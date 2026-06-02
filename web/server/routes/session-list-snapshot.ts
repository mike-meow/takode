import { access as accessAsync } from "node:fs/promises";
import type { CliLauncher } from "../cli-launcher.js";
import {
  countPendingUserPermissions,
  getNotificationStatusSnapshot,
  summarizePendingPermissions,
  type NotificationStatusSnapshot,
} from "../bridge/session-registry-controller.js";
import { getSettings } from "../settings-manager.js";
import type { TimerManager } from "../timer-manager.js";
import type { WsBridge } from "../ws-bridge.js";
import * as sessionNames from "../session-names.js";
import { computeSessionTurnMetrics, getLastActualHumanUserMessageTimestamp } from "../user-message-classification.js";
import { getLeaderProfilePortraitForSession } from "../leader-profile-assignments.js";
import { buildLeaderActivePhaseSummary } from "../../shared/leader-active-phase-summary.js";
import { getBoard as getBoardController } from "../bridge/board-watchdog-controller.js";

type SessionListEntry = ReturnType<CliLauncher["listSessions"]>[number];
const scheduledWorktreeGitStateRefreshes = new Map<string, ReturnType<typeof setTimeout>>();

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

export interface BuildEnrichedSessionsSnapshotDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  timerManager?: TimerManager;
  pendingWorktreeCleanups: Map<string, Promise<void>>;
}

export function scheduleWorktreeGitStateRefreshForSnapshot(
  wsBridge: Pick<WsBridge, "refreshWorktreeGitStateForSnapshot">,
  sessionId: string,
): void {
  if (scheduledWorktreeGitStateRefreshes.has(sessionId)) return;
  const timer = setTimeout(() => {
    scheduledWorktreeGitStateRefreshes.delete(sessionId);
    try {
      void Promise.resolve(
        wsBridge.refreshWorktreeGitStateForSnapshot(sessionId, {
          broadcastUpdate: true,
          notifyPoller: true,
        }),
      ).catch((error) => {
        console.warn(`[routes] Background worktree git refresh failed for ${sessionId}:`, error);
      });
    } catch (error) {
      console.warn(`[routes] Background worktree git refresh failed for ${sessionId}:`, error);
    }
  }, 0);
  scheduledWorktreeGitStateRefreshes.set(sessionId, timer);
}

export function _resetScheduledWorktreeGitStateRefreshesForTest(): void {
  for (const timer of scheduledWorktreeGitStateRefreshes.values()) {
    clearTimeout(timer);
  }
  scheduledWorktreeGitStateRefreshes.clear();
}

export function buildLeaderActivePhaseSummaryForSnapshot(isOrchestrator: boolean | undefined, bridgeSession: unknown) {
  const board = buildLeaderActiveBoardRowsForSnapshot(isOrchestrator, bridgeSession);
  if (board === undefined) return undefined;
  return buildLeaderActivePhaseSummary(board);
}

export function buildLeaderActiveBoardRowsForSnapshot(isOrchestrator: boolean | undefined, bridgeSession: unknown) {
  if (isOrchestrator !== true) return undefined;
  return hasBoardState(bridgeSession)
    ? getBoardController(bridgeSession as Parameters<typeof getBoardController>[0])
    : [];
}

function hasBoardState(bridgeSession: unknown): boolean {
  return (
    bridgeSession !== null &&
    typeof bridgeSession === "object" &&
    (bridgeSession as { board?: unknown }).board instanceof Map
  );
}

