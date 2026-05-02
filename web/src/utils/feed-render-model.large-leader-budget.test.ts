import { describe, expect, it } from "vitest";
import type { ThreadWindowState } from "../types.js";
import type { Turn } from "../hooks/use-feed-model.js";
import {
  AUTOCOMPLETE_RECENCY_MAX_CHARS,
  AUTOCOMPLETE_RECENCY_MAX_RECENT_TURNS,
  AUTOCOMPLETE_RECENCY_MAX_SCANNED_MESSAGES,
  selectBoundedRecentAutocompleteContents,
} from "../components/composer-reference-utils.js";
import {
  SYNTHETIC_LEADER_SESSION_ID,
  SYNTHETIC_PRIMARY_THREAD_KEY,
  SYNTHETIC_SECONDARY_THREAD_KEY,
  collectFixtureStrings,
  createSyntheticLargeLeaderFeedFixture,
  createSyntheticLiveMainUpdate,
} from "../test-fixtures/large-leader-feed-fixture.js";
import { buildFeedMessageModel, buildFeedWindowModel } from "./feed-render-model.js";

function selectedWindow(threadKey: string, sourceHistoryLength: number, itemCount: number): ThreadWindowState {
  return {
    thread_key: threadKey,
    from_item: sourceHistoryLength,
    item_count: itemCount,
    total_items: sourceHistoryLength + itemCount,
    source_history_length: sourceHistoryLength,
    section_item_count: 50,
    visible_item_count: itemCount,
  };
}

function makeTurns(count: number): Turn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `synthetic-turn-${index}`,
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
  }));
}

describe("large leader synthetic feed budgets", () => {
  it("keeps Main feed derivation bounded while preserving source context and merged movement summaries", () => {
    const fixture = createSyntheticLargeLeaderFeedFixture();

    const model = buildFeedMessageModel({
      leaderSessionId: SYNTHETIC_LEADER_SESSION_ID,
      threadKey: "main",
      projectThreadRoutes: true,
      allMessages: fixture.allMessages,
      historyLoading: false,
      selectedFeedWindowEnabled: true,
      selectedFeedWindow: selectedWindow(
        "main",
        fixture.selectedWindowSourceHistoryLength,
        fixture.selectedMainWindowMessages.length,
      ),
      selectedFeedWindowMessages: fixture.selectedMainWindowMessages,
      sessionNotifications: fixture.sessionNotifications,
      sessionAttentionRecords: fixture.sessionAttentionRecords,
    });

    expect(fixture.allMessages.length).toBeGreaterThan(700);
    expect(model.messagesAvailableForDerivation.length).toBeLessThanOrEqual(fixture.budgets.maxMainDerivationMessages);
    expect(model.messages.length).toBeLessThanOrEqual(fixture.budgets.maxMainRenderedRows);
    expect(model.messages.some((message) => message.id === fixture.mainSourceMessageId)).toBe(true);
    expect(model.messages.some((message) => message.id === fixture.questSourceMessageId)).toBe(false);
    expect(model.messages.some((message) => message.metadata?.questId === SYNTHETIC_SECONDARY_THREAD_KEY)).toBe(false);

    const openedRecord = model.attentionRecordsWithThreadMovement.find(
      (record) => record.type === "quest_thread_created" && record.questId === SYNTHETIC_PRIMARY_THREAD_KEY,
    );
    expect(openedRecord?.threadAttachmentSummary?.count).toBe(3);
    expect(openedRecord?.threadAttachmentSummary?.details.join("\n")).toContain("Ranges:");
    expect(model.messages.some((message) => message.id === fixture.threadAttachmentMarkerMessageId)).toBe(false);
  });

  it("keeps selected quest-thread windows bounded without leaking Main or sibling-thread rows", () => {
    const fixture = createSyntheticLargeLeaderFeedFixture();

    const model = buildFeedMessageModel({
      leaderSessionId: SYNTHETIC_LEADER_SESSION_ID,
      threadKey: SYNTHETIC_PRIMARY_THREAD_KEY,
      projectThreadRoutes: true,
      allMessages: fixture.allMessages,
      historyLoading: false,
      selectedFeedWindowEnabled: true,
      selectedFeedWindow: selectedWindow(
        SYNTHETIC_PRIMARY_THREAD_KEY,
        fixture.selectedWindowSourceHistoryLength,
        fixture.selectedQuestWindowMessages.length,
      ),
      selectedFeedWindowMessages: fixture.selectedQuestWindowMessages,
      sessionNotifications: fixture.sessionNotifications,
      sessionAttentionRecords: fixture.sessionAttentionRecords,
    });

    expect(model.messages.length).toBeLessThanOrEqual(fixture.budgets.maxQuestRenderedRows);
    expect(model.messages.some((message) => message.id === fixture.questSourceMessageId)).toBe(true);
    expect(model.messages.some((message) => message.id === fixture.mainSourceMessageId)).toBe(false);
    expect(model.messages.some((message) => message.metadata?.questId === SYNTHETIC_SECONDARY_THREAD_KEY)).toBe(false);
    expect(model.messages.every((message) => !message.id.startsWith("synthetic-tail-main-"))).toBe(true);
  });

  it("keeps local section window budgets deterministic for large unwindowed leader histories", () => {
    const fixture = createSyntheticLargeLeaderFeedFixture();
    const model = buildFeedWindowModel({
      turns: makeTurns(120),
      sectionTurnCount: 5,
      sectionWindowStart: null,
      selectedFeedWindowEnabled: false,
      historyWindow: null,
      selectedFeedWindow: null,
      historyLoading: false,
      messageCount: 720,
    });

    expect(model.totalSections).toBe(24);
    expect(model.visibleSections).toHaveLength(3);
    expect(model.visibleSections.length).toBeLessThanOrEqual(fixture.budgets.maxVisibleSections);
    expect(model.visibleTurns).toHaveLength(15);
    expect(model.hasOlderSections).toBe(true);
    expect(model.hasNewerSections).toBe(false);
  });

  it("keeps composer recency bounded when a synthetic live update arrives while autocomplete is open", () => {
    const fixture = createSyntheticLargeLeaderFeedFixture();
    const updatedMessages = [...fixture.allMessages, createSyntheticLiveMainUpdate(fixture.allMessages.length + 1)];

    const contents = selectBoundedRecentAutocompleteContents(updatedMessages, { threadKey: "main" });
    const joined = contents.join("\n");

    expect(contents.length).toBeGreaterThanOrEqual(AUTOCOMPLETE_RECENCY_MAX_RECENT_TURNS);
    expect(contents.length).toBeLessThanOrEqual(AUTOCOMPLETE_RECENCY_MAX_SCANNED_MESSAGES);
    expect(joined.length).toBeLessThanOrEqual(AUTOCOMPLETE_RECENCY_MAX_CHARS);
    expect(joined).toContain("Synthetic live Main update");
    expect(joined).not.toContain("Synthetic q-1079 needs-input source");
    expect(joined).not.toContain("Synthetic q-1080 routed update");
  });

  it("keeps the committed large-leader fixture synthetic and free of obvious private-data patterns", () => {
    const fixture = createSyntheticLargeLeaderFeedFixture();
    const text = collectFixtureStrings(fixture).join("\n");

    expect(text).not.toMatch(/\/Users\/[A-Za-z0-9._-]+/);
    expect(text).not.toMatch(/\/home\/[A-Za-z0-9._-]+/);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/i);
    expect(text).not.toMatch(/ghp_[A-Za-z0-9]{10,}/i);
    expect(text).not.toMatch(/xox[baprs]-[A-Za-z0-9-]+/i);
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });
});
