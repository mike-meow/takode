// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { BrowserIncomingMessage } from "../types.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { normalizeHistoryMessageToChatMessages } from "../utils/history-message-normalization.js";

const mockMarkNotificationDone = vi.fn(async (_sessionId: string, _notifId: string, _done = true) => ({ ok: true }));
const mockMarkAllNotificationsDone = vi.fn(async (_sessionId: string, _done = true) => ({ ok: true, count: 0 }));
const mockSendNeedsInputResponse = vi.fn(async (_sessionId: string, _notifId: string, _response: any) => ({
  ok: true,
  sessionId: _sessionId,
  notificationId: _notifId,
  delivery: "sent",
}));
const mockRequestScrollToMessage = vi.fn();
const mockSetExpandAllInTurn = vi.fn();
const mockOpenQuestOverlay = vi.fn();
const mockNotifications = new Map<string, Array<any>>();
const mockComposerDrafts = new Map<string, any>();
const mockReplyContexts = new Map<string, any>();
const mockSetComposerDraft = vi.fn((sessionId: string, draft: any) => {
  mockComposerDrafts.set(sessionId, draft);
});
const mockSetReplyContext = vi.fn((sessionId: string, context: any) => {
  if (context) mockReplyContexts.set(sessionId, context);
  else mockReplyContexts.delete(sessionId);
});
const mockFocusComposer = vi.fn();
const mockRequestBottomAlignOnNextUserMessage = vi.fn();
const mockSendToSession = vi.fn((_sessionId: string, _msg: any) => true);

const mockStoreState: Record<string, any> = {
  sessionNotifications: mockNotifications,
  composerDrafts: mockComposerDrafts,
  replyContexts: mockReplyContexts,
  messages: new Map(),
  threadWindowMessages: new Map(),
  quests: [],
  sessionBoards: new Map(),
  sessionCompletedBoards: new Map(),
  sessionNames: new Map(),
  sdkSessions: [],
  zoomLevel: 1,
  requestScrollToMessage: mockRequestScrollToMessage,
  setExpandAllInTurn: mockSetExpandAllInTurn,
  openQuestOverlay: mockOpenQuestOverlay,
  setComposerDraft: mockSetComposerDraft,
  setReplyContext: mockSetReplyContext,
  focusComposer: mockFocusComposer,
  requestBottomAlignOnNextUserMessage: mockRequestBottomAlignOnNextUserMessage,
};

vi.mock("../store.js", () => {
  const useStore: any = (selector: (state: any) => unknown) => selector(mockStoreState);
  useStore.getState = () => mockStoreState;
  return { useStore };
});

vi.mock("../api.js", () => ({
  api: {
    markNotificationDone: (sessionId: string, notifId: string, done = true) =>
      mockMarkNotificationDone(sessionId, notifId, done),
    markAllNotificationsDone: (sessionId: string, done = true) => mockMarkAllNotificationsDone(sessionId, done),
    sendNeedsInputResponse: (sessionId: string, notifId: string, response: any) =>
      mockSendNeedsInputResponse(sessionId, notifId, response),
  },
}));

vi.mock("../ws.js", () => ({
  sendToSession: (sessionId: string, msg: any) => mockSendToSession(sessionId, msg),
}));

