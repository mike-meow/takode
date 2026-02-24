import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execPromise = promisify(execCb);

/** Timeout (ms) for git shell commands. Generous default for large repos on NFS. */
export const GIT_CMD_TIMEOUT = Number(process.env.COMPANION_GIT_TIMEOUT) || 60_000;
import { resolve, basename } from "node:path";
import { homedir } from "node:os";
import type { PushoverNotifier } from "./pushover.js";
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
  CLIControlCancelRequestMessage,
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
  SessionTaskEntry,
} from "./session-types.js";
import { TOOL_RESULT_PREVIEW_LIMIT } from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import type { CodexAdapter } from "./codex-adapter.js";
import type { RecorderManager } from "./recorder.js";
import type { ImageStore } from "./image-store.js";
import type { CliLauncher } from "./cli-launcher.js";
import * as gitUtils from "./git-utils.js";
import { sessionTag } from "./session-tag.js";
import { shouldAttemptAutoApproval, evaluatePermission, type RecentToolCall } from "./auto-approver.js";

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

/** Tools that require user interaction — must NEVER be auto-approved regardless of permission mode.
 *  These tools collect user input (answers, plan approval) that cannot be synthesized by the server. */
const NEVER_AUTO_APPROVE: ReadonlySet<string> = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** Tools whose approvals appear as chat messages (same set — interactive tools need visible records). */
const NOTABLE_APPROVALS = NEVER_AUTO_APPROVE;

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
  /** Wall-clock start times for tool calls (tool_use_id → Date.now()). Transient, not persisted. */
  toolStartTimes: Map<string, number>;
  /** Whether the CLI is actively generating a response (transient, not persisted) */
  isGenerating: boolean;
  /** When isGenerating became true (epoch ms), for stuck detection + timer restore */
  generationStartedAt: number | null;
  /** Last message received from CLI (epoch ms), for stuck detection */
  lastCliMessageAt: number;
  /** When stuck notification was sent (epoch ms), to avoid repeated notifications */
  stuckNotifiedAt: number | null;
  /** Server-side activity preview (mirrors browser's sessionTaskPreview) */
  lastActivityPreview?: string;
  /** Epoch ms when the user last viewed this session (server-authoritative) */
  lastReadAt: number;
  /** Current attention reason: why this session needs the user's attention */
  attentionReason: "action" | "error" | "review" | null;
  /** High-level task history recognized by the session auto-namer */
  taskHistory: SessionTaskEntry[];
  /** Accumulated search keywords from the session auto-namer */
  keywords: string[];
  /** Whether agent activity has occurred since the last diff computation */
  diffStatsDirty: boolean;
  /** Whether this session was created by resuming an external CLI session (VS Code/terminal) */
  resumedFromExternal?: boolean;
  /** AbortControllers for in-flight LLM auto-approval evaluations, keyed by request_id.
   *  Used to cancel the LLM subprocess when the user responds manually. Transient — not persisted. */
  evaluatingAborts: Map<string, AbortController>;
}

type GitSessionKey = "git_branch" | "is_worktree" | "is_containerized" | "repo_root" | "git_ahead" | "git_behind" | "total_lines_added" | "total_lines_removed";

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
    git_default_branch: "",
    diff_base_branch: "",
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