export async function buildEnrichedSessionsSnapshot(
  deps: BuildEnrichedSessionsSnapshotDeps,
  filterFn?: (session: SessionListEntry) => boolean,
) {
  const { launcher, wsBridge, timerManager, pendingWorktreeCleanups } = deps;
  const sessions = launcher.listSessions().filter((session) => session.hidden !== true);
  const names = sessionNames.getAllNames();
  const pool = filterFn ? sessions.filter(filterFn) : sessions;
  const settings = getSettings();
  const heavyRepoModeEnabled = settings.heavyRepoModeEnabled;
  return Promise.all(
    pool.map(async (session) => {
      let s = session;
      const pendingTimerCount = timerManager?.listTimers(s.sessionId).length ?? 0;
      let notificationSummary: NotificationStatusSnapshot = {
        notificationUrgency: null,
        activeNotificationCount: 0,
        activeNeedsInputNotificationCount: 0,
        activeReviewNotificationCount: 0,
        notificationStatusVersion: 0,
        notificationStatusUpdatedAt: 0,
      };
      try {
        if (s.worktreeCleanupStatus === "pending" && !pendingWorktreeCleanups.has(s.sessionId)) {
          launcher.setWorktreeCleanupState(s.sessionId, {
            status: "failed",
            error: s.worktreeCleanupError || "Cleanup was interrupted before completion.",
            startedAt: s.worktreeCleanupStartedAt,
            finishedAt: Date.now(),
          });
          s = launcher.getSession(s.sessionId) ?? s;
        }

        const {
          sessionAuthToken: _token,
          injectedSystemPrompt: _prompt,
          codexLeaderRecycleThresholdTokens: launcherCodexLeaderRecycleThresholdTokens,
          ...safeSession
        } = s;
        const bridgeSession = wsBridge.getSession(s.sessionId);
        // Herded worker notifications route through the leader/board flow and
        // should not create direct user-facing sidebar markers for the worker.
        notificationSummary =
          bridgeSession && !safeSession.herdedBy ? getNotificationStatusSnapshot(bridgeSession) : notificationSummary;
        if (bridgeSession?.state?.is_worktree && !safeSession.archived && !heavyRepoModeEnabled) {
          scheduleWorktreeGitStateRefreshForSnapshot(wsBridge, s.sessionId);
        }
        const currentBridgeSession = wsBridge.getSession(s.sessionId) ?? bridgeSession;
        const bridge = currentBridgeSession?.state;
        const turnMetrics = currentBridgeSession
          ? computeSessionTurnMetrics(currentBridgeSession.messageHistory)
          : null;
        if (bridge && turnMetrics) {
          bridge.user_turn_count = turnMetrics.userTurnCount;
          bridge.agent_turn_count = turnMetrics.agentTurnCount;
          bridge.num_turns = turnMetrics.userTurnCount;
        }
        const lastUserMessageAt = currentBridgeSession
          ? getLastActualHumanUserMessageTimestamp(currentBridgeSession.messageHistory)
          : safeSession.lastUserMessageAt;
        const attention = currentBridgeSession
          ? {
              lastReadAt: currentBridgeSession.lastReadAt,
              attentionReason: currentBridgeSession.attentionReason,
              pendingPermissionCount: countPendingUserPermissions(currentBridgeSession),
              pendingPermissionSummary: summarizePendingPermissions(currentBridgeSession),
            }
          : null;
        const model = bridge?.model || safeSession.model;
        const treeGroupId = bridge?.treeGroupId ?? safeSession.treeGroupId ?? null;
        const memorySessionSpaceSlug = bridge?.memorySessionSpaceSlug ?? safeSession.memorySessionSpaceSlug ?? null;
        const cliConnected = wsBridge.isBackendConnected(s.sessionId);
        const effectiveState = cliConnected && currentBridgeSession?.isGenerating ? "running" : safeSession.state;
        const codexLeaderRecycleThresholdTokens =
          safeSession.backendType === "codex" && safeSession.isOrchestrator === true
            ? (positiveInteger(launcherCodexLeaderRecycleThresholdTokens) ??
              positiveInteger(bridge?.codex_leader_recycle_threshold_tokens))
            : undefined;
        const leaderProfilePortrait = getLeaderProfilePortraitForSession(
          safeSession,
          settings.leaderProfilePools,
          (portraitId) => launcher.setLeaderProfilePortraitId(s.sessionId, portraitId),
        );
        const leaderProfilePortraitId =
          leaderProfilePortrait && leaderProfilePortrait.poolId !== "fallback"
            ? leaderProfilePortrait.id
            : (safeSession.leaderProfilePortraitId ?? null);
        const leaderActiveBoardRows = buildLeaderActiveBoardRowsForSnapshot(
          safeSession.isOrchestrator,
          currentBridgeSession,
        );
        const leaderActivePhaseSummary =
          leaderActiveBoardRows === undefined ? undefined : buildLeaderActivePhaseSummary(leaderActiveBoardRows);
        const gitAhead = bridge?.git_ahead || 0;
        const gitBehind = bridge?.git_behind || 0;
        return {
          ...safeSession,
          lastUserMessageAt,
          // Bridge model (from system.init) is more accurate than launcher model
          // (creation-time value, often empty for "default").
          model,
          state: effectiveState,
          treeGroupId,
          memorySessionSpaceSlug,
          sessionNum: launcher.getSessionNum(s.sessionId) ?? null,
          name: names[s.sessionId] ?? s.name,
          gitBranch: bridge?.git_branch || "",
          gitDefaultBranch: bridge?.git_default_branch || "",
          diffBaseBranch: bridge?.diff_base_branch || "",
          gitAhead,
          gitBehind,
          totalLinesAdded: bridge?.total_lines_added || 0,
          totalLinesRemoved: bridge?.total_lines_removed || 0,
          diffStatsSkippedReason: bridge?.diff_stats_skipped_reason ?? null,
          gitStatusRefreshedAt: bridge?.git_status_refreshed_at,
          gitStatusRefreshError: bridge?.git_status_refresh_error ?? null,
          userTurnCount: turnMetrics?.userTurnCount ?? bridge?.user_turn_count ?? bridge?.num_turns ?? 0,
          agentTurnCount: turnMetrics?.agentTurnCount ?? bridge?.agent_turn_count ?? 0,
          numTurns: turnMetrics?.userTurnCount ?? bridge?.user_turn_count ?? bridge?.num_turns ?? 0,
          contextUsedPercent: bridge?.context_used_percent || 0,
          messageHistoryBytes: bridge?.message_history_bytes || 0,
          codexRetainedPayloadBytes: bridge?.codex_retained_payload_bytes || 0,
          sessionLifecycleEvents: bridge?.lifecycle_events ?? [],
          leaderProfilePortraitId,
          ...(leaderProfilePortrait ? { leaderProfilePortrait } : {}),
          ...(codexLeaderRecycleThresholdTokens ? { codexLeaderRecycleThresholdTokens } : {}),
          ...(bridge?.codex_token_details ? { codexTokenDetails: bridge.codex_token_details } : {}),
          ...(bridge?.claude_token_details ? { claudeTokenDetails: bridge.claude_token_details } : {}),
          ...(bridge?.leaderOpenThreadTabs ? { leaderOpenThreadTabs: bridge.leaderOpenThreadTabs } : {}),
          ...(leaderActiveBoardRows !== undefined ? { leaderActiveBoardRows } : {}),
          ...(leaderActivePhaseSummary !== undefined ? { leaderActivePhaseSummary } : {}),
          lastMessagePreview: currentBridgeSession?.lastUserMessage || "",
          cliConnected,
          taskHistory: currentBridgeSession?.taskHistory ?? [],
          keywords: currentBridgeSession?.keywords ?? [],
          claimedQuestId: bridge?.claimedQuestId ?? null,
          claimedQuestTitle: bridge?.claimedQuestTitle ?? null,
          claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
          claimedQuestVerificationInboxUnread: bridge?.claimedQuestVerificationInboxUnread,
          claimedQuestLeaderSessionId: bridge?.claimedQuestLeaderSessionId ?? null,
          pendingTimerCount,
          pause: bridge?.pause ?? null,
          pausedInputQueueCount: bridge?.pause?.queuedMessages.length ?? 0,
          codexResultErrorAutoPause: bridge?.codex_result_error_auto_pause ?? null,
          codexAutoPausedInputCount:
            bridge?.codex_result_error_auto_pause?.heldInputs.reduce(
              (total, item) => total + Math.max(1, item.count),
              0,
            ) ?? 0,
          ...notificationSummary,
          ...(attention ?? {}),
          ...(s.isWorktree && s.archived ? { worktreeExists: await archivedWorktreeExists(s.cwd) } : {}),
        };
      } catch (e) {
        console.warn(`[routes] Failed to enrich session ${s.sessionId}:`, e);
        return { ...s, name: names[s.sessionId] ?? s.name, pendingTimerCount, ...notificationSummary };
      }
    }),
  );
}

async function archivedWorktreeExists(cwd: string): Promise<boolean> {
  try {
    await accessAsync(cwd);
    return true;
  } catch {
    return false;
  }
}
