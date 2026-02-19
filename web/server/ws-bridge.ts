import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type {
  CLIMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIAuthStatusMessage,
  CLISystemCompactBoundaryMessage,
  CLIUserMessage,
  BrowserOutgoingMessage,
  BrowserIncomingMessage,
  ReplayableBrowserIncomingMessage,
  BufferedBrowserEvent,
  ToolResultPreview,
  SessionState,
  PermissionRequest,
  BackendType,
  McpServerDetail,
  McpServerConfig,
} from "./session-types.js";
import { TOOL_RESULT_PREVIEW_LIMIT } from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { RecorderManager } from "./recorder.js";
import type { ImageStore } from "./image-store.js";

// ─── Denial summary helper ───────────────────────────────────────────────────

/** Build a concise human-readable summary for a denied permission. */
function getDenialSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof input.command === "string") {
    const cmd = input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
    return `Denied: Bash \u2014 ${cmd}`;
  }
  if (typeof input.file_path === "string") {
    return `Denied: ${toolName} \u2014 ${input.file_path}`;
  }
  return `Denied: ${toolName}`;
}

/** Build a concise human-readable summary for an approved permission. */
function getApprovalSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "ExitPlanMode") return "Plan approved";
  if (toolName === "Bash" && typeof input.command === "string") {
    const cmd = input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
    return `Approved: Bash \u2014 ${cmd}`;
  }
  if (typeof input.file_path === "string") {
    return `Approved: ${toolName} \u2014 ${input.file_path}`;
  }
  return `Approved: ${toolName}`;
}

/** Tools whose approvals should appear as chat messages. */
const NOTABLE_APPROVALS = new Set(["ExitPlanMode", "AskUserQuestion"]);

/** Extract structured Q&A pairs from an AskUserQuestion approval. */
function extractAskUserAnswers(
  originalInput: Record<string, unknown>,
  updatedInput?: Record<string, unknown>,
): { question: string; answer: string }[] | undefined {
  const answers = updatedInput?.answers as Record<string, string> | undefined;
  const questions = Array.isArray(originalInput.questions) ? originalInput.questions as Record<string, unknown>[] : [];
  if (!answers || !questions.length) return undefined;

  const pairs: { question: string; answer: string }[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const questionText = typeof q.question === "string" ? q.question : "";
    // Protocol uses numeric index keys ("0", "1", ...) or question text as keys
    const answer = answers[String(i)] ?? (questionText ? answers[questionText] : undefined);
    if (questionText && answer) {
      pairs.push({ question: questionText, answer });
    }
  }
  return pairs.length ? pairs : undefined;
}

// ─── WebSocket data tags ──────────────────────────────────────────────────────

interface CLISocketData {
  kind: "cli";
  sessionId: string;
}

interface BrowserSocketData {
  kind: "browser";
  sessionId: string;
  subscribed?: boolean;
  lastAckSeq?: number;
}

interface TerminalSocketData {
  kind: "terminal";
  terminalId: string;
}

export type SocketData = CLISocketData | BrowserSocketData | TerminalSocketData;

// ─── Session ──────────────────────────────────────────────────────────────────

/** Tracks a pending control_request sent to CLI that expects a control_response. */
interface PendingControlRequest {
  subtype: string;
  resolve: (response: unknown) => void;
}

interface Session {
  id: string;
  backendType: BackendType;
  cliSocket: ServerWebSocket<SocketData> | null;
  codexAdapter: CodexAdapter | null;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  /** Pending control_requests sent TO CLI, keyed by request_id */
  pendingControlRequests: Map<string, PendingControlRequest>;
  messageHistory: BrowserIncomingMessage[];
  /** Messages queued while waiting for CLI to connect */
  pendingMessages: string[];
  /** Monotonic sequence for broadcast events */
  nextEventSeq: number;
  /** Recent broadcast events for reconnect replay */
  eventBuffer: BufferedBrowserEvent[];
  /** Highest acknowledged seq seen from any browser for this session */
  lastAckSeq: number;
  /** Recently processed browser client_msg_id values for idempotency on reconnect retries */
  processedClientMessageIds: string[];
  processedClientMessageIdSet: Set<string>;
  /** Full tool results indexed by tool_use_id for lazy fetch */
  toolResults: Map<string, { content: string; is_error: boolean; timestamp: number }>;
  /** Set after compact_boundary; the next user text message is the summary */
  awaitingCompactSummary?: boolean;
  /** Accumulates content blocks for assistant messages with the same ID (parallel tool calls) */
  assistantAccumulator: Map<string, { contentBlockIds: Set<string> }>;
}

type GitSessionKey = "git_branch" | "is_worktree" | "is_containerized" | "repo_root" | "git_ahead" | "git_behind";

function makeDefaultState(sessionId: string, backendType: BackendType = "claude"): SessionState {
  return {
    session_id: sessionId,
    backend_type: backendType,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
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
  };
}

// ─── Git info helper ─────────────────────────────────────────────────────────

