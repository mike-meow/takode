import type { BufferedBrowserEvent, ReplayableBrowserIncomingMessage } from "../../server/session-types.js";
import type { ChatMessage, SessionAttentionRecord, SessionNotification } from "../types.js";

// Generated-only fixture data. Do not paste raw session exports, private paths,
// keys, or user conversation text into this file.
export const SYNTHETIC_LEADER_SESSION_ID = "synthetic-large-leader";
export const SYNTHETIC_PRIMARY_THREAD_KEY = "q-1079";
export const SYNTHETIC_SECONDARY_THREAD_KEY = "q-1080";

export interface SyntheticLargeLeaderFeedFixture {
  allMessages: ChatMessage[];
  selectedMainWindowMessages: ChatMessage[];
  selectedQuestWindowMessages: ChatMessage[];
  sessionNotifications: SessionNotification[];
  sessionAttentionRecords: SessionAttentionRecord[];
  mainSourceMessageId: string;
  questSourceMessageId: string;
  threadAttachmentMarkerMessageId: string;
  selectedWindowSourceHistoryLength: number;
  budgets: {
    maxMainDerivationMessages: number;
    maxMainRenderedRows: number;
    maxQuestRenderedRows: number;
    maxVisibleSections: number;
  };
}

export interface SyntheticLargeLeaderReplayFixture {
  events: BufferedBrowserEvent[];
  topLevelLeaderTextDeltaCount: number;
  nestedTextDeltaCount: number;
  nonTextLeaderStreamEventCount: number;
  durableEventCount: number;
}

