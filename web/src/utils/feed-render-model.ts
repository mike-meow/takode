import type { HistoryWindowState, SessionAttentionRecord, SessionNotification, ThreadWindowState } from "../types.js";
import type { ChatMessage } from "../types.js";
import type { Turn } from "../hooks/use-feed-model.js";
import type { FeedSection } from "../components/message-feed-sections.js";
import { deriveWindowAvailability, readWindowAvailability } from "../../shared/window-availability.js";
import {
  DEFAULT_VISIBLE_SECTION_COUNT,
  buildFeedSections,
  findPreviousSectionStartIndex,
  findVisibleSectionEndIndex,
  findVisibleSectionStartIndex,
} from "../components/message-feed-sections.js";
import {
  collectMergedThreadAttachmentKeysForThread,
  enrichThreadOpenedRecordsWithMovement,
  removeMergedThreadAttachmentMarkers,
} from "../components/message-feed-thread-movement.js";
import {
  buildAttentionLedgerMessages,
  buildAttentionRecords,
  mergeChronologicalMessages,
  type AttentionBoardRowSource,
} from "./attention-records.js";
import {
  collectMessageToolUseIds,
  collectRetainedNotificationSourceMessageIds,
  filterMessagesForThread,
  isAllThreadsKey,
  isMainThreadKey,
  normalizeThreadKey,
  recoverRoutedNotificationSourceMessages,
} from "./thread-projection.js";
import { composeSelectedFeedMessages } from "./thread-window-messages.js";

export interface BuildFeedMessageModelInput {
  leaderSessionId: string;
  threadKey: string;
  projectThreadRoutes: boolean;
  allMessages: ChatMessage[];
  historyLoading: boolean;
  selectedFeedWindowEnabled: boolean;
  selectedFeedWindow: ThreadWindowState | null;
  selectedFeedWindowMessages: ChatMessage[];
  sessionNotifications?: ReadonlyArray<SessionNotification>;
  sessionAttentionRecords?: ReadonlyArray<SessionAttentionRecord>;
  additionalAttentionRecords?: ReadonlyArray<SessionAttentionRecord>;
  sessionBoard?: ReadonlyArray<AttentionBoardRowSource>;
  sessionCompletedBoard?: ReadonlyArray<AttentionBoardRowSource>;
}

export interface FeedMessageModel {
  normalizedThreadKey: string;
  messagesAvailableForDerivation: ChatMessage[];
  messagesAvailableForProjection: ChatMessage[];
  baseMessages: ChatMessage[];
  attentionRecords: SessionAttentionRecord[];
  attentionRecordsWithThreadMovement: SessionAttentionRecord[];
  mergedThreadAttachmentKeys: Set<string>;
  visibleBaseMessages: ChatMessage[];
  attentionLedgerMessages: ChatMessage[];
  messages: ChatMessage[];
  visibleToolUseIds?: Set<string>;
}

export function buildFeedMessageModel(input: BuildFeedMessageModelInput): FeedMessageModel {
  const normalizedThreadKey = normalizeThreadKey(input.threadKey || "main");
  const retainedMessageIds = collectRetainedNotificationSourceMessageIds(input.sessionNotifications, input.threadKey);
  const activeSelectedFeedWindow = input.selectedFeedWindowEnabled ? input.selectedFeedWindow : null;
  const messagesAvailableForDerivation = composeSelectedFeedMessages({
    allMessages: input.allMessages,
    historyLoading: input.historyLoading,
    selectedFeedWindow: activeSelectedFeedWindow,
    selectedFeedWindowEnabled: input.selectedFeedWindowEnabled,
    selectedFeedWindowMessages: input.selectedFeedWindowMessages,
    retainedMessageIds,
  });
  const messagesAvailableForProjection = recoverRoutedNotificationSourceMessages(
    messagesAvailableForDerivation,
    input.sessionNotifications,
    input.threadKey,
  );
  const baseMessages = input.projectThreadRoutes
    ? filterProjectedMessagesForThread(messagesAvailableForProjection, input.threadKey, activeSelectedFeedWindow)
    : messagesAvailableForDerivation;
  const records =
    input.additionalAttentionRecords && input.additionalAttentionRecords.length > 0
      ? [...(input.sessionAttentionRecords ?? []), ...input.additionalAttentionRecords]
      : input.sessionAttentionRecords;
  const attentionRecords = buildAttentionRecords({
    leaderSessionId: input.leaderSessionId,
    records,
    notifications: input.sessionNotifications,
    boardRows: input.sessionBoard,
    completedBoardRows: input.sessionCompletedBoard,
    messages: messagesAvailableForDerivation,
  });
  const attentionRecordsWithThreadMovement = enrichThreadOpenedRecordsWithMovement(
    attentionRecords,
    messagesAvailableForProjection,
  );
  const mergedThreadAttachmentKeys = collectMergedThreadAttachmentKeysForThread(
    attentionRecordsWithThreadMovement,
    normalizedThreadKey,
  );
  const visibleBaseMessages = removeMergedThreadAttachmentMarkers(baseMessages, mergedThreadAttachmentKeys);
  const baseMessageIds = new Set(visibleBaseMessages.map((message) => message.id));
  const attentionLedgerMessages = buildAttentionLedgerMessages(
    attentionRecordsWithThreadMovement,
    normalizedThreadKey,
    {
      availableMessageIds: baseMessageIds,
    },
  );
  const messages = mergeChronologicalMessages(visibleBaseMessages, attentionLedgerMessages);
  const visibleToolUseIds =
    isMainThreadKey(input.threadKey) || isAllThreadsKey(input.threadKey)
      ? undefined
      : collectMessageToolUseIds(messages);

  return {
    normalizedThreadKey,
    messagesAvailableForDerivation,
    messagesAvailableForProjection,
    baseMessages,
    attentionRecords,
    attentionRecordsWithThreadMovement,
    mergedThreadAttachmentKeys,
    visibleBaseMessages,
    attentionLedgerMessages,
    messages,
    visibleToolUseIds,
  };
}

