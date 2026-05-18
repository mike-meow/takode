import type {
  BoardRow,
  BrowserIncomingMessage,
  NeedsInputNotificationQuestion,
  SessionNotification,
} from "../session-types.js";
import {
  type ThreadRouteMetadata,
  normalizeThreadRoute,
  resolveConsistentNotificationThreadRoute,
  routeFromHistoryEntry,
  sameThreadRoute,
  withThreadRoute,
} from "../thread-routing-metadata.js";

type SessionLike = any;

export type AttentionReason = "action" | "error" | "review";
export type NotificationUrgency = "needs-input" | "review" | null;

export interface NotificationStatusSnapshot {
  notificationUrgency: NotificationUrgency;
  activeNotificationCount: number;
  notificationStatusVersion: number;
  notificationStatusUpdatedAt: number;
}

type BrowserNotificationDeps = {
  broadcastToBrowsers?: (session: SessionLike, msg: BrowserIncomingMessage) => void;
};

type PersistNotificationDeps = BrowserNotificationDeps & {
  persistSession: (session: SessionLike) => void;
};

type NotifyUserDeps = PersistNotificationDeps & {
  isHerdedWorkerSession?: (session: SessionLike) => boolean;
  getLauncherSessionInfo?: (sessionId: string) => any;
  emitTakodeEvent?: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  scheduleNotification?: (
    sessionId: string,
    category: "question" | "completed",
    detail: string,
    options?: { skipReadCheck?: boolean },
  ) => void;
};

type NotifyUserOptions = {
  suggestedAnswers?: string[];
  questions?: NeedsInputNotificationQuestion[];
  threadRoute?: ThreadRouteMetadata;
};

type NotificationDoneDeps = PersistNotificationDeps & {
  broadcastBoard?: (session: SessionLike, board: BoardRow[], completedBoard: BoardRow[]) => void;
};

export function setAttention(
  session: SessionLike,
  reason: AttentionReason,
  deps: PersistNotificationDeps & { isHerdedWorkerSession?: (session: SessionLike) => boolean },
  options?: { allowHerdedWorker?: boolean },
): void {
  if (deps.isHerdedWorkerSession?.(session) && !options?.allowHerdedWorker) return;
  const current = session.attentionReason as AttentionReason | null;
  const pri = { action: 3, error: 2, review: 1 } as const;
  if (current && pri[current] >= pri[reason]) return;
  session.attentionReason = reason;
  deps.broadcastToBrowsers?.(session, {
    type: "session_update",
    session: { attentionReason: session.attentionReason },
  } as BrowserIncomingMessage);
  deps.persistSession(session);
}

export function clearAttentionAndMarkRead(session: SessionLike, deps: PersistNotificationDeps): void {
  if (session.attentionReason === null) return;
  session.attentionReason = null;
  session.lastReadAt = Date.now();
  deps.broadcastToBrowsers?.(session, {
    type: "session_update",
    session: { attentionReason: null, lastReadAt: session.lastReadAt },
  } as BrowserIncomingMessage);
  deps.persistSession(session);
}

export function normalizeStatusNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function deriveNotificationStatusUpdatedAt(
  notifications: ReadonlyArray<Pick<SessionNotification, "timestamp">>,
): number {
  let latest = 0;
  for (const notification of notifications) {
    if (Number.isFinite(notification.timestamp) && notification.timestamp > latest) latest = notification.timestamp;
  }
  return latest;
}

function touchNotificationStatus(session: SessionLike): void {
  session.notificationStatusVersion = normalizeStatusNumber(session.notificationStatusVersion, 0) + 1;
  session.notificationStatusUpdatedAt = Date.now();
}

function isActionableSessionNotification(notification: Pick<SessionNotification, "category">): boolean {
  return notification.category === "needs-input" || notification.category === "review";
}

function getActionableSessionNotifications(session: SessionLike): SessionNotification[] {
  return (session.notifications ?? []).filter(isActionableSessionNotification);
}

