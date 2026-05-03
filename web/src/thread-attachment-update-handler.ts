import { FEED_WINDOW_SYNC_VERSION } from "../shared/feed-window-sync.js";
import {
  getHistoryWindowTurnCount,
  HISTORY_WINDOW_SECTION_TURN_COUNT,
  HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
} from "../shared/history-window.js";
import { getThreadWindowItemCount, MAIN_THREAD_KEY } from "../shared/thread-window.js";
import { useStore } from "./store.js";
import type { ChatMessage, ThreadAttachmentUpdate } from "./types.js";
import { normalizeHistoryMessageToChatMessages } from "./utils/history-message-normalization.js";
import { invalidateHistoryWindowCache, invalidateThreadWindowCache } from "./utils/history-window-cache.js";
import { recordFrontendPerfEntry } from "./utils/frontend-perf-recorder.js";
import { isAllThreadsKey, isMainThreadKey, normalizeThreadKey } from "./utils/thread-projection.js";
import type { WsMessageHandlerDeps } from "./ws-handlers.js";

const APPLIED_UPDATE_ID_LIMIT = 200;

const appliedUpdateIdsBySession = new Map<string, Set<string>>();

type SafeThreadAttachmentUpdateEntry = ThreadAttachmentUpdate["updates"][number];

interface SafeThreadAttachmentUpdate {
  updateId: string;
  affectedThreadKeys: string[];
  updates: SafeThreadAttachmentUpdateEntry[];
}

export function applyThreadAttachmentUpdate(
  sessionId: string,
  update: ThreadAttachmentUpdate,
  deps: WsMessageHandlerDeps,
): void {
  const startedAt = perfNow();
  const normalized = normalizeThreadAttachmentUpdate(update);
  if (!normalized.ok) {
    const affectedThreadKeys = normalized.affectedThreadKeys;
    invalidateThreadAttachmentWindows(sessionId, affectedThreadKeys);
    requestLatestMainWindow(sessionId, deps);
    const requestedThreadWindowCount = requestAffectedThreadWindows(sessionId, affectedThreadKeys, deps);
    recordFrontendPerfEntry({
      kind: "thread_attachment_update_apply",
      timestamp: Date.now(),
      sessionId,
      ...normalized.stats,
      requestedHistoryWindowCount: 1,
      requestedThreadWindowCount,
      durationMs: perfNow() - startedAt,
      ok: false,
      recoveryReason: normalized.recoveryReason,
    });
    return;
  }

  const safeUpdate = normalized.update;
  const stats = threadAttachmentUpdateStats(safeUpdate);

  if (hasAppliedThreadAttachmentUpdate(sessionId, safeUpdate.updateId)) {
    recordFrontendPerfEntry({
      kind: "thread_attachment_update_apply",
      timestamp: Date.now(),
      sessionId,
      ...stats,
      requestedHistoryWindowCount: 0,
      requestedThreadWindowCount: 0,
      durationMs: perfNow() - startedAt,
      ok: true,
      deduped: true,
    });
    return;
  }

  rememberAppliedThreadAttachmentUpdate(sessionId, safeUpdate.updateId);
  invalidateThreadAttachmentWindows(sessionId, safeUpdate.affectedThreadKeys);
  patchLoadedThreadRefs(sessionId, safeUpdate);
  appendThreadAttachmentMarkers(sessionId, safeUpdate);
  requestLatestMainWindow(sessionId, deps);
  const requestedThreadWindowCount = requestAffectedThreadWindows(sessionId, safeUpdate.affectedThreadKeys, deps);

  recordFrontendPerfEntry({
    kind: "thread_attachment_update_apply",
    timestamp: Date.now(),
    sessionId,
    ...stats,
    requestedHistoryWindowCount: 1,
    requestedThreadWindowCount,
    durationMs: perfNow() - startedAt,
    ok: true,
  });
}

