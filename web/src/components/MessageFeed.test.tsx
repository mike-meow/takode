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
import type { ChatMessage } from "../types.js";
import type { FeedEntry, Turn } from "../hooks/use-feed-model.js";

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

describe("findActiveTaskTurnIdForScroll", () => {
  it("returns the last turn whose top is above the reference line", () => {
    const offsets = [
      { turnId: "t1", offsetTop: 0 },
      { turnId: "t2", offsetTop: 120 },
      { turnId: "t3", offsetTop: 280 },
    ];

    expect(findActiveTaskTurnIdForScroll(offsets, 0, "t1")).toBe("t1");
    expect(findActiveTaskTurnIdForScroll(offsets, 100, "t1")).toBe("t2");
    expect(findActiveTaskTurnIdForScroll(offsets, 260, "t1")).toBe("t3");
  });

  it("falls back to the first task turn when the viewport is above all tracked turns", () => {
    const offsets = [
      { turnId: "t2", offsetTop: 120 },
      { turnId: "t3", offsetTop: 280 },
    ];

    expect(findActiveTaskTurnIdForScroll(offsets, 0, "t2", 0)).toBe("t2");
  });
});

describe("MessageFeed section windowing", () => {
  it("chunks turns into fixed-size 50-turn sections", () => {
    const sections = buildFeedSections(makeSectionTurns(120));

    expect(sections).toHaveLength(3);
    expect(sections.map((section) => section.turns.length)).toEqual([50, 50, 20]);
    expect(findVisibleSectionStartIndex(sections, 3)).toBe(0);
    expect(findVisibleSectionEndIndex(sections, 0, 3)).toBe(3);
    expect(findVisibleSectionStartIndex(sections, 2)).toBe(1);
    expect(findVisibleSectionEndIndex(sections, 1, 2)).toBe(3);
  });

  it("clamps target window selection for section-aware jumps", () => {
    const sections = buildFeedSections(makeSectionTurns(200), 50);

    expect(findSectionWindowStartIndexForTarget(sections, 0, 3)).toBe(0);
    expect(findSectionWindowStartIndexForTarget(sections, 1, 3)).toBe(0);
    expect(findSectionWindowStartIndexForTarget(sections, 2, 3)).toBe(1);
    expect(findSectionWindowStartIndexForTarget(sections, 3, 3)).toBe(1);
  });

  it("slides a bounded three-section window when the user loads older and then loads newer", () => {
    const sid = "test-section-window";
    setStoreMessages(sid, makeSectionedMessages(4, 2));
    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);

    expect(screen.queryByText("Section 1 marker")).toBeNull();
    expect(screen.getByText("Section 2 marker")).toBeTruthy();
    expect(screen.getByText("Section 4 marker")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load older section" })).toBeTruthy();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Load older section" }));

    expect(screen.getByText("Section 1 marker")).toBeTruthy();
    expect(screen.queryByText("Section 4 marker")).toBeNull();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Load newer section" }));

    expect(screen.queryByText("Section 1 marker")).toBeNull();
    expect(screen.getByText("Section 2 marker")).toBeTruthy();
    expect(screen.getByText("Section 4 marker")).toBeTruthy();
    expect(container.querySelectorAll("[data-feed-section-id]")).toHaveLength(3);
  });

  it("shows the newer-section control after loading older history", () => {
    const sid = "test-section-newer-control";
    setStoreMessages(sid, makeSectionedMessages(4, 2));

    const { container } = render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Load older section" }));

    expect(screen.getByRole("button", { name: "Load newer section" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load newer section" }));
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

    render(<MessageFeed sessionId={sid} sectionTurnCount={2} />);

    fireEvent.click(screen.getByRole("button", { name: "Load older section" }));

    expect(mockSendToSession).toHaveBeenCalledWith(sid, {
      type: "history_window_request",
      from_turn: 0,
      turn_count: 6,
      section_turn_count: 2,
      visible_section_count: 3,
    });
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
    expect(screen.getByText("New content below")).toBeTruthy();
  });
});

// ─── Pure functions tested through component output ──────────────────────────
// Since formatElapsed, formatTokens, getToolOnlyName, extractToolItems,
// groupToolMessages, groupMessages are not exported, we test them through the
// component's rendered output.

// ─── formatElapsed (tested via generation stats bar) ─────────────────────────

describe("ElapsedTimer - formatElapsed via stats bar", () => {
  it("formats seconds only (e.g. '5s') for short durations", () => {
    const sid = "test-elapsed-secs";
    setStoreStatus(sid, "running");
    // Set startedAt to 5 seconds ago
    setStoreStreamingStartedAt(sid, Date.now() - 5000);

    render(<ElapsedTimer sessionId={sid} />);

    // Should show "5s" (or close) in the stats bar
    expect(screen.getByText(/^\d+s$/)).toBeTruthy();
  });

  it("formats minutes and seconds (e.g. '2m 30s') for longer durations", () => {
    const sid = "test-elapsed-mins";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 150_000); // 2m 30s ago

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText(/^\d+m \d+s$/)).toBeTruthy();
  });
});

// ─── formatTokens (tested via generation stats bar) ──────────────────────────

describe("ElapsedTimer - formatTokens via stats bar", () => {
  it("formats token count with 'k' suffix for values >= 1000", () => {
    const sid = "test-tokens-k";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 3000);
    setStoreStreamingOutputTokens(sid, 1500);

    render(<ElapsedTimer sessionId={sid} />);

    // Should display token count formatted as "1.5k"
    expect(screen.getByText(/1\.5k/)).toBeTruthy();
  });

  it("formats token count as plain number for values < 1000", () => {
    const sid = "test-tokens-plain";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 3000);
    setStoreStreamingOutputTokens(sid, 500);

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText(/500/)).toBeTruthy();
  });
});

// ─── Empty state ─────────────────────────────────────────────────────────────

