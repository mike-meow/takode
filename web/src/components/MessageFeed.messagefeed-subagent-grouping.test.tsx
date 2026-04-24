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