export function createSyntheticLargeLeaderFeedFixture({
  historyMessageCount = 720,
  selectedTailCount = 64,
}: {
  historyMessageCount?: number;
  selectedTailCount?: number;
} = {}): SyntheticLargeLeaderFeedFixture {
  const messages: ChatMessage[] = [];

  const mainSource = pushMessage(messages, {
    id: "synthetic-main-needs-input-source",
    role: "assistant",
    content: "Synthetic Main needs-input source for a generated large leader fixture.",
    timestamp: 1,
  });
  const questSource = pushMessage(messages, {
    id: "synthetic-q1079-needs-input-source",
    role: "assistant",
    content: "Synthetic q-1079 needs-input source that belongs only to the quest thread.",
    timestamp: 2,
    threadKey: SYNTHETIC_PRIMARY_THREAD_KEY,
  });

  const movedMessages: ChatMessage[] = [];
  for (let index = 0; messages.length < historyMessageCount - selectedTailCount - 6; index += 1) {
    const messageIndex = messages.length;
    if (messageIndex >= 24 && messageIndex < 27) {
      movedMessages.push(
        pushMessage(messages, {
          id: `synthetic-moved-${messageIndex}`,
          role: messageIndex % 2 === 0 ? "user" : "assistant",
          content: `Synthetic moved message ${messageIndex} backfilled into q-1079.`,
          timestamp: messageIndex + 1,
          threadKey: SYNTHETIC_PRIMARY_THREAD_KEY,
          source: "backfill",
        }),
      );
      continue;
    }

    if (index % 17 === 0) {
      pushMessage(messages, {
        id: `synthetic-secondary-${messageIndex}`,
        role: "assistant",
        content: `Synthetic q-1080 routed update ${messageIndex}.`,
        timestamp: messageIndex + 1,
        threadKey: SYNTHETIC_SECONDARY_THREAD_KEY,
      });
      continue;
    }

    if (index % 7 === 0) {
      pushMessage(messages, {
        id: `synthetic-primary-${messageIndex}`,
        role: index % 2 === 0 ? "assistant" : "user",
        content: `Synthetic q-1079 routed update ${messageIndex}.`,
        timestamp: messageIndex + 1,
        threadKey: SYNTHETIC_PRIMARY_THREAD_KEY,
      });
      continue;
    }

    pushMessage(messages, {
      id: `synthetic-main-${messageIndex}`,
      role: index % 5 === 0 ? "user" : "assistant",
      content: `Synthetic Main update ${messageIndex} mentioning q-${1100 + (index % 40)}.`,
      timestamp: messageIndex + 1,
    });
  }

  const threadAttachmentMarker = pushMessage(messages, {
    id: "synthetic-thread-attachment-marker-q1079",
    role: "system",
    content: "3 messages moved to thread:q-1079",
    timestamp: messages.length + 1,
    threadAttachmentMarker: {
      type: "thread_attachment_marker",
      id: "synthetic-thread-attachment-marker-q1079",
      timestamp: messages.length + 1,
      markerKey: "synthetic-move-q1079",
      sourceThreadKey: "main",
      threadKey: SYNTHETIC_PRIMARY_THREAD_KEY,
      questId: SYNTHETIC_PRIMARY_THREAD_KEY,
      attachedAt: messages.length + 1,
      attachedBy: "synthetic-fixture",
      messageIds: movedMessages.map((message) => message.id),
      messageIndices: movedMessages.map((message) => message.historyIndex ?? -1),
      ranges: [`${movedMessages[0]?.historyIndex ?? 24}-${movedMessages.at(-1)?.historyIndex ?? 26}`],
      count: movedMessages.length,
      firstMessageId: movedMessages[0]?.id,
      firstMessageIndex: movedMessages[0]?.historyIndex,
    },
  });

  while (messages.length < historyMessageCount) {
    const messageIndex = messages.length;
    const tailOrdinal = historyMessageCount - messageIndex;
    if (tailOrdinal % 9 === 0) {
      pushMessage(messages, {
        id: `synthetic-tail-q1079-${messageIndex}`,
        role: "assistant",
        content: `Synthetic visible q-1079 tail update ${messageIndex}.`,
        timestamp: messageIndex + 1,
        threadKey: SYNTHETIC_PRIMARY_THREAD_KEY,
      });
      continue;
    }
    if (tailOrdinal % 13 === 0) {
      pushMessage(messages, {
        id: `synthetic-tail-q1080-${messageIndex}`,
        role: "assistant",
        content: `Synthetic visible q-1080 tail update ${messageIndex}.`,
        timestamp: messageIndex + 1,
        threadKey: SYNTHETIC_SECONDARY_THREAD_KEY,
      });
      continue;
    }
    pushMessage(messages, {
      id: `synthetic-tail-main-${messageIndex}`,
      role: tailOrdinal % 5 === 0 ? "user" : "assistant",
      content: `Synthetic visible Main tail update ${messageIndex} with q-${1200 + (messageIndex % 30)}.`,
      timestamp: messageIndex + 1,
    });
  }

  const sourceHistoryLength = Math.max(0, historyMessageCount - selectedTailCount);
  return {
    allMessages: messages,
    selectedMainWindowMessages: messages.filter(
      (message) => (message.historyIndex ?? 0) >= sourceHistoryLength || message.id === threadAttachmentMarker.id,
    ),
    selectedQuestWindowMessages: messages
      .filter((message) => messageBelongsToThread(message, SYNTHETIC_PRIMARY_THREAD_KEY))
      .slice(-Math.floor(selectedTailCount / 2)),
    sessionNotifications: [
      notification("synthetic-main-needs-input", mainSource.id, "Synthetic Main needs input"),
      notification("synthetic-q1079-needs-input", questSource.id, "Synthetic q-1079 needs input", {
        threadKey: SYNTHETIC_PRIMARY_THREAD_KEY,
        questId: SYNTHETIC_PRIMARY_THREAD_KEY,
      }),
    ],
    sessionAttentionRecords: [questThreadOpenedAttentionRecord(threadAttachmentMarker.timestamp)],
    mainSourceMessageId: mainSource.id,
    questSourceMessageId: questSource.id,
    threadAttachmentMarkerMessageId: threadAttachmentMarker.id,
    selectedWindowSourceHistoryLength: sourceHistoryLength,
    budgets: {
      maxMainDerivationMessages: selectedTailCount + 2,
      maxMainRenderedRows: selectedTailCount + 4,
      maxQuestRenderedRows: Math.floor(selectedTailCount / 2) + 2,
      maxVisibleSections: 3,
    },
  };
}

