import type { SessionNotification } from "../types.js";

export type NotificationUrgency = "needs-input" | "review" | null;

/** Highest urgency among already-active notifications.
 *  needs-input takes precedence over review. */
export function getHighestNotificationUrgency(
  notifications: ReadonlyArray<Pick<SessionNotification, "category">> | null | undefined,
): NotificationUrgency {
  if (!notifications || notifications.length === 0) return null;
  let hasReview = false;
  for (const notification of notifications) {
    if (notification.category === "needs-input") return "needs-input";
    if (notification.category === "review") hasReview = true;
  }
  return hasReview ? "review" : null;
}
