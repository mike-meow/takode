import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { GIT_CMD_TIMEOUT } from "./constants.js";

const execPromise = promisify(execCb);

const GIT_SHA_REF_RE = /^[0-9a-f]{7,40}$/i;
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
  CLISystemTaskNotificationMessage,
  CLIUserMessage,
  BrowserOutgoingMessage,
  BrowserIncomingMessage,
  ReplayableBrowserIncomingMessage,
  BufferedBrowserEvent,
  ToolResultPreview,
  ContentBlock,
  SessionState,
  PermissionRequest,
  BackendType,
  McpServerDetail,
  McpServerConfig,
  SessionTaskEntry,
  TakodeEvent,
  TakodeEventType,
  TakodeEventSubscriber,
} from "./session-types.js";
import { TOOL_RESULT_PREVIEW_LIMIT } from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import type { CodexAdapter, CodexResumeSnapshot, CodexResumeTurnSnapshot } from "./codex-adapter.js";
import type { RecorderManager } from "./recorder.js";
import type { ImageStore } from "./image-store.js";
import type { CliLauncher } from "./cli-launcher.js";
import * as gitUtils from "./git-utils.js";
import { sessionTag } from "./session-tag.js";
import { shouldAttemptAutoApproval, evaluatePermission, type RecentToolCall } from "./auto-approver.js";
import type { AutoApprovalConfig } from "./auto-approval-store.js";
import type { PerfTracer } from "./perf-tracer.js";

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

/** Build a concise human-readable summary for an auto-approved permission.
 *  Prefers the human-readable description over raw command/file when available.
 *  Reason (LLM rationale) is kept separate — sent as its own field, not baked into summary. */
function getAutoApprovalSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    // Prefer the human-readable description (set by Claude Code for Bash calls)
    if (typeof input.description === "string" && input.description.length > 0) {
      return `Auto-approved: ${input.description}`;
    }
    if (typeof input.command === "string") {
      const cmd = input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
      return `Auto-approved: Bash \u2014 ${cmd}`;
    }
  }
  if (typeof input.file_path === "string") {
    return `Auto-approved: ${toolName} \u2014 ${input.file_path}`;
  }
  return `Auto-approved: ${toolName}`;
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

type QuestLifecycleStatus = "in_progress" | "needs_verification" | "done";

interface ParsedQuestLifecycleCommand {
  questId: string;
  targetStatus?: QuestLifecycleStatus;
}

function normalizeQuestStatus(value: string | undefined): QuestLifecycleStatus | undefined {
  if (!value) return undefined;
  const s = value.toLowerCase();
  if (s === "in_progress") return "in_progress";
  if (s === "needs_verification" || s === "verification") return "needs_verification";
  if (s === "done") return "done";
  return undefined;
}

function normalizeQuestId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/\b(q-\d+)\b/i);
  return match?.[1]?.toLowerCase();
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === "\\") {
        escaping = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseQuestLifecycleCommand(command: string): ParsedQuestLifecycleCommand | null {
  const match = command.match(/(?:^|[\s;|&])\/?quest\s+([a-z_]+)\s+(q-\d+)\b/i);
  if (!match) return null;

  const subcommand = match[1]?.toLowerCase();
  const questId = match[2];
  if (!subcommand || !questId) return null;

  if (subcommand === "claim") return { questId, targetStatus: "in_progress" };
  if (subcommand === "complete") return { questId, targetStatus: "needs_verification" };
  if (subcommand === "done" || subcommand === "cancel") return { questId, targetStatus: "done" };
  if (subcommand === "transition") {
    const statusMatch = command.match(/--status\s+([a-z_]+)/i);
    return { questId, targetStatus: normalizeQuestStatus(statusMatch?.[1]) };
  }

  return null;
}

function parseQuestLifecycleResult(resultText: string): {
  questId?: string;
  title?: string;
  status?: QuestLifecycleStatus;
} | null {
  const trimmed = resultText.trim();
  if (!trimmed) return null;

  const parseCandidate = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const questId = normalizeQuestId(
        typeof parsed.questId === "string"
          ? parsed.questId
          : (typeof parsed.id === "string" ? parsed.id : undefined),
      );
      const title = typeof parsed.title === "string" ? parsed.title : undefined;
      const status = normalizeQuestStatus(
        typeof parsed.status === "string" ? parsed.status : undefined,
      );
      if (!questId && !title && !status) return null;
      return { questId, title, status };
    } catch {
      return null;
    }
  };

  const whole = parseCandidate(trimmed);
  if (whole) return whole;

  const jsonCandidates = extractJsonObjectCandidates(trimmed);
  for (let i = jsonCandidates.length - 1; i >= 0; i--) {
    const parsed = parseCandidate(jsonCandidates[i]);
    if (parsed) return parsed;
  }

  const claimLine = trimmed.match(/Claimed\s+(q-\d+)\s+"([^"]+)"/i);
  if (claimLine) {
    return { questId: claimLine[1], title: claimLine[2], status: "in_progress" };
  }

  const completeLine = trimmed.match(/Completed\s+(q-\d+)\s+"([^"]+)"/i);
  if (completeLine) {
    return { questId: completeLine[1], title: completeLine[2], status: "needs_verification" };
  }

  const doneLine = trimmed.match(/(?:Marked done|Cancelled)\s+(q-\d+)\s+"([^"]+)"/i);
  if (doneLine) {
    return { questId: doneLine[1], title: doneLine[2], status: "done" };
  }

  const transitionLine = trimmed.match(/Transitioned\s+(q-\d+)\s+to\s+([a-z_]+)/i);
  if (transitionLine) {
    return {
      questId: transitionLine[1],
      status: normalizeQuestStatus(transitionLine[2]),
    };
  }

  return null;
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

interface PendingCodexTurnRecovery {
  adapterMsg: BrowserOutgoingMessage;
  userMessageId: string;
  userContent: string;
  turnId: string | null;
  disconnectedAt: number | null;
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
  /** Last in-flight Codex user turn that may need replay/recovery after disconnect. */
  pendingCodexTurnRecovery: PendingCodexTurnRecovery | null;
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
  /** Parsed quest lifecycle commands pending completion, keyed by tool_use_id. */
  pendingQuestCommands: Map<string, ParsedQuestLifecycleCommand>;
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
  /** Last keep_alive or WebSocket ping from CLI (epoch ms), for disconnect diagnostics */
  lastCliPingAt: number;
  /**
   * The last user message NDJSON sent to the CLI. Set when a user message is
   * forwarded to the CLI, cleared when the turn completes (result message).
   * If the CLI disconnects mid-turn, this is re-queued in pendingMessages so
   * the message is automatically re-sent after --resume reconnect.
   */
  lastOutboundUserNdjson: string | null;
  /** When stuck notification was sent (epoch ms), to avoid repeated notifications */
  stuckNotifiedAt: number | null;
  /** Server-side activity preview (mirrors browser's sessionTaskPreview) */
  lastActivityPreview?: string;
  /** Cached truncated content of the last user message (avoids scanning messageHistory) */
  lastUserMessage?: string;
  /** Epoch ms when the user last viewed this session (server-authoritative) */
  lastReadAt: number;
  /** Current attention reason: why this session needs the user's attention */
  attentionReason: "action" | "error" | "review" | null;
  /** Grace period timer for CLI disconnect — delays side-effects to allow seamless reconnect.
   *  The Claude Code CLI disconnects every 5 minutes for token refresh and reconnects in ~13s.
   *  If the CLI reconnects within the grace period, the disconnect is invisible to the system. */
  disconnectGraceTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the CLI was generating when the grace timer started (preserved for deferred handling). */
  disconnectWasGenerating: boolean;
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
  /** True while a relaunched CLI is replaying old messages via --resume.
   *  During this window, system.status permissionMode changes must NOT
   *  overwrite uiMode — the replayed mode is stale and would revert
   *  user-approved mode transitions (e.g. ExitPlanMode → agent). */
  cliResuming: boolean;
}

type GitSessionKey =
  | "git_branch"
  | "git_default_branch"
  | "diff_base_branch"
  | "git_head_sha"
  | "diff_base_start_sha"
  | "is_worktree"
  | "is_containerized"
  | "repo_root"
  | "git_ahead"
  | "git_behind"
  | "total_lines_added"
  | "total_lines_removed";

