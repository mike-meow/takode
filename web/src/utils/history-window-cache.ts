import type { BrowserIncomingMessage, HistoryWindowState, ThreadWindowEntry, ThreadWindowState } from "../types.js";
import { scopedGetItem, scopedSetItem } from "./scoped-storage.js";
import { normalizeThreadKey } from "./thread-projection.js";

const HISTORY_CACHE_VERSION = 1;
const MAX_HISTORY_ENTRIES_PER_SESSION = 12;
const MAX_THREAD_ENTRIES_PER_THREAD = 12;
const MAX_CACHE_BYTES = 1_500_000;

interface HistoryWindowCacheEntry {
  key: string;
  fromTurn: number;
  turnCount: number;
  sectionTurnCount: number;
  visibleSectionCount: number;
  windowHash: string;
  messages: BrowserIncomingMessage[];
  updatedAt: number;
}

interface ThreadWindowCacheEntry {
  key: string;
  threadKey: string;
  fromItem: number;
  itemCount: number;
  sectionItemCount: number;
  visibleItemCount: number;
  windowHash: string;
  entries: ThreadWindowEntry[];
  updatedAt: number;
}

interface WindowCacheEnvelope<TEntry> {
  version: number;
  entries: TEntry[];
}

export interface HistoryWindowCacheLookup {
  fromTurn: number;
  turnCount: number;
  sectionTurnCount: number;
  visibleSectionCount: number;
}

export interface ThreadWindowCacheLookup {
  threadKey: string;
  fromItem: number;
  itemCount: number;
  sectionItemCount: number;
  visibleItemCount: number;
}

export function getCachedHistoryWindowHash(sessionId: string, lookup: HistoryWindowCacheLookup): string | undefined {
  return readHistoryCache(sessionId).entries.find((entry) => entry.key === historyEntryKey(lookup))?.windowHash;
}

export function getCachedThreadWindowHash(sessionId: string, lookup: ThreadWindowCacheLookup): string | undefined {
  if (lookup.fromItem < 0) return undefined;
  return readThreadCache(sessionId, lookup.threadKey).entries.find((entry) => entry.key === threadEntryKey(lookup))
    ?.windowHash;
}

export function cacheHistoryWindow(sessionId: string, window: HistoryWindowState, messages: BrowserIncomingMessage[]) {
  if (!window.window_hash || messages.length === 0) return;
  const lookup = {
    fromTurn: window.from_turn,
    turnCount: window.turn_count,
    sectionTurnCount: window.section_turn_count,
    visibleSectionCount: window.visible_section_count,
  };
  const entry: HistoryWindowCacheEntry = {
    key: historyEntryKey(lookup),
    ...lookup,
    windowHash: window.window_hash,
    messages,
    updatedAt: Date.now(),
  };
  writeBoundedCache(
    historyStorageKey(sessionId),
    readHistoryCache(sessionId).entries,
    entry,
    MAX_HISTORY_ENTRIES_PER_SESSION,
  );
}

export function cacheThreadWindow(sessionId: string, window: ThreadWindowState, entries: ThreadWindowEntry[]) {
  if (!window.window_hash || entries.length === 0) return;
  const lookup = {
    threadKey: window.thread_key,
    fromItem: window.from_item,
    itemCount: window.item_count,
    sectionItemCount: window.section_item_count,
    visibleItemCount: window.visible_item_count,
  };
  const entry: ThreadWindowCacheEntry = {
    key: threadEntryKey(lookup),
    ...lookup,
    threadKey: normalizeThreadKey(lookup.threadKey),
    windowHash: window.window_hash,
    entries,
    updatedAt: Date.now(),
  };
  writeBoundedCache(
    threadStorageKey(sessionId, lookup.threadKey),
    readThreadCache(sessionId, lookup.threadKey).entries,
    entry,
    MAX_THREAD_ENTRIES_PER_THREAD,
  );
}

