import { useStore } from "./store.js";
import type { SdkSessionInfo, SessionNotification } from "./types.js";

export type NotificationUrgency = "needs-input" | "review" | null;

export interface NotificationStatusSnapshot {
  notificationUrgency?: NotificationUrgency;
  activeNotificationCount?: number;
  notificationStatusVersion?: number;
  notificationStatusUpdatedAt?: number;
}

function summarizeNotifications(
  notifications: ReadonlyArray<SessionNotification>,
): Required<NotificationStatusSnapshot> {
  let activeNotificationCount = 0;
  let hasNeedsInput = false;
  let hasReview = false;
  for (const notification of notifications) {
    if (notification.done) continue;
    activeNotificationCount += 1;
    if (notification.category === "needs-input") hasNeedsInput = true;
    if (notification.category === "review") hasReview = true;
  }
  return {
    notificationUrgency: hasNeedsInput ? "needs-input" : hasReview ? "review" : null,
    activeNotificationCount,
    notificationStatusVersion: 0,
    notificationStatusUpdatedAt: 0,
  };
}

function hasNotificationStatus(snapshot: NotificationStatusSnapshot): boolean {
  return (
    snapshot.notificationUrgency !== undefined ||
    snapshot.activeNotificationCount !== undefined ||
    snapshot.notificationStatusVersion !== undefined ||
    snapshot.notificationStatusUpdatedAt !== undefined
  );
}

function notificationStatusFromSession(session: SdkSessionInfo | undefined): NotificationStatusSnapshot {
  if (!session) return {};
  return {
    notificationUrgency: session.notificationUrgency,
    activeNotificationCount: session.activeNotificationCount,
    notificationStatusVersion: session.notificationStatusVersion,
    notificationStatusUpdatedAt: session.notificationStatusUpdatedAt,
  };
}

function isIncomingNotificationStatusStale(
  current: NotificationStatusSnapshot,
  incoming: NotificationStatusSnapshot,
): boolean {
  if (!hasNotificationStatus(incoming)) return false;
  const currentVersion = current.notificationStatusVersion;
  const incomingVersion = incoming.notificationStatusVersion;
  if (currentVersion !== undefined) {
    if (incomingVersion === undefined) return true;
    if (incomingVersion < currentVersion) return true;
    if (incomingVersion > currentVersion) return false;
  }
  const currentUpdatedAt = current.notificationStatusUpdatedAt;
  const incomingUpdatedAt = incoming.notificationStatusUpdatedAt;
  if (currentUpdatedAt !== undefined && incomingUpdatedAt !== undefined) {
    return incomingUpdatedAt < currentUpdatedAt;
  }
  return false;
}

function applyNotificationStatus(session: SdkSessionInfo, status: NotificationStatusSnapshot): SdkSessionInfo {
  return {
    ...session,
    ...(status.notificationUrgency !== undefined ? { notificationUrgency: status.notificationUrgency } : {}),
    ...(status.activeNotificationCount !== undefined
      ? { activeNotificationCount: status.activeNotificationCount }
      : {}),
    ...(status.notificationStatusVersion !== undefined
      ? { notificationStatusVersion: status.notificationStatusVersion }
      : {}),
    ...(status.notificationStatusUpdatedAt !== undefined
      ? { notificationStatusUpdatedAt: status.notificationStatusUpdatedAt }
      : {}),
  };
}

function preserveCurrentNotificationStatus(
  incoming: SdkSessionInfo,
  current: SdkSessionInfo | undefined,
): SdkSessionInfo {
  const currentStatus = notificationStatusFromSession(current);
  const incomingStatus = notificationStatusFromSession(incoming);
  if (!hasNotificationStatus(incomingStatus) && hasNotificationStatus(currentStatus)) {
    return applyNotificationStatus(incoming, currentStatus);
  }
  if (!isIncomingNotificationStatusStale(currentStatus, incomingStatus)) return incoming;
  return applyNotificationStatus(incoming, currentStatus);
}

export function setSdkSessionsWithNotificationFreshness(sessions: SdkSessionInfo[]): void {
  const state = useStore.getState();
  const currentById = new Map(state.sdkSessions.map((session) => [session.sessionId, session]));
  state.setSdkSessions(
    sessions.map((session) => preserveCurrentNotificationStatus(session, currentById.get(session.sessionId))),
  );
}

export function applyNotificationStatusUpdate(sessionId: string, status: NotificationStatusSnapshot): boolean {
  if (!hasNotificationStatus(status)) return true;
  let applied = false;
  useStore.setState((state) => {
    const index = state.sdkSessions.findIndex((session) => session.sessionId === sessionId);
    if (index === -1) {
      applied = true;
      return state;
    }
    const current = state.sdkSessions[index]!;
    if (isIncomingNotificationStatusStale(notificationStatusFromSession(current), status)) return state;
    const nextSession = applyNotificationStatus(current, status);
    if (nextSession === current) {
      applied = true;
      return state;
    }
    const sdkSessions = state.sdkSessions.slice();
    sdkSessions[index] = nextSession;
    applied = true;
    return { sdkSessions };
  });
  return applied;
}

export function applySessionNotifications(
  sessionId: string,
  notifications: SessionNotification[],
  status: NotificationStatusSnapshot,
): boolean {
  const summary = summarizeNotifications(notifications);
  const incoming: NotificationStatusSnapshot = {
    notificationUrgency: summary.notificationUrgency,
    activeNotificationCount: summary.activeNotificationCount,
    notificationStatusVersion: status.notificationStatusVersion,
    notificationStatusUpdatedAt: status.notificationStatusUpdatedAt,
  };
  let applied = false;
  useStore.setState((state) => {
    const sdkSession = state.sdkSessions.find((session) => session.sessionId === sessionId);
    if (isIncomingNotificationStatusStale(notificationStatusFromSession(sdkSession), incoming)) return state;

    const sessionNotifications = new Map(state.sessionNotifications);
    if (notifications.length === 0) sessionNotifications.delete(sessionId);
    else sessionNotifications.set(sessionId, notifications);

    const index = state.sdkSessions.findIndex((session) => session.sessionId === sessionId);
    if (index === -1) {
      applied = true;
      return { sessionNotifications };
    }
    const sdkSessions = state.sdkSessions.slice();
    sdkSessions[index] = applyNotificationStatus(sdkSessions[index]!, incoming);
    applied = true;
    return { sessionNotifications, sdkSessions };
  });
  return applied;
}