async function resolveGitInfo(state: SessionState): Promise<void> {
  if (!state.cwd) return;
  // Preserve is_containerized — it's set during session launch, not derived from git
  const wasContainerized = state.is_containerized;
  try {
    const { stdout: branchOut } = await execPromise("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
      cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT,
    });
    state.git_branch = branchOut.trim();

    // Detect if this is a linked worktree
    try {
      const { stdout: gitDirOut } = await execPromise("git rev-parse --git-dir 2>/dev/null", {
        cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT,
      });
      state.is_worktree = gitDirOut.trim().includes("/worktrees/");
    } catch {
      state.is_worktree = false;
    }

    try {
      // For worktrees, --show-toplevel gives the worktree root, not the main repo.
      // Use --git-common-dir to find the real repo root.
      if (state.is_worktree) {
        const { stdout: commonDirOut } = await execPromise("git rev-parse --git-common-dir 2>/dev/null", {
          cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT,
        });
        // commonDir is e.g. /path/to/repo/.git — parent is the repo root
        state.repo_root = resolve(state.cwd, commonDirOut.trim(), "..");
      } else {
        const { stdout: toplevelOut } = await execPromise("git rev-parse --show-toplevel 2>/dev/null", {
          cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT,
        });
        state.repo_root = toplevelOut.trim();
      }
    } catch { /* ignore */ }

    // Set diff_base_branch if not already set (first time or restored session).
    // This is the single source of truth for all ahead/behind and diff computations.
    if (!state.diff_base_branch && state.git_branch) {
      state.diff_base_branch = await gitUtils.resolveDefaultBranchAsync(state.repo_root || state.cwd, state.git_branch);
    }

    // Compute ahead/behind using diff_base_branch as the reference point.
    // Fall back to git_default_branch when diff_base_branch is "" (user selected "default").
    const ref = state.diff_base_branch || state.git_default_branch;
    if (ref) {
      try {
        const { stdout: countsOut } = await execPromise(
          `git rev-list --left-right --count ${ref}...HEAD 2>/dev/null`,
          { cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT },
        );
        const [behind, ahead] = countsOut.trim().split(/\s+/).map(Number);
        state.git_ahead = ahead || 0;
        state.git_behind = behind || 0;
      } catch {
        state.git_ahead = 0;
        state.git_behind = 0;
      }
    } else {
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
  private pushoverNotifier: PushoverNotifier | null = null;
  private launcher: CliLauncher | null = null;
  private onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null = null;
  private onCLIRelaunchNeeded: ((sessionId: string) => void) | null = null;
  private onPermissionModeChanged: ((sessionId: string, newMode: string) => void) | null = null;
  private onUserMessage: ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string, wasGenerating: boolean) => void) | null = null;
  private onTurnCompleted: ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void) | null = null;
  private onAgentPaused: ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void) | null = null;
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
    "total_lines_added",
    "total_lines_removed",
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

  /** Register a callback for when a user message is received (for auto-naming).
   *  wasGenerating indicates whether the agent was already generating before this user message. */
  onUserMessageCallback(cb: (sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string, wasGenerating: boolean) => void): void {
    this.onUserMessage = cb;
  }

  /** Register a callback for when the agent finishes a turn (result message received, for auto-naming). */
  onTurnCompletedCallback(cb: (sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void): void {
    this.onTurnCompleted = cb;
  }

  /** Register a callback for when the agent pauses for user input (ExitPlanMode, for auto-naming). */
  onAgentPausedCallback(cb: (sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void): void {
    this.onAgentPaused = cb;
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
   * Mark a session as resumed from an external CLI session (VS Code/terminal).
   * This enables extraction of user prompts from CLI replay messages.
   */
  markResumedFromExternal(sessionId: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.resumedFromExternal = true;
  }

  /**
   * Pre-populate a session with worktree info so the browser gets the correct
   * repo_root for sidebar grouping immediately, before the CLI connects.
   * Call this right after launcher.launch() for worktree sessions.
   */
  markWorktree(sessionId: string, repoRoot: string, worktreeCwd: string, defaultBranch?: string, diffBaseBranch?: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.state.is_worktree = true;
    session.state.repo_root = repoRoot;
    session.state.cwd = worktreeCwd;
    if (defaultBranch) {
      session.state.git_default_branch = defaultBranch;
    }
    // Set diff_base_branch: prefer explicit parent branch, fall back to defaultBranch
    const diffBase = diffBaseBranch || defaultBranch;
    if (diffBase && !session.state.diff_base_branch) {
      session.state.diff_base_branch = diffBase;
    }
  }

  setDiffBaseBranch(sessionId: string, branch: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.state.diff_base_branch = branch;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { diff_base_branch: branch },
    });
    // Recompute ahead/behind with new base, then recompute diff stats.
    // Chained so git_default_branch is fresh when diff falls back to it (user selected "default").
    session.diffStatsDirty = true;
    void this.refreshGitInfo(session, { broadcastUpdate: true }).then(() => {
      this.recomputeDiffIfDirty(session);
    });
    this.persistSession(session);
    return true;
  }

  /**
   * Set cwd on a session at creation time so the slash command cache lookup
   * works before the CLI sends system/init (which only arrives after the first
   * user message). Also pre-fills slash commands from the per-project cache.
   */
  setInitialCwd(sessionId: string, cwd: string): void {
    const session = this.getOrCreateSession(sessionId);
    if (cwd && !session.state.cwd) {
      session.state.cwd = cwd;
    }
    this.prefillSlashCommands(session);
  }

  /** Fill slash_commands/skills from the per-project cache if not yet populated. */
  private prefillSlashCommands(session: Session): void {
    if (session.state.slash_commands?.length && session.state.skills?.length) return;
    const projectKey = session.state.repo_root || session.state.cwd;
    const cached = projectKey ? this.slashCommandCache.get(projectKey) : undefined;
    if (cached) {
      if (!session.state.slash_commands?.length) session.state.slash_commands = cached.slash_commands;
      if (!session.state.skills?.length) session.state.skills = cached.skills;
    }
  }

  /**
   * When the slash command cache is populated for a project, push the commands
   * to all other sessions with the same project key that still have empty
   * slash_commands/skills, so already-connected browsers get them immediately.
   */
  private backfillSlashCommands(projectKey: string, sourceSessionId: string): void {
    const cached = this.slashCommandCache.get(projectKey);
    if (!cached) return;
    for (const [id, session] of this.sessions) {
      if (id === sourceSessionId) continue;
      const key = session.state.repo_root || session.state.cwd;
      if (key !== projectKey) continue;
      let changed = false;
      if (!session.state.slash_commands?.length && cached.slash_commands.length) {
        session.state.slash_commands = cached.slash_commands;
        changed = true;
      }
      if (!session.state.skills?.length && cached.skills.length) {
        session.state.skills = cached.skills;
        changed = true;
      }
      if (changed && session.browserSockets.size > 0) {
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: session.state,
        });
      }
    }
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

  /** Periodically check for sessions stuck in "generating" state with no CLI activity. */
  startStuckSessionWatchdog(): void {
    const STUCK_THRESHOLD_MS = 120_000; // 2 minutes
    const CHECK_INTERVAL_MS = 30_000;   // check every 30s

    const timer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (!session.isGenerating || !session.generationStartedAt) continue;
        if (session.stuckNotifiedAt) continue; // already notified

        const elapsed = Date.now() - session.generationStartedAt;
        if (elapsed < STUCK_THRESHOLD_MS) continue;

        // If CLI sent a message after generation started, it's still active
        if (session.lastCliMessageAt > session.generationStartedAt) continue;

        session.stuckNotifiedAt = Date.now();
        console.warn(`[ws-bridge] Session ${session.id} appears stuck (${Math.round(elapsed / 1000)}s, no CLI response)`);
        this.recorder?.recordServerEvent(session.id, "stuck_detected", { elapsed }, session.backendType, session.state.cwd);
        this.broadcastToBrowsers(session, { type: "session_stuck" } as BrowserIncomingMessage);
      }
    }, CHECK_INTERVAL_MS);
    if (timer.unref) timer.unref();
  }

  /** Push a message to all connected browsers for a session (public, for PRPoller etc.). */
  broadcastToSession(sessionId: string, msg: BrowserIncomingMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.broadcastToBrowsers(session, msg);
  }

  /** Push a message to all connected browsers across ALL sessions. */
  broadcastGlobal(msg: BrowserIncomingMessage): void {
    for (const session of this.sessions.values()) {
      this.broadcastToBrowsers(session, msg);
    }
  }

  /** Update the claimed quest for a session and broadcast to its browsers. */
  setSessionClaimedQuest(
    sessionId: string,
    quest: { id: string; title: string; status?: string } | null,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.log(`[ws-bridge] setSessionClaimedQuest: session ${sessionId} not found`);
      return;
    }
    console.log(`[ws-bridge] setSessionClaimedQuest: quest=${quest?.id ?? "null"} title="${quest?.title ?? ""}" status=${quest?.status ?? "null"} browsers=${session.browserSockets.size} session=${sessionId}`);
    session.state.claimedQuestId = quest?.id;
    session.state.claimedQuestTitle = quest?.title;
    session.state.claimedQuestStatus = quest?.status;
    this.broadcastToBrowsers(session, {
      type: "session_quest_claimed",
      quest,
    } as BrowserIncomingMessage);
    this.persistSession(session);
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

  setPushoverNotifier(notifier: PushoverNotifier): void {
    this.pushoverNotifier = notifier;
  }

  /** Attach the CLI launcher for activity tracking. */
  setLauncher(launcher: CliLauncher): void {
    this.launcher = launcher;
  }

  /** Check if a session is actively generating or has pending permission requests. */
  isSessionBusy(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    return s.isGenerating || s.pendingPermissions.size > 0;
  }

  /** Restore sessions from disk (call once at startup). */
  async restoreFromDisk(): Promise<number> {
    if (!this.store) return 0;
    const persisted = await this.store.loadAll();
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
        toolStartTimes: new Map(),
        isGenerating: false,
        generationStartedAt: null,
        lastCliMessageAt: 0,
        stuckNotifiedAt: null,
        lastReadAt: typeof p.lastReadAt === "number" ? p.lastReadAt : 0,
        attentionReason: p.attentionReason ?? null,
        taskHistory: Array.isArray(p.taskHistory) ? p.taskHistory : [],
        keywords: Array.isArray(p.keywords) ? p.keywords : [],
        diffStatsDirty: true,
        evaluatingAborts: new Map(),
      };
      session.state.backend_type = session.backendType;

      // Recover from server restart: any permissions left in "evaluating" state
      // have no running LLM subprocess. Transition them to normal pending.
      for (const perm of session.pendingPermissions.values()) {
        if (perm.evaluating) {
          perm.evaluating = false;
        }
      }

      // Git info resolves lazily on first CLI/browser connect — skipping here
      // eliminates hundreds of blocking git calls at startup on NFS.
      this.sessions.set(p.id, session);
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
      lastReadAt: session.lastReadAt,
      attentionReason: session.attentionReason,
      taskHistory: session.taskHistory,
      keywords: session.keywords,
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
      lastReadAt: session.lastReadAt,
      attentionReason: session.attentionReason,
      taskHistory: session.taskHistory,
      keywords: session.keywords,
    });
  }

  private async refreshGitInfo(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): Promise<void> {
    const before: Record<string, unknown> = {};
    for (const key of WsBridge.GIT_SESSION_KEYS) {
      before[key] = session.state[key];
    }

    await resolveGitInfo(session.state);

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

  /** Tools that cannot modify the filesystem — any other tool marks diff stats dirty. */
  private static readonly READ_ONLY_TOOLS = new Set([
    "Read", "Grep", "Glob", "WebFetch", "WebSearch",
    "TodoWrite", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
    "TaskOutput", "TaskStop",
  ]);

  /**
   * Recompute diff stats only if agent activity has occurred since the last computation.
   * Broadcasts updated stats to all browsers if recomputed.
   */
  recomputeDiffIfDirty(session: Session): void {
    if (!session.diffStatsDirty) return;
    this.computeDiffStatsAsync(session).then((didRun) => {
      if (!didRun) return;
      session.diffStatsDirty = false;
      // Only broadcast diff stats — git info fields are broadcast by refreshGitInfo
      this.broadcastToBrowsers(session, {
        type: "session_update",
        session: {
          total_lines_added: session.state.total_lines_added,
          total_lines_removed: session.state.total_lines_removed,
        },
      });
      this.persistSession(session);
    }).catch(() => { /* git not available */ });
  }

  /**
   * Compute diff stats (total lines added/removed) by running `git diff --numstat`
   * against the session's diff_base_branch (or git_default_branch as fallback).
   * Diffs the entire repo — git tracks what changed, no need to scope by file list.
   * Runs asynchronously via child_process.exec to avoid blocking the event loop on NFS.
   */
  private async computeDiffStatsAsync(session: Session): Promise<boolean> {
    const cwd = session.state.cwd;
    // Fall back to git_default_branch when diff_base_branch is "" (user selected "default")
    const ref = session.state.diff_base_branch || session.state.git_default_branch;
    if (!cwd || !ref) return false;

    try {
      // Compute merge-base to diff against (async).
      // Skip merge-base for commit SHAs — diff directly against the exact commit.
      let diffBase = ref;
      if (!/^[0-9a-f]{7,40}$/.test(ref)) {
        try {
          const { stdout } = await execPromise(`git merge-base ${ref} HEAD`, { cwd, timeout: GIT_CMD_TIMEOUT });
          const mergeBase = stdout.trim();
          if (mergeBase) diffBase = mergeBase;
        } catch { /* no common ancestor — use branch name directly */ }
      }

      const cmd = `git diff --numstat ${diffBase}`;
      // Generous timeout — large repos on NFS can be slow, and this runs in the background
      const { stdout } = await execPromise(cmd, { cwd, timeout: GIT_CMD_TIMEOUT });
      const raw = stdout.trim();

      let added = 0;
      let removed = 0;
      if (raw) {
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          const [addStr, delStr] = line.split("\t");
          // Binary files show "-" for both fields
          if (addStr !== "-") added += parseInt(addStr, 10) || 0;
          if (delStr !== "-") removed += parseInt(delStr, 10) || 0;
        }
      }

      session.state.total_lines_added = added;
      session.state.total_lines_removed = removed;
      return true;
    } catch {
      // git not available or not a git repo — leave values unchanged
      return false;
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
        toolStartTimes: new Map(),
        isGenerating: false,
        generationStartedAt: null,
        lastCliMessageAt: 0,
        stuckNotifiedAt: null,
        lastReadAt: 0,
        attentionReason: null,
        taskHistory: [],
        keywords: [],
        diffStatsDirty: true,
        evaluatingAborts: new Map(),
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

  // ─── Attention state (server-authoritative read/unread) ───────────────────

  private static readonly ATTENTION_PRIORITY: Record<string, number> = { action: 3, error: 2, review: 1 };

  /** Upgrade attention (never downgrade). Broadcasts + persists. */
  private setAttention(session: Session, reason: "action" | "error" | "review"): void {
    const current = session.attentionReason;
    const pri = WsBridge.ATTENTION_PRIORITY;
    if (current && pri[current] >= pri[reason]) return; // already equal or higher
    session.attentionReason = reason;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { attentionReason: session.attentionReason },
    });
    this.persistSession(session);
  }

  /** Clear attention, set lastReadAt, broadcast + persist. */
  private clearAttentionAndMarkRead(session: Session): void {
    if (session.attentionReason === null) return;
    session.attentionReason = null;
    session.lastReadAt = Date.now();
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { attentionReason: null, lastReadAt: session.lastReadAt },
    });
    this.persistSession(session);
  }

  /** Downgrade "action" attention to null when all pending permissions are resolved. */
  private clearActionAttentionIfNoPermissions(session: Session): void {
    if (session.pendingPermissions.size === 0 && session.attentionReason === "action") {
      session.attentionReason = null;
      this.broadcastToBrowsers(session, { type: "session_update", session: { attentionReason: null } });
      this.persistSession(session);
    }
  }

  /** Mark a session as read by the user. Returns false if session not found. */
  markSessionRead(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.clearAttentionAndMarkRead(session);
    return true;
  }

  /** Mark all sessions as read. */
  markAllSessionsRead(): void {
    for (const session of this.sessions.values()) {
      this.clearAttentionAndMarkRead(session);
    }
  }

  /** Mark a session as unread (user-initiated). Returns false if session not found. */
  markSessionUnread(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.attentionReason = "review";
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { attentionReason: "review" },
    });
    this.persistSession(session);
    return true;
  }

  /** Get attention state for a session (used by REST enrichment and Pushover). */
  getSessionAttentionState(sessionId: string): { lastReadAt: number; attentionReason: "action" | "error" | "review" | null } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return { lastReadAt: session.lastReadAt, attentionReason: session.attentionReason };
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

  getSessionActivityPreview(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.lastActivityPreview;
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
      // Track Codex CLI activity for idle management and stuck detection
      this.launcher?.touchActivity(session.id);
      session.lastCliMessageAt = Date.now();

      if (msg.type === "session_init") {
        session.state = { ...session.state, ...msg.session, backend_type: "codex" };
        void this.refreshGitInfo(session, { notifyPoller: true });
        this.persistSession(session);
      } else if (msg.type === "session_update") {
        session.state = { ...session.state, ...msg.session, backend_type: "codex" };
        void this.refreshGitInfo(session, { notifyPoller: true });
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
        // Route through the unified result handler so Codex gets the same
        // post-turn state refresh (git + diff stats + attention) as Claude.
        this.handleResultMessage(session, msg.data);
        return;
      }

      // Diagnostic: log tool_use assistant messages
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content;
        const hasToolUse = content?.some((b) => b.type === "tool_use");
        if (hasToolUse) {
          console.log(`[ws-bridge] Broadcasting tool_use assistant to ${session.browserSockets.size} browser(s) for session ${sessionTag(session.id)}`);
        }
      }

      // Handle permission requests
      if (msg.type === "permission_request") {
        session.pendingPermissions.set(msg.request.request_id, msg.request);
        this.persistSession(session);
      }

      this.broadcastToBrowsers(session, msg);
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
      void this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
      this.persistSession(session);
    });

    // Handle disconnect
    adapter.onDisconnect(() => {
      const wasGenerating = session.isGenerating;
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      session.pendingPermissions.clear();
      session.codexAdapter = null;
      this.setGenerating(session, false, "codex_disconnect");
      this.persistSession(session);
      const idleKilled = this.launcher?.getSession(sessionId)?.killedByIdleManager;
      console.log(`[ws-bridge] Codex adapter disconnected for session ${sessionTag(sessionId)}${idleKilled ? " (idle limit)" : ""}`);
      this.broadcastToBrowsers(session, {
        type: "cli_disconnected",
        ...(idleKilled ? { reason: "idle_limit" as const } : {}),
      });
      if (wasGenerating && !idleKilled) {
        this.setAttention(session, "error");
      }
    });

    // Flush any messages queued while waiting for the adapter
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) to Codex adapter for session ${sessionTag(sessionId)}`);
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
    console.log(`[ws-bridge] Codex adapter attached for session ${sessionTag(sessionId)}`);
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    session.cliSocket = ws;
    console.log(`[ws-bridge] CLI connected for session ${sessionTag(sessionId)}`);
    this.broadcastToBrowsers(session, { type: "cli_connected" });

    // Flush any messages queued while waiting for the CLI WebSocket.
    // Per the SDK protocol, the first user message triggers system.init,
    // so we must send it as soon as the WebSocket is open — NOT wait for
    // system.init (which would create a deadlock for slow-starting sessions
    // like Docker containers where the user message arrives before CLI connects).
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) on CLI connect for session ${sessionTag(sessionId)}`);
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

    const wasGenerating = session.isGenerating;
    session.cliSocket = null;
    this.setGenerating(session, false, "cli_disconnect");
    const idleKilled = this.launcher?.getSession(sessionId)?.killedByIdleManager;
    console.log(`[ws-bridge] CLI disconnected for session ${sessionTag(sessionId)}${idleKilled ? " (idle limit)" : ""}`);
    this.broadcastToBrowsers(session, {
      type: "cli_disconnected",
      ...(idleKilled ? { reason: "idle_limit" as const } : {}),
    });
    // Immediately tell browsers to stop showing "Purring..." — without this,
    // the browser stays in a stale "running" state until a full reconnect.
    this.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
    // Only set error attention on unexpected disconnects (mid-generation crash),
    // not on clean shutdown after a result message or idle kill
    if (wasGenerating && !idleKilled) {
      this.setAttention(session, "error");
    }

    // Cancel any pending permission requests
    for (const [reqId] of session.pendingPermissions) {
      this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
    }
    session.pendingPermissions.clear();
    session.assistantAccumulator.clear();
    // Flush cleared permissions to disk so they don't survive a server restart
    this.persistSession(session);
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    const browserData = ws.data as BrowserSocketData;
    browserData.subscribed = false;
    browserData.lastAckSeq = 0;
    session.browserSockets.add(ws);
    console.log(`[ws-bridge] Browser connected for session ${sessionTag(sessionId)} (${session.browserSockets.size} browsers)`);

    // Refresh git state on browser connect so branch changes made mid-session are reflected.
    // Chain diff recomputation after git info resolves — needs git_default_branch populated.
    void this.refreshGitInfo(session, { notifyPoller: true }).then(() => {
      this.recomputeDiffIfDirty(session);
    });

    // Send current session state as snapshot (includes nextEventSeq for stale seq detection).
    // If slash_commands/skills haven't arrived yet (CLI sends them only after the first
    // user message), fill from the per-project cache so autocomplete works immediately.
    this.prefillSlashCommands(session);
    const snapshot: BrowserIncomingMessage = {
      type: "session_init",
      session: session.state,
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
      const idleKilled = this.launcher?.getSession(sessionId)?.killedByIdleManager;
      this.sendToBrowser(ws, {
        type: "cli_disconnected",
        ...(idleKilled ? { reason: "idle_limit" as const } : {}),
      });
      if (this.onCLIRelaunchNeeded) {
        console.log(`[ws-bridge] Browser connected but backend is dead for session ${sessionTag(sessionId)}, requesting relaunch`);
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
    console.log(`[ws-bridge] Browser disconnected for session ${sessionTag(sessionId)} (${session.browserSockets.size} remaining, backend=${hasBackend ? "alive" : "dead"})`);
  }

  // ── CLI message routing ─────────────────────────────────────────────────

  private routeCLIMessage(session: Session, msg: CLIMessage) {
    // Track CLI activity for idle management and stuck detection.
    // Exclude keep_alive pings — they fire periodically on idle sessions and
    // would make them appear "recently active", preventing the idle manager
    // from reclaiming them in favor of sessions with real user activity.
    if (msg.type !== "keep_alive") {
      this.launcher?.touchActivity(session.id);
      session.lastCliMessageAt = Date.now();
    }

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

      case "control_cancel_request":
        this.handleControlCancelRequest(session, msg);
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
        // Extract user prompt text/images from CLI messages during --resume replay
        // of external sessions (VS Code/terminal). Only for external resume sessions —
        // Companion-originated sessions already capture user messages from the browser.
        if (session.resumedFromExternal) {
          this.extractUserPromptFromCLI(session, msg as CLIUserMessage);
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
        // Push to other sessions in the same project that don't have commands yet
        this.backfillSlashCommands(projectKey, session.id);
      }

      // Resolve and publish git info
      void this.refreshGitInfo(session, { notifyPoller: true });

      this.broadcastToBrowsers(session, {
        type: "session_init",
        session: session.state,
      });
      this.persistSession(session);

      // Flush any messages queued before CLI was initialized (e.g. user sent
      // a message while the container was still starting up).
      if (session.pendingMessages.length > 0) {
        console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) after init for session ${sessionTag(session.id)}`);
        const queued = session.pendingMessages.splice(0);
        for (const ndjson of queued) {
          this.sendToCLI(session, ndjson);
        }
      }
    } else if (msg.subtype === "status") {
      session.state.is_compacting = msg.status === "compacting";
      // Compaction pauses generation; clear the flag so deriveSessionStatus is accurate
      if (msg.status === "compacting") {
        this.setGenerating(session, false, "compaction");
      }

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
      const cliUuid = (msg as CLISystemCompactBoundaryMessage).uuid;
      const meta = (msg as CLISystemCompactBoundaryMessage).compact_metadata;

      // Dedup: CLI replays compact_boundary on --resume. Skip if a marker with
      // the same CLI uuid already exists in history (replay after server restart).
      const alreadyExists = cliUuid && session.messageHistory.some(
        (m) => m.type === "compact_marker" && (m as { cliUuid?: string }).cliUuid === cliUuid,
      );
      if (alreadyExists) return;

      const ts = Date.now();
      session.messageHistory.push({
        type: "compact_marker" as const,
        timestamp: ts,
        id: `compact-boundary-${ts}`,
        cliUuid,
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
      // No accumulator — either first time seeing this message, or a replay
      // after server restart (accumulators are in-memory only).
      const alreadyInHistory = session.messageHistory.some(
        (m) => m.type === "assistant" && (m as { message?: { id?: string } }).message?.id === msgId,
      );
      if (alreadyInHistory) return;

      {
        // Truly first occurrence — store and broadcast
        const contentBlockIds = new Set<string>();
        const now = Date.now();
        const toolStartTimesMap: Record<string, number> = {};
        for (const block of msg.message.content) {
          if (block.type === "tool_use" && block.id) {
            contentBlockIds.add(block.id);
            if (!session.toolStartTimes.has(block.id)) {
              session.toolStartTimes.set(block.id, now);
            }
            toolStartTimesMap[block.id] = session.toolStartTimes.get(block.id)!;
          }
        }

        const browserMsg: BrowserIncomingMessage = {
          type: "assistant",
          message: { ...msg.message, content: [...msg.message.content] },
          parent_tool_use_id: msg.parent_tool_use_id,
          timestamp: Date.now(),
          uuid: msg.uuid,
          ...(Object.keys(toolStartTimesMap).length > 0 ? { tool_start_times: toolStartTimesMap } : {}),
        };

        session.assistantAccumulator.set(msgId, { contentBlockIds });
        session.messageHistory.push(browserMsg);
        this.broadcastToBrowsers(session, browserMsg);
      }
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
          if (!session.toolStartTimes.has(block.id)) {
            session.toolStartTimes.set(block.id, Date.now());
          }
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

      // Collect tool start times for all tool_use blocks in the accumulated message
      const allToolStartTimes: Record<string, number> = {};
      for (const block of historyEntry.message.content) {
        if (block.type === "tool_use" && block.id && session.toolStartTimes.has(block.id)) {
          allToolStartTimes[block.id] = session.toolStartTimes.get(block.id)!;
        }
      }

      // Re-broadcast the full accumulated message with tool start times
      const rebroadcast: BrowserIncomingMessage = {
        ...(historyEntry as BrowserIncomingMessage),
        ...(Object.keys(allToolStartTimes).length > 0 ? { tool_start_times: allToolStartTimes } : {}),
      };
      this.broadcastToBrowsers(session, rebroadcast);
    }

    // NOTE: we intentionally do NOT delete the accumulator on stop_reason.
    // The CLI may send the same message ID in multiple parts (e.g. [text] first,
    // then [tool_use] second, both with stop_reason: tool_use). Keeping the
    // accumulator alive lets part 2 hit the normal merge path above. The
    // accumulator is in-memory only, so it naturally resets on server restart —
    // replayed messages from CLI reconnect will be correctly skipped via the
    // alreadyInHistory check.

    // Extract activity preview from TodoWrite/TaskUpdate tool calls
    // (mirrors browser-side extractTaskItemsFromToolUse in ws.ts)
    this.extractActivityPreview(session, msg.message.content);

    // Mark diff stats dirty when non-read-only tools are used (any tool that could modify files)
    if (Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type !== "tool_use") continue;
        const name = (block as { name?: string }).name ?? "";
        if (!WsBridge.READ_ONLY_TOOLS.has(name)) {
          session.diffStatsDirty = true;
          break; // One dirty tool is enough
        }
      }
    }

    this.persistSession(session);
  }

  /**
   * Extract the current activity preview from TodoWrite/TaskUpdate tool_use blocks.
   * Mirrors browser-side logic in ws.ts extractTaskItemsFromToolUse — but only
   * extracts the in_progress task's activeForm text for push notification context.
   */
  private extractActivityPreview(session: Session, content: unknown[]): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
      if (b.type !== "tool_use") continue;

      if (b.name === "TodoWrite") {
        const todos = b.input?.todos as { status?: string; activeForm?: string; content?: string }[] | undefined;
        if (Array.isArray(todos)) {
          const active = todos.find((t) => t.status === "in_progress");
          session.lastActivityPreview = active
            ? (active.activeForm || active.content || "").slice(0, 80)
            : undefined;
        }
      } else if (b.name === "TaskUpdate") {
        const status = b.input?.status as string | undefined;
        const activeForm = b.input?.activeForm as string | undefined;
        if (status === "in_progress" && activeForm) {
          session.lastActivityPreview = activeForm.slice(0, 80);
        }
      }
    }
  }

  private handleResultMessage(session: Session, msg: CLIResultMessage) {
    // Dedup: CLI replays result messages on --resume. Skip if already in history
    // to avoid re-triggering attention/notifications for old completions.
    if (msg.uuid) {
      const alreadyInHistory = session.messageHistory.some(
        (m) => m.type === "result" && (m as { data?: { uuid?: string } }).data?.uuid === msg.uuid,
      );
      if (alreadyInHistory) return;
    }

    // Update session cost/turns
    session.state.total_cost_usd = msg.total_cost_usd;
    session.state.num_turns = msg.num_turns;

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

    // Re-check git state after each turn (session idle), then recompute diff stats.
    // Chained so git_default_branch is populated before diff computation.
    session.diffStatsDirty = true;
    void this.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true }).then(() => {
      this.recomputeDiffIfDirty(session);
    });

    // Broadcast updated metrics to all browsers
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: {
        total_cost_usd: session.state.total_cost_usd,
        num_turns: session.state.num_turns,
        context_used_percent: session.state.context_used_percent,
      },
    });

    this.setGenerating(session, false, "result");

    // Safety net: clear any stale pending permissions when a turn completes.
    // A completed turn means the CLI has no outstanding tool calls, so any
    // leftover pendingPermissions are stale (e.g. cancelled by hooks that the
    // server missed, or race conditions during interrupts).
    if (session.pendingPermissions.size > 0) {
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
        this.pushoverNotifier?.cancelPermission(session.id, reqId);
      }
      console.log(`[ws-bridge] Cleared ${session.pendingPermissions.size} stale pending permission(s) on result for session ${sessionTag(session.id)}`);
      session.pendingPermissions.clear();
    }

    const browserMsg: BrowserIncomingMessage = {
      type: "result",
      data: msg,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);

    // Set attention state for the completed/errored session
    this.setAttention(session, msg.is_error ? "error" : "review");

    // Schedule Pushover notification for session completion/error
    if (this.pushoverNotifier) {
      if (msg.is_error) {
        this.pushoverNotifier.scheduleNotification(session.id, "error", typeof msg.result === "string" ? msg.result.slice(0, 100) : "Error");
      } else {
        this.pushoverNotifier.scheduleNotification(session.id, "completed");
      }
    }

    // Trigger auto-naming re-evaluation after turn completion (async, fire-and-forget)
    if (this.onTurnCompleted) {
      this.onTurnCompleted(session.id, [...session.messageHistory], session.state.cwd);
    }

  }

  private handleStreamEvent(session: Session, msg: CLIStreamEventMessage) {
    this.broadcastToBrowsers(session, {
      type: "stream_event",
      event: msg.event,
      parent_tool_use_id: msg.parent_tool_use_id,
    });
  }

  /**
   * Check if a file path targets a Claude Code / Companion config location.
   * Edits to these files should always require explicit user approval in
   * acceptEdits mode since they control the agent's own behavior.
   */
  private static isSensitiveConfigPath(filePath: string): boolean {
    if (!filePath) return false;
    const name = basename(filePath);
    // CLAUDE.md anywhere — project root, parent dirs, .claude/, ~/.claude/
    if (name === "CLAUDE.md") return true;
    // MCP server configs
    if (name === ".mcp.json" || name === ".claude.json") return true;
    // Settings / credentials inside .claude/
    if (filePath.includes("/.claude/")) {
      if (name === "settings.json" || name === "settings.local.json" || name === ".credentials.json") return true;
      // commands/, agents/, skills/, hooks/ directories
      if (/\/\.claude\/(commands|agents|skills|hooks)\//.test(filePath)) return true;
    }
    // Companion config
    const home = homedir();
    if (filePath.startsWith(`${home}/.companion/settings.json`) ||
        filePath.startsWith(`${home}/.companion/envs/`)) {
      return true;
    }
    // ~/.claude.json (user-level MCP config at home root)
    if (filePath === `${home}/.claude.json`) return true;
    return false;
  }

  // Tools that are auto-approved in acceptEdits mode (everything except Bash).
  // In bypassPermissions mode, all tools are auto-approved EXCEPT those in NEVER_AUTO_APPROVE.
  private static readonly ACCEPT_EDITS_AUTO_APPROVE = new Set([
    "Edit", "Write", "Read", "MultiEdit", "NotebookEdit",
    "Glob", "Grep", "WebFetch", "WebSearch",
    "TodoWrite", "Task", "Skill",
  ]);

  private handleControlRequest(session: Session, msg: CLIControlRequestMessage) {
    if (msg.request.subtype === "can_use_tool") {
      const mode = session.state.permissionMode;
      const toolName = msg.request.tool_name;

      // Server-side auto-approval based on permission mode.
      // The CLI may not honor runtime set_permission_mode for out-of-project
      // files, so the server acts as the enforcement layer.
      // In acceptEdits mode, edits to sensitive config files (CLAUDE.md,
      // settings.json, hooks, etc.) still require explicit approval.
      const isFileEdit = toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit" || toolName === "NotebookEdit";
      const filePath = isFileEdit ? String(msg.request.input.file_path ?? "") : "";
      const autoApprove = !NEVER_AUTO_APPROVE.has(toolName) && (
        mode === "bypassPermissions" ||
        (mode === "acceptEdits"
          && toolName !== "Bash"
          && WsBridge.ACCEPT_EDITS_AUTO_APPROVE.has(toolName)
          && !(isFileEdit && WsBridge.isSensitiveConfigPath(filePath))));

      if (autoApprove) {
        const ndjson = JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: msg.request_id,
            response: {
              behavior: "allow",
              updatedInput: msg.request.input,
            },
          },
        });
        this.sendToCLI(session, ndjson);
        return;
      }

      // Check if LLM auto-approval is available for this session's project.
      // Only for Claude Code sessions and non-NEVER_AUTO_APPROVE tools.
      const autoApprovalConfig = (
        session.backendType === "claude" &&
        !NEVER_AUTO_APPROVE.has(toolName)
      ) ? shouldAttemptAutoApproval(
        session.state.cwd,
        session.state.repo_root ? [session.state.repo_root] : undefined,
      ) : null;

      const perm: PermissionRequest = {
        request_id: msg.request_id,
        tool_name: msg.request.tool_name,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions,
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
        timestamp: Date.now(),
        ...(autoApprovalConfig ? { evaluating: true } : {}),
      };
      session.pendingPermissions.set(msg.request_id, perm);

      this.broadcastToBrowsers(session, {
        type: "permission_request",
        request: perm,
      });

      if (autoApprovalConfig) {
        // Path A: LLM auto-approval available — show collapsed spinner in browser,
        // defer attention/notifications until LLM evaluation completes.
        this.persistSession(session);
        this.tryLlmAutoApproval(session, msg.request_id, perm);
      } else {
        // Path B: Normal flow — immediate attention + notification.
        this.setAttention(session, "action");
        this.persistSession(session);

        if (this.pushoverNotifier) {
          const eventType = toolName === "AskUserQuestion" ? "question" as const : "permission" as const;
          const detail = toolName + (perm.description ? `: ${perm.description}` : "");
          this.pushoverNotifier.scheduleNotification(session.id, eventType, detail, msg.request_id);
        }
      }

      // Trigger auto-naming when agent pauses for plan approval — the agent
      // has done meaningful work and the plan provides rich naming context.
      if (toolName === "ExitPlanMode" && this.onAgentPaused) {
        this.onAgentPaused(session.id, [...session.messageHistory], session.state.cwd);
      }
    }
  }

  /**
   * Asynchronously evaluate a permission request via LLM auto-approver.
   * Fire-and-forget: the caller does not await this. Race conditions are
   * handled by checking `session.pendingPermissions.has(requestId)` before
   * acting on the LLM result.
   */
  /** Extract the last N tool_use inputs from messageHistory (no outputs, inputs only). */
  private extractRecentToolCalls(session: Session, limit = 10): RecentToolCall[] {
    const calls: RecentToolCall[] = [];
    // Walk backwards through messageHistory to find assistant messages with tool_use blocks
    for (let i = session.messageHistory.length - 1; i >= 0 && calls.length < limit; i--) {
      const msg = session.messageHistory[i];
      if (msg.type === "assistant" && msg.message?.content) {
        const blocks = msg.message.content;
        // Iterate blocks in reverse to get most recent first
        for (let j = blocks.length - 1; j >= 0 && calls.length < limit; j--) {
          const block = blocks[j];
          if (block.type === "tool_use") {
            calls.push({
              toolName: block.name,
              input: block.input as Record<string, unknown>,
            });
          }
        }
      }
    }
    // Reverse so oldest is first (chronological order)
    return calls.reverse();
  }

  private async tryLlmAutoApproval(
    session: Session,
    requestId: string,
    perm: PermissionRequest,
  ): Promise<void> {
    const abort = new AbortController();
    session.evaluatingAborts.set(requestId, abort);

    // Collect last 10 tool call inputs for context
    const recentToolCalls = this.extractRecentToolCalls(session);

    try {
      const result = await evaluatePermission(
        session.id,
        perm.tool_name,
        perm.input,
        perm.description,
        session.state.cwd,
        abort.signal,
        recentToolCalls,
      );

      // Clean up abort controller
      session.evaluatingAborts.delete(requestId);

      // Race condition guard: user/CLI may have already handled this permission
      if (!session.pendingPermissions.has(requestId)) return;

      if (result?.decision === "approve") {
        // LLM approved — auto-approve the permission
        session.pendingPermissions.delete(requestId);
        this.pushoverNotifier?.cancelPermission(session.id, requestId);
        this.clearActionAttentionIfNoPermissions(session);

        const ndjson = JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: {
              behavior: "allow",
              updatedInput: perm.input,
            },
          },
        });
        this.sendToCLI(session, ndjson);

        this.broadcastToBrowsers(session, {
          type: "permission_auto_approved",
          request_id: requestId,
          tool_name: perm.tool_name,
          tool_use_id: perm.tool_use_id,
          reason: result.reason,
          timestamp: Date.now(),
        });

        console.log(`[auto-approver] Auto-approved ${perm.tool_name} for session ${sessionTag(session.id)}: ${result.reason}`);
        this.persistSession(session);
      } else {
        // LLM denied or failed (null) — transition to normal pending state.
        // Clear the evaluating flag so the browser shows full approval UI.
        perm.evaluating = false;

        this.broadcastToBrowsers(session, {
          type: "permission_needs_attention",
          request_id: requestId,
          timestamp: Date.now(),
        });

        // NOW set attention and schedule notifications
        this.setAttention(session, "action");
        if (this.pushoverNotifier) {
          const eventType = perm.tool_name === "AskUserQuestion" ? "question" as const : "permission" as const;
          const detail = perm.tool_name + (perm.description ? `: ${perm.description}` : "");
          this.pushoverNotifier.scheduleNotification(session.id, eventType, detail, requestId);
        }

        if (result?.decision === "deny") {
          console.log(`[auto-approver] LLM denied ${perm.tool_name} for session ${sessionTag(session.id)}: ${result.reason}`);
        } else {
          console.log(`[auto-approver] LLM evaluation failed/timed out for ${perm.tool_name} in session ${sessionTag(session.id)}, falling through to user`);
        }
        this.persistSession(session);
      }
    } catch (err) {
      session.evaluatingAborts.delete(requestId);

      // Fail-safe: if anything goes wrong, transition to normal pending
      if (session.pendingPermissions.has(requestId)) {
        perm.evaluating = false;
        this.broadcastToBrowsers(session, {
          type: "permission_needs_attention",
          request_id: requestId,
          timestamp: Date.now(),
        });
        this.setAttention(session, "action");
        this.persistSession(session);
      }
      console.warn(`[auto-approver] Error evaluating ${perm.tool_name} for session ${sessionTag(session.id)}:`, err);
    }
  }

  /** Abort any in-flight LLM auto-approval evaluation for a given request. */
  private abortAutoApproval(session: Session, requestId: string): void {
    const abort = session.evaluatingAborts.get(requestId);
    if (abort) {
      abort.abort();
      session.evaluatingAborts.delete(requestId);
    }
  }

  /** CLI cancels a pending can_use_tool it previously sent (e.g. after interrupt or hook auto-approval). */
  private handleControlCancelRequest(session: Session, msg: CLIControlCancelRequestMessage) {
    const reqId = msg.request_id;
    const pending = session.pendingPermissions.get(reqId);
    if (pending) {
      this.abortAutoApproval(session, reqId);
      session.pendingPermissions.delete(reqId);
      this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      this.pushoverNotifier?.cancelPermission(session.id, reqId);
      this.clearActionAttentionIfNoPermissions(session);
      this.persistSession(session);
      console.log(`[ws-bridge] CLI cancelled pending permission ${reqId} (${pending.tool_name}) for session ${sessionTag(session.id)}`);
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

  /**
   * Extract user prompt text/images from a CLI user message and store in
   * messageHistory. This makes CLI-replayed user prompts (from --resume)
   * visible in the browser. Deduplicates by CLI uuid to avoid duplicating
   * messages that the browser already sent.
   */
  private extractUserPromptFromCLI(session: Session, msg: CLIUserMessage): void {
    // Only extract top-level user prompts — skip subagent messages and tool results
    if (msg.parent_tool_use_id !== null) return;

    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    // Skip messages that contain tool_result blocks — these are tool confirmations
    // (e.g. "[Request interrupted by user for tool use]"), not user-typed prompts.
    const hasToolResult = content.some((b) => (b as Record<string, unknown>).type === "tool_result");
    if (hasToolResult) return;

    // Collect text and image blocks.
    // CLI user messages can contain "image" blocks not in our ContentBlock type,
    // so we cast each block to `any` for flexible property access.
    const textParts: string[] = [];
    const imageBlocks: { media_type: string; data: string }[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "image" && (b.source as Record<string, unknown>)?.type === "base64") {
        const src = b.source as Record<string, string>;
        imageBlocks.push({ media_type: src.media_type, data: src.data });
      }
    }

    // Only process if there's actual user prompt content (not pure tool results)
    if (textParts.length === 0 && imageBlocks.length === 0) return;

    // Dedup: skip if a user_message with this CLI uuid already exists
    const cliUuid = msg.uuid;
    if (cliUuid) {
      const alreadyInHistory = session.messageHistory.some(
        (m) => m.type === "user_message" && (m as { cliUuid?: string }).cliUuid === cliUuid,
      );
      if (alreadyInHistory) return;
    }

    const ts = Date.now();
    const text = textParts.join("\n");

    const storeEntry = (refs?: import("./image-store.js").ImageRef[]) => {
      const entry: BrowserIncomingMessage = {
        type: "user_message",
        content: text,
        timestamp: ts,
        id: `cli-user-${ts}-${this.userMsgCounter++}`,
        cliUuid,
        ...(refs?.length ? { images: refs } : {}),
      };
      session.messageHistory.push(entry);
      this.broadcastToBrowsers(session, entry);
      this.persistSession(session);
    };

    if (imageBlocks.length > 0 && this.imageStore) {
      Promise.all(
        imageBlocks.map((img) => this.imageStore!.store(session.id, img.data, img.media_type)),
      ).then(storeEntry).catch(() => storeEntry());
    } else {
      storeEntry();
    }
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

      // Compute wall-clock duration from tool_use start time
      const startTime = session.toolStartTimes.get(block.tool_use_id);
      const durationSeconds = startTime != null
        ? Math.round((Date.now() - startTime) / 100) / 10
        : undefined;
      session.toolStartTimes.delete(block.tool_use_id);

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
        duration_seconds: durationSeconds,
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

    // Track user activity for idle management
    if (this.launcher) {
      const activityTypes: ReadonlySet<string> = new Set([
        "user_message", "permission_response", "interrupt",
        "set_model", "set_permission_mode",
      ]);
      if (activityTypes.has(msg.type)) {
        this.launcher.touchActivity(session.id);
      }
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
        const wasGenerating = session.isGenerating;
        this.setGenerating(session, true, "user_message");
        this.broadcastToBrowsers(session, { type: "status_change", status: "running" });
        this.persistSession(session);

        // Trigger auto-naming evaluation (async, fire-and-forget)
        if (this.onUserMessage) {
          this.onUserMessage(session.id, [...session.messageHistory], session.state.cwd, wasGenerating);
        }
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
        console.log(`[ws-bridge] Codex adapter not yet attached for session ${sessionTag(session.id)}, queuing ${msg.type}`);
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

    // Clean up stale pendingPermissions that were already resolved in
    // messageHistory. This handles the case where the server crashed before
    // the debounced persist flushed the removal.
    const resolvedIds = new Set<string>();
    for (const msg of session.messageHistory) {
      if (msg.type === "permission_approved" || msg.type === "permission_denied") {
        const rec = msg as Record<string, unknown>;
        // request_id may be a direct field, or embedded in id as "approval-{rid}" / "denial-{rid}"
        const rid = rec.request_id as string | undefined;
        if (rid) {
          resolvedIds.add(rid);
        } else if (typeof rec.id === "string") {
          const m = (rec.id as string).match(/^(?:approval|denial)-(.+)$/);
          if (m) resolvedIds.add(m[1]);
        }
      }
    }
    let cleanedStale = false;
    for (const reqId of session.pendingPermissions.keys()) {
      if (resolvedIds.has(reqId)) {
        session.pendingPermissions.delete(reqId);
        cleanedStale = true;
      }
    }
    if (cleanedStale) this.persistSession(session);

    // Fresh connection (no prior state) — send full history.
    // This is the single source of truth for initial state delivery (previously
    // also done in handleBrowserOpen, causing double delivery).
    if (lastAckSeq === 0) {
      if (session.messageHistory.length > 0) {
        this.sendToBrowser(ws, {
          type: "message_history",
          messages: session.messageHistory,
        });
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
    } else if (lastAckSeq < session.nextEventSeq - 1) {
      // Browser is behind — determine what was missed.
      const earliest = session.eventBuffer[0]?.seq ?? session.nextEventSeq;
      const hasGap = session.eventBuffer.length === 0 || lastAckSeq < earliest - 1;

      const missedEvents = session.eventBuffer.filter((evt) => evt.seq > lastAckSeq);
      const hasMissedHistoryBacked = missedEvents.some((evt) =>
        this.isHistoryBackedEvent(evt.message),
      );

      if (hasGap || hasMissedHistoryBacked) {
        // Gap in buffer coverage OR missed history-backed events: send
        // authoritative message_history (full replacement) so the browser
        // has all chat messages. Then replay only transient events from the
        // buffer for in-flight streaming/progress state.
        if (session.messageHistory.length > 0) {
          this.sendToBrowser(ws, {
            type: "message_history",
            messages: session.messageHistory,
          });
        }
        const transientMissed = missedEvents
          .filter((evt) => !this.isHistoryBackedEvent(evt.message));
        if (transientMissed.length > 0) {
          this.sendToBrowser(ws, {
            type: "event_replay",
            events: transientMissed,
          });
        }
      } else {
        // No gap and only transient events missed — browser already has all
        // chat messages. Replay the missed transient events directly.
        if (missedEvents.length > 0) {
          this.sendToBrowser(ws, {
            type: "event_replay",
            events: missedEvents,
          });
        }
      }
    }

    // Always replay pending permissions regardless of which path above was
    // taken. Previously, permissions were only replayed in the fresh (lastAckSeq=0)
    // and gap paths, but the no-gap and empty-buffer paths skipped them — causing
    // plan approval and tool permission prompts to be invisible after server
    // restarts. Permission requests are idempotent (browser stores by request_id).
    if (session.pendingPermissions.size > 0) {
      for (const perm of session.pendingPermissions.values()) {
        this.sendToBrowser(ws, { type: "permission_request", request: perm });
      }
    }

    // Send task history so the browser always has the full list on reconnect
    if (session.taskHistory.length > 0) {
      this.sendToBrowser(ws, {
        type: "session_task_history",
        tasks: session.taskHistory,
      });
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
    const wasGenerating = session.isGenerating;
    this.setGenerating(session, true, "user_message");
    // Notify all browsers immediately so the UI shows "Thinking" without
    // waiting for the CLI's first assistant response.
    this.broadcastToBrowsers(session, { type: "status_change", status: "running" });
    this.persistSession(session);

    // Trigger auto-naming evaluation (async, fire-and-forget)
    if (this.onUserMessage) {
      this.onUserMessage(session.id, [...session.messageHistory], session.state.cwd, wasGenerating);
    }
  }

  private handlePermissionResponse(
    session: Session,
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: unknown[]; message?: string }
  ) {
    // Remove from pending
    const pending = session.pendingPermissions.get(msg.request_id);
    session.pendingPermissions.delete(msg.request_id);

    // Abort any in-flight LLM auto-approval evaluation
    this.abortAutoApproval(session, msg.request_id);

    // Cancel any pending Pushover notification for this permission
    this.pushoverNotifier?.cancelPermission(session.id, msg.request_id);

    this.clearActionAttentionIfNoPermissions(session);

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

      // If the permission response includes a setMode update (e.g. user clicked
      // "Set mode to acceptEdits"), send a separate set_permission_mode control
      // request to the CLI so it actually changes its permission mode.
      if (msg.updated_permissions?.length) {
        const setMode = (msg.updated_permissions as Array<{ type: string; mode?: string }>)
          .find(p => p.type === "setMode" && p.mode);
        if (setMode) {
          this.handleSetPermissionMode(session, setMode.mode!);
        }
      }

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
        this.setGenerating(session, true, "exit_plan_mode");
        this.broadcastToBrowsers(session, { type: "status_change", status: "running" });
        console.log(`[ws-bridge] ExitPlanMode approved for session ${sessionTag(session.id)}, switching to ${postPlanMode} (askPermission=${askPerm})`);
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
        console.log(`[ws-bridge] ExitPlanMode denied for session ${sessionTag(session.id)}, sending interrupt`);
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
      console.log(`[ws-bridge] CLI not yet connected for session ${sessionTag(session.id)}, queuing message`);
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
  broadcastNameUpdate(sessionId: string, name: string, source?: "quest"): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.log(`[ws-bridge] broadcastNameUpdate: session ${sessionTag(sessionId)} not found in sessions map`);
      return;
    }
    console.log(`[ws-bridge] broadcastNameUpdate: "${name}" source=${source ?? "none"} browsers=${session.browserSockets.size} session=${sessionTag(sessionId)}`);
    this.broadcastToBrowsers(session, { type: "session_name_update", name, ...(source && { source }) });
  }

  /** Add a task entry to the session's task history, persist, and broadcast. */
  addTaskEntry(sessionId: string, entry: SessionTaskEntry): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (entry.action === "revise") {
      // Revisions silently update the most recent entry's title
      const last = session.taskHistory[session.taskHistory.length - 1];
      if (last) {
        last.title = entry.title;
      }
    } else {
      session.taskHistory.push(entry);
    }
    this.broadcastTaskHistory(session);
    this.persistSession(session);
  }

  /** Push the full task history to all connected browsers for a session. */
  private broadcastTaskHistory(session: Session): void {
    this.broadcastToBrowsers(session, {
      type: "session_task_history",
      tasks: session.taskHistory,
    });
  }

  /** Merge new keywords into a session's accumulated keyword set. */
  mergeKeywords(sessionId: string, newKeywords: string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session || newKeywords.length === 0) return;
    const existing = new Set(session.keywords);
    for (const kw of newKeywords) {
      existing.add(kw);
    }
    session.keywords = [...existing].slice(0, 30);
    this.persistSession(session);
  }

  /** Get accumulated keywords for a session (for REST API). */
  getSessionKeywords(sessionId: string): string[] {
    return this.sessions.get(sessionId)?.keywords ?? [];
  }

  /** Get task history for a session (for REST API). */
  getSessionTaskHistory(sessionId: string): SessionTaskEntry[] {
    return this.sessions.get(sessionId)?.taskHistory ?? [];
  }

  /** Centralized generation state setter with logging and recording. */
  private setGenerating(session: Session, generating: boolean, reason: string): void {
    if (session.isGenerating === generating) return;
    session.isGenerating = generating;
    if (generating) {
      session.generationStartedAt = Date.now();
      session.stuckNotifiedAt = null;
      console.log(`[ws-bridge] Generation started for session ${sessionTag(session.id)} (${reason})`);
      this.recorder?.recordServerEvent(session.id, "generation_started", { reason }, session.backendType, session.state.cwd);
    } else {
      const elapsed = session.generationStartedAt ? Date.now() - session.generationStartedAt : 0;
      session.generationStartedAt = null;
      session.stuckNotifiedAt = null;
      console.log(`[ws-bridge] Generation ended for session ${sessionTag(session.id)} (${reason}, duration: ${elapsed}ms)`);
      this.recorder?.recordServerEvent(session.id, "generation_ended", { reason, elapsed }, session.backendType, session.state.cwd);
    }
  }

  /** Derive current session status from explicit runtime state. */
  private deriveSessionStatus(session: Session): string | null {
    if (session.state.is_compacting) return "compacting";
    const hasBackend = !!(session.cliSocket || session.codexAdapter);
    if (!hasBackend) return null;
    if (session.isGenerating) return "running";
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
      lastReadAt: session.lastReadAt,
      attentionReason: session.attentionReason,
      generationStartedAt: session.generationStartedAt ?? null,
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
      || msg.type === "permission_request"
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
      console.log(`[ws-bridge] ⚠ Broadcasting ${msg.type} to 0 browsers for session ${sessionTag(session.id)} (stored in history: ${msg.type === "assistant" || msg.type === "result"})`);
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