export function resolveCachedHistoryWindowMessages(
  sessionId: string,
  window: HistoryWindowState,
): BrowserIncomingMessage[] | null {
  if (!window.window_hash) return null;
  const lookup = {
    fromTurn: window.from_turn,
    turnCount: window.turn_count,
    sectionTurnCount: window.section_turn_count,
    visibleSectionCount: window.visible_section_count,
  };
  const entry = readHistoryCache(sessionId).entries.find(
    (candidate) => candidate.key === historyEntryKey(lookup) && candidate.windowHash === window.window_hash,
  );
  return entry?.messages ?? null;
}

export function resolveCachedThreadWindowEntries(
  sessionId: string,
  window: ThreadWindowState,
): ThreadWindowEntry[] | null {
  if (!window.window_hash) return null;
  const lookup = {
    threadKey: window.thread_key,
    fromItem: window.from_item,
    itemCount: window.item_count,
    sectionItemCount: window.section_item_count,
    visibleItemCount: window.visible_item_count,
  };
  const entry = readThreadCache(sessionId, window.thread_key).entries.find(
    (candidate) => candidate.key === threadEntryKey(lookup) && candidate.windowHash === window.window_hash,
  );
  return entry?.entries ?? null;
}

function historyEntryKey(lookup: HistoryWindowCacheLookup): string {
  return [
    Math.max(0, Math.floor(lookup.fromTurn)),
    Math.max(0, Math.floor(lookup.turnCount)),
    Math.max(1, Math.floor(lookup.sectionTurnCount)),
    Math.max(1, Math.floor(lookup.visibleSectionCount)),
  ].join(":");
}

function threadEntryKey(lookup: ThreadWindowCacheLookup): string {
  return [
    normalizeThreadKey(lookup.threadKey),
    Math.max(0, Math.floor(lookup.fromItem)),
    Math.max(0, Math.floor(lookup.itemCount)),
    Math.max(1, Math.floor(lookup.sectionItemCount)),
    Math.max(1, Math.floor(lookup.visibleItemCount)),
  ].join(":");
}

function historyStorageKey(sessionId: string): string {
  return `cc-history-window-cache:v${HISTORY_CACHE_VERSION}:${sessionId}`;
}

function threadStorageKey(sessionId: string, threadKey: string): string {
  return `cc-thread-window-cache:v${HISTORY_CACHE_VERSION}:${sessionId}:${normalizeThreadKey(threadKey)}`;
}

function readHistoryCache(sessionId: string): WindowCacheEnvelope<HistoryWindowCacheEntry> {
  return readCache(historyStorageKey(sessionId));
}

function readThreadCache(sessionId: string, threadKey: string): WindowCacheEnvelope<ThreadWindowCacheEntry> {
  return readCache(threadStorageKey(sessionId, threadKey));
}

function readCache<TEntry>(storageKey: string): WindowCacheEnvelope<TEntry> {
  if (typeof window === "undefined") return emptyCache();
  const raw = scopedGetItem(storageKey);
  if (!raw) return emptyCache();
  try {
    const parsed = JSON.parse(raw) as WindowCacheEnvelope<TEntry>;
    if (parsed?.version !== HISTORY_CACHE_VERSION || !Array.isArray(parsed.entries)) return emptyCache();
    return parsed;
  } catch {
    return emptyCache();
  }
}

function writeBoundedCache<TEntry extends { key: string; updatedAt: number }>(
  storageKey: string,
  currentEntries: TEntry[],
  entry: TEntry,
  maxEntries: number,
) {
  if (typeof window === "undefined") return;
  const deduped = currentEntries.filter((candidate) => candidate.key !== entry.key);
  const entries = [...deduped, entry].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, maxEntries);
  const envelope: WindowCacheEnvelope<TEntry> = { version: HISTORY_CACHE_VERSION, entries };
  const serialized = JSON.stringify(envelope);
  if (serialized.length > MAX_CACHE_BYTES) return;
  try {
    scopedSetItem(storageKey, serialized);
  } catch {
    // Quota errors should never break authoritative history rendering.
  }
}

function emptyCache<TEntry>(): WindowCacheEnvelope<TEntry> {
  return { version: HISTORY_CACHE_VERSION, entries: [] };
}
