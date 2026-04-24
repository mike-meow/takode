export const SAVE_THREAD_VIEWPORT_EVENT = "takode:save-thread-viewport";

export function requestThreadViewportSnapshot(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  window.dispatchEvent(
    new CustomEvent(SAVE_THREAD_VIEWPORT_EVENT, {
      detail: { sessionId },
    }),
  );
}
