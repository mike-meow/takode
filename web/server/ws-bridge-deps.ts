import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import { computeSessionPayloadMetrics } from "./session-payload-metrics.js";
import { getDefaultModelForBackend } from "../shared/backend-defaults.js";
import { buildLeaderActivePhaseSummary } from "../shared/leader-active-phase-summary.js";
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
import { isSessionPaused } from "./session-pause.js";
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
import { validateLeaderThreadOutcomes as validateLeaderThreadOutcomesController } from "./bridge/leader-thread-outcome-validator.js";
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
  handleCodexSetUiMode as handleCodexSetUiModeController,
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
  markCodexIntentionalRelaunch as markCodexIntentionalRelaunchController,
  maybeFlushQueuedCodexMessages as maybeFlushQueuedCodexMessagesController,
  pokeStaleCodexPendingDelivery as pokeStaleCodexPendingDeliveryController,
  queueCodexPendingStartBatch as queueCodexPendingStartBatchController,
  rearmRecoveredQueuedHeadTurn as rearmRecoveredQueuedHeadTurnController,
  registerCodexAdapterRecoveryLifecycle,
  rebuildQueuedCodexPendingStartBatch as rebuildQueuedCodexPendingStartBatchController,
  reconcileCodexResumedTurn as reconcileCodexResumedTurnController,
  reconcileRecoveredQueuedTurnLifecycle as reconcileRecoveredQueuedTurnLifecycleController,
  recordSteeredCodexTurn as recordSteeredCodexTurnController,
  removePendingCodexInput as removePendingCodexInputController,
  retryNonDrainableCodexHeadTurn as retryNonDrainableCodexHeadTurnController,
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
import type {
  CodexBridgeAdapter,
  GitSessionKey,
  InterruptSource,
  Session,
  SocketData,
} from "./bridge/ws-bridge-session.js";

