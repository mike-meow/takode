import type {
  BrowserIncomingMessage,
  ContentBlock,
  ThreadAttachmentMarker,
  ThreadRef,
  ThreadWindowEntry,
  ThreadWindowState,
  ThreadTransitionMarker,
} from "../server/session-types.js";
import {
  inferThreadTargetFromTextContent,
  isQuestThreadKey,
  parseCommandThreadComment,
  parseThreadTextPrefix,
} from "./thread-routing.js";

export const MAIN_THREAD_KEY = "main";
export const ALL_THREADS_KEY = "all";

export interface BuildThreadWindowInput {
  messageHistory: ReadonlyArray<BrowserIncomingMessage>;
  threadKey: string;
  fromItem: number;
  itemCount: number;
  sectionItemCount: number;
  visibleItemCount: number;
}

interface FeedItem {
  entry: ThreadWindowEntry;
  order: number;
}

type RouteTarget = { threadKey: string; questId?: string };

export function normalizeSelectedFeedThreadKey(threadKey: string): string {
  const normalized = threadKey.trim().toLowerCase();
  return normalized || MAIN_THREAD_KEY;
}

export function getThreadWindowItemCount(visibleItemCount: number, sectionItemCount: number): number {
  return Math.max(1, Math.floor(visibleItemCount)) * Math.max(1, Math.floor(sectionItemCount));
}

export function buildThreadWindowSync(input: BuildThreadWindowInput): {
  threadKey: string;
  entries: ThreadWindowEntry[];
  window: ThreadWindowState;
} {
  const threadKey = normalizeSelectedFeedThreadKey(input.threadKey);
  const sectionItemCount = Math.max(1, Math.floor(input.sectionItemCount));
  const visibleItemCount = Math.max(1, Math.floor(input.visibleItemCount));
  const requestedItemCount = Math.max(
    1,
    Math.floor(input.itemCount || getThreadWindowItemCount(visibleItemCount, sectionItemCount)),
  );
  const items = buildFeedItems(input.messageHistory, threadKey);
  const totalItems = items.length;
  const requestedFromItem = Math.floor(input.fromItem);
  const fromItem =
    totalItems === 0
      ? 0
      : requestedFromItem < 0
        ? Math.max(0, totalItems - requestedItemCount)
        : Math.max(0, Math.min(requestedFromItem, Math.max(0, totalItems - 1)));
  const endItem = Math.min(totalItems, fromItem + requestedItemCount);
  const selectedItems = items.slice(fromItem, endItem);
  const entries = dedupeEntries(expandToolClosureItems(input.messageHistory, threadKey, selectedItems));
  return {
    threadKey,
    entries,
    window: {
      thread_key: threadKey,
      from_item: fromItem,
      item_count: Math.max(0, endItem - fromItem),
      total_items: totalItems,
      source_history_length: input.messageHistory.length,
      section_item_count: sectionItemCount,
      visible_item_count: visibleItemCount,
    },
  };
}

function buildFeedItems(messages: ReadonlyArray<BrowserIncomingMessage>, threadKey: string): FeedItem[] {
  if (threadKey === ALL_THREADS_KEY) {
    return messages.map((message, index) => ({ order: index, entry: { message, history_index: index } }));
  }
  if (threadKey === MAIN_THREAD_KEY) return buildMainFeedItems(messages);
  return buildQuestThreadFeedItems(messages, threadKey);
}

function buildMainFeedItems(messages: ReadonlyArray<BrowserIncomingMessage>): FeedItem[] {
  const markerTargets = collectMarkerBackfillTargets(messages);
  const items: FeedItem[] = [];
  let hiddenRun: Array<{ message: BrowserIncomingMessage; index: number }> = [];
  let hiddenRunRoute: RouteTarget | null = null;

  const flushHiddenRun = () => {
    if (!hiddenRunRoute || hiddenRun.length === 0) return;
    if (!isQuestThreadKey(hiddenRunRoute.threadKey)) {
      items.push(buildCrossThreadActivityItem(hiddenRun, hiddenRunRoute));
    }
    hiddenRun = [];
    hiddenRunRoute = null;
  };

  messages.forEach((message, index) => {
    if (message.type === "thread_attachment_marker") {
      flushHiddenRun();
      items.push({ order: index, entry: { message, history_index: index } });
      return;
    }
    if (message.type === "thread_transition_marker") {
      flushHiddenRun();
      if (normalizeSelectedFeedThreadKey(message.sourceThreadKey) === MAIN_THREAD_KEY) {
        items.push({ order: index, entry: { message, history_index: index } });
      }
      return;
    }
    if (isCoveredBackfillMessage(message, index, markerTargets)) return;
    if (!hasExplicitNonMainRoute(message)) {
      flushHiddenRun();
      items.push({ order: index, entry: { message, history_index: index } });
      return;
    }

    const route = explicitNonMainRoute(message);
    if (!route || isHerdEventMessage(message)) return;
    if (hiddenRunRoute && hiddenRunRoute.threadKey !== route.threadKey) {
      flushHiddenRun();
    }
    hiddenRunRoute = route;
    hiddenRun.push({ message, index });
  });

  flushHiddenRun();
  return items;
}

