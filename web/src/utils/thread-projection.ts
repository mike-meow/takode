import type { ChatMessage, ThreadAttachmentMarker } from "../types.js";

export const MAIN_THREAD_KEY = "main";
export const ALL_THREADS_KEY = "all";

export function normalizeThreadKey(threadKey: string): string {
  return threadKey.trim().toLowerCase();
}

export function isMainThreadKey(threadKey: string): boolean {
  return normalizeThreadKey(threadKey) === MAIN_THREAD_KEY;
}

export function isAllThreadsKey(threadKey: string): boolean {
  return normalizeThreadKey(threadKey) === ALL_THREADS_KEY;
}

export function isThreadAttachmentMarkerMessage(message: ChatMessage): boolean {
  return !!message.metadata?.threadAttachmentMarker;
}

export function formatThreadAttachmentMarkerSummary(marker: ThreadAttachmentMarker): string {
  const destination = marker.questId ?? marker.threadKey;
  const countLabel = `${marker.count} message${marker.count === 1 ? "" : "s"}`;
  const rangeLabel = marker.ranges.length > 0 ? ` - ${marker.ranges.join(", ")}` : "";
  return `${countLabel} to ${destination}${rangeLabel}`;
}

function normalizedRouteKeys(message: ChatMessage): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const normalized = normalizeThreadKey(value);
    if (!normalized || normalized === MAIN_THREAD_KEY) return;
    keys.add(normalized);
  };

  const metadata = message.metadata;
  add(metadata?.threadKey);
  add(metadata?.questId);
  for (const ref of metadata?.threadRefs ?? []) {
    add(ref.threadKey);
    add(ref.questId);
  }
  return keys;
}

function messageHasThreadRef(message: ChatMessage, threadKey: string): boolean {
  if (isThreadAttachmentMarkerMessage(message)) return false;
  return normalizedRouteKeys(message).has(normalizeThreadKey(threadKey));
}

function contentBlockToolUseId(block: NonNullable<ChatMessage["contentBlocks"]>[number]): string | null {
  if (block.type === "tool_use") return block.id;
  if (block.type === "tool_result") return block.tool_use_id;
  return null;
}

export function messageToolUseIds(message: ChatMessage): string[] {
  return (message.contentBlocks ?? []).map(contentBlockToolUseId).filter((id): id is string => Boolean(id));
}

export function collectMessageToolUseIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const toolUseId of messageToolUseIds(message)) {
      ids.add(toolUseId);
    }
  }
  return ids;
}

function collectMarkerBackfillTargets(messages: ChatMessage[]): {
  ids: Set<string>;
  indices: Set<number>;
} {
  const ids = new Set<string>();
  const indices = new Set<number>();
  for (const message of messages) {
    const marker = message.metadata?.threadAttachmentMarker;
    if (!marker) continue;
    marker.messageIds.forEach((id) => ids.add(id));
    marker.messageIndices.forEach((index) => indices.add(index));
  }
  return { ids, indices };
}

function hasBackfillThreadRef(message: ChatMessage): boolean {
  return (message.metadata?.threadRefs ?? []).some((ref) => ref.source === "backfill");
}

function isCoveredBackfillMessage(message: ChatMessage, targets: { ids: Set<string>; indices: Set<number> }): boolean {
  if (!hasBackfillThreadRef(message)) return false;
  if (targets.ids.has(message.id)) return true;
  return typeof message.historyIndex === "number" && targets.indices.has(message.historyIndex);
}

function hasExplicitNonMainRoute(message: ChatMessage): boolean {
  if (isThreadAttachmentMarkerMessage(message)) return false;
  const metadata = message.metadata;
  if (!metadata) return false;

  if (metadata.threadKey && !isMainThreadKey(metadata.threadKey)) return true;
  if (metadata.questId && !isMainThreadKey(metadata.questId)) return true;
  return (metadata.threadRefs ?? []).some((ref) => ref.source !== "backfill" && !isMainThreadKey(ref.threadKey));
}

function filterMainThreadMessages(messages: ChatMessage[]): ChatMessage[] {
  const markerTargets = collectMarkerBackfillTargets(messages);
  return messages.filter((message) => {
    if (isThreadAttachmentMarkerMessage(message)) return true;
    if (isCoveredBackfillMessage(message, markerTargets)) return false;
    return !hasExplicitNonMainRoute(message);
  });
}

function filterQuestThreadMessages(messages: ChatMessage[], threadKey: string): ChatMessage[] {
  const includedToolUseIds = new Set<string>();
  for (const message of messages) {
    if (!messageHasThreadRef(message, threadKey)) continue;
    for (const toolUseId of messageToolUseIds(message)) {
      includedToolUseIds.add(toolUseId);
    }
  }

  return messages.filter((message) => {
    if (messageHasThreadRef(message, threadKey)) return true;
    if (message.parentToolUseId && includedToolUseIds.has(message.parentToolUseId)) return true;
    return messageToolUseIds(message).some((toolUseId) => includedToolUseIds.has(toolUseId));
  });
}

export function filterMessagesForThread(messages: ChatMessage[], threadKey: string): ChatMessage[] {
  if (isAllThreadsKey(threadKey)) return messages;
  if (isMainThreadKey(threadKey)) return filterMainThreadMessages(messages);
  return filterQuestThreadMessages(messages, normalizeThreadKey(threadKey));
}
