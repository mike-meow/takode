import { ALL_THREADS_KEY, MAIN_THREAD_KEY, normalizeSelectedFeedThreadKey } from "./thread-window.js";

export const LEADER_OPEN_THREAD_TABS_VERSION = 1;
export const MAX_LEADER_OPEN_THREAD_TABS = 50;
export const MAX_LEADER_CLOSED_THREAD_TOMBSTONES = 200;

export interface LeaderClosedThreadTombstone {
  threadKey: string;
  closedAt: number;
}

export interface LeaderOpenThreadTabsState {
  version: typeof LEADER_OPEN_THREAD_TABS_VERSION;
  orderedOpenThreadKeys: string[];
  closedThreadTombstones: LeaderClosedThreadTombstone[];
  updatedAt: number;
  migratedFromLocalStorageAt?: number;
}

export type LeaderThreadTabUpdate =
  | {
      type: "migrate";
      orderedOpenThreadKeys: string[];
      migratedAt?: number;
    }
  | {
      type: "open";
      threadKey: string;
      placement?: "first" | "last";
      source?: "user" | "server_candidate";
      eventAt?: number;
    }
  | {
      type: "close";
      threadKey: string;
      closedAt?: number;
    }
  | {
      type: "reorder";
      orderedOpenThreadKeys: string[];
    }
  | {
      /**
       * Legacy browser operation removed from the product model. Keep it as a
       * runtime no-op so stale clients cannot clear authoritative server state.
       */
      type: "auto_close";
      threadKeys?: unknown[];
    };

export function shouldPersistLeaderThreadTab(threadKey: string): boolean {
  const normalized = normalizeLeaderThreadKey(threadKey);
  return normalized !== MAIN_THREAD_KEY && normalized !== ALL_THREADS_KEY;
}

export function normalizeLeaderThreadKey(threadKey: string): string {
  return normalizeSelectedFeedThreadKey(threadKey);
}

export function normalizeLeaderOpenThreadKeys(threadKeys: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of threadKeys) {
    const rawKey = threadKeyFromLegacyValue(value);
    if (!rawKey) continue;
    const key = normalizeLeaderThreadKey(rawKey);
    if (!shouldPersistLeaderThreadTab(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
    if (result.length >= MAX_LEADER_OPEN_THREAD_TABS) break;
  }
  return result;
}

export function normalizeLeaderOpenThreadTabsState(candidate: unknown): LeaderOpenThreadTabsState | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Partial<LeaderOpenThreadTabsState>;
  if (record.version !== LEADER_OPEN_THREAD_TABS_VERSION) return undefined;
  const updatedAt =
    typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? Math.max(0, record.updatedAt) : 0;
  const migratedFromLocalStorageAt =
    typeof record.migratedFromLocalStorageAt === "number" && Number.isFinite(record.migratedFromLocalStorageAt)
      ? Math.max(0, record.migratedFromLocalStorageAt)
      : undefined;
  return {
    version: LEADER_OPEN_THREAD_TABS_VERSION,
    orderedOpenThreadKeys: normalizeLeaderOpenThreadKeys(record.orderedOpenThreadKeys ?? []),
    closedThreadTombstones: normalizeClosedThreadTombstones(record.closedThreadTombstones ?? []),
    updatedAt,
    ...(migratedFromLocalStorageAt !== undefined ? { migratedFromLocalStorageAt } : {}),
  };
}

export function createLeaderOpenThreadTabsState(now = Date.now()): LeaderOpenThreadTabsState {
  return {
    version: LEADER_OPEN_THREAD_TABS_VERSION,
    orderedOpenThreadKeys: [],
    closedThreadTombstones: [],
    updatedAt: now,
  };
}

export function placeLeaderOpenThreadTabKey(
  existingThreadKeys: ReadonlyArray<string>,
  threadKey: string,
  placement: "first" | "last" = "first",
): string[] {
  const normalized = normalizeLeaderThreadKey(threadKey);
  if (!shouldPersistLeaderThreadTab(normalized)) return normalizeLeaderOpenThreadKeys(existingThreadKeys);
  const withoutTarget = normalizeLeaderOpenThreadKeys(existingThreadKeys).filter((key) => key !== normalized);
  const nextKeys = placement === "first" ? [normalized, ...withoutTarget] : [...withoutTarget, normalized];
  return placement === "first"
    ? normalizeLeaderOpenThreadKeys(nextKeys)
    : normalizeLeaderOpenThreadKeys(nextKeys.slice(-MAX_LEADER_OPEN_THREAD_TABS));
}

export function reorderLeaderOpenThreadKeys(
  existingThreadKeys: ReadonlyArray<string>,
  requestedOrder: ReadonlyArray<unknown>,
): string[] {
  const existing = normalizeLeaderOpenThreadKeys(existingThreadKeys);
  const existingSet = new Set(existing);
  const requested = normalizeLeaderOpenThreadKeys(requestedOrder).filter((key) => existingSet.has(key));
  const requestedSet = new Set(requested);
  return [...requested, ...existing.filter((key) => !requestedSet.has(key))];
}

