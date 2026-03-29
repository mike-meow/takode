import { mkdirSync } from "node:fs";
import { readdir, readFile, writeFile, unlink, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  SessionState,
  BrowserIncomingMessage,
  PermissionRequest,
  BufferedBrowserEvent,
  SessionTaskEntry,
  CodexOutboundTurn,
  PendingCodexInput,
  BoardRow,
} from "./session-types.js";

// ─── Two-Tier Persistence Design ────────────────────────────────────────────
//
// Problem: JSON.stringify(entireSession) blocked the event loop for 50-75ms on
// large sessions (8,700+ messages, 14.8MB). With 150ms debounce, this consumed
// 33-50% of event loop time during streaming, causing WebSocket disconnects.
//
// Solution: Split persistence into two files per session:
//
//   {id}.json            Hot state — session config + current turn's messages.
//                        Written every 150ms (debounced). Serialize cost is
//                        O(current turn), bounded and typically <1ms.
//
//   {id}.history.jsonl   Frozen log — completed turns, append-only JSONL.
//                        Appended once per turn completion. Each message is
//                        serialized exactly once when frozen.
//
// Freeze boundary: Everything up to and including the last `result` message.
// Messages after that are the current in-progress turn and stay "hot".
//
// Why append-only works despite in-place mutations:
//
// Messages in messageHistory are mutated after insertion in 6 places:
//   1. assistant content.push(block)  — CLI sends same msg ID in parts
//   2. assistant stop_reason update   — subsequent part arrives
//   3. assistant usage update         — subsequent part arrives
//   4. assistant timestamp update     — each part arrival
//   5. assistant turn_duration_ms     — set when result message arrives
//   6. compact_marker summary         — injected async after compact_boundary
//
// All mutations resolve before or at the `result` message that triggers the
// freeze. The compact marker summary always arrives before the next user
// message (CLI protocol guarantee). So by the time we freeze a completed
// turn, every message is in its final form.
//
// Tool results are frozen at the same boundary. They only arrive via
// buildToolResultPreviews() inside handleResultMessage() — the same moment
// that triggers the freeze. So all tool results at freeze time belong to
// completed turns.
//
// Crash safety: JSONL is appended before the hot JSON is written. On load,
// overlap detection handles the case where JSONL has more data than the hot
// JSON expects (crash between the two writes).
//
// The in-memory session.messageHistory array is unchanged. ws-bridge.ts has
// zero changes — the split is entirely inside SessionStore.
//
// ─────────────────────────────────────────────────────────────────────────────

// ─── Serializable session shape ─────────────────────────────────────────────

export interface PersistedSession {
  id: string;
  state: SessionState;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  pendingCodexTurns?: CodexOutboundTurn[];
  pendingCodexInputs?: PendingCodexInput[];
  pendingPermissions: [string, PermissionRequest][];
  eventBuffer?: BufferedBrowserEvent[];
  nextEventSeq?: number;
  lastAckSeq?: number;
  processedClientMessageIds?: string[];
  archived?: boolean;
  /** Epoch ms when this session was archived */
  archivedAt?: number;
  /** Serialized Map entries for full tool results (tool_use_id → result) */
  toolResults?: [string, { content: string; is_error: boolean; timestamp: number }][];
  /** Epoch ms when the user last viewed this session (server-authoritative) */
  lastReadAt?: number;
  /** Current attention reason: why this session needs the user's attention */
  attentionReason?: "action" | "error" | "review" | null;
  /** High-level task history recognized by the session auto-namer */
  taskHistory?: SessionTaskEntry[];
  /** Accumulated search keywords from the session auto-namer */
  keywords?: string[];
  /** Leader work board rows, keyed by quest ID */
  board?: BoardRow[];

