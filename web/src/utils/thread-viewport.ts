import { MAIN_THREAD_KEY, normalizeThreadKey } from "./thread-projection.js";

export const SAVE_THREAD_VIEWPORT_EVENT = "takode:save-thread-viewport";

export function getFeedViewportKey(sessionId: string, threadKey: string | null | undefined = MAIN_THREAD_KEY): string {
  return `${sessionId}:thread:${normalizeThreadKey(threadKey || MAIN_THREAD_KEY)}`;
}

export function requestThreadViewportSnapshot(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  window.dispatchEvent(
    new CustomEvent(SAVE_THREAD_VIEWPORT_EVENT, {
      detail: { sessionId },
    }),
  );
}