const MAX_ADAPTER_RELAUNCH_FAILURES = 3;
const ADAPTER_FAILURE_RESET_WINDOW_MS = 120_000;
const CODEX_DISCONNECT_GRACE_MS = 15_000;
const CODEX_INTENTIONAL_RELAUNCH_GUARD_MS = 15_000;
const CODEX_RECOVERY_TIMEOUT_MS = 30_000;
const CODEX_TOOL_RESULT_WATCHDOG_MS = 120_000;
const STUCK_GENERATION_THRESHOLD_MS = 120_000;
const TAKODE_BOARD_RESULT_PREVIEW_LIMIT = 12_000;
const WS_BRIDGE_CODEX_ASSISTANT_REPLAY_SCAN_LIMIT = 200;
const WS_BRIDGE_CROSS_SESSION_THROTTLE_MS = 30_000;
const WS_BRIDGE_EVENT_BUFFER_LIMIT = 600;
const WS_BRIDGE_IDEMPOTENT_BROWSER_MESSAGE_TYPES = new Set<string>([
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
const WS_BRIDGE_GIT_SESSION_KEYS: GitSessionKey[] = [
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
const WS_BRIDGE_LEADER_GROUP_IDLE_NOTIFY_DELAY_MS = 10_000;
const WS_BRIDGE_PROCESSED_CLIENT_MSG_ID_LIMIT = 1000;
const WS_BRIDGE_USER_MESSAGE_RUNNING_TIMEOUT_MS = 30_000;
const WS_BRIDGE_VSCODE_OPEN_FILE_TIMEOUT_MS = 8_000;
const WS_BRIDGE_VSCODE_WINDOW_STALE_MS = 30_000;

function readLauncherSession(host: any, sessionId: string) {
  return typeof host.launcher?.getSession === "function" ? host.launcher.getSession(sessionId) : undefined;
}

function requestCliRelaunchIfUnpaused(host: any): ((sessionId: string) => void) | undefined {
  if (!host.onCLIRelaunchNeeded) return undefined;
  return (sessionId: string) => {
    if (isSessionPaused(host.sessions?.get(sessionId))) {
      console.log(`[ws-bridge] Relaunch deferred for paused session ${sessionTag(sessionId)}`);
      return;
    }
    host.onCLIRelaunchNeeded?.(sessionId);
  };
}

export function getSessionGitStateDeps(host: any) {
  const broadcastSessionUpdate = (targetSession: unknown, update: Record<string, unknown>) => {
    const session = targetSession as Session;
    host.broadcastToBrowsers(session, {
      type: "session_update",
      session: update,
    });
  };
  return {
    gitSessionKeys: WS_BRIDGE_GIT_SESSION_KEYS,
    sessions: host.sessions,
    inFlightRefreshes: host.worktreeSnapshotRefreshes,
    nonWorktreeAheadBehindRefreshes: host.nonWorktreeAheadBehindRefreshes,
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
        diff_stats_skipped_reason: session.state.diff_stats_skipped_reason ?? null,
      });
    },
    broadcastDiffTotals: (targetSession: unknown) => {
      const session = targetSession as Session;
      broadcastSessionUpdate(session, {
        total_lines_added: session.state.total_lines_added,
        total_lines_removed: session.state.total_lines_removed,
        diff_stats_skipped_reason: session.state.diff_stats_skipped_reason ?? null,
      });
    },
    persistSession: (targetSession: unknown) => host.persistSession(targetSession as Session),
    notifyPoller: (targetSession: unknown) => {
      const session = targetSession as Session;
      if (host.onGitInfoReady && session.state.git_branch && session.state.cwd) {
        host.onGitInfoReady(session.id, session.state.cwd, session.state.git_branch);
      }
    },
    updateBranchIndex: (targetSession: unknown) =>
      updateBranchIndexState(targetSession as Session, {
        isArchived: readLauncherSession(host, (targetSession as Session).id)?.archived === true,
        branchToSessions: host.branchToSessions,
        sessionBranches: host.sessionBranches,
      }),
    invalidateSessionsSharingBranch: (targetSession: unknown, previousHeadSha: string) => {
      const session = targetSession as Session;
      const { changedBranch, invalidatedCount } = invalidateSessionsSharingBranchIndex(session, {
        sessions: host.sessions,
        branchToSessions: host.branchToSessions,
        sessionBranches: host.sessionBranches,
        lastCrossSessionRefreshAt: host.lastCrossSessionRefreshAt,
        throttleMs: WS_BRIDGE_CROSS_SESSION_THROTTLE_MS,
        isArchived: (sessionId) => readLauncherSession(host, sessionId)?.archived === true,
        refreshSession: (candidateSession) =>
          host.refreshGitInfoThenRecomputeDiff(candidateSession as Session, { broadcastUpdate: true }),
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
    ) => host.refreshGitInfo(targetSession as Session, options),
  };
}

export function getSessionCleanupDeps(host: any) {
  return {
    clearOptimisticRunningTimer: (session: Session, _reason: string) => clearOptimisticRunningTimerLifecycle(session),
    clearAllCodexToolResultWatchdogs: (session: Session, _reason: string) =>
      clearAllCodexToolResultWatchdogsController(session),
    cleanupBranchState: (sessionId: string) =>
      cleanupBranchStateIndex(sessionId, {
        branchToSessions: host.branchToSessions,
        sessionBranches: host.sessionBranches,
        lastCrossSessionRefreshAt: host.lastCrossSessionRefreshAt,
      }),
    removeStoredSession: (sessionId: string) => host.store?.remove(sessionId),
    removeImages: (sessionId: string) => host.imageStore?.removeSession(sessionId),
  };
}

export function getSessionNotificationDeps(host: any) {
  return {
    isHerdedWorkerSession: (targetSession: unknown) => host.isHerdedWorkerSession(targetSession as Session),
    getLauncherSessionInfo: (sessionId: string) => readLauncherSession(host, sessionId),
    broadcastToBrowsers: (targetSession: unknown, msg: BrowserIncomingMessage) =>
      host.broadcastToBrowsers(targetSession as Session, msg),
    persistSession: (targetSession: unknown) => host.persistSession(targetSession as Session),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      host.emitTakodeEvent(sessionId, type as TakodeEventType, data as any),
    scheduleNotification: (
      sessionId: string,
      category: "question" | "completed",
      detail: string,
      options?: { skipReadCheck?: boolean; notificationId?: string },
    ) => host.pushoverNotifier?.scheduleNotification(sessionId, category, detail, undefined, options),
    cancelScheduledNotification: (sessionId: string, notificationId: string) =>
      host.pushoverNotifier?.cancelNotification(sessionId, notificationId),
  };
}

export function getSessionRegistryDeps(host: any) {
  const notificationDeps = host.getSessionNotificationDeps();
  return {
    makeDefaultState: (sessionId: string, backendType: string) =>
      makeDefaultState(sessionId, backendType as BackendType),
    pruneToolResultsForCurrentHistory: (targetSession: unknown) =>
      host.pruneToolResultsForCurrentHistory(targetSession as Session),
    broadcastToSession: (sessionId: string, msg: BrowserIncomingMessage) => host.broadcastToSession(sessionId, msg),
    broadcastToBrowsers: (targetSession: unknown, msg: BrowserIncomingMessage) =>
      host.broadcastToBrowsers(targetSession as Session, msg),
    recomputeAndBroadcastHistoryBytes: (targetSession: unknown) =>
      host.recomputeAndBroadcastHistoryBytes(targetSession as Session),
    broadcastSessionUpdate: (targetSession: unknown, update: Record<string, unknown>) =>
      host.broadcastToBrowsers(targetSession as Session, { type: "session_update", session: update }),
    broadcastTaskHistory: (targetSession: unknown) =>
      host.broadcastToBrowsers(targetSession as Session, {
        type: "session_task_history",
        tasks: (targetSession as Session).taskHistory,
      }),
    persistSession: (targetSession: unknown) => host.persistSession(targetSession as Session),
    persistSessionSync: (sessionId: string) => host.persistSessionSync(sessionId),
    requestCliRelaunch: requestCliRelaunchIfUnpaused(host),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      host.emitTakodeEvent(sessionId, type as TakodeEventType, data as any),
    attached: (targetSession: unknown) => backendAttachedController(targetSession as Session),
    getLauncherSessionInfo: (sessionId: string) => readLauncherSession(host, sessionId),
    recoveryTimeoutMs: CODEX_RECOVERY_TIMEOUT_MS,
    maxAdapterRelaunchFailures: MAX_ADAPTER_RELAUNCH_FAILURES,
    getHerdedSessionIds: (leaderId: string) =>
      host.launcher?.getHerdedSessions?.(leaderId)?.map((worker: { sessionId: string }) => worker.sessionId) ?? [],
    getSessionNum: (sessionId: string) => host.launcher?.getSessionNum?.(sessionId),
    getSessionName: (sessionId: string) => host.sessionNameGetter?.(sessionId),
    deriveSessionStatus: (targetSession: unknown) =>
      deriveSessionStatusController(targetSession as Session, {
        backendConnected: (concreteSession: unknown) => backendConnectedController(concreteSession as Session),
      }),
    clearAttentionAndMarkRead: (targetSession: unknown) =>
      clearAttentionAndMarkReadController(targetSession as Session, notificationDeps),
    setAttentionReview: (targetSession: unknown) =>
      setAttentionController(targetSession as Session, "review", notificationDeps),
    broadcastLeaderGroupIdle: (targetSession: unknown, payload: Record<string, unknown>) =>
      host.broadcastToBrowsers(targetSession as Session, payload as BrowserIncomingMessage),
    recordServerEvent: (
      sessionId: string,
      eventReason: string,
      payload: Record<string, unknown>,
      backendType: string,
      cwd: string,
    ) => host.recorder?.recordServerEvent(sessionId, eventReason, payload, backendType as BackendType, cwd),
    delayMs: WS_BRIDGE_LEADER_GROUP_IDLE_NOTIFY_DELAY_MS,
    isHerdedWorkerSession: notificationDeps.isHerdedWorkerSession,
    scheduleNotification: notificationDeps.scheduleNotification,
    scheduleCompletedNotification: (sessionId: string, detail: string) =>
      host.pushoverNotifier?.scheduleNotification(sessionId, "completed", detail),
    onSessionNamedByQuest: host.onSessionNamedByQuest
      ? (sessionId: string, title: string) => host.onSessionNamedByQuest?.(sessionId, title)
      : undefined,
    finalizeCodexRecoveringTurn: (targetSession: unknown, reason: "recovery_timeout" | "recovery_failed") =>
      host.finalizeCodexRecoveringTurn(targetSession as Session, reason),
  };
}

export function getCompactionRecoveryRuntimeDeps(host: any) {
  return {
    isLeaderSession: (session: unknown) => readLauncherSession(host, (session as Session).id)?.isOrchestrator === true,
    isSystemSourceTag: (agentSource: { sessionId: string; sessionLabel?: string } | undefined) =>
      host.isSystemSourceTag(agentSource),
    injectUserMessage: (
      sessionId: string,
      content: string,
      agentSource?: { sessionId: string; sessionLabel?: string },
    ) => host.injectUserMessage(sessionId, content, agentSource),
  };
}

export function getCommonClaudeRuntimeDeps(host: any) {
  const generationDeps = host.getGenerationLifecycleDeps();
  return {
    getLauncherSessionInfo: (sessionId: string) => readLauncherSession(host, sessionId),
    refreshGitInfoThenRecomputeDiff: (
      targetSession: unknown,
      options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
    ) => host.refreshGitInfoThenRecomputeDiff(targetSession as Session, options),
    persistSession: (targetSession: unknown) => host.persistSession(targetSession as Session),
    markTurnInterrupted: (targetSession: unknown, source: InterruptSource) =>
      host.markTurnInterrupted(targetSession as Session, source),
    setGenerating: (targetSession: unknown, generating: boolean, reason: string) =>
      setGeneratingLifecycle(generationDeps, targetSession as Session, generating, reason),
    onSessionActivityStateChanged: (sessionId: string, reason: string) =>
      host.onSessionActivityStateChanged(sessionId, reason),
  };
}

export function getCommonCodexRuntimeDeps(host: any) {
  const generationDeps = host.getGenerationLifecycleDeps();
  const sessionRegistryDeps = host.getSessionRegistryDeps();
  return {
    formatVsCodeSelectionPrompt: (selection: import("./session-types.js").VsCodeSelectionMetadata) =>
      host.formatVsCodeSelectionPrompt(selection),
    broadcastToBrowsers: (targetSession: unknown, browserMsg: BrowserIncomingMessage) =>
      host.broadcastToBrowsers(targetSession as Session, browserMsg),
    persistSession: (targetSession: unknown) => host.persistSession(targetSession as Session),
    touchUserMessage: (sessionId: string, timestamp?: number) => host.launcher?.touchUserMessage(sessionId, timestamp),
    onUserMessage: host.onUserMessage
      ? (sessionId: string, history: Session["messageHistory"], cwd: string, wasGenerating: boolean) =>
          host.onUserMessage?.(sessionId, history, cwd, wasGenerating)
      : undefined,
    refreshGitInfoThenRecomputeDiff: (
      targetSession: unknown,
      options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
    ) => host.refreshGitInfoThenRecomputeDiff(targetSession as Session, options),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      host.emitTakodeEvent(sessionId, type as TakodeEventType, data as any),
    requestCodexAutoRecovery: (targetSession: unknown, reason: string) =>
      host.requestCodexAutoRecovery(targetSession as Session, reason),
    getLauncherSessionInfo: (sessionId: string) => readLauncherSession(host, sessionId),
    setAttentionError: (targetSession: unknown) =>
      setAttentionController(targetSession as Session, "error", sessionRegistryDeps),
    setGenerating: (targetSession: unknown, generating: boolean, reason: string) =>
      setGeneratingLifecycle(generationDeps, targetSession as Session, generating, reason),
    markTurnInterrupted: (targetSession: unknown, source: InterruptSource) =>
      host.markTurnInterrupted(targetSession as Session, source),
  };
}

export function getClaudeMessageHandlers(host: any) {
  const runtime = host.getCommonClaudeRuntimeDeps();
  return createClaudeMessageHandlersController({
    onCLISessionId: host.onCLISessionId ?? undefined,
    cacheSlashCommands: (projectKey: string, data: { slash_commands: string[]; skills: string[] }) => {
      host.slashCommandCache.set(projectKey, {
        ...data,
        skill_metadata: [],
        apps: [],
      });
    },
    backfillSlashCommands: (projectKey: string, sourceSessionId: string) =>
      host.backfillSlashCommands(projectKey, sourceSessionId),
    ...runtime,
    broadcastToBrowsers: (
      targetSession: unknown,
      browserMsg: BrowserIncomingMessage,
      options?: { skipBuffer?: boolean },
    ) => host.broadcastToBrowsers(targetSession as Session, browserMsg, options),
    hasPendingForceCompact: (targetSession: unknown) => host.hasPendingForceCompact(targetSession as Session),
    flushQueuedCliMessages: (targetSession: unknown, reason: string) =>
      flushQueuedCliMessagesController(targetSession as Session, reason, host.getClaudeCliTransportDeps()),
    onOrchestratorTurnEnd: (sessionId: string) => host.herdEventDispatcher?.onOrchestratorTurnEnd(sessionId),
    isCliUserMessagePayload: (ndjson: string) => host.isCliUserMessagePayload(ndjson),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      host.emitTakodeEvent(sessionId, type as TakodeEventType, data as TakodeEventDataByType[TakodeEventType]),
    injectCompactionRecovery: (targetSession: unknown) =>
      injectCompactionRecoveryController(targetSession as Session, host.getCompactionRecoveryRuntimeDeps()),
    hasCompactBoundaryReplay: (targetSession: unknown, cliUuid: string | undefined, meta: unknown) =>
      host.hasCompactBoundaryReplay(
        targetSession as Session,
        cliUuid,
        meta as CLISystemCompactBoundaryMessage["compact_metadata"],
      ),
    freezeHistoryThroughCurrentTail: (targetSession: unknown) =>
      freezeHistoryThroughCurrentTailController(targetSession as Session),
    hasTaskNotificationReplay: (targetSession: unknown, taskId: string, toolUseId: string) =>
      host.hasTaskNotificationReplay(targetSession as Session, taskId, toolUseId),
    stuckGenerationThresholdMs: STUCK_GENERATION_THRESHOLD_MS,
    hasAssistantReplay: (targetSession: unknown, messageId: string) =>
      host.hasAssistantReplay(targetSession as Session, messageId),
    onToolUseObserved: (targetSession: unknown, toolUse: Extract<ContentBlock, { type: "tool_use" }>) =>
      host.handleObservedLongSleepBashToolUse(targetSession as Session, toolUse),
    hasResultReplay: (targetSession: unknown, resultUuid: string) =>
      host.hasResultReplay(targetSession as Session, resultUuid),
    reconcileReplayState: (targetSession: unknown) =>
      reconcileTerminalResultStateLifecycle(
        host.getGenerationLifecycleDeps(),
        targetSession as Session,
        "result_replay",
      ),
    drainInlineQueuedClaudeTurns: (targetSession: unknown, reason: string) =>
      drainInlineQueuedClaudeTurnsController(targetSession as Session, reason, {
        getQueuedTurnLifecycleEntries: (session) => getQueuedTurnLifecycleEntriesLifecycle(session as Session),
        replaceQueuedTurnLifecycleEntries: (session, entries) =>
          replaceQueuedTurnLifecycleEntriesLifecycle(session as Session, entries as any[]),
        isCliUserMessagePayload: (ndjson: string) => host.isCliUserMessagePayload(ndjson),
      }),
    getCurrentTurnTriggerSource: (targetSession: unknown) =>
      getCurrentTurnTriggerSourceController(targetSession as Session, {
        isSystemSourceTag: (agentSource) => host.isSystemSourceTag(agentSource),
      }),
    reconcileTerminalResultState: (targetSession: unknown) => {
      reconcileTerminalResultStateLifecycle(host.getGenerationLifecycleDeps(), targetSession as Session, "result");
    },
    finalizeOrphanedTerminalToolsOnResult: (targetSession: unknown, resultMsg: CLIResultMessage) =>
      host.finalizeOrphanedTerminalToolsOnResult(targetSession as Session, resultMsg),
    cancelPermissionNotification: (sessionId: string, requestId: string) =>
      host.pushoverNotifier?.cancelPermission(sessionId, requestId),
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
          isHerdedWorkerSession: (concreteSession) => host.isHerdedWorkerSession(concreteSession as Session),
          getLauncherSessionInfo: (sessionId: string) => readLauncherSession(host, sessionId),
          broadcastToBrowsers: (concreteSession, browserMsg) =>
            host.broadcastToBrowsers(concreteSession as Session, browserMsg),
          persistSession: (concreteSession) => host.persistSession(concreteSession as Session),
          emitTakodeEvent: (sessionId, type, data) =>
            host.emitTakodeEvent(sessionId, type as TakodeEventType, data as TakodeEventDataByType[TakodeEventType]),
          scheduleErrorNotification: host.pushoverNotifier
            ? (sessionId, detail) => host.pushoverNotifier!.scheduleNotification(sessionId, "error", detail)
            : undefined,
          scheduleResultCompletedNotification: host.pushoverNotifier
            ? (sessionId) => host.pushoverNotifier!.scheduleNotification(sessionId, "completed")
            : undefined,
        },
      ),
    validateLeaderThreadOutcomes: (targetSession: unknown, turnTriggerSource: unknown) => {
      validateLeaderThreadOutcomesController(targetSession as Session, {
        isLeaderSession: (sessionId) => readLauncherSession(host, sessionId)?.isOrchestrator === true,
        getTurnSource: () => turnTriggerSource as "user" | "leader" | "system" | "unknown",
        injectUserMessage: (sessionId, content, agentSource, threadRoute) => {
          const delivery = host.injectUserMessage(sessionId, content, agentSource, undefined, threadRoute);
          return delivery === "paused_queued" ? "queued" : delivery;
        },
        persistSession: (concreteSession) => host.persistSession(concreteSession as Session),
      });
    },
    onTurnCompleted: (targetSession: unknown) => {
      const concreteSession = targetSession as Session;
      host.onTurnCompleted?.(concreteSession.id, [...concreteSession.messageHistory], concreteSession.state.cwd);
    },
    injectUserMessage: (
      sessionId: string,
      content: string,
      agentSource: { sessionId: string; sessionLabel?: string },
      takodeHerdBatch: undefined,
      threadRoute: { threadKey: string; questId?: string; threadRefs?: ThreadRef[] },
    ) => host.injectUserMessage(sessionId, content, agentSource, takodeHerdBatch, threadRoute),
    hasUserPromptReplay: (targetSession: unknown, cliUuid: string) =>
      host.hasUserPromptReplay(targetSession as Session, cliUuid),
    hasToolResultPreviewReplay: (targetSession: unknown, toolUseId: string) =>
      host.hasToolResultPreviewReplay(targetSession as Session, toolUseId),
    nextUserMessageId: (timestamp: number) => `cli-user-${timestamp}-${host.userMsgCounter++}`,
    clearCodexToolResultWatchdog: (targetSession: unknown, toolUseId: string) =>
      clearCodexToolResultWatchdogController(targetSession as Session, toolUseId),
    buildToolResultPreviews: (targetSession: unknown, toolResults: Extract<ContentBlock, { type: "tool_result" }>[]) =>
      host.buildToolResultPreviews(targetSession as Session, toolResults),
    collectCompletedToolStartTimes: (
      targetSession: unknown,
      toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
    ) => host.collectCompletedToolStartTimes(targetSession as Session, toolResults),
    finalizeSupersededCodexTerminalTools: (targetSession: unknown, completedToolStartTimes: number[]) =>
      finalizeSupersededCodexTerminalToolsController(
        targetSession as Session,
        completedToolStartTimes,
        host.getToolResultRecoveryDeps(),
      ),
    broadcastCompactSummary: (targetSession: unknown, summary: string) =>
      host.broadcastToBrowsers(targetSession as Session, { type: "compact_summary", summary }),
    updateLatestCompactMarkerSummary: (targetSession: unknown, summary: string) => {
      const marker = (targetSession as Session).messageHistory.findLast((entry) => entry.type === "compact_marker");
      if (marker && marker.type === "compact_marker") {
        (marker as { summary?: string }).summary = summary;
      }
    },
  });
}

