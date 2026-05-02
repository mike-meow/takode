// @vitest-environment jsdom

const mockScrollIntoView = vi.fn();
const mockScrollTo = vi.fn();
const mediaState = { touchDevice: false };

beforeAll(() => {
  Element.prototype.scrollIntoView = mockScrollIntoView;
  Element.prototype.scrollTo = mockScrollTo;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(hover: none) and (pointer: coarse)" ? mediaState.touchDevice : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatMessage, ThreadAttachmentMarker } from "../types.js";

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

const mockStoreValues: Record<string, unknown> = {};
const mockToggleTurnActivity = vi.fn();
const mockFocusTurn = vi.fn();
const mockClearScrollToTurn = vi.fn();
const mockClearScrollToMessage = vi.fn();
const mockSetActiveTaskTurnId = vi.fn();
const mockKeepTurnExpanded = vi.fn();
const mockSetCollapsibleTurnIds = vi.fn();
const mockSetFeedScrollPosition = vi.fn();
const mockCollapseAllTurnActivity = vi.fn();
const mockClearBottomAlignOnNextUserMessage = vi.fn();
const mockSetComposerDraft = vi.fn();
const mockRequestScrollToMessage = vi.fn();
const mockSetExpandAllInTurn = vi.fn();
const mockSendToSession: any = vi.fn(() => true);
const mockOpenQuestOverlay = vi.fn();

vi.mock("../ws.js", () => ({
  sendToSession: (sessionId: string, msg: any) => mockSendToSession(sessionId, msg),
}));

vi.mock("../store.js", () => {
  const useStore: any = (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      messages: mockStoreValues.messages ?? new Map(),
      messageFrozenCounts: mockStoreValues.messageFrozenCounts ?? new Map(),
      messageFrozenRevisions: mockStoreValues.messageFrozenRevisions ?? new Map(),
      historyLoading: mockStoreValues.historyLoading ?? new Map(),
      historyWindows: mockStoreValues.historyWindows ?? new Map(),
      streaming: mockStoreValues.streaming ?? new Map(),
      streamingByParentToolUseId: mockStoreValues.streamingByParentToolUseId ?? new Map(),
      streamingThinking: mockStoreValues.streamingThinking ?? new Map(),
      streamingThinkingByParentToolUseId: mockStoreValues.streamingThinkingByParentToolUseId ?? new Map(),
      streamingStartedAt: mockStoreValues.streamingStartedAt ?? new Map(),
      streamingOutputTokens: mockStoreValues.streamingOutputTokens ?? new Map(),
      streamingPausedDuration: mockStoreValues.streamingPausedDuration ?? new Map(),
      streamingPauseStartedAt: mockStoreValues.streamingPauseStartedAt ?? new Map(),
      sessionStatus: mockStoreValues.sessionStatus ?? new Map(),
      sessionStuck: mockStoreValues.sessionStuck ?? new Map(),
      sessions: mockStoreValues.sessions ?? new Map(),
      toolProgress: mockStoreValues.toolProgress ?? new Map(),
      toolResults: mockStoreValues.toolResults ?? new Map(),
      toolStartTimestamps: mockStoreValues.toolStartTimestamps ?? new Map(),
      sdkSessions: mockStoreValues.sdkSessions ?? [],
      feedScrollPosition: mockStoreValues.feedScrollPosition ?? new Map(),
      turnActivityOverrides: mockStoreValues.turnActivityOverrides ?? new Map(),
      autoExpandedTurnIds: mockStoreValues.autoExpandedTurnIds ?? new Map(),
      toggleTurnActivity: mockToggleTurnActivity,
      scrollToTurnId: mockStoreValues.scrollToTurnId ?? new Map(),
      clearScrollToTurn: mockClearScrollToTurn,
      scrollToMessageId: mockStoreValues.scrollToMessageId ?? new Map(),
      clearScrollToMessage: mockClearScrollToMessage,
      expandAllInTurn: mockStoreValues.expandAllInTurn ?? new Map(),
      clearExpandAllInTurn: vi.fn(),
      bottomAlignNextUserMessage: mockStoreValues.bottomAlignNextUserMessage ?? new Set(),
      sessionTaskHistory: mockStoreValues.sessionTaskHistory ?? new Map(),
      pendingUserUploads: mockStoreValues.pendingUserUploads ?? new Map(),
      pendingCodexInputs: mockStoreValues.pendingCodexInputs ?? new Map(),
      activeTaskTurnId: mockStoreValues.activeTaskTurnId ?? new Map(),
      setActiveTaskTurnId: mockSetActiveTaskTurnId,
      backgroundAgentNotifs: mockStoreValues.backgroundAgentNotifs ?? new Map(),
      sessionNotifications: mockStoreValues.sessionNotifications ?? new Map(),
      sessionAttentionRecords: mockStoreValues.sessionAttentionRecords ?? new Map(),
      sessionBoards: mockStoreValues.sessionBoards ?? new Map(),
      sessionCompletedBoards: mockStoreValues.sessionCompletedBoards ?? new Map(),
      sessionSearch: mockStoreValues.sessionSearch ?? new Map(),
      quests: mockStoreValues.quests ?? [],
    };
    return selector(state);
  };
  useStore.getState = () => ({
    feedScrollPosition: mockStoreValues.feedScrollPosition ?? new Map(),
    setFeedScrollPosition: mockSetFeedScrollPosition,
    collapseAllTurnActivity: mockCollapseAllTurnActivity,
    setCollapsibleTurnIds: mockSetCollapsibleTurnIds,
    turnActivityOverrides: mockStoreValues.turnActivityOverrides ?? new Map(),
    autoExpandedTurnIds: mockStoreValues.autoExpandedTurnIds ?? new Map(),
    toggleTurnActivity: mockToggleTurnActivity,
    focusTurn: mockFocusTurn,
    keepTurnExpanded: mockKeepTurnExpanded,
    clearBottomAlignOnNextUserMessage: mockClearBottomAlignOnNextUserMessage,
    setComposerDraft: mockSetComposerDraft,
    requestScrollToMessage: mockRequestScrollToMessage,
    setExpandAllInTurn: mockSetExpandAllInTurn,
    openQuestOverlay: mockOpenQuestOverlay,
    sessionNotifications: mockStoreValues.sessionNotifications ?? new Map(),
    sessionAttentionRecords: mockStoreValues.sessionAttentionRecords ?? new Map(),
    removePendingUserUpload: vi.fn(),
    updatePendingUserUpload: vi.fn(),
    focusComposer: vi.fn(),
  });
  return {
    useStore,
    getSessionSearchState: () => {
      return { query: "", isOpen: false, mode: "strict", category: "all", matches: [], currentMatchIndex: -1 };
    },
  };
});

import { MessageFeed } from "./MessageFeed.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function movedMarker(overrides: Partial<ThreadAttachmentMarker> & { id: string; threadKey: string; count: number }) {
  return {
    type: "thread_attachment_marker" as const,
    timestamp: 1,
    markerKey: `thread-attachment:${overrides.threadKey}:${overrides.id}`,
    questId: overrides.threadKey,
    attachedAt: 1,
    attachedBy: "session-1",
    messageIds: [],
    messageIndices: [],
    ranges: [],
    firstMessageId: overrides.id,
    firstMessageIndex: 0,
    ...overrides,
  };
}