  // ── Append-only history bookkeeping (managed by SessionStore) ───────────
  /**
   * Number of messages from the beginning of the full messageHistory that
   * are persisted in the append-only JSONL frozen log. The hot JSON only
   * stores messages[_frozenCount..]. On load, frozen + hot are concatenated.
   */
  _frozenCount?: number;
  /**
   * Number of toolResults entries persisted in the frozen log.
   * The hot JSON only stores toolResults[_frozenToolResultCount..].
   */
  _frozenToolResultCount?: number;
}

// ─── Store ──────────────────────────────────────────────────────────────────

const DEFAULT_BASE_DIR = join(homedir(), ".companion", "sessions");

/**
 * Session persistence with two-tier storage:
 *
 * 1. **Hot state** (`{id}.json`) — small JSON with session state + only the
 *    current turn's messages and tool results. Written every 150ms (debounced).
 *    Serialize cost is O(current turn), bounded and typically <1ms.
 *
 * 2. **Frozen log** (`{id}.history.jsonl`) — append-only JSONL with all
 *    completed turns. Appended once per turn completion. Each message is
 *    serialized exactly once when frozen.
 *
 * This eliminates the O(total history) serialization that previously blocked
 * the event loop for 50-75ms on large sessions (8,700+ messages, 14.8MB).
 */
export class SessionStore {
  private dir: string;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingSaves = new Map<string, PersistedSession>();
  /** Track in-flight async writes so flushAll can await them. */
  private inflightWrites = new Set<Promise<unknown>>();

  /**
   * How many messages from the start of each session's messageHistory are
   * already in the frozen JSONL. Set on load(), updated on freeze.
   */
  private frozenCounts = new Map<string, number>();
  /** Same for tool results — how many entries are in the frozen JSONL. */
  private frozenToolResultCounts = new Map<string, number>();

