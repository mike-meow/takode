import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { computeSessionPayloadMetrics } from "./session-payload-metrics.js";
import { getDefaultModelForBackend } from "../shared/backend-defaults.js";
import type { PushoverNotifier } from "./pushover.js";
import type { TrafficStatsSnapshot } from "./traffic-stats.js";
import type {
  CLIMessage,
  CLIAssistantMessage,
  CLIResultMessage,
  CLIControlResponseMessage,
  CLISystemCompactBoundaryMessage,
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
  CodexLeaderRecycleTrigger,
  TakodeEvent,
  TakodeEventDataByType,
  TakodeEventType,
  TakodePermissionRequestEventData,
  TakodeTurnEndEventData,
  TakodeWorkerStreamEventData,
  BoardRow,
  SessionNotification,
  SessionAttentionRecord,
  TakodeHerdBatchSnapshot,
  ThreadRef,
  ActiveTurnRoute,
} from "./session-types.js";
import { TOOL_RESULT_PREVIEW_LIMIT, assertNever, formatVsCodeSelectionPrompt } from "./session-types.js";
import type { QuestJourneyState } from "./session-types.js";
import { SessionStore } from "./session-store.js";
import type { CodexResumeSnapshot, CodexResumeTurnSnapshot, CodexSessionMeta } from "./codex-adapter.js";
import type { ClaudeSdkSessionMeta } from "./claude-sdk-adapter.js";
import type { RecorderManager } from "./recorder.js";
import type { ImageStore } from "./image-store.js";
import type { CliLauncher } from "./cli-launcher.js";
import { buildBoardRowSessionStatuses } from "./board-row-session-status.js";
import * as gitUtils from "./git-utils.js";
import { sessionTag } from "./session-tag.js";
import type { PerfTracer } from "./perf-tracer.js";
import { HerdEventDispatcher, isSessionIdleRuntime } from "./herd-event-dispatcher.js";
import { injectCompactionRecovery as injectCompactionRecoveryController } from "./bridge/compaction-recovery.js";
import {
  handlePermissionRequest as handlePermissionRequestPipeline,
  type PermissionPipelineResult,
  isSensitiveBashCommand as isSensitiveBashCommandPolicy,
  isSensitiveConfigPath as isSensitiveConfigPathPolicy,
} from "./bridge/permission-pipeline.js";
import { detectLongSleepBashCommand, LONG_SLEEP_REMINDER_TEXT } from "./bridge/bash-sleep-policy.js";
import { getApprovalSummary, getDenialSummary } from "./bridge/permission-summaries.js";
import {
  cleanupBranchState as cleanupBranchStateIndex,
  invalidateSessionsSharingBranch as invalidateSessionsSharingBranchIndex,
  updateBranchIndex as updateBranchIndexState,
} from "./bridge/branch-session-index.js";
import {
  clearCodexFreshTurnRequirement as clearCodexFreshTurnRequirementState,
  completeCodexTurn as completeCodexTurnState,
  enqueueCodexTurn as enqueueCodexTurnState,
  getCodexHeadTurn as getCodexHeadTurnState,
  getCodexTurnAwaitingAck as getCodexTurnAwaitingAckState,
  getCodexTurnInRecovery as getCodexTurnInRecoveryState,
  removeCompletedCodexTurns as removeCompletedCodexTurnsState,
} from "./bridge/codex-turn-queue.js";
import {
  clampFrozenCount as clampFrozenCountController,
  freezeHistoryThroughCurrentTail as freezeHistoryThroughCurrentTailController,
} from "./bridge/browser-transport-controller.js";
import {
  broadcastToBrowsers as broadcastToBrowsersController,
  deriveActiveTurnRoute as deriveActiveTurnRouteBrowserTransportController,
  deriveSessionStatus as deriveSessionStatusController,
  findMatchingPendingCodexInput as findMatchingPendingCodexInputBrowserTransportController,
  getPendingCodexInputDeliveryState as getPendingCodexInputDeliveryStateBrowserTransportController,
  handleBrowserClose as handleBrowserCloseController,
  handleBrowserMessage as handleBrowserMessageTransportController,
  handleBrowserOpen as handleBrowserOpenController,
  isHerdEventSource as isHerdEventSourceBrowserTransportController,
  injectUserMessage as injectUserMessageController,
  isHistoryBackedEvent as isHistoryBackedEventController,
  sameAgentSource as sameAgentSourceBrowserTransportController,
  sendToBrowser as sendToBrowserController,
} from "./bridge/browser-transport-controller.js";
import type { BrowserTransportStateLike } from "./bridge/browser-transport-controller.js";
import {
  flushQueuedCliMessages as flushQueuedCliMessagesController,
  handleCLIClose as handleCLICloseTransportController,
  handleCLIOpen as handleCLIOpenTransportController,
  handleControlResponse as handleControlResponseTransportController,
  processCLIMessageBatch as processCLIMessageBatchController,
  sendControlRequest as sendControlRequestTransportController,
  sendToCLI as sendToCLITransportController,
} from "./bridge/claude-cli-transport-controller.js";
import { attachClaudeSdkAdapterLifecycle } from "./bridge/claude-sdk-adapter-lifecycle-controller.js";
import {
  flushQueuedMessagesToCodexAdapter as flushQueuedMessagesToCodexAdapterController,
  handleCodexAdapterBrowserMessage as handleCodexAdapterBrowserMessageController,
} from "./bridge/codex-adapter-browser-message-controller.js";
import {
  getBoardForSession as getBoardForSessionController,
  getBoardDispatchableSignature as getBoardDispatchableSignatureController,
  getBoardDispatchableSignatureForSession as getBoardDispatchableSignatureForSessionController,
  getBoardStallSignature as getBoardStallSignatureController,
  getBoardStallSignatureForSession as getBoardStallSignatureForSessionController,
  getCompletedBoardForSession as getCompletedBoardForSessionController,
  pruneStaleBoardStalledHerdBatch as pruneStaleBoardStalledHerdBatchController,
  pruneStalePendingCodexHerdInputs as pruneStalePendingCodexHerdInputsController,
  removeBoardRowFromAllSessions as removeBoardRowFromAllSessionsController,
  sweepBoardDispatchableWarnings as sweepBoardDispatchableWarningsController,
  sweepBoardStallWarnings as sweepBoardStallWarningsController,
} from "./bridge/board-watchdog-controller.js";
import {
  backendAttached as backendAttachedController,
  backendConnected as backendConnectedController,
  beginCodexRollback as beginCodexRollbackController,
  buildPersistedSessionPayload as buildPersistedSessionPayloadController,
  clearActionAttentionIfNoPermissions as clearActionAttentionIfNoPermissionsController,
  clearAttentionAndMarkRead as clearAttentionAndMarkReadController,
  deriveBackendState as deriveBackendStateController,
  finalizeCodexRollback as finalizeCodexRollbackController,
  getNotifications as getNotificationsController,
  getCurrentTurnTriggerSource as getCurrentTurnTriggerSourceController,
  handleResultAttentionAndNotifications as handleResultAttentionAndNotificationsController,
  killSession as killSessionController,
  getOrCreateSession as getOrCreateSessionController,
  hasAssistantReplay as hasAssistantReplayController,
  hasCompactBoundaryReplay as hasCompactBoundaryReplayController,
  hasResultReplay as hasResultReplayController,
  hasTaskNotificationReplay as hasTaskNotificationReplayController,
  hasToolResultPreviewReplay as hasToolResultPreviewReplayController,
  hasUserPromptReplay as hasUserPromptReplayController,
  markAllNotificationsDoneBySessionId as markAllNotificationsDoneBySessionIdController,
  markCodexAutoRecoveryFailed as markCodexAutoRecoveryFailedController,
  markNotificationDoneBySessionId as markNotificationDoneBySessionIdController,
  notifyUserBySessionId as notifyUserBySessionIdController,
  prepareSessionForRevert as prepareSessionForRevertController,
  reconcileCodexQuestToolResult as reconcileCodexQuestToolResultController,
  restorePersistedSessions as restorePersistedSessionsController,
  removeSession as removeSessionController,
  getSessionActivitySnapshot as getSessionActivitySnapshotController,
  setBackendState as setBackendStateController,
  setAttention as setAttentionController,
  trackCodexQuestCommands as trackCodexQuestCommandsController,
  closeSession as closeSessionController,
} from "./bridge/session-registry-controller.js";
import {
  createClaudeMessageHandlers as createClaudeMessageHandlersController,
  drainInlineQueuedClaudeTurns as drainInlineQueuedClaudeTurnsController,
  routeCLIMessage as routeCLIMessageController,
} from "./bridge/claude-message-controller.js";
import {
  handleCodexPermissionRequest as handleCodexPermissionRequestController,
  handleControlRequest as handleControlRequestController,
  handleInterrupt as handleInterruptController,
  handleSetModel as handleSetModelController,
  handleCodexSetModel as handleCodexSetModelController,
  handleCodexSetReasoningEffort as handleCodexSetReasoningEffortController,
  routeBrowserMessage as routeBrowserMessageController,
  handleSdkPermissionRequest as handleSdkPermissionRequestController,
  handleSetAskPermission as handleSetAskPermissionController,
  handleSetPermissionMode as handleSetPermissionModeController,
  handleCodexSetPermissionMode as handleCodexSetPermissionModeController,
  hasPendingForceCompact as hasPendingForceCompactController,
  isCliSlashCommand as isCliSlashCommandController,
  queueForceCompactPendingMessage as queueForceCompactPendingMessageController,
  tryLlmAutoApproval as tryLlmAutoApprovalController,
} from "./bridge/adapter-browser-routing-controller.js";
import {
  addPendingCodexInput as addPendingCodexInputController,
  attachCodexAdapterLifecycle as attachCodexAdapterLifecycleController,
  armCodexFreshTurnRequirement as armCodexFreshTurnRequirementController,
  clearCodexFreshTurnRequirement as clearCodexFreshTurnRequirementController,
  commitPendingCodexInputs as commitPendingCodexInputsController,
  completeCodexTurnsForResult as completeCodexTurnsForResultController,
  dispatchQueuedCodexTurns as dispatchQueuedCodexTurnsController,
  extractUserTextFromResumedTurn as extractUserTextFromResumedTurnController,
  getCancelablePendingCodexInputs as getCancelablePendingCodexInputsController,
  getPendingCodexInputsByIds as getPendingCodexInputsByIdsController,
  hydrateCodexResumedHistory as hydrateCodexResumedHistoryController,
  maybeFlushQueuedCodexMessages as maybeFlushQueuedCodexMessagesController,
  queueCodexPendingStartBatch as queueCodexPendingStartBatchController,
  rearmRecoveredQueuedHeadTurn as rearmRecoveredQueuedHeadTurnController,
  registerCodexAdapterRecoveryLifecycle,
  rebuildQueuedCodexPendingStartBatch as rebuildQueuedCodexPendingStartBatchController,
  reconcileCodexResumedTurn as reconcileCodexResumedTurnController,
  reconcileRecoveredQueuedTurnLifecycle as reconcileRecoveredQueuedTurnLifecycleController,
  recordSteeredCodexTurn as recordSteeredCodexTurnController,
  removePendingCodexInput as removePendingCodexInputController,
  retryPendingCodexTurn as retryPendingCodexTurnController,
  requestCodexAutoRecovery as requestCodexAutoRecoveryOrchestratorController,
  setPendingCodexInputCancelable as setPendingCodexInputCancelableController,
  setPendingCodexInputsCancelable as setPendingCodexInputsCancelableController,
  trySteerPendingCodexInputs as trySteerPendingCodexInputsController,
} from "./bridge/codex-recovery-orchestrator.js";
import {
  buildToolResultPreviews as buildToolResultPreviewsController,
  clearAllCodexToolResultWatchdogs as clearAllCodexToolResultWatchdogsController,
  clearCodexToolResultWatchdog as clearCodexToolResultWatchdogController,
  collectCompletedToolStartTimes as collectCompletedToolStartTimesController,
  finalizeSupersededCodexTerminalTools as finalizeSupersededCodexTerminalToolsController,
  finalizeOrphanedTerminalToolsOnResult as finalizeOrphanedTerminalToolsOnResultController,
  finalizeRecoveredDisconnectedTerminalTools as finalizeRecoveredDisconnectedTerminalToolsController,
  findToolUseBlockInHistory as findToolUseBlockInHistoryController,
  getIndexedToolResult,
  getToolResultPreviewLimit as getToolResultPreviewLimitController,
  pruneToolResultsForCurrentHistory as pruneToolResultsForCurrentHistoryController,
  recoverToolStartTimesFromHistory as recoverToolStartTimesFromHistoryController,
  scheduleCodexToolResultWatchdogs as scheduleCodexToolResultWatchdogsController,
  shouldDeferCodexToolResultWatchdog as shouldDeferCodexToolResultWatchdogController,
  synthesizeCodexToolResultsFromResumedTurn as synthesizeCodexToolResultsFromResumedTurnController,
} from "./bridge/tool-result-recovery-controller.js";

// `takode board` output is compact, high-signal state that agents routinely
// reason about. A 300-char tail preview can hide dependent rows and make the
// model think a row disappeared when only the preview was truncated.
const TAKODE_BOARD_RESULT_PREVIEW_LIMIT = 12_000;
import type { QuestLifecycleStatus } from "./bridge/quest-detector.js";
import {
  clearOptimisticRunningTimer as clearOptimisticRunningTimerLifecycle,
  getQueuedTurnLifecycleEntries as getQueuedTurnLifecycleEntriesLifecycle,
  markRunningFromUserDispatch as markRunningFromUserDispatchLifecycle,
  markTurnInterrupted as markTurnInterruptedLifecycle,
  promoteNextQueuedTurn as promoteNextQueuedTurnLifecycle,
  reconcileTerminalResultState as reconcileTerminalResultStateLifecycle,
  replaceQueuedTurnLifecycleEntries as replaceQueuedTurnLifecycleEntriesLifecycle,
  runStuckSessionWatchdogSweep as runStuckSessionWatchdogSweepLifecycle,
  setGenerating as setGeneratingLifecycle,
  type InterruptSource as GenerationInterruptSource,
  type UserDispatchTurnTarget,
  trackUserMessageForTurn as trackUserMessageForTurnLifecycle,
} from "./bridge/generation-lifecycle.js";
import {
  computeDiffStatsAsync as computeDiffStatsAsyncController,
  makeDefaultState,
  refreshGitInfo as refreshGitInfoController,
  refreshWorktreeGitStateForSnapshot as refreshWorktreeGitStateForSnapshotController,
  recomputeDiffIfDirty as recomputeDiffIfDirtyController,
} from "./bridge/session-git-state.js";
import { getSettings } from "./settings-manager.js";
import type {
  BackendAdapter,
  CompactRequestedAwareAdapter,
  CurrentTurnIdAwareAdapter,
  PendingOutgoingAwareAdapter,
  RateLimitsAwareAdapter,
  TurnSteerFailedAwareAdapter,
  TurnStartedAwareAdapter,
  TurnSteeredAwareAdapter,
  TurnStartFailedAwareAdapter,
} from "./bridge/adapter-interface.js";

const MAX_ADAPTER_RELAUNCH_FAILURES = 3;
const ADAPTER_FAILURE_RESET_WINDOW_MS = 120_000;
const CODEX_INTENTIONAL_RELAUNCH_GUARD_MS = 15_000;
const CODEX_RETRY_SAFE_RESUME_ITEM_TYPES: ReadonlySet<string> = new Set(["reasoning", "contextCompaction"]);
const CODEX_TOOL_RESULT_WATCHDOG_MS = 120_000;

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

type TurnTriggerSource = "user" | "leader" | "system" | "unknown";
type InterruptSource = GenerationInterruptSource;
type CodexBridgeAdapter = BackendAdapter<CodexSessionMeta> &
  TurnStartedAwareAdapter &
  TurnSteeredAwareAdapter &
  TurnSteerFailedAwareAdapter &
  TurnStartFailedAwareAdapter &
  CurrentTurnIdAwareAdapter &
  RateLimitsAwareAdapter & {
    rollbackTurns: (numTurns: number) => Promise<void>;
  } & Partial<{
    refreshSkills: (forceReload?: boolean) => Promise<string[]>;
  }>;
