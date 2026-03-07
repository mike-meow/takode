/**
 * Codex App-Server Adapter
 *
 * Translates between the Codex app-server JSON-RPC protocol (stdin/stdout)
 * and The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * This allows the browser to be completely unaware of which backend is running —
 * it sees the same message types regardless of whether Claude Code or Codex is
 * the backend.
 */

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  SessionState,
  PermissionRequest,
  CLIResultMessage,
  McpServerDetail,
  McpServerConfig,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";
import type {
  BackendAdapter,
  CurrentTurnIdAwareAdapter,
  RateLimitsAwareAdapter,
  TurnStartFailedAwareAdapter,
} from "./bridge/adapter-interface.js";
import { getDefaultModelForBackend } from "../shared/backend-defaults.js";

// ─── Codex JSON-RPC Types ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  method: string;
  id: number;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// Codex item types
interface CodexItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

/** Safely extract a string kind from a Codex file change entry.
 *  Codex may send kind as a string ("create") or as an object ({ type: "modify" }). */
function safeKind(kind: unknown): string {
  if (typeof kind === "string") return kind;
  if (kind && typeof kind === "object" && "type" in kind) {
    const t = (kind as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return "modify";
}

function toSafeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => toSafeText(v)).filter(Boolean).join(" ").trim();
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const preferred = rec.text ?? rec.summary ?? rec.content;
    if (preferred !== undefined) return toSafeText(preferred);
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function stripOuterShellQuotes(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first !== "'" && first !== "\"") || first !== last) return trimmed;

  const inner = trimmed.slice(1, -1);
  if (first === "'") {
    // POSIX single-quote escaping pattern: 'foo'\''bar'
    return inner.replace(/'\\''/g, "'");
  }
  return inner.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function unwrapShellWrappedCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";

  // Common Codex shell wrapper: /bin/bash -lc "<actual command>"
  const posix = trimmed.match(
    /^(?:\/(?:usr\/)?bin\/env\s+)?(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/,
  );
  if (posix) {
    return stripOuterShellQuotes(posix[1]);
  }

  // Windows wrapper: cmd /c "<actual command>"
  const win = trimmed.match(/^cmd(?:\.exe)?\s+\/c\s+([\s\S]+)$/i);
  if (win) {
    return stripOuterShellQuotes(win[1]);
  }

  return trimmed;
}

function extractCommandAction(commandActions: unknown): string {
  if (!Array.isArray(commandActions)) return "";
  for (const action of commandActions) {
    if (!action || typeof action !== "object") continue;
    const cmd = (action as Record<string, unknown>).command;
    if (typeof cmd === "string" && cmd.trim()) {
      return cmd.trim();
    }
  }
  return "";
}

function formatCommandForDisplay(command: string | string[] | undefined, commandActions?: unknown): string {
  const actionCommand = extractCommandAction(commandActions);
  if (actionCommand) return unwrapShellWrappedCommand(actionCommand);
  const raw = Array.isArray(command) ? command.join(" ") : (command || "");
  return unwrapShellWrappedCommand(raw);
}

function firstNonEmptyString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

type ToolFileChange = {
  path: string;
  kind: string;
  diff?: string;
};

function extractChangeDiff(change: Record<string, unknown>): string {
  const direct = firstNonEmptyString(change, [
    "diff",
    "unified_diff",
    "unifiedDiff",
    "patch",
  ]);
  if (direct) return direct;

  const kind = change.kind;
  if (kind && typeof kind === "object") {
    const nested = firstNonEmptyString(kind as Record<string, unknown>, [
      "diff",
      "unified_diff",
      "unifiedDiff",
      "patch",
    ]);
    if (nested) return nested;
  }

  return "";
}

function mapFileChangesForTool(changes: Array<Record<string, unknown>>): ToolFileChange[] {
  return changes.map((c) => {
    const path = typeof c.path === "string" ? c.path : "";
    const kind = safeKind(c.kind ?? c.type);
    const diff = extractChangeDiff(c);
    return {
      path,
      kind,
      ...(diff ? { diff } : {}),
    };
  });
}

function mapFileChangesObjectForTool(fileChanges: Record<string, unknown>): ToolFileChange[] {
  return Object.entries(fileChanges).map(([path, raw]) => {
    const rec = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const kind = safeKind(rec.kind ?? rec.type);
    const diff = extractChangeDiff(rec);
    return {
      path,
      kind,
      ...(diff ? { diff } : {}),
    };
  });
}

function mapUnknownFileChangesForTool(raw: unknown): ToolFileChange[] {
  if (Array.isArray(raw)) {
    const entries = raw.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
    return mapFileChangesForTool(entries);
  }
  if (raw && typeof raw === "object") {
    return mapFileChangesObjectForTool(raw as Record<string, unknown>);
  }
  return [];
}

function hasAnyPatchDiff(changes: ToolFileChange[]): boolean {
  return changes.some((change) => typeof change.diff === "string" && change.diff.trim().length > 0);
}

interface CodexAgentMessageItem extends CodexItem {
  type: "agentMessage";
  text?: string;
}

interface CodexCommandExecutionItem extends CodexItem {
  type: "commandExecution";
  command: string | string[];
  commandActions?: Array<{ command?: string }>;
  cwd?: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  exitCode?: number;
  durationMs?: number;
}

interface CodexFileChangeItem extends CodexItem {
  type: "fileChange";
  changes?: Array<Record<string, unknown>> | Record<string, unknown>;
  status: "inProgress" | "completed" | "failed" | "declined";
}

interface CodexMcpToolCallItem extends CodexItem {
  type: "mcpToolCall";
  server: string;
  tool: string;
  status: "inProgress" | "completed" | "failed";
  arguments?: Record<string, unknown>;
  result?: string;
  error?: string;
}

interface CodexWebSearchItem extends CodexItem {
  type: "webSearch";
  query?: string;
  action?: { type?: string; url?: string; pattern?: string; query?: string; q?: string };
  result?: string;
  output?: string;
  summary?: string;
  results?: unknown[];
  searchResults?: unknown[];
}

interface CodexReasoningItem extends CodexItem {
  type: "reasoning";
  summary?: string;
  content?: string;
}

interface CodexContextCompactionItem extends CodexItem {
  type: "contextCompaction";
}

interface CodexCollabAgentToolCallItem extends CodexItem {
  type: "collabAgentToolCall";
  tool?: string;
  prompt?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  agentsStates?: unknown[];
  status?: "inProgress" | "completed" | "failed" | "declined";
  error?: unknown;
}

interface PendingSubagentToolUse {
  prompt: string;
  startedAt: number;
  senderThreadId: string | null;
  parentToolUseId: string | null;
}

function formatWebSearchResultEntry(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const rec = entry as Record<string, unknown>;
  const title = toSafeText(rec.title ?? rec.name ?? "").trim();
  const url = toSafeText(rec.url ?? rec.link ?? "").trim();
  const snippet = toSafeText(rec.snippet ?? rec.description ?? rec.summary ?? "").trim();

  if (title && url) return `${title}\n${url}`;
  if (title && snippet) return `${title}\n${snippet}`;
  if (title) return title;
  if (url && snippet) return `${url}\n${snippet}`;
  if (url) return url;
  return snippet;
}

function extractWebSearchResultText(item: CodexWebSearchItem): string {
  const directText = [item.result, item.output, item.summary]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join("\n")
    .trim();
  if (directText) return directText;

  const resultLists = [item.results, item.searchResults];
  for (const list of resultLists) {
    if (!Array.isArray(list)) continue;
    const lines = list
      .map((entry) => formatWebSearchResultEntry(entry))
      .filter((line) => line.length > 0);
    if (lines.length > 0) return lines.join("\n\n");
  }

  const actionUrl = item.action?.url;
  if (typeof actionUrl === "string" && actionUrl.trim()) return actionUrl.trim();

  return "Web search completed";
}

function extractWebSearchQuery(item: CodexWebSearchItem): string {
  if (typeof item.query === "string" && item.query.trim()) return item.query.trim();
  if (typeof item.action?.query === "string" && item.action.query.trim()) return item.action.query.trim();
  if (typeof item.action?.q === "string" && item.action.q.trim()) return item.action.q.trim();
  if (typeof item.action?.pattern === "string" && item.action.pattern.trim()) return item.action.pattern.trim();
  return "";
}

interface CodexMcpServerStatus {
  name: string;
  tools?: Record<string, { name?: string; annotations?: unknown }>;
  authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
}

interface CodexMcpStatusListResponse {
  data?: CodexMcpServerStatus[];
  nextCursor?: string | null;
}

// ─── Adapter Options ──────────────────────────────────────────────────────────

export interface CodexAdapterOptions {
  model?: string;
  cwd?: string;
  approvalMode?: string;
  askPermission?: boolean;
  sandbox?: "workspace-write" | "danger-full-access";
  reasoningEffort?: string;
  /** If provided, resume an existing thread instead of starting a new one. */
  threadId?: string;
  /** Optional recorder for raw message capture. */
  recorder?: RecorderManager;
  /** Companion instructions injected via developer_instructions in turn/start. */
  instructions?: string;
}

export interface CodexResumeTurnSnapshot {
  id: string;
  status: string | null;
  error: unknown;
  items: Array<Record<string, unknown>>;
}

export interface CodexResumeSnapshot {
  threadId: string;
  turnCount: number;
  lastTurn: CodexResumeTurnSnapshot | null;
  /** Thread-level status from the resume response (e.g. "idle", "active"). */
  threadStatus?: string | null;
}

export interface CodexSessionMeta {
  cliSessionId?: string;
  model?: string;
  cwd?: string;
  resumeSnapshot?: CodexResumeSnapshot | null;
}

// ─── JSON-RPC Transport ───────────────────────────────────────────────────────

class JsonRpcTransport {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private requestHandler: ((method: string, id: number, params: Record<string, unknown>) => void) | null = null;
  private rawInCb: ((line: string) => void) | null = null;
  private rawOutCb: ((data: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private connected = true;
  private buffer = "";

  constructor(
    stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number },
    stdout: ReadableStream<Uint8Array>,
  ) {
    // Handle both Bun subprocess stdin types
    let writable: WritableStream<Uint8Array>;
    if ("write" in stdin && typeof stdin.write === "function") {
      // Bun's subprocess stdin has a .write() method that returns bytes
      // actually written. We must loop to handle partial writes — otherwise
      // large payloads (images) can be silently truncated, corrupting the
      // NDJSON protocol and crashing the Codex process.
      const bunStdin = stdin as { write(data: Uint8Array): number };
      writable = new WritableStream({
        async write(chunk) {
          let offset = 0;
          while (offset < chunk.length) {
            const written = bunStdin.write(
              offset === 0 ? chunk : chunk.subarray(offset),
            );
            if (written <= 0) {
              // Pipe buffer full — yield to the event loop and retry
              await new Promise<void>((r) => setTimeout(r, 1));
              continue;
            }
            offset += written;
          }
        },
      });
    } else {
      writable = stdin as WritableStream<Uint8Array>;
    }
    // Acquire writer once and hold it — avoids "WritableStream is locked" race
    // when concurrent async calls (e.g. rateLimits + turn/start) overlap.
    this.writer = writable.getWriter();

    this.readStdout(stdout);
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.processBuffer();
      }
    } catch (err) {
      console.error("[codex-adapter] stdout reader error:", err);
    } finally {
      this.connected = false;
      // Reject all pending promises so callers don't hang indefinitely
      // when the Codex process crashes or exits unexpectedly.
      for (const [id, { reject }] of this.pending) {
        reject(new Error("Transport closed"));
      }
      this.pending.clear();
      this.closeCb?.();
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Record raw incoming line before parsing
      this.rawInCb?.(trimmed);

      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        console.warn("[codex-adapter] Failed to parse JSON-RPC:", trimmed.substring(0, 200));
        continue;
      }

      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id !== undefined) {
      if ("method" in msg && msg.method) {
        // This is a request FROM the server (e.g., approval request)
        try {
          this.requestHandler?.(msg.method, msg.id as number, (msg as JsonRpcRequest).params || {});
        } catch (err) {
          console.error(`[codex-adapter] Request handler failed for ${msg.method}:`, err);
        }
      } else {
        // This is a response to one of our requests
        const pending = this.pending.get(msg.id as number);
        if (pending) {
          this.pending.delete(msg.id as number);
          const resp = msg as JsonRpcResponse;
          if (resp.error) {
            pending.reject(new Error(resp.error.message));
          } else {
            pending.resolve(resp.result);
          }
        }
      }
    } else if ("method" in msg) {
      // Notification (no id)
      try {
        this.notificationHandler?.(msg.method, (msg as JsonRpcNotification).params || {});
      } catch (err) {
        console.error(`[codex-adapter] Notification handler failed for ${msg.method}:`, err);
      }
    }
  }

  /** Send a request and wait for the matching response. */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise(async (resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request = JSON.stringify({ method, id, params });
      try {
        await this.writeRaw(request + "\n");
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a notification (no response expected). */
  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const notification = JSON.stringify({ method, params });
    await this.writeRaw(notification + "\n");
  }

  /** Respond to a request from the server (e.g., approval). */
  async respond(id: number, result: unknown): Promise<void> {
    const response = JSON.stringify({ id, result });
    await this.writeRaw(response + "\n");
  }

  /** Register handler for server-initiated notifications. */
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  /** Register handler for server-initiated requests (need a response). */
  onRequest(handler: (method: string, id: number, params: Record<string, unknown>) => void): void {
    this.requestHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Register callback for raw incoming lines (before JSON parse). */
  onRawIncoming(cb: (line: string) => void): void {
    this.rawInCb = cb;
  }

  /** Register callback for raw outgoing data (before write). */
  onRawOutgoing(cb: (data: string) => void): void {
    this.rawOutCb = cb;
  }

  /** Register callback for when the transport closes (stdout ends or errors). */
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  /** IDs of in-flight RPC requests (for debugging unexpected disconnects). */
  getPendingIds(): number[] {
    return [...this.pending.keys()];
  }

  private async writeRaw(data: string): Promise<void> {
    if (!this.connected) {
      throw new Error("Transport closed");
    }
    // Record raw outgoing data before writing
    this.rawOutCb?.(data);
    await this.writer.write(new TextEncoder().encode(data));
  }
}

// ─── Codex Adapter ────────────────────────────────────────────────────────────

export class CodexAdapter
  implements
    BackendAdapter<CodexSessionMeta>,
    TurnStartFailedAwareAdapter,
    CurrentTurnIdAwareAdapter,
    RateLimitsAwareAdapter {
  private transport: JsonRpcTransport;
  private proc: Subprocess;
  private sessionId: string;
  private options: CodexAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: CodexSessionMeta) => void) | null = null;
  private disconnectCb: (() => void) | null = null;
  private initErrorCb: ((error: string) => void) | null = null;
  private turnStartFailedCb: ((msg: BrowserOutgoingMessage) => void) | null = null;

  // State
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private connected = false;
  private initialized = false;
  private initFailed = false;
  private collaborationModeSupported = true;

  // Last few raw JSON-RPC messages for debugging unexpected disconnects
  private recentRawMessages: string[] = [];
  private static readonly RAW_MESSAGE_RING_SIZE = 5;

  // Streaming accumulator for agent messages
  private streamingText = "";
  private streamingItemId: string | null = null;

  // Track command execution start times for progress indicator
  private commandStartTimes = new Map<string, number>();
  private commandOutputByItemId = new Map<string, string>();
  private planToolUseSeq = 0;
  private planSignatureByKey = new Map<string, string>();

  // Accumulate reasoning text by item ID so we can emit final thinking blocks.
  private reasoningTextByItemId = new Map<string, string>();
  // Per reasoning item, capture elapsed time from previous completed message
  // to the moment this reasoning summary first arrives.
  private reasoningTimeFromLastMessageByItemId = new Map<string, number>();
  private lastMessageFinishedAt: number | null = null;

  // Track which item IDs we have already emitted a tool_use block for.
  // When Codex auto-approves (approvalPolicy "never"), it may skip item/started
  // and only send item/completed — we need to emit tool_use before tool_result.
  private emittedToolUseIds = new Set<string>();
  private patchChangesByCallId = new Map<string, ToolFileChange[]>();
  private parentToolUseIdByThreadId = new Map<string, string>();
  private parentToolUseIdByItemId = new Map<string, string | null>();
  private pendingSubagentToolUsesByCallId = new Map<string, PendingSubagentToolUse>();

  // Resolve when the current turn ends (used by interruptAndWaitForTurnEnd)
  private turnEndResolvers: Array<() => void> = [];

  // Queue messages received before initialization completes
  private pendingOutgoing: BrowserOutgoingMessage[] = [];
  // Serialize async outgoing dispatch so permission/interrupt/user turns can't overlap.
  private outgoingDispatchChain: Promise<void> = Promise.resolve();

  // Pending approval requests (Codex sends these as JSON-RPC requests with an id)
  private pendingApprovals = new Map<string, number>(); // request_id -> JSON-RPC id

  // Track request types that need different response formats
  private pendingUserInputQuestionIds = new Map<string, string[]>(); // request_id -> ordered Codex question IDs
  private pendingReviewDecisions = new Set<string>(); // request_ids that need ReviewDecision format
  private pendingDynamicToolCalls = new Map<string, {
    jsonRpcId: number;
    callId: string;
    toolName: string;
    parentToolUseId: string | null;
    timeout: ReturnType<typeof setTimeout>;
  }>(); // request_id -> pending dynamic tool call metadata

  // Codex account rate limits (fetched after init, updated via notification)
  private _rateLimits: {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  } | null = null;
  // Codex can publish multiple limit buckets (for example, "codex" and model-specific IDs).
  // Keep the latest values per limitId and prefer the canonical "codex" bucket for UI parity
  // with the official usage page.
  private rateLimitsByLimitId = new Map<string, {
    primary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
    secondary: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null;
  }>();
  private static readonly DYNAMIC_TOOL_CALL_TIMEOUT_MS = 120_000;
  private static readonly VALID_REASONING_EFFORTS = new Set([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);

  constructor(proc: Subprocess, sessionId: string, options: CodexAdapterOptions = {}) {
    this.proc = proc;
    this.sessionId = sessionId;
    this.options = options;

    const stdout = proc.stdout;
    const stdin = proc.stdin;
    if (!stdout || !stdin || typeof stdout === "number" || typeof stdin === "number") {
      throw new Error("Codex process must have stdio pipes");
    }

    this.transport = new JsonRpcTransport(
      stdin as WritableStream<Uint8Array> | { write(data: Uint8Array): number },
      stdout as ReadableStream<Uint8Array>,
    );
    this.transport.onNotification((method, params) => this.handleNotification(method, params));
    this.transport.onRequest((method, id, params) => this.handleRequest(method, id, params));

    // Wire raw message recording + ring buffer for post-mortem debugging
    const recorder = options.recorder;
    const cwd = options.cwd || "";
    this.transport.onRawIncoming((line) => {
      recorder?.record(sessionId, "in", line, "cli", "codex", cwd);
      // Ring buffer: keep last N messages for debugging unexpected disconnects
      const truncated = line.length > 200 ? line.substring(0, 200) + "..." : line;
      this.recentRawMessages.push(truncated);
      if (this.recentRawMessages.length > CodexAdapter.RAW_MESSAGE_RING_SIZE) {
        this.recentRawMessages.shift();
      }
    });
    if (recorder) {
      this.transport.onRawOutgoing((data) => {
        recorder.record(sessionId, "out", data.trimEnd(), "cli", "codex", cwd);
      });
    }

    // Propagate transport close (stdout ends) to the adapter.
    // This fires independently of proc.exited — stdout can close while
    // the process node wrapper is still alive, leaving the adapter in a
    // stale "connected" state that rejects messages with "Transport closed".
    this.transport.onClose(() => {
      if (!this.connected) return; // already handled by proc.exited
      const pendingIds = [...this.transport.getPendingIds()];
      console.log(
        `[codex-adapter] Transport closed for session ${sessionId} (process may still be running)` +
        `${pendingIds.length ? `, pendingRpcIds=[${pendingIds.join(",")}]` : ""}`,
      );
      if (this.recentRawMessages.length > 0) {
        console.log(`[codex-adapter] Last ${this.recentRawMessages.length} raw messages before close for ${sessionId}:`);
        for (const msg of this.recentRawMessages) {
          console.log(`  ${msg}`);
        }
      }
      this.connected = false;
      // Wake any turn-end waiters so they don't hang after disconnect
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
      for (const pending of this.pendingDynamicToolCalls.values()) {
        clearTimeout(pending.timeout);
      }
      this.pendingDynamicToolCalls.clear();
      this.disconnectCb?.();
    });

    // Monitor process exit
    proc.exited.then((exitCode) => {
      if (!this.connected) return; // already handled by transport.onClose
      console.log(`[codex-adapter] Process exited for session ${sessionId} (code=${exitCode}, connected was true — transport.onClose did not fire first)`);
      this.connected = false;
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
      for (const pending of this.pendingDynamicToolCalls.values()) {
        clearTimeout(pending.timeout);
      }
      this.pendingDynamicToolCalls.clear();
      this.disconnectCb?.();
    });

    // Start initialization
    this.initialize();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  getRateLimits() {
    return this._rateLimits;
  }

  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    // If initialization failed, reject all new messages
    if (this.initFailed) {
      return false;
    }

    // Queue messages if not yet initialized (init is async)
    if (!this.initialized || !this.threadId) {
      if (
        msg.type === "user_message"
        || msg.type === "permission_response"
        || msg.type === "mcp_get_status"
        || msg.type === "mcp_toggle"
        || msg.type === "mcp_reconnect"
        || msg.type === "mcp_set_servers"
      ) {
        this.pendingOutgoing.push(msg);
        return true; // accepted, will be sent after init
      }
      // Non-queueable messages are dropped if not connected
      if (!this.connected) return false;
    }

    return this.dispatchOutgoing(msg);
  }

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        this.enqueueOutgoingDispatch("user_message", () => this.handleOutgoingUserMessage(msg));
        return true;
      case "permission_response":
        this.enqueueOutgoingDispatch("permission_response", () => this.handleOutgoingPermissionResponse(msg));
        return true;
      case "interrupt":
        this.enqueueOutgoingDispatch("interrupt", () => this.handleOutgoingInterrupt());
        return true;
      case "set_model":
        console.warn("[codex-adapter] Runtime model switching not supported by Codex");
        return false;
      case "set_permission_mode":
        console.warn("[codex-adapter] Runtime permission mode switching not supported by Codex");
        return false;
      case "mcp_get_status":
        this.enqueueOutgoingDispatch("mcp_get_status", () => this.handleOutgoingMcpGetStatus());
        return true;
      case "mcp_toggle":
        this.enqueueOutgoingDispatch("mcp_toggle", () => this.handleOutgoingMcpToggle(msg.serverName, msg.enabled));
        return true;
      case "mcp_reconnect":
        this.enqueueOutgoingDispatch("mcp_reconnect", () => this.handleOutgoingMcpReconnect());
        return true;
      case "mcp_set_servers":
        this.enqueueOutgoingDispatch("mcp_set_servers", () => this.handleOutgoingMcpSetServers(msg.servers));
        return true;
      default:
        return false;
    }
  }

  private enqueueOutgoingDispatch(
    label: string,
    run: () => Promise<void>,
  ): void {
    this.outgoingDispatchChain = this.outgoingDispatchChain
      .then(run)
      .catch((err) => {
        console.warn(`[codex-adapter] Outgoing dispatch failed (${label}) for session ${this.sessionId}:`, err);
      });
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: CodexSessionMeta) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  onInitError(cb: (error: string) => void): void {
    this.initErrorCb = cb;
  }

  onTurnStartFailed(cb: (msg: BrowserOutgoingMessage) => void): void {
    this.turnStartFailedCb = cb;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      this.proc.kill("SIGTERM");
      await Promise.race([
        this.proc.exited,
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } catch {}
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  private isMissingRolloutError(err: unknown): boolean {
    const message = String(err).toLowerCase();
    return message.includes("no rollout found") || message.includes("empty session file");
  }

  // ── Initialization ──────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    try {
      let resumeSnapshot: CodexResumeSnapshot | null = null;
      // Step 1: Send initialize request
      const result = await this.transport.call("initialize", {
        clientInfo: {
          name: "thecompanion",
          title: "The Companion",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      }) as Record<string, unknown>;

      // Step 2: Send initialized notification
      await this.transport.notify("initialized", {});

      this.connected = true;
      this.initialized = true;

      // Step 3: Start or resume a thread
      if (this.options.threadId) {
        try {
          // Resume an existing thread
          const resumeResult = await this.transport.call("thread/resume", {
            threadId: this.options.threadId,
            model: this.options.model,
            cwd: this.options.cwd,
            approvalPolicy: this.mapApprovalPolicy(this.options.approvalMode, this.options.askPermission),
            sandbox: this.options.sandbox || this.mapSandboxPolicy(this.options.approvalMode),
          }) as { thread: Record<string, unknown> & { id: string } };
          this.threadId = resumeResult.thread.id;
          resumeSnapshot = this.buildResumeSnapshot(resumeResult.thread);
          // Only set currentTurnId if the turn is truly in-progress AND the
          // thread itself isn't idle. After a CLI restart, the thread reports
          // idle but the last turn's status may still say "inProgress" — that
          // turn is stale (it was in-progress in the dead process).
          const threadIsIdle = resumeSnapshot?.threadStatus === "idle";
          this.currentTurnId =
            !threadIsIdle && resumeSnapshot?.lastTurn?.status === "inProgress"
              ? resumeSnapshot.lastTurn.id
              : null;
        } catch (err) {
          // Fresh or partially-initialized Codex threads may fail resume with
          // "no rollout found". Fall back to a fresh thread to avoid a stuck session.
          if (!this.isMissingRolloutError(err)) throw err;
          console.warn(
            `[codex-adapter] thread/resume failed for ${this.options.threadId}: ${err}. Starting a fresh thread.`,
          );
          const threadResult = await this.transport.call("thread/start", {
            model: this.options.model,
            cwd: this.options.cwd,
            approvalPolicy: this.mapApprovalPolicy(this.options.approvalMode, this.options.askPermission),
            sandbox: this.options.sandbox || this.mapSandboxPolicy(this.options.approvalMode),
          }) as { thread: { id: string } };
          this.threadId = threadResult.thread.id;
        }
      } else {
        // Start a new thread
        const threadResult = await this.transport.call("thread/start", {
          model: this.options.model,
          cwd: this.options.cwd,
          approvalPolicy: this.mapApprovalPolicy(this.options.approvalMode, this.options.askPermission),
          sandbox: this.options.sandbox || this.mapSandboxPolicy(this.options.approvalMode),
        }) as { thread: { id: string } };
        this.threadId = threadResult.thread.id;
      }

      // Notify session metadata
      this.sessionMetaCb?.({
        cliSessionId: this.threadId,
        model: this.options.model,
        cwd: this.options.cwd,
        resumeSnapshot,
      });

      // Send session_init to browser
      const state: SessionState = {
        session_id: this.sessionId,
        backend_type: "codex",
        model: this.options.model || "",
        cwd: this.options.cwd || "",
        tools: [],
        permissionMode: this.options.approvalMode || "suggest",
        claude_code_version: "",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        ...(this.options.reasoningEffort ? { codex_reasoning_effort: this.options.reasoningEffort } : {}),
      };

      this.emit({ type: "session_init", session: state });

      // Fetch initial rate limits — await so the RPC completes before flushing
      // queued messages. Without this, a concurrent rateLimits write and
      // turn/start write can interleave on the shared stdin pipe.
      try {
        const rateLimitsResult = await this.transport.call("account/rateLimits/read", {});
        this.updateRateLimits(rateLimitsResult as Record<string, unknown>);
      } catch { /* best-effort — don't fail init if rate limits fetch errors */ }

      // Flush any messages that were queued during initialization
      if (this.pendingOutgoing.length > 0) {
        const queued = this.pendingOutgoing.splice(0);
        for (const msg of queued) {
          this.dispatchOutgoing(msg);
        }
      }
    } catch (err) {
      const errorMsg = `Codex initialization failed: ${err}`;
      console.error(`[codex-adapter] ${errorMsg}`);
      this.initFailed = true;
      this.connected = false;
      // Discard any messages queued during the failed init attempt
      this.pendingOutgoing.length = 0;
      this.emit({ type: "error", message: errorMsg });
      this.initErrorCb?.(errorMsg);
    }
  }

  // ── Outgoing message handlers ───────────────────────────────────────────

  private async handleOutgoingUserMessage(
    msg: {
      type: "user_message";
      content: string;
      images?: { media_type: string; data: string }[];
      local_images?: string[];
      vscodeSelection?: import("./session-types.js").VsCodeSelectionMetadata;
    },
  ): Promise<void> {
    // User message is the latest completed message before Codex starts reasoning.
    this.markMessageFinished(Date.now());
    if (!this.threadId) {
      this.emit({ type: "error", message: "No Codex thread started yet" });
      return;
    }

    // If a turn is already in progress, interrupt it first and wait for it to
    // complete. Sending turn/start while a turn is active causes Codex to
    // error or crash (observed as sudden disconnects, especially with image
    // attachments whose large base64 payloads amplify the timing window).
    if (this.currentTurnId) {
      console.log(
        `[codex-adapter] Turn ${this.currentTurnId} already in progress for session ${this.sessionId}, interrupting before new turn`,
      );
      await this.interruptAndWaitForTurnEnd();
    }

    const input: Array<{
      type: string;
      text?: string;
      url?: string;
      path?: string;
      text_elements?: unknown[];
    }> = [];

    // Prefer local paths to avoid persisting large data: URLs in thread history.
    // Codex schema: UserInput::LocalImage => { type: "localImage", path }.
    if (msg.local_images?.length) {
      for (const path of msg.local_images) {
        input.push({
          type: "localImage",
          path,
        });
      }
    }

    // Inline base64 image transport is intentionally disabled for Codex.
    // Oversized data: URLs can silently drop whole turns; ws-bridge should
    // provide local_images paths instead.
    if (msg.images?.length) {
      console.warn(
        `[codex-adapter] Ignoring inline images for session ${this.sessionId}; expected local_images path references`,
      );
    }

    // Add text
    input.push({ type: "text", text: msg.content, text_elements: [] });
    if (msg.vscodeSelection) {
      const selection = msg.vscodeSelection;
      const selectionText = selection.startLine === selection.endLine
        ? `[user selection in VSCode: ${selection.relativePath} line ${selection.startLine}] (this may or may not be relevant)`
        : `[user selection in VSCode: ${selection.relativePath} lines ${selection.startLine}-${selection.endLine}] (this may or may not be relevant)`;
      input.push({ type: "text", text: selectionText, text_elements: [] });
    }

    // Log when payload is large (images, long prompts) to help diagnose
    // transport issues — Codex reads JSON-RPC from stdin, so huge lines
    // can cause event loop blocks and process crashes.
    const estimatedChars = input.reduce(
      (sum, i) => sum + (i.url?.length || 0) + (i.path?.length || 0) + (i.text?.length || 0),
      0,
    );
    if (estimatedChars > 500_000) {
      console.warn(
        `[codex-adapter] Large turn/start payload: ~${(estimatedChars / 1024).toFixed(0)}KB for session ${this.sessionId}`,
      );
    }

    const turnStartParams: Record<string, unknown> = {
      threadId: this.threadId,
      input,
      cwd: this.options.cwd,
    };
    const collaborationMode = this.collaborationModeSupported
      ? this.buildCollaborationModeOverride()
      : null;
    if (collaborationMode) {
      turnStartParams.collaborationMode = collaborationMode;
    }

    try {
      const result = await this.transport.call("turn/start", turnStartParams) as { turn: { id: string } };
      this.currentTurnId = result.turn.id;
    } catch (err) {
      // Older Codex builds may reject collaborationMode. If so, retry once
      // without it and remember to skip it for future turns.
      if (collaborationMode && this.isCollaborationModeUnsupportedError(err)) {
        this.collaborationModeSupported = false;
        delete turnStartParams.collaborationMode;
        console.warn(
          `[codex-adapter] collaborationMode not supported; falling back for session ${this.sessionId}`,
        );
        try {
          const retry = await this.transport.call("turn/start", turnStartParams) as { turn: { id: string } };
          this.currentTurnId = retry.turn.id;
          return;
        } catch (retryErr) {
          const requeued = this.handleTurnStartDispatchFailure(msg);
          if (requeued && this.isTransportClosedError(retryErr)) {
            console.warn(
              `[codex-adapter] turn/start transport closed; message re-queued for session ${this.sessionId}`,
            );
            return;
          }
          this.emit({ type: "error", message: `Failed to start turn: ${retryErr}` });
          return;
        }
      }

      const requeued = this.handleTurnStartDispatchFailure(msg);
      if (requeued && this.isTransportClosedError(err)) {
        console.warn(
          `[codex-adapter] turn/start transport closed; message re-queued for session ${this.sessionId}`,
        );
        return;
      }
      this.emit({ type: "error", message: `Failed to start turn: ${err}` });
    }
  }

  private async handleOutgoingPermissionResponse(
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown> },
  ): Promise<void> {
    const jsonRpcId = this.pendingApprovals.get(msg.request_id);
    if (jsonRpcId === undefined) {
      console.warn(`[codex-adapter] No pending approval for request_id=${msg.request_id}`);
      return;
    }

    // Dynamic tool calls (item/tool/call) require a DynamicToolCallResponse payload.
    const pendingDynamic = this.pendingDynamicToolCalls.get(msg.request_id);
    if (pendingDynamic) {
      this.pendingDynamicToolCalls.delete(msg.request_id);
      this.pendingApprovals.delete(msg.request_id);
      clearTimeout(pendingDynamic.timeout);

      const result = this.buildDynamicToolCallResponse(msg, pendingDynamic.toolName);
      await this.transport.respond(jsonRpcId, result);
      return;
    }

    this.pendingApprovals.delete(msg.request_id);

    // User input requests (item/tool/requestUserInput) need ToolRequestUserInputResponse
    const questionIds = this.pendingUserInputQuestionIds.get(msg.request_id);
    if (questionIds) {
      this.pendingUserInputQuestionIds.delete(msg.request_id);

      if (msg.behavior === "deny") {
        // Respond with empty answers on deny
        await this.transport.respond(jsonRpcId, { answers: {} });
        return;
      }

      // Convert browser answers (keyed by index "0","1",...) to Codex format (keyed by question ID)
      const browserAnswers = msg.updated_input?.answers as Record<string, string> || {};
      const codexAnswers: Record<string, { answers: string[] }> = {};
      for (let i = 0; i < questionIds.length; i++) {
        const answer = browserAnswers[String(i)];
        if (answer !== undefined) {
          codexAnswers[questionIds[i]] = { answers: [answer] };
        }
      }

      await this.transport.respond(jsonRpcId, { answers: codexAnswers });
      return;
    }

    // Review decisions (applyPatchApproval / execCommandApproval) need ReviewDecision
    if (this.pendingReviewDecisions.has(msg.request_id)) {
      this.pendingReviewDecisions.delete(msg.request_id);
      const decision = msg.behavior === "allow" ? "approved" : "denied";
      await this.transport.respond(jsonRpcId, { decision });
      return;
    }

    // Standard item/*/requestApproval — uses accept/decline
    const decision = msg.behavior === "allow" ? "accept" : "decline";
    await this.transport.respond(jsonRpcId, { decision });
  }

  private async handleOutgoingInterrupt(): Promise<void> {
    if (!this.threadId || !this.currentTurnId) return;

    try {
      await this.transport.call("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.currentTurnId,
      });
    } catch (err) {
      console.warn("[codex-adapter] Interrupt failed:", err);
    }
  }

  /**
   * Interrupt the current turn and wait for it to end (turn/completed
   * notification clears `currentTurnId`). Times out after 5s to avoid
   * hanging indefinitely if Codex never sends turn/completed.
   */
  private async interruptAndWaitForTurnEnd(): Promise<void> {
    await this.handleOutgoingInterrupt();

    if (!this.currentTurnId) return; // Already cleared

    const TIMEOUT_MS = 5_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Remove this resolver so handleTurnCompleted doesn't call stale fn
        const idx = this.turnEndResolvers.indexOf(onEnd);
        if (idx >= 0) this.turnEndResolvers.splice(idx, 1);
        if (this.currentTurnId) {
          console.warn(
            `[codex-adapter] Turn ${this.currentTurnId} did not complete within ${TIMEOUT_MS}ms after interrupt for session ${this.sessionId}, proceeding anyway`,
          );
          this.currentTurnId = null;
        }
        resolve();
      }, TIMEOUT_MS);

      const onEnd = () => {
        clearTimeout(timer);
        resolve();
      };
      this.turnEndResolvers.push(onEnd);
    });
  }

  private async handleOutgoingMcpGetStatus(): Promise<void> {
    try {
      const statusEntries = await this.listAllMcpServerStatuses();
      const configMap = await this.readMcpServersConfig();

      const names = new Set<string>([
        ...statusEntries.map((s) => s.name),
        ...Object.keys(configMap),
      ]);

      const statusByName = new Map(statusEntries.map((s) => [s.name, s]));
      const servers: McpServerDetail[] = Array.from(names).sort().map((name) => {
        const status = statusByName.get(name);
        const config = this.toMcpServerConfig(configMap[name]);
        const isEnabled = this.isMcpServerEnabled(configMap[name]);
        const serverStatus: McpServerDetail["status"] =
          !isEnabled
            ? "disabled"
            : (status?.authStatus === "notLoggedIn" ? "failed" : "connected");

        return {
          name,
          status: serverStatus,
          error: status?.authStatus === "notLoggedIn" ? "MCP server requires login" : undefined,
          config,
          scope: "user",
          tools: this.mapMcpTools(status?.tools),
        };
      });

      this.emit({ type: "mcp_status", servers });
    } catch (err) {
      this.emit({ type: "error", message: `Failed to get MCP status: ${err}` });
    }
  }

  private async handleOutgoingMcpToggle(serverName: string, enabled: boolean): Promise<void> {
    try {
      if (serverName.includes(".")) {
        throw new Error("Server names containing '.' are not supported for toggle");
      }
      await this.transport.call("config/value/write", {
        keyPath: `mcp_servers.${serverName}.enabled`,
        value: enabled,
        mergeStrategy: "upsert",
      });
      await this.reloadMcpServers();
      await this.handleOutgoingMcpGetStatus();
    } catch (err) {
      // Some existing configs may contain legacy/foreign fields (e.g. `transport`)
      // that fail on reload when touched. If so, remove this server entry entirely.
      const msg = String(err);
      if (msg.includes("invalid transport")) {
        try {
          await this.transport.call("config/value/write", {
            keyPath: `mcp_servers.${serverName}`,
            value: null,
            mergeStrategy: "replace",
          });
          await this.reloadMcpServers();
          await this.handleOutgoingMcpGetStatus();
          return;
        } catch {
          // fall through to user-visible error below
        }
      }
      this.emit({ type: "error", message: `Failed to toggle MCP server "${serverName}": ${err}` });
    }
  }

  private async handleOutgoingMcpReconnect(): Promise<void> {
    try {
      await this.reloadMcpServers();
      await this.handleOutgoingMcpGetStatus();
    } catch (err) {
      this.emit({ type: "error", message: `Failed to reload MCP servers: ${err}` });
    }
  }

  private async handleOutgoingMcpSetServers(servers: Record<string, McpServerConfig>): Promise<void> {
    try {
      const edits: Array<{ keyPath: string; value: Record<string, unknown>; mergeStrategy: "upsert" }> = [];
      for (const [name, config] of Object.entries(servers)) {
        if (name.includes(".")) {
          throw new Error(`Server names containing '.' are not supported: ${name}`);
        }
        edits.push({
          keyPath: `mcp_servers.${name}`,
          value: this.fromMcpServerConfig(config),
          mergeStrategy: "upsert",
        });
      }
      if (edits.length > 0) {
        await this.transport.call("config/batchWrite", {
          edits,
        });
      }
      await this.reloadMcpServers();
      await this.handleOutgoingMcpGetStatus();
    } catch (err) {
      this.emit({ type: "error", message: `Failed to configure MCP servers: ${err}` });
    }
  }

  // ── Incoming notification handlers ──────────────────────────────────────

  private handleNotification(method: string, params: Record<string, unknown>): void {
    // Verbose per-notification logging removed — use protocol recordings for debugging.

    try {
    switch (method) {
      case "item/started":
        this.handleItemStarted(params);
        break;
      case "codex/event/patch_apply_begin":
      case "codex/event/patch_apply_end":
        this.cachePatchApplyChanges(params);
        break;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(params);
        break;
      case "item/commandExecution/outputDelta":
        // Streaming command output — emit as tool_progress so the browser
        // can render live elapsed time and incremental terminal output.
        this.emitCommandProgress(params);
        break;
      case "item/fileChange/outputDelta":
        // Streaming file change output. Same as above.
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded":
        this.handleReasoningDelta(params);
        break;
      case "item/mcpToolCall/progress": {
        // MCP tool call progress — map to tool_progress
        const itemId = params.itemId as string | undefined;
        const threadId = params.threadId as string | undefined;
        if (itemId) {
          this.emit({
            type: "tool_progress",
            tool_use_id: itemId,
            tool_name: "mcp_tool_call",
            elapsed_time_seconds: 0,
          });
        }
        break;
      }
      case "item/plan/delta":
        this.emitPlanTodoWrite(params, "item_plan_delta");
        break;
      case "item/updated":
        this.handleItemUpdated(params);
        break;
      case "item/completed":
        this.handleItemCompleted(params);
        break;
      case "rawResponseItem/completed":
        // Raw model response — internal, not needed for UI.
        break;
      case "turn/started":
        // Turn started, nothing to emit
        break;
      case "turn/completed":
        this.handleTurnCompleted(params);
        break;
      case "turn/plan/updated":
        this.emitPlanTodoWrite(params, "turn_plan_updated");
        break;
      case "codex/event/task_complete":
        this.handleSubagentTaskComplete(params);
        break;
      case "turn/diff/updated":
        // Could show diff, but not needed for MVP
        break;
      case "thread/started":
        // Thread started after init — nothing to emit.
        break;
      case "thread/status/changed":
        this.handleThreadStatusChanged(params);
        break;
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(params);
        break;
      case "account/updated":
      case "account/login/completed":
        // Auth events
        break;
      case "account/rateLimits/updated":
        this.updateRateLimits(params);
        break;
      case "codex/event/stream_error": {
        const msg = params.msg as { message?: string } | undefined;
        if (msg?.message) {
          console.log(`[codex-adapter] Stream error: ${msg.message}`);
        }
        break;
      }
      case "codex/event/error": {
        const msg = params.msg as { message?: string } | undefined;
        if (msg?.message) {
          console.error(`[codex-adapter] Codex error: ${msg.message}`);
          this.emit({ type: "error", message: msg.message });
        }
        break;
      }
      default:
        // Unknown notification, log for debugging
        // Silently ignore — protocol recordings capture all messages for debugging.
        break;
    }
    } catch (err) {
      console.error(`[codex-adapter] Error handling notification ${method}:`, err);
    }
  }

  private cachePatchApplyChanges(params: Record<string, unknown>): void {
    const msg = params.msg as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== "object") return;
    const callId = toSafeText(msg.call_id ?? msg.callId).trim();
    if (!callId) return;
    const changes = mapUnknownFileChangesForTool(msg.changes);
    if (changes.length > 0) {
      this.patchChangesByCallId.set(callId, changes);
    }
  }

  private resolveFileChangesForTool(toolUseId: string, rawChanges: unknown): ToolFileChange[] {
    const direct = mapUnknownFileChangesForTool(rawChanges);
    const cached = this.patchChangesByCallId.get(toolUseId) || [];
    if (cached.length === 0) return direct;
    if (direct.length === 0) return cached;
    if (!hasAnyPatchDiff(direct) && hasAnyPatchDiff(cached)) return cached;
    return direct;
  }

  private getThreadIdFromRecord(record: Record<string, unknown> | undefined): string | null {
    if (!record) return null;
    const threadId = toSafeText(
      record.threadId
      ?? record.senderThreadId
      ?? record.conversationId
      ?? record.conversation_id
      ?? record.new_thread_id,
    ).trim();
    return threadId || null;
  }

  private getThreadIdFromParams(params: Record<string, unknown>): string | null {
    const direct = this.getThreadIdFromRecord(params);
    if (direct) return direct;

    for (const key of ["item", "turn", "msg"]) {
      const value = params[key];
      if (value && typeof value === "object") {
        const nested = this.getThreadIdFromRecord(value as Record<string, unknown>);
        if (nested) return nested;
      }
    }

    return null;
  }

  private getParentToolUseIdForThreadId(threadId: string | null | undefined): string | null {
    if (!threadId) return null;
    return this.parentToolUseIdByThreadId.get(threadId) ?? null;
  }

  private resolveParentToolUseId(params: Record<string, unknown>, itemId?: string): string | null {
    if (itemId && this.parentToolUseIdByItemId.has(itemId)) {
      return this.parentToolUseIdByItemId.get(itemId) ?? null;
    }
    return this.getParentToolUseIdForThreadId(this.getThreadIdFromParams(params));
  }

  private extractSubagentRole(item: CodexCollabAgentToolCallItem): string {
    if (Array.isArray(item.agentsStates)) {
      for (const agentState of item.agentsStates) {
        if (!agentState || typeof agentState !== "object") continue;
        const role = toSafeText((agentState as Record<string, unknown>).role).trim();
        if (role) return role;
      }
    }
    return "";
  }

  private extractSubagentLabel(item: CodexCollabAgentToolCallItem): string {
    if (Array.isArray(item.agentsStates)) {
      for (const agentState of item.agentsStates) {
        if (!agentState || typeof agentState !== "object") continue;
        const rec = agentState as Record<string, unknown>;
        const nickname = toSafeText(rec.nickname ?? rec.agentNickname ?? rec.name).trim();
        if (nickname) return nickname;
      }
    }
    return "";
  }

  private handleSubagentTaskComplete(params: Record<string, unknown>): void {
    const msg = params.msg as Record<string, unknown> | undefined;
    const threadId = this.getThreadIdFromParams(params);
    const toolUseId = this.getParentToolUseIdForThreadId(threadId);
    if (!toolUseId) return;

    const resultText = toSafeText(
      msg?.last_agent_message
      ?? params.last_agent_message
      ?? msg?.summary
      ?? params.summary
      ?? msg?.message
      ?? params.message,
    ).trim() || "Subagent completed";

    const parentToolUseId = this.pendingSubagentToolUsesByCallId.get(toolUseId)?.parentToolUseId ?? null;
    this.emitToolResult(toolUseId, resultText, false, parentToolUseId);
  }

  // ── Incoming request handlers (approval requests) ───────────────────────

  private handleRequest(method: string, id: number, params: Record<string, unknown>): void {
    try {
      switch (method) {
        case "item/commandExecution/requestApproval":
          this.handleCommandApproval(id, params);
          break;
        case "item/fileChange/requestApproval":
          this.handleFileChangeApproval(id, params);
          break;
        case "item/mcpToolCall/requestApproval":
          this.handleMcpToolCallApproval(id, params);
          break;
        case "item/tool/call":
          this.handleDynamicToolCall(id, params);
          break;
        case "item/tool/requestUserInput":
          this.handleUserInputRequest(id, params);
          break;
        case "applyPatchApproval":
          this.handleApplyPatchApproval(id, params);
          break;
        case "execCommandApproval":
          this.handleExecCommandApproval(id, params);
          break;
        case "account/chatgptAuthTokens/refresh":
          console.warn("[codex-adapter] Auth token refresh not supported");
          this.transport.respond(id, { error: "not supported" });
          break;
        default:
          // Auto-accept unknown requests
          this.transport.respond(id, { decision: "accept" });
          break;
      }
    } catch (err) {
      console.error(`[codex-adapter] Error handling request ${method}:`, err);
    }
  }

  private handleCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const command = params.command as string | string[] | undefined;
    const parsedCmd = params.parsedCmd as string | undefined;
    const commandStr = (typeof parsedCmd === "string" && parsedCmd.trim())
      ? parsedCmd
      : formatCommandForDisplay(command, params.commandActions);

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Bash",
      input: {
        command: commandStr,
        cwd: params.cwd as string || this.options.cwd || "",
      },
      description: params.reason as string || `Execute: ${commandStr}`,
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleFileChangeApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    // Extract file paths from changes array if available
    const rawChanges = Array.isArray(params.changes) ? params.changes as Array<Record<string, unknown>> : [];
    const changes = mapFileChangesForTool(rawChanges);
    const filePaths = changes.map((c) => c.path).filter(Boolean);
    const fileList = filePaths.length > 0 ? filePaths.join(", ") : undefined;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Edit",
      input: {
        description: params.reason as string || "File changes pending approval",
        ...(filePaths[0] ? { file_path: filePaths[0] } : {}),
        ...(filePaths.length > 0 && { file_paths: filePaths }),
        ...(changes.length > 0 && { changes }),
      },
      description: params.reason as string || (fileList ? `Codex wants to modify: ${fileList}` : "Codex wants to modify files"),
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleMcpToolCallApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-approval-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const server = params.server as string || "unknown";
    const tool = params.tool as string || "unknown";
    const args = params.arguments as Record<string, unknown> || {};

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: `mcp:${server}:${tool}`,
      input: args,
      description: params.reason as string || `MCP tool call: ${server}/${tool}`,
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleDynamicToolCall(jsonRpcId: number, params: Record<string, unknown>): void {
    const callId = params.callId as string || `dynamic-${randomUUID()}`;
    const toolName = params.tool as string || "unknown_dynamic_tool";
    const toolArgs = params.arguments as Record<string, unknown> || {};
    const requestId = `codex-dynamic-${randomUUID()}`;
    const parentToolUseId = this.resolveParentToolUseId(params, callId);

    // Emit tool_use so the browser sees this custom tool invocation.
    this.emitToolUseTracked(callId, `dynamic:${toolName}`, toolArgs, { parentToolUseId });

    this.pendingApprovals.set(requestId, jsonRpcId);
    const timeout = setTimeout(() => {
      this.resolveDynamicToolCallTimeout(requestId);
    }, CodexAdapter.DYNAMIC_TOOL_CALL_TIMEOUT_MS);

    this.pendingDynamicToolCalls.set(requestId, {
      jsonRpcId,
      callId,
      toolName,
      parentToolUseId,
      timeout,
    });

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: `dynamic:${toolName}`,
      input: {
        ...toolArgs,
        call_id: callId,
      },
      description: `Custom tool call: ${toolName}`,
      tool_use_id: callId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private async resolveDynamicToolCallTimeout(requestId: string): Promise<void> {
    const pending = this.pendingDynamicToolCalls.get(requestId);
    if (!pending) return;

    this.pendingDynamicToolCalls.delete(requestId);
    this.pendingApprovals.delete(requestId);

    this.emitToolResult(
      pending.callId,
      `Dynamic tool "${pending.toolName}" timed out waiting for output.`,
      true,
      pending.parentToolUseId,
    );

    try {
      await this.transport.respond(pending.jsonRpcId, {
        contentItems: [{ type: "inputText", text: `Timed out waiting for dynamic tool output: ${pending.toolName}` }],
        success: false,
      });
    } catch (err) {
      console.warn(`[codex-adapter] Failed to send dynamic tool timeout response: ${err}`);
    }
  }

  private buildDynamicToolCallResponse(
    msg: { behavior: "allow" | "deny"; updated_input?: Record<string, unknown> },
    toolName: string,
  ): { contentItems: unknown[]; success: boolean; structuredContent?: unknown } {
    if (msg.behavior === "deny") {
      return {
        contentItems: [{ type: "inputText", text: `Dynamic tool "${toolName}" was denied by user` }],
        success: false,
      };
    }

    const rawContentItems = msg.updated_input?.contentItems;
    const contentItems = Array.isArray(rawContentItems) && rawContentItems.length > 0
      ? rawContentItems
      : [{ type: "inputText", text: String(msg.updated_input?.text || "Dynamic tool call completed") }];

    const success = typeof msg.updated_input?.success === "boolean"
      ? msg.updated_input.success
      : true;

    const structuredContent = msg.updated_input?.structuredContent;

    return {
      contentItems,
      success,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    };
  }

  private handleUserInputRequest(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-userinput-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);

    const questions = params.questions as Array<{
      id: string; header: string; question: string;
      isOther: boolean; isSecret: boolean;
      options: Array<{ label: string; description: string }> | null;
    }> || [];

    // Store question IDs so we can map browser indices back to Codex IDs in the response
    this.pendingUserInputQuestionIds.set(requestId, questions.map((q) => q.id));

    // Convert to our AskUserQuestion format (matches AskUserQuestionDisplay component)
    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "AskUserQuestion",
      input: {
        questions: questions.map((q) => ({
          header: q.header,
          question: q.question,
          options: q.options?.map((o) => ({ label: o.label, description: o.description })) || [],
        })),
      },
      description: questions[0]?.question || "User input requested",
      tool_use_id: params.itemId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleApplyPatchApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-patch-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);
    this.pendingReviewDecisions.add(requestId);

    const fileChanges = params.fileChanges as Record<string, unknown> || {};
    const changes = mapFileChangesObjectForTool(fileChanges);
    const filePaths = changes.map((c) => c.path).filter(Boolean);
    const reason = params.reason as string | null;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Edit",
      input: {
        ...(filePaths[0] ? { file_path: filePaths[0] } : {}),
        file_paths: filePaths,
        ...(changes.length > 0 ? { changes } : {}),
        ...(reason && { reason }),
      },
      description: reason || (filePaths.length > 0
        ? `Codex wants to modify: ${filePaths.join(", ")}`
        : "Codex wants to modify files"),
      tool_use_id: params.callId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  private handleExecCommandApproval(jsonRpcId: number, params: Record<string, unknown>): void {
    const requestId = `codex-exec-${randomUUID()}`;
    this.pendingApprovals.set(requestId, jsonRpcId);
    this.pendingReviewDecisions.add(requestId);

    const command = params.command as string | string[] | undefined;
    const commandStr = formatCommandForDisplay(command, params.commandActions);
    const cwd = params.cwd as string || this.options.cwd || "";
    const reason = params.reason as string | null;

    const perm: PermissionRequest = {
      request_id: requestId,
      tool_name: "Bash",
      input: {
        command: commandStr,
        cwd,
      },
      description: reason || `Execute: ${commandStr}`,
      tool_use_id: params.callId as string || requestId,
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: perm });
  }

  // ── Item event handlers ─────────────────────────────────────────────────

  private handleItemStarted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;
    const parentToolUseId = this.resolveParentToolUseId(params, item.id);
    this.parentToolUseIdByItemId.set(item.id, parentToolUseId);

    switch (item.type) {
      case "agentMessage":
        // Start streaming accumulation
        this.streamingItemId = item.id;
        this.streamingText = "";
        // Emit message_start stream event so the browser knows streaming began
        this.emit({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: this.makeMessageId("agent", item.id),
              type: "message",
              role: "assistant",
              model: this.options.model || "",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
          },
          parent_tool_use_id: parentToolUseId,
        });
        // Also emit content_block_start
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          parent_tool_use_id: parentToolUseId,
        });
        break;

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = formatCommandForDisplay(cmd.command, cmd.commandActions);
        this.commandStartTimes.set(item.id, Date.now());
        this.commandOutputByItemId.delete(item.id);
        this.emitToolUseStart(item.id, "Bash", { command: commandStr }, { parentToolUseId });
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const changes = this.resolveFileChangesForTool(item.id, fc.changes);
        if (changes.length === 0 || !hasAnyPatchDiff(changes)) {
          // item/started can arrive with path/kind but no diff; defer to item/completed.
          break;
        }
        const firstChange = changes[0];
        const toolName = safeKind(firstChange?.kind) === "create" ? "Write" : "Edit";
        const toolInput = {
          file_path: firstChange?.path || "",
          changes,
        };
        this.emitToolUseStart(item.id, toolName, toolInput, { parentToolUseId });
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        this.emitToolUseStart(item.id, `mcp:${mcp.server}:${mcp.tool}`, mcp.arguments || {}, { parentToolUseId });
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        this.emitToolUseStart(item.id, "WebSearch", { query: extractWebSearchQuery(ws) }, { parentToolUseId });
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        this.reasoningTextByItemId.set(item.id, r.summary || r.content || "");
        if (typeof this.lastMessageFinishedAt === "number") {
          this.reasoningTimeFromLastMessageByItemId.set(item.id, Math.max(0, Date.now() - this.lastMessageFinishedAt));
        }
        // Emit as thinking content block
        if (r.summary || r.content) {
          this.emit({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: r.summary || r.content || "" },
            },
            parent_tool_use_id: parentToolUseId,
          });
        }
        break;
      }

      case "collabAgentToolCall": {
        const collab = item as CodexCollabAgentToolCallItem;
        if (collab.tool !== "spawnAgent") break;
        const senderThreadId = toSafeText(collab.senderThreadId).trim() || this.getThreadIdFromParams(params);
        this.pendingSubagentToolUsesByCallId.set(item.id, {
          prompt: toSafeText(collab.prompt).trim(),
          startedAt: Date.now(),
          senderThreadId: senderThreadId || null,
          parentToolUseId: this.getParentToolUseIdForThreadId(senderThreadId),
        });
        break;
      }

      case "contextCompaction":
        this.emit({ type: "status_change", status: "compacting" });
        break;

      default:
        // userMessage is an echo of browser input and not needed in UI.
        // Silently ignore unknown item types — recordings capture everything.
        break;
    }
  }

  private handleReasoningDelta(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;

    if (!this.reasoningTextByItemId.has(itemId)) {
      this.reasoningTextByItemId.set(itemId, "");
    }

    const delta = params.delta as string | undefined;
    if (delta) {
      const current = this.reasoningTextByItemId.get(itemId) || "";
      this.reasoningTextByItemId.set(itemId, current + delta);
    }
  }

  private handleAgentMessageDelta(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    const delta = params.delta as string;
    if (!delta) return;

    this.streamingText += delta;
    const parentToolUseId = this.resolveParentToolUseId(params, itemId);

    // Emit as content_block_delta (matches Claude's streaming format)
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta },
      },
      parent_tool_use_id: parentToolUseId,
    });
  }

  private handleItemUpdated(params: Record<string, unknown>): void {
    // item/updated is a general update — currently we handle streaming via the specific delta events
    // Could handle status updates for command_execution / file_change items here
  }

  private normalizePlanStatus(value: unknown): "pending" | "in_progress" | "completed" {
    const status = toSafeText(value).toLowerCase();
    if (status.includes("done") || status.includes("complete") || status.includes("finished")) return "completed";
    if (
      status.includes("progress")
      || status.includes("doing")
      || status.includes("active")
      || status.includes("running")
      || status.includes("current")
    ) return "in_progress";
    return "pending";
  }

  private extractPlanTodos(
    params: Record<string, unknown>,
  ): Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> {
    const todos: Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> = [];
    const seen = new Set<unknown>();

    const pushTodo = (value: unknown): void => {
      if (typeof value === "string") {
        const content = value.trim();
        if (content) todos.push({ content, status: "pending" });
        return;
      }
      if (!value || typeof value !== "object") return;
      const rec = value as Record<string, unknown>;
      const content = toSafeText(
        rec.content ?? rec.text ?? rec.title ?? rec.step ?? rec.name ?? rec.description ?? rec.task,
      ).trim();
      if (!content) return;
      const activeForm = toSafeText(rec.activeForm ?? rec.active_form ?? rec.inProgressForm).trim() || undefined;
      todos.push({ content, status: this.normalizePlanStatus(rec.status ?? rec.state), activeForm });
    };

    const walk = (value: unknown): void => {
      if (value == null || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const entry of value) {
          pushTodo(entry);
          walk(entry);
        }
        return;
      }
      if (typeof value !== "object") return;
      const rec = value as Record<string, unknown>;
      for (const key of ["todos", "steps", "items", "plan", "checklist", "tasks", "value", "delta"]) {
        if (key in rec) walk(rec[key]);
      }
    };

    walk(params);
    if (todos.length > 0) return todos;

    // Fallback: parse markdown checkbox lines from textual deltas.
    const rawDelta = toSafeText(params.delta ?? params.text ?? params.plan ?? "");
    if (!rawDelta) return todos;
    for (const line of rawDelta.split("\n")) {
      const match = line.match(/^\s*[-*]\s*\[([ xX])\]\s+(.+)$/);
      if (!match) continue;
      todos.push({
        content: match[2].trim(),
        status: match[1].toLowerCase() === "x" ? "completed" : "pending",
      });
    }
    return todos;
  }

  private emitPlanTodoWrite(params: Record<string, unknown>, source: "item_plan_delta" | "turn_plan_updated"): void {
    const todos = this.extractPlanTodos(params);
    if (todos.length === 0) return;

    const key = toSafeText(params.turnId ?? params.itemId ?? params.threadId ?? source) || source;
    const signature = JSON.stringify(todos);
    if (this.planSignatureByKey.get(key) === signature) return;
    this.planSignatureByKey.set(key, signature);

    const toolUseId = `codex-plan-${key}-${++this.planToolUseSeq}`;
    this.emitToolUseTracked(toolUseId, "TodoWrite", { todos }, {
      parentToolUseId: this.resolveParentToolUseId(params, toolUseId),
    });
  }

  private handleItemCompleted(params: Record<string, unknown>): void {
    const item = params.item as CodexItem;
    if (!item) return;
    const parentToolUseId = this.resolveParentToolUseId(params, item.id);

    switch (item.type) {
      case "agentMessage": {
        const agentMsg = item as CodexAgentMessageItem;
        const text = agentMsg.text || this.streamingText;
        const completedAt = Date.now();

        // Emit message_stop for streaming
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: parentToolUseId,
        });
        this.emit({
          type: "stream_event",
          event: {
            type: "message_delta",
            delta: { stop_reason: null }, // null, not "end_turn" — the turn may continue with tool calls
            usage: { output_tokens: 0 },
          },
          parent_tool_use_id: parentToolUseId,
        });

        // Emit the full assistant message
        this.emit({
          type: "assistant",
          message: {
            id: this.makeMessageId("agent", item.id),
            type: "message",
            role: "assistant",
            model: this.options.model || "",
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: parentToolUseId,
          timestamp: completedAt,
        });
        this.markMessageFinished(completedAt);

        // Reset streaming state
        this.streamingText = "";
        this.streamingItemId = null;
        break;
      }

      case "commandExecution": {
        const cmd = item as CodexCommandExecutionItem;
        const commandStr = formatCommandForDisplay(cmd.command, cmd.commandActions);
        // Ensure tool_use was emitted (may be skipped when auto-approved)
        this.ensureToolUseEmitted(item.id, "Bash", { command: commandStr }, { parentToolUseId });
        // Clean up progress tracking
        this.commandStartTimes.delete(item.id);
        const streamedOutput = (this.commandOutputByItemId.get(item.id) || "").trim();
        this.commandOutputByItemId.delete(item.id);
        // Emit tool result
        const cmdRecord = item as Record<string, unknown>;
        // Codex often only sets aggregatedOutput/formatted_output on completion
        // (without stdout/stderr), so we must check all known output fields.
        const output = firstNonEmptyString(cmdRecord, [
          "stdout",
          "aggregatedOutput",
          "aggregated_output",
          "formatted_output",
          "output",
        ]);
        const stderr = firstNonEmptyString(cmdRecord, [
          "stderr",
          "errorOutput",
          "error_output",
        ]);
        const directOutput = [output, stderr].filter(Boolean).join("\n").trim();
        const combinedOutput = directOutput || streamedOutput;
        const exitCode = typeof cmd.exitCode === "number" ? cmd.exitCode : 0;
        const durationMs = typeof cmd.durationMs === "number" ? cmd.durationMs : undefined;
        const failed = cmd.status === "failed" || cmd.status === "declined" || exitCode !== 0;

        // Keep successful no-output commands silent in the chat feed.
        if (!combinedOutput && !failed) {
          break;
        }

        let resultText = combinedOutput;
        if (!resultText) {
          resultText = `Exit code: ${exitCode}`;
        } else if (exitCode !== 0) {
          resultText = `${resultText}\nExit code: ${exitCode}`;
        }
        // Append duration if available and significant (>100ms)
        if (durationMs !== undefined && durationMs >= 100) {
          const durationStr = durationMs >= 1000
            ? `${(durationMs / 1000).toFixed(1)}s`
            : `${durationMs}ms`;
          resultText = `${resultText}\n(${durationStr})`;
        }

        this.emitToolResult(item.id, resultText, failed, parentToolUseId);
        break;
      }

      case "fileChange": {
        const fc = item as CodexFileChangeItem;
        const changes = this.resolveFileChangesForTool(item.id, fc.changes);
        const firstChange = changes[0];
        const toolName = safeKind(firstChange?.kind) === "create" ? "Write" : "Edit";
        // Ensure tool_use was emitted
        this.ensureToolUseEmitted(item.id, toolName, {
          file_path: firstChange?.path || "",
          changes,
        }, { parentToolUseId });
        const summary = changes.map((c) => `${safeKind(c.kind)}: ${c.path}`).join("\n");
        this.emitToolResult(item.id, summary || "File changes applied", fc.status === "failed", parentToolUseId);
        this.patchChangesByCallId.delete(item.id);
        break;
      }

      case "mcpToolCall": {
        const mcp = item as CodexMcpToolCallItem;
        // Ensure tool_use was emitted
        this.ensureToolUseEmitted(item.id, `mcp:${mcp.server}:${mcp.tool}`, mcp.arguments || {}, { parentToolUseId });
        this.emitToolResult(item.id, mcp.result || mcp.error || "MCP tool call completed", mcp.status === "failed", parentToolUseId);
        break;
      }

      case "webSearch": {
        const ws = item as CodexWebSearchItem;
        const wsQuery = extractWebSearchQuery(ws);
        // Ensure tool_use was emitted
        this.ensureToolUseEmitted(item.id, "WebSearch", { query: wsQuery }, { parentToolUseId });
        // Only emit a result if there's meaningful content beyond the query
        // itself. Codex web search items often lack structured result data,
        // causing extractWebSearchResultText to return the query or a generic
        // placeholder — showing that as "RESULT" is confusing.
        const wsResult = extractWebSearchResultText(ws);
        if (wsResult && wsResult !== wsQuery && wsResult !== "Web search completed") {
          this.emitToolResult(item.id, wsResult, false, parentToolUseId);
        }
        break;
      }

      case "reasoning": {
        const r = item as CodexReasoningItem;
        const bufferedText = toSafeText(this.reasoningTextByItemId.get(item.id)).trim();
        const fallbackText = toSafeText(r.summary ?? r.content ?? "").trim();
        const thinkingText = bufferedText || fallbackText;
        const completedAt = Date.now();
        let thinkingTimeMs = this.reasoningTimeFromLastMessageByItemId.get(item.id);
        if (thinkingTimeMs === undefined && typeof this.lastMessageFinishedAt === "number") {
          // Fallback when item/started was skipped: use completion arrival time.
          thinkingTimeMs = Math.max(0, completedAt - this.lastMessageFinishedAt);
        }

        if (thinkingText) {
          this.emit({
            type: "assistant",
            message: {
              id: this.makeMessageId("reasoning", item.id),
              type: "message",
              role: "assistant",
              model: this.options.model || "",
              content: [{ type: "thinking", thinking: thinkingText, ...(thinkingTimeMs !== undefined ? { thinking_time_ms: thinkingTimeMs } : {}) }],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
            parent_tool_use_id: parentToolUseId,
            timestamp: completedAt,
          });
          this.markMessageFinished(completedAt);
        }

        this.reasoningTextByItemId.delete(item.id);
        this.reasoningTimeFromLastMessageByItemId.delete(item.id);

        // Close the thinking content block that was opened in handleItemStarted
        this.emit({
          type: "stream_event",
          event: {
            type: "content_block_stop",
            index: 0,
          },
          parent_tool_use_id: parentToolUseId,
        });
        break;
      }

      case "collabAgentToolCall": {
        const collab = item as CodexCollabAgentToolCallItem;
        if (collab.tool !== "spawnAgent") break;

        const pending = this.pendingSubagentToolUsesByCallId.get(item.id);
        const role = this.extractSubagentRole(collab);
        const description = this.extractSubagentLabel(collab) || role || "Subagent";
        const effectiveParentToolUseId = pending?.parentToolUseId ?? parentToolUseId;
        const input: Record<string, unknown> = {
          prompt: toSafeText(collab.prompt).trim() || pending?.prompt || "",
          description,
          subagent_type: role,
        };

        this.ensureToolUseEmitted(item.id, "Agent", input, {
          parentToolUseId: effectiveParentToolUseId,
          timestamp: pending?.startedAt,
        });

        if (Array.isArray(collab.receiverThreadIds)) {
          for (const threadId of collab.receiverThreadIds) {
            if (typeof threadId === "string" && threadId.trim()) {
              this.parentToolUseIdByThreadId.set(threadId, item.id);
            }
          }
        }

        if (collab.status === "failed" || collab.status === "declined") {
          const errorText = toSafeText(collab.error).trim() || "Subagent failed";
          this.emitToolResult(item.id, errorText, true, effectiveParentToolUseId);
        }

        break;
      }

      case "contextCompaction":
        this.emit({ type: "status_change", status: null });
        break;

      default:
        // Silently ignore unknown item types — recordings capture everything.
        break;
    }
  }

  private handleThreadStatusChanged(params: Record<string, unknown>): void {
    const status = params.status as Record<string, unknown> | undefined;
    if (!status) return;
    const threadId = this.getThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) return;

    if (status.type === "idle" && this.currentTurnId) {
      console.log(
        `[codex-adapter] Thread reported idle while currentTurnId=${this.currentTurnId} is set; clearing stale turn for session ${this.sessionId}`,
      );
      this.currentTurnId = null;
      for (const resolve of this.turnEndResolvers.splice(0)) resolve();
    }
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = params.turn as { id: string; status: string; error?: { message: string } } | undefined;
    const threadId = this.getThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) {
      return;
    }

    this.currentTurnId = null;
    // Wake any callers waiting for the turn to end (e.g. interruptAndWaitForTurnEnd)
    for (const resolve of this.turnEndResolvers.splice(0)) resolve();

    // Always emit a result — even for interrupted turns — so the server
    // transitions to idle. For internal interrupts (new message while a turn
    // was active), the next turn/start will immediately set generating=true
    // again, so the brief idle flash is imperceptible.

    // Synthesize a CLIResultMessage-like structure
    const isSuccess = turn?.status === "completed" || turn?.status === "interrupted";
    const result: CLIResultMessage = {
      type: "result",
      subtype: isSuccess ? "success" : "error_during_execution",
      is_error: !isSuccess,
      result: turn?.error?.message,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: turn?.status || "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: randomUUID(),
      session_id: this.sessionId,
    };

    this.emit({ type: "result", data: result });
  }

  private updateRateLimits(data: Record<string, unknown>): void {
    const normalizeLimit = (value: unknown) => {
      if (!value || typeof value !== "object") return null;
      const raw = value as Record<string, unknown>;
      const usedRaw = Number(raw.usedPercent ?? 0);
      // Codex has been observed to report this as either 0..100 or 0..1.
      // Use strict < 1 to avoid treating usedPercent:1 (1%) as 0..1 format → 100%.
      const normalizedPercent = Number.isFinite(usedRaw)
        ? (usedRaw > 0 && usedRaw < 1 ? usedRaw * 100 : usedRaw)
        : 0;
      const usedPercent = Math.max(0, Math.min(100, normalizedPercent));
      const windowDurationMins = Number(raw.windowDurationMins ?? 0);
      let resetsAt = 0;
      const rawResetsAt = raw.resetsAt;
      if (typeof rawResetsAt === "number" && Number.isFinite(rawResetsAt)) {
        resetsAt = rawResetsAt;
      } else if (typeof rawResetsAt === "string") {
        const asNumber = Number(rawResetsAt);
        if (Number.isFinite(asNumber)) {
          resetsAt = asNumber;
        } else {
          const asDateMs = Date.parse(rawResetsAt);
          if (Number.isFinite(asDateMs)) resetsAt = asDateMs;
        }
      }
      return {
        usedPercent,
        windowDurationMins: Number.isFinite(windowDurationMins) ? windowDurationMins : 0,
        resetsAt,
      };
    };
    const normalizeRateLimitSet = (value: unknown) => {
      if (!value || typeof value !== "object") return null;
      const raw = value as Record<string, unknown>;
      return {
        primary: normalizeLimit(raw.primary),
        secondary: normalizeLimit(raw.secondary),
      };
    };

    const direct = data?.rateLimits as Record<string, unknown> | undefined;
    const directNormalized = normalizeRateLimitSet(direct);
    const directLimitId = typeof direct?.limitId === "string" ? direct.limitId : null;
    if (directLimitId && directNormalized) {
      this.rateLimitsByLimitId.set(directLimitId, directNormalized);
    }

    const byId = data?.rateLimitsByLimitId as Record<string, unknown> | undefined;
    if (byId && typeof byId === "object") {
      for (const [limitId, limitData] of Object.entries(byId)) {
        const parsed = normalizeRateLimitSet(limitData);
        if (parsed) this.rateLimitsByLimitId.set(limitId, parsed);
      }
    }

    this._rateLimits =
      this.rateLimitsByLimitId.get("codex")
      ?? (directLimitId ? this.rateLimitsByLimitId.get(directLimitId) ?? null : null)
      ?? directNormalized
      ?? null;

    if (!this._rateLimits) return;

    // Forward rate limits to browser for UI display
    this.emit({
      type: "session_update",
      session: {
        codex_rate_limits: {
          primary: this._rateLimits.primary,
          secondary: this._rateLimits.secondary,
        },
      },
    });
  }

  private handleTokenUsageUpdated(params: Record<string, unknown>): void {
    // Codex sends: { threadId, turnId, tokenUsage: {
    //   total: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens },
    //   last: { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens },
    //   modelContextWindow: 258400
    // }}
    // IMPORTANT: `total` is cumulative across all turns and can far exceed the context window.
    // `last` is the most recent turn — its inputTokens reflects what's actually in context.
    const threadId = this.getThreadIdFromParams(params);
    if (threadId && this.threadId && threadId !== this.threadId) return;
    const tokenUsage = params.tokenUsage as Record<string, unknown> | undefined;
    if (!tokenUsage) return;

    const total = tokenUsage.total as Record<string, number> | undefined;
    const last = tokenUsage.last as Record<string, number> | undefined;
    const contextWindow = tokenUsage.modelContextWindow as number | undefined;

    const updates: Partial<SessionState> = {};

    // Use last turn's input tokens for context usage — that's what's actually in the window
    if (last && contextWindow && contextWindow > 0) {
      const usedInContext = (last.inputTokens || 0) + (last.outputTokens || 0);
      const pct = Math.round((usedInContext / contextWindow) * 100);
      updates.context_used_percent = Math.max(0, Math.min(pct, 100));
    }

    // Forward cumulative token breakdown for display in the UI
    if (total) {
      updates.codex_token_details = {
        inputTokens: total.inputTokens || 0,
        outputTokens: total.outputTokens || 0,
        cachedInputTokens: total.cachedInputTokens || 0,
        reasoningOutputTokens: total.reasoningOutputTokens || 0,
        modelContextWindow: contextWindow || 0,
      };
    }

    if (Object.keys(updates).length > 0) {
      this.emit({
        type: "session_update",
        session: updates,
      });
    }
  }

  // ── Command progress tracking ─────────────────────────────────────────

  private emitCommandProgress(params: Record<string, unknown>): void {
    const itemId = params.itemId as string | undefined;
    if (!itemId) return;
    const startTime = this.commandStartTimes.get(itemId);
    const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
    const deltaText = this.extractCommandOutputDelta(params);
    if (deltaText) {
      const prev = this.commandOutputByItemId.get(itemId) || "";
      this.commandOutputByItemId.set(itemId, prev + deltaText);
    }
    this.emit({
      type: "tool_progress",
      tool_use_id: itemId,
      tool_name: "Bash",
      elapsed_time_seconds: elapsed,
      ...(deltaText ? { output_delta: deltaText } : {}),
    });
  }

  private extractCommandOutputDelta(params: Record<string, unknown>): string {
    const collected: string[] = [];
    const seen = new Set<unknown>();

    const visit = (value: unknown): void => {
      if (value == null || seen.has(value)) return;
      seen.add(value);
      if (typeof value === "string") {
        collected.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        for (const key of ["delta", "text", "output", "stdout", "stderr", "content", "message"]) {
          if (key in obj) visit(obj[key]);
        }
      }
    };

    for (const key of ["delta", "output", "stdout", "stderr", "content"]) {
      visit(params[key]);
    }

    return collected.join("");
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private markMessageFinished(timestamp: number): void {
    this.lastMessageFinishedAt = timestamp;
  }

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }

  /** Emit an assistant message with a tool_use content block (no tracking). */
  private emitToolUse(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: { parentToolUseId?: string | null; timestamp?: number },
  ): void {
    const now = options?.timestamp ?? Date.now();
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_use", toolUseId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: toolName,
            input,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: options?.parentToolUseId ?? null,
      timestamp: now,
      tool_start_times: { [toolUseId]: now },
    });
  }

  /** Emit tool_use and track the ID so we don't double-emit. */
  private emitToolUseTracked(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: { parentToolUseId?: string | null; timestamp?: number },
  ): void {
    this.emittedToolUseIds.add(toolUseId);
    this.emitToolUse(toolUseId, toolName, input, options);
  }

  /**
   * Emit a tool_use start sequence: stream_event content_block_start + assistant message.
   * This matches Claude Code's streaming pattern and ensures the frontend sees the tool block
   * even during active streaming.
   */
  private emitToolUseStart(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: { parentToolUseId?: string | null; timestamp?: number },
  ): void {
    // Emit stream event for tool_use start (matches Claude Code pattern)
    this.emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: toolUseId, name: toolName, input: {} },
      },
      parent_tool_use_id: options?.parentToolUseId ?? null,
    });
    this.emitToolUseTracked(toolUseId, toolName, input, options);
  }

  /** Emit tool_use only if item/started was never received for this ID. */
  private ensureToolUseEmitted(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: { parentToolUseId?: string | null; timestamp?: number },
  ): void {
    if (!this.emittedToolUseIds.has(toolUseId)) {
      this.emitToolUseStart(toolUseId, toolName, input, options);
    }
  }

  /** Emit an assistant message with a tool_result content block. */
  private emitToolResult(toolUseId: string, content: unknown, isError: boolean, parentToolUseId?: string | null): void {
    const safeContent = typeof content === "string" ? content : JSON.stringify(content);
    const completedAt = Date.now();
    this.emit({
      type: "assistant",
      message: {
        id: this.makeMessageId("tool_result", toolUseId),
        type: "message",
        role: "assistant",
        model: this.options.model || "",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: safeContent,
            is_error: isError,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: parentToolUseId ?? null,
      timestamp: completedAt,
    });
    this.markMessageFinished(completedAt);
  }

  private makeMessageId(kind: string, sourceId?: string): string {
    if (sourceId) return `codex-${kind}-${sourceId}`;
    return `codex-${kind}-${randomUUID()}`;
  }

  private buildResumeSnapshot(
    thread: Record<string, unknown> & { id: string },
  ): CodexResumeSnapshot | null {
    const rawTurns = Array.isArray(thread.turns) ? thread.turns : [];
    const turns = rawTurns.filter((t): t is Record<string, unknown> => !!t && typeof t === "object");
    const last = turns.length > 0 ? turns[turns.length - 1] : null;

    // Extract thread-level status (e.g. {type: "idle"} or {type: "active"})
    const rawStatus = thread.status;
    const threadStatus = typeof rawStatus === "object" && rawStatus !== null
      ? String((rawStatus as Record<string, unknown>).type ?? "")
      : typeof rawStatus === "string" ? rawStatus : null;

    if (!last) {
      return {
        threadId: thread.id,
        turnCount: 0,
        lastTurn: null,
        threadStatus,
      };
    }

    const lastId = typeof last.id === "string" ? last.id : "";
    const status = typeof last.status === "string" ? last.status : null;
    const items = Array.isArray(last.items)
      ? last.items.filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
      : [];

    return {
      threadId: thread.id,
      turnCount: turns.length,
      lastTurn: {
        id: lastId,
        status,
        error: last.error ?? null,
        items,
      },
      threadStatus,
    };
  }

  private mapApprovalPolicy(mode?: string, askPermission?: boolean): string {
    if (askPermission === false) return "never";
    switch (mode) {
      case "bypassPermissions":
        return "never";
      case "suggest":
      case "plan":
      case "acceptEdits":
      case "default":
      default:
        return "untrusted";
    }
  }

  private mapSandboxPolicy(mode?: string): string {
    switch (mode) {
      case "bypassPermissions":
        return "danger-full-access";
      default:
        return "workspace-write";
    }
  }

  private buildCollaborationModeOverride():
    { mode: "default" | "plan"; settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null } }
    | null {
    const mode = this.options.approvalMode === "plan" ? "plan" : "default";
    return {
      mode,
      settings: {
        model: this.options.model?.trim() || getDefaultModelForBackend("codex"),
        reasoning_effort: this.normalizeReasoningEffort(this.options.reasoningEffort),
        developer_instructions: this.options.instructions ?? null,
      },
    };
  }

  private normalizeReasoningEffort(effort?: string): string | null {
    if (!effort) return null;
    const normalized = effort.trim().toLowerCase();
    if (!normalized) return null;
    return CodexAdapter.VALID_REASONING_EFFORTS.has(normalized) ? normalized : null;
  }

  private isCollaborationModeUnsupportedError(err: unknown): boolean {
    const text = String(err).toLowerCase();
    return text.includes("collaborationmode")
      && (text.includes("unknown field") || text.includes("invalid params")
        || text.includes("-32602") || text.includes("experimentalapi"));
  }

  private isTransportClosedError(err: unknown): boolean {
    return String(err).toLowerCase().includes("transport closed");
  }

  private handleTurnStartDispatchFailure(msg: BrowserOutgoingMessage): boolean {
    if (!this.turnStartFailedCb) return false;
    this.turnStartFailedCb(msg);
    return true;
  }

  private async listAllMcpServerStatuses(): Promise<CodexMcpServerStatus[]> {
    const out: CodexMcpServerStatus[] = [];
    let cursor: string | null = null;
    let page = 0;

    while (page < 50) {
      const response = await this.transport.call("mcpServerStatus/list", {
        cursor,
        limit: 100,
      }) as CodexMcpStatusListResponse;
      if (Array.isArray(response.data)) {
        out.push(...response.data);
      }
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (!cursor) break;
      page++;
    }

    return out;
  }

  private async readMcpServersConfig(): Promise<Record<string, unknown>> {
    const response = await this.transport.call("config/read", {}) as {
      config?: Record<string, unknown>;
    };
    const config = this.asRecord(response?.config) || {};
    return this.asRecord(config.mcp_servers) || {};
  }

  private async reloadMcpServers(): Promise<void> {
    await this.transport.call("config/mcpServer/reload", {});
  }

  private isMcpServerEnabled(value: unknown): boolean {
    const cfg = this.asRecord(value);
    if (!cfg) return true;
    return cfg.enabled !== false;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private toMcpServerConfig(value: unknown): McpServerConfig {
    const cfg = this.asRecord(value) || {};
    const args = Array.isArray(cfg.args)
      ? cfg.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env = this.asRecord(cfg.env) as Record<string, string> | null;

    let type: McpServerConfig["type"] = "sdk";
    if (cfg.type === "stdio" || cfg.type === "sse" || cfg.type === "http" || cfg.type === "sdk") {
      type = cfg.type;
    } else if (typeof cfg.command === "string") {
      type = "stdio";
    } else if (typeof cfg.url === "string") {
      type = "http";
    }

    return {
      type,
      command: typeof cfg.command === "string" ? cfg.command : undefined,
      args,
      env: env || undefined,
      url: typeof cfg.url === "string" ? cfg.url : undefined,
    };
  }

  private fromMcpServerConfig(config: McpServerConfig): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (typeof config.command === "string") out.command = config.command;
    if (Array.isArray(config.args)) out.args = config.args;
    if (config.env) out.env = config.env;
    if (typeof config.url === "string") out.url = config.url;
    return out;
  }

  private normalizeRawMcpServerConfig(value: unknown): Record<string, unknown> {
    const cfg = this.asRecord(value) || {};
    const out: Record<string, unknown> = {};

    // Keep only fields supported by Codex raw MCP config schema
    if (typeof cfg.command === "string") out.command = cfg.command;
    if (Array.isArray(cfg.args)) out.args = cfg.args.filter((a) => typeof a === "string");
    if (typeof cfg.cwd === "string") out.cwd = cfg.cwd;
    if (typeof cfg.url === "string") out.url = cfg.url;
    if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled;
    if (typeof cfg.required === "boolean") out.required = cfg.required;

    const env = this.asRecord(cfg.env);
    if (env) out.env = Object.fromEntries(
      Object.entries(env).filter(([, v]) => typeof v === "string"),
    );

    const envHttpHeaders = this.asRecord(cfg.env_http_headers);
    if (envHttpHeaders) out.env_http_headers = Object.fromEntries(
      Object.entries(envHttpHeaders).filter(([, v]) => typeof v === "string"),
    );

    const httpHeaders = this.asRecord(cfg.http_headers);
    if (httpHeaders) out.http_headers = Object.fromEntries(
      Object.entries(httpHeaders).filter(([, v]) => typeof v === "string"),
    );

    const asStringArray = (arr: unknown): string[] | undefined =>
      Array.isArray(arr)
        ? arr.filter((x): x is string => typeof x === "string")
        : undefined;

    const disabledTools = asStringArray(cfg.disabled_tools);
    if (disabledTools) out.disabled_tools = disabledTools;
    const enabledTools = asStringArray(cfg.enabled_tools);
    if (enabledTools) out.enabled_tools = enabledTools;
    const envVars = asStringArray(cfg.env_vars);
    if (envVars) out.env_vars = envVars;
    const scopes = asStringArray(cfg.scopes);
    if (scopes) out.scopes = scopes;

    if (typeof cfg.startup_timeout_ms === "number") out.startup_timeout_ms = cfg.startup_timeout_ms;
    if (typeof cfg.startup_timeout_sec === "number") out.startup_timeout_sec = cfg.startup_timeout_sec;
    if (typeof cfg.tool_timeout_sec === "number") out.tool_timeout_sec = cfg.tool_timeout_sec;
    if (typeof cfg.bearer_token === "string") out.bearer_token = cfg.bearer_token;
    if (typeof cfg.bearer_token_env_var === "string") out.bearer_token_env_var = cfg.bearer_token_env_var;

    return out;
  }

  private mapMcpTools(
    tools: Record<string, { name?: string; annotations?: unknown }> | undefined,
  ): McpServerDetail["tools"] {
    if (!tools) return [];
    return Object.entries(tools).map(([key, tool]) => {
      const ann = this.asRecord(tool.annotations);
      const annotations = ann ? {
        readOnly: (ann.readOnly ?? ann.readOnlyHint) === true,
        destructive: (ann.destructive ?? ann.destructiveHint) === true,
        openWorld: (ann.openWorld ?? ann.openWorldHint) === true,
      } : undefined;

      return {
        name: typeof tool.name === "string" ? tool.name : key,
        annotations,
      };
    });
  }
}
