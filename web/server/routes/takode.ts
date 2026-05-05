import { Hono } from "hono";
import { access as accessAsync } from "node:fs/promises";
import * as questStore from "../quest-store.js";
import * as sessionNames from "../session-names.js";
import type { HerdSessionsResponse } from "../../shared/herd-types.js";
import { isValidQuestId } from "../../shared/quest-journey.js";
import {
  buildPeekResponse,
  buildPeekDefault,
  buildPeekRange,
  buildReadResponse,
  findTurnBoundaries,
  buildPeekTurnScan,
  grepMessageHistory,
  exportSessionAsText,
} from "../takode-messages.js";
import { buildLeaderContextResume } from "../takode-leader-context-resume.js";
import {
  getHerdDiagnostics as getHerdDiagnosticsController,
  markAllNotificationsDone as markAllNotificationsDoneController,
  markNotificationDone as markNotificationDoneController,
  notifyUser as notifyUserController,
  summarizePendingPermissions,
} from "../bridge/session-registry-controller.js";
import { getBoard as getBoardController } from "../bridge/board-watchdog-controller.js";
import {
  refreshGitInfoPublic as refreshGitInfoPublicController,
  setDiffBaseBranch as setDiffBaseBranchController,
} from "../bridge/session-git-state.js";
import { buildBoardRowSessionStatuses as buildBoardRowSessionStatusesController } from "../board-row-session-status.js";
import { getSettings } from "../settings-manager.js";
import {
  type BrowserIncomingMessage,
  type BrowserOutgoingMessage,
  type ThreadAttachmentUpdate,
  type ThreadAttachmentUpdateEntry,
  type ThreadRef,
} from "../session-types.js";
import {
  buildThreadAttachmentSelection,
  hasThreadAttachmentMarker,
  inferThreadAttachmentSourceRoute,
  inferThreadRouteFromTextContent,
  messageIdForThreadAttachment,
  routeKey,
  sameThreadRoute,
  threadRouteForTarget,
} from "../thread-routing-metadata.js";
import { isSessionIdleRuntime } from "../herd-event-dispatcher.js";
import type { RouteContext } from "./context.js";
import { loadQuestJourneyPhaseCatalog } from "../quest-journey-phases.js";
import { registerTakodeBoardRoutes } from "./takode-board.js";

const THREAD_ATTACHMENT_HISTORY_BROADCAST_DELAY_MS = 100;
const THREAD_ATTACHMENT_UPDATE_VERSION = 1;
const THREAD_ATTACHMENT_RECENT_HISTORY_LIMIT = 300;
const THREAD_ATTACHMENT_MAX_CHANGED_MESSAGES = 100;
const pendingThreadAttachmentHistoryBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();
const pendingThreadAttachmentUpdates = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; changedCount: number; updates: ThreadAttachmentUpdateEntry[] }
>();

function scheduleThreadAttachmentHistoryBroadcast(wsBridge: RouteContext["wsBridge"], sessionId: string): void {
  const existing = pendingThreadAttachmentHistoryBroadcasts.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingThreadAttachmentHistoryBroadcasts.delete(sessionId);
    const session = wsBridge.getSession(sessionId);
    if (!session) return;
    wsBridge.broadcastToSession(sessionId, { type: "message_history", messages: session.messageHistory });
  }, THREAD_ATTACHMENT_HISTORY_BROADCAST_DELAY_MS);
  pendingThreadAttachmentHistoryBroadcasts.set(sessionId, timer);
}

function normalizeAffectedThreadKey(threadKey: string | undefined): string | null {
  const normalized = threadKey?.trim().toLowerCase();
  if (!normalized) return null;
  return normalized;
}

function pendingThreadAttachmentChangedCount(sessionId: string): number {
  return pendingThreadAttachmentUpdates.get(sessionId)?.changedCount ?? 0;
}

function threadAttachmentEntryAttachedAt(update: ThreadAttachmentUpdateEntry): number | undefined {
  const markerAttachedAt = update.markers[0]?.attachedAt;
  if (typeof markerAttachedAt === "number") return markerAttachedAt;
  for (const message of update.changedMessages) {
    const refAttachedAt = message.threadRefs.find((ref) => typeof ref.attachedAt === "number")?.attachedAt;
    if (typeof refAttachedAt === "number") return refAttachedAt;
  }
  return undefined;
}

function threadAttachmentEntryAttachedBy(update: ThreadAttachmentUpdateEntry): string | undefined {
  const markerAttachedBy = update.markers[0]?.attachedBy;
  if (markerAttachedBy) return markerAttachedBy;
  for (const message of update.changedMessages) {
    const refAttachedBy = message.threadRefs.find((ref) => ref.attachedBy)?.attachedBy;
    if (refAttachedBy) return refAttachedBy;
  }
  return undefined;
}

function buildThreadAttachmentBoundError(input: {
  questId: string;
  historyLength: number;
  selectedIndices: number[];
  changedCount: number;
  pendingChangedCount: number;
}): Record<string, unknown> | null {
  const minAllowedIndex = Math.max(0, input.historyLength - THREAD_ATTACHMENT_RECENT_HISTORY_LIMIT);
  const validSelectedIndices = input.selectedIndices.filter((index) => index >= 0 && index < input.historyLength);
  const minSelectedIndex = validSelectedIndices[0];
  const maxSelectedIndex = validSelectedIndices[validSelectedIndices.length - 1];
  if (typeof minSelectedIndex === "number" && minSelectedIndex < minAllowedIndex) {
    return {
      error: "Thread attach range is outside the recent bounded update window",
      code: "THREAD_ATTACH_OUTSIDE_RECENT_WINDOW",
      questId: input.questId,
      historyLength: input.historyLength,
      minSelectedIndex,
      maxSelectedIndex,
      minAllowedIndex,
      maxDistanceFromTail: THREAD_ATTACHMENT_RECENT_HISTORY_LIMIT,
      maxChangedMessages: THREAD_ATTACHMENT_MAX_CHANGED_MESSAGES,
      suggestion: "Attach recent messages only.",
    };
  }
  if (input.pendingChangedCount + input.changedCount > THREAD_ATTACHMENT_MAX_CHANGED_MESSAGES) {
    return {
      error: "Thread attach selection exceeds the bounded update message limit",
      code: "THREAD_ATTACH_TOO_MANY_MESSAGES",
      questId: input.questId,
      changedMessages: input.changedCount,
      pendingChangedMessages: input.pendingChangedCount,
      maxChangedMessages: THREAD_ATTACHMENT_MAX_CHANGED_MESSAGES,
      maxDistanceFromTail: THREAD_ATTACHMENT_RECENT_HISTORY_LIMIT,
      suggestion: "Attach fewer messages in this recent burst.",
    };
  }
  return null;
}

function scheduleThreadAttachmentUpdateBroadcast(
  wsBridge: RouteContext["wsBridge"],
  sessionId: string,
  update: ThreadAttachmentUpdateEntry,
): void {
  const existing = pendingThreadAttachmentUpdates.get(sessionId);
  if (existing) clearTimeout(existing.timer);

  const updates = [...(existing?.updates ?? []), update];
  const changedCount = (existing?.changedCount ?? 0) + update.changedMessages.length;
  const timer = setTimeout(() => {
    pendingThreadAttachmentUpdates.delete(sessionId);
    const session = wsBridge.getSession(sessionId);
    if (!session) return;
    const timestamp = Date.now();
    const affectedThreadKeys = new Set<string>(["main"]);
    for (const item of updates) {
      const target = normalizeAffectedThreadKey(item.target.threadKey);
      const targetQuest = normalizeAffectedThreadKey(item.target.questId);
      const source = normalizeAffectedThreadKey(item.source?.threadKey);
      const sourceQuest = normalizeAffectedThreadKey(item.source?.questId);
      if (target) affectedThreadKeys.add(target);
      if (targetQuest) affectedThreadKeys.add(targetQuest);
      if (source) affectedThreadKeys.add(source);
      if (sourceQuest) affectedThreadKeys.add(sourceQuest);
    }
    const markerIds = updates.flatMap((item) => item.markers.map((marker) => marker.id));
    const event: ThreadAttachmentUpdate = {
      type: "thread_attachment_update",
      version: THREAD_ATTACHMENT_UPDATE_VERSION,
      updateId: `thread-attachment-update:${timestamp}:${markerIds.join(",") || changedCount}`,
      timestamp,
      attachedAt: threadAttachmentEntryAttachedAt(updates[0]!) ?? timestamp,
      attachedBy: threadAttachmentEntryAttachedBy(updates[0]!) ?? "",
      historyLength: session.messageHistory.length,
      affectedThreadKeys: [...affectedThreadKeys],
      maxDistanceFromTail: THREAD_ATTACHMENT_RECENT_HISTORY_LIMIT,
      maxChangedMessages: THREAD_ATTACHMENT_MAX_CHANGED_MESSAGES,
      updates,
    };
    wsBridge.broadcastToSession(sessionId, event);
  }, THREAD_ATTACHMENT_HISTORY_BROADCAST_DELAY_MS);
  pendingThreadAttachmentUpdates.set(sessionId, { timer, changedCount, updates });
}

