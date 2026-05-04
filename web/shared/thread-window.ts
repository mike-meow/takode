import type {
  BrowserIncomingMessage,
  ContentBlock,
  ThreadWindowEntry,
  ThreadWindowState,
  ThreadTransitionMarker,
} from "../server/session-types.js";
import { deriveWindowAvailability } from "./window-availability.js";
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

interface ConversationRange {
  startItem: number;
  endItem: number;
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
  const items = buildThreadConversationItems(input.messageHistory, threadKey);
  const ranges = buildConversationRanges(items);
  const totalItems = ranges.length;
  const requestedFromItem = Math.floor(input.fromItem);
  const fromItem =
    totalItems === 0
      ? 0
      : requestedFromItem < 0
        ? Math.max(0, totalItems - requestedItemCount)
        : Math.max(0, Math.min(requestedFromItem, Math.max(0, totalItems - 1)));
  const endItem = Math.min(totalItems, fromItem + requestedItemCount);
  const selectedItems = selectConversationItems(items, ranges.slice(fromItem, endItem));
  const sourceExpandedItems =
    threadKey === MAIN_THREAD_KEY
      ? expandMainAttachmentSourceItems(input.messageHistory, items, selectedItems)
      : selectedItems;
  const entries = dedupeEntries(expandToolClosureItems(input.messageHistory, threadKey, sourceExpandedItems));
  const availability = deriveThreadWindowAvailability({
    items,
    ranges,
    entries,
    fromItem,
    endItem,
  });
  return {
    threadKey,
    entries,
    window: {
      thread_key: threadKey,
      from_item: fromItem,
      item_count: Math.max(0, endItem - fromItem),
      total_items: totalItems,
      ...availability,
      source_history_length: input.messageHistory.length,
      section_item_count: sectionItemCount,
      visible_item_count: visibleItemCount,
    },
  };
}

function deriveThreadWindowAvailability(input: {
  items: FeedItem[];
  ranges: ConversationRange[];
  entries: ThreadWindowEntry[];
  fromItem: number;
  endItem: number;
}) {
  const fallback = deriveWindowAvailability({
    from: input.fromItem,
    count: Math.max(0, input.endItem - input.fromItem),
    total: input.ranges.length,
  });
  if (input.ranges.length === 0 || input.items.length === 0 || input.entries.length === 0) return fallback;

  const itemIndexByKey = new Map<string, number>();
  input.items.forEach((item, index) => {
    itemIndexByKey.set(entryKey(item.entry), index);
  });

  const representedItemIndexes = new Set<number>();
  input.entries.forEach((entry) => {
    const index = itemIndexByKey.get(entryKey(entry));
    if (index !== undefined) representedItemIndexes.add(index);
  });

  const hasUnrepresentedRangeItems = (range: ConversationRange) => {
    for (let index = range.startItem; index < range.endItem; index++) {
      if (!representedItemIndexes.has(index)) return true;
    }
    return false;
  };

  return {
    has_older_items: input.ranges.some((range, index) => index < input.fromItem && hasUnrepresentedRangeItems(range)),
    has_newer_items: input.ranges.some((range, index) => index >= input.endItem && hasUnrepresentedRangeItems(range)),
  };
}

function buildThreadConversationItems(messages: ReadonlyArray<BrowserIncomingMessage>, threadKey: string): FeedItem[] {
  const items = buildFeedItems(messages, threadKey);
  if (threadKey === ALL_THREADS_KEY) return items;
  return dedupeFeedItems(addTurnClosingResults(items, messages));
}

function buildFeedItems(messages: ReadonlyArray<BrowserIncomingMessage>, threadKey: string): FeedItem[] {
  if (threadKey === ALL_THREADS_KEY) {
    return messages.map((message, index) => ({ order: index, entry: { message, history_index: index } }));
  }
  if (threadKey === MAIN_THREAD_KEY) return buildMainFeedItems(messages);
  return buildQuestThreadFeedItems(messages, threadKey);
}

