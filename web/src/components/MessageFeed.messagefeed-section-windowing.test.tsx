// @vitest-environment jsdom

// jsdom does not implement scrollIntoView; polyfill it before any React rendering
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

import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { BrowserIncomingMessage, ChatMessage } from "../types.js";
import type { FeedEntry, Turn } from "../hooks/use-feed-model.js";
import { FEED_WINDOW_SYNC_VERSION } from "../../shared/feed-window-sync.js";

// Mock react-markdown to avoid ESM issues in tests
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

// Build a mock for the store that returns configurable values per session
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
const mockSendToSession: any = vi.fn(() => true);

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
      threadWindows: mockStoreValues.threadWindows ?? new Map(),
      threadWindowMessages: mockStoreValues.threadWindowMessages ?? new Map(),
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
      sessionSearch: mockStoreValues.sessionSearch ?? new Map(),
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
    removePendingUserUpload: vi.fn(),
    updatePendingUserUpload: vi.fn(),
    focusComposer: vi.fn(),
  });
  return {
    useStore,
    getSessionSearchState: (state: Record<string, unknown>, _sessionId: string) => {
      return { query: "", isOpen: false, mode: "strict", category: "all", matches: [], currentMatchIndex: -1 };
    },
  };
});

import {
  MessageFeed,
  ElapsedTimer,
  buildFeedSections,
  findActiveTaskTurnIdForScroll,
  findSectionWindowStartIndexForTarget,
  findVisibleSectionEndIndex,
  findVisibleSectionStartIndex,
} from "./MessageFeed.js";
import { HISTORY_WINDOW_SECTION_TURN_COUNT } from "../../shared/history-window.js";
import { cacheHistoryWindow } from "../utils/history-window-cache.js";

function makeMessage(overrides: Partial<ChatMessage> & { role: ChatMessage["role"] }): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeFeedEntryMessage(msg: ChatMessage): FeedEntry {
  return { kind: "message", msg };
}

function makeTurnForSections({
  id,
  userEntry = null,
  systemEntries = [],
  agentEntries = [],
  responseEntry = null,
}: {
  id: string;
  userEntry?: FeedEntry | null;
  systemEntries?: FeedEntry[];
  agentEntries?: FeedEntry[];
  responseEntry?: FeedEntry | null;
}): Turn {
  return {
    id,
    userEntry,
    allEntries: [...systemEntries, ...agentEntries, ...(responseEntry ? [responseEntry] : [])],
    agentEntries,
    systemEntries,
    notificationEntries: [],
    responseEntry,
    subConclusions: [],
    stats: {
      messageCount: 0,
      toolCount: 0,
      subagentCount: 0,
      herdEventCount: 0,
    },
  };
}

function makeSectionTurns(totalTurns: number): Turn[] {
  return Array.from({ length: totalTurns }, (_, index) => {
    const turnNumber = index + 1;
    return makeTurnForSections({
      id: `turn-${turnNumber}`,
      userEntry: makeFeedEntryMessage(
        makeMessage({
          id: `u${turnNumber}`,
          role: "user",
          content: `Turn ${turnNumber}`,
        }),
      ),
    });
  });
}

function makeSectionedMessages(sectionCount: number, turnsPerSection = 50): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let timestamp = 1_700_000_000_000;

  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
    for (let turnIndex = 0; turnIndex < turnsPerSection; turnIndex++) {
      const turnNumber = sectionIndex * turnsPerSection + turnIndex + 1;
      const label =
        turnIndex === 0 ? `Section ${sectionIndex + 1} marker` : `Section ${sectionIndex + 1} turn ${turnIndex + 1}`;
      messages.push(
        makeMessage({
          id: `u${turnNumber}`,
          role: "user",
          content: label,
          timestamp: timestamp++,
        }),
      );
    }
  }

  return messages;
}

function setStoreMessages(sessionId: string, msgs: ChatMessage[]) {
  const map = new Map();
  map.set(sessionId, msgs);
  mockStoreValues.messages = map;
}

function setStoreStreaming(sessionId: string, text: string | undefined) {
  const map = new Map();
  if (text !== undefined) map.set(sessionId, text);
  mockStoreValues.streaming = map;
}

function setStoreThinking(sessionId: string, text: string | undefined) {
  const map = new Map();
  if (text !== undefined) map.set(sessionId, text);
  mockStoreValues.streamingThinking = map;
}

