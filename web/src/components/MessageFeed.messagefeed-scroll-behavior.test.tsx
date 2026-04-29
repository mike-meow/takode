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
import { getFeedViewportKey, requestThreadViewportSnapshot } from "../utils/thread-viewport.js";

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
  threadKey = "main",
) {
  const map = new Map();
  map.set(getFeedViewportKey(sessionId, threadKey), pos);
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

  it("captures a terminal-switch snapshot and restores to the real bottom on remount", () => {
    const sid = "test-terminal-roundtrip-bottom";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Question" }),
      makeMessage({ id: "a1", role: "assistant", content: "Answer" }),
    ]);

    let scrollHeightValue = 1200;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    let scrollTopValue = 788;
    Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? scrollHeightValue : 0;
      },
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 400 : 0;
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

    mockSetFeedScrollPosition.mockImplementationOnce((viewportKey, pos) => {
      mockStoreValues.feedScrollPosition = new Map([[viewportKey, pos]]);
    });

    try {
      const { unmount } = render(<MessageFeed sessionId={sid} />);
      requestThreadViewportSnapshot(sid);
      unmount();

      scrollHeightValue = 1600;
      scrollTopValue = 0;
      mockScrollTo.mockClear();

      render(<MessageFeed sessionId={sid} />);

      expect(mockScrollTo).toHaveBeenCalledWith({ top: 1188, behavior: "auto" });
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        delete (HTMLDivElement.prototype as { scrollHeight?: unknown }).scrollHeight;
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
      } else {
        delete (HTMLDivElement.prototype as { clientHeight?: unknown }).clientHeight;
      }
      if (originalScrollTop) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      } else {
        delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      }
    }
  });

  it("captures an anchored older viewport when snapshotting before a terminal switch", () => {
    const sid = "test-terminal-roundtrip-anchor";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "First request" }),
      makeMessage({ id: "a1", role: "assistant", content: "First result" }),
      makeMessage({ id: "u2", role: "user", content: "Second request" }),
      makeMessage({ id: "a2", role: "assistant", content: "Second result" }),
      makeMessage({ id: "u3", role: "user", content: "Third request" }),
      makeMessage({ id: "a3", role: "assistant", content: "Third result" }),
    ]);

    mockSetFeedScrollPosition.mockImplementation((viewportKey, pos) => {
      mockStoreValues.feedScrollPosition = new Map([[viewportKey, pos]]);
    });

    const { container } = render(<MessageFeed sessionId={sid} />);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollTopValue = 720;

    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "scrollTop");

    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("overflow-y-auto") ? 400 : 0;
      },
    });
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

      const baseTopByTurnId: Record<string, { top: number; height: number }> = {
        u1: { top: 0, height: 300 },
        u2: { top: 740, height: 300 },
        u3: { top: 1180, height: 300 },
      };

      const turnId = element.dataset.turnId;
      if (turnId && baseTopByTurnId[turnId] !== undefined) {
        const turn = baseTopByTurnId[turnId];
        return makeRect(turn.top - scrollTopValue, turn.height);
      }

      return makeRect(-1000, 0);
    };

    try {
      fireEvent.scroll(scrollContainer);
      requestThreadViewportSnapshot(sid);
      expect(mockSetFeedScrollPosition).toHaveBeenCalledWith(
        getFeedViewportKey(sid),
        expect.objectContaining({
          scrollTop: 720,
          isAtBottom: false,
          anchorTurnId: "u2",
          anchorOffsetTop: 20,
        }),
      );
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
      if (originalScrollTop) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollTop", originalScrollTop);
      } else {
        delete (HTMLDivElement.prototype as { scrollTop?: unknown }).scrollTop;
      }
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
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