describe("MessageFeed - empty state", () => {
  it("shows empty state when no messages and no streaming", () => {
    const sid = "test-empty";
    setStoreMessages(sid, []);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Start a conversation")).toBeTruthy();
    expect(screen.getByText(/Send a message to begin/)).toBeTruthy();
  });

  it("does not show empty state when there are messages", () => {
    const sid = "test-not-empty";
    setStoreMessages(sid, [makeMessage({ role: "user", content: "Hello" })]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Start a conversation")).toBeNull();
  });

  it("shows pending Codex inputs instead of the empty state", () => {
    const sid = "test-pending-codex";
    setStoreMessages(sid, []);
    setStoreSessionBackend(sid, "codex");
    setStorePendingCodexInputs(sid, [
      {
        id: "pending-1",
        content: "Steer the active turn toward auth fixes",
        timestamp: Date.now(),
        cancelable: true,
        draftImages: [],
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.getByText("Pending delivery")).toBeTruthy();
    expect(screen.getByText(/Steer the active turn toward auth fixes/)).toBeTruthy();
  });

  it("shows an uploading-image stage instead of the empty state for Codex image sends", () => {
    const sid = "test-uploading-image-stage";
    setStoreMessages(sid, []);
    setStoreSessionState(sid, { backend_type: "codex", codex_image_send_stage: "uploading" });
    setStoreStatus(sid, "running");

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.queryByText("Pending delivery")).toBeNull();
    expect(screen.getByText("uploading image")).toBeTruthy();
    expect(screen.queryByText("Sending the attached image to the server.")).toBeNull();
  });

  it("renders pending local upload messages with immediate local image previews", () => {
    const sid = "test-pending-local-upload";
    setStoreMessages(sid, []);
    setStorePendingUserUploads(sid, [
      {
        id: "pending-upload-1",
        content: "Inspect this screenshot",
        timestamp: Date.now(),
        stage: "uploading",
        images: [{ name: "attachment-1.png", base64: "ZmFrZQ==", mediaType: "image/png" }],
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.getByText("Pending upload")).toBeTruthy();
    expect(screen.getByText("Uploading image…")).toBeTruthy();
    const image = screen.getByAltText("attachment-1.png") as HTMLImageElement;
    expect(image.src).toContain("data:image/png;base64,ZmFrZQ==");
  });

  it("shows backend-processing stage for pending Codex image delivery", () => {
    const sid = "test-processing-image-stage";
    setStoreMessages(sid, []);
    setStoreSessionState(sid, { backend_type: "codex", codex_image_send_stage: "processing" });
    setStoreStatus(sid, "running");
    setStorePendingCodexInputs(sid, [
      {
        id: "pending-img-1",
        content: "Inspect the attached screenshot",
        timestamp: Date.now(),
        cancelable: true,
        draftImages: [{ name: "attachment-1.png", base64: "x", mediaType: "image/png" }],
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Pending delivery")).toBeTruthy();
    expect(screen.getByText("processing image")).toBeTruthy();
    expect(screen.queryByText("Preparing the image-backed turn for Codex.")).toBeNull();
  });
});

// ─── Message rendering ───────────────────────────────────────────────────────

describe("MessageFeed - message rendering", () => {
  it("renders user and assistant messages", () => {
    const sid = "test-render-msgs";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "What is 2+2?" }),
      makeMessage({ id: "a1", role: "assistant", content: "The answer is 4." }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("What is 2+2?")).toBeTruthy();
    // The assistant message goes through the mocked Markdown component
    expect(screen.getByText("The answer is 4.")).toBeTruthy();
  });

  it("renders system messages in the feed", () => {
    const sid = "test-system-msg";
    setStoreMessages(sid, [
      makeMessage({ id: "s1", role: "system", content: "Session restored" }),
      makeMessage({ id: "u1", role: "user", content: "Continue" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Session restored")).toBeTruthy();
    expect(screen.getByText("Continue")).toBeTruthy();
  });

  it("shows model-responding stage while Codex is streaming an image-backed request", () => {
    const sid = "test-responding-image-stage";
    setStoreSessionState(sid, { backend_type: "codex", codex_image_send_stage: "responding" });
    setStoreStatus(sid, "running");
    setStoreStreaming(sid, "Inspecting the uploaded image");
    setStoreStreamingStartedAt(sid, Date.now() - 4_000);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.queryByText("Model responding")).toBeNull();
  });

  it("shows only a date marker for same-day messages, no minute marks", () => {
    // Same-day minute marks were removed (q-249) -- only date-change markers remain.
    // The first message in a session always gets a date marker.
    const sid = "test-smart-timestamps-same-minute";
    const base = new Date("2026-02-25T10:00:00.000Z").getTime();
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First", timestamp: base + 5_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "Second", timestamp: base + 25_000 }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Only the initial date marker, no per-minute markers
    expect(screen.getAllByTestId("minute-boundary-timestamp")).toHaveLength(1);
  });

  it("does not add extra markers when minute changes on same day", () => {
    // Same-day minute marks were removed (q-249) -- minute changes don't add markers.
    // Only the initial date marker appears.
    const sid = "test-smart-timestamps-minute-boundary";
    const base = new Date("2026-02-25T10:00:00.000Z").getTime();
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "M0", timestamp: base + 5_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "M0 response", timestamp: base + 25_000 }),
      makeMessage({ id: "u2", role: "user", content: "M1", timestamp: base + 65_000 }),
      makeMessage({ id: "a2", role: "assistant", content: "M1 response", timestamp: base + 85_000 }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Only 1 marker (the initial date), not 2 (would have been 2 with minute marks)
    expect(screen.getAllByTestId("minute-boundary-timestamp")).toHaveLength(1);
  });

  it("shows a date marker when messages cross a day boundary", () => {
    const sid = "test-cross-day-boundary";
    // Use dates far apart to avoid timezone edge cases
    const day1 = new Date("2026-02-25T12:00:00.000Z").getTime();
    const day2 = new Date("2026-02-26T12:00:00.000Z").getTime();
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Day one", timestamp: day1 }),
      makeMessage({ id: "a1", role: "assistant", content: "Day two", timestamp: day2 }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // 2 date markers: one for Feb 25, one for Feb 26
    expect(screen.getAllByTestId("minute-boundary-timestamp")).toHaveLength(2);
  });
});

// ─── Scroll behavior ────────────────────────────────────────────────────────

describe("MessageFeed - scroll behavior", () => {
  it("restores a saved non-bottom position proportionally", () => {
    const sid = "test-restore-scroll-position";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);
    setStoreFeedScrollPosition(sid, {
      scrollTop: 300,
      scrollHeight: 1200,
      isAtBottom: false,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1800 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    try {
      render(<MessageFeed sessionId={sid} />);
      expect(scrollTopValue).toBe(450);
      expect(screen.getByLabelText("Go to bottom")).toBeTruthy();
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      }
      if (originalScrollTop) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      } else {
        delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      }
    }
  });

  it("restores to the real bottom when the saved state was at bottom", () => {
    const sid = "test-restore-bottom";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);
    setStoreFeedScrollPosition(sid, {
      scrollTop: 0,
      scrollHeight: 1200,
      isAtBottom: true,
    });

    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    let scrollTopValue = 0;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 1600 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollTopValue : 0;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    try {
      mockScrollTo.mockClear();
      render(<MessageFeed sessionId={sid} />);
      expect(mockScrollTo).toHaveBeenCalledWith({ top: 1588, behavior: "auto" });
      expect(scrollTopValue).toBe(0);
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      }
      if (originalScrollTop) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      } else {
        delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      }
    }
  });

  it("keeps immediate bottom-follow when the user is near bottom and a non-streaming message arrives", async () => {
    const sid = "test-bottom-follow-non-streaming";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Question" })]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1600;
    let scrollTopValue = 980;
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });

    fireEvent.scroll(scrollContainer);
    mockScrollTo.mockClear();

    scrollHeightValue = 1760;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(scrollTopValue).toBe(1160);
    expect(mockScrollTo).not.toHaveBeenCalled();
  });

  it("aligns to the real content bottom instead of the extra end slack while running", async () => {
    const sid = "test-real-bottom-ignores-slack";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Question" })]);
    setStoreStatus(sid, "running");

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 2200;
    let scrollTopValue = 1040;
    const offsetTopByBlockId: Record<string, number> = {
      "turn:u1": 1600,
      "message:u1": 1600,
    };
    const offsetHeightByBlockId: Record<string, number> = {
      "turn:u1": 40,
      "message:u1": 40,
    };
    const originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });

    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        const blockId = (this as HTMLElement).dataset?.feedBlockId ?? "";
        return offsetTopByBlockId[blockId] ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        const blockId = (this as HTMLElement).dataset?.feedBlockId ?? "";
        return offsetHeightByBlockId[blockId] ?? 0;
      },
    });

    try {
      fireEvent.scroll(scrollContainer);

      scrollHeightValue = 2320;
      offsetTopByBlockId["turn:u2"] = 1720;
      offsetTopByBlockId["message:u2"] = 1720;
      offsetHeightByBlockId["turn:u2"] = 40;
      offsetHeightByBlockId["message:u2"] = 40;
      setStoreMessages(sid, [
        makeMessage({ id: "u1", role: "user", content: "Question" }),
        makeMessage({ id: "u2", role: "user", content: "Follow-up" }),
      ]);
      rerender(<MessageFeed sessionId={sid} />);

      await flushFeedObservers();

      expect(scrollTopValue).toBe(1160);
    } finally {
      if (originalOffsetTop) {
        Object.defineProperty(HTMLElement.prototype, "offsetTop", originalOffsetTop);
      } else {
        delete (HTMLElement.prototype as { offsetTop?: unknown }).offsetTop;
      }
      if (originalOffsetHeight) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
      } else {
        delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
      }
    }
  });

  it("uses immediate bottom alignment while streaming when the user is near bottom", async () => {
    const sid = "test-bottom-follow-streaming";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Question" })]);
    setStoreStreaming(sid, "Thinking...");

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1600;
    let scrollTopValue = 980;
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    fireEvent.scroll(scrollContainer);
    mockScrollTo.mockClear();

    scrollHeightValue = 1760;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Partial answer" }),
    ]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(scrollTopValue).toBe(1160);
    expect(mockScrollTo).not.toHaveBeenCalled();
  });

  it("keeps following when an existing assistant message grows without changing message count", async () => {
    const sid = "test-same-message-growth";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Short answer" }),
    ]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1600;
    let scrollTopValue = 980;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    fireEvent.scroll(scrollContainer);

    scrollHeightValue = 1760;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "A much longer answer that keeps growing in place." }),
    ]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(scrollTopValue).toBe(1160);
  });

  it("keeps grouped tool containers visible when in-place tool results expand them", async () => {
    // Use Bash tools (which still group) to test scroll behavior during result expansion
    const sid = "test-grouped-tool-growth";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo a" } }],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-2", name: "Bash", input: { command: "echo b" } }],
      }),
    ]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1600;
    let scrollTopValue = 980;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    fireEvent.scroll(scrollContainer);
    fireEvent.click(screen.getByText("echo b"));

    scrollHeightValue = 1760;
    setStoreToolResults(sid, {
      "tu-2": {
        content: "Expanded grouped tool result",
        is_truncated: false,
      },
    });
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(scrollTopValue).toBe(1160);
  });

  it("follows footer tool progress updates even when the message list is unchanged", async () => {
    const sid = "test-tool-progress-growth";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Question" })]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1000;
    let scrollTopValue = 380;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    fireEvent.scroll(scrollContainer);

    scrollHeightValue = 1120;
    setStoreToolProgress(sid, [{ toolUseId: "tu-1", toolName: "Bash", elapsedSeconds: 12 }]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(scrollTopValue).toBe(520);
  });

  it("does not jump upward to an older subagent when newer bottom streaming content is still active", async () => {
    const sid = "test-subagent-does-not-yank-follow-upward";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-follow-floor",
            name: "Task",
            input: { description: "Inspect event routing", subagent_type: "Explore" },
          },
        ],
      }),
    ]);
    setStoreStatus(sid, "running");
    setStoreStreaming(sid, "Latest bottom output");
    setStoreParentStreaming(sid, { "task-follow-floor": "Older subagent output" });

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    fireEvent.click(screen.getByText("Inspect event routing"));
    fireEvent.click(screen.getByText("Activities"));

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1760;
    let scrollTopValue = 1160;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    const subagentBlock = container.querySelector('[data-feed-block-id="subagent:task-follow-floor"]') as HTMLElement;
    const footerBlock = container.querySelector('[data-feed-block-id="footer:streaming"]') as HTMLElement;
    setElementOffsetMetrics(subagentBlock, 900, 400);
    setElementOffsetMetrics(footerBlock, 1600, 160);

    fireEvent.scroll(scrollContainer);

    setStoreParentStreaming(sid, { "task-follow-floor": "Older subagent output that keeps growing" });
    rerender(<MessageFeed sessionId={sid} />);

    const rerenderedSubagentBlock = container.querySelector(
      '[data-feed-block-id="subagent:task-follow-floor"]',
    ) as HTMLElement;
    const rerenderedFooterBlock = container.querySelector('[data-feed-block-id="footer:streaming"]') as HTMLElement;
    setElementOffsetMetrics(rerenderedSubagentBlock, 900, 400);
    setElementOffsetMetrics(rerenderedFooterBlock, 1600, 160);

    await flushFeedObservers();

    expect(scrollTopValue).toBe(1160);
  });

  it("does not auto-scroll when the user is reading away from the bottom", async () => {
    const sid = "test-no-autofollow-when-scrolled-up";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1600,
    });
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      writable: true,
      value: 100,
    });

    fireEvent.scroll(scrollContainer);
    mockScrollTo.mockClear();

    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
      makeMessage({ id: "u2", role: "user", content: "Follow-up" }),
    ]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(mockScrollTo).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Go to bottom")).toBeTruthy();
  });

  it("stops following immediately when the user scrolls upward, even before leaving the bottom threshold", async () => {
    const sid = "test-upward-scroll-disables-follow";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Short answer" }),
    ]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1600;
    let scrollTopValue = 980;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    fireEvent.scroll(scrollContainer);

    scrollTopValue = 940;
    fireEvent.scroll(scrollContainer);

    scrollHeightValue = 1760;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "A much longer answer that grows in place." }),
    ]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(scrollTopValue).toBe(940);
    expect(screen.getByLabelText("Go to bottom")).toBeTruthy();
  });

  it("re-enables follow after the user deliberately returns to the bottom", async () => {
    const sid = "test-return-to-bottom-reenables-follow";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Short answer" }),
    ]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1600;
    let scrollTopValue = 980;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    fireEvent.scroll(scrollContainer);

    scrollTopValue = 940;
    fireEvent.scroll(scrollContainer);

    scrollHeightValue = 1760;
    scrollTopValue = 1160;
    fireEvent.scroll(scrollContainer);

    scrollHeightValue = 1920;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "An even longer answer after returning to bottom." }),
    ]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(scrollTopValue).toBe(1320);
  });

  it("bottom-aligns the next locally sent user message instead of snapping to spacer slack", async () => {
    const sid = "test-bottom-align-next-user-message";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1800;
    let scrollTopValue = 1000;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const makeRect = (top: number, height: number): DOMRect => ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 400,
      bottom: top + height,
      width: 400,
      height,
      toJSON: () => ({}),
    });

    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this === scrollContainer || this.classList.contains("overflow-y-auto")) {
        return makeRect(0, 600);
      }
      const messageId = (this as HTMLElement).dataset.messageId;
      if (messageId === "u2") {
        return makeRect(1500 - scrollTopValue, 40);
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      fireEvent.scroll(scrollContainer);
      setStoreBottomAlignNextUserMessage(sid);
      setStoreMessages(sid, [
        makeMessage({ id: "u1", role: "user", content: "Question" }),
        makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
        makeMessage({ id: "u2", role: "user", content: "Follow-up" }),
      ]);
      rerender(<MessageFeed sessionId={sid} />);
      await flushFeedObservers();

      expect(scrollTopValue).toBe(940);
      expect(mockClearBottomAlignOnNextUserMessage).toHaveBeenCalledWith(sid);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it("keeps the real bottom visible when an older turn collapses near bottom", () => {
    const sid = "test-collapse-near-bottom-follow";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First request" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-collapse", name: "Read", input: { file_path: "/tmp/a.ts" } }],
      }),
      makeMessage({ id: "a2", role: "assistant", content: "First result" }),
      makeMessage({ id: "u2", role: "user", content: "Follow-up" }),
      makeMessage({ id: "a3", role: "assistant", content: "Follow-up result" }),
    ]);
    setStoreTurnOverrides(sid, [["u1", true]]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollTopValue = 1400;
    let scrollHeightValue = 1600;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 180,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    fireEvent.scroll(scrollContainer);
    expect(screen.getByText("Read File")).toBeTruthy();

    scrollHeightValue = 1320;
    setStoreTurnOverrides(sid, []);
    rerender(<MessageFeed sessionId={sid} />);

    expect(scrollTopValue).toBe(1128);
    expect(screen.queryByText("Read File")).toBeNull();
  });

  it("preserves the current viewport anchor when an older turn collapses away from bottom", () => {
    const sid = "test-collapse-anchor-restore";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First request" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-anchor", name: "Read", input: { file_path: "/tmp/a.ts" } }],
      }),
      makeMessage({ id: "a2", role: "assistant", content: "First result" }),
      makeMessage({ id: "u2", role: "user", content: "Second request" }),
      makeMessage({ id: "a3", role: "assistant", content: "Second result" }),
    ]);
    setStoreTurnOverrides(sid, [["u1", true]]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollTopValue = 120;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const makeRect = (top: number, height: number): DOMRect =>
      ({
        x: 0,
        y: top,
        top,
        bottom: top + height,
        left: 0,
        right: 320,
        width: 320,
        height,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRectMock() {
      const element = this as HTMLElement;
      if (element === scrollContainer || element.classList.contains("overflow-y-auto")) {
        return makeRect(0, 400);
      }

      const firstTurnExpanded = document.body.textContent?.includes("Read File") === true;
      const baseTopByMessageId: Record<string, number> = {
        u1: 0,
        a2: firstTurnExpanded ? 220 : 100,
        u2: firstTurnExpanded ? 260 : 140,
        a3: firstTurnExpanded ? 320 : 200,
      };
      const baseTopByTurnId: Record<string, { top: number; height: number }> = {
        u1: { top: 0, height: firstTurnExpanded ? 260 : 140 },
        u2: { top: firstTurnExpanded ? 260 : 140, height: 120 },
      };

      const messageId = element.dataset.messageId;
      if (messageId && baseTopByMessageId[messageId] !== undefined) {
        return makeRect(baseTopByMessageId[messageId] - scrollTopValue, 40);
      }

      const turnId = element.dataset.turnId;
      if (turnId && baseTopByTurnId[turnId] !== undefined) {
        const turn = baseTopByTurnId[turnId];
        return makeRect(turn.top - scrollTopValue, turn.height);
      }

      return makeRect(-1000, 0);
    };

    try {
      fireEvent.scroll(scrollContainer);
      expect(scrollTopValue).toBe(120);

      setStoreTurnOverrides(sid, []);
      rerender(<MessageFeed sessionId={sid} />);

      expect(scrollTopValue).toBe(0);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it("does not render a runway or latest pill by default", () => {
    const sid = "test-no-runway-or-latest-pill";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("feed-bottom-runway")).toBeNull();
    expect(screen.queryByText("New content below")).toBeNull();
  });

  it("shows the latest pill only after new content arrives below the current viewport", async () => {
    const sid = "test-latest-pill-after-new-content";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1600;
    let scrollTopValue = 100;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    fireEvent.scroll(scrollContainer);
    expect(screen.queryByLabelText("Jump to latest")).toBeNull();

    scrollHeightValue = 1760;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
      makeMessage({ id: "a2", role: "assistant", content: "Fresh content below" }),
    ]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(screen.getByLabelText("Jump to latest")).toBeTruthy();
    expect(screen.getByText("New content below")).toBeTruthy();
  });

  it("does not resurrect the latest pill on session restore until new content arrives afterward", async () => {
    const sid = "test-latest-pill-no-resurrect-on-restore";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
      makeMessage({ id: "a2", role: "assistant", content: "Previously unseen content" }),
    ]);
    setStoreFeedScrollPosition(sid, {
      scrollTop: 100,
      scrollHeight: 1760,
      isAtBottom: false,
      lastSeenContentBottom: 1400,
    });

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1760;
    let scrollTopValue = 100;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    await flushFeedObservers();
    expect(screen.queryByLabelText("Jump to latest")).toBeNull();

    scrollHeightValue = 1920;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
      makeMessage({ id: "a2", role: "assistant", content: "Previously unseen content" }),
      makeMessage({ id: "a3", role: "assistant", content: "Fresh content after restore" }),
    ]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    expect(screen.getByLabelText("Jump to latest")).toBeTruthy();
  });

  it("uses the latest pill to jump to the real content bottom", async () => {
    const sid = "test-latest-pill-click";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);

    const { container, rerender } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollHeightValue = 1600;
    let scrollTopValue = 100;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeightValue;
      },
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValue;
      },
      set(value) {
        scrollTopValue = value as number;
      },
    });

    fireEvent.scroll(scrollContainer);
    scrollHeightValue = 1760;
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
      makeMessage({ id: "a2", role: "assistant", content: "Fresh content below" }),
    ]);
    rerender(<MessageFeed sessionId={sid} />);
    await flushFeedObservers();

    mockScrollTo.mockClear();
    fireEvent.click(screen.getByLabelText("Jump to latest"));

    expect(mockScrollTo).toHaveBeenCalledWith({ top: 1148, behavior: "smooth" });
  });

  it("keeps the Go to bottom button aligned to the real feed bottom", () => {
    const sid = "test-go-to-bottom-real-content";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);

    const { container } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;

    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(scrollContainer, "scrollHeight", {
      configurable: true,
      value: 1600,
    });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });

    fireEvent.scroll(scrollContainer);
    mockScrollTo.mockClear();

    fireEvent.click(screen.getByLabelText("Go to bottom"));

    expect(mockScrollTo).toHaveBeenCalledWith({ top: 988, behavior: "smooth" });
  });

  it("renders streaming text with cursor animation", () => {
    const sid = "test-streaming";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Hello" })]);
    setStoreStreaming(sid, "I am currently thinking about");

    const { container } = render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("I am currently thinking about")).toBeTruthy();
    // Check for the blinking cursor element (animate class with pulse-dot)
    const cursor = container.querySelector('[class*="animate-"]');
    expect(cursor).toBeTruthy();
  });

  it("uses markdown rendering for codex streaming text", () => {
    const sid = "test-streaming-codex";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Hello" })]);
    setStoreStreaming(sid, "Codex is streaming\nStill hidden");
    setStoreSessionBackend(sid, "codex");

    const { container } = render(<MessageFeed sessionId={sid} />);

    // The user message also renders via MarkdownContent now, so multiple
    // [data-testid="markdown"] elements exist. The streaming bubble is the last one.
    const markdownEls = screen.getAllByTestId("markdown");
    expect(markdownEls[markdownEls.length - 1].textContent).toContain("Codex is streaming");
    expect(screen.queryByText("Still hidden")).toBeNull();
    expect(container.querySelector("pre.font-mono-code")).toBeNull();
  });

  it("renders live codex thinking when no assistant text is streaming yet", () => {
    const sid = "test-streaming-codex-thinking";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Hello" })]);
    setStoreSessionBackend(sid, "codex");
    setStoreThinking(sid, "Checking session restore flow");

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Checking session restore flow")).toBeTruthy();
  });

  it("withholds partial codex lines until a newline commits them", () => {
    const sid = "test-streaming-codex-partial";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Hello" })]);
    setStoreStreaming(sid, "Uncommitted partial");
    setStoreSessionBackend(sid, "codex");

    const { unmount } = render(<MessageFeed sessionId={sid} />);

    // The user message also renders via MarkdownContent, so get the last
    // markdown element (the streaming bubble).
    const els1 = screen.getAllByTestId("markdown");
    expect(els1[els1.length - 1].textContent).toBe("");
    expect(screen.queryByText("Uncommitted partial")).toBeNull();

    unmount();
    setStoreStreaming(sid, "Uncommitted partial\n");
    render(<MessageFeed sessionId={sid} />);

    const els2 = screen.getAllByTestId("markdown");
    expect(els2[els2.length - 1].textContent).toContain("Uncommitted partial");
  });

  it("keeps serif streaming typography for claude sessions", () => {
    const sid = "test-streaming-claude";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Hello" })]);
    setStoreStreaming(sid, "Claude is streaming");
    setStoreSessionBackend(sid, "claude");

    render(<MessageFeed sessionId={sid} />);

    const text = screen.getByText("Claude is streaming");
    const pre = text.closest("pre");
    expect(pre).toBeTruthy();
    expect(pre?.className).toContain("font-serif-assistant");
    expect(pre?.className).not.toContain("font-mono-code");
  });

  it("does not render streaming indicator when no streaming text", () => {
    const sid = "test-no-stream";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Hello" })]);

    const { container } = render(<MessageFeed sessionId={sid} />);

    // No pre element with streaming content
    const preElements = container.querySelectorAll("pre.font-serif-assistant");
    expect(preElements.length).toBe(0);
  });

  it("shows an explicit loading conversation state instead of the empty state during cold history hydration", () => {
    const sid = "test-loading-conversation";
    setStoreMessages(sid, []);
    setStoreHistoryLoading(sid, true);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Loading conversation...")).toBeTruthy();
    expect(screen.queryByText("Start a conversation")).toBeNull();
  });

  it("does not trigger a smooth bottom-follow when initial history lands after showing the loading conversation state", () => {
    const sid = "test-loading-history-no-smooth-jump";
    setStoreMessages(sid, []);
    setStoreHistoryLoading(sid, true);

    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    let scrollHeightValue = 1600;

    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 600 : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollHeightValue : 0;
      },
    });

    try {
      const { rerender } = render(<MessageFeed sessionId={sid} />);
      expect(screen.getByText("Loading conversation...")).toBeTruthy();

      mockScrollTo.mockClear();
      setStoreHistoryLoading(sid, false);
      setStoreMessages(sid, [
        makeMessage({ id: "u1", role: "user", content: "Question" }),
        makeMessage({ id: "a1", role: "assistant", content: "Loaded answer" }),
      ]);
      scrollHeightValue = 1800;
      rerender(<MessageFeed sessionId={sid} />);

      expect(screen.queryByText("Loading conversation...")).toBeNull();
      expect(screen.getByText("Loaded answer")).toBeTruthy();
      expect(mockScrollTo).not.toHaveBeenCalledWith({ top: 1800, behavior: "smooth" });
    } finally {
      if (originalClientHeight) {
        Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      } else {
        delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
      }
      if (originalScrollHeight) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      }
    }
  });
});