function setStorePendingCodexInputs(sessionId: string, inputs: Array<Record<string, unknown>>) {
  const map = new Map();
  map.set(sessionId, inputs);
  mockStoreValues.pendingCodexInputs = map;
}

function setStorePendingUserUploads(sessionId: string, uploads: Array<Record<string, unknown>>) {
  const map = new Map();
  map.set(sessionId, uploads);
  mockStoreValues.pendingUserUploads = map;
}

function setStoreNotifications(sessionId: string, notifications: Array<Record<string, unknown>>) {
  const map = new Map();
  map.set(sessionId, notifications);
  mockStoreValues.sessionNotifications = map;
}

function setStoreHistoryLoading(sessionId: string, loading: boolean) {
  const map = new Map();
  if (loading) map.set(sessionId, true);
  mockStoreValues.historyLoading = map;
}

function setStoreHistoryWindow(sessionId: string) {
  mockStoreValues.historyWindows = new Map([
    [
      sessionId,
      {
        from_turn: 22,
        turn_count: 15,
        total_turns: 37,
        section_turn_count: 5,
        visible_section_count: 3,
      },
    ],
  ]);
}

function setStoreFeedScrollPosition(
  sessionId: string,
  pos: {
    scrollTop: number;
    scrollHeight: number;
    isAtBottom: boolean;
    anchorTurnId?: string | null;
    anchorOffsetTop?: number;
    lastSeenContentBottom?: number | null;
  },
) {
  const map = new Map();
  map.set(sessionId, pos);
  map.set(`${sessionId}:thread:main`, pos);
  mockStoreValues.feedScrollPosition = map;
}

function setStoreParentStreaming(sessionId: string, entries: Record<string, string>) {
  const map = new Map();
  map.set(sessionId, new Map(Object.entries(entries)));
  mockStoreValues.streamingByParentToolUseId = map;
}

function setStoreParentThinking(sessionId: string, entries: Record<string, string>) {
  const map = new Map();
  map.set(sessionId, new Map(Object.entries(entries)));
  mockStoreValues.streamingThinkingByParentToolUseId = map;
}

function setStoreStatus(sessionId: string, status: string | null) {
  const statusMap = new Map();
  if (status) statusMap.set(sessionId, status);
  mockStoreValues.sessionStatus = statusMap;
}

function setStoreSessionBackend(sessionId: string, backend: "claude" | "codex") {
  const map = new Map();
  map.set(sessionId, { backend_type: backend });
  mockStoreValues.sessions = map;
}

function setStoreSessionState(sessionId: string, session: Record<string, unknown>) {
  const map = new Map();
  map.set(sessionId, session);
  mockStoreValues.sessions = map;
}

function setStoreStreamingStartedAt(sessionId: string, startedAt: number | undefined) {
  const map = new Map();
  if (startedAt !== undefined) map.set(sessionId, startedAt);
  mockStoreValues.streamingStartedAt = map;
}

function setStoreStreamingOutputTokens(sessionId: string, tokens: number | undefined) {
  const map = new Map();
  if (tokens !== undefined) map.set(sessionId, tokens);
  mockStoreValues.streamingOutputTokens = map;
}

function setStoreToolProgress(
  sessionId: string,
  entries: Array<{ toolUseId: string; toolName: string; elapsedSeconds: number; output?: string }>,
) {
  const toolProgressMap = new Map();
  const sessionProgress = new Map();
  for (const entry of entries) {
    sessionProgress.set(entry.toolUseId, {
      toolName: entry.toolName,
      elapsedSeconds: entry.elapsedSeconds,
      ...(entry.output ? { output: entry.output } : {}),
    });
  }
  toolProgressMap.set(sessionId, sessionProgress);
  mockStoreValues.toolProgress = toolProgressMap;
}

function setStoreToolStartTimestamps(sessionId: string, timestamps: Record<string, number>) {
  const map = new Map();
  map.set(sessionId, new Map(Object.entries(timestamps)));
  mockStoreValues.toolStartTimestamps = map;
}

function setStoreToolResults(
  sessionId: string,
  results: Record<string, { content: string; is_truncated: boolean; duration_seconds?: number; is_error?: boolean }>,
) {
  const map = new Map();
  map.set(sessionId, new Map(Object.entries(results)));
  mockStoreValues.toolResults = map;
}

function setStoreSdkSessionRole(sessionId: string, overrides: { isOrchestrator?: boolean; herdedBy?: string } = {}) {
  mockStoreValues.sdkSessions = [
    {
      sessionId,
      state: "connected",
      cwd: "/test",
      createdAt: Date.now(),
      ...(overrides.isOrchestrator ? { isOrchestrator: true } : {}),
      ...(overrides.herdedBy ? { herdedBy: overrides.herdedBy } : {}),
    },
  ];
}