export function getToolResultRecoveryDeps(host: any) {
  return {
    getToolUseBlockInHistory: (targetSession: unknown, toolUseId: string) =>
      findToolUseBlockInHistoryController(targetSession as Session, toolUseId),
    hasToolResultPreviewReplay: (targetSession: unknown, toolUseId: string) =>
      host.hasToolResultPreviewReplay(targetSession as Session, toolUseId),
    clearCodexToolResultWatchdog: (targetSession: unknown, toolUseId: string) =>
      clearCodexToolResultWatchdogController(targetSession as Session, toolUseId),
    broadcastToBrowsers: (targetSession: unknown, browserMsg: BrowserIncomingMessage) =>
      host.broadcastToBrowsers(targetSession as Session, browserMsg),
    persistSession: (targetSession: unknown) => host.persistSession(targetSession as Session),
    getCodexTurnInRecovery: (targetSession: unknown) => getCodexTurnInRecoveryState(targetSession as Session),
    codexToolResultWatchdogMs: CODEX_TOOL_RESULT_WATCHDOG_MS,
    takodeBoardResultPreviewLimit: TAKODE_BOARD_RESULT_PREVIEW_LIMIT,
    defaultToolResultPreviewLimit: TOOL_RESULT_PREVIEW_LIMIT,
  };
}