// ─── Generation stats bar ────────────────────────────────────────────────────

describe("ElapsedTimer - generation stats bar", () => {
  it("renders stats bar when session is running", () => {
    const sid = "test-stats";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 10_000);

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
  });

  it("does not render stats bar when session is idle", () => {
    const sid = "test-idle";
    setStoreStatus(sid, "idle");

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.queryByText("Purring...")).toBeNull();
  });

  it("shows output tokens in stats bar when available", () => {
    const sid = "test-tokens-stats";
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 5000);
    setStoreStreamingOutputTokens(sid, 2500);

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    // Should show "2.5k" token count
    expect(screen.getByText(/2\.5k/)).toBeTruthy();
  });

  it("uses image-send labels during the pre-stream Codex wait", () => {
    const sid = "test-prestream-image-label";
    setStoreStatus(sid, "running");
    setStoreSessionState(sid, { backend_type: "codex", codex_image_send_stage: "uploading" });

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText("uploading image")).toBeTruthy();
    expect(screen.queryByText("Purring...")).toBeNull();
  });

  it("reverts to the normal purring label once Codex streaming starts", () => {
    const sid = "test-prestream-image-label-clears";
    setStoreStatus(sid, "running");
    setStoreSessionState(sid, { backend_type: "codex", codex_image_send_stage: "processing" });
    setStoreStreamingStartedAt(sid, Date.now() - 5_000);

    render(<ElapsedTimer sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.queryByText("processing image")).toBeNull();
  });
});

