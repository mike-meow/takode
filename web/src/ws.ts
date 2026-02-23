import { useStore } from "./store.js";
import { api } from "./api.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, ContentBlock, ChatMessage, TaskItem, SdkSessionInfo, McpServerConfig } from "./types.js";
import { generateUniqueSessionName } from "./utils/names.js";
import { playNotificationSound } from "./utils/notification-sound.js";
import { scopedGetItem, scopedSetItem } from "./utils/scoped-storage.js";

const sockets = new Map<string, WebSocket>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
const reconnectAttempts = new Map<string, number>();
const heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
const lastSeqBySession = new Map<string, number>();
const taskCounters = new Map<string, number>();
/** Track processed tool_use IDs to prevent duplicate task creation */
const processedToolUseIds = new Map<string, Set<string>>();

// ─── Eager diff stats fetcher ─────────────────────────────────────────────
// Debounced per-session: after changedFiles are added, fetch bulk diff stats
// so the TopBar badge shows the accurate count without opening the diff tab.
const diffStatsTimers = new Map<string, ReturnType<typeof setTimeout>>();
const diffStatsFetchedFiles = new Map<string, Set<string>>();

/** Clear the diff stats cache and re-fetch (e.g. when base branch changes). */
export function invalidateDiffStatsCache(sessionId: string) {
  diffStatsFetchedFiles.delete(sessionId);
  // Schedule an immediate re-fetch so the badge updates with the new base
  scheduleDiffStatsFetch(sessionId);
}

function scheduleDiffStatsFetch(sessionId: string) {
  // Debounce: wait 1.5s after last file change before fetching
  const existing = diffStatsTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  diffStatsTimers.set(sessionId, setTimeout(() => {
    diffStatsTimers.delete(sessionId);
    fetchDiffStatsForSession(sessionId);
  }, 1500));
}

async function fetchDiffStatsForSession(sessionId: string) {
  const store = useStore.getState();
  const files = store.changedFiles.get(sessionId);
  if (!files || files.size === 0) return;

  const session = store.sessions.get(sessionId);
  const sessionCwd = session?.cwd || store.sdkSessions.find((s) => s.sessionId === sessionId)?.cwd;
  if (!sessionCwd) return;

  const repoRoot = (session?.repo_root && sessionCwd.startsWith(session.repo_root + "/"))
    ? session.repo_root
    : sessionCwd;

  // Read base branch from server session state (authoritative, synced across devices)
  const baseBranch = session?.diff_base_branch || session?.git_default_branch || undefined;

  // Only fetch stats for files we haven't fetched yet
  const alreadyFetched = diffStatsFetchedFiles.get(sessionId) || new Set();
  const newFiles = [...files].filter((f) => !alreadyFetched.has(f));
  if (newFiles.length === 0) return;

  try {
    const result = await api.getDiffStats(newFiles, repoRoot, baseBranch);
    if (!result?.stats) return;

    // Merge with existing stats in the store
    const existingStats = useStore.getState().diffFileStats.get(sessionId) || new Map();
    const merged = new Map(existingStats);
    for (const [absPath, stat] of Object.entries(result.stats)) {
      merged.set(absPath, stat);
    }
    // Mark files with no entry in stats as +0/-0 (file exists in changedFiles but has no diff)
    for (const f of newFiles) {
      if (!merged.has(f)) {
        merged.set(f, { additions: 0, deletions: 0 });
      }
    }
    useStore.getState().setDiffFileStats(sessionId, merged);

    // Track which files we've already fetched
    const updated = new Set(alreadyFetched);
    for (const f of newFiles) updated.add(f);
    diffStatsFetchedFiles.set(sessionId, updated);
  } catch (err) {
    // Best-effort — badge will show raw count until diff tab is opened
    console.warn("[diff-stats] fetch failed for session", sessionId, err);
  }
}

/** Heartbeat interval — send a ping every 30s to keep the connection alive */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Max reconnect delay — exponential backoff caps at 30s */
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Base reconnect delay */
const BASE_RECONNECT_DELAY_MS = 2_000;

function normalizePath(path: string): string {
  const isAbs = path.startsWith("/");
  const parts = path.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return `${isAbs ? "/" : ""}${out.join("/")}`;
}

export function resolveSessionFilePath(filePath: string, cwd?: string): string {
  if (filePath.startsWith("/")) return normalizePath(filePath);
  if (!cwd) return normalizePath(filePath);
  return normalizePath(`${cwd}/${filePath}`);
}

function isPathInSessionScope(filePath: string, cwd?: string): boolean {
  if (!cwd) return true;
  const normalizedCwd = normalizePath(cwd);
  return filePath === normalizedCwd || filePath.startsWith(`${normalizedCwd}/`);
}

function getProcessedSet(sessionId: string): Set<string> {
  let set = processedToolUseIds.get(sessionId);
  if (!set) {
    set = new Set();
    processedToolUseIds.set(sessionId, set);
  }
  return set;
}

function extractTasksFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const processed = getProcessedSet(sessionId);
  let hadTaskUpdate = false;

  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input, id: toolUseId } = block;

    // Deduplicate by tool_use_id
    if (toolUseId) {
      if (processed.has(toolUseId)) continue;
      processed.add(toolUseId);
    }

    // TodoWrite: full replacement — { todos: [{ content, status, activeForm }] }
    if (name === "TodoWrite") {
      const todos = input.todos as { content?: string; status?: string; activeForm?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const tasks: TaskItem[] = todos.map((t, i) => ({
          id: String(i + 1),
          subject: t.content || "Task",
          description: "",
          activeForm: t.activeForm,
          status: (t.status as TaskItem["status"]) || "pending",
        }));
        store.setTasks(sessionId, tasks);
        taskCounters.set(sessionId, tasks.length);
        hadTaskUpdate = true;
      }
      continue;
    }

    // TaskCreate: incremental add — { subject, description, activeForm }
    if (name === "TaskCreate") {
      const count = (taskCounters.get(sessionId) || 0) + 1;
      taskCounters.set(sessionId, count);
      const task = {
        id: String(count),
        subject: (input.subject as string) || "Task",
        description: (input.description as string) || "",
        activeForm: input.activeForm as string | undefined,
        status: "pending" as const,
      };
      store.addTask(sessionId, task);
      hadTaskUpdate = true;
      continue;
    }

    // TaskUpdate: incremental update — { taskId, status, owner, activeForm, addBlockedBy }
    if (name === "TaskUpdate") {
      const taskId = input.taskId as string;
      if (taskId) {
        const updates: Partial<TaskItem> = {};
        if (input.status) updates.status = input.status as TaskItem["status"];
        if (input.owner) updates.owner = input.owner as string;
        if (input.activeForm !== undefined) updates.activeForm = input.activeForm as string;
        if (input.addBlockedBy) updates.blockedBy = input.addBlockedBy as string[];
        store.updateTask(sessionId, taskId, updates);
        hadTaskUpdate = true;
      }
    }
  }

  // Update sidebar task preview: show the first in_progress task's activeForm
  if (hadTaskUpdate) {
    const tasks = useStore.getState().sessionTasks.get(sessionId);
    const active = tasks?.find((t) => t.status === "in_progress");
    store.setSessionTaskPreview(sessionId, active ? (active.activeForm || active.subject) : null);
  }
}

function extractChangedFilesFromBlocks(sessionId: string, blocks: ContentBlock[]) {
  const store = useStore.getState();
  const session = store.sessions.get(sessionId);
  const sessionCwd =
    session?.cwd ||
    store.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.cwd;
  // Use repo root as scope so files outside session cwd (e.g. repo-root CLAUDE.md) are tracked.
  // For worktrees, repo_root points to the main repo (not the worktree directory), so fall
  // back to cwd when repo_root isn't an ancestor of cwd.
  const scope = (session?.repo_root && sessionCwd?.startsWith(session.repo_root + "/"))
    ? session.repo_root
    : sessionCwd;
  let addedAny = false;
  for (const block of blocks) {
    if (block.type !== "tool_use") continue;
    const { name, input } = block;
    const filePath = name === "NotebookEdit" ? input.notebook_path : input.file_path;
    if ((name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") && typeof filePath === "string") {
      const resolvedPath = resolveSessionFilePath(filePath, sessionCwd);
      if (isPathInSessionScope(resolvedPath, scope)) {
        store.addChangedFile(sessionId, resolvedPath);
        addedAny = true;
      }
    }
  }
  // Eagerly fetch diff stats so the TopBar badge is accurate
  if (addedAny) scheduleDiffStatsFetch(sessionId);
}

function sendBrowserNotification(title: string, body: string, tag: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  new Notification(title, { body, tag });
}

let idCounter = 0;
let clientMsgCounter = 0;
function nextId(): string {
  return `msg-${Date.now()}-${++idCounter}`;
}

function nextClientMsgId(): string {
  return `cmsg-${Date.now()}-${++clientMsgCounter}`;
}

const IDEMPOTENT_OUTGOING_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "user_message",
  "permission_response",
  "interrupt",
  "set_model",
  "set_permission_mode",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
  "set_ask_permission",
]);

function getWsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/browser/${sessionId}`;
}

function getLastSeqStorageKey(sessionId: string): string {
  return `companion:last-seq:${sessionId}`;
}

function getLastSeq(sessionId: string): number {
  const cached = lastSeqBySession.get(sessionId);
  if (typeof cached === "number") return cached;
  try {
    const raw = scopedGetItem(getLastSeqStorageKey(sessionId));
    const parsed = raw ? Number(raw) : 0;
    const normalized = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    lastSeqBySession.set(sessionId, normalized);
    return normalized;
  } catch {
    return 0;
  }
}

function setLastSeq(sessionId: string, seq: number): void {
  const normalized = Math.max(0, Math.floor(seq));
  lastSeqBySession.set(sessionId, normalized);
  try {
    scopedSetItem(getLastSeqStorageKey(sessionId), String(normalized));
  } catch {
    // ignore storage errors
  }
}

function ackSeq(sessionId: string, seq: number): void {
  sendToSession(sessionId, { type: "session_ack", last_seq: seq });
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "thinking") return b.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Merge content blocks from two versions of the same assistant message.
 *  Deduplicates tool_use blocks by their unique `id` and text/thinking
 *  blocks by content equality. Returns all unique blocks in order. */
function mergeContentBlocks(existing: ContentBlock[], incoming: ContentBlock[]): ContentBlock[] {
  const seenToolIds = new Set<string>();
  const seenTexts = new Set<string>();
  const result: ContentBlock[] = [];

  for (const block of existing) {
    if (block.type === "tool_use" && block.id) {
      seenToolIds.add(block.id);
    } else if (block.type === "text") {
      seenTexts.add(block.text);
    } else if (block.type === "thinking") {
      seenTexts.add(`thinking:${block.thinking}`);
    }
    result.push(block);
  }

  for (const block of incoming) {
    if (block.type === "tool_use" && block.id) {
      if (seenToolIds.has(block.id)) continue;
      seenToolIds.add(block.id);
    } else if (block.type === "text") {
      if (seenTexts.has(block.text)) continue;
      seenTexts.add(block.text);
    } else if (block.type === "thinking") {
      if (seenTexts.has(`thinking:${block.thinking}`)) continue;
      seenTexts.add(`thinking:${block.thinking}`);
    }
    result.push(block);
  }

  return result;
}

function handleMessage(sessionId: string, event: MessageEvent) {
  let data: BrowserIncomingMessage;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }

  handleParsedMessage(sessionId, data);
}

function handleParsedMessage(
  sessionId: string,
  data: BrowserIncomingMessage,
  options: { processSeq?: boolean; ackSeqMessage?: boolean } = {},
) {
  const { processSeq = true, ackSeqMessage = true } = options;
  const store = useStore.getState();

  if (processSeq && typeof data.seq === "number") {
    const previous = getLastSeq(sessionId);
    if (data.seq <= previous) return;
    setLastSeq(sessionId, data.seq);
    if (ackSeqMessage) {
      ackSeq(sessionId, data.seq);
    }
  }

  switch (data.type) {
    case "session_init": {
      // Reset stale seq if browser is ahead of server (e.g. after server restart)
      if (typeof data.nextEventSeq === "number") {
        const browserSeq = getLastSeq(sessionId);
        if (browserSeq >= data.nextEventSeq) {
          setLastSeq(sessionId, 0);
        }
      }
      const existingSession = store.sessions.get(sessionId);
      store.addSession(data.session);
      // Do NOT set cliConnected here — session_init is just a state snapshot.
      // CLI connection status comes from explicit cli_connected/cli_disconnected messages.
      if (!existingSession) {
        store.setSessionStatus(sessionId, "idle");
      }
      if (!store.sessionNames.has(sessionId)) {
        const existingNames = new Set(store.sessionNames.values());
        const name = generateUniqueSessionName(existingNames);
        store.setSessionName(sessionId, name);
      }
      // Sync askPermission from server state
      if (typeof data.session.askPermission === "boolean") {
        store.setAskPermission(sessionId, data.session.askPermission);
      }
      // Restore quest-named flag from persisted session state (on reconnect)
      if (data.session.claimedQuestId) {
        store.markQuestNamed(sessionId);
      } else {
        store.clearQuestNamed(sessionId);
      }
      break;
    }

    case "session_update": {
      store.updateSession(sessionId, data.session);
      // Sync askPermission if updated
      if (typeof data.session.askPermission === "boolean") {
        store.setAskPermission(sessionId, data.session.askPermission);
      }
      // Sync session name if included (e.g. after a rename via REST API)
      if (typeof (data.session as Record<string, unknown>).name === "string") {
        store.setSessionName(sessionId, (data.session as Record<string, unknown>).name as string);
      }
      // Sync server-authoritative attention state
      if (data.session.attentionReason !== undefined) {
        const isViewing = useStore.getState().currentSessionId === sessionId;
        if (isViewing && data.session.attentionReason) {
          // User is viewing this session — suppress badge, tell server we've read it
          api.markSessionRead(sessionId).catch(() => {});
        } else {
          const sessionAttention = new Map(useStore.getState().sessionAttention);
          sessionAttention.set(sessionId, data.session.attentionReason ?? null);
          useStore.setState({ sessionAttention });
        }
      }
      break;
    }

    case "assistant": {
      const msg = data.message;
      const textContent = extractTextFromBlocks(msg.content);
      const chatMsg: ChatMessage = {
        id: msg.id,
        role: "assistant",
        content: textContent,
        contentBlocks: msg.content,
        timestamp: data.timestamp || Date.now(),
        parentToolUseId: data.parent_tool_use_id,
        model: msg.model,
        stopReason: msg.stop_reason,
        cliUuid: (data as Record<string, unknown>).uuid as string | undefined,
      };
      // Server accumulates content blocks for same-ID messages (parallel tool calls).
      // If this ID already exists, merge content blocks rather than replace — this
      // handles both accumulated messages (server sends full set) and non-accumulated
      // messages (old server sends partial blocks) correctly.
      const existingMsgs = store.messages.get(sessionId) || [];
      const existing = msg.id ? existingMsgs.find((m) => m.id === msg.id) : undefined;
      if (existing) {
        const mergedBlocks = mergeContentBlocks(existing.contentBlocks || [], msg.content || []);
        store.updateMessage(sessionId, msg.id!, {
          content: extractTextFromBlocks(mergedBlocks),
          contentBlocks: mergedBlocks,
          stopReason: msg.stop_reason || existing.stopReason,
        });
      } else {
        store.appendMessage(sessionId, chatMsg);
      }
      store.setStreaming(sessionId, null);
      // Clear progress only for completed tools (tool_result blocks), not all tools.
      // Blanket clear would cause flickering during concurrent tool execution.
      if (msg.content?.length) {
        for (const block of msg.content) {
          if (block.type === "tool_result") {
            store.clearToolProgress(sessionId, block.tool_use_id);
          }
        }
      }
      store.setSessionStatus(sessionId, "running");

      // Store server-provided tool start timestamps for live duration display
      if (data.tool_start_times && typeof data.tool_start_times === "object") {
        store.setToolStartTimestamps(sessionId, data.tool_start_times as Record<string, number>);
      }

      // Start timer if not already started (for non-streaming tool calls)
      if (!store.streamingStartedAt.has(sessionId)) {
        store.setStreamingStats(sessionId, { startedAt: Date.now() });
      }

      // Extract tasks and changed files from tool_use content blocks
      if (msg.content?.length) {
        extractTasksFromBlocks(sessionId, msg.content);
        extractChangedFilesFromBlocks(sessionId, msg.content);
      }

      break;
    }

    case "stream_event": {
      const evt = data.event as Record<string, unknown>;
      if (evt && typeof evt === "object") {
        // message_start → mark generation start time
        if (evt.type === "message_start") {
          if (!store.streamingStartedAt.has(sessionId)) {
            store.setStreamingStats(sessionId, { startedAt: Date.now(), outputTokens: 0 });
          }
        }

        // content_block_delta → accumulate streaming text
        if (evt.type === "content_block_delta") {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const current = store.streaming.get(sessionId) || "";
            store.setStreaming(sessionId, current + delta.text);
          }
        }

        // message_delta → extract output token count
        if (evt.type === "message_delta") {
          const usage = (evt as { usage?: { output_tokens?: number } }).usage;
          if (usage?.output_tokens) {
            store.setStreamingStats(sessionId, { outputTokens: usage.output_tokens });
          }
        }
      }
      break;
    }

    case "result": {
      const r = data.data;
      const sessionUpdates: Partial<{ total_cost_usd: number; num_turns: number; context_used_percent: number; total_lines_added: number; total_lines_removed: number }> = {
        total_cost_usd: r.total_cost_usd,
        num_turns: r.num_turns,
      };
      // Forward lines changed if present
      if (typeof r.total_lines_added === "number") {
        sessionUpdates.total_lines_added = r.total_lines_added;
      }
      if (typeof r.total_lines_removed === "number") {
        sessionUpdates.total_lines_removed = r.total_lines_removed;
      }
      // Compute context % from modelUsage if available
      if (r.modelUsage) {
        for (const usage of Object.values(r.modelUsage)) {
          if (usage.contextWindow > 0) {
            const pct = Math.round(
              ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
            );
            sessionUpdates.context_used_percent = Math.max(0, Math.min(pct, 100));
          }
        }
      }
      store.updateSession(sessionId, sessionUpdates);
      store.clearStreamingState(sessionId);
      store.clearToolProgress(sessionId);
      store.setSessionStatus(sessionId, "idle");
      store.setSessionStuck(sessionId, false);
      // Play notification sound if enabled and tab is not focused
      if (!document.hasFocus() && store.notificationSound) {
        playNotificationSound();
      }
      if (!document.hasFocus() && store.notificationDesktop) {
        sendBrowserNotification("Session completed", "Claude finished the task", sessionId);
      }
      if (r.is_error) {
        const errorText = r.errors?.length
          ? r.errors.join(", ")
          : r.result || "An error occurred";
        const isContextLimit = errorText.toLowerCase().includes("prompt is too long");

        // If user tried /compact but it failed because context is full,
        // auto-recover by killing the CLI and relaunching with --resume.
        // The SDK protocol doesn't intercept slash commands from user messages,
        // so /compact gets treated as a regular prompt and overflows again.
        if (isContextLimit) {
          const msgs = store.messages.get(sessionId) || [];
          const lastUserMsg = [...msgs].reverse().find(m => m.role === "user");
          if (lastUserMsg?.content.trim().toLowerCase() === "/compact") {
            store.appendMessage(sessionId, {
              id: nextId(),
              role: "system",
              content: "Context is full — restarting session to compact...",
              timestamp: Date.now(),
              variant: "info",
            });
            fetch(`/api/sessions/${encodeURIComponent(sessionId)}/force-compact`, { method: "POST" }).catch(() => {
              store.appendMessage(sessionId, {
                id: nextId(),
                role: "system",
                content: `Error: ${errorText}`,
                timestamp: Date.now(),
                variant: "error",
              });
            });
            break;
          }
        }

        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Error: ${errorText}`,
          timestamp: Date.now(),
          variant: "error",
        });
      }
      break;
    }

    case "permission_request": {
      store.addPermission(sessionId, data.request);
      // Pause generation timer while waiting for user input
      store.pauseStreamingTimer(sessionId);
      if (!document.hasFocus() && store.notificationDesktop) {
        const req = data.request;
        sendBrowserNotification(
          "Permission needed",
          `${req.tool_name}: approve or deny`,
          req.request_id,
        );
      }
      // Also extract tasks and changed files from permission requests
      const req = data.request;
      if (req.tool_name && req.input) {
        const permBlocks = [{
          type: "tool_use" as const,
          id: req.tool_use_id,
          name: req.tool_name,
          input: req.input,
        }];
        extractTasksFromBlocks(sessionId, permBlocks);
        extractChangedFilesFromBlocks(sessionId, permBlocks);
      }
      break;
    }

    case "permission_cancelled": {
      store.removePermission(sessionId, data.request_id);
      break;
    }

    case "permission_denied": {
      if (data.request_id) store.removePermission(sessionId, data.request_id);
      const denialMsg: ChatMessage = {
        id: data.id,
        role: "system",
        content: data.summary,
        timestamp: data.timestamp,
        variant: "denied",
      };
      store.appendMessage(sessionId, denialMsg);
      break;
    }

    case "permission_approved": {
      if (data.request_id) store.removePermission(sessionId, data.request_id);
      const approvedMsg: ChatMessage = {
        id: data.id,
        role: "system",
        content: data.summary,
        timestamp: data.timestamp,
        variant: "approved",
        ...(data.answers?.length ? { metadata: { answers: data.answers } } : {}),
      };
      store.appendMessage(sessionId, approvedMsg);
      break;
    }

    case "tool_progress": {
      store.setToolProgress(sessionId, data.tool_use_id, {
        toolName: data.tool_name,
        elapsedSeconds: data.elapsed_time_seconds,
      });
      break;
    }

    case "tool_use_summary": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.summary,
        timestamp: Date.now(),
      });
      break;
    }

    case "tool_result_preview": {
      for (const preview of data.previews) {
        store.setToolResult(sessionId, preview.tool_use_id, preview);
      }
      break;
    }

    case "user_message": {
      // Server-authoritative: user messages are broadcast by the server to all
      // browsers. The browser never adds user messages to the store locally.
      const userMsg: ChatMessage = {
        id: data.id || nextId(),
        role: "user",
        content: data.content,
        timestamp: data.timestamp || Date.now(),
        ...(data.images?.length ? { images: data.images } : {}),
      };
      store.appendMessage(sessionId, userMsg);
      store.setSessionPreview(sessionId, data.content.slice(0, 80));
      break;
    }

    case "status_change": {
      if (data.status === "compacting") {
        store.setSessionStatus(sessionId, "compacting");
      } else {
        store.setSessionStatus(sessionId, data.status);
      }
      // Any status change clears stuck flag
      store.setSessionStuck(sessionId, false);
      break;
    }

    case "session_stuck": {
      store.setSessionStuck(sessionId, true);
      break;
    }

    case "permissions_cleared": {
      store.clearPermissions(sessionId);
      break;
    }

    case "state_snapshot": {
      // Authoritative state from server — overrides any stale transient state
      store.setSessionStatus(sessionId, data.sessionStatus as "idle" | "running" | "compacting" | "reverting" | null);
      store.setCliConnected(sessionId, data.cliConnected);
      if (data.cliConnected) store.setCliEverConnected(sessionId);
      if (data.askPermission !== undefined) {
        store.setAskPermission(sessionId, data.askPermission);
      }
      // Clear stale streaming state when session is not actively generating.
      // This handles: server restart (event_replay sets stale timers),
      // CLI crash mid-generation, and any other state desync.
      if (data.sessionStatus !== "running") {
        store.clearStreamingState(sessionId);
        store.clearToolProgress(sessionId);
        store.setSessionStuck(sessionId, false);
      } else if (data.generationStartedAt && !store.streamingStartedAt.has(sessionId)) {
        // Restore generation timer from server so switching sessions
        // doesn't reset the "Purring..." counter.
        store.setStreamingStats(sessionId, { startedAt: data.generationStartedAt });
      }
      // Sync server-authoritative attention state
      if (data.attentionReason !== undefined) {
        const isViewing = useStore.getState().currentSessionId === sessionId;
        if (isViewing && data.attentionReason) {
          api.markSessionRead(sessionId).catch(() => {});
        } else {
          const sessionAttention = new Map(useStore.getState().sessionAttention);
          sessionAttention.set(sessionId, data.attentionReason ?? null);
          useStore.setState({ sessionAttention });
        }
      }
      break;
    }

    case "auth_status": {
      if (data.error) {
        store.appendMessage(sessionId, {
          id: nextId(),
          role: "system",
          content: `Auth error: ${data.error}`,
          timestamp: Date.now(),
          variant: "error",
        });
      }
      break;
    }

    case "error": {
      store.appendMessage(sessionId, {
        id: nextId(),
        role: "system",
        content: data.message,
        timestamp: Date.now(),
        variant: "error",
      });
      break;
    }

    case "cli_disconnected": {
      store.setCliConnected(sessionId, false);
      store.setCliDisconnectReason(sessionId, data.reason ?? null);
      store.setSessionStatus(sessionId, null);
      store.clearStreamingState(sessionId);
      store.clearToolProgress(sessionId);
      break;
    }

    case "cli_connected": {
      store.setCliConnected(sessionId, true);
      break;
    }

    case "session_name_update": {
      // Server is authoritative for all name updates (auto-naming, manual rename, etc.)
      const prevName = store.sessionNames.get(sessionId);
      if (prevName !== data.name) {
        store.setSessionName(sessionId, data.name);
        store.markRecentlyRenamed(sessionId);
      }
      // Track whether this name was set by a quest claim (for amber styling)
      if (data.source === "quest") {
        store.markQuestNamed(sessionId);
      } else {
        store.clearQuestNamed(sessionId);
      }
      break;
    }

    case "session_task_history": {
      store.setSessionTaskHistory(sessionId, data.tasks);
      break;
    }

    case "pr_status_update": {
      store.setPRStatus(sessionId, { available: data.available, pr: data.pr });
      break;
    }

    case "compact_boundary": {
      // CLI has compacted — preserve existing messages and insert a compact marker divider
      store.appendMessage(sessionId, {
        id: `compact-boundary-${Date.now()}`,
        role: "system",
        content: "Conversation compacted",
        timestamp: Date.now(),
        variant: "info",
      });
      break;
    }

    case "compact_summary": {
      // Update the most recent compact marker with the full summary text
      const msgs = store.messages.get(sessionId) || [];
      const lastCompact = [...msgs].reverse().find(
        (m) => m.role === "system" && m.id.startsWith("compact-boundary-"),
      );
      if (lastCompact) {
        store.updateMessage(sessionId, lastCompact.id, { content: data.summary });
      }
      break;
    }

    case "mcp_status": {
      store.setMcpServers(sessionId, data.servers);
      break;
    }

    case "quest_list_updated": {
      store.refreshQuests();
      break;
    }

    case "session_quest_claimed": {
      console.log(`[ws] session_quest_claimed for ${sessionId}:`, data.quest);
      store.updateSession(sessionId, {
        claimedQuestId: data.quest?.id ?? undefined,
        claimedQuestTitle: data.quest?.title ?? undefined,
      });
      // Also sync quest-named styling (redundant with session_name_update source,
      // but ensures consistency when quest is unclaimed/done)
      if (data.quest?.id) {
        store.markQuestNamed(sessionId);
      } else {
        store.clearQuestNamed(sessionId);
      }
      // Insert a quest-claimed message into the chat feed with full details
      if (data.quest?.id) {
        const questId = data.quest.id;
        // Fetch full quest details asynchronously and insert the message
        api.getQuest(questId).then((quest) => {
          const questMeta: ChatMessage["metadata"] = {
            quest: {
              questId: quest.questId,
              title: quest.title,
              description: "description" in quest ? quest.description : undefined,
              status: quest.status,
              tags: quest.tags,
              images: quest.images,
              verificationItems: "verificationItems" in quest ? quest.verificationItems : undefined,
            },
          };
          useStore.getState().appendMessage(sessionId, {
            id: `quest-claimed-${questId}-${Date.now()}`,
            role: "system",
            content: `Quest claimed: ${quest.title}`,
            timestamp: Date.now(),
            variant: "quest_claimed",
            metadata: questMeta,
          });
        }).catch(() => {
          // Fallback: insert a basic message if quest fetch fails
          useStore.getState().appendMessage(sessionId, {
            id: `quest-claimed-${questId}-${Date.now()}`,
            role: "system",
            content: `Quest claimed: ${data.quest!.title}`,
            timestamp: Date.now(),
            variant: "quest_claimed",
            metadata: {
              quest: {
                questId: questId,
                title: data.quest!.title,
                status: "in_progress",
              },
            },
          });
        });
      }
      break;
    }

    case "message_history": {
      // Clear stale pending permissions — the server will re-send any that
      // are actually still pending as permission_request messages immediately
      // after message_history. This prevents stale banners from surviving
      // reconnects or server restarts.
      store.clearPermissions(sessionId);
      const chatMessages: ChatMessage[] = [];
      for (let i = 0; i < data.messages.length; i++) {
        const histMsg = data.messages[i];
        if (histMsg.type === "user_message") {
          chatMessages.push({
            id: histMsg.id || nextId(),
            role: "user",
            content: histMsg.content,
            timestamp: histMsg.timestamp,
            ...(histMsg.images?.length ? { images: histMsg.images } : {}),
          });
        } else if (histMsg.type === "assistant") {
          const msg = histMsg.message;
          const textContent = extractTextFromBlocks(msg.content);
          chatMessages.push({
            id: msg.id,
            role: "assistant",
            content: textContent,
            contentBlocks: msg.content,
            timestamp: histMsg.timestamp || Date.now(),
            parentToolUseId: histMsg.parent_tool_use_id,
            model: msg.model,
            stopReason: msg.stop_reason,
            cliUuid: (histMsg as Record<string, unknown>).uuid as string | undefined,
          });
          // Also extract tasks and changed files from history
          if (msg.content?.length) {
            extractTasksFromBlocks(sessionId, msg.content);
            extractChangedFilesFromBlocks(sessionId, msg.content);
          }
          // Restore tool start timestamps for in-flight tools on reconnect
          const histToolStartTimes = (histMsg as Record<string, unknown>).tool_start_times as Record<string, number> | undefined;
          if (histToolStartTimes) {
            store.setToolStartTimestamps(sessionId, histToolStartTimes);
          }
        } else if (histMsg.type === "compact_marker") {
          chatMessages.push({
            id: histMsg.id || `compact-${i}`,
            role: "system",
            content: histMsg.summary || "Conversation compacted",
            timestamp: histMsg.timestamp,
            variant: "info",
          });
        } else if (histMsg.type === "permission_denied") {
          chatMessages.push({
            id: histMsg.id,
            role: "system",
            content: histMsg.summary,
            timestamp: histMsg.timestamp,
            variant: "denied",
          });
        } else if (histMsg.type === "permission_approved") {
          chatMessages.push({
            id: histMsg.id,
            role: "system",
            content: histMsg.summary,
            timestamp: histMsg.timestamp,
            variant: "approved",
            ...(histMsg.answers?.length ? { metadata: { answers: histMsg.answers } } : {}),
          });
        } else if (histMsg.type === "tool_result_preview") {
          for (const preview of histMsg.previews) {
            store.setToolResult(sessionId, preview.tool_use_id, preview);
          }
        } else if (histMsg.type === "result") {
          const r = histMsg.data as { is_error?: boolean; errors?: string[]; result?: string };
          if (r.is_error) {
            const errorText = r.errors?.length
              ? r.errors.join(", ")
              : r.result || "An error occurred";
            chatMessages.push({
              id: `hist-error-${i}`,
              role: "system",
              content: `Error: ${errorText}`,
              timestamp: Date.now(),
              variant: "error",
            });
          }
        }
      }
      // Server history is authoritative — always replace browser state.
      // This prevents cross-session message contamination that occurred
      // when the old merge logic kept stale messages from a previous session.
      store.setMessages(sessionId, chatMessages);
      // If we received history with messages, the CLI was connected before (e.g. page refresh).
      // Mark it so the UI shows "CLI disconnected" instead of "Starting session..." if it drops.
      if (chatMessages.length > 0) {
        store.setCliEverConnected(sessionId);
      }
      processedToolUseIds.delete(sessionId);
      taskCounters.delete(sessionId);
      // Extract last user message as sidebar preview
      for (let i = data.messages.length - 1; i >= 0; i--) {
        const m = data.messages[i];
        if (m.type === "user_message" && m.content) {
          store.setSessionPreview(sessionId, m.content.slice(0, 80));
          break;
        }
      }
      break;
    }

    case "event_replay": {
      let latestProcessed: number | undefined;
      for (const evt of data.events) {
        const previous = getLastSeq(sessionId);
        if (evt.seq <= previous) continue;
        setLastSeq(sessionId, evt.seq);
        latestProcessed = evt.seq;
        handleParsedMessage(
          sessionId,
          evt.message as BrowserIncomingMessage,
          { processSeq: false, ackSeqMessage: false },
        );
      }
      if (typeof latestProcessed === "number") {
        ackSeq(sessionId, latestProcessed);
      }
      break;
    }
  }
}