function buildQuestThreadFeedItems(messages: ReadonlyArray<BrowserIncomingMessage>, threadKey: string): FeedItem[] {
  const includedToolUseIds = new Set<string>();
  messages.forEach((message) => {
    if (
      !messageHasThreadRef(message, threadKey) &&
      !threadSystemMarkerVisibleInQuestThread(message, messages, threadKey)
    ) {
      return;
    }
    for (const toolUseId of messageToolUseIds(message)) includedToolUseIds.add(toolUseId);
    if (message.type === "tool_result_preview") {
      for (const preview of message.previews) includedToolUseIds.add(preview.tool_use_id);
    }
    if (typeof (message as { parent_tool_use_id?: unknown }).parent_tool_use_id === "string") {
      includedToolUseIds.add((message as { parent_tool_use_id: string }).parent_tool_use_id);
    }
  });

  const items: FeedItem[] = [];
  messages.forEach((message, index) => {
    if (threadSystemMarkerVisibleInQuestThread(message, messages, threadKey)) {
      items.push({ order: index, entry: { message, history_index: index } });
      return;
    }
    if (messageHasThreadRef(message, threadKey)) {
      items.push({ order: index, entry: { message, history_index: index } });
      return;
    }
    const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
    if (typeof parentToolUseId === "string" && includedToolUseIds.has(parentToolUseId)) {
      items.push({ order: index, entry: { message, history_index: index } });
      return;
    }
    if (messageToolUseIds(message).some((toolUseId) => includedToolUseIds.has(toolUseId))) {
      items.push({ order: index, entry: { message, history_index: index } });
    }
  });
  return items;
}

function expandToolClosureItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
  selectedItems: FeedItem[],
): FeedItem[] {
  if (threadKey === MAIN_THREAD_KEY || threadKey === ALL_THREADS_KEY || selectedItems.length === 0) {
    return selectedItems;
  }

  const selectedToolUseIds = new Set<string>();
  for (const item of selectedItems) {
    for (const toolUseId of relatedToolUseIds(item.entry.message)) {
      selectedToolUseIds.add(toolUseId);
    }
  }
  if (selectedToolUseIds.size === 0) return selectedItems;

  const expanded = [...selectedItems];
  messages.forEach((message, index) => {
    if (!relatedToolUseIds(message).some((toolUseId) => selectedToolUseIds.has(toolUseId))) return;
    expanded.push({ order: index, entry: { message, history_index: index } });
  });
  return expanded;
}

