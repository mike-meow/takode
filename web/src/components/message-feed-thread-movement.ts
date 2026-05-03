import type { ChatMessage, SessionAttentionRecord } from "../types.js";
import {
  isMainThreadKey,
  isThreadAttachmentMarkerMessage,
  threadAttachmentMarkerTargetKey,
} from "../utils/thread-projection.js";

export function enrichThreadOpenedRecordsWithMovement(
  records: SessionAttentionRecord[],
  messages: ReadonlyArray<ChatMessage>,
): SessionAttentionRecord[] {
  void messages;
  return records;
}

export function collectMergedThreadAttachmentKeys(records: ReadonlyArray<SessionAttentionRecord>): Set<string> {
  void records;
  return new Set();
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
