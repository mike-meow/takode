import { describe, expect, it } from "vitest";
import type {
  BrowserIncomingMessage,
  ChatMessage,
  SessionAttentionRecord,
  SessionNotification,
  ThreadWindowState,
} from "../types.js";
import type { Turn } from "../hooks/use-feed-model.js";
import { buildFeedMessageModel, buildFeedWindowModel } from "./feed-render-model.js";
import { buildThreadFeedWindowSync } from "../../shared/feed-window-sync.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { normalizeHistoryMessageToChatMessages } from "./history-message-normalization.js";

function makeMessage(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"] }): ChatMessage {
  return {
    content: "",
    timestamp: 1,
    ...overrides,
  };
}

function makeNotification(overrides: Partial<SessionNotification> & { id: string; messageId: string | null }) {
  return {
    category: "needs-input" as const,
    timestamp: 1,
    done: false,
    summary: "Needs input",
    ...overrides,
  };
}

function makeWindow(overrides: Partial<ThreadWindowState> = {}): ThreadWindowState {
  return {
    thread_key: "main",
    from_item: 20,
    item_count: 1,
    total_items: 30,
    source_history_length: 20,
    section_item_count: 50,
    visible_item_count: 3,
    ...overrides,
  };
}

function makeAttentionRecord(overrides: Partial<SessionAttentionRecord> & { id: string }): SessionAttentionRecord {
  const createdAt = overrides.createdAt ?? 1;
  return {
    leaderSessionId: "leader-1",
    type: "review_ready",
    source: { kind: "manual", signature: overrides.id },
    threadKey: "main",
    title: "Attention item",
    summary: "Attention item",
    actionLabel: "Open",
    priority: "review",
    state: "unresolved",
    createdAt,
    updatedAt: createdAt,
    route: { threadKey: "main" },
    chipEligible: false,
    ledgerEligible: true,
    dedupeKey: overrides.id,
    ...overrides,
  };
}

function makeAttachmentMarker(
  overrides: Partial<NonNullable<NonNullable<ChatMessage["metadata"]>["threadAttachmentMarker"]>> = {},
) {
  return {
    type: "thread_attachment_marker" as const,
    id: "marker-q941",
    timestamp: 300,
    markerKey: "thread-attachment:q-941:m-attached",
    threadKey: "q-941",
    questId: "q-941",
    attachedAt: 300,
    attachedBy: "leader-1",
    messageIds: ["m-attached"],
    messageIndices: [1],
    ranges: ["1"],
    count: 1,
    firstMessageId: "m-attached",
    firstMessageIndex: 1,
    ...overrides,
  };
}

function makeTransitionMarker(overrides: {
  id: string;
  sourceThreadKey: string;
  threadKey: string;
}): Extract<BrowserIncomingMessage, { type: "thread_transition_marker" }> {
  return {
    type: "thread_transition_marker",
    id: overrides.id,
    timestamp: 300,
    markerKey: `thread-transition:${overrides.sourceThreadKey}->${overrides.threadKey}:0`,
    sourceThreadKey: overrides.sourceThreadKey,
    ...(overrides.sourceThreadKey === "main" ? {} : { sourceQuestId: overrides.sourceThreadKey }),
    threadKey: overrides.threadKey,
    questId: overrides.threadKey,
    transitionedAt: 300,
    reason: "route_switch",
  };
}

function buildMessageModel(
  input: Partial<Parameters<typeof buildFeedMessageModel>[0]> &
    Pick<Parameters<typeof buildFeedMessageModel>[0], "allMessages" | "sessionNotifications">,
) {
  return buildFeedMessageModel({
    leaderSessionId: "leader-1",
    threadKey: "main",
    projectThreadRoutes: true,
    historyLoading: false,
    selectedFeedWindowEnabled: true,
    selectedFeedWindow: makeWindow(),
    selectedFeedWindowMessages: [],
    ...input,
  });
}

function makeTurn(id: string): Turn {
  return {
    id,
    userEntry: null,
    allEntries: [],
    agentEntries: [],
    systemEntries: [],
    notificationEntries: [],
    responseEntry: null,
    subConclusions: [],
    stats: {
      messageCount: 0,
      toolCount: 0,
      subagentCount: 0,
      herdEventCount: 0,
    },
  };
}

