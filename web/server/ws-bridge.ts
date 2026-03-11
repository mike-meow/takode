import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { readFile as readFileAsync, stat as statAsync } from "node:fs/promises";
import { GIT_CMD_TIMEOUT } from "./constants.js";
import { getDefaultModelForBackend } from "../shared/backend-defaults.js";
import { computeHistoryMessagesSyncHash, computeHistoryPrefixSyncHash } from "../shared/history-sync-hash.js";

const execPromise = promisify(execCb);
const TOOL_PROGRESS_OUTPUT_LIMIT = 12_000;

const GIT_SHA_REF_RE = /^[0-9a-f]{7,40}$/i;
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { PushoverNotifier } from "./pushover.js";
import { getTrafficMessageType, trafficStats, type TrafficStatsSnapshot } from "./traffic-stats.js";
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
  CodexOutboundTurn,
  PendingCodexInput,
  PendingCodexInputImageDraft,
  VsCodeSelectionState,
  VsCodeWindowState,
  VsCodeOpenFileCommand,
  TakodeEvent,
  TakodeEventDataByType,
  TakodeEventFor,
  TakodeEventType,
  TakodePermissionRequestEventData,
  TakodeEventSubscriber,
  TakodeTurnEndEventData,
} from "./session-types.js";
import { TOOL_RESULT_PREVIEW_LIMIT, assertNever } from "./session-types.js";
import type { SessionStore } from "./session-store.js";
import type { CodexResumeSnapshot, CodexResumeTurnSnapshot, CodexSessionMeta } from "./codex-adapter.js";
import type { ClaudeSdkSessionMeta } from "./claude-sdk-adapter.js";
import type { RecorderManager } from "./recorder.js";
import type { ImageStore } from "./image-store.js";
import type { CliLauncher } from "./cli-launcher.js";
import * as gitUtils from "./git-utils.js";
import { sessionTag } from "./session-tag.js";
import { evaluatePermission, type RecentToolCall } from "./auto-approver.js";
import type { AutoApprovalConfig } from "./auto-approval-store.js";
import type { PerfTracer } from "./perf-tracer.js";
import {
  NEVER_AUTO_APPROVE,
  handlePermissionRequest as handlePermissionRequestPipeline,
  type PermissionPipelineResult,
  isSensitiveBashCommand as isSensitiveBashCommandPolicy,
  isSensitiveConfigPath as isSensitiveConfigPathPolicy,
} from "./bridge/permission-pipeline.js";
import { detectQuestEvent, type QuestLifecycleStatus } from "./bridge/quest-detector.js";
import {
  clearOptimisticRunningTimer as clearOptimisticRunningTimerLifecycle,
  getQueuedTurnLifecycleEntries as getQueuedTurnLifecycleEntriesLifecycle,
  markRunningFromUserDispatch as markRunningFromUserDispatchLifecycle,
  markTurnInterrupted as markTurnInterruptedLifecycle,
  promoteNextQueuedTurn as promoteNextQueuedTurnLifecycle,
  reconcileTerminalResultState as reconcileTerminalResultStateLifecycle,
  replaceQueuedTurnLifecycleEntries as replaceQueuedTurnLifecycleEntriesLifecycle,
  setGenerating as setGeneratingLifecycle,
  type InterruptSource as GenerationInterruptSource,
  type UserDispatchTurnTarget,
  trackUserMessageForTurn as trackUserMessageForTurnLifecycle,
} from "./bridge/generation-lifecycle.js";
import type {
  BackendAdapter,
  CurrentTurnIdAwareAdapter,
  RateLimitsAwareAdapter,
  TurnSteerFailedAwareAdapter,
  TurnStartedAwareAdapter,
  TurnSteeredAwareAdapter,
  TurnStartFailedAwareAdapter,
} from "./bridge/adapter-interface.js";

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

/** Tools whose approvals appear as chat messages (same set — interactive tools need visible records). */
const NOTABLE_APPROVALS = NEVER_AUTO_APPROVE;

/** MIME type to file extension mapping for image file path derivation (must match image-store.ts). */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpeg", "image/jpg": "jpg",
  "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
  "image/bmp": "bmp", "image/tiff": "tiff", "image/avif": "avif",
  "image/heic": "heic", "image/heif": "heif",
};

type ImageRefForAttachmentPath = { imageId: string; media_type: string };

function deriveAttachmentPaths(sessionId: string, imageRefs: ImageRefForAttachmentPath[]): string[] {
  const imgDir = join(homedir(), ".companion", "images", sessionId);
  return imageRefs.map((ref) => {
    const ext = MIME_TO_EXT[ref.media_type] || "bin";
    return join(imgDir, `${ref.imageId}.orig.${ext}`);
  });
}

function formatAttachmentPathAnnotation(paths: string[]): string {
  if (paths.length === 0) return "";
  const numbered = paths
    .map((path, idx) => `Attachment ${idx + 1}: ${path}`)
    .join("\n");
  return `\n[📎 Inline image file paths (same order as images above):\n${numbered}]`;
}

function buildPendingCodexImageDrafts(
  images: { media_type: string; data: string }[] | undefined,
): PendingCodexInputImageDraft[] | undefined {
  if (!images?.length) return undefined;
  return images.map((img, idx) => ({
    name: `attachment-${idx + 1}.${MIME_TO_EXT[img.media_type] || "bin"}`,
    base64: img.data,
    mediaType: img.media_type,
  }));
}

const MAX_ADAPTER_RELAUNCH_FAILURES = 3;
const ADAPTER_FAILURE_RESET_WINDOW_MS = 120_000;
const CODEX_INTENTIONAL_RELAUNCH_GUARD_MS = 15_000;
const CODEX_RETRY_SAFE_RESUME_ITEM_TYPES: ReadonlySet<string> = new Set(["reasoning", "contextCompaction"]);
const CODEX_TOOL_RESULT_WATCHDOG_MS = 120_000;

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

type LeaderAssistantAddressing = "not_leader" | "user" | "self" | "missing";
type TurnTriggerSource = "user" | "leader" | "system" | "unknown";
type InterruptSource = GenerationInterruptSource;
type CodexBridgeAdapter = BackendAdapter<CodexSessionMeta>
  & TurnStartedAwareAdapter
  & TurnSteeredAwareAdapter
  & TurnSteerFailedAwareAdapter
  & TurnStartFailedAwareAdapter
  & CurrentTurnIdAwareAdapter
  & RateLimitsAwareAdapter
  & Partial<{ refreshSkills: (forceReload?: boolean) => Promise<string[]> }>;
type ClaudeSdkBridgeAdapter = BackendAdapter<ClaudeSdkSessionMeta>;

interface Session {
  id: string;
  backendType: BackendType;
  backendSocket: ServerWebSocket<SocketData> | null;
  codexAdapter: CodexBridgeAdapter | null;
  claudeSdkAdapter: ClaudeSdkBridgeAdapter | null;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  state: SessionState;
  pendingPermissions: Map<string, PermissionRequest>;
  /** Pending control_requests sent TO CLI, keyed by request_id */
  pendingControlRequests: Map<string, PendingControlRequest>;
  messageHistory: BrowserIncomingMessage[];
  /** Number of history entries that belong to the frozen prefix persisted in the append-only log. */
  frozenCount: number;
  /** Messages queued while waiting for CLI to connect */
  pendingMessages: string[];
  /** Authoritative Codex outbound user-turn queue (persisted across disconnect/relaunch). */
  pendingCodexTurns: CodexOutboundTurn[];
  /** Codex inputs accepted by Takode but not yet delivered to Codex. */
  pendingCodexInputs: PendingCodexInput[];
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
  /** Retained live tool output tails (tool_use_id -> output) for transcript fallback. */
  toolProgressOutput: Map<string, string>;
  /** Parsed quest lifecycle commands pending completion, keyed by tool_use_id. */
  pendingQuestCommands: Map<string, { questId: string; targetStatus?: QuestLifecycleStatus }>;
  /** Set after compact_boundary; the next user text message is the summary */
  awaitingCompactSummary?: boolean;
  /** Accumulates content blocks for assistant messages with the same ID (parallel tool calls) */
  assistantAccumulator: Map<string, { contentBlockIds: Set<string> }>;
  /** Wall-clock start times for tool calls (tool_use_id → Date.now()). Transient, not persisted. */
  toolStartTimes: Map<string, number>;
  /** Cheap fingerprint of linked-worktree metadata used to skip unnecessary git refreshes. */
  worktreeStateFingerprint: string;
  /** Codex-only watchdog timers for tool calls that started but never produced tool_result. */
  codexToolResultWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
  /** Whether the CLI is actively generating a response (transient, not persisted) */
  isGenerating: boolean;
  /** When isGenerating became true (epoch ms), for stuck detection + timer restore */
  generationStartedAt: number | null;
  /** Quest status snapshot at turn start, for detecting changes in turn_end events */
  questStatusAtTurnStart: string | null;
  /** Message history length at turn start, for computing message ID range in turn_end */
  messageCountAtTurnStart: number;
  /** Set when handleInterrupt is called during generation, cleared at turn end */
  interruptedDuringTurn: boolean;
  /** Source of the current turn interruption (if interruptedDuringTurn=true). */
  interruptSourceDuringTurn: InterruptSource | null;
  /** Consecutive SDK/adapter disconnect count without a successful turn completion.
   *  Used to cap auto-relaunch attempts and prevent infinite respawn loops. */
  consecutiveAdapterFailures: number;
  /** Timestamp of the latest adapter disconnect failure for decay/reset windows. */
  lastAdapterFailureAt: number | null;
  /** Expected disconnect deadline for an intentional Codex relaunch. */
  intentionalCodexRelaunchUntil: number | null;
  /** Debug label for the current intentional Codex relaunch guard. */
  intentionalCodexRelaunchReason: string | null;
  /** Whether context compaction occurred during the current turn (for turn_end herd events) */
  compactedDuringTurn: boolean;
  /** Message history indices of user messages received during the current turn (for turn_end herd events) */
  userMessageIdsThisTurn: number[];
  /** Number of follow-up turns queued while a current turn is still running. */
  queuedTurnStarts: number;
  /** Dispatch reasons for queued follow-up turns (aligned with queuedTurnStarts). */
  queuedTurnReasons: string[];
  /** User message history IDs per queued follow-up turn. */
  queuedTurnUserMessageIds: number[][];
  /** Interrupt sources aligned with queued follow-up turns.
   *  A queued follow-up does not prove the active turn was interrupted. */
  queuedTurnInterruptSources: (InterruptSource | null)[];
  /** Whether system.init has been received since the last CLI connect.
   *  False during --resume replay — messages sent before init are dropped by CLI. */
  cliInitReceived: boolean;
  /** Last message received from CLI (epoch ms), for stuck detection */
  lastCliMessageAt: number;
  /** Last keep_alive or WebSocket ping from CLI (epoch ms), for disconnect diagnostics */
  lastCliPingAt: number;
  /** Last tool_progress for an Agent/Task sub-agent (epoch ms). Tracks whether
   *  async sub-agents are actively running — prevents false "stuck" warnings
   *  when the main agent is idle waiting for long-running sub-agents. */
  lastSubagentProgressAt: number;
  /** Optimistic running rollback timer started when a user message is dispatched. */
  optimisticRunningTimer: ReturnType<typeof setTimeout> | null;
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
  /** Set when the CLI reconnects within the grace period (token refresh, not relaunch).
   *  Consumed by system.init handler to skip force-clearing isGenerating. */
  seamlessReconnect: boolean;
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
  /** Debounce timer for clearing cliResuming after the last replayed system.init.
   *  The CLI replays ALL historical system.init messages (one per subagent),
   *  so we can't clear cliResuming on the first one — must wait for the replay
   *  to finish (no more system.init within the debounce window). */
  cliResumingClearTimer: ReturnType<typeof setTimeout> | null;
}

interface LeaderGroupIdleTimerState {
  timer: ReturnType<typeof setTimeout> | null;
  idleSince: number | null;
  notifiedWhileIdle: boolean;
  leaderUnreadSetByGroupIdle: boolean;
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
    backend_state: "disconnected",
    backend_error: null,
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

async function readWorktreeStateFingerprint(cwd: string): Promise<string | null> {
  try {
    const gitFile = await readFileAsync(join(cwd, ".git"), "utf-8");
    const match = gitFile.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return null;
    const gitDir = resolve(cwd, match[1].trim());
    const [headStat, indexStat] = await Promise.all([
      statAsync(join(gitDir, "HEAD")).catch(() => null),
      statAsync(join(gitDir, "index")).catch(() => null),
    ]);
    return [
      headStat ? `${headStat.mtimeMs}:${headStat.size}` : "missing",
      indexStat ? `${indexStat.mtimeMs}:${indexStat.size}` : "missing",
    ].join("|");
  } catch {
    return null;
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function inferContextWindowFromModel(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const normalized = model.toLowerCase();
  if (normalized.includes("[1m]") || normalized.includes("context-1m")) {
    return 1_000_000;
  }
  if (normalized.startsWith("claude-")) {
    // Claude models default to 200k unless explicitly marked as 1m.
    return 200_000;
  }
  return undefined;
}

function resolveResultContextWindow(
  model: string | undefined,
  modelUsage: CLIResultMessage["modelUsage"] | undefined,
): number | undefined {
  let fromUsage = 0;
  if (modelUsage) {
    for (const usage of Object.values(modelUsage)) {
      if (usage.contextWindow > 0) {
        fromUsage = Math.max(fromUsage, usage.contextWindow);
      }
    }
  }
  const fromModel = inferContextWindowFromModel(model) ?? 0;
  const resolved = Math.max(fromUsage, fromModel);
  return resolved > 0 ? resolved : undefined;
}

/** Token usage fields shared between assistant and result messages. */
interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Compute context fill % from token usage and a context window size.
 * Total tokens in context = input_tokens + cache_creation + cache_read + output_tokens.
 * These fields are mutually exclusive components (input_tokens excludes cached portions).
 */
function computeContextUsedPercent(usage: TokenUsage, contextWindow: number): number | undefined {
  const usedInContext =
    Number(usage.input_tokens || 0)
    + Number(usage.cache_creation_input_tokens || 0)
    + Number(usage.cache_read_input_tokens || 0)
    + Number(usage.output_tokens || 0);
  if (usedInContext <= 0) return undefined;

  const pct = Math.round((usedInContext / contextWindow) * 100);
  return clampPercent(pct);
}

/**
 * Compute context_used_percent from a turn result. Prefers the last assistant
 * message's per-turn usage (accurate context fill for one API call) over the
 * result message's cumulative session-total usage (which grows unbounded and
 * was the source of the inaccuracy bug — see q-86).
 */
function computeResultContextUsedPercent(
  model: string | undefined,
  msg: CLIResultMessage,
  lastAssistantUsage: TokenUsage | undefined,
): number | undefined {
  const contextWindow = resolveResultContextWindow(model, msg.modelUsage);
  if (!contextWindow) return undefined;

  // Prefer per-turn assistant usage — it reflects what actually fit in the
  // context window for the most recent API call.
  if (lastAssistantUsage) {
    return computeContextUsedPercent(lastAssistantUsage, contextWindow);
  }

  // Fallback: use the result's usage (cumulative). Still better than nothing
  // for the first turn or when assistant usage isn't available.
  if (!msg.usage) return undefined;
  return computeContextUsedPercent(msg.usage, contextWindow);
}

function computePreTokenContextUsedPercent(
  model: string | undefined,
  preTokens: number | undefined,
): number | undefined {
  if (!Number.isFinite(preTokens) || Number(preTokens) <= 0) return undefined;
  const contextWindow = resolveResultContextWindow(model, undefined);
  if (!contextWindow) return undefined;
  const pct = Math.round((Number(preTokens) / contextWindow) * 100);
  return clampPercent(pct);
}

function extractClaudeTokenDetails(
  modelUsage: CLIResultMessage["modelUsage"],
): SessionState["claude_token_details"] | undefined {
  if (!modelUsage) return undefined;
  const usage = Object.values(modelUsage).find((entry) => entry && typeof entry === "object");
  if (!usage) return undefined;

  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);
  const cachedInputTokens = Number(usage.cacheReadInputTokens || 0) + Number(usage.cacheCreationInputTokens || 0);
  const modelContextWindow = Number(usage.contextWindow || 0);

  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0 && modelContextWindow <= 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    modelContextWindow,
  };
}

// ─── Bridge ───────────────────────────────────────────────────────────────────

export class WsBridge {
  private static readonly EVENT_BUFFER_LIMIT = 600;
  private static readonly CODEX_ASSISTANT_REPLAY_DEDUP_WINDOW_MS = 15_000;
  private static readonly CODEX_ASSISTANT_REPLAY_SCAN_LIMIT = 200;
  private static readonly LEADER_GROUP_IDLE_NOTIFY_DELAY_MS = 10_000;
  private static readonly USER_MESSAGE_RUNNING_TIMEOUT_MS = 30_000;
  private static readonly PROCESSED_CLIENT_MSG_ID_LIMIT = 1000;
  private static readonly IDEMPOTENT_BROWSER_MESSAGE_TYPES = new Set<string>([
    "user_message",
    "vscode_selection_update",
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
  private herdEventDispatcher: { onOrchestratorTurnEnd(orchId: string): void; onOrchestratorDisconnect(orchId: string): void; getDiagnostics(orchId: string): Record<string, unknown> } | null = null;
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
  /** Server-authoritative custom session ordering by group key. */
  private sessionOrderByGroup = new Map<string, string[]>();
  /** Server-authoritative ordering for project groups in the sidebar. */
  private groupOrder: string[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Track recent CLI disconnects to detect mass disconnect events. */
  private recentCliDisconnects: number[] = [];
  /** Machine-global latest VSCode selection seen by the server. */
  private vscodeSelectionState: VsCodeSelectionState | null = null;
  /** Machine-global registry of running VSCode windows on this server machine. */
  private vscodeWindows = new Map<string, VsCodeWindowState>();
  /** Pending remote open-file commands keyed by VSCode window sourceId. */
  private vscodeOpenFileQueues = new Map<string, VsCodeOpenFileCommand[]>();
  /** In-flight browser requests waiting for extension-host open-file results. */
  private pendingVsCodeOpenResults = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  private static readonly VSCODE_WINDOW_STALE_MS = 30_000;
  private static readonly VSCODE_OPEN_FILE_TIMEOUT_MS = 8_000;

  // ── Takode orchestration event emitter ───────────────────────────────────
  private takodeSubscribers = new Set<TakodeEventSubscriber>();
  private takodeEventLog: TakodeEvent[] = [];
  private takodeEventNextId = 0;
  private static readonly TAKODE_EVENT_LOG_LIMIT = 1000;
  private sessionNameGetter: ((sessionId: string) => string) | null = null;
  private onGitInfoReady: ((sessionId: string, cwd: string, branch: string) => void) | null = null;
  private leaderGroupIdleStates = new Map<string, LeaderGroupIdleTimerState>();
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
  setInitialAskPermission(sessionId: string, askPermission: boolean, uiMode: "plan" | "agent" = "plan"): void {
    const session = this.getOrCreateSession(sessionId);
    session.state.askPermission = askPermission;
    session.state.uiMode = uiMode;
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

  /** Replace the full server-side session order map (startup restore path). */
  setSessionOrderState(orderByGroup: Record<string, string[]>): void {
    const next = new Map<string, string[]>();
    for (const [rawGroupKey, rawOrderedIds] of Object.entries(orderByGroup || {})) {
      const groupKey = rawGroupKey.trim();
      if (!groupKey || !Array.isArray(rawOrderedIds)) continue;
      const seen = new Set<string>();
      const orderedIds: string[] = [];
      for (const rawId of rawOrderedIds) {
        if (typeof rawId !== "string") continue;
        const id = rawId.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        orderedIds.push(id);
      }
      next.set(groupKey, orderedIds);
    }
    this.sessionOrderByGroup = next;
  }

  /** Snapshot the full server-side session order map. */
  getSessionOrderState(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [groupKey, orderedIds] of this.sessionOrderByGroup.entries()) {
      out[groupKey] = [...orderedIds];
    }
    return out;
  }

  /** Update one group's order and return the full normalized snapshot. */
  updateSessionOrder(groupKey: string, orderedIds: string[]): Record<string, string[]> {
    const key = groupKey.trim();
    if (!key) return this.getSessionOrderState();

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const rawId of orderedIds) {
      if (typeof rawId !== "string") continue;
      const id = rawId.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }

    if (normalized.length === 0) {
      this.sessionOrderByGroup.delete(key);
    } else {
      this.sessionOrderByGroup.set(key, normalized);
    }
    return this.getSessionOrderState();
  }

  /** Broadcast the latest session order to every connected browser socket. */
  broadcastSessionOrderUpdate(): void {
    const payload: BrowserIncomingMessage = {
      type: "session_order_update",
      sessionOrder: this.getSessionOrderState(),
    };
    for (const session of this.sessions.values()) {
      for (const ws of session.browserSockets) {
        this.sendToBrowser(ws, payload);
      }
    }
  }

  /** Replace server-side group order snapshot (startup restore path). */
  setGroupOrderState(order: string[]): void {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const rawKey of order || []) {
      if (typeof rawKey !== "string") continue;
      const key = rawKey.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      normalized.push(key);
    }
    this.groupOrder = normalized;
  }

  /** Snapshot the current group order. */
  getGroupOrderState(): string[] {
    return [...this.groupOrder];
  }

  /** Replace group order and return normalized snapshot. */
  updateGroupOrder(orderedGroupKeys: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const rawKey of orderedGroupKeys || []) {
      if (typeof rawKey !== "string") continue;
      const key = rawKey.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      normalized.push(key);
    }
    this.groupOrder = normalized;
    return this.getGroupOrderState();
  }