export function canServerCandidateOpenThread(
  state: LeaderOpenThreadTabsState | undefined,
  threadKey: string,
  eventAt: number | undefined,
): boolean {
  const normalized = normalizeLeaderThreadKey(threadKey);
  if (!shouldPersistLeaderThreadTab(normalized)) return false;
  const tombstone = state?.closedThreadTombstones.find((entry) => entry.threadKey === normalized);
  if (!tombstone) return true;
  return typeof eventAt === "number" && Number.isFinite(eventAt) && eventAt > tombstone.closedAt;
}

export function applyLeaderThreadTabUpdate(
  currentState: LeaderOpenThreadTabsState | undefined,
  update: LeaderThreadTabUpdate | { type?: unknown },
  now = Date.now(),
): LeaderOpenThreadTabsState | undefined {
  const existingState = normalizeLeaderOpenThreadTabsState(currentState);
  if (!update || typeof update !== "object") return existingState;
  const record = update as Record<string, unknown>;

  switch (record.type) {
    case "migrate": {
      if (!Array.isArray(record.orderedOpenThreadKeys)) return existingState;
      const migratedAt = validTimestamp(record.migratedAt) ?? now;
      return {
        version: LEADER_OPEN_THREAD_TABS_VERSION,
        orderedOpenThreadKeys: normalizeLeaderOpenThreadKeys(record.orderedOpenThreadKeys),
        closedThreadTombstones: [],
        updatedAt: migratedAt,
        migratedFromLocalStorageAt: migratedAt,
      };
    }
    case "open": {
      if (typeof record.threadKey !== "string") return existingState;
      const state = existingState ?? createLeaderOpenThreadTabsState(now);
      const threadKey = normalizeLeaderThreadKey(record.threadKey);
      if (!shouldPersistLeaderThreadTab(threadKey)) return state;
      const source = record.source === "server_candidate" ? "server_candidate" : "user";
      const eventAt = validTimestamp(record.eventAt);
      if (source === "server_candidate" && !canServerCandidateOpenThread(state, threadKey, eventAt)) {
        return state;
      }
      const placement = record.placement === "last" ? "last" : "first";
      return {
        ...state,
        orderedOpenThreadKeys: placeLeaderOpenThreadTabKey(state.orderedOpenThreadKeys, threadKey, placement),
        closedThreadTombstones: state.closedThreadTombstones.filter((entry) => entry.threadKey !== threadKey),
        updatedAt: now,
      };
    }
    case "close": {
      if (typeof record.threadKey !== "string") return existingState;
      const state = existingState ?? createLeaderOpenThreadTabsState(now);
      const threadKey = normalizeLeaderThreadKey(record.threadKey);
      if (!shouldPersistLeaderThreadTab(threadKey)) return state;
      const closedAt = validTimestamp(record.closedAt) ?? now;
      return {
        ...state,
        orderedOpenThreadKeys: state.orderedOpenThreadKeys.filter((key) => key !== threadKey),
        closedThreadTombstones: upsertClosedThreadTombstone(state.closedThreadTombstones, { threadKey, closedAt }),
        updatedAt: closedAt,
      };
    }
    case "reorder": {
      if (!existingState || !Array.isArray(record.orderedOpenThreadKeys)) return existingState;
      const orderedOpenThreadKeys = reorderLeaderOpenThreadKeys(
        existingState.orderedOpenThreadKeys,
        record.orderedOpenThreadKeys,
      );
      if (arraysEqual(existingState.orderedOpenThreadKeys, orderedOpenThreadKeys)) return existingState;
      return {
        ...existingState,
        orderedOpenThreadKeys,
        updatedAt: now,
      };
    }
    case "auto_close":
    default:
      return existingState;
  }
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeClosedThreadTombstones(candidate: ReadonlyArray<unknown>): LeaderClosedThreadTombstone[] {
  const seen = new Set<string>();
  const result: LeaderClosedThreadTombstone[] = [];
  for (const value of candidate) {
    if (!value || typeof value !== "object") continue;
    const record = value as Partial<LeaderClosedThreadTombstone>;
    const threadKey = typeof record.threadKey === "string" ? normalizeLeaderThreadKey(record.threadKey) : "";
    if (!shouldPersistLeaderThreadTab(threadKey) || seen.has(threadKey)) continue;
    const closedAt = validTimestamp(record.closedAt);
    if (closedAt === undefined) continue;
    seen.add(threadKey);
    result.push({ threadKey, closedAt });
  }
  return result.sort((left, right) => right.closedAt - left.closedAt).slice(0, MAX_LEADER_CLOSED_THREAD_TOMBSTONES);
}

function upsertClosedThreadTombstone(
  existing: ReadonlyArray<LeaderClosedThreadTombstone>,
  next: LeaderClosedThreadTombstone,
): LeaderClosedThreadTombstone[] {
  return normalizeClosedThreadTombstones([next, ...existing.filter((entry) => entry.threadKey !== next.threadKey)]);
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function threadKeyFromLegacyValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["threadKey", "questId"]) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}