export function getBrowserTransportDeps(host: any) {
  return {
    refreshGitInfoThenRecomputeDiff: (targetSession: unknown, options: { notifyPoller: boolean }) =>
      host.refreshGitInfoThenRecomputeDiff(targetSession as Session, options),
    prefillSlashCommands: (targetSession: unknown) => host.prefillSlashCommands(targetSession as Session),
    getTreeGroupState: async () => {
      const treeGroupStore = await import("./tree-group-store.js");
      const tgs = await treeGroupStore.getState();
      return {
        groups: tgs.groups,
        assignments: tgs.assignments,
        nodeOrder: tgs.nodeOrder,
      };
    },
    getVsCodeSelectionState: () => host.browserTransportState.vscodeSelectionState,
    getLauncherSessionInfo: (sessionId: string) => readLauncherSession(host, sessionId),
    backendAttached: (targetSession: unknown) => backendAttachedController(targetSession as Session),
    backendConnected: (targetSession: unknown) => backendConnectedController(targetSession as Session),
    requestCodexLeaderRecycle: async (targetSession: unknown, trigger: CodexLeaderRecycleTrigger) =>
      host.recycleCodexLeaderSession((targetSession as Session).id, trigger),
    requestCliRelaunch: requestCliRelaunchIfUnpaused(host),
    getRouteChain: (sessionId: string) => host.sessionRouteChains.get(sessionId),
    setRouteChain: (sessionId: string, task: Promise<void>) => {
      host.sessionRouteChains.set(sessionId, task);
    },
    clearRouteChain: (sessionId: string, task: Promise<void>) => {
      if (host.sessionRouteChains.get(sessionId) === task) {
        host.sessionRouteChains.delete(sessionId);
      }
    },
    routeBrowserMessage: (targetSession: unknown, msg: BrowserOutgoingMessage, ws?: unknown) =>
      routeBrowserMessageController(
        targetSession as Session,
        msg,
        ws as ServerWebSocket<SocketData> | undefined,
        host.getBrowserRoutingDeps(),
      ),
    abortAutoApproval: (targetSession: unknown, requestId: string) =>
      host.abortAutoApproval(targetSession as Session, requestId),
    broadcastToBrowsers: (targetSession: unknown, browserMsg: BrowserIncomingMessage) =>
      host.broadcastToBrowsers(targetSession as Session, browserMsg),
    setAttentionAction: (targetSession: unknown) =>
      setAttentionController(targetSession as Session, "action", host.getSessionNotificationDeps()),
    touchActivity: (sessionId: string) => host.launcher?.touchActivity(sessionId),
    notifyImageSendFailure: (targetSession: unknown, err?: unknown) =>
      host.notifyImageSendFailure(targetSession as Session, err),
    broadcastError: (targetSession: unknown, message: string) =>
      host.broadcastToBrowsers(targetSession as Session, { type: "error", message }),
    queueCodexPendingStartBatch: (targetSession: unknown, reason: string) =>
      queueCodexPendingStartBatchController(targetSession as Session, reason, host.getCodexRecoveryOrchestratorDeps()),
    deriveBackendState: (targetSession: unknown) => deriveBackendStateController(targetSession as Session),
    getBoard: (sessionId: string) => getBoardForSessionController(host.sessions, sessionId),
    getCompletedBoard: (sessionId: string) => getCompletedBoardForSessionController(host.sessions, sessionId),
    getBoardRowSessionStatuses: (sessionId: string, board: unknown[], completedBoard: unknown[]) =>
      host.getBoardRowSessionStatuses(sessionId, board as BoardRow[], completedBoard as BoardRow[]),
    recoverToolStartTimesFromHistory: (targetSession: unknown) =>
      host.recoverToolStartTimesFromHistory(targetSession as Session),
    finalizeRecoveredDisconnectedTerminalTools: (targetSession: unknown, reason: string) =>
      host.finalizeRecoveredDisconnectedTerminalTools(targetSession as Session, reason),
    scheduleCodexToolResultWatchdogs: (targetSession: unknown, reason: string) =>
      host.scheduleCodexToolResultWatchdogs(targetSession as Session, reason),
    recomputeAndBroadcastHistoryBytes: (targetSession: unknown) =>
      host.recomputeAndBroadcastHistoryBytes(targetSession as Session),
    listTimers: (sessionId: string) => host.timerManager?.listTimers(sessionId) ?? [],
    persistSession: (targetSession: unknown) => host.persistSession(targetSession as Session),
    recordIncomingRaw: (sessionId: string, json: string, backendType: string, cwd: string) =>
      host.recorder?.record(sessionId, "in", json, "browser", backendType as BackendType, cwd),
    recordOutgoingRaw: (sessionId: string, json: string, backendType: string, cwd: string) =>
      host.recorder?.record(sessionId, "out", json, "browser", backendType as BackendType, cwd),
    eventBufferLimit: WS_BRIDGE_EVENT_BUFFER_LIMIT,
    browserTransportState: host.browserTransportState,
    idempotentMessageTypes: WS_BRIDGE_IDEMPOTENT_BROWSER_MESSAGE_TYPES,
    processedClientMsgIdLimit: WS_BRIDGE_PROCESSED_CLIENT_MSG_ID_LIMIT,
    getSessions: () => host.sessions.values(),
    windowStaleMs: WS_BRIDGE_VSCODE_WINDOW_STALE_MS,
    openFileTimeoutMs: WS_BRIDGE_VSCODE_OPEN_FILE_TIMEOUT_MS,
    lazyLoadFullHistory: async (targetSession: unknown) => {
      const session = targetSession as Session;
      if (!session.searchDataOnly || !host.store) return;
      const persisted = await host.store.load(session.id);
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
        host.store
          .load(session.id)
          .then((fresh: import("./session-store.js").PersistedSession | null) => {
            if (fresh && !fresh._searchExcerpts) {
              fresh._searchExcerpts = excerpts;
              host.store!.saveSync(fresh);
            }
          })
          .catch(() => {});
      }
      session.searchDataOnly = false;
      session.searchExcerpts = [];
    },
  };
}