function expectTextContent(element: Element, text: string) {
  expect(element.textContent).toContain(text);
}

function setStoreMessages(sessionId: string, msgs: ChatMessage[]) {
  const map = new Map();
  map.set(sessionId, msgs);
  mockStoreValues.messages = map;
}

function setStoreAttentionRecords(sessionId: string, records: Array<Record<string, unknown>>) {
  const map = new Map();
  map.set(sessionId, records);
  mockStoreValues.sessionAttentionRecords = map;
}

function resetStore() {
  mockToggleTurnActivity.mockReset();
  mockFocusTurn.mockReset();
  mockClearScrollToTurn.mockReset();
  mockClearScrollToMessage.mockReset();
  mockSetActiveTaskTurnId.mockReset();
  mockKeepTurnExpanded.mockReset();
  mockSetCollapsibleTurnIds.mockReset();
  mockSetFeedScrollPosition.mockReset();
  mockCollapseAllTurnActivity.mockReset();
  mockClearBottomAlignOnNextUserMessage.mockReset();
  mockSetComposerDraft.mockReset();
  mockRequestScrollToMessage.mockReset();
  mockSetExpandAllInTurn.mockReset();
  mockOpenQuestOverlay.mockReset();
  mockSendToSession.mockReset();
  mockSendToSession.mockReturnValue(true);
  mockStoreValues.messages = new Map();
  mockStoreValues.messageFrozenCounts = new Map();
  mockStoreValues.messageFrozenRevisions = new Map();
  mockStoreValues.historyWindows = new Map();
  mockStoreValues.streaming = new Map();
  mockStoreValues.streamingByParentToolUseId = new Map();
  mockStoreValues.streamingStartedAt = new Map();
  mockStoreValues.streamingOutputTokens = new Map();
  mockStoreValues.streamingPausedDuration = new Map();
  mockStoreValues.streamingPauseStartedAt = new Map();
  mockStoreValues.sessionStatus = new Map();
  mockStoreValues.sessions = new Map();
  mockStoreValues.sessionNotifications = new Map();
  mockStoreValues.sessionAttentionRecords = new Map();
  mockStoreValues.sessionBoards = new Map();
  mockStoreValues.sessionCompletedBoards = new Map();
  mockStoreValues.toolProgress = new Map();
  mockStoreValues.toolResults = new Map();
  mockStoreValues.toolStartTimestamps = new Map();
  mockStoreValues.turnActivityOverrides = new Map();
  mockStoreValues.autoExpandedTurnIds = new Map();
  mockStoreValues.backgroundAgentNotifs = new Map();
  mockStoreValues.scrollToTurnId = new Map();
  mockStoreValues.scrollToMessageId = new Map();
  mockStoreValues.expandAllInTurn = new Map();
  mockStoreValues.bottomAlignNextUserMessage = new Set();
  mockStoreValues.sessionTaskHistory = new Map();
  mockStoreValues.pendingCodexInputs = new Map();
  mockStoreValues.activeTaskTurnId = new Map();
  mockStoreValues.sdkSessions = [];
  mockStoreValues.quests = [];
}