export function createSyntheticLargeLeaderReplayFixture({
  topLevelLeaderTextDeltaCount = 900,
  nestedTextDeltaCount = 24,
  nonTextLeaderStreamEventCount = 12,
  durableEventCount = 6,
}: {
  topLevelLeaderTextDeltaCount?: number;
  nestedTextDeltaCount?: number;
  nonTextLeaderStreamEventCount?: number;
  durableEventCount?: number;
} = {}): SyntheticLargeLeaderReplayFixture {
  const events: BufferedBrowserEvent[] = [];
  let seq = 1;

  const push = (message: ReplayableBrowserIncomingMessage) => {
    events.push({ seq, message });
    seq += 1;
  };

  for (let index = 0; index < topLevelLeaderTextDeltaCount; index += 1) {
    push(textStreamDelta(null, `synthetic leader chunk ${index}`));
  }
  for (let index = 0; index < nestedTextDeltaCount; index += 1) {
    push(textStreamDelta(`synthetic-tool-${index % 3}`, `synthetic nested chunk ${index}`));
  }
  for (let index = 0; index < nonTextLeaderStreamEventCount; index += 1) {
    push({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: `synthetic thought ${index}` } },
    });
  }
  for (let index = 0; index < durableEventCount; index += 1) {
    push({
      type: "status_change",
      status: index % 2 === 0 ? "running" : "idle",
    });
  }

  return {
    events,
    topLevelLeaderTextDeltaCount,
    nestedTextDeltaCount,
    nonTextLeaderStreamEventCount,
    durableEventCount,
  };
}

export function createSyntheticLiveMainUpdate(historyIndex: number): ChatMessage {
  return {
    id: `synthetic-live-main-${historyIndex}`,
    role: "assistant",
    content: `Synthetic live Main update ${historyIndex} while composer autocomplete is open and mentions q-1999.`,
    timestamp: historyIndex + 1,
    historyIndex,
  };
}

export function collectFixtureStrings(value: unknown): string[] {
  const strings: string[] = [];
  collectStrings(value, strings);
  return strings;
}

function pushMessage(
  messages: ChatMessage[],
  {
    id,
    role,
    content,
    timestamp,
    threadKey,
    source = "explicit",
    threadAttachmentMarker,
  }: {
    id: string;
    role: ChatMessage["role"];
    content: string;
    timestamp: number;
    threadKey?: string;
    source?: "explicit" | "backfill";
    threadAttachmentMarker?: NonNullable<ChatMessage["metadata"]>["threadAttachmentMarker"];
  },
): ChatMessage {
  const message: ChatMessage = {
    id,
    role,
    content,
    timestamp,
    historyIndex: messages.length,
    ...(threadKey || threadAttachmentMarker
      ? {
          metadata: {
            ...(threadKey
              ? {
                  threadKey,
                  questId: threadKey,
                  threadRefs: [{ threadKey, questId: threadKey, source }],
                }
              : {}),
            ...(threadAttachmentMarker ? { threadAttachmentMarker } : {}),
          },
        }
      : {}),
  };
  messages.push(message);
  return message;
}

function notification(
  id: string,
  messageId: string,
  summary: string,
  route: { threadKey?: string; questId?: string } = {},
): SessionNotification {
  return {
    id,
    category: "needs-input",
    summary,
    timestamp: 1,
    messageId,
    done: false,
    ...route,
  };
}

function questThreadOpenedAttentionRecord(createdAt: number): SessionAttentionRecord {
  return {
    id: "synthetic-thread-opened-q1079",
    leaderSessionId: SYNTHETIC_LEADER_SESSION_ID,
    type: "quest_thread_created",
    source: { kind: "quest", id: SYNTHETIC_PRIMARY_THREAD_KEY, questId: SYNTHETIC_PRIMARY_THREAD_KEY },
    questId: SYNTHETIC_PRIMARY_THREAD_KEY,
    threadKey: SYNTHETIC_PRIMARY_THREAD_KEY,
    title: "Thread opened",
    summary: "Synthetic thread opened",
    actionLabel: "Open",
    priority: "created",
    state: "unresolved",
    createdAt,
    updatedAt: createdAt,
    route: { threadKey: SYNTHETIC_PRIMARY_THREAD_KEY, questId: SYNTHETIC_PRIMARY_THREAD_KEY },
    chipEligible: true,
    ledgerEligible: true,
    dedupeKey: "synthetic-thread-opened-q1079",
  };
}

function textStreamDelta(parentToolUseId: string | null, text: string): ReplayableBrowserIncomingMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: parentToolUseId,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function messageBelongsToThread(message: ChatMessage, threadKey: string): boolean {
  if (message.metadata?.threadKey === threadKey || message.metadata?.questId === threadKey) return true;
  return (message.metadata?.threadRefs ?? []).some((ref) => ref.threadKey === threadKey || ref.questId === threadKey);
}

function collectStrings(value: unknown, strings: string[]): void {
  if (typeof value === "string") {
    strings.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, strings);
    return;
  }
  for (const item of Object.values(value)) collectStrings(item, strings);
}
