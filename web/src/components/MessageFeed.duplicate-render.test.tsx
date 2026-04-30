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
import type { ChatMessage } from "../types.js";
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

    expect(screen.getAllByTestId("attention-ledger-row")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Mark as reviewed|Mark as not reviewed/ })).toHaveLength(1);
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

    expect(screen.getAllByTestId("attention-ledger-row")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Mark as reviewed|Mark as not reviewed/ })).toHaveLength(1);
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
