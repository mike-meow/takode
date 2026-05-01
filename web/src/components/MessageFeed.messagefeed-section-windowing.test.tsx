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