vi.mock("./MarkdownContent.js", () => ({
  MarkdownContent: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { NotificationChip } from "./NotificationChip.js";

function setNotifications(sessionId: string, notifications: Array<any>) {
  mockNotifications.set(sessionId, notifications);
}

function setNotificationSummary(
  sessionId: string,
  summary: {
    notificationUrgency: "needs-input" | "review" | null;
    activeNotificationCount: number;
    notificationStatusVersion: number;
    notificationStatusUpdatedAt?: number;
  },
) {
  mockStoreState.sdkSessions = [
    {
      sessionId,
      state: "connected",
      cwd: "/repo",
      createdAt: 1,
      archived: false,
      ...summary,
    },
  ];
}

function setQuests(quests: Array<any>) {
  mockStoreState.quests = quests;
}

function selectedThreadWindowMessagesForStaleTurnEnd(threadKey: string) {
  const history: BrowserIncomingMessage[] = [
    {
      type: "user_message",
      id: "herd-turn-end",
      content: "1 event from 1 session\n\n#1590 | turn_end | ✓ 2m 54s | tools: 30",
      timestamp: Date.now(),
      agentSource: { sessionId: "herd-events" },
      threadKey,
      questId: threadKey,
      threadRefs: [{ threadKey, questId: threadKey, source: "explicit" }],
    },
  ];
  const sync = buildThreadWindowSync({
    messageHistory: history,
    threadKey,
    fromItem: 0,
    itemCount: 10,
    sectionItemCount: 10,
    visibleItemCount: 3,
  });
  return sync.entries.flatMap((entry) => normalizeHistoryMessageToChatMessages(entry.message, entry.history_index));
}

function installIntersectionObserverMock() {
  let callback: IntersectionObserverCallback | null = null;
  let observedTarget: Element | null = null;
  const observe = vi.fn((target: Element) => {
    observedTarget = target;
  });

  vi.stubGlobal(
    "IntersectionObserver",
    class IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [0];

      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }

      observe(target: Element) {
        observe(target);
      }

      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    },
  );

  return {
    observe,
    trigger(isIntersecting: boolean) {
      if (!callback || !observedTarget) return;
      callback(
        [
          {
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0,
            target: observedTarget,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    },
  };
}

describe("NotificationChip", () => {
  beforeEach(() => {
    mockNotifications.clear();
    mockComposerDrafts.clear();
    mockReplyContexts.clear();
    mockStoreState.messages = new Map();
    mockStoreState.threadWindowMessages = new Map();
    mockStoreState.quests = [];
    mockStoreState.sessionNames = new Map();
    mockStoreState.sdkSessions = [];
    mockMarkNotificationDone.mockClear();
    mockMarkAllNotificationsDone.mockClear();
    mockSendNeedsInputResponse.mockClear();
    mockSendNeedsInputResponse.mockResolvedValue({
      ok: true,
      sessionId: "s1",
      notificationId: "n-1",
      delivery: "sent",
    });
    mockRequestScrollToMessage.mockClear();
    mockSetExpandAllInTurn.mockClear();
    mockOpenQuestOverlay.mockClear();
    mockSetComposerDraft.mockClear();
    mockSetReplyContext.mockClear();
    mockFocusComposer.mockClear();
    mockRequestBottomAlignOnNextUserMessage.mockClear();
    mockSendToSession.mockClear();
    mockSendToSession.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing when there are no active notifications", () => {
    // The floating bell should stay hidden when the inbox has only completed
    // notifications or no notifications at all.
    setNotifications("s1", [{ id: "done-1", category: "review", summary: "done", timestamp: Date.now(), done: true }]);
    const { container } = render(<NotificationChip sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for waiting-only status markers", () => {
    // Waiting markers are transient status, not unresolved notifications that
    // should create chip counts or resolver work.
    setNotifications("s1", [
      { id: "waiting-1", category: "waiting", summary: "Waiting on reviewer", timestamp: Date.now(), done: false },
    ]);

    const { container } = render(<NotificationChip sessionId="s1" />);

    expect(container).toBeEmptyDOMElement();
  });

  it("filters waiting status markers out of mixed notification chips and popovers", () => {
    // A legacy/live waiting payload may arrive beside actionable notifications,
    // but it must not add count text or a popover row.
    setNotifications("s1", [
      { id: "waiting-1", category: "waiting", summary: "Waiting on reviewer", timestamp: Date.now(), done: false },
      { id: "input-1", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
    ]);
    render(<NotificationChip sessionId="s1" />);

    const chip = screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" });
    expect(chip).toHaveTextContent("1needs input");
    expect(chip).not.toHaveTextContent("Waiting");

    fireEvent.click(chip);
    expect(screen.getAllByTestId("notification-inbox-row")).toHaveLength(1);
    expect(screen.getAllByText("Need answer").length).toBeGreaterThan(0);
    expect(screen.queryByText("Waiting on reviewer")).not.toBeInTheDocument();
  });

  it("uses the theme-safe info color when review is the highest active urgency", () => {
    // Review-only inboxes should render a single-height inline count + bell
    // segment with explicit review copy.
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "review-2", category: "review", summary: "Also review", timestamp: Date.now(), done: true },
    ]);
    render(<NotificationChip sessionId="s1" />);

    const chip = screen.getByRole("button", { name: "Notification inbox: 1 review notification" });
    const badge = within(chip).getByTestId("notification-chip-review");
    const bell = badge.querySelector("svg");
    expect(chip).toHaveTextContent("1review");
    expect(within(chip).queryByText("unreads")).not.toBeInTheDocument();
    expect(bell?.className.baseVal ?? bell?.getAttribute("class")).toContain("text-cc-info");
    expect(badge).toHaveTextContent("1");
    expect(badge.className).not.toContain("rounded-full");
  });

  it("prioritizes needs-input on the chip surface when needs-input and review are both active", () => {
    // Mixed inboxes should show one attention bell, with review discoverable as
    // secondary text instead of a competing info bell.
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "input-1", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
      { id: "input-2", category: "needs-input", summary: "Need second answer", timestamp: Date.now(), done: false },
    ]);
    render(<NotificationChip sessionId="s1" />);

    const chip = screen.getByRole("button", {
      name: "Notification inbox: 2 needs-input notifications, 1 review notification",
    });
    const needsInputBadge = within(chip).getByTestId("notification-chip-needs-input");
    const reviewSecondary = within(chip).getByTestId("notification-chip-review-secondary");
    const needsInputBell = needsInputBadge.querySelector("svg");
    expect(chip).toHaveTextContent("2needs input+1 review");
    expect(needsInputBell?.className.baseVal ?? needsInputBell?.getAttribute("class")).toContain("text-cc-attention");
    expect(within(chip).queryByTestId("notification-chip-review")).not.toBeInTheDocument();
    expect(needsInputBadge).toHaveTextContent("2");
    expect(reviewSecondary).toHaveTextContent("+1 review");
    expect(within(chip).queryByText("unreads")).not.toBeInTheDocument();
  });

  it("uses a newer active summary when the cached full inbox is still review-only", () => {
    // Global session_activity_update can arrive before the full notification
    // inbox refreshes. The chip should follow the newer server summary instead
    // of briefly turning back to review urgency from stale cached details.
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);
    setNotificationSummary("s1", {
      notificationUrgency: "needs-input",
      activeNotificationCount: 1,
      notificationStatusVersion: 6,
      notificationStatusUpdatedAt: 6000,
    });

    render(<NotificationChip sessionId="s1" />);

    const chip = screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" });
    expect(within(chip).queryByTestId("notification-chip-review")).toBeNull();
    const needsInputBadge = within(chip).getByTestId("notification-chip-needs-input");
    const needsInputBell = needsInputBadge.querySelector("svg");
    expect(needsInputBell?.className.baseVal ?? needsInputBell?.getAttribute("class")).toContain("text-cc-attention");
  });

  it("shows an active summary even before the full notification payload arrives", () => {
    // A stale empty/done-only full inbox should not hide a new needs-input
    // summary while the current-session snapshot/notification_update catches up.
    setNotifications("s1", [
      { id: "old-review", category: "review", summary: "Old review", timestamp: Date.now(), done: true },
    ]);
    setNotificationSummary("s1", {
      notificationUrgency: "needs-input",
      activeNotificationCount: 1,
      notificationStatusVersion: 7,
      notificationStatusUpdatedAt: 7000,
    });

    render(<NotificationChip sessionId="s1" />);

    expect(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" })).toBeInTheDocument();
  });

  it("keeps a newer needs-input summary when stale clear state is still cached", () => {
    // Protects the observed transition: stale clear/review local notification
    // state must not override a newer authoritative needs-input summary.
    setNotificationSummary("s1", {
      notificationUrgency: "needs-input",
      activeNotificationCount: 1,
      notificationStatusVersion: 8,
      notificationStatusUpdatedAt: 8000,
    });

    render(<NotificationChip sessionId="s1" />);

    expect(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" })).toBeInTheDocument();
  });

  it("preserves popover behavior while using urgency color", () => {
    // Coloring the bell should not change the existing click-to-open inbox flow.
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);
    render(<NotificationChip sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));
    expect(screen.getByRole("dialog", { name: "Notification inbox" })).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });

  it("uses fully readable muted text for notification timestamps", () => {
    // Light-theme Execute caught timestamp metadata rendered as text-cc-muted/60,
    // which falls below AA on the notification popover card.
    setNotifications("s1", [
      {
        id: "needs-input-1",
        category: "needs-input",
        summary: "Choose rollout mode",
        timestamp: Date.now() - 120_000,
        done: false,
      },
    ]);
    render(<NotificationChip sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));

    const timestamp = screen.getByText(/m ago/);
    expect(timestamp).toHaveClass("text-cc-muted");
    expect(timestamp.className).not.toContain("text-cc-muted/60");
  });

  it("uses theme-readable muted text for source context action labels", () => {
    // Execute caught visible More and Preview labels when they resolved through
    // low-contrast muted utilities on light and dark notification popovers.
    mockStoreState.messages = new Map([
      [
        "s1",
        [
          {
            id: "msg-123",
            role: "assistant",
            content: "The deployment is staged and the smoke test is green.\n\nRollback is ready if the canary fails.",
            timestamp: Date.now() - 10,
          },
        ],
      ],
    ]);
    setNotifications("s1", [
      {
        id: "n-1",
        category: "needs-input",
        summary: "Deploy now?",
        timestamp: Date.now(),
        messageId: "msg-123",
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));

    const moreButton = screen.getByRole("button", { name: "More" });
    const previewButton = screen.getByRole("button", { name: "Preview source message" });
    expect(moreButton).toHaveClass("cc-muted-readable");
    expect(previewButton).toHaveClass("cc-muted-readable");
    expect(moreButton).not.toHaveClass("text-cc-muted");
    expect(previewButton).not.toHaveClass("text-cc-muted");
    expect(moreButton.className).not.toContain("text-cc-muted/80");
    expect(previewButton.className).not.toContain("text-cc-muted/80");
  });

  it("sends a paused-session notification answer through the response API", async () => {
    mockComposerDrafts.set("s1", {
      text: "old draft",
      images: [{ id: "img-1", name: "keep.png", base64: "abc", mediaType: "image/png", status: "ready" }],
    });
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        state: "connected",
        cwd: "/repo",
        createdAt: 1,
        archived: false,
        pause: { pausedAt: 1234, pausedBy: "test" },
        pausedInputQueueCount: 1,
      },
    ];
    setNotifications("s1", [
      {
        id: "n-1",
        category: "needs-input",
        summary: "Deploy now?",
        suggestedAnswers: ["yes", "no"],
        timestamp: Date.now(),
        messageId: "msg-123",
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));
    expect(screen.getByTestId("notification-answer-actions")).toContainElement(
      screen.getByRole("button", { name: "yes" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "yes" }));
    expect(screen.getByLabelText("Answer for Deploy now?")).toHaveValue("yes");
    fireEvent.click(screen.getByRole("button", { name: "Send Response" }));

    await waitFor(() =>
      expect(mockSendNeedsInputResponse).toHaveBeenCalledWith("s1", "n-1", {
        content: "Deploy now?\n\nAnswer: yes",
        threadKey: "main",
      }),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
    expect(mockMarkNotificationDone).not.toHaveBeenCalled();
    expect(mockRequestBottomAlignOnNextUserMessage).toHaveBeenCalledWith("s1");
    expect(mockSetComposerDraft).not.toHaveBeenCalled();
    expect(mockFocusComposer).not.toHaveBeenCalled();
  });

  it("shows expandable source context on needs-input rows without duplicating the prompt", () => {
    mockStoreState.messages = new Map([
      [
        "s1",
        [
          {
            id: "msg-123",
            role: "assistant",
            content: "The deployment is staged and the smoke test is green.\n\nRollback is ready if the canary fails.",
            timestamp: Date.now() - 10,
          },
        ],
      ],
    ]);
    setNotifications("s1", [
      {
        id: "n-1",
        category: "needs-input",
        summary: "Deploy now?",
        suggestedAnswers: ["yes", "no"],
        timestamp: Date.now(),
        messageId: "msg-123",
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));

    expect(screen.getAllByText("Deploy now?")).toHaveLength(1);
    expect(screen.getByTestId("notification-source-context")).toHaveTextContent("Rollback is ready");
    expect(screen.queryByText("Jump")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByTestId("notification-source-context").className).toContain("whitespace-pre-line");
    expect(mockRequestScrollToMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open source message for Deploy now?" }));
    expect(mockRequestScrollToMessage).toHaveBeenCalledWith("s1", "msg-123");
    expect(mockSetExpandAllInTurn).toHaveBeenCalledWith("s1", "msg-123");
  });

  it("falls back to a title-only needs-input row when source context is unavailable", () => {
    setNotifications("s1", [
      {
        id: "n-1",
        category: "needs-input",
        summary: "Confirm scope",
        suggestedAnswers: ["yes"],
        timestamp: Date.now(),
        messageId: null,
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));

    expect(screen.queryByTestId("notification-source-context")).toBeNull();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(screen.getAllByText("Confirm scope")).toHaveLength(1);
  });

  it("switches to the notification owner thread before jumping to the message", () => {
    const onSelectThread = vi.fn();
    vi.useFakeTimers();
    setNotifications("s1", [
      {
        id: "review-1",
        category: "review",
        summary: "q-977 ready for review",
        timestamp: Date.now(),
        messageId: "msg-977",
        threadKey: "q-977",
        questId: "q-977",
        done: false,
      },
    ]);

    try {
      render(<NotificationChip sessionId="s1" currentThreadKey="main" onSelectThread={onSelectThread} />);
      fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));
      fireEvent.click(screen.getByRole("button", { name: /^q-977$/i }));

      expect(onSelectThread).toHaveBeenCalledWith("q-977");
      expect(mockRequestScrollToMessage).not.toHaveBeenCalled();

      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(mockRequestScrollToMessage).toHaveBeenCalledWith("s1", "msg-977");
      expect(mockSetExpandAllInTurn).toHaveBeenCalledWith("s1", "msg-977");
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches to an owner thread and targets the synthetic chip for unanchored needs-input notifications", () => {
    const onSelectThread = vi.fn();
    vi.useFakeTimers();
    setNotifications("s1", [
      {
        id: "n-q977",
        category: "needs-input",
        summary: "Approve q-977 dispatch?",
        timestamp: Date.now(),
        messageId: null,
        threadKey: "q-977",
        questId: "q-977",
        done: false,
      },
    ]);

    try {
      render(<NotificationChip sessionId="s1" currentThreadKey="main" onSelectThread={onSelectThread} />);
      fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));
      fireEvent.click(screen.getByRole("button", { name: /Approve q-977 dispatch/i }));

      expect(onSelectThread).toHaveBeenCalledWith("q-977");
      expect(mockRequestScrollToMessage).not.toHaveBeenCalled();

      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(mockRequestScrollToMessage).toHaveBeenCalledWith("s1", "attention-ledger:notification:n-q977");
      expect(mockSetExpandAllInTurn).toHaveBeenCalledWith("s1", "attention-ledger:notification:n-q977");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the needs-input decision row instead of unrelated herd turn_end anchors", () => {
    const onSelectThread = vi.fn();
    vi.useFakeTimers();
    mockStoreState.messages = new Map([
      [
        "s1",
        [
          {
            id: "herd-turn-end",
            role: "user",
            content: "1 event from 1 session\n\n#1590 | turn_end | ✓ 2m 54s | tools: 30",
            timestamp: Date.now(),
            agentSource: { sessionId: "herd-events" },
          },
        ],
      ],
    ]);
    setNotifications("s1", [
      {
        id: "n-q977",
        category: "needs-input",
        summary: "Approve q-977 dispatch?",
        timestamp: Date.now(),
        messageId: "herd-turn-end",
        threadKey: "q-977",
        questId: "q-977",
        done: false,
      },
    ]);

    try {
      render(<NotificationChip sessionId="s1" currentThreadKey="main" onSelectThread={onSelectThread} />);
      fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));
      fireEvent.click(screen.getByRole("button", { name: /Approve q-977 dispatch/i }));

      expect(onSelectThread).toHaveBeenCalledWith("q-977");
      expect(mockRequestScrollToMessage).not.toHaveBeenCalledWith("s1", "herd-turn-end");

      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(mockRequestScrollToMessage).toHaveBeenCalledWith("s1", "attention-ledger:notification:n-q977");
      expect(mockSetExpandAllInTurn).toHaveBeenCalledWith("s1", "attention-ledger:notification:n-q977");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses selected thread-window evidence when rejecting stale needs-input anchors", () => {
    const onSelectThread = vi.fn();
    vi.useFakeTimers();
    mockStoreState.messages = new Map();
    mockStoreState.threadWindowMessages = new Map([
      ["s1", new Map([["q-977", selectedThreadWindowMessagesForStaleTurnEnd("q-977")]])],
    ]);
    setNotifications("s1", [
      {
        id: "n-q977",
        category: "needs-input",
        summary: "Approve q-977 dispatch?",
        timestamp: Date.now(),
        messageId: "herd-turn-end",
        threadKey: "q-977",
        questId: "q-977",
        done: false,
      },
    ]);

    try {
      render(<NotificationChip sessionId="s1" currentThreadKey="main" onSelectThread={onSelectThread} />);
      fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));
      fireEvent.click(screen.getByRole("button", { name: /Approve q-977 dispatch/i }));

      expect(onSelectThread).toHaveBeenCalledWith("q-977");
      expect(mockRequestScrollToMessage).not.toHaveBeenCalledWith("s1", "herd-turn-end");

      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(mockRequestScrollToMessage).toHaveBeenCalledWith("s1", "attention-ledger:notification:n-q977");
      expect(mockSetExpandAllInTurn).toHaveBeenCalledWith("s1", "attention-ledger:notification:n-q977");
    } finally {
      vi.useRealTimers();
    }
  });

  it("switches out of All Threads before sending a direct response", () => {
    const onSelectThread = vi.fn();
    vi.useFakeTimers();
    mockComposerDrafts.set("s1", { text: "old draft", images: [] });
    setNotifications("s1", [
      {
        id: "n-1",
        category: "needs-input",
        summary: "Deploy q-977?",
        suggestedAnswers: ["yes", "no"],
        timestamp: Date.now(),
        messageId: "msg-977",
        threadKey: "q-977",
        questId: "q-977",
        done: false,
      },
    ]);

    try {
      render(<NotificationChip sessionId="s1" currentThreadKey="all" onSelectThread={onSelectThread} />);
      fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));
      fireEvent.click(screen.getByRole("button", { name: "yes" }));
      fireEvent.click(screen.getByRole("button", { name: "Send Response" }));

      expect(onSelectThread).toHaveBeenCalledWith("q-977");
      expect(mockSendToSession).not.toHaveBeenCalled();

      act(() => {
        vi.runOnlyPendingTimers();
      });

      expect(mockSendNeedsInputResponse).toHaveBeenCalledWith("s1", "n-1", {
        content: "Deploy q-977?\n\nAnswer: yes",
        threadKey: "q-977",
        questId: "q-977",
      });
      expect(mockSendToSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a composer reply path without replacing draft text", () => {
    mockComposerDrafts.set("s1", { text: "keep my draft", images: [] });
    setNotifications("s1", [
      {
        id: "n-1",
        category: "needs-input",
        summary: "Choose rollout mode",
        suggestedAnswers: ["fast", "slow"],
        timestamp: Date.now(),
        messageId: "msg-123",
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));
    const useComposerButton = screen.getByRole("button", { name: "Use composer" });
    expect(useComposerButton).toHaveClass("cc-muted-readable");
    expect(useComposerButton).not.toHaveClass("text-cc-muted");
    fireEvent.click(useComposerButton);

    expect(mockSetReplyContext).toHaveBeenCalledWith("s1", {
      messageId: "msg-123",
      notificationId: "n-1",
      previewText: "Choose rollout mode",
    });
    expect(mockSetComposerDraft).not.toHaveBeenCalled();
    expect(mockComposerDrafts.get("s1")?.text).toBe("keep my draft");
    expect(mockFocusComposer).toHaveBeenCalledTimes(1);
  });

  it("hides answer actions for addressed needs-input notifications in the done section", () => {
    setNotifications("s1", [
      {
        id: "active-review",
        category: "review",
        summary: "Ready for review",
        timestamp: Date.now(),
        done: false,
      },
      {
        id: "done-input",
        category: "needs-input",
        summary: "Deploy now?",
        suggestedAnswers: ["yes", "no"],
        timestamp: Date.now(),
        done: true,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));
    fireEvent.click(screen.getByRole("button", { name: "Done (1)" }));

    expect(screen.getByText("Deploy now?")).not.toBeNull();
    expect(screen.queryByTestId("notification-answer-actions")).toBeNull();
    expect(screen.queryByRole("button", { name: "yes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use composer" })).toBeNull();
  });

  it("renders multiple question blocks and keeps suggestions scoped to the chosen question", () => {
    setNotifications("s1", [
      {
        id: "n-1",
        category: "needs-input",
        summary: "Need rollout choices",
        questions: [
          { prompt: "Which rollout?", suggestedAnswers: ["staged", "full"] },
          { prompt: "When should it start?", suggestedAnswers: ["now", "after review"] },
        ],
        timestamp: Date.now(),
        messageId: "msg-123",
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));

    expect(screen.getAllByTestId("notification-question-block")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "staged" }));
    expect(screen.getByLabelText("Answer for Which rollout?")).toHaveValue("staged");
    expect(screen.getByLabelText("Answer for When should it start?")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Answer for When should it start?"), {
      target: { value: "after the smoke test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send Response" }));

    expect(mockSendNeedsInputResponse).toHaveBeenCalledWith(
      "s1",
      "n-1",
      expect.objectContaining({
        content:
          "Answers for: Need rollout choices\n\n1. Which rollout?\nAnswer: staged\n\n2. When should it start?\nAnswer: after the smoke test",
        threadKey: "main",
      }),
    );
    expect(mockSendToSession).not.toHaveBeenCalled();
  });

  it("renders the quest mention as a quest link while keeping the row clickable for jump-to-message", () => {
    setQuests([
      {
        id: "q-345-v1",
        questId: "q-345",
        title: "Compress herd events",
      },
    ]);
    setNotifications("s1", [
      {
        id: "review-1",
        category: "review",
        summary: "q-345 ready for review: Compress herd events",
        timestamp: Date.now(),
        messageId: "msg-123",
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));

    const questLink = screen.getByRole("link", { name: "q-345" });
    const rowButton = screen.getByRole("button", { name: /q-345: Compress herd events/i });
    expect(questLink).toHaveAttribute("href", "#/?quest=q-345");
    expect(rowButton).toBeInTheDocument();
    expect(screen.queryByText(/ready for review/i)).toBeNull();

    fireEvent.click(rowButton);
    expect(mockRequestScrollToMessage).toHaveBeenCalledWith("s1", "msg-123");
    expect(mockSetExpandAllInTurn).toHaveBeenCalledWith("s1", "msg-123");

    fireEvent.click(questLink);
    expect(mockOpenQuestOverlay).toHaveBeenCalledWith("q-345");
    expect(mockRequestScrollToMessage).toHaveBeenCalledTimes(1);
  });

  it("compacts multi-quest ready-for-review summaries in the inbox row", () => {
    setNotifications("s1", [
      {
        id: "review-batch-1",
        category: "review",
        summary: "2 quests ready for review: q-345, q-346",
        timestamp: Date.now(),
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));

    expect(screen.getByText("q-345, q-346")).toBeInTheDocument();
    expect(screen.queryByText(/2 quests ready for review/i)).toBeNull();
  });

  it("uses a full-width mobile popover shell while staying anchored above the feed chip", () => {
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));

    const dialog = screen.getByRole("dialog", { name: "Notification inbox" });
    expect(dialog.className).toContain("inset-x-3");
    expect(dialog.className).toContain("bottom-[var(--notification-popover-bottom)]");
    expect(dialog.className).toContain("max-h-[min(60vh,28rem,var(--notification-popover-available-height))]");
    expect(dialog.className).toContain("sm:w-[24rem]");
    expect(dialog.className).toContain("md:w-[26rem]");
    expect(dialog.className).toContain("sm:max-h-[min(50vh,var(--notification-popover-available-height))]");
    expect(dialog.style.getPropertyValue("--notification-popover-bottom")).toBe("56px");
  });

  it("raises the popover above the chip when the composer pushes the feed controls higher", () => {
    // The notification chip sits inside the feed, above the composer. Anchoring
    // the panel above that chip keeps the composer and send controls usable on
    // narrow layouts with taller composer surfaces.
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);

    try {
      render(<NotificationChip sessionId="s1" />);
      const chip = screen.getByRole("button", { name: "Notification inbox: 1 review notification" });
      Object.defineProperty(chip, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          x: 640,
          y: 620,
          top: 620,
          right: 780,
          bottom: 644,
          left: 640,
          width: 140,
          height: 24,
          toJSON: () => ({}),
        }),
      });

      fireEvent.click(chip);

      const dialog = screen.getByRole("dialog", { name: "Notification inbox" });
      expect(dialog.style.getPropertyValue("--notification-popover-bottom")).toBe("188px");
      expect(dialog.style.getPropertyValue("--notification-popover-available-height")).toBe(
        "calc(100dvh - 188px - 12px)",
      );
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  it("does not show a message preview when hovering a notification row", () => {
    mockStoreState.messages = new Map([
      [
        "s1",
        [
          {
            id: "msg-123",
            role: "assistant",
            content: "Hidden hover preview body",
          },
        ],
      ],
    ]);
    setNotifications("s1", [
      {
        id: "review-1",
        category: "review",
        summary: "q-345 ready for review",
        timestamp: Date.now(),
        messageId: "msg-123",
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: /^q-345$/i }));

    expect(screen.queryByText("Hidden hover preview body")).toBeNull();
    expect(screen.queryByTestId("message-link-hover-card")).toBeNull();
  });

  it("keeps the quest hover card behavior on the inline quest link", () => {
    setQuests([
      {
        id: "q-345-v1",
        questId: "q-345",
        title: "Compress herd events more aggressively",
        status: "done",
        tags: ["ui", "notifications"],
      },
    ]);
    setNotifications("s1", [
      {
        id: "review-1",
        category: "review",
        summary: "q-345 ready for review",
        timestamp: Date.now(),
        messageId: "msg-123",
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));
    fireEvent.mouseEnter(screen.getByRole("link", { name: "q-345" }));

    expect(screen.getByText("Compress herd events more aggressively")).toBeInTheDocument();
    expect(within(screen.getByTestId("quest-hover-status-row")).getByText("Completed")).toBeInTheDocument();
  });

  it("auto-resolves visible review rows in the notification popover", () => {
    const observer = installIntersectionObserverMock();
    setNotifications("s1", [
      {
        id: "review-visible",
        category: "review",
        summary: "q-345 ready for review",
        timestamp: Date.now(),
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));

    expect(observer.observe).toHaveBeenCalledTimes(1);
    act(() => observer.trigger(true));
    expect(mockMarkNotificationDone).toHaveBeenCalledWith("s1", "review-visible", true);
  });

  it("does not auto-resolve visible needs-input rows in the notification popover", () => {
    const observer = installIntersectionObserverMock();
    setNotifications("s1", [
      {
        id: "needs-input-visible",
        category: "needs-input",
        summary: "Deploy now?",
        timestamp: Date.now(),
        done: false,
      },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 needs-input notification" }));

    act(() => observer.trigger(true));
    expect(mockMarkNotificationDone).not.toHaveBeenCalled();
  });

  it("shows a Read All control and marks all active notifications done", () => {
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "review-2", category: "review", summary: "Another review", timestamp: Date.now(), done: false },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 2 review notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Read All" }));

    expect(mockMarkAllNotificationsDone).toHaveBeenCalledWith("s1", true);
  });
});
