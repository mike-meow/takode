// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockNotifications = new Map<string, Array<any>>();

vi.mock("../store.js", () => ({
  useStore: (selector: (state: any) => unknown) =>
    selector({
      sessionNotifications: mockNotifications,
      messages: new Map(),
      zoomLevel: 1,
      requestScrollToMessage: vi.fn(),
      setExpandAllInTurn: vi.fn(),
    }),
}));

vi.mock("../api.js", () => ({
  api: {
    markNotificationDone: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("./MarkdownContent.js", () => ({
  MarkdownContent: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { NotificationChip } from "./NotificationChip.js";

function setNotifications(sessionId: string, notifications: Array<any>) {
  mockNotifications.set(sessionId, notifications);
}

describe("NotificationChip", () => {
  beforeEach(() => {
    mockNotifications.clear();
  });

  it("renders nothing when there are no active notifications", () => {
    // The floating bell should stay hidden when the inbox has only completed
    // notifications or no notifications at all.
    setNotifications("s1", [
      { id: "done-1", category: "review", summary: "done", timestamp: Date.now(), done: true },
    ]);
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
});