  constructor(dir?: string, port?: number) {
    if (dir) {
      this.dir = dir;
    } else {
      this.dir = port ? join(DEFAULT_BASE_DIR, String(port)) : DEFAULT_BASE_DIR;
    }
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  private frozenLogPath(sessionId: string): string {
    return join(this.dir, `${sessionId}.history.jsonl`);
  }

  // ─── Freeze logic ───────────────────────────────────────────────────────

  /**
   * Find the freeze boundary in messageHistory. Returns the number of
   * messages from the start that belong to completed turns (everything
   * up to and including the last `result` message). Messages after that
   * are the current in-progress turn and stay "hot".
   */
  private computeFreezeCutoff(messages: BrowserIncomingMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i] as { type: string }).type === "result") {
        return i + 1;
      }
    }
    return 0;
  }

  private static toolResultPreviewReplayKey(message: BrowserIncomingMessage): string | null {
    if (message.type !== "tool_result_preview" || !Array.isArray(message.previews) || message.previews.length === 0) {
      return null;
    }
    return JSON.stringify(
      message.previews.map((preview) => ({
        tool_use_id: preview.tool_use_id,
        content: preview.content,
        is_error: preview.is_error,
        total_size: preview.total_size,
        is_truncated: preview.is_truncated,
      })),
    );
  }

  private trimDuplicateReplayPreviewTail(messages: BrowserIncomingMessage[]): {
    messages: BrowserIncomingMessage[];
    removedCount: number;
  } {
    let suffixStart = messages.length;
    while (suffixStart > 0 && messages[suffixStart - 1]?.type === "tool_result_preview") {
      suffixStart--;
    }
    if (suffixStart === messages.length) return { messages, removedCount: 0 };

    const seen = new Set<string>();
    for (let i = 0; i < suffixStart; i++) {
      const key = SessionStore.toolResultPreviewReplayKey(messages[i]);
      if (key) seen.add(key);
    }

    const cleaned = messages.slice(0, suffixStart);
    let removedCount = 0;
    for (let i = suffixStart; i < messages.length; i++) {
      const key = SessionStore.toolResultPreviewReplayKey(messages[i]);
      if (!key) {
        cleaned.push(messages[i]);
        continue;
      }
      if (seen.has(key)) {
        removedCount++;
        continue;
      }
      seen.add(key);
      cleaned.push(messages[i]);
    }

    return removedCount > 0 ? { messages: cleaned, removedCount } : { messages, removedCount: 0 };
  }

  /**
   * Append newly frozen messages and tool results to the JSONL frozen log.
   * Creates the file with a version header if it doesn't exist yet.
   * Fire-and-forget async — tracked in inflightWrites for flushAll().
   */
  private appendToFrozenLog(
    sessionId: string,
    messages: BrowserIncomingMessage[],
    toolResults: [string, { content: string; is_error: boolean; timestamp: number }][],
    isNewLog: boolean,
  ): void {
    if (messages.length === 0 && toolResults.length === 0) return;

    let data = "";
    if (isNewLog) {
      data += JSON.stringify({ v: 1, sessionId }) + "\n";
    }

    for (const msg of messages) {
      data += JSON.stringify(msg) + "\n";
    }

    if (toolResults.length > 0) {
      data += JSON.stringify({ _toolResults: toolResults }) + "\n";
    }

    const p = appendFile(this.frozenLogPath(sessionId), data, "utf-8")
      .catch((err) => {
        console.error(`[session-store] Failed to append frozen log for ${sessionId}:`, err);
      })
      .finally(() => {
        this.inflightWrites.delete(p);
      });
    this.inflightWrites.add(p);
  }

  /**
   * Rewrite the frozen JSONL log with only the messages that survived a
   * history truncation (e.g., session revert). Replaces the entire file.
   * Fire-and-forget async — tracked in inflightWrites for flushAll().
   */
  private rewriteFrozenLog(
    sessionId: string,
    survivingMessages: BrowserIncomingMessage[],
    survivingToolResults: PersistedSession["toolResults"],
  ): void {
    // Compute how many of the surviving messages belong to completed turns
    const frozenCount = this.computeFreezeCutoff(survivingMessages);
    const frozenMessages = survivingMessages.slice(0, frozenCount);

    // Build the full JSONL content from scratch
    let data = JSON.stringify({ v: 1, sessionId }) + "\n";
    for (const msg of frozenMessages) {
      data += JSON.stringify(msg) + "\n";
    }
    // Include tool results that survived the truncation
    if (survivingToolResults?.length) {
      data += JSON.stringify({ _toolResults: survivingToolResults }) + "\n";
    }

    // Update in-memory frozen counts to match the rewritten file
    this.frozenCounts.set(sessionId, frozenCount);
    this.frozenToolResultCounts.set(sessionId, survivingToolResults?.length ?? 0);

    const logPath = this.frozenLogPath(sessionId);
    if (frozenCount === 0) {
      // No completed turns survive — delete the JSONL file entirely
      const p = unlink(logPath)
        .catch(() => {
          /* File may not exist */
        })
        .finally(() => {
          this.inflightWrites.delete(p);
        });
      this.inflightWrites.add(p);
    } else {
      // Rewrite with only the surviving frozen messages
      const p = writeFile(logPath, data, "utf-8")
        .catch((err) => {
          console.error(`[session-store] Failed to rewrite frozen log for ${sessionId}:`, err);
        })
        .finally(() => {
          this.inflightWrites.delete(p);
        });
      this.inflightWrites.add(p);
    }
  }

  /**
   * Parse a JSONL frozen log into messages and tool results.
   * Skips the header line and gracefully handles corrupt/truncated lines.
   */
  private async readFrozenLog(sessionId: string): Promise<{
    messages: BrowserIncomingMessage[];
    toolResults: [string, { content: string; is_error: boolean; timestamp: number }][];
  }> {
    const messages: BrowserIncomingMessage[] = [];
    const toolResults: [string, { content: string; is_error: boolean; timestamp: number }][] = [];

    let raw: string;
    try {
      raw = await readFile(this.frozenLogPath(sessionId), "utf-8");
    } catch {
      return { messages, toolResults };
    }

    const lines = raw.split("\n");
    let isFirstNonEmpty = true;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        // Skip the version header (first non-empty line with a `v` field)
        if (isFirstNonEmpty && parsed.v !== undefined) {
          isFirstNonEmpty = false;
          continue;
        }
        isFirstNonEmpty = false;

        if (parsed._toolResults) {
          toolResults.push(...parsed._toolResults);
        } else {
          messages.push(parsed as BrowserIncomingMessage);
        }
      } catch {
        // Truncated line from a crash — skip
        console.warn(`[session-store] Skipping corrupt line in frozen log for ${sessionId}`);
      }
    }

    return { messages, toolResults };
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /** Debounced write — batches rapid changes (e.g. multiple stream events). */
  save(session: PersistedSession): void {
    const existing = this.debounceTimers.get(session.id);
    if (existing) clearTimeout(existing);

    this.pendingSaves.set(session.id, session);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(session.id);
      this.pendingSaves.delete(session.id);
      this.saveSync(session);
    }, 150);
    this.debounceTimers.set(session.id, timer);
  }

  /**
   * Immediate persist — fire-and-forget async under the hood.
   *
   * Two-tier write: completed turns go to append-only JSONL (O(new msgs)),
   * current turn goes to the hot JSON file (O(current turn), typically <1ms).
   */
  saveSync(session: PersistedSession): void {
    const cleanedHistory = this.trimDuplicateReplayPreviewTail(session.messageHistory);
    if (cleanedHistory.removedCount > 0) {
      session.messageHistory = cleanedHistory.messages;
      console.warn(
        `[session-store] Trimmed ${cleanedHistory.removedCount} duplicate replay-generated tool_result_preview messages ` +
          `from hot tail while saving session ${session.id.slice(0, 8)}`,
      );
    }

    const messages = session.messageHistory;
    const allToolResults = session.toolResults ?? [];

    // How many messages are in completed turns?
    const cutoff = this.computeFreezeCutoff(messages);
    let prevFrozenMsgs = this.frozenCounts.get(session.id) ?? session._frozenCount ?? 0;
    let prevFrozenToolResults = this.frozenToolResultCounts.get(session.id) ?? session._frozenToolResultCount ?? 0;

    // Revert detection: if messageHistory was truncated below the frozen count
    // (e.g., session revert), rewrite the JSONL frozen log with only the
    // surviving messages so the revert persists across server restarts.
    // This breaks the append-only invariant but only during an explicit
    // user-initiated revert (which is inherently destructive anyway).
    if (prevFrozenMsgs > messages.length) {
      console.log(
        `[session-store] Session ${session.id.slice(0, 8)} reverted: messageHistory (${messages.length}) < frozenCount (${prevFrozenMsgs}). ` +
          `Rewriting frozen log to match truncated history.`,
      );
      this.rewriteFrozenLog(session.id, messages, allToolResults);
      prevFrozenMsgs = messages.length;
      prevFrozenToolResults = Math.min(prevFrozenToolResults, allToolResults.length);
    }
    if (prevFrozenToolResults > allToolResults.length) {
      prevFrozenToolResults = allToolResults.length;
    }

    // If new messages to freeze (a turn just completed), append them to JSONL
    if (cutoff > prevFrozenMsgs) {
      const newFrozenMsgs = messages.slice(prevFrozenMsgs, cutoff);

      // Tool results are stored as an ordered array (Map insertion order =
      // chronological). When a turn completes, snapshot the current count:
      // all tool results accumulated so far belong to completed turns.
      // Results from the next in-progress turn haven't been added yet
      // because they arrive via result messages (which trigger the freeze).
      const toolResultsToFreeze = allToolResults.length;
      const newToolResults = allToolResults.slice(prevFrozenToolResults, toolResultsToFreeze);

      const isNewLog = prevFrozenMsgs === 0;
      this.appendToFrozenLog(session.id, newFrozenMsgs, newToolResults, isNewLog);
      this.frozenCounts.set(session.id, cutoff);
      this.frozenToolResultCounts.set(session.id, toolResultsToFreeze);

      // Hot JSON: only the current turn (no tool results yet — they arrive
      // with the result message, which triggers the next freeze)
      this.writeHotJson(session, messages.slice(cutoff), [], cutoff, toolResultsToFreeze);
    } else {
      // No new freeze — write the hot JSON with the current tail
      this.writeHotJson(
        session,
        messages.slice(prevFrozenMsgs),
        allToolResults.slice(prevFrozenToolResults),
        prevFrozenMsgs,
        prevFrozenToolResults,
      );
    }
  }

  /** Write the hot JSON file with the given tail of messages and tool results. */
  private writeHotJson(
    session: PersistedSession,
    hotMessages: BrowserIncomingMessage[],
    hotToolResults: PersistedSession["toolResults"],
    frozenMsgCount: number,
    frozenToolResultCount: number,
  ): void {
    const hotSession: PersistedSession = {
      ...session,
      messageHistory: hotMessages,
      toolResults: hotToolResults,
      _frozenCount: frozenMsgCount,
      _frozenToolResultCount: frozenToolResultCount,
    };

    const serStart = performance.now();
    const data = JSON.stringify(hotSession);
    const serMs = performance.now() - serStart;
    if (serMs > 50) {
      console.warn(
        `[session-store] Slow JSON.stringify: ${serMs.toFixed(1)}ms, session=${session.id.slice(0, 8)}, hotMsgs=${hotMessages.length}, len=${data.length}`,
      );
    }

    const p = writeFile(this.filePath(session.id), data, "utf-8")
      .catch((err) => {
        console.error(`[session-store] Failed to save session ${session.id}:`, err);
      })
      .finally(() => {
        this.inflightWrites.delete(p);
      });
    this.inflightWrites.add(p);
  }

  /** Load a single session from disk, combining frozen log + hot state. */
  async load(sessionId: string): Promise<PersistedSession | null> {
    let hot: PersistedSession;
    try {
      const raw = await readFile(this.filePath(sessionId), "utf-8");
      hot = JSON.parse(raw) as PersistedSession;
    } catch {
      return null;
    }

    const expectedFrozenMsgs = hot._frozenCount ?? 0;
    const expectedFrozenToolResults = hot._frozenToolResultCount ?? 0;

    // No frozen data — either legacy format (full history in JSON) or a
    // brand-new session with no completed turns yet. Return as-is.
    if (expectedFrozenMsgs === 0) {
      this.frozenCounts.set(sessionId, 0);
      this.frozenToolResultCounts.set(sessionId, 0);
      return hot;
    }

    // Read the frozen JSONL log
    const frozen = await this.readFrozenLog(sessionId);
    const actualFrozenMsgs = frozen.messages.length;

    // Crash recovery: JSONL may have more lines than the hot JSON expects
    // (crash between JSONL append and hot JSON write). Trim overlap from
    // both messages and tool results to avoid duplicates.
    let hotTail = hot.messageHistory;
    let hotTailToolResults = hot.toolResults ?? [];
    if (actualFrozenMsgs > expectedFrozenMsgs) {
      const overlap = actualFrozenMsgs - expectedFrozenMsgs;
      hotTail = hot.messageHistory.slice(overlap);
    }
    if (frozen.toolResults.length > expectedFrozenToolResults) {
      const trOverlap = frozen.toolResults.length - expectedFrozenToolResults;
      hotTailToolResults = hotTailToolResults.slice(trOverlap);
    }

    // Handle JSONL truncation: if the frozen log has FEWER messages than
    // expected (e.g., JSONL was corrupted/truncated), log a warning. The
    // missing messages are lost — the frozen log is the source of truth.
    if (actualFrozenMsgs < expectedFrozenMsgs) {
      console.warn(
        `[session-store] Frozen log for ${sessionId} has ${actualFrozenMsgs} messages but expected ${expectedFrozenMsgs}. ` +
          `${expectedFrozenMsgs - actualFrozenMsgs} messages may have been lost due to JSONL corruption.`,
      );
    }

    // Merge tool results: frozen first, then hot
    const mergedToolResults: PersistedSession["toolResults"] = [...frozen.toolResults, ...hotTailToolResults];

    const mergedHistory = [...frozen.messages, ...hotTail];
    const cleanedHistory = this.trimDuplicateReplayPreviewTail(mergedHistory);
    const cleanedHotTail = cleanedHistory.messages.slice(actualFrozenMsgs);

    if (cleanedHistory.removedCount > 0) {
      console.warn(
        `[session-store] Repaired ${cleanedHistory.removedCount} duplicate replay-generated tool_result_preview messages ` +
          `from persisted hot tail for session ${sessionId.slice(0, 8)}`,
      );
      this.writeHotJson(
        {
          ...hot,
          messageHistory: cleanedHistory.messages,
          toolResults: mergedToolResults,
        },
        cleanedHotTail,
        hotTailToolResults,
        actualFrozenMsgs,
        frozen.toolResults.length,
      );
    }

    this.frozenCounts.set(sessionId, actualFrozenMsgs);
    this.frozenToolResultCounts.set(sessionId, frozen.toolResults.length);

    return {
      ...hot,
      messageHistory: cleanedHistory.messages,
      toolResults: mergedToolResults,
      _frozenCount: actualFrozenMsgs,
      _frozenToolResultCount: frozen.toolResults.length,
    };
  }

  /** Load all sessions from disk. */
  async loadAll(): Promise<PersistedSession[]> {
    const sessions: PersistedSession[] = [];
    try {
      const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json") && f !== "launcher.json");
      for (const file of files) {
        const sessionId = file.replace(/\.json$/, "");
        try {
          const session = await this.load(sessionId);
          if (session) sessions.push(session);
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Dir doesn't exist yet
    }
    return sessions;
  }

  /** Set the archived flag on a persisted session. */
  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    const session = await this.load(sessionId);
    if (!session) return false;
    session.archived = archived;
    session.archivedAt = archived ? Date.now() : undefined;
    this.saveSync(session);
    return true;
  }

  /** Flush all pending debounced saves and await in-flight writes. Call before shutdown. */
  async flushAll(): Promise<void> {
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    for (const [, session] of this.pendingSaves) {
      this.saveSync(session);
    }
    this.debounceTimers.clear();
    this.pendingSaves.clear();
    await Promise.allSettled([...this.inflightWrites]);
  }

  /** Remove a session's files from disk (hot JSON + frozen log). */
  remove(sessionId: string): void {
    const timer = this.debounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(sessionId);
    }
    this.pendingSaves.delete(sessionId);
    this.frozenCounts.delete(sessionId);
    this.frozenToolResultCounts.delete(sessionId);

    const p1 = unlink(this.filePath(sessionId))
      .catch(() => {
        /* File may not exist */
      })
      .finally(() => {
        this.inflightWrites.delete(p1);
      });
    this.inflightWrites.add(p1);

    const p2 = unlink(this.frozenLogPath(sessionId))
      .catch(() => {
        /* File may not exist */
      })
      .finally(() => {
        this.inflightWrites.delete(p2);
      });
    this.inflightWrites.add(p2);
  }

  /** Persist launcher state (separate file). */
  saveLauncher(data: unknown): void {
    const p = writeFile(join(this.dir, "launcher.json"), JSON.stringify(data, null, 2), "utf-8")
      .catch((err) => {
        console.error("[session-store] Failed to save launcher state:", err);
      })
      .finally(() => {
        this.inflightWrites.delete(p);
      });
    this.inflightWrites.add(p);
  }

  /** Load launcher state. */
  async loadLauncher<T>(): Promise<T | null> {
    try {
      const raw = await readFile(join(this.dir, "launcher.json"), "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  get directory(): string {
    return this.dir;
  }
}
