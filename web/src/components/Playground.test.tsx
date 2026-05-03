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

    expect(within(realChat).getByText("Thread routing reminder")).toBeTruthy();
    expect(within(realChat).getByText("model-only")).toBeTruthy();
    expect(within(realChat).queryByText(/Missing thread marker/)).toBeNull();

    fireEvent.click(within(realChat).getByRole("button", { name: "Expand Thread routing reminder" }));
    expect(within(realChat).getByText(/^\[Thread routing reminder\]/)).toBeTruthy();
  });

  it("documents multi-file Write blocks whose change diff fields contain raw file content", () => {
    render(<Playground />);

    expect(screen.getByRole("button", { name: /Write File.*2 files/ })).toBeTruthy();
    expect(screen.getByText("full_datagen_inner.sh")).toBeTruthy();
    expect(screen.getByText("launch_tmux_retry.sh")).toBeTruthy();
    expect(document.body).toHaveTextContent("set -uo pipefail");
    expect(document.body).toHaveTextContent("tmux new-session");
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

  it("documents additive source projection without source attachment markers", () => {
    render(<Playground />);

    expect(screen.queryByText("Thread opened")).toBeNull();
    expect(
      screen
        .getAllByTestId("attention-ledger-row")
        .some((row) => row.getAttribute("data-attention-type") === "quest_thread_created"),
    ).toBe(false);

    expect(screen.getByText("Earlier context attached to the implementation quest.")).toBeTruthy();

    const marker = screen.getAllByTestId("thread-system-marker-cluster")[0];
    expect(marker).toHaveTextContent("Work continued from Main to thread:q-962");
    expect(marker).not.toHaveTextContent("activities in thread:");
    expect(within(marker).queryByText("Jump")).toBeNull();
    expect(within(marker).getByRole("button", { name: "thread:q-962" })).toBeTruthy();
  });

  it("documents Journey finished as green while completed Journey starts stay quiet", () => {
    render(<Playground />);

    const rows = screen.getAllByTestId("attention-ledger-row");
    const finishedRow = rows.find((row) => row.textContent?.includes("Journey finished"));
    const completedStartRow = rows.find((row) => row.textContent?.includes("Completed Journey start is quiet"));

    expect(finishedRow).toBeTruthy();
    expect(finishedRow).toHaveClass("border-emerald-400/30", "bg-emerald-500/10");
    expect(completedStartRow).toBeTruthy();
    expect(completedStartRow).toHaveClass("border-cc-border/70", "bg-cc-card/35");
    expect(completedStartRow).not.toHaveClass("bg-emerald-500/10");
  });

  it("documents Work Board Bar tab shrinking, phase legend, and shared quest hover states", async () => {
    render(<Playground />);

    fireEvent.click(screen.getByText("Seed board data"));

    const rail = screen.getByTestId("thread-tab-rail");
    expect(rail).toHaveAttribute("data-overflow", "horizontal-scroll-after-min");
    expect(within(rail).queryByText("Tabs")).not.toBeInTheDocument();
    const tabStrip = screen.getByTestId("thread-tab-strip");
    expect(tabStrip).toHaveAttribute("data-scrollbar", "thin-transient");
    expect(tabStrip).toHaveAttribute("data-scrollbar-active", "false");
    expect(tabStrip).toHaveClass("overflow-y-hidden");
    expect(screen.getByTestId("workboard-main-banner")).toBeTruthy();
    expect(
      rail.compareDocumentPosition(screen.getByTestId("workboard-main-banner")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId("workboard-summary-button")).toHaveTextContent("Open Workboard");
    expect(
      screen
        .getByTestId("workboard-summary-button")
        .compareDocumentPosition(screen.getByTestId("workboard-phase-summary")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByTestId("workboard-current-thread")).toBeNull();
    expect(screen.getByTestId("thread-main-tab")).toHaveTextContent("Main Thread");
    expect(screen.getByTestId("thread-main-tab")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("thread-main-tab")).toHaveClass("border-violet-100/45", "border-b-transparent");
    expect(screen.getByTestId("thread-main-tab")).not.toHaveClass("border-amber-400/60", "border-cc-primary/70");
    expect(screen.getByTestId("workboard-phase-summary")).toHaveTextContent("1 Implement");
    const mainTitle = within(screen.getByTestId("thread-main-tab")).getByTestId("thread-tab-title");
    expect(mainTitle).toHaveAttribute("data-active-output", "false");
    expect(
      within(screen.getByTestId("thread-main-tab")).queryByTestId("thread-tab-active-output-indicator"),
    ).toBeNull();
    expect(mainTitle.getAttribute("style") ?? "").not.toContain("animation");
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
    const activeOutputTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-42");
    expect(activeOutputTab).toHaveAttribute("data-active-output", "true");
    const activeOutputMarker = within(activeOutputTab!).getByTestId("thread-tab-active-output-indicator");
    expect(activeOutputMarker).toHaveAttribute("data-reduced-motion-static", "true");
    expect(activeOutputMarker).toHaveAttribute("data-dot-position", "left");
    expect(activeOutputMarker).toHaveAttribute("data-overlaps-needs-input", "true");
    expect(within(activeOutputMarker).getByTestId("thread-tab-active-output-glint")).toHaveClass(
      "thread-tab-output-glint",
    );
    expect(within(activeOutputMarker).getByTestId("thread-tab-active-output-dot")).toHaveClass(
      "left-1.5",
      "top-1/2",
      "h-3",
      "w-3",
      "-translate-y-1/2",
    );
    expect(within(activeOutputTab!).getByTestId("thread-tab-needs-input-bell")).toHaveClass("relative", "z-10");
    expect(within(activeOutputTab!).getByTestId("thread-tab-title")).toHaveAttribute("data-active-output", "true");
    expect(within(activeOutputTab!).getByTestId("thread-tab-title").getAttribute("style") ?? "").not.toContain(
      "animation",
    );
    const queuedTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-55");
    expect(queuedTab).toHaveAttribute("data-active-output", "false");
    expect(within(queuedTab!).queryByTestId("thread-tab-active-output-indicator")).toBeNull();
    expect(within(queuedTab!).getByTestId("thread-tab-title")).toHaveAttribute(
      "data-title-color",
      "var(--color-cc-fg)",
    );
    const completedTab = tabs.find((tab) => tab.getAttribute("data-thread-key") === "q-88");
    expect(completedTab).toHaveAttribute("data-closable", "true");
    expect(within(completedTab!).getByTestId("thread-tab-close")).toHaveAttribute("data-compact-close", "true");
    expect(within(completedTab!).getByTestId("thread-tab-close")).toHaveClass(
      "sm:w-0",
      "sm:group-hover:w-5",
      "focus-visible:w-5",
    );
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
    expect(within(hoverCard).getByRole("link", { name: "Worker #5 Clear Mesa" })).toBeTruthy();
    expect(within(hoverCard).getByRole("link", { name: "Reviewer #6 Review Lead" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Quest thread" }));
    const selectedActiveQuestTab = screen
      .getAllByTestId("thread-tab")
      .find((tab) => tab.getAttribute("data-thread-key") === "q-42")!;
    expect(within(selectedActiveQuestTab).getByTestId("thread-tab-select")).toHaveAttribute("aria-pressed", "true");
    expect(selectedActiveQuestTab).toHaveClass("border-violet-100/45", "border-b-transparent");
    expect(selectedActiveQuestTab).toHaveAttribute("data-active-output", "true");
    expect(within(selectedActiveQuestTab).getByTestId("thread-tab-active-output-indicator")).toBeTruthy();

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
    expect(screen.getByTestId("workboard-other-threads-toggle")).toHaveTextContent("2 other");
    expect(screen.getByTestId("workboard-other-threads-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(
      within(screen.getByTestId("workboard-off-board-threads")).queryByText("Off-board routed discussion"),
    ).toBeNull();
    fireEvent.click(screen.getByTestId("workboard-other-threads-toggle"));
    expect(screen.getByTestId("workboard-other-threads-content")).toHaveTextContent("Off-board routed discussion");
  });

  it("documents compact quest-thread banners without chip note counts and with tap previews", () => {
    render(<Playground />);

    expect(screen.getAllByText(/long Quest Journey preview clamped around the current phase/).length).toBeGreaterThan(
      0,
    );

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
