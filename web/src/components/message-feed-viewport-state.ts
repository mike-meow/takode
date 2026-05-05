import { useStore } from "../store.js";
import type { FeedViewportPosition } from "../utils/thread-viewport.js";
import { readLeaderViewportPosition } from "../utils/thread-viewport.js";

export function getSavedViewportRestoreKey(viewportKey: string, pos: FeedViewportPosition | null): string {
  if (!pos) return `${viewportKey}:latest`;
  return [
    viewportKey,
    pos.isAtBottom ? "bottom" : "position",
    pos.scrollTop,
    pos.scrollHeight,
    pos.anchorTurnId ?? "",
    pos.anchorOffsetTop ?? "",
    pos.lastSeenContentBottom ?? "",
  ].join(":");
}

export function readSavedViewportPosition({
  sessionId,
  viewportKey,
  normalizedThreadKey,
  isLeaderSession,
}: {
  sessionId: string;
  viewportKey: string;
  normalizedThreadKey: string;
  isLeaderSession: boolean;
}): FeedViewportPosition | null {
  const memoryPosition = useStore.getState().feedScrollPosition.get(viewportKey) ?? null;
  if (!isLeaderSession) return memoryPosition;
  return readLeaderViewportPosition(sessionId, normalizedThreadKey) ?? memoryPosition;
}
