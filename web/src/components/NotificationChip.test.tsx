// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockMarkNotificationDone = vi.fn(async (_sessionId: string, _notifId: string, _done = true) => ({ ok: true }));
const mockMarkAllNotificationsDone = vi.fn(async (_sessionId: string, _done = true) => ({ ok: true, count: 0 }));
const mockRequestScrollToMessage = vi.fn();
const mockSetExpandAllInTurn = vi.fn();
const mockOpenQuestOverlay = vi.fn();
const mockNotifications = new Map<string, Array<any>>();

const mockStoreState: Record<string, any> = {
  sessionNotifications: mockNotifications,
  messages: new Map(),
  quests: [],
  sessionNames: new Map(),
  sdkSessions: [],
  zoomLevel: 1,
  requestScrollToMessage: mockRequestScrollToMessage,
  setExpandAllInTurn: mockSetExpandAllInTurn,
  openQuestOverlay: mockOpenQuestOverlay,
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
    mockStoreState.messages = new Map();
    mockStoreState.quests = [];
    mockStoreState.sessionNames = new Map();
    mockStoreState.sdkSessions = [];
    mockMarkNotificationDone.mockClear();
    mockMarkAllNotificationsDone.mockClear();
    mockRequestScrollToMessage.mockClear();
    mockSetExpandAllInTurn.mockClear();
    mockOpenQuestOverlay.mockClear();
  });

  it("renders nothing when there are no active notifications", () => {
    // The floating bell should stay hidden when the inbox has only completed
    // notifications or no notifications at all.
    setNotifications("s1", [{ id: "done-1", category: "review", summary: "done", timestamp: Date.now(), done: true }]);
    const { container } = render(<NotificationChip sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("colors the bell blue when review is the highest active urgency", () => {
    // Review-only inboxes keep the pill behavior but switch the bell to the
    // lower-priority review color used elsewhere in the UI.
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "review-2", category: "review", summary: "Also review", timestamp: Date.now(), done: true },
    ]);
    render(<NotificationChip sessionId="s1" />);

    const chip = screen.getByRole("button", { name: /1 notification/i });
    const bell = chip.querySelector("svg");
    expect(bell?.className.baseVal ?? bell?.getAttribute("class")).toContain("text-blue-500");
    expect(chip).toHaveTextContent("1 notification");
  });

  it("colors the bell amber when needs-input is present, even with reviews", () => {
    // needs-input takes precedence over review so mixed inboxes must render
    // the bell in the higher-urgency amber tone.
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
      { id: "input-1", category: "needs-input", summary: "Need answer", timestamp: Date.now(), done: false },
    ]);
    render(<NotificationChip sessionId="s1" />);

    const chip = screen.getByRole("button", { name: /2 notifications/i });
    const bell = chip.querySelector("svg");
    expect(bell?.className.baseVal ?? bell?.getAttribute("class")).toContain("text-amber-400");
    expect(chip).toHaveTextContent("2 notifications");
  });

  it("preserves popover behavior while using urgency color", () => {
    // Coloring the bell should not change the existing click-to-open inbox flow.
    setNotifications("s1", [
      { id: "review-1", category: "review", summary: "Needs review", timestamp: Date.now(), done: false },
    ]);
    render(<NotificationChip sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: /1 notification/i }));
    expect(screen.getByRole("dialog", { name: "Notification inbox" })).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /1 notification/i }));

    const questLink = screen.getByRole("link", { name: "q-345" });
    expect(questLink).toHaveAttribute("href", "#/?quest=q-345");

    fireEvent.click(screen.getByText(/ready for review: Compress herd events/i));
    expect(mockRequestScrollToMessage).toHaveBeenCalledWith("s1", "msg-123");
    expect(mockSetExpandAllInTurn).toHaveBeenCalledWith("s1", "msg-123");

    fireEvent.click(questLink);
    expect(mockOpenQuestOverlay).toHaveBeenCalledWith("q-345");
    expect(mockRequestScrollToMessage).toHaveBeenCalledTimes(1);
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
    fireEvent.click(screen.getByRole("button", { name: /1 notification/i }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: /q-345 ready for review/i }));

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
    fireEvent.click(screen.getByRole("button", { name: /1 notification/i }));
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
    fireEvent.click(screen.getByRole("button", { name: /2 notifications/i }));
    fireEvent.click(screen.getByRole("button", { name: "Read All" }));

    expect(mockMarkAllNotificationsDone).toHaveBeenCalledWith("s1", true);
  });
});