export function connectSession(sessionId: string) {
  if (sockets.has(sessionId)) return;

  // Clear in-memory seq cache so we use localStorage as source of truth on reconnect
  lastSeqBySession.delete(sessionId);

  const store = useStore.getState();
  store.setConnectionStatus(sessionId, "connecting");

  const ws = new WebSocket(getWsUrl(sessionId));
  sockets.set(sessionId, ws);

  ws.onopen = () => {
    const currentStore = useStore.getState();
    currentStore.setConnectionStatus(sessionId, "connected");
    reconnectAttempts.delete(sessionId); // Reset backoff on successful connect
    // After a page refresh the Zustand store is empty but localStorage still
    // holds a high last_seq. Sending that stale seq would tell the server we
    // already have all messages, so it skips sending message_history. Fix: when
    // the in-memory store has no messages, request full history with last_seq=0.
    const storeMessages = currentStore.messages.get(sessionId);
    const lastSeq = (storeMessages && storeMessages.length > 0) ? getLastSeq(sessionId) : 0;
    ws.send(JSON.stringify({ type: "session_subscribe", last_seq: lastSeq }));
    // Clear any reconnect timer
    const timer = reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(sessionId);
    }
    // Start heartbeat to keep connection alive
    const hb = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatIntervals.set(sessionId, hb);
  };

  ws.onmessage = (event) => handleMessage(sessionId, event);

  ws.onclose = () => {
    sockets.delete(sessionId);
    const hb = heartbeatIntervals.get(sessionId);
    if (hb) {
      clearInterval(hb);
      heartbeatIntervals.delete(sessionId);
    }
    useStore.getState().setConnectionStatus(sessionId, "disconnected");
    scheduleReconnect(sessionId);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function scheduleReconnect(sessionId: string) {
  if (reconnectTimers.has(sessionId)) return;
  const attempts = reconnectAttempts.get(sessionId) || 0;
  const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, attempts), MAX_RECONNECT_DELAY_MS);
  reconnectAttempts.set(sessionId, attempts + 1);
  const timer = setTimeout(() => {
    reconnectTimers.delete(sessionId);
    const store = useStore.getState();
    // Reconnect any active (non-archived) session
    const sdkSession = store.sdkSessions.find((s) => s.sessionId === sessionId);
    if (sdkSession && !sdkSession.archived) {
      connectSession(sessionId);
    }
  }, delay);
  reconnectTimers.set(sessionId, timer);
}

