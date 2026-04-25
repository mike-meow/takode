import type { SidebarSessionItem } from "./sidebar-session-item.js";

export function buildReviewerByParent(sessions: SidebarSessionItem[]): Map<number, SidebarSessionItem> {
  const map = new Map<number, SidebarSessionItem>();
  for (const session of sessions) {
    if (session.reviewerOf === undefined) continue;
    const existing = map.get(session.reviewerOf);
    if (
      !existing ||
      (existing.archived && !session.archived) ||
      (existing.archived === session.archived && session.createdAt > existing.createdAt)
    ) {
      map.set(session.reviewerOf, session);
    }
  }
  return map;
}
