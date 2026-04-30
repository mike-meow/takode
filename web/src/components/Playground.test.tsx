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

    const marker = screen.getAllByTestId("thread-system-marker-cluster")[0];
    expect(marker).toHaveTextContent("1 message moved to thread:q-961");
    expect(marker).toHaveTextContent("Work continued from Main to thread:q-962");
    expect(marker).not.toHaveTextContent("activities in thread:");
    expect(within(marker).queryByText("Jump")).toBeNull();
    expect(within(marker).getByRole("button", { name: "thread:q-961" })).toBeTruthy();
    expect(within(marker).getByRole("button", { name: "thread:q-962" })).toBeTruthy();
  });

  it("documents Work Board Bar tab shrinking, phase legend, and shared quest hover states", async () => {
    render(<Playground />);

    fireEvent.click(screen.getByText("Seed board data"));

    const rail = screen.getByTestId("thread-tab-rail");
    expect(rail).toHaveAttribute("data-overflow", "horizontal-scroll-after-min");
    expect(screen.getByTestId("workboard-main-banner")).toBeTruthy();
    expect(screen.getByTestId("workboard-summary-button")).toHaveTextContent("Open Workboard");
    expect(screen.queryByTestId("workboard-current-thread")).toBeNull();
    expect(screen.getByTestId("thread-main-tab")).toHaveTextContent("Main Thread");
    expect(screen.getByTestId("thread-main-tab")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("thread-main-tab")).toHaveClass("border-amber-400/60", "bg-cc-bg");
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
    expect(within(rail).queryByText("Active")).not.toBeInTheDocument();
    expect(tabs[0]).toHaveClass("min-w-[6.25rem]", "max-w-[18rem]", "flex-[1_1_11rem]");
    expect(tabs[0]).toHaveAttribute("data-closable", "false");
    expect(within(tabs[0]).queryByTestId("thread-tab-close")).not.toBeInTheDocument();
    const queuedTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-55");
    expect(within(queuedTab!).getByTestId("thread-tab-title")).toHaveAttribute(
      "data-title-color",
      "var(--color-cc-fg)",
    );
    const completedTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-88");
    expect(completedTab).toHaveAttribute("data-closable", "true");
    expect(within(completedTab!).getByTestId("thread-tab-close")).toHaveAttribute("data-compact-close", "true");
    expect(within(completedTab!).getByTestId("thread-tab-title")).toHaveAttribute(
      "data-title-color",
      "var(--color-cc-muted)",
    );
    const activeQuestTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-42");
    expect(activeQuestTab).toHaveAttribute("data-has-quest-hover", "true");
    expect(activeQuestTab).not.toHaveAttribute("title");

    fireEvent.mouseEnter(activeQuestTab!);
    const hoverCard = await screen.findByTestId("quest-hover-card");
    expect(within(hoverCard).getByText("Fix mobile sidebar overflow")).toBeTruthy();
    expect(within(hoverCard).getByTestId("quest-journey-preview-card")).toBeTruthy();
    expect(within(hoverCard).getByTestId("quest-journey-timeline")).toHaveAttribute("data-journey-mode", "active");
    expect(within(hoverCard).getByTestId("quest-hover-worker-session")).toHaveTextContent("Worker");
    expect(within(hoverCard).getByTestId("quest-hover-reviewer-session")).toHaveTextContent("Reviewer");
    expect(within(hoverCard).getByRole("link", { name: "#5" })).toBeTruthy();
    expect(within(hoverCard).getByRole("link", { name: "#6" })).toBeTruthy();

    fireEvent.click(screen.getByText("Simulate moved-message tab"));
    const movedTabs = screen.getAllByTestId("thread-tab");
    expect(movedTabs[0]).toHaveAttribute("data-thread-key", "q-99");
    expect(movedTabs[0]).toHaveAttribute("data-new-tab", "true");
    expect(screen.queryByTestId("workboard-main-banner")).toBeNull();
    expect(screen.getByTestId("thread-tab-rail")).toBeTruthy();

    fireEvent.click(screen.getByText("Main banner"));
    fireEvent.click(screen.getByTestId("workboard-summary-button"));
    expect(screen.getByTestId("workboard-thread-main")).toHaveAttribute("data-variant", "compact");
    expect(screen.getByTestId("workboard-thread-all")).toHaveAttribute("data-secondary", "true");
  });

  it("documents compact quest-thread banners without chip note counts and with tap previews", () => {
    render(<Playground />);

    const banner = screen.getAllByTestId("quest-thread-banner")[0];
    expect(banner).toHaveClass("py-1");
    expect(within(banner).getByTestId("quest-thread-meta-strip")).toHaveClass("flex-[1_1_auto]");
    expect(within(banner).getByTestId("quest-thread-participant-strip")).toHaveClass("inline-flex");
    expect(within(banner).getByTestId("quest-journey-compact-summary")).toHaveTextContent("Implement");
    expect(within(banner).getByTestId("quest-journey-compact-summary")).not.toHaveTextContent("note");

    fireEvent.click(within(banner).getByTestId("quest-thread-journey-hover-target"));
    const hoverCard = screen.getByTestId("quest-thread-journey-hover-card");
    expect(hoverCard).toBeTruthy();
    expect(within(hoverCard).getByTestId("quest-journey-preview-card")).toHaveTextContent("Visual outcome review");
  });
});
