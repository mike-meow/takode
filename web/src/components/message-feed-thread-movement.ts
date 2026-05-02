import type { ChatMessage, SessionAttentionRecord } from "../types.js";
import {
  isMainThreadKey,
  isThreadAttachmentMarkerMessage,
  normalizeThreadKey,
  summarizeThreadAttachmentMarkersForThread,
  threadAttachmentMarkerTargetKey,
} from "../utils/thread-projection.js";

export function enrichThreadOpenedRecordsWithMovement(
  records: SessionAttentionRecord[],
  messages: ReadonlyArray<ChatMessage>,
): SessionAttentionRecord[] {
  let changed = false;
  const enriched = records.map((record) => {
    if (record.type !== "quest_thread_created") return record;
    const threadKey = normalizeThreadKey(record.route.threadKey || record.threadKey);
    const threadAttachmentSummary = summarizeThreadAttachmentMarkersForThread(messages, threadKey);
    if (!threadAttachmentSummary) return record;
    changed = true;
    return { ...record, threadAttachmentSummary };
  });
  return changed ? enriched : records;
}

export function collectMergedThreadAttachmentKeys(records: ReadonlyArray<SessionAttentionRecord>): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    if (record.type !== "quest_thread_created" || !record.threadAttachmentSummary) continue;
    keys.add(normalizeThreadKey(record.threadAttachmentSummary.threadKey));
  }
  return keys;
}

export function collectMergedThreadAttachmentKeysForThread(
  records: ReadonlyArray<SessionAttentionRecord>,
  threadKey: string,
): Set<string> {
  return isMainThreadKey(threadKey) ? collectMergedThreadAttachmentKeys(records) : new Set<string>();
}

export function removeMergedThreadAttachmentMarkers(
  messages: ChatMessage[],
  mergedThreadAttachmentKeys: ReadonlySet<string>,
): ChatMessage[] {
  if (mergedThreadAttachmentKeys.size === 0) return messages;
  return messages.filter((message) => {
    if (!isThreadAttachmentMarkerMessage(message)) return true;
    const marker = message.metadata?.threadAttachmentMarker;
    if (!marker) return true;
    return !mergedThreadAttachmentKeys.has(threadAttachmentMarkerTargetKey(marker));
  });
}
