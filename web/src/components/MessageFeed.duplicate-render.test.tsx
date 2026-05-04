// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockScrollIntoView = vi.fn();
const mockScrollTo = vi.fn();
const mediaState = { touchDevice: false };
const mockStoreValues: Record<string, unknown> = {};

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

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("remark-gfm", () => ({
  default: {},
}));

vi.mock("../ws.js", () => ({
  sendToSession: vi.fn(() => true),
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
      scrollToTurnId: mockStoreValues.scrollToTurnId ?? new Map(),
      clearScrollToTurn: vi.fn(),
      scrollToMessageId: mockStoreValues.scrollToMessageId ?? new Map(),
      clearScrollToMessage: vi.fn(),
      expandAllInTurn: mockStoreValues.expandAllInTurn ?? new Map(),
      clearExpandAllInTurn: vi.fn(),
      bottomAlignNextUserMessage: mockStoreValues.bottomAlignNextUserMessage ?? new Set(),
      sessionTaskHistory: mockStoreValues.sessionTaskHistory ?? new Map(),
      pendingUserUploads: mockStoreValues.pendingUserUploads ?? new Map(),
      pendingCodexInputs: mockStoreValues.pendingCodexInputs ?? new Map(),
      activeTaskTurnId: mockStoreValues.activeTaskTurnId ?? new Map(),
      setActiveTaskTurnId: vi.fn(),
      backgroundAgentNotifs: mockStoreValues.backgroundAgentNotifs ?? new Map(),
      sessionNotifications: mockStoreValues.sessionNotifications ?? new Map(),
      sessionAttentionRecords: mockStoreValues.sessionAttentionRecords ?? new Map(),
      sessionSearch: mockStoreValues.sessionSearch ?? new Map(),
      quests: mockStoreValues.quests ?? [],
      toggleTurnActivity: vi.fn(),
    };
    return selector(state);
  };
  useStore.getState = () => ({
    feedScrollPosition: mockStoreValues.feedScrollPosition ?? new Map(),
    setFeedScrollPosition: vi.fn(),
    collapseAllTurnActivity: vi.fn(),
    setCollapsibleTurnIds: vi.fn(),
    turnActivityOverrides: mockStoreValues.turnActivityOverrides ?? new Map(),
    autoExpandedTurnIds: mockStoreValues.autoExpandedTurnIds ?? new Map(),
    toggleTurnActivity: vi.fn(),
    focusTurn: vi.fn(),
    keepTurnExpanded: vi.fn(),
    clearBottomAlignOnNextUserMessage: vi.fn(),
    setComposerDraft: vi.fn(),
    requestScrollToMessage: vi.fn(),
    setExpandAllInTurn: vi.fn(),
    openQuestOverlay: vi.fn(),
    removePendingUserUpload: vi.fn(),
    updatePendingUserUpload: vi.fn(),
    focusComposer: vi.fn(),
  });
  return {
    useStore,
    getSessionSearchState: () => ({
      query: "",
      isOpen: false,
      mode: "strict",
      category: "all",
      matches: [],
      currentMatchIndex: -1,
    }),
  };
});

import { render, screen } from "@testing-library/react";
import type { ChatMessage, SessionAttentionRecord } from "../types.js";
import { MessageFeed } from "./MessageFeed.js";