function normalizeThreadAttachmentUpdate(update: ThreadAttachmentUpdate):
  | { ok: true; update: SafeThreadAttachmentUpdate }
  | {
      ok: false;
      recoveryReason: string;
      affectedThreadKeys: string[];
      stats: ReturnType<typeof malformedThreadAttachmentUpdateStats>;
    } {
  const raw = update as unknown as Record<string, unknown>;
  const affectedThreadKeys = safeAffectedThreadKeys(raw);
  const recovery = (recoveryReason: string) => ({
    ok: false as const,
    recoveryReason,
    affectedThreadKeys,
    stats: malformedThreadAttachmentUpdateStats(raw, affectedThreadKeys),
  });

  if (raw.version !== 1) return recovery("unsupported_version");
  if (typeof raw.updateId !== "string" || !raw.updateId.trim()) return recovery("missing_update_id");
  if (!Array.isArray(raw.affectedThreadKeys)) return recovery("invalid_affected_thread_keys");
  if (affectedThreadKeys.length !== raw.affectedThreadKeys.length) return recovery("invalid_affected_thread_keys");
  if (!Array.isArray(raw.updates)) return recovery("missing_updates");

  for (const item of raw.updates) {
    if (!isRecord(item)) return recovery("invalid_update_entry");
    if (!Array.isArray(item.markers)) return recovery("invalid_markers");
    if (!item.markers.every(isValidThreadAttachmentMarkerRecord)) return recovery("invalid_markers");
    if (
      !Array.isArray(item.markerHistoryIndices) ||
      item.markerHistoryIndices.length !== item.markers.length ||
      !item.markerHistoryIndices.every(isSafeHistoryIndex)
    ) {
      return recovery("invalid_marker_history_indices");
    }
    if (!Array.isArray(item.changedMessages)) return recovery("invalid_changed_messages");
    if (!item.changedMessages.every(isValidChangedMessageRecord)) return recovery("invalid_changed_message_record");
  }

  return {
    ok: true,
    update: {
      updateId: raw.updateId,
      affectedThreadKeys,
      updates: raw.updates as SafeThreadAttachmentUpdateEntry[],
    },
  };
}

function hasAppliedThreadAttachmentUpdate(sessionId: string, updateId: string): boolean {
  return appliedUpdateIdsBySession.get(sessionId)?.has(updateId) ?? false;
}

function rememberAppliedThreadAttachmentUpdate(sessionId: string, updateId: string): void {
  const existing = appliedUpdateIdsBySession.get(sessionId) ?? new Set<string>();
  existing.add(updateId);
  while (existing.size > APPLIED_UPDATE_ID_LIMIT) {
    const oldest = existing.values().next().value;
    if (!oldest) break;
    existing.delete(oldest);
  }
  appliedUpdateIdsBySession.set(sessionId, existing);
}

function invalidateThreadAttachmentWindows(sessionId: string, affectedThreadKeys: string[]): void {
  const store = useStore.getState();
  invalidateHistoryWindowCache(sessionId);
  store.setHistoryWindow(sessionId, null);
  for (const threadKey of uniqueThreadKeys(affectedThreadKeys)) {
    if (isMainThreadKey(threadKey) || isAllThreadsKey(threadKey)) continue;
    invalidateThreadWindowCache(sessionId, threadKey);
    store.setThreadWindow(sessionId, threadKey, null);
  }
}

function patchLoadedThreadRefs(sessionId: string, update: SafeThreadAttachmentUpdate): void {
  const store = useStore.getState();
  const messages = store.messages.get(sessionId) ?? [];
  for (const changed of update.updates.flatMap((item) => item.changedMessages)) {
    const message = findLoadedMessage(messages, changed.historyIndex, changed.messageId);
    if (!message) continue;
    store.updateMessage(sessionId, message.id, {
      metadata: {
        ...(message.metadata ?? {}),
        threadRefs: changed.threadRefs,
      },
    });
  }
}

function findLoadedMessage(
  messages: ReadonlyArray<ChatMessage>,
  historyIndex: number,
  messageId: string,
): ChatMessage | undefined {
  return (
    messages.find((message) => message.historyIndex === historyIndex) ??
    messages.find((message) => message.id === messageId)
  );
}

function appendThreadAttachmentMarkers(sessionId: string, update: SafeThreadAttachmentUpdate): void {
  const store = useStore.getState();
  for (const item of update.updates) {
    item.markers.forEach((marker, index) => {
      const historyIndex = item.markerHistoryIndices[index] ?? -1;
      const [message] = normalizeHistoryMessageToChatMessages(marker, historyIndex);
      if (message) store.appendMessage(sessionId, message);
    });
  }
}

function requestLatestMainWindow(sessionId: string, deps: WsMessageHandlerDeps): void {
  deps.sendToSession(sessionId, {
    type: "history_window_request",
    from_turn: -1,
    turn_count: getHistoryWindowTurnCount(HISTORY_WINDOW_VISIBLE_SECTION_COUNT, HISTORY_WINDOW_SECTION_TURN_COUNT),
    section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
    visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
    feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
  });
}

