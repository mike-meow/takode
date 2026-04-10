// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTimer(overrides: Partial<SessionTimer> = {}): SessionTimer {
  return {
    id: "t1",
    sessionId: "s1",
    prompt: "Check the build status",
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

  it("renders a chip with timer count and next fire time", () => {
    // Verifies the chip shows the correct count and relative time for
    // the soonest timer.
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer()]]]),
    });
    render(<TimerChip sessionId="s1" />);
    expect(screen.getByText("1 timer")).toBeInTheDocument();
    expect(screen.getByText(/next in/)).toBeInTheDocument();
  });

  it("pluralises 'timers' for multiple entries", () => {
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
    expect(screen.getByText("2 timers")).toBeInTheDocument();
  });

  it("shows next fire time from the soonest timer", () => {
    // The chip should display the countdown for the timer that fires soonest,
    // regardless of insertion order.
    const soonest = Date.now() + 120_000; // 2m
    const later = Date.now() + 7_200_000; // 2h
    resetStore({
      sessionTimers: new Map([
        [
          "s1",
          [
            makeTimer({ id: "t1", nextFireAt: later }),
            makeTimer({ id: "t2", nextFireAt: soonest }),
          ],
        ],
      ]),
    });
    render(<TimerChip sessionId="s1" />);
    expect(screen.getByText(/next in 2m/)).toBeInTheDocument();
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
  it("renders timer list with full prompt text", () => {
    // Verifies the modal shows the complete, untruncated prompt for each timer.
    const longPrompt = "Check the build status and report back to the team with the full log output";
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer({ prompt: longPrompt })]]]),
    });
    const onClose = vi.fn();
    render(<TimerModal sessionId="s1" onClose={onClose} />);
    expect(screen.getByText(longPrompt)).toBeInTheDocument();
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

  it("closes on backdrop click", () => {
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer()]]]),
    });
    const onClose = vi.fn();
    render(<TimerModal sessionId="s1" onClose={onClose} />);
    // The outermost dialog div acts as the backdrop click target.
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when clicking inside the modal card", () => {
    resetStore({
      sessionTimers: new Map([["s1", [makeTimer()]]]),
    });
    const onClose = vi.fn();
    render(<TimerModal sessionId="s1" onClose={onClose} />);
    // Clicking the timer prompt text (inside the card) should not trigger close.
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
      sessionTimers: new Map([
        ["s1", [makeTimer({ id: "t1" }), makeTimer({ id: "t2" })]],
      ]),
    });
    render(<TimerModal sessionId="s1" onClose={vi.fn()} />);
    expect(screen.getByText("(2)")).toBeInTheDocument();
  });
});