export function _resetThreadAttachmentHistoryBroadcastsForTest(): void {
  for (const timer of pendingThreadAttachmentHistoryBroadcasts.values()) {
    clearTimeout(timer);
  }
  pendingThreadAttachmentHistoryBroadcasts.clear();
  for (const pending of pendingThreadAttachmentUpdates.values()) {
    clearTimeout(pending.timer);
  }
  pendingThreadAttachmentUpdates.clear();
}

export function createTakodeRoutes(ctx: RouteContext) {
  const api = new Hono();
  const bridgeAny = ctx.wsBridge as any;
  const { launcher, wsBridge, authenticateTakodeCaller, resolveId, timerManager, pushoverNotifier } = ctx;
  type BridgeSession = NonNullable<ReturnType<typeof wsBridge.getSession>>;
  type LeaderAnswerTarget =
    | {
        kind: "permission";
        request_id: string;
        tool_name: string;
        timestamp: number;
        msg_index?: number;
        threadKey?: string;
        questId?: string;
        input: Record<string, unknown>;
        questions?: unknown;
        plan?: unknown;
        allowedPrompts?: unknown;
      }
    | {
        kind: "notification";
        notification_id: string;
        tool_name: "takode.notify";
        timestamp: number;
        msg_index?: number;
        threadKey?: string;
        questId?: string;
        summary?: string;
        suggestedAnswers?: string[];
        messageId: string | null;
      };
  type LeaderAnswerTargetSelection =
    | { kind: "oldest" }
    | { kind: "msg_index"; msg_index: number }
    | { kind: "target_id"; target_id: string }
    | { kind: "thread"; threadKey: string };
  type LeaderPermissionResponse = Extract<BrowserOutgoingMessage, { type: "permission_response" }>;

  const resolveReportedPermissionMode = (
    launcherMode: string | undefined,
    bridgeMode: string | null | undefined,
  ): string | null => {
    if (typeof bridgeMode === "string" && bridgeMode.trim() && bridgeMode !== "default") {
      return bridgeMode;
    }
    if (typeof launcherMode === "string" && launcherMode.trim()) {
      return launcherMode;
    }
    return bridgeMode || null;
  };
  const isBridgeSessionBusy = (session: BridgeSession | null | undefined): boolean =>
    !!session && (session.isGenerating || session.pendingPermissions.size > 0);
  const routeLeaderPermissionResponse = async (
    sessionId: string,
    session: BridgeSession,
    msg: LeaderPermissionResponse,
    actorSessionId: string,
  ): Promise<boolean> => {
    if (typeof bridgeAny.routeExternalPermissionResponse === "function") {
      await bridgeAny.routeExternalPermissionResponse(session, msg, actorSessionId);
      return true;
    }
    if (typeof bridgeAny.handleBrowserMessage === "function") {
      await bridgeAny.handleBrowserMessage(
        { data: { kind: "browser", sessionId }, send: () => {}, close: () => {}, readyState: 1 },
        JSON.stringify({ ...msg, actorSessionId }),
      );
      return true;
    }
    if (typeof bridgeAny.routeBrowserMessage === "function") {
      await bridgeAny.routeBrowserMessage(session, {
        ...msg,
        actorSessionId,
      });
      return true;
    }
    return false;
  };
  const notificationRouteDeps = {
    isHerdedWorkerSession: (session: BridgeSession) => !!launcher.getSession(session.id)?.herdedBy,
    getLauncherSessionInfo: (sessionId: string) => launcher.getSession(sessionId),
    broadcastToBrowsers: (session: BridgeSession, msg: unknown) => wsBridge.broadcastToSession(session.id, msg as any),
    persistSession: (session: BridgeSession) => wsBridge.persistSessionById(session.id),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      wsBridge.emitTakodeEvent(sessionId, type as any, data as any),
    scheduleNotification: (
      sessionId: string,
      category: "question" | "completed",
      detail: string,
      options?: { skipReadCheck?: boolean },
    ) => pushoverNotifier?.scheduleNotification(sessionId, category, detail, undefined, options),
  };
  const notificationPersistDeps = {
    broadcastToBrowsers: (session: BridgeSession, msg: unknown) => wsBridge.broadcastToSession(session.id, msg as any),
    broadcastBoard: (
      session: BridgeSession,
      board: import("../session-types.js").BoardRow[],
      completedBoard: import("../session-types.js").BoardRow[],
    ) => broadcastBoardUpdate(session, board, completedBoard),
    persistSession: (session: BridgeSession) => wsBridge.persistSessionById(session.id),
  };
  const boardWatchdogDeps = {
    getLauncherSessionInfo: (sessionId: string) => launcher.getSession(sessionId),
    getSession: (sessionId: string) => wsBridge.getSession(sessionId),
    listSessions: () => launcher.listSessions(),
    resolveSessionId: (ref: string) => launcher.resolveSessionId(ref) ?? undefined,
    timerCount: (sessionId: string) => timerManager?.listTimers(sessionId).length ?? 0,
    backendConnected: (session: BridgeSession) => wsBridge.isBackendConnected(session.id),
    getBoard: (sessionId: string) => {
      const session = wsBridge.getSession(sessionId);
      return session ? getBoardController(session) : [];
    },
    notifyUser: (sessionId: string, category: "needs-input" | "review", summary: string) => {
      const session = wsBridge.getSession(sessionId);
      return session
        ? notifyUserController(session, category, summary, notificationRouteDeps)
        : { ok: false as const, error: "Session not found" };
    },
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      wsBridge.emitTakodeEvent(sessionId, type as any, data as any),
    markNotificationDone: (sessionId: string, notifId: string, done: boolean) => {
      const session = wsBridge.getSession(sessionId);
      return session ? markNotificationDoneController(session, notifId, done, notificationPersistDeps) : false;
    },
    isSessionIdle: (sessionId: string) => isSessionIdleRuntime(wsBridge.getSession(sessionId) as any),
  };
  const workBoardStateDeps = {
    getBoardDispatchableSignature: (session: BridgeSession, questId: string) =>
      wsBridge.getBoardDispatchableSignature(session.id, questId),
    markNotificationDone: boardWatchdogDeps.markNotificationDone,
    broadcastBoard: (
      session: BridgeSession,
      board: import("../session-types.js").BoardRow[],
      completedBoard: import("../session-types.js").BoardRow[],
    ) => broadcastBoardUpdate(session, board, completedBoard),
    broadcastAttentionRecords: (
      session: BridgeSession,
      attentionRecords: import("../session-types.js").SessionAttentionRecord[],
    ) =>
      wsBridge.broadcastToSession(session.id, {
        type: "attention_records_update",
        attentionRecords,
      } as any),
    persistSession: (session: BridgeSession) => wsBridge.persistSessionById(session.id),
    notifyReview: (sessionId: string, summary: string) => {
      const session = wsBridge.getSession(sessionId);
      if (session) notifyUserController(session, "review", summary, notificationRouteDeps);
    },
  };
  const getSessionGitDeps = () => bridgeAny.getSessionGitStateDeps?.();
  const setDiffBaseBranch = (sessionId: string, branch: string): boolean => {
    const session = wsBridge.getSession(sessionId);
    const deps = getSessionGitDeps();
    if (session && deps) {
      setDiffBaseBranchController(session as any, branch, deps);
      return true;
    }
    return bridgeAny.setDiffBaseBranch?.(sessionId, branch) ?? false;
  };
  const refreshGitInfoPublic = async (
    sessionId: string,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean } = {},
  ): Promise<boolean> => {
    const session = wsBridge.getSession(sessionId);
    const deps = getSessionGitDeps();
    if (session && deps) {
      await refreshGitInfoPublicController(session as any, deps, options);
      return true;
    }
    return (await bridgeAny.refreshGitInfoPublic?.(sessionId, options)) ?? false;
  };

  const buildEnrichedSessions = async (filterFn?: (s: ReturnType<typeof launcher.listSessions>[number]) => boolean) => {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const pool = filterFn ? sessions.filter(filterFn) : sessions;
    const heavyRepoModeEnabled = getSettings().heavyRepoModeEnabled;
    return Promise.all(
      pool.map(async (s) => {
        const pendingTimerCount = timerManager?.listTimers(s.sessionId).length ?? 0;
        try {
          const { sessionAuthToken: _token, ...safeSession } = s;
          const bridgeSession = wsBridge.getSession(s.sessionId);
          if (bridgeSession?.state?.is_worktree && !safeSession.archived && !heavyRepoModeEnabled) {
            await wsBridge.refreshWorktreeGitStateForSnapshot(s.sessionId, {
              broadcastUpdate: true,
              notifyPoller: true,
            });
          }
          const currentBridgeSession = wsBridge.getSession(s.sessionId) ?? bridgeSession;
          const bridge = currentBridgeSession?.state;
          const attention = currentBridgeSession
            ? {
                lastReadAt: currentBridgeSession.lastReadAt,
                attentionReason: currentBridgeSession.attentionReason,
                pendingPermissionSummary: summarizePendingPermissions(currentBridgeSession),
              }
            : null;
          const cliConnected = wsBridge.isBackendConnected(s.sessionId);
          const effectiveState = cliConnected && currentBridgeSession?.isGenerating ? "running" : safeSession.state;
          return {
            ...safeSession,
            state: effectiveState,
            sessionNum: launcher.getSessionNum(s.sessionId) ?? null,
            name: names[s.sessionId] ?? s.name,
            pendingTimerCount,
            gitBranch: bridge?.git_branch || "",
            gitDefaultBranch: bridge?.git_default_branch || "",
            diffBaseBranch: bridge?.diff_base_branch || "",
            gitAhead: bridge?.git_ahead || 0,
            gitBehind: bridge?.git_behind || 0,
            totalLinesAdded: bridge?.total_lines_added || 0,
            totalLinesRemoved: bridge?.total_lines_removed || 0,
            gitStatusRefreshedAt: bridge?.git_status_refreshed_at,
            gitStatusRefreshError: bridge?.git_status_refresh_error ?? null,
            lastMessagePreview: currentBridgeSession?.lastUserMessage || "",
            cliConnected,
            taskHistory: currentBridgeSession?.taskHistory ?? [],
            keywords: currentBridgeSession?.keywords ?? [],
            claimedQuestId: bridge?.claimedQuestId ?? null,
            claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
            claimedQuestVerificationInboxUnread: bridge?.claimedQuestVerificationInboxUnread,
            ...(attention ?? {}),
            ...(s.isWorktree && s.archived
              ? await (async () => {
                  let exists = false;
                  try {
                    await accessAsync(s.cwd);
                    exists = true;
                  } catch {
                    /* not found */
                  }
                  return { worktreeExists: exists };
                })()
              : {}),
          };
        } catch (e) {
          console.warn(`[routes] Failed to enrich session ${s.sessionId}:`, e);
          return { ...s, name: names[s.sessionId] ?? s.name, pendingTimerCount };
        }
      }),
    );
  };
  type EnrichedSession = Awaited<ReturnType<typeof buildEnrichedSessions>>[number];

  const findMessageIndexById = (session: BridgeSession, messageId: string | null | undefined): number | undefined => {
    if (!messageId) return undefined;
    for (let i = session.messageHistory.length - 1; i >= 0; i--) {
      const entry = session.messageHistory[i];
      if (entry.type === "assistant" && entry.message?.id === messageId) return i;
    }
    return undefined;
  };

  const parseNotificationNumericId = (notificationId: string): number | null => {
    const match = /^n-(\d+)$/.exec(notificationId);
    return match ? Number.parseInt(match[1], 10) : null;
  };

  const normalizeNeedsInputNotificationId = (value: unknown): string | null => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return `n-${value}`;
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numericId = Number.parseInt(trimmed, 10);
      return numericId > 0 ? `n-${numericId}` : null;
    }
    const numericId = parseNotificationNumericId(trimmed.toLowerCase());
    return numericId !== null ? `n-${numericId}` : null;
  };

  const normalizeSuggestedAnswers = (
    value: unknown,
    category: "needs-input" | "review",
  ): { ok: true; answers: string[] } | { ok: false; error: string } => {
    if (value === undefined || value === null) return { ok: true, answers: [] };
    if (!Array.isArray(value)) return { ok: false, error: "suggestedAnswers must be an array of strings" };
    if (value.length === 0) return { ok: true, answers: [] };
    if (category !== "needs-input") {
      return { ok: false, error: "suggestedAnswers are only supported for needs-input notifications" };
    }
    if (value.length > 3) return { ok: false, error: "suggestedAnswers may include at most 3 options" };

    const seen = new Set<string>();
    const answers: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") return { ok: false, error: "suggestedAnswers must be strings" };
      const answer = entry.trim().replace(/\s+/g, " ");
      if (!answer) return { ok: false, error: "suggestedAnswers entries must be nonempty" };
      if (answer.length > 32) return { ok: false, error: "suggestedAnswers entries must be 32 characters or less" };
      const key = answer.toLocaleLowerCase();
      if (seen.has(key)) return { ok: false, error: "suggestedAnswers entries must be unique" };
      seen.add(key);
      answers.push(answer);
    }
    return { ok: true, answers };
  };

  const buildSelfNeedsInputNotifications = (session: BridgeSession) => {
    const unresolved: Array<{
      notificationId: number;
      rawNotificationId: string;
      summary?: string;
      suggestedAnswers?: string[];
      timestamp: number;
      messageId: string | null;
    }> = [];
    let resolvedCount = 0;

    for (const notification of session.notifications ?? []) {
      if (notification.category !== "needs-input") continue;
      const numericId = parseNotificationNumericId(notification.id);
      if (numericId === null) continue;
      if (notification.done) {
        resolvedCount += 1;
        continue;
      }
      unresolved.push({
        notificationId: numericId,
        rawNotificationId: notification.id,
        summary: notification.summary,
        ...(notification.suggestedAnswers?.length ? { suggestedAnswers: notification.suggestedAnswers } : {}),
        timestamp: notification.timestamp,
        messageId: notification.messageId,
      });
    }

    unresolved.sort((a, b) => a.notificationId - b.notificationId);
    return { notifications: unresolved, resolvedCount };
  };

  const getBoardStatusSessions = () =>
    launcher.listSessions().map((session) => {
      const bridgeSession = wsBridge.getSession(session.sessionId);
      const cliConnected = wsBridge.isBackendConnected(session.sessionId);
      return {
        sessionId: session.sessionId,
        sessionNum: launcher.getSessionNum(session.sessionId) ?? null,
        reviewerOf: session.reviewerOf,
        archived: session.archived,
        state: cliConnected && bridgeSession?.isGenerating ? "running" : session.state,
        cliConnected,
        name: sessionNames.getName(session.sessionId) ?? session.name,
      };
    });

  const buildBoardRowSessionStatuses = async (rows: import("../session-types.js").BoardRow[]) => {
    if (rows.length === 0) return {};
    return buildBoardRowSessionStatusesController(rows, getBoardStatusSessions());
  };

  const broadcastBoardUpdate = (
    session: BridgeSession,
    board: import("../session-types.js").BoardRow[],
    completedBoard: import("../session-types.js").BoardRow[],
  ) =>
    wsBridge.broadcastToSession(session.id, {
      type: "board_updated",
      board,
      completedBoard,
      rowSessionStatuses: buildBoardRowSessionStatusesController(
        [...board, ...completedBoard],
        getBoardStatusSessions(),
      ),
    } as any);

  api.get("/takode/me", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    return c.json({
      sessionId: auth.callerId,
      sessionNum: launcher.getSessionNum(auth.callerId) ?? null,
      isOrchestrator: auth.caller.isOrchestrator === true,
      state: auth.caller.state,
      backendType: auth.caller.backendType || "claude",
    });
  });

  api.get("/takode/quest-journey-phases", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const phases = await loadQuestJourneyPhaseCatalog();
    return c.json({ phases });
  });

  api.get("/takode/sessions", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    const enriched = await buildEnrichedSessions();
    return c.json(enriched);
  });

  // ─── Takode: Session Info ──────────────────────────────────

  api.get("/sessions/:id/info", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const session = launcher.getSession(sessionId);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const bridgeSession = wsBridge.getSession(sessionId);
    if (bridgeSession?.state?.is_worktree && !session.archived) {
      await wsBridge.refreshWorktreeGitStateForSnapshot(sessionId, {
        broadcastUpdate: true,
        notifyPoller: true,
      });
    }
    const currentBridgeSession = wsBridge.getSession(sessionId) ?? bridgeSession;
    const bridge = currentBridgeSession?.state;
    const names = sessionNames.getAllNames();
    const { sessionAuthToken: _token, ...safeSession } = session;

    // Compute actual turn count from message history (bridge?.num_turns is the CLI's
    // internal counter which resets on compaction and doesn't reflect true turn count)
    const infoHistory = currentBridgeSession?.messageHistory ?? null;
    const actualNumTurns =
      infoHistory && infoHistory.length > 0 ? findTurnBoundaries(infoHistory).length : bridge?.num_turns || 0;
    const attention = currentBridgeSession
      ? {
          lastReadAt: currentBridgeSession.lastReadAt,
          attentionReason: currentBridgeSession.attentionReason,
          pendingPermissionSummary: summarizePendingPermissions(currentBridgeSession),
        }
      : null;

    return c.json({
      ...safeSession,
      sessionNum: launcher.getSessionNum(sessionId) ?? null,
      name: names[sessionId] ?? session.name ?? null,
      cliConnected: wsBridge.isBackendConnected(sessionId),
      isGenerating: isBridgeSessionBusy(currentBridgeSession),
      // Bridge-derived state
      gitBranch: bridge?.git_branch || null,
      gitHeadSha: bridge?.git_head_sha || null,
      gitDefaultBranch: bridge?.git_default_branch || null,
      diffBaseBranch: bridge?.diff_base_branch || null,
      gitAhead: bridge?.git_ahead || 0,
      gitBehind: bridge?.git_behind || 0,
      totalLinesAdded: bridge?.total_lines_added || 0,
      totalLinesRemoved: bridge?.total_lines_removed || 0,
      gitStatusRefreshedAt: bridge?.git_status_refreshed_at,
      gitStatusRefreshError: bridge?.git_status_refresh_error ?? null,
      totalCostUsd: bridge?.total_cost_usd || 0,
      numTurns: actualNumTurns,
      contextUsedPercent: bridge?.context_used_percent || 0,
      isCompacting: bridge?.is_compacting || false,
      permissionMode: resolveReportedPermissionMode(session.permissionMode, bridge?.permissionMode),
      tools: bridge?.tools || [],
      mcpServers: bridge?.mcp_servers || [],
      claudeCodeVersion: bridge?.claude_code_version || null,
      claimedQuestId: bridge?.claimedQuestId ?? null,
      claimedQuestTitle: bridge?.claimedQuestTitle ?? null,
      claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
      claimedQuestVerificationInboxUnread: bridge?.claimedQuestVerificationInboxUnread,
      uiMode: bridge?.uiMode ?? null,
      pendingTimerCount: timerManager?.listTimers(sessionId).length ?? 0,
      ...(attention ?? {}),
      taskHistory: currentBridgeSession?.taskHistory ?? [],
      keywords: currentBridgeSession?.keywords ?? [],
    });
  });

  api.get("/sessions/:id/leader-context-resume", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const launcherSession = launcher.getSession(sessionId);
    const bridgeSession = wsBridge.getSession(sessionId);
    if (!launcherSession || !bridgeSession) return c.json({ error: "Session not found" }, 404);

    const isLeaderSession = launcherSession.isOrchestrator === true || bridgeSession.state?.isOrchestrator === true;
    if (!isLeaderSession) {
      return c.json(
        {
          error:
            "Session is not recognized as a leader/orchestrator session; takode leader-context-resume only supports leader sessions.",
        },
        409,
      );
    }

    const board = getBoardController(bridgeSession);
    const rowSessionStatuses = await buildBoardRowSessionStatuses(board);
    const participantIds = new Set<string>();
    for (const row of board) {
      if (row.worker) participantIds.add(row.worker);
      const status = rowSessionStatuses[row.questId];
      if (status?.worker?.sessionId) participantIds.add(status.worker.sessionId);
      if (status?.reviewer?.sessionId) participantIds.add(status.reviewer.sessionId);
    }

    const participants = new Map<string, import("../takode-leader-context-resume.js").LeaderContextResumeParticipant>();
    for (const participantId of participantIds) {
      const participantLauncher = launcher.getSession(participantId);
      if (!participantLauncher) continue;
      const participantBridge = wsBridge.getSession(participantId);
      const participantStatus = participantBridge
        ? wsBridge.isBackendConnected(participantId)
          ? participantBridge.isGenerating
            ? "running"
            : "idle"
          : "disconnected"
        : participantLauncher.archived
          ? "archived"
          : "missing";
      const participantSessionNum = launcher.getSessionNum(participantId) ?? null;
      const participantState =
        (participantBridge?.state as
          | {
              claimedQuestId?: string | null;
              claimedQuestStatus?: string | null;
              claimedQuestVerificationInboxUnread?: boolean;
            }
          | undefined) ?? {};
      const role = participantLauncher.reviewerOf != null ? "reviewer" : "worker";
      participants.set(participantId, {
        sessionId: participantId,
        sessionNum: participantSessionNum,
        name: sessionNames.getName(participantId) ?? participantLauncher.name ?? null,
        role,
        status: participantStatus,
        claimedQuestId: participantState.claimedQuestId ?? null,
        claimedQuestStatus: participantState.claimedQuestStatus ?? null,
        verificationInboxUnread: participantState.claimedQuestVerificationInboxUnread,
        messageHistory: participantBridge?.messageHistory ?? [],
      });
    }

    const model = await buildLeaderContextResume({
      leader: {
        sessionId,
        sessionNum: launcher.getSessionNum(sessionId) ?? null,
        name: sessionNames.getName(sessionId) ?? launcherSession.name ?? null,
        isOrchestrator: true,
        messageHistory: bridgeSession.messageHistory ?? [],
        notifications: bridgeSession.notifications ?? [],
        board,
      },
      rowSessionStatuses,
      participants,
      loadQuest: (questId: string) => questStore.getQuest(questId),
    });

    return c.json(model);
  });

  // ─── Takode: Message Peek & Read ────────────────────────────

  api.get("/sessions/:id/messages", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const history = wsBridge.getSession(sessionId)?.messageHistory ?? null;
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const sessionNum = launcher.getSessionNum(sessionId) ?? -1;
    const sessionName = sessionNames.getName(sessionId) || sessionId.slice(0, 8);
    const cliConnected = wsBridge.isBackendConnected(sessionId);

    // Derive status: check bridge session for generation state
    const bridgeSession = wsBridge.getSession(sessionId);
    let status: "idle" | "running" | "disconnected" = "disconnected";
    if (cliConnected) {
      status = bridgeSession?.isGenerating ? "running" : "idle";
    }

    // Quest info from the bridge session state (set via quest claiming)
    const sessionState = bridgeSession?.state;
    const quest = sessionState?.claimedQuestId
      ? {
          id: sessionState.claimedQuestId,
          title: sessionState.claimedQuestTitle || "",
          status: sessionState.claimedQuestStatus || "",
          verificationInboxUnread: sessionState.claimedQuestVerificationInboxUnread,
        }
      : null;

    const base = {
      sid: sessionId,
      sn: sessionNum,
      name: sessionName,
      status,
      quest,
      pendingTimerCount: timerManager?.listTimers(sessionId).length ?? 0,
    };

    // ── Mode detection ──
    const fromParam = c.req.query("from");
    const untilParam = c.req.query("until");
    const detail = c.req.query("detail") === "true";
    const turnParam = c.req.query("turn");
    const scanMode = c.req.query("scan");

    // Turn scan mode: paginated collapsed turn summaries (used by `takode scan`)
    if (scanMode === "turns") {
      const fromTurn = parseInt(c.req.query("fromTurn") ?? "0", 10);
      const turnCount = parseInt(c.req.query("turnCount") ?? "50", 10);
      return c.json({ ...base, ...buildPeekTurnScan(history, { fromTurn, turnCount }, sessionId) });
    }

    // Turn mode: resolve turn number to message range, then use range mode
    if (turnParam !== undefined) {
      const turnNum = parseInt(turnParam, 10);
      if (isNaN(turnNum) || turnNum < 0) return c.json({ error: "turn must be a non-negative integer" }, 400);

      const allTurns = findTurnBoundaries(history);
      if (turnNum >= allTurns.length) {
        return c.json(
          { error: `Turn ${turnNum} not found. Session has ${allTurns.length} turns (0-${allTurns.length - 1}).` },
          404,
        );
      }

      const turn = allTurns[turnNum];
      const endIdx = turn.endIdx >= 0 ? turn.endIdx : history.length - 1;
      const showTools = c.req.query("showTools") === "true";
      return c.json({
        ...base,
        ...buildPeekRange(history, { from: turn.startIdx, until: endIdx, showTools }, sessionId),
      });
    }

    if (fromParam !== undefined || untilParam !== undefined) {
      // Range browsing mode: page forward from `from`, backward from `until`,
      // or browse an explicit inclusive range when both are present.
      const from = fromParam !== undefined ? parseInt(fromParam, 10) : undefined;
      const until = untilParam !== undefined ? parseInt(untilParam, 10) : undefined;
      const count = parseInt(c.req.query("count") ?? "60", 10);
      const showTools = c.req.query("showTools") === "true";
      return c.json({ ...base, ...buildPeekRange(history, { from, until, count, showTools }, sessionId) });
    }

    if (detail) {
      // Detail mode: legacy full-detail behavior
      const turns = parseInt(c.req.query("turns") ?? "1", 10);
      const since = parseInt(c.req.query("since") ?? "0", 10);
      const full = c.req.query("full") === "true";
      return c.json({
        ...base,
        ...{ mode: "detail" as const, turns: buildPeekResponse(history, { turns, since, full }, sessionId) },
      });
    }

    // Default mode: smart overview (collapsed recent turns + expanded last turn)
    const collapsedCount = parseInt(c.req.query("collapsed") ?? "5", 10);
    const expandLimit = parseInt(c.req.query("expand") ?? "10", 10);
    return c.json({ ...base, ...buildPeekDefault(history, { collapsedCount, expandLimit }, sessionId) });
  });

  api.get("/sessions/:id/messages/:idx", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const idx = parseInt(c.req.param("idx"), 10);
    if (isNaN(idx)) return c.json({ error: "Invalid message index" }, 400);

    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = parseInt(c.req.query("limit") ?? "200", 10);

    const history = wsBridge.getSession(sessionId)?.messageHistory ?? null;
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const result = buildReadResponse(
      history,
      idx,
      {
        offset,
        limit,
        getToolResult: (toolUseId) => wsBridge.getToolResult(sessionId, toolUseId),
      },
      sessionId,
    );
    if (!result) {
      return c.json({ error: `Message index ${idx} out of range (0-${history.length - 1})` }, 404);
    }

    return c.json(result);
  });

  // ─── Takode: Grep (within-session search) ────────────────────

  api.get("/sessions/:id/grep", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const history = wsBridge.getSession(sessionId)?.messageHistory ?? null;
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const query = (c.req.query("q") || "").trim();
    if (!query) return c.json({ error: "Query parameter 'q' is required" }, 400);

    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const type = c.req.query("type") || undefined;
    const results = grepMessageHistory(history, query, { limit, type }, sessionId);

    return c.json({ sessionId, sessionNum: launcher.getSessionNum(sessionId) ?? -1, query, ...results });
  });

  // ─── Takode: Export (dump session to text) ───────────────────

  api.get("/sessions/:id/export", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const history = wsBridge.getSession(sessionId)?.messageHistory ?? null;
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const text = exportSessionAsText(history, sessionId);
    const totalTurns = findTurnBoundaries(history).length;

    return c.json({ sessionId, totalMessages: history.length, totalTurns, text });
  });

  // ─── Cross-session messaging ───────────────────────────────────────

  api.post("/sessions/:id/message", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.archived) {
      return c.json({ error: "Cannot send to archived session" }, 409);
    }
    // Allow exited/disconnected sessions (including idle-killed ones) —
    // injectUserMessage will queue the message, clear killedByIdleManager,
    // and trigger a relaunch, matching the browser chat UI behavior.
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    const rawThreadKey =
      typeof body.threadKey === "string"
        ? body.threadKey.trim()
        : typeof body.thread_key === "string"
          ? body.thread_key.trim()
          : typeof body.questId === "string"
            ? body.questId.trim()
            : "";
    const explicitRoute = rawThreadKey ? threadRouteForTarget(rawThreadKey) : null;
    if (rawThreadKey && routeKey(explicitRoute) === "main" && rawThreadKey.trim().toLowerCase() !== "main") {
      return c.json({ error: "threadKey must be main or q-N" }, 400);
    }
    const threadRoute = explicitRoute ?? inferThreadRouteFromTextContent(body.content) ?? undefined;
    // Validate optional agentSource label from callers.
    let sessionLabel: string | undefined;
    if (body.agentSource && typeof body.agentSource === "object") {
      if (typeof body.agentSource.sessionId === "string" && body.agentSource.sessionId.trim()) {
        const claimed = resolveId(body.agentSource.sessionId.trim());
        if (!claimed || claimed !== auth.callerId) {
          return c.json({ error: "agentSource.sessionId does not match authenticated caller" }, 403);
        }
      }
      if (typeof body.agentSource.sessionLabel === "string" && body.agentSource.sessionLabel.trim()) {
        sessionLabel = body.agentSource.sessionLabel;
      }
    }
    const agentSource = { sessionId: auth.callerId, ...(sessionLabel ? { sessionLabel } : {}) };

    // Herd guard: if the target session is herded, only its leader can send messages.
    if (session.herdedBy) {
      if (auth.callerId !== session.herdedBy) {
        return c.json({ error: "Session is herded — only its leader can send messages" }, 403);
      }
    }
    const delivery = wsBridge.injectUserMessage(id, body.content, agentSource, undefined, threadRoute);
    if (delivery === "no_session") return c.json({ error: "Session not found in bridge" }, 404);
    return c.json({ ok: true, sessionId: id, delivery });
  });

  api.post("/sessions/:id/user-message", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only publish a user-visible message from your own session" }, 403);
    }
    const launcherSession = launcher.getSession(id);
    if (!launcherSession) return c.json({ error: "Session not found" }, 404);
    if (!launcherSession.isOrchestrator) {
      return c.json({ error: "Session is not an orchestrator" }, 403);
    }
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }

    const timestamp = Date.now();
    const message: BrowserIncomingMessage = {
      type: "leader_user_message",
      id: `leader-user-${timestamp}-${session.messageHistory.length}`,
      content: body.content,
      timestamp,
    };
    session.messageHistory.push(message);
    wsBridge.broadcastToSession(id, message);
    wsBridge.persistSessionById(id);
    return c.json({ ok: true, sessionId: id, messageId: message.id });
  });

  api.post("/sessions/:id/thread/attach", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only attach thread history from your own leader session" }, 403);
    }
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const questId = typeof body.questId === "string" ? body.questId.trim().toLowerCase() : "";
    if (!isValidQuestId(questId)) {
      return c.json({ error: "questId must match q-N format" }, 400);
    }

    const indices = new Set<number>();
    if (Number.isInteger(body.message)) indices.add(body.message);
    if (Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (!Number.isInteger(message)) return c.json({ error: "messages must contain integer message indices" }, 400);
        indices.add(message);
      }
    }
    if (typeof body.range === "string") {
      const match = /^(\d+)-(\d+)$/.exec(body.range.trim());
      if (!match) return c.json({ error: "range must use start-end message indices" }, 400);
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (end < start) return c.json({ error: "range end must be greater than or equal to start" }, 400);
      for (let index = start; index <= end; index++) indices.add(index);
    }
    if (Number.isInteger(body.turn)) {
      const turn = findTurnBoundaries(session.messageHistory)[body.turn];
      if (!turn) {
        return c.json({ error: "turn is out of range" }, 400);
      }
      const end = turn.endIdx >= 0 ? turn.endIdx : session.messageHistory.length - 1;
      for (let index = turn.startIdx; index <= end; index++) indices.add(index);
    }
    if (indices.size === 0) {
      return c.json({ error: "Provide --message <index>, --range <start-end>, or --turn <turn>" }, 400);
    }

    const sortedIndices = [...indices].sort((a, b) => a - b);
    const sourceRoute = inferThreadAttachmentSourceRoute(session.messageHistory, questId, sortedIndices);
    const ref: ThreadRef = {
      threadKey: questId,
      questId,
      source: "backfill",
      attachedAt: Date.now(),
      attachedBy: auth.callerId,
    };
    const attached: number[] = [];
    const alreadyAttached: number[] = [];
    const outOfRange: number[] = [];
    for (const index of sortedIndices) {
      const entry = session.messageHistory[index];
      if (!entry) {
        outOfRange.push(index);
        continue;
      }
      const existing = entry.threadRefs ?? [];
      if (!existing.some((item) => item.threadKey.toLowerCase() === questId)) {
        attached.push(index);
      } else {
        alreadyAttached.push(index);
      }
    }
    if (attached.length === 0 && alreadyAttached.length === 0) {
      return c.json({ error: "No message indices were in range", outOfRange }, 400);
    }
    const boundError = buildThreadAttachmentBoundError({
      questId,
      historyLength: session.messageHistory.length,
      selectedIndices: sortedIndices,
      changedCount: attached.length,
      pendingChangedCount: pendingThreadAttachmentChangedCount(id),
    });
    if (boundError) {
      return c.json(boundError, 400);
    }

    for (const index of attached) {
      const entry = session.messageHistory[index];
      if (!entry) continue;
      entry.threadRefs = [...(entry.threadRefs ?? []), ref];
    }

    let marker: BrowserIncomingMessage | undefined;
    let markerHistoryIndex: number | undefined;
    if (attached.length > 0) {
      const selection = buildThreadAttachmentSelection(session.messageHistory, questId, attached);
      if (!hasThreadAttachmentMarker(session.messageHistory, selection.markerKey)) {
        const timestamp = Date.now();
        markerHistoryIndex = session.messageHistory.length;
        marker = {
          type: "thread_attachment_marker",
          id: `thread-attachment-${timestamp}-${markerHistoryIndex}`,
          timestamp,
          markerKey: selection.markerKey,
          ...(sourceRoute ? { sourceThreadKey: sourceRoute.threadKey } : {}),
          ...(sourceRoute?.questId ? { sourceQuestId: sourceRoute.questId } : {}),
          threadKey: questId,
          questId,
          attachedAt: timestamp,
          attachedBy: auth.callerId,
          messageIds: selection.messageIds,
          messageIndices: selection.indices,
          ranges: selection.ranges,
          count: selection.indices.length,
          firstMessageId: selection.firstMessageId,
          firstMessageIndex: selection.firstMessageIndex,
        };
        session.messageHistory.push(marker);
      }
    }

    if (attached.length > 0) {
      const changedMessages = attached.map((historyIndex) => {
        const entry = session.messageHistory[historyIndex]!;
        return {
          historyIndex,
          messageId: messageIdForThreadAttachment(entry, historyIndex),
          threadRefs: entry.threadRefs ?? [],
        };
      });
      scheduleThreadAttachmentUpdateBroadcast(wsBridge, id, {
        target: { threadKey: questId, questId },
        ...(sourceRoute
          ? {
              source: {
                threadKey: sourceRoute.threadKey,
                ...(sourceRoute.questId ? { questId: sourceRoute.questId } : {}),
              },
            }
          : {}),
        markers: marker && marker.type === "thread_attachment_marker" ? [marker] : [],
        markerHistoryIndices: typeof markerHistoryIndex === "number" ? [markerHistoryIndex] : [],
        changedMessages,
        ranges: marker && marker.type === "thread_attachment_marker" ? marker.ranges : [],
        count: attached.length,
      });
      wsBridge.persistSessionById(id);
    }
    return c.json({ ok: true, sessionId: id, questId, attached, alreadyAttached, outOfRange, marker });
  });

  // ─── Cat herding (orchestrator→worker relationships) ──────────────

  api.post("/sessions/:id/herd", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const orch = launcher.getSession(orchId);
    if (!orch) return c.json({ error: "Orchestrator session not found" }, 404);

    // Server-side role check: only orchestrators can herd
    if (!orch.isOrchestrator) {
      return c.json({ error: "Session is not an orchestrator" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    if (!Array.isArray(body.workerIds) || body.workerIds.length === 0) {
      return c.json({ error: "workerIds array is required" }, 400);
    }
    if (body.force !== undefined && typeof body.force !== "boolean") {
      return c.json({ error: "force must be a boolean" }, 400);
    }
    // Resolve each worker ref (supports #N, UUID, prefix)
    const resolved: string[] = [];
    const notFound: string[] = [];
    for (const ref of body.workerIds) {
      const wid = resolveId(String(ref));
      if (wid) {
        resolved.push(wid);
      } else {
        notFound.push(String(ref));
      }
    }
    const result =
      body.force === true
        ? launcher.herdSessions(orchId, resolved, { force: true })
        : launcher.herdSessions(orchId, resolved);
    return c.json({
      herded: result.herded,
      notFound: [...notFound, ...result.notFound],
      conflicts: result.conflicts,
      reassigned: result.reassigned,
      leaders: result.leaders,
    } satisfies HerdSessionsResponse);
  });

  api.delete("/sessions/:id/herd/:workerId", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const workerId = resolveId(c.req.param("workerId"));
    if (!workerId) return c.json({ error: "Worker session not found" }, 404);
    const removed = launcher.unherdSession(orchId, workerId);
    return c.json({ ok: true, removed });
  });

  api.get("/sessions/:id/herd", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const herded = launcher.getHerdedSessions(orchId);
    return c.json(
      herded.map((s) => ({
        sessionId: s.sessionId,
        sessionNum: s.sessionNum,
        name: sessionNames.getName(s.sessionId),
        state: s.state,
        cwd: s.cwd,
        backendType: s.backendType,
        cliConnected: wsBridge.isBackendConnected(s.sessionId),
        isOrchestrator: s.isOrchestrator,
        herdedBy: s.herdedBy,
      })),
    );
  });

  // ─── Leader answer (resolve AskUserQuestion / ExitPlanMode) ─────────

  /** Answerable tool names — tool permissions (can_use_tool) are human-only */
  const ANSWERABLE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

  const buildLeaderAnswerTargets = (session: BridgeSession): LeaderAnswerTarget[] => {
    const targets: LeaderAnswerTarget[] = [];

    for (const [, perm] of session.pendingPermissions) {
      if (!ANSWERABLE_TOOLS.has(perm.tool_name)) continue;
      let msg_index: number | undefined;
      for (let i = session.messageHistory.length - 1; i >= 0; i--) {
        const entry = session.messageHistory[i] as { type?: string; request?: { request_id?: string } };
        if (entry.type === "permission_request" && entry.request?.request_id === perm.request_id) {
          msg_index = i;
          break;
        }
      }
      targets.push({
        kind: "permission",
        request_id: perm.request_id,
        tool_name: perm.tool_name,
        timestamp: perm.timestamp,
        input: perm.input,
        ...(msg_index !== undefined ? { msg_index } : {}),
        threadKey: perm.threadKey ?? "main",
        ...(perm.questId ? { questId: perm.questId } : {}),
        ...(perm.tool_name === "AskUserQuestion" ? { questions: perm.input.questions } : {}),
        ...(perm.tool_name === "ExitPlanMode"
          ? { plan: perm.input.plan, allowedPrompts: perm.input.allowedPrompts }
          : {}),
      });
    }

    for (const notif of session.notifications) {
      if (notif.done || notif.category !== "needs-input") continue;
      const msg_index = findMessageIndexById(session, notif.messageId);
      targets.push({
        kind: "notification",
        notification_id: notif.id,
        tool_name: "takode.notify",
        timestamp: notif.timestamp,
        ...(msg_index !== undefined ? { msg_index } : {}),
        threadKey: notif.threadKey ?? "main",
        ...(notif.questId ? { questId: notif.questId } : {}),
        ...(notif.summary ? { summary: notif.summary } : {}),
        ...(notif.suggestedAnswers?.length ? { suggestedAnswers: notif.suggestedAnswers } : {}),
        messageId: notif.messageId,
      });
    }

    return targets.sort((a, b) => a.timestamp - b.timestamp);
  };

  const matchLeaderAnswerTarget = (
    target: LeaderAnswerTarget,
    selection: Exclude<LeaderAnswerTargetSelection, { kind: "oldest" }>,
  ): boolean => {
    if (selection.kind === "msg_index") return target.msg_index === selection.msg_index;
    if (selection.kind === "thread") return sameThreadRoute(target, selection);
    return target.kind === "permission"
      ? target.request_id === selection.target_id
      : target.notification_id === selection.target_id;
  };

  const selectLeaderAnswerTarget = (
    targets: LeaderAnswerTarget[],
    selection: LeaderAnswerTargetSelection,
  ): { ok: true; target: LeaderAnswerTarget } | { ok: false; status: 404 | 409; error: string } => {
    if (targets.length === 0) return { ok: false, status: 404, error: "No pending question or plan to answer" };

    if (selection.kind === "oldest") {
      if (targets.length > 1) {
        return {
          ok: false,
          status: 409,
          error: "Multiple pending prompts; choose one with msgIndex/--message or targetId/--target",
        };
      }
      return { ok: true, target: targets[0] };
    }

    const matches = targets.filter((target) => matchLeaderAnswerTarget(target, selection));
    if (matches.length === 0) {
      return { ok: false, status: 404, error: "Targeted pending prompt not found" };
    }
    if (matches.length > 1) {
      return { ok: false, status: 409, error: "Target selector matched multiple pending prompts" };
    }
    return { ok: true, target: matches[0] };
  };

  api.get("/sessions/:id/pending", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (workerInfo.herdedBy !== auth.callerId) {
      return c.json({ error: "Only the leader who herded this session can view pending prompts" }, 403);
    }
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    return c.json({ pending: buildLeaderAnswerTargets(session) });
  });

  api.post("/sessions/:id/answer", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const response = typeof body.response === "string" ? body.response : "";
    if (!response.trim()) {
      return c.json({ error: "response is required" }, 400);
    }
    const rawTargetId =
      typeof body.targetId === "string"
        ? body.targetId.trim()
        : typeof body.target_id === "string"
          ? body.target_id.trim()
          : "";
    const rawMsgIndex =
      typeof body.msgIndex === "number"
        ? body.msgIndex
        : typeof body.msg_index === "number"
          ? body.msg_index
          : undefined;
    const rawThreadKey =
      typeof body.threadKey === "string"
        ? body.threadKey.trim()
        : typeof body.thread_key === "string"
          ? body.thread_key.trim()
          : typeof body.questId === "string"
            ? body.questId.trim()
            : "";
    if (rawMsgIndex !== undefined && !Number.isInteger(rawMsgIndex)) {
      return c.json({ error: "msgIndex must be an integer" }, 400);
    }
    if (
      typeof body.callerSessionId === "string" &&
      body.callerSessionId.trim() &&
      body.callerSessionId.trim() !== auth.callerId
    ) {
      return c.json({ error: "callerSessionId does not match authenticated caller" }, 403);
    }
    const callerSessionId = auth.callerId;

    // Herd guard: only the leader can answer
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (!callerSessionId || workerInfo.herdedBy !== callerSessionId) {
      return c.json({ error: "Only the leader who herded this session can answer" }, 403);
    }

    const targets = buildLeaderAnswerTargets(session);
    const threadTarget = rawThreadKey ? threadRouteForTarget(rawThreadKey) : null;
    if (rawThreadKey && routeKey(threadTarget) === "main" && rawThreadKey.trim().toLowerCase() !== "main") {
      return c.json({ error: "threadKey must be main or q-N" }, 400);
    }
    const selection: LeaderAnswerTargetSelection =
      rawMsgIndex !== undefined
        ? { kind: "msg_index", msg_index: rawMsgIndex }
        : rawTargetId
          ? { kind: "target_id", target_id: rawTargetId }
          : threadTarget
            ? { kind: "thread", threadKey: threadTarget.threadKey }
            : { kind: "oldest" };
    const selected = selectLeaderAnswerTarget(targets, selection);
    if (!selected.ok) return c.json({ error: selected.error }, selected.status);
    const target = selected.target;

    if (target.kind === "notification") {
      const callerInfo = launcher.getSession(auth.callerId);
      const sessionLabel = callerInfo?.sessionNum !== undefined ? `#${callerInfo.sessionNum}` : undefined;
      const delivery = wsBridge.injectUserMessage(
        id,
        response,
        {
          sessionId: auth.callerId,
          ...(sessionLabel ? { sessionLabel } : {}),
        },
        undefined,
        threadRouteForTarget(target.threadKey ?? "main"),
      );
      if (delivery === "no_session") return c.json({ error: "Session not found in bridge" }, 404);
      markNotificationDoneController(session, target.notification_id, true, notificationPersistDeps);
      return c.json({
        ok: true,
        kind: "notification",
        tool_name: target.tool_name,
        action: "answered",
        answer: response,
        delivery,
      });
    }

    // Build the permission_response based on tool type
    if (target.tool_name === "AskUserQuestion") {
      // Parse response: number = pick option, otherwise free text
      const questions = target.input.questions as Array<{ options?: Array<{ label: string }> }> | undefined;
      const optIdx = parseInt(response, 10);
      let answerValue: string;
      if (!isNaN(optIdx) && questions?.[0]?.options && optIdx >= 1 && optIdx <= questions[0].options.length) {
        answerValue = questions[0].options[optIdx - 1].label; // 1-indexed
      } else {
        answerValue = response; // free text
      }
      const answers: Record<string, string> = {};
      for (let i = 0; i < Math.max(1, questions?.length ?? 0); i++) {
        answers[String(i)] = answerValue;
      }

      const routed = await routeLeaderPermissionResponse(
        id,
        session,
        {
          type: "permission_response",
          request_id: target.request_id,
          behavior: "allow",
          updated_input: { ...target.input, answers },
        },
        auth.callerId,
      );
      if (!routed) return c.json({ error: "Permission response routing unavailable" }, 500);
      return c.json({ ok: true, kind: "permission", tool_name: target.tool_name, answer: answerValue });
    }

    if (target.tool_name === "ExitPlanMode") {
      const isApprove = response.toLowerCase().startsWith("approve");
      if (isApprove) {
        const routed = await routeLeaderPermissionResponse(
          id,
          session,
          {
            type: "permission_response",
            request_id: target.request_id,
            behavior: "allow",
            updated_input: target.input,
          },
          auth.callerId,
        );
        if (!routed) return c.json({ error: "Permission response routing unavailable" }, 500);
        return c.json({ ok: true, kind: "permission", tool_name: target.tool_name, action: "approved" });
      } else {
        // "reject" or "reject: feedback text"
        const feedback = response.replace(/^reject:?\s*/i, "").trim() || "Rejected by leader";
        const routed = await routeLeaderPermissionResponse(
          id,
          session,
          {
            type: "permission_response",
            request_id: target.request_id,
            behavior: "deny",
            message: feedback,
          },
          auth.callerId,
        );
        if (!routed) return c.json({ error: "Permission response routing unavailable" }, 500);
        return c.json({ ok: true, kind: "permission", tool_name: target.tool_name, action: "rejected", feedback });
      }
    }

    return c.json({ error: "Unsupported tool type" }, 400);
  });

  // ─── Herd diagnostics ────────────────────────────────────────────────

  api.get("/sessions/:id/herd-diagnostics", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    const bridgeDiag = session
      ? getHerdDiagnosticsController(new Map([[id, session]]), id, Date.now(), {
          getHerdDispatcherDiagnostics: (targetSessionId) =>
            (wsBridge as any).herdEventDispatcher?.getDiagnostics?.(targetSessionId) ?? {},
        })
      : null;
    const herded = info.isOrchestrator ? launcher.getHerdedSessions(id) : [];

    return c.json({
      sessionId: id,
      sessionNum: info.sessionNum,
      isOrchestrator: info.isOrchestrator || false,
      herdedBy: info.herdedBy,
      herdedWorkers: herded.map((s) => ({
        sessionId: s.sessionId,
        sessionNum: s.sessionNum,
        name: sessionNames.getName(s.sessionId),
        state: s.state,
        cliConnected: wsBridge.isBackendConnected(s.sessionId),
      })),
      ...(bridgeDiag || {}),
    });
  });

  // ─── Branch management ─────────────────────────────────────────────

  /**
   * Trigger a git info refresh for the caller's own session.
   * Agents call this after git checkout / branch / rebase so the server
   * picks up the new HEAD and recomputes ahead/behind stats.
   */
  api.post("/sessions/:id/refresh-branch", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    await refreshGitInfoPublic(id, { broadcastUpdate: true, notifyPoller: true, force: true });

    const state = wsBridge.getSession(id)?.state;
    return c.json({
      ok: true,
      gitBranch: state?.git_branch || null,
      gitDefaultBranch: state?.git_default_branch || null,
      diffBaseBranch: state?.diff_base_branch || null,
      gitAhead: state?.git_ahead || 0,
      gitBehind: state?.git_behind || 0,
    });
  });

  /**
   * Get branch info for the caller's session.
   * Returns current branch, base branch, default branch, HEAD SHA, and ahead/behind counts.
   */
  api.get("/sessions/:id/branch/status", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const state = session.state;
    return c.json({
      ok: true,
      gitBranch: state.git_branch || null,
      diffBaseBranch: state.diff_base_branch || null,
      gitDefaultBranch: state.git_default_branch || null,
      gitHeadSha: state.git_head_sha || null,
      gitAhead: state.git_ahead || 0,
      gitBehind: state.git_behind || 0,
      totalLinesAdded: state.total_lines_added || 0,
      totalLinesRemoved: state.total_lines_removed || 0,
      gitStatusRefreshedAt: state.git_status_refreshed_at || null,
      gitStatusRefreshError: state.git_status_refresh_error || null,
      isWorktree: state.is_worktree || false,
    });
  });

  /**
   * Set the diff base branch for the caller's session.
   * This is the same operation as changing it in the DiffPanel UI.
   */
  api.post("/sessions/:id/branch/set-base", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const body = await c.req.json<{ branch?: string }>().catch(() => ({}) as { branch?: string });
    const branch = body.branch?.trim();
    if (!branch) return c.json({ error: "Missing 'branch' parameter" }, 400);
    if (branch.length > 255) return c.json({ error: "Branch name too long (max 255)" }, 400);

    const success = setDiffBaseBranch(id, branch);
    if (!success) return c.json({ error: "Failed to set base branch" }, 500);

    const state = wsBridge.getSession(id)?.state;
    return c.json({
      ok: true,
      diffBaseBranch: state?.diff_base_branch || null,
      gitBranch: state?.git_branch || null,
      gitAhead: state?.git_ahead || 0,
      gitBehind: state?.git_behind || 0,
    });
  });

  // ─── Worker stream checkpoints ─────────────────────────────────────────

  api.post("/sessions/:id/worker-stream", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only stream checkpoints from your own session" }, 403);
    }

    const launcherSession = launcher.getSession(id);
    if (!launcherSession) return c.json({ error: "Session not found" }, 404);
    if (!launcherSession.herdedBy) {
      return c.json({ error: "worker-stream requires a herded worker or reviewer session" }, 409);
    }

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);
    if (typeof bridgeAny.emitWorkerStreamCheckpoint !== "function") {
      return c.json({ error: "worker-stream is unavailable" }, 500);
    }

    const result = bridgeAny.emitWorkerStreamCheckpoint(id) as {
      ok: boolean;
      streamed: boolean;
      reason: string;
      msgRange?: { from: number; to: number };
    };
    return c.json(result);
  });

  // ─── User notifications ──────────────────────────────────────────────

  api.post("/sessions/:id/notify", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    // The caller can only notify for their own session
    if (id !== auth.callerId) {
      return c.json({ error: "Can only notify from your own session" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const category = body.category;
    if (category !== "needs-input" && category !== "review") {
      return c.json({ error: 'category must be "needs-input" or "review"' }, 400);
    }
    const rawSummary = typeof body.summary === "string" ? body.summary.trim() : "";
    if (!rawSummary) {
      return c.json({ error: "summary is required" }, 400);
    }
    const summary = rawSummary;
    const suggestedAnswersResult = normalizeSuggestedAnswers(body.suggestedAnswers, category);
    if (!suggestedAnswersResult.ok) {
      return c.json({ error: suggestedAnswersResult.error }, 400);
    }

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const result = notifyUserController(session, category, summary, notificationRouteDeps, {
      suggestedAnswers: suggestedAnswersResult.answers,
    });
    return c.json({
      ok: true,
      category,
      anchoredMessageId: result.anchoredMessageId,
      notificationId: parseNotificationNumericId(result.notificationId),
      rawNotificationId: result.notificationId,
      ...(suggestedAnswersResult.answers.length ? { suggestedAnswers: suggestedAnswersResult.answers } : {}),
    });
  });

  api.get("/sessions/:id/notifications/needs-input/self", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only inspect notifications for your own session" }, 403);
    }

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(buildSelfNeedsInputNotifications(session));
  });

  api.post("/sessions/:id/notifications/needs-input/:notificationId/resolve", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (id !== auth.callerId) {
      return c.json({ error: "Can only resolve notifications for your own session" }, 403);
    }

    const numericId = Number.parseInt(c.req.param("notificationId"), 10);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return c.json({ error: "notificationId must be a positive integer" }, 400);
    }

    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const rawNotificationId = `n-${numericId}`;
    const notification = session.notifications.find(
      (entry) => entry.id === rawNotificationId && entry.category === "needs-input",
    );
    if (!notification) return c.json({ error: "Notification not found" }, 404);
    if (notification.done) {
      return c.json({ ok: true, notificationId: numericId, rawNotificationId, changed: false });
    }

    markNotificationDoneController(session, rawNotificationId, true, notificationPersistDeps);
    return c.json({ ok: true, notificationId: numericId, rawNotificationId, changed: true });
  });

  // ─── Notification Inbox ─────────────────────────────────────────────

  api.post("/sessions/:id/notifications/:notifId/done", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const notifId = c.req.param("notifId");
    const body = await c.req.json().catch(() => ({}));
    const done = body.done !== false;
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const ok = markNotificationDoneController(session, notifId, done, notificationPersistDeps);
    if (!ok) return c.json({ error: "Notification not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/notifications/done-all", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const done = body.done !== false;
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const count = markAllNotificationsDoneController(session, done, notificationPersistDeps);
    return c.json({ ok: true, count });
  });

  api.get("/sessions/:id/notifications", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    return c.json(wsBridge.getSession(id)?.notifications ?? []);
  });

  // ─── Work Board ──────────────────────────────────────────────────────

  /** Resolve which #N session deps on the board are currently idle. */
  function resolveSessionDeps(board: import("../session-types.js").BoardRow[]): string[] {
    const sessionRefs = new Set<string>();
    for (const row of board) {
      for (const dep of row.waitFor ?? []) {
        if (dep.startsWith("#")) sessionRefs.add(dep);
      }
    }
    if (sessionRefs.size === 0) return [];
    const resolved: string[] = [];
    for (const ref of sessionRefs) {
      const num = ref.slice(1); // strip '#'
      const sessionId = launcher.resolveSessionId(num);
      if (sessionId && isSessionIdleRuntime(wsBridge.getSession(sessionId) as any)) {
        resolved.push(ref);
      }
    }
    return resolved;
  }

  registerTakodeBoardRoutes(api, {
    launcher,
    wsBridge,
    authenticateTakodeCaller,
    resolveId,
    boardWatchdogDeps,
    workBoardStateDeps,
    buildBoardRowSessionStatuses,
    resolveSessionDeps,
  });

  return api;
}