type ClaudeSdkBridgeAdapter = BackendAdapter<ClaudeSdkSessionMeta> & CompactRequestedAwareAdapter;

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
  /** True after Takode has queued a forced `/compact` and is waiting for the
   *  relaunched Claude session to actually begin the real compaction cycle. */
  forceCompactPending: boolean;
  /** Authoritative Codex outbound user-turn queue (persisted across disconnect/relaunch). */
  pendingCodexTurns: CodexOutboundTurn[];
  /** Codex inputs accepted by Takode but not yet delivered to Codex. */
  pendingCodexInputs: PendingCodexInput[];
  /** Pending Codex thread rollback to run on the next connected adapter. */
  pendingCodexRollback: { numTurns: number; truncateIdx: number; clearCodexState: boolean } | null;
  /** Last error from a pending Codex rollback, if any. */
  pendingCodexRollbackError: string | null;
  /** Resolver for an in-flight deferred Codex rollback request. */
  pendingCodexRollbackWaiter: { resolve: () => void; reject: (err: Error) => void } | null;
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
  pendingQuestCommands: Map<
    string,
    { questId: string; targetStatus?: QuestLifecycleStatus; verificationInboxUnread?: boolean }
  >;
  /** Set after compact_boundary; the next user text message is the summary */
  awaitingCompactSummary?: boolean;
  /** Claude WebSocket only: a real compact_boundary arrived for the current compaction cycle. */
  claudeCompactBoundarySeen?: boolean;
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
  /** Optional restart-prep metadata for a user-sourced interrupt. */
  restartPrepInterruptOperationId?: string | null;
  restartPrepInterruptOrigin?: "restart_prep" | null;
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
  /** Synthetic quest-thread attachment reminders queued from leader assistant output for delivery after result. */
  questThreadRemindersThisTurn?: import("./bridge/quest-thread-reminder.js").QuestThreadReminderInjection[];
  /** Thread/quest route associated with the currently active turn, when known. */
  activeTurnRoute?: ActiveTurnRoute | null;
  /** Number of follow-up turns queued while a current turn is still running. */
  queuedTurnStarts: number;
  /** Dispatch reasons for queued follow-up turns (aligned with queuedTurnStarts). */
  queuedTurnReasons: string[];
  /** User message history IDs per queued follow-up turn. */
  queuedTurnUserMessageIds: number[][];
  /** Interrupt sources aligned with queued follow-up turns.
   *  A queued follow-up does not prove the active turn was interrupted. */
  queuedTurnInterruptSources: (InterruptSource | null)[];
  /** Explicit active-thread route aligned with queued follow-up turns. */
  queuedTurnActiveRoutes?: (ActiveTurnRoute | null)[];
  /** Codex-only: active turn id that must end before a follow-up can start a fresh turn.
   *  Used for denied ExitPlanMode so new input does not get steered into the old plan turn. */
  codexFreshTurnRequiredUntilTurnId: string | null;
  /** Whether system.init has been received since the last CLI connect.
   *  False during --resume replay — messages sent before init are dropped by CLI. */
  cliInitReceived: boolean;
  /** Last message received from CLI (epoch ms), for stuck detection */
  lastCliMessageAt: number;
  /** Last keep_alive or WebSocket ping from CLI (epoch ms), for disconnect diagnostics */
  lastCliPingAt: number;
  /** Last tool_progress from any tool (epoch ms). Prevents false "stuck"
   *  warnings when a tool (Bash, Agent, etc.) is legitimately running. */
  lastToolProgressAt: number;
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
  /** Calendar date key (YYYY-MM-DD) of the last CLI-bound user message, for date-boundary injection. */
  lastUserMessageDateTag: string;
  /** Epoch ms when the user last viewed this session (server-authoritative) */
  lastReadAt: number;
  /** Current attention reason: why this session needs the user's attention */
  attentionReason: "action" | "error" | "review" | null;
  /** Codex-only: defers disconnect interruption side-effects while reconnect/resume may recover the turn. */
  codexDisconnectGraceTimer: ReturnType<typeof setTimeout> | null;
  /** Grace period timer for CLI disconnect — delays side-effects to allow seamless reconnect.
   *  The Claude Code CLI disconnects every 5 minutes for token refresh and reconnects in ~13s.
   *  If the CLI reconnects within the grace period, the disconnect is invisible to the system. */
  disconnectGraceTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the CLI was generating when the grace timer started (preserved for deferred handling). */
  disconnectWasGenerating: boolean;
  /** Set when the CLI reconnects within the grace period (token refresh, not relaunch).
   *  Consumed by system.init handler to skip force-clearing isGenerating. */
  seamlessReconnect: boolean;
  /** Set by onBeforeRelaunch — prevents handleCLIOpen from treating the new
   *  CLI connection as a seamless reconnect (which would preserve stale isGenerating). */
  relaunchPending: boolean;
  /** High-level task history recognized by the session auto-namer */
  taskHistory: SessionTaskEntry[];
  /** Accumulated search keywords from the session auto-namer */
  keywords: string[];
  /** Leader work board: quest ID → row. Ephemeral per leader session, persisted across restarts. */
  board: Map<string, BoardRow>;
  /** Completed board items (moved here by rm/advance instead of being deleted). Newest-first by completedAt. */
  completedBoard: Map<string, BoardRow>;
  /** Per-row stall tracking for board warnings (not persisted). */
  boardStallStates: Map<string, { signature: string; stalledSince: number; warnedAt: number | null }>;
  /** Per-row queued dispatchability tracking for one-shot nudges (not persisted). */
  boardDispatchStates: Map<string, { signature: string; warnedAt: number | null; notificationId?: string | null }>;
  /** Per-session notification inbox entries from `takode notify`. */
  notifications: SessionNotification[];
  /** Server-authoritative attention records for Main ledger rows and top chips. */
  attentionRecords: SessionAttentionRecord[];
  /** Monotonic counter for notification IDs (survives deletion without collisions). */
  notificationCounter: number;
  /** Whether agent activity has occurred since the last diff computation */
  diffStatsDirty: boolean;
  /** True when this archived session was loaded with only search-relevant data.
   *  Full messageHistory will be lazy-loaded on first browser subscribe. */
  searchDataOnly: boolean;
  /** Lightweight search excerpts for search-data-only sessions. */
  searchExcerpts: import("./session-store.js").SearchExcerpt[];
  /** Whether this session was created by resuming an external CLI session (VS Code/terminal) */
  resumedFromExternal?: boolean;
  /** AbortControllers for in-flight LLM auto-approval evaluations, keyed by request_id.
   *  Used to cancel the LLM subprocess when the user responds manually. Transient — not persisted. */
  evaluatingAborts: Map<string, AbortController>;
  /** Whether we've sent the `initialize` control_request with appendSystemPrompt
   *  to the current CLI process (WebSocket sessions only). Reset on relaunch so
   *  new processes get fresh instructions. Prevents double-sends on seamless reconnects. */
  cliInitializeSent: boolean;
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
  /** True only for the first replay after a revert. While set, replayed
   *  history-backed Claude messages that are no longer present in the truncated
   *  messageHistory must be ignored instead of being re-appended. */
  dropReplayHistoryAfterRevert: boolean;
}

type BoardStallStatus = "running" | "idle" | "disconnected" | "missing";

interface BoardStallCandidate {
  signature: string;
  sourceSessionId: string;
  questId: string;
  title?: string;
  stage?: string;
  workerStatus: BoardStallStatus;
  reviewerStatus: BoardStallStatus;
  stalledSince: number;
  reason: string;
  action: string;
}

interface BoardDispatchableCandidate {
  signature: string;
  questId: string;
  title?: string;
  summary: string;
  action?: string;
}

export interface WorkerStreamCheckpointResult {
  ok: true;
  streamed: boolean;
  reason: "streamed" | "not_generating" | "no_activity" | "dispatcher_unavailable";
  msgRange?: NonNullable<TakodeWorkerStreamEventData["msgRange"]>;
}

const BOARD_STALL_THRESHOLD_MS = 3 * 60_000;

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

// ─── Stuck Session Constants ─────────────────────────────────────────────────
// Shared between the watchdog and system.init reconnect handler.

/** Minimum generation age (ms) before a session is considered potentially stuck.
 *  Used by the watchdog for first detection AND by the seamless reconnect handler
 *  to decide whether a long-running generation should be force-cleared. */
