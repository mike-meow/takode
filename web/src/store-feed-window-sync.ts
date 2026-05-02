import type { FeedWindowSync } from "../shared/feed-window-sync.js";
import type { AppState } from "./store-types.js";

type FeedWindowSyncPatch = Pick<AppState, "feedWindowSyncs" | "threadFeedWindowSyncs">;

export function updateFeedWindowSyncState(
  state: AppState,
  sessionId: string,
  sync: FeedWindowSync | null,
): FeedWindowSyncPatch {
  if (!sync) return clearFeedWindowSyncState(state, sessionId);

  if (sync.source === "history_window") {
    const feedWindowSyncs = new Map(state.feedWindowSyncs);
    feedWindowSyncs.set(sessionId, sync);
    return { feedWindowSyncs, threadFeedWindowSyncs: state.threadFeedWindowSyncs };
  }

  const threadKey = normalizeThreadKey(sync.threadKey);
  const threadFeedWindowSyncs = new Map(state.threadFeedWindowSyncs);
  const nextThreadSyncs = new Map(threadFeedWindowSyncs.get(sessionId) ?? []);
  nextThreadSyncs.set(threadKey, sync);
  threadFeedWindowSyncs.set(sessionId, nextThreadSyncs);
  return { feedWindowSyncs: state.feedWindowSyncs, threadFeedWindowSyncs };
}

export function clearFeedWindowSyncState(state: AppState, sessionId: string): FeedWindowSyncPatch {
  const feedWindowSyncs = new Map(state.feedWindowSyncs);
  const threadFeedWindowSyncs = new Map(state.threadFeedWindowSyncs);
  feedWindowSyncs.delete(sessionId);
  threadFeedWindowSyncs.delete(sessionId);
  return { feedWindowSyncs, threadFeedWindowSyncs };
}

export function clearHistoryFeedWindowSyncState(state: AppState, sessionId: string): Pick<AppState, "feedWindowSyncs"> {
  const feedWindowSyncs = new Map(state.feedWindowSyncs);
  feedWindowSyncs.delete(sessionId);
  return { feedWindowSyncs };
}

export function clearThreadFeedWindowSyncState(
  state: AppState,
  sessionId: string,
  threadKey: string,
): Pick<AppState, "threadFeedWindowSyncs"> {
  const normalizedThreadKey = normalizeThreadKey(threadKey);
  const threadFeedWindowSyncs = new Map(state.threadFeedWindowSyncs);
  const nextThreadSyncs = new Map(threadFeedWindowSyncs.get(sessionId) ?? []);
  nextThreadSyncs.delete(normalizedThreadKey);
  if (nextThreadSyncs.size > 0) threadFeedWindowSyncs.set(sessionId, nextThreadSyncs);
  else threadFeedWindowSyncs.delete(sessionId);
  return { threadFeedWindowSyncs };
}

function normalizeThreadKey(threadKey: string): string {
  return threadKey.trim().toLowerCase() || "main";
}