export function disconnectSession(sessionId: string) {
  const timer = reconnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(sessionId);
  }
  reconnectAttempts.delete(sessionId);
  const hb = heartbeatIntervals.get(sessionId);
  if (hb) {
    clearInterval(hb);
    heartbeatIntervals.delete(sessionId);
  }
  const ws = sockets.get(sessionId);
  if (ws) {
    ws.close();
    sockets.delete(sessionId);
  }
  processedToolUseIds.delete(sessionId);
  taskCounters.delete(sessionId);
  // Clean up diff stats fetcher state
  const diffTimer = diffStatsTimers.get(sessionId);
  if (diffTimer) clearTimeout(diffTimer);
  diffStatsTimers.delete(sessionId);
  diffStatsFetchedFiles.delete(sessionId);
}

export function disconnectAll() {
  for (const [id] of sockets) {
    disconnectSession(id);
  }
}

export function connectAllSessions(sessions: SdkSessionInfo[]) {
  for (const s of sessions) {
    if (!s.archived) {
      connectSession(s.sessionId);
    }
  }
}

export function waitForConnection(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const ws = sockets.get(sessionId);
      if (ws?.readyState === WebSocket.OPEN) {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
    const timeout = setTimeout(() => {
      clearInterval(check);
      reject(new Error("Connection timeout"));
    }, 10000);
  });
}

