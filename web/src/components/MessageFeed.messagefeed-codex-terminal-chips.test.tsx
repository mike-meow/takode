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
