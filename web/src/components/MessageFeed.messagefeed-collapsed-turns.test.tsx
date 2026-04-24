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