describe("MessageFeed - floating status pill", () => {
  it("renders the compact lower-left running indicator inside the feed", () => {
    const sid = "test-feed-status-pill";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Still working" })]);
    setStoreStatus(sid, "running");
    setStoreStreamingStartedAt(sid, Date.now() - 10_000);
    setStoreStreamingOutputTokens(sid, 2500);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Purring...")).toBeTruthy();
    expect(screen.getByText("10s")).toBeTruthy();
    expect(screen.getByText(/2\.5k/)).toBeTruthy();
  });

  it("lifts the mobile nav buttons above the floating notification chip stack", () => {
    const sid = "test-feed-mobile-nav-clearance";
    mediaState.touchDevice = true;
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "Scroll target" })]);
    setStoreFeedScrollPosition(sid, {
      scrollTop: 120,
      scrollHeight: 600,
      isAtBottom: false,
    });
    setStoreNotifications(sid, [
      {
        id: "notif-1",
        category: "review",
        summary: "Quest q-464 ready for verification",
        timestamp: Date.now(),
        messageId: "msg-anchor",
        done: false,
      },
    ]);

    // q-464: the mobile nav stack should reserve clearance above the measured
    // lower-right floating-status chips. Stub that stack's rect directly so the
    // test validates the offset math without depending on jsdom layout.
    const getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("data-testid") === "feed-status-pill-right") {
          return makeDomRect(26, 144);
        }
        return makeDomRect(0, 0);
      });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByLabelText("Go to top")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notification inbox: 1 review notification" })).toBeTruthy();
    expect(screen.getByTestId("message-feed-nav-fabs").style.bottom).toBe("42px");

    getBoundingClientRectSpy.mockRestore();
  });
});

describe("MessageFeed - tool timer footer", () => {
  it("shows detached tool timer summary for Claude sessions", () => {
    const sid = "test-footer-claude";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "ok" })]);
    setStoreSessionBackend(sid, "claude");
    setStoreToolProgress(sid, [{ toolUseId: "tu-1", toolName: "Bash", elapsedSeconds: 12 }]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("12s")).toBeTruthy();
  });

  it("hides detached tool timer summary for Codex sessions", () => {
    const sid = "test-footer-codex";
    setStoreMessages(sid, [makeMessage({ role: "assistant", content: "ok" })]);
    setStoreSessionBackend(sid, "codex");
    setStoreToolProgress(sid, [{ toolUseId: "tu-1", toolName: "Bash", elapsedSeconds: 12 }]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.queryByText("12s")).toBeNull();
  });
});