export function getNotificationStatusSnapshot(session: SessionLike): NotificationStatusSnapshot {
  let activeNotificationCount = 0;
  let hasNeedsInput = false;
  let hasReview = false;
  const notifications = getActionableSessionNotifications(session);
  for (const notification of notifications) {
    if (notification.done) continue;
    activeNotificationCount += 1;
    if (notification.category === "needs-input") hasNeedsInput = true;
    if (notification.category === "review") hasReview = true;
  }
  return {
    notificationUrgency: hasNeedsInput ? "needs-input" : hasReview ? "review" : null,
    activeNotificationCount,
    notificationStatusVersion: normalizeStatusNumber(session.notificationStatusVersion, 0),
    notificationStatusUpdatedAt: normalizeStatusNumber(
      session.notificationStatusUpdatedAt,
      deriveNotificationStatusUpdatedAt(notifications),
    ),
  };
}

function buildNotificationUpdateMessage(session: SessionLike): BrowserIncomingMessage {
  const status = getNotificationStatusSnapshot(session);
  return {
    type: "notification_update",
    notifications: getActionableSessionNotifications(session),
    notificationStatusVersion: status.notificationStatusVersion,
    notificationStatusUpdatedAt: status.notificationStatusUpdatedAt,
  } as BrowserIncomingMessage;
}

function broadcastNotificationStatus(session: SessionLike, deps: BrowserNotificationDeps): void {
  deps.broadcastToBrowsers?.(session, {
    type: "session_update",
    session: { attentionReason: session.attentionReason ?? null },
  } as BrowserIncomingMessage);
}

function broadcastNotificationRefresh(session: SessionLike, deps: PersistNotificationDeps): void {
  touchNotificationStatus(session);
  deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
  clearActionAttentionIfNoNotifications(session, deps);
  broadcastNotificationStatus(session, deps);
  deps.persistSession(session);
}

export function notifyUser(
  session: SessionLike,
  category: SessionNotification["category"],
  summary: string,
  deps: NotifyUserDeps,
  options: NotifyUserOptions = {},
): { ok: true; anchoredMessageId: string | null; notificationId: string } {
  const timestamp = Date.now();
  const preferredThreadRoute = options.threadRoute ?? activeNotificationThreadRoute(session);
  let anchorIndex = findLastNotificationAnchorIndex(session);
  let anchor = anchorIndex !== undefined ? getNotificationAnchor(session.messageHistory[anchorIndex]) : undefined;
  if (
    anchorIndex !== undefined &&
    preferredThreadRoute &&
    !anchorMatchesThreadRoute(session, anchorIndex, preferredThreadRoute)
  ) {
    anchorIndex = undefined;
    anchor = undefined;
  }
  let createdFallbackMessage: BrowserIncomingMessage | null = null;
  const isLeaderSession = deps.getLauncherSessionInfo?.(session.id)?.isOrchestrator === true;

  if (!anchor && isLeaderSession && category === "needs-input" && !deps.isHerdedWorkerSession?.(session)) {
    createdFallbackMessage = {
      type: "leader_user_message",
      id: `leader-needs-input-${timestamp}-${session.messageHistory.length}`,
      content: `Needs input: ${summary}`,
      timestamp,
    };
    session.messageHistory.push(createdFallbackMessage);
    anchorIndex = session.messageHistory.length - 1;
    anchor = getNotificationAnchor(createdFallbackMessage);
  }

  const anchoredMessageId = anchor?.id ?? null;
  const suggestedAnswers =
    category === "needs-input" && options.suggestedAnswers?.length ? options.suggestedAnswers : undefined;
  const questions = category === "needs-input" && options.questions?.length ? options.questions : undefined;
  const nextNotificationCounter = Number.isInteger(session.notificationCounter) ? session.notificationCounter + 1 : 1;
  session.notificationCounter = nextNotificationCounter;
  const notificationId = `n-${nextNotificationCounter}`;
  const threadRoute =
    preferredThreadRoute ??
    (createdFallbackMessage
      ? { threadKey: "main" }
      : resolveConsistentNotificationThreadRoute(session.messageHistory, anchorIndex, notificationId));
  if (createdFallbackMessage) {
    createdFallbackMessage.threadKey = threadRoute.threadKey;
    if (threadRoute.questId) createdFallbackMessage.questId = threadRoute.questId;
    if (threadRoute.threadRefs?.length) createdFallbackMessage.threadRefs = threadRoute.threadRefs;
  }
  const anchoredNotification = withThreadRoute(
    {
      id: notificationId,
      category,
      timestamp,
      summary,
      ...(suggestedAnswers ? { suggestedAnswers } : {}),
      ...(questions ? { questions } : {}),
    },
    threadRoute,
  );

  const notif: SessionNotification = withThreadRoute(
    {
      id: notificationId,
      category,
      summary,
      ...(suggestedAnswers ? { suggestedAnswers } : {}),
      ...(questions ? { questions } : {}),
      timestamp,
      messageId: anchoredMessageId,
      done: false,
    },
    threadRoute,
  );
  session.notifications.push(notif);
  touchNotificationStatus(session);

  if (deps.isHerdedWorkerSession?.(session)) {
    if (category === "needs-input") {
      deps.emitTakodeEvent?.(session.id, "notification_needs_input", {
        summary,
        notificationId: notif.id,
        messageId: anchoredMessageId,
        ...(suggestedAnswers ? { suggestedAnswers } : {}),
        ...(questions ? { questions } : {}),
        ...(anchorIndex !== undefined ? { msg_index: anchorIndex } : {}),
        threadKey: threadRoute.threadKey,
        ...(threadRoute.questId ? { questId: threadRoute.questId } : {}),
      });
    }
    deps.persistSession(session);
    return { ok: true, anchoredMessageId, notificationId: notif.id };
  }

  if (anchor) {
    (anchor.message as Record<string, unknown>).notification = anchoredNotification;
  }

  if (createdFallbackMessage) deps.broadcastToBrowsers?.(session, createdFallbackMessage);

  deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));

  if (category === "needs-input" || category === "review") {
    const reason = category === "needs-input" ? "action" : "review";
    setAttention(session, reason, deps);
  }
  broadcastNotificationStatus(session, deps);

  if (category === "needs-input" || category === "review") {
    deps.scheduleNotification?.(session.id, category === "needs-input" ? "question" : "completed", summary, {
      skipReadCheck: true,
    });
  }

  if (anchor) {
    deps.broadcastToBrowsers?.(session, {
      type: "notification_anchored",
      messageId: anchoredMessageId,
      notification: anchoredNotification,
    } as BrowserIncomingMessage);
  }

  deps.persistSession(session);
  return { ok: true, anchoredMessageId, notificationId: notif.id };
}