export function getClaudeCliTransportDeps(host: any) {
  const runtime = host.getCommonClaudeRuntimeDeps();
  const handlers = host.getClaudeMessageHandlers();
  return {
    ...runtime,
    broadcastToBrowsers: (targetSession: unknown, msg: BrowserIncomingMessage) =>
      host.broadcastToBrowsers(targetSession as Session, msg),
    routeCLIMessage: (targetSession: unknown, msg: CLIMessage) => {
      const session = targetSession as Session;
      if (msg.type !== "keep_alive") {
        host.launcher?.touchActivity(session.id);
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
          void handleControlRequestController(messageSession as Session, controlMsg, host.getBrowserRoutingDeps());
        },
        handleUserMessage: handlers.handleClaudeCliUserMessage,
        handleControlResponse: (messageSession, controlResponse) =>
          host.handleControlResponse(messageSession as Session, controlResponse),
        abortAutoApproval: (messageSession, requestId) => host.abortAutoApproval(messageSession as Session, requestId),
        broadcastToBrowsers: (messageSession, browserMsg, options) =>
          host.broadcastToBrowsers(messageSession as Session, browserMsg, options),
        cancelPermissionNotification: (sessionId, requestId) =>
          host.pushoverNotifier?.cancelPermission(sessionId, requestId),
        clearActionAttentionIfNoPermissions: (messageSession) =>
          host.clearActionAttentionIfNoPermissions(messageSession as Session),
        persistSession: (messageSession) => host.persistSession(messageSession as Session),
        toolProgressOutputLimit: 12_000,
      });
      host.syncSlackThreadRecordForChild?.(session);
    },
    recordIncomingRaw: (sessionId: string, data: string, backendType: string, cwd: string) =>
      host.recorder?.record(sessionId, "in", data, "cli", backendType as BackendType, cwd),
    recordOutgoingRaw: (sessionId: string, data: string, backendType: string, cwd: string) =>
      host.recorder?.record(sessionId, "out", data, "cli", backendType as BackendType, cwd),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      host.emitTakodeEvent(sessionId, type as TakodeEventType, data as TakodeEventDataByType[TakodeEventType]),
    setAttentionError: (targetSession: unknown) =>
      setAttentionController(targetSession as Session, "error", host.getSessionRegistryDeps()),
    onOrchestratorDisconnect: (sessionId: string) => host.herdEventDispatcher?.onOrchestratorDisconnect(sessionId),
    requestCliRelaunch: requestCliRelaunchIfUnpaused(host),
    markRunningFromUserDispatch: (targetSession: unknown, reason: string, userMessageHistoryIndex?: number) =>
      markRunningFromUserDispatchLifecycle(
        host.getGenerationLifecycleDeps(),
        targetSession as Session,
        reason,
        null,
        userMessageHistoryIndex,
      ),
    isCliUserMessagePayload: (ndjson: string) => host.isCliUserMessagePayload(ndjson),
  };
}

export function getClaudeSdkAdapterLifecycleDeps(host: any) {
  const runtime = host.getCommonClaudeRuntimeDeps();
  const handlers = host.getClaudeMessageHandlers();
  return {
    ...runtime,
    getOrCreateSession: (sessionId: string, backendType: "claude-sdk") =>
      host.getOrCreateSession(sessionId, backendType),
    onOrchestratorTurnEnd: (sessionId: string) => host.herdEventDispatcher?.onOrchestratorTurnEnd(sessionId),
    touchActivity: (sessionId: string) => host.launcher?.touchActivity(sessionId),
    clearOptimisticRunningTimer: (targetSession: unknown, reason: string) =>
      clearOptimisticRunningTimerLifecycle(targetSession as Session),
    hasPendingForceCompact: (targetSession: unknown) => host.hasPendingForceCompact(targetSession as Session),
    broadcastToBrowsers: (targetSession: unknown, msg: Record<string, unknown>) =>
      host.broadcastToBrowsers(targetSession as Session, msg as BrowserIncomingMessage),
    handleSdkBrowserMessage: handlers.handleSdkBrowserMessage,
    handleSdkPermissionRequest: (targetSession: unknown, request: PermissionRequest) =>
      handleSdkPermissionRequestController(targetSession as Session, request, host.getBrowserRoutingDeps()),
    syncSlackThreadParent: (targetSession: unknown) => host.syncSlackThreadRecordForChild?.(targetSession as Session),
    setCliSessionId: (sessionId: string, cliSessionId: string) =>
      host.launcher?.setCLISessionId(sessionId, cliSessionId),
    requestCliRelaunch: requestCliRelaunchIfUnpaused(host),
    isCurrentSession: (sessionId: string, session: unknown) => host.sessions.get(sessionId) === session,
    maxAdapterRelaunchFailures: MAX_ADAPTER_RELAUNCH_FAILURES,
    adapterFailureResetWindowMs: ADAPTER_FAILURE_RESET_WINDOW_MS,
  };
}