function buildMainFeedItems(messages: ReadonlyArray<BrowserIncomingMessage>): FeedItem[] {
  const items: FeedItem[] = [];
  const toolUseRoutes = toolUseRoutesById(messages);
  let hiddenRun: Array<{ message: BrowserIncomingMessage; index: number }> = [];
  let hiddenRunRoute: RouteTarget | null = null;

  const flushHiddenRun = (throughIndex?: number) => {
    if (!hiddenRunRoute || hiddenRun.length === 0) return;
    const attachAuditItem = buildMainThreadAttachAuditItem(hiddenRun, hiddenRunRoute, messages, throughIndex);
    if (attachAuditItem) {
      items.push(attachAuditItem);
    } else if (!isQuestThreadKey(hiddenRunRoute.threadKey)) {
      items.push(buildCrossThreadActivityItem(hiddenRun, hiddenRunRoute));
    }
    hiddenRun = [];
    hiddenRunRoute = null;
  };

  messages.forEach((message, index) => {
    if (message.type === "tool_result_preview") {
      const visiblePreview = mainVisibleToolResultPreview(message, toolUseRoutes);
      if (!visiblePreview) return;
      if (visiblePreview !== message) {
        flushHiddenRun();
        items.push({ order: index, entry: { message: visiblePreview, history_index: index } });
        return;
      }
    }
    if (message.type === "thread_attachment_marker") {
      flushHiddenRun(index);
      return;
    }
    if (message.type === "thread_transition_marker") {
      flushHiddenRun();
      if (normalizeSelectedFeedThreadKey(message.sourceThreadKey) === MAIN_THREAD_KEY) {
        items.push({ order: index, entry: { message, history_index: index } });
      }
      return;
    }
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

function toolUseRoutesById(messages: ReadonlyArray<BrowserIncomingMessage>): Map<string, RouteTarget | null> {
  const routes = new Map<string, RouteTarget | null>();
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    const route = explicitNonMainRoute(message);
    for (const block of message.message.content) {
      if (block.type !== "tool_use") continue;
      routes.set(block.id, route);
    }
  }
  return routes;
}

function mainVisibleToolResultPreview(
  message: Extract<BrowserIncomingMessage, { type: "tool_result_preview" }>,
  toolUseRoutes: ReadonlyMap<string, RouteTarget | null>,
): BrowserIncomingMessage | null {
  const previews = message.previews.filter((preview) => {
    const route = toolUseRoutes.get(preview.tool_use_id);
    return !route || !isQuestThreadKey(route.threadKey);
  });
  if (previews.length === 0) return null;
  if (previews.length === message.previews.length) return message;
  return { ...message, previews };
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

function addTurnClosingResults(items: FeedItem[], messages: ReadonlyArray<BrowserIncomingMessage>): FeedItem[] {
  if (items.length === 0) return items;

  const includedIndexes = new Set(items.map((item) => item.order));
  const additions: FeedItem[] = [];
  for (const range of buildMessageTurnRanges(messages)) {
    const endMessage = messages[range.endIndex];
    if (endMessage?.type !== "result") continue;
    let hasIncludedTurnContent = false;
    for (let index = range.startIndex; index < range.endIndex; index++) {
      if (includedIndexes.has(index)) {
        hasIncludedTurnContent = true;
        break;
      }
    }
    if (!hasIncludedTurnContent || includedIndexes.has(range.endIndex)) continue;
    additions.push({
      order: range.endIndex,
      entry: { message: endMessage, history_index: range.endIndex },
    });
  }

  return additions.length === 0 ? items : [...items, ...additions];
}

function buildMessageTurnRanges(
  messages: ReadonlyArray<BrowserIncomingMessage>,
): Array<{ startIndex: number; endIndex: number }> {
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  let startIndex = messages.length > 0 ? 0 : -1;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.type === "user_message") {
      if (startIndex >= 0 && index > startIndex) {
        ranges.push({ startIndex, endIndex: index - 1 });
      }
      startIndex = index;
      continue;
    }
    if (message.type === "result" && startIndex >= 0) {
      ranges.push({ startIndex, endIndex: index });
      startIndex = index + 1;
    }
  }

  if (startIndex >= 0 && startIndex < messages.length) {
    ranges.push({ startIndex, endIndex: messages.length - 1 });
  }
  return ranges;
}

function buildConversationRanges(items: FeedItem[]): ConversationRange[] {
  if (items.length === 0) return [];

  const ranges: ConversationRange[] = [];
  let startItem = 0;
  for (let index = 0; index < items.length; index++) {
    const message = items[index]?.entry.message;
    if (message?.type === "user_message" && index > startItem) {
      ranges.push({ startItem, endItem: index });
      startItem = index;
      continue;
    }
    if (message?.type === "result") {
      ranges.push({ startItem, endItem: index + 1 });
      startItem = index + 1;
    }
  }

  if (startItem < items.length) {
    ranges.push({ startItem, endItem: items.length });
  }
  return ranges;
}

function selectConversationItems(items: FeedItem[], ranges: ConversationRange[]): FeedItem[] {
  return ranges.flatMap((range) => items.slice(range.startItem, range.endItem));
}

function expandMainAttachmentSourceItems(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  allItems: FeedItem[],
  selectedItems: FeedItem[],
): FeedItem[] {
  if (selectedItems.length === 0) return selectedItems;

  const relevantMarkers = collectSelectedMainAttachmentMarkers(messages, allItems, selectedItems);
  if (relevantMarkers.length === 0) return selectedItems;

  const sourceIds = new Set<string>();
  for (const marker of relevantMarkers) {
    for (const messageId of marker.messageIds) sourceIds.add(messageId);
  }
  if (sourceIds.size === 0) return selectedItems;

  const expanded = [...selectedItems];
  messages.forEach((message, index) => {
    if (!sourceIds.has(rawMessageId(message, index))) return;
    if (!isMainAttachmentSourceMessage(message)) return;
    expanded.push({ order: index, entry: { message, history_index: index } });
  });
  return expanded;
}

function collectSelectedMainAttachmentMarkers(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  allItems: FeedItem[],
  selectedItems: FeedItem[],
) {
  const selectedKeys = new Set(selectedItems.map((item) => entryKey(item.entry)));
  const selectedItemIndexes: number[] = [];
  allItems.forEach((item, index) => {
    if (selectedKeys.has(entryKey(item.entry))) selectedItemIndexes.push(index);
  });
  if (selectedItemIndexes.length === 0) return [];

  const selectedSpans = selectedItemIndexes.map((itemIndex) => {
    const previousItemOrder = allItems[itemIndex - 1]?.order ?? -1;
    return { afterOrder: previousItemOrder, throughOrder: allItems[itemIndex]!.order };
  });
  const latestSelectedItemIndex = selectedItemIndexes[selectedItemIndexes.length - 1];
  if (latestSelectedItemIndex === allItems.length - 1) {
    selectedSpans.push({ afterOrder: allItems[latestSelectedItemIndex]!.order, throughOrder: messages.length - 1 });
  }

  return messages.filter((message, index) => {
    if (message.type !== "thread_attachment_marker") return false;
    const sourceKey = message.sourceThreadKey ?? message.sourceQuestId;
    if (sourceKey && normalizeSelectedFeedThreadKey(sourceKey) !== MAIN_THREAD_KEY) return false;
    return selectedSpans.some((span) => index > span.afterOrder && index <= span.throughOrder);
  }) as Array<Extract<BrowserIncomingMessage, { type: "thread_attachment_marker" }>>;
}

function isMainAttachmentSourceMessage(message: BrowserIncomingMessage): boolean {
  if (hasExplicitNonMainRoute(message)) return false;
  return (message.threadRefs ?? []).some((ref) => {
    return ref.source === "backfill" && normalizeSelectedFeedThreadKey(ref.threadKey) !== MAIN_THREAD_KEY;
  });
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

function dedupeFeedItems(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const deduped: FeedItem[] = [];
  for (const item of items.sort((a, b) => a.order - b.order)) {
    const key = entryKey(item.entry);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function dedupeEntries(items: FeedItem[]): ThreadWindowEntry[] {
  const seen = new Set<string>();
  const entries: ThreadWindowEntry[] = [];
  for (const item of items.sort((a, b) => a.order - b.order)) {
    const key = entryKey(item.entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(item.entry);
  }
  return entries;
}

function entryKey(entry: ThreadWindowEntry): string {
  return `${entry.history_index}:${rawMessageId(entry.message, entry.history_index)}`;
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

function buildMainThreadAttachAuditItem(
  hiddenRun: ReadonlyArray<{ message: BrowserIncomingMessage; index: number }>,
  route: RouteTarget,
  messages: ReadonlyArray<BrowserIncomingMessage>,
  throughIndex?: number,
): FeedItem | null {
  if (!isQuestThreadKey(route.threadKey)) return null;

  const attachCommand = firstThreadAttachCommand(hiddenRun, route);
  if (!attachCommand) return null;

  const marker = findMainSourceAttachmentMarker(messages, attachCommand.index, throughIndex, attachCommand.target);
  if (!marker) return null;

  const commandId = rawMessageId(attachCommand.message, attachCommand.index);
  const markerId = rawMessageId(marker.message, marker.index);
  const destination = marker.message.questId ?? marker.message.threadKey;
  const attachedCount = marker.message.count;
  const messageLabel = attachedCount === 1 ? "message" : "messages";
  return {
    order: attachCommand.index,
    entry: {
      synthetic: true,
      history_index: attachCommand.index,
      message: {
        type: "cross_thread_activity_marker",
        id: `thread-attach-audit:${destination}:${commandId}:${markerId}`,
        timestamp: timestampForRawMessage(marker.message),
        threadKey: marker.message.threadKey,
        ...(marker.message.questId ? { questId: marker.message.questId } : {}),
        count: 1,
        activityKind: "thread_attach",
        attachedCount,
        summary: `Thread attach command added ${attachedCount} Main ${messageLabel} to thread:${destination}`,
        firstMessageId: commandId,
        lastMessageId: markerId,
        firstHistoryIndex: attachCommand.index,
        lastHistoryIndex: marker.index,
        startedAt: timestampForRawMessage(attachCommand.message),
        updatedAt: timestampForRawMessage(marker.message),
      } as BrowserIncomingMessage,
    },
  };
}

function firstThreadAttachCommand(
  hiddenRun: ReadonlyArray<{ message: BrowserIncomingMessage; index: number }>,
  route: RouteTarget,
): { message: BrowserIncomingMessage; index: number; target: RouteTarget } | null {
  for (const item of hiddenRun) {
    const command = threadAttachCommandText(item.message);
    if (!command) continue;
    const target = threadAttachCommandTarget(command);
    if (!target || !sameRouteTarget(target, route)) continue;
    return { ...item, target };
  }
  return null;
}

function threadAttachCommandText(message: BrowserIncomingMessage): string | null {
  if (message.type !== "assistant") return null;
  const block = message.message.content.find((candidate) => {
    return candidate.type === "tool_use" && candidate.name === "Bash" && typeof candidate.input?.command === "string";
  });
  if (!block || block.type !== "tool_use" || block.name !== "Bash" || typeof block.input.command !== "string") {
    return null;
  }
  return /\btakode\s+thread\s+attach\s+q-\d+\b/.test(block.input.command) ? block.input.command : null;
}

function threadAttachCommandTarget(command: string): RouteTarget | null {
  const match = /\btakode\s+thread\s+attach\s+(q-\d+)\b/.exec(command);
  if (!match) return null;
  const threadKey = normalizeSelectedFeedThreadKey(match[1]!);
  return { threadKey, questId: threadKey };
}

function sameRouteTarget(left: RouteTarget, right: RouteTarget): boolean {
  return (
    normalizeSelectedFeedThreadKey(left.threadKey) === normalizeSelectedFeedThreadKey(right.threadKey) ||
    normalizeSelectedFeedThreadKey(left.questId ?? "") === normalizeSelectedFeedThreadKey(right.threadKey) ||
    normalizeSelectedFeedThreadKey(left.threadKey) === normalizeSelectedFeedThreadKey(right.questId ?? "")
  );
}

function findMainSourceAttachmentMarker(
  messages: ReadonlyArray<BrowserIncomingMessage>,
  afterIndex: number,
  throughIndex: number | undefined,
  target: RouteTarget,
): { message: Extract<BrowserIncomingMessage, { type: "thread_attachment_marker" }>; index: number } | null {
  const endIndex = throughIndex ?? messages.length - 1;
  for (let index = afterIndex + 1; index <= endIndex; index++) {
    const message = messages[index];
    if (message?.type !== "thread_attachment_marker") continue;
    if (!sameRouteTarget({ threadKey: message.threadKey, questId: message.questId }, target)) continue;
    if (!attachmentMarkerHasMainSource(message)) continue;
    return { message, index };
  }
  return null;
}

function attachmentMarkerHasMainSource(message: Extract<BrowserIncomingMessage, { type: "thread_attachment_marker" }>) {
  const sourceKey = message.sourceThreadKey ?? message.sourceQuestId;
  return !sourceKey || normalizeSelectedFeedThreadKey(sourceKey) === MAIN_THREAD_KEY;
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

function transitionMarkerInvolvesThread(marker: ThreadTransitionMarker, threadKey: string): boolean {
  const target = normalizeSelectedFeedThreadKey(threadKey);
  return (
    normalizeSelectedFeedThreadKey(marker.sourceThreadKey) === target ||
    normalizeSelectedFeedThreadKey(marker.sourceQuestId ?? "") === target ||
    normalizeSelectedFeedThreadKey(marker.threadKey) === target ||
    normalizeSelectedFeedThreadKey(marker.questId ?? "") === target
  );
}

function threadSystemMarkerVisibleInQuestThread(
  message: BrowserIncomingMessage,
  messages: ReadonlyArray<BrowserIncomingMessage>,
  threadKey: string,
): boolean {
  void messages;
  if (message.type === "thread_attachment_marker") return false;
  if (message.type === "thread_transition_marker") return transitionMarkerInvolvesThread(message, threadKey);
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