describe("MessageFeed - Codex terminal chips", () => {
  it("renders a top rail chip and compact inline stub for a long-running Codex Bash command", () => {
    const sid = "test-codex-live-terminal";
    setStoreSessionBackend(sid, "codex");
    setStoreMessages(sid, [
      makeMessage({
        id: "codex-live-1",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-live", name: "Bash", input: { command: "bun test src/ws-bridge.test.ts" } },
        ],
      }),
    ]);
    setStoreToolProgress(sid, [
      { toolUseId: "tu-live", toolName: "Bash", elapsedSeconds: 12, output: "RUN  src/ws-bridge.test.ts\n" },
    ]);
    setStoreToolStartTimestamps(sid, { "tu-live": Date.now() - 12_000 });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("live-activity-rail")).toBeTruthy();
    expect(screen.getByTestId("codex-live-terminal-chip").textContent).toContain("bun");
    expect(screen.getByText("Live terminal")).toBeTruthy();
    expect(screen.queryByText("Live output")).toBeNull();
  });

  it("waits five seconds before showing the top live-terminal rail", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));
      const sid = "test-codex-live-terminal-dwell";
      setStoreSessionBackend(sid, "codex");
      setStoreMessages(sid, [
        makeMessage({
          id: "codex-live-dwell-1",
          role: "assistant",
          content: "",
          contentBlocks: [{ type: "tool_use", id: "tu-live-dwell", name: "Bash", input: { command: "npm run lint" } }],
        }),
      ]);
      setStoreToolProgress(sid, [
        { toolUseId: "tu-live-dwell", toolName: "Bash", elapsedSeconds: 1, output: "linting...\n" },
      ]);
      setStoreToolStartTimestamps(sid, { "tu-live-dwell": new Date("2026-03-10T11:59:56.000Z").getTime() });

      render(<MessageFeed sessionId={sid} />);

      expect(screen.queryByTestId("live-activity-rail")).toBeNull();
      expect(screen.getByText("Live terminal")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      expect(screen.getByTestId("live-activity-rail")).toBeTruthy();
      expect(screen.getByTestId("codex-live-terminal-chip").textContent).toContain("npm");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the read-only inspector from the live chip", () => {
    const sid = "test-codex-live-inspector";
    setStoreSessionBackend(sid, "codex");
    setStoreMessages(sid, [
      makeMessage({
        id: "codex-live-2",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-live-2", name: "Bash", input: { command: "npm run flaky:test" } }],
      }),
    ]);
    setStoreToolProgress(sid, [
      { toolUseId: "tu-live-2", toolName: "Bash", elapsedSeconds: 9, output: "Waiting for reconnect watchdog...\n" },
    ]);
    setStoreToolStartTimestamps(sid, { "tu-live-2": Date.now() - 9_000 });

    render(<MessageFeed sessionId={sid} />);

    setElementClientSize(screen.getByTestId("message-feed-overlay"), 700, 560);

    fireEvent.click(screen.getByTestId("codex-live-terminal-chip"));

    expect(screen.getByTestId("codex-terminal-inspector")).toBeTruthy();
    expect(screen.getByText("Live output")).toBeTruthy();
    expect(screen.getByText("Waiting for reconnect watchdog...")).toBeTruthy();
  });

  it("keeps the live inspector draggable within the feed viewport", () => {
    const sid = "test-codex-live-inspector-drag";
    setStoreSessionBackend(sid, "codex");
    setStoreMessages(sid, [
      makeMessage({
        id: "codex-live-drag",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-live-drag", name: "Bash", input: { command: "tail -f server.log" } },
        ],
      }),
    ]);
    setStoreToolProgress(sid, [
      { toolUseId: "tu-live-drag", toolName: "Bash", elapsedSeconds: 17, output: "waiting...\n" },
    ]);
    setStoreToolStartTimestamps(sid, { "tu-live-drag": Date.now() - 17_000 });

    render(<MessageFeed sessionId={sid} />);

    setElementClientSize(screen.getByTestId("message-feed-overlay"), 700, 560);
    fireEvent.click(screen.getByTestId("codex-live-terminal-chip"));

    const inspector = screen.getByTestId("codex-terminal-inspector");
    const header = screen.getByTestId("codex-terminal-inspector-header");

    expect(inspector.style.left).toBe("16px");
    expect(inspector.style.top).toBe("184px");
    expect(inspector.style.width).toBe("512px");
    expect(inspector.style.height).toBe("360px");

    fireEvent.pointerDown(header, { button: 0, clientX: 40, clientY: 210, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 520, clientY: 510, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(inspector.style.left).toBe("172px");
    expect(inspector.style.top).toBe("184px");

    fireEvent.pointerDown(header, { button: 0, clientX: 520, clientY: 210, pointerId: 2 });
    fireEvent.pointerMove(window, { clientX: -50, clientY: -50, pointerId: 2 });
    fireEvent.pointerUp(window, { pointerId: 2 });

    expect(inspector.style.left).toBe("16px");
    expect(inspector.style.top).toBe("16px");
  });

  it("clamps live inspector resizing so the transcript stays on-screen", () => {
    const sid = "test-codex-live-inspector-resize";
    setStoreSessionBackend(sid, "codex");
    setStoreMessages(sid, [
      makeMessage({
        id: "codex-live-resize",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-live-resize", name: "Bash", input: { command: "npm run watch" } }],
      }),
    ]);
    setStoreToolProgress(sid, [
      { toolUseId: "tu-live-resize", toolName: "Bash", elapsedSeconds: 11, output: "rebuilt 3 files\n" },
    ]);
    setStoreToolStartTimestamps(sid, { "tu-live-resize": Date.now() - 11_000 });

    render(<MessageFeed sessionId={sid} />);

    setElementClientSize(screen.getByTestId("message-feed-overlay"), 700, 500);
    fireEvent.click(screen.getByTestId("codex-live-terminal-chip"));

    const inspector = screen.getByTestId("codex-terminal-inspector");
    const resizeHandle = screen.getByTestId("codex-terminal-inspector-resize");

    fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 528, clientY: 484, pointerId: 3 });
    fireEvent.pointerMove(window, { clientX: 900, clientY: 900, pointerId: 3 });
    fireEvent.pointerUp(window, { pointerId: 3 });

    expect(inspector.style.left).toBe("16px");
    expect(inspector.style.top).toBe("16px");
    expect(inspector.style.width).toBe("668px");
    expect(inspector.style.height).toBe("468px");
  });

  it("removes the live chip once the Codex Bash command has a final result", () => {
    const sid = "test-codex-live-complete";
    setStoreSessionBackend(sid, "codex");
    setStoreMessages(sid, [
      makeMessage({
        id: "codex-live-3",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-live-3", name: "Bash", input: { command: "bun run test" } }],
      }),
    ]);
    setStoreToolResults(sid, {
      "tu-live-3": {
        content: "12 passed",
        is_truncated: false,
        duration_seconds: 15.2,
      },
    });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("codex-live-terminal-chip")).toBeNull();
    expect(screen.queryByTestId("live-activity-rail")).toBeNull();
    expect(screen.queryByText("Live terminal")).toBeNull();
    expect(screen.getByText("bun run test")).toBeTruthy();
  });

  it("keeps a completed live terminal transcript visible in the inline Bash card", () => {
    const sid = "test-codex-live-transcript";
    setStoreSessionBackend(sid, "codex");
    setStoreMessages(sid, [
      makeMessage({
        id: "codex-live-4",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-live-4", name: "Bash", input: { command: "find . -name '*.ts'" } }],
      }),
    ]);
    setStoreToolProgress(sid, [
      {
        toolUseId: "tu-live-4",
        toolName: "Bash",
        elapsedSeconds: 14,
        output: "src/store.ts\nsrc/ws-handlers.ts\n",
      },
    ]);
    setStoreToolResults(sid, {
      "tu-live-4": {
        content: "Terminal command completed, but no output was captured.",
        is_truncated: false,
        duration_seconds: 14.1,
      },
    });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("live-activity-rail")).toBeNull();
    expect(screen.getByText("live")).toBeTruthy();

    fireEvent.click(screen.getByText("find . -name '*.ts'"));

    expect(screen.getByText("previously live")).toBeTruthy();
    expect(screen.getByText("showing captured transcript")).toBeTruthy();
    expect(screen.getByText(/src\/store\.ts[\s\S]*src\/ws-handlers\.ts/)).toBeTruthy();
  });

  it("renders all live activity chips in a horizontally scrollable rail", () => {
    const sid = "test-live-activity-horizontal-scroll";
    setStoreSessionBackend(sid, "codex");
    setStoreMessages(sid, [
      makeMessage({
        id: "codex-live-many",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-live-1", name: "Bash", input: { command: "cmd 1" } },
          { type: "tool_use", id: "tu-live-2", name: "Bash", input: { command: "cmd 2" } },
          { type: "tool_use", id: "tu-live-3", name: "Bash", input: { command: "cmd 3" } },
          { type: "tool_use", id: "tu-live-4", name: "Bash", input: { command: "cmd 4" } },
          { type: "tool_use", id: "tu-live-5", name: "Bash", input: { command: "cmd 5" } },
          { type: "tool_use", id: "tu-live-6", name: "Bash", input: { command: "cmd 6" } },
        ],
      }),
    ]);
    setStoreToolProgress(sid, [
      { toolUseId: "tu-live-1", toolName: "Bash", elapsedSeconds: 10 },
      { toolUseId: "tu-live-2", toolName: "Bash", elapsedSeconds: 10 },
      { toolUseId: "tu-live-3", toolName: "Bash", elapsedSeconds: 10 },
      { toolUseId: "tu-live-4", toolName: "Bash", elapsedSeconds: 10 },
      { toolUseId: "tu-live-5", toolName: "Bash", elapsedSeconds: 10 },
      { toolUseId: "tu-live-6", toolName: "Bash", elapsedSeconds: 10 },
    ]);
    setStoreToolStartTimestamps(sid, {
      "tu-live-1": Date.now() - 10_000,
      "tu-live-2": Date.now() - 10_000,
      "tu-live-3": Date.now() - 10_000,
      "tu-live-4": Date.now() - 10_000,
      "tu-live-5": Date.now() - 10_000,
      "tu-live-6": Date.now() - 10_000,
    });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("live-activity-rail")).toBeTruthy();
    expect(screen.getAllByTestId("codex-live-terminal-chip")).toHaveLength(6);
  });

  it("shortens path-based terminal chip labels to the executable file name", () => {
    const sid = "test-live-activity-path-chip";
    setStoreSessionBackend(sid, "codex");
    setStoreMessages(sid, [
      makeMessage({
        id: "codex-live-path",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-live-path",
            name: "Bash",
            input: { command: "/Users/test/bin/really-long-tool --flag value" },
          },
        ],
      }),
    ]);
    setStoreToolProgress(sid, [{ toolUseId: "tu-live-path", toolName: "Bash", elapsedSeconds: 12 }]);
    setStoreToolStartTimestamps(sid, { "tu-live-path": Date.now() - 12_000 });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("codex-live-terminal-chip").textContent).toContain("really-long-tool");
    expect(screen.queryByText("Live activity")).toBeNull();
  });

  it("waits five seconds before showing a live subagent chip", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));
      const sid = "test-live-subagent-dwell";
      setStoreSessionBackend(sid, "claude");
      setStoreStatus(sid, "running");
      setStoreMessages(sid, [
        makeMessage({ id: "u-sub-1", role: "user", content: "Investigate the logs" }),
        makeMessage({
          id: "a-sub-1",
          role: "assistant",
          content: "",
          contentBlocks: [
            {
              type: "tool_use",
              id: "task-live-dwell",
              name: "Task",
              input: { description: "Analyze logs", subagent_type: "Explore" },
            },
          ],
        }),
      ]);
      setStoreToolStartTimestamps(sid, {
        "task-live-dwell": new Date("2026-03-10T11:59:56.000Z").getTime(),
      });

      render(<MessageFeed sessionId={sid} />);

      expect(screen.queryByTestId("live-activity-rail")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      expect(screen.getByTestId("live-activity-rail")).toBeTruthy();
      expect(screen.getByTestId("live-subagent-chip").textContent).toContain("Analyze logs");
      // agentType and background tags are intentionally omitted from floating chips to save space
    } finally {
      vi.useRealTimers();
    }
  });

  it("scrolls to the inline subagent card when clicking a live subagent chip", () => {
    const sid = "test-live-subagent-scroll";
    setStoreSessionBackend(sid, "claude");
    setStoreStatus(sid, "running");
    setStoreMessages(sid, [
      makeMessage({ id: "u-sub-2", role: "user", content: "Inspect event routing" }),
      makeMessage({
        id: "a-sub-2",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-live-scroll",
            name: "Task",
            input: { description: "Inspect event routing", subagent_type: "explorer" },
          },
        ],
      }),
    ]);
    setStoreToolStartTimestamps(sid, {
      "task-live-scroll": Date.now() - 8_000,
    });

    render(<MessageFeed sessionId={sid} />);

    mockScrollIntoView.mockClear();
    fireEvent.click(screen.getByTestId("live-subagent-chip"));

    expect(mockScrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("dismisses a live subagent chip locally while keeping the inline card", () => {
    const sid = "test-live-subagent-dismiss";
    setStoreSessionBackend(sid, "claude");
    setStoreStatus(sid, "running");
    setStoreMessages(sid, [
      makeMessage({ id: "u-sub-dismiss", role: "user", content: "Inspect event routing" }),
      makeMessage({
        id: "a-sub-dismiss",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-live-dismiss",
            name: "Task",
            input: { description: "Inspect event routing", subagent_type: "explorer" },
          },
        ],
      }),
    ]);
    setStoreToolStartTimestamps(sid, {
      "task-live-dismiss": Date.now() - 8_000,
    });

    const { container } = render(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("live-subagent-chip")).toBeTruthy();
    fireEvent.click(screen.getByTestId("live-subagent-chip-dismiss"));

    expect(screen.queryByTestId("live-subagent-chip")).toBeNull();
    expect(container.querySelector('[data-feed-block-id="subagent:task-live-dismiss"]')).toBeTruthy();
  });

  it("re-shows a dismissed live subagent chip when fresh activity arrives", () => {
    const sid = "test-live-subagent-dismiss-refresh";
    setStoreSessionBackend(sid, "claude");
    setStoreStatus(sid, "running");
    setStoreMessages(sid, [
      makeMessage({ id: "u-sub-refresh", role: "user", content: "Inspect event routing" }),
      makeMessage({
        id: "a-sub-refresh",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-live-refresh",
            name: "Task",
            input: { description: "Inspect event routing", subagent_type: "explorer" },
          },
        ],
      }),
    ]);
    setStoreToolStartTimestamps(sid, {
      "task-live-refresh": Date.now() - 8_000,
    });

    const { rerender } = render(<MessageFeed sessionId={sid} />);

    fireEvent.click(screen.getByTestId("live-subagent-chip-dismiss"));
    expect(screen.queryByTestId("live-subagent-chip")).toBeNull();

    setStoreParentStreaming(sid, { "task-live-refresh": "New child output arrived\n" });
    rerender(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("live-subagent-chip")).toBeTruthy();
  });
});

// ─── getToolOnlyName behavior (tested via grouping) ──────────────────────────

describe("MessageFeed - tool-only message detection", () => {
  it("renders view_image tool-only messages as a visible View Image block in the chat feed", () => {
    const sid = "test-view-image-tool";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-view-1", name: "view_image", input: { path: "/tmp/proof.png" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("View Image")).toBeTruthy();
    expect(screen.getByText("/tmp/proof.png")).toBeTruthy();
  });

  it("hides synthetic write_stdin polling actions from the chat feed", () => {
    const sid = "test-hide-write-stdin";
    setStoreMessages(sid, [
      makeMessage({
        id: "a-poll",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-poll", name: "write_stdin", input: { session_id: "59356", chars: "" } },
        ],
      }),
      makeMessage({
        id: "a-visible",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("59356")).toBeNull();
    expect(screen.queryByText("write_stdin")).toBeNull();
    expect(screen.getByText("pwd")).toBeTruthy();
  });

  it("renders file-tool messages as standalone chips without grouping", () => {
    // Edit/Write/Read tools are never grouped at the feed level
    const sid = "test-tool-group";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } }],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/b.ts" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // No count badge -- each is standalone
    expect(screen.queryByText("2")).toBeNull();
    // 2 standalone chips, each with "Read File" label
    const labels = screen.getAllByText("Read File");
    expect(labels.length).toBe(2);
  });

  it("keeps the outer Terminal group label while removing repeated inner bash labels", () => {
    const sid = "test-bash-tool-group";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "test -f package.json" } }],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-2", name: "Bash", input: { command: "bun run test" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getAllByText("Terminal")).toHaveLength(1);
    expect(screen.getByText("test -f package.json")).toBeTruthy();
    expect(screen.getByText("bun run test")).toBeTruthy();
  });

  it("does not group different tool types across messages", () => {
    const sid = "test-no-tool-group";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } }],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-2", name: "Bash", input: { command: "ls" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Read File")).toBeTruthy();
    expect(screen.queryByText("Terminal")).toBeNull();
    expect(screen.getByText("ls")).toBeTruthy();
  });

  it("does not treat assistant messages with text as tool-only", () => {
    const sid = "test-mixed-msg";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "text", text: "Let me check something" },
          { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Should render as a regular message, not grouped
    expect(screen.getByText("Let me check something")).toBeTruthy();
    expect(screen.getByText("Read File")).toBeTruthy();
  });
});

// ─── groupMessages with subagent nesting ─────────────────────────────────────

