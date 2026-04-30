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
import type { ChatMessage, ThreadAttachmentMarker } from "../types.js";
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
const mockRequestScrollToMessage = vi.fn();
const mockSetExpandAllInTurn = vi.fn();
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
      sessionBoards: mockStoreValues.sessionBoards ?? new Map(),
      sessionCompletedBoards: mockStoreValues.sessionCompletedBoards ?? new Map(),
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
    requestScrollToMessage: mockRequestScrollToMessage,
    setExpandAllInTurn: mockSetExpandAllInTurn,
    sessionNotifications: mockStoreValues.sessionNotifications ?? new Map(),
    sessionAttentionRecords: mockStoreValues.sessionAttentionRecords ?? new Map(),
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

function hiddenThreadMessages(threadKey: string, count: number, idPrefix: string): ChatMessage[] {
  return Array.from({ length: count }, (_, index) =>
    makeMessage({
      id: `${idPrefix}-${index}`,
      role: "assistant",
      content: `${threadKey} hidden update ${index}`,
      metadata: { threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }] },
    }),
  );
}

function expectTextContent(element: Element, text: string) {
  expect(element.textContent).toContain(text);
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

function setStoreAttentionRecords(sessionId: string, records: Array<Record<string, unknown>>) {
  const map = new Map();
  map.set(sessionId, records);
  mockStoreValues.sessionAttentionRecords = map;
}

function setStoreBoard(sessionId: string, board: Array<Record<string, unknown>>) {
  const map = new Map();
  map.set(sessionId, board);
  mockStoreValues.sessionBoards = map;
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
  mockRequestScrollToMessage.mockReset();
  mockSetExpandAllInTurn.mockReset();
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
  it("leader sessions render unthreaded Main activity instead of private collapsed activity", () => {
    // Main remains a readable staging thread. Unthreaded leader activity is
    // visible directly instead of being hidden behind a synthetic activity bar.
    const sid = "test-leader-main-full-stream";
    setStoreSdkSessionRole(sid, { isOrchestrator: true });
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Coordinate workers" }),
      makeMessage({ id: "a1", role: "assistant", content: "Private orchestration detail" }),
      makeMessage({ id: "a2", role: "assistant", content: "Published leader update" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Coordinate workers")).toBeTruthy();
    expect(screen.getByText("Private orchestration detail")).toBeTruthy();
    expect(screen.getByText("Published leader update")).toBeTruthy();
    expect(screen.queryByText("Leader activity")).toBeNull();
  });

  it("keeps explicitly routed quest messages out of Main", () => {
    // Clean Main excludes messages with explicit non-main route metadata while
    // avoiding compact quest activity markers that look like Main activity.
    const sid = "test-main-clean-explicit-route";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Main-only setup" }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "q-941 routed update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Main-only setup")).toBeTruthy();
    expect(screen.queryByTestId("cross-thread-activity-marker")).toBeNull();
    expect(screen.queryByText("q-941 routed update")).toBeNull();
  });

  it("keeps explicitly routed quest messages visible in their quest thread and All Threads", () => {
    const sid = "test-quest-routed-visibility";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Main-only setup" }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "q-941 routed update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);

    const questView = render(<MessageFeed sessionId={sid} threadKey="q-941" />);
    expect(screen.getByText("q-941 routed update")).toBeTruthy();
    expect(screen.queryByText("Main-only setup")).toBeNull();
    questView.unmount();

    render(<MessageFeed sessionId={sid} threadKey="all" />);
    expect(screen.getByText("q-941 routed update")).toBeTruthy();
    expect(screen.getByText("Main-only setup")).toBeTruthy();
  });

  it("keeps quest-scoped herd event injections out of Main without activity markers", () => {
    const sid = "test-main-no-herd-thread-markers";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Main-only setup" }),
      makeMessage({
        id: "herd-q998",
        role: "user",
        content: "6 activities in q-998",
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
        metadata: { threadRefs: [{ threadKey: "q-998", questId: "q-998", source: "inferred" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Main-only setup")).toBeTruthy();
    expect(screen.queryByTestId("cross-thread-activity-marker")).toBeNull();
    expect(screen.queryByText("6 activities in q-998")).toBeNull();
  });

  it("recovers legacy Main-routed herd messages from transcript target content", () => {
    const sid = "test-main-legacy-herd-content-route";
    const content = [
      "1 event from 1 session",
      "",
      "#1323 | turn_end | ✓ 1m 52s | tools: 29 | [350]-[414] | 1 user msg [350]",
      '[350] leader: "Review [q-1005](quest:q-1005) in the Outcome Review phase.',
      '[414] "ACCEPT: screenshots show `q-99` inserted after Main for [q-1005](quest:q-1005)."',
    ].join("\n");
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Main-only setup" }),
      makeMessage({
        id: "herd-q1005",
        role: "user",
        content,
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
        metadata: { threadKey: "main" },
      }),
    ]);

    const mainView = render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Main-only setup")).toBeTruthy();
    expect(screen.queryByText("Outcome Review phase.")).toBeNull();
    expect(screen.queryByTestId("cross-thread-activity-marker")).toBeNull();
    mainView.unmount();

    const questView = render(<MessageFeed sessionId={sid} threadKey="q-1005" />);
    expect(screen.getByText("#1323")).toBeTruthy();
    questView.unmount();

    render(<MessageFeed sessionId={sid} threadKey="all" />);
    expect(screen.getByText("#1323")).toBeTruthy();
  });

  it("shows marker-backed attachment summaries in Main and hides the covered backfill messages", () => {
    // A persisted attachment marker is the compatibility boundary: Main keeps
    // the summary row but removes the moved/attached backfill content.
    const sid = "test-main-marker-backed-backfill";
    const marker = {
      type: "thread_attachment_marker" as const,
      id: "marker-q-941",
      timestamp: 3,
      markerKey: "thread-attachment:q-941:m-backfill",
      threadKey: "q-941",
      questId: "q-941",
      attachedAt: 3,
      attachedBy: "session-1",
      messageIds: ["m-backfill"],
      messageIndices: [1],
      ranges: ["1"],
      count: 1,
      firstMessageId: "m-backfill",
      firstMessageIndex: 1,
    };
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

  it("keeps old unmarked backfill references visible in Main", () => {
    // Older sessions may have backfill threadRefs without a marker. Without the
    // marker boundary, Main preserves historical visibility.
    const sid = "test-main-old-backfill-compat";
    setStoreMessages(sid, [
      makeMessage({
        id: "m-old-backfill",
        role: "assistant",
        content: "Old backfill still visible",
        historyIndex: 1,
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "backfill" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Old backfill still visible")).toBeTruthy();
  });

  it("renders All Threads as the global view", () => {
    const sid = "test-all-threads-global-view";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Main-only setup" }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "q-941 routed update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="all" />);

    expect(screen.getByText("Main-only setup")).toBeTruthy();
    expect(screen.getByText("q-941 routed update")).toBeTruthy();
    expect(screen.queryByTestId("cross-thread-activity-marker")).toBeNull();
  });

  it("keeps same-thread badges hidden in Main while leaving the messages visible", () => {
    const sid = "test-main-hides-redundant-thread-badges";
    setStoreMessages(sid, [
      makeMessage({
        id: "u-main",
        role: "user",
        content: "Main dispatch",
        metadata: { threadKey: "main" },
      }),
      makeMessage({
        id: "a-main",
        role: "assistant",
        content: "Main response",
        contentBlocks: [{ type: "text", text: "Main response" }],
        metadata: { threadKey: "main" },
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Main dispatch")).toBeTruthy();
    expect(screen.getByText("Main response")).toBeTruthy();
    expect(screen.queryByTestId("thread-source-badge")).toBeNull();
  });

  it("keeps thread badges visible in All Threads because it has no single selected thread", () => {
    const sid = "test-all-threads-keeps-thread-badges";
    setStoreMessages(sid, [
      makeMessage({
        id: "u-main",
        role: "user",
        content: "Main dispatch",
        metadata: { threadKey: "main" },
      }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "q-941 routed update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="all" />);

    expect(screen.getByText("Main dispatch")).toBeTruthy();
    expect(screen.getByText("q-941 routed update")).toBeTruthy();
    expect(screen.getAllByTestId("thread-source-badge").map((badge) => badge.textContent)).toEqual([
      "[thread:main]",
      "[thread:q-941]",
    ]);
  });

  it("suppresses hidden quest activity markers including the triggering routed user message", () => {
    const sid = "test-main-hidden-activity-group";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main", role: "user", content: "Main-only setup" }),
      makeMessage({
        id: "u-q975",
        role: "user",
        content: "Hidden q-975 user trigger",
        metadata: { threadRefs: [{ threadKey: "q-975", questId: "q-975", source: "explicit" }] },
      }),
      makeMessage({
        id: "a-q975",
        role: "assistant",
        content: "Hidden q-975 assistant response",
        metadata: { threadRefs: [{ threadKey: "q-975", questId: "q-975", source: "explicit" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} onSelectThread={vi.fn()} />);

    expect(screen.getByText("Main-only setup")).toBeTruthy();
    expect(screen.queryByTestId("cross-thread-activity-marker")).toBeNull();
    expect(screen.queryByText("Hidden q-975 user trigger")).toBeNull();
    expect(screen.queryByText("Hidden q-975 assistant response")).toBeNull();
    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
  });

  it("does not duplicate active needs-input notifications as Main ledger rows", () => {
    const sid = "test-main-attention-ledger-notification";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main", role: "user", content: "Coordinate active quests", timestamp: 100 }),
      makeMessage({
        id: "a-q983",
        role: "assistant",
        content: "Hidden q-983 implementation note",
        timestamp: 110,
        metadata: { threadRefs: [{ threadKey: "q-983", questId: "q-983", source: "explicit" }] },
      }),
    ]);
    setStoreNotifications(sid, [
      {
        id: "n-q983",
        category: "needs-input",
        summary: "Approve the implementation direction",
        timestamp: 120,
        messageId: "a-q983",
        threadKey: "q-983",
        questId: "q-983",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
    expect(screen.queryByText("Approve the implementation direction")).toBeNull();
    expect(screen.queryByText("Hidden q-983 implementation note")).toBeNull();
    expect(screen.queryByTestId("cross-thread-activity-marker")).toBeNull();
  });

  it("keeps resolved attention ledger rows visible with resolved state", () => {
    const sid = "test-main-attention-ledger-resolved";
    setStoreMessages(sid, [makeMessage({ id: "u-main", role: "user", content: "Coordinate active quests" })]);
    setStoreNotifications(sid, [
      {
        id: "n-review",
        category: "review",
        summary: "q-983 ready for review",
        timestamp: 120,
        messageId: null,
        threadKey: "q-983",
        questId: "q-983",
        done: true,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    const row = screen.getByTestId("attention-ledger-row");
    expect(row.getAttribute("data-attention-state")).toBe("resolved");
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.queryByText(/ready for review/i)).toBeNull();
    expect(screen.getByText("Resolved")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("renders review ledger rows with compact finished copy and no duplicate summary", () => {
    const sid = "test-main-attention-ledger-review-finished";
    setStoreMessages(sid, [makeMessage({ id: "u-main", role: "user", content: "Coordinate active quests" })]);
    setStoreNotifications(sid, [
      {
        id: "n-review",
        category: "review",
        summary: "q-983 ready for review: Compact notification cards",
        timestamp: 120,
        messageId: null,
        threadKey: "q-983",
        questId: "q-983",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    const row = screen.getByTestId("attention-ledger-row");
    expect(row.textContent).toContain("Finished: Compact notification cards");
    expect(row.textContent).toContain("q-983");
    expect(row.textContent?.match(/Compact notification cards/g)).toHaveLength(1);
    expect(screen.queryByText(/ready for review/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  });

  it("renders server-authoritative attention lifecycle records from the live store", () => {
    // `seen`, `dismissed`, and `superseded` are not notification states. Main
    // must render them from the shared server-authoritative record collection.
    const sid = "test-main-attention-ledger-live-records";
    setStoreMessages(sid, [makeMessage({ id: "u-main", role: "user", content: "Coordinate active quests" })]);
    setStoreAttentionRecords(sid, [
      {
        id: "manual-seen",
        leaderSessionId: sid,
        type: "needs_input",
        source: { kind: "manual", id: "manual-seen" },
        questId: "q-983",
        threadKey: "q-983",
        title: "Implementation direction seen",
        summary: "Still unresolved after being seen",
        actionLabel: "Answer",
        priority: "needs_input",
        state: "seen",
        createdAt: 120,
        updatedAt: 140,
        route: { threadKey: "q-983", questId: "q-983" },
        chipEligible: true,
        ledgerEligible: true,
        dedupeKey: "manual-seen",
      },
      {
        id: "manual-dismissed",
        leaderSessionId: sid,
        type: "blocked_user_resolvable",
        source: { kind: "manual", id: "manual-dismissed" },
        questId: "q-984",
        threadKey: "q-984",
        title: "External unblock dismissed",
        summary: "Dismissed without resolving",
        actionLabel: "Open",
        priority: "blocked",
        state: "dismissed",
        createdAt: 130,
        updatedAt: 150,
        dismissedAt: 150,
        route: { threadKey: "q-984", questId: "q-984" },
        chipEligible: true,
        ledgerEligible: true,
        dedupeKey: "manual-dismissed",
      },
      {
        id: "manual-superseded",
        leaderSessionId: sid,
        type: "quest_reopened_or_rework",
        source: { kind: "manual", id: "manual-superseded" },
        questId: "q-975",
        threadKey: "q-975",
        title: "Older rework request",
        summary: "Superseded by a newer request",
        actionLabel: "Open",
        priority: "milestone",
        state: "superseded",
        createdAt: 140,
        updatedAt: 160,
        route: { threadKey: "q-975", questId: "q-975" },
        chipEligible: false,
        ledgerEligible: true,
        dedupeKey: "manual-superseded",
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    const rows = screen.getAllByTestId("attention-ledger-row");
    expect(rows.map((row) => row.getAttribute("data-attention-state"))).toEqual(["seen", "dismissed", "superseded"]);
    expect(screen.getByText("Seen")).toBeTruthy();
    expect(screen.getByText("Dismissed")).toBeTruthy();
    expect(screen.getByText("Superseded")).toBeTruthy();
  });

  it("surfaces routed user rework feedback as a low-priority Main ledger milestone", () => {
    const sid = "test-main-attention-ledger-rework-message";
    setStoreMessages(sid, [
      makeMessage({ id: "u-main", role: "user", content: "Main coordination", timestamp: 100 }),
      makeMessage({
        id: "msg-9248",
        role: "user",
        content:
          "This looks horrible. Please ask the agent to fix this. All consecutive hidden activities should be merged.",
        timestamp: 120,
        metadata: { threadRefs: [{ threadKey: "q-975", questId: "q-975", source: "explicit" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    const row = screen.getByTestId("attention-ledger-row");
    expect(row.getAttribute("data-attention-type")).toBe("quest_reopened_or_rework");
    expect(row.getAttribute("data-attention-state")).toBe("reopened");
    expect(screen.getByText("Reopened")).toBeTruthy();
    expect(screen.getByText("q-975: rework requested")).toBeTruthy();
  });

  it("renders board wait-for-input as attention without promoting ordinary wait-for dependencies", () => {
    const sid = "test-main-attention-ledger-board-wait";
    setStoreMessages(sid, [makeMessage({ id: "u-main", role: "user", content: "Coordinate active quests" })]);
    setStoreBoard(sid, [
      {
        questId: "q-983",
        title: "Implement Main attention ledger rows",
        waitForInput: ["n-missing"],
        updatedAt: 120,
      },
      {
        questId: "q-984",
        title: "Implement compact chips",
        waitFor: ["free-worker"],
        updatedAt: 140,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByTestId("attention-ledger-row").getAttribute("data-attention-type")).toBe("needs_input");
    expect(screen.getByText("q-983: Implement Main attention ledger rows")).toBeTruthy();
    expect(screen.getByText("Waiting for input: n-missing")).toBeTruthy();
    expect(screen.queryByText("q-984: Implement compact chips")).toBeNull();
  });

  it("merges consecutive hidden non-quest Main activity markers across destination threads", () => {
    // Non-quest routed activity still keeps the sparse awareness marker; quest
    // activity is suppressed in Main so it cannot look like Main timeline work.
    const sid = "test-main-hidden-activity-multi-thread-group";
    const onSelectThread = vi.fn();
    setStoreMessages(sid, [
      makeMessage({ id: "u-main", role: "user", content: "Main-only setup" }),
      makeMessage({
        id: "a-side-a-1",
        role: "assistant",
        content: "Hidden side-a first update",
        metadata: { threadRefs: [{ threadKey: "side-a", source: "explicit" }] },
      }),
      makeMessage({
        id: "a-side-a-2",
        role: "assistant",
        content: "Hidden side-a second update",
        metadata: { threadRefs: [{ threadKey: "side-a", source: "explicit" }] },
      }),
      makeMessage({
        id: "a-side-b",
        role: "assistant",
        content: "Hidden side-b update",
        metadata: { threadRefs: [{ threadKey: "side-b", source: "explicit" }] },
      }),
      makeMessage({
        id: "a-side-c",
        role: "assistant",
        content: "Hidden side-c update",
        metadata: { threadRefs: [{ threadKey: "side-c", source: "explicit" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} onSelectThread={onSelectThread} />);

    expect(screen.getAllByTestId("cross-thread-activity-marker")).toHaveLength(1);
    expect(screen.getByText("4 activities in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "thread:side-a" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "thread:side-b" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "thread:side-c" })).toBeTruthy();
    expect(screen.queryByText("Hidden side-a first update")).toBeNull();
    expect(screen.queryByText("Hidden side-b update")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "thread:side-b" }));
    expect(onSelectThread).toHaveBeenCalledWith("side-b");
  });

  it("keeps screenshot-style moved-message clusters while suppressing quest activity rows", () => {
    // Attachment markers are explicit Main actions and remain visible; hidden
    // quest activity around them does not produce compact Main activity rows.
    const sid = "test-main-thread-marker-mixed-cluster";
    const onSelectThread = vi.fn();
    const markerA = movedMarker({
      id: "marker-q-1006-a",
      threadKey: "q-1006",
      timestamp: 11,
      count: 6,
      messageIds: ["m1", "m2", "m3", "m4", "m5", "m6"],
      messageIndices: [1, 2, 3, 4, 5, 6],
      ranges: ["1-6"],
    });
    const markerB = movedMarker({
      id: "marker-q-1006-b",
      threadKey: "q-1006",
      timestamp: 13,
      count: 9,
      messageIds: ["m7", "m8", "m9"],
      messageIndices: [7, 8, 9],
      ranges: ["7-15"],
    });
    setStoreMessages(sid, [
      ...hiddenThreadMessages("q-1003", 4, "q1003-before"),
      ...hiddenThreadMessages("q-1004", 6, "q1004-before"),
      makeMessage({
        id: markerA.id,
        role: "system",
        content: "6 messages moved to q-1006",
        timestamp: markerA.timestamp,
        metadata: { threadAttachmentMarker: markerA },
      }),
      ...hiddenThreadMessages("q-1006", 1, "q1006-middle"),
      makeMessage({
        id: markerB.id,
        role: "system",
        content: "9 messages moved to q-1006",
        timestamp: markerB.timestamp,
        metadata: { threadAttachmentMarker: markerB },
      }),
      ...hiddenThreadMessages("q-1006", 8, "q1006-after"),
      ...hiddenThreadMessages("q-1003", 4, "q1003-after"),
    ]);

    render(<MessageFeed sessionId={sid} onSelectThread={onSelectThread} />);

    const marker = screen.getByTestId("thread-attachment-marker");
    expect(screen.queryByText("Jump")).toBeNull();
    expectTextContent(marker, "15 messages moved to thread:q-1006");
    expect(marker.textContent).not.toContain("activities in thread:");
    expect(screen.getAllByRole("button", { name: "thread:q-1006" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole("button", { name: "thread:q-1006" })[0]);
    expect(onSelectThread).toHaveBeenCalledWith("q-1006");

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const details = screen.getByTestId("thread-marker-cluster-details");
    expectTextContent(details, "6 messages moved to thread:q-1006");
    expectTextContent(details, "9 messages moved to thread:q-1006");
    expect(details.textContent).not.toContain("activities in thread:");
  });

  it("stops thread-system marker clusters at ordinary visible content", () => {
    // Ordinary chat content is the visual boundary. Markers on either side
    // should not merge across it.
    const sid = "test-main-hidden-activity-boundaries";
    const marker = {
      type: "thread_attachment_marker" as const,
      id: "marker-q-972",
      timestamp: 2,
      markerKey: "thread-attachment:q-972:m1",
      threadKey: "q-972",
      questId: "q-972",
      attachedAt: 2,
      attachedBy: "session-1",
      messageIds: ["m1"],
      messageIndices: [1],
      ranges: ["1"],
      count: 1,
    };
    setStoreMessages(sid, [
      makeMessage({
        id: "a-q968",
        role: "assistant",
        content: "Hidden q-968 update",
        metadata: { threadRefs: [{ threadKey: "q-968", questId: "q-968", source: "explicit" }] },
      }),
      makeMessage({
        id: marker.id,
        role: "system",
        content: "1 message moved to q-972",
        timestamp: marker.timestamp,
        metadata: { threadAttachmentMarker: marker },
      }),
      makeMessage({
        id: "a-q976",
        role: "assistant",
        content: "Hidden q-976 update",
        metadata: { threadRefs: [{ threadKey: "q-976", questId: "q-976", source: "explicit" }] },
      }),
      makeMessage({ id: "u-main-visible", role: "user", content: "Visible Main boundary" }),
      makeMessage({
        id: "a-q980",
        role: "assistant",
        content: "Hidden q-980 update",
        metadata: { threadRefs: [{ threadKey: "q-980", questId: "q-980", source: "explicit" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} onSelectThread={vi.fn()} />);

    expect(screen.queryByTestId("thread-system-marker-cluster")).toBeNull();
    expect(screen.queryByTestId("cross-thread-activity-marker")).toBeNull();
    expect(screen.getByText("Visible Main boundary")).toBeTruthy();
    expectTextContent(screen.getByTestId("thread-attachment-marker"), "1 message moved to thread:q-972");
    expect(screen.queryByText("Hidden q-968 update")).toBeNull();
    expect(screen.queryByText("Hidden q-976 update")).toBeNull();
    expect(screen.queryByText("Hidden q-980 update")).toBeNull();
  });

  it("uses moved marker destination links to select the destination thread", () => {
    const sid = "test-marker-selects-thread";
    const onSelectThread = vi.fn();
    const marker = {
      type: "thread_attachment_marker" as const,
      id: "marker-q-941",
      timestamp: 1,
      markerKey: "thread-attachment:q-941:m1",
      threadKey: "q-941",
      questId: "q-941",
      attachedAt: 1,
      attachedBy: "session-1",
      messageIds: ["m1"],
      messageIndices: [1],
      ranges: ["1"],
      count: 1,
    };
    setStoreMessages(sid, [
      makeMessage({
        id: marker.id,
        role: "system",
        content: "1 message moved to q-941",
        timestamp: marker.timestamp,
        variant: "info",
        metadata: { threadAttachmentMarker: marker },
      }),
    ]);

    render(<MessageFeed sessionId={sid} onSelectThread={onSelectThread} />);
    fireEvent.click(screen.getByRole("button", { name: "thread:q-941" }));

    expect(onSelectThread).toHaveBeenCalledWith("q-941");
    expect(screen.queryByText("Jump")).toBeNull();
  });

  it("groups move-only marker clusters across multiple destinations", () => {
    const sid = "test-grouped-moved-marker-destinations";
    const markerA = movedMarker({ id: "marker-a", threadKey: "q-1006", count: 15, ranges: ["1-15"] });
    const markerB = movedMarker({ id: "marker-b", threadKey: "q-1008", count: 4, ranges: ["16-19"] });
    setStoreMessages(sid, [
      makeMessage({
        id: markerA.id,
        role: "system",
        content: "15 messages moved to q-1006",
        timestamp: markerA.timestamp,
        metadata: { threadAttachmentMarker: markerA },
      }),
      makeMessage({
        id: markerB.id,
        role: "system",
        content: "4 messages moved to q-1008",
        timestamp: markerB.timestamp,
        metadata: { threadAttachmentMarker: markerB },
      }),
    ]);

    render(<MessageFeed sessionId={sid} onSelectThread={vi.fn()} />);

    const cluster = screen.getByTestId("thread-attachment-marker");
    expectTextContent(cluster, "15 messages moved to thread:q-1006, 4 to thread:q-1008");
    expect(screen.getByRole("button", { name: "thread:q-1006" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "thread:q-1008" })).toBeTruthy();
  });

  it("suppresses activity-only marker clusters for quest destinations", () => {
    const sid = "test-activity-only-marker-cluster";
    setStoreMessages(sid, [
      ...hiddenThreadMessages("q-1003", 10, "activity-q1003"),
      ...hiddenThreadMessages("q-1004", 14, "activity-q1004"),
    ]);

    render(<MessageFeed sessionId={sid} onSelectThread={vi.fn()} />);

    expect(screen.queryByTestId("cross-thread-activity-marker")).toBeNull();
    expect(screen.queryByText("q-1003 hidden update 0")).toBeNull();
    expect(screen.queryByText("q-1004 hidden update 0")).toBeNull();
  });

  it("groups adjacent moved-message markers and expands chronological details", () => {
    const sid = "test-grouped-moved-markers";
    const markerA = {
      type: "thread_attachment_marker" as const,
      id: "marker-a",
      timestamp: 1,
      markerKey: "thread-attachment:q-972:a",
      threadKey: "q-972",
      questId: "q-972",
      attachedAt: 1,
      attachedBy: "session-1",
      messageIds: ["m1", "m2"],
      messageIndices: [1, 2],
      ranges: ["1-2"],
      count: 2,
    };
    const markerB = {
      type: "thread_attachment_marker" as const,
      id: "marker-b",
      timestamp: 2,
      markerKey: "thread-attachment:q-972:b",
      threadKey: "q-972",
      questId: "q-972",
      attachedAt: 2,
      attachedBy: "session-1",
      messageIds: ["m3"],
      messageIndices: [3],
      ranges: ["3"],
      count: 1,
    };
    setStoreMessages(sid, [
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

    render(<MessageFeed sessionId={sid} onSelectThread={vi.fn()} />);

    expect(screen.getAllByTestId("thread-attachment-marker")).toHaveLength(1);
    expectTextContent(screen.getByTestId("thread-attachment-marker"), "3 messages moved to thread:q-972");

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const details = screen.getByTestId("thread-marker-cluster-details");
    expect(details.textContent?.indexOf("2 messages moved to thread:q-972")).toBeLessThan(
      details.textContent?.indexOf("1 message moved to thread:q-972") ?? Number.POSITIVE_INFINITY,
    );
    expectTextContent(details, "Ranges: 1-2");
    expectTextContent(details, "Ranges: 3");
    expectTextContent(details, "Message ids: m1, m2");
    expectTextContent(details, "Message ids: m3");
  });

  it("filters quest-thread views to associated messages while Main stays implicit", () => {
    // Quest threads are metadata projections over the flat history. Unrelated
    // Main messages remain out of the selected quest view.
    const sid = "test-quest-thread-filter";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Main-only setup" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "q-941 routed update",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        content: "q-942 routed update",
        metadata: { threadRefs: [{ threadKey: "q-942", questId: "q-942", source: "explicit" }] },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-941" />);

    expect(screen.getByText("q-941 routed update")).toBeTruthy();
    expect(screen.queryByText("q-942 routed update")).toBeNull();
    expect(screen.queryByText("Main-only setup")).toBeNull();
  });

  it("shows user-composed quest-thread messages and subsequent routed assistant messages", () => {
    const sid = "test-quest-thread-user-and-assistant";
    setStoreMessages(sid, [
      makeMessage({
        id: "u-q941",
        role: "user",
        content: "User reply from the q-941 thread",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
      makeMessage({
        id: "a-q941",
        role: "assistant",
        content: "Leader response routed to q-941",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
      makeMessage({ id: "a-main", role: "assistant", content: "Unrelated Main update" }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-941" />);

    expect(screen.getByText("User reply from the q-941 thread")).toBeTruthy();
    expect(screen.getByText("Leader response routed to q-941")).toBeTruthy();
    expect(screen.queryByText("Unrelated Main update")).toBeNull();
    expect(screen.queryByTestId("thread-source-badge")).toBeNull();
  });

  it("keeps moved and cross-thread provenance badges in quest-thread views", () => {
    const sid = "test-quest-thread-keeps-provenance-badges";
    setStoreMessages(sid, [
      makeMessage({
        id: "a-backfill",
        role: "assistant",
        content: "Attached historical context",
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "backfill" }] },
      }),
      makeMessage({
        id: "a-cross",
        role: "assistant",
        content: "Cross-thread origin context",
        metadata: {
          threadKey: "q-942",
          questId: "q-942",
          threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
        },
      }),
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-941" />);

    expect(screen.getByText("Attached historical context")).toBeTruthy();
    expect(screen.getByText("Cross-thread origin context")).toBeTruthy();
    expect(screen.getAllByTestId("thread-source-badge").map((badge) => badge.textContent)).toEqual([
      "[thread:q-941]",
      "[thread:q-942]",
    ]);
  });

  it("projects routed Bash tool groups and filters unrelated live progress in quest-thread views", () => {
    const sid = "test-quest-thread-tool-group";
    setStoreSessionBackend(sid, "claude");
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Main-only setup" }),
      makeMessage({
        id: "a-tool",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-routed", name: "Bash", input: { command: "pwd" } }],
        metadata: { threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }] },
      }),
      makeMessage({
        id: "a-result",
        role: "assistant",
        content: "tool result",
        contentBlocks: [{ type: "tool_result", tool_use_id: "tu-routed", content: "workspace path" }],
      }),
      makeMessage({
        id: "a-other-tool",
        role: "assistant",
        content: "",
        contentBlocks: [{ type: "tool_use", id: "tu-other", name: "Bash", input: { command: "date" } }],
        metadata: { threadRefs: [{ threadKey: "q-942", questId: "q-942", source: "explicit" }] },
      }),
    ]);
    setStoreToolProgress(sid, [
      { toolUseId: "tu-routed", toolName: "Bash", elapsedSeconds: 12 },
      { toolUseId: "tu-other", toolName: "Bash", elapsedSeconds: 34 },
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-941" />);

    expect(screen.getByText("pwd")).toBeTruthy();
    expect(screen.getByText("workspace path")).toBeTruthy();
    expect(screen.getAllByText("12s").length).toBeGreaterThan(0);
    expect(screen.queryByText("date")).toBeNull();
    expect(screen.queryByText("34s")).toBeNull();
    expect(screen.queryByText("Main-only setup")).toBeNull();
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
