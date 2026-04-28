// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockMarkNotificationDone = vi.fn(async (_sessionId: string, _notifId: string, _done = true) => ({ ok: true }));
const mockMarkAllNotificationsDone = vi.fn(async (_sessionId: string, _done = true) => ({ ok: true, count: 0 }));
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

const mockStoreState: Record<string, any> = {
  sessionNotifications: mockNotifications,
  composerDrafts: mockComposerDrafts,
  replyContexts: mockReplyContexts,
  messages: new Map(),
  quests: [],
  sessionNames: new Map(),
  sdkSessions: [],
  zoomLevel: 1,
  requestScrollToMessage: mockRequestScrollToMessage,
  setExpandAllInTurn: mockSetExpandAllInTurn,
  openQuestOverlay: mockOpenQuestOverlay,
  setComposerDraft: mockSetComposerDraft,
  setReplyContext: mockSetReplyContext,
  focusComposer: mockFocusComposer,
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
  },
}));

vi.mock("./MarkdownContent.js", () => ({
  MarkdownContent: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { NotificationChip } from "./NotificationChip.js";

function setNotifications(sessionId: string, notifications: Array<any>) {
  mockNotifications.set(sessionId, notifications);
}

function setQuests(quests: Array<any>) {
  mockStoreState.quests = quests;
}

describe("NotificationChip", () => {
  beforeEach(() => {
    mockNotifications.clear();
    mockComposerDrafts.clear();
    mockReplyContexts.clear();
    mockStoreState.messages = new Map();
    mockStoreState.quests = [];
    mockStoreState.sessionNames = new Map();
    mockStoreState.sdkSessions = [];
    mockMarkNotificationDone.mockClear();
    mockMarkAllNotificationsDone.mockClear();
    mockRequestScrollToMessage.mockClear();
    mockSetExpandAllInTurn.mockClear();
    mockOpenQuestOverlay.mockClear();
    mockSetComposerDraft.mockClear();
    mockSetReplyContext.mockClear();
    mockFocusComposer.mockClear();
  });

  it("renders nothing when there are no active notifications", () => {
    // The floating bell should stay hidden when the inbox has only completed
    // notifications or no notifications at all.
    setNotifications("s1", [{ id: "done-1", category: "review", summary: "done", timestamp: Date.now(), done: true }]);
    const { container } = render(<NotificationChip sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("colors the bell blue when review is the highest active urgency", () => {
    // Review-only inboxes should render a single-height inline count + bell
    // segment while keeping the blue review color.
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "review-2", category: "review", summary: "Also review", timestamp: Date.now(), done: true },
    ]);
    render(<NotificationChip sessionId="s1" />);

    const chip = screen.getByRole("button", { name: "Notification inbox: 1 review notification" });
    const summary = within(chip).getByText("unreads").parentElement;
    const badge = within(chip).getByTestId("notification-chip-review");
    const bell = badge.querySelector("svg");
    expect(summary).toHaveTextContent("1unreads");
    expect(bell?.className.baseVal ?? bell?.getAttribute("class")).toContain("text-blue-500");
    expect(badge).toHaveTextContent("1");
    expect(badge.className).not.toContain("rounded-full");
  });

  it("renders a compact per-type breakdown when needs-input and review are both active", () => {
    // Mixed inboxes should stay single-height by using inline comma-separated
    // count + bell segments and ending with "unreads".
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
    const reviewBadge = within(chip).getByTestId("notification-chip-review");
    const needsInputBell = needsInputBadge.querySelector("svg");
    const reviewBell = reviewBadge.querySelector("svg");
    expect(chip).toHaveTextContent("1,2unreads");
    expect(needsInputBell?.className.baseVal ?? needsInputBell?.getAttribute("class")).toContain("text-amber-400");
    expect(reviewBell?.className.baseVal ?? reviewBell?.getAttribute("class")).toContain("text-blue-500");
    expect(needsInputBadge).toHaveTextContent("2");
    expect(reviewBadge).toHaveTextContent("1");
    expect(within(chip).getByText(",")).toBeInTheDocument();
    expect(within(chip).getByText("unreads")).toBeInTheDocument();
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

  it("renders suggested answers and prefills the composer without sending", () => {
    mockComposerDrafts.set("s1", {
      text: "old draft",
      images: [{ id: "img-1", name: "keep.png", base64: "abc", mediaType: "image/png", status: "ready" }],
    });
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
    fireEvent.click(screen.getByRole("button", { name: "yes" }));

    expect(mockSetReplyContext).toHaveBeenCalledWith("s1", {
      messageId: "msg-123",
      notificationId: "n-1",
      previewText: "Deploy now?",
    });
    expect(mockSetComposerDraft).toHaveBeenCalledWith("s1", {
      text: "yes",
      images: [{ id: "img-1", name: "keep.png", base64: "abc", mediaType: "image/png", status: "ready" }],
    });
    expect(mockFocusComposer).toHaveBeenCalledTimes(1);
    expect(mockMarkNotificationDone).not.toHaveBeenCalled();
  });

  it("starts a custom needs-input reply without replacing draft text", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));

    expect(mockSetReplyContext).toHaveBeenCalledWith("s1", {
      messageId: "msg-123",
      notificationId: "n-1",
      previewText: "Choose rollout mode",
    });
    expect(mockSetComposerDraft).not.toHaveBeenCalled();
    expect(mockComposerDrafts.get("s1")?.text).toBe("keep my draft");
    expect(mockFocusComposer).toHaveBeenCalledTimes(1);
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

  it("uses a full-width mobile popover shell while staying height-capped", () => {
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);

    render(<NotificationChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Notification inbox: 1 review notification" }));

    const dialog = screen.getByRole("dialog", { name: "Notification inbox" });
    expect(dialog.className).toContain("inset-x-3");
    expect(dialog.className).toContain("max-h-[min(60vh,28rem)]");
    expect(dialog.className).toContain("sm:w-80");
    expect(dialog.className).toContain("sm:max-h-[50vh]");
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
        status: "needs_verification",
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
    expect(screen.getByText("Verification")).toBeInTheDocument();
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