describe("MessageFeed - subagent grouping", () => {
  it("nests child messages under Task tool_use entries in a unified card", () => {
    // The Task tool_use should be absorbed into the SubagentContainer — not rendered
    // as a separate ToolBlock. The unified card shows description, agent type, and children.
    const sid = "test-subagent";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-1",
            name: "Task",
            input: { description: "Research the problem", subagent_type: "researcher" },
          },
        ],
      }),
      makeMessage({
        id: "child-1",
        role: "assistant",
        content: "Found the answer",
        parentToolUseId: "task-1",
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // The description appears in the unified subagent card header
    expect(screen.getAllByText("Research the problem").length).toBeGreaterThanOrEqual(1);
    // The agent type badge should be shown
    expect(screen.getByText("researcher")).toBeTruthy();
    // The Task tool_use should NOT produce a separate "Subagent" ToolBlock label
    // (the old behavior showed both a ToolBlock and a SubagentContainer)
    expect(screen.queryByText("Subagent")).toBeNull();
  });

  it("filters out orphaned child messages when parent Task tool_use block is missing", () => {
    // When the CLI sent the parent assistant message in two parts and the Task
    // block was lost due to message deduplication, the child messages still have
    // parentToolUseId set but the synthetic taskInfo has empty input. These
    // orphaned subagents should NOT appear — they create persistent "ghost" chips
    // at the bottom of the turn that never go away.
    const sid = "test-orphan-subagent";
    setStoreMessages(sid, [
      // Parent message only has text — no Task tool_use block (it was lost)
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "Let me use the playwright agent to check this",
        contentBlocks: [{ type: "text", text: "Let me use the playwright agent to check this" }],
      }),
      // Child messages have parentToolUseId but no matching Task in any message
      makeMessage({
        id: "child-1",
        role: "assistant",
        content: "",
        parentToolUseId: "task-orphan-1",
        contentBlocks: [{ type: "tool_use", id: "tu-bash-1", name: "Bash", input: { command: "ls" } }],
      }),
      makeMessage({
        id: "child-2",
        role: "assistant",
        content: "",
        parentToolUseId: "task-orphan-1",
        contentBlocks: [{ type: "tool_use", id: "tu-bash-2", name: "Bash", input: { command: "pwd" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Orphaned children with synthetic taskInfo (empty input) should be filtered
    // out, not rendered as a fallback SubagentContainer. The parent text should
    // still render, but no "Subagent" chip should appear.
    expect(screen.getByText("Let me use the playwright agent to check this")).toBeTruthy();
    expect(screen.queryByText("Subagent")).toBeNull();
  });

  it("renders 'Agent starting...' when Task has no children yet", () => {
    // When a Task tool_use is dispatched but the subagent hasn't produced any
    // child messages yet, the unified card should show a loading indicator.
    const sid = "test-subagent-empty";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-empty",
            name: "Task",
            input: { description: "Analyze logs", subagent_type: "Explore" },
          },
        ],
      }),
    ]);
    // Session must be "running" so the subagent isn't treated as abandoned
    setStoreStatus(sid, "running");

    render(<MessageFeed sessionId={sid} />);

    // Card header should show the description (visible when collapsed)
    expect(screen.getByText("Analyze logs")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    // Subagents start collapsed — click to expand
    fireEvent.click(screen.getByText("Analyze logs"));
    // Since there are no children and no result, the "Agent starting..." indicator
    // should be visible when expanded
    expect(screen.getByText("Agent starting...")).toBeTruthy();
  });

  it("renders live parented streaming inside the subagent card instead of the top-level streaming bubble", () => {
    const sid = "test-subagent-streaming";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-streaming",
            name: "Agent",
            input: { description: "Inspect event routing", subagent_type: "explorer" },
          },
        ],
      }),
    ]);
    setStoreSessionBackend(sid, "codex");
    setStoreStatus(sid, "running");
    setStoreParentStreaming(sid, { "task-streaming": "Streaming from the subagent\nStill hidden" });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Inspect event routing")).toBeTruthy();
    fireEvent.click(screen.getByText("Inspect event routing"));
    fireEvent.click(screen.getByText("Activities"));
    expect(screen.getByTestId("markdown").textContent).toContain("Streaming from the subagent");
    expect(screen.queryByText("Still hidden")).toBeNull();
    expect(screen.queryByText("Agent starting...")).toBeNull();
  });

  it("renders live parented codex thinking inside the subagent card", () => {
    const sid = "test-subagent-thinking";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-thinking",
            name: "Agent",
            input: { description: "Inspect event routing", subagent_type: "explorer" },
          },
        ],
      }),
    ]);
    setStoreSessionBackend(sid, "codex");
    setStoreStatus(sid, "running");
    setStoreParentThinking(sid, { "task-thinking": "Summarizing the routing plan" });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Summarizing the routing plan")).toBeTruthy();
    fireEvent.click(screen.getByText("Inspect event routing"));
    fireEvent.click(screen.getByText("Activities"));
    expect(screen.getAllByText("Summarizing the routing plan").length).toBeGreaterThan(0);
    expect(screen.queryByText("Agent starting...")).toBeNull();
  });

  it("withholds partial codex subagent lines until a newline commits them", () => {
    const sid = "test-subagent-streaming-partial";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-streaming-partial",
            name: "Agent",
            input: { description: "Inspect event routing", subagent_type: "explorer" },
          },
        ],
      }),
    ]);
    setStoreSessionBackend(sid, "codex");
    setStoreStatus(sid, "running");
    setStoreParentStreaming(sid, { "task-streaming-partial": "Hidden partial" });

    const { unmount } = render(<MessageFeed sessionId={sid} />);

    fireEvent.click(screen.getByText("Inspect event routing"));
    fireEvent.click(screen.getByText("Activities"));
    expect(screen.queryByText("Hidden partial")).toBeNull();
    expect(screen.getByTestId("markdown").textContent).toBe("");

    unmount();
    setStoreParentStreaming(sid, { "task-streaming-partial": "Hidden partial\n" });
    render(<MessageFeed sessionId={sid} />);

    fireEvent.click(screen.getByText("Inspect event routing"));
    fireEvent.click(screen.getByText("Activities"));
    expect(screen.getByTestId("markdown").textContent).toContain("Hidden partial");
  });

  it("shows a live subagent timer while the task tool is running", () => {
    // Validates that subagent cards use Task tool start timestamps for live duration.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
      const sid = "test-subagent-live-timer";
      setStoreMessages(sid, [
        makeMessage({
          id: "a1",
          role: "assistant",
          content: "",
          contentBlocks: [
            {
              type: "tool_use",
              id: "task-live",
              name: "Task",
              input: { description: "Analyze logs", subagent_type: "Explore" },
            },
          ],
        }),
      ]);
      setStoreToolStartTimestamps(sid, { "task-live": new Date("2026-01-01T00:00:05.000Z").getTime() });
      // Session must be "running" so the live timer ticks (not abandoned)
      setStoreStatus(sid, "running");

      render(<MessageFeed sessionId={sid} />);

      expect(screen.getAllByText("5.0s").length).toBeGreaterThan(0);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getAllByText("7.0s").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows 'Agent interrupted' when session is idle and subagent has no result", () => {
    // When the session goes idle (turn ended) but a subagent never received a
    // tool_result, the chip should stop spinning and show "Agent interrupted"
    // instead of "Agent starting..." forever.
    const sid = "test-subagent-abandoned";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-abandoned",
            name: "Task",
            input: { description: "Review auth code", subagent_type: "general-purpose" },
          },
        ],
      }),
    ]);
    // Session is idle — the turn has ended
    setStoreStatus(sid, "idle");

    render(<MessageFeed sessionId={sid} />);

    // Expand the subagent card
    fireEvent.click(screen.getByText("Review auth code"));
    // Should show "Agent interrupted" instead of "Agent starting..."
    expect(screen.getByText("Agent interrupted")).toBeTruthy();
    expect(screen.queryByText("Agent starting...")).toBeNull();
  });

  it("shows final subagent duration when the task completes", () => {
    // Validates that completed subagents render the server-reported final duration.
    const sid = "test-subagent-final-duration";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-final",
            name: "Task",
            input: { description: "Analyze logs", subagent_type: "Explore" },
          },
        ],
      }),
    ]);
    setStoreToolResults(sid, {
      "task-final": {
        content: "done",
        is_truncated: false,
        duration_seconds: 5.2,
      },
    });

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("5.2s")).toBeTruthy();
  });

  it("shows the Prompt toggle when task has a prompt", () => {
    // The unified card should include a collapsible "Prompt" section
    // when the Task tool_use includes a prompt field.
    const sid = "test-subagent-prompt";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-prompt",
            name: "Task",
            input: {
              description: "Search for patterns",
              subagent_type: "Explore",
              prompt: "Find all authentication middleware files",
            },
          },
        ],
      }),
      makeMessage({
        id: "child-1",
        role: "assistant",
        content: "",
        parentToolUseId: "task-prompt",
        contentBlocks: [{ type: "tool_use", id: "tu-grep-1", name: "Grep", input: { pattern: "auth" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Subagents start collapsed — click to expand
    fireEvent.click(screen.getByText("Search for patterns"));
    // The "Prompt" toggle should be visible when expanded (prompt starts collapsed)
    expect(screen.getByText("Prompt")).toBeTruthy();
    // The prompt text itself should NOT be visible until the toggle is clicked
    expect(screen.queryByText("Find all authentication middleware files")).toBeNull();
  });

  it("lets Prompt, Activities, and Result collapse independently", () => {
    const sid = "test-subagent-sections";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-sections",
            name: "Task",
            input: {
              description: "Inspect auth flow",
              subagent_type: "Explore",
              prompt: "Trace the auth middleware path",
            },
          },
        ],
      }),
      makeMessage({
        id: "child-sections",
        role: "assistant",
        content: "Checked middleware entrypoint",
        parentToolUseId: "task-sections",
        contentBlocks: [{ type: "text", text: "Checked middleware entrypoint" }],
      }),
    ]);
    setStoreToolResults(sid, {
      "task-sections": {
        content: "Final auth summary",
        is_truncated: false,
      },
    });

    render(<MessageFeed sessionId={sid} />);

    fireEvent.click(screen.getByText("Inspect auth flow"));

    expect(screen.getByText("Prompt")).toBeTruthy();
    expect(screen.getByText("Activities")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.queryByText("Trace the auth middleware path")).toBeNull();
    expect(screen.queryByText("Checked middleware entrypoint")).toBeNull();
    expect(screen.queryByText("Final auth summary")).toBeNull();

    fireEvent.click(screen.getByText("Activities"));
    expect(screen.getByText("Checked middleware entrypoint")).toBeTruthy();
    expect(screen.queryByText("Final auth summary")).toBeNull();

    fireEvent.click(screen.getByText("Result"));
    expect(screen.getByText("Final auth summary")).toBeTruthy();

    fireEvent.click(screen.getByText("Prompt"));
    expect(screen.getByText("Trace the auth middleware path")).toBeTruthy();
    expect(screen.getByText("Checked middleware entrypoint")).toBeTruthy();
  });

  it("keeps the Activities section collapsed while new subagent activity streams in", () => {
    const sid = "test-subagent-activities-stay-collapsed";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-collapse-stream",
            name: "Task",
            input: { description: "Inspect event routing", subagent_type: "Explore" },
          },
        ],
      }),
      makeMessage({
        id: "child-collapse-stream",
        role: "assistant",
        content: "Initial child activity",
        parentToolUseId: "task-collapse-stream",
        contentBlocks: [{ type: "text", text: "Initial child activity" }],
      }),
    ]);
    setStoreSessionBackend(sid, "codex");
    setStoreStatus(sid, "running");

    const { rerender } = render(<MessageFeed sessionId={sid} />);

    fireEvent.click(screen.getByText("Inspect event routing"));
    expect(screen.queryByText("Initial child activity")).toBeNull();

    setStoreParentStreaming(sid, { "task-collapse-stream": "Streaming from the subagent\n" });
    rerender(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Initial child activity")).toBeNull();
    expect(screen.queryByText("Streaming from the subagent")).toBeNull();
  });

  it("does not render Task tool_use as ToolBlock in mixed message with text and Task", () => {
    // When an assistant message has both text and Task tool_use blocks,
    // the Task blocks should be filtered from MessageBubble rendering
    // and only appear as SubagentContainer cards.
    const sid = "test-mixed-task";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "I'll launch two agents in parallel.",
        contentBlocks: [
          { type: "text", text: "I'll launch two agents in parallel." },
          {
            type: "tool_use",
            id: "task-mix-1",
            name: "Task",
            input: { description: "Count files", subagent_type: "Explore" },
          },
          {
            type: "tool_use",
            id: "task-mix-2",
            name: "Task",
            input: { description: "Check git activity", subagent_type: "Bash" },
          },
        ],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // The text should render in the MessageBubble
    expect(screen.getByText("I'll launch two agents in parallel.")).toBeTruthy();
    // SubagentContainer cards should appear with the descriptions
    expect(screen.getByText("Count files")).toBeTruthy();
    expect(screen.getByText("Check git activity")).toBeTruthy();
    // No "Subagent" ToolBlock label should appear (that would mean duplicate rendering)
    expect(screen.queryByText("Subagent")).toBeNull();
  });

  it("renders subagent assistant text when child message also contains tool_use blocks", () => {
    // Some child assistant messages include text in `content` while contentBlocks
    // only contain tool_use entries. The subagent panel should still render both.
    const sid = "test-subagent-child-mixed";
    setStoreMessages(sid, [
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "task-mixed-child",
            name: "Task",
            input: { description: "Inspect docs", subagent_type: "Explore" },
          },
        ],
      }),
      makeMessage({
        id: "child-1",
        role: "assistant",
        content: "Let me inspect README first.",
        parentToolUseId: "task-mixed-child",
        contentBlocks: [{ type: "tool_use", id: "tu-read-1", name: "Read", input: { file_path: "/tmp/README.md" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    fireEvent.click(screen.getByText("Inspect docs"));
    fireEvent.click(screen.getByText("Activities"));

    expect(screen.getByText("Let me inspect README first.")).toBeTruthy();
    expect(screen.getByText("Read File")).toBeTruthy();
  });
});

// ─── Turn grouping and collapse ─────────────────────────────────────────────

describe("MessageFeed - turn grouping", () => {
  it("groups entries into turns split on user messages", () => {
    // Two user messages with assistant responses between them — both should render
    const sid = "test-turn-group";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First question" }),
      makeMessage({ id: "a1", role: "assistant", content: "First answer" }),
      makeMessage({ id: "u2", role: "user", content: "Second question" }),
      makeMessage({ id: "a2", role: "assistant", content: "Second answer" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("First question")).toBeTruthy();
    expect(screen.getByText("First answer")).toBeTruthy();
    expect(screen.getByText("Second question")).toBeTruthy();
    expect(screen.getByText("Second answer")).toBeTruthy();
  });

  it("shows assistant turn duration in the feed for completed turns", () => {
    // Validates that completed assistant turns surface total turn duration in feed UI.
    const sid = "test-turn-duration";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First question" }),
      makeMessage({ id: "a1", role: "assistant", content: "First answer", turnDurationMs: 4200 }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("message-timestamp").textContent).toContain("4.2s");
  });

  it("renders agent activity before first user message", () => {
    // Session starts with assistant message (e.g., resumed session)
    const sid = "test-turn-preamble";
    setStoreMessages(sid, [
      makeMessage({ id: "a0", role: "assistant", content: "Session restored" }),
      makeMessage({ id: "u1", role: "user", content: "Continue" }),
      makeMessage({ id: "a1", role: "assistant", content: "OK" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Continue")).toBeTruthy();
    expect(screen.getByText("OK")).toBeTruthy();
  });

  it("shows normal-session turn duration inside the collapsed activity row", () => {
    const sid = "test-turn-duration-summary-normal";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First question", timestamp: 1_000 }),
      makeMessage({ id: "a1", role: "assistant", content: "Investigating first question", timestamp: 120_000 }),
      makeMessage({ id: "a2", role: "assistant", content: "First answer", timestamp: 193_000 }),
      makeMessage({ id: "u2", role: "user", content: "Second question", timestamp: 200_000 }),
      makeMessage({ id: "a3", role: "assistant", content: "Second answer", timestamp: 260_000 }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    const durations = screen.getAllByTestId("turn-summary-duration");
    expect(durations).toHaveLength(1);
    expect(durations[0].textContent).toBe("3m 12s");
    expect(screen.getByText("1 message")).toBeTruthy();
  });

  it("shows leader-session durations inside activity summary rows", () => {
    // Leader mode: turns split at user messages only. Each non-last turn
    // with collapsible agent activity shows a duration in its summary row.
    // Turns need tool calls so agentEntries isn't empty after text promotion.
    const sid = "test-turn-duration-summary-leader";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Coordinate", timestamp: 1_000 }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 31_000,
        contentBlocks: [{ type: "tool_use", id: "tu-700", name: "Read", input: { file_path: "/a.ts" } }],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "First update @to(user)",
        timestamp: 121_000,
      }),
      // Second user message creates a new turn
      makeMessage({ id: "u2", role: "user", content: "Continue", timestamp: 130_000 }),
      makeMessage({ id: "a3", role: "assistant", content: "Nudged #4", timestamp: 170_000 }),
      makeMessage({
        id: "a4",
        role: "assistant",
        content: "Second update @to(user)",
        timestamp: 313_000,
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // First turn: leader duration is boundary-to-boundary (u1 at 1s → u2 at 130s = 2m 9s)
    const durations = screen.getAllByTestId("turn-summary-duration");
    expect(durations).toHaveLength(1);
    expect(durations[0].textContent).toBe("2m 9s");
  });

  it("does not show normal-session summary duration when no final assistant response exists", () => {
    const sid = "test-turn-duration-summary-no-response";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First question", timestamp: 1_000 }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 5_000,
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } }],
      }),
      makeMessage({ id: "u2", role: "user", content: "Second question", timestamp: 10_000 }),
      makeMessage({ id: "a2", role: "assistant", content: "Second answer", timestamp: 15_000 }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("turn-summary-duration")).toBeNull();
  });
});

describe("MessageFeed - collapsed turns", () => {
  it("passes defaultExpanded=true when collapsing the latest leader activity row", () => {
    // Leader turns now always show the last assistant text as the collapsed
    // response preview. This test needs additional agent activity (internal
    // messages) so the CollapsedActivityBar still renders with a message count.
    const sid = "test-leader-latest-toggle";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "status" }),
      makeMessage({ id: "a1", role: "assistant", content: "Checking workers..." }),
      makeMessage({ id: "a2", role: "assistant", content: "Assigned q-400 to #9" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // a2 becomes responseEntry (shown as collapsed preview), a1 stays as 1 internal message
    fireEvent.click(screen.getByText("1 message"));
    expect(mockToggleTurnActivity).toHaveBeenCalledWith(sid, "u1", true);
  });

  it("leader mode leaves deprecated tag text in the collapsed card", () => {
    const sid = "test-leader-promotion";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Kick off orchestration" }),
      makeMessage({ id: "a1", role: "assistant", content: "Assigned q-600 to #2" }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "First update from the herd. @to(user)",
      }),
      makeMessage({ id: "a3", role: "assistant", content: "Nudged #2 about test coverage" }),
      makeMessage({
        id: "a4",
        role: "assistant",
        content: "Second update with progress. @to(user)",
      }),
      makeMessage({ id: "a5", role: "assistant", content: "Internal coordination @to(self)" }),
      // New user message creates turn boundary
      makeMessage({ id: "u2", role: "user", content: "Thanks" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Kick off orchestration")).toBeTruthy();
    expect(screen.getByText("Internal coordination @to(self)")).toBeTruthy();
    expect(screen.queryByText("Assigned q-600 to #2")).toBeNull();
    expect(screen.queryByText("Nudged #2 about test coverage")).toBeNull();
    expect(screen.queryByText("Second update with progress. @to(user)")).toBeNull();
    expect(screen.queryByText("First update from the herd. @to(user)")).toBeNull();
  });

  it("leader mode renders deprecated suffixes raw inside mixed assistant messages", () => {
    const sid = "test-leader-multi-text-boundary";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Need a status update" }),
      makeMessage({ id: "a1", role: "assistant", content: "Assigned q-777 to #4" }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content:
          "I investigated worker logs and reproduced the failure.\nRoot cause confirmed; patch queued. @to(user)",
        contentBlocks: [
          { type: "text", text: "I investigated worker logs and reproduced the failure." },
          { type: "tool_use", id: "tu-200", name: "Bash", input: { command: 'rg -n "leader" web/src/components' } },
          { type: "text", text: "Root cause confirmed; patch queued. @to(user)" },
        ],
      }),
      makeMessage({ id: "a3", role: "assistant", content: "Queued follow-up validation for #4" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("I investigated worker logs and reproduced the failure.")).toBeTruthy();
    expect(screen.getByText("Root cause confirmed; patch queued. @to(user)")).toBeTruthy();
    expect(screen.getByText("Assigned q-777 to #4")).toBeTruthy();
    expect(screen.getByText("Queued follow-up validation for #4")).toBeTruthy();
  });

  it("passes defaultExpanded=true when collapsing the latest leader turn with tool activity", () => {
    // Turns no longer split at @to(user) — all entries stay in one turn.
    // Add a tool call so there's a collapsible activity bar to click.
    const sid = "test-leader-last-user-boundary";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "status" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }],
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "#9 is implementing now. @to(user)",
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // The turn has tool activity → click the activity bar
    const activityRows = screen.getAllByText("1 tool");
    fireEvent.click(activityRows[activityRows.length - 1]);
    expect(mockToggleTurnActivity).toHaveBeenCalledWith(sid, "u1", true);
  });

  it("leader mode shows deprecated tags raw in the response preview", () => {
    const sid = "test-leader-collapse";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Coordinate workers" }),
      makeMessage({ id: "a1", role: "assistant", content: "Assigned q-127 to #3" }),
      makeMessage({ id: "a_self", role: "assistant", content: "internal check @to(self)" }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "I delegated auth + tests. Waiting for your review. @to(user)",
      }),
      makeMessage({ id: "u2", role: "user", content: "continue" }),
      makeMessage({ id: "a3", role: "assistant", content: "peeked #3 and nudged #4" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("I delegated auth + tests. Waiting for your review. @to(user)")).toBeTruthy();
    expect(screen.queryByText("Assigned q-127 to #3")).toBeNull();
    expect(screen.queryByText("internal check")).toBeNull();
    expect(screen.getByText("peeked #3 and nudged #4")).toBeTruthy();
  });

  it("leader mode keeps the latest turn tool activity expanded by default", () => {
    // Tool activity a3 is visible since the latest turn is expanded by default.
    const sid = "test-leader-latest-tools-expanded";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Status?" }),
      makeMessage({ id: "a1", role: "assistant", content: "Assigned q-333 to #6" }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "Worker #6 is implementing now. @to(user)",
      }),
      makeMessage({
        id: "a3",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "npm test" } }],
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Assigned q-333 to #6")).toBeTruthy();
    // Tool activity visible since turn is expanded (last turn)
    expect(screen.getByText("npm test")).toBeTruthy();
  });

  it("leader mode keeps the active latest turn expanded while streaming even with a stale collapsed override", () => {
    const sid = "test-leader-streaming-latest-forces-expanded";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreStatus(sid, "running");
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Status?" }),
      makeMessage({ id: "a1", role: "assistant", content: "Assigned q-333 to #6" }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "Worker #6 is implementing now. @to(user)",
      }),
      makeMessage({
        id: "a3",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "npm test" } }],
      }),
    ]);
    setStoreTurnOverrides(sid, [["u1", false]]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("npm test")).toBeTruthy();
  });

  it("leader mode still collapses the older turn when a fresh follow-up arrives", () => {
    const sid = "test-leader-streaming-penultimate-collapses";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreStatus(sid, "running");
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Status?" }),
      makeMessage({ id: "a1", role: "assistant", content: "Assigned q-333 to #6" }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "Worker #6 is implementing now. @to(user)",
      }),
      makeMessage({
        id: "a3",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "npm test" } }],
      }),
      makeMessage({ id: "u2", role: "user", content: "Follow-up while streaming" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("npm test")).toBeNull();
    expect(screen.getByText(/1 tool/)).toBeTruthy();
  });

  it("leader mode shows internal messages when the activity row is expanded", () => {
    const sid = "test-leader-expand";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Status?" }),
      makeMessage({ id: "a1", role: "assistant", content: "Assigned q-200 to #7" }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "Worker #7 is implementing the fix now. @to(user)",
      }),
    ]);
    setStoreTurnOverrides(sid, [["u1", true]]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Assigned q-200 to #7")).toBeTruthy();
  });

  it("non-last turns default to collapsed, showing activity bar + response", () => {
    // First turn auto-collapses since it's not the last turn.
    // The collapsed view shows: user msg + activity bar + final response entry.
    const sid = "test-turn-collapse";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First question" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a.ts" } }],
      }),
      makeMessage({ id: "a2", role: "assistant", content: "Here is the answer" }),
      makeMessage({ id: "u2", role: "user", content: "Second question" }),
      makeMessage({ id: "a3", role: "assistant", content: "Second answer" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // User message always visible
    expect(screen.getByText("First question")).toBeTruthy();
    // Activity bar shows stats (tool calls are intermediate activity)
    expect(screen.getByText(/1 tool/)).toBeTruthy();
    // Final agent response is always visible even when activity is collapsed
    expect(screen.getByText("Here is the answer")).toBeTruthy();
    // Second turn (last) is expanded by default
    expect(screen.getByText("Second question")).toBeTruthy();
    expect(screen.getByText("Second answer")).toBeTruthy();
  });

  it("keeps system messages visible when turn is collapsed", () => {
    // System messages (compact markers, errors) should not be hidden by collapse
    const sid = "test-system-visible";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Do something" }),
      makeMessage({ id: "compact-boundary-test", role: "system", content: "Conversation compacted", variant: "info" }),
      makeMessage({ id: "a1", role: "assistant", content: "Done" }),
      makeMessage({ id: "u2", role: "user", content: "Next" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Compact marker should remain visible even though the turn is collapsed
    expect(screen.getByText("Conversation compacted")).toBeTruthy();
    // Agent response should be visible as the responseEntry
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("renders compact markers in chronological position when turn is expanded", () => {
    // Compact markers should appear at their original position in the message flow.
    // Force-expand a non-last turn via override to test expanded rendering.
    const sid = "test-compact-position";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Start" }),
      makeMessage({ id: "a1", role: "assistant", content: "Working on it" }),
      makeMessage({ id: "compact-boundary-pos", role: "system", content: "Conversation compacted", variant: "info" }),
      makeMessage({ id: "a2", role: "assistant", content: "Done after compaction" }),
      makeMessage({ id: "u2", role: "user", content: "Next" }),
    ]);
    // Force-expand the first turn (not last, so defaults to collapsed)
    setStoreTurnOverrides(sid, [["u1", true]]);

    const { container } = render(<MessageFeed sessionId={sid} />);

    // All messages should be visible in the expanded turn
    expect(screen.getByText("Working on it")).toBeTruthy();
    expect(screen.getByText("Conversation compacted")).toBeTruthy();
    expect(screen.getByText("Done after compaction")).toBeTruthy();

    // Verify chronological order: "Working on it" should appear before
    // "Conversation compacted" which should appear before "Done after compaction"
    const allText = container.textContent || "";
    const posWorking = allText.indexOf("Working on it");
    const posCompact = allText.indexOf("Conversation compacted");
    const posDone = allText.indexOf("Done after compaction");
    expect(posWorking).toBeLessThan(posCompact);
    expect(posCompact).toBeLessThan(posDone);
  });

  it("collapsed turn shows final response even when no activity bar", () => {
    // When a turn has only a text response (no tools), no activity bar is shown —
    // just the user message and the response.
    const sid = "test-collapse-no-activity";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "The fix has been applied" }),
      makeMessage({ id: "u2", role: "user", content: "Thanks" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    // Response is visible as a full MessageBubble
    expect(screen.getByText(/The fix has been applied/)).toBeTruthy();
    // No activity bar since there are no remaining agent entries after extracting response
    expect(screen.queryByText(/message/)).toBeNull();
  });

  it("collapses an older unfinished turn when a new user message arrives", () => {
    const sid = "test-unfinished-turn-collapses";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First request" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-streaming", name: "Read", input: { file_path: "/tmp/a.ts" } }],
      }),
      makeMessage({ id: "u2", role: "user", content: "Follow-up while previous turn is unfinished" }),
      makeMessage({ id: "a2", role: "assistant", content: "Acknowledged follow-up" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Read File")).toBeNull();
    expect(screen.getByText(/1 tool/)).toBeTruthy();
  });

  it("collapses the penultimate turn while streaming when the latest turn is user-only", () => {
    const sid = "test-codex-streaming-penultimate-collapsed";
    setStoreStatus(sid, "running");
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Primary request" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-prev", name: "Read", input: { file_path: "/tmp/prev.ts" } }],
      }),
      makeMessage({ id: "a2", role: "assistant", content: "Partial in-flight response" }),
      makeMessage({ id: "u2", role: "user", content: "Follow-up during stream" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Read File")).toBeNull();
    expect(screen.getByText(/1 tool/)).toBeTruthy();
  });

  it("still respects an explicit override for an older turn after a follow-up", () => {
    const sid = "test-explicit-override-idle";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Primary request" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-prev", name: "Read", input: { file_path: "/tmp/prev.ts" } }],
      }),
      makeMessage({ id: "a2", role: "assistant", content: "Partial in-flight response" }),
      makeMessage({ id: "u2", role: "user", content: "Follow-up sent during stream" }),
      makeMessage({ id: "a3", role: "assistant", content: "Response to follow-up" }),
    ]);
    setStoreTurnOverrides(sid, [["u1", true]]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Read File")).toBeTruthy();
  });

  it("ignores stale auto-expanded state for older turns", () => {
    const sid = "test-stale-auto-expanded-turns";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First request" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-older", name: "Read", input: { file_path: "/tmp/older.ts" } }],
      }),
      makeMessage({ id: "a2", role: "assistant", content: "Older result" }),
      makeMessage({ id: "u2", role: "user", content: "Second request" }),
      makeMessage({
        id: "a3",
        role: "assistant",
        content: "",
        contentBlocks: [
          { type: "tool_use", id: "tu-penultimate", name: "Read", input: { file_path: "/tmp/penultimate.ts" } },
        ],
      }),
      makeMessage({ id: "a4", role: "assistant", content: "Penultimate result" }),
      makeMessage({ id: "u3", role: "user", content: "Latest request" }),
      makeMessage({ id: "a5", role: "assistant", content: "Latest result" }),
    ]);
    setStoreAutoExpandedTurns(sid, ["u1", "u2"]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByText("Read File")).toBeNull();
    expect(screen.getAllByText(/1 tool/)).toHaveLength(2);
  });

  // q-277: notification-bearing assistant messages should remain visible even
  // when the turn is collapsed. They should stay visible inside the same
  // collapsed turn card rather than rendering as a separate visual turn.
  it("keeps notification-bearing messages visible inside the collapsed single turn", () => {
    const sid = "test-collapsed-notification-visible";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Deploy the fix" }),
      // Internal assistant message (will be hidden when collapsed)
      makeMessage({ id: "a1", role: "assistant", content: "Running tests and building..." }),
      // Assistant message with a notification chip (should stay visible)
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "Quest q-99 ready for verification",
        notification: { category: "review", timestamp: Date.now(), summary: "q-99 ready for verification" },
      }),
      // Final response (shown as collapsed preview)
      makeMessage({ id: "a3", role: "assistant", content: "All done, ported to main." }),
      // Second turn boundary to force the first turn to collapse by default
      makeMessage({ id: "u2", role: "user", content: "Thanks" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    const notificationMessage = screen.getByText("Quest q-99 ready for verification");
    const responsePreview = screen.getByText("All done, ported to main.");
    const collapsedCard = responsePreview.closest(".rounded-xl");

    expect(notificationMessage).toBeTruthy();
    expect(responsePreview).toBeTruthy();
    expect(collapsedCard).toBeTruthy();
    expect(notificationMessage.closest(".rounded-xl")).toBe(collapsedCard);
    expect(within(collapsedCard as HTMLElement).getByText("Quest q-99 ready for verification")).toBeTruthy();
    expect(within(collapsedCard as HTMLElement).getByText("All done, ported to main.")).toBeTruthy();
    // The internal assistant message should be hidden (in agentEntries, collapsed)
    expect(screen.queryByText("Running tests and building...")).toBeNull();
  });
});
