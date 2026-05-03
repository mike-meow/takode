import { MAIN_THREAD_KEY, normalizeThreadKey } from "./thread-projection.js";
import { scopedGetItem, scopedSetItem } from "./scoped-storage.js";

export const SAVE_THREAD_VIEWPORT_EVENT = "takode:save-thread-viewport";

export interface FeedViewportPosition {
  scrollTop: number;
  scrollHeight: number;
  isAtBottom: boolean;
  anchorTurnId?: string | null;
  anchorOffsetTop?: number;
  lastSeenContentBottom?: number | null;
}

interface LeaderSessionViewState {
  version: 1;
  selectedThreadKey: string;
  viewports: Record<string, FeedViewportPosition>;
  updatedAt: number;
}

const LEADER_SESSION_VIEW_STORAGE_PREFIX = "cc-leader-session-view";
const MAX_STORED_THREAD_VIEWPORTS = 24;

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

export function readLeaderSelectedThreadKey(sessionId: string): string | null {
  return readLeaderSessionViewState(sessionId)?.selectedThreadKey ?? null;
}

export function persistLeaderSelectedThreadKey(sessionId: string, threadKey: string): void {
  const selectedThreadKey = normalizeRestorableThreadKey(threadKey);
  if (!selectedThreadKey) return;
  writeLeaderSessionViewState(sessionId, {
    ...(readLeaderSessionViewState(sessionId) ?? emptyLeaderSessionViewState()),
    selectedThreadKey,
    updatedAt: Date.now(),
  });
}

export function readLeaderViewportPosition(sessionId: string, threadKey: string): FeedViewportPosition | null {
  const state = readLeaderSessionViewState(sessionId);
  if (!state) return null;
  const viewportKey = getFeedViewportKey(sessionId, threadKey);
  return state.viewports[viewportKey] ?? null;
}

export function persistLeaderViewportPosition(
  sessionId: string,
  threadKey: string,
  position: FeedViewportPosition,
): void {
  const normalizedThreadKey = normalizeRestorableThreadKey(threadKey);
  const normalizedPosition = normalizeViewportPosition(position);
  if (!normalizedThreadKey || !normalizedPosition) return;
  const viewportKey = getFeedViewportKey(sessionId, normalizedThreadKey);
  const previous = readLeaderSessionViewState(sessionId) ?? emptyLeaderSessionViewState();
  writeLeaderSessionViewState(sessionId, {
    ...previous,
    viewports: limitStoredViewports({
      ...previous.viewports,
      [viewportKey]: normalizedPosition,
    }),
    updatedAt: Date.now(),
  });
}

function leaderSessionViewStorageKey(sessionId: string): string {
  return `${LEADER_SESSION_VIEW_STORAGE_PREFIX}:${sessionId}`;
}

function emptyLeaderSessionViewState(): LeaderSessionViewState {
  return {
    version: 1,
    selectedThreadKey: MAIN_THREAD_KEY,
    viewports: {},
    updatedAt: Date.now(),
  };
}

function readLeaderSessionViewState(sessionId: string): LeaderSessionViewState | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeLeaderSessionViewState(JSON.parse(scopedGetItem(leaderSessionViewStorageKey(sessionId)) ?? "null"));
  } catch {
    return null;
  }
}

function writeLeaderSessionViewState(sessionId: string, state: LeaderSessionViewState): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeLeaderSessionViewState(state);
  if (!normalized) return;
  try {
    scopedSetItem(leaderSessionViewStorageKey(sessionId), JSON.stringify(normalized));
  } catch {
    // Local viewport restore is best-effort; storage failures should not affect chat.
  }
}

function normalizeLeaderSessionViewState(value: unknown): LeaderSessionViewState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return null;
  const selectedThreadKey = normalizeRestorableThreadKey(record.selectedThreadKey);
  if (!selectedThreadKey) return null;
  const viewports = normalizeViewportMap(record.viewports);
  return {
    version: 1,
    selectedThreadKey,
    viewports,
    updatedAt: normalizeFiniteNumber(record.updatedAt) ?? Date.now(),
  };
}

function normalizeViewportMap(value: unknown): Record<string, FeedViewportPosition> {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, rawPosition]) => {
    const position = normalizeViewportPosition(rawPosition);
    return position ? ([[key, position]] as const) : [];
  });
  return Object.fromEntries(entries.slice(-MAX_STORED_THREAD_VIEWPORTS));
}

function limitStoredViewports(viewports: Record<string, FeedViewportPosition>): Record<string, FeedViewportPosition> {
  return Object.fromEntries(Object.entries(viewports).slice(-MAX_STORED_THREAD_VIEWPORTS));
}

function normalizeViewportPosition(value: unknown): FeedViewportPosition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const scrollTop = normalizeFiniteNumber(record.scrollTop);
  const scrollHeight = normalizeFiniteNumber(record.scrollHeight);
  if (scrollTop == null || scrollHeight == null) return null;
  const anchorOffsetTop = normalizeFiniteNumber(record.anchorOffsetTop);
  const lastSeenContentBottom = normalizeFiniteNumber(record.lastSeenContentBottom);
  return {
    scrollTop,
    scrollHeight,
    isAtBottom: record.isAtBottom === true,
    anchorTurnId: typeof record.anchorTurnId === "string" ? record.anchorTurnId : null,
    ...(anchorOffsetTop != null ? { anchorOffsetTop } : {}),
    ...(lastSeenContentBottom != null ? { lastSeenContentBottom } : {}),
  };
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRestorableThreadKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeThreadKey(value || MAIN_THREAD_KEY);
  if (normalized === MAIN_THREAD_KEY || normalized === "all" || /^q-\d+$/.test(normalized)) return normalized;
  return null;
}