beforeEach(() => {
  resetStore();
  mockScrollIntoView.mockClear();
  mockScrollTo.mockClear();
  mediaState.touchDevice = false;
});

describe("MessageFeed - thread movement rows", () => {
  it("shows marker-backed attachment summaries in Main and hides the covered backfill messages", () => {
    const sid = "test-main-marker-backed-backfill";
    const marker = movedMarker({
      id: "marker-q-941",
      threadKey: "q-941",
      timestamp: 3,
      messageIds: ["m-backfill"],
      messageIndices: [1],
      ranges: ["1"],
      count: 1,
      firstMessageId: "m-backfill",
      firstMessageIndex: 1,
    });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Main setup", historyIndex: 0 }),
      makeMessage({
        id: "m-backfill",
        role: "assistant",
        content: "Attached historical context",
        historyIndex: 1,
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "backfill" }] },
      }),
      makeMessage({
        id: marker.id,
        role: "system",
        content: "1 message moved to q-941",
        timestamp: marker.timestamp,
        historyIndex: 2,
        variant: "info",
        metadata: { threadAttachmentMarker: marker },
      }),
    ]);

    render(<MessageFeed sessionId={sid} onSelectThread={vi.fn()} />);

    expect(screen.getByText("Main setup")).toBeTruthy();
    const markerRow = screen.getByTestId("thread-attachment-marker");
    expect(markerRow.getAttribute("data-thread-key")).toBe("q-941");
    expectTextContent(markerRow, "1 message moved to thread:q-941");
    expect(screen.getByRole("button", { name: "thread:q-941" })).toBeTruthy();
    expect(screen.queryByText("Attached historical context")).toBeNull();
  });

  it("shows moved-message attachment summaries in the source quest thread", () => {
    const sid = "test-source-thread-marker-backed-handoff";
    const marker = movedMarker({
      id: "marker-q-941",
      threadKey: "q-941",
      count: 2,
      sourceThreadKey: "q-940",
      sourceQuestId: "q-940",
      messageIds: ["m-source-1", "m-source-2"],
      messageIndices: [1, 2],
      ranges: ["1-2"],
    });
    const onSelectThread = vi.fn();
    setStoreMessages(sid, [
      makeMessage({
        id: "m-source-1",
        role: "assistant",
        content: "Source quest setup",
        historyIndex: 1,
        metadata: { threadRefs: [{ threadKey: "q-940", questId: "q-940", source: "explicit" }] },
      }),
      makeMessage({
        id: "m-source-2",
        role: "assistant",
        content: "Source quest approval",
        historyIndex: 2,
        metadata: { threadRefs: [{ threadKey: "q-940", questId: "q-940", source: "explicit" }] },
      }),
      makeMessage({
        id: marker.id,
        role: "system",
        content: "2 messages moved to q-941",
        metadata: { threadAttachmentMarker: marker },
      }),
      makeMessage({
        id: "dest-only",
        role: "assistant",
        content: "Destination quest work",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-940" onSelectThread={onSelectThread} />);

    expect(screen.getByText("Source quest setup")).toBeTruthy();
    expect(screen.queryByText("Destination quest work")).toBeNull();
    const markerRow = screen.getByTestId("thread-attachment-marker");
    expectTextContent(markerRow, "2 messages moved to thread:q-941");
    fireEvent.click(screen.getByRole("button", { name: "thread:q-941" }));
    expect(onSelectThread).toHaveBeenCalledWith("q-941");
  });

  it("merges moved-message summaries into matching thread-created ledger rows", () => {
    const sid = "test-thread-created-movement-summary";
    const onSelectThread = vi.fn();
    const markerA = movedMarker({
      id: "marker-q-972-a",
      threadKey: "q-972",
      timestamp: 122,
      count: 2,
      messageIds: ["m1", "m2"],
      messageIndices: [1, 2],
      ranges: ["1-2"],
    });
    const markerB = movedMarker({
      id: "marker-q-972-b",
      threadKey: "q-972",
      timestamp: 123,
      count: 1,
      messageIds: ["m3"],
      messageIndices: [3],
      ranges: ["3"],
    });
    setStoreMessages(sid, [
      makeMessage({ id: "u-main", role: "user", content: "Coordinate active quests", timestamp: 100 }),
      makeMessage({
        id: markerA.id,
        role: "system",
        content: "2 messages moved to q-972",
        timestamp: markerA.timestamp,
        metadata: { threadAttachmentMarker: markerA },
      }),
      makeMessage({
        id: markerB.id,
        role: "system",
        content: "1 message moved to q-972",
        timestamp: markerB.timestamp,
        metadata: { threadAttachmentMarker: markerB },
      }),
    ]);
    setStoreAttentionRecords(sid, [
      {
        id: "thread-opened:q-972",
        leaderSessionId: sid,
        type: "quest_thread_created",
        source: { kind: "manual", id: "q-972", questId: "q-972", signature: "thread-opened" },
        questId: "q-972",
        threadKey: "q-972",
        title: "Thread opened",
        summary: "q-972: Restore source markers",
        actionLabel: "Open",
        priority: "created",
        state: "resolved",
        createdAt: 121,
        updatedAt: 121,
        resolvedAt: 121,
        route: { threadKey: "q-972", questId: "q-972" },
        chipEligible: false,
        ledgerEligible: true,
        dedupeKey: "thread-opened:q-972",
      },
    ]);

    render(<MessageFeed sessionId={sid} onSelectThread={onSelectThread} />);

    const row = screen.getByTestId("attention-ledger-row");
    expect(row.getAttribute("data-attention-type")).toBe("quest_thread_created");
    expectTextContent(row, "Thread opened");
    expectTextContent(row, "3 messages moved to thread:q-972");
    expect(screen.queryByTestId("thread-attachment-marker")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const details = within(row).getByTestId("attention-thread-movement-details");
    expectTextContent(details, "2 messages moved to thread:q-972");
    expectTextContent(details, "1 message moved to thread:q-972");
    expectTextContent(details, "Ranges: 1-2");
    expectTextContent(details, "Message ids: m3");

    fireEvent.click(within(row).getByRole("button", { name: "Open thread:q-972" }));
    expect(onSelectThread).toHaveBeenCalledWith("q-972");
  });

  it("keeps Main-routed messages visible when quest-routed messages have no movement marker", () => {
    const sid = "test-main-no-movement-no-loss";
    setStoreMessages(sid, [
      makeMessage({
        id: "u-approve",
        role: "user",
        content: "approve",
        timestamp: 100,
        metadata: { threadKey: "main" },
      }),
      makeMessage({
        id: "a-q1065",
        role: "assistant",
        content: "Approved and dispatched q-1065.",
        timestamp: 101,
        metadata: {
          threadKey: "q-1065",
          questId: "q-1065",
          threadRefs: [{ threadKey: "q-1065", questId: "q-1065", source: "explicit" }],
        },
      }),
      makeMessage({
        id: "a-main",
        role: "assistant",
        content: "No. I did not run takode thread attach.",
        timestamp: 102,
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("approve")).toBeTruthy();
    expect(screen.getByText("No. I did not run takode thread attach.")).toBeTruthy();
    expect(screen.queryByText("Approved and dispatched q-1065.")).toBeNull();
    expect(screen.queryByTestId("thread-attachment-marker")).toBeNull();
  });
});