async function resolveUpstreamRef(state: SessionState): Promise<string | null> {
  if (!state.cwd || !state.git_branch || state.git_branch === "HEAD" || state.is_worktree) return null;
  try {
    const { stdout } = await execPromise(
      `git rev-parse --abbrev-ref --symbolic-full-name ${state.git_branch}@{upstream} 2>/dev/null`,
      { cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT },
    );
    const upstreamRef = stdout.trim();
    return upstreamRef || null;
  } catch {
    return null;
  }
}

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
    git_head_sha: "",
    git_default_branch: "",
    diff_base_branch: "",
    diff_base_start_sha: "",
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
    const { stdout: branchOut } = await execPromise("git --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null", {
      cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT,
    });
    state.git_branch = branchOut.trim();
    try {
      const { stdout: headOut } = await execPromise("git --no-optional-locks rev-parse HEAD 2>/dev/null", {
        cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT,
      });
      state.git_head_sha = headOut.trim();
    } catch {
      state.git_head_sha = "";
    }

    // Detect if this is a linked worktree
    try {
      const { stdout: gitDirOut } = await execPromise("git --no-optional-locks rev-parse --git-dir 2>/dev/null", {
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
        const { stdout: commonDirOut } = await execPromise("git --no-optional-locks rev-parse --git-common-dir 2>/dev/null", {
          cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT,
        });
        // commonDir is e.g. /path/to/repo/.git — parent is the repo root
        state.repo_root = resolve(state.cwd, commonDirOut.trim(), "..");
      } else {
        const { stdout: toplevelOut } = await execPromise("git --no-optional-locks rev-parse --show-toplevel 2>/dev/null", {
          cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT,
        });
        state.repo_root = toplevelOut.trim();
      }
    } catch { /* ignore */ }

    const upstreamRef = await resolveUpstreamRef(state);
    let legacyDefaultBranch: string | null = null;
    const getLegacyDefaultBranch = async () => {
      if (!legacyDefaultBranch) {
        legacyDefaultBranch = await gitUtils.resolveDefaultBranchAsync(state.repo_root || state.cwd, state.git_branch);
      }
      return legacyDefaultBranch;
    };

    // Non-worktree sessions should default to the current branch's upstream
    // tracking ref (e.g. origin/jiayi), not repo default (often main).
    if (upstreamRef) {
      state.git_default_branch = upstreamRef;
      if (!state.diff_base_branch) {
        state.diff_base_branch = upstreamRef;
      } else {
        // Migrate legacy sessions that auto-defaulted to repo default branch.
        const legacyDefault = await getLegacyDefaultBranch();
        if (state.diff_base_branch === legacyDefault) {
          state.diff_base_branch = upstreamRef;
        }
      }
    } else {
      const fallbackBase = await getLegacyDefaultBranch();
      state.git_default_branch = fallbackBase;
      if (!state.diff_base_branch && state.git_branch) {
        state.diff_base_branch = fallbackBase;
      }
    }

    // Compute ahead/behind using diff_base_branch as the reference point.
    // Fall back to git_default_branch when diff_base_branch is "" (user selected "default").
    const ref = state.diff_base_branch || state.git_default_branch;
    if (ref) {
      try {
        const { stdout: countsOut } = await execPromise(
          `git --no-optional-locks rev-list --left-right --count ${ref}...HEAD 2>/dev/null`,
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
    state.git_default_branch = "";
    state.diff_base_branch = "";
    state.git_head_sha = "";
    state.diff_base_start_sha = "";
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
    "set_codex_reasoning_effort",
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
  private herdEventDispatcher: { onOrchestratorTurnEnd(orchId: string): void } | null = null;
  private perfTracer: PerfTracer | null = null;
  private onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null = null;
  private onCLIRelaunchNeeded: ((sessionId: string) => void) | null = null;
  private onPermissionModeChanged: ((sessionId: string, newMode: string) => void) | null = null;
  private onSessionRelaunchRequested: ((sessionId: string) => void) | null = null;
  private onUserMessage: ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string, wasGenerating: boolean) => void) | null = null;
  private onTurnCompleted: ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void) | null = null;
  private onAgentPaused: ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void) | null = null;
  private onSessionNamedByQuest: ((sessionId: string, title: string) => void) | null = null;
  private userMsgCounter = 0;
  /** Per-project cache of slash commands & skills so new sessions get them
   *  before the CLI sends system/init (which only arrives after the first
   *  user message). Key is repo_root || cwd. */
  private slashCommandCache = new Map<string, { slash_commands: string[]; skills: string[] }>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Track recent CLI disconnects to detect mass disconnect events. */
  private recentCliDisconnects: number[] = [];

  // ── Takode orchestration event emitter ───────────────────────────────────
  private takodeSubscribers = new Set<TakodeEventSubscriber>();
  private takodeEventLog: TakodeEvent[] = [];
  private takodeEventNextId = 0;
  private static readonly TAKODE_EVENT_LOG_LIMIT = 1000;
  private sessionNameGetter: ((sessionId: string) => string) | null = null;
  private onGitInfoReady: ((sessionId: string, cwd: string, branch: string) => void) | null = null;
  private static readonly GIT_SESSION_KEYS: GitSessionKey[] = [
    "git_branch",
    "git_default_branch",
    "diff_base_branch",
    "git_head_sha",
    "diff_base_start_sha",
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

  /** Register a callback for when session settings changed and backend relaunch is required. */
  onSessionRelaunchRequestedCallback(cb: (sessionId: string) => void): void {
    this.onSessionRelaunchRequested = cb;
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

  /** Register a callback for when a quest claims a session name.
   *  The callback receives the session ID and quest title so the caller can
   *  cancel in-flight namer calls AND update the persistent name store. */
  onSessionNamedByQuestCallback(cb: (sessionId: string, title: string) => void): void {
    this.onSessionNamedByQuest = cb;
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
    this.refreshGitInfoThenRecomputeDiff(session, { broadcastUpdate: true });
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

  /** Send periodic pings to all browser and CLI sockets to detect dead connections.
   *  10s interval matches the CLI's expected WebSocket ping/pong cadence and ensures
   *  half-open TCP connections are detected within ~10s instead of ~30s. */
  startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      for (const session of this.sessions.values()) {
        // Ping browser sockets (prevents Bun's idle timeout from closing them)
        for (const ws of session.browserSockets) {
          try {
            ws.ping();
          } catch {
            session.browserSockets.delete(ws);
          }
        }
        // Ping CLI socket (detects half-open TCP connections from the server
        // side — the CLI also pings us every 10s, but if the network silently
        // drops packets, server-side pings give us earlier detection)
        if (session.cliSocket) {
          try {
            session.cliSocket.ping();
          } catch {
            // ping() threw — socket is already dead
          }
        }
      }
    }, 10_000);
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
    const prevId = session.state.claimedQuestId ?? null;
    const prevTitle = session.state.claimedQuestTitle ?? null;
    const prevStatus = session.state.claimedQuestStatus ?? null;
    const nextId = quest?.id ?? null;
    const nextTitle = quest?.title ?? null;
    const nextStatus = quest?.status ?? null;
    if (prevId === nextId && prevTitle === nextTitle && prevStatus === nextStatus) {
      return;
    }
    session.state.claimedQuestId = quest?.id;
    session.state.claimedQuestTitle = quest?.title;
    session.state.claimedQuestStatus = quest?.status;
    // Cancel in-flight namer calls before broadcasting so no stale result
    // can arrive after the quest name update reaches browsers.
    if (quest?.title && this.onSessionNamedByQuest) {
      this.onSessionNamedByQuest(sessionId, quest.title);
    }
    this.broadcastToBrowsers(session, {
      type: "session_quest_claimed",
      quest,
    } as BrowserIncomingMessage);
    // When a quest is set, also broadcast a session_name_update with source "quest"
    // so ALL paths (REST claim, Codex Bash detection, transitions) consistently
    // update the session name and the browser's questNamedSessions guard.
    if (quest?.title) {
      this.broadcastNameUpdate(sessionId, quest.title, "quest");
    }
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

  /** Attach the herd event dispatcher for push-based event delivery to orchestrators. */
  setHerdEventDispatcher(dispatcher: { onOrchestratorTurnEnd(orchId: string): void }): void {
    this.herdEventDispatcher = dispatcher;
  }

  /** Check if a session is idle (CLI connected, not generating). */
  isSessionIdle(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return !!(session.cliSocket || session.codexAdapter) && !session.isGenerating;
  }

  setPerfTracer(tracer: PerfTracer): void {
    this.perfTracer = tracer;
  }

  /** Set the callback used to resolve human-readable session names for takode events. */
  setSessionNameGetter(fn: (sessionId: string) => string): void {
    this.sessionNameGetter = fn;
  }

  /** Route a permission response from an external source (REST API / CLI).
   *  This reuses the same handlePermissionResponse path as browser WebSocket responses. */
  routeExternalPermissionResponse(
    session: Session,
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; message?: string },
  ): void {
    this.routeBrowserMessage(session, msg as BrowserOutgoingMessage);
  }

  // ── Takode orchestration event methods ──────────────────────────────────

  /** Emit a takode event, buffering it and notifying matching subscribers. */
  emitTakodeEvent(sessionId: string, event: TakodeEventType, data: Record<string, unknown>): void {
    const takodeEvent: TakodeEvent = {
      id: this.takodeEventNextId++,
      event,
      sessionId,
      sessionNum: this.launcher?.getSessionNum(sessionId) ?? -1,
      sessionName: this.sessionNameGetter?.(sessionId) ?? sessionId.slice(0, 8),
      ts: Date.now(),
      data,
    };

    // Ring buffer: evict oldest when full
    this.takodeEventLog.push(takodeEvent);
    if (this.takodeEventLog.length > WsBridge.TAKODE_EVENT_LOG_LIMIT) {
      this.takodeEventLog.shift();
    }

    // Notify matching subscribers (wrap in try/catch — SSE streams may have closed)
    for (const sub of this.takodeSubscribers) {
      if (sub.sessions.has(sessionId)) {
        try {
          sub.callback(takodeEvent);
        } catch {
          // Subscriber errored (likely closed SSE stream) — remove it
          this.takodeSubscribers.delete(sub);
        }
      }
    }
  }

  /** Subscribe to takode events for a set of sessions. Returns an unsubscribe function.
   *  If sinceEventId is provided, immediately replays buffered events with id > sinceEventId. */
  subscribeTakodeEvents(
    sessions: Set<string>,
    callback: (event: TakodeEvent) => void,
    sinceEventId?: number,
  ): () => void {
    const sub: TakodeEventSubscriber = { sessions, callback };
    this.takodeSubscribers.add(sub);

    // Replay buffered events if requested
    if (sinceEventId !== undefined) {
      for (const evt of this.takodeEventLog) {
        if (evt.id > sinceEventId && sessions.has(evt.sessionId)) {
          try {
            callback(evt);
          } catch {
            this.takodeSubscribers.delete(sub);
            return () => {};
          }
        }
      }
    }

    return () => {
      this.takodeSubscribers.delete(sub);
    };
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
        pendingCodexTurnRecovery: null,
        nextEventSeq: p.nextEventSeq && p.nextEventSeq > 0 ? p.nextEventSeq : 1,
        eventBuffer: Array.isArray(p.eventBuffer) ? p.eventBuffer : [],
        lastAckSeq: typeof p.lastAckSeq === "number" ? p.lastAckSeq : 0,
        processedClientMessageIds: Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        processedClientMessageIdSet: new Set(
          Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        ),
        toolResults: new Map(Array.isArray(p.toolResults) ? p.toolResults : []),
        pendingQuestCommands: new Map(),
        assistantAccumulator: new Map(),
        toolStartTimes: new Map(),
        isGenerating: false,
        generationStartedAt: null,
        lastCliMessageAt: 0,
        lastCliPingAt: 0,
        lastOutboundUserNdjson: null,
        stuckNotifiedAt: null,
        lastReadAt: typeof p.lastReadAt === "number" ? p.lastReadAt : 0,
        attentionReason: p.attentionReason ?? null,
        disconnectGraceTimer: null,
        disconnectWasGenerating: false,
        taskHistory: Array.isArray(p.taskHistory) ? p.taskHistory : [],
        keywords: Array.isArray(p.keywords) ? p.keywords : [],
        diffStatsDirty: true,
        evaluatingAborts: new Map(),
        cliResuming: false,
      };
      session.state.backend_type = session.backendType;

      // Recover from server restart: any permissions left in "evaluating" state
      // have no running LLM subprocess. Transition them to normal pending.
      for (const perm of session.pendingPermissions.values()) {
        if (perm.evaluating) {
          perm.evaluating = undefined;
        }
      }

      // Git info resolves lazily on first CLI/browser connect — skipping here
      // eliminates hundreds of blocking git calls at startup on NFS.

      // Initialize lastUserMessage cache from history (scan once at restore,
      // not on every /api/sessions request)
      for (let i = session.messageHistory.length - 1; i >= 0; i--) {
        const m = session.messageHistory[i];
        if (m.type === "user_message" && m.content) {
          session.lastUserMessage = m.content.slice(0, 80);
          break;
        }
      }

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
    // Skip expensive git operations for fully background sessions without a
    // backend connection. Exception: actively viewed worktree sessions still
    // need refresh to re-anchor diff_base_start_sha after sync/rebase/reset.
    if (
      !session.cliSocket
      && !session.codexAdapter
      && !(session.state.is_worktree && session.browserSockets.size > 0)
    ) return;

    const before: Record<string, unknown> = {};
    for (const key of WsBridge.GIT_SESSION_KEYS) {
      before[key] = session.state[key];
    }
    const previousHeadSha = session.state.git_head_sha || "";

    await resolveGitInfo(session.state);
    const anchorChanged = await this.updateDiffBaseStartSha(session, previousHeadSha);
    if (anchorChanged) {
      // Force recomputation so +/− totals reflect the rewritten branch baseline.
      session.diffStatsDirty = true;
    }

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
            git_default_branch: session.state.git_default_branch,
            diff_base_branch: session.state.diff_base_branch,
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

  /**
   * Keep a per-worktree baseline anchor for "agent-made changes".
   * For branch mode, derive it from merge-base(baseRef, HEAD) so base branch
   * fast-forwards do not inflate session-owned diff stats.
   */
  private async updateDiffBaseStartSha(session: Session, previousHeadSha: string): Promise<boolean> {
    if (!session.state.is_worktree) return false;
    const cwd = session.state.cwd;
    const currentHeadSha = session.state.git_head_sha?.trim() || "";
    if (!cwd || !currentHeadSha) return false;

    const existingAnchor = session.state.diff_base_start_sha?.trim() || "";
    const ref = (session.state.diff_base_branch || session.state.git_default_branch || "").trim();

    // Explicit commit mode: keep anchor stable so stats can compare directly
    // against the selected commit SHA.
    if (ref && GIT_SHA_REF_RE.test(ref)) {
      if (!existingAnchor) {
        session.state.diff_base_start_sha = currentHeadSha;
        return true;
      }
      // If history was rewritten while commit mode is active, keep anchor aligned
      // with HEAD so clearing commit mode doesn't restore stale baselines.
      if (previousHeadSha && previousHeadSha !== currentHeadSha) {
        try {
          await execPromise(
            `git --no-optional-locks merge-base --is-ancestor ${previousHeadSha} ${currentHeadSha}`,
            { cwd, timeout: GIT_CMD_TIMEOUT },
          );
        } catch {
          session.state.diff_base_start_sha = currentHeadSha;
          return true;
        }
      }
      return false;
    }

    let nextAnchor = currentHeadSha;
    if (ref) {
      try {
        const { stdout } = await execPromise(
          `git --no-optional-locks merge-base ${ref} HEAD`,
          { cwd, timeout: GIT_CMD_TIMEOUT },
        );
        const mergeBase = stdout.trim();
        if (mergeBase) nextAnchor = mergeBase;
      } catch {
        // Fall back to current HEAD when merge-base is unavailable.
      }
    }

    if (nextAnchor !== existingAnchor) {
      session.state.diff_base_start_sha = nextAnchor;
      return true;
    }
    return false;
  }

  /** Refresh git metadata and then recompute dirty diff stats. */
  private refreshGitInfoThenRecomputeDiff(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): void {
    void this.refreshGitInfo(session, options).then(() => {
      this.recomputeDiffIfDirty(session);
    });
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
    // Skip expensive git diff for fully background sessions without a backend.
    // Exception: actively viewed worktree sessions should refresh totals.
    if (
      !session.cliSocket
      && !session.codexAdapter
      && !(session.state.is_worktree && session.browserSockets.size > 0)
    ) return;
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
   * against a stable worktree anchor (agent-made diff), or against the selected
   * base ref for non-worktree sessions.
   * Diffs the entire repo — git tracks what changed, no need to scope by file list.
   * Runs asynchronously via child_process.exec to avoid blocking the event loop on NFS.
   */
  private async computeDiffStatsAsync(session: Session): Promise<boolean> {
    const cwd = session.state.cwd;
    if (!cwd) return false;

    try {
      let diffBase = "";
      if (session.state.is_worktree) {
        const selectedBase = (session.state.diff_base_branch || session.state.git_default_branch || "").trim();
        if (selectedBase && GIT_SHA_REF_RE.test(selectedBase)) {
          // Explicit commit selection in DiffPanel.
          diffBase = selectedBase;
        } else {
          // Worktree metric: branch-local changes since merge-base anchor.
          diffBase = session.state.diff_base_start_sha?.trim() || session.state.git_head_sha?.trim() || "";
          if (!diffBase) {
            // Fallback for older persisted sessions before git_head/anchor is available.
            diffBase = selectedBase;
          }
        }
      } else {
        // Non-worktree fallback: compare against selected base ref.
        diffBase = (session.state.diff_base_branch || session.state.git_default_branch || "").trim();
      }
      if (!diffBase) return false;
      const cmd = `git --no-optional-locks diff --numstat ${diffBase}`;
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

  /**
   * Diff stats are server-computed from git and must not be overwritten by
   * Codex adapter session updates.
   */
  private sanitizeCodexSessionPatch(patch: Partial<SessionState>): Partial<SessionState> {
    const {
      total_lines_added: _ignoredAdded,
      total_lines_removed: _ignoredRemoved,
      ...rest
    } = patch;
    return rest;
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
        pendingCodexTurnRecovery: null,
        nextEventSeq: 1,
        eventBuffer: [],
        lastAckSeq: 0,
        processedClientMessageIds: [],
        processedClientMessageIdSet: new Set(),
        toolResults: new Map(),
        pendingQuestCommands: new Map(),
        assistantAccumulator: new Map(),
        toolStartTimes: new Map(),
        isGenerating: false,
        generationStartedAt: null,
        lastCliMessageAt: 0,
        lastCliPingAt: 0,
        lastOutboundUserNdjson: null,
        stuckNotifiedAt: null,
        lastReadAt: 0,
        attentionReason: null,
        disconnectGraceTimer: null,
        disconnectWasGenerating: false,
        taskHistory: [],
        keywords: [],
        diffStatsDirty: true,
        evaluatingAborts: new Map(),
        cliResuming: false,
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
    return this.sessions.get(sessionId)?.lastUserMessage;
  }

  /** Returns the full message history for a session (read-only snapshot). */
  getMessageHistory(sessionId: string): BrowserIncomingMessage[] | null {
    const session = this.sessions.get(sessionId);
    return session ? session.messageHistory : null;
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
    // Fire-and-forget: image cleanup is non-critical
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
    // Fire-and-forget: image cleanup is non-critical
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
      let outgoing: BrowserIncomingMessage | null = msg;

      if (msg.type === "session_init") {
        const sanitized = this.sanitizeCodexSessionPatch(msg.session);
        session.state = { ...session.state, ...sanitized, backend_type: "codex" };
        this.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
        this.persistSession(session);
      } else if (msg.type === "session_update") {
        const sanitized = this.sanitizeCodexSessionPatch(msg.session);
        session.state = { ...session.state, ...sanitized, backend_type: "codex" };
        outgoing = { ...msg, session: sanitized };
        this.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
        this.persistSession(session);
      } else if (msg.type === "status_change") {
        session.state.is_compacting = msg.status === "compacting";
        this.persistSession(session);
      } else if (msg.type === "assistant") {
        const content = msg.message.content || [];
        this.trackCodexQuestCommands(session, content);
        const toolResults = content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
        if (toolResults.length > 0) {
          for (const block of toolResults) {
            this.reconcileCodexQuestToolResult(session, block);
          }
          const previews = this.buildToolResultPreviews(session, toolResults);
          if (previews.length > 0) {
            const previewMsg: BrowserIncomingMessage = {
              type: "tool_result_preview",
              previews,
            };
            session.messageHistory.push(previewMsg);
            this.broadcastToBrowsers(session, previewMsg);
            this.persistSession(session);
          }

          // Preserve non-tool_result content blocks (text/tool_use/thinking).
          // If the message only contains tool_result blocks, suppress it so
          // Codex renders results via the shared ToolBlock result section.
          const nonResult = content.filter((b) => b.type !== "tool_result");
          if (nonResult.length === 0) {
            outgoing = null;
          } else {
            outgoing = {
              ...msg,
              message: { ...msg.message, content: nonResult },
            };
          }
        }
      }

      // Store assistant/result messages in history for replay
      if (outgoing?.type === "assistant") {
        session.messageHistory.push({ ...outgoing, timestamp: outgoing.timestamp || Date.now() });
        this.persistSession(session);
      } else if (outgoing?.type === "result") {
        session.pendingCodexTurnRecovery = null;
        // Route through the unified result handler so Codex gets the same
        // post-turn state refresh (git + diff stats + attention) as Claude.
        this.handleResultMessage(session, outgoing.data);
        return;
      }

      // Diagnostic: log tool_use assistant messages
      if (outgoing?.type === "assistant") {
        const content = (outgoing as { message?: { content?: Array<{ type: string }> } }).message?.content;
        const hasToolUse = content?.some((b) => b.type === "tool_use");
        if (hasToolUse) {
          console.log(`[ws-bridge] Broadcasting tool_use assistant to ${session.browserSockets.size} browser(s) for session ${sessionTag(session.id)}`);
        }
      }

      // Handle permission requests
      if (outgoing?.type === "permission_request") {
        const perm = outgoing.request;
        session.pendingPermissions.set(perm.request_id, perm);
        this.setAttention(session, "action");
        this.persistSession(session);

        // Emit herd event so orchestrator knows this worker is blocked
        this.emitTakodeEvent(session.id, "permission_request", {
          tool_name: perm.tool_name,
          request_id: perm.request_id,
          summary: perm.description || perm.tool_name,
          ...this.buildPermissionPreview(perm),
        });
      }

      if (outgoing) this.broadcastToBrowsers(session, outgoing);
    });

    // Handle session metadata updates
    adapter.onSessionMeta((meta) => {
      if (meta.cliSessionId && this.onCLISessionId) {
        this.onCLISessionId(session.id, meta.cliSessionId);
      }
      if (meta.resumeSnapshot) {
        this.reconcileCodexResumedTurn(session, meta.resumeSnapshot);
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
      this.refreshGitInfoThenRecomputeDiff(session, { broadcastUpdate: true, notifyPoller: true });
      this.persistSession(session);
    });

    // Handle disconnect
    adapter.onDisconnect(() => {
      const wasGenerating = session.isGenerating;
      const disconnectedTurnId = adapter.getCurrentTurnId ? adapter.getCurrentTurnId() : null;
      if (session.pendingCodexTurnRecovery) {
        session.pendingCodexTurnRecovery.turnId = disconnectedTurnId;
        session.pendingCodexTurnRecovery.disconnectedAt = Date.now();
      }
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      session.pendingPermissions.clear();
      session.pendingQuestCommands.clear();
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

      // Recover faster from unexpected Codex transport drops while a browser is
      // actively connected. Without this, the UI can remain disconnected until
      // either the process exits by itself or the browser reconnects.
      if (
        !idleKilled
        && this.onCLIRelaunchNeeded
        && session.browserSockets.size > 0
        // Suppress relaunch for intentional teardown (session closed/removed).
        && this.sessions.get(sessionId) === session
      ) {
        console.log(`[ws-bridge] Codex adapter disconnected for active browser; requesting relaunch for session ${sessionTag(sessionId)}`);
        this.onCLIRelaunchNeeded(sessionId);
      }
    });

    // Re-queue user messages whose turn/start dispatch failed (e.g. transport closed mid-call)
    adapter.onTurnStartFailed((msg) => {
      console.log(`[ws-bridge] Turn start failed for session ${sessionTag(sessionId)}, re-queuing ${msg.type}`);
      if (msg.type === "user_message") {
        // turn/start never made it to Codex — standard pending queue handles retry.
        session.pendingCodexTurnRecovery = null;
      }
      session.pendingMessages.push(JSON.stringify(msg));
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

    // Cancel disconnect grace timer if the CLI reconnected within the window.
    // The CLI disconnects every ~5 minutes for token refresh and reconnects in ~13s.
    // If the grace timer is running, this reconnect is seamless — no events emitted.
    if (session.disconnectGraceTimer) {
      clearTimeout(session.disconnectGraceTimer);
      session.disconnectGraceTimer = null;
      console.log(`[ws-bridge] CLI reconnected within grace period for session ${sessionTag(sessionId)} (seamless)`);
    }

    // Always flush pending herd events on ANY CLI reconnect — not just grace timer
    // cancellations. Events accumulate in the inbox while cliSocket is null (during
    // the disconnect/relaunch cycle), but isSessionIdle returns false so they never
    // get scheduled for delivery. This catches all reconnect paths: grace period
    // cancellation, post-relaunch reconnect, and server restart recovery.
    if (this.herdEventDispatcher) {
      const info = this.launcher?.getSession(sessionId);
      if (info?.isOrchestrator) {
        this.herdEventDispatcher.onOrchestratorTurnEnd(sessionId);
      }
    }

    // When a CLI reconnects to an existing session (has history), mark it as
    // resuming. During --resume replay, the CLI sends stale system.status
    // messages with old permissionMode that would incorrectly overwrite uiMode
    // (e.g. reverting an ExitPlanMode approval). The flag is cleared on
    // system.init (which always follows replay completion).
    if (session.messageHistory.length > 0) {
      session.cliResuming = true;
    }
    console.log(`[ws-bridge] CLI connected for session ${sessionTag(sessionId)}${session.cliResuming ? " (resuming)" : ""}`);
    this.broadcastToBrowsers(session, { type: "cli_connected" });
    // Retry diff recomputation now that backend connectivity exists.
    this.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });

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
    const perfStart = this.perfTracer ? performance.now() : 0;
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

    if (this.perfTracer) {
      const perfMs = performance.now() - perfStart;
      if (perfMs > this.perfTracer.wsSlowThresholdMs) {
        const firstType = lines.length > 0 ? (JSON.parse(lines[0])?.type ?? "unknown") : "unknown";
        this.perfTracer.recordSlowWsMessage(sessionId, "cli", firstType, perfMs);
      }
    }
  }

  handleCLIClose(ws: ServerWebSocket<SocketData>, code?: number, reason?: string) {
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const now = Date.now();
    const wasGenerating = session.isGenerating;
    session.cliSocket = null;
    // Reset generating state immediately — the UI needs to stop showing "running"
    // even during the grace period. But DON'T call setGenerating() here because
    // that emits turn_end/turn_start takode events which we want to defer.
    session.isGenerating = false;
    session.generationStartedAt = null;
    const idleKilled = this.launcher?.getSession(sessionId)?.killedByIdleManager;

    // Diagnostic: time since last CLI activity for disconnect analysis
    const sinceLastMsg = session.lastCliMessageAt ? now - session.lastCliMessageAt : -1;
    const sinceLastPing = session.lastCliPingAt ? now - session.lastCliPingAt : -1;

    // Log close code/reason with diagnostic timing to help diagnose whether
    // CLI is initiating the disconnect (ping/pong timeout) vs network drop.
    // Common codes: 1000=normal, 1001=going away, 1006=abnormal (no close frame)
    console.log(
      `[ws-bridge] CLI disconnected for session ${sessionTag(sessionId)}${idleKilled ? " (idle limit)" : ""}` +
      ` | code=${code ?? "?"} reason=${JSON.stringify(reason || "")}` +
      ` wasGenerating=${wasGenerating}` +
      ` sinceLastMsg=${sinceLastMsg > 0 ? `${(sinceLastMsg / 1000).toFixed(1)}s` : "n/a"}` +
      ` sinceLastPing=${sinceLastPing > 0 ? `${(sinceLastPing / 1000).toFixed(1)}s` : "n/a"}`
    );

    // Mass disconnect detection: if multiple CLIs disconnect within 2 seconds,
    // it's likely a network event rather than individual session issues.
    this.recentCliDisconnects.push(now);
    // Prune entries older than 2 seconds
    while (this.recentCliDisconnects.length > 0 && now - this.recentCliDisconnects[0] > 2000) {
      this.recentCliDisconnects.shift();
    }
    if (this.recentCliDisconnects.length >= 3) {
      const span = now - this.recentCliDisconnects[0];
      console.warn(
        `[ws-bridge] ⚠ Mass CLI disconnect: ${this.recentCliDisconnects.length} CLIs dropped in ${span}ms` +
        ` — likely a network event, not a per-session issue`
      );
    }

    // If killed by idle manager, run full disconnect immediately (no grace period)
    if (idleKilled) {
      this.runFullDisconnect(session, sessionId, wasGenerating, idleKilled, reason);
      return;
    }

    // ── Grace period: the Claude Code CLI disconnects every ~5 minutes for
    // token refresh and reconnects within ~13 seconds. Delay all side-effects
    // (events, permission cancel, relaunch) to allow seamless reconnect.
    // If the CLI reconnects within the grace window, handleCLIOpen cancels the
    // timer and the disconnect is invisible to the rest of the system.
    session.disconnectWasGenerating = wasGenerating;
    if (session.disconnectGraceTimer) clearTimeout(session.disconnectGraceTimer);
    session.disconnectGraceTimer = setTimeout(() => {
      session.disconnectGraceTimer = null;
      // CLI didn't reconnect in time — run full disconnect
      if (!session.cliSocket) {
        console.log(`[ws-bridge] Grace period expired for session ${sessionTag(sessionId)}, running full disconnect`);
        this.runFullDisconnect(session, sessionId, session.disconnectWasGenerating, false, reason);
      }
    }, 15_000);
    console.log(`[ws-bridge] Grace period started for session ${sessionTag(sessionId)} (15s, expecting reconnect)`);
  }

  /** Run the full disconnect side-effects (events, permission cancel, relaunch).
   *  Separated from handleCLIClose so it can be deferred during the grace period. */
  private runFullDisconnect(
    session: Session, sessionId: string,
    wasGenerating: boolean, idleKilled: boolean | undefined, reason?: string,
  ): void {
    // Clear generating state if not already done
    if (session.isGenerating) {
      this.setGenerating(session, false, "cli_disconnect");
    }

    this.broadcastToBrowsers(session, {
      type: "cli_disconnected",
      ...(idleKilled ? { reason: "idle_limit" as const } : {}),
    });

    // Takode: session_disconnected
    this.emitTakodeEvent(sessionId, "session_disconnected", {
      wasGenerating,
      reason: idleKilled ? "idle_limit" : (reason || "unknown"),
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

    // Re-queue the in-flight user message if the CLI disconnected mid-turn.
    if (wasGenerating && !idleKilled) {
      if (session.lastOutboundUserNdjson) {
        console.log(`[ws-bridge] Re-queuing in-flight user message for session ${sessionTag(sessionId)} (will re-send after reconnect)`);
        session.pendingMessages.push(session.lastOutboundUserNdjson);
        session.lastOutboundUserNdjson = null;
      } else {
        // Agent was generating but no user message in flight — send a nudge
        const nudgeContent = "[CLI disconnected and relaunched. Please continue your work from where you left off.]";
        const nudge = JSON.stringify({
          type: "user",
          message: { role: "user", content: nudgeContent },
          parent_tool_use_id: null,
          session_id: session.state.session_id || "",
        });
        console.log(`[ws-bridge] Queuing continue-nudge for session ${sessionTag(sessionId)} (was generating, no user message in flight)`);
        session.pendingMessages.push(nudge);
        session.messageHistory.push({
          type: "user_message",
          content: nudgeContent,
          timestamp: Date.now(),
          id: `nudge-${Date.now()}`,
        } as BrowserIncomingMessage);
      }
    }

    // Flush cleared permissions to disk
    this.persistSession(session);

    // Auto-relaunch after full disconnect (CLI didn't reconnect within grace period)
    if (!idleKilled && this.onCLIRelaunchNeeded) {
      const sid = sessionId;
      // No additional delay needed — the 15s grace period already passed
      const s = this.sessions.get(sid);
      if (s && !s.cliSocket) {
        this.onCLIRelaunchNeeded(sid);
      }
    }
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
    this.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });

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
    const perfStart = this.perfTracer ? performance.now() : 0;
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

    if (this.perfTracer) {
      const perfMs = performance.now() - perfStart;
      if (perfMs > this.perfTracer.wsSlowThresholdMs) {
        this.perfTracer.recordSlowWsMessage(sessionId, "browser", msg.type, perfMs);
      }
    }
  }

  /** Send a user message into a session programmatically (no browser required).
   *  Used by the cron scheduler and takode CLI to send prompts. */
  injectUserMessage(sessionId: string, content: string, agentSource?: { sessionId: string; sessionLabel?: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject message: session ${sessionId} not found`);
      return;
    }
    this.routeBrowserMessage(session, {
      type: "user_message",
      content,
      ...(agentSource ? { agentSource } : {}),
    });
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>, code?: number, reason?: string) {
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.browserSockets.delete(ws);
    const hasBackend = session.backendType === "codex" ? !!session.codexAdapter : !!session.cliSocket;
    console.log(`[ws-bridge] Browser disconnected for session ${sessionTag(sessionId)} (${session.browserSockets.size} remaining, backend=${hasBackend ? "alive" : "dead"}) | code=${code ?? "?"} reason=${JSON.stringify(reason || "")}`);
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
        void this.handleControlRequest(session, msg);
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
        // Track keepalive timing for disconnect diagnostics
        session.lastCliPingAt = Date.now();
        break;

      default:
        // Forward unknown messages as-is for debugging
        break;
    }
  }

  private handleSystemMessage(session: Session, msg: CLISystemInitMessage | CLISystemStatusMessage | CLISystemCompactBoundaryMessage | CLISystemTaskNotificationMessage) {
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
      // On --resume reconnect, the CLI reports its launch-time permissionMode
      // (typically "plan"), which would overwrite any mode the user approved
      // before the disconnect (e.g. ExitPlanMode → acceptEdits). Preserve the
      // server's existing permissionMode for resumed sessions.
      const isResume = session.messageHistory.length > 0;
      if (!isResume) {
        session.state.permissionMode = msg.permissionMode;
      }
      session.state.claude_code_version = msg.claude_code_version;
      // system.init marks the end of --resume replay. Clear the resuming flag
      // so subsequent real-time system.status updates can change uiMode again.
      session.cliResuming = false;
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
      this.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });

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
        // During --resume replay, the CLI sends stale system.status messages
        // with old permissionMode values. Updating uiMode from these would
        // revert user-approved mode transitions (e.g. ExitPlanMode → agent
        // gets overwritten back to plan). Only update uiMode from real-time
        // status changes (after replay completes and cliResuming is cleared).
        if (!session.cliResuming) {
          const uiMode = msg.permissionMode === "plan" ? "plan" : "agent";
          session.state.uiMode = uiMode;
          this.broadcastToBrowsers(session, {
            type: "session_update",
            session: { permissionMode: msg.permissionMode, uiMode },
          });
        } else {
          // Still broadcast permissionMode (CLI state) without changing uiMode
          this.broadcastToBrowsers(session, {
            type: "session_update",
            session: { permissionMode: msg.permissionMode },
          });
        }
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

      // Some CLIs don't provide compact_boundary uuid. On resume/replay this can
      // duplicate the marker immediately. If the latest history entry is an
      // equivalent unsummarized marker, treat it as a replay and skip.
      const last = session.messageHistory[session.messageHistory.length - 1] as
        | { type?: string; trigger?: string; preTokens?: number; summary?: string }
        | undefined;
      const duplicateWithoutUuid = !cliUuid
        && last?.type === "compact_marker"
        && !last.summary
        && (last.trigger ?? null) === (meta?.trigger ?? null)
        && (last.preTokens ?? null) === (meta?.pre_tokens ?? null);
      if (duplicateWithoutUuid) return;

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
    } else if (msg.subtype === "task_notification") {
      // Forward background agent completion notifications to browsers
      this.broadcastToBrowsers(session, {
        type: "task_notification" as const,
        task_id: msg.task_id,
        tool_use_id: msg.tool_use_id,
        status: msg.status,
        output_file: msg.output_file,
        summary: msg.summary,
      });
    }
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
      ) as { type: "assistant"; message: CLIAssistantMessage["message"]; timestamp?: number } | undefined;

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

      // Treat the latest part as the completion timestamp for this assistant message.
      historyEntry.timestamp = Date.now();

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
    this.refreshGitInfoThenRecomputeDiff(session, { broadcastUpdate: true, notifyPoller: true });

    // Broadcast updated metrics to all browsers
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: {
        total_cost_usd: session.state.total_cost_usd,
        num_turns: session.state.num_turns,
        context_used_percent: session.state.context_used_percent,
      },
    });

    const turnDurationMs =
      typeof session.generationStartedAt === "number"
        ? Math.max(0, Date.now() - session.generationStartedAt)
        : undefined;

    this.setGenerating(session, false, "result");
    // Turn completed — the user message was processed. Clear the re-queue
    // tracker so we don't re-send it on a subsequent disconnect.
    session.lastOutboundUserNdjson = null;

    // Persist turn duration on the latest top-level assistant message and
    // rebroadcast it so the chat feed can render the completed turn timing.
    if (typeof turnDurationMs === "number") {
      const latestAssistant = session.messageHistory.findLast(
        (m) => m.type === "assistant" && (m as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
      ) as (BrowserIncomingMessage & { type: "assistant"; turn_duration_ms?: number }) | undefined;
      if (latestAssistant) {
        latestAssistant.turn_duration_ms = turnDurationMs;
        this.broadcastToBrowsers(session, latestAssistant);
      }
    }

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

    // Takode: session_error when the result indicates an error
    if (msg.is_error) {
      this.emitTakodeEvent(session.id, "session_error", {
        error: typeof msg.result === "string" ? msg.result.slice(0, 200) : "Unknown error",
      });
    }

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
        filePath.startsWith(`${home}/.companion/envs/`) ||
        filePath.startsWith(`${home}/.companion/auto-approval/`)) {
      return true;
    }
    // Port-specific companion settings (e.g. settings-3456.json)
    if (filePath.startsWith(`${home}/.companion/`) && /settings(-\d+)?\.json$/.test(filePath)) {
      return true;
    }
    // ~/.claude.json (user-level MCP config at home root)
    if (filePath === `${home}/.claude.json`) return true;
    return false;
  }

  /** Check if a Bash command targets sensitive config files (CLAUDE.md, hooks, settings, etc.).
   *  Used to skip LLM auto-approval for commands that could modify agent behavior. */
  private static isSensitiveBashCommand(command: string): boolean {
    if (!command) return false;
    const sensitive = [
      "CLAUDE.md", ".claude/settings", ".claude/hooks/", ".claude/commands/",
      ".claude/agents/", ".claude/skills/", ".mcp.json", ".claude.json",
      ".companion/settings", ".companion/auto-approval/", ".companion/envs/",
    ];
    return sensitive.some(p => command.includes(p));
  }

  // Tools that are auto-approved in acceptEdits mode (everything except Bash).
  // In bypassPermissions mode, all tools are auto-approved EXCEPT those in NEVER_AUTO_APPROVE.
  private static readonly ACCEPT_EDITS_AUTO_APPROVE = new Set([
    "Edit", "Write", "Read", "MultiEdit", "NotebookEdit",
    "Glob", "Grep", "WebFetch", "WebSearch",
    "TodoWrite", "Task", "Skill",
  ]);

  private async handleControlRequest(session: Session, msg: CLIControlRequestMessage) {
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
      // Sensitive file edits and Bash commands targeting config files always
      // require human review — never sent to the LLM auto-approver.
      const bashCommand = toolName === "Bash" ? String(msg.request.input.command ?? "") : "";
      const autoApprovalConfig = (
        session.backendType === "claude" &&
        !NEVER_AUTO_APPROVE.has(toolName) &&
        !(isFileEdit && WsBridge.isSensitiveConfigPath(filePath)) &&
        !(toolName === "Bash" && WsBridge.isSensitiveBashCommand(bashCommand))
      ) ? await shouldAttemptAutoApproval(
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
        ...(autoApprovalConfig ? { evaluating: "queued" as const } : {}),
      };
      session.pendingPermissions.set(msg.request_id, perm);

      this.broadcastToBrowsers(session, {
        type: "permission_request",
        request: perm,
      });

      // NOTE: Takode permission_request event is NOT emitted here.
      // It's deferred until auto-approval decides (if auto-approval is configured).
      // If no auto-approval, it's emitted immediately in Path B below.

      if (autoApprovalConfig) {
        // Path A: LLM auto-approval available — show collapsed spinner in browser,
        // defer attention/notifications until LLM evaluation completes.
        this.persistSession(session);
        this.tryLlmAutoApproval(session, msg.request_id, perm, autoApprovalConfig);
      } else {
        // Path B: Normal flow — immediate attention + notification.
        this.setAttention(session, "action");
        this.persistSession(session);

        // Takode: emit permission_request only when it actually needs human attention
        this.emitTakodeEvent(session.id, "permission_request", {
          tool_name: perm.tool_name,
          request_id: perm.request_id,
          summary: perm.description || perm.tool_name,
          ...this.buildPermissionPreview(perm),
        });

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
    config: AutoApprovalConfig,
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
        config,
        abort.signal,
        recentToolCalls,
        session.state.model,
        // onAcquired: transition from "queued" → "evaluating" in browser
        () => {
          if (!session.pendingPermissions.has(requestId)) return;
          perm.evaluating = "evaluating";
          this.broadcastToBrowsers(session, {
            type: "permission_evaluating_status",
            request_id: requestId,
            evaluating: "evaluating",
            timestamp: Date.now(),
          });
        },
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
          summary: getAutoApprovalSummary(perm.tool_name, perm.input),
          timestamp: Date.now(),
        });

        console.log(`[auto-approver] Auto-approved ${perm.tool_name} for session ${sessionTag(session.id)}: ${result.reason}`);
        this.persistSession(session);
      } else {
        // LLM denied or failed (null) — transition to normal pending state.
        // Clear the evaluating flag so the browser shows full approval UI.
        perm.evaluating = undefined;

        this.broadcastToBrowsers(session, {
          type: "permission_needs_attention",
          request_id: requestId,
          timestamp: Date.now(),
        });

        // Takode: emit permission_request NOW — auto-approval deferred, human needs to act
        this.emitTakodeEvent(session.id, "permission_request", {
          tool_name: perm.tool_name,
          request_id: perm.request_id,
          summary: perm.description || perm.tool_name,
          ...this.buildPermissionPreview(perm),
        });

        // NOW set attention and schedule notifications
        this.setAttention(session, "action");
        if (this.pushoverNotifier) {
          const eventType = perm.tool_name === "AskUserQuestion" ? "question" as const : "permission" as const;
          const detail = perm.tool_name + (perm.description ? `: ${perm.description}` : "");
          this.pushoverNotifier.scheduleNotification(session.id, eventType, detail, requestId);
        }

        if (result?.decision === "defer") {
          console.log(`[auto-approver] LLM deferred ${perm.tool_name} for session ${sessionTag(session.id)}: ${result.reason}`);
        } else {
          console.log(`[auto-approver] LLM evaluation failed/timed out for ${perm.tool_name} in session ${sessionTag(session.id)}, deferring to user`);
        }
        this.persistSession(session);
      }
    } catch (err) {
      session.evaluatingAborts.delete(requestId);

      // Fail-safe: if anything goes wrong, transition to normal pending
      if (session.pendingPermissions.has(requestId)) {
        perm.evaluating = undefined;
        this.broadcastToBrowsers(session, {
          type: "permission_needs_attention",
          request_id: requestId,
          timestamp: Date.now(),
        });
        // Takode: emit permission_request on fail-safe escalation too
        this.emitTakodeEvent(session.id, "permission_request", {
          tool_name: perm.tool_name,
          request_id: perm.request_id,
          summary: perm.description || perm.tool_name,
          ...this.buildPermissionPreview(perm),
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

    const toolResults = content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
    const previews = this.buildToolResultPreviews(session, toolResults);

    if (previews.length === 0) return;

    const browserMsg: BrowserIncomingMessage = {
      type: "tool_result_preview",
      previews,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);
  }

  /**
   * Convert tool_result blocks into ToolResultPreview entries and index full payloads.
   * Shared by Claude and Codex paths to keep Terminal result rendering consistent.
   */
  private buildToolResultPreviews(
    session: Session,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ): ToolResultPreview[] {
    const previews: ToolResultPreview[] = [];

    for (const block of toolResults) {
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

    return previews;
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

    // User opened the permission dialog — cancel in-flight auto-approval
    // Handled before the Codex/Claude branch since pendingPermissions is shared
    if (msg.type === "permission_user_viewing") {
      const reqId = msg.request_id;
      const perm = session.pendingPermissions.get(reqId);
      if (perm?.evaluating) {
        this.abortAutoApproval(session, reqId);
        perm.evaluating = undefined;

        this.broadcastToBrowsers(session, {
          type: "permission_needs_attention",
          request_id: reqId,
          timestamp: Date.now(),
        });

        this.setAttention(session, "action");

        console.log(`[ws-bridge] Auto-approval cancelled for ${perm.tool_name} in session ${sessionTag(session.id)} — user opened dialog`);
        this.persistSession(session);
      }
      return;
    }

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
        "set_model", "set_permission_mode", "set_codex_reasoning_effort",
      ]);
      if (activityTypes.has(msg.type)) {
        this.launcher.touchActivity(session.id);
      }
    }

    // For Codex sessions, delegate entirely to the adapter
    if (session.backendType === "codex") {
      let userImageRefs: import("./image-store.js").ImageRef[] | undefined;
      let codexUserMessageId: string | null = null;

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
        userImageRefs = imageRefs;
        const userHistoryEntry: BrowserIncomingMessage = {
          type: "user_message",
          content: msg.content,
          timestamp: ts,
          id: `user-${ts}-${this.userMsgCounter++}`,
          ...(imageRefs?.length ? { images: imageRefs } : {}),
        };
        codexUserMessageId = userHistoryEntry.id || null;
        session.messageHistory.push(userHistoryEntry);
        session.lastUserMessage = (msg.content || "").slice(0, 80);
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
        // Takode: permission_resolved (Codex path)
        if (pending) {
          this.emitTakodeEvent(session.id, "permission_resolved", {
            tool_name: pending.tool_name,
            outcome: msg.behavior === "allow" ? "approved" : "denied",
          });
        }
        this.persistSession(session);
      }

      if (msg.type === "set_model") {
        this.handleCodexSetModel(session, msg.model);
        return;
      }
      if (msg.type === "set_permission_mode") {
        this.handleCodexSetPermissionMode(session, msg.mode);
        return;
      }
      if (msg.type === "set_codex_reasoning_effort") {
        this.handleCodexSetReasoningEffort(session, msg.effort);
        return;
      }

      // Prefer local image paths for Codex user turns so thread history stores
      // compact local references instead of large data: URLs. If any path can't
      // be resolved, fall back to compressed inline base64 payloads.
      let adapterMsg: BrowserOutgoingMessage = msg;
      if (msg.type === "user_message" && msg.images?.length) {
        let localImagePaths: string[] | undefined;

        if (this.imageStore && userImageRefs?.length === msg.images.length) {
          const paths: string[] = [];
          const imageStoreForCodex = this.imageStore as ImageStore & {
            getTransportPath?: (sessionId: string, imageId: string) => Promise<string | null>;
          };
          for (const ref of userImageRefs) {
            const transportPath = imageStoreForCodex.getTransportPath
              ? await imageStoreForCodex.getTransportPath(session.id, ref.imageId)
              : null;
            if (!transportPath) {
              paths.length = 0;
              break;
            }
            paths.push(transportPath);
          }
          if (paths.length === msg.images.length) localImagePaths = paths;
        }

        if (localImagePaths?.length) {
          const localMsg = { ...msg, local_images: localImagePaths } as BrowserOutgoingMessage;
          delete (localMsg as { images?: unknown }).images;
          adapterMsg = localMsg;
        } else if (this.imageStore) {
          const compressedImages: { media_type: string; data: string }[] = [];
          for (const img of msg.images) {
            const { base64, mediaType } = await this.imageStore.compressForTransport(img.data, img.media_type);
            compressedImages.push({ media_type: mediaType, data: base64 });
          }
          adapterMsg = { ...msg, images: compressedImages };
        }
      }

      // Track the in-flight Codex user turn so we can reconcile/resume
      // correctly if the transport drops right after turn/start.
      if (msg.type === "user_message") {
        session.pendingCodexTurnRecovery = {
          adapterMsg,
          userMessageId: codexUserMessageId || `user-recovery-${Date.now()}`,
          userContent: msg.content || "",
          turnId: null,
          disconnectedAt: null,
        };
      }

      if (session.codexAdapter) {
        session.codexAdapter.sendBrowserMessage(adapterMsg);
      } else {
        // Adapter not yet attached — queue for when it's ready.
        // The adapter itself also queues during init, but this covers
        // the window between session creation and adapter attachment.
        console.log(`[ws-bridge] Codex adapter not yet attached for session ${sessionTag(session.id)}, queuing ${msg.type}`);
        session.pendingMessages.push(JSON.stringify(adapterMsg));
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

      case "set_codex_reasoning_effort":
        // Claude sessions ignore this Codex-only message type.
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
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[]; agentSource?: { sessionId: string; sessionLabel?: string } }
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
      ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
    };
    session.messageHistory.push(userHistoryEntry);
    // Broadcast user message to all browsers (server-authoritative: browsers
    // never add user messages locally, they render only what the server sends)
    this.broadcastToBrowsers(session, userHistoryEntry);

    this.emitTakodeEvent(session.id, "user_message", {
      content: (msg.content || "").slice(0, 120),
      ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
    });

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

    // Role-prefix for orchestrator sessions: the CLI sees [User], [Herd], or [Agent] tags
    // so the orchestrator can distinguish message sources. History/browser keep original content.
    const isOrch = this.launcher?.getSession(session.id)?.isOrchestrator;
    if (isOrch && typeof content === "string") {
      const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (msg.agentSource?.sessionId === "herd-events") {
        content = `[Herd ${time}] ${content}`;
      } else if (msg.agentSource) {
        const label = msg.agentSource.sessionLabel || msg.agentSource.sessionId.slice(0, 8);
        content = `[Agent ${label} ${time}] ${content}`;
      } else {
        content = `[User ${time}] ${content}`;
      }
    }

    const ndjson = JSON.stringify({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: msg.session_id || session.state.session_id || "",
    });
    this.sendToCLI(session, ndjson);
    // Track the outbound user message so we can re-queue it if the CLI
    // disconnects mid-turn (before sending a result). On --resume reconnect,
    // the CLI's internal checkpoint won't include the in-flight message.
    session.lastOutboundUserNdjson = ndjson;
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

      // Takode: permission_resolved (approved) — emit for all approvals, not just notable ones
      if (pending) {
        this.emitTakodeEvent(session.id, "permission_resolved", {
          tool_name: pending.tool_name,
          outcome: "approved",
        });
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

      // Takode: permission_resolved (denied)
      this.emitTakodeEvent(session.id, "permission_resolved", {
        tool_name: pending?.tool_name || "unknown",
        outcome: "denied",
      });
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

  private handleCodexSetModel(session: Session, model: string) {
    const nextModel = model.trim();
    if (!nextModel || session.state.model === nextModel) return;
    session.state.model = nextModel;
    const launchInfo = this.launcher?.getSession(session.id);
    if (launchInfo) launchInfo.model = nextModel;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { model: nextModel },
    });
    this.persistSession(session);
    this.onSessionRelaunchRequested?.(session.id);
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
    // Also update the launcher's stored mode so CLI relaunch uses the latest
    // mode, not the one from session creation (which is typically "plan").
    const launcherInfo = this.launcher?.getSession(session.id);
    if (launcherInfo) launcherInfo.permissionMode = mode;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { permissionMode: mode, uiMode },
    });
    this.persistSession(session);
  }

  private handleCodexSetPermissionMode(session: Session, mode: string) {
    if (!mode || session.state.permissionMode === mode) return;

    // Auto-resolve pending permission requests before relaunch.
    // When switching to bypassPermissions (auto), approve pending requests so the
    // Codex thread doesn't get stuck with unresolved approvals after process kill.
    // For other transitions, cancel them — the new session uses the new policy.
    if (session.pendingPermissions.size > 0) {
      const approve = mode === "bypassPermissions";
      for (const [reqId, perm] of session.pendingPermissions) {
        // Send response to adapter so the JSON-RPC request is answered before
        // the process is killed. Without this, the resumed thread has an
        // unresolved approval and gets stuck permanently.
        if (session.codexAdapter) {
          session.codexAdapter.sendBrowserMessage({
            type: "permission_response",
            request_id: reqId,
            behavior: approve ? "allow" : "deny",
          } as BrowserOutgoingMessage);
        }
        // Broadcast UI resolution
        if (approve) {
          const approvedMsg: BrowserIncomingMessage = {
            type: "permission_approved",
            id: `approval-${reqId}`,
            request_id: reqId,
            tool_name: perm.tool_name,
            tool_use_id: perm.tool_use_id,
            summary: getApprovalSummary(perm.tool_name, perm.input),
            timestamp: Date.now(),
          };
          session.messageHistory.push(approvedMsg);
          this.broadcastToBrowsers(session, approvedMsg);
        } else {
          this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
        }
        // Clean up associated auto-approval / notification state
        this.abortAutoApproval(session, reqId);
        this.pushoverNotifier?.cancelPermission(session.id, reqId);
        // Emit herd event for orchestator visibility
        this.emitTakodeEvent(session.id, "permission_resolved", {
          tool_name: perm.tool_name,
          outcome: approve ? "approved" : "denied",
        });
      }
      session.pendingPermissions.clear();
      this.clearActionAttentionIfNoPermissions(session);
    }

    session.state.permissionMode = mode;
    const launchInfo = this.launcher?.getSession(session.id);
    if (launchInfo) launchInfo.permissionMode = mode;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { permissionMode: mode },
    });
    this.persistSession(session);

    // Delay relaunch to let the adapter's async outgoing dispatch chain process
    // the permission responses above. The relaunch kills the old process
    // synchronously (SIGTERM), so without this delay the responses would be
    // enqueued but never flushed to the Codex process stdin.
    setTimeout(() => {
      this.onSessionRelaunchRequested?.(session.id);
    }, 100);
  }

  private handleCodexSetReasoningEffort(session: Session, effort: string) {
    const normalized = effort.trim();
    const next = normalized || undefined;
    if (session.state.codex_reasoning_effort === next) return;
    session.state.codex_reasoning_effort = next;
    const launchInfo = this.launcher?.getSession(session.id);
    if (launchInfo) launchInfo.codexReasoningEffort = next;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { codex_reasoning_effort: next },
    });
    this.persistSession(session);
    this.onSessionRelaunchRequested?.(session.id);
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
      // Send failure means the socket is dead — close it so the auto-relaunch
      // mechanism can kick in (either from handleCLIClose or browser reconnect).
      console.warn(`[ws-bridge] CLI send failed for session ${sessionTag(session.id)}, closing dead socket:`, err);
      try { session.cliSocket.close(); } catch { /* already dead */ }
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

  /** Track quest lifecycle commands from Codex Bash tool_use blocks. */
  private trackCodexQuestCommands(session: Session, content: ContentBlock[]): void {
    for (const block of content) {
      if (block.type !== "tool_use" || block.name !== "Bash") continue;
      const command = typeof block.input.command === "string" ? block.input.command : "";
      if (!command) continue;
      const parsed = parseQuestLifecycleCommand(command);
      if (!parsed) continue;
      session.pendingQuestCommands.set(block.id, parsed);
    }
  }

  /** Apply quest lifecycle updates from successful Codex Bash tool_result blocks. */
  private reconcileCodexQuestToolResult(
    session: Session,
    toolResult: Extract<ContentBlock, { type: "tool_result" }>,
  ): void {
    const pending = session.pendingQuestCommands.get(toolResult.tool_use_id);
    if (!pending) return;
    session.pendingQuestCommands.delete(toolResult.tool_use_id);
    if (toolResult.is_error) return;

    const raw = typeof toolResult.content === "string"
      ? toolResult.content
      : JSON.stringify(toolResult.content);
    const parsedResult = parseQuestLifecycleResult(raw);
    if (!parsedResult) return;

    const questId = parsedResult?.questId || pending.questId;
    const status = parsedResult?.status || pending.targetStatus;
    const title = parsedResult?.title || session.state.claimedQuestTitle || questId;
    if (!questId || !status) return;

    if (status === "done") {
      if (session.state.claimedQuestId === questId) {
        this.setSessionClaimedQuest(session.id, null);
      }
      return;
    }

    this.setSessionClaimedQuest(session.id, { id: questId, title, status });
    if (status !== "in_progress") return;

    const alreadyTracked = session.taskHistory.some(
      (entry) => entry.source === "quest" && entry.questId === questId,
    );
    if (alreadyTracked) return;

    let triggerMsgId = `quest-${questId}`;
    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      const msg = session.messageHistory[i];
      if (msg.type === "user_message" && msg.id) {
        triggerMsgId = msg.id;
        break;
      }
    }

    this.addTaskEntry(session.id, {
      title,
      action: "new",
      timestamp: Date.now(),
      triggerMessageId: triggerMsgId,
      source: "quest",
      questId,
    });
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

  /** Update titles of all task history entries linked to a quest, then broadcast. */
  updateQuestTaskEntries(sessionId: string, questId: string, newTitle: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    let changed = false;
    for (const entry of session.taskHistory) {
      if (entry.source === "quest" && entry.questId === questId && entry.title !== newTitle) {
        entry.title = newTitle;
        changed = true;
      }
    }
    if (changed) {
      this.broadcastTaskHistory(session);
      this.persistSession(session);
    }
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

  private reconcileCodexResumedTurn(session: Session, snapshot: CodexResumeSnapshot): void {
    const pending = session.pendingCodexTurnRecovery;
    const lastTurn = snapshot.lastTurn;
    if (!pending || !lastTurn) return;

    const pendingText = pending.userContent.trim();
    const resumedUserText = this.extractUserTextFromResumedTurn(lastTurn).trim();
    const matchesTurnId = !!pending.turnId && pending.turnId === lastTurn.id;
    const matchesText = !!pendingText && pendingText === resumedUserText;
    if (!matchesTurnId && !matchesText) return;

    const nonUserItems = lastTurn.items.filter((item) => item.type !== "userMessage");
    if (nonUserItems.length === 0) {
      console.log(
        `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} has only user input; retrying message`,
      );
      this.retryPendingCodexTurn(session, pending);
      return;
    }

    const recovered = this.recoverAgentMessagesFromResumedTurn(session, lastTurn, pending);
    session.pendingCodexTurnRecovery = null;
    if (recovered > 0) {
      this.persistSession(session);
      return;
    }

    console.warn(
      `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} has non-user items but no recoverable agentMessage text; skipping auto-retry to avoid duplicate side effects`,
    );
    this.broadcastToBrowsers(session, {
      type: "error",
      message:
        "Codex disconnected mid-turn and resumed with non-text tool activity. " +
        "Automatic retry was skipped to avoid duplicate side effects.",
    });
    this.persistSession(session);
  }

  private extractUserTextFromResumedTurn(turn: CodexResumeTurnSnapshot): string {
    for (const item of turn.items) {
      if (item.type !== "userMessage") continue;
      const content = Array.isArray(item.content) ? item.content : [];
      const textParts: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const rec = part as Record<string, unknown>;
        if (rec.type === "text" && typeof rec.text === "string") {
          textParts.push(rec.text);
        }
      }
      if (textParts.length > 0) return textParts.join("\n");
    }
    return "";
  }

  private retryPendingCodexTurn(session: Session, pending: PendingCodexTurnRecovery): void {
    const nextPending: PendingCodexTurnRecovery = {
      ...pending,
      turnId: null,
      disconnectedAt: null,
    };
    session.pendingCodexTurnRecovery = nextPending;
    this.setGenerating(session, true, "codex_resume_retry");
    this.broadcastToBrowsers(session, { type: "status_change", status: "running" });

    if (session.codexAdapter) {
      const ok = session.codexAdapter.sendBrowserMessage(pending.adapterMsg);
      if (!ok) {
        session.pendingMessages.push(JSON.stringify(pending.adapterMsg));
      }
    } else {
      session.pendingMessages.push(JSON.stringify(pending.adapterMsg));
    }
    this.persistSession(session);
  }

  private recoverAgentMessagesFromResumedTurn(
    session: Session,
    turn: CodexResumeTurnSnapshot,
    pending: PendingCodexTurnRecovery,
  ): number {
    let recovered = 0;
    const baseTs = pending.disconnectedAt ?? Date.now();

    for (let i = 0; i < turn.items.length; i++) {
      const item = turn.items[i];
      if (item.type !== "agentMessage") continue;
      const text = typeof item.text === "string" ? item.text : "";
      if (!text.trim()) continue;

      const itemId = typeof item.id === "string" ? item.id : `${turn.id}-${i}`;
      const assistantId = `codex-recovered-${itemId}`;
      const alreadyExists = session.messageHistory.some((m) => (
        m.type === "assistant" && m.message?.id === assistantId
      ));
      if (alreadyExists) continue;

      const assistant: BrowserIncomingMessage = {
        type: "assistant",
        message: {
          id: assistantId,
          type: "message",
          role: "assistant",
          model: session.state.model || "gpt-5.3-codex",
          content: [{ type: "text", text }],
          stop_reason: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        timestamp: baseTs + i + 1,
      };
      session.messageHistory.push(assistant);
      this.broadcastToBrowsers(session, assistant);
      recovered++;
    }

    return recovered;
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

      // Takode: turn_start
      this.emitTakodeEvent(session.id, "turn_start", {
        reason,
        userMessage: session.lastUserMessage?.slice(0, 120),
      });
    } else {
      const elapsed = session.generationStartedAt ? Date.now() - session.generationStartedAt : 0;
      session.generationStartedAt = null;
      session.stuckNotifiedAt = null;
      console.log(`[ws-bridge] Generation ended for session ${sessionTag(session.id)} (${reason}, duration: ${elapsed}ms)`);
      this.recorder?.recordServerEvent(session.id, "generation_ended", { reason, elapsed }, session.backendType, session.state.cwd);

      // Takode: turn_end with tool summary from the last turn
      const toolSummary = this.buildTurnToolSummary(session);
      this.emitTakodeEvent(session.id, "turn_end", {
        reason,
        duration_ms: elapsed,
        ...toolSummary,
      });

      // Herd event dispatcher: notify if this is an orchestrator finishing a turn
      if (this.herdEventDispatcher) {
        const info = this.launcher?.getSession(session.id);
        if (info?.isOrchestrator) {
          this.herdEventDispatcher.onOrchestratorTurnEnd(session.id);
        }
      }
    }
  }

  /** Build a preview of a permission request for inclusion in takode events.
   *  For AskUserQuestion: first question text. For ExitPlanMode: truncated plan. */
  private buildPermissionPreview(perm: PermissionRequest): Record<string, unknown> {
    if (perm.tool_name === "AskUserQuestion") {
      const questions = perm.input.questions as Array<{ question: string; options?: Array<{ label: string }> }> | undefined;
      if (questions?.[0]) {
        return {
          question: questions[0].question,
          options: questions[0].options?.map(o => o.label),
        };
      }
    }
    if (perm.tool_name === "ExitPlanMode") {
      const plan = typeof perm.input.plan === "string" ? perm.input.plan.slice(0, 200) : undefined;
      return plan ? { planPreview: plan } : {};
    }
    return {};
  }

  /** Scan backwards through messageHistory to build a tool usage summary for the last turn. */
  private buildTurnToolSummary(session: Session): Record<string, unknown> {
    const toolCounts: Record<string, number> = {};
    let resultPreview: string | undefined;
    const history = session.messageHistory;

    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      // Stop at the last user message or result (previous turn boundary)
      if (msg.type === "user_message" || msg.type === "result") {
        if (msg.type === "result") {
          const data = (msg as { data?: { result?: string } }).data;
          resultPreview = data?.result?.slice(0, 200);
        }
        break;
      }
      // Count tool_use blocks from assistant messages
      if (msg.type === "assistant") {
        const content = (msg as { message?: { content?: ContentBlock[] } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
            }
          }
        }
      }
    }

    return {
      tools: Object.keys(toolCounts).length > 0 ? toolCounts : undefined,
      resultPreview,
    };
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
    const serStart = performance.now();
    const json = JSON.stringify(this.sequenceEvent(session, msg));
    const serMs = performance.now() - serStart;
    if (serMs > 50) {
      console.warn(`[ws-bridge] Slow JSON.stringify in broadcastToBrowsers: ${serMs.toFixed(1)}ms, type=${msg.type}, len=${json.length}, session=${sessionTag(session.id)}`);
    }

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