export function sendToSession(sessionId: string, msg: BrowserOutgoingMessage): boolean {
  const ws = sockets.get(sessionId);
  let outgoing: BrowserOutgoingMessage = msg;
  if (IDEMPOTENT_OUTGOING_TYPES.has(msg.type)) {
    switch (msg.type) {
      case "user_message":
      case "permission_response":
      case "interrupt":
      case "set_model":
      case "set_permission_mode":
      case "mcp_get_status":
      case "mcp_toggle":
      case "mcp_reconnect":
      case "mcp_set_servers":
      case "set_ask_permission":
        if (!msg.client_msg_id) {
          outgoing = { ...msg, client_msg_id: nextClientMsgId() };
        }
        break;
    }
  }
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(outgoing));
    return true;
  }
  return false;
}

export function sendMcpGetStatus(sessionId: string) {
  sendToSession(sessionId, { type: "mcp_get_status" });
}

export function sendMcpToggle(sessionId: string, serverName: string, enabled: boolean) {
  sendToSession(sessionId, { type: "mcp_toggle", serverName, enabled });
}

export function sendMcpReconnect(sessionId: string, serverName: string) {
  sendToSession(sessionId, { type: "mcp_reconnect", serverName });
}

export function sendMcpSetServers(sessionId: string, servers: Record<string, McpServerConfig>) {
  sendToSession(sessionId, { type: "mcp_set_servers", servers });
}

// ── Page visibility: reconnect disconnected sessions when tab becomes visible ──
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const store = useStore.getState();
      for (const s of store.sdkSessions) {
        if (!s.archived && !sockets.has(s.sessionId)) {
          connectSession(s.sessionId);
        }
      }
    }
  });
}

// ── Page unload: close all WebSockets so the browser tears down TCP connections ──
// Without this, Safari reuses stale keep-alive connections after a dev server
// restart, causing the reloaded page to hang indefinitely. Closing WebSockets
// on beforeunload forces Safari to open fresh TCP connections on the next load.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const [sessionId, ws] of sockets) {
      const hb = heartbeatIntervals.get(sessionId);
      if (hb) clearInterval(hb);
      heartbeatIntervals.delete(sessionId);
      const timer = reconnectTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      reconnectTimers.delete(sessionId);
      ws.close();
    }
    sockets.clear();
  });
}