export function notifyUserBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  category: SessionNotification["category"],
  summary: string,
  deps: NotifyUserDeps,
  options: NotifyUserOptions = {},
): { ok: true; anchoredMessageId: string | null; notificationId: string } | { ok: false; error: string } {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: "Session not found" };
  return notifyUser(session, category, summary, deps, options);
}

function activeNotificationThreadRoute(session: SessionLike): ThreadRouteMetadata | null {
  return normalizeThreadRoute(session.activeTurnRoute?.threadKey, session.activeTurnRoute?.questId);
}

function anchorMatchesThreadRoute(session: SessionLike, anchorIndex: number, route: ThreadRouteMetadata): boolean {
  const anchorRoute = routeFromHistoryEntry(session.messageHistory[anchorIndex]) ?? { threadKey: "main" };
  return sameThreadRoute(anchorRoute, route);
}

function getSortedBoardRows(session: SessionLike): BoardRow[] {
  if (!session.board?.values) return [];
  return Array.from(session.board.values() as Iterable<BoardRow>).sort((a, b) => a.createdAt - b.createdAt);
}

function getSortedCompletedBoardRows(session: SessionLike): BoardRow[] {
  if (!session.completedBoard?.values) return [];
  return Array.from(session.completedBoard.values() as Iterable<BoardRow>).sort(
    (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0),
  );
}

function removeNotificationLinksFromBoardRows(session: SessionLike, notifId: string): boolean {
  const normalizedNotificationId = notifId.trim().toLowerCase();
  if (!/^n-\d+$/.test(normalizedNotificationId)) return false;

  let changed = false;
  const boardMaps = [session.board, session.completedBoard].filter(
    (boardMap): boardMap is Map<string, BoardRow> => !!boardMap?.values,
  );
  for (const boardMap of boardMaps) {
    for (const row of boardMap.values()) {
      if (!Array.isArray(row.waitForInput) || row.waitForInput.length === 0) continue;
      const currentIds = [
        ...new Set(row.waitForInput.map((notificationId: string) => notificationId.trim().toLowerCase())),
      ]
        .filter((notificationId) => /^n-\d+$/.test(notificationId))
        .sort((a, b) => Number.parseInt(a.slice(2), 10) - Number.parseInt(b.slice(2), 10));
      if (!currentIds.includes(normalizedNotificationId)) continue;

      const nextIds = currentIds.filter((notificationId) => notificationId !== normalizedNotificationId);
      row.waitForInput = nextIds.length > 0 ? nextIds : undefined;
      boardMap.set(row.questId, row);
      changed = true;
    }
  }

  return changed;
}

