/**
 * Manages the lifecycle of pending session creation.
 *
 * Decoupled from React components so the SSE stream keeps running even after
 * the NewSessionModal unmounts. Operates on the Zustand store directly.
 */
import { createSessionStream, type CreateSessionOpts } from "../api.js";
import { connectSession } from "../ws.js";
import { navigateToSession, navigateToMostRecentSession } from "./routing.js";
import { addRecentDir } from "./recent-dirs.js";
import { useStore, type PendingSession } from "../store.js";

// AbortControllers live outside Zustand (not serializable)
const abortControllers = new Map<string, AbortController>();

export function createPendingId(): string {
  return `pending-${crypto.randomUUID()}`;
}

export function isPendingId(id: string | null): boolean {
  return id != null && id.startsWith("pending-");
}

/**
 * Start the SSE creation stream for a pending session that's already in the store.
 * Handles progress updates, success transition, error, and abort.
 */
export function startPendingCreation(pendingId: string): void {
  const pending = useStore.getState().pendingSessions.get(pendingId);
  if (!pending) return;

  const controller = new AbortController();
  abortControllers.set(pendingId, controller);

  // Fire-and-forget — the stream runs in the background
  _runCreation(pendingId, pending, controller.signal).catch(() => {
    // Errors are handled inside _runCreation; this catch prevents unhandled rejection
  });
}

export function queuePendingSession(params: {
  backend: "claude" | "codex";
  createOpts: CreateSessionOpts;
  cwd?: string | null;
}): string {
  const pendingId = createPendingId();
  useStore.getState().addPendingSession({
    id: pendingId,
    backend: params.backend,
    createOpts: params.createOpts,
    progress: [],
    error: null,
    status: "creating",
    realSessionId: null,
    cwd: params.cwd ?? params.createOpts.cwd ?? null,
    groupKey: null,
    createdAt: Date.now(),
  });

  navigateToSession(pendingId);
  startPendingCreation(pendingId);
  return pendingId;
}

/**
 * Retry a failed pending session with the same createOpts.
 */
export function retryPendingCreation(pendingId: string): void {
  const store = useStore.getState();
  const pending = store.pendingSessions.get(pendingId);
  if (!pending) return;

  // Clean up old controller if any
  abortControllers.get(pendingId)?.abort();
  abortControllers.delete(pendingId);

  // Reset state
  store.updatePendingSession(pendingId, {
    progress: [],
    error: null,
    status: "creating",
    realSessionId: null,
  });

  startPendingCreation(pendingId);
}

/**
 * Cancel an in-flight creation and remove the pending session.
 */
export function cancelPendingCreation(pendingId: string): void {
  // Abort the SSE fetch
  abortControllers.get(pendingId)?.abort();
  abortControllers.delete(pendingId);

  const store = useStore.getState();
  store.removePendingSession(pendingId);

  // If the user was viewing this pending session, navigate away
  if (store.currentSessionId === pendingId) {
    navigateToMostRecentSession({ replace: true });
  }
}

async function _runCreation(
  pendingId: string,
  pending: PendingSession,
  signal: AbortSignal,
): Promise<void> {
  try {
    const result = await createSessionStream(
      pending.createOpts,
      (progress) => {
        useStore.getState().addPendingProgress(pendingId, progress);
      },
      signal,
    );

    const sessionId = result.sessionId;

    // Mark succeeded (briefly visible before removal)
    useStore.getState().updatePendingSession(pendingId, {
      status: "succeeded",
      realSessionId: sessionId,
    });

    // Add cwd to recent dirs if applicable
    if (pending.cwd) addRecentDir(pending.cwd);

    // Transition: if user is viewing the pending session, seamlessly switch to real session
    const currentId = useStore.getState().currentSessionId;
    if (currentId === pendingId) {
      navigateToSession(sessionId, true); // replaceState — no flash
    }

    connectSession(sessionId);

    // Clean up the pending session after a brief delay (let the UI flash "succeeded")
    setTimeout(() => {
      useStore.getState().removePendingSession(pendingId);
    }, 300);
  } catch (e: unknown) {
    // AbortError = user cancelled — silently clean up (cancelPendingCreation already removed it)
    if (e instanceof DOMException && e.name === "AbortError") {
      return;
    }
    const errMsg = e instanceof Error ? e.message : String(e);
    useStore.getState().updatePendingSession(pendingId, {
      status: "error",
      error: errMsg,
    });
  } finally {
    abortControllers.delete(pendingId);
  }
}
