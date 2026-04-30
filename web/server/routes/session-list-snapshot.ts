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
import { getLastActualHumanUserMessageTimestamp } from "../user-message-classification.js";

type SessionListEntry = ReturnType<CliLauncher["listSessions"]>[number];

export interface BuildEnrichedSessionsSnapshotDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
  timerManager?: TimerManager;
  pendingWorktreeCleanups: Map<string, Promise<void>>;
}

export async function buildEnrichedSessionsSnapshot(
  deps: BuildEnrichedSessionsSnapshotDeps,
  filterFn?: (session: SessionListEntry) => boolean,
) {
  const { launcher, wsBridge, timerManager, pendingWorktreeCleanups } = deps;
  const sessions = launcher.listSessions();
  const names = sessionNames.getAllNames();
  const pool = filterFn ? sessions.filter(filterFn) : sessions;
  const heavyRepoModeEnabled = getSettings().heavyRepoModeEnabled;
  return Promise.all(
    pool.map(async (session) => {
      let s = session;
      const pendingTimerCount = timerManager?.listTimers(s.sessionId).length ?? 0;
      let notificationSummary: NotificationStatusSnapshot = {
        notificationUrgency: null,
        activeNotificationCount: 0,
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

        const { sessionAuthToken: _token, injectedSystemPrompt: _prompt, ...safeSession } = s;
        const bridgeSession = wsBridge.getSession(s.sessionId);
        // Herded worker notifications route through the leader/board flow and
        // should not create direct user-facing sidebar markers for the worker.
        notificationSummary =
          bridgeSession && !safeSession.herdedBy ? getNotificationStatusSnapshot(bridgeSession) : notificationSummary;
        if (bridgeSession?.state?.is_worktree && !safeSession.archived && !heavyRepoModeEnabled) {
          await wsBridge.refreshWorktreeGitStateForSnapshot(s.sessionId, {
            broadcastUpdate: true,
            notifyPoller: true,
          });
        }
        const currentBridgeSession = wsBridge.getSession(s.sessionId) ?? bridgeSession;
        const bridge = currentBridgeSession?.state;
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
        const cliConnected = wsBridge.isBackendConnected(s.sessionId);
        const effectiveState = cliConnected && currentBridgeSession?.isGenerating ? "running" : safeSession.state;
        const gitAhead = bridge?.git_ahead || 0;
        const gitBehind = bridge?.git_behind || 0;
        return {
          ...safeSession,
          lastUserMessageAt,
          // Bridge model (from system.init) is more accurate than launcher model
          // (creation-time value, often empty for "default").
          model: bridge?.model || safeSession.model,
          state: effectiveState,
          sessionNum: launcher.getSessionNum(s.sessionId) ?? null,
          name: names[s.sessionId] ?? s.name,
          gitBranch: bridge?.git_branch || "",
          gitDefaultBranch: bridge?.git_default_branch || "",
          diffBaseBranch: bridge?.diff_base_branch || "",
          gitAhead,
          gitBehind,
          totalLinesAdded: bridge?.total_lines_added || 0,
          totalLinesRemoved: bridge?.total_lines_removed || 0,
          numTurns: bridge?.num_turns || 0,
          contextUsedPercent: bridge?.context_used_percent || 0,
          messageHistoryBytes: bridge?.message_history_bytes || 0,
          codexRetainedPayloadBytes: bridge?.codex_retained_payload_bytes || 0,
          sessionLifecycleEvents: bridge?.lifecycle_events ?? [],
          ...(bridge?.codex_token_details ? { codexTokenDetails: bridge.codex_token_details } : {}),
          ...(bridge?.claude_token_details ? { claudeTokenDetails: bridge.claude_token_details } : {}),
          lastMessagePreview: currentBridgeSession?.lastUserMessage || "",
          cliConnected,
          taskHistory: currentBridgeSession?.taskHistory ?? [],
          keywords: currentBridgeSession?.keywords ?? [],
          claimedQuestId: bridge?.claimedQuestId ?? null,
          claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
          claimedQuestVerificationInboxUnread: bridge?.claimedQuestVerificationInboxUnread,
          pendingTimerCount,
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