const STUCK_GENERATION_THRESHOLD_MS = 120_000; // 2 minutes
const CODEX_DISCONNECT_GRACE_MS = 15_000;
const CODEX_RECOVERY_TIMEOUT_MS = 30_000;
const STUCK_PENDING_DELIVERY_MS = 60_000;

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
  /** Per-session serialization chain for externally injected/browser-routed messages.
   *  Preserves send order across async image ingestion without blocking other sessions. */
  private sessionRouteChains = new Map<string, Promise<void>>();
  private workerStreamCheckpointMsgTo = new Map<string, number>();
  /** Per-session serialization chain for Codex quest lifecycle reconciliation. */
  private codexQuestLifecycleChains = new Map<string, Promise<void>>();
  store: SessionStore | null = null;
  recorder: RecorderManager | null = null;
  timerManager: import("./timer-manager.js").TimerManager | null = null;
  imageStore: ImageStore | null = null;
  pushoverNotifier: PushoverNotifier | null = null;
  launcher: CliLauncher | null = null;
  herdEventDispatcher: Pick<
    HerdEventDispatcher,
    | "emitTakodeEvent"
    | "subscribeTakodeEvents"
    | "onSessionActivityStateChanged"
    | "onOrchestratorTurnEnd"
    | "onOrchestratorDisconnect"
    | "getDiagnostics"
    | "forceFlushPendingEvents"
  > | null = null;
  perfTracer: PerfTracer | null = null;
  onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null = null;
  onCLIRelaunchNeeded: ((sessionId: string) => void) | null = null;
  onPermissionModeChanged: ((sessionId: string, newMode: string) => void) | null = null;
  onSessionRelaunchRequested: ((sessionId: string) => void) | null = null;
  onUserMessage:
    | ((
        sessionId: string,
        history: import("./session-types.js").BrowserIncomingMessage[],
        cwd: string,
        wasGenerating: boolean,
      ) => void)
    | null = null;
  onTurnCompleted:
    | ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void)
    | null = null;
  onAgentPaused:
    | ((sessionId: string, history: import("./session-types.js").BrowserIncomingMessage[], cwd: string) => void)
    | null = null;
  onSessionNamedByQuest: ((sessionId: string, title: string) => void) | null = null;
  resolveQuestTitle: ((questId: string) => Promise<string | null>) | null = null;
  resolveQuestStatus: ((questId: string) => Promise<string | null>) | null = null;
  private userMsgCounter = 0;
  /** Per-project cache of slash commands, skills, and apps so new sessions get them
   *  before the CLI sends system/init (which only arrives after the first
   *  user message). Key is repo_root || cwd. */
  private slashCommandCache = new Map<
    string,
    {
      slash_commands: string[];
      skills: string[];
      skill_metadata: NonNullable<SessionState["skill_metadata"]>;
      apps: NonNullable<SessionState["apps"]>;
    }
  >();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  /** Track recent CLI disconnects to detect mass disconnect events. */
  private recentCliDisconnects: number[] = [];
  /** Machine-global browser transport state shared with VS Code/browser routing. */
  private browserTransportState: BrowserTransportStateLike = {
    vscodeSelectionState: null,
    vscodeWindows: new Map<string, VsCodeWindowState>(),
    vscodeOpenFileQueues: new Map<string, VsCodeOpenFileCommand[]>(),
    pendingVsCodeOpenResults: new Map<
      string,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >(),
  };

  private static readonly VSCODE_WINDOW_STALE_MS = 30_000;
  private static readonly VSCODE_OPEN_FILE_TIMEOUT_MS = 8_000;
  sessionNameGetter: ((sessionId: string) => string) | null = null;
  onGitInfoReady: ((sessionId: string, cwd: string, branch: string) => void) | null = null;

  // ── Cross-session branch invalidation ──────────────────────────────────
  // Reverse index: branch name → set of session IDs that reference it
  // (as git_branch, diff_base_branch, or git_default_branch).
  // Only active (non-archived) sessions are indexed.
  private branchToSessions = new Map<string, Set<string>>();
  // Tracks which branches each session is indexed under, for fast removal.
  private sessionBranches = new Map<string, Set<string>>();
  // Per-session throttle for cross-session invalidation (epoch ms).
  // 30s prevents cascading when an agent pushes multiple commits in rapid
  // succession -- each push would otherwise trigger O(sessions) refreshes.
  private lastCrossSessionRefreshAt = new Map<string, number>();
  // Coalesce worktree snapshot refreshes so heavy-repo sidebar polls cannot
  // stack slow git refresh/diff jobs for the same session.
  private worktreeSnapshotRefreshes = new Map<string, Promise<SessionState | null>>();
  private static readonly CROSS_SESSION_THROTTLE_MS = 30_000;

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

  private static localDateKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** Fill slash_commands/skills/apps from the per-project cache if not yet populated. */
  private prefillSlashCommands(session: Session): void {
    const projectKey = session.state.repo_root || session.state.cwd;
    const cached = projectKey ? this.slashCommandCache.get(projectKey) : undefined;
    if (cached) {
      if (!session.state.slash_commands?.length) session.state.slash_commands = cached.slash_commands;
      if (!session.state.skills?.length) session.state.skills = cached.skills;
      if (!session.state.skill_metadata?.length) session.state.skill_metadata = cached.skill_metadata;
      if (!session.state.apps?.length) session.state.apps = cached.apps;
    }
  }

  /**
   * When the slash command cache is populated for a project, push the commands
   * to all other sessions with the same project key that still have empty
   * slash_commands/skills/apps, so already-connected browsers get them immediately.
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
      if (!session.state.skill_metadata?.length && cached.skill_metadata.length) {
        session.state.skill_metadata = cached.skill_metadata;
        changed = true;
      }
      if (!session.state.apps?.length && cached.apps.length) {
        session.state.apps = cached.apps;
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
            try {
              session.backendSocket.close();
            } catch {
              /* already dead */
            }
          }
        }
      }
    }, 10_000);
  }

  /** Periodically check for sessions stuck in "generating" state with no CLI activity. */
  startStuckSessionWatchdog(): void {
    const timer = setInterval(() => {
      const now = Date.now();
      runStuckSessionWatchdogSweepLifecycle(this.sessions.values(), now, {
        stuckPendingDeliveryMs: STUCK_PENDING_DELIVERY_MS,
        stuckThresholdMs: STUCK_GENERATION_THRESHOLD_MS,
        autoRecoverMs: 300_000,
        autoRecoverOrchestratorMs: STUCK_GENERATION_THRESHOLD_MS,
        requestCodexAutoRecovery: (session, reason) => this.requestCodexAutoRecovery(session as Session, reason),
        broadcastMessage: (session, msg) => this.broadcastToBrowsers(session as Session, msg as BrowserIncomingMessage),
        recordServerEvent: (session, reason, payload) =>
          this.recorder?.recordServerEvent(
            session.id,
            reason,
            payload,
            session.backendType as BackendType,
            session.state.cwd,
          ),
        getLauncherSessionInfo: (sessionId) => this.launcher?.getSession(sessionId),
        forceFlushPendingEvents: (sessionId) => this.herdEventDispatcher?.forceFlushPendingEvents?.(sessionId) ?? 0,
        backendConnected: (session) => backendConnectedController(session as Session),
        markTurnInterrupted: (session, source) => this.markTurnInterrupted(session as Session, source),
        setGenerating: (session, generating, reason) =>
          setGeneratingLifecycle(this.getGenerationLifecycleDeps(), session as Session, generating, reason),
      });
      this.sweepBoardStallWarnings(now);
      this.sweepBoardDispatchableWarnings(now);
    }, 30_000);
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
      this.broadcastToBrowsers(session, msg, { skipBuffer: true });
    }
  }

  private broadcastSessionActivityUpdateGlobally(
    msg: Extract<BrowserIncomingMessage, { type: "session_activity_update" }>,
  ): void {
    for (const session of this.sessions.values()) {
      for (const ws of session.browserSockets) {
        sendToBrowserController(ws as any, msg);
      }
    }
  }

  /** Re-check group-idle state for any leader affected by this session's activity change. */
  private onSessionActivityStateChanged(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.broadcastSessionActivityUpdateGlobally({
        type: "session_activity_update",
        session_id: sessionId,
        session: {
          ...getSessionActivitySnapshotController(session),
          status: deriveSessionStatusController(session, {
            backendConnected: (targetSession) => backendConnectedController(targetSession as Session),
          }) as "compacting" | "reverting" | "idle" | "running" | null,
        },
      });
    }
    this.herdEventDispatcher?.onSessionActivityStateChanged?.(sessionId, reason);
  }

  // ── Takode orchestration event methods ──────────────────────────────────

  /** Emit a takode event, buffering it and notifying matching subscribers. */
  emitTakodeEvent<E extends TakodeEventType>(
    sessionId: string,
    event: E,
    data: TakodeEventDataByType[E],
    actorSessionId?: string,
  ): void {
    if (!this.herdEventDispatcher) return;
    if (actorSessionId === undefined) {
      this.herdEventDispatcher.emitTakodeEvent(sessionId, event, data);
      return;
    }
    this.herdEventDispatcher.emitTakodeEvent(sessionId, event, data, actorSessionId);
  }

  emitWorkerStreamCheckpoint(sessionId: string): WorkerStreamCheckpointResult {
    const session = this.sessions.get(sessionId);
    if (!session?.isGenerating) {
      return { ok: true, streamed: false, reason: "not_generating" };
    }
    if (!this.herdEventDispatcher) {
      return { ok: true, streamed: false, reason: "dispatcher_unavailable" };
    }

    const summary = this.buildTurnToolSummary(session);
    const range = summary.msgRange;
    if (!range) {
      return { ok: true, streamed: false, reason: "no_activity" };
    }

    const lastCheckpointTo = this.workerStreamCheckpointMsgTo.get(sessionId) ?? -1;
    if (range.to <= lastCheckpointTo) {
      return { ok: true, streamed: false, reason: "no_activity", msgRange: range };
    }

    this.workerStreamCheckpointMsgTo.set(sessionId, range.to);
    const elapsed = session.generationStartedAt ? Date.now() - session.generationStartedAt : 0;
    const turnSource = getCurrentTurnTriggerSourceController(session, {
      isSystemSourceTag: (agentSource) => this.isSystemSourceTag(agentSource),
    });
    const activeTurnRoute = session.activeTurnRoute;

    this.emitTakodeEvent(sessionId, "worker_stream", {
      reason: "checkpoint",
      duration_ms: elapsed,
      ...summary,
      turn_source: turnSource,
      ...(activeTurnRoute?.threadKey ? { threadKey: activeTurnRoute.threadKey } : {}),
      ...(activeTurnRoute?.questId ? { questId: activeTurnRoute.questId } : {}),
    });

    return { ok: true, streamed: true, reason: "streamed", msgRange: range };
  }

  /** Subscribe to takode events for a set of sessions. Returns an unsubscribe function.
   *  If sinceEventId is provided, immediately replays buffered events with id > sinceEventId. */
  subscribeTakodeEvents(
    sessions: Set<string>,
    callback: (event: TakodeEvent) => void,
    sinceEventId?: number,
  ): () => void {
    return this.herdEventDispatcher?.subscribeTakodeEvents(sessions, callback, sinceEventId) ?? (() => {});
  }

  getBoardStallSignature(sessionId: string, questId: string): string | null {
    return getBoardStallSignatureForSessionController(this.sessions, sessionId, questId, this.getBoardWatchdogDeps());
  }

  getBoardDispatchableSignature(sessionId: string, questId: string): string | null {
    return getBoardDispatchableSignatureForSessionController(
      this.sessions,
      sessionId,
      questId,
      this.getBoardWatchdogDeps(),
    );
  }

  /**
   * Kill a session by terminating its backend (subprocess or SDK adapter).
   * Called by the idle manager. Returns true if the session was successfully
   * terminated. For SDK sessions, this disconnects the in-process adapter
   * directly (launcher.kill only handles subprocesses).
   */
  async killSession(sessionId: string): Promise<boolean> {
    return killSessionController(this.sessions, sessionId, {
      killLauncher: async (targetSessionId: string) =>
        this.launcher ? await this.launcher.kill(targetSessionId) : false,
    });
  }

  /** Restore sessions from disk (call once at startup). */
  async restoreFromDisk(): Promise<number> {
    if (!this.store) return 0;
    return restorePersistedSessionsController(this.sessions, await this.store.loadAll(), {
      recoverToolStartTimesFromHistory: (session) => this.recoverToolStartTimesFromHistory(session as Session),
      finalizeRecoveredDisconnectedTerminalTools: (session, reason) =>
        this.finalizeRecoveredDisconnectedTerminalTools(session as Session, reason),
      scheduleCodexToolResultWatchdogs: (session, reason) =>
        this.scheduleCodexToolResultWatchdogs(session as Session, reason),
      reconcileRestoredBoardState: (session) => this.reconcileRestoredBoardState(session as Session),
    });
  }

  private async reconcileRestoredBoardState(session: Session): Promise<void> {
    if (!this.resolveQuestStatus || session.board.size === 0) return;
    for (const [questId] of [...session.board]) {
      try {
        const status = await this.resolveQuestStatus(questId);
        // q-112: the board lifecycle is decoupled from most quest statuses.
        // Restore should only drop rows that are definitely terminal/missing,
        // not queued ideas or verification-stage items that are still active on
        // the leader's board.
        if (status === "done" || status === null) {
          session.board.delete(questId);
          session.boardStallStates.delete(questId);
        }
      } catch {
        // If quest status cannot be resolved, preserve the row and let normal runtime paths decide.
      }
    }
  }

  /** Persist a session to disk (debounced). */
  private persistSession(session: Session): void {
    if (!this.store) return;
    clampFrozenCountController(session);
    this.store.save(buildPersistedSessionPayloadController(session));
  }

  /** Persist a session to disk immediately (bypass debounce). */
  persistSessionSync(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !this.store) return;
    clampFrozenCountController(session);
    this.store.saveSync(buildPersistedSessionPayloadController(session));
  }

  persistSessionById(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.persistSession(session);
  }

  private getSessionGitStateDeps() {
    const broadcastSessionUpdate = (targetSession: unknown, update: Record<string, unknown>) => {
      const session = targetSession as Session;
      this.broadcastToBrowsers(session, {
        type: "session_update",
        session: update,
      });
    };
    return {
      gitSessionKeys: WsBridge.GIT_SESSION_KEYS,
      sessions: this.sessions,
      inFlightRefreshes: this.worktreeSnapshotRefreshes,
      broadcastSessionUpdate,
      broadcastGitUpdate: (targetSession: unknown) => {
        const session = targetSession as Session;
        broadcastSessionUpdate(session, {
          git_branch: session.state.git_branch,
          git_default_branch: session.state.git_default_branch,
          diff_base_branch: session.state.diff_base_branch,
          is_worktree: session.state.is_worktree,
          is_containerized: session.state.is_containerized,
          repo_root: session.state.repo_root,
          git_ahead: session.state.git_ahead,
          git_behind: session.state.git_behind,
        });
      },
      broadcastDiffTotals: (targetSession: unknown) => {
        const session = targetSession as Session;
        broadcastSessionUpdate(session, {
          total_lines_added: session.state.total_lines_added,
          total_lines_removed: session.state.total_lines_removed,
        });
      },
      persistSession: (targetSession: unknown) => this.persistSession(targetSession as Session),
      notifyPoller: (targetSession: unknown) => {
        const session = targetSession as Session;
        if (this.onGitInfoReady && session.state.git_branch && session.state.cwd) {
          this.onGitInfoReady(session.id, session.state.cwd, session.state.git_branch);
        }
      },
      updateBranchIndex: (targetSession: unknown) =>
        updateBranchIndexState(targetSession as Session, {
          isArchived: this.launcher?.getSession((targetSession as Session).id)?.archived === true,
          branchToSessions: this.branchToSessions,
          sessionBranches: this.sessionBranches,
        }),
      invalidateSessionsSharingBranch: (targetSession: unknown, previousHeadSha: string) => {
        const session = targetSession as Session;
        const { changedBranch, invalidatedCount } = invalidateSessionsSharingBranchIndex(session, {
          sessions: this.sessions,
          branchToSessions: this.branchToSessions,
          sessionBranches: this.sessionBranches,
          lastCrossSessionRefreshAt: this.lastCrossSessionRefreshAt,
          throttleMs: WsBridge.CROSS_SESSION_THROTTLE_MS,
          isArchived: (sessionId) => this.launcher?.getSession(sessionId)?.archived === true,
          refreshSession: (candidateSession) =>
            this.refreshGitInfoThenRecomputeDiff(candidateSession as Session, { broadcastUpdate: true }),
        });
        if (changedBranch && invalidatedCount > 0) {
          console.log(
            `[ws-bridge] Cross-session invalidation: ${session.id} (branch ${changedBranch}) triggered refresh of ${invalidatedCount} session(s)`,
          );
        }
      },
      refreshGitInfo: (
        targetSession: unknown,
        options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean },
      ) => this.refreshGitInfo(targetSession as Session, options),
    };
  }

  private async refreshGitInfo(
    session: Session,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean } = {},
  ): Promise<void> {
    await refreshGitInfoController(session, this.getSessionGitStateDeps(), options);
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
    return refreshWorktreeGitStateForSnapshotController(sessionId, this.getSessionGitStateDeps(), options);
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

  /**
   * Recompute diff stats only if agent activity has occurred since the last computation.
   * Broadcasts updated stats to all browsers if recomputed.
   */
  recomputeDiffIfDirty(session: Session): void {
    recomputeDiffIfDirtyController(session, this.getSessionGitStateDeps());
  }

  private getSessionCleanupDeps() {
    return {
      clearOptimisticRunningTimer: (session: Session, _reason: string) => clearOptimisticRunningTimerLifecycle(session),
      clearAllCodexToolResultWatchdogs: (session: Session, _reason: string) =>
        clearAllCodexToolResultWatchdogsController(session),
      cleanupBranchState: (sessionId: string) =>
        cleanupBranchStateIndex(sessionId, {
          branchToSessions: this.branchToSessions,
          sessionBranches: this.sessionBranches,
          lastCrossSessionRefreshAt: this.lastCrossSessionRefreshAt,
        }),
      removeStoredSession: (sessionId: string) => this.store?.remove(sessionId),
      removeImages: (sessionId: string) => this.imageStore?.removeSession(sessionId),
    };
  }

  /**
   * Diff stats are server-computed from git and must not be overwritten by
   * Codex adapter session updates.
   */
  private sanitizeCodexSessionPatch(patch: Partial<SessionState>): Partial<SessionState> {
    const { total_lines_added: _ignoredAdded, total_lines_removed: _ignoredRemoved, ...rest } = patch;
    return rest;
  }

  private getSessionNotificationDeps() {
    return {
      isHerdedWorkerSession: (targetSession: unknown) => this.isHerdedWorkerSession(targetSession as Session),
      getLauncherSessionInfo: (sessionId: string) => this.launcher?.getSession(sessionId),
      broadcastToBrowsers: (targetSession: unknown, msg: BrowserIncomingMessage) =>
        this.broadcastToBrowsers(targetSession as Session, msg),
      persistSession: (targetSession: unknown) => this.persistSession(targetSession as Session),
      emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
        this.emitTakodeEvent(sessionId, type as TakodeEventType, data as any),
      scheduleNotification: (
        sessionId: string,
        category: "question" | "completed",
        detail: string,
        options?: { skipReadCheck?: boolean },
      ) => this.pushoverNotifier?.scheduleNotification(sessionId, category, detail, undefined, options),
    };
  }

  private getSessionRegistryDeps() {
    const notificationDeps = this.getSessionNotificationDeps();
    return {
      makeDefaultState: (sessionId: string, backendType: string) =>
        makeDefaultState(sessionId, backendType as BackendType),
      pruneToolResultsForCurrentHistory: (targetSession: unknown) =>
        this.pruneToolResultsForCurrentHistory(targetSession as Session),
      broadcastToSession: (sessionId: string, msg: BrowserIncomingMessage) => this.broadcastToSession(sessionId, msg),
      broadcastToBrowsers: (targetSession: unknown, msg: BrowserIncomingMessage) =>
        this.broadcastToBrowsers(targetSession as Session, msg),
      recomputeAndBroadcastHistoryBytes: (targetSession: unknown) =>
        this.recomputeAndBroadcastHistoryBytes(targetSession as Session),
      broadcastSessionUpdate: (targetSession: unknown, update: Record<string, unknown>) =>
        this.broadcastToBrowsers(targetSession as Session, { type: "session_update", session: update }),
      broadcastTaskHistory: (targetSession: unknown) =>
        this.broadcastToBrowsers(targetSession as Session, {
          type: "session_task_history",
          tasks: (targetSession as Session).taskHistory,
        }),
      persistSession: (targetSession: unknown) => this.persistSession(targetSession as Session),
      persistSessionSync: (sessionId: string) => this.persistSessionSync(sessionId),
      requestCliRelaunch: this.onCLIRelaunchNeeded
        ? (sessionId: string) => this.onCLIRelaunchNeeded?.(sessionId)
        : undefined,
      emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
        this.emitTakodeEvent(sessionId, type as TakodeEventType, data as any),
      attached: (targetSession: unknown) => backendAttachedController(targetSession as Session),
      getLauncherSessionInfo: (sessionId: string) => this.launcher?.getSession(sessionId),
      recoveryTimeoutMs: CODEX_RECOVERY_TIMEOUT_MS,
      getHerdedSessionIds: (leaderId: string) =>
        this.launcher?.getHerdedSessions?.(leaderId)?.map((worker) => worker.sessionId) ?? [],
      getSessionNum: (sessionId: string) => this.launcher?.getSessionNum?.(sessionId),
      getSessionName: (sessionId: string) => this.sessionNameGetter?.(sessionId),
      deriveSessionStatus: (targetSession: unknown) =>
        deriveSessionStatusController(targetSession as Session, {
          backendConnected: (concreteSession: unknown) => backendConnectedController(concreteSession as Session),
        }),
      clearAttentionAndMarkRead: (targetSession: unknown) =>
        clearAttentionAndMarkReadController(targetSession as Session, notificationDeps),
      setAttentionReview: (targetSession: unknown) =>
        setAttentionController(targetSession as Session, "review", notificationDeps),
      broadcastLeaderGroupIdle: (targetSession: unknown, payload: Record<string, unknown>) =>
        this.broadcastToBrowsers(targetSession as Session, payload as BrowserIncomingMessage),
      recordServerEvent: (
        sessionId: string,
        eventReason: string,
        payload: Record<string, unknown>,
        backendType: string,
        cwd: string,
      ) => this.recorder?.recordServerEvent(sessionId, eventReason, payload, backendType as BackendType, cwd),
      delayMs: WsBridge.LEADER_GROUP_IDLE_NOTIFY_DELAY_MS,
      isHerdedWorkerSession: notificationDeps.isHerdedWorkerSession,
      scheduleNotification: notificationDeps.scheduleNotification,
      scheduleCompletedNotification: (sessionId: string, detail: string) =>
        this.pushoverNotifier?.scheduleNotification(sessionId, "completed", detail),
      onSessionNamedByQuest: this.onSessionNamedByQuest
        ? (sessionId: string, title: string) => this.onSessionNamedByQuest?.(sessionId, title)
        : undefined,
      finalizeCodexRecoveringTurn: (targetSession: unknown, reason: "recovery_timeout" | "recovery_failed") =>
        this.finalizeCodexRecoveringTurn(targetSession as Session, reason),
    };
  }

  // ── Session management ──────────────────────────────────────────────────

  getOrCreateSession(sessionId: string, backendType?: BackendType): Session {
    return getOrCreateSessionController(this.sessions, sessionId, backendType, this.getSessionRegistryDeps());
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  async interruptSession(
    sessionId: string,
    source: InterruptSource = "user",
    options?: { interruptOrigin?: "restart_prep"; restartPrepOperationId?: string },
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (options?.interruptOrigin === "restart_prep" && session.isGenerating) {
      session.restartPrepInterruptOrigin = "restart_prep";
      session.restartPrepInterruptOperationId = options.restartPrepOperationId ?? null;
    }
    await routeBrowserMessageController(
      session,
      { type: "interrupt", interruptSource: source },
      undefined,
      this.getBrowserRoutingDeps(),
    );
    return true;
  }

  prepareSessionForRevert(
    sessionId: string,
    truncateIdx: number,
    options?: { clearCodexState?: boolean },
  ): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return prepareSessionForRevertController(session, truncateIdx, this.getSessionRegistryDeps(), options);
  }

  private finalizeCodexRollback(session: Session): void {
    const plan = session.pendingCodexRollback;
    if (!plan) return;
    const revertedSession = this.prepareSessionForRevert(session.id, plan.truncateIdx, {
      clearCodexState: plan.clearCodexState,
    });
    finalizeCodexRollbackController(session, this.getSessionRegistryDeps(), revertedSession);
  }

  beginCodexRollback(
    sessionId: string,
    plan: { numTurns: number; truncateIdx: number; clearCodexState: boolean },
  ): { promise: Promise<void>; requiresRelaunch: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        promise: Promise.reject(new Error("Session not found")),
        requiresRelaunch: false,
      };
    }
    return beginCodexRollbackController(session, plan, this.getSessionRegistryDeps(), () => {
      this.finalizeCodexRollback(session);
    });
  }

  private hasAssistantReplay(session: Session, messageId: string): boolean {
    return hasAssistantReplayController(session, messageId);
  }

  private hasUserPromptReplay(session: Session, cliUuid: string): boolean {
    return hasUserPromptReplayController(session, cliUuid);
  }

  private hasResultReplay(session: Session, resultUuid: string): boolean {
    return hasResultReplayController(session, resultUuid);
  }

  private hasToolResultPreviewReplay(session: Session, toolUseId: string): boolean {
    return hasToolResultPreviewReplayController(session, toolUseId);
  }

  private hasTaskNotificationReplay(session: Session, taskId: string, toolUseId: string): boolean {
    return hasTaskNotificationReplayController(session, taskId, toolUseId);
  }

  private hasCompactBoundaryReplay(
    session: Session,
    cliUuid: string | undefined,
    meta: CLISystemCompactBoundaryMessage["compact_metadata"],
  ): boolean {
    return hasCompactBoundaryReplayController(session, cliUuid, meta);
  }

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

  private isHerdedWorkerSession(session: Session): boolean {
    return !!this.launcher?.getSession(session.id)?.herdedBy;
  }

  private formatVsCodeSelectionPrompt(selection: import("./session-types.js").VsCodeSelectionMetadata): string {
    return formatVsCodeSelectionPrompt(selection);
  }

  private getCompactionRecoveryRuntimeDeps() {
    return {
      isLeaderSession: (session: unknown) =>
        this.launcher?.getSession((session as Session).id)?.isOrchestrator === true,
      isSystemSourceTag: (agentSource: { sessionId: string; sessionLabel?: string } | undefined) =>
        this.isSystemSourceTag(agentSource),
      injectUserMessage: (
        sessionId: string,
        content: string,
        agentSource?: { sessionId: string; sessionLabel?: string },
      ) => this.injectUserMessage(sessionId, content, agentSource),
    };
  }

  private getCommonClaudeRuntimeDeps() {
    const generationDeps = this.getGenerationLifecycleDeps();
    return {
      getLauncherSessionInfo: (sessionId: string) => this.launcher?.getSession(sessionId),
      refreshGitInfoThenRecomputeDiff: (
        targetSession: unknown,
        options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
      ) => this.refreshGitInfoThenRecomputeDiff(targetSession as Session, options),
      persistSession: (targetSession: unknown) => this.persistSession(targetSession as Session),
      markTurnInterrupted: (targetSession: unknown, source: InterruptSource) =>
        this.markTurnInterrupted(targetSession as Session, source),
      setGenerating: (targetSession: unknown, generating: boolean, reason: string) =>
        setGeneratingLifecycle(generationDeps, targetSession as Session, generating, reason),
      onSessionActivityStateChanged: (sessionId: string, reason: string) =>
        this.onSessionActivityStateChanged(sessionId, reason),
    };
  }

  private getCommonCodexRuntimeDeps() {
    const generationDeps = this.getGenerationLifecycleDeps();
    const sessionRegistryDeps = this.getSessionRegistryDeps();
    return {
      formatVsCodeSelectionPrompt: (selection: import("./session-types.js").VsCodeSelectionMetadata) =>
        this.formatVsCodeSelectionPrompt(selection),
      broadcastToBrowsers: (targetSession: unknown, browserMsg: BrowserIncomingMessage) =>
        this.broadcastToBrowsers(targetSession as Session, browserMsg),
      persistSession: (targetSession: unknown) => this.persistSession(targetSession as Session),
      touchUserMessage: (sessionId: string, timestamp?: number) =>
        this.launcher?.touchUserMessage(sessionId, timestamp),
      onUserMessage: this.onUserMessage
        ? (sessionId: string, history: Session["messageHistory"], cwd: string, wasGenerating: boolean) =>
            this.onUserMessage?.(sessionId, history, cwd, wasGenerating)
        : undefined,
      refreshGitInfoThenRecomputeDiff: (
        targetSession: unknown,
        options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
      ) => this.refreshGitInfoThenRecomputeDiff(targetSession as Session, options),
      emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
        this.emitTakodeEvent(sessionId, type as TakodeEventType, data as any),
      requestCodexAutoRecovery: (targetSession: unknown, reason: string) =>
        this.requestCodexAutoRecovery(targetSession as Session, reason),
      getLauncherSessionInfo: (sessionId: string) => this.launcher?.getSession(sessionId),
      setAttentionError: (targetSession: unknown) =>
        setAttentionController(targetSession as Session, "error", sessionRegistryDeps),
      setGenerating: (targetSession: unknown, generating: boolean, reason: string) =>
        setGeneratingLifecycle(generationDeps, targetSession as Session, generating, reason),
      markTurnInterrupted: (targetSession: unknown, source: InterruptSource) =>
        this.markTurnInterrupted(targetSession as Session, source),
    };
  }

  private getClaudeMessageHandlers() {
    const runtime = this.getCommonClaudeRuntimeDeps();
    return createClaudeMessageHandlersController({
      onCLISessionId: this.onCLISessionId ?? undefined,
      cacheSlashCommands: (projectKey: string, data: { slash_commands: string[]; skills: string[] }) => {
        this.slashCommandCache.set(projectKey, {
          ...data,
          skill_metadata: [],
          apps: [],
        });
      },
      backfillSlashCommands: (projectKey: string, sourceSessionId: string) =>
        this.backfillSlashCommands(projectKey, sourceSessionId),
      ...runtime,
      broadcastToBrowsers: (
        targetSession: unknown,
        browserMsg: BrowserIncomingMessage,
        options?: { skipBuffer?: boolean },
      ) => this.broadcastToBrowsers(targetSession as Session, browserMsg, options),
      hasPendingForceCompact: (targetSession: unknown) => this.hasPendingForceCompact(targetSession as Session),
      flushQueuedCliMessages: (targetSession: unknown, reason: string) =>
        flushQueuedCliMessagesController(targetSession as Session, reason, this.getClaudeCliTransportDeps()),
      onOrchestratorTurnEnd: (sessionId: string) => this.herdEventDispatcher?.onOrchestratorTurnEnd(sessionId),
      isCliUserMessagePayload: (ndjson: string) => this.isCliUserMessagePayload(ndjson),
      emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
        this.emitTakodeEvent(sessionId, type as TakodeEventType, data as TakodeEventDataByType[TakodeEventType]),
      injectCompactionRecovery: (targetSession: unknown) =>
        injectCompactionRecoveryController(targetSession as Session, this.getCompactionRecoveryRuntimeDeps()),
      hasCompactBoundaryReplay: (targetSession: unknown, cliUuid: string | undefined, meta: unknown) =>
        this.hasCompactBoundaryReplay(
          targetSession as Session,
          cliUuid,
          meta as CLISystemCompactBoundaryMessage["compact_metadata"],
        ),
      freezeHistoryThroughCurrentTail: (targetSession: unknown) =>
        freezeHistoryThroughCurrentTailController(targetSession as Session),
      hasTaskNotificationReplay: (targetSession: unknown, taskId: string, toolUseId: string) =>
        this.hasTaskNotificationReplay(targetSession as Session, taskId, toolUseId),
      stuckGenerationThresholdMs: STUCK_GENERATION_THRESHOLD_MS,
      hasAssistantReplay: (targetSession: unknown, messageId: string) =>
        this.hasAssistantReplay(targetSession as Session, messageId),
      onToolUseObserved: (targetSession: unknown, toolUse: Extract<ContentBlock, { type: "tool_use" }>) =>
        this.handleObservedLongSleepBashToolUse(targetSession as Session, toolUse),
      hasResultReplay: (targetSession: unknown, resultUuid: string) =>
        this.hasResultReplay(targetSession as Session, resultUuid),
      reconcileReplayState: (targetSession: unknown) =>
        reconcileTerminalResultStateLifecycle(
          this.getGenerationLifecycleDeps(),
          targetSession as Session,
          "result_replay",
        ),
      drainInlineQueuedClaudeTurns: (targetSession: unknown, reason: string) =>
        drainInlineQueuedClaudeTurnsController(targetSession as Session, reason, {
          getQueuedTurnLifecycleEntries: (session) => getQueuedTurnLifecycleEntriesLifecycle(session as Session),
          replaceQueuedTurnLifecycleEntries: (session, entries) =>
            replaceQueuedTurnLifecycleEntriesLifecycle(session as Session, entries as any[]),
          isCliUserMessagePayload: (ndjson: string) => this.isCliUserMessagePayload(ndjson),
        }),
      getCurrentTurnTriggerSource: (targetSession: unknown) =>
        getCurrentTurnTriggerSourceController(targetSession as Session, {
          isSystemSourceTag: (agentSource) => this.isSystemSourceTag(agentSource),
        }),
      reconcileTerminalResultState: (targetSession: unknown) => {
        reconcileTerminalResultStateLifecycle(this.getGenerationLifecycleDeps(), targetSession as Session, "result");
      },
      finalizeOrphanedTerminalToolsOnResult: (targetSession: unknown, resultMsg: CLIResultMessage) =>
        this.finalizeOrphanedTerminalToolsOnResult(targetSession as Session, resultMsg),
      cancelPermissionNotification: (sessionId: string, requestId: string) =>
        this.pushoverNotifier?.cancelPermission(sessionId, requestId),
      onResultAttentionAndNotifications: (
        targetSession: unknown,
        resultMsg: CLIResultMessage,
        turnTriggerSource: unknown,
      ) =>
        handleResultAttentionAndNotificationsController(
          targetSession as Session,
          resultMsg,
          turnTriggerSource as "user" | "leader" | "system" | "unknown",
          {
            isHerdedWorkerSession: (concreteSession) => this.isHerdedWorkerSession(concreteSession as Session),
            getLauncherSessionInfo: (sessionId: string) => this.launcher?.getSession(sessionId),
            broadcastToBrowsers: (concreteSession, browserMsg) =>
              this.broadcastToBrowsers(concreteSession as Session, browserMsg),
            persistSession: (concreteSession) => this.persistSession(concreteSession as Session),
            emitTakodeEvent: (sessionId, type, data) =>
              this.emitTakodeEvent(sessionId, type as TakodeEventType, data as TakodeEventDataByType[TakodeEventType]),
            scheduleErrorNotification: this.pushoverNotifier
              ? (sessionId, detail) => this.pushoverNotifier!.scheduleNotification(sessionId, "error", detail)
              : undefined,
            scheduleResultCompletedNotification: this.pushoverNotifier
              ? (sessionId) => this.pushoverNotifier!.scheduleNotification(sessionId, "completed")
              : undefined,
          },
        ),
      onTurnCompleted: (targetSession: unknown) => {
        const concreteSession = targetSession as Session;
        this.onTurnCompleted?.(concreteSession.id, [...concreteSession.messageHistory], concreteSession.state.cwd);
      },
      injectUserMessage: (
        sessionId: string,
        content: string,
        agentSource: { sessionId: string; sessionLabel?: string },
        takodeHerdBatch: undefined,
        threadRoute: { threadKey: string; questId?: string; threadRefs?: ThreadRef[] },
      ) => this.injectUserMessage(sessionId, content, agentSource, takodeHerdBatch, threadRoute),
      hasUserPromptReplay: (targetSession: unknown, cliUuid: string) =>
        this.hasUserPromptReplay(targetSession as Session, cliUuid),
      hasToolResultPreviewReplay: (targetSession: unknown, toolUseId: string) =>
        this.hasToolResultPreviewReplay(targetSession as Session, toolUseId),
      nextUserMessageId: (timestamp: number) => `cli-user-${timestamp}-${this.userMsgCounter++}`,
      clearCodexToolResultWatchdog: (targetSession: unknown, toolUseId: string) =>
        clearCodexToolResultWatchdogController(targetSession as Session, toolUseId),
      buildToolResultPreviews: (
        targetSession: unknown,
        toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
      ) => this.buildToolResultPreviews(targetSession as Session, toolResults),
      collectCompletedToolStartTimes: (
        targetSession: unknown,
        toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
      ) => this.collectCompletedToolStartTimes(targetSession as Session, toolResults),
      finalizeSupersededCodexTerminalTools: (targetSession: unknown, completedToolStartTimes: number[]) =>
        finalizeSupersededCodexTerminalToolsController(
          targetSession as Session,
          completedToolStartTimes,
          this.getToolResultRecoveryDeps(),
        ),
      broadcastCompactSummary: (targetSession: unknown, summary: string) =>
        this.broadcastToBrowsers(targetSession as Session, { type: "compact_summary", summary }),
      updateLatestCompactMarkerSummary: (targetSession: unknown, summary: string) => {
        const marker = (targetSession as Session).messageHistory.findLast((entry) => entry.type === "compact_marker");
        if (marker && marker.type === "compact_marker") {
          (marker as { summary?: string }).summary = summary;
        }
      },
    });
  }

  // ─── Work Board ──────────────────────────────────────────────────────────

  /** Remove a quest from ALL session boards (e.g. on quest deletion or cancellation).
   *  True deletion -- removes from both active board and completed history. */
  removeBoardRowFromAll(questId: string): void {
    removeBoardRowFromAllSessionsController(this.sessions, questId, {
      broadcastBoard: (targetSession, board, completedBoard) =>
        this.broadcastToBrowsers(targetSession as Session, {
          type: "board_updated",
          board,
          completedBoard,
          rowSessionStatuses: this.getBoardRowSessionStatuses((targetSession as Session).id, board, completedBoard),
        }),
      persistSession: (targetSession) => this.persistSession(targetSession as Session),
      markNotificationDone: (sessionId, notifId, done) =>
        markNotificationDoneBySessionIdController(this.sessions, sessionId, notifId, done, {
          broadcastToBrowsers: (targetSession, msg) => this.broadcastToBrowsers(targetSession as Session, msg),
          broadcastBoard: (targetSession, board, completedBoard) =>
            this.broadcastToBrowsers(targetSession as Session, {
              type: "board_updated",
              board,
              completedBoard,
              rowSessionStatuses: this.getBoardRowSessionStatuses((targetSession as Session).id, board, completedBoard),
            }),
          persistSession: (targetSession) => this.persistSession(targetSession as Session),
        }),
    });
  }

  private sweepBoardStallWarnings(now: number): void {
    sweepBoardStallWarningsController(this.sessions.values(), now, this.getBoardWatchdogDeps());
  }

  private sweepBoardDispatchableWarnings(now: number): void {
    sweepBoardDispatchableWarningsController(this.sessions.values(), now, this.getBoardWatchdogDeps());
  }

  /** Downgrade "action" attention to null when all pending permissions are resolved. */
  private clearActionAttentionIfNoPermissions(session: Session): void {
    clearActionAttentionIfNoPermissionsController(session, this.getSessionNotificationDeps());
  }

  private injectLongSleepReminder(session: Session): void {
    this.injectUserMessage(session.id, LONG_SLEEP_REMINDER_TEXT, {
      sessionId: "system:long-sleep-guard",
      sessionLabel: "System",
    });
  }

  private handleObservedLongSleepBashToolUse(
    session: Session,
    toolUse: Extract<ContentBlock, { type: "tool_use" }>,
  ): void {
    if (session.backendType !== "claude" || toolUse.name !== "Bash") return;
    const command = typeof toolUse.input?.command === "string" ? toolUse.input.command : "";
    if (!detectLongSleepBashCommand(command)) return;

    const denialId = `sleep-guard-${toolUse.id || randomUUID()}`;
    const alreadyDenied = session.messageHistory.some(
      (entry) => entry.type === "permission_denied" && (entry as { id?: string }).id === denialId,
    );
    if (alreadyDenied) return;

    this.onSessionActivityStateChanged(session.id, "long_sleep_tool_use_denied");
    const deniedMsg: BrowserIncomingMessage = {
      type: "permission_denied",
      id: denialId,
      tool_name: "Bash",
      tool_use_id: toolUse.id || "",
      summary: getDenialSummary("Bash", { command }),
      timestamp: Date.now(),
    };
    session.messageHistory.push(deniedMsg);
    this.broadcastToBrowsers(session, deniedMsg);
    this.emitTakodeEvent(session.id, "permission_resolved", { tool_name: "Bash", outcome: "denied" });
    handleInterruptController(session, "system", this.getBrowserRoutingDeps());
    this.injectLongSleepReminder(session);
    this.persistSession(session);
  }

  private syncBackendTypeFromLauncher(session: Session, reason: string): void {
    const launcherBackendType = this.launcher?.getSession(session.id)?.backendType;
    if (!launcherBackendType || launcherBackendType === session.backendType) return;
    if (backendAttachedController(session)) return;

    console.log(
      `[ws-bridge] Syncing session ${sessionTag(session.id)} backend ${session.backendType} -> ${launcherBackendType} (${reason})`,
    );
    session.backendType = launcherBackendType;
    session.state.backend_type = launcherBackendType;
    this.persistSession(session);
  }

  private setBackendState(
    session: Session,
    backendState: NonNullable<SessionState["backend_state"]>,
    backendError: string | null = null,
  ): void {
    setBackendStateController(session, backendState, backendError, this.getSessionRegistryDeps());
  }

  private clearCodexDisconnectGraceTimer(session: Session, reason: string): void {
    if (!session.codexDisconnectGraceTimer) return;
    clearTimeout(session.codexDisconnectGraceTimer);
    session.codexDisconnectGraceTimer = null;
    console.log(`[ws-bridge] Cleared Codex disconnect grace timer for session ${sessionTag(session.id)} (${reason})`);
  }

  private finalizeCodexRecoveringTurn(session: Session, reason: "recovery_timeout" | "recovery_failed"): void {
    this.clearCodexDisconnectGraceTimer(session, `codex_${reason}`);
    if (session.codexAdapter || !session.isGenerating) return;
    if (!getCodexTurnInRecoveryState(session)) return;
    this.markTurnInterrupted(session, "system");
    setGeneratingLifecycle(this.getGenerationLifecycleDeps(), session, false, "codex_disconnect");
    this.persistSession(session);
    console.log(
      `[ws-bridge] Finalized deferred Codex disconnect interruption for session ${sessionTag(session.id)} ` +
        `after ${reason}`,
    );
  }

  markCodexAutoRecoveryFailed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    markCodexAutoRecoveryFailedController(session, this.getSessionRegistryDeps());
  }

  isBackendConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return backendConnectedController(session);
  }

  getBoardRowSessionStatuses(sessionId: string, board: BoardRow[], completedBoard: BoardRow[]) {
    if (board.length === 0 && completedBoard.length === 0) return {};
    const launcherSessions = this.launcher?.listSessions?.() ?? [];
    return buildBoardRowSessionStatuses(
      [...board, ...completedBoard],
      launcherSessions.map((session) => {
        const bridgeSession = this.sessions.get(session.sessionId);
        const cliConnected = this.isBackendConnected(session.sessionId);
        return {
          sessionId: session.sessionId,
          sessionNum: session.sessionNum,
          reviewerOf: session.reviewerOf,
          archived: session.archived,
          state: cliConnected && bridgeSession?.isGenerating ? "running" : session.state,
          cliConnected,
        };
      }),
    );
  }

  /** Is any transport attached (even if still initializing)? */
  isBackendAttached(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return backendAttachedController(session);
  }

  removeSession(sessionId: string) {
    removeSessionController(this.sessions, sessionId, this.getSessionCleanupDeps());
  }

  /**
   * Close all sockets (CLI + browsers) for a session and remove it.
   */
  closeSession(sessionId: string) {
    closeSessionController(this.sessions, sessionId, this.getSessionCleanupDeps());
  }

  // ── Codex adapter attachment ────────────────────────────────────────────

  /**
   * Attach a CodexAdapter to a session. The adapter handles all message
   * translation between the Codex app-server (stdio JSON-RPC) and the
   * browser WebSocket protocol.
   */
  attachCodexAdapter(sessionId: string, adapter: CodexBridgeAdapter): void {
    const session = this.getOrCreateSession(sessionId, "codex");
    attachCodexAdapterLifecycleController(sessionId, session, adapter, {
      clearCodexDisconnectGraceTimer: (targetSession, reason) =>
        this.clearCodexDisconnectGraceTimer(targetSession as Session, reason),
      setBackendState: (targetSession, state, error) =>
        this.setBackendState(targetSession as Session, state as NonNullable<SessionState["backend_state"]>, error),
      persistSession: (targetSession) => this.persistSession(targetSession as Session),
      getLauncherSessionInfo: (targetSessionId: string) => this.launcher?.getSession(targetSessionId),
      onOrchestratorTurnEnd: (targetSessionId: string) =>
        this.herdEventDispatcher?.onOrchestratorTurnEnd(targetSessionId),
      handleCodexAdapterBrowserMessage: (targetSession, msg) =>
        handleCodexAdapterBrowserMessageController(
          targetSession as Session,
          msg as BrowserIncomingMessage,
          this.getCodexAdapterBrowserMessageDeps(),
        ),
      registerRecoveryLifecycle: (targetSessionId, targetSession, targetAdapter) =>
        registerCodexAdapterRecoveryLifecycle(
          targetSessionId,
          targetSession as Session,
          targetAdapter as CodexBridgeAdapter,
          this.getCodexRecoveryOrchestratorDeps(),
        ),
    });
  }

  private flushQueuedMessagesToCodexAdapter(session: Session, adapter: CodexBridgeAdapter, reason: string): void {
    flushQueuedMessagesToCodexAdapterController(session, adapter, reason, {
      dispatchQueuedCodexTurns: (targetSession, dispatchReason) =>
        dispatchQueuedCodexTurnsController(
          targetSession as Session,
          dispatchReason,
          this.getCodexRecoveryOrchestratorDeps(),
        ),
    });
  }

  /** Attach a Claude SDK adapter (stdio transport) for a session.
   *  Mirrors attachCodexAdapter but simpler — SDK messages already match our protocol. */
  attachClaudeSdkAdapter(sessionId: string, adapter: ClaudeSdkBridgeAdapter): void {
    attachClaudeSdkAdapterLifecycle(sessionId, adapter, this.getClaudeSdkAdapterLifecycleDeps());
  }

  // ── CLI WebSocket handlers ──────────────────────────────────────────────

  handleCLIOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    handleCLIOpenTransportController(session, sessionId, ws, this.getClaudeCliTransportDeps());
  }

  handleCLIMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const perfStart = this.perfTracer ? performance.now() : 0;
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const firstType = processCLIMessageBatchController(session, sessionId, data, this.getClaudeCliTransportDeps());

    if (this.perfTracer) {
      const perfMs = performance.now() - perfStart;
      if (perfMs > this.perfTracer.wsSlowThresholdMs) {
        this.perfTracer.recordSlowWsMessage(sessionId, "cli", firstType, perfMs);
      }
    }
  }

  handleCLIClose(ws: ServerWebSocket<SocketData>, code?: number, reason?: string) {
    const sessionId = (ws.data as CLISocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.backendSocket && session.backendSocket !== ws) return;
    handleCLICloseTransportController(
      session,
      sessionId,
      { ...this.getClaudeCliTransportDeps(), recentCliDisconnects: this.recentCliDisconnects },
      code,
      reason,
    );
  }

  // ── Browser WebSocket handlers ──────────────────────────────────────────

  handleBrowserOpen(ws: ServerWebSocket<SocketData>, sessionId: string) {
    const session = this.getOrCreateSession(sessionId);
    this.syncBackendTypeFromLauncher(session, "browser_open");
    handleBrowserOpenController(session, ws, this.getBrowserTransportDeps());
  }

  async handleBrowserMessage(ws: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const perfStart = this.perfTracer ? performance.now() : 0;
    const data = typeof raw === "string" ? raw : raw.toString("utf-8");
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.syncBackendTypeFromLauncher(session, "browser_message");
    const { messageType, completion } = handleBrowserMessageTransportController(
      session,
      data,
      ws,
      this.getBrowserTransportDeps(),
    );
    if (completion) {
      await completion;
    }

    if (this.perfTracer) {
      const perfMs = performance.now() - perfStart;
      if (perfMs > this.perfTracer.wsSlowThresholdMs) {
        this.perfTracer.recordSlowWsMessage(sessionId, "browser", messageType, perfMs);
      }
    }
  }

  private enqueueCodexQuestLifecycle(session: Session, task: () => Promise<void>): Promise<void> {
    const prior = this.codexQuestLifecycleChains.get(session.id);
    const next = (prior ?? Promise.resolve()).catch(() => {}).then(() => task());
    const tracked = next.finally(() => {
      if (this.codexQuestLifecycleChains.get(session.id) === tracked) {
        this.codexQuestLifecycleChains.delete(session.id);
      }
    });
    this.codexQuestLifecycleChains.set(session.id, tracked);
    return tracked;
  }

  /** Send a user message into a session programmatically (no browser required).
   *  Used by the cron scheduler and takode CLI to send prompts.
   *  Returns delivery status so callers can distinguish live delivery from queuing. */
  injectUserMessage(
    sessionId: string,
    content: string,
    agentSource?: { sessionId: string; sessionLabel?: string },
    takodeHerdBatch?: TakodeHerdBatchSnapshot,
    threadRoute?: { threadKey: string; questId?: string; threadRefs?: ThreadRef[] },
  ): "sent" | "queued" | "dropped" | "no_session" {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.error(`[ws-bridge] Cannot inject message: session ${sessionId} not found`);
      return "no_session";
    }
    let deliveryContent = content;
    let deliveryBatch = takodeHerdBatch;
    if (agentSource?.sessionId === "herd-events" && deliveryBatch) {
      const pruned = this.pruneStaleBoardStalledHerdBatch(session, deliveryBatch);
      if (pruned.changed) {
        if (!pruned.content || !pruned.batch) {
          return "dropped";
        }
        deliveryContent = pruned.content;
        deliveryBatch = pruned.batch;
      }
    }
    this.syncBackendTypeFromLauncher(session, "inject_user_message");
    return injectUserMessageController(
      session,
      deliveryContent,
      agentSource,
      deliveryBatch,
      this.getBrowserTransportDeps(),
      threadRoute,
    );
  }

  private isLiveBoardStalledEvent(session: Session, event: TakodeEvent): boolean {
    if (event.event !== "board_stalled") return true;
    const row = session.board.get(event.data.questId);
    if (!row) return false;
    if (event.data.stage && row.status !== event.data.stage) return false;
    if (!event.data.signature) return true;
    return getBoardStallSignatureController(session, row.questId, this.getBoardWatchdogDeps()) === event.data.signature;
  }

  private pruneStaleBoardStalledHerdBatch(
    session: Session,
    batch: TakodeHerdBatchSnapshot | undefined,
  ): { batch?: TakodeHerdBatchSnapshot; content?: string; changed: boolean } {
    return pruneStaleBoardStalledHerdBatchController(session, batch, this.getBoardWatchdogDeps());
  }

  private pruneStalePendingCodexHerdInputs(session: Session, reason: string): boolean {
    return pruneStalePendingCodexHerdInputsController(session, reason, this.getBoardWatchdogDeps(), {
      broadcastPendingCodexInputs: (targetSession) =>
        this.broadcastToBrowsers(targetSession as Session, {
          type: "codex_pending_inputs",
          inputs: (targetSession as Session).pendingCodexInputs,
        }),
      rebuildQueuedCodexPendingStartBatch: (targetSession) =>
        rebuildQueuedCodexPendingStartBatchController(
          targetSession as Session,
          this.getCodexRecoveryOrchestratorDeps(),
        ),
      persistSession: (targetSession) => this.persistSession(targetSession as Session),
    });
  }

  private isSystemSourceTag(agentSource: { sessionId: string; sessionLabel?: string } | undefined): boolean {
    if (!agentSource) return false;
    return agentSource.sessionId === "system" || agentSource.sessionId.startsWith("system:");
  }

  handleBrowserClose(ws: ServerWebSocket<SocketData>, code?: number, reason?: string) {
    const sessionId = (ws.data as BrowserSocketData).sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    handleBrowserCloseController(
      session,
      ws,
      { backendConnected: (targetSession: unknown) => backendConnectedController(targetSession as Session) } as any,
      code,
      reason,
    );
  }

  private static isSensitiveConfigPath(filePath: string): boolean {
    return isSensitiveConfigPathPolicy(filePath);
  }

  private static isSensitiveBashCommand(command: string): boolean {
    return isSensitiveBashCommandPolicy(command);
  }

  private abortAutoApproval(session: Session, requestId: string): void {
    const abort = session.evaluatingAborts.get(requestId);
    if (abort) {
      abort.abort();
      session.evaluatingAborts.delete(requestId);
    }
  }

  private collectCompletedToolStartTimes(
    session: Session,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ): number[] {
    return collectCompletedToolStartTimesController(session, toolResults);
  }

  private getToolResultRecoveryDeps() {
    return {
      getToolUseBlockInHistory: (targetSession: unknown, toolUseId: string) =>
        findToolUseBlockInHistoryController(targetSession as Session, toolUseId),
      hasToolResultPreviewReplay: (targetSession: unknown, toolUseId: string) =>
        this.hasToolResultPreviewReplay(targetSession as Session, toolUseId),
      clearCodexToolResultWatchdog: (targetSession: unknown, toolUseId: string) =>
        clearCodexToolResultWatchdogController(targetSession as Session, toolUseId),
      broadcastToBrowsers: (targetSession: unknown, browserMsg: BrowserIncomingMessage) =>
        this.broadcastToBrowsers(targetSession as Session, browserMsg),
      persistSession: (targetSession: unknown) => this.persistSession(targetSession as Session),
      getCodexTurnInRecovery: (targetSession: unknown) => getCodexTurnInRecoveryState(targetSession as Session),
      codexToolResultWatchdogMs: CODEX_TOOL_RESULT_WATCHDOG_MS,
      takodeBoardResultPreviewLimit: TAKODE_BOARD_RESULT_PREVIEW_LIMIT,
      defaultToolResultPreviewLimit: TOOL_RESULT_PREVIEW_LIMIT,
    };
  }

  private getToolResultPreviewLimit(session: Session, toolUseId: string): number {
    return getToolResultPreviewLimitController(session, toolUseId, this.getToolResultRecoveryDeps());
  }

  private pruneToolResultsForCurrentHistory(session: Session): void {
    pruneToolResultsForCurrentHistoryController(session);
  }

  private recoverToolStartTimesFromHistory(session: Session): void {
    recoverToolStartTimesFromHistoryController(session);
  }

  private finalizeRecoveredDisconnectedTerminalTools(session: Session, reason: string): void {
    finalizeRecoveredDisconnectedTerminalToolsController(session, reason, this.getToolResultRecoveryDeps());
  }

  private finalizeOrphanedTerminalToolsOnResult(session: Session, msg: CLIResultMessage): void {
    finalizeOrphanedTerminalToolsOnResultController(session, msg, this.getToolResultRecoveryDeps());
  }

  private scheduleCodexToolResultWatchdogs(session: Session, reason: string): void {
    scheduleCodexToolResultWatchdogsController(session, reason, this.getToolResultRecoveryDeps());
  }

  private shouldDeferCodexToolResultWatchdog(session: Session, toolUseId: string): boolean {
    return shouldDeferCodexToolResultWatchdogController(session, toolUseId, this.getToolResultRecoveryDeps());
  }

  private synthesizeCodexToolResultsFromResumedTurn(
    session: Session,
    turn: CodexResumeTurnSnapshot,
    pending: CodexOutboundTurn,
  ): number {
    return synthesizeCodexToolResultsFromResumedTurnController(
      session,
      turn,
      pending,
      this.getToolResultRecoveryDeps(),
    );
  }

  private buildToolResultPreviews(
    session: Session,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ): ToolResultPreview[] {
    return buildToolResultPreviewsController(session, toolResults, this.getToolResultRecoveryDeps());
  }

  getToolResult(
    sessionId: string,
    toolUseId: string,
  ): {
    content: string;
    is_error: boolean;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return getIndexedToolResult(session, toolUseId);
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

  private setCodexImageSendStage(
    session: Session,
    stage: SessionState["codex_image_send_stage"],
    options?: { persist?: boolean },
  ): void {
    if (session.backendType !== "codex") return;
    if ((session.state.codex_image_send_stage ?? null) === (stage ?? null)) return;
    session.state.codex_image_send_stage = stage ?? null;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: { codex_image_send_stage: session.state.codex_image_send_stage ?? null },
    });
    if (options?.persist !== false) {
      this.persistSession(session);
    }
  }

  private requestCodexAutoRecovery(session: Session, reason: string): boolean {
    return requestCodexAutoRecoveryOrchestratorController(session, reason, this.getSessionRegistryDeps());
  }

  private getBrowserTransportDeps() {
    return {
      refreshGitInfoThenRecomputeDiff: (targetSession: unknown, options: { notifyPoller: boolean }) =>
        this.refreshGitInfoThenRecomputeDiff(targetSession as Session, options),
      prefillSlashCommands: (targetSession: unknown) => this.prefillSlashCommands(targetSession as Session),
      getTreeGroupState: async () => {
        const treeGroupStore = await import("./tree-group-store.js");
        const tgs = await treeGroupStore.getState();
        return {
          groups: tgs.groups,
          assignments: tgs.assignments,
          nodeOrder: tgs.nodeOrder,
        };
      },
      getVsCodeSelectionState: () => this.browserTransportState.vscodeSelectionState,
      getLauncherSessionInfo: (sessionId: string) => this.launcher?.getSession(sessionId),
      backendAttached: (targetSession: unknown) => backendAttachedController(targetSession as Session),
      backendConnected: (targetSession: unknown) => backendConnectedController(targetSession as Session),
      requestCodexAutoRecovery: (targetSession: unknown, reason: string) =>
        this.requestCodexAutoRecovery(targetSession as Session, reason),
      requestCodexLeaderRecycle: async (targetSession: unknown, trigger: "manual_compact" | "threshold") =>
        this.recycleCodexLeaderSession((targetSession as Session).id, trigger),
      requestCliRelaunch: this.onCLIRelaunchNeeded
        ? (sessionId: string) => this.onCLIRelaunchNeeded?.(sessionId)
        : undefined,
      getRouteChain: (sessionId: string) => this.sessionRouteChains.get(sessionId),
      setRouteChain: (sessionId: string, task: Promise<void>) => {
        this.sessionRouteChains.set(sessionId, task);
      },
      clearRouteChain: (sessionId: string, task: Promise<void>) => {
        if (this.sessionRouteChains.get(sessionId) === task) {
          this.sessionRouteChains.delete(sessionId);
        }
      },
      routeBrowserMessage: (targetSession: unknown, msg: BrowserOutgoingMessage, ws?: unknown) =>
        routeBrowserMessageController(
          targetSession as Session,
          msg,
          ws as ServerWebSocket<SocketData> | undefined,
          this.getBrowserRoutingDeps(),
        ),
      abortAutoApproval: (targetSession: unknown, requestId: string) =>
        this.abortAutoApproval(targetSession as Session, requestId),
      broadcastToBrowsers: (targetSession: unknown, browserMsg: BrowserIncomingMessage) =>
        this.broadcastToBrowsers(targetSession as Session, browserMsg),
      setAttentionAction: (targetSession: unknown) =>
        setAttentionController(targetSession as Session, "action", this.getSessionNotificationDeps()),
      touchActivity: (sessionId: string) => this.launcher?.touchActivity(sessionId),
      notifyImageSendFailure: (targetSession: unknown, err?: unknown) =>
        this.notifyImageSendFailure(targetSession as Session, err),
      broadcastError: (targetSession: unknown, message: string) =>
        this.broadcastToBrowsers(targetSession as Session, { type: "error", message }),
      queueCodexPendingStartBatch: (targetSession: unknown, reason: string) =>
        queueCodexPendingStartBatchController(
          targetSession as Session,
          reason,
          this.getCodexRecoveryOrchestratorDeps(),
        ),
      deriveBackendState: (targetSession: unknown) => deriveBackendStateController(targetSession as Session),
      getBoard: (sessionId: string) => getBoardForSessionController(this.sessions, sessionId),
      getCompletedBoard: (sessionId: string) => getCompletedBoardForSessionController(this.sessions, sessionId),
      getBoardRowSessionStatuses: (sessionId: string, board: unknown[], completedBoard: unknown[]) =>
        this.getBoardRowSessionStatuses(sessionId, board as BoardRow[], completedBoard as BoardRow[]),
      recoverToolStartTimesFromHistory: (targetSession: unknown) =>
        this.recoverToolStartTimesFromHistory(targetSession as Session),
      finalizeRecoveredDisconnectedTerminalTools: (targetSession: unknown, reason: string) =>
        this.finalizeRecoveredDisconnectedTerminalTools(targetSession as Session, reason),
      scheduleCodexToolResultWatchdogs: (targetSession: unknown, reason: string) =>
        this.scheduleCodexToolResultWatchdogs(targetSession as Session, reason),
      recomputeAndBroadcastHistoryBytes: (targetSession: unknown) =>
        this.recomputeAndBroadcastHistoryBytes(targetSession as Session),
      listTimers: (sessionId: string) => this.timerManager?.listTimers(sessionId) ?? [],
      persistSession: (targetSession: unknown) => this.persistSession(targetSession as Session),
      recordIncomingRaw: (sessionId: string, json: string, backendType: string, cwd: string) =>
        this.recorder?.record(sessionId, "in", json, "browser", backendType as BackendType, cwd),
      recordOutgoingRaw: (sessionId: string, json: string, backendType: string, cwd: string) =>
        this.recorder?.record(sessionId, "out", json, "browser", backendType as BackendType, cwd),
      eventBufferLimit: WsBridge.EVENT_BUFFER_LIMIT,
      browserTransportState: this.browserTransportState,
      idempotentMessageTypes: WsBridge.IDEMPOTENT_BROWSER_MESSAGE_TYPES,
      processedClientMsgIdLimit: WsBridge.PROCESSED_CLIENT_MSG_ID_LIMIT,
      getSessions: () => this.sessions.values(),
      windowStaleMs: WsBridge.VSCODE_WINDOW_STALE_MS,
      openFileTimeoutMs: WsBridge.VSCODE_OPEN_FILE_TIMEOUT_MS,
      lazyLoadFullHistory: async (targetSession: unknown) => {
        const session = targetSession as Session;
        if (!session.searchDataOnly || !this.store) return;
        const persisted = await this.store.load(session.id);
        if (!persisted) return;
        session.messageHistory = persisted.messageHistory;
        session.frozenCount =
          typeof persisted._frozenCount === "number"
            ? Math.max(0, Math.min(persisted._frozenCount, persisted.messageHistory.length))
            : 0;
        session.toolResults = new Map(Array.isArray(persisted.toolResults) ? persisted.toolResults : []);
        // Lazy-backfill search excerpts for pre-existing archived sessions
        if (!persisted._searchExcerpts && persisted.archived) {
          const excerpts = SessionStore.extractSearchExcerpts(persisted.messageHistory);
          session.searchExcerpts = excerpts;
          // Persist excerpts for future startups (fire-and-forget)
          this.store
            .load(session.id)
            .then((fresh) => {
              if (fresh && !fresh._searchExcerpts) {
                fresh._searchExcerpts = excerpts;
                this.store!.saveSync(fresh);
              }
            })
            .catch(() => {});
        }
        session.searchDataOnly = false;
        session.searchExcerpts = [];
      },
    };
  }

  private getClaudeCliTransportDeps() {
    const runtime = this.getCommonClaudeRuntimeDeps();
    const handlers = this.getClaudeMessageHandlers();
    return {
      ...runtime,
      broadcastToBrowsers: (targetSession: unknown, msg: BrowserIncomingMessage) =>
        this.broadcastToBrowsers(targetSession as Session, msg),
      routeCLIMessage: (targetSession: unknown, msg: CLIMessage) => {
        const session = targetSession as Session;
        if (msg.type !== "keep_alive") {
          this.launcher?.touchActivity(session.id);
          session.lastCliMessageAt = Date.now();
          clearOptimisticRunningTimerLifecycle(session);
        } else {
          session.lastCliPingAt = Date.now();
        }
        routeCLIMessageController(session, msg, {
          handleSystemMessage: handlers.handleSystemMessage,
          handleAssistantMessage: handlers.handleAssistantMessage,
          handleResultMessage: handlers.handleResultMessage,
          handleControlRequest: (messageSession, controlMsg) => {
            void handleControlRequestController(messageSession as Session, controlMsg, this.getBrowserRoutingDeps());
          },
          handleUserMessage: handlers.handleClaudeCliUserMessage,
          handleControlResponse: (messageSession, controlResponse) =>
            this.handleControlResponse(messageSession as Session, controlResponse),
          abortAutoApproval: (messageSession, requestId) =>
            this.abortAutoApproval(messageSession as Session, requestId),
          broadcastToBrowsers: (messageSession, browserMsg, options) =>
            this.broadcastToBrowsers(messageSession as Session, browserMsg, options),
          cancelPermissionNotification: (sessionId, requestId) =>
            this.pushoverNotifier?.cancelPermission(sessionId, requestId),
          clearActionAttentionIfNoPermissions: (messageSession) =>
            this.clearActionAttentionIfNoPermissions(messageSession as Session),
          persistSession: (messageSession) => this.persistSession(messageSession as Session),
          toolProgressOutputLimit: 12_000,
        });
      },
      recordIncomingRaw: (sessionId: string, data: string, backendType: string, cwd: string) =>
        this.recorder?.record(sessionId, "in", data, "cli", backendType as BackendType, cwd),
      recordOutgoingRaw: (sessionId: string, data: string, backendType: string, cwd: string) =>
        this.recorder?.record(sessionId, "out", data, "cli", backendType as BackendType, cwd),
      emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
        this.emitTakodeEvent(sessionId, type as TakodeEventType, data as TakodeEventDataByType[TakodeEventType]),
      setAttentionError: (targetSession: unknown) =>
        setAttentionController(targetSession as Session, "error", this.getSessionRegistryDeps()),
      onOrchestratorDisconnect: (sessionId: string) => this.herdEventDispatcher?.onOrchestratorDisconnect(sessionId),
      requestCliRelaunch: this.onCLIRelaunchNeeded
        ? (sessionId: string) => this.onCLIRelaunchNeeded?.(sessionId)
        : undefined,
      markRunningFromUserDispatch: (targetSession: unknown, reason: string, userMessageHistoryIndex?: number) =>
        markRunningFromUserDispatchLifecycle(
          this.getGenerationLifecycleDeps(),
          targetSession as Session,
          reason,
          null,
          userMessageHistoryIndex,
        ),
      isCliUserMessagePayload: (ndjson: string) => this.isCliUserMessagePayload(ndjson),
    };
  }

  private getClaudeSdkAdapterLifecycleDeps() {
    const runtime = this.getCommonClaudeRuntimeDeps();
    const handlers = this.getClaudeMessageHandlers();
    return {
      ...runtime,
      getOrCreateSession: (sessionId: string, backendType: "claude-sdk") =>
        this.getOrCreateSession(sessionId, backendType),
      onOrchestratorTurnEnd: (sessionId: string) => this.herdEventDispatcher?.onOrchestratorTurnEnd(sessionId),
      touchActivity: (sessionId: string) => this.launcher?.touchActivity(sessionId),
      clearOptimisticRunningTimer: (targetSession: unknown, reason: string) =>
        clearOptimisticRunningTimerLifecycle(targetSession as Session),
      hasPendingForceCompact: (targetSession: unknown) => this.hasPendingForceCompact(targetSession as Session),
      broadcastToBrowsers: (targetSession: unknown, msg: Record<string, unknown>) =>
        this.broadcastToBrowsers(targetSession as Session, msg as BrowserIncomingMessage),
      handleSdkBrowserMessage: handlers.handleSdkBrowserMessage,
      handleSdkPermissionRequest: (targetSession: unknown, request: PermissionRequest) =>
        handleSdkPermissionRequestController(targetSession as Session, request, this.getBrowserRoutingDeps()),
      setCliSessionId: (sessionId: string, cliSessionId: string) =>
        this.launcher?.setCLISessionId(sessionId, cliSessionId),
      requestCliRelaunch: this.onCLIRelaunchNeeded
        ? (sessionId: string) => this.onCLIRelaunchNeeded?.(sessionId)
        : undefined,
      isCurrentSession: (sessionId: string, session: unknown) => this.sessions.get(sessionId) === session,
      maxAdapterRelaunchFailures: MAX_ADAPTER_RELAUNCH_FAILURES,
      adapterFailureResetWindowMs: ADAPTER_FAILURE_RESET_WINDOW_MS,
    };
  }

  private getCodexAdapterBrowserMessageDeps() {
    const claudeHandlers = this.getClaudeMessageHandlers();
    const runtime = this.getCommonCodexRuntimeDeps();
    const codexRecoveryDeps = this.getCodexRecoveryOrchestratorDeps();
    return {
      ...runtime,
      getCodexLeaderRecycleThresholdTokens: (modelId?: string) => {
        const settings = getSettings();
        const normalizedModelId = typeof modelId === "string" ? modelId.trim() : "";
        const override = normalizedModelId
          ? settings.codexLeaderRecycleThresholdTokensByModel?.[normalizedModelId]
          : undefined;
        return typeof override === "number" && override >= 1 ? override : settings.codexLeaderRecycleThresholdTokens;
      },
      getLauncherSessionInfo: (sessionId: string) => this.launcher?.getSession(sessionId),
      touchActivity: (sessionId: string) => this.launcher?.touchActivity(sessionId),
      clearOptimisticRunningTimer: (targetSession: unknown, reason: string) =>
        clearOptimisticRunningTimerLifecycle(targetSession as Session),
      setCodexImageSendStage: (targetSession: unknown, stage: string, options?: { persist?: boolean }) =>
        this.setCodexImageSendStage(targetSession as Session, stage as SessionState["codex_image_send_stage"], options),
      sanitizeCodexSessionPatch: (patch: Record<string, unknown>) =>
        this.sanitizeCodexSessionPatch(patch as Partial<SessionState>) as Record<string, unknown>,
      cacheSlashCommandState: (targetSession: unknown, sanitized: Record<string, unknown>) => {
        const concreteSession = targetSession as Session;
        const projectKey = concreteSession.state.repo_root || concreteSession.state.cwd;
        const hasCachedSuggestionPatch =
          Object.hasOwn(sanitized, "slash_commands") ||
          Object.hasOwn(sanitized, "skills") ||
          Object.hasOwn(sanitized, "skill_metadata") ||
          Object.hasOwn(sanitized, "apps");
        if (projectKey && hasCachedSuggestionPatch) {
          this.slashCommandCache.set(projectKey, {
            slash_commands: concreteSession.state.slash_commands ?? [],
            skills: concreteSession.state.skills ?? [],
            skill_metadata: concreteSession.state.skill_metadata ?? [],
            apps: concreteSession.state.apps ?? [],
          });
          this.backfillSlashCommands(projectKey, concreteSession.id);
        }
      },
      freezeHistoryThroughCurrentTail: (targetSession: unknown) =>
        freezeHistoryThroughCurrentTailController(targetSession as Session),
      injectCompactionRecovery: (targetSession: unknown) =>
        injectCompactionRecoveryController(targetSession as Session, this.getCompactionRecoveryRuntimeDeps()),
      trackCodexQuestCommands: (targetSession: unknown, content: ContentBlock[]) =>
        this.trackCodexQuestCommands(targetSession as Session, content),
      reconcileCodexQuestToolResult: (
        targetSession: unknown,
        toolResult: Extract<ContentBlock, { type: "tool_result" }>,
      ) => this.reconcileCodexQuestToolResult(targetSession as Session, toolResult),
      collectCompletedToolStartTimes: (
        targetSession: unknown,
        toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
      ) => this.collectCompletedToolStartTimes(targetSession as Session, toolResults),
      buildToolResultPreviews: (
        targetSession: unknown,
        toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
      ) => this.buildToolResultPreviews(targetSession as Session, toolResults),
      finalizeSupersededCodexTerminalTools: (targetSession: unknown, completedToolStartTimes: number[]) =>
        finalizeSupersededCodexTerminalToolsController(
          targetSession as Session,
          completedToolStartTimes,
          this.getToolResultRecoveryDeps(),
        ),
      isDuplicateCodexAssistantReplay: (
        targetSession: unknown,
        assistant: Extract<BrowserIncomingMessage, { type: "assistant" }>,
      ) => this.isDuplicateCodexAssistantReplay(targetSession as Session, assistant),
      completeCodexTurnsForResult: codexRecoveryDeps.completeCodexTurnsForResult,
      clearCodexFreshTurnRequirement: codexRecoveryDeps.clearCodexFreshTurnRequirement,
      handleResultMessage: claudeHandlers.handleResultMessage,
      queueCodexPendingStartBatch: codexRecoveryDeps.queueCodexPendingStartBatch,
      dispatchQueuedCodexTurns: codexRecoveryDeps.dispatchQueuedCodexTurns,
      maybeFlushQueuedCodexMessages: codexRecoveryDeps.maybeFlushQueuedCodexMessages,
      handleCodexPermissionRequest: (targetSession: unknown, permission: PermissionRequest) =>
        handleCodexPermissionRequestController(targetSession as Session, permission, this.getBrowserRoutingDeps()),
      requestCodexLeaderRecycle: async (targetSession: unknown, trigger: "manual_compact" | "threshold") =>
        this.recycleCodexLeaderSession((targetSession as Session).id, trigger),
    };
  }

  private getWorkBoardStateDeps() {
    const notificationDeps = this.getSessionNotificationDeps();
    return {
      getBoardDispatchableSignature: (targetSession: unknown, questId: string) =>
        getBoardDispatchableSignatureController(targetSession as Session, questId, this.getBoardWatchdogDeps()),
      markNotificationDone: (sessionId: string, notifId: string, done: boolean) =>
        markNotificationDoneBySessionIdController(this.sessions, sessionId, notifId, done, notificationDeps),
      broadcastBoard: (targetSession: unknown, board: BoardRow[], completedBoard: BoardRow[]) =>
        this.broadcastToBrowsers(targetSession as Session, {
          type: "board_updated",
          board,
          completedBoard,
          rowSessionStatuses: this.getBoardRowSessionStatuses((targetSession as Session).id, board, completedBoard),
        }),
      broadcastAttentionRecords: (targetSession: unknown, attentionRecords: SessionAttentionRecord[]) =>
        this.broadcastToBrowsers(targetSession as Session, {
          type: "attention_records_update",
          attentionRecords,
        }),
      persistSession: (targetSession: unknown) => this.persistSession(targetSession as Session),
      notifyReview: (sessionId: string, summary: string) =>
        void notifyUserBySessionIdController(this.sessions, sessionId, "review", summary, notificationDeps),
    };
  }

  private getBoardWatchdogDeps() {
    const notificationDeps = this.getSessionNotificationDeps();
    return {
      getLauncherSessionInfo: (sessionId: string) => this.launcher?.getSession?.(sessionId),
      getSession: (sessionId: string) => this.sessions.get(sessionId),
      listSessions: () => this.launcher?.listSessions?.() ?? [],
      resolveSessionId: (ref: string) => this.launcher?.resolveSessionId?.(ref) ?? undefined,
      timerCount: (sessionId: string) => this.timerManager?.listTimers(sessionId).length ?? 0,
      backendConnected: (targetSession: unknown) => backendConnectedController(targetSession as Session),
      getBoard: (sessionId: string) => getBoardForSessionController(this.sessions, sessionId),
      notifyUser: (sessionId: string, category: "needs-input" | "review", summary: string) =>
        notifyUserBySessionIdController(this.sessions, sessionId, category, summary, notificationDeps),
      emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
        this.emitTakodeEvent(sessionId, type as TakodeEventType, data as any),
      markNotificationDone: (sessionId: string, notifId: string, done: boolean) =>
        markNotificationDoneBySessionIdController(this.sessions, sessionId, notifId, done, notificationDeps),
      isSessionIdle: (sessionId: string) => isSessionIdleRuntime(this.sessions.get(sessionId)),
    };
  }

  private getBrowserRoutingDeps() {
    const notificationDeps = this.getSessionNotificationDeps();
    const generationDeps = this.getGenerationLifecycleDeps();
    const codexRecoveryDeps = this.getCodexRecoveryOrchestratorDeps();
    return {
      sendToCLI: (
        targetSession: unknown,
        ndjson: string,
        opts?: { deferUntilCliReady?: boolean; skipUserDispatchLifecycle?: boolean; userMessageHistoryIndex?: number },
      ) => sendToCLITransportController(targetSession as Session, ndjson, opts, this.getClaudeCliTransportDeps()),
      broadcastToBrowsers: (targetSession: unknown, browserMsg: BrowserIncomingMessage) =>
        this.broadcastToBrowsers(targetSession as Session, browserMsg),
      emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>, actorSessionId?: string) =>
        actorSessionId === undefined
          ? this.emitTakodeEvent(sessionId, type as TakodeEventType, data as Record<string, unknown>)
          : this.emitTakodeEvent(sessionId, type as TakodeEventType, data as Record<string, unknown>, actorSessionId),
      persistSession: (targetSession: unknown) => this.persistSession(targetSession as Session),
      sessionNotificationDeps: {
        ...notificationDeps,
        schedulePermissionNotification: (targetSession: unknown, request: PermissionRequest) => {
          if (!this.pushoverNotifier) return;
          const eventType = request.tool_name === "AskUserQuestion" ? ("question" as const) : ("permission" as const);
          const detail = request.tool_name + (request.description ? `: ${request.description}` : "");
          this.pushoverNotifier.scheduleNotification(
            (targetSession as Session).id,
            eventType,
            detail,
            request.request_id,
          );
        },
        cancelPermissionNotification: (sessionId: string, requestId: string) =>
          this.pushoverNotifier?.cancelPermission(sessionId, requestId),
      },
      onAgentPaused: this.onAgentPaused
        ? (sessionId: string, history: Session["messageHistory"], cwd: string) =>
            this.onAgentPaused?.(sessionId, history, cwd)
        : undefined,
      getCurrentTurnTriggerSource: (targetSession: unknown) =>
        getCurrentTurnTriggerSourceController(targetSession as Session, {
          isSystemSourceTag: (agentSource) => this.isSystemSourceTag(agentSource),
        }),
      abortAutoApproval: (targetSession: unknown, requestId: string) =>
        this.abortAutoApproval(targetSession as Session, requestId),
      preInterrupt: (targetSession: unknown, source: InterruptSource) => {
        const session = targetSession as Session;
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
      },
      touchUserMessage: (sessionId: string, timestamp?: number) =>
        this.launcher?.touchUserMessage(sessionId, timestamp),
      formatVsCodeSelectionPrompt: (selection: import("./session-types.js").VsCodeSelectionMetadata) =>
        this.formatVsCodeSelectionPrompt(selection),
      getCliSessionId: (targetSession: unknown) => {
        const session = targetSession as Session;
        return this.launcher?.getSession(session.id)?.cliSessionId || session.state.session_id || "";
      },
      nextUserMessageId: (ts: number) => `user-${ts}-${this.userMsgCounter++}`,
      onUserMessage: this.onUserMessage
        ? (sessionId: string, history: Session["messageHistory"], cwd: string, wasGenerating: boolean) =>
            this.onUserMessage?.(sessionId, history, cwd, wasGenerating)
        : undefined,
      markRunningFromUserDispatch: (
        targetSession: unknown,
        reason: string,
        queuedInterruptSource?: InterruptSource | null,
        userMessageHistoryIndex?: number,
        activeTurnRoute?: import("./session-types.js").ActiveTurnRoute | null,
      ) =>
        markRunningFromUserDispatchLifecycle(
          generationDeps,
          targetSession as Session,
          reason,
          queuedInterruptSource,
          userMessageHistoryIndex,
          activeTurnRoute,
        ),
      trackUserMessageForTurn: (targetSession: unknown, historyIndex: number, turnTarget: UserDispatchTurnTarget) =>
        trackUserMessageForTurnLifecycle(targetSession as Session, historyIndex, turnTarget),
      setGenerating: (targetSession: unknown, generating: boolean, reason: string) =>
        setGeneratingLifecycle(generationDeps, targetSession as Session, generating, reason),
      broadcastStatusChange: (targetSession: unknown, status: "idle" | "running" | "compacting" | "reverting" | null) =>
        this.broadcastToBrowsers(targetSession as Session, {
          type: "status_change",
          status,
          activeTurnRoute:
            status === "running" ? deriveActiveTurnRouteBrowserTransportController(targetSession as Session) : null,
        }),
      setCodexImageSendStage: (
        targetSession: unknown,
        stage: SessionState["codex_image_send_stage"],
        options?: { persist?: boolean },
      ) => this.setCodexImageSendStage(targetSession as Session, stage, options),
      notifyImageSendFailure: (targetSession: unknown, err?: unknown) =>
        this.notifyImageSendFailure(targetSession as Session, err),
      isHerdEventSource: (agentSource: { sessionId: string; sessionLabel?: string } | undefined) =>
        isHerdEventSourceBrowserTransportController(agentSource),
      onSessionActivityStateChanged: (sessionId: string, reason: string) =>
        this.onSessionActivityStateChanged(sessionId, reason),
      markTurnInterrupted: (targetSession: unknown, source: InterruptSource) =>
        this.markTurnInterrupted(targetSession as Session, source),
      armCodexFreshTurnRequirement: (targetSession: unknown, turnId: string, reason: string) =>
        armCodexFreshTurnRequirementController(targetSession as Session, turnId, reason, codexRecoveryDeps),
      clearCodexFreshTurnRequirement: (targetSession: unknown, reason: string) =>
        clearCodexFreshTurnRequirementController(targetSession as Session, reason, codexRecoveryDeps),
      addPendingCodexInput: (targetSession: unknown, input: PendingCodexInput) =>
        addPendingCodexInputController(targetSession as Session, input, codexRecoveryDeps),
      getCancelablePendingCodexInputs: (targetSession: unknown) =>
        getCancelablePendingCodexInputsController(targetSession as Session),
      removePendingCodexInput: (targetSession: unknown, id: string) =>
        removePendingCodexInputController(targetSession as Session, id, codexRecoveryDeps),
      clearQueuedTurnLifecycleEntries: (targetSession: unknown) =>
        replaceQueuedTurnLifecycleEntriesLifecycle(targetSession as Session, []),
      queueCodexPendingStartBatch: (targetSession: unknown, reason: string) =>
        queueCodexPendingStartBatchController(targetSession as Session, reason, codexRecoveryDeps),
      rebuildQueuedCodexPendingStartBatch: (targetSession: unknown) =>
        rebuildQueuedCodexPendingStartBatchController(targetSession as Session, codexRecoveryDeps),
      trySteerPendingCodexInputs: (targetSession: unknown, reason: string) =>
        trySteerPendingCodexInputsController(targetSession as Session, reason, codexRecoveryDeps),
      sendToBrowser: (ws: unknown, browserMsg: BrowserIncomingMessage) =>
        sendToBrowserController(ws as ServerWebSocket<SocketData>, browserMsg),
      getLauncherSessionInfo: (sessionId: string) => this.launcher?.getSession(sessionId),
      requestCodexIntentionalRelaunch: (targetSession: unknown, reason: string, delayMs?: number) =>
        (() => {
          const session = targetSession as Session;
          const guardMs = Math.max(CODEX_INTENTIONAL_RELAUNCH_GUARD_MS, (delayMs ?? 0) + 5_000);
          session.intentionalCodexRelaunchUntil = Date.now() + guardMs;
          session.intentionalCodexRelaunchReason = reason;
          if ((delayMs ?? 0) > 0) {
            setTimeout(() => this.onSessionRelaunchRequested?.(session.id), delayMs);
            return;
          }
          this.onSessionRelaunchRequested?.(session.id);
        })(),
      onPermissionModeChanged: this.onPermissionModeChanged
        ? (sessionId: string, newMode: string) => this.onPermissionModeChanged?.(sessionId, newMode)
        : undefined,
      sendControlRequest: (
        targetSession: unknown,
        request: Record<string, unknown>,
        onResponse?: { subtype: string; resolve: (response: unknown) => void },
      ) =>
        sendControlRequestTransportController(
          targetSession as Session,
          request,
          onResponse,
          this.getClaudeCliTransportDeps(),
        ),
      requestCodexAutoRecovery: (targetSession: unknown, reason: string) =>
        this.requestCodexAutoRecovery(targetSession as Session, reason),
      requestCodexLeaderRecycle: async (targetSession: unknown, trigger: "manual_compact" | "threshold") =>
        this.recycleCodexLeaderSession((targetSession as Session).id, trigger),
      requestCliRelaunch: this.onCLIRelaunchNeeded
        ? (sessionId: string) => this.onCLIRelaunchNeeded?.(sessionId)
        : undefined,
      injectUserMessage: (
        sessionId: string,
        content: string,
        agentSource?: { sessionId: string; sessionLabel?: string },
      ) => this.injectUserMessage(sessionId, content, agentSource),
      handleSetModel: (targetSession: unknown, model: string) =>
        handleSetModelController(targetSession as Session, model, this.getBrowserRoutingDeps()),
      handleCodexSetModel: (targetSession: unknown, model: string) =>
        handleCodexSetModelController(targetSession as Session, model, this.getBrowserRoutingDeps()),
      handleSetPermissionMode: (targetSession: unknown, mode: string) =>
        handleSetPermissionModeController(targetSession as Session, mode, this.getBrowserRoutingDeps()),
      handleCodexSetPermissionMode: (targetSession: unknown, mode: string) =>
        handleCodexSetPermissionModeController(targetSession as Session, mode, this.getBrowserRoutingDeps()),
      handleCodexSetReasoningEffort: (targetSession: unknown, effort: string) =>
        handleCodexSetReasoningEffortController(targetSession as Session, effort, this.getBrowserRoutingDeps()),
      handleSetAskPermission: (targetSession: unknown, askPermission: boolean) =>
        handleSetAskPermissionController(targetSession as Session, askPermission, this.getBrowserRoutingDeps()),
      handleInterruptFallback: (targetSession: unknown, source: InterruptSource) =>
        handleInterruptController(targetSession as Session, source, this.getBrowserRoutingDeps()),
    };
  }

  private getCodexRecoveryOrchestratorDeps() {
    const generationDeps = this.getGenerationLifecycleDeps();
    const runtime = this.getCommonCodexRuntimeDeps();
    const codexRecoveryDeps = {
      codexAssistantReplayScanLimit: WsBridge.CODEX_ASSISTANT_REPLAY_SCAN_LIMIT,
      ...runtime,
      broadcastPendingCodexInputs: (targetSession: unknown) =>
        this.broadcastToBrowsers(targetSession as Session, {
          type: "codex_pending_inputs",
          inputs: (targetSession as Session).pendingCodexInputs,
        }),
      enqueueCodexTurn: (targetSession: unknown, turn: CodexOutboundTurn) =>
        enqueueCodexTurnState(targetSession as Session, turn),
      getCodexHeadTurn: (targetSession: unknown) => getCodexHeadTurnState(targetSession as Session),
      getCodexTurnInRecovery: (targetSession: unknown) => getCodexTurnInRecoveryState(targetSession as Session),
      completeCodexTurn: (targetSession: unknown, turn: CodexOutboundTurn | null) =>
        completeCodexTurnState(targetSession as Session, turn),
      completeCodexTurnsForResult: (targetSession: unknown, msg: CLIResultMessage, updatedAt?: number) =>
        completeCodexTurnsForResultController(targetSession as Session, msg, codexRecoveryDeps, updatedAt),
      clearCodexFreshTurnRequirement: (
        targetSession: unknown,
        reason: string,
        options?: { completedTurnId?: string | null },
      ) => clearCodexFreshTurnRequirementController(targetSession as Session, reason, codexRecoveryDeps, options),
      dispatchQueuedCodexTurns: (targetSession: unknown, reason: string) =>
        dispatchQueuedCodexTurnsController(targetSession as Session, reason, codexRecoveryDeps),
      maybeFlushQueuedCodexMessages: (targetSession: unknown, reason: string) =>
        maybeFlushQueuedCodexMessagesController(targetSession as Session, reason, codexRecoveryDeps),
      pruneStalePendingCodexHerdInputs: (targetSession: unknown, reason: string) =>
        this.pruneStalePendingCodexHerdInputs(targetSession as Session, reason),
      synthesizeCodexToolResultsFromResumedTurn: (
        targetSession: unknown,
        turn: CodexResumeTurnSnapshot,
        pending: CodexOutboundTurn,
      ) => this.synthesizeCodexToolResultsFromResumedTurn(targetSession as Session, turn, pending),
      injectCompactionRecovery: (targetSession: unknown) =>
        injectCompactionRecoveryController(targetSession as Session, this.getCompactionRecoveryRuntimeDeps()),
      trackUserMessageForTurn: (targetSession: unknown, historyIndex: number, target: UserDispatchTurnTarget) =>
        trackUserMessageForTurnLifecycle(targetSession as Session, historyIndex, target),
      markRunningFromUserDispatch: (
        targetSession: unknown,
        reason: string,
        queuedInterruptSource?: InterruptSource | null,
      ) =>
        markRunningFromUserDispatchLifecycle(generationDeps, targetSession as Session, reason, queuedInterruptSource),
      promoteNextQueuedTurn: (targetSession: unknown) =>
        promoteNextQueuedTurnLifecycle(generationDeps, targetSession as Session),
      clearCodexDisconnectGraceTimer: (targetSession: unknown, reason: string) =>
        this.clearCodexDisconnectGraceTimer(targetSession as Session, reason),
      setCliSessionIdFromMeta: (sessionId: string, cliSessionId: string) => {
        if (this.onCLISessionId) {
          this.onCLISessionId(sessionId, cliSessionId);
        }
      },
      completeCodexLeaderRecycle: (sessionId: string) => this.launcher?.completeCodexLeaderRecycle(sessionId),
      hydrateCodexResumedHistory: (targetSession: unknown, snapshot: unknown) =>
        hydrateCodexResumedHistoryController(
          targetSession as Session,
          snapshot as CodexResumeSnapshot,
          codexRecoveryDeps,
        ),
      setBackendState: (targetSession: unknown, state: string, error: string | null) =>
        this.setBackendState(targetSession as Session, state as NonNullable<SessionState["backend_state"]>, error),
      refreshGitInfoThenRecomputeDiff: (
        targetSession: unknown,
        options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
      ) => this.refreshGitInfoThenRecomputeDiff(targetSession as Session, options),
      finalizeCodexRollback: (targetSession: unknown) => this.finalizeCodexRollback(targetSession as Session),
      flushQueuedMessagesToCodexAdapter: (targetSession: unknown, adapter: unknown, reason: string) =>
        this.flushQueuedMessagesToCodexAdapter(targetSession as Session, adapter as CodexBridgeAdapter, reason),
      getCancelablePendingCodexInputs: (targetSession: unknown) =>
        getCancelablePendingCodexInputsController(targetSession as Session),
      getCodexTurnAwaitingAck: (targetSession: unknown) => getCodexTurnAwaitingAckState(targetSession as Session),
      getPendingCodexInputsByIds: (targetSession: unknown, inputIds: string[]) =>
        getPendingCodexInputsByIdsController(targetSession as Session, inputIds),
      queueCodexPendingStartBatch: (targetSession: unknown, reason: string) =>
        queueCodexPendingStartBatchController(targetSession as Session, reason, codexRecoveryDeps),
      recordSteeredCodexTurn: (
        targetSession: unknown,
        turnId: string,
        steeredInputs: unknown[],
        committedHistoryIndexes: number[],
      ) =>
        recordSteeredCodexTurnController(
          targetSession as Session,
          turnId,
          steeredInputs as PendingCodexInput[],
          committedHistoryIndexes,
          codexRecoveryDeps,
        ),
      setPendingCodexInputsCancelable: (targetSession: unknown, inputIds: string[], cancelable: boolean) =>
        setPendingCodexInputsCancelableController(targetSession as Session, inputIds, cancelable, codexRecoveryDeps),
      rebuildQueuedCodexPendingStartBatch: (targetSession: unknown) =>
        rebuildQueuedCodexPendingStartBatchController(targetSession as Session, codexRecoveryDeps),
      scheduleCodexToolResultWatchdogs: (targetSession: unknown, reason: string) =>
        this.scheduleCodexToolResultWatchdogs(targetSession as Session, reason),
      isCurrentSession: (sessionId: string, session: unknown) => this.sessions.get(sessionId) === session,
      logCodexProcessSnapshot: (sessionId: string, reason: string) =>
        this.launcher?.logCodexProcessSnapshotForSession?.(sessionId, reason),
      codexDisconnectGraceMs: CODEX_DISCONNECT_GRACE_MS,
      adapterFailureResetWindowMs: ADAPTER_FAILURE_RESET_WINDOW_MS,
      maxAdapterRelaunchFailures: MAX_ADAPTER_RELAUNCH_FAILURES,
      hasCliRelaunchCallback: !!this.onCLIRelaunchNeeded,
      injectUserMessage: (
        sessionId: string,
        content: string,
        agentSource?: { sessionId: string; sessionLabel?: string },
      ) => this.injectUserMessage(sessionId, content, agentSource),
    };
    return codexRecoveryDeps;
  }

  private hasPendingForceCompact(session: Session): boolean {
    return hasPendingForceCompactController(session);
  }

  async recycleCodexLeaderSession(
    sessionId: string,
    trigger: CodexLeaderRecycleTrigger,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };
    if (session.backendType !== "codex") return { ok: false, error: "Session is not a Codex session" };
    const launcherInfo = this.launcher?.getSession(sessionId);
    if (!launcherInfo) return { ok: false, error: "Session not found" };
    if (!launcherInfo.isOrchestrator) return { ok: false, error: "Recycle is only supported for Codex leaders" };
    if (launcherInfo.codexLeaderRecyclePending) return { ok: true };
    if (!this.launcher) return { ok: false, error: "Launcher unavailable" };

    const tokenDetails = session.state.codex_token_details;
    const tokenUsage =
      tokenDetails || typeof session.state.context_used_percent === "number"
        ? {
            contextTokensUsed: tokenDetails?.contextTokensUsed,
            contextUsedPercent: session.state.context_used_percent,
            modelContextWindow: tokenDetails?.modelContextWindow,
            inputTokens: tokenDetails?.inputTokens,
            cachedInputTokens: tokenDetails?.cachedInputTokens,
            outputTokens: tokenDetails?.outputTokens,
            reasoningOutputTokens: tokenDetails?.reasoningOutputTokens,
          }
        : undefined;

    const prepared = this.launcher.prepareCodexLeaderRecycle(sessionId, { trigger, tokenUsage });
    if (!prepared.ok) {
      return { ok: false, error: prepared.error || "Failed to prepare Codex leader recycle" };
    }

    clearAllCodexToolResultWatchdogsController(session);
    session.pendingMessages = [];
    session.forceCompactPending = false;
    session.pendingCodexTurns = [];
    session.pendingCodexInputs = [];
    session.pendingCodexRollback = null;
    session.pendingCodexRollbackError = null;
    session.pendingCodexRollbackWaiter = null;
    session.pendingPermissions.clear();
    session.pendingQuestCommands.clear();
    session.codexFreshTurnRequiredUntilTurnId = null;
    session.lastOutboundUserNdjson = null;
    session.state.is_compacting = false;
    replaceQueuedTurnLifecycleEntriesLifecycle(session, []);
    session.interruptedDuringTurn = true;
    session.interruptSourceDuringTurn = "system";
    session.intentionalCodexRelaunchUntil = Date.now() + CODEX_INTENTIONAL_RELAUNCH_GUARD_MS;
    session.intentionalCodexRelaunchReason = `leader_recycle:${trigger}`;
    session.relaunchPending = true;
    setGeneratingLifecycle(this.getGenerationLifecycleDeps(), session, false, "codex_leader_recycle");
    this.persistSession(session);

    const relaunch = await this.launcher.relaunch(sessionId);
    if (!relaunch.ok) {
      this.launcher.completeCodexLeaderRecycle(sessionId);
      session.intentionalCodexRelaunchUntil = null;
      session.intentionalCodexRelaunchReason = null;
      session.relaunchPending = false;
      this.persistSession(session);
      return { ok: false, error: relaunch.error || "Failed to relaunch Codex leader session" };
    }
    return { ok: true };
  }

  queueForceCompactForRelaunch(sessionId: string): { ok: true } | { ok: false; error: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };
    if (session.backendType === "codex") return { ok: false, error: "Force compact not supported for Codex" };
    queueForceCompactPendingMessageController(session, this.getBrowserRoutingDeps());
    return { ok: true };
  }

  private markTurnInterrupted(session: Session, source: InterruptSource): void {
    markTurnInterruptedLifecycle(session, source);
  }

  private handleControlResponse(session: Session, msg: CLIControlResponseMessage) {
    handleControlResponseTransportController(session, msg);
  }

  private trackCodexQuestCommands(session: Session, content: ContentBlock[]): void {
    trackCodexQuestCommandsController(session, content);
  }

  private async reconcileCodexQuestToolResult(
    session: Session,
    toolResult: Extract<ContentBlock, { type: "tool_result" }>,
  ): Promise<void> {
    await this.enqueueCodexQuestLifecycle(session, async () => {
      const deps = this.getSessionRegistryDeps();
      await reconcileCodexQuestToolResultController(session, toolResult, {
        ...deps,
        resolveQuestTitle: this.resolveQuestTitle
          ? async (questId: string) => (await this.resolveQuestTitle?.(questId)) ?? undefined
          : undefined,
      });
    });
  }

  private isCliUserMessagePayload(ndjson: string): boolean {
    if (!ndjson.includes('"type":"user"')) return false;
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

  private recomputeAndBroadcastHistoryBytes(session: Session): void {
    const { replayHistoryBytes, codexRetainedPayloadBytes } = computeSessionPayloadMetrics(
      session.messageHistory,
      session.toolResults,
    );
    const prevReplayBytes = session.state.message_history_bytes ?? 0;
    const prevRetainedBytes = session.state.codex_retained_payload_bytes ?? 0;

    session.state.message_history_bytes = replayHistoryBytes;
    if (session.backendType === "codex") {
      session.state.codex_retained_payload_bytes = codexRetainedPayloadBytes;
    }

    const sessionUpdate: Partial<SessionState> = {};
    if (prevReplayBytes === 0 ? replayHistoryBytes > 0 : Math.abs(replayHistoryBytes - prevReplayBytes) >= 1024) {
      sessionUpdate.message_history_bytes = replayHistoryBytes;
    }
    if (
      session.backendType === "codex" &&
      (prevRetainedBytes === 0
        ? codexRetainedPayloadBytes > 0
        : Math.abs(codexRetainedPayloadBytes - prevRetainedBytes) >= 1024)
    ) {
      sessionUpdate.codex_retained_payload_bytes = codexRetainedPayloadBytes;
    }

    if (Object.keys(sessionUpdate).length === 0) return;
    this.broadcastToBrowsers(session, {
      type: "session_update",
      session: sessionUpdate,
    });
  }

  private getGenerationLifecycleDeps() {
    return {
      sessions: this.sessions,
      userMessageRunningTimeoutMs: WsBridge.USER_MESSAGE_RUNNING_TIMEOUT_MS,
      broadcastStatus: (session: Session, status: "running" | "idle") => {
        this.broadcastToBrowsers(session, {
          type: "status_change",
          status,
          activeTurnRoute: status === "running" ? deriveActiveTurnRouteBrowserTransportController(session) : null,
        });
      },
      persistSession: (session: Session) => this.persistSession(session),
      onSessionActivityStateChanged: (sessionId: string, reason: string) =>
        this.onSessionActivityStateChanged(sessionId, reason),
      emitTakodeEvent: (sessionId: string, type: "turn_start" | "turn_end", data: Record<string, unknown>) => {
        this.emitTakodeEvent(sessionId, type, data);
      },
      buildTurnToolSummary: (session: Session) => this.buildTurnToolSummary(session),
      recordGenerationStarted: (session: Session, reason: string) => {
        this.workerStreamCheckpointMsgTo.delete(session.id);
        this.recorder?.recordServerEvent(
          session.id,
          "generation_started",
          { reason },
          session.backendType,
          session.state.cwd,
        );
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
      onGenerationStopped: (session: Session) => {
        // Recompute message history bytes at turn boundaries (when generation ends)
        // so the UI can show payload size without computing on every push.
        if (session.backendType === "codex" && session.state.codex_image_send_stage) {
          this.setCodexImageSendStage(session, null, { persist: false });
        }
        this.recomputeAndBroadcastHistoryBytes(session);
      },
      onOrchestratorTurnEnd: (sessionId: string, reason?: string) => {
        if (!this.herdEventDispatcher) return;
        const info = this.launcher?.getSession(sessionId);
        if (info?.isOrchestrator) {
          this.herdEventDispatcher.onOrchestratorTurnEnd(sessionId, reason);
        }
      },
      getCurrentTurnTriggerSource: (session: Session) =>
        getCurrentTurnTriggerSourceController(session, {
          isSystemSourceTag: (agentSource) => this.isSystemSourceTag(agentSource),
        }),
      isHerdedWorker: (session: Session) => this.isHerdedWorkerSession(session),
    };
  }

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

    const msgFrom = session.messageCountAtTurnStart;
    const msgTo = history.length > 0 ? history.length - 1 : 0;
    const msgRange = msgFrom < msgTo ? { from: msgFrom, to: msgTo } : undefined;

    const currentQuestStatus = session.state.claimedQuestStatus ?? null;
    const prevQuestStatus = session.questStatusAtTurnStart;
    const questChange =
      prevQuestStatus !== currentQuestStatus && session.state.claimedQuestId
        ? {
            questId: session.state.claimedQuestId,
            from: prevQuestStatus || "none",
            to: currentQuestStatus || "none",
          }
        : undefined;

    const userMsgs =
      session.userMessageIdsThisTurn.length > 0
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

  private isHistoryBackedEvent(msg: ReplayableBrowserIncomingMessage): boolean {
    return isHistoryBackedEventController(msg);
  }

  private maybeBroadcastGlobalSessionActivityUpdate(session: Session, msg: BrowserIncomingMessage): void {
    if (
      msg.type !== "permission_request" &&
      msg.type !== "permission_approved" &&
      msg.type !== "permission_denied" &&
      msg.type !== "permission_cancelled" &&
      msg.type !== "permissions_cleared" &&
      msg.type !== "status_change" &&
      !(msg.type === "session_update" && ("attentionReason" in msg.session || "lastReadAt" in msg.session))
    ) {
      return;
    }

    this.broadcastSessionActivityUpdateGlobally({
      type: "session_activity_update",
      session_id: session.id,
      session: {
        ...getSessionActivitySnapshotController(session),
        ...(msg.type === "status_change" ? { status: msg.status } : {}),
      },
    });
  }

  private broadcastToBrowsers(session: Session, msg: BrowserIncomingMessage, options?: { skipBuffer?: boolean }) {
    this.maybeBroadcastGlobalSessionActivityUpdate(session, msg);
    broadcastToBrowsersController(session, msg, this.getBrowserTransportDeps(), options);
  }
}