function resolveGitInfo(state: SessionState): void {
  if (!state.cwd) return;
  // Preserve is_containerized — it's set during session launch, not derived from git
  const wasContainerized = state.is_containerized;
  try {
    state.git_branch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
      cwd: state.cwd, encoding: "utf-8", timeout: 3000,
    }).trim();

    // Detect if this is a linked worktree
    try {
      const gitDir = execSync("git rev-parse --git-dir 2>/dev/null", {
        cwd: state.cwd, encoding: "utf-8", timeout: 3000,
      }).trim();
      state.is_worktree = gitDir.includes("/worktrees/");
    } catch {
      state.is_worktree = false;
    }

    try {
      // For worktrees, --show-toplevel gives the worktree root, not the main repo.
      // Use --git-common-dir to find the real repo root.
      if (state.is_worktree) {
        const commonDir = execSync("git rev-parse --git-common-dir 2>/dev/null", {
          cwd: state.cwd, encoding: "utf-8", timeout: 3000,
        }).trim();
        // commonDir is e.g. /path/to/repo/.git — parent is the repo root
        state.repo_root = resolve(state.cwd, commonDir, "..");
      } else {
        state.repo_root = execSync("git rev-parse --show-toplevel 2>/dev/null", {
          cwd: state.cwd, encoding: "utf-8", timeout: 3000,
        }).trim();
      }
    } catch { /* ignore */ }

    try {
      const counts = execSync(
        "git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null",
        { cwd: state.cwd, encoding: "utf-8", timeout: 3000 },
      ).trim();
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      state.git_ahead = ahead || 0;
      state.git_behind = behind || 0;
    } catch {
      state.git_ahead = 0;
      state.git_behind = 0;
    }
  } catch {
    // Not a git repo or git not available
    state.git_branch = "";
    state.is_worktree = false;
    state.repo_root = "";
    state.git_ahead = 0;
    state.git_behind = 0;
  }
  state.is_containerized = wasContainerized;
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export class WsBridge {
  private static readonly EVENT_BUFFER_LIMIT = 600;
  private static readonly PROCESSED_CLIENT_MSG_ID_LIMIT = 1000;
  private static readonly IDEMPOTENT_BROWSER_MESSAGE_TYPES = new Set<string>([
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
  private sessions = new Map<string, Session>();
  private store: SessionStore | null = null;
  private recorder: RecorderManager | null = null;
  private imageStore: ImageStore | null = null;
  private onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null = null;
  private onCLIRelaunchNeeded: ((sessionId: string) => void) | null = null;
  private onPermissionModeChanged: ((sessionId: string, newMode: string) => void) | null = null;
  private onFirstTurnCompleted: ((sessionId: string, firstUserMessage: string) => void) | null = null;
  private autoNamingAttempted = new Set<string>();
  private userMsgCounter = 0;
  /** Per-project cache of slash commands & skills so new sessions get them
   *  before the CLI sends system/init (which only arrives after the first
   *  user message). Key is repo_root || cwd. */
  private slashCommandCache = new Map<string, { slash_commands: string[]; skills: string[] }>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private onGitInfoReady: ((sessionId: string, cwd: string, branch: string) => void) | null = null;
  private static readonly GIT_SESSION_KEYS: GitSessionKey[] = [
    "git_branch",
    "is_worktree",
    "is_containerized",
    "repo_root",
    "git_ahead",
    "git_behind",
  ];

  /** Register a callback for when we learn the CLI's internal session ID. */
  onCLISessionIdReceived(cb: (sessionId: string, cliSessionId: string) => void): void {
    this.onCLISessionId = cb;
  }

  /** Register a callback for when a browser connects but CLI is dead. */
  onCLIRelaunchNeededCallback(cb: (sessionId: string) => void): void {
    this.onCLIRelaunchNeeded = cb;
  }

  /** Register a callback for when askPermission changes and CLI needs restart with new mode. */
  onPermissionModeChangedCallback(cb: (sessionId: string, newMode: string) => void): void {
    this.onPermissionModeChanged = cb;
  }

  /** Register a callback for when a session completes its first turn. */
  onFirstTurnCompletedCallback(cb: (sessionId: string, firstUserMessage: string) => void): void {
    this.onFirstTurnCompleted = cb;
  }

  /** Register a callback for when git info is resolved and branch is known. */
  onSessionGitInfoReadyCallback(cb: (sessionId: string, cwd: string, branch: string) => void): void {
    this.onGitInfoReady = cb;
  }

  /**
   * Pre-populate a session with container info so that handleSystemMessage
   * preserves the host cwd instead of overwriting it with /workspace.
   * Call this right after launcher.launch() for containerized sessions.
   */
  markContainerized(sessionId: string, hostCwd: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.state.is_containerized = true;
    session.state.cwd = hostCwd;
  }

  /**
   * Set initial askPermission state on a session at creation time.
   * This ensures the browser receives the correct initial state via state_snapshot.
   */
  setInitialAskPermission(sessionId: string, askPermission: boolean): void {
    const session = this.getOrCreateSession(sessionId);
    session.state.askPermission = askPermission;
    session.state.uiMode = "plan"; // New sessions default to plan mode
    this.persistSession(session);
  }

  /**
   * Pre-populate a session with worktree info so the browser gets the correct
   * repo_root for sidebar grouping immediately, before the CLI connects.
   * Call this right after launcher.launch() for worktree sessions.
   */
  markWorktree(sessionId: string, repoRoot: string, worktreeCwd: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.state.is_worktree = true;
    session.state.repo_root = repoRoot;
    session.state.cwd = worktreeCwd;
  }

  /** Send periodic pings to all browser sockets to prevent Bun's idle timeout from closing them. */
  startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      for (const session of this.sessions.values()) {
        for (const ws of session.browserSockets) {
          try {
            ws.ping();
          } catch {
            session.browserSockets.delete(ws);
          }
        }
      }
    }, 30_000);
  }

  /** Push a message to all connected browsers for a session (public, for PRPoller etc.). */
  broadcastToSession(sessionId: string, msg: BrowserIncomingMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, msg);
  }

  /** Attach a persistent store. Call restoreFromDisk() after. */
  setStore(store: SessionStore): void {
    this.store = store;
  }

  /** Attach a recorder for raw message capture. */
  setRecorder(recorder: RecorderManager): void {
    this.recorder = recorder;
  }

  /** Attach an image store for persisting user-uploaded images to disk. */
  setImageStore(imageStore: ImageStore): void {
    this.imageStore = imageStore;
  }

  /** Restore sessions from disk (call once at startup). */
  restoreFromDisk(): number {
    if (!this.store) return 0;
    const persisted = this.store.loadAll();
    let count = 0;
    for (const p of persisted) {
      if (this.sessions.has(p.id)) continue; // don't overwrite live sessions
      const session: Session = {
        id: p.id,
        backendType: p.state.backend_type || "claude",
        cliSocket: null,
        codexAdapter: null,
        browserSockets: new Set(),
        state: p.state,
        pendingPermissions: new Map(p.pendingPermissions || []),
        pendingControlRequests: new Map(),
        messageHistory: p.messageHistory || [],
        pendingMessages: p.pendingMessages || [],
        nextEventSeq: p.nextEventSeq && p.nextEventSeq > 0 ? p.nextEventSeq : 1,
        eventBuffer: Array.isArray(p.eventBuffer) ? p.eventBuffer : [],
        lastAckSeq: typeof p.lastAckSeq === "number" ? p.lastAckSeq : 0,
        processedClientMessageIds: Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        processedClientMessageIdSet: new Set(
          Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        ),
        toolResults: new Map(Array.isArray(p.toolResults) ? p.toolResults : []),
        assistantAccumulator: new Map(),
      };
      session.state.backend_type = session.backendType;
      // Resolve git info for restored sessions (may have been persisted without it)
      resolveGitInfo(session.state);
      this.sessions.set(p.id, session);
      // Restored sessions with completed turns don't need auto-naming re-triggered
      if (session.state.num_turns > 0) {
        this.autoNamingAttempted.add(session.id);
      }
      count++;
    }
    if (count > 0) {
      console.log(`[ws-bridge] Restored ${count} session(s) from disk`);
    }
    return count;
  }

  /** Persist a session to disk (debounced). */
  private persistSession(session: Session): void {
    if (!this.store) return;
    this.store.save({
      id: session.id,
      state: session.state,
      messageHistory: session.messageHistory,
      pendingMessages: session.pendingMessages,
      pendingPermissions: Array.from(session.pendingPermissions.entries()),
      eventBuffer: session.eventBuffer,
      nextEventSeq: session.nextEventSeq,
      lastAckSeq: session.lastAckSeq,
      processedClientMessageIds: session.processedClientMessageIds,
      toolResults: Array.from(session.toolResults.entries()),
    });
  }

  /** Persist a session to disk immediately (bypass debounce). */
  persistSessionSync(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.store) return;
    this.store.saveSync({
      id: session.id,
      state: session.state,
      messageHistory: session.messageHistory,
      pendingMessages: session.pendingMessages,
      pendingPermissions: Array.from(session.pendingPermissions.entries()),
      eventBuffer: session.eventBuffer,
      nextEventSeq: session.nextEventSeq,
      lastAckSeq: session.lastAckSeq,
      processedClientMessageIds: session.processedClientMessageIds,
      toolResults: Array.from(session.toolResults.entries()),
    });
  }

  private refreshGitInfo(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): void {
    const before = {
      git_branch: session.state.git_branch,
      is_worktree: session.state.is_worktree,
      is_containerized: session.state.is_containerized,
      repo_root: session.state.repo_root,
      git_ahead: session.state.git_ahead,
      git_behind: session.state.git_behind,
    };

    resolveGitInfo(session.state);

    let changed = false;
    for (const key of WsBridge.GIT_SESSION_KEYS) {
      if (session.state[key] !== before[key]) {
        changed = true;
        break;
      }
    }

    if (changed) {
      if (options.broadcastUpdate) {
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: {
            git_branch: session.state.git_branch,
            is_worktree: session.state.is_worktree,
            is_containerized: session.state.is_containerized,
            repo_root: session.state.repo_root,
            git_ahead: session.state.git_ahead,
            git_behind: session.state.git_behind,
          },
        });
      }
      this.persistSession(session);
    }

    if (options.notifyPoller && session.state.git_branch && session.state.cwd && this.onGitInfoReady) {
      this.onGitInfoReady(session.id, session.state.cwd, session.state.git_branch);
    }
  }

  // ── Session management ──────────────────────────────────────────────────

  getOrCreateSession(sessionId: string, backendType?: BackendType): Session {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const type = backendType || "claude";
      session = {
        id: sessionId,
        backendType: type,
        cliSocket: null,
        codexAdapter: null,
        browserSockets: new Set(),
        state: makeDefaultState(sessionId, type),
        pendingPermissions: new Map(),
        pendingControlRequests: new Map(),
        messageHistory: [],
        pendingMessages: [],
        nextEventSeq: 1,
        eventBuffer: [],
        lastAckSeq: 0,
        processedClientMessageIds: [],
        processedClientMessageIdSet: new Set(),
        toolResults: new Map(),
        assistantAccumulator: new Map(),
      };
      this.sessions.set(sessionId, session);
    } else if (backendType) {
      // Only overwrite backendType when explicitly provided (e.g. attachCodexAdapter)
      // Prevents handleBrowserOpen from resetting codex→claude
      session.backendType = backendType;
      session.state.backend_type = backendType;
    }
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  /** Returns the truncated content of the last user message for a session. */
  getLastUserMessage(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      const m = session.messageHistory[i];
      if (m.type === "user_message") {
        return m.content.slice(0, 80);
      }
    }
    return undefined;
  }

  getCodexRateLimits(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session?.codexAdapter?.getRateLimits() ?? null;
  }

  isCliConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.backendType === "codex") {
      return !!session.codexAdapter?.isConnected();
    }
    return !!session.cliSocket;
  }

  removeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
    this.imageStore?.removeSession(sessionId);
  }

  /**
   * Close all sockets (CLI + browsers) for a session and remove it.
   */
  closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Close CLI socket (Claude)
    if (session.cliSocket) {
      try { session.cliSocket.close(); } catch {}
      session.cliSocket = null;
    }

    // Disconnect Codex adapter
    if (session.codexAdapter) {
      session.codexAdapter.disconnect().catch(() => {});
      session.codexAdapter = null;
    }

    // Close all browser sockets
    for (const ws of session.browserSockets) {
      try { ws.close(); } catch {}
    }
    session.browserSockets.clear();

    this.sessions.delete(sessionId);
    this.autoNamingAttempted.delete(sessionId);
    this.store?.remove(sessionId);
    this.imageStore?.removeSession(sessionId);
  }

  // ── Codex adapter attachment ────────────────────────────────────────────

  /**
   * Attach a CodexAdapter to a session. The adapter handles all message
   * translation between the Codex app-server (stdio JSON-RPC) and the
   * browser WebSocket protocol.
   */
  attachCodexAdapter(sessionId: string, adapter: CodexAdapter): void {
    const session = this.getOrCreateSession(sessionId, "codex");
    session.backendType = "codex";
    session.state.backend_type = "codex";
    session.codexAdapter = adapter;

    // Forward translated messages to browsers
    adapter.onBrowserMessage((msg) => {
      if (msg.type === "session_init") {
        session.state = { ...session.state, ...msg.session, backend_type: "codex" };
        this.refreshGitInfo(session, { notifyPoller: true });
        this.persistSession(session);
      } else if (msg.type === "session_update") {
        session.state = { ...session.state, ...msg.session, backend_type: "codex" };
        this.refreshGitInfo(session, { notifyPoller: true });
        this.persistSession(session);
      } else if (msg.type === "status_change") {
        session.state.is_compacting = msg.status === "compacting";
        this.persistSession(session);
      }

      // Store assistant/result messages in history for replay
      if (msg.type === "assistant") {
        session.messageHistory.push({ ...msg, timestamp: msg.timestamp || Date.now() });
        this.persistSession(session);
      } else if (msg.type === "result") {
        session.messageHistory.push(msg);
        this.persistSession(session);
      }

      // Diagnostic: log tool_use assistant messages
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content;
        const hasToolUse = content?.some((b) => b.type === "tool_use");
        if (hasToolUse) {
          console.log(`[ws-bridge] Broadcasting tool_use assistant to ${session.browserSockets.size} browser(s) for session ${session.id}`);
        }
      }

      // Handle permission requests
      if (msg.type === "permission_request") {
        session.pendingPermissions.set(msg.request.request_id, msg.request);
        this.persistSession(session);
      }

      this.broadcastToBrowsers(session, msg);

      // Trigger auto-naming after the first result
      if (
        msg.type === "result" &&
        !(msg.data as { is_error?: boolean }).is_error &&
        this.onFirstTurnCompleted &&
        !this.autoNamingAttempted.has(session.id)
      ) {
        this.autoNamingAttempted.add(session.id);
        const firstUserMsg = session.messageHistory.find((m) => m.type === "user_message");
        if (firstUserMsg && firstUserMsg.type === "user_message") {
          this.onFirstTurnCompleted(session.id, firstUserMsg.content);
        }
      }
    });

    // Handle session metadata updates
    adapter.onSessionMeta((meta) => {
      if (meta.cliSessionId && this.onCLISessionId) {
        this.onCLISessionId(session.id, meta.cliSessionId);
      }
      if (meta.model) {
        session.state.model = meta.model;
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: { model: meta.model },
        });
      }
      if (meta.cwd) session.state.cwd = meta.cwd;
      session.state.backend_type = "codex";
      this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
      this.persistSession(session);
    });

    // Handle disconnect
    adapter.onDisconnect(() => {
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      session.pendingPermissions.clear();
      session.codexAdapter = null;
      this.persistSession(session);
      console.log(`[ws-bridge] Codex adapter disconnected for session ${sessionId}`);
      this.broadcastToBrowsers(session, { type: "cli_disconnected" });
    });

    // Flush any messages queued while waiting for the adapter
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) to Codex adapter for session ${sessionId}`);
      const queued = session.pendingMessages.splice(0);
      for (const raw of queued) {
        try {
          const msg = JSON.parse(raw) as BrowserOutgoingMessage;
          adapter.sendBrowserMessage(msg);
        } catch {
          console.warn(`[ws-bridge] Failed to parse queued message for Codex: ${raw.substring(0, 100)}`);
        }
      }
    }

    // Notify browsers that the backend is connected
    this.broadcastToBrowsers(session, { type: "cli_connected" });
    console.log(`[ws-bridge] Codex adapter attached for session ${sessionId}`);
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    session.cliSocket = ws;
    console.log(`[ws-bridge] CLI connected for session ${sessionId}`);
    this.broadcastToBrowsers(session, { type: "cli_connected" });

    // Flush any messages queued while waiting for the CLI WebSocket.
    // Per the SDK protocol, the first user message triggers system.init,
    // so we must send it as soon as the WebSocket is open — NOT wait for
    // system.init (which would create a deadlock for slow-starting sessions
    // like Docker containers where the user message arrives before CLI connects).
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) on CLI connect for session ${sessionId}`);
      const queued = session.pendingMessages.splice(0);
      for (const ndjson of queued) {
        this.sendToCLI(session, ndjson);
      }
    }
  }

  handleCLIMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Record raw incoming CLI message before any parsing
    this.recorder?.record(sessionId, "in", data, "cli", session.backendType, session.state.cwd);

    // NDJSON: split on newlines, parse each line
    const lines = data.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let msg: CLIMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        console.warn(`[ws-bridge] Failed to parse CLI message: ${line.substring(0, 200)}`);
        continue;
      }
      this.routeCLIMessage(session, msg);
    }
  }

  handleCLIClose(ws: ServerWebSocket<SocketData>) {
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.cliSocket = null;
    console.log(`[ws-bridge] CLI disconnected for session ${sessionId}`);
    this.broadcastToBrowsers(session, { type: "cli_disconnected" });

    // Cancel any pending permission requests
    for (const [reqId] of session.pendingPermissions) {
      this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
    }
    session.pendingPermissions.clear();
    session.assistantAccumulator.clear();
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    const browserData = ws.data as BrowserSocketData;
    browserData.subscribed = false;
    browserData.lastAckSeq = 0;
    session.browserSockets.add(ws);
    console.log(`[ws-bridge] Browser connected for session ${sessionId} (${session.browserSockets.size} browsers)`);

    // Refresh git state on browser connect so branch changes made mid-session are reflected.
    this.refreshGitInfo(session, { notifyPoller: true });

    // Send current session state as snapshot (includes nextEventSeq for stale seq detection).
    // If slash_commands/skills haven't arrived yet (CLI sends them only after the first
    // user message), fill from the per-project cache so autocomplete works immediately.
    let snapshotState = session.state;
    if (!snapshotState.slash_commands?.length || !snapshotState.skills?.length) {
      const projectKey = session.state.repo_root || session.state.cwd;
      const cached = projectKey ? this.slashCommandCache.get(projectKey) : undefined;
      if (cached) {
        snapshotState = { ...snapshotState };
        if (!snapshotState.slash_commands?.length) snapshotState.slash_commands = cached.slash_commands;
        if (!snapshotState.skills?.length) snapshotState.skills = cached.skills;
      }
    }
    const snapshot: BrowserIncomingMessage = {
      type: "session_init",
      session: snapshotState,
      nextEventSeq: session.nextEventSeq,
    };
    this.sendToBrowser(ws, snapshot);

    // History replay and pending permissions are sent by handleSessionSubscribe
    // (triggered when the browser sends session_subscribe after onopen).
    // Sending them here too would cause double delivery, leading to duplicate
    // or tangled messages across sessions during reconnects.

    // Notify if backend is not connected and request relaunch
    const backendConnected = session.backendType === "codex"
      // Treat an attached adapter as "alive" during init.
      // `isConnected()` flips true only after initialize/thread start, and
      // relaunching during that window can kill a healthy startup.
      ? !!session.codexAdapter
      : !!session.cliSocket;

    if (!backendConnected) {
      this.sendToBrowser(ws, { type: "cli_disconnected" });
      if (this.onCLIRelaunchNeeded) {
        console.log(`[ws-bridge] Browser connected but backend is dead for session ${sessionId}, requesting relaunch`);
        this.onCLIRelaunchNeeded(sessionId);
      }
    } else {
      this.sendToBrowser(ws, { type: "cli_connected" });
    }
  }

  handleBrowserMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Record raw incoming browser message
    this.recorder?.record(sessionId, "in", data, "browser", session.backendType, session.state.cwd);

    let msg: BrowserOutgoingMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      console.warn(`[ws-bridge] Failed to parse browser message: ${data.substring(0, 200)}`);
      return;
    }

    this.routeBrowserMessage(session, msg, ws);
  }

  /** Send a user message into a session programmatically (no browser required).
   *  Used by the cron scheduler to send prompts to autonomous sessions. */
  injectUserMessage(sessionId: string, content: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject message: session ${sessionId} not found`);
      return;
    }
    this.routeBrowserMessage(session, { type: "user_message", content });
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>) {
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.browserSockets.delete(ws);
    const hasBackend = session.backendType === "codex" ? !!session.codexAdapter : !!session.cliSocket;
    console.log(`[ws-bridge] Browser disconnected for session ${sessionId} (${session.browserSockets.size} remaining, backend=${hasBackend ? "alive" : "dead"})`);
  }

  // ── CLI message routing ─────────────────────────────────────────────────

  private routeCLIMessage(session: Session, msg: CLIMessage) {
    switch (msg.type) {
      case "system":
        this.handleSystemMessage(session, msg);
        break;

      case "assistant":
        this.handleAssistantMessage(session, msg);
        break;

      case "result":
        this.handleResultMessage(session, msg);
        break;

      case "stream_event":
        this.handleStreamEvent(session, msg);
        break;

      case "control_request":
        this.handleControlRequest(session, msg);
        break;

      case "tool_progress":
        this.handleToolProgress(session, msg);
        break;

      case "tool_use_summary":
        this.handleToolUseSummary(session, msg);
        break;

      case "auth_status":
        this.handleAuthStatus(session, msg);
        break;

      case "control_response":
        this.handleControlResponse(session, msg);
        break;

      case "user": {
        // Check if this is the compaction summary (text block following compact_boundary)
        if (session.awaitingCompactSummary) {
          const content = (msg as CLIUserMessage).message?.content;
          let summaryText: string | undefined;
          if (typeof content === "string" && content.length > 0) {
            summaryText = content;
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
            summaryText = textBlock?.text;
          }
          if (summaryText) {
            session.awaitingCompactSummary = false;
            // Update the most recent compact marker in history with the summary
            const marker = session.messageHistory.findLast((m) => m.type === "compact_marker");
            if (marker && marker.type === "compact_marker") {
              (marker as { summary?: string }).summary = summaryText;
            }
            this.broadcastToBrowsers(session, { type: "compact_summary", summary: summaryText });
            this.persistSession(session);
            break;
          }
          // No summary text found — clear the flag to avoid getting stuck
          session.awaitingCompactSummary = false;
        }
        this.handleToolResultMessage(session, msg as CLIUserMessage);
        break;
      }

      case "keep_alive":
        // Silently consume keepalives
        break;

      default:
        // Forward unknown messages as-is for debugging
        break;
    }
  }

  private handleSystemMessage(session: Session, msg: CLISystemInitMessage | CLISystemStatusMessage | CLISystemCompactBoundaryMessage) {
    if (msg.subtype === "init") {
      // Keep the launcher-assigned session_id as the canonical ID.
      // The CLI may report its own internal session_id which differs
      // from the launcher UUID, causing duplicate entries in the sidebar.

      // Store the CLI's internal session_id so we can --resume on relaunch
      if (msg.session_id && this.onCLISessionId) {
        this.onCLISessionId(session.id, msg.session_id);
      }

      session.state.model = msg.model;
      // For containerized sessions, the CLI reports /workspace as its cwd.
      // Keep the host path (set by markContainerized()) for correct project grouping.
      if (!session.state.is_containerized) {
        session.state.cwd = msg.cwd;
      }
      session.state.tools = msg.tools;
      session.state.permissionMode = msg.permissionMode;
      session.state.claude_code_version = msg.claude_code_version;
      session.state.mcp_servers = msg.mcp_servers;
      session.state.agents = msg.agents ?? [];
      session.state.slash_commands = msg.slash_commands ?? [];
      session.state.skills = msg.skills ?? [];

      // Cache slash commands per project so new sessions get them immediately
      const projectKey = session.state.repo_root || session.state.cwd;
      if (projectKey && (msg.slash_commands?.length || msg.skills?.length)) {
        this.slashCommandCache.set(projectKey, {
          slash_commands: msg.slash_commands ?? [],
          skills: msg.skills ?? [],
        });
      }

      // Resolve and publish git info
      this.refreshGitInfo(session, { notifyPoller: true });

      this.broadcastToBrowsers(session, {
        type: "session_init",
        session: session.state,
      });
      this.persistSession(session);

      // Flush any messages queued before CLI was initialized (e.g. user sent
      // a message while the container was still starting up).
      if (session.pendingMessages.length > 0) {
        console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) after init for session ${session.id}`);
        const queued = session.pendingMessages.splice(0);
        for (const ndjson of queued) {
          this.sendToCLI(session, ndjson);
        }
      }
    } else if (msg.subtype === "status") {
      session.state.is_compacting = msg.status === "compacting";

      if (msg.permissionMode) {
        session.state.permissionMode = msg.permissionMode;
        // Broadcast CLI-authoritative mode change to all browsers so they stay in sync
        const uiMode = msg.permissionMode === "plan" ? "plan" : "agent";
        session.state.uiMode = uiMode;
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: { permissionMode: msg.permissionMode, uiMode },
        });
      }

      this.broadcastToBrowsers(session, {
        type: "status_change",
        status: msg.status ?? null,
      });
    } else if (msg.subtype === "compact_boundary") {
      // CLI has compacted its context — append a compact marker as a divider.
      // Old messages are preserved for browser display; the marker visually separates
      // pre- and post-compaction segments. The next CLI "user" message with a text
      // block will contain the compaction summary.
      const ts = Date.now();
      const meta = (msg as CLISystemCompactBoundaryMessage).compact_metadata;
      session.messageHistory.push({
        type: "compact_marker" as const,
        timestamp: ts,
        id: `compact-boundary-${ts}`,
        trigger: meta?.trigger,
        preTokens: meta?.pre_tokens,
      });
      session.awaitingCompactSummary = true;
      this.broadcastToBrowsers(session, {
        type: "compact_boundary",
        trigger: meta?.trigger,
        preTokens: meta?.pre_tokens,
      });
      this.persistSession(session);
    }
    // Other system subtypes (task_notification, etc.) can be forwarded as needed
  }

  private handleAssistantMessage(session: Session, msg: CLIAssistantMessage) {
    const msgId = msg.message?.id;

    // No ID — forward as-is (defensive)
    if (!msgId) {
      const browserMsg: BrowserIncomingMessage = {
        type: "assistant",
        message: msg.message,
        parent_tool_use_id: msg.parent_tool_use_id,
        timestamp: Date.now(),
        uuid: msg.uuid,
      };
      session.messageHistory.push(browserMsg);
      this.broadcastToBrowsers(session, browserMsg);
      this.persistSession(session);
      return;
    }

    const acc = session.assistantAccumulator.get(msgId);

    if (!acc) {
      // First occurrence of this message ID.
      // Check if it's a CLI reconnect resending a completed message.
      const alreadyInHistory = session.messageHistory.some(
        (m) => m.type === "assistant" && (m as { message?: { id?: string } }).message?.id === msgId,
      );
      if (alreadyInHistory) {
        // Already fully accumulated from a previous connection — skip
        return;
      }

      const browserMsg: BrowserIncomingMessage = {
        type: "assistant",
        message: { ...msg.message, content: [...msg.message.content] },
        parent_tool_use_id: msg.parent_tool_use_id,
        timestamp: Date.now(),
        uuid: msg.uuid,
      };

      // Track content block IDs to avoid duplicates
      const contentBlockIds = new Set<string>();
      for (const block of msg.message.content) {
        if (block.type === "tool_use" && block.id) {
          contentBlockIds.add(block.id);
        }
      }

      session.assistantAccumulator.set(msgId, { contentBlockIds });
      session.messageHistory.push(browserMsg);
      this.broadcastToBrowsers(session, browserMsg);
    } else {
      // Subsequent occurrence — merge new content blocks into the history entry
      const historyEntry = session.messageHistory.findLast(
        (m) => m.type === "assistant" && (m as { message?: { id?: string } }).message?.id === msgId,
      ) as { type: "assistant"; message: CLIAssistantMessage["message"] } | undefined;

      if (!historyEntry) return; // shouldn't happen

      for (const block of msg.message.content) {
        if (block.type === "tool_use" && block.id) {
          if (acc.contentBlockIds.has(block.id)) continue;
          acc.contentBlockIds.add(block.id);
        }
        historyEntry.message.content.push(block);
      }

      // Update stop_reason and usage from the latest message
      if (msg.message.stop_reason) {
        historyEntry.message.stop_reason = msg.message.stop_reason;
      }
      if (msg.message.usage) {
        historyEntry.message.usage = msg.message.usage;
      }

      // Re-broadcast the full accumulated message
      this.broadcastToBrowsers(session, historyEntry as BrowserIncomingMessage);
    }

    // Clean up accumulator when message is complete
    if (msg.message.stop_reason) {
      session.assistantAccumulator.delete(msgId);
    }

    this.persistSession(session);
  }

  private handleResultMessage(session: Session, msg: CLIResultMessage) {
    // Update session cost/turns
    session.state.total_cost_usd = msg.total_cost_usd;
    session.state.num_turns = msg.num_turns;

    // Update lines changed (CLI may send these in result)
    if (typeof msg.total_lines_added === "number") {
      session.state.total_lines_added = msg.total_lines_added;
    }
    if (typeof msg.total_lines_removed === "number") {
      session.state.total_lines_removed = msg.total_lines_removed;
    }

    // Compute context usage from modelUsage
    if (msg.modelUsage) {
      for (const usage of Object.values(msg.modelUsage)) {
        if (usage.contextWindow > 0) {
          const pct = Math.round(
            ((usage.inputTokens + usage.outputTokens) / usage.contextWindow) * 100
          );
          session.state.context_used_percent = Math.max(0, Math.min(pct, 100));
        }
      }
    }

    // Re-check git state after each turn in case branch moved during the session.
    this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });

    // Broadcast updated metrics to all browsers
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: {
        total_cost_usd: session.state.total_cost_usd,
        num_turns: session.state.num_turns,
        context_used_percent: session.state.context_used_percent,
        total_lines_added: session.state.total_lines_added,
        total_lines_removed: session.state.total_lines_removed,
      },
    });

    const browserMsg: BrowserIncomingMessage = {
      type: "result",
      data: msg,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);

    // Trigger auto-naming after the first successful result for this session.
    // Note: num_turns counts all internal tool-use turns, so it's typically > 1
    // even on the first user interaction. We track per-session instead.
    if (
      !msg.is_error &&
      this.onFirstTurnCompleted &&
      !this.autoNamingAttempted.has(session.id)
    ) {
      this.autoNamingAttempted.add(session.id);
      const firstUserMsg = session.messageHistory.find(
        (m) => m.type === "user_message",
      );
      if (firstUserMsg && firstUserMsg.type === "user_message") {
        this.onFirstTurnCompleted(session.id, firstUserMsg.content);
      }
    }
  }

  private handleStreamEvent(session: Session, msg: CLIStreamEventMessage) {
    this.broadcastToBrowsers(session, {
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  private handleControlRequest(session: Session, msg: CLIControlRequestMessage) {
    if (msg.request.subtype === "can_use_tool") {
      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions,
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        timestamp: Date.now(),
      };
      session.pendingPermissions.set(msg.request_id, perm);

      this.broadcastToBrowsers(session, {
        type: "permission_request",
        request: perm,
      });
      this.persistSession(session);
    }
  }

  private handleToolProgress(session: Session, msg: CLIToolProgressMessage) {
    this.broadcastToBrowsers(session, {
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
    });
  }

  private handleToolUseSummary(session: Session, msg: CLIToolUseSummaryMessage) {
    this.broadcastToBrowsers(session, {
      type: "tool_use_summary",
      summary: msg.summary,
      tool_use_ids: msg.preceding_tool_use_ids,
    });
  }

  private handleToolResultMessage(session: Session, msg: CLIUserMessage) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    const previews: ToolResultPreview[] = [];

    for (const block of content) {
      if (block.type !== "tool_result") continue;

      const resultContent = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content);
      const totalSize = resultContent.length;
      const isTruncated = totalSize > TOOL_RESULT_PREVIEW_LIMIT;

      // Store full result for lazy fetch
      session.toolResults.set(block.tool_use_id, {
        content: resultContent,
        is_error: !!block.is_error,
        timestamp: Date.now(),
      });

      previews.push({
        tool_use_id: block.tool_use_id,
        content: isTruncated
          ? resultContent.slice(-TOOL_RESULT_PREVIEW_LIMIT)
          : resultContent,
        is_error: !!block.is_error,
        total_size: totalSize,
        is_truncated: isTruncated,
      });
    }

    if (previews.length === 0) return;

    const browserMsg: BrowserIncomingMessage = {
      type: "tool_result_preview",
      previews,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);
  }

  /** Look up a full tool result by tool_use_id for lazy fetch via REST. */
  getToolResult(sessionId: string, toolUseId: string): {
    content: string;
    is_error: boolean;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const indexed = session.toolResults.get(toolUseId);
    if (indexed) {
      return { content: indexed.content, is_error: indexed.is_error };
    }

    return null;
  }

  private handleAuthStatus(session: Session, msg: CLIAuthStatusMessage) {
    this.broadcastToBrowsers(session, {
      type: "auth_status",
      isAuthenticating: msg.isAuthenticating,
      output: msg.output,
      error: msg.error,
    });
  }

  // ── Browser message routing ─────────────────────────────────────────────

  private async routeBrowserMessage(
    session: Session,
    msg: BrowserOutgoingMessage,
    ws?: ServerWebSocket<SocketData>,
  ) {
    if (msg.type === "session_subscribe") {
      this.handleSessionSubscribe(session, ws, msg.last_seq);
      return;
    }

    if (msg.type === "session_ack") {
      this.handleSessionAck(session, ws, msg.last_seq);
      return;
    }

    // Heartbeat — keeps the connection alive, no action needed
    if ((msg as { type: string }).type === "ping") return;

    if (
      WsBridge.IDEMPOTENT_BROWSER_MESSAGE_TYPES.has(msg.type)
      && "client_msg_id" in msg
      && msg.client_msg_id
    ) {
      if (this.isDuplicateClientMessage(session, msg.client_msg_id)) {
        return;
      }
      this.rememberClientMessage(session, msg.client_msg_id);
    }

    // For Codex sessions, delegate entirely to the adapter
    if (session.backendType === "codex") {
      // Store user messages in history for replay with stable ID for dedup on reconnect
      if (msg.type === "user_message") {
        const ts = Date.now();
        let imageRefs: import("./image-store.js").ImageRef[] | undefined;
        if (msg.images?.length && this.imageStore) {
          imageRefs = [];
          for (const img of msg.images) {
            const ref = await this.imageStore.store(session.id, img.data, img.media_type);
            imageRefs.push(ref);
          }
        }
        const userHistoryEntry: BrowserIncomingMessage = {
          type: "user_message",
          content: msg.content,
          timestamp: ts,
          id: `user-${ts}-${this.userMsgCounter++}`,
          ...(imageRefs?.length ? { images: imageRefs } : {}),
        };
        session.messageHistory.push(userHistoryEntry);
        // Broadcast user message to all browsers (server-authoritative)
        this.broadcastToBrowsers(session, userHistoryEntry);
        this.broadcastToBrowsers(session, { type: "status_change", status: "running" });
        this.persistSession(session);
      }
      if (msg.type === "permission_response") {
        const pending = session.pendingPermissions.get(msg.request_id);
        session.pendingPermissions.delete(msg.request_id);
        if (msg.behavior === "allow" && pending && NOTABLE_APPROVALS.has(pending.tool_name)) {
          const answers = pending.tool_name === "AskUserQuestion"
            ? extractAskUserAnswers(pending.input, msg.updated_input)
            : undefined;
          // Skip AskUserQuestion if we couldn't extract answers (avoids redundant chip)
          if (pending.tool_name !== "AskUserQuestion" || answers) {
            const approvedMsg: BrowserIncomingMessage = {
              type: "permission_approved",
              id: `approval-${msg.request_id}`,
              tool_name: pending.tool_name,
              tool_use_id: pending.tool_use_id,
              summary: getApprovalSummary(pending.tool_name, pending.input),
              timestamp: Date.now(),
              ...(answers ? { answers } : {}),
            };
            session.messageHistory.push(approvedMsg);
            this.broadcastToBrowsers(session, approvedMsg);
          }
        }
        if (msg.behavior === "deny" && pending) {
          const deniedMsg: BrowserIncomingMessage = {
            type: "permission_denied",
            id: `denial-${msg.request_id}`,
            tool_name: pending.tool_name,
            tool_use_id: pending.tool_use_id,
            summary: getDenialSummary(pending.tool_name, pending.input),
            timestamp: Date.now(),
          };
          session.messageHistory.push(deniedMsg);
          this.broadcastToBrowsers(session, deniedMsg);
        }
        this.persistSession(session);
      }

      if (session.codexAdapter) {
        session.codexAdapter.sendBrowserMessage(msg);
      } else {
        // Adapter not yet attached — queue for when it's ready.
        // The adapter itself also queues during init, but this covers
        // the window between session creation and adapter attachment.
        console.log(`[ws-bridge] Codex adapter not yet attached for session ${session.id}, queuing ${msg.type}`);
        session.pendingMessages.push(JSON.stringify(msg));
      }
      return;
    }

    // Claude Code path (existing logic)
    switch (msg.type) {
      case "user_message":
        await this.handleUserMessage(session, msg);
        break;

      case "permission_response":
        this.handlePermissionResponse(session, msg);
        break;

      case "interrupt":
        this.handleInterrupt(session);
        break;

      case "set_model":
        this.handleSetModel(session, msg.model);
        break;

      case "set_permission_mode":
        this.handleSetPermissionMode(session, msg.mode);
        break;

      case "mcp_get_status":
        this.handleMcpGetStatus(session);
        break;

      case "mcp_toggle":
        this.handleMcpToggle(session, msg.serverName, msg.enabled);
        break;

      case "mcp_reconnect":
        this.handleMcpReconnect(session, msg.serverName);
        break;

      case "mcp_set_servers":
        this.handleMcpSetServers(session, msg.servers);
        break;

      case "set_ask_permission":
        this.handleSetAskPermission(session, msg.askPermission);
        break;
    }
  }

  private isDuplicateClientMessage(session: Session, clientMsgId: string): boolean {
    return session.processedClientMessageIdSet.has(clientMsgId);
  }

  private rememberClientMessage(session: Session, clientMsgId: string): void {
    session.processedClientMessageIds.push(clientMsgId);
    session.processedClientMessageIdSet.add(clientMsgId);
    if (session.processedClientMessageIds.length > WsBridge.PROCESSED_CLIENT_MSG_ID_LIMIT) {
      const overflow = session.processedClientMessageIds.length - WsBridge.PROCESSED_CLIENT_MSG_ID_LIMIT;
      const removed = session.processedClientMessageIds.splice(0, overflow);
      for (const id of removed) {
        session.processedClientMessageIdSet.delete(id);
      }
    }
    this.persistSession(session);
  }

  private handleSessionSubscribe(
    session: Session,
    ws: ServerWebSocket<SocketData> | undefined,
    lastSeq: number,
  ) {
    if (!ws) return;
    const data = ws.data as BrowserSocketData;
    data.subscribed = true;
    const lastAckSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
    data.lastAckSeq = lastAckSeq;

    // Fresh connection (no prior state) — send full history + pending permissions.
    // This is the single source of truth for initial state delivery (previously
    // also done in handleBrowserOpen, causing double delivery).
    if (lastAckSeq === 0) {
      if (session.messageHistory.length > 0) {
        this.sendToBrowser(ws, {
          type: "message_history",
          messages: session.messageHistory,
        });
      }
      for (const perm of session.pendingPermissions.values()) {
        this.sendToBrowser(ws, { type: "permission_request", request: perm });
      }
      // Also replay any buffered events so transient messages (stream_event,
      // tool_progress, status_change, etc.) are caught up
      if (session.eventBuffer.length > 0) {
        const transient = session.eventBuffer
          .filter((evt) => !this.isHistoryBackedEvent(evt.message));
        if (transient.length > 0) {
          this.sendToBrowser(ws, {
            type: "event_replay",
            events: transient,
          });
        }
      }
    } else if (session.eventBuffer.length > 0 && lastAckSeq < session.nextEventSeq - 1) {
      const earliest = session.eventBuffer[0]?.seq ?? session.nextEventSeq;
      const hasGap = lastAckSeq < earliest - 1;
      if (hasGap) {
        this.sendToBrowser(ws, {
          type: "message_history",
          messages: session.messageHistory,
        });
        for (const perm of session.pendingPermissions.values()) {
          this.sendToBrowser(ws, { type: "permission_request", request: perm });
        }
        const transientMissed = session.eventBuffer
          .filter((evt) => evt.seq > lastAckSeq && !this.isHistoryBackedEvent(evt.message));
        if (transientMissed.length > 0) {
          this.sendToBrowser(ws, {
            type: "event_replay",
            events: transientMissed,
          });
        }
      } else {
        const missed = session.eventBuffer.filter((evt) => evt.seq > lastAckSeq);
        if (missed.length > 0) {
          this.sendToBrowser(ws, {
            type: "event_replay",
            events: missed,
          });
        }
      }
    }

    // Always send authoritative state snapshot last — ensures transient state
    // (session status, CLI connection, permission mode) is correct regardless
    // of which events the browser may have missed.
    this.sendStateSnapshot(session, ws);
  }

  private handleSessionAck(
    session: Session,
    ws: ServerWebSocket<SocketData> | undefined,
    lastSeq: number,
  ) {
    const normalized = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
    if (ws) {
      const data = ws.data as BrowserSocketData;
      const prior = typeof data.lastAckSeq === "number" ? data.lastAckSeq : 0;
      data.lastAckSeq = Math.max(prior, normalized);
    }
    if (normalized > session.lastAckSeq) {
      session.lastAckSeq = normalized;
      this.persistSession(session);
    }
  }

  private async handleUserMessage(
    session: Session,
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[] }
  ) {
    const ts = Date.now();

    // Store images to disk and get refs (if imageStore is available)
    let imageRefs: import("./image-store.js").ImageRef[] | undefined;
    if (msg.images?.length && this.imageStore) {
      imageRefs = [];
      for (const img of msg.images) {
        const ref = await this.imageStore.store(session.id, img.data, img.media_type);
        imageRefs.push(ref);
      }
    }

    // Store user message in history for replay with stable ID for dedup on reconnect
    const userHistoryEntry: BrowserIncomingMessage = {
      type: "user_message",
      content: msg.content,
      timestamp: ts,
      id: `user-${ts}-${this.userMsgCounter++}`,
      ...(imageRefs?.length ? { images: imageRefs } : {}),
    };
    session.messageHistory.push(userHistoryEntry);
    // Broadcast user message to all browsers (server-authoritative: browsers
    // never add user messages locally, they render only what the server sends)
    this.broadcastToBrowsers(session, userHistoryEntry);

    // Build content: if images are present, convert unsupported formats and use
    // content block array; otherwise plain string. Conversion operates on copies
    // so that the original base64 data stored to disk is not affected.
    let content: string | unknown[];
    if (msg.images?.length) {
      const blocks: unknown[] = [];
      for (const img of msg.images) {
        let mediaType = img.media_type;
        let data = img.data;
        if (this.imageStore) {
          const converted = await this.imageStore.convertForApi(data, mediaType);
          mediaType = converted.mediaType;
          data = converted.base64;
        }
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data },
        });
      }
      blocks.push({ type: "text", text: msg.content });
      content = blocks;
    } else {
      content = msg.content;
    }

    const ndjson = JSON.stringify({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: msg.session_id || session.state.session_id || "",
    });
    this.sendToCLI(session, ndjson);
    // Notify all browsers immediately so the UI shows "Thinking" without
    // waiting for the CLI's first assistant response.
    this.broadcastToBrowsers(session, { type: "status_change", status: "running" });
    this.persistSession(session);
  }

  private handlePermissionResponse(
    session: Session,
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: unknown[]; message?: string }
  ) {
    // Remove from pending
    const pending = session.pendingPermissions.get(msg.request_id);
    session.pendingPermissions.delete(msg.request_id);

    if (msg.behavior === "allow") {
      const response: Record<string, unknown> = {
        behavior: "allow",
        updatedInput: msg.updated_input ?? pending?.input ?? {},
      };
      if (msg.updated_permissions?.length) {
        response.updatedPermissions = msg.updated_permissions;
      }
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response,
        },
      });
      this.sendToCLI(session, ndjson);

      // Broadcast approval record for notable approvals only.
      // Most tool approvals are redundant since the ToolBlock already shows
      // the command/file/question. ExitPlanMode and AskUserQuestion need
      // visible markers (plan state transition / user's chosen answer).
      if (pending && NOTABLE_APPROVALS.has(pending.tool_name)) {
        const answers = pending.tool_name === "AskUserQuestion"
          ? extractAskUserAnswers(pending.input, msg.updated_input)
          : undefined;
        // Skip AskUserQuestion if we couldn't extract answers (avoids redundant chip)
        if (pending.tool_name !== "AskUserQuestion" || answers) {
          const approvedMsg: BrowserIncomingMessage = {
            type: "permission_approved",
            id: `approval-${msg.request_id}`,
            request_id: msg.request_id,
            tool_name: pending.tool_name,
            tool_use_id: pending.tool_use_id,
            summary: getApprovalSummary(pending.tool_name, pending.input),
            timestamp: Date.now(),
            ...(answers ? { answers } : {}),
          };
          session.messageHistory.push(approvedMsg);
          this.broadcastToBrowsers(session, approvedMsg);
        }
      }

      // After ExitPlanMode approval, switch the CLI to the appropriate execution
      // mode. The CLI does NOT auto-transition out of plan mode — it needs an
      // explicit set_permission_mode control_request.
      //   askPermission=true  → acceptEdits (edits auto-approved, Bash prompted)
      //   askPermission=false → bypassPermissions (everything auto-approved)
      if (pending?.tool_name === "ExitPlanMode") {
        const askPerm = session.state.askPermission !== false; // default true
        const postPlanMode = askPerm ? "acceptEdits" : "bypassPermissions";
        this.handleSetPermissionMode(session, postPlanMode);
        // Immediately tell browsers the session is running — the CLI will
        // start executing the plan right away but its own status update
        // takes a round-trip to arrive.
        this.broadcastToBrowsers(session, { type: "status_change", status: "running" });
        console.log(`[ws-bridge] ExitPlanMode approved for session ${session.id}, switching to ${postPlanMode} (askPermission=${askPerm})`);
      }
    } else {
      const ndjson = JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            behavior: "deny",
            message: msg.message || "Denied by user",
          },
        },
      });
      this.sendToCLI(session, ndjson);

      // When ExitPlanMode is denied, also interrupt the CLI so it stops
      // and waits for new user input (matches Claude Code vanilla behavior)
      if (pending?.tool_name === "ExitPlanMode") {
        this.handleInterrupt(session);
        // Don't broadcast "idle" here — let the CLI's interrupt response set
        // the status naturally. Broadcasting idle eagerly causes a flash when
        // the browser auto-rejects a plan by sending a new message (deny →
        // interrupt → user_message), because the CLI's interrupt response
        // arrives after user_message's "running" broadcast and overwrites it.
        console.log(`[ws-bridge] ExitPlanMode denied for session ${session.id}, sending interrupt`);
      }

      // Broadcast denial record to all browsers and persist in history
      const deniedMsg: BrowserIncomingMessage = {
        type: "permission_denied",
        id: `denial-${msg.request_id}`,
        request_id: msg.request_id,
        tool_name: pending?.tool_name || "unknown",
        tool_use_id: pending?.tool_use_id || "",
        summary: getDenialSummary(pending?.tool_name || "unknown", pending?.input || {}),
        timestamp: Date.now(),
      };
      session.messageHistory.push(deniedMsg);
      this.broadcastToBrowsers(session, deniedMsg);
    }
    this.persistSession(session);
  }

  private handleInterrupt(session: Session) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToCLI(session, ndjson);
  }

  private handleSetModel(session: Session, model: string) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_model", model },
    });
    this.sendToCLI(session, ndjson);
    // Optimistically update server-side state and broadcast to all browsers
    session.state.model = model;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { model },
    });
    this.persistSession(session);
  }

  private handleSetPermissionMode(session: Session, mode: string) {
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "set_permission_mode", mode },
    });
    this.sendToCLI(session, ndjson);
    // Optimistically update server-side state and broadcast to all browsers
    const uiMode = mode === "plan" ? "plan" : "agent";
    session.state.permissionMode = mode;
    session.state.uiMode = uiMode;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { permissionMode: mode, uiMode },
    });
    this.persistSession(session);
  }

  private handleSetAskPermission(session: Session, askPermission: boolean) {
    session.state.askPermission = askPermission;
    // Resolve the new CLI permission mode based on current UI mode + new ask state
    const uiMode = session.state.uiMode ?? "agent";
    const newMode = uiMode === "plan" ? "plan" : (askPermission ? "acceptEdits" : "bypassPermissions");
    session.state.permissionMode = newMode;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { askPermission, permissionMode: newMode, uiMode },
    });
    this.persistSession(session);
    // Trigger CLI restart with the new permission mode
    this.onPermissionModeChanged?.(session.id, newMode);
  }

  // ── Control response handling ─────────────────────────────────────────

  private handleControlResponse(
    session: Session,
    msg: CLIControlResponseMessage,
  ) {
    const reqId = msg.response.request_id;
    const pending = session.pendingControlRequests.get(reqId);
    if (!pending) return; // Not a request we're tracking
    session.pendingControlRequests.delete(reqId);

    if (msg.response.subtype === "error") {
      console.warn(`[ws-bridge] Control request ${pending.subtype} failed: ${msg.response.error}`);
      return;
    }

    pending.resolve(msg.response.response ?? {});
  }

  // ── MCP control messages ──────────────────────────────────────────────

  /** Send a control_request to CLI, optionally tracking the response via a callback. */
  private sendControlRequest(
    session: Session,
    request: Record<string, unknown>,
    onResponse?: PendingControlRequest,
  ) {
    const requestId = randomUUID();
    if (onResponse) {
      session.pendingControlRequests.set(requestId, onResponse);
    }
    this.sendToCLI(session, JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request,
    }));
  }

  private handleMcpGetStatus(session: Session) {
    this.sendControlRequest(session, { subtype: "mcp_status" }, {
      subtype: "mcp_status",
      resolve: (response) => {
        const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
        this.broadcastToBrowsers(session, { type: "mcp_status", servers });
      },
    });
  }

  private handleMcpToggle(session: Session, serverName: string, enabled: boolean) {
    this.sendControlRequest(session, { subtype: "mcp_toggle", serverName, enabled });
    setTimeout(() => this.handleMcpGetStatus(session), 500);
  }

  private handleMcpReconnect(session: Session, serverName: string) {
    this.sendControlRequest(session, { subtype: "mcp_reconnect", serverName });
    setTimeout(() => this.handleMcpGetStatus(session), 1000);
  }

  private handleMcpSetServers(session: Session, servers: Record<string, McpServerConfig>) {
    this.sendControlRequest(session, { subtype: "mcp_set_servers", servers });
    setTimeout(() => this.handleMcpGetStatus(session), 2000);
  }

  // ── Transport helpers ───────────────────────────────────────────────────

  private sendToCLI(session: Session, ndjson: string) {
    if (!session.cliSocket) {
      // Queue the message — CLI might still be starting up.
      // Don't record here; the message will be recorded when flushed.
      console.log(`[ws-bridge] CLI not yet connected for session ${session.id}, queuing message`);
      session.pendingMessages.push(ndjson);
      return;
    }
    // Record raw outgoing CLI message (only when actually sending, not when queuing)
    this.recorder?.record(session.id, "out", ndjson, "cli", session.backendType, session.state.cwd);
    try {
      // NDJSON requires a newline delimiter
      session.cliSocket.send(ndjson + "\n");
    } catch (err) {
      console.error(`[ws-bridge] Failed to send to CLI for session ${session.id}:`, err);
    }
  }

  /** Push a partial session state update to all connected browsers for a session. */
  broadcastSessionUpdate(sessionId: string, update: Record<string, unknown>) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: update,
    });
  }

  /** Push a session name update to all connected browsers for a session. */
  broadcastNameUpdate(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, { type: "session_name_update", name });
  }

  /** Derive current session status from existing state (no extra field needed). */
  private deriveSessionStatus(session: Session): string | null {
    if (session.state.is_compacting) return "compacting";
    const hasBackend = !!(session.cliSocket || session.codexAdapter);
    if (!hasBackend) return null;
    // If last history message is assistant or user_message (no result after it),
    // the session is running — either the CLI is generating or processing the request.
    const last = session.messageHistory[session.messageHistory.length - 1];
    if (last?.type === "assistant" || last?.type === "user_message") return "running";
    return "idle";
  }

  /** Send authoritative state snapshot to a single browser after subscribe replay. */
  private sendStateSnapshot(session: Session, ws: ServerWebSocket<SocketData>): void {
    this.sendToBrowser(ws, {
      type: "state_snapshot",
      sessionStatus: this.deriveSessionStatus(session),
      permissionMode: session.state.permissionMode,
      cliConnected: !!(session.cliSocket || session.codexAdapter),
      uiMode: session.state.uiMode ?? null,
      askPermission: session.state.askPermission ?? true,
    });
  }

  private shouldBufferForReplay(msg: BrowserIncomingMessage): msg is ReplayableBrowserIncomingMessage {
    return msg.type !== "session_init"
      && msg.type !== "message_history"
      && msg.type !== "event_replay";
  }

  private isHistoryBackedEvent(msg: ReplayableBrowserIncomingMessage): boolean {
    return msg.type === "assistant"
      || msg.type === "result"
      || msg.type === "user_message"
      || msg.type === "error"
      || msg.type === "tool_result_preview"
      || msg.type === "permission_denied"
      || msg.type === "permission_approved"
      || msg.type === "compact_boundary"
      || msg.type === "compact_summary"
      || msg.type === "compact_marker";
  }

  private sequenceEvent(
    session: Session,
    msg: BrowserIncomingMessage,
  ): BrowserIncomingMessage {
    const seq = session.nextEventSeq++;
    const sequenced = { ...msg, seq };
    if (this.shouldBufferForReplay(msg)) {
      session.eventBuffer.push({ seq, message: msg });
      if (session.eventBuffer.length > WsBridge.EVENT_BUFFER_LIMIT) {
        session.eventBuffer.splice(0, session.eventBuffer.length - WsBridge.EVENT_BUFFER_LIMIT);
      }
      this.persistSession(session);
    }
    return sequenced;
  }

  private broadcastToBrowsers(session: Session, msg: BrowserIncomingMessage) {
    // Debug: warn when assistant messages are broadcast to 0 browsers (they may be lost)
    if (session.browserSockets.size === 0 && (msg.type === "assistant" || msg.type === "stream_event" || msg.type === "result")) {
      console.log(`[ws-bridge] ⚠ Broadcasting ${msg.type} to 0 browsers for session ${session.id} (stored in history: ${msg.type === "assistant" || msg.type === "result"})`);
    }
    const json = JSON.stringify(this.sequenceEvent(session, msg));

    // Record raw outgoing browser message
    this.recorder?.record(session.id, "out", json, "browser", session.backendType, session.state.cwd);

    for (const ws of session.browserSockets) {
      try {
        ws.send(json);
      } catch {
        session.browserSockets.delete(ws);
      }
    }
  }

  private sendToBrowser(ws: ServerWebSocket<SocketData>, msg: BrowserIncomingMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Socket will be cleaned up on close
    }
  }
}