function setStoreScrollToTurn(sessionId: string, turnId: string) {
  const map = new Map();
  map.set(sessionId, turnId);
  mockStoreValues.scrollToTurnId = map;
}

function setStoreScrollToMessage(sessionId: string, messageId: string) {
  const map = new Map();
  map.set(sessionId, messageId);
  mockStoreValues.scrollToMessageId = map;
}

function setStoreBottomAlignNextUserMessage(sessionId: string, enabled = true) {
  const set = new Set<string>();
  if (enabled) set.add(sessionId);
  mockStoreValues.bottomAlignNextUserMessage = set;
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
  mockStoreValues.threadWindows = new Map();
  mockStoreValues.threadWindowMessages = new Map();
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
  localStorage.clear();
}

/** Set explicit overrides for turn activity expansion per session.
 *  Each entry: [turnId, expanded: boolean]. */
function setStoreTurnOverrides(sessionId: string, overrides: [string, boolean][]) {
  const map = new Map();
  map.set(sessionId, new Map(overrides));
  mockStoreValues.turnActivityOverrides = map;
}

function setStoreAutoExpandedTurns(sessionId: string, turnIds: string[]) {
  const map = new Map();
  map.set(sessionId, new Set(turnIds));
  mockStoreValues.autoExpandedTurnIds = map;
}

function setStoreSelectedThreadWindow({
  sessionId,
  threadKey,
  fromItem,
  itemCount,
  totalItems,
  sectionItemCount,
  visibleItemCount,
  hasOlderItems,
  hasNewerItems,
  messages,
}: {
  sessionId: string;
  threadKey: string;
  fromItem: number;
  itemCount: number;
  totalItems: number;
  sectionItemCount: number;
  visibleItemCount: number;
  hasOlderItems?: boolean;
  hasNewerItems?: boolean;
  messages: ChatMessage[];
}) {
  mockStoreValues.threadWindows = new Map([
    [
      sessionId,
      new Map([
        [
          threadKey,
          {
            thread_key: threadKey,
            from_item: fromItem,
            item_count: itemCount,
            total_items: totalItems,
            ...(hasOlderItems === undefined ? {} : { has_older_items: hasOlderItems }),
            ...(hasNewerItems === undefined ? {} : { has_newer_items: hasNewerItems }),
            source_history_length: totalItems,
            section_item_count: sectionItemCount,
            visible_item_count: visibleItemCount,
          },
        ],
      ]),
    ],
  ]);
  mockStoreValues.threadWindowMessages = new Map([[sessionId, new Map([[threadKey, messages]])]]);
}

async function flushFeedObservers() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setElementOffsetMetrics(element: HTMLElement, offsetTop: number, offsetHeight: number) {
  Object.defineProperty(element, "offsetTop", {
    configurable: true,
    get() {
      return offsetTop;
    },
  });
  Object.defineProperty(element, "offsetHeight", {
    configurable: true,
    get() {
      return offsetHeight;
    },
  });
}

function setElementClientSize(element: HTMLElement, width: number, height: number) {
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    get() {
      return width;
    },
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get() {
      return height;
    },
  });
}

function setElementScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get() {
      return scrollHeight;
    },
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get() {
      return clientHeight;
    },
  });
  element.scrollTop = scrollTop;
}

function getScrollContainer(container: HTMLElement): HTMLElement {
  const scrollContainer = container.querySelector<HTMLElement>('[data-testid="message-feed-scroll-container"]');
  if (!scrollContainer) throw new Error("Message feed scroll container missing");
  return scrollContainer;
}

beforeEach(() => {
  resetStore();
  mockScrollIntoView.mockClear();
  mockScrollTo.mockClear();
  mediaState.touchDevice = false;
});