function filterProjectedMessagesForThread(
  messages: ChatMessage[],
  threadKey: string,
  selectedFeedWindow: ThreadWindowState | null,
): ChatMessage[] {
  if (!selectedFeedWindow || isAllThreadsKey(threadKey)) return filterMessagesForThread(messages, threadKey);

  const threadLocalMessages: ChatMessage[] = [];
  const liveMessages: ChatMessage[] = [];
  for (const message of messages) {
    if (typeof message.historyIndex === "number" && message.historyIndex < selectedFeedWindow.source_history_length) {
      threadLocalMessages.push(message);
      continue;
    }
    liveMessages.push(message);
  }

  return [...threadLocalMessages, ...filterMessagesForThread(liveMessages, threadKey)];
}

export interface BuildFeedWindowModelInput {
  turns: Turn[];
  sectionTurnCount: number;
  sectionWindowStart: number | null;
  selectedFeedWindowEnabled: boolean;
  historyWindow: HistoryWindowState | null;
  selectedFeedWindow: ThreadWindowState | null;
  streamingText?: string;
  historyLoading: boolean;
  messageCount: number;
}

export interface FeedWindowModel {
  sections: FeedSection[];
  activeHistoryWindow: HistoryWindowState | null;
  isWindowedHistory: boolean;
  activeThreadWindow: ThreadWindowState | null;
  isWindowedFeed: boolean;
  totalSections: number;
  latestVisibleSectionStartIndex: number;
  visibleSectionStartIndex: number;
  visibleSectionEndIndex: number;
  visibleSections: FeedSection[];
  visibleWindowSignature: string;
  visibleTurns: Turn[];
  showConversationLoading: boolean;
  previousSectionStartIndex: number | null;
  nextSectionStartIndex: number | null;
  hasOlderSections: boolean;
  hasNewerSections: boolean;
}

export function buildFeedWindowModel(input: BuildFeedWindowModelInput): FeedWindowModel {
  const sections = buildFeedSections(input.turns, input.sectionTurnCount);
  const activeHistoryWindow = input.selectedFeedWindowEnabled ? null : input.historyWindow;
  const isWindowedHistory = activeHistoryWindow !== null;
  const activeThreadWindow = input.selectedFeedWindowEnabled ? input.selectedFeedWindow : null;
  const isWindowedFeed = isWindowedHistory || activeThreadWindow !== null;
  const totalSections = sections.length;
  const latestVisibleSectionStartIndex = findVisibleSectionStartIndex(sections, DEFAULT_VISIBLE_SECTION_COUNT);
  const visibleSectionStartIndex = isWindowedFeed ? 0 : (input.sectionWindowStart ?? latestVisibleSectionStartIndex);
  const visibleSectionEndIndex = isWindowedFeed
    ? sections.length
    : findVisibleSectionEndIndex(sections, visibleSectionStartIndex, DEFAULT_VISIBLE_SECTION_COUNT);
  const visibleSections = isWindowedFeed ? sections : sections.slice(visibleSectionStartIndex, visibleSectionEndIndex);
  const visibleWindowSignature = visibleSections.map((section) => section.id).join("|");
  const visibleTurns = visibleSections.flatMap((section) => section.turns);
  const previousSectionStartIndex = isWindowedFeed
    ? null
    : findPreviousSectionStartIndex(sections, visibleSectionStartIndex);
  const nextSectionStartIndex =
    !isWindowedFeed && visibleSectionStartIndex + 1 < sections.length ? visibleSectionStartIndex + 1 : null;
  const activeThreadAvailability = activeThreadWindow
    ? readWindowAvailability(
        activeThreadWindow,
        deriveWindowAvailability({
          from: activeThreadWindow.from_item,
          count: activeThreadWindow.item_count,
          total: activeThreadWindow.total_items,
        }),
      )
    : null;
  const activeHistoryAvailability = activeHistoryWindow
    ? readWindowAvailability(
        activeHistoryWindow,
        deriveWindowAvailability({
          from: activeHistoryWindow.from_turn,
          count: activeHistoryWindow.turn_count,
          total: activeHistoryWindow.total_turns,
        }),
      )
    : null;
  const hasOlderSections = activeThreadAvailability
    ? activeThreadAvailability.has_older_items
    : activeHistoryAvailability
      ? activeHistoryAvailability.has_older_items
      : previousSectionStartIndex !== null;
  const hasNewerSections = activeThreadAvailability
    ? activeThreadAvailability.has_newer_items
    : activeHistoryAvailability
      ? activeHistoryAvailability.has_newer_items
      : input.sectionWindowStart !== null && nextSectionStartIndex !== null;

  return {
    sections,
    activeHistoryWindow,
    isWindowedHistory,
    activeThreadWindow,
    isWindowedFeed,
    totalSections,
    latestVisibleSectionStartIndex,
    visibleSectionStartIndex,
    visibleSectionEndIndex,
    visibleSections,
    visibleWindowSignature,
    visibleTurns,
    showConversationLoading: input.historyLoading && input.messageCount === 0 && !input.streamingText,
    previousSectionStartIndex,
    nextSectionStartIndex,
    hasOlderSections,
    hasNewerSections,
  };
}