function makeMessage(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"] }): ChatMessage {
  return {
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

function setStoreMessages(sessionId: string, messages: ChatMessage[]) {
  mockStoreValues.messages = new Map([[sessionId, messages]]);
}

function setStoreNotifications(sessionId: string, notifications: Array<Record<string, unknown>>) {
  mockStoreValues.sessionNotifications = new Map([[sessionId, notifications]]);
}

function makeJourneyFinishedRecord(overrides: Partial<SessionAttentionRecord> = {}): SessionAttentionRecord {
  const createdAt = overrides.createdAt ?? Date.now();
  return {
    id: "notification:n-journey-finished",
    leaderSessionId: "leader-1",
    type: "quest_completed_recent",
    source: { kind: "notification", id: "n-journey-finished", questId: "q-1151" },
    questId: "q-1151",
    threadKey: "q-1151",
    title: "Journey finished",
    summary: "Keep Journey chips anchored",
    actionLabel: "Open",
    priority: "review",
    state: "unresolved",
    createdAt,
    updatedAt: createdAt,
    route: { threadKey: "q-1151", questId: "q-1151" },
    chipEligible: false,
    ledgerEligible: true,
    dedupeKey: "notification:n-journey-finished",
    journeyLifecycleStatus: "completed",
    ...overrides,
  };
}

describe("MessageFeed duplicate rendering regression", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockStoreValues)) delete mockStoreValues[key];
    mockScrollIntoView.mockReset();
    mockScrollTo.mockReset();
  });

  it("renders a notification-bearing assistant message only once when a herd event follows it", () => {
    // q-524: collapsed-slot precedence must keep a notification-bearing
    // assistant message out of subConclusions so it only renders once.
    const sid = "test-collapsed-notification-no-duplicate";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "What should we dispatch next?" }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "q-514 is complete and q-521 is unblocked.",
        notification: {
          category: "review",
          timestamp: Date.now(),
          summary: "q-521 can be dispatched now",
        },
      }),
      makeMessage({
        id: "h1",
        role: "user",
        content: "#514 | wait_for_resolved | ✓ q-521 unblocked",
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      }),
      makeMessage({ id: "u2", role: "user", content: "Thanks" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getAllByText("q-514 is complete and q-521 is unblocked.")).toHaveLength(1);
    expect(screen.getAllByText("q-521 can be dispatched now")).toHaveLength(1);
  });

  it("keeps a Journey-finished chip in chronological order inside a collapsed turn", () => {
    const sid = "test-collapsed-journey-finished-order";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Coordinate the Journey" }),
      makeMessage({
        id: "a-before",
        role: "assistant",
        content: "Priority update before the Journey finished",
        notification: { category: "review", timestamp: Date.now(), summary: "q-1150 ready for review" },
      }),
      makeMessage({ id: "a-private-before", role: "assistant", content: "Hidden private activity before finish" }),
      makeMessage({
        id: "journey-finished",
        role: "system",
        content: "Open: Journey finished",
        variant: "info",
        metadata: { attentionRecord: makeJourneyFinishedRecord() },
      }),
      makeMessage({ id: "a-private-after", role: "assistant", content: "Hidden private activity after finish" }),
      makeMessage({ id: "a-after", role: "assistant", content: "Visible final update after the Journey finished" }),
      makeMessage({ id: "u2", role: "user", content: "Next request" }),
    ]);

    render(<MessageFeed sessionId={sid} />);

    const before = screen.getByText("Priority update before the Journey finished");
    const journey = screen.getByText("Journey finished");
    const after = screen.getByText("Visible final update after the Journey finished");
    const collapsedCard = after.closest(".rounded-xl");

    expect(collapsedCard).toBeTruthy();
    expect(before.closest(".rounded-xl")).toBe(collapsedCard);
    expect(journey.closest(".rounded-xl")).toBe(collapsedCard);
    expect(screen.queryByText("Hidden private activity before finish")).toBeNull();
    expect(screen.queryByText("Hidden private activity after finish")).toBeNull();

    const text = collapsedCard?.textContent ?? "";
    expect(text.indexOf("Priority update before the Journey finished")).toBeLessThan(text.indexOf("Journey finished"));
    expect(text.indexOf("Journey finished")).toBeLessThan(
      text.indexOf("Visible final update after the Journey finished"),
    );
  });

  it("renders a tool-only notification-bearing assistant as one rich review banner", () => {
    // q-568: once a `takode notify` call has an anchored notification, the
    // message must stay a full assistant message so the banner survives and the
    // fallback notify chip does not render alongside it.
    const sid = "test-tool-only-notification-single-chip";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Tell me when the fix is ready." }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-review-single-chip",
            name: "Bash",
            input: { command: 'TAKODE_API_PORT=3455 takode notify review "q-568 single rich chip"' },
          },
        ],
        notification: {
          category: "review",
          timestamp: Date.now(),
          summary: "q-568 single rich chip",
        },
      }),
      makeMessage({ id: "u2", role: "user", content: "Thanks" }),
    ]);
    setStoreNotifications(sid, [
      {
        id: "n-review-single-chip",
        category: "review",
        timestamp: Date.now(),
        messageId: "a1",
        summary: "q-568 single rich chip",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Mark as reviewed|Mark as not reviewed/ })).toHaveLength(1);
    expect(screen.getAllByText("q-568 single rich chip")).toHaveLength(1);
    expect(screen.queryByText("Ready for review")).toBeNull();
  });

  it("renders the lagged tool-only anchored-store notification as one rich review banner", () => {
    // q-568: exact skeptic-review path. The tool-only assistant message has not
    // received inline `notification` metadata yet, but the store already has a
    // single anchored notification for its message ID.
    const sid = "test-tool-only-lagged-anchored-store";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Tell me when the fix is ready." }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-review-lagged",
            name: "Bash",
            input: { command: 'TAKODE_API_PORT=3455 takode notify review "q-568 single rich chip"' },
          },
        ],
      }),
      makeMessage({ id: "u2", role: "user", content: "Thanks" }),
    ]);
    setStoreNotifications(sid, [
      {
        id: "n-review-lagged",
        category: "review",
        timestamp: Date.now(),
        messageId: "a1",
        summary: "q-568 single rich chip",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Mark as reviewed|Mark as not reviewed/ })).toHaveLength(1);
    expect(screen.getAllByText("q-568 single rich chip")).toHaveLength(1);
    expect(screen.queryByText("Ready for review")).toBeNull();
  });

  it("does not add a Main ledger row for an anchored needs-input notification", () => {
    const sid = "test-tool-only-needs-input-no-ledger";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Tell me if you need a decision." }),
      makeMessage({
        id: "a1",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-needs-input",
            name: "Bash",
            input: { command: 'takode notify needs-input "Pick the dispatch order"' },
          },
        ],
      }),
      makeMessage({ id: "u2", role: "user", content: "Thanks" }),
    ]);
    setStoreNotifications(sid, [
      {
        id: "n-needs-input",
        category: "needs-input",
        timestamp: Date.now(),
        messageId: "a1",
        summary: "Pick the dispatch order",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Mark handled|Mark unhandled/ })).toHaveLength(1);
    expect(screen.getAllByText("Pick the dispatch order")).toHaveLength(1);
  });

  it("keeps a Main needs-input source message visible when selected history windows would otherwise omit it", () => {
    // q-1069: a leader proposal can be older than the bounded Main selected
    // window while its active needs-input notification remains actionable.
    // The anchored source message must stay available so the chip has visible
    // context instead of disappearing with the suppressed Main fallback row.
    const sid = "test-windowed-main-needs-input-source-message";
    setStoreMessages(sid, [
      makeMessage({
        id: "a-proposal",
        role: "assistant",
        content: "Proposed follow-up quest: compact quest lifecycle event chips on mobile without removing content.",
        timestamp: 100,
        historyIndex: 4,
      }),
      makeMessage({
        id: "a-visible-tail",
        role: "assistant",
        content: "I proposed this as a separate follow-up and sent an approval notification.",
        timestamp: 200,
        historyIndex: 25,
      }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([
      [
        sid,
        new Map([
          [
            "main",
            {
              thread_key: "main",
              from_item: 20,
              item_count: 1,
              total_items: 30,
              source_history_length: 20,
              section_item_count: 50,
              visible_item_count: 3,
            },
          ],
        ]),
      ],
    ]);
    mockStoreValues.threadWindowMessages = new Map([
      [
        sid,
        new Map([
          [
            "main",
            [
              makeMessage({
                id: "a-visible-tail",
                role: "assistant",
                content: "I proposed this as a separate follow-up and sent an approval notification.",
                timestamp: 200,
                historyIndex: 25,
              }),
            ],
          ],
        ]),
      ],
    ]);
    setStoreNotifications(sid, [
      {
        id: "114",
        category: "needs-input",
        timestamp: Date.now(),
        messageId: "a-proposal",
        summary: "approve compact quest lifecycle event chip follow-up quest",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(
      screen.getByText(
        "Proposed follow-up quest: compact quest lifecycle event chips on mobile without removing content.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("I proposed this as a separate follow-up and sent an approval notification.")).toBeTruthy();
    expect(screen.getAllByText("approve compact quest lifecycle event chip follow-up quest")).toHaveLength(1);
    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
  });

  it("keeps a Main needs-input source visible when Main opens before its selected window arrives", () => {
    // Opening Main directly can briefly have no installed Main thread window
    // even though raw history and active notifications are already in store.
    // Explicit notification source retention must still win on this cold path
    // so visiting All Threads is not required to reveal the prompt.
    const sid = "test-cold-main-needs-input-source-message";
    setStoreMessages(sid, [
      makeMessage({
        id: "a-checkpoint",
        role: "assistant",
        content: "Self-improvement checkpoint question: should I apply this skill update?",
        timestamp: 100,
        historyIndex: 4,
      }),
      makeMessage({
        id: "a-raw-tail",
        role: "assistant",
        content: "Raw historical Main tail waiting for selected-window hydration.",
        timestamp: 200,
        historyIndex: 25,
      }),
      makeMessage({
        id: "a-live-marker",
        role: "assistant",
        content: "Live reconnect marker in Main.",
        timestamp: 300,
        historyIndex: -1,
      }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([[sid, new Map()]]);
    mockStoreValues.threadWindowMessages = new Map([[sid, new Map()]]);
    setStoreNotifications(sid, [
      {
        id: "n-main-cold",
        category: "needs-input",
        timestamp: Date.now(),
        messageId: "a-checkpoint",
        summary: "Approve self-improvement update for User Checkpoint notification gate",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Self-improvement checkpoint question: should I apply this skill update?")).toBeTruthy();
    expect(screen.getByText("Live reconnect marker in Main.")).toBeTruthy();
    expect(screen.queryByText("Raw historical Main tail waiting for selected-window hydration.")).toBeNull();
    expect(screen.getAllByText("Approve self-improvement update for User Checkpoint notification gate")).toHaveLength(
      1,
    );
    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
  });

  it("does not retain quest-thread needs-input source messages in the Main selected window", () => {
    const sid = "test-windowed-main-excludes-routed-needs-input-source-message";
    setStoreMessages(sid, [
      makeMessage({
        id: "a-q983-plan",
        role: "assistant",
        content: "Plan for q-983: dispatch the worker after user approval.",
        timestamp: 100,
        historyIndex: 4,
      }),
      makeMessage({
        id: "a-main-tail",
        role: "assistant",
        content: "Main feed tail remains visible.",
        timestamp: 200,
        historyIndex: 25,
      }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([
      [
        sid,
        new Map([
          [
            "main",
            {
              thread_key: "main",
              from_item: 20,
              item_count: 1,
              total_items: 30,
              source_history_length: 20,
              section_item_count: 50,
              visible_item_count: 3,
            },
          ],
        ]),
      ],
    ]);
    mockStoreValues.threadWindowMessages = new Map([
      [
        sid,
        new Map([
          [
            "main",
            [
              makeMessage({
                id: "a-main-tail",
                role: "assistant",
                content: "Main feed tail remains visible.",
                timestamp: 200,
                historyIndex: 25,
              }),
            ],
          ],
        ]),
      ],
    ]);
    setStoreNotifications(sid, [
      {
        id: "n-q983",
        category: "needs-input",
        timestamp: Date.now(),
        messageId: "a-q983-plan",
        threadKey: "q-983",
        questId: "q-983",
        summary: "Approve q-983 dispatch plan",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getByText("Main feed tail remains visible.")).toBeTruthy();
    expect(screen.queryByText("Plan for q-983: dispatch the worker after user approval.")).toBeNull();
    expect(screen.queryByText("Approve q-983 dispatch plan")).toBeNull();
  });

  it("shows a routed needs-input source assistant message in its owner thread", () => {
    // The notification chip is only the affordance. When a needs-input
    // notification points at an assistant plan message, the owner thread must
    // recover and show that source content instead of replacing it with a
    // synthetic fallback row.
    const sid = "test-owner-thread-routed-source-message";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Prepare the dispatch plan." }),
      makeMessage({
        id: "a-plan",
        role: "assistant",
        content: "Plan for q-983: dispatch the worker, then wait for review approval.",
      }),
    ]);
    setStoreNotifications(sid, [
      {
        id: "n-q983",
        category: "needs-input",
        timestamp: Date.now(),
        messageId: "a-plan",
        threadKey: "q-983",
        questId: "q-983",
        summary: "Approve q-983 dispatch plan",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-983" />);

    expect(screen.getByText("Plan for q-983: dispatch the worker, then wait for review approval.")).toBeTruthy();
    expect(screen.getAllByText("Approve q-983 dispatch plan")).toHaveLength(1);
    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
  });

  it("recovers a routed needs-input source message from selected thread-window history", () => {
    // Reloaded leader thread windows can omit historical source messages that
    // lack ordinary thread refs. Notification messageId routing must keep the
    // source plan available before projection so the owner thread does not
    // degrade to a synthetic-only approval row.
    const sid = "test-windowed-owner-thread-routed-source-message";
    setStoreMessages(sid, [
      makeMessage({
        id: "a-plan",
        role: "assistant",
        content: "Windowed q-983 plan: approve the implementation direction before dispatch.",
        timestamp: 100,
        historyIndex: 4,
      }),
      makeMessage({
        id: "a-live-tail",
        role: "assistant",
        content: "Unrelated live Main tail",
        timestamp: 200,
        historyIndex: 25,
      }),
    ]);
    mockStoreValues.sessions = new Map([[sid, { isOrchestrator: true }]]);
    mockStoreValues.threadWindows = new Map([
      [
        sid,
        new Map([
          [
            "q-983",
            {
              thread_key: "q-983",
              from_item: 0,
              item_count: 0,
              total_items: 0,
              source_history_length: 20,
              section_item_count: 50,
              visible_item_count: 3,
            },
          ],
        ]),
      ],
    ]);
    mockStoreValues.threadWindowMessages = new Map([[sid, new Map([["q-983", []]])]]);
    setStoreNotifications(sid, [
      {
        id: "n-q983",
        category: "needs-input",
        timestamp: Date.now(),
        messageId: "a-plan",
        threadKey: "q-983",
        questId: "q-983",
        summary: "Approve q-983 implementation direction",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-983" />);

    expect(screen.getByText("Windowed q-983 plan: approve the implementation direction before dispatch.")).toBeTruthy();
    expect(screen.getAllByText("Approve q-983 implementation direction")).toHaveLength(1);
    expect(screen.queryByTestId("attention-ledger-row")).toBeNull();
    expect(screen.queryByText("Unrelated live Main tail")).toBeNull();
  });

  it("still uses a synthetic owner-thread row for genuinely unanchored needs-input notifications", () => {
    const sid = "test-owner-thread-unanchored-fallback";
    setStoreMessages(sid, [makeMessage({ id: "u1", role: "user", content: "Prepare the dispatch plan." })]);
    setStoreNotifications(sid, [
      {
        id: "n-q983",
        category: "needs-input",
        timestamp: Date.now(),
        messageId: null,
        threadKey: "q-983",
        questId: "q-983",
        summary: "Approve q-983 dispatch plan",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} threadKey="q-983" />);

    expect(screen.getByTestId("attention-ledger-row").getAttribute("data-attention-type")).toBe("needs_input");
    expect(screen.getByText("Approve q-983 dispatch plan")).toBeTruthy();
  });

  it("renders needs-input notify tool calls as normal commands beside the generated notification chip", () => {
    // q-1013: the notification can be anchored to the preceding leader message
    // while a later Bash tool call contains `takode notify needs-input`. The
    // tool call must not add a second generic amber "Needs input" chip.
    const sid = "test-needs-input-tool-call-normal-command";
    setStoreMessages(sid, [
      makeMessage({ id: "u1", role: "user", content: "Please ask before queuing the quest." }),
      makeMessage({
        id: "a-question",
        role: "assistant",
        content: "I need approval before continuing.",
        notification: {
          id: "n-needs-input",
          category: "needs-input",
          timestamp: Date.now(),
          summary: "approve Worker Stream follow-up quest",
        },
      }),
      makeMessage({
        id: "a-tool",
        role: "assistant",
        content: "",
        contentBlocks: [
          {
            type: "tool_use",
            id: "tu-needs-input",
            name: "Bash",
            input: { command: 'takode notify needs-input "approve Worker Stream follow-up quest"' },
          },
        ],
      }),
    ]);
    setStoreNotifications(sid, [
      {
        id: "n-needs-input",
        category: "needs-input",
        timestamp: Date.now(),
        messageId: "a-question",
        summary: "approve Worker Stream follow-up quest",
        done: false,
      },
    ]);

    render(<MessageFeed sessionId={sid} />);

    expect(screen.getAllByText("approve Worker Stream follow-up quest")).toHaveLength(1);
    expect(screen.getByText(/takode notify needs-input/)).toBeTruthy();
    expect(screen.queryByText("Needs input")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Mark handled|Mark unhandled/ })).toHaveLength(1);
  });
});