export function getCodexAdapterBrowserMessageDeps(host: any) {
  const claudeHandlers = host.getClaudeMessageHandlers();
  const runtime = host.getCommonCodexRuntimeDeps();
  const codexRecoveryDeps = host.getCodexRecoveryOrchestratorDeps();
  return {
    ...runtime,
    getLauncherSessionInfo: (sessionId: string) => readLauncherSession(host, sessionId),
    touchActivity: (sessionId: string) => host.launcher?.touchActivity(sessionId),
    clearOptimisticRunningTimer: (targetSession: unknown, reason: string) =>
      clearOptimisticRunningTimerLifecycle(targetSession as Session),
    setCodexImageSendStage: (targetSession: unknown, stage: string, options?: { persist?: boolean }) =>
      host.setCodexImageSendStage(targetSession as Session, stage as SessionState["codex_image_send_stage"], options),
    sanitizeCodexSessionPatch: (patch: Record<string, unknown>) =>
      host.sanitizeCodexSessionPatch(patch as Partial<SessionState>) as Record<string, unknown>,
    cacheSlashCommandState: (targetSession: unknown, sanitized: Record<string, unknown>) => {
      const concreteSession = targetSession as Session;
      const projectKey = concreteSession.state.repo_root || concreteSession.state.cwd;
      const hasCachedSuggestionPatch =
        Object.hasOwn(sanitized, "slash_commands") ||
        Object.hasOwn(sanitized, "skills") ||
        Object.hasOwn(sanitized, "skill_metadata") ||
        Object.hasOwn(sanitized, "apps");
      if (projectKey && hasCachedSuggestionPatch) {
        host.slashCommandCache.set(projectKey, {
          slash_commands: concreteSession.state.slash_commands ?? [],
          skills: concreteSession.state.skills ?? [],
          skill_metadata: concreteSession.state.skill_metadata ?? [],
          apps: concreteSession.state.apps ?? [],
        });
        host.backfillSlashCommands(projectKey, concreteSession.id);
      }
    },
    freezeHistoryThroughCurrentTail: (targetSession: unknown) =>
      freezeHistoryThroughCurrentTailController(targetSession as Session),
    injectCompactionRecovery: (targetSession: unknown) =>
      injectCompactionRecoveryController(targetSession as Session, host.getCompactionRecoveryRuntimeDeps()),
    trackCodexQuestCommands: (targetSession: unknown, content: ContentBlock[]) =>
      host.trackCodexQuestCommands(targetSession as Session, content),
    reconcileCodexQuestToolResult: (
      targetSession: unknown,
      toolResult: Extract<ContentBlock, { type: "tool_result" }>,
    ) => host.reconcileCodexQuestToolResult(targetSession as Session, toolResult),
    collectCompletedToolStartTimes: (
      targetSession: unknown,
      toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
    ) => host.collectCompletedToolStartTimes(targetSession as Session, toolResults),
    buildToolResultPreviews: (targetSession: unknown, toolResults: Extract<ContentBlock, { type: "tool_result" }>[]) =>
      host.buildToolResultPreviews(targetSession as Session, toolResults),
    finalizeSupersededCodexTerminalTools: (targetSession: unknown, completedToolStartTimes: number[]) =>
      finalizeSupersededCodexTerminalToolsController(
        targetSession as Session,
        completedToolStartTimes,
        host.getToolResultRecoveryDeps(),
      ),
    isDuplicateCodexAssistantReplay: (
      targetSession: unknown,
      assistant: Extract<BrowserIncomingMessage, { type: "assistant" }>,
    ) => host.isDuplicateCodexAssistantReplay(targetSession as Session, assistant),
    completeCodexTurnsForResult: codexRecoveryDeps.completeCodexTurnsForResult,
    clearCodexFreshTurnRequirement: codexRecoveryDeps.clearCodexFreshTurnRequirement,
    handleResultMessage: claudeHandlers.handleResultMessage,
    queueCodexPendingStartBatch: codexRecoveryDeps.queueCodexPendingStartBatch,
    dispatchQueuedCodexTurns: codexRecoveryDeps.dispatchQueuedCodexTurns,
    maybeFlushQueuedCodexMessages: codexRecoveryDeps.maybeFlushQueuedCodexMessages,
    handleCodexPermissionRequest: (targetSession: unknown, permission: PermissionRequest) =>
      handleCodexPermissionRequestController(targetSession as Session, permission, host.getBrowserRoutingDeps()),
    requestCodexLeaderRecycle: async (targetSession: unknown, trigger: CodexLeaderRecycleTrigger) =>
      host.recycleCodexLeaderSession((targetSession as Session).id, trigger),
    handleCodexResultErrorAutoPause: (
      targetSession: unknown,
      msg: CLIResultMessage,
      completedTurn: CodexOutboundTurn | null,
    ) => host.handleCodexResultErrorAutoPause(targetSession as Session, msg, completedTurn),
    syncSlackThreadParent: (targetSession: unknown) => host.syncSlackThreadRecordForChild?.(targetSession as Session),
  };
}

export function getWorkBoardStateDeps(host: any) {
  const notificationDeps = host.getSessionNotificationDeps();
  return {
    getBoardDispatchableSignature: (targetSession: unknown, questId: string) =>
      getBoardDispatchableSignatureController(targetSession as Session, questId, host.getBoardWatchdogDeps()),
    markNotificationDone: (sessionId: string, notifId: string, done: boolean) =>
      markNotificationDoneBySessionIdController(host.sessions, sessionId, notifId, done, notificationDeps),
    broadcastBoard: (targetSession: unknown, board: BoardRow[], completedBoard: BoardRow[]) =>
      host.broadcastToBrowsers(targetSession as Session, {
        type: "board_updated",
        board,
        completedBoard,
        leaderActivePhaseSummary: buildLeaderActivePhaseSummary(board),
        rowSessionStatuses: host.getBoardRowSessionStatuses((targetSession as Session).id, board, completedBoard),
      }),
    broadcastAttentionRecords: (targetSession: unknown, attentionRecords: SessionAttentionRecord[]) =>
      host.broadcastToBrowsers(targetSession as Session, {
        type: "attention_records_update",
        attentionRecords,
      }),
    persistSession: (targetSession: unknown) => host.persistSession(targetSession as Session),
    notifyReview: (sessionId: string, summary: string) =>
      void notifyUserBySessionIdController(host.sessions, sessionId, "review", summary, notificationDeps),
  };
}

export function getBoardWatchdogDeps(host: any) {
  const notificationDeps = host.getSessionNotificationDeps();
  return {
    getLauncherSessionInfo: (sessionId: string) => host.launcher?.getSession?.(sessionId),
    getSession: (sessionId: string) => host.sessions.get(sessionId),
    listSessions: () => host.launcher?.listSessions?.() ?? [],
    resolveSessionId: (ref: string) => host.launcher?.resolveSessionId?.(ref) ?? undefined,
    timerCount: (sessionId: string) => host.timerManager?.listTimers(sessionId).length ?? 0,
    backendConnected: (targetSession: unknown) => backendConnectedController(targetSession as Session),
    getBoard: (sessionId: string) => getBoardForSessionController(host.sessions, sessionId),
    notifyUser: (sessionId: string, category: "needs-input" | "review", summary: string) =>
      notifyUserBySessionIdController(host.sessions, sessionId, category, summary, notificationDeps),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      host.emitTakodeEvent(sessionId, type as TakodeEventType, data as any),
    markNotificationDone: (sessionId: string, notifId: string, done: boolean) =>
      markNotificationDoneBySessionIdController(host.sessions, sessionId, notifId, done, notificationDeps),
    isSessionIdle: (sessionId: string) => isSessionIdleRuntime(host.sessions.get(sessionId)),
  };
}

