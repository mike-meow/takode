// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

// Mock markdown renderer used by MessageBubble/PermissionBanner
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock("remark-gfm", () => ({
  default: {},
}));

import { Playground } from "./Playground.js";

describe("Playground", () => {
  it("renders the real chat stack section with integrated chat components", () => {
    render(<Playground />);

    expect(screen.getByText("Component Playground")).toBeTruthy();
    expect(screen.getByText("Real Chat Stack")).toBeTruthy();
    expect(screen.getByText("Search Preview Chat")).toBeTruthy();
    expect(screen.getByText("Shortcut Hints")).toBeTruthy();
    expect(screen.getByText("Timer Messages")).toBeTruthy();

    const realChat = screen.getByTestId("playground-real-chat-stack");
    expect(realChat).toBeTruthy();

    // Dynamic tool permission should be visible inside the integrated ChatView.
    expect(within(realChat).getByText("dynamic:code_interpreter")).toBeTruthy();

    // Streaming text from MessageFeed mock state should also be rendered.
    expect(within(realChat).getByText("I'm updating tests and then I'll run the full suite.")).toBeTruthy();
  });

  it("shows the voice mode selector before the recording label in Playground composer states", () => {
    render(<Playground />);

    const editRow = screen.getByTestId("playground-recording-mode-row-edit");
    const editToggle = within(editRow).getByTestId("playground-recording-mode-toggle-edit");
    const editRecordingLabel = within(editRow).getByText("Recording");
    expect(editToggle.compareDocumentPosition(editRecordingLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const appendRow = screen.getByTestId("playground-recording-mode-row-append");
    const appendToggle = within(appendRow).getByTestId("playground-recording-mode-toggle-append");
    const appendRecordingLabel = within(appendRow).getByText("Recording");
    expect(appendToggle.compareDocumentPosition(appendRecordingLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("documents leader thread routing and full Main activity", () => {
    render(<Playground />);

    expect(screen.getByText("Leader Main stream — full activity visible")).toBeTruthy();
    expect(screen.getByText("Leader thread switcher")).toBeTruthy();
    expect(screen.getByText("Checked worker state, inspected the board, and prepared the next dispatch.")).toBeTruthy();
    expect(
      screen.getByText(
        "Approved #70's plan for q-43. It's a clean unification: resize once at store time (1920px max).",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/@to\(user\)/)).toBeNull();
  });

  it("documents compact moved-message markers without quest activity summaries", () => {
    render(<Playground />);

    const marker = screen.getAllByTestId("thread-attachment-marker")[0];
    expect(marker).toHaveTextContent("1 message moved to thread:q-961");
    expect(marker).not.toHaveTextContent("activities in thread:");
    expect(within(marker).queryByText("Jump")).toBeNull();
    expect(within(marker).getByRole("button", { name: "thread:q-961" })).toBeTruthy();
  });

  it("documents Work Board Bar tab shrinking and phase legend states", () => {
    render(<Playground />);

    fireEvent.click(screen.getByText("Seed board data"));

    const rail = screen.getByTestId("thread-tab-rail");
    expect(rail).toHaveAttribute("data-overflow", "horizontal-scroll-after-min");
    expect(screen.getByTestId("thread-main-tab")).toHaveTextContent("Main Thread");
    expect(screen.getByTestId("thread-main-tab")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("workboard-phase-summary")).toHaveTextContent("1 Implement");
    const mainTitle = within(screen.getByTestId("thread-main-tab")).getByTestId("thread-tab-title");
    expect(mainTitle).toHaveAttribute("data-active-output", "true");
    expect(mainTitle).toHaveStyle({ animation: "thread-title-glow 2s ease-in-out infinite" });
    expect(mainTitle).not.toHaveClass("border");
    expect(mainTitle).not.toHaveClass("bg-sky-400/10");

    const tabs = screen.getAllByTestId("thread-tab");
    expect(tabs.map((tab) => tab.getAttribute("data-min-label"))).toEqual(
      expect.arrayContaining(["q-42", "q-55", "q-61", "q-77", "q-88"]),
    );
    expect(tabs[0]).toHaveClass("min-w-[6.25rem]", "max-w-[18rem]", "flex-[1_1_11rem]");
    expect(within(tabs[0]).getByTestId("thread-tab-close")).toHaveAttribute("data-compact-close", "true");
    const completedTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-88");
    expect(within(completedTab!).getByTestId("thread-tab-title")).toHaveAttribute(
      "data-title-color",
      "var(--color-cc-muted)",
    );

    fireEvent.click(screen.getByText("Simulate moved-message tab"));
    const movedTabs = screen.getAllByTestId("thread-tab");
    expect(movedTabs[0]).toHaveAttribute("data-thread-key", "q-99");
    expect(movedTabs[0]).toHaveAttribute("data-new-tab", "true");
  });
});