  /** Broadcast latest group order to every connected browser socket. */
  broadcastGroupOrderUpdate(): void {
    const payload: BrowserIncomingMessage = {
      type: "group_order_update",
      groupOrder: this.getGroupOrderState(),
    };
    for (const session of this.sessions.values()) {
      for (const ws of session.browserSockets) {
        this.sendToBrowser(ws, payload);
      }
    }
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
        if (session.backendSocket) {
          try {
            session.backendSocket.ping();
          } catch {
            // ping() threw — socket is already dead. Close it to trigger
            // handleCLIClose → auto-relaunch instead of leaving a ghost socket.
            console.warn(`[ws-bridge] CLI ping failed for session ${sessionTag(session.id)}, closing dead socket`);
            try { session.backendSocket.close(); } catch { /* already dead */ }
          }
        }
      }
    }, 10_000);
  }

  /** Periodically check for sessions stuck in "generating" state with no CLI activity. */
  startStuckSessionWatchdog(): void {
    const STUCK_THRESHOLD_MS = 120_000; // 2 minutes without any CLI activity
    const CHECK_INTERVAL_MS = 30_000;   // check every 30s

    const timer = setInterval(() => {
      const now = Date.now();
      for (const session of this.sessions.values()) {
        if (!session.isGenerating || !session.generationStartedAt) continue;

        // Don't flag sessions that haven't been generating long enough.
        // lastCliMessageAt / lastCliPingAt may be stale from a previous turn,
        // so without this guard, a freshly-started generation triggers a false
        // "stuck" that self-clears on the next cycle once real CLI output arrives.
        if (now - session.generationStartedAt < STUCK_THRESHOLD_MS) continue;

        // Check whether the CLI has been active recently — either a real
        // message, a keep_alive ping, or sub-agent tool_progress within the
        // threshold. Sub-agent progress prevents false "stuck" warnings when
        // the main agent is idle waiting for long-running async sub-agents.
        const lastActivity = Math.max(session.lastCliMessageAt, session.lastCliPingAt, session.lastSubagentProgressAt);
        const sinceLastActivity = lastActivity > 0 ? now - lastActivity : now - session.generationStartedAt;

        if (sinceLastActivity < STUCK_THRESHOLD_MS) {
          // Session is active — reset stuck notification so it can
          // re-fire if the session hangs again later in the same turn.
          if (session.stuckNotifiedAt) {
            session.stuckNotifiedAt = null;
            this.broadcastToBrowsers(session, { type: "session_unstuck" } as BrowserIncomingMessage);
          }
          continue;
        }

        if (session.stuckNotifiedAt) continue; // already notified, still stuck

        session.stuckNotifiedAt = now;
        const elapsed = now - session.generationStartedAt;
        console.warn(`[ws-bridge] Session ${session.id} appears stuck (${Math.round(elapsed / 1000)}s generation, ${Math.round(sinceLastActivity / 1000)}s since last CLI activity)`);
        this.recorder?.recordServerEvent(session.id, "stuck_detected", { elapsed, sinceLastActivity }, session.backendType, session.state.cwd);
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
    // Only cancel in-flight namer calls and take over session naming when the
    // quest is actively being worked on (in_progress). When it transitions
    // away (needs_verification, done), let the auto-namer resume so it can
    // track subsequent agent actions.
    const isQuestActive = quest?.title && quest?.status === "in_progress";
    if (isQuestActive && this.onSessionNamedByQuest) {
      this.onSessionNamedByQuest(sessionId, quest.title);
    }
    this.broadcastToBrowsers(session, {
      type: "session_quest_claimed",
      quest,
    } as BrowserIncomingMessage);
    // When a quest is actively in_progress, broadcast a session_name_update
    // with source "quest" so ALL paths (REST claim, Codex Bash detection,
    // transitions) consistently update the session name and the browser's
    // questNamedSessions guard. Skip this for non-active statuses so the
    // auto-namer can resume.
    if (isQuestActive) {
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

  getTrafficStatsSnapshot(): TrafficStatsSnapshot {
    return trafficStats.snapshot();
  }

  resetTrafficStats(): void {
    trafficStats.reset();
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
  setHerdEventDispatcher(dispatcher: { onOrchestratorTurnEnd(orchId: string): void; onOrchestratorDisconnect(orchId: string): void; getDiagnostics(orchId: string): Record<string, unknown> }): void {
    this.herdEventDispatcher = dispatcher;
  }

  /** Re-evaluate leader-group idle notifications when herd membership changes. */
  onHerdMembershipChanged(orchId: string): void {
    this.updateLeaderGroupIdleState(orchId, "herd_membership_changed");
  }

  /** Check if a session is idle AND ready to receive messages.
   *  Requires: CLI connected, system.init received, not generating. */
  isSessionIdle(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return !!(session.backendSocket || session.codexAdapter || session.claudeSdkAdapter)
      && session.cliInitReceived
      && !session.isGenerating;
  }

  /** Get diagnostic info for a session's herd event and generation state. */
  getHerdDiagnostics(sessionId: string): Record<string, unknown> | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      isGenerating: session.isGenerating,
      generationStartedAt: session.generationStartedAt,
      queuedTurnStarts: session.queuedTurnStarts,
      backendConnected: !!(session.backendSocket || session.codexAdapter || session.claudeSdkAdapter),
      cliInitReceived: session.cliInitReceived,
      pendingMessagesCount: session.pendingMessages.length,
      pendingPermissionsCount: session.pendingPermissions.size,
      disconnectGraceActive: session.disconnectGraceTimer !== null,
      disconnectWasGenerating: session.disconnectWasGenerating,
      seamlessReconnect: session.seamlessReconnect,
      ...(this.herdEventDispatcher ? { herdDispatcher: this.herdEventDispatcher.getDiagnostics(sessionId) } : {}),
    };
  }

  /** Re-check group-idle state for any leader affected by this session's activity change. */
  private onSessionActivityStateChanged(sessionId: string, reason: string): void {
    const info = this.launcher?.getSession?.(sessionId);
    if (!info) return;

    if (info.isOrchestrator) {
      this.updateLeaderGroupIdleState(sessionId, `${reason}:leader`);
    }
    if (info.herdedBy) {
      this.updateLeaderGroupIdleState(info.herdedBy, `${reason}:worker`);
    }
  }

  private getLeaderGroupMembers(leaderId: string): string[] {
    const workerIds = this.launcher?.getHerdedSessions?.(leaderId)?.map((w) => w.sessionId) ?? [];
    return [leaderId, ...workerIds];
  }

  private isIdleForLeaderGroup(session: Session): boolean {
    return this.deriveSessionStatus(session) === "idle" && session.pendingPermissions.size === 0;
  }

  /** Build per-member idle diagnostic for group idle logging. */
  private buildGroupIdleDiag(members: string[]): { memberStates: Record<string, unknown>[]; allIdle: boolean } {
    const memberStates: Record<string, unknown>[] = [];
    let allIdle = true;
    for (const memberId of members) {
      const session = this.sessions.get(memberId);
      const num = this.launcher?.getSessionNum?.(memberId);
      const tag = num !== undefined ? `#${num}` : memberId.slice(0, 8);
      if (!session) {
        memberStates.push({ id: tag, status: "no_session" });
        allIdle = false;
        continue;
      }
      const status = this.deriveSessionStatus(session);
      const idle = this.isIdleForLeaderGroup(session);
      if (!idle) allIdle = false;
      memberStates.push({
        id: tag,
        status,
        generating: session.isGenerating,
        perms: session.pendingPermissions.size,
        idle,
      });
    }
    return { memberStates, allIdle };
  }

  private clearLeaderGroupIdleTimer(state: LeaderGroupIdleTimerState): void {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private getOrCreateLeaderGroupIdleState(leaderId: string): LeaderGroupIdleTimerState {
    let state = this.leaderGroupIdleStates.get(leaderId);
    if (!state) {
      state = {
        timer: null,
        idleSince: null,
        notifiedWhileIdle: false,
        leaderUnreadSetByGroupIdle: false,
      };
      this.leaderGroupIdleStates.set(leaderId, state);
    }
    return state;
  }

  private updateLeaderGroupIdleState(leaderId: string, reason: string): void {
    const leaderInfo = this.launcher?.getSession?.(leaderId);
    if (!leaderInfo?.isOrchestrator) {
      const stale = this.leaderGroupIdleStates.get(leaderId);
      if (stale) {
        this.clearLeaderGroupIdleTimer(stale);
        this.leaderGroupIdleStates.delete(leaderId);
      }
      return;
    }

    const members = this.getLeaderGroupMembers(leaderId);
    const allIdle = members.every((memberId) => {
      const session = this.sessions.get(memberId);
      if (!session) return false;
      return this.isIdleForLeaderGroup(session);
    });

    const state = this.getOrCreateLeaderGroupIdleState(leaderId);
    if (!allIdle) {
      this.clearLeaderGroupIdleTimer(state);
      state.idleSince = null;
      state.notifiedWhileIdle = false;
      if (state.leaderUnreadSetByGroupIdle) {
        const leaderSession = this.sessions.get(leaderId);
        if (leaderSession?.attentionReason === "review") {
          this.clearAttentionAndMarkRead(leaderSession);
        }
        state.leaderUnreadSetByGroupIdle = false;
      }
      return;
    }

    if (state.notifiedWhileIdle || state.timer) return;
    state.idleSince = Date.now();
    const leaderNum = this.launcher?.getSessionNum?.(leaderId);
    const leaderTag = leaderNum !== undefined ? `#${leaderNum}` : leaderId.slice(0, 8);
    const startDiag = this.buildGroupIdleDiag(members);
    console.log(
      `[ws-bridge] Group idle timer started for ${leaderTag} (reason: ${reason}, members: ${members.length})` +
      ` | ${startDiag.memberStates.map((m) => `${m.id}:${m.idle ? "idle" : m.status}`).join(", ")}`,
    );
    state.timer = setTimeout(() => {
      state.timer = null;
      const latestMembers = this.getLeaderGroupMembers(leaderId);
      const fireDiag = this.buildGroupIdleDiag(latestMembers);
      if (!fireDiag.allIdle || state.notifiedWhileIdle) {
        console.log(
          `[ws-bridge] Group idle timer fired but NOT notifying for ${leaderTag}` +
          ` (allIdle=${fireDiag.allIdle}, notifiedWhileIdle=${state.notifiedWhileIdle})` +
          ` | ${fireDiag.memberStates.map((m) => `${m.id}:${m.idle ? "idle" : m.status}`).join(", ")}`,
        );
        return;
      }
      console.log(
        `[ws-bridge] Group idle timer fired → NOTIFYING for ${leaderTag}` +
        ` (idle for ${state.idleSince ? Math.round((Date.now() - state.idleSince) / 1000) : "?"}s)` +
        ` | ${fireDiag.memberStates.map((m) => `${m.id}:${m.idle ? "idle" : m.status}`).join(", ")}`,
      );
      state.leaderUnreadSetByGroupIdle = this.emitLeaderGroupIdleNotification(leaderId, latestMembers, state.idleSince);
      state.notifiedWhileIdle = true;
    }, WsBridge.LEADER_GROUP_IDLE_NOTIFY_DELAY_MS);
    this.recorder?.recordServerEvent(leaderId, "leader_group_idle_timer_started", { reason, members: members.length, memberStates: startDiag.memberStates }, leaderInfo.backendType ?? "claude", leaderInfo.cwd);
  }

  private buildLeaderGroupLabel(leaderId: string): string {
    const num = this.launcher?.getSessionNum?.(leaderId);
    const name = this.sessionNameGetter?.(leaderId);
    if (num !== undefined && name) return `#${num} ${name}`;
    if (num !== undefined) return `#${num}`;
    if (name) return name;
    return leaderId.slice(0, 8);
  }

  private emitLeaderGroupIdleNotification(leaderId: string, members: string[], idleSince: number | null): boolean {
    const session = this.sessions.get(leaderId);
    if (!session) return false;
    const now = Date.now();
    const idleForMs = idleSince ? Math.max(0, now - idleSince) : WsBridge.LEADER_GROUP_IDLE_NOTIFY_DELAY_MS;
    const leaderLabel = this.buildLeaderGroupLabel(leaderId);
    const detail = `${leaderLabel} is idle and waiting for attention`;
    const priorAttention = session.attentionReason;
    this.setAttention(session, "review");
    this.pushoverNotifier?.scheduleNotification(leaderId, "completed", detail);
    this.broadcastToBrowsers(session, {
      type: "leader_group_idle",
      leader_session_id: leaderId,
      leader_label: leaderLabel,
      member_count: members.length,
      idle_for_ms: idleForMs,
      timestamp: now,
    });
    return priorAttention === null && session.attentionReason === "review";
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

  /** Route an interrupt from an external source (REST API / CLI).
   *  This reuses the same interrupt path as the browser stop button. */
  async routeExternalInterrupt(session: Session, source: InterruptSource = "system"): Promise<void> {
    await this.routeBrowserMessage(session, { type: "interrupt", interruptSource: source } as BrowserOutgoingMessage);
  }

  // ── Takode orchestration event methods ──────────────────────────────────

  /** Emit a takode event, buffering it and notifying matching subscribers. */
  emitTakodeEvent<E extends TakodeEventType>(
    sessionId: string,
    event: E,
    data: TakodeEventDataByType[E],
  ): void {
    const takodeEvent = {
      id: this.takodeEventNextId++,
      event,
      sessionId,
      sessionNum: this.launcher?.getSessionNum?.(sessionId) ?? -1,
      sessionName: this.sessionNameGetter?.(sessionId) ?? sessionId.slice(0, 8),
      ts: Date.now(),
      data,
    } as TakodeEventFor<E>;

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
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.isGenerating || session.pendingPermissions.size > 0;
  }

  /** Restore sessions from disk (call once at startup). */
  async restoreFromDisk(): Promise<number> {
    if (!this.store) return 0;
    const persisted = await this.store.loadAll();
    let count = 0;
    for (const p of persisted) {
      if (this.sessions.has(p.id)) continue; // don't overwrite live sessions
      const restoredCodexTurns = Array.isArray(p.pendingCodexTurns)
        ? p.pendingCodexTurns.map((turn) => this.normalizePersistedCodexTurn(turn))
        : [];
      const session: Session = {
        id: p.id,
        backendType: p.state.backend_type || "claude",
        backendSocket: null,
        codexAdapter: null,
        claudeSdkAdapter: null,
        browserSockets: new Set(),
        state: p.state,
        pendingPermissions: new Map(p.pendingPermissions || []),
        pendingControlRequests: new Map(),
        messageHistory: p.messageHistory || [],
        frozenCount: typeof p._frozenCount === "number" ? Math.max(0, Math.min(p._frozenCount, (p.messageHistory || []).length)) : 0,
        pendingMessages: p.pendingMessages || [],
        pendingCodexTurns: restoredCodexTurns,
        pendingCodexInputs: Array.isArray(p.pendingCodexInputs) ? p.pendingCodexInputs : [],
        nextEventSeq: p.nextEventSeq && p.nextEventSeq > 0 ? p.nextEventSeq : 1,
        eventBuffer: Array.isArray(p.eventBuffer) ? p.eventBuffer : [],
        lastAckSeq: typeof p.lastAckSeq === "number" ? p.lastAckSeq : 0,
        processedClientMessageIds: Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        processedClientMessageIdSet: new Set(
          Array.isArray(p.processedClientMessageIds) ? p.processedClientMessageIds : [],
        ),
        toolResults: new Map(Array.isArray(p.toolResults) ? p.toolResults : []),
        toolProgressOutput: new Map(),
        pendingQuestCommands: new Map(),
        assistantAccumulator: new Map(),
        toolStartTimes: new Map(),
        worktreeStateFingerprint: "",
        codexToolResultWatchdogs: new Map(),
        isGenerating: false,
        generationStartedAt: null,
        questStatusAtTurnStart: null,
        messageCountAtTurnStart: 0,
        interruptedDuringTurn: false,
        interruptSourceDuringTurn: null,
        compactedDuringTurn: false,
        consecutiveAdapterFailures: 0,
        lastAdapterFailureAt: null,
        intentionalCodexRelaunchUntil: null,
        intentionalCodexRelaunchReason: null,
        userMessageIdsThisTurn: [],
        queuedTurnStarts: 0,
        queuedTurnReasons: [],
        queuedTurnUserMessageIds: [],
        queuedTurnInterruptSources: [],
        cliInitReceived: false,
        lastCliMessageAt: 0,
        lastCliPingAt: 0,
        lastSubagentProgressAt: 0,
        optimisticRunningTimer: null,
        lastOutboundUserNdjson: null,
        stuckNotifiedAt: null,
        lastReadAt: typeof p.lastReadAt === "number" ? p.lastReadAt : 0,
        attentionReason: p.attentionReason ?? null,
        disconnectGraceTimer: null,
        disconnectWasGenerating: false,
        seamlessReconnect: false,
        taskHistory: Array.isArray(p.taskHistory) ? p.taskHistory : [],
        keywords: Array.isArray(p.keywords) ? p.keywords : [],
        diffStatsDirty: true,
        evaluatingAborts: new Map(),
        cliResuming: false,
        cliResumingClearTimer: null,
      };
      session.state.backend_type = session.backendType;
      session.state.backend_state = session.state.backend_state ?? "disconnected";
      session.state.backend_error = session.state.backend_error ?? null;

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

      this.recoverToolStartTimesFromHistory(session);
      this.finalizeRecoveredDisconnectedTerminalTools(session, "restore_from_disk");
      this.scheduleCodexToolResultWatchdogs(session, "restore_from_disk");

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
    this.clampFrozenCount(session);
    this.store.save({
      id: session.id,
      state: session.state,
      messageHistory: session.messageHistory,
      pendingMessages: session.pendingMessages,
      pendingCodexTurns: session.pendingCodexTurns,
      pendingCodexInputs: session.pendingCodexInputs,
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
    this.clampFrozenCount(session);
    this.store.saveSync({
      id: session.id,
      state: session.state,
      messageHistory: session.messageHistory,
      pendingMessages: session.pendingMessages,
      pendingCodexTurns: session.pendingCodexTurns,
      pendingCodexInputs: session.pendingCodexInputs,
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
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean } = {},
  ): Promise<void> {
    // Skip expensive git operations for fully background sessions without a
    // backend connection. Exception: actively viewed worktree sessions still
    // need refresh to re-anchor diff_base_start_sha after sync/rebase/reset.
    if (
      !options.force
      && !session.backendSocket
      && !session.codexAdapter
      && !(session.state.is_worktree && session.browserSockets.size > 0)
    ) return;

    const before: Record<string, unknown> = {};
    for (const key of WsBridge.GIT_SESSION_KEYS) {
      before[key] = session.state[key];
    }
    const previousHeadSha = session.state.git_head_sha || "";

    await resolveGitInfo(session.state);
    if (!session.state.is_worktree) {
      session.worktreeStateFingerprint = "";
    }
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
   * Force-refresh git metadata and diff totals for worktree sessions even when
   * no agent-side activity marked diffStatsDirty. This covers external git
   * operations like reset/rebase/sync that change the worktree behind Takode's
   * back but should still clear stale +/- badges in session snapshots.
   */
  async refreshWorktreeGitStateForSnapshot(
    sessionId: string,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
  ): Promise<SessionState | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (!session.state.is_worktree || !session.state.cwd) return session.state;

    const currentFingerprint = await readWorktreeStateFingerprint(session.state.cwd);
    const previousFingerprint = session.worktreeStateFingerprint.trim();
    if (currentFingerprint && previousFingerprint && currentFingerprint === previousFingerprint) {
      return session.state;
    }

    const beforeAdded = session.state.total_lines_added;
    const beforeRemoved = session.state.total_lines_removed;

    await this.refreshGitInfo(session, {
      broadcastUpdate: options.broadcastUpdate,
      notifyPoller: options.notifyPoller,
      force: true,
    });

    const didRun = await this.computeDiffStatsAsync(session);
    if (!didRun) return session.state;

    session.diffStatsDirty = false;
    session.worktreeStateFingerprint = currentFingerprint || "";

    const totalsChanged = beforeAdded !== session.state.total_lines_added
      || beforeRemoved !== session.state.total_lines_removed;
    if (totalsChanged && options.broadcastUpdate) {
      this.broadcastToBrowsers(session, {
        type: "session_update",
        session: {
          total_lines_added: session.state.total_lines_added,
          total_lines_removed: session.state.total_lines_removed,
        },
      });
    }
    if (totalsChanged) {
      this.persistSession(session);
    }
    return session.state;
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
      !session.backendSocket
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
      if (session.state.is_worktree && cwd) {
        session.worktreeStateFingerprint = await readWorktreeStateFingerprint(cwd) || "";
      }
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
        backendSocket: null,
        codexAdapter: null,
        claudeSdkAdapter: null,
        browserSockets: new Set(),
        state: makeDefaultState(sessionId, type),
        pendingPermissions: new Map(),
        pendingControlRequests: new Map(),
        messageHistory: [],
        frozenCount: 0,
        pendingMessages: [],
        pendingCodexTurns: [],
        pendingCodexInputs: [],
        nextEventSeq: 1,
        eventBuffer: [],
        lastAckSeq: 0,
        processedClientMessageIds: [],
        processedClientMessageIdSet: new Set(),
        toolResults: new Map(),
        toolProgressOutput: new Map(),
        pendingQuestCommands: new Map(),
        assistantAccumulator: new Map(),
        toolStartTimes: new Map(),
        worktreeStateFingerprint: "",
        codexToolResultWatchdogs: new Map(),
        isGenerating: false,
        generationStartedAt: null,
        questStatusAtTurnStart: null,
        messageCountAtTurnStart: 0,
        interruptedDuringTurn: false,
        interruptSourceDuringTurn: null,
        compactedDuringTurn: false,
        consecutiveAdapterFailures: 0,
        lastAdapterFailureAt: null,
        intentionalCodexRelaunchUntil: null,
        intentionalCodexRelaunchReason: null,
        userMessageIdsThisTurn: [],
        queuedTurnStarts: 0,
        queuedTurnReasons: [],
        queuedTurnUserMessageIds: [],
        queuedTurnInterruptSources: [],
        cliInitReceived: false,
        lastCliMessageAt: 0,
        lastCliPingAt: 0,
        lastSubagentProgressAt: 0,
        optimisticRunningTimer: null,
        lastOutboundUserNdjson: null,
        stuckNotifiedAt: null,
        lastReadAt: 0,
        attentionReason: null,
        disconnectGraceTimer: null,
        disconnectWasGenerating: false,
        seamlessReconnect: false,
        taskHistory: [],
        keywords: [],
        diffStatsDirty: true,
        evaluatingAborts: new Map(),
        cliResuming: false,
        cliResumingClearTimer: null,
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

  private findHistoryReplayEntry<T extends BrowserIncomingMessage>(
    session: Session,
    predicate: (message: BrowserIncomingMessage) => message is T,
  ): T | undefined {
    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      const entry = session.messageHistory[i];
      if (predicate(entry)) return entry;
    }
    return undefined;
  }

  private hasAssistantReplay(session: Session, messageId: string): boolean {
    return !!this.findHistoryReplayEntry(
      session,
      (message): message is BrowserIncomingMessage & { type: "assistant"; message: { id?: string } } =>
        message.type === "assistant" && (message as { message?: { id?: string } }).message?.id === messageId,
    );
  }

  private hasUserPromptReplay(session: Session, cliUuid: string): boolean {
    return !!this.findHistoryReplayEntry(
      session,
      (message): message is BrowserIncomingMessage & { type: "user_message"; cliUuid?: string } =>
        message.type === "user_message" && (message as { cliUuid?: string }).cliUuid === cliUuid,
    );
  }

  private hasResultReplay(session: Session, resultUuid: string): boolean {
    return !!this.findHistoryReplayEntry(
      session,
      (message): message is BrowserIncomingMessage & { type: "result"; data?: { uuid?: string } } =>
        message.type === "result" && (message as { data?: { uuid?: string } }).data?.uuid === resultUuid,
    );
  }

  private hasToolResultPreviewReplay(session: Session, toolUseId: string): boolean {
    return !!this.findHistoryReplayEntry(
      session,
      (message): message is BrowserIncomingMessage & { type: "tool_result_preview"; previews?: ToolResultPreview[] } =>
        message.type === "tool_result_preview"
          && Array.isArray((message as { previews?: ToolResultPreview[] }).previews)
          && ((message as { previews?: ToolResultPreview[] }).previews || []).some(
            (preview) => preview.tool_use_id === toolUseId,
          ),
    );
  }

  private hasCompactBoundaryReplay(
    session: Session,
    cliUuid: string | undefined,
    meta: CLISystemCompactBoundaryMessage["compact_metadata"],
  ): boolean {
    if (cliUuid) {
      const matchedUuid = this.findHistoryReplayEntry(
        session,
        (message): message is BrowserIncomingMessage & { type: "compact_marker"; cliUuid?: string } =>
          message.type === "compact_marker" && (message as { cliUuid?: string }).cliUuid === cliUuid,
      );
      if (matchedUuid) return true;
    }

    const last = session.messageHistory[session.messageHistory.length - 1] as
      | { type?: string; trigger?: string; preTokens?: number; summary?: string }
      | undefined;
    return last?.type === "compact_marker"
      && !last.summary
      && (last.trigger ?? null) === (meta?.trigger ?? null)
      && (last.preTokens ?? null) === (meta?.pre_tokens ?? null);
  }

  // ─── Attention state (server-authoritative read/unread) ───────────────────

  private static readonly ATTENTION_PRIORITY: Record<string, number> = { action: 3, error: 2, review: 1 };
  private static readonly LEADER_TO_USER_SUFFIX = "@to(user)";
  private static readonly LEADER_TO_SELF_SUFFIX = "@to(self)";
  private static readonly LEADER_TAG_ENFORCEMENT_REMINDER =
    "[System] As a leader session, every text message you send must end with @to(user) (if addressing the human) or @to(self) (if internal coordination). Your last message was missing this tag — please resend it with the appropriate suffix.";
  private static readonly LEADER_TAG_SYSTEM_SOURCE = {
    sessionId: "system:leader-tag-enforcer",
    sessionLabel: "System",
  } as const;

  /**
   * Codex can replay prior assistant messages after reconnect. Deduplicate only
   * when the canonical assistant ID matches, or when timestamp + content +
   * parent tool context all match a recent assistant. This keeps the fallback
   * filter narrow so legitimate repeated text still appears.
   */
  private isDuplicateCodexAssistantReplay(
    session: Session,
    msg: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  ): boolean {
    const incomingId = typeof msg.message?.id === "string" ? msg.message.id : null;
    if (!incomingId && typeof msg.timestamp !== "number") return false;

    const incomingTimestamp = typeof msg.timestamp === "number" ? msg.timestamp : null;
    const incomingParentToolUseId = msg.parent_tool_use_id;
    const incomingContentKey = JSON.stringify(msg.message.content);

    let scannedAssistants = 0;
    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      const entry = session.messageHistory[i];
      if (entry.type !== "assistant") continue;
      scannedAssistants += 1;
      if (scannedAssistants > WsBridge.CODEX_ASSISTANT_REPLAY_SCAN_LIMIT) break;

      const existing = entry as Extract<BrowserIncomingMessage, { type: "assistant" }>;
      if (incomingId && existing.message?.id === incomingId) {
        return true;
      }
      if (existing.parent_tool_use_id !== incomingParentToolUseId) continue;
      if (incomingTimestamp == null) continue;
      if (typeof existing.timestamp !== "number") continue;
      if (Math.abs(existing.timestamp - incomingTimestamp) > WsBridge.CODEX_ASSISTANT_REPLAY_DEDUP_WINDOW_MS) continue;

      const existingContentKey = JSON.stringify(existing.message.content);
      if (existingContentKey !== incomingContentKey) continue;

      return true;
    }

    return false;
  }

  private isLeaderSession(session: Session): boolean {
    return this.launcher?.getSession(session.id)?.isOrchestrator === true;
  }

  private isHerdedWorkerSession(session: Session): boolean {
    return !!this.launcher?.getSession(session.id)?.herdedBy;
  }

  /**
   * Leader assistant addressing is inferred from @to() suffixes on text blocks.
   * If ANY non-empty text block ends with @to(user), the message is user-addressed.
   * Otherwise, the last non-empty text block determines self/@to(self) or missing.
   * - no text blocks => treated as self/internal (tool-only assistant message)
   * - text present but no recognized suffix => missing tag (enforcement trigger)
   */
  private classifyLeaderAssistantAddressing(session: Session, content: ContentBlock[]): LeaderAssistantAddressing {
    if (!this.isLeaderSession(session)) return "not_leader";

    let hasText = false;
    let lastClassification: LeaderAssistantAddressing = "self";
    for (const block of content) {
      if (block.type !== "text") continue;
      if (block.text.trim().length === 0) continue;
      hasText = true;
      const trimmed = block.text.trimEnd();
      // Any text block ending with @to(user) makes the whole message user-addressed
      if (trimmed.endsWith(WsBridge.LEADER_TO_USER_SUFFIX)) return "user";
      if (trimmed.endsWith(WsBridge.LEADER_TO_SELF_SUFFIX)) {
        lastClassification = "self";
      } else {
        lastClassification = "missing";
      }
    }
    if (!hasText) return "self";
    return lastClassification;
  }

  private formatVsCodeSelectionPrompt(selection: import("./session-types.js").VsCodeSelectionMetadata): string {
    if (selection.startLine === selection.endLine) {
      return `[user selection in VSCode: ${selection.relativePath} line ${selection.startLine}] (this may or may not be relevant)`;
    }
    return `[user selection in VSCode: ${selection.relativePath} lines ${selection.startLine}-${selection.endLine}] (this may or may not be relevant)`;
  }

  private buildPendingCodexRecoveryUserText(msg: BrowserOutgoingMessage): string {
    if (msg.type === "user_message") {
      const parts: string[] = [];
      if (msg.content) parts.push(msg.content);
      if (msg.vscodeSelection) {
        parts.push(this.formatVsCodeSelectionPrompt(msg.vscodeSelection));
      }
      return parts.join("\n");
    }
    if (msg.type === "codex_start_pending") {
      return msg.inputs
        .map((input) => {
          const parts = [input.content];
          if (input.vscodeSelection) {
            parts.push(this.formatVsCodeSelectionPrompt(input.vscodeSelection));
          }
          return parts.filter(Boolean).join("\n");
        })
        .filter(Boolean)
        .join("\n\n");
    }
    return "";
  }

  private normalizePersistedCodexTurn(turn: CodexOutboundTurn, now = Date.now()): CodexOutboundTurn {
    return {
      ...turn,
      pendingInputIds: Array.isArray(turn.pendingInputIds) && turn.pendingInputIds.length > 0
        ? turn.pendingInputIds
        : [turn.userMessageId],
      historyIndex: turn.historyIndex ?? -1,
      status: turn.status ?? "queued",
      dispatchCount: turn.dispatchCount ?? 0,
      createdAt: turn.createdAt ?? now,
      updatedAt: turn.updatedAt ?? now,
      acknowledgedAt: turn.acknowledgedAt ?? null,
      // turnTarget is runtime lifecycle wiring; do not trust persisted values
      // across restart/recovery boundaries.
      turnTarget: null,
      lastError: turn.lastError ?? null,
    };
  }

  private maybeInjectLeaderAddressingReminder(
    session: Session,
    addressing: LeaderAssistantAddressing,
    turnTriggerSource: TurnTriggerSource,
    turnWasInterrupted: boolean,
  ): boolean {
    if (addressing !== "missing") return false;
    // Never chain reminders off system-injected reminder turns; this avoids
    // recursive nudge loops when the model keeps omitting @to() tags.
    if (turnTriggerSource === "system") return false;
    // Don't nudge when the turn was interrupted — the assistant didn't get a chance
    // to finish its response (and add the @to() tag). Without this guard, the nudge
    // injects a new user message that triggers another turn, making it impossible to
    // actually stop a leader session.
    if (turnWasInterrupted) return false;
    this.injectUserMessage(session.id, WsBridge.LEADER_TAG_ENFORCEMENT_REMINDER, WsBridge.LEADER_TAG_SYSTEM_SOURCE);
    return true;
  }

  private getCurrentTurnTriggerSource(session: Session): TurnTriggerSource {
    for (const historyIndex of session.userMessageIdsThisTurn) {
      const entry = session.messageHistory[historyIndex] as
        | (Extract<BrowserIncomingMessage, { type: "user_message" }>)
        | undefined;
      if (!entry || entry.type !== "user_message") continue;
      if (!entry.agentSource) return "user";
      if (this.isSystemSourceTag(entry.agentSource)) return "system";
      return "leader";
    }
    return "unknown";
  }

  /** Whether a completed turn should surface attention/notifications to the human. */
  private shouldNotifyHumanOnResult(session: Session, turnTriggerSource: TurnTriggerSource): boolean {
    if (this.isHerdedWorkerSession(session)) {
      return turnTriggerSource === "user";
    }
    if (!this.isLeaderSession(session)) return true;

    const latestAssistant = session.messageHistory.findLast(
      (m) => m.type === "assistant" && (m as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
    ) as (BrowserIncomingMessage & { type: "assistant"; leader_user_addressed?: boolean }) | undefined;
    return latestAssistant?.leader_user_addressed === true;
  }

  /** Upgrade attention (never downgrade). Broadcasts + persists. */
  private setAttention(
    session: Session,
    reason: "action" | "error" | "review",
    options?: { allowHerdedWorker?: boolean },
  ): void {
    if (this.isHerdedWorkerSession(session) && !options?.allowHerdedWorker) return;
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
    if (this.isHerdedWorkerSession(session)) return true;
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
    return {
      lastReadAt: session.lastReadAt,
      attentionReason: session.attentionReason,
    };
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

  async refreshCodexSkills(sessionId: string, forceReload = false): Promise<{ ok: boolean; skills?: string[]; error?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };
    if (!session.codexAdapter?.refreshSkills) return { ok: false, error: "Codex adapter unavailable" };
    try {
      const skills = await session.codexAdapter.refreshSkills(forceReload);
      return { ok: true, skills };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Is the correct backend for this session connected and responsive? */
  private backendConnected(session: Session): boolean {
    switch (session.backendType) {
      case "claude":     return !!session.backendSocket;
      case "codex":      return !!session.codexAdapter?.isConnected();
      case "claude-sdk": return !!session.claudeSdkAdapter?.isConnected();
      default:           return assertNever(session.backendType);
    }
  }

  /** Is any transport attached (even if still initializing)?
   *  Use this to guard against relaunching sessions that are mid-startup. */
  private backendAttached(session: Session): boolean {
    return !!(session.backendSocket || session.codexAdapter || session.claudeSdkAdapter);
  }

  private deriveBackendState(session: Session): NonNullable<SessionState["backend_state"]> {
    if (session.state.backend_state === "broken") return "broken";
    if (this.backendConnected(session)) return "connected";
    if (session.state.backend_state === "initializing" || session.state.backend_state === "resuming") {
      return session.state.backend_state;
    }
    return "disconnected";
  }

  private setBackendState(
    session: Session,
    backendState: NonNullable<SessionState["backend_state"]>,
    backendError: string | null = null,
  ): void {
    const changed =
      session.state.backend_state !== backendState
      || session.state.backend_error !== backendError;
    session.state.backend_state = backendState;
    session.state.backend_error = backendError;
    if (!changed) return;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: {
        backend_state: backendState,
        backend_error: backendError,
      },
    });
  }

  private getCodexHeadTurn(session: Session): CodexOutboundTurn | null {
    return session.pendingCodexTurns[0] ?? null;
  }

  private getCodexTurnAwaitingAck(session: Session): CodexOutboundTurn | null {
    const head = this.getCodexHeadTurn(session);
    return head?.status === "dispatched" ? head : null;
  }

  private getCodexTurnInRecovery(session: Session): CodexOutboundTurn | null {
    const head = this.getCodexHeadTurn(session);
    if (!head) return null;
    if (
      head.status === "queued"
      || head.status === "dispatched"
      || head.status === "backend_acknowledged"
      || head.status === "blocked_broken_session"
    ) {
      return head;
    }
    return null;
  }

  private enqueueCodexTurn(session: Session, turn: CodexOutboundTurn): CodexOutboundTurn {
    session.pendingCodexTurns.push(turn);
    return turn;
  }

  private removeCompletedCodexTurns(session: Session): boolean {
    let removed = 0;
    while (session.pendingCodexTurns[0]?.status === "completed") {
      session.pendingCodexTurns.shift();
      removed++;
    }
    return removed > 0;
  }

  private completeCodexTurn(session: Session, turn: CodexOutboundTurn | null, updatedAt = Date.now()): boolean {
    if (!turn) return false;
    turn.status = "completed";
    turn.updatedAt = updatedAt;
    return this.removeCompletedCodexTurns(session);
  }

  private dispatchQueuedCodexTurns(session: Session, reason: string): void {
    const adapter = session.codexAdapter;
    if (!adapter) return;
    if (session.codexAdapter !== adapter) return;
    if (session.state.backend_state !== "connected" || !adapter.isConnected()) return;

    const head = this.getCodexHeadTurn(session);
    if (!head) return;
    if (head.status === "blocked_broken_session") {
      head.status = "queued";
      head.updatedAt = Date.now();
      head.lastError = null;
      head.turnId = null;
      head.acknowledgedAt = null;
      head.disconnectedAt = null;
      head.resumeConfirmedAt = null;
    }
    if (head.status === "backend_acknowledged" || head.status === "dispatched") return;

    const now = Date.now();
    const accepted = adapter.sendBrowserMessage(head.adapterMsg);
    if (!accepted) {
      head.status = "queued";
      head.updatedAt = now;
      head.lastError = `Codex adapter rejected outbound turn during ${reason}.`;
      this.persistSession(session);
      return;
    }

    head.status = "dispatched";
    head.dispatchCount += 1;
    head.updatedAt = now;
    head.lastError = null;
    this.setPendingCodexInputsCancelable(session, head.pendingInputIds ?? [head.userMessageId], false);
    this.persistSession(session);
    console.log(
      `[ws-bridge] Dispatched queued Codex turn for session ${sessionTag(session.id)} (${reason}, attempt ${head.dispatchCount})`,
    );
  }

  private maybeFlushQueuedCodexMessages(session: Session, reason: string): void {
    const adapter = session.codexAdapter;
    if (!adapter) return;
    this.flushQueuedMessagesToCodexAdapter(session, adapter, reason);
  }

  isBackendConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return this.backendConnected(session);
  }

  removeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.clearOptimisticRunningTimer(session, "remove_session");
      this.clearAllCodexToolResultWatchdogs(session, "remove_session");
    }
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
    this.clearOptimisticRunningTimer(session, "close_session");
    this.clearAllCodexToolResultWatchdogs(session, "close_session");

    // Close CLI socket (Claude)
    if (session.backendSocket) {
      try { session.backendSocket.close(); } catch {}
      session.backendSocket = null;
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
  attachCodexAdapter(sessionId: string, adapter: CodexBridgeAdapter): void {
    const session = this.getOrCreateSession(sessionId, "codex");
    session.backendType = "codex";
    session.state.backend_type = "codex";
    if (session.codexAdapter && session.codexAdapter !== adapter) {
      session.codexAdapter.disconnect().catch(() => {});
    }
    session.codexAdapter = adapter;
    const launcherInfo = this.launcher?.getSession(session.id);
    const backendState =
      launcherInfo?.cliSessionId || session.pendingCodexTurns.length > 0 || session.pendingMessages.length > 0
        ? "resuming"
        : "initializing";
    this.setBackendState(session, backendState, null);
    this.persistSession(session);

    // Mark session as initialized immediately when the Codex adapter attaches.
    // Mirrors the SDK path (attachClaudeSdkAdapter). Without this,
    // cliInitReceived stays false after server restart → isSessionIdle()
    // returns false → herd events are never delivered.
    session.cliInitReceived = true;

    // Flush pending herd events now that isSessionIdle() can return true.
    if (this.herdEventDispatcher) {
      const orchInfo = this.launcher?.getSession(session.id);
      if (orchInfo?.isOrchestrator) {
        this.herdEventDispatcher.onOrchestratorTurnEnd(session.id);
      }
    }

    // Forward translated messages to browsers
    adapter.onBrowserMessage((msg) => {
      if (session.codexAdapter !== adapter) return;
      // Track Codex CLI activity for idle management and stuck detection
      this.launcher?.touchActivity(session.id);
      session.lastCliMessageAt = Date.now();
      this.clearOptimisticRunningTimer(session, `codex_output:${msg.type}`);
      let outgoing: BrowserIncomingMessage | null = msg;

      if (msg.type === "session_init") {
        const sanitized = this.sanitizeCodexSessionPatch(msg.session);
        session.state = { ...session.state, ...sanitized, backend_type: "codex" };
        // Mirror SDK path (line ~2650): ensure cliInitReceived is set so
        // isSessionIdle() works correctly for herd event delivery.
        session.cliInitReceived = true;
        this.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
        this.persistSession(session);
      } else if (msg.type === "session_update") {
        const sanitized = this.sanitizeCodexSessionPatch(msg.session);
        session.state = { ...session.state, ...sanitized, backend_type: "codex" };
        outgoing = { ...msg, session: sanitized };
        this.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
        this.persistSession(session);
      } else if (msg.type === "status_change") {
        const wasCompacting = session.state.is_compacting;
        session.state.is_compacting = msg.status === "compacting";
        // Only emit for NEW compaction transitions (not re-notifications)
        if (msg.status === "compacting" && !wasCompacting) {
          session.compactedDuringTurn = true;
          this.emitTakodeEvent(session.id, "compaction_started", {
            ...(typeof session.state.context_used_percent === "number"
              ? { context_used_percent: session.state.context_used_percent }
              : {}),
          });
          // Synthesize compact marker for the chat UI (Codex doesn't emit compact_boundary)
          const ts = Date.now();
          const markerId = `compact-boundary-${ts}`;
          session.messageHistory.push({
            type: "compact_marker" as const,
            timestamp: ts,
            id: markerId,
          });
          this.freezeHistoryThroughCurrentTail(session);
          this.broadcastToBrowsers(session, {
            type: "compact_boundary",
            id: markerId,
            timestamp: ts,
          });
        }
        if (wasCompacting && msg.status !== "compacting") {
          this.emitTakodeEvent(session.id, "compaction_finished", {
            ...(typeof session.state.context_used_percent === "number"
              ? { context_used_percent: session.state.context_used_percent }
              : {}),
          });
        }
        this.persistSession(session);
      } else if (msg.type === "assistant") {
        const content = msg.message.content || [];
        const now = Date.now();
        for (const block of content) {
          if (block.type === "tool_use" && block.id && !session.toolStartTimes.has(block.id)) {
            session.toolStartTimes.set(block.id, now);
            session.toolProgressOutput.delete(block.id);
          }
        }
        this.trackCodexQuestCommands(session, content);
        const toolResults = content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
        if (toolResults.length > 0) {
          for (const block of toolResults) {
            this.reconcileCodexQuestToolResult(session, block);
          }
          const completedToolStartTimes = this.collectCompletedToolStartTimes(session, toolResults);
          const previews = this.buildToolResultPreviews(session, toolResults);
          if (previews.length > 0) {
            const previewMsg: BrowserIncomingMessage = {
              type: "tool_result_preview",
              previews,
            };
            session.messageHistory.push(previewMsg);
            this.broadcastToBrowsers(session, previewMsg);
            this.persistSession(session);
            this.finalizeSupersededCodexTerminalTools(session, completedToolStartTimes);
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
      } else if (msg.type === "tool_progress") {
        if (typeof msg.output_delta === "string" && msg.output_delta.length > 0) {
          const prev = session.toolProgressOutput.get(msg.tool_use_id) || "";
          const merged = prev + msg.output_delta;
          session.toolProgressOutput.set(
            msg.tool_use_id,
            merged.length > TOOL_PROGRESS_OUTPUT_LIMIT
              ? merged.slice(-TOOL_PROGRESS_OUTPUT_LIMIT)
              : merged,
          );
        }
      }

      if (outgoing?.type === "assistant") {
        const addressing = this.classifyLeaderAssistantAddressing(session, outgoing.message.content);
        const leaderUserAddressed = addressing === "user";
        const normalizedAssistant: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
          ...outgoing,
          timestamp: outgoing.timestamp || Date.now(),
          ...(leaderUserAddressed ? { leader_user_addressed: true } : {}),
        };
        // Dedup: Codex may replay assistant messages after reconnect. Keep this
        // strict (timestamp + content match) to avoid suppressing valid repeats.
        if (this.isDuplicateCodexAssistantReplay(session, normalizedAssistant)) {
          return;
        }
        outgoing = normalizedAssistant;
        // NOTE: Do NOT inject leader addressing reminder here.
        // Deferred to handleResultMessage (turn end) to avoid false nudges
        // during intermediate tool-call gaps.
      }

      // Store assistant/result messages in history for replay
      if (outgoing?.type === "assistant") {
        session.messageHistory.push(outgoing);
        this.persistSession(session);
      } else if (outgoing?.type === "result") {
        session.consecutiveAdapterFailures = 0;
        session.lastAdapterFailureAt = null;
        this.completeCodexTurn(session, this.getCodexHeadTurn(session), Date.now());
        // Route through the unified result handler so Codex gets the same
        // post-turn state refresh (git + diff stats + attention) as Claude.
        this.handleResultMessage(session, outgoing.data);
        if (!session.isGenerating) {
          this.queueCodexPendingStartBatch(session, "codex_turn_completed");
        }
        this.dispatchQueuedCodexTurns(session, "codex_turn_completed");
        this.maybeFlushQueuedCodexMessages(session, "codex_turn_completed_non_user");
        return;
      }

      // Handle permission requests — route through same pipeline as SDK/WS sessions.
      // Auto-approved results are sent directly back to the Codex adapter.
      if (outgoing?.type === "permission_request") {
        const perm = outgoing.request;

        const applyResult = (result: PermissionPipelineResult): void => {
          if (result.kind === "mode_auto_approved" || result.kind === "settings_rule_approved") {
            // Send approval directly back to the Codex adapter
            if (session.codexAdapter) {
              session.codexAdapter.sendBrowserMessage({
                type: "permission_response",
                request_id: result.request.request_id,
                behavior: "allow",
                updated_input: result.request.input,
              } as any);
            }
            // Broadcast approval to browsers for UI consistency
            const approvedMsg: BrowserIncomingMessage = {
              type: "permission_approved",
              id: `approval-${result.request.request_id}`,
              request_id: result.request.request_id,
              tool_name: result.request.tool_name,
              tool_use_id: result.request.tool_use_id,
              summary: getApprovalSummary(result.request.tool_name, result.request.input),
              timestamp: Date.now(),
            };
            session.messageHistory.push(approvedMsg);
            this.broadcastToBrowsers(session, approvedMsg);
            this.persistSession(session);
            return;
          }

          if (result.kind === "queued_for_llm_auto_approval") {
            this.tryLlmAutoApproval(session, result.request.request_id, result.request, result.autoApprovalConfig);
          }
        };

        const maybeResult = handlePermissionRequestPipeline(
          session,
          perm,
          "codex",
          {
            onSessionActivityStateChanged: (sessionId, reason) => this.onSessionActivityStateChanged(sessionId, reason),
            broadcastPermissionRequest: (targetSession, request) => this.broadcastToBrowsers(targetSession, {
              type: "permission_request",
              request,
            }),
            persistSession: (targetSession) => this.persistSession(targetSession),
            setAttentionAction: (targetSession) => this.setAttention(targetSession, "action"),
            emitTakodePermissionRequest: (targetSession, request) => this.emitTakodeEvent(targetSession.id, "permission_request", {
              tool_name: request.tool_name,
              request_id: request.request_id,
              summary: request.description || request.tool_name,
              ...this.buildPermissionPreview(request),
            }),
            schedulePermissionNotification: (targetSession, request) => {
              if (!this.pushoverNotifier) return;
              const eventType = request.tool_name === "AskUserQuestion" ? "question" as const : "permission" as const;
              const detail = request.tool_name + (request.description ? `: ${request.description}` : "");
              this.pushoverNotifier.scheduleNotification(targetSession.id, eventType, detail, request.request_id);
            },
          },
          {
            activityReason: "codex_permission_request",
          },
        );
        if (maybeResult instanceof Promise) {
          void maybeResult.then((result) => {
            applyResult(result);
          }).catch((err) => {
            console.error(`[ws-bridge] Failed to process Codex permission_request for session ${sessionTag(session.id)}:`, err);
          });
        } else {
          applyResult(maybeResult);
        }
        outgoing = null;
      }

      if (outgoing) this.broadcastToBrowsers(session, outgoing);
    });

    // Handle session metadata updates
    adapter.onSessionMeta((meta) => {
      if (session.codexAdapter !== adapter) return;
      if (meta.cliSessionId && this.onCLISessionId) {
        this.onCLISessionId(session.id, meta.cliSessionId);
      }
      if (meta.resumeSnapshot) {
        this.reconcileCodexResumedTurn(session, meta.resumeSnapshot);
      }
      this.setBackendState(session, "connected", null);
      if (meta.model) {
        session.state.model = meta.model;
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: { model: meta.model },
        });
      }
      if (meta.cwd) session.state.cwd = meta.cwd;
      session.state.backend_type = "codex";
      const steeredPending = this.trySteerPendingCodexInputs(session, "session_meta");
      if (!steeredPending) {
        this.dispatchQueuedCodexTurns(session, "session_meta");
        if (!session.isGenerating) {
          this.queueCodexPendingStartBatch(session, "session_meta");
        }
      }
      this.flushQueuedMessagesToCodexAdapter(session, adapter, "session_meta");
      this.broadcastToBrowsers(session, { type: "backend_connected" });
      this.refreshGitInfoThenRecomputeDiff(session, { broadcastUpdate: true, notifyPoller: true });
      this.persistSession(session);
    });

    adapter.onTurnStarted((turnId) => {
      if (session.codexAdapter !== adapter) return;
      const pending = this.getCodexTurnAwaitingAck(session);
      if (!pending) return;
      const committedHistoryIndexes = this.commitPendingCodexInputs(
        session,
        pending.pendingInputIds ?? [pending.userMessageId],
      );
      if (committedHistoryIndexes.length > 0) {
        pending.historyIndex = committedHistoryIndexes[0];
      }
      const trackedHistoryIndexes =
        committedHistoryIndexes.length > 0
          ? committedHistoryIndexes
          : (pending.historyIndex >= 0 ? [pending.historyIndex] : []);
      pending.turnId = turnId;
      pending.status = "backend_acknowledged";
      pending.acknowledgedAt = Date.now();
      pending.updatedAt = pending.acknowledgedAt;
      if (pending.turnTarget === "queued" && !session.isGenerating) {
        this.rearmRecoveredQueuedHeadTurn(session, pending, "codex_turn_started_recovered");
      }
      if (pending.turnTarget === null) {
        const target = session.isGenerating
          ? "current"
          : this.markRunningFromUserDispatch(session, "codex_turn_started");
        pending.turnTarget = target;
        for (const idx of trackedHistoryIndexes) {
          this.trackUserMessageForTurn(session, idx, target);
        }
      } else if (trackedHistoryIndexes.length > 0) {
        for (const idx of trackedHistoryIndexes) {
          this.trackUserMessageForTurn(session, idx, pending.turnTarget);
        }
      }
      this.persistSession(session);
      this.trySteerPendingCodexInputs(session, "codex_turn_started");
    });

    adapter.onTurnSteered((turnId, pendingInputIds) => {
      if (session.codexAdapter !== adapter) return;
      const steeredInputs = this.getPendingCodexInputsByIds(session, pendingInputIds);
      const committedHistoryIndexes = this.commitPendingCodexInputs(session, pendingInputIds);
      this.recordSteeredCodexTurn(session, turnId, steeredInputs, committedHistoryIndexes);
      this.persistSession(session);
      this.trySteerPendingCodexInputs(session, "codex_turn_steered");
    });

    adapter.onTurnSteerFailed((pendingInputIds) => {
      if (session.codexAdapter !== adapter) return;
      this.setPendingCodexInputsCancelable(session, pendingInputIds, true);
    });

    adapter.onInitError((error) => {
      if (session.codexAdapter !== adapter) return;
      console.error(`[ws-bridge] Codex adapter init failed for session ${sessionTag(sessionId)}: ${error}`);
      session.codexAdapter = null;
      const pending = this.getCodexTurnInRecovery(session);
      if (pending) {
        pending.status = "blocked_broken_session";
        pending.lastError = error;
        pending.updatedAt = Date.now();
        this.setPendingCodexInputsCancelable(session, pending.pendingInputIds ?? [pending.userMessageId], true);
      }
      this.setBackendState(session, "broken", error);
      this.setAttention(session, "error");
      this.setGenerating(session, false, "codex_init_error");
      this.broadcastToBrowsers(session, { type: "backend_disconnected", reason: "broken" });
      this.broadcastToBrowsers(session, { type: "status_change", status: null });
      this.persistSession(session);
    });

    // Handle disconnect
    adapter.onDisconnect(() => {
      if (session.codexAdapter !== adapter) return;
      const wasGenerating = session.isGenerating;
      const disconnectedTurnId = adapter.getCurrentTurnId ? adapter.getCurrentTurnId() : null;
      const pending = this.getCodexTurnInRecovery(session);
      if (pending) {
        pending.turnId = disconnectedTurnId;
        pending.disconnectedAt = Date.now();
        pending.resumeConfirmedAt = null;
        pending.updatedAt = pending.disconnectedAt;
      }
      const now = Date.now();
      const intentionalRelaunch = session.intentionalCodexRelaunchUntil !== null
        && now <= session.intentionalCodexRelaunchUntil;
      const intentionalReason = intentionalRelaunch ? (session.intentionalCodexRelaunchReason || "unknown") : null;
      if (session.intentionalCodexRelaunchUntil !== null) {
        session.intentionalCodexRelaunchUntil = null;
        session.intentionalCodexRelaunchReason = null;
      }
      for (const [reqId] of session.pendingPermissions) {
        this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      session.pendingPermissions.clear();
      this.onSessionActivityStateChanged(session.id, "codex_disconnect_permissions_cleared");
      session.pendingQuestCommands.clear();
      session.codexAdapter = null;
      this.setPendingCodexInputsCancelable(
        session,
        session.pendingCodexInputs.map((input) => input.id),
        true,
      );
      this.setBackendState(session, "disconnected", null);
      if (!intentionalRelaunch) {
        if (
          session.lastAdapterFailureAt !== null
          && now - session.lastAdapterFailureAt > ADAPTER_FAILURE_RESET_WINDOW_MS
        ) {
          session.consecutiveAdapterFailures = 0;
        }
        session.lastAdapterFailureAt = now;
        session.consecutiveAdapterFailures++;
      }
      this.markTurnInterrupted(session, "system");
      this.setGenerating(session, false, "codex_disconnect");
      this.broadcastToBrowsers(session, { type: "status_change", status: null });
      this.scheduleCodexToolResultWatchdogs(session, "codex_disconnect");
      this.persistSession(session);
      const idleKilled = this.launcher?.getSession(sessionId)?.killedByIdleManager;
      console.log(
        `[ws-bridge] Codex adapter disconnected for session ${sessionTag(sessionId)}${idleKilled ? " (idle limit)" : ""}`
        + `${intentionalReason ? ` (intentional relaunch: ${intentionalReason})` : ""}`
        + ` (consecutive failures: ${session.consecutiveAdapterFailures})`,
      );
      this.broadcastToBrowsers(session, {
        type: "backend_disconnected",
        ...(idleKilled ? { reason: "idle_limit" as const } : {}),
      });
      if (wasGenerating && !idleKilled && !intentionalRelaunch) {
        this.setAttention(session, "error");
      }

      // Recover faster from unexpected Codex transport drops while a browser is
      // actively connected. Without this, the UI can remain disconnected until
      // either the process exits by itself or the browser reconnects.
      if (
        !intentionalRelaunch
        &&
        !idleKilled
        && this.onCLIRelaunchNeeded
        && session.browserSockets.size > 0
        // Suppress relaunch for intentional teardown (session closed/removed).
        && this.sessions.get(sessionId) === session
        && session.consecutiveAdapterFailures <= MAX_ADAPTER_RELAUNCH_FAILURES
      ) {
        console.log(`[ws-bridge] Codex adapter disconnected for active browser; requesting relaunch for session ${sessionTag(sessionId)} (attempt ${session.consecutiveAdapterFailures}/${MAX_ADAPTER_RELAUNCH_FAILURES})`);
        this.onCLIRelaunchNeeded(sessionId);
      } else if (!intentionalRelaunch && session.consecutiveAdapterFailures > MAX_ADAPTER_RELAUNCH_FAILURES) {
        console.error(`[ws-bridge] Codex adapter for session ${sessionTag(sessionId)} exceeded ${MAX_ADAPTER_RELAUNCH_FAILURES} consecutive failures — stopping auto-relaunch`);
        this.broadcastToBrowsers(session, {
          type: "error",
          message: `Session stopped after ${MAX_ADAPTER_RELAUNCH_FAILURES} consecutive launch failures. Use the relaunch button to try again.`,
        });
      }
    });

    // Re-queue user messages whose turn/start dispatch failed (e.g. transport closed mid-call)
    adapter.onTurnStartFailed((msg) => {
      console.log(`[ws-bridge] Turn start failed for session ${sessionTag(sessionId)}, re-queuing ${msg.type}`);
      if (msg.type === "user_message" || msg.type === "codex_start_pending") {
        const pending = this.getCodexTurnAwaitingAck(session)
          ?? session.pendingCodexTurns.find((turn) =>
            turn.adapterMsg.type === msg.type
            && JSON.stringify(turn.adapterMsg) === JSON.stringify(msg)
            && turn.status !== "completed");
        if (pending) {
          pending.status = "queued";
          pending.turnId = null;
          pending.updatedAt = Date.now();
          pending.lastError = "turn/start failed before acknowledgement";
          this.setPendingCodexInputsCancelable(session, pending.pendingInputIds ?? [pending.userMessageId], true);
        }
        this.dispatchQueuedCodexTurns(session, "turn_start_failed");
      } else {
        const raw = JSON.stringify(msg);
        const alreadyQueued = session.pendingMessages.some((queued) => queued === raw);
        if (!alreadyQueued) {
          session.pendingMessages.push(raw);
        }
      }

      // If this callback came from a stale adapter after reconnect, immediately
      // flush to the currently attached adapter so the message doesn't remain
      // stranded in session.pendingMessages.
      const activeAdapter = session.codexAdapter;
      if (activeAdapter && activeAdapter !== adapter) {
        this.dispatchQueuedCodexTurns(session, "stale_adapter_turn_start_failed");
        this.flushQueuedMessagesToCodexAdapter(session, activeAdapter, "stale_adapter_turn_start_failed");
      }
    });

    console.log(`[ws-bridge] Codex adapter attached for session ${sessionTag(sessionId)}`);
  }

  private flushQueuedMessagesToCodexAdapter(session: Session, adapter: CodexBridgeAdapter, reason: string): void {
    if (session.pendingMessages.length === 0) return;
    if (session.codexAdapter !== adapter) return;
    if (session.state.backend_state !== "connected") {
      console.log(
        `[ws-bridge] Deferring flush of ${session.pendingMessages.length} queued message(s) for session ${sessionTag(session.id)} until Codex session is connected (${reason})`,
      );
      return;
    }
    const queued = session.pendingMessages.splice(0);
    const stillQueued: string[] = [];
    const sendNow: BrowserOutgoingMessage[] = [];
    for (const raw of queued) {
      try {
        const msg = JSON.parse(raw) as BrowserOutgoingMessage;
        if (msg.type === "user_message") {
          console.warn(
            `[ws-bridge] Unexpected raw queued Codex user_message for session ${sessionTag(session.id)}; ` +
            "Codex user turns should only exist in pendingCodexTurns.",
          );
          stillQueued.push(raw);
          continue;
        }
        sendNow.push(msg);
      } catch {
        console.warn(`[ws-bridge] Failed to parse queued message for Codex: ${raw.substring(0, 100)}`);
        stillQueued.push(raw);
      }
    }
    session.pendingMessages = stillQueued;
    if (sendNow.length === 0) {
      if (stillQueued.length > 0) {
        console.log(
          `[ws-bridge] Deferring ${stillQueued.length} queued non-user message(s) for session ${sessionTag(session.id)} (${reason})`,
        );
      }
      this.dispatchQueuedCodexTurns(session, `${reason}_after_pending_message_scan`);
      return;
    }
    console.log(
      `[ws-bridge] Flushing ${sendNow.length} queued message(s) to Codex adapter for session ${sessionTag(session.id)} (${reason})`,
    );
    for (const msg of sendNow) {
      try {
        adapter.sendBrowserMessage(msg);
      } catch {
        console.warn(`[ws-bridge] Failed to flush queued message for Codex session ${sessionTag(session.id)}`);
      }
    }
    this.dispatchQueuedCodexTurns(session, `${reason}_after_non_user_flush`);
  }

  /** Attach a Claude SDK adapter (stdio transport) for a session.
   *  Mirrors attachCodexAdapter but simpler — SDK messages already match our protocol. */
  attachClaudeSdkAdapter(sessionId: string, adapter: ClaudeSdkBridgeAdapter): void {
    const session = this.getOrCreateSession(sessionId, "claude-sdk");
    session.backendType = "claude-sdk";
    session.state.backend_type = "claude-sdk";
    // Disconnect the old adapter if one exists (prevents orphaned processes on relaunch)
    if (session.claudeSdkAdapter && session.claudeSdkAdapter !== adapter) {
      session.claudeSdkAdapter.disconnect().catch(() => {});
    }
    // Copy launcher metadata into session state so the UI has it immediately
    // (before the SDK's system.init arrives with the resolved values).
    const launcherInfo = this.launcher?.getSession(sessionId);
    if (launcherInfo?.isWorktree) {
      session.state.is_worktree = true;
      if (launcherInfo.repoRoot) session.state.repo_root = launcherInfo.repoRoot;
    }
    if (launcherInfo?.model && !session.state.model) {
      session.state.model = launcherInfo.model;
    }
    session.claudeSdkAdapter = adapter;

    // Mark session as initialized immediately when the adapter attaches.
    // Resumed SDK sessions (unstable_v2_resumeSession) do NOT re-emit
    // system.init, so the session_init handler below never fires. Without
    // this, cliInitReceived stays false after server restart → isSessionIdle()
    // returns false → herd events are never delivered.
    session.cliInitReceived = true;

    // Flush messages that were queued while the adapter was disconnected
    // (e.g., herd events or user messages that arrived during a reconnect cycle).
    // Without this, queued messages are stranded forever since the SDK path
    // has no equivalent of the WebSocket handleCLIOpen flush (line ~3256).
    if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) on SDK adapter attach for session ${sessionTag(sessionId)}`);
      const queued = session.pendingMessages.splice(0);
      for (const raw of queued) {
        try {
          const msg = JSON.parse(raw) as BrowserOutgoingMessage;
          adapter.sendBrowserMessage(msg);
        } catch {
          // Corrupt queued message — skip
        }
      }
    }

    // Flush pending herd events now that isSessionIdle() can return true.
    if (this.herdEventDispatcher) {
      const orchInfo = this.launcher?.getSession(session.id);
      if (orchInfo?.isOrchestrator) {
        this.herdEventDispatcher.onOrchestratorTurnEnd(session.id);
      }
    }

    adapter.onBrowserMessage((msg) => {
      this.launcher?.touchActivity(session.id);
      session.lastCliMessageAt = Date.now();
      this.clearOptimisticRunningTimer(session, `sdk_output:${msg.type}`);

      // Track generation state for SDK sessions
      if (msg.type === "result") {
        session.consecutiveAdapterFailures = 0;
        session.lastAdapterFailureAt = null;
        // NOTE: Do NOT call setGenerating(false) here — handleResultMessage
        // (below) handles the full generation lifecycle through
        // reconcileTerminalResultState, same as WebSocket sessions.
        // Calling it here would: (1) promote queued turns prematurely,
        // (2) clear generationStartedAt before turnDurationMs can be
        // calculated, (3) emit a duplicate status:idle broadcast.
      }

      // Extract tool results from "user" messages (tool_result blocks).
      // The WebSocket path does this in handleToolResultMessage; SDK messages
      // bypass that handler, so we call it directly here.
      // Note: "user" is a CLI message type (not in BrowserIncomingMessage), but
      // the SDK adapter forwards raw CLI messages including this type.
      if ((msg as any).type === "user") {
        this.handleToolResultMessage(session, msg as any);
      }

      // SDK messages are already in BrowserIncomingMessage format — process them
      // through the same handler as CLI WebSocket messages.
      if (msg.type === "session_init") {
        const initMsg = msg as any;
        if (initMsg.session) {
          // Merge SDK init data into session state, but PRESERVE:
          // - session_id: the Companion UUID (not the CLI's internal ID)
          // - cwd: the launch cwd (worktree path / user-selected dir), not the
          //   CLI's resolved cwd which may differ (e.g., process.cwd() fallback)
          const companionSessionId = session.state.session_id;
          const launchCwd = session.state.cwd;
          session.state = { ...session.state, ...initMsg.session, backend_type: "claude-sdk" };
          session.state.session_id = companionSessionId;
          if (launchCwd) {
            session.state.cwd = launchCwd;
          }

          // Also fix the forwarded message so the browser sees correct IDs/cwd
          initMsg.session = { ...initMsg.session, session_id: companionSessionId, backend_type: "claude-sdk" };
          if (launchCwd) {
            initMsg.session.cwd = launchCwd;
          }
        }
        // Mark SDK session as initialized — mirrors cliInitReceived for WebSocket
        // sessions (set in handleSystemMessage on system.init). Without this,
        // isSessionIdle() always returns false for SDK sessions, blocking herd
        // event delivery entirely.
        session.cliInitReceived = true;
        this.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
        this.persistSession(session);

        // Flush pending herd events after SDK init — mirrors the WebSocket path
        // at system.init. Events accumulated during disconnect/relaunch are
        // delivered here now that isSessionIdle() can return true.
        if (this.herdEventDispatcher) {
          const launcherInfo = this.launcher?.getSession(session.id);
          if (launcherInfo?.isOrchestrator) {
            this.herdEventDispatcher.onOrchestratorTurnEnd(session.id);
          }
        }
      }

      // Intercept permission_request from SDK adapter — route through auto-approver
      // before broadcasting to browser. This mirrors the NDJSON permission flow.
      if (msg.type === "permission_request") {
        const permMsg = msg as { type: "permission_request"; request: PermissionRequest };
        const maybe = this.handleSdkPermissionRequest(session, permMsg.request);
        if (maybe instanceof Promise) {
          void maybe.catch((err) => {
            console.error(`[ws-bridge] SDK auto-approval error for session ${sessionTag(session.id)}:`, err);
          });
        }
        return; // Don't broadcast yet — handleSdkPermissionRequest will broadcast
      }

      // Route assistant messages through the unified handler so SDK sessions
      // get the same content-block accumulation, deduplication, tool timing,
      // and leader tag labeling as WebSocket sessions. This also ensures
      // messageHistory persists correctly for takode peek/read and survives
      // server restarts.
      if (msg.type === "assistant") {
        this.handleAssistantMessage(session, msg as any);
        return;
      }

      // Route result messages through the unified handler so SDK sessions get
      // the same post-turn state refresh (git, diff, attention, leader tag
      // enforcement) as WebSocket and Codex sessions.
      if (msg.type === "result") {
        this.handleResultMessage(session, (msg as any).data ?? msg as any);
        return;
      }

      // Persist task_notification in messageHistory so sub-agent completion
      // survives reconnects — mirrors the WebSocket path in handleCLISystemMessage.
      if (msg.type === "task_notification") {
        session.messageHistory.push(msg);
        this.broadcastToBrowsers(session, msg);
        this.persistSession(session);
        return;
      }

      // Forward to all browsers + store in history
      this.broadcastToBrowsers(session, msg);
    });

    adapter.onSessionMeta((meta) => {
      if (meta.cliSessionId) {
        // Store the CLI's internal session ID in the launcher for --resume.
        // Do NOT overwrite session.state.session_id — that's the Companion's
        // session ID which the browser uses as its primary key. Overwriting it
        // causes duplicate entries in the sidebar (same bug as WebSocket path,
        // see handleSystemMessage comment).
        this.launcher?.setCLISessionId(sessionId, meta.cliSessionId);
      }
      if (meta.model) session.state.model = meta.model;
    });

    adapter.onDisconnect(() => {
      const idleKilled = this.launcher?.getSession(sessionId)?.killedByIdleManager;
      const now = Date.now();
      if (
        session.lastAdapterFailureAt !== null
        && now - session.lastAdapterFailureAt > ADAPTER_FAILURE_RESET_WINDOW_MS
      ) {
        session.consecutiveAdapterFailures = 0;
      }
      session.lastAdapterFailureAt = now;
      session.consecutiveAdapterFailures++;
      console.log(`[ws-bridge] Claude SDK adapter disconnected for session ${sessionTag(sessionId)}${idleKilled ? " (idle limit)" : ""} (consecutive failures: ${session.consecutiveAdapterFailures})`);
      session.claudeSdkAdapter = null;
      session.cliInitReceived = false; // Reset — next adapter must send session_init before we deliver
      this.markTurnInterrupted(session, "system");
      this.setGenerating(session, false, "sdk_disconnect");
      this.broadcastToBrowsers(session, {
        type: "backend_disconnected",
        ...(idleKilled ? { reason: "idle_limit" as const } : {}),
      });
      this.broadcastToBrowsers(session, { type: "status_change", status: "idle" });

      // Auto-relaunch when a browser is actively connected, but cap retries
      // to prevent infinite respawn loops (e.g., "conversation ID not found").
      if (
        !idleKilled
        && this.onCLIRelaunchNeeded
        && session.browserSockets.size > 0
        && this.sessions.get(sessionId) === session
        && session.consecutiveAdapterFailures <= MAX_ADAPTER_RELAUNCH_FAILURES
      ) {
        console.log(`[ws-bridge] SDK adapter disconnected for active browser; requesting relaunch for session ${sessionTag(sessionId)} (attempt ${session.consecutiveAdapterFailures}/${MAX_ADAPTER_RELAUNCH_FAILURES})`);
        this.onCLIRelaunchNeeded(sessionId);
      } else if (session.consecutiveAdapterFailures > MAX_ADAPTER_RELAUNCH_FAILURES) {
        // SDK crash-looped — revert to WebSocket backend and try one more relaunch.
        // This recovers from corrupted SDK sessions (e.g. failed transport upgrades
        // that leave backendType as "claude-sdk" but the SDK can't resume).
        const launcherInfo = this.launcher?.getSession(sessionId);
        if (
          launcherInfo
          && !idleKilled
          && this.onCLIRelaunchNeeded
          && session.browserSockets.size > 0
          && this.sessions.get(sessionId) === session
        ) {
          console.warn(`[ws-bridge] SDK adapter for session ${sessionTag(sessionId)} exceeded ${MAX_ADAPTER_RELAUNCH_FAILURES} consecutive failures — reverting to WebSocket backend`);
          // Revert backend type in both ws-bridge session and launcher state
          session.backendType = "claude";
          session.state.backend_type = "claude";
          launcherInfo.backendType = "claude";
          // Reset failure counter so WebSocket relaunch isn't immediately blocked
          session.consecutiveAdapterFailures = 0;
          session.lastAdapterFailureAt = null;
          // Notify browsers about the backend switch
          this.broadcastSessionUpdate(sessionId, { backend_type: "claude" });
          this.broadcastToBrowsers(session, {
            type: "error",
            message: "SDK backend crash-looped — reverting to WebSocket mode.",
          });
          this.onCLIRelaunchNeeded(sessionId);
        } else {
          console.error(`[ws-bridge] SDK adapter for session ${sessionTag(sessionId)} exceeded ${MAX_ADAPTER_RELAUNCH_FAILURES} consecutive failures — stopping auto-relaunch`);
          this.broadcastToBrowsers(session, {
            type: "error",
            message: `Session stopped after ${MAX_ADAPTER_RELAUNCH_FAILURES} consecutive launch failures. Use the relaunch button to try again.`,
          });
        }
      }
    });

    adapter.onInitError((error) => {
      console.error(`[ws-bridge] Claude SDK adapter init failed for session ${sessionTag(sessionId)}: ${error}`);
      session.claudeSdkAdapter = null;
      // Notify browsers so the UI shows the disconnect state and the
      // relaunch button appears. Without this, the browser still thinks
      // the backend is connected after a failed relaunch.
      this.setGenerating(session, false, "sdk_init_error");
      this.broadcastToBrowsers(session, { type: "backend_disconnected" });
      this.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
    });

    this.broadcastToBrowsers(session, { type: "backend_connected" });
    console.log(`[ws-bridge] Claude SDK adapter attached for session ${sessionTag(sessionId)}`);
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    session.backendSocket = ws;

    // Cancel disconnect grace timer if the CLI reconnected within the window.
    // The CLI disconnects every ~5 minutes for token refresh and reconnects in ~13s.
    // If the grace timer is running, this reconnect is seamless — no events emitted.
    if (session.disconnectGraceTimer) {
      clearTimeout(session.disconnectGraceTimer);
      session.disconnectGraceTimer = null;
      session.seamlessReconnect = true;
      console.log(`[ws-bridge] CLI reconnected within grace period for session ${sessionTag(sessionId)} (seamless, wasGenerating=${session.disconnectWasGenerating})`);
    }

    // NOTE: Herd event flush is NOT done here — it's done after system.init
    // (in handleSystemMessage) when the CLI is fully ready. Flushing here would
    // send events before the CLI finishes --resume replay, causing silent drops.

    // When a CLI reconnects to an existing session (has history), mark it as
    // resuming. During --resume replay, the CLI sends stale system.status
    // messages with old permissionMode that would incorrectly overwrite uiMode
    // (e.g. reverting an ExitPlanMode approval). The flag is cleared via a
    // debounced timer after the last system.init (replay includes multiple
    // historical system.init messages, one per subagent invocation).
    if (session.messageHistory.length > 0) {
      // Cancel any pending clear timer from a previous connection.
      if (session.cliResumingClearTimer) {
        clearTimeout(session.cliResumingClearTimer);
        session.cliResumingClearTimer = null;
      }
      session.cliResuming = true;
    }
    console.log(`[ws-bridge] CLI connected for session ${sessionTag(sessionId)}${session.cliResuming ? " (resuming)" : ""}`);
    this.broadcastToBrowsers(session, { type: "backend_connected" });
    // Retry diff recomputation now that backend connectivity exists.
    this.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });

    // Flush any messages queued while waiting for the CLI WebSocket.
    // For NEW sessions: the first user message triggers system.init,
    // so we must send it as soon as the WebSocket is open.
    // For RESUMING sessions (reconnecting after disconnect/relaunch): defer
    // the flush until after system.init — the CLI replays its conversation
    // history first and may drop messages received before init completes.
    // The post-init flush at handleSystemMessage handles this case.
    // We detect resume by checking if the launcher has a cliSessionId
    // (set during the previous connection's system.init).
    const launcherInfo = this.launcher?.getSession(sessionId);
    const isResuming = !!launcherInfo?.cliSessionId;
    if (session.pendingMessages.length > 0 && !isResuming) {
      console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) on CLI connect for session ${sessionTag(sessionId)}`);
      const queued = session.pendingMessages.splice(0);
      for (const ndjson of queued) {
        this.sendToCLI(session, ndjson);
      }
    } else if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] ${session.pendingMessages.length} queued message(s) deferred until init for session ${sessionTag(sessionId)} (resuming)`);
    }
    this.onSessionActivityStateChanged(session.id, "cli_open");
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
        trafficStats.record({
          sessionId,
          channel: "cli",
          direction: "in",
          messageType: "invalid_json",
          payloadBytes: Buffer.byteLength(line, "utf-8"),
        });
        console.warn(`[ws-bridge] Failed to parse CLI message: ${line.substring(0, 200)}`);
        continue;
      }
      trafficStats.record({
        sessionId,
        channel: "cli",
        direction: "in",
        messageType: getTrafficMessageType(msg),
        payloadBytes: Buffer.byteLength(line, "utf-8"),
      });
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
    session.backendSocket = null;
    session.cliInitReceived = false; // Reset — next CLI must send system.init before we deliver
    // DON'T clear isGenerating here — defer to the grace period. During the grace
    // window, the UI already shows "disconnected" (backendSocket=null makes
    // deriveSessionStatus return null). If the CLI reconnects (token refresh),
    // isGenerating is preserved. If the grace period expires, runFullDisconnect
    // clears it properly with setGenerating() to emit turn_end events.
    this.onSessionActivityStateChanged(session.id, "cli_close");
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

    // Reset herd event in-flight state: if this orchestrator had events injected
    // but disconnected before consuming them, mark them for re-delivery.
    if (this.herdEventDispatcher) {
      const launcherInfo = this.launcher?.getSession(sessionId);
      if (launcherInfo?.isOrchestrator) {
        this.herdEventDispatcher.onOrchestratorDisconnect(sessionId);
      }
    }

    // ── Grace period: the Claude Code CLI disconnects every ~5 minutes for
    // token refresh and reconnects within ~13 seconds. Delay all side-effects
    // (events, permission cancel, relaunch) to allow seamless reconnect.
    // If the CLI reconnects within the grace window, handleCLIOpen cancels the
    // timer and the disconnect is invisible to the rest of the system.
    // Sticky: accumulate across multiple disconnects during grace period
    session.disconnectWasGenerating = session.disconnectWasGenerating || wasGenerating;
    if (session.disconnectGraceTimer) clearTimeout(session.disconnectGraceTimer);
    session.disconnectGraceTimer = setTimeout(() => {
      session.disconnectGraceTimer = null;
      // CLI didn't reconnect in time — run full disconnect
      if (!session.backendSocket) {
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
      this.markTurnInterrupted(session, "system");
      this.setGenerating(session, false, "cli_disconnect");
    }

    this.broadcastToBrowsers(session, {
      type: "backend_disconnected",
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
    this.onSessionActivityStateChanged(session.id, "full_disconnect");

    // Re-queue the in-flight user message if the CLI disconnected mid-turn.
    if (wasGenerating && !idleKilled) {
      if (session.lastOutboundUserNdjson) {
        // Only re-queue if the message isn't already in pendingMessages
        // (it could have been queued by sendToCLI during the grace period)
        const alreadyQueued = session.pendingMessages.some(m => m === session.lastOutboundUserNdjson);
        if (!alreadyQueued) {
          console.log(`[ws-bridge] Re-queuing in-flight user message for session ${sessionTag(sessionId)} (will re-send after reconnect)`);
          session.pendingMessages.push(session.lastOutboundUserNdjson);
        }
        session.lastOutboundUserNdjson = null;
      } else if (session.pendingMessages.length === 0) {
        // Agent was generating but no user message in flight AND nothing already
        // queued (e.g., no user message sent during grace period). Send a nudge
        // so the --resume'd CLI picks up where it left off.
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
      // else: messages already queued (e.g., user sent a message during grace period) — skip nudge
    }

    // Flush cleared permissions to disk
    this.persistSession(session);

    // Auto-relaunch after full disconnect (CLI didn't reconnect within grace period)
    if (!idleKilled && this.onCLIRelaunchNeeded) {
      this.onCLIRelaunchNeeded(sessionId);
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
    this.sendToBrowser(ws, {
      type: "codex_pending_inputs",
      inputs: session.pendingCodexInputs,
    });
    this.sendToBrowser(ws, {
      type: "session_order_update",
      sessionOrder: this.getSessionOrderState(),
    });
    this.sendToBrowser(ws, {
      type: "group_order_update",
      groupOrder: this.getGroupOrderState(),
    });
    this.sendVsCodeSelectionState(ws);

    // History replay and pending permissions are sent by handleSessionSubscribe
    // (triggered when the browser sends session_subscribe after onopen).
    // Sending them here too would cause double delivery, leading to duplicate
    // or tangled messages across sessions during reconnects.

    // Notify if backend is not attached and request relaunch.
    // Use backendAttached (not backendConnected) to avoid relaunching sessions
    // where the adapter exists but is still initializing.
    const hasBackendAttached = this.backendAttached(session);

    if (!hasBackendAttached) {
      const launcherInfo = this.launcher?.getSession(sessionId);
      // For SDK sessions during an active relaunch, the adapter attaches
      // synchronously so it should be ready within seconds — send backend_connected
      // optimistically.  However, after a server restart the adapter is gone
      // (state="exited") and we need to trigger a relaunch just like CLI sessions.
      if (launcherInfo?.backendType === "claude-sdk" && launcherInfo.state !== "exited") {
        this.sendToBrowser(ws, { type: "backend_connected" });
      } else if (launcherInfo?.state === "starting") {
        // CLI is starting up — don't request relaunch, just notify
        this.sendToBrowser(ws, { type: "backend_disconnected" });
      } else {
        const idleKilled = launcherInfo?.killedByIdleManager;
        this.sendToBrowser(ws, {
          type: "backend_disconnected",
          ...(idleKilled ? { reason: "idle_limit" as const } : {}),
        });
        if (this.onCLIRelaunchNeeded) {
          console.log(`[ws-bridge] Browser connected but backend is dead for session ${sessionTag(sessionId)}, requesting relaunch`);
          this.onCLIRelaunchNeeded(sessionId);
        }
      }
    } else {
      if (this.backendConnected(session)) {
        this.sendToBrowser(ws, { type: "backend_connected" });
      } else {
        this.sendToBrowser(ws, {
          type: "backend_disconnected",
          ...(session.state.backend_state === "broken" ? { reason: "broken" as const } : {}),
        });
      }
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
      trafficStats.record({
        sessionId,
        channel: "browser",
        direction: "in",
        messageType: "invalid_json",
        payloadBytes: Buffer.byteLength(data, "utf-8"),
      });
      console.warn(`[ws-bridge] Failed to parse browser message: ${data.substring(0, 200)}`);
      return;
    }
    trafficStats.record({
      sessionId,
      channel: "browser",
      direction: "in",
      messageType: getTrafficMessageType(msg),
      payloadBytes: Buffer.byteLength(data, "utf-8"),
    });

    void this.routeBrowserMessage(session, msg, ws).catch((err) => {
      if (msg.type === "user_message" && msg.images?.length) {
        this.notifyImageSendFailure(session, err);
        return;
      }
      console.error(`[ws-bridge] Failed to route browser message for session ${sessionTag(session.id)}:`, err);
      this.broadcastToBrowsers(session, {
        type: "error",
        message: "Failed to process message. Please retry.",
      });
    });

    if (this.perfTracer) {
      const perfMs = performance.now() - perfStart;
      if (perfMs > this.perfTracer.wsSlowThresholdMs) {
        this.perfTracer.recordSlowWsMessage(sessionId, "browser", msg.type, perfMs);
      }
    }
  }

  /** Send a user message into a session programmatically (no browser required).
   *  Used by the cron scheduler and takode CLI to send prompts.
   *  Returns delivery status so callers can distinguish live delivery from queuing. */
  injectUserMessage(sessionId: string, content: string, agentSource?: { sessionId: string; sessionLabel?: string }): "sent" | "queued" | "no_session" {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject message: session ${sessionId} not found`);
      return "no_session";
    }
    // Check backend connectivity BEFORE routing — if the backend is dead,
    // routeBrowserMessage will queue the message but the caller should know.
    const backendLive = this.backendConnected(session);
    this.routeBrowserMessage(session, {
      type: "user_message",
      content,
      ...(agentSource ? { agentSource } : {}),
    });

    // If the backend is dead, request a relaunch so queued messages will
    // eventually be flushed.  routeBrowserMessage already handles this for
    // Codex / Claude SDK (adapter-based) sessions, but the traditional
    // Claude Code (NDJSON) path only queues without triggering relaunch
    // because its relaunch normally fires from handleCLIClose or
    // handleBrowserOpen — neither of which run for REST-injected messages.
    if (!backendLive && this.onCLIRelaunchNeeded) {
      const launcherInfo = this.launcher?.getSession(sessionId);
      if (
        launcherInfo
        && launcherInfo.state === "exited"
        && !launcherInfo.killedByIdleManager
        && session.state.backend_state !== "broken"
      ) {
        console.log(`[ws-bridge] Injected message queued for exited session ${sessionTag(sessionId)}, requesting relaunch`);
        this.onCLIRelaunchNeeded(sessionId);
      }
    }

    return backendLive ? "sent" : "queued";
  }

  private isSystemSourceTag(agentSource: { sessionId: string; sessionLabel?: string } | undefined): boolean {
    if (!agentSource) return false;
    return agentSource.sessionId === "system" || agentSource.sessionId.startsWith("system:");
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>, code?: number, reason?: string) {
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.browserSockets.delete(ws);
    const hasBackend = this.backendConnected(session);
    console.log(`[ws-bridge] Browser disconnected for session ${sessionTag(sessionId)} (${session.browserSockets.size} remaining, backend=${hasBackend ? "alive" : "dead"}) | code=${code ?? "?"} reason=${JSON.stringify(reason || "")}`);
  }

  private shouldAcceptVsCodeSelectionUpdate(next: VsCodeSelectionState): boolean {
    const current = this.vscodeSelectionState;
    if (!current) return true;
    if (next.updatedAt !== current.updatedAt) {
      return next.updatedAt > current.updatedAt;
    }
    if (next.sourceId !== current.sourceId) {
      return next.sourceId > current.sourceId;
    }
    return true;
  }

  private sendVsCodeSelectionState(ws: ServerWebSocket<SocketData>): void {
    this.sendToBrowser(ws, {
      type: "vscode_selection_state",
      state: this.vscodeSelectionState,
    });
  }

  private broadcastVsCodeSelectionState(): void {
    const msg: Extract<BrowserIncomingMessage, { type: "vscode_selection_state" }> = {
      type: "vscode_selection_state",
      state: this.vscodeSelectionState,
    };
    for (const session of this.sessions.values()) {
      for (const ws of session.browserSockets) {
        this.sendToBrowser(ws, msg);
      }
    }
  }

  private handleVsCodeSelectionUpdate(
    msg: Extract<BrowserOutgoingMessage, { type: "vscode_selection_update" }>,
  ): boolean {
    const nextState: VsCodeSelectionState = {
      selection: msg.selection
        ? {
          absolutePath: msg.selection.absolutePath,
          startLine: msg.selection.startLine,
          endLine: msg.selection.endLine,
          lineCount: msg.selection.lineCount,
        }
        : null,
      updatedAt: msg.updatedAt,
      sourceId: msg.sourceId,
      sourceType: msg.sourceType,
      ...(msg.sourceLabel ? { sourceLabel: msg.sourceLabel } : {}),
    };

    return this.updateVsCodeSelectionState(nextState);
  }

  getVsCodeSelectionState(): VsCodeSelectionState | null {
    return this.vscodeSelectionState
      ? {
        ...this.vscodeSelectionState,
        selection: this.vscodeSelectionState.selection
          ? { ...this.vscodeSelectionState.selection }
          : null,
      }
      : null;
  }

  updateVsCodeSelectionState(nextState: VsCodeSelectionState): boolean {
    if (!this.shouldAcceptVsCodeSelectionUpdate(nextState)) {
      return false;
    }

    this.vscodeSelectionState = {
      ...nextState,
      selection: nextState.selection ? { ...nextState.selection } : null,
    };
    if (nextState.sourceType === "vscode-window") {
      const currentWindow = this.vscodeWindows.get(nextState.sourceId);
      if (currentWindow) {
        currentWindow.lastSeenAt = Date.now();
        currentWindow.lastActivityAt = Math.max(currentWindow.lastActivityAt, nextState.updatedAt);
        currentWindow.updatedAt = Math.max(currentWindow.updatedAt, nextState.updatedAt);
      }
    }
    this.broadcastVsCodeSelectionState();
    return true;
  }

  private cloneVsCodeWindowState(window: VsCodeWindowState): VsCodeWindowState {
    return {
      ...window,
      workspaceRoots: [...window.workspaceRoots],
    };
  }

  private normalizePathForVsCodeMatch(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+$/, "");
  }

  private getVsCodeWindowRootMatchLength(window: VsCodeWindowState, absolutePath: string): number {
    const normalizedPath = this.normalizePathForVsCodeMatch(absolutePath);
    let best = -1;
    for (const root of window.workspaceRoots) {
      const normalizedRoot = this.normalizePathForVsCodeMatch(root);
      if (!normalizedRoot) continue;
      if (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)) {
        best = Math.max(best, normalizedRoot.length);
      }
    }
    return best;
  }

  private getActiveVsCodeWindows(now = Date.now()): VsCodeWindowState[] {
    const active: VsCodeWindowState[] = [];
    for (const window of this.vscodeWindows.values()) {
      if (now - window.lastSeenAt <= WsBridge.VSCODE_WINDOW_STALE_MS) {
        active.push(window);
      }
    }
    return active;
  }

  private selectVsCodeWindowForFile(absolutePath: string): VsCodeWindowState | null {
    const candidates = this.getActiveVsCodeWindows();
    if (candidates.length === 0) return null;

    const ranked = candidates.map((window) => ({
      window,
      rootMatchLength: this.getVsCodeWindowRootMatchLength(window, absolutePath),
    }));

    ranked.sort((a, b) => {
      const aContains = a.rootMatchLength >= 0 ? 1 : 0;
      const bContains = b.rootMatchLength >= 0 ? 1 : 0;
      if (aContains !== bContains) return bContains - aContains;
      if (a.rootMatchLength !== b.rootMatchLength) return b.rootMatchLength - a.rootMatchLength;
      if (a.window.lastActivityAt !== b.window.lastActivityAt) {
        return b.window.lastActivityAt - a.window.lastActivityAt;
      }
      if (a.window.updatedAt !== b.window.updatedAt) {
        return b.window.updatedAt - a.window.updatedAt;
      }
      return a.window.sourceId.localeCompare(b.window.sourceId);
    });

    return ranked[0]?.window ?? null;
  }

  private getVsCodeOpenQueue(sourceId: string): VsCodeOpenFileCommand[] {
    let queue = this.vscodeOpenFileQueues.get(sourceId);
    if (!queue) {
      queue = [];
      this.vscodeOpenFileQueues.set(sourceId, queue);
    }
    return queue;
  }

  getVsCodeWindowStates(): VsCodeWindowState[] {
    return this.getActiveVsCodeWindows()
      .map((window) => this.cloneVsCodeWindowState(window))
      .sort((a, b) => {
        if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
        if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
        return a.sourceId.localeCompare(b.sourceId);
      });
  }

  upsertVsCodeWindowState(nextState: Omit<VsCodeWindowState, "lastSeenAt">): VsCodeWindowState {
    const current = this.vscodeWindows.get(nextState.sourceId);
    if (
      current
      && nextState.updatedAt < current.updatedAt
    ) {
      return this.cloneVsCodeWindowState(current);
    }

    const now = Date.now();
    const normalized: VsCodeWindowState = {
      sourceId: nextState.sourceId,
      sourceType: "vscode-window",
      workspaceRoots: [...new Set(nextState.workspaceRoots
        .filter((root) => typeof root === "string" && root.trim().length > 0)
        .map((root) => {
          const normalizedRoot = resolve(root).replace(/\\/g, "/");
          return normalizedRoot === "/" ? normalizedRoot : normalizedRoot.replace(/\/+$/, "");
        }))],
      updatedAt: nextState.updatedAt,
      lastActivityAt: nextState.lastActivityAt,
      lastSeenAt: now,
      ...(nextState.sourceLabel ? { sourceLabel: nextState.sourceLabel } : {}),
    };
    this.vscodeWindows.set(normalized.sourceId, normalized);
    return this.cloneVsCodeWindowState(normalized);
  }

  touchVsCodeWindow(sourceId: string): VsCodeWindowState | null {
    const current = this.vscodeWindows.get(sourceId);
    if (!current) return null;
    current.lastSeenAt = Date.now();
    return this.cloneVsCodeWindowState(current);
  }

  pollVsCodeOpenFileCommands(sourceId: string, limit = 1): VsCodeOpenFileCommand[] {
    this.touchVsCodeWindow(sourceId);
    const queue = this.vscodeOpenFileQueues.get(sourceId);
    if (!queue || queue.length === 0) return [];
    return queue.splice(0, Math.max(1, limit)).map((command) => ({
      ...command,
      target: { ...command.target },
    }));
  }

  resolveVsCodeOpenFileResult(
    sourceId: string,
    commandId: string,
    result: { ok: boolean; error?: string },
  ): boolean {
    const pending = this.pendingVsCodeOpenResults.get(commandId);
    if (!pending) return false;
    this.pendingVsCodeOpenResults.delete(commandId);
    clearTimeout(pending.timeout);
    this.touchVsCodeWindow(sourceId);
    if (result.ok) {
      pending.resolve();
    } else {
      pending.reject(new Error(result.error?.trim() || "VS Code failed to open the requested file."));
    }
    return true;
  }

  async requestVsCodeOpenFile(
    target: { absolutePath: string; line?: number; column?: number; endLine?: number },
    options?: { timeoutMs?: number },
  ): Promise<{ sourceId: string; commandId: string }> {
    const sourceWindow = this.selectVsCodeWindowForFile(target.absolutePath);
    if (!sourceWindow) {
      throw new Error("No running VS Code was detected on this machine.");
    }

    const command: VsCodeOpenFileCommand = {
      commandId: randomUUID(),
      sourceId: sourceWindow.sourceId,
      target: {
        absolutePath: target.absolutePath,
        line: Math.max(1, target.line ?? 1),
        column: Math.max(1, target.column ?? 1),
        ...(Number.isFinite(target.endLine) ? { endLine: Math.max(Math.max(1, target.line ?? 1), Number(target.endLine)) } : {}),
      },
      createdAt: Date.now(),
    };
    this.getVsCodeOpenQueue(sourceWindow.sourceId).push(command);

    const timeoutMs = options?.timeoutMs ?? WsBridge.VSCODE_OPEN_FILE_TIMEOUT_MS;
    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingVsCodeOpenResults.delete(command.commandId);
        reject(new Error("Timed out waiting for VSCode on this machine to open the file."));
      }, timeoutMs);
      this.pendingVsCodeOpenResults.set(command.commandId, { resolve, reject, timeout });
    });

    await completion;
    return {
      sourceId: sourceWindow.sourceId,
      commandId: command.commandId,
    };
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
      this.clearOptimisticRunningTimer(session, `cli_output:${msg.type}`);
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
      // Mark CLI as fully initialized — safe to send messages now
      session.cliInitReceived = true;

      // Keep the launcher-assigned session_id as the canonical ID.
      // The CLI may report its own internal session_id which differs
      // from the launcher UUID, causing duplicate entries in the sidebar.

      // Store the CLI's internal session_id so we can --resume on relaunch
      if (msg.session_id && this.onCLISessionId) {
        this.onCLISessionId(session.id, msg.session_id);
      }

      session.state.model = msg.model;
      // Initialize context usage details from the model name so the UI shows
      // the context bar immediately, before the first result message arrives
      // with actual token counts.
      const inferredContextWindow = inferContextWindowFromModel(msg.model);
      if (inferredContextWindow && !session.state.claude_token_details) {
        session.state.claude_token_details = {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          modelContextWindow: inferredContextWindow,
        };
      }
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
      // During --resume replay, the CLI replays ALL historical system.init
      // messages (one per subagent/Task invocation). We can't clear cliResuming
      // on the first system.init because the replay isn't done — later replayed
      // system.status messages would slip through the compaction/uiMode guards.
      // Instead, debounce: clear cliResuming 2s after the LAST system.init.
      if (session.cliResuming) {
        if (session.cliResumingClearTimer) clearTimeout(session.cliResumingClearTimer);
        session.cliResumingClearTimer = setTimeout(() => {
          session.cliResumingClearTimer = null;
          session.cliResuming = false;
          // Reset stale compaction state now that replay is truly done.
          session.state.is_compacting = false;
        }, 2000);
      } else {
        // Not resuming — clear compaction state immediately.
        session.state.is_compacting = false;
      }
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

      // Force-clear isGenerating on system.init ONLY for actual relaunches (new CLI
      // process via --resume). On seamless reconnects (5-minute token refresh), the CLI
      // process is still alive and may still be mid-generation — clearing isGenerating
      // would emit a false turn_end takode event while the agent is still working.
      // Also preserve running state if we already dispatched a user message and are
      // waiting for that turn's backend output, to avoid a spurious turn_end before
      // the real turn starts producing output.
      if (session.isGenerating && !session.seamlessReconnect) {
        const hasInFlightUserDispatch =
          typeof session.lastOutboundUserNdjson === "string"
          && this.isCliUserMessagePayload(session.lastOutboundUserNdjson);
        if (hasInFlightUserDispatch) {
          console.log(`[ws-bridge] Preserving running state on system.init for in-flight user dispatch in session ${sessionTag(session.id)}`);
        } else {
          console.log(`[ws-bridge] Force-clearing stale isGenerating on system.init for session ${sessionTag(session.id)}`);
          this.markTurnInterrupted(session, "system");
          this.setGenerating(session, false, "system_init_reset");
          this.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
        }
      }
      // Clear the seamless reconnect flag — consumed. Future system.init messages
      // (from actual relaunches) should force-clear isGenerating normally.
      session.seamlessReconnect = false;
      session.disconnectWasGenerating = false;

      // Flush any messages queued before CLI was initialized (e.g. user sent
      // a message while the container was still starting up).
      if (session.pendingMessages.length > 0) {
        console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) after init for session ${sessionTag(session.id)}`);
        const queued = session.pendingMessages.splice(0);
        for (const ndjson of queued) {
          this.sendToCLI(session, ndjson);
        }
      }

      // Flush pending herd events AFTER system.init — this is the safe moment
      // when the CLI has completed --resume replay and is ready for new messages.
      // Events accumulated in the herd inbox during the disconnect/relaunch cycle
      // are delivered here, making event loss impossible by construction.
      if (this.herdEventDispatcher) {
        const launcherInfo = this.launcher?.getSession(session.id);
        if (launcherInfo?.isOrchestrator) {
          this.herdEventDispatcher.onOrchestratorTurnEnd(session.id);
        }
      }
      this.onSessionActivityStateChanged(session.id, "system_init");
    } else if (msg.subtype === "status") {
      const wasCompacting = session.state.is_compacting;
      session.state.is_compacting = msg.status === "compacting";
      // Guard: only emit compaction_started for NEW compaction transitions (not
      // re-notifications of already-known compaction) and skip --resume replay
      // which replays stale status messages from the CLI's history.
      // NOTE: Do NOT call setGenerating(false) here. Compaction is not a turn
      // boundary — the CLI continues its turn after compaction. Killing the
      // generation lifecycle mid-turn means the actual result at end of turn
      // is a no-op (isGenerating already false), leaving the session stuck as
      // idle while still actively working.
      if (msg.status === "compacting" && !wasCompacting && !session.cliResuming) {
        session.compactedDuringTurn = true;
        this.emitTakodeEvent(session.id, "compaction_started", {
          ...(typeof session.state.context_used_percent === "number"
            ? { context_used_percent: session.state.context_used_percent }
            : {}),
        });
      }
      if (wasCompacting && msg.status !== "compacting" && !session.cliResuming) {
        this.emitTakodeEvent(session.id, "compaction_finished", {
          ...(typeof session.state.context_used_percent === "number"
            ? { context_used_percent: session.state.context_used_percent }
            : {}),
        });
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
      this.onSessionActivityStateChanged(session.id, "system_status");
    } else if (msg.subtype === "compact_boundary") {
      // CLI has compacted its context — append a compact marker as a divider.
      // Old messages are preserved for browser display; the marker visually separates
      // pre- and post-compaction segments. The next CLI "user" message with a text
      // block will contain the compaction summary.
      const cliUuid = (msg as CLISystemCompactBoundaryMessage).uuid;
      const meta = (msg as CLISystemCompactBoundaryMessage).compact_metadata;

      // Dedup: CLI replays compact_boundary on --resume. Skip if a marker with
      // the same CLI uuid already exists in history (replay after server restart).
      if (this.hasCompactBoundaryReplay(session, cliUuid, meta)) return;

      const ts = Date.now();
      const markerId = `compact-boundary-${ts}`;
      session.messageHistory.push({
        type: "compact_marker" as const,
        timestamp: ts,
        id: markerId,
        cliUuid,
        trigger: meta?.trigger,
        preTokens: meta?.pre_tokens,
      });
      this.freezeHistoryThroughCurrentTail(session);
      const preTokenContextPct = computePreTokenContextUsedPercent(
        session.state.model,
        meta?.pre_tokens,
      );
      if (typeof preTokenContextPct === "number" && preTokenContextPct !== session.state.context_used_percent) {
        session.state.context_used_percent = preTokenContextPct;
        this.broadcastToBrowsers(session, {
          type: "session_update",
          session: { context_used_percent: preTokenContextPct },
        });
      }
      session.awaitingCompactSummary = true;
      this.broadcastToBrowsers(session, {
        type: "compact_boundary",
        id: markerId,
        timestamp: ts,
        trigger: meta?.trigger,
        preTokens: meta?.pre_tokens,
      });
      this.persistSession(session);
    } else if (msg.subtype === "task_notification") {
      // Forward background agent completion notifications to browsers.
      // Persist in messageHistory so completion survives reconnects/page refreshes.
      const browserMsg = {
        type: "task_notification" as const,
        task_id: msg.task_id,
        tool_use_id: msg.tool_use_id,
        status: msg.status,
        output_file: msg.output_file,
        summary: msg.summary,
      };
      session.messageHistory.push(browserMsg);
      this.broadcastToBrowsers(session, browserMsg);
      this.persistSession(session);
    }
  }

  private handleAssistantMessage(session: Session, msg: CLIAssistantMessage) {
    const msgId = msg.message?.id;

    // No ID — forward as-is (defensive)
    if (!msgId) {
      const addressing = this.classifyLeaderAssistantAddressing(session, msg.message.content);
      const leaderUserAddressed = addressing === "user";
      const browserMsg: BrowserIncomingMessage = {
        type: "assistant",
        message: msg.message,
        parent_tool_use_id: msg.parent_tool_use_id,
        timestamp: Date.now(),
        uuid: msg.uuid,
        ...(leaderUserAddressed ? { leader_user_addressed: true } : {}),
      };
      session.messageHistory.push(browserMsg);
      this.broadcastToBrowsers(session, browserMsg);
      this.maybeUpdateContextUsedPercentFromAssistantUsage(session, msg.message.usage, msg.message.model);
      // NOTE: Do NOT inject leader addressing reminder here.
      // Deferred to handleResultMessage (turn end).
      this.persistSession(session);
      return;
    }

    const acc = session.assistantAccumulator.get(msgId);

    if (!acc) {
      // No accumulator — either first time seeing this message, or a replay
      // after server restart (accumulators are in-memory only).
      if (this.hasAssistantReplay(session, msgId)) return;

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
            session.toolProgressOutput.delete(block.id);
            toolStartTimesMap[block.id] = session.toolStartTimes.get(block.id)!;
          }
        }

        const addressing = this.classifyLeaderAssistantAddressing(session, msg.message.content);
        const browserMsg: BrowserIncomingMessage = {
          type: "assistant",
          message: { ...msg.message, content: [...msg.message.content] },
          parent_tool_use_id: msg.parent_tool_use_id,
          timestamp: Date.now(),
          uuid: msg.uuid,
          ...(addressing === "user"
            ? { leader_user_addressed: true }
            : {}),
          ...(Object.keys(toolStartTimesMap).length > 0 ? { tool_start_times: toolStartTimesMap } : {}),
        };
        const accEntry = { contentBlockIds };
        session.assistantAccumulator.set(msgId, accEntry);
        session.messageHistory.push(browserMsg);
        this.broadcastToBrowsers(session, browserMsg);
        // NOTE: Do NOT inject the leader addressing reminder here.
        // This is an intermediate assistant message — the agent may add the
        // @to(user)/@to(self) tag in a later text block after tool calls.
        // The reminder is deferred to handleResultMessage (turn end).
      }
    } else {
      // Subsequent occurrence — merge new content blocks into the history entry
      const historyEntry = session.messageHistory.findLast(
        (m) => m.type === "assistant" && (m as { message?: { id?: string } }).message?.id === msgId,
      ) as { type: "assistant"; message: CLIAssistantMessage["message"]; timestamp?: number; leader_user_addressed?: boolean } | undefined;

      if (!historyEntry) return; // shouldn't happen

      for (const block of msg.message.content) {
        if (block.type === "tool_use" && block.id) {
          if (acc.contentBlockIds.has(block.id)) continue;
          acc.contentBlockIds.add(block.id);
          if (!session.toolStartTimes.has(block.id)) {
            session.toolStartTimes.set(block.id, Date.now());
          }
          session.toolProgressOutput.delete(block.id);
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
      const addressing = this.classifyLeaderAssistantAddressing(session, historyEntry.message.content);
      if (addressing === "user") {
        historyEntry.leader_user_addressed = true;
      } else {
        delete historyEntry.leader_user_addressed;
      }
      // Re-broadcast the full accumulated message with tool start times
      const rebroadcast: BrowserIncomingMessage = {
        ...(historyEntry as BrowserIncomingMessage),
        ...(Object.keys(allToolStartTimes).length > 0 ? { tool_start_times: allToolStartTimes } : {}),
      };
      this.broadcastToBrowsers(session, rebroadcast);
      // NOTE: Do NOT inject the leader addressing reminder here.
      // Deferred to handleResultMessage (turn end) to avoid false nudges
      // during intermediate tool-call gaps.
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

    this.maybeUpdateContextUsedPercentFromAssistantUsage(session, msg.message.usage, msg.message.model);
    this.persistSession(session);
  }

  private maybeUpdateContextUsedPercentFromAssistantUsage(
    session: Session,
    usage: TokenUsage | undefined,
    modelHint: string | undefined,
  ) {
    if (!usage) return;
    const model = session.state.model || modelHint;
    const contextWindow = resolveResultContextWindow(model, undefined);
    if (!contextWindow) return;
    const nextContextPct = computeContextUsedPercent(usage, contextWindow);
    if (typeof nextContextPct !== "number") return;
    if (session.state.context_used_percent === nextContextPct) return;
    session.state.context_used_percent = nextContextPct;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { context_used_percent: nextContextPct },
    });
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
    // Still reconcile lifecycle drift so a replayed terminal result can clear
    // stale running/stuck state after reconnect.
    if (msg.uuid) {
      if (this.hasResultReplay(session, msg.uuid)) {
        const reconciled = reconcileTerminalResultStateLifecycle(
          this.getGenerationLifecycleDeps(),
          session,
          "result_replay",
        );
        if (reconciled.clearedResidualState) {
          this.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
          this.persistSession(session);
        }
        return;
      }
    }

    // Update session cost/turns
    session.state.total_cost_usd = msg.total_cost_usd;
    session.state.num_turns = msg.num_turns;

    // Extract per-turn usage from the last top-level assistant message.
    // This is the accurate context fill for the most recent API call, unlike
    // msg.usage which is cumulative across the entire session.
    const lastAssistant = session.messageHistory.findLast(
      (m) => m.type === "assistant" && (m as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
    ) as { message?: { usage?: TokenUsage } } | undefined;
    const lastAssistantUsage = lastAssistant?.message?.usage;

    const nextContextPct = computeResultContextUsedPercent(session.state.model, msg, lastAssistantUsage);
    if (typeof nextContextPct === "number") {
      session.state.context_used_percent = nextContextPct;
    }
    const nextClaudeTokenDetails = extractClaudeTokenDetails(msg.modelUsage);
    if (nextClaudeTokenDetails) {
      session.state.claude_token_details = nextClaudeTokenDetails;
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
        ...(nextClaudeTokenDetails ? { claude_token_details: nextClaudeTokenDetails } : {}),
      },
    });

    const turnDurationMs =
      typeof session.generationStartedAt === "number"
        ? Math.max(0, Date.now() - session.generationStartedAt)
        : undefined;

    const stopReason = typeof msg.stop_reason === "string" ? msg.stop_reason.toLowerCase() : "";
    const resultInterrupted = stopReason.includes("interrupt") || stopReason.includes("cancel");
    if (resultInterrupted && !session.interruptedDuringTurn && session.queuedTurnStarts > 0) {
      const queuedInterruptSource = session.queuedTurnInterruptSources[0] ?? "user";
      this.markTurnInterrupted(session, queuedInterruptSource);
    }
    const turnWasInterrupted = session.interruptedDuringTurn || resultInterrupted;

    const turnTriggerSource = this.getCurrentTurnTriggerSource(session);
    reconcileTerminalResultStateLifecycle(this.getGenerationLifecycleDeps(), session, "result");
    this.finalizeOrphanedTerminalToolsOnResult(session, msg);
    // Broadcast idle status for backends that don't send a separate
    // system.status message after result (e.g. Claude SDK via Agent SDK).
    // WebSocket sessions get idle via CLI's system.status {status:null},
    // but SDK sessions only get result → no status follow-up. Without this,
    // the UI stays in "running" state after the turn completes.
    if (!session.isGenerating) {
      this.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
    }
    // Turn completed — the user message was processed. Clear the re-queue
    // tracker so we don't re-send it on a subsequent disconnect.
    session.lastOutboundUserNdjson = null;
    const shouldNotifyHuman = this.shouldNotifyHumanOnResult(session, turnTriggerSource);

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
      this.onSessionActivityStateChanged(session.id, "result_cleared_permissions");
    }

    const browserMsg: BrowserIncomingMessage = {
      type: "result",
      data: msg,
    };
    session.messageHistory.push(browserMsg);
    this.freezeHistoryThroughCurrentTail(session);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);

    // ── Leader addressing enforcement (deferred from assistant messages) ──
    // Now that the turn is complete, check the latest top-level assistant
    // message for the @to(user)/@to(self) tag. Previously this ran on every
    // intermediate assistant message, causing false nudges during tool-call
    // gaps before the agent's final text response.
    const latestTopLevelAssistant = session.messageHistory.findLast(
      (m) => m.type === "assistant" && (m as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
    ) as (BrowserIncomingMessage & { type: "assistant"; message: { content: ContentBlock[] } }) | undefined;
    if (latestTopLevelAssistant) {
      const addressing = this.classifyLeaderAssistantAddressing(session, latestTopLevelAssistant.message.content);
      this.maybeInjectLeaderAddressingReminder(session, addressing, turnTriggerSource, turnWasInterrupted);
    }

    // Set attention only when this turn should surface to the human.
    if (shouldNotifyHuman) {
      this.setAttention(
        session,
        msg.is_error ? "error" : "review",
        { allowHerdedWorker: this.isHerdedWorkerSession(session) && turnTriggerSource === "user" },
      );
    }

    // Takode: session_error when the result indicates an error
    if (msg.is_error) {
      this.emitTakodeEvent(session.id, "session_error", {
        error: typeof msg.result === "string" ? msg.result.slice(0, 200) : "Unknown error",
      });
    }

    // Schedule Pushover notification for session completion/error
    if (this.pushoverNotifier && shouldNotifyHuman) {
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
    return isSensitiveConfigPathPolicy(filePath);
  }

  /** Check if a Bash command targets sensitive config files (CLAUDE.md, hooks, settings, etc.).
   *  Used to skip LLM auto-approval for commands that could modify agent behavior. */
  private static isSensitiveBashCommand(command: string): boolean {
    return isSensitiveBashCommandPolicy(command);
  }

  private handleControlRequest(session: Session, msg: CLIControlRequestMessage): void {
    if (msg.request.subtype !== "can_use_tool") return;
    const toolName = msg.request.tool_name;
    const applyResult = (result: PermissionPipelineResult): void => {
      if (result.kind === "mode_auto_approved" || result.kind === "settings_rule_approved") {
        const ndjson = JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: result.request.request_id,
            response: {
              behavior: "allow",
              updatedInput: result.request.input,
            },
          },
        });
        this.sendToCLI(session, ndjson);
        return;
      }

      if (result.kind === "queued_for_llm_auto_approval") {
        this.tryLlmAutoApproval(
          session,
          result.request.request_id,
          result.request,
          result.autoApprovalConfig,
        );
      }

      // Trigger auto-naming when agent pauses for plan approval — the agent
      // has done meaningful work and the plan provides rich naming context.
      if (toolName === "ExitPlanMode" && this.onAgentPaused) {
        this.onAgentPaused(session.id, [...session.messageHistory], session.state.cwd);
      }
    };

    const resultOrPromise = handlePermissionRequestPipeline(
      session,
      {
        request_id: msg.request_id,
        tool_name: toolName,
        input: msg.request.input,
        permission_suggestions: msg.request.permission_suggestions,
        description: msg.request.description,
        tool_use_id: msg.request.tool_use_id,
        agent_id: msg.request.agent_id,
      },
      "claude-ws",
      {
        onSessionActivityStateChanged: (sessionId, reason) => this.onSessionActivityStateChanged(sessionId, reason),
        broadcastPermissionRequest: (targetSession, perm) => this.broadcastToBrowsers(targetSession, {
          type: "permission_request",
          request: perm,
        }),
        persistSession: (targetSession) => this.persistSession(targetSession),
        setAttentionAction: (targetSession) => this.setAttention(targetSession, "action"),
        emitTakodePermissionRequest: (targetSession, perm) => this.emitTakodeEvent(targetSession.id, "permission_request", {
          tool_name: perm.tool_name,
          request_id: perm.request_id,
          summary: perm.description || perm.tool_name,
          ...this.buildPermissionPreview(perm),
        }),
        schedulePermissionNotification: (targetSession, perm) => {
          if (!this.pushoverNotifier) return;
          const eventType = perm.tool_name === "AskUserQuestion" ? "question" as const : "permission" as const;
          const detail = perm.tool_name + (perm.description ? `: ${perm.description}` : "");
          this.pushoverNotifier.scheduleNotification(targetSession.id, eventType, detail, perm.request_id);
        },
      },
      { activityReason: "permission_request" },
    );

    if (resultOrPromise instanceof Promise) {
      void resultOrPromise.then((result) => {
        applyResult(result);
      }).catch((err) => {
        console.error(`[ws-bridge] Failed to process control_request for session ${sessionTag(session.id)}:`, err);
      });
      return;
    }

    applyResult(resultOrPromise);
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

  /**
   * Handle a permission request from the Claude SDK adapter.
   * Routes through the auto-approver (same logic as NDJSON sessions),
   * then broadcasts to browsers. If auto-approved, sends the response
   * directly back to the SDK adapter.
   */
  private handleSdkPermissionRequest(session: Session, perm: PermissionRequest): void | Promise<void> {
    const applyResult = (result: PermissionPipelineResult): void => {
      if (result.kind === "mode_auto_approved" || result.kind === "settings_rule_approved") {
        // Auto-approve: send response directly back to the SDK adapter
        if (session.claudeSdkAdapter) {
          session.claudeSdkAdapter.sendBrowserMessage({
            type: "permission_response",
            request_id: result.request.request_id,
            behavior: "allow",
            updated_input: result.request.input,
          } as any);
        }
        // Broadcast approval to browsers for UI consistency
        const approvedMsg: BrowserIncomingMessage = {
          type: "permission_approved",
          id: `approval-${result.request.request_id}`,
          request_id: result.request.request_id,
          tool_name: result.request.tool_name,
          tool_use_id: result.request.tool_use_id,
          summary: getApprovalSummary(result.request.tool_name, result.request.input),
          timestamp: Date.now(),
        };
        session.messageHistory.push(approvedMsg);
        this.broadcastToBrowsers(session, approvedMsg);
        this.persistSession(session);
        return;
      }

      if (result.kind === "queued_for_llm_auto_approval") {
        this.tryLlmAutoApproval(session, result.request.request_id, result.request, result.autoApprovalConfig);
      }
    };

    const resultOrPromise = handlePermissionRequestPipeline(
      session,
      perm,
      "claude-sdk",
      {
        onSessionActivityStateChanged: (sessionId, reason) => this.onSessionActivityStateChanged(sessionId, reason),
        broadcastPermissionRequest: (targetSession, request) => this.broadcastToBrowsers(targetSession, {
          type: "permission_request",
          request,
        }),
        persistSession: (targetSession) => this.persistSession(targetSession),
        setAttentionAction: (targetSession) => this.setAttention(targetSession, "action"),
        emitTakodePermissionRequest: (targetSession, request) => this.emitTakodeEvent(targetSession.id, "permission_request", {
          tool_name: request.tool_name,
          summary: request.description || request.tool_name,
        }),
        schedulePermissionNotification: (targetSession, request) => {
          if (!this.pushoverNotifier) return;
          const eventType = request.tool_name === "AskUserQuestion" ? "question" as const : "permission" as const;
          const detail = request.tool_name + (request.description ? `: ${request.description}` : "");
          this.pushoverNotifier.scheduleNotification(targetSession.id, eventType, detail, request.request_id);
        },
      },
      { activityReason: "sdk_permission_request" },
    );

    if (resultOrPromise instanceof Promise) {
      return resultOrPromise.then((result) => {
        applyResult(result);
      });
    }

    applyResult(resultOrPromise);
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
        this.onSessionActivityStateChanged(session.id, "auto_approved_permission");
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
        // Route approval through the correct backend
        if (session.backendType === "claude-sdk" && session.claudeSdkAdapter) {
          session.claudeSdkAdapter.sendBrowserMessage({
            type: "permission_response",
            request_id: requestId,
            behavior: "allow",
            updated_input: perm.input,
          } as any);
        } else if (session.backendType === "codex" && session.codexAdapter) {
          session.codexAdapter.sendBrowserMessage({
            type: "permission_response",
            request_id: requestId,
            behavior: "allow",
            updated_input: perm.input,
          } as any);
        } else {
          this.sendToCLI(session, ndjson);
        }

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
        // Set deferralReason so the browser can explain WHY the permission needs human review.
        const deferralReason = result?.decision === "defer"
          ? (result.reason || "Auto-approver deferred to human")
          : "Auto-approval evaluation failed or timed out";
        perm.evaluating = undefined;
        perm.deferralReason = deferralReason;

        this.broadcastToBrowsers(session, {
          type: "permission_needs_attention",
          request_id: requestId,
          timestamp: Date.now(),
          reason: deferralReason,
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
        const errorReason = "Auto-approval evaluation encountered an error";
        perm.evaluating = undefined;
        perm.deferralReason = errorReason;
        this.broadcastToBrowsers(session, {
          type: "permission_needs_attention",
          request_id: requestId,
          timestamp: Date.now(),
          reason: errorReason,
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
    if (typeof msg.output_delta === "string" && msg.output_delta.length > 0) {
      const prev = session.toolProgressOutput.get(msg.tool_use_id) || "";
      const merged = prev + msg.output_delta;
      session.toolProgressOutput.set(
        msg.tool_use_id,
        merged.length > TOOL_PROGRESS_OUTPUT_LIMIT
          ? merged.slice(-TOOL_PROGRESS_OUTPUT_LIMIT)
          : merged,
      );
    }
    // Track sub-agent liveness for stuck detection — prevents false "stuck"
    // warnings when the main agent is idle waiting for long-running sub-agents.
    if (msg.tool_name === "Agent" || msg.tool_name === "Task") {
      session.lastSubagentProgressAt = Date.now();
    }
    this.broadcastToBrowsers(session, {
      type: "tool_progress",
      tool_use_id: msg.tool_use_id,
      tool_name: msg.tool_name,
      elapsed_time_seconds: msg.elapsed_time_seconds,
      ...(typeof msg.output_delta === "string" ? { output_delta: msg.output_delta } : {}),
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
      if (this.hasUserPromptReplay(session, cliUuid)) return;
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
    const newToolResults = toolResults.filter((block) => {
      if (!this.hasToolResultPreviewReplay(session, block.tool_use_id)) return true;
      // Replay must be idempotent: if the preview is already in history, do
      // not append it again or it becomes an ever-growing hot tail after the
      // replayed result is deduplicated.
      this.clearCodexToolResultWatchdog(session, block.tool_use_id);
      session.toolStartTimes.delete(block.tool_use_id);
      return false;
    });
    const completedToolStartTimes = this.collectCompletedToolStartTimes(session, newToolResults);
    const previews = this.buildToolResultPreviews(session, newToolResults);

    if (previews.length === 0) return;

    const browserMsg: BrowserIncomingMessage = {
      type: "tool_result_preview",
      previews,
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);
    this.finalizeSupersededCodexTerminalTools(session, completedToolStartTimes);
  }

  private clearCodexToolResultWatchdog(session: Session, toolUseId: string): void {
    const timer = session.codexToolResultWatchdogs.get(toolUseId);
    if (!timer) return;
    clearTimeout(timer);
    session.codexToolResultWatchdogs.delete(toolUseId);
  }

  private clearAllCodexToolResultWatchdogs(session: Session, _reason: string): void {
    for (const timer of session.codexToolResultWatchdogs.values()) {
      clearTimeout(timer);
    }
    session.codexToolResultWatchdogs.clear();
  }

  private collectCompletedToolStartTimes(
    session: Session,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ): number[] {
    const completedToolStartTimes: number[] = [];
    for (const block of toolResults) {
      const startedAt = session.toolStartTimes.get(block.tool_use_id);
      if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
        completedToolStartTimes.push(startedAt);
      }
    }
    return completedToolStartTimes;
  }

  private emitSyntheticToolResultPreview(
    session: Session,
    toolUseId: string,
    content: string,
    isError: boolean,
    reason: string,
  ): void {
    if (!session.toolStartTimes.has(toolUseId)) return;
    if (this.hasToolResultPreviewReplay(session, toolUseId)) {
      this.clearCodexToolResultWatchdog(session, toolUseId);
      session.toolStartTimes.delete(toolUseId);
      return;
    }
    this.clearCodexToolResultWatchdog(session, toolUseId);

    const retainedOutput = session.toolProgressOutput.get(toolUseId)?.trim();
    if (retainedOutput) {
      content = retainedOutput;
    }

    const totalSize = content.length;
    const isTruncated = totalSize > TOOL_RESULT_PREVIEW_LIMIT;
    const startedAt = session.toolStartTimes.get(toolUseId);
    const durationSeconds = startedAt != null
      ? Math.round((Date.now() - startedAt) / 100) / 10
      : undefined;
    session.toolStartTimes.delete(toolUseId);
    session.toolProgressOutput.delete(toolUseId);
    session.toolResults.set(toolUseId, {
      content,
      is_error: isError,
      timestamp: Date.now(),
    });

    const preview: ToolResultPreview = {
      tool_use_id: toolUseId,
      content: isTruncated ? content.slice(-TOOL_RESULT_PREVIEW_LIMIT) : content,
      is_error: isError,
      total_size: totalSize,
      is_truncated: isTruncated,
      duration_seconds: durationSeconds,
    };
    const browserMsg: BrowserIncomingMessage = {
      type: "tool_result_preview",
      previews: [preview],
    };
    session.messageHistory.push(browserMsg);
    this.broadcastToBrowsers(session, browserMsg);
    this.persistSession(session);
    console.warn(
      `[ws-bridge] Synthesized tool_result_preview for orphaned tool ${toolUseId} in session ${sessionTag(session.id)} (${reason})`,
    );
  }

  private finalizeSupersededCodexTerminalTools(session: Session, completedToolStartTimes: number[]): void {
    if (session.backendType !== "codex") return;
    if (completedToolStartTimes.length === 0) return;

    const newestCompletedToolStart = Math.max(...completedToolStartTimes);
    for (const [toolUseId, startedAt] of [...session.toolStartTimes.entries()]) {
      if (!(startedAt < newestCompletedToolStart)) continue;
      const toolName = this.findToolUseNameInHistory(session, toolUseId);
      if (toolName !== "Bash") continue;
      this.emitSyntheticToolResultPreview(
        session,
        toolUseId,
        "Terminal command did not deliver a final result after a later tool completed.",
        false,
        "superseded_by_later_completed_tool",
      );
    }
  }

  private findToolUseNameInHistory(session: Session, toolUseId: string): string | null {
    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      const msg = session.messageHistory[i];
      if (msg.type !== "assistant") continue;
      const content = (msg as { message?: { content?: ContentBlock[] } }).message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          return typeof block.name === "string" ? block.name : null;
        }
      }
    }
    return null;
  }

  private collectUnresolvedToolStartTimesFromHistory(session: Session): Map<string, number> {
    const starts = new Map<string, number>();
    const resolved = new Set<string>();

    for (const msg of session.messageHistory) {
      if (msg.type === "assistant") {
        const raw = (msg as Record<string, unknown>).tool_start_times;
        if (raw && typeof raw === "object") {
          for (const [toolUseId, ts] of Object.entries(raw as Record<string, unknown>)) {
            if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
            const prev = starts.get(toolUseId);
            if (prev == null || ts < prev) starts.set(toolUseId, ts);
          }
        }
      } else if (msg.type === "tool_result_preview") {
        for (const preview of msg.previews || []) {
          if (typeof preview.tool_use_id === "string") {
            resolved.add(preview.tool_use_id);
          }
        }
      }
    }

    for (const toolUseId of resolved) {
      starts.delete(toolUseId);
    }
    return starts;
  }

  private recoverToolStartTimesFromHistory(session: Session): void {
    const unresolved = this.collectUnresolvedToolStartTimesFromHistory(session);
    if (unresolved.size === 0) return;
    for (const [toolUseId, startedAt] of unresolved) {
      if (!session.toolStartTimes.has(toolUseId)) {
        session.toolStartTimes.set(toolUseId, startedAt);
      }
    }
  }

  private finalizeRecoveredDisconnectedTerminalTools(session: Session, reason: string): void {
    if (session.backendType !== "codex") return;

    const now = Date.now();
    for (const [toolUseId, startedAt] of session.toolStartTimes) {
      if (this.shouldDeferCodexToolResultWatchdog(session, toolUseId)) continue;
      if (now - startedAt < CODEX_TOOL_RESULT_WATCHDOG_MS) continue;
      const toolName = this.findToolUseNameInHistory(session, toolUseId);
      if (toolName !== "Bash") continue;
      this.emitSyntheticToolResultPreview(
        session,
        toolUseId,
        "Terminal command was interrupted while backend was disconnected; final output was not recovered.",
        true,
        reason,
      );
    }
  }

  private finalizeOrphanedTerminalToolsOnResult(session: Session, msg: CLIResultMessage): void {
    if (session.backendType !== "codex") return;
    if (session.toolStartTimes.size === 0) return;

    const stopReason = typeof msg.stop_reason === "string" ? msg.stop_reason.toLowerCase() : "";
    const interrupted = stopReason.includes("interrupt") || stopReason.includes("cancel");
    const failed = !!msg.is_error || interrupted;

    for (const toolUseId of [...session.toolStartTimes.keys()]) {
      const toolName = this.findToolUseNameInHistory(session, toolUseId);
      if (toolName !== "Bash") continue;

      const content = interrupted
        ? "Terminal command was interrupted before the final tool result was delivered."
        : failed
          ? "Terminal command failed before the final tool result was delivered."
          : "Terminal command completed, but no output was captured.";
      this.emitSyntheticToolResultPreview(
        session,
        toolUseId,
        content,
        failed,
        "result_orphaned_terminal",
      );
    }
  }

  private scheduleCodexToolResultWatchdogs(session: Session, reason: string): void {
    if (session.backendType !== "codex") return;
    for (const toolUseId of session.toolStartTimes.keys()) {
      if (session.codexToolResultWatchdogs.has(toolUseId)) continue;
      const timer = setTimeout(() => {
        session.codexToolResultWatchdogs.delete(toolUseId);
        if (!session.toolStartTimes.has(toolUseId)) return;

        if (this.shouldDeferCodexToolResultWatchdog(session, toolUseId)) {
          this.scheduleCodexToolResultWatchdogs(session, "backend_connected");
          return;
        }

        this.emitSyntheticToolResultPreview(
          session,
          toolUseId,
          "Tool call was interrupted by backend disconnect; final result was not recovered.",
          true,
          reason,
        );
      }, CODEX_TOOL_RESULT_WATCHDOG_MS);
      session.codexToolResultWatchdogs.set(toolUseId, timer);
    }
  }

  private shouldDeferCodexToolResultWatchdog(session: Session, toolUseId: string): boolean {
    if (!session.codexAdapter?.isConnected()) return false;

    const pending = this.getCodexTurnInRecovery(session);
    if (!pending) return true;
    if (pending.resumeConfirmedAt == null) return true;
    if (pending.disconnectedAt == null) return true;

    const startedAt = session.toolStartTimes.get(toolUseId);
    if (typeof startedAt !== "number") return true;

    // Only time out tools that were already running before the disconnect and
    // remained unresolved after Codex confirmed the resumed turn.
    return startedAt > pending.disconnectedAt;
  }

  private synthesizeCodexToolResultsFromResumedTurn(
    session: Session,
    turn: CodexResumeTurnSnapshot,
    pending: CodexOutboundTurn,
  ): number {
    const turnStatus = typeof turn.status === "string" ? turn.status : null;
    if (!turnStatus || turnStatus === "inProgress") return 0;

    const disconnectedAt = pending.disconnectedAt ?? Date.now();
    const unresolvedToolIds = new Set<string>();
    for (const [toolUseId, startedAt] of session.toolStartTimes) {
      if (startedAt <= disconnectedAt) unresolvedToolIds.add(toolUseId);
    }
    if (unresolvedToolIds.size === 0) return 0;

    let synthesized = 0;
    const firstNonEmptyString = (obj: Record<string, unknown>, fields: string[]): string => {
      for (const field of fields) {
        const value = obj[field];
        if (typeof value === "string" && value.trim().length > 0) return value.trim();
      }
      return "";
    };

    for (const rawItem of turn.items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Record<string, unknown>;
      const itemId = typeof item.id === "string" ? item.id : "";
      if (!itemId || !unresolvedToolIds.has(itemId)) continue;

      const itemType = typeof item.type === "string" ? item.type : "";
      const itemStatus = typeof item.status === "string" ? item.status : turnStatus;
      let isError = itemStatus === "failed" || itemStatus === "declined";
      let content = "";

      if (itemType === "commandExecution") {
        const output = firstNonEmptyString(item, [
          "stdout",
          "aggregatedOutput",
          "aggregated_output",
          "formatted_output",
          "output",
        ]);
        const stderr = firstNonEmptyString(item, [
          "stderr",
          "errorOutput",
          "error_output",
        ]);
        const combinedOutput = [output, stderr].filter(Boolean).join("\n").trim();
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
        if (exitCode !== null && exitCode !== 0) isError = true;
        if (combinedOutput) {
          content = combinedOutput;
          if (exitCode !== null && exitCode !== 0) {
            content = `${content}\nExit code: ${exitCode}`;
          }
        } else if (exitCode !== null) {
          content = `Command ${isError ? "failed" : "completed"} before reconnect recovery finished.\nExit code: ${exitCode}`;
        } else {
          content = `Command ${isError ? "failed" : "completed"} before reconnect recovery finished.`;
        }
      } else {
        content = `Tool call ${isError ? "failed" : "completed"} before reconnect recovery finished.`;
      }

      this.emitSyntheticToolResultPreview(
        session,
        itemId,
        content,
        isError,
        "resume_snapshot",
      );
      unresolvedToolIds.delete(itemId);
      synthesized++;
    }

    // Fallback: if the resumed turn is terminal but omitted item details, do not
    // leave tool_use cards running forever in the UI.
    for (const toolUseId of unresolvedToolIds) {
      this.emitSyntheticToolResultPreview(
        session,
        toolUseId,
        `Tool call ${turnStatus} before reconnect recovery finished; final output was not recovered.`,
        turnStatus === "failed" || turnStatus === "declined",
        "resume_snapshot_fallback",
      );
      synthesized++;
    }

    return synthesized;
  }

  /**
   * Strip duplicated stderr output from Claude Code CLI error results.
   *
   * The CLI captures stdout and stderr separately and concatenates both into the
   * tool_result content. For failed commands this produces:
   *   "Exit code N\n<output>\n\n<output>"
   * where <output> (the combined stdout+stderr) appears twice, separated by a
   * blank line. We detect this pattern and keep only the first copy.
   */
  private static deduplicateCliErrorOutput(content: string): string {
    const nlIdx = content.indexOf("\n");
    if (nlIdx < 0 || !content.startsWith("Exit code ")) return content;

    const body = content.slice(nlIdx + 1);
    // Scan for a "\n\n" separator where the text before and after are identical
    let sepIdx = body.indexOf("\n\n");
    while (sepIdx >= 0) {
      if (body.slice(0, sepIdx) === body.slice(sepIdx + 2)) {
        return content.slice(0, nlIdx + 1) + body.slice(0, sepIdx);
      }
      sepIdx = body.indexOf("\n\n", sepIdx + 1);
    }
    return content;
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
      let resultContent = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content);

      // Claude Code CLI duplicates stderr in error results: the content arrives
      // as "Exit code N\n<body>\n\n<body>" where <body> is repeated verbatim.
      // Strip the duplicate second half so the UI shows the error only once.
      if (block.is_error && typeof block.content === "string") {
        resultContent = WsBridge.deduplicateCliErrorOutput(resultContent);
      }

      const totalSize = resultContent.length;
      const isTruncated = totalSize > TOOL_RESULT_PREVIEW_LIMIT;

      // Compute wall-clock duration from tool_use start time
      const startTime = session.toolStartTimes.get(block.tool_use_id);
      const durationSeconds = startTime != null
        ? Math.round((Date.now() - startTime) / 100) / 10
        : undefined;
      this.clearCodexToolResultWatchdog(session, block.tool_use_id);
      session.toolStartTimes.delete(block.tool_use_id);
      session.toolProgressOutput.delete(block.tool_use_id);

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

  private static isImageNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const withCode = err as { code?: unknown; message?: unknown };
    if (withCode.code === "ENOENT") return true;
    const msg = typeof withCode.message === "string" ? withCode.message.toLowerCase() : "";
    return msg.includes("enoent") || msg.includes("no such file") || msg.includes("not found");
  }

  private notifyImageSendFailure(session: Session, err?: unknown): void {
    const detail = WsBridge.isImageNotFoundError(err)
      ? "image couldn't be found on server"
      : "the server couldn't store the image";
    if (err) {
      console.warn(`[ws-bridge] Image send failed for session ${sessionTag(session.id)}:`, err);
    } else {
      console.warn(`[ws-bridge] Image send failed for session ${sessionTag(session.id)}: ${detail}`);
    }
    this.broadcastToBrowsers(session, {
      type: "error",
      message: `Image failed to send: ${detail}. Please reattach and retry.`,
    });
  }

  // ── Browser message routing ─────────────────────────────────────────────

  private async routeBrowserMessage(
    session: Session,
    msg: BrowserOutgoingMessage,
    ws?: ServerWebSocket<SocketData>,
  ) {
    if (msg.type === "session_subscribe") {
      this.handleSessionSubscribe(session, ws, msg.last_seq, msg.known_frozen_count, msg.known_frozen_hash);
      return;
    }

    if (msg.type === "session_ack") {
      this.handleSessionAck(session, ws, msg.last_seq);
      return;
    }

    if (msg.type === "history_sync_mismatch") {
      console.warn(
        `[history-sync] Browser reported hash mismatch for session ${sessionTag(session.id)} ` +
        `(frozenCount=${msg.frozen_count}) ` +
        `frozen expected=${msg.expected_frozen_hash} actual=${msg.actual_frozen_hash}; ` +
        `full expected=${msg.expected_full_hash} actual=${msg.actual_full_hash}`,
      );
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

    if (msg.type === "vscode_selection_update") {
      this.handleVsCodeSelectionUpdate(msg);
      return;
    }

    // Image turns require backend image-store persistence so we can provide
    // stable attachment paths and avoid silently dropped payloads.
    if (msg.type === "user_message" && msg.images?.length && !this.imageStore) {
      this.notifyImageSendFailure(session, new Error("image store unavailable"));
      return;
    }

    // For Codex/Claude SDK sessions, route CLI-bound messages through the adapter,
    // while ws-bridge still owns cross-cutting session state/history/permissions.
    if (session.backendType === "codex" || session.backendType === "claude-sdk") {
      // Clean up ws-bridge permission tracking for SDK sessions when browser resolves
      if (msg.type === "permission_response" && session.backendType === "claude-sdk") {
        const requestId = (msg as any).request_id;
        const behavior = (msg as any).behavior;
        const pending = session.pendingPermissions.get(requestId);
        if (pending) {
          session.pendingPermissions.delete(requestId);

          // Forward the response to the SDK adapter so it can resolve the
          // canUseTool Promise that the CLI is blocking on. Without this,
          // the CLI hangs forever waiting for a response that never arrives.
          if (session.claudeSdkAdapter) {
            session.claudeSdkAdapter.sendBrowserMessage({
              type: "permission_response",
              request_id: requestId,
              behavior,
              updated_input: behavior === "allow" ? ((msg as any).updated_input || pending.input) : undefined,
              message: behavior !== "allow" ? ((msg as any).message || "Denied by user") : undefined,
            } as any);
          }

          this.onSessionActivityStateChanged(session.id, "sdk_permission_response");
          this.pushoverNotifier?.cancelPermission(session.id, requestId);
          this.clearActionAttentionIfNoPermissions(session);

          // Emit takode event for herd monitoring
          this.emitTakodeEvent(session.id, "permission_resolved", {
            tool_name: pending.tool_name,
            outcome: behavior === "allow" ? "approved" : "denied",
          });

          // Record in message history
          if (behavior === "allow") {
            const approvedMsg: BrowserIncomingMessage = {
              type: "permission_approved",
              id: `approval-${requestId}`,
              request_id: requestId,
              tool_name: pending.tool_name,
              tool_use_id: pending.tool_use_id,
              summary: `Approved: ${pending.tool_name}${pending.description ? ` — ${pending.description}` : ""}`,
              timestamp: Date.now(),
            };
            session.messageHistory.push(approvedMsg);
            this.broadcastToBrowsers(session, approvedMsg);
          } else {
            const deniedMsg: BrowserIncomingMessage = {
              type: "permission_denied",
              id: `denial-${requestId}`,
              request_id: requestId,
              tool_name: pending.tool_name,
              tool_use_id: pending.tool_use_id,
              summary: `Denied: ${pending.tool_name}${pending.description ? ` — ${pending.description}` : ""}`,
              timestamp: Date.now(),
            };
            session.messageHistory.push(deniedMsg);
            this.broadcastToBrowsers(session, deniedMsg);
          }

          // ExitPlanMode post-approval: transition out of plan mode
          // (mirrors handlePermissionResponse logic for regular Claude sessions)
          if (behavior === "allow" && pending.tool_name === "ExitPlanMode") {
            const askPerm = session.state.askPermission !== false;
            const postPlanMode = askPerm ? "acceptEdits" : "bypassPermissions";
            this.handleSetPermissionMode(session, postPlanMode);
            this.setGenerating(session, true, "exit_plan_mode");
            this.broadcastToBrowsers(session, { type: "status_change", status: "running" });
            console.log(`[ws-bridge] ExitPlanMode approved for SDK session ${sessionTag(session.id)}, switching to ${postPlanMode} (askPermission=${askPerm})`);
          }

          // ExitPlanMode denial: interrupt the SDK session
          if (behavior === "deny" && pending.tool_name === "ExitPlanMode") {
            if (session.claudeSdkAdapter) {
              session.claudeSdkAdapter.sendBrowserMessage({ type: "interrupt" } as any);
            } else {
              this.handleInterrupt(session);
            }
            console.log(`[ws-bridge] ExitPlanMode denied for SDK session ${sessionTag(session.id)}, sending interrupt`);
          }

          this.persistSession(session);
        }
      }

      let userImageRefs: import("./image-store.js").ImageRef[] | undefined;
      let codexUserMessageId: string | null = null;
      let ingested: {
        timestamp: number;
        historyEntry: Extract<BrowserIncomingMessage, { type: "user_message" }>;
        historyIndex: number;
        imageRefs?: import("./image-store.js").ImageRef[];
        wasGenerating: boolean;
      } | undefined;

      if (msg.type === "user_message") {
        try {
          const maybeIngested = this.ingestUserMessage(session, msg, "adapter", {
            commit: session.backendType !== "codex",
          });
          ingested = maybeIngested instanceof Promise ? await maybeIngested : maybeIngested;
        } catch (err) {
          if (msg.images?.length) {
            this.notifyImageSendFailure(session, err);
            return;
          }
          throw err;
        }
        userImageRefs = ingested.imageRefs;
        codexUserMessageId = ingested.historyEntry.id || null;
        // Trigger auto-naming evaluation (async, fire-and-forget) only after
        // the message is committed to authoritative history.
        if (this.onUserMessage && session.backendType !== "codex") {
          this.onUserMessage(session.id, [...session.messageHistory], session.state.cwd, ingested.wasGenerating);
        }
      }
      if (msg.type === "permission_response") {
        const pending = session.pendingPermissions.get(msg.request_id);
        session.pendingPermissions.delete(msg.request_id);
        this.onSessionActivityStateChanged(session.id, "codex_permission_response");
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

      if (session.backendType === "codex" && msg.type === "cancel_pending_codex_input") {
        const pendingInput = session.pendingCodexInputs.find((input) => input.id === msg.id);
        if (!pendingInput?.cancelable) return;
        const activeTurnId = session.codexAdapter?.getCurrentTurnId() ?? null;
        session.pendingCodexTurns = session.pendingCodexTurns.filter((turn) =>
          !!activeTurnId && turn.turnId === activeTurnId);
        replaceQueuedTurnLifecycleEntriesLifecycle(session, []);
        const removed = this.removePendingCodexInput(session, msg.id);
        if ((!session.isGenerating || !activeTurnId) && this.getCancelablePendingCodexInputs(session).length > 0) {
          this.queueCodexPendingStartBatch(session, "cancel_pending_codex_input");
        }
        if (removed && ws) {
          this.sendToBrowser(ws, { type: "codex_pending_input_cancelled", input: removed });
        }
        this.persistSession(session);
        return;
      }

      if (msg.type === "set_model") {
        if (session.backendType === "claude-sdk") {
          // SDK sessions: forward model change to CLI subprocess via the adapter.
          this.handleSetModel(session, msg.model);
        } else {
          this.handleCodexSetModel(session, msg.model);
        }
        return;
      }
      if (msg.type === "set_permission_mode") {
        if (session.backendType === "claude-sdk") {
          // SDK sessions: use the same handler as ExitPlanMode, which forwards
          // the mode change to the CLI subprocess via the adapter (query.setPermissionMode).
          // Codex sessions need a full relaunch since mode is set at process spawn.
          this.handleSetPermissionMode(session, msg.mode);
        } else {
          this.handleCodexSetPermissionMode(session, msg.mode);
        }
        return;
      }
      if (msg.type === "set_codex_reasoning_effort") {
        this.handleCodexSetReasoningEffort(session, msg.effort);
        return;
      }
      if (msg.type === "set_ask_permission") {
        this.handleSetAskPermission(session, msg.askPermission);
        return;
      }

      // Prefer local image paths for Codex user turns so thread history stores
      // compact local references instead of large data: URLs.
      let adapterMsg: BrowserOutgoingMessage = msg;
      if (msg.type === "user_message" && msg.images?.length) {
        // Append image file path annotation so the agent can see/reference images.
        // Mirrors the annotation logic in handleUserMessage for CLI sessions.
        let annotatedContent = msg.content || "";
        if (userImageRefs?.length) {
          const paths = deriveAttachmentPaths(session.id, userImageRefs);
          annotatedContent += formatAttachmentPathAnnotation(paths);
        }
        // Start with the annotated content
        adapterMsg = { ...msg, content: annotatedContent } as BrowserOutgoingMessage;

        // local_images (file paths on disk) only works for Codex which has a
        // native localImage content type. The Claude SDK doesn't support file
        // paths and still needs base64 image data.
        if (session.backendType === "codex") {
          if (this.imageStore && userImageRefs?.length === msg.images.length) {
            const paths: string[] = [];
            const imageStoreForCodex = this.imageStore as ImageStore & {
              getTransportPath?: (sessionId: string, imageId: string) => Promise<string | null>;
              getOriginalPath?: (sessionId: string, imageId: string) => Promise<string | null>;
            };
            for (const ref of userImageRefs) {
              const transportPath = imageStoreForCodex.getTransportPath
                ? await imageStoreForCodex.getTransportPath(session.id, ref.imageId)
                : null;
              if (transportPath) {
                paths.push(transportPath);
                continue;
              }
              const originalPath = imageStoreForCodex.getOriginalPath
                ? await imageStoreForCodex.getOriginalPath(session.id, ref.imageId)
                : null;
              if (originalPath) {
                paths.push(originalPath);
                continue;
              }
              this.notifyImageSendFailure(session, new Error(`image ${ref.imageId} not found after upload`));
              return;
            }
            const localMsg = { ...adapterMsg, local_images: paths } as BrowserOutgoingMessage;
            delete (localMsg as { images?: unknown }).images;
            adapterMsg = localMsg;
          } else {
            this.notifyImageSendFailure(session, new Error("uploaded images missing from image store"));
            return;
          }
        } else if (this.imageStore && session.backendType === "claude-sdk") {
          // SDK sessions can handle larger payloads (~1MB) than Codex (~500KB)
          const maxChars = session.backendType === "claude-sdk" ? 1_000_000 : undefined;
          const compressedImages: { media_type: string; data: string }[] = [];
          for (const img of msg.images) {
            const { base64, mediaType } = await this.imageStore.compressForTransport(img.data, img.media_type, maxChars);
            compressedImages.push({ media_type: mediaType, data: base64 });
          }
          adapterMsg = { ...adapterMsg, images: compressedImages } as BrowserOutgoingMessage;
        }
      }

      let pendingTurnTarget: UserDispatchTurnTarget | null = null;
      if (msg.type === "user_message" && ingested && session.state.backend_state !== "broken") {
        // Mark session running for ALL user_message dispatches, not just
        // when the session was already generating. Without this, idle SDK
        // sessions stay visually idle until the CLI emits a status_change
        // event — creating a flicker gap. The interruptSource is only set
        // when wasGenerating was true (an actual interruption occurred).
        // Skip for broken sessions — they can't process messages until
        // the adapter relaunches.
        const interruptSource = ingested.wasGenerating
          ? (msg.agentSource
              ? (this.isSystemSourceTag(msg.agentSource) ? "system" : "leader")
              : "user")
          : undefined;
        pendingTurnTarget = this.markRunningFromUserDispatch(session, "user_message", interruptSource ?? null);
        if (ingested.historyIndex >= 0) {
          this.trackUserMessageForTurn(session, ingested.historyIndex, pendingTurnTarget);
        }
      }

      if (session.backendType === "codex" && msg.type === "user_message") {
        if (ingested?.historyEntry.id) {
          this.addPendingCodexInput(session, {
            id: ingested.historyEntry.id,
            content: ingested.historyEntry.content,
            timestamp: ingested.timestamp,
            cancelable: true,
            ...(userImageRefs?.length ? { imageRefs: userImageRefs } : {}),
            ...(msg.images?.length ? { draftImages: buildPendingCodexImageDrafts(msg.images) } : {}),
            ...(adapterMsg.type === "user_message" ? { deliveryContent: adapterMsg.content } : {}),
            ...(adapterMsg.type === "user_message" && adapterMsg.local_images?.length ? { localImagePaths: adapterMsg.local_images } : {}),
            ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
            ...(msg.vscodeSelection ? { vscodeSelection: msg.vscodeSelection } : {}),
          });
          this.emitTakodeEvent(session.id, "user_message", {
            content: (ingested.historyEntry.content || "").slice(0, 120),
            ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
          });
        }
        const currentTurnId = session.codexAdapter?.getCurrentTurnId() ?? null;
        if (currentTurnId) {
          this.trySteerPendingCodexInputs(session, "browser_user_message");
        } else {
          if (session.codexAdapter && ingested?.wasGenerating) {
            this.persistSession(session);
          } else {
            this.queueCodexPendingStartBatch(session, "browser_user_message");
          }
        }

        if (session.state.backend_state === "broken") {
          this.broadcastToBrowsers(session, {
            type: "error",
            message: "Codex session is broken. Your message was queued and will run after relaunch.",
          });
        }

        if (!session.codexAdapter) {
          console.log(`[ws-bridge] Codex adapter not yet attached for session ${sessionTag(session.id)}, queued user_message`);
          if (this.onCLIRelaunchNeeded) {
            const launcherInfo = this.launcher?.getSession(session.id);
            if (
              session.state.backend_state !== "broken"
              && launcherInfo
              && launcherInfo.state === "exited"
              && !launcherInfo.killedByIdleManager
            ) {
              session.consecutiveAdapterFailures = 0;
              console.log(`[ws-bridge] User message queued for exited ${session.backendType} session ${sessionTag(session.id)}, requesting relaunch`);
              this.onCLIRelaunchNeeded(session.id);
            }
          }
        }
        return;
      }

      const adapter = session.codexAdapter || session.claudeSdkAdapter;
      const raw = JSON.stringify(adapterMsg);
      const queueAdapterMessage = () => {
        const alreadyQueued = session.pendingMessages.some((queued) => queued === raw);
        if (!alreadyQueued) {
          session.pendingMessages.push(raw);
        }
      };

      if (adapter) {
        const accepted = adapter.sendBrowserMessage(adapterMsg);
        if (!accepted) {
          queueAdapterMessage();
        }
        this.persistSession(session);
      } else {
        console.log(`[ws-bridge] Adapter not yet attached for session ${sessionTag(session.id)}, queuing ${msg.type}`);
        queueAdapterMessage();

        if (msg.type === "user_message" && this.onCLIRelaunchNeeded) {
          const launcherInfo = this.launcher?.getSession(session.id);
          if (session.state.backend_state !== "broken" && launcherInfo && launcherInfo.state === "exited" && !launcherInfo.killedByIdleManager) {
            session.consecutiveAdapterFailures = 0;
            console.log(`[ws-bridge] User message queued for exited ${session.backendType} session ${sessionTag(session.id)}, requesting relaunch`);
            this.onCLIRelaunchNeeded(session.id);
          }
        }
        this.persistSession(session);
      }
      return;
    }

    // Claude Code path (existing logic)
    switch (msg.type) {
      case "user_message":
        try {
          await this.handleUserMessage(session, msg);
        } catch (err) {
          if (msg.images?.length) {
            this.notifyImageSendFailure(session, err);
            break;
          }
          throw err;
        }
        break;

      case "permission_response":
        this.handlePermissionResponse(session, msg);
        break;

      case "interrupt":
        this.handleInterrupt(session, msg.interruptSource ?? "user");
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

  private normalizeKnownFrozenCount(knownFrozenCount: number | undefined): number {
    if (!Number.isFinite(knownFrozenCount)) return 0;
    return Math.max(0, Math.floor(knownFrozenCount ?? 0));
  }

  private clampFrozenCount(session: Session): void {
    session.frozenCount = Math.max(0, Math.min(session.frozenCount, session.messageHistory.length));
  }

  private freezeHistoryThroughCurrentTail(session: Session): void {
    session.frozenCount = session.messageHistory.length;
  }

  private sendHistorySync(
    session: Session,
    ws: ServerWebSocket<SocketData>,
    knownFrozenCount: number,
    knownFrozenHash?: string,
  ): boolean {
    const normalizedKnownFrozenCount = this.normalizeKnownFrozenCount(knownFrozenCount);
    this.clampFrozenCount(session);
    const frozenCount = session.frozenCount;
    const frozenHistory = session.messageHistory.slice(0, frozenCount);
    const frozenPrefix = computeHistoryMessagesSyncHash(frozenHistory);
    if (normalizedKnownFrozenCount > frozenPrefix.renderedCount) {
      console.warn(
        `[history-sync] Invalid known_frozen_count=${normalizedKnownFrozenCount} ` +
        `for session ${sessionTag(session.id)} authoritativeFrozen=${frozenPrefix.renderedCount}; refusing sync`,
      );
      return false;
    }
    if (session.messageHistory.length === 0) {
      return true;
    }
    if (normalizedKnownFrozenCount > 0 && typeof knownFrozenHash === "string") {
      const expectedPrefix = computeHistoryPrefixSyncHash(frozenHistory, normalizedKnownFrozenCount);
      if (expectedPrefix.hash !== knownFrozenHash) {
        console.warn(
          `[history-sync] Frozen prefix hash mismatch for session ${sessionTag(session.id)} ` +
          `(count=${normalizedKnownFrozenCount}) expected=${expectedPrefix.hash} actual=${knownFrozenHash}; ` +
          `refusing sync`,
        );
        return false;
      }
    }
    const fullHistory = computeHistoryMessagesSyncHash(session.messageHistory);
    const frozenDelta = session.messageHistory.slice(normalizedKnownFrozenCount, frozenCount);
    const hotMessages = session.messageHistory.slice(frozenCount);
    trafficStats.recordHistorySyncBreakdown({
      sessionId: session.id,
      frozenDeltaBytes: Buffer.byteLength(JSON.stringify(frozenDelta), "utf-8"),
      hotMessagesBytes: Buffer.byteLength(JSON.stringify(hotMessages), "utf-8"),
      frozenDeltaMessages: frozenDelta.length,
      hotMessagesCount: hotMessages.length,
    });
    this.sendToBrowser(ws, {
      type: "history_sync",
      frozen_base_count: normalizedKnownFrozenCount,
      frozen_delta: frozenDelta,
      hot_messages: hotMessages,
      frozen_count: frozenCount,
      expected_frozen_hash: frozenPrefix.hash,
      expected_full_hash: fullHistory.hash,
    });
    return true;
  }

  private handleSessionSubscribe(
    session: Session,
    ws: ServerWebSocket<SocketData> | undefined,
    lastSeq: number,
    knownFrozenCount = 0,
    knownFrozenHash?: string,
  ) {
    if (!ws) return;
    const data = ws.data as BrowserSocketData;
    data.subscribed = true;
    const lastAckSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
    data.lastAckSeq = lastAckSeq;
    this.recoverToolStartTimesFromHistory(session);
    this.finalizeRecoveredDisconnectedTerminalTools(session, "session_subscribe");
    this.scheduleCodexToolResultWatchdogs(session, "session_subscribe");

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
        this.sendHistorySync(session, ws, knownFrozenCount, knownFrozenHash);
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
        // authoritative history state so the browser can rebuild its feed.
        // Prefer frozen-delta + hot-tail sync. If the client cannot safely
        // reuse its frozen prefix, refuse sync instead of resending the full
        // conversation payload.
        if (session.messageHistory.length > 0) {
          this.sendHistorySync(session, ws, knownFrozenCount, knownFrozenHash);
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

  private ingestUserMessage(
    session: Session,
    msg: {
      type: "user_message";
      content: string;
      images?: { media_type: string; data: string }[];
      agentSource?: { sessionId: string; sessionLabel?: string };
      vscodeSelection?: import("./session-types.js").VsCodeSelectionMetadata;
    },
    source: "adapter" | "cli",
    options?: { commit?: boolean },
  ): {
    timestamp: number;
    historyEntry: Extract<BrowserIncomingMessage, { type: "user_message" }>;
    historyIndex: number;
    imageRefs?: import("./image-store.js").ImageRef[];
    wasGenerating: boolean;
  } | Promise<{
    timestamp: number;
    historyEntry: Extract<BrowserIncomingMessage, { type: "user_message" }>;
    historyIndex: number;
    imageRefs?: import("./image-store.js").ImageRef[];
    wasGenerating: boolean;
  }> {
    const ts = Date.now();
    const commit = options?.commit !== false;

    const finalize = (imageRefs?: import("./image-store.js").ImageRef[]) => {
      const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
        type: "user_message",
        content: msg.content,
        timestamp: ts,
        id: `user-${ts}-${this.userMsgCounter++}`,
        ...(imageRefs?.length ? { images: imageRefs } : {}),
        ...(msg.vscodeSelection ? { vscodeSelection: msg.vscodeSelection } : {}),
        ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
      };
      let userMsgHistoryIdx = -1;
      if (commit) {
        session.messageHistory.push(userHistoryEntry);
        userMsgHistoryIdx = session.messageHistory.length - 1;
        session.lastUserMessage = (msg.content || "").slice(0, 80);

        // Server-authoritative user message fan-out: browsers render only what ws-bridge broadcasts.
        this.broadcastToBrowsers(session, userHistoryEntry);
        this.emitTakodeEvent(session.id, "user_message", {
          content: (msg.content || "").slice(0, 120),
          ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
        });
      }

      const wasGenerating = session.isGenerating;
      return {
        timestamp: ts,
        historyEntry: userHistoryEntry,
        historyIndex: userMsgHistoryIdx,
        imageRefs,
        wasGenerating,
      };
    };

    if (msg.images?.length && this.imageStore) {
      return (async () => {
        const imageRefs: import("./image-store.js").ImageRef[] = [];
        for (const img of msg.images || []) {
          const ref = await this.imageStore!.store(session.id, img.data, img.media_type);
          imageRefs.push(ref);
        }
        return finalize(imageRefs);
      })();
    }

    return finalize();
  }

  private async handleUserMessage(
    session: Session,
    msg: { type: "user_message"; content: string; session_id?: string; images?: { media_type: string; data: string }[]; agentSource?: { sessionId: string; sessionLabel?: string }; vscodeSelection?: import("./session-types.js").VsCodeSelectionMetadata }
  ) {
    const maybeIngested = this.ingestUserMessage(session, msg, "cli");
    const ingested = maybeIngested instanceof Promise ? await maybeIngested : maybeIngested;
    const ts = ingested.timestamp;
    const imageRefs = ingested.imageRefs;
    const userMsgHistoryIdx = ingested.historyIndex;

    // Build content: if images are present, convert unsupported formats and use
    // content block array; otherwise plain string. Conversion operates on copies
    // so that the original base64 data stored to disk is not affected.
    const selectionText = msg.vscodeSelection
      ? this.formatVsCodeSelectionPrompt(msg.vscodeSelection)
      : null;
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
      // Append image file paths to the text block so the leader can see them
      // in real-time and forward to herded workers via takode send.
      let textContent = msg.content;
      if (imageRefs?.length) {
        const paths = deriveAttachmentPaths(session.id, imageRefs);
        textContent += formatAttachmentPathAnnotation(paths);
      }
      blocks.push({ type: "text", text: textContent });
      if (selectionText) {
        blocks.push({ type: "text", text: selectionText });
      }
      content = blocks;
    } else {
      content = selectionText
        ? [
          { type: "text", text: msg.content },
          { type: "text", text: selectionText },
        ]
        : msg.content;
    }

    // Role-prefix for orchestrator sessions: the CLI sees [User], [Herd], [System], or [Agent] tags
    // so the orchestrator can distinguish message sources. History/browser keep original content.
    const isOrch = this.launcher?.getSession(session.id)?.isOrchestrator;
    if (isOrch && typeof content === "string") {
      const time = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      if (this.isSystemSourceTag(msg.agentSource)) {
        content = `[System ${time}] ${content}`;
      } else if (msg.agentSource?.sessionId === "herd-events") {
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
    const turnTarget = this.sendToCLI(session, ndjson);
    this.trackUserMessageForTurn(session, userMsgHistoryIdx, turnTarget ?? "current");
    // Track the outbound user message so we can re-queue it if the CLI
    // disconnects mid-turn (before sending a result). On --resume reconnect,
    // the CLI's internal checkpoint won't include the in-flight message.
    session.lastOutboundUserNdjson = ndjson;

    // Trigger auto-naming evaluation (async, fire-and-forget)
    if (this.onUserMessage) {
      this.onUserMessage(session.id, [...session.messageHistory], session.state.cwd, ingested.wasGenerating);
    }
  }

  private handlePermissionResponse(
    session: Session,
    msg: { type: "permission_response"; request_id: string; behavior: "allow" | "deny"; updated_input?: Record<string, unknown>; updated_permissions?: unknown[]; message?: string }
  ) {
    // Remove from pending
    const pending = session.pendingPermissions.get(msg.request_id);
    session.pendingPermissions.delete(msg.request_id);
    this.onSessionActivityStateChanged(session.id, "permission_response");

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
        this.handleInterrupt(session, "system");
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

  private handleInterrupt(session: Session, source: InterruptSource = "user") {
    if (session.backendType === "codex" && source === "user") {
      if (session.pendingCodexTurns.length > 1) {
        const activeTurnId = session.codexAdapter?.getCurrentTurnId() ?? null;
        const preservedTurn = activeTurnId
          ? (session.pendingCodexTurns.find((turn) => turn.turnId === activeTurnId) ?? null)
          : null;
        session.pendingCodexTurns = preservedTurn ? [preservedTurn] : [];
      }
      replaceQueuedTurnLifecycleEntriesLifecycle(session, []);
      this.persistSession(session);
    }
    this.markTurnInterrupted(session, source);
    const ndjson = JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    });
    this.sendToCLI(session, ndjson);
  }

  private markTurnInterrupted(session: Session, source: InterruptSource): void {
    markTurnInterruptedLifecycle(session, source);
  }

  private handleSetModel(session: Session, model: string) {
    if (session.backendType === "claude-sdk" && session.claudeSdkAdapter) {
      // SDK sessions: forward model change to CLI subprocess via the adapter
      // (query.setModel). Unlike permission mode (which is server-side only),
      // the model must reach the CLI so it uses the correct model for API calls.
      session.claudeSdkAdapter.sendBrowserMessage({ type: "set_model", model } as any);
    } else {
      const ndjson = JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "set_model", model },
      });
      this.sendToCLI(session, ndjson);
    }
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
    this.requestCodexIntentionalRelaunch(session, "set_model");
  }

  private handleSetPermissionMode(session: Session, mode: string) {
    // Route to the appropriate backend
    if (session.backendType === "claude-sdk" && session.claudeSdkAdapter) {
      // SDK sessions: mode change is server-side only. The adapter logs it
      // but does NOT forward to the CLI — the CLI's internal mode is irrelevant
      // because --permission-prompt-tool stdio routes all permission decisions
      // through canUseTool → handleSdkPermissionRequest, which checks the
      // server-side mode for auto-approval.
      session.claudeSdkAdapter.sendBrowserMessage({ type: "set_permission_mode", mode } as any);
    } else {
      const ndjson = JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "set_permission_mode", mode },
      });
      this.sendToCLI(session, ndjson);
    }
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

    const previousAsk = session.state.askPermission !== false;
    const codexUiMode = mode === "plan" ? "plan" : "agent";
    const codexAskPermission = mode === "plan"
      ? previousAsk
      : mode !== "bypassPermissions";
    session.state.permissionMode = mode;
    session.state.uiMode = codexUiMode;
    session.state.askPermission = codexAskPermission;
    const launchInfo = this.launcher?.getSession(session.id);
    if (launchInfo) {
      launchInfo.permissionMode = mode;
      launchInfo.askPermission = codexAskPermission;
    }
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { permissionMode: mode, uiMode: codexUiMode, askPermission: codexAskPermission },
    });
    this.persistSession(session);

    // Delay relaunch to let the adapter's async outgoing dispatch chain process
    // the permission responses above. The relaunch kills the old process
    // synchronously (SIGTERM), so without this delay the responses would be
    // enqueued but never flushed to the Codex process stdin.
    this.requestCodexIntentionalRelaunch(session, "set_permission_mode", 100);
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
    this.requestCodexIntentionalRelaunch(session, "set_codex_reasoning_effort");
  }

  private handleSetAskPermission(session: Session, askPermission: boolean) {
    if (session.backendType === "codex") {
      const uiMode = session.state.uiMode === "plan" ? "plan" : "agent";
      const newMode = uiMode === "plan" ? "plan" : (askPermission ? "suggest" : "bypassPermissions");
      if (session.state.askPermission === askPermission && session.state.permissionMode === newMode) return;
      session.state.askPermission = askPermission;
      session.state.permissionMode = newMode;
      session.state.uiMode = uiMode;
      const launchInfo = this.launcher?.getSession(session.id);
      if (launchInfo) {
        launchInfo.permissionMode = newMode;
        launchInfo.askPermission = askPermission;
      }
      this.broadcastToBrowsers(session, {
        type: "session_update",
        session: { askPermission, permissionMode: newMode, uiMode },
      });
      this.persistSession(session);
      this.requestCodexIntentionalRelaunch(session, "set_ask_permission");
      return;
    }

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
    if (session.backendType === "claude-sdk" && session.claudeSdkAdapter) {
      // SDK sessions: forward the resolved mode to the CLI subprocess inline
      // instead of restarting the process. The adapter calls query.setPermissionMode().
      session.claudeSdkAdapter.sendBrowserMessage({ type: "set_permission_mode", mode: newMode } as any);
      const launchInfo = this.launcher?.getSession(session.id);
      if (launchInfo) launchInfo.permissionMode = newMode;
    } else {
      // WebSocket Claude sessions: trigger CLI restart with the new permission mode
      this.onPermissionModeChanged?.(session.id, newMode);
    }
  }

  /** Mark an upcoming Codex adapter disconnect as intentional (e.g., relaunch).
   *  This prevents the onDisconnect handler from incrementing failure counters
   *  and requesting a redundant auto-relaunch that races with the in-progress one. */
  markCodexRelaunchIntentional(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.intentionalCodexRelaunchUntil = Date.now() + CODEX_INTENTIONAL_RELAUNCH_GUARD_MS;
    session.intentionalCodexRelaunchReason = reason;
  }

  private requestCodexIntentionalRelaunch(session: Session, reason: string, delayMs = 0): void {
    const guardMs = Math.max(CODEX_INTENTIONAL_RELAUNCH_GUARD_MS, delayMs + 5_000);
    session.intentionalCodexRelaunchUntil = Date.now() + guardMs;
    session.intentionalCodexRelaunchReason = reason;
    if (delayMs > 0) {
      setTimeout(() => this.onSessionRelaunchRequested?.(session.id), delayMs);
      return;
    }
    this.onSessionRelaunchRequested?.(session.id);
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

  private sendToCLI(session: Session, ndjson: string): UserDispatchTurnTarget | null {
    let turnTarget: UserDispatchTurnTarget | null = null;
    if (this.isCliUserMessagePayload(ndjson)) {
      turnTarget = this.markRunningFromUserDispatch(session, "user_message_dispatch");
    }
    if (!session.backendSocket) {
      // Queue the message — CLI might still be starting up.
      // Don't record here; the message will be recorded when flushed.
      console.log(`[ws-bridge] CLI not yet connected for session ${sessionTag(session.id)}, queuing message`);
      session.pendingMessages.push(ndjson);
      return turnTarget;
    }
    // Record raw outgoing CLI message (only when actually sending, not when queuing)
    this.recorder?.record(session.id, "out", ndjson, "cli", session.backendType, session.state.cwd);
    try {
      // NDJSON requires a newline delimiter
      session.backendSocket.send(ndjson + "\n");
      trafficStats.record({
        sessionId: session.id,
        channel: "cli",
        direction: "out",
        messageType: getTrafficMessageType(JSON.parse(ndjson) as Record<string, unknown>),
        payloadBytes: Buffer.byteLength(ndjson + "\n", "utf-8"),
      });
    } catch (err) {
      // Send failure means the socket is dead — re-queue the message so it
      // can be delivered after reconnect, then close the socket to trigger
      // the auto-relaunch mechanism.
      console.warn(`[ws-bridge] CLI send failed for session ${sessionTag(session.id)}, re-queuing message and closing dead socket:`, err);
      session.pendingMessages.push(ndjson);
      try { session.backendSocket.close(); } catch { /* already dead */ }
    }
    return turnTarget;
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
      const parsed = detectQuestEvent({ kind: "command", text: command });
      if (!parsed?.questId) continue;
      session.pendingQuestCommands.set(block.id, {
        questId: parsed.questId,
        targetStatus: parsed.targetStatus,
      });
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
    const parsedResult = detectQuestEvent({ kind: "result", text: raw });
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

  private broadcastPendingCodexInputs(session: Session): void {
    this.broadcastToBrowsers(session, {
      type: "codex_pending_inputs",
      inputs: session.pendingCodexInputs,
    });
  }

  private addPendingCodexInput(session: Session, input: PendingCodexInput): void {
    session.pendingCodexInputs.push(input);
    session.lastUserMessage = (input.content || "").slice(0, 80);
    this.broadcastPendingCodexInputs(session);
  }

  private setPendingCodexInputCancelable(session: Session, id: string, cancelable: boolean): void {
    const pending = session.pendingCodexInputs.find((item) => item.id === id);
    if (!pending || pending.cancelable === cancelable) return;
    pending.cancelable = cancelable;
    this.broadcastPendingCodexInputs(session);
    this.persistSession(session);
  }

  private setPendingCodexInputsCancelable(session: Session, ids: string[], cancelable: boolean): void {
    let changed = false;
    const idSet = new Set(ids);
    for (const pending of session.pendingCodexInputs) {
      if (!idSet.has(pending.id) || pending.cancelable === cancelable) continue;
      pending.cancelable = cancelable;
      changed = true;
    }
    if (!changed) return;
    this.broadcastPendingCodexInputs(session);
    this.persistSession(session);
  }

  private getCancelablePendingCodexInputs(session: Session): PendingCodexInput[] {
    return session.pendingCodexInputs.filter((item) => item.cancelable);
  }

  private commitPendingCodexInputs(session: Session, ids: string[]): number[] {
    const indexes: number[] = [];
    for (const id of ids) {
      const idx = this.commitPendingCodexInput(session, id);
      if (typeof idx === "number" && idx >= 0) indexes.push(idx);
    }
    return indexes;
  }

  private getPendingCodexInputsByIds(session: Session, ids: string[]): PendingCodexInput[] {
    const idSet = new Set(ids);
    return session.pendingCodexInputs.filter((input) => idSet.has(input.id));
  }

  private recordSteeredCodexTurn(
    session: Session,
    turnId: string,
    inputs: PendingCodexInput[],
    committedHistoryIndexes: number[],
  ): void {
    if (inputs.length === 0) return;
    const now = Date.now();
    const pendingInputIds = inputs.map((input) => input.id);
    this.enqueueCodexTurn(session, {
      adapterMsg: {
        type: "codex_start_pending",
        pendingInputIds,
        inputs: this.buildCodexBatchMessageInputs(inputs),
      },
      userMessageId: pendingInputIds[0]!,
      pendingInputIds,
      userContent: this.buildCodexPendingBatchRecoveryText(inputs),
      historyIndex: committedHistoryIndexes[0] ?? -1,
      status: "backend_acknowledged",
      dispatchCount: 1,
      createdAt: now,
      updatedAt: now,
      acknowledgedAt: now,
      turnTarget: "queued",
      lastError: null,
      turnId,
      disconnectedAt: null,
      resumeConfirmedAt: null,
    });
    for (const idx of committedHistoryIndexes) {
      this.trackUserMessageForTurn(session, idx, "queued");
    }
  }

  private buildCodexBatchMessageInputs(inputs: PendingCodexInput[]): import("./session-types.js").CodexPendingBatchInput[] {
    return inputs.map((input) => ({
      content: input.deliveryContent || input.content,
      ...(input.localImagePaths?.length ? { local_images: input.localImagePaths } : {}),
      ...(input.vscodeSelection ? { vscodeSelection: input.vscodeSelection } : {}),
    }));
  }

  private buildCodexPendingBatchRecoveryText(inputs: PendingCodexInput[]): string {
    return inputs
      .map((input) => {
        const parts = [input.deliveryContent || input.content];
        if (input.vscodeSelection) {
          parts.push(this.formatVsCodeSelectionPrompt(input.vscodeSelection));
        }
        return parts.filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
  }

  private queueCodexPendingStartBatch(session: Session, reason: string): void {
    const deliverable = this.getCancelablePendingCodexInputs(session);
    if (deliverable.length === 0) return;

    const existingHead = this.getCodexHeadTurn(session);
    if (existingHead && existingHead.status === "queued" && existingHead.turnId == null) {
      existingHead.adapterMsg = {
        type: "codex_start_pending",
        pendingInputIds: deliverable.map((input) => input.id),
        inputs: this.buildCodexBatchMessageInputs(deliverable),
      };
      existingHead.userMessageId = deliverable[0].id;
      existingHead.pendingInputIds = deliverable.map((input) => input.id);
      existingHead.userContent = this.buildCodexPendingBatchRecoveryText(deliverable);
      existingHead.updatedAt = Date.now();
      existingHead.lastError = null;
      this.persistSession(session);
      this.dispatchQueuedCodexTurns(session, reason);
      return;
    }

    if (existingHead) return;

    const now = Date.now();
    this.enqueueCodexTurn(session, {
      adapterMsg: {
        type: "codex_start_pending",
        pendingInputIds: deliverable.map((input) => input.id),
        inputs: this.buildCodexBatchMessageInputs(deliverable),
      },
      userMessageId: deliverable[0].id,
      pendingInputIds: deliverable.map((input) => input.id),
      userContent: this.buildCodexPendingBatchRecoveryText(deliverable),
      historyIndex: -1,
      status: session.state.backend_state === "broken" ? "blocked_broken_session" : "queued",
      dispatchCount: 0,
      createdAt: now,
      updatedAt: now,
      acknowledgedAt: null,
      turnTarget: null,
      lastError: session.state.backend_state === "broken"
        ? (session.state.backend_error || "Codex session needs relaunch before queued messages can run.")
        : null,
      turnId: null,
      disconnectedAt: null,
      resumeConfirmedAt: null,
    });
    this.persistSession(session);
    this.dispatchQueuedCodexTurns(session, reason);
  }

  private trySteerPendingCodexInputs(session: Session, reason: string): boolean {
    const adapter = session.codexAdapter;
    const expectedTurnId = adapter?.getCurrentTurnId() ?? null;
    if (!adapter || !expectedTurnId || session.state.backend_state !== "connected" || !adapter.isConnected()) {
      return false;
    }
    const deliverable = this.getCancelablePendingCodexInputs(session);
    if (deliverable.length === 0) return false;
    const ids = deliverable.map((input) => input.id);
    this.setPendingCodexInputsCancelable(session, ids, false);
    const accepted = adapter.sendBrowserMessage({
      type: "codex_steer_pending",
      pendingInputIds: ids,
      expectedTurnId,
      inputs: this.buildCodexBatchMessageInputs(deliverable),
    });
    if (!accepted) {
      this.setPendingCodexInputsCancelable(session, ids, true);
      return false;
    }
    console.log(`[ws-bridge] Steered ${ids.length} pending Codex input(s) for session ${sessionTag(session.id)} (${reason})`);
    return true;
  }

  private commitPendingCodexInput(session: Session, id: string): number | null {
    const idx = session.pendingCodexInputs.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const pending = session.pendingCodexInputs[idx];
    session.pendingCodexInputs.splice(idx, 1);

    const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
      type: "user_message",
      content: pending.content,
      timestamp: pending.timestamp,
      id: pending.id,
      ...(pending.imageRefs?.length ? { images: pending.imageRefs } : {}),
      ...(pending.vscodeSelection ? { vscodeSelection: pending.vscodeSelection } : {}),
      ...(pending.agentSource ? { agentSource: pending.agentSource } : {}),
    };
    session.messageHistory.push(userHistoryEntry);
    const userMsgHistoryIdx = session.messageHistory.length - 1;
    session.lastUserMessage = (pending.content || "").slice(0, 80);
    this.broadcastToBrowsers(session, userHistoryEntry);
    this.broadcastPendingCodexInputs(session);
    if (this.onUserMessage) {
      this.onUserMessage(session.id, [...session.messageHistory], session.state.cwd, session.isGenerating);
    }
    this.persistSession(session);
    return userMsgHistoryIdx;
  }

  private removePendingCodexInput(session: Session, id: string): PendingCodexInput | null {
    const idx = session.pendingCodexInputs.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const [removed] = session.pendingCodexInputs.splice(idx, 1);
    this.broadcastPendingCodexInputs(session);
    this.persistSession(session);
    return removed;
  }

  private reconcileCodexResumedTurn(session: Session, snapshot: CodexResumeSnapshot): void {
    const pending = this.getCodexTurnInRecovery(session);
    const lastTurn = snapshot.lastTurn;
    if (!pending) return;

    if (!lastTurn) {
      if (pending.turnId) {
        console.log(
          `[ws-bridge] Resumed Codex snapshot for session ${sessionTag(session.id)} has no lastTurn while pending turn ${pending.turnId} is in flight; retrying message`,
        );
        this.retryPendingCodexTurn(session, pending);
      }
      return;
    }

    const pendingText = this.normalizeResumedUserText(pending.userContent);
    const resumedUserText = this.normalizeResumedUserText(this.extractUserTextFromResumedTurn(lastTurn));
    const matchesTurnId = !!pending.turnId && pending.turnId === lastTurn.id;
    const matchesText = !!pendingText && pendingText === resumedUserText;
    if (!matchesTurnId && !matchesText) {
      if (
        !pending.turnId
        && lastTurn.status === "inProgress"
        && snapshot.threadStatus === "idle"
        && lastTurn.items.length === 0
      ) {
        console.log(
          `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} ` +
          "lost local turn identity after turn/start; thread is idle and turn has no items, retrying user message",
        );
        this.retryPendingCodexTurn(session, pending);
        return;
      }
      if (pending.turnId && pending.turnId !== lastTurn.id) {
        console.log(
          `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} does not match pending turn ${pending.turnId}; retrying message`,
        );
        this.retryPendingCodexTurn(session, pending);
      }
      return;
    }

    const committedHistoryIndexes = this.commitPendingCodexInputs(
      session,
      pending.pendingInputIds ?? [pending.userMessageId],
    );
    if (committedHistoryIndexes.length > 0 && pending.historyIndex < 0) {
      pending.historyIndex = committedHistoryIndexes[0];
    }

    const nonUserItems = lastTurn.items.filter((item) => item.type !== "userMessage");
    if (nonUserItems.length === 0) {
      console.log(
        `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} has only user input; retrying message`,
      );
      this.retryPendingCodexTurn(session, pending);
      return;
    }

    // If the thread is idle but the last turn claims inProgress, the turn was
    // running in the dead CLI process and is now stale (e.g. compaction +
    // disconnect). Retry immediately — the work from the old turn is lost, but
    // Codex has compacted context and can pick up from a fresh turn. This check
    // must run BEFORE recovery/synthesis because those would absorb partial
    // results from a turn that will never continue.
    if (lastTurn.status === "inProgress" && snapshot.threadStatus === "idle") {
      console.log(
        `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} reports inProgress but thread is idle; retrying user message`,
      );
      this.retryPendingCodexTurn(session, pending);
      return;
    }

    const recovered = this.recoverAgentMessagesFromResumedTurn(session, lastTurn, pending);
    const synthesizedToolResults = this.synthesizeCodexToolResultsFromResumedTurn(session, lastTurn, pending);
    if (lastTurn.status === "inProgress") {
      if (recovered > 0 || synthesizedToolResults > 0) {
        session.consecutiveAdapterFailures = 0;
        session.lastAdapterFailureAt = null;
      }
      // Thread is still active — keep the authoritative outbound turn at the
      // head of the queue even if Codex replayed assistant/tool items during
      // resume. Those replay artifacts are browser-visible, but the user turn
      // is not complete until Codex reports a terminal turn status.
      pending.status = "backend_acknowledged";
      pending.turnId = lastTurn.id;
      pending.resumeConfirmedAt = Date.now();
      pending.updatedAt = pending.resumeConfirmedAt;
      if (pending.turnTarget !== "queued" && !session.isGenerating) {
        const target = this.markRunningFromUserDispatch(session, "codex_resume_in_progress");
        pending.turnTarget = target;
        if (pending.historyIndex >= 0) {
          this.trackUserMessageForTurn(session, pending.historyIndex, target);
        }
      }
      this.rearmRecoveredQueuedHeadTurn(session, pending, "codex_resume_in_progress");
      this.persistSession(session);
      return;
    }

    if (recovered > 0) {
      session.consecutiveAdapterFailures = 0;
      session.lastAdapterFailureAt = null;
      this.completeCodexTurn(session, pending);
      this.reconcileRecoveredQueuedTurnLifecycle(session, "codex_resume_recovered_messages");
      this.persistSession(session);
      this.dispatchQueuedCodexTurns(session, "codex_resume_recovered_messages");
      this.maybeFlushQueuedCodexMessages(session, "codex_resume_recovered_messages");
      return;
    }

    if (synthesizedToolResults > 0) {
      session.consecutiveAdapterFailures = 0;
      session.lastAdapterFailureAt = null;
      this.completeCodexTurn(session, pending);
      this.reconcileRecoveredQueuedTurnLifecycle(session, "codex_resume_synthesized_results");
      this.persistSession(session);
      this.dispatchQueuedCodexTurns(session, "codex_resume_synthesized_results");
      this.maybeFlushQueuedCodexMessages(session, "codex_resume_synthesized_results");
      return;
    }

    if (this.hasOnlyRetrySafeCodexResumedItems(nonUserItems)) {
      console.log(
        `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} contains reasoning-only items; retrying pending user message`,
      );
      this.retryPendingCodexTurn(session, pending);
      return;
    }

    this.completeCodexTurn(session, pending);
    this.reconcileRecoveredQueuedTurnLifecycle(session, "codex_resume_non_retryable");
    this.dispatchQueuedCodexTurns(session, "codex_resume_non_retryable");
    this.maybeFlushQueuedCodexMessages(session, "codex_resume_non_retryable");
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

  private hasOnlyRetrySafeCodexResumedItems(items: Array<Record<string, unknown>>): boolean {
    if (items.length === 0) return false;
    return items.every((item) => {
      const itemType = typeof item.type === "string" ? item.type : "";
      return CODEX_RETRY_SAFE_RESUME_ITEM_TYPES.has(itemType);
    });
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

  private normalizeResumedUserText(text: string): string {
    return text.trim().replace(/\s+/g, " ");
  }

  private normalizeCodexRecoveredAssistantText(text: string): string {
    return text.trim().replace(/\s+/g, " ");
  }

  private reconcileRecoveredQueuedTurnLifecycle(
    session: Session,
    reason: string,
    options: { releasedHeadQueuedTurn?: boolean } = {},
  ): void {
    const previousEntries = getQueuedTurnLifecycleEntriesLifecycle(session);
    const nextEntries = previousEntries.map((entry) => ({
      reason: entry.reason,
      userMessageIds: [...entry.userMessageIds],
      interruptSource: entry.interruptSource,
    }));
    let clearedQueuedHead = false;

    if (options.releasedHeadQueuedTurn && nextEntries.length > 0) {
      nextEntries.shift();
    }

    const liveTurns = session.pendingCodexTurns.filter((turn) => turn.status !== "completed");
    if (!session.isGenerating && liveTurns[0]?.turnTarget === "queued") {
      liveTurns[0].turnTarget = null;
      clearedQueuedHead = true;
      if (nextEntries.length > 0) {
        nextEntries.shift();
      }
    }

    const rebuiltEntries = liveTurns
      .filter((turn) => turn.turnTarget === "queued")
      .map((turn, idx) => ({
        reason: nextEntries[idx]?.reason ?? "queued_user_message",
        userMessageIds: nextEntries[idx]?.userMessageIds ?? (turn.historyIndex >= 0 ? [turn.historyIndex] : []),
        interruptSource: nextEntries[idx]?.interruptSource ?? null,
      }));

    const lifecycleChanged =
      JSON.stringify(previousEntries) !== JSON.stringify(rebuiltEntries)
      || clearedQueuedHead
      || options.releasedHeadQueuedTurn === true;
    if (!lifecycleChanged) return;

    replaceQueuedTurnLifecycleEntriesLifecycle(session, rebuiltEntries);
    console.log(
      `[ws-bridge] Reconciled queued-turn lifecycle for session ${sessionTag(session.id)} ` +
      `(${reason}, queued=${rebuiltEntries.length}${clearedQueuedHead ? ", cleared_head" : ""})`,
    );
  }

  private rearmRecoveredQueuedHeadTurn(
    session: Session,
    pending: CodexOutboundTurn,
    reason: string,
  ): void {
    if (pending.turnTarget !== "queued" || session.isGenerating) return;

    if (promoteNextQueuedTurnLifecycle(this.getGenerationLifecycleDeps(), session)) {
      pending.turnTarget = "current";
      console.log(
        `[ws-bridge] Re-armed recovered queued Codex turn for session ${sessionTag(session.id)} ` +
        `(${reason}, via_lifecycle_promotion)`,
      );
      return;
    }

    const target = this.markRunningFromUserDispatch(session, reason);
    pending.turnTarget = target;
    if (pending.historyIndex >= 0) {
      this.trackUserMessageForTurn(session, pending.historyIndex, target);
    }
    console.log(
      `[ws-bridge] Re-armed recovered queued Codex turn for session ${sessionTag(session.id)} ` +
      `(${reason}, via_running_guard)`,
    );
  }

  private findMatchingRecoveredCodexAssistant(
    session: Session,
    text: string,
  ): Extract<BrowserIncomingMessage, { type: "assistant" }> | null {
    const normalizedText = this.normalizeCodexRecoveredAssistantText(text);
    if (!normalizedText) return null;

    let scannedAssistants = 0;
    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      const entry = session.messageHistory[i];
      if (entry.type !== "assistant") continue;
      scannedAssistants += 1;
      if (scannedAssistants > WsBridge.CODEX_ASSISTANT_REPLAY_SCAN_LIMIT) break;

      const existing = entry as Extract<BrowserIncomingMessage, { type: "assistant" }>;
      if (existing.parent_tool_use_id !== null) continue;
      const textBlocks = existing.message.content.filter((block) => block.type === "text");
      if (textBlocks.length !== 1) continue;

      const existingText = this.normalizeCodexRecoveredAssistantText(textBlocks[0].text || "");
      if (!existingText) continue;
      if (existingText === normalizedText) return existing;
    }

    return null;
  }

  private retryPendingCodexTurn(session: Session, pending: CodexOutboundTurn): void {
    const releasedHeadQueuedTurn = pending.turnTarget === "queued";
    pending.status = session.state.backend_state === "broken" ? "blocked_broken_session" : "queued";
    pending.updatedAt = Date.now();
    pending.acknowledgedAt = null;
    pending.lastError = null;
    pending.turnTarget = null;
    pending.turnId = null;
    pending.disconnectedAt = null;
    pending.resumeConfirmedAt = null;
    this.reconcileRecoveredQueuedTurnLifecycle(session, "codex_retry_pending_turn", { releasedHeadQueuedTurn });
    this.dispatchQueuedCodexTurns(session, "codex_retry_pending_turn");
    this.persistSession(session);
  }

  private recoverAgentMessagesFromResumedTurn(
    session: Session,
    turn: CodexResumeTurnSnapshot,
    pending: CodexOutboundTurn,
  ): number {
    let matchedOrRecovered = 0;
    const baseTs = pending.disconnectedAt ?? Date.now();

    for (let i = 0; i < turn.items.length; i++) {
      const item = turn.items[i];
      if (item.type !== "agentMessage") continue;
      const text = typeof item.text === "string" ? item.text : "";
      if (!text.trim()) continue;

      const itemId = typeof item.id === "string" ? item.id : `${turn.id}-${i}`;
      const assistantId = `codex-agent-${itemId}`;
      const alreadyExists = session.messageHistory.some((m) => (
        m.type === "assistant" && m.message?.id === assistantId
      ));
      if (alreadyExists) {
        matchedOrRecovered++;
        continue;
      }

      // Codex compaction/replay snapshots can rewrite historical assistant item
      // ids as generic "item-N" values. Match by text for those cases so the
      // already-rendered assistant commentary is not emitted again.
      if (/^item-\d+$/.test(itemId) && this.findMatchingRecoveredCodexAssistant(session, text)) {
        matchedOrRecovered++;
        continue;
      }

      const assistant: BrowserIncomingMessage = {
        type: "assistant",
        message: {
          id: assistantId,
          type: "message",
          role: "assistant",
          model: session.state.model || getDefaultModelForBackend("codex"),
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
        ...(this.classifyLeaderAssistantAddressing(session, [{ type: "text", text }]) === "user"
          ? { leader_user_addressed: true }
          : {}),
      };
      session.messageHistory.push(assistant);
      this.broadcastToBrowsers(session, assistant);
      matchedOrRecovered++;
    }

    return matchedOrRecovered;
  }

  /**
   * Optimistically mark a session running as soon as a user message is
   * dispatched, then roll back after a safety timeout if no backend output
   * arrives. This closes the idle-race window between dispatch and first token.
   */
  private markRunningFromUserDispatch(
    session: Session,
    reason: string,
    queuedInterruptSource: InterruptSource | null = null,
  ): UserDispatchTurnTarget {
    return markRunningFromUserDispatchLifecycle(
      this.getGenerationLifecycleDeps(),
      session,
      reason,
      queuedInterruptSource,
    );
  }

  private trackUserMessageForTurn(
    session: Session,
    historyIndex: number,
    target: UserDispatchTurnTarget,
  ): void {
    trackUserMessageForTurnLifecycle(session, historyIndex, target);
  }

  private clearOptimisticRunningTimer(session: Session, _reason: string): void {
    clearOptimisticRunningTimerLifecycle(session);
  }

  private isCliUserMessagePayload(ndjson: string): boolean {
    if (!ndjson.includes("\"type\":\"user\"")) return false;
    try {
      const parsed = JSON.parse(ndjson) as {
        type?: unknown;
        message?: { role?: unknown };
      };
      return parsed.type === "user" && parsed.message?.role === "user";
    } catch {
      return false;
    }
  }

  /** Centralized generation state setter with logging and recording. */
  private setGenerating(session: Session, generating: boolean, reason: string): void {
    setGeneratingLifecycle(this.getGenerationLifecycleDeps(), session, generating, reason);
  }

  private getGenerationLifecycleDeps() {
    return {
      sessions: this.sessions,
      userMessageRunningTimeoutMs: WsBridge.USER_MESSAGE_RUNNING_TIMEOUT_MS,
      broadcastStatus: (session: Session, status: "running" | "idle") => {
        this.broadcastToBrowsers(session, { type: "status_change", status });
      },
      persistSession: (session: Session) => this.persistSession(session),
      onSessionActivityStateChanged: (sessionId: string, reason: string) => this.onSessionActivityStateChanged(sessionId, reason),
      emitTakodeEvent: (sessionId: string, type: "turn_start" | "turn_end", data: Record<string, unknown>) => {
        this.emitTakodeEvent(sessionId, type, data);
      },
      buildTurnToolSummary: (session: Session) => this.buildTurnToolSummary(session),
      recordGenerationStarted: (session: Session, reason: string) => {
        this.recorder?.recordServerEvent(session.id, "generation_started", { reason }, session.backendType, session.state.cwd);
      },
      recordGenerationEnded: (session: Session, reason: string, elapsedMs: number) => {
        this.recorder?.recordServerEvent(
          session.id,
          "generation_ended",
          { reason, elapsed: elapsedMs },
          session.backendType,
          session.state.cwd,
        );
      },
      onOrchestratorTurnEnd: (sessionId: string) => {
        if (!this.herdEventDispatcher) return;
        const info = this.launcher?.getSession(sessionId);
        if (info?.isOrchestrator) {
          this.herdEventDispatcher.onOrchestratorTurnEnd(sessionId);
        }
      },
      getCurrentTurnTriggerSource: (session: Session) => this.getCurrentTurnTriggerSource(session),
      isHerdedWorker: (session: Session) => this.isHerdedWorkerSession(session),
    };
  }

  /** Build a preview of a permission request for inclusion in takode events.
   *  For AskUserQuestion: first question text. For ExitPlanMode: truncated plan. */
  private buildPermissionPreview(
    perm: PermissionRequest,
  ): Pick<TakodePermissionRequestEventData, "question" | "options" | "planPreview"> {
    if (perm.tool_name === "AskUserQuestion") {
      const questions = perm.input.questions as Array<{ question: string; options?: Array<{ label: string }> }> | undefined;
      if (questions?.[0]) {
        const options = questions[0].options?.map(o => o.label);
        return {
          question: questions[0].question,
          ...(options ? { options } : {}),
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
  private buildTurnToolSummary(
    session: Session,
  ): Pick<TakodeTurnEndEventData, "tools" | "resultPreview" | "msgRange" | "questChange" | "userMsgs"> {
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

    // Message ID range: from turn start snapshot to current end
    const msgFrom = session.messageCountAtTurnStart;
    const msgTo = history.length > 0 ? history.length - 1 : 0;
    const msgRange = msgFrom < msgTo ? { from: msgFrom, to: msgTo } : undefined;

    // Quest status change: compare snapshot at turn start with current status
    const currentQuestStatus = session.state.claimedQuestStatus ?? null;
    const prevQuestStatus = session.questStatusAtTurnStart;
    const questChange = (prevQuestStatus !== currentQuestStatus && session.state.claimedQuestId)
      ? {
          questId: session.state.claimedQuestId,
          from: prevQuestStatus || "none",
          to: currentQuestStatus || "none",
        }
      : undefined;

    // User messages received during this turn (deferred from immediate delivery)
    const userMsgs = session.userMessageIdsThisTurn.length > 0
      ? { count: session.userMessageIdsThisTurn.length, ids: [...session.userMessageIdsThisTurn] }
      : undefined;

    return {
      ...(Object.keys(toolCounts).length > 0 ? { tools: toolCounts } : {}),
      ...(resultPreview ? { resultPreview } : {}),
      ...(msgRange ? { msgRange } : {}),
      ...(questChange ? { questChange } : {}),
      ...(userMsgs ? { userMsgs } : {}),
    };
  }

  /** Derive current session status from explicit runtime state. */
  private deriveSessionStatus(session: Session): string | null {
    if (session.state.is_compacting) return "compacting";
    if (!this.backendConnected(session)) return null;
    if (session.isGenerating) return "running";
    return "idle";
  }

  /** Send authoritative state snapshot to a single browser after subscribe replay. */
  private sendStateSnapshot(session: Session, ws: ServerWebSocket<SocketData>): void {
    this.sendToBrowser(ws, {
      type: "state_snapshot",
      sessionStatus: this.deriveSessionStatus(session),
      permissionMode: session.state.permissionMode,
      backendConnected: this.backendConnected(session),
      backendState: this.deriveBackendState(session),
      backendError: session.state.backend_error ?? null,
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
      && msg.type !== "event_replay"
      && msg.type !== "leader_group_idle";
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
    if (session.browserSockets.size === 0 && (msg.type === "assistant" || msg.type === "result")) {
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

    let successfulFanout = 0;
    for (const ws of session.browserSockets) {
      try {
        ws.send(json);
        successfulFanout++;
      } catch {
        session.browserSockets.delete(ws);
      }
    }
    trafficStats.record({
      sessionId: session.id,
      channel: "browser",
      direction: "out",
      messageType: msg.type,
      payloadBytes: Buffer.byteLength(json, "utf-8"),
      fanout: successfulFanout,
    });
  }

  private sendToBrowser(ws: ServerWebSocket<SocketData>, msg: BrowserIncomingMessage) {
    try {
      const json = JSON.stringify(msg);
      ws.send(json);
      const sessionId = (ws.data as BrowserSocketData).sessionId;
      trafficStats.record({
        sessionId,
        channel: "browser",
        direction: "out",
        messageType: msg.type,
        payloadBytes: Buffer.byteLength(json, "utf-8"),
        fanout: 1,
      });
    } catch {
      // Socket will be cleaned up on close
    }
  }
}