describe("feed render model builders", () => {
  it("keeps an active Main notification source visible when the selected window would otherwise omit it", () => {
    const proposal = makeMessage({
      id: "a-proposal",
      role: "assistant",
      content: "Proposed follow-up quest that needs approval.",
      timestamp: 100,
      historyIndex: 4,
    });
    const tail = makeMessage({
      id: "a-tail",
      role: "assistant",
      content: "Visible tail message.",
      timestamp: 200,
      historyIndex: 25,
    });

    const model = buildMessageModel({
      allMessages: [proposal, tail],
      selectedFeedWindowMessages: [tail],
      sessionNotifications: [makeNotification({ id: "n-main", messageId: proposal.id })],
      sessionAttentionRecords: [
        makeAttentionRecord({
          id: "inactive-between-retained-source-and-window",
          state: "resolved",
          createdAt: 150,
          updatedAt: 150,
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-proposal", "a-tail"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("keeps an active Main review notification source as a normal feed event", () => {
    const reviewSource = makeMessage({
      id: "a-review-ready",
      role: "assistant",
      content: "q-1130 is ready for review.",
      timestamp: 100,
      historyIndex: 4,
    });
    const tail = makeMessage({
      id: "a-tail",
      role: "assistant",
      content: "Visible tail message.",
      timestamp: 200,
      historyIndex: 25,
    });

    const model = buildMessageModel({
      allMessages: [reviewSource, tail],
      selectedFeedWindowMessages: [tail],
      sessionNotifications: [
        makeNotification({
          id: "n-review",
          category: "review",
          messageId: reviewSource.id,
          summary: "q-1130 ready for review",
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-review-ready", "a-tail"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("keeps an active Main notification source visible when Main opens before its selected window arrives", () => {
    const proposal = makeMessage({
      id: "a-main-checkpoint",
      role: "assistant",
      content: "Main checkpoint question that needs approval.",
      timestamp: 100,
      historyIndex: 4,
    });
    const rawTail = makeMessage({
      id: "a-raw-tail",
      role: "assistant",
      content: "Raw historical tail that still waits for the Main thread window.",
      timestamp: 200,
      historyIndex: 25,
    });
    const liveMarker = makeMessage({
      id: "a-live-marker",
      role: "assistant",
      content: "Live marker after reconnect.",
      timestamp: 300,
      historyIndex: -1,
    });

    const model = buildMessageModel({
      allMessages: [proposal, rawTail, liveMarker],
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [makeNotification({ id: "n-main", messageId: proposal.id })],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-main-checkpoint", "a-live-marker"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("keeps windowed Main attention ledger rows bounded to active and visible-window records", () => {
    const visibleWindowStart = makeMessage({
      id: "a-visible-window-start",
      role: "assistant",
      content: "Visible Main window start.",
      timestamp: 1_000,
      historyIndex: 25,
    });
    const visibleWindowEnd = makeMessage({
      id: "a-visible-window-end",
      role: "assistant",
      content: "Visible Main window end.",
      timestamp: 1_100,
      historyIndex: 26,
    });

    const model = buildMessageModel({
      allMessages: [visibleWindowStart, visibleWindowEnd],
      selectedFeedWindowMessages: [visibleWindowStart, visibleWindowEnd],
      sessionNotifications: [],
      sessionAttentionRecords: [
        makeAttentionRecord({
          id: "old-resolved",
          state: "resolved",
          createdAt: 100,
          updatedAt: 100,
          title: "Old resolved item",
        }),
        makeAttentionRecord({
          id: "old-active",
          state: "unresolved",
          createdAt: 200,
          updatedAt: 200,
          title: "Old active item",
        }),
        makeAttentionRecord({
          id: "in-window-resolved",
          state: "resolved",
          createdAt: 1_050,
          updatedAt: 1_050,
          title: "In-window resolved item",
        }),
        makeAttentionRecord({
          id: "after-window-resolved",
          state: "resolved",
          createdAt: 5_000,
          updatedAt: 5_000,
          title: "After-window resolved item",
        }),
      ],
    });

    expect(model.attentionLedgerMessages.map((message) => message.metadata?.attentionRecord?.id)).toEqual([
      "old-active",
      "in-window-resolved",
    ]);
  });

  it("keeps active Journey-finished ledger rows anchored to the selected Main window", () => {
    const olderWindowStart = makeMessage({
      id: "a-older-window-start",
      role: "assistant",
      content: "Older Main window start.",
      timestamp: 1_000,
      historyIndex: 25,
    });
    const olderWindowEnd = makeMessage({
      id: "a-older-window-end",
      role: "assistant",
      content: "Older Main window end.",
      timestamp: 1_100,
      historyIndex: 26,
    });
    const journeyWindowStart = makeMessage({
      id: "a-journey-window-start",
      role: "assistant",
      content: "Journey window start.",
      timestamp: 4_900,
      historyIndex: 50,
    });
    const journeyWindowEnd = makeMessage({
      id: "a-journey-window-end",
      role: "assistant",
      content: "Journey window end.",
      timestamp: 5_100,
      historyIndex: 51,
    });
    const journeyFinished = makeNotification({
      id: "n-journey-finished",
      category: "review",
      messageId: null,
      summary: "q-1151 finished: Keep Journey chips anchored",
      timestamp: 5_000,
      threadKey: "q-1151",
      questId: "q-1151",
    });

    const olderModel = buildMessageModel({
      allMessages: [olderWindowStart, olderWindowEnd],
      selectedFeedWindowMessages: [olderWindowStart, olderWindowEnd],
      sessionNotifications: [journeyFinished],
    });
    const journeyModel = buildMessageModel({
      allMessages: [journeyWindowStart, journeyWindowEnd],
      selectedFeedWindowMessages: [journeyWindowStart, journeyWindowEnd],
      sessionNotifications: [journeyFinished],
    });

    expect(olderModel.attentionLedgerMessages).toHaveLength(0);
    expect(olderModel.messages.map((message) => message.id)).toEqual(["a-older-window-start", "a-older-window-end"]);
    expect(journeyModel.attentionLedgerMessages.map((message) => message.id)).toEqual([
      "attention-ledger:notification:n-journey-finished",
    ]);
    expect(journeyModel.messages.map((message) => message.id)).toEqual([
      "a-journey-window-start",
      "attention-ledger:notification:n-journey-finished",
      "a-journey-window-end",
    ]);
  });

  it("does not render stale inactive Main ledger rows before the selected window arrives", () => {
    const model = buildMessageModel({
      allMessages: [],
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [],
      sessionAttentionRecords: [
        makeAttentionRecord({
          id: "old-resolved",
          state: "resolved",
          createdAt: 100,
          updatedAt: 100,
          title: "Old resolved item",
        }),
        makeAttentionRecord({
          id: "old-active",
          state: "unresolved",
          createdAt: 200,
          updatedAt: 200,
          title: "Old active item",
        }),
      ],
    });

    expect(model.attentionLedgerMessages.map((message) => message.metadata?.attentionRecord?.id)).toEqual([
      "old-active",
    ]);
  });

  it("does not derive cold Main ledger bounds from retained or live visible messages", () => {
    const retainedSource = makeMessage({
      id: "a-retained-main-source",
      role: "assistant",
      content: "Retained Main source.",
      timestamp: 100,
      historyIndex: -1,
    });
    const liveMessage = makeMessage({
      id: "a-live-main-message",
      role: "assistant",
      content: "Live Main output.",
      timestamp: 300,
      historyIndex: -1,
    });

    const model = buildMessageModel({
      allMessages: [retainedSource, liveMessage],
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [],
      sessionAttentionRecords: [
        makeAttentionRecord({
          id: "cold-start-active",
          state: "unresolved",
          createdAt: 50,
          updatedAt: 50,
          title: "Cold start active item",
        }),
        makeAttentionRecord({
          id: "pseudo-window-inactive",
          state: "resolved",
          createdAt: 150,
          updatedAt: 150,
          title: "Pseudo-window inactive item",
        }),
      ],
    });

    expect(model.attentionLedgerMessages.map((message) => message.metadata?.attentionRecord?.id)).toEqual([
      "cold-start-active",
    ]);
    expect(model.messages.map((message) => message.id)).toEqual([
      "attention-ledger:cold-start-active",
      "a-retained-main-source",
      "a-live-main-message",
    ]);
  });

  it("does not leak routed quest notification sources into the Main feed model", () => {
    const questSource = makeMessage({
      id: "a-q983-plan",
      role: "assistant",
      content: "Plan for q-983.",
      timestamp: 100,
      historyIndex: 4,
    });
    const mainTail = makeMessage({
      id: "a-main-tail",
      role: "assistant",
      content: "Main feed tail remains visible.",
      timestamp: 200,
      historyIndex: 25,
    });

    const model = buildMessageModel({
      allMessages: [questSource, mainTail],
      selectedFeedWindowMessages: [mainTail],
      sessionNotifications: [
        makeNotification({
          id: "n-q983",
          messageId: questSource.id,
          threadKey: "q-983",
          questId: "q-983",
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-main-tail"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("does not leak routed quest notification sources during cold Main selected-feed startup", () => {
    const questSource = makeMessage({
      id: "a-q983-plan",
      role: "assistant",
      content: "Plan for q-983.",
      timestamp: 100,
      historyIndex: 4,
    });
    const liveMain = makeMessage({
      id: "a-main-live",
      role: "assistant",
      content: "Main live marker.",
      timestamp: 200,
      historyIndex: -1,
    });

    const model = buildMessageModel({
      allMessages: [questSource, liveMain],
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
      sessionNotifications: [
        makeNotification({
          id: "n-q983",
          messageId: questSource.id,
          threadKey: "q-983",
          questId: "q-983",
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-main-live"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("keeps backfilled source messages visible in Main without rendering attachment markers", () => {
    const mainSetup = makeMessage({
      id: "m-main",
      role: "user",
      content: "Main setup",
      timestamp: 100,
      historyIndex: 0,
    });
    const attached = makeMessage({
      id: "m-attached",
      role: "assistant",
      content: "Main context attached to q-941",
      timestamp: 200,
      historyIndex: 1,
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "backfill" }] },
    });
    const marker = makeMessage({
      id: "marker-q941",
      role: "system",
      content: "1 message moved to q-941",
      timestamp: 300,
      historyIndex: 2,
      metadata: { threadAttachmentMarker: makeAttachmentMarker() },
    });

    const model = buildMessageModel({
      selectedFeedWindowEnabled: false,
      allMessages: [mainSetup, attached, marker],
      sessionNotifications: [],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["m-main", "m-attached"]);
  });

  it("uses server-retained selected-window Main attachment sources without rendering marker rows", () => {
    const attached = makeMessage({
      id: "m-attached",
      role: "assistant",
      content: "Main context attached to q-941 from outside the selected window",
      timestamp: 100,
      historyIndex: 4,
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "backfill" }] },
    });
    const questOnly = makeMessage({
      id: "m-quest-only",
      role: "assistant",
      content: "Future q-941-only response",
      timestamp: 120,
      historyIndex: 5,
      metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
    });
    const marker = makeMessage({
      id: "marker-q941",
      role: "system",
      content: "2 messages moved to q-941",
      timestamp: 300,
      historyIndex: 25,
      metadata: {
        threadAttachmentMarker: makeAttachmentMarker({
          messageIds: [attached.id, questOnly.id],
          firstMessageId: attached.id,
          count: 2,
        }),
      },
    });
    const tail = makeMessage({
      id: "a-visible-tail",
      role: "assistant",
      content: "Visible Main tail",
      timestamp: 400,
      historyIndex: 26,
    });

    const model = buildMessageModel({
      allMessages: [attached, questOnly, marker, tail],
      selectedFeedWindowMessages: [attached, tail],
      sessionNotifications: [],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["m-attached", "a-visible-tail"]);
  });

  it("keeps source and destination quest membership without rendering source attachment markers", () => {
    const sourceMessage = makeMessage({
      id: "m-attached",
      role: "assistant",
      content: "Source quest context attached to q-941",
      timestamp: 200,
      historyIndex: 1,
      metadata: {
        threadRefs: [
          { threadKey: "q-940", questId: "q-940", source: "explicit" },
          { threadKey: "q-941", questId: "q-941", source: "backfill" },
        ],
      },
    });
    const marker = makeMessage({
      id: "marker-q941",
      role: "system",
      content: "1 message moved to q-941",
      timestamp: 300,
      historyIndex: 2,
      metadata: {
        threadAttachmentMarker: makeAttachmentMarker({ sourceThreadKey: "q-940", sourceQuestId: "q-940" }),
      },
    });

    const sourceModel = buildMessageModel({
      threadKey: "q-940",
      selectedFeedWindowEnabled: false,
      allMessages: [sourceMessage, marker],
      sessionNotifications: [],
    });
    const destinationModel = buildMessageModel({
      threadKey: "q-941",
      selectedFeedWindowEnabled: false,
      allMessages: [sourceMessage, marker],
      sessionNotifications: [],
    });

    expect(sourceModel.messages.map((message) => message.id)).toEqual(["m-attached"]);
    expect(destinationModel.messages.map((message) => message.id)).toEqual(["m-attached"]);
  });

  it("recovers routed notification sources for the owner quest thread without adding a fallback ledger row", () => {
    const questSource = makeMessage({
      id: "a-q983-plan",
      role: "assistant",
      content: "Plan for q-983.",
      timestamp: 100,
      historyIndex: 4,
    });

    const model = buildMessageModel({
      threadKey: "q-983",
      allMessages: [questSource],
      selectedFeedWindow: makeWindow({ thread_key: "q-983" }),
      selectedFeedWindowMessages: [],
      sessionNotifications: [
        makeNotification({
          id: "n-q983",
          messageId: questSource.id,
          threadKey: "q-983",
          questId: "q-983",
        }),
      ],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-q983-plan"]);
    expect(model.messages[0]?.metadata?.threadRefs).toEqual([
      { threadKey: "q-983", questId: "q-983", source: "inferred" },
    ]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
  });

  it("derives bounded local section metadata separately from scroll/runtime behavior", () => {
    const turns = Array.from({ length: 8 }, (_, index) => makeTurn(`turn-${index + 1}`));

    const model = buildFeedWindowModel({
      turns,
      sectionTurnCount: 2,
      sectionWindowStart: null,
      selectedFeedWindowEnabled: false,
      historyWindow: null,
      selectedFeedWindow: null,
      historyLoading: false,
      messageCount: 16,
    });

    expect(model.sections).toHaveLength(4);
    expect(model.visibleSections.map((section) => section.id)).toEqual(["turn-3", "turn-5", "turn-7"]);
    expect(model.hasOlderSections).toBe(true);
    expect(model.hasNewerSections).toBe(false);
    expect(model.previousSectionStartIndex).toBe(0);
    expect(model.nextSectionStartIndex).toBe(2);
  });

  it("uses active selected-thread window metadata for older/newer boundaries", () => {
    const turns = Array.from({ length: 4 }, (_, index) => makeTurn(`turn-${index + 1}`));

    const model = buildFeedWindowModel({
      turns,
      sectionTurnCount: 2,
      sectionWindowStart: null,
      selectedFeedWindowEnabled: true,
      historyWindow: null,
      selectedFeedWindow: makeWindow({
        thread_key: "q-1027",
        from_item: 2,
        item_count: 6,
        total_items: 10,
        section_item_count: 2,
        visible_item_count: 3,
      }),
      historyLoading: false,
      messageCount: 8,
    });

    expect(model.visibleSections).toHaveLength(2);
    expect(model.hasOlderSections).toBe(true);
    expect(model.hasNewerSections).toBe(true);
    expect(model.previousSectionStartIndex).toBeNull();
    expect(model.nextSectionStartIndex).toBeNull();
  });

  it("prefers explicit selected-thread availability over legacy bounds math", () => {
    const turns = Array.from({ length: 4 }, (_, index) => makeTurn(`turn-${index + 1}`));

    const model = buildFeedWindowModel({
      turns,
      sectionTurnCount: 2,
      sectionWindowStart: null,
      selectedFeedWindowEnabled: true,
      historyWindow: null,
      selectedFeedWindow: makeWindow({
        thread_key: "q-1027",
        from_item: 2,
        item_count: 6,
        total_items: 10,
        has_older_items: false,
        has_newer_items: false,
      }),
      historyLoading: false,
      messageCount: 8,
    });

    expect(model.hasOlderSections).toBe(false);
    expect(model.hasNewerSections).toBe(false);
  });

  it("prefers explicit history-window availability over legacy bounds math", () => {
    const turns = Array.from({ length: 4 }, (_, index) => makeTurn(`turn-${index + 1}`));

    const model = buildFeedWindowModel({
      turns,
      sectionTurnCount: 2,
      sectionWindowStart: null,
      selectedFeedWindowEnabled: false,
      historyWindow: {
        from_turn: 0,
        turn_count: 6,
        total_turns: 12,
        has_older_items: false,
        has_newer_items: false,
        section_turn_count: 2,
        visible_section_count: 3,
      },
      selectedFeedWindow: null,
      historyLoading: false,
      messageCount: 8,
    });

    expect(model.hasOlderSections).toBe(false);
    expect(model.hasNewerSections).toBe(false);
  });

  it("keeps selected-thread feed_window_sync item order aligned with the render-model target", () => {
    const rawThreadMessage = {
      type: "user_message",
      id: "u-q1080",
      content: "Selected thread message",
      timestamp: 100,
      threadKey: "q-1080",
      questId: "q-1080",
      threadRefs: [{ threadKey: "q-1080", questId: "q-1080", source: "explicit" }],
    } satisfies BrowserIncomingMessage;
    const threadWindow = makeWindow({
      thread_key: "q-1080",
      from_item: 0,
      item_count: 1,
      total_items: 1,
      source_history_length: 4,
    });
    const feedSync = buildThreadFeedWindowSync({
      threadKey: "q-1080",
      entries: [{ message: rawThreadMessage, history_index: 3 }],
      window: threadWindow,
    });
    const chatThreadMessage = makeMessage({
      id: "u-q1080",
      role: "user",
      content: "Selected thread message",
      timestamp: 100,
      historyIndex: 3,
      metadata: {
        threadKey: "q-1080",
        questId: "q-1080",
        threadRefs: [{ threadKey: "q-1080", questId: "q-1080", source: "explicit" }],
      },
    });

    const model = buildMessageModel({
      threadKey: "q-1080",
      allMessages: [],
      selectedFeedWindow: threadWindow,
      selectedFeedWindowMessages: [chatThreadMessage],
      sessionNotifications: [],
    });

    expect(feedSync.items.map((item) => item.messageId)).toEqual(model.messages.map((message) => message.id));
    expect(feedSync.bounds).toMatchObject({ from: 0, count: 1, total: 1, sourceHistoryLength: 4 });
  });

  it("treats selected-thread window messages as an already routed local conversation", () => {
    const threadWindow = makeWindow({
      thread_key: "q-1080",
      from_item: 0,
      item_count: 1,
      total_items: 1,
      source_history_length: 4,
    });
    const localThreadMessage = makeMessage({
      id: "u-q1080",
      role: "user",
      content: "Selected thread request",
      timestamp: 100,
      historyIndex: 1,
      metadata: {
        threadKey: "q-1080",
        questId: "q-1080",
        threadRefs: [{ threadKey: "q-1080", questId: "q-1080", source: "explicit" }],
      },
    });
    const localUnroutedResult = makeMessage({
      id: "hist-result-2",
      role: "system",
      content: "Error: failed",
      timestamp: 101,
      historyIndex: 2,
    });
    const liveUnroutedTail = makeMessage({
      id: "live-main-tail",
      role: "assistant",
      content: "Main live tail",
      timestamp: 200,
      historyIndex: 4,
    });

    const model = buildMessageModel({
      threadKey: "q-1080",
      allMessages: [liveUnroutedTail],
      selectedFeedWindow: threadWindow,
      selectedFeedWindowMessages: [localThreadMessage, localUnroutedResult],
      sessionNotifications: [],
    });

    expect(model.messages.map((message) => message.id)).toEqual(["u-q1080", "hist-result-2"]);
  });

  it("defensively scopes selected-thread window transition markers to affected threads", () => {
    const sourceMarker = makeTransitionMarker({
      id: "transition-q1139-q1141",
      sourceThreadKey: "q-1139",
      threadKey: "q-1141",
    });
    const unrelatedMarker = makeTransitionMarker({
      id: "transition-q1141-q1135",
      sourceThreadKey: "q-1141",
      threadKey: "q-1135",
    });
    const selectedFeedWindowMessages = [
      ...normalizeHistoryMessageToChatMessages(sourceMarker, 1),
      ...normalizeHistoryMessageToChatMessages(unrelatedMarker, 2),
    ];
    const threadWindow = makeWindow({
      thread_key: "q-1139",
      from_item: 0,
      item_count: 2,
      total_items: 2,
      source_history_length: 4,
    });
    const feedSync = buildThreadFeedWindowSync({
      threadKey: "q-1139",
      entries: [
        { message: sourceMarker, history_index: 1 },
        { message: unrelatedMarker, history_index: 2 },
      ],
      window: threadWindow,
    });

    const model = buildMessageModel({
      threadKey: "q-1139",
      allMessages: [],
      selectedFeedWindow: threadWindow,
      selectedFeedWindowMessages,
      sessionNotifications: [],
    });

    expect(feedSync.items.map((item) => item.messageId)).toEqual(["transition-q1139-q1141", "transition-q1141-q1135"]);
    expect(model.messages.map((message) => message.id)).toEqual(["transition-q1139-q1141"]);
  });

  it("projects producer-shaped Main-origin handoff markers in the Main selected window", () => {
    const mainToDestination = makeTransitionMarker({
      id: "transition-main-q948",
      sourceThreadKey: "main",
      threadKey: "q-948",
    });
    const unrelatedPair = makeTransitionMarker({
      id: "transition-q950-q951",
      sourceThreadKey: "q-950",
      threadKey: "q-951",
    });
    const history: BrowserIncomingMessage[] = [
      {
        type: "user_message",
        id: "main-request",
        content: "Please work on q-948",
        timestamp: 100,
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        timestamp: 110,
        message: {
          id: "main-tool-use",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "tool_use", id: "tool-view-image", name: "View", input: { file_path: "screenshot.png" } }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: "tool_result_preview",
        previews: [
          {
            tool_use_id: "tool-view-image",
            content: "viewed screenshot",
            is_error: false,
            total_size: 17,
            is_truncated: false,
          },
        ],
      },
      mainToDestination,
      {
        type: "assistant",
        parent_tool_use_id: null,
        timestamp: 130,
        threadKey: "q-948",
        questId: "q-948",
        threadRefs: [{ threadKey: "q-948", questId: "q-948", source: "explicit" }],
        message: {
          id: "destination-output",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "Continuing in q-948" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      unrelatedPair,
    ];
    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const selectedFeedWindowMessages = sync.entries.flatMap((entry) =>
      normalizeHistoryMessageToChatMessages(entry.message, entry.history_index),
    );

    const model = buildMessageModel({
      threadKey: "main",
      allMessages: [],
      selectedFeedWindow: sync.window,
      selectedFeedWindowMessages,
      sessionNotifications: [],
    });

    expect(sync.entries.map((entry) => (entry.message as { id?: string }).id)).toEqual([
      "main-request",
      undefined,
      undefined,
      "transition-main-q948",
    ]);
    expect(model.messages.map((message) => message.id)).toEqual([
      "main-request",
      "main-tool-use",
      "transition-main-q948",
    ]);
    expect(model.messages.map((message) => message.content)).toContain("Work continued from Main to thread:q-948");
    expect(model.messages.map((message) => message.content)).not.toContain("Continuing in q-948");
    expect(model.messages.map((message) => message.content)).not.toContain(
      "Work continued from thread:q-950 to thread:q-951",
    );
  });
});
