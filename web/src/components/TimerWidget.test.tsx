// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SessionTimer } from "../types.js";

// ─── Mock store ──────────────────────────────────────────────────────────────

interface MockStoreState {
  sessionTimers: Map<string, SessionTimer[]>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    sessionTimers: new Map(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(mockState),
}));

// Mock the cancel API so tests don't make real HTTP calls.
vi.mock("../api.js", () => ({
  api: {
    cancelTimer: vi.fn(() => Promise.resolve()),
  },
}));

const { TimerChip, TimerModal } = await import("./TimerWidget.js");
const { api } = await import("../api.js");

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTimer(overrides: Partial<SessionTimer> = {}): SessionTimer {
  return {
    id: "t1",
    sessionId: "s1",
    title: "Check the build status",
    description: "Inspect the latest failing shard if the build is red.",
    type: "delay",
    originalSpec: "30m",
    nextFireAt: Date.now() + 1_800_000, // 30m from now
    createdAt: Date.now() - 600_000,
    fireCount: 0,
    ...overrides,
  };
}

// ─── TimerChip ───────────────────────────────────────────────────────────────

describe("TimerChip", () => {
  it("renders nothing when there are no timers", () => {
    // Verifies the chip is invisible when the session has no active timers.
    const { container } = render(<TimerChip sessionId="s1" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a compact single-timer chip with count and next fire time", () => {
    // The collapsed chip should stay small: collapse count and countdown into
    // one short label, not the verbose "N timers" plus a second timing segment.
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer()]]]),
    });
    render(<TimerChip sessionId="s1" />);
    expect(screen.getByText(/1 ⏰ in/)).toBeInTheDocument();
    expect(screen.queryByText("1 timer")).toBeNull();
    expect(screen.queryByText(/next in/)).toBeNull();
    expect(screen.queryByText("Check the build status")).toBeNull();
  });

  it("uses the compact count-plus-icon label for multiple timers too", () => {
    resetStore({
      sessionTimers: new Map([
        [
          "s1",
          [
            makeTimer({ id: "t1", nextFireAt: Date.now() + 60_000 }),
            makeTimer({ id: "t2", nextFireAt: Date.now() + 120_000 }),
          ],
        ],
      ]),
    });
    render(<TimerChip sessionId="s1" />);
    expect(screen.getByText(/2 ⏰ in/)).toBeInTheDocument();
  });

  it("shows next fire time from the soonest timer", () => {
    // The chip should display the countdown for the timer that fires soonest,
    // regardless of insertion order.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T09:00:00Z"));
    const soonest = Date.now() + 120_000; // 2m
    const later = Date.now() + 7_200_000; // 2h
    resetStore({
      sessionTimers: new Map([
        ["s1", [makeTimer({ id: "t1", nextFireAt: later }), makeTimer({ id: "t2", nextFireAt: soonest })]],
      ]),
    });
    render(<TimerChip sessionId="s1" />);
    // New M:SS format: 120s = "2:00"
    expect(screen.getByText(/2 ⏰ in 2:00/)).toBeInTheDocument();
  });

  it("uses an hour-only compact label for multi-hour waits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T09:00:00Z"));
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer({ nextFireAt: Date.now() + 7_200_000 })]]]),
    });
    render(<TimerChip sessionId="s1" />);
    expect(screen.getByText(/1 ⏰ in 2h/)).toBeInTheDocument();
    expect(screen.queryByText(/2h 0m/)).toBeNull();
  });

  it("uses a day-only compact label for multi-day waits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T09:00:00Z"));
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer({ nextFireAt: Date.now() + 172_800_000 })]]]),
    });
    render(<TimerChip sessionId="s1" />);
    expect(screen.getByText(/1 ⏰ in 2d/)).toBeInTheDocument();
    expect(screen.queryByText(/48h/)).toBeNull();
    expect(screen.queryByText(/2d 0h/)).toBeNull();
  });

  it("keeps sub-24-hour waits in the hour bucket instead of rounding up to a day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T09:00:00Z"));
    resetStore({
      sessionTimers: new Map([
        [
          "s1",
          [
            makeTimer({ id: "t1", nextFireAt: Date.now() + (23 * 60 + 1) * 60_000 }),
            makeTimer({ id: "t2", nextFireAt: Date.now() + (23 * 60 + 59) * 60_000 }),
          ],
        ],
      ]),
    });
    render(<TimerChip sessionId="s1" />);
    expect(screen.getByText(/2 ⏰ in 23h/)).toBeInTheDocument();
    expect(screen.queryByText(/1d/)).toBeNull();
  });

  it("opens the modal on click", () => {
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer()]]]),
    });
    render(<TimerChip sessionId="s1" />);
    fireEvent.click(screen.getByRole("button"));
    // Modal should now be visible with the "Session Timers" heading.
    expect(screen.getByText("Session Timers")).toBeInTheDocument();
  });
});

