import type { SessionNotification } from "../types.js";

export function getSingleAnchoredNotification(
  notifications: ReadonlyArray<SessionNotification> | undefined,
  messageId: string,
): SessionNotification | null {
  if (!notifications || notifications.length === 0) return null;

  let match: SessionNotification | null = null;
  for (const notification of notifications) {
    if (notification.messageId !== messageId) continue;
    if (match) return null;
    match = notification;
  }

  return match;
}

export function collectAnchoredNotificationMessageIds(
  notifications: ReadonlyArray<Pick<SessionNotification, "messageId">> | undefined,
): string[] {
  if (!notifications || notifications.length === 0) return [];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const notification of notifications) {
    if (!notification.messageId || seen.has(notification.messageId)) continue;
    seen.add(notification.messageId);
    ids.push(notification.messageId);
  }
  return ids;
}