export function markNotificationDone(
  session: SessionLike,
  notifId: string,
  done: boolean,
  deps: NotificationDoneDeps,
): boolean {
  const notif = session.notifications.find((entry: SessionNotification) => entry.id === notifId);
  if (!notif) return false;
  if (notif.done === done) {
    if (done) broadcastNotificationRefresh(session, deps);
    return true;
  }
  notif.done = done;
  touchNotificationStatus(session);
  const clearedBoardWaits =
    done && notif.category === "needs-input" ? removeNotificationLinksFromBoardRows(session, notifId) : false;
  deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
  if (clearedBoardWaits) {
    deps.broadcastBoard?.(session, getSortedBoardRows(session), getSortedCompletedBoardRows(session));
  }
  if (done) clearActionAttentionIfNoNotifications(session, deps);
  broadcastNotificationStatus(session, deps);
  deps.persistSession(session);
  return true;
}

export function markNotificationDoneBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  notifId: string,
  done: boolean,
  deps: NotificationDoneDeps,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return markNotificationDone(session, notifId, done, deps);
}

export function markAllNotificationsDone(session: SessionLike, done: boolean, deps: NotificationDoneDeps): number {
  let count = 0;
  let clearedBoardWaits = false;
  for (const notif of session.notifications) {
    if (notif.done === done) continue;
    notif.done = done;
    if (done && notif.category === "needs-input") {
      clearedBoardWaits = removeNotificationLinksFromBoardRows(session, notif.id) || clearedBoardWaits;
    }
    count += 1;
  }
  if (count > 0) {
    touchNotificationStatus(session);
    deps.broadcastToBrowsers?.(session, buildNotificationUpdateMessage(session));
    if (clearedBoardWaits) {
      deps.broadcastBoard?.(session, getSortedBoardRows(session), getSortedCompletedBoardRows(session));
    }
    if (done) clearActionAttentionIfNoNotifications(session, deps);
    broadcastNotificationStatus(session, deps);
    deps.persistSession(session);
  } else if (done) {
    broadcastNotificationRefresh(session, deps);
  }
  return count;
}

export function markAllNotificationsDoneBySessionId(
  sessions: Map<string, SessionLike>,
  sessionId: string,
  done: boolean,
  deps: NotificationDoneDeps,
): number {
  const session = sessions.get(sessionId);
  if (!session) return -1;
  return markAllNotificationsDone(session, done, deps);
}

export function clearActionAttentionIfNoNotifications(session: SessionLike, deps: BrowserNotificationDeps): void {
  if (session.pendingPermissions.size > 0) return;
  const hasOpenNeedsInput = session.notifications.some(
    (notif: SessionNotification) => !notif.done && notif.category === "needs-input",
  );
  if (!hasOpenNeedsInput && session.attentionReason === "action") {
    session.attentionReason = null;
    deps.broadcastToBrowsers?.(session, {
      type: "session_update",
      session: { attentionReason: null },
    } as BrowserIncomingMessage);
  }
}

function findLastNotificationAnchorIndex(session: SessionLike): number | undefined {
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    if (getNotificationAnchor(session.messageHistory[i])) return i;
  }
  return undefined;
}

function getNotificationAnchor(entry: BrowserIncomingMessage | undefined):
  | {
      id: string;
      message: Extract<BrowserIncomingMessage, { type: "assistant" | "leader_user_message" }>;
    }
  | undefined {
  if (!entry) return undefined;
  if (entry.type === "assistant" && entry.parent_tool_use_id == null && entry.message?.id) {
    return { id: entry.message.id, message: entry };
  }
  if (entry.type === "leader_user_message" && entry.id) {
    return { id: entry.id, message: entry };
  }
  return undefined;
}