export function getBrowserRoutingDeps(host: any) {
  const notificationDeps = host.getSessionNotificationDeps();
  const generationDeps = host.getGenerationLifecycleDeps();
  const codexRecoveryDeps = host.getCodexRecoveryOrchestratorDeps();
  return {
    sendToCLI: (
      targetSession: unknown,
      ndjson: string,
      opts?: { deferUntilCliReady?: boolean; skipUserDispatchLifecycle?: boolean; userMessageHistoryIndex?: number },
    ) => sendToCLITransportController(targetSession as Session, ndjson, opts, host.getClaudeCliTransportDeps()),
    broadcastToBrowsers: (targetSession: unknown, browserMsg: BrowserIncomingMessage) =>
      host.broadcastToBrowsers(targetSession as Session, browserMsg),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>, actorSessionId?: string) =>
      actorSessionId === undefined
        ? host.emitTakodeEvent(sessionId, type as TakodeEventType, data as Record<string, unknown>)
        : host.emitTakodeEvent(sessionId, type as TakodeEventType, data as Record<string, unknown>, actorSessionId),
    persistSession: (targetSession: unknown) => host.persistSession(targetSession as Session),
    sessionNotificationDeps: {
      ...notificationDeps,
      schedulePermissionNotification: (targetSession: unknown, request: PermissionRequest) => {
        if (!host.pushoverNotifier) return;
        const eventType = request.tool_name === "AskUserQuestion" ? ("question" as const) : ("permission" as const);
        const detail = request.tool_name + (request.description ? `: ${request.description}` : "");
        host.pushoverNotifier.scheduleNotification(
          (targetSession as Session).id,
          eventType,
          detail,
          request.request_id,
        );
      },
      cancelPermissionNotification: (sessionId: string, requestId: string) =>
        host.pushoverNotifier?.cancelPermission(sessionId, requestId),
    },
    onAgentPaused: host.onAgentPaused
      ? (sessionId: string, history: Session["messageHistory"], cwd: string) =>
          host.onAgentPaused?.(sessionId, history, cwd)
      : undefined,
    getCurrentTurnTriggerSource: (targetSession: unknown) =>
      getCurrentTurnTriggerSourceController(targetSession as Session, {
        isSystemSourceTag: (agentSource) => host.isSystemSourceTag(agentSource),
      }),
    abortAutoApproval: (targetSession: unknown, requestId: string) =>
      host.abortAutoApproval(targetSession as Session, requestId),
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
        host.persistSession(session);
      }
    },
    touchUserMessage: (sessionId: string, timestamp?: number) => host.launcher?.touchUserMessage(sessionId, timestamp),
    formatVsCodeSelectionPrompt: (selection: import("./session-types.js").VsCodeSelectionMetadata) =>
      host.formatVsCodeSelectionPrompt(selection),
    getCliSessionId: (targetSession: unknown) => {
      const session = targetSession as Session;
      return readLauncherSession(host, session.id)?.cliSessionId || session.state.session_id || "";
    },
    nextUserMessageId: (ts: number) => `user-${ts}-${host.userMsgCounter++}`,
    onUserMessage: host.onUserMessage
      ? (sessionId: string, history: Session["messageHistory"], cwd: string, wasGenerating: boolean) =>
          host.onUserMessage?.(sessionId, history, cwd, wasGenerating)
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
      host.broadcastToBrowsers(targetSession as Session, {
        type: "status_change",
        status,
        activeTurnRoute:
          status === "running" ? deriveActiveTurnRouteBrowserTransportController(targetSession as Session) : null,
      }),
    setCodexImageSendStage: (
      targetSession: unknown,
      stage: SessionState["codex_image_send_stage"],
      options?: { persist?: boolean },
    ) => host.setCodexImageSendStage(targetSession as Session, stage, options),
    notifyImageSendFailure: (targetSession: unknown, err?: unknown) =>
      host.notifyImageSendFailure(targetSession as Session, err),
    isHerdEventSource: (agentSource: { sessionId: string; sessionLabel?: string } | undefined) =>
      isHerdEventSourceBrowserTransportController(agentSource),
    onSessionActivityStateChanged: (sessionId: string, reason: string) =>
      host.onSessionActivityStateChanged(sessionId, reason),
    markTurnInterrupted: (targetSession: unknown, source: InterruptSource) =>
      host.markTurnInterrupted(targetSession as Session, source),
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
    pokeStaleCodexPendingDelivery: (targetSession: unknown, reason: string, options?: { triggeringInputId?: string }) =>
      pokeStaleCodexPendingDeliveryController(targetSession as Session, reason, codexRecoveryDeps, options),
    rebuildQueuedCodexPendingStartBatch: (targetSession: unknown) =>
      rebuildQueuedCodexPendingStartBatchController(targetSession as Session, codexRecoveryDeps),
    trySteerPendingCodexInputs: (targetSession: unknown, reason: string) =>
      trySteerPendingCodexInputsController(targetSession as Session, reason, codexRecoveryDeps),
    sendToBrowser: (ws: unknown, browserMsg: BrowserIncomingMessage) =>
      sendToBrowserController(ws as ServerWebSocket<SocketData>, browserMsg),
    getLauncherSessionInfo: (sessionId: string) => readLauncherSession(host, sessionId),
    requestCodexIntentionalRelaunch: (targetSession: unknown, reason: string, delayMs?: number) =>
      (() => {
        const session = targetSession as Session;
        const guardMs = Math.max(CODEX_INTENTIONAL_RELAUNCH_GUARD_MS, (delayMs ?? 0) + 5_000);
        const requestRelaunch = () => {
          markCodexIntentionalRelaunchController(session, reason, guardMs);
          host.onSessionRelaunchRequested?.(session.id);
        };
        if ((delayMs ?? 0) > 0) {
          setTimeout(requestRelaunch, delayMs);
          return;
        }
        requestRelaunch();
      })(),
    onPermissionModeChanged: host.onPermissionModeChanged
      ? (sessionId: string, newMode: string) => host.onPermissionModeChanged?.(sessionId, newMode)
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
        host.getClaudeCliTransportDeps(),
      ),
    requestCodexAutoRecovery: (targetSession: unknown, reason: string) =>
      host.requestCodexAutoRecovery(targetSession as Session, reason),
    requestCodexLeaderRecycle: async (targetSession: unknown, trigger: CodexLeaderRecycleTrigger) =>
      host.recycleCodexLeaderSession((targetSession as Session).id, trigger),
    requestCliRelaunch: requestCliRelaunchIfUnpaused(host),
    injectUserMessage: (
      sessionId: string,
      content: string,
      agentSource?: { sessionId: string; sessionLabel?: string },
    ) => host.injectUserMessage(sessionId, content, agentSource),
    handleSetModel: (targetSession: unknown, model: string) =>
      handleSetModelController(targetSession as Session, model, host.getBrowserRoutingDeps()),
    handleCodexSetModel: (targetSession: unknown, model: string) =>
      handleCodexSetModelController(targetSession as Session, model, host.getBrowserRoutingDeps()),
    handleSetPermissionMode: (targetSession: unknown, mode: string) =>
      handleSetPermissionModeController(targetSession as Session, mode, host.getBrowserRoutingDeps()),
    handleCodexSetPermissionMode: (targetSession: unknown, mode: string) =>
      handleCodexSetPermissionModeController(targetSession as Session, mode, host.getBrowserRoutingDeps()),
    handleCodexSetUiMode: (targetSession: unknown, uiMode: "plan" | "agent") =>
      handleCodexSetUiModeController(targetSession as Session, uiMode, host.getBrowserRoutingDeps()),
    handleCodexSetReasoningEffort: (targetSession: unknown, effort: string) =>
      handleCodexSetReasoningEffortController(targetSession as Session, effort, host.getBrowserRoutingDeps()),
    handleSetAskPermission: (targetSession: unknown, askPermission: boolean) =>
      handleSetAskPermissionController(targetSession as Session, askPermission, host.getBrowserRoutingDeps()),
    handleInterruptFallback: (targetSession: unknown, source: InterruptSource) =>
      handleInterruptController(targetSession as Session, source, host.getBrowserRoutingDeps()),
  };
}

