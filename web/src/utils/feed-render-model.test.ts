import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage, ChatMessage, SessionNotification, ThreadWindowState } from "../types.js";
import type { Turn } from "../hooks/use-feed-model.js";
import { buildFeedMessageModel, buildFeedWindowModel } from "./feed-render-model.js";
import { buildThreadFeedWindowSync } from "../../shared/feed-window-sync.js";

function makeMessage(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"] }): ChatMessage {
  return {
    content: "",
    timestamp: 1,
    ...overrides,
  };
}

function makeNotification(overrides: Partial<SessionNotification> & { id: string; messageId: string }) {
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
    });

    expect(model.messages.map((message) => message.id)).toEqual(["a-proposal", "a-tail"]);
    expect(model.attentionLedgerMessages).toHaveLength(0);
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
});
