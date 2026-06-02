import type {
  BackendType,
  CodexResultErrorAutoPauseState,
  CodexLeaderRecycleLineage,
  CodexLeaderRecycleTrigger,
  SessionPauseState,
} from "./session-types.js";
import type { LeaderActivePhaseSummarySegment } from "../shared/leader-active-phase-summary.js";

export interface SdkSessionInfo {
  sessionId: string;
  /** Monotonic integer ID assigned at runtime (not persisted, regenerated on restart) */
  sessionNum?: number;
  pid?: number;
  state: "starting" | "connected" | "running" | "exited";
  exitCode?: number | null;
  model?: string;
  permissionMode?: string;
  /** Whether permission prompts are enabled (shared UI state; backend-specific mapping). */
  askPermission?: boolean;
  /** Codex collaboration UI mode, kept separate from the permission profile. */
  uiMode?: "plan" | "agent";
  cwd: string;
  createdAt: number;
  /** Epoch ms of last user or CLI activity (used by idle manager) */
  lastActivityAt?: number;
  /** Epoch ms of last user message (used for sidebar activity sort) */
  lastUserMessageAt?: number;
  /** The CLI's internal session ID (from system.init), used for --resume */
  cliSessionId?: string;
  /** Codex leader recycle lineage across fresh-thread swaps within one Takode session. */
  codexLeaderRecycleLineage?: CodexLeaderRecycleLineage;
  /** Resolved Codex leader recycle threshold derived at launch from source model effective context. */
  codexLeaderRecycleThresholdTokens?: number;
  /** Pending Codex leader recycle awaiting a fresh replacement thread and recovery prompt. */
  codexLeaderRecyclePending?: {
    eventIndex: number;
    trigger: CodexLeaderRecycleTrigger;
    requestedAt: number;
  } | null;
  archived?: boolean;
  /** Epoch ms when this session was archived */
  archivedAt?: number;
  /** Async cleanup state for archived worktree sessions. */
  worktreeCleanupStatus?: "pending" | "done" | "failed";
  /** Last background cleanup error, if any. */
  worktreeCleanupError?: string;
  /** Epoch ms when background cleanup started. */
  worktreeCleanupStartedAt?: number;
  /** Epoch ms when background cleanup finished (success or failure). */
  worktreeCleanupFinishedAt?: number;
  /** User-facing session name */
  name?: string;
  /** Hidden implementation session, omitted from normal session lists. */
  hidden?: boolean;
  /** Parent/root session when this session backs a Slack-like conversation thread. */
  parentSessionId?: string;
  /** Slack-like branch id when this hidden session backs a root conversation thread. */
  slackThreadId?: string;
  slackThreadAnchorMessageId?: string;
  slackThreadAnchorHistoryIndex?: number;
  /** Hidden thread sessions are hard read-only regardless of normal permission mode. */
  slackThreadReadOnly?: boolean;
  /** Which backend this session uses */
  backendType?: BackendType;
  /** Git branch from bridge state (enriched by REST API) */
  gitBranch?: string;
  /** Git ahead count (enriched by REST API) */
  gitAhead?: number;
  /** Git behind count (enriched by REST API) */
  gitBehind?: number;
  /** Total lines added (enriched by REST API) */
  totalLinesAdded?: number;
  /** Total lines removed (enriched by REST API) */
  totalLinesRemoved?: number;
  /** Intentional diff-stat budget skip reason, distinct from refresh failures. */
  diffStatsSkippedReason?: string | null;
  /** Epoch ms for the last server git metadata refresh attempt. */
  gitStatusRefreshedAt?: number;
  /** Last git refresh error, if any. */
  gitStatusRefreshError?: string | null;
  /** Whether internet/web search is enabled for Codex sessions */
  codexInternetAccess?: boolean;
  /** Sandbox mode selected for Codex sessions */
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Reasoning effort selected for Codex sessions (e.g. low/medium/high). */
  codexReasoningEffort?: string;
  /** Optional per-session Codex home override, reused across relaunches. */
  codexHome?: string;
  /** If this session was spawned by a cron job */
  cronJobId?: string;
  /** Human-readable name of the cron job that spawned this session */
  cronJobName?: string;
  /** Number of active timers currently waiting on this session. */
  pendingTimerCount?: number;
  /** Emergency pause state for this session, when paused. */
  pause?: SessionPauseState | null;
  /** Number of inputs held while this session is paused. */
  pausedInputQueueCount?: number;
  /** Codex-only auto-pause state for repeated classified terminal result errors. */
  codexResultErrorAutoPause?: CodexResultErrorAutoPauseState | null;
  /** Number of coalesced automatic inputs held by Codex result-error auto-pause. */
  codexAutoPausedInputCount?: number;
  /** Highest active Takode notification urgency restored from the session inbox. */
  notificationUrgency?: "needs-input" | "review" | null;
  /** Number of unresolved Takode notifications for sidebar snapshots. */
  activeNotificationCount?: number;
  /** Set by idle manager before killing, lets the UI show a less alarming indicator */
  killedByIdleManager?: boolean;
  /** Whether --resume has already been retried once after a fast exit */
  resumeRetried?: boolean;

  // Worktree fields
  /** Whether this session uses a git worktree */
  isWorktree?: boolean;
  /** The original repo root path */
  repoRoot?: string;
  /** Conceptual branch this session is working on (what user selected) */
  branch?: string;
  /** Actual git branch in the worktree (may differ for -wt-N branches) */
  actualBranch?: string;
  /** Branch/repo target that worktree changes should port back to. */
  worktreePortTarget?: {
    repoRoot: string;
    branch: string;
    sourceSessionId?: string;
    sourceSessionNum?: number | null;
    sourceLabel?: string;
  };

  /** Whether this is an assistant-mode session */
  isAssistant?: boolean;
  /** Whether this is an orchestrator session (has herd/orchestration privileges) */
  isOrchestrator?: boolean;
  /** Stable built-in leader profile portrait assignment. */
  leaderProfilePortraitId?: string | null;
  /** Server-owned active Quest Journey phase counts for leader sidebar chips. */
  leaderActivePhaseSummary?: LeaderActivePhaseSummarySegment[];
  /** Session UUID of the leader that has herded this worker (single leader per session) */
  herdedBy?: string;
  /** Env profile slug used at creation, for re-resolving env vars on relaunch */
  envSlug?: string;
  /** Durable session-space/group assignment. `default` means confirmed default; null means unknown. */
  treeGroupId?: string | null;
  /** Authoritative Takode memory/session-space slug for default memory repo resolution. */
  memorySessionSpaceSlug?: string;
  /** When true, the session auto-namer is suppressed (e.g. temporary reviewer sessions) */
  noAutoName?: boolean;
  /** Session number of the parent session this reviewer is reviewing (reviewer lifecycle) */
  reviewerOf?: number;
  /** Server-issued secret used to authenticate privileged REST calls from this session. */
  sessionAuthToken?: string;
  /** One-shot: resume-session-at UUID for revert (cleared after use) */
  resumeAt?: string;
  /** The Companion-injected system prompt constructed at launch time (for debugging in Session Info). */
  injectedSystemPrompt?: string;
  /** Stable per-session Claude SDK debug log path for transport/process debugging. */
  sdkDebugLogPath?: string;

  // Container fields
  /** Docker container ID when session runs inside a container */
  containerId?: string;
  /** Docker container name */
  containerName?: string;
  /** Docker image used for the container */
  containerImage?: string;
}