function makeDomRect(height: number, width = 0): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: height,
    right: width,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("MessageFeed section windowing", () => {
  it("chunks turns into fixed-size default sections", () => {
    const turns = makeSectionTurns(120);
    const sections = buildFeedSections(turns);
    const expectedSectionCount = Math.ceil(turns.length / HISTORY_WINDOW_SECTION_TURN_COUNT);

    expect(sections).toHaveLength(expectedSectionCount);
    expect(sections.map((section) => section.turns.length)).toEqual(
      Array.from({ length: expectedSectionCount }, (_, index) =>
        index === expectedSectionCount - 1
          ? turns.length - HISTORY_WINDOW_SECTION_TURN_COUNT * index
          : HISTORY_WINDOW_SECTION_TURN_COUNT,
      ),
    );
    expect(findVisibleSectionStartIndex(sections, 3)).toBe(Math.max(0, expectedSectionCount - 3));
    expect(findVisibleSectionEndIndex(sections, 0, 3)).toBe(Math.min(expectedSectionCount, 3));
    expect(findVisibleSectionStartIndex(sections, 2)).toBe(Math.max(0, expectedSectionCount - 2));
    expect(findVisibleSectionEndIndex(sections, 1, 2)).toBe(Math.min(expectedSectionCount, 3));
  });

  it("clamps target window selection for section-aware jumps", () => {
    const sections = buildFeedSections(makeSectionTurns(200), 50);

    expect(findSectionWindowStartIndexForTarget(sections, 0, 3)).toBe(0);
    expect(findSectionWindowStartIndexForTarget(sections, 1, 3)).toBe(0);
    expect(findSectionWindowStartIndexForTarget(sections, 2, 3)).toBe(1);
    expect(findSectionWindowStartIndexForTarget(sections, 3, 3)).toBe(1);
  });

  it("slides a bounded three-section window when the user scrolls older and then newer", () => {
    const sid = "test-section-window";
    setStoreMessages(sid, makeSectionedMessages(4, 2));
    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);
    const scrollContainer = getScrollContainer(container);

    expect(screen.queryByText("Section 1 marker")).toBeNull();
    expect(screen.getByText("Section 2 marker")).toBeTruthy();
    expect(screen.getByText("Section 4 marker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older section" })).toBeNull();
    expect(screen.getByText("Scroll up for older section")).toBeTruthy();
    expect(screen.queryByText("Loading older section...")).toBeNull();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);

    setElementScrollMetrics(scrollContainer, 1000, 300, 0);
    fireEvent.wheel(scrollContainer, { deltaY: -80 });

    expect(screen.getByText("Section 1 marker")).toBeTruthy();
    expect(screen.queryByText("Section 4 marker")).toBeNull();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);

    setElementScrollMetrics(scrollContainer, 1000, 300, 700);
    fireEvent.wheel(scrollContainer, { deltaY: 80 });

    expect(screen.queryByText("Section 1 marker")).toBeNull();
    expect(screen.getByText("Section 2 marker")).toBeTruthy();
    expect(screen.getByText("Section 4 marker")).toBeTruthy();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);
  });

  it("shows newer-section boundary text after loading older history", () => {
    const sid = "test-section-newer-control";
    setStoreMessages(sid, makeSectionedMessages(4, 2));

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);
    const scrollContainer = getScrollContainer(container);
    setElementScrollMetrics(scrollContainer, 1000, 300, 0);
    fireEvent.wheel(scrollContainer, { deltaY: -80 });

    expect(screen.queryByRole("button", { name: "Load newer section" })).toBeNull();
    expect(screen.getByText("Scroll down for newer section")).toBeTruthy();
    expect(screen.queryByText("Loading newer section...")).toBeNull();
    setElementScrollMetrics(scrollContainer, 1000, 300, 700);
    fireEvent.wheel(scrollContainer, { deltaY: 80 });
    expect(screen.queryByText("Section 1 marker")).toBeNull();
    expect(screen.getByText("Section 2 marker")).toBeTruthy();
    expect(screen.getByText("Section 4 marker")).toBeTruthy();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);
  });

  it("requests an older history window from the server when the loaded feed is windowed", () => {
    const sid = "test-windowed-history-request";
    setStoreMessages(sid, makeSectionedMessages(3, 2));
    const windows = new Map();
    windows.set(sid, {
      from_turn: 2,
      turn_count: 6,
      total_turns: 10,
      section_turn_count: 2,
      visible_section_count: 3,
    });
    mockStoreValues.historyWindows = windows;

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);
    const scrollContainer = getScrollContainer(container);

    setElementScrollMetrics(scrollContainer, 1000, 300, 0);
    fireEvent.wheel(scrollContainer, { deltaY: -80 });

    expect(mockSendToSession).toHaveBeenCalledWith(sid, {
      type: "history_window_request",
      from_turn: 0,
      turn_count: 10,
      section_turn_count: 2,
      visible_section_count: 3,
      feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
    });
  });

  it("sends a cached history window hash with scroll-triggered server window requests", () => {
    const sid = "test-windowed-history-cached-request";
    setStoreMessages(sid, makeSectionedMessages(3, 2));
    cacheHistoryWindow(
      sid,
      {
        from_turn: 0,
        turn_count: 10,
        total_turns: 10,
        section_turn_count: 2,
        visible_section_count: 3,
        window_hash: "cached-history-window",
      },
      [{ type: "user_message", id: "cached-u1", content: "cached", timestamp: 1 } as BrowserIncomingMessage],
    );
    const windows = new Map();
    windows.set(sid, {
      from_turn: 2,
      turn_count: 6,
      total_turns: 10,
      section_turn_count: 2,
      visible_section_count: 3,
    });
    mockStoreValues.historyWindows = windows;

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);
    const scrollContainer = getScrollContainer(container);
    setElementScrollMetrics(scrollContainer, 1000, 300, 0);
    fireEvent.wheel(scrollContainer, { deltaY: -80 });

    expect(mockSendToSession).toHaveBeenCalledWith(sid, {
      type: "history_window_request",
      from_turn: 0,
      turn_count: 10,
      section_turn_count: 2,
      visible_section_count: 3,
      feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
      cached_window_hash: "cached-history-window",
    });
  });

  it("requests a newer history window with adjacent context for smooth reverse scrolling", () => {
    const sid = "test-windowed-history-newer-context-request";
    setStoreMessages(sid, makeSectionedMessages(3, 2));
    const windows = new Map();
    windows.set(sid, {
      from_turn: 0,
      turn_count: 6,
      total_turns: 12,
      section_turn_count: 2,
      visible_section_count: 3,
    });
    mockStoreValues.historyWindows = windows;

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);
    const scrollContainer = getScrollContainer(container);

    setElementScrollMetrics(scrollContainer, 1000, 300, 700);
    fireEvent.wheel(scrollContainer, { deltaY: 80 });

    expect(mockSendToSession).toHaveBeenCalledWith(sid, {
      type: "history_window_request",
      from_turn: 2,
      turn_count: 10,
      section_turn_count: 2,
      visible_section_count: 3,
      feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
    });
    expect(screen.getByText("Loading newer section...")).toBeTruthy();
  });

  it("renders a temporary five-section history window without showing an unavailable older boundary", () => {
    const sid = "test-windowed-history-expanded-context-render";
    setStoreMessages(sid, makeSectionedMessages(5, 2));
    const windows = new Map();
    windows.set(sid, {
      from_turn: 0,
      turn_count: 10,
      total_turns: 12,
      section_turn_count: 2,
      visible_section_count: 3,
    });
    mockStoreValues.historyWindows = windows;

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);

    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(5);
    expect(screen.queryByText("Scroll up for older section")).toBeNull();
    expect(screen.getByText("Scroll down for newer section")).toBeTruthy();
  });

  it("keeps leader Main loading while the selected thread window hydrates", async () => {
    const sid = "test-leader-main-selected-window-cold-start";
    const mainTail = makeMessage({
      id: "u-main-tail",
      role: "user",
      content: "Persisted Main history tail",
      timestamp: 100,
      historyIndex: 42,
    });
    setStoreSessionState(sid, { isOrchestrator: true });
    setStoreMessages(sid, [mainTail]);
    setStoreHistoryWindow(sid);

    const { rerender } = render(<MessageFeed sessionId={sid} threadKey="main" sectionTurnCount={5} />);

    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.getByText("Loading conversation...")).toBeTruthy();
    await flushFeedObservers();
    expect(mockSendToSession).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({
        type: "thread_window_request",
        thread_key: "main",
        from_item: -1,
        item_count: 15,
        section_item_count: 5,
        visible_item_count: 3,
        feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
      }),
    );

    setStoreSelectedThreadWindow({
      sessionId: sid,
      threadKey: "main",
      fromItem: 22,
      itemCount: 15,
      totalItems: 37,
      sectionItemCount: 5,
      visibleItemCount: 3,
      messages: [mainTail],
    });
    rerender(<MessageFeed sessionId={sid} threadKey="main" sectionTurnCount={5} />);

    expect(screen.getByText("Persisted Main history tail")).toBeTruthy();
    expect(screen.queryByText("Start a conversation")).toBeNull();
  });

  it("requests the Main selected window when returning from a quest tab", async () => {
    const sid = "test-leader-main-request-after-quest-tab";
    const mainTail = makeMessage({
      id: "u-main-tail-after-quest",
      role: "user",
      content: "Main content after quest return",
      timestamp: 100,
      historyIndex: 42,
    });
    const questTail = makeMessage({
      id: "u-quest-tail",
      role: "user",
      content: "Quest thread content",
      timestamp: 200,
      historyIndex: 43,
    });
    setStoreSessionState(sid, { isOrchestrator: true });
    setStoreMessages(sid, [mainTail]);
    setStoreHistoryWindow(sid);
    setStoreSelectedThreadWindow({
      sessionId: sid,
      threadKey: "q-1162",
      fromItem: 0,
      itemCount: 1,
      totalItems: 1,
      sectionItemCount: 5,
      visibleItemCount: 3,
      messages: [questTail],
    });
    const { rerender } = render(<MessageFeed sessionId={sid} threadKey="q-1162" sectionTurnCount={5} />);
    await flushFeedObservers();
    mockSendToSession.mockClear();

    rerender(<MessageFeed sessionId={sid} threadKey="main" sectionTurnCount={5} />);

    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.getByText("Loading conversation...")).toBeTruthy();
    await flushFeedObservers();
    expect(mockSendToSession).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({
        type: "thread_window_request",
        thread_key: "main",
        from_item: -1,
      }),
    );
  });

  it("does not auto-load newer selected-thread content on stationary mobile top overscroll", () => {
    // q-1050 follow-up: on mobile, pulling upward at the top of a short completed
    // selected-thread window can produce scroll events without changing scrollTop.
    // That must not be treated as a downward/newer boundary scroll, or the feed
    // snaps back toward latest while showing "Loading older section...".
    mediaState.touchDevice = true;
    const sid = "test-selected-thread-mobile-top-overscroll";
    const threadKey = "q-1027";
    setStoreSessionState(sid, { isOrchestrator: true });
    const selectedThreadMessages = [
      makeMessage({ id: "u3", role: "user", content: "Completed q-1027 turn 3", timestamp: 3 }),
      makeMessage({ id: "a3", role: "assistant", content: "Completed q-1027 reply 3", timestamp: 4 }),
      makeMessage({ id: "u4", role: "user", content: "Completed q-1027 turn 4", timestamp: 5 }),
      makeMessage({ id: "a4", role: "assistant", content: "Completed q-1027 reply 4", timestamp: 6 }),
    ];
    setStoreSelectedThreadWindow({
      sessionId: sid,
      threadKey,
      fromItem: 2,
      itemCount: 6,
      totalItems: 10,
      sectionItemCount: 2,
      visibleItemCount: 3,
      messages: selectedThreadMessages,
    });

    const { container } = render(
      <MessageFeed sessionId={sid} threadKey={threadKey} projectThreadRoutes={false} sectionTurnCount={2} />,
    );
    const scrollContainer = getScrollContainer(container);
    setElementScrollMetrics(scrollContainer, 380, 340, 0);

    fireEvent.scroll(scrollContainer);

    expect(mockSendToSession).not.toHaveBeenCalledWith(
      sid,
      expect.objectContaining({
        type: "thread_window_request",
        from_item: 4,
      }),
    );
    expect(screen.getByText("Scroll up for older section")).toBeTruthy();
    expect(screen.getByText("Scroll down for newer section")).toBeTruthy();
  });

  it("auto-loads older selected-thread content on an upward boundary scroll", () => {
    const sid = "test-selected-thread-upward-boundary-scroll";
    const threadKey = "q-1027";
    setStoreSessionState(sid, { isOrchestrator: true });
    setStoreSelectedThreadWindow({
      sessionId: sid,
      threadKey,
      fromItem: 2,
      itemCount: 6,
      totalItems: 10,
      sectionItemCount: 2,
      visibleItemCount: 3,
      messages: [
        makeMessage({ id: "u3", role: "user", content: "Completed q-1027 turn 3", timestamp: 3 }),
        makeMessage({ id: "a3", role: "assistant", content: "Completed q-1027 reply 3", timestamp: 4 }),
        makeMessage({ id: "u4", role: "user", content: "Completed q-1027 turn 4", timestamp: 5 }),
        makeMessage({ id: "a4", role: "assistant", content: "Completed q-1027 reply 4", timestamp: 6 }),
      ],
    });

    const { container } = render(
      <MessageFeed sessionId={sid} threadKey={threadKey} projectThreadRoutes={false} sectionTurnCount={2} />,
    );
    const scrollContainer = getScrollContainer(container);
    setElementScrollMetrics(scrollContainer, 1000, 340, 120);
    fireEvent.scroll(scrollContainer);
    mockSendToSession.mockClear();

    setElementScrollMetrics(scrollContainer, 1000, 340, 0);
    fireEvent.scroll(scrollContainer);

    expect(mockSendToSession).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({
        type: "thread_window_request",
        from_item: 0,
        item_count: 10,
      }),
    );
    expect(screen.getByText("Loading older section...")).toBeTruthy();
  });

  it("hides selected-thread boundary affordances when explicit server availability is false", () => {
    const sid = "test-selected-thread-explicit-unavailable";
    const threadKey = "q-1027";
    setStoreSessionState(sid, { isOrchestrator: true });
    setStoreSelectedThreadWindow({
      sessionId: sid,
      threadKey,
      fromItem: 2,
      itemCount: 6,
      totalItems: 10,
      sectionItemCount: 2,
      visibleItemCount: 3,
      hasOlderItems: false,
      hasNewerItems: false,
      messages: [
        makeMessage({ id: "u3", role: "user", content: "Completed q-1027 turn 3", timestamp: 3 }),
        makeMessage({ id: "a3", role: "assistant", content: "Completed q-1027 reply 3", timestamp: 4 }),
      ],
    });

    const { container } = render(
      <MessageFeed sessionId={sid} threadKey={threadKey} projectThreadRoutes={false} sectionTurnCount={2} />,
    );
    const scrollContainer = getScrollContainer(container);
    setElementScrollMetrics(scrollContainer, 1000, 340, 660);
    fireEvent.wheel(scrollContainer, { deltaY: 80 });

    expect(screen.queryByText("Scroll up for older section")).toBeNull();
    expect(screen.queryByText("Scroll down for newer section")).toBeNull();
    expect(screen.queryByText("Latest section below")).toBeNull();
    expect(mockSendToSession).not.toHaveBeenCalledWith(sid, expect.objectContaining({ type: "thread_window_request" }));
  });

  it("clears pending selected-thread loading after an authoritative no-op sync rerender", () => {
    const sid = "test-selected-thread-noop-sync-clears-pending";
    const threadKey = "q-1027";
    setStoreSessionState(sid, { isOrchestrator: true });
    const messages = [
      makeMessage({ id: "u3", role: "user", content: "Completed q-1027 turn 3", timestamp: 3 }),
      makeMessage({ id: "a3", role: "assistant", content: "Completed q-1027 reply 3", timestamp: 4 }),
    ];
    setStoreSelectedThreadWindow({
      sessionId: sid,
      threadKey,
      fromItem: 0,
      itemCount: 6,
      totalItems: 12,
      sectionItemCount: 2,
      visibleItemCount: 3,
      hasOlderItems: false,
      hasNewerItems: true,
      messages,
    });

    const { container, rerender } = render(
      <MessageFeed sessionId={sid} threadKey={threadKey} projectThreadRoutes={false} sectionTurnCount={2} />,
    );
    const scrollContainer = getScrollContainer(container);
    setElementScrollMetrics(scrollContainer, 1000, 340, 660);
    fireEvent.wheel(scrollContainer, { deltaY: 80 });

    expect(screen.getByText("Loading newer section...")).toBeTruthy();

    setStoreSelectedThreadWindow({
      sessionId: sid,
      threadKey,
      fromItem: 0,
      itemCount: 6,
      totalItems: 12,
      sectionItemCount: 2,
      visibleItemCount: 3,
      hasOlderItems: false,
      hasNewerItems: true,
      messages,
    });
    rerender(<MessageFeed sessionId={sid} threadKey={threadKey} projectThreadRoutes={false} sectionTurnCount={2} />);

    expect(screen.queryByText("Loading newer section...")).toBeNull();
    expect(screen.getByText("Scroll down for newer section")).toBeTruthy();
  });

  it("remounts the correct section window before scrolling to an older turn", async () => {
    const sid = "test-section-scroll-to-turn";
    setStoreMessages(sid, makeSectionedMessages(4, 2));
    setStoreScrollToTurn(sid, "u1");

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);

    expect(await screen.findByText("Section 1 marker")).toBeTruthy();
    expect(screen.queryByText("Section 4 marker")).toBeNull();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);
    expect(mockKeepTurnExpanded).toHaveBeenCalledWith(sid, "u1");
    expect(mockClearScrollToTurn).toHaveBeenCalledWith(sid);
  });

  it("remounts the correct section window before scrolling to an older message", async () => {
    const sid = "test-section-scroll-to-message";
    setStoreMessages(sid, makeSectionedMessages(4, 2));
    setStoreScrollToMessage(sid, "u1");

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);

    expect(await screen.findByText("Section 1 marker")).toBeTruthy();
    expect(screen.queryByText("Section 4 marker")).toBeNull();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);
    expect(mockFocusTurn).toHaveBeenCalledWith(sid, "u1");
    expect(mockClearScrollToMessage).toHaveBeenCalledWith(sid);
  });

  // q-274: notifications anchored to tool-use-only assistant messages (like
  // codex-tool_use-call_NTK7...) get grouped into tool_msg_group entries by
  // the feed model, so the scroll search must also check tool_msg_group.firstId.
  // The DOM scroll step must also find the element via data-feed-block-id
  // (tool groups don't have data-message-id).
  it("scrolls to the correct turn when notification targets a tool-use-only assistant message", async () => {
    const sid = "test-scroll-tool-use-only";
    const toolUseMessageId = "codex-tool_use-call_NTK7xAS0zqfp1eNdSC9vV7yL";
    // Build a realistic turn: user message, then a tool-use-only assistant
    // message (no text, only tool_use content blocks). The feed model groups
    // this into a tool_msg_group entry with firstId = the assistant message id.
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Run the quest transition", timestamp: 1000 }),
      makeMessage({
        id: toolUseMessageId,
        role: "assistant",
        content: "", // no text -- tool-use only
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "quest done q-261" } }],
        timestamp: 1001,
      }),
    ]);
    // Target the tool-use-only assistant message (simulates a notification
    // created by `takode notify review` when the last assistant message was
    // a tool invocation with no text content)
    setStoreScrollToMessage(sid, toolUseMessageId);

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={50} />);

    // The turn lookup should resolve the tool_msg_group entry and focus the turn
    expect(mockClearScrollToMessage).toHaveBeenCalledWith(sid);
    expect(mockFocusTurn).toHaveBeenCalledWith(sid, "u1");

    // The DOM should contain the tool group element with data-feed-block-id
    // (tool_msg_group entries render with data-feed-block-id, not data-message-id).
    // This is what the scroll step querySelector falls back to.
    const toolGroupElement = container.querySelector(`[data-feed-block-id="tool-group:${toolUseMessageId}"]`);
    expect(toolGroupElement).not.toBeNull();
    // And confirm there's no data-message-id for this ID (would indicate it
    // wasn't actually grouped into tool_msg_group)
    const messageElement = container.querySelector(`[data-message-id="${toolUseMessageId}"]`);
    expect(messageElement).toBeNull();
  });

  // Generic fallback: when messageId genuinely doesn't exist in any turn entry
  // (e.g. compacted away), fall back to the last turn rather than doing nothing.
  it("falls back to last turn when scroll-to-message target is completely absent", async () => {
    const sid = "test-scroll-to-message-fallback";
    setStoreMessages(sid, makeSectionedMessages(2, 2));
    setStoreScrollToMessage(sid, "completely-nonexistent-id");

    render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);

    expect(mockClearScrollToMessage).toHaveBeenCalledWith(sid);
    // Falls back to the last turn (u4 in a 2-section × 2-turn grid)
    expect(mockFocusTurn).toHaveBeenCalledWith(sid, "u4");
  });

  it("restores a saved older-section anchor instead of falling back to latest", async () => {
    const sid = "test-section-anchor-restore";
    setStoreMessages(sid, makeSectionedMessages(4, 2));
    setStoreFeedScrollPosition(sid, {
      scrollTop: 240,
      scrollHeight: 1600,
      isAtBottom: false,
      anchorTurnId: "u1",
      anchorOffsetTop: 0,
    });

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);

    expect(await screen.findByText("Section 1 marker")).toBeTruthy();
    expect(screen.queryByText("Section 4 marker")).toBeNull();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);
  });

  it("shows the latest pill when restore lands on an older section with newer sections below", async () => {
    const sid = "test-section-latest-pill-on-restore";
    setStoreMessages(sid, makeSectionedMessages(4, 2));
    setStoreFeedScrollPosition(sid, {
      scrollTop: 240,
      scrollHeight: 1600,
      isAtBottom: false,
      anchorTurnId: "u1",
      anchorOffsetTop: 0,
      lastSeenContentBottom: 1180,
    });

    render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);

    expect(await screen.findByText("Section 1 marker")).toBeTruthy();
    expect(screen.getByLabelText("Jump to latest")).toBeTruthy();
    expect(screen.getByText("Latest section below")).toBeTruthy();
  });
});