export function getCodexRecoveryOrchestratorDeps(host: any) {
  const generationDeps = host.getGenerationLifecycleDeps();
  const runtime = host.getCommonCodexRuntimeDeps();
  const codexRecoveryDeps = {
    codexAssistantReplayScanLimit: WS_BRIDGE_CODEX_ASSISTANT_REPLAY_SCAN_LIMIT,
    ...runtime,
    broadcastPendingCodexInputs: (targetSession: unknown) =>
      host.broadcastToBrowsers(targetSession as Session, {
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
      host.pruneStalePendingCodexHerdInputs(targetSession as Session, reason),
    synthesizeCodexToolResultsFromResumedTurn: (
      targetSession: unknown,
      turn: CodexResumeTurnSnapshot,
      pending: CodexOutboundTurn,
    ) => host.synthesizeCodexToolResultsFromResumedTurn(targetSession as Session, turn, pending),
    injectCompactionRecovery: (targetSession: unknown) =>
      injectCompactionRecoveryController(targetSession as Session, host.getCompactionRecoveryRuntimeDeps()),
    trackUserMessageForTurn: (targetSession: unknown, historyIndex: number, target: UserDispatchTurnTarget) =>
      trackUserMessageForTurnLifecycle(targetSession as Session, historyIndex, target),
    markRunningFromUserDispatch: (
      targetSession: unknown,
      reason: string,
      queuedInterruptSource?: InterruptSource | null,
    ) => markRunningFromUserDispatchLifecycle(generationDeps, targetSession as Session, reason, queuedInterruptSource),
    promoteNextQueuedTurn: (targetSession: unknown) =>
      promoteNextQueuedTurnLifecycle(generationDeps, targetSession as Session),
    clearCodexDisconnectGraceTimer: (targetSession: unknown, reason: string) =>
      host.clearCodexDisconnectGraceTimer(targetSession as Session, reason),
    setCliSessionIdFromMeta: (sessionId: string, cliSessionId: string) => {
      if (host.onCLISessionId) {
        host.onCLISessionId(sessionId, cliSessionId);
      }
    },
    completeCodexLeaderRecycle: (sessionId: string) => host.launcher?.completeCodexLeaderRecycle(sessionId),
    hydrateCodexResumedHistory: (targetSession: unknown, snapshot: unknown) =>
      hydrateCodexResumedHistoryController(
        targetSession as Session,
        snapshot as CodexResumeSnapshot,
        codexRecoveryDeps,
      ),
    setBackendState: (targetSession: unknown, state: string, error: string | null) =>
      host.setBackendState(targetSession as Session, state as NonNullable<SessionState["backend_state"]>, error),
    refreshGitInfoThenRecomputeDiff: (
      targetSession: unknown,
      options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
    ) => host.refreshGitInfoThenRecomputeDiff(targetSession as Session, options),
    finalizeCodexRollback: (targetSession: unknown) => host.finalizeCodexRollback(targetSession as Session),
    flushQueuedMessagesToCodexAdapter: (targetSession: unknown, adapter: unknown, reason: string) =>
      host.flushQueuedMessagesToCodexAdapter(targetSession as Session, adapter as CodexBridgeAdapter, reason),
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
      host.scheduleCodexToolResultWatchdogs(targetSession as Session, reason),
    isCurrentSession: (sessionId: string, session: unknown) => host.sessions.get(sessionId) === session,
    logCodexProcessSnapshot: (sessionId: string, reason: string) =>
      host.launcher?.logCodexProcessSnapshotForSession?.(sessionId, reason),
    codexDisconnectGraceMs: CODEX_DISCONNECT_GRACE_MS,
    adapterFailureResetWindowMs: ADAPTER_FAILURE_RESET_WINDOW_MS,
    maxAdapterRelaunchFailures: MAX_ADAPTER_RELAUNCH_FAILURES,
    hasCliRelaunchCallback: !!host.onCLIRelaunchNeeded,
    injectUserMessage: (
      sessionId: string,
      content: string,
      agentSource?: { sessionId: string; sessionLabel?: string },
    ) => host.injectUserMessage(sessionId, content, agentSource),
  };
  return codexRecoveryDeps;
}

export function getGenerationLifecycleDeps(host: any) {
  return {
    sessions: host.sessions,
    userMessageRunningTimeoutMs: WS_BRIDGE_USER_MESSAGE_RUNNING_TIMEOUT_MS,
    broadcastStatus: (session: Session, status: "running" | "idle") => {
      host.broadcastToBrowsers(session, {
        type: "status_change",
        status,
        activeTurnRoute: status === "running" ? deriveActiveTurnRouteBrowserTransportController(session) : null,
      });
    },
    broadcastSessionUpdate: (session: Session, update: Record<string, unknown>) => {
      host.broadcastToBrowsers(session, {
        type: "session_update",
        session: update,
      });
    },
    persistSession: (session: Session) => host.persistSession(session),
    onSessionActivityStateChanged: (sessionId: string, reason: string) =>
      host.onSessionActivityStateChanged(sessionId, reason),
    emitTakodeEvent: (sessionId: string, type: "turn_start" | "turn_end", data: Record<string, unknown>) => {
      host.emitTakodeEvent(sessionId, type, data);
    },
    buildTurnToolSummary: (session: Session) => host.buildTurnToolSummary(session),
    recordGenerationStarted: (session: Session, reason: string) => {
      host.workerStreamCheckpointMsgTo.delete(session.id);
      host.recorder?.recordServerEvent(
        session.id,
        "generation_started",
        { reason },
        session.backendType,
        session.state.cwd,
      );
    },
    recordGenerationEnded: (session: Session, reason: string, elapsedMs: number) => {
      host.recorder?.recordServerEvent(
        session.id,
        "generation_ended",
        { reason, elapsed: elapsedMs },
        session.backendType,
        session.state.cwd,
      );
    },
    recoverPendingCodexTurnBeforeQueueDrain: (session: Session, reason: string) => {
      if (session.backendType !== "codex") return false;
      return retryNonDrainableCodexHeadTurnController(
        session,
        `${reason}_before_queued_lifecycle_drain`,
        host.getCodexRecoveryOrchestratorDeps(),
      );
    },
    onGenerationStopped: (session: Session) => {
      // Recompute message history bytes at turn boundaries (when generation ends)
      // so the UI can show payload size without computing on every push.
      if (session.backendType === "codex" && session.state.codex_image_send_stage) {
        host.setCodexImageSendStage(session, null, { persist: false });
      }
      host.recomputeAndBroadcastHistoryBytes(session);
    },
    onOrchestratorTurnEnd: (sessionId: string, reason?: string) => {
      if (!host.herdEventDispatcher) return;
      const info = readLauncherSession(host, sessionId);
      if (info?.isOrchestrator) {
        host.herdEventDispatcher.onOrchestratorTurnEnd(sessionId, reason);
      }
    },
    getCurrentTurnTriggerSource: (session: Session) =>
      getCurrentTurnTriggerSourceController(session, {
        isSystemSourceTag: (agentSource) => host.isSystemSourceTag(agentSource),
      }),
    isHerdedWorker: (session: Session) => host.isHerdedWorkerSession(session),
  };
}