function requestAffectedThreadWindows(
  sessionId: string,
  affectedThreadKeys: string[],
  deps: WsMessageHandlerDeps,
): number {
  let requested = 0;
  for (const threadKey of uniqueThreadKeys(affectedThreadKeys)) {
    if (isMainThreadKey(threadKey) || isAllThreadsKey(threadKey)) continue;
    deps.sendToSession(sessionId, {
      type: "thread_window_request",
      thread_key: threadKey,
      from_item: -1,
      item_count: getThreadWindowItemCount(HISTORY_WINDOW_VISIBLE_SECTION_COUNT, HISTORY_WINDOW_SECTION_TURN_COUNT),
      section_item_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_item_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
    });
    requested++;
  }
  return requested;
}

function threadWindowRequestCount(affectedThreadKeys: string[]): number {
  return uniqueThreadKeys(affectedThreadKeys).filter(
    (threadKey) => !isMainThreadKey(threadKey) && !isAllThreadsKey(threadKey),
  ).length;
}

function uniqueThreadKeys(threadKeys: string[]): string[] {
  const keys = new Set<string>();
  for (const threadKey of threadKeys) {
    const normalized = normalizeThreadKey(threadKey || MAIN_THREAD_KEY) || MAIN_THREAD_KEY;
    keys.add(normalized);
  }
  return [...keys];
}

function threadAttachmentUpdateStats(update: SafeThreadAttachmentUpdate): {
  updateCount: number;
  markerCount: number;
  changedMessageCount: number;
  affectedThreadCount: number;
} {
  return {
    updateCount: update.updates.length,
    markerCount: update.updates.reduce((count, item) => count + item.markers.length, 0),
    changedMessageCount: update.updates.reduce((count, item) => count + item.changedMessages.length, 0),
    affectedThreadCount: update.affectedThreadKeys.length,
  };
}

function malformedThreadAttachmentUpdateStats(
  raw: Record<string, unknown>,
  affectedThreadKeys: string[],
): {
  updateCount: number;
  markerCount: number;
  changedMessageCount: number;
  affectedThreadCount: number;
} {
  const updates = Array.isArray(raw.updates) ? raw.updates.filter(isRecord) : [];
  return {
    updateCount: updates.length,
    markerCount: updates.reduce((count, item) => count + (Array.isArray(item.markers) ? item.markers.length : 0), 0),
    changedMessageCount: updates.reduce(
      (count, item) => count + (Array.isArray(item.changedMessages) ? item.changedMessages.length : 0),
      0,
    ),
    affectedThreadCount: affectedThreadKeys.length,
  };
}

function safeAffectedThreadKeys(raw: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  addThreadKeyValues(keys, raw.affectedThreadKeys);
  if (Array.isArray(raw.updates)) {
    for (const item of raw.updates) {
      if (!isRecord(item)) continue;
      addRouteKeys(keys, item.target);
      addRouteKeys(keys, item.source);
      if (!Array.isArray(item.markers)) continue;
      for (const marker of item.markers) addRouteKeys(keys, marker);
    }
  }
  return [...keys];
}

function addRouteKeys(keys: Set<string>, value: unknown): void {
  if (!isRecord(value)) return;
  addThreadKeyValues(keys, [value.threadKey, value.questId]);
}

function addThreadKeyValues(keys: Set<string>, values: unknown): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeThreadKey(value);
    if (normalized) keys.add(normalized);
  }
}

function isValidChangedMessageRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isSafeHistoryIndex(value.historyIndex)) return false;
  if (typeof value.messageId !== "string" || !value.messageId.trim()) return false;
  if (!Array.isArray(value.threadRefs)) return false;
  return value.threadRefs.every(isValidThreadRefRecord);
}

function isValidThreadAttachmentMarkerRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type !== "thread_attachment_marker") return false;
  if (typeof value.id !== "string" || !value.id.trim()) return false;
  if (typeof value.markerKey !== "string" || !value.markerKey.trim()) return false;
  if (typeof value.threadKey !== "string" || !value.threadKey.trim()) return false;
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return false;
  if (typeof value.attachedAt !== "number" || !Number.isFinite(value.attachedAt)) return false;
  if (typeof value.attachedBy !== "string" || !value.attachedBy.trim()) return false;
  if (!isSafeHistoryIndex(value.count)) return false;
  if (!Array.isArray(value.messageIds) || !value.messageIds.every((item) => typeof item === "string")) return false;
  if (!Array.isArray(value.messageIndices) || !value.messageIndices.every(isSafeHistoryIndex)) return false;
  return Array.isArray(value.ranges) && value.ranges.every((item) => typeof item === "string");
}

function isValidThreadRefRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.threadKey !== "string" || !value.threadKey.trim()) return false;
  return typeof value.source === "string" && value.source.trim().length > 0;
}

function isSafeHistoryIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function perfNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