function dedupeEntries(items: FeedItem[]): ThreadWindowEntry[] {
  const seen = new Set<string>();
  const entries: ThreadWindowEntry[] = [];
  for (const item of items.sort((a, b) => a.order - b.order)) {
    const id = rawMessageId(item.entry.message, item.entry.history_index);
    const key = `${item.entry.history_index}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(item.entry);
  }
  return entries;
}

function buildCrossThreadActivityItem(
  hiddenRun: ReadonlyArray<{ message: BrowserIncomingMessage; index: number }>,
  route: RouteTarget,
): FeedItem {
  const first = hiddenRun[0]!;
  const last = hiddenRun[hiddenRun.length - 1] ?? first;
  const firstId = rawMessageId(first.message, first.index);
  const lastId = rawMessageId(last.message, last.index);
  return {
    order: first.index,
    entry: {
      synthetic: true,
      history_index: first.index,
      message: {
        type: "cross_thread_activity_marker",
        id: `cross-thread-activity:${route.threadKey}:${firstId}`,
        timestamp: timestampForRawMessage(last.message),
        threadKey: route.threadKey,
        ...(route.questId ? { questId: route.questId } : {}),
        count: hiddenRun.length,
        firstMessageId: firstId,
        lastMessageId: lastId,
        firstHistoryIndex: first.index,
        lastHistoryIndex: last.index,
        startedAt: timestampForRawMessage(first.message),
        updatedAt: timestampForRawMessage(last.message),
      } as BrowserIncomingMessage,
    },
  };
}

function normalizedRouteKeys(message: BrowserIncomingMessage, includeBackfill: boolean): Set<string> {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const normalized = normalizeSelectedFeedThreadKey(value);
    if (!normalized || normalized === MAIN_THREAD_KEY) return;
    keys.add(normalized);
  };

  if (message.type === "thread_attachment_marker" || message.type === "thread_transition_marker") return keys;

  add(message.threadKey);
  add(message.questId);
  for (const ref of message.threadRefs ?? []) {
    if (!includeBackfill && ref.source === "backfill") continue;
    add(ref.threadKey);
    add(ref.questId);
  }

  const repaired = repairedRouteForMessage(message);
  add(repaired?.threadKey);
  add(repaired?.questId);

  const inferred = inferredHerdEventRoute(message);
  add(inferred?.threadKey);
  add(inferred?.questId);
  return keys;
}

function messageHasThreadRef(message: BrowserIncomingMessage, threadKey: string): boolean {
  return normalizedRouteKeys(message, true).has(normalizeSelectedFeedThreadKey(threadKey));
}

function hasExplicitNonMainRoute(message: BrowserIncomingMessage): boolean {
  return normalizedRouteKeys(message, false).size > 0;
}

function explicitNonMainRoute(message: BrowserIncomingMessage): RouteTarget | null {
  const metadataRoute = routeFromMessageFields(message, false);
  if (metadataRoute) return metadataRoute;
  return repairedRouteForMessage(message) ?? inferredHerdEventRoute(message);
}

function routeFromMessageFields(message: BrowserIncomingMessage, includeBackfill: boolean): RouteTarget | null {
  if (message.type === "thread_attachment_marker" || message.type === "thread_transition_marker") return null;
  if (message.threadKey && normalizeSelectedFeedThreadKey(message.threadKey) !== MAIN_THREAD_KEY) {
    return {
      threadKey: normalizeSelectedFeedThreadKey(message.threadKey),
      ...(message.questId ? { questId: message.questId } : {}),
    };
  }
  if (message.questId && normalizeSelectedFeedThreadKey(message.questId) !== MAIN_THREAD_KEY) {
    return { threadKey: normalizeSelectedFeedThreadKey(message.questId), questId: message.questId };
  }
  const ref = (message.threadRefs ?? []).find((candidate) => {
    return (
      (includeBackfill || candidate.source !== "backfill") &&
      normalizeSelectedFeedThreadKey(candidate.threadKey) !== MAIN_THREAD_KEY
    );
  });
  if (!ref) return null;
  return {
    threadKey: normalizeSelectedFeedThreadKey(ref.threadKey),
    ...(ref.questId ? { questId: ref.questId } : {}),
  };
}

function repairedRouteForMessage(message: BrowserIncomingMessage): RouteTarget | null {
  if (message.type === "user_message" || message.type === "leader_user_message") {
    const parsed = parseThreadTextPrefix(message.content);
    return parsed.ok ? parsed.target : null;
  }
  if (message.type !== "assistant") return null;
  const content = message.message.content;
  const firstText = content.find((block) => block.type === "text" && block.text.trim());
  if (firstText?.type === "text") {
    const parsed = parseThreadTextPrefix(firstText.text);
    if (parsed.ok) return parsed.target;
  }
  const firstBash = content.find(
    (block) => block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string",
  );
  if (!firstBash || firstBash.type !== "tool_use" || typeof firstBash.input.command !== "string") return null;
  return parseCommandThreadComment(firstBash.input.command);
}

function isHerdEventMessage(message: BrowserIncomingMessage): boolean {
  return (message as { agentSource?: { sessionId?: string } }).agentSource?.sessionId === "herd-events";
}

function inferredHerdEventRoute(message: BrowserIncomingMessage): RouteTarget | null {
  if (!isHerdEventMessage(message)) return null;
  const content = message.type === "user_message" ? message.content : null;
  if (typeof content !== "string") return null;
  const target = inferThreadTargetFromTextContent(content);
  if (!target || normalizeSelectedFeedThreadKey(target.threadKey) === MAIN_THREAD_KEY) return null;
  return {
    threadKey: normalizeSelectedFeedThreadKey(target.threadKey),
    ...(target.questId ? { questId: target.questId } : {}),
  };
}

function collectMarkerBackfillTargets(messages: ReadonlyArray<BrowserIncomingMessage>): {
  ids: Set<string>;
  indices: Set<number>;
} {
  const ids = new Set<string>();
  const indices = new Set<number>();
  for (const message of messages) {
    if (message.type !== "thread_attachment_marker") continue;
    message.messageIds.forEach((id) => ids.add(id));
    message.messageIndices.forEach((index) => indices.add(index));
  }
  return { ids, indices };
}

function hasBackfillThreadRef(message: BrowserIncomingMessage): boolean {
  return (message.threadRefs ?? []).some((ref: ThreadRef) => ref.source === "backfill");
}

function isCoveredBackfillMessage(
  message: BrowserIncomingMessage,
  historyIndex: number,
  targets: { ids: Set<string>; indices: Set<number> },
): boolean {
  if (!hasBackfillThreadRef(message)) return false;
  if (targets.ids.has(rawMessageId(message, historyIndex))) return true;
  return targets.indices.has(historyIndex);
}

function markerCoversMessage(marker: ThreadAttachmentMarker, message: BrowserIncomingMessage, index: number): boolean {
  if (marker.messageIds.includes(rawMessageId(message, index))) return true;
  return marker.messageIndices.includes(index);
}

function attachmentMarkerSourceMatchesThread(
  marker: ThreadAttachmentMarker,
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
): boolean {
  const target = normalizeSelectedFeedThreadKey(threadKey);
  if (normalizeSelectedFeedThreadKey(marker.sourceThreadKey ?? "") === target) return true;
  if (normalizeSelectedFeedThreadKey(marker.sourceQuestId ?? "") === target) return true;

  return messages.some((message, index) => {
    if (!markerCoversMessage(marker, message, index)) return false;
    return normalizedRouteKeys(message, false).has(target);
  });
}

function transitionMarkerSourceMatchesThread(marker: ThreadTransitionMarker, threadKey: string): boolean {
  const target = normalizeSelectedFeedThreadKey(threadKey);
  return (
    normalizeSelectedFeedThreadKey(marker.sourceThreadKey) === target ||
    normalizeSelectedFeedThreadKey(marker.sourceQuestId ?? "") === target
  );
}

function threadSystemMarkerVisibleInQuestThread(
  message: BrowserIncomingMessage,
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
): boolean {
  if (message.type === "thread_attachment_marker")
    return attachmentMarkerSourceMatchesThread(message, messages, threadKey);
  if (message.type === "thread_transition_marker") return transitionMarkerSourceMatchesThread(message, threadKey);
  return false;
}

function messageToolUseIds(message: BrowserIncomingMessage): string[] {
  const blocks = contentBlocksForMessage(message);
  return blocks
    .map((block) => {
      if (block.type === "tool_use") return block.id;
      if (block.type === "tool_result") return block.tool_use_id;
      return null;
    })
    .filter((id): id is string => Boolean(id));
}

function relatedToolUseIds(message: BrowserIncomingMessage): string[] {
  const ids = new Set(messageToolUseIds(message));
  if (message.type === "tool_result_preview") {
    for (const preview of message.previews) ids.add(preview.tool_use_id);
  }
  const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  if (typeof parentToolUseId === "string") ids.add(parentToolUseId);
  return [...ids];
}

function contentBlocksForMessage(message: BrowserIncomingMessage): ContentBlock[] {
  if (message.type === "assistant") return message.message.content;
  return [];
}

function rawMessageId(message: BrowserIncomingMessage, fallbackIndex: number): string {
  if ("id" in message && typeof message.id === "string") return message.id;
  if (message.type === "assistant") return message.message.id;
  return `history-${fallbackIndex}`;
}

function timestampForRawMessage(message: BrowserIncomingMessage): number {
  if ("timestamp" in message && typeof message.timestamp === "number") return message.timestamp;
  return Date.now();
}