// ─── TimerModal ──────────────────────────────────────────────────────────────

describe("TimerModal", () => {
  it("renders timer title with only the first description line by default", () => {
    // Verifies the anchored timer view separates title from description and collapses
    // the description to its first line for scan-friendly reading.
    const description = "First line summary\nSecond line detail\nThird line detail";
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer({ title: "Check the build status", description })]]]),
    });
    const onClose = vi.fn();
    render(<TimerModal sessionId="s1" onClose={onClose} />);
    expect(screen.getByText("Check the build status")).toBeInTheDocument();
    expect(screen.getByText("First line summary")).toBeInTheDocument();
    expect(screen.queryByText("Second line detail")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand timer t1 description" })).toBeInTheDocument();
  });

  it("expands the timer description on demand", () => {
    // Verifies additional detail stays hidden until the user explicitly expands it.
    const description = "First line summary\nSecond line detail";
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer({ description })]]]),
    });
    render(<TimerModal sessionId="s1" onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand timer t1 description" }));

    expect(screen.getByText(/Second line detail/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse timer t1 description" })).toBeInTheDocument();
  });

  it("shows type labels for recurring and at timers, but not for delay", () => {
    // Delay timers only show countdown; recurring/at timers show schedule info.
    resetStore({
      sessionTimers: new Map([
        [
          "s1",
          [
            makeTimer({ id: "t1", type: "delay", originalSpec: "30m" }),
            makeTimer({ id: "t2", type: "recurring", originalSpec: "10m" }),
            makeTimer({ id: "t3", type: "at", originalSpec: "3pm" }),
          ],
        ],
      ]),
    });
    render(<TimerModal sessionId="s1" onClose={vi.fn()} />);
    expect(screen.getByText("every 10m")).toBeInTheDocument();
    expect(screen.getByText("at 3pm")).toBeInTheDocument();
    // "delay" type should NOT show "30m" as a schedule label (only as countdown).
    expect(screen.queryByText("30m")).not.toBeInTheDocument();
  });

  it("shows empty state when no timers exist", () => {
    render(<TimerModal sessionId="s1" onClose={vi.fn()} />);
    expect(screen.getByText("No active timers")).toBeInTheDocument();
  });

  it("closes on Escape key", () => {
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer()]]]),
    });
    const onClose = vi.fn();
    render(<TimerModal sessionId="s1" onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on outside click", async () => {
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer()]]]),
    });
    const onClose = vi.fn();
    render(<TimerModal sessionId="s1" onClose={onClose} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when clicking inside the anchored timer view", () => {
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer()]]]),
    });
    const onClose = vi.fn();
    render(<TimerModal sessionId="s1" onClose={onClose} />);
    // Clicking the timer title inside the popover should not trigger close.
    fireEvent.click(screen.getByText("Check the build status"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls cancelTimer API when cancel button is clicked", () => {
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer({ id: "t1" })]]]),
    });
    render(<TimerModal sessionId="s1" onClose={vi.fn()} />);
    const cancelBtn = screen.getByTitle("Cancel timer");
    fireEvent.click(cancelBtn);
    expect(api.cancelTimer).toHaveBeenCalledWith("s1", "t1");
  });

  it("shows timer count in header", () => {
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer({ id: "t1" }), makeTimer({ id: "t2" })]]]),
    });
    render(<TimerModal sessionId="s1" onClose={vi.fn()} />);
    expect(screen.getByText("(2)")).toBeInTheDocument();
  });
});
