// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockListActiveTimers = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    listActiveTimers: (...args: unknown[]) => mockListActiveTimers(...args),
  },
}));

vi.mock("./SessionInlineLink.js", () => ({
  SessionInlineLink: ({
    sessionId,
    children,
    className,
  }: {
    sessionId: string | null;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={sessionId ? `#/session/${sessionId}` : "#"} data-testid="session-inline-link" className={className}>
      {children}
    </a>
  ),
}));

import { ActiveTimersPage } from "./ActiveTimersPage.js";

describe("ActiveTimersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders active timers grouped by session metadata", async () => {
    // Verifies the scheduled page now surfaces real cross-session timers, not cron jobs.
    mockListActiveTimers.mockResolvedValue([
      {
        sessionId: "s1",
        sessionNum: 42,
        name: "Build Fixer",
        backendType: "claude",
        state: "running",
        cliConnected: true,
        cwd: "/repo/build",
        gitBranch: "fix/build",
        timers: [
          {
            id: "t1",
            sessionId: "s1",
            title: "Check build health",
            description: "Inspect the failing shard.",
            type: "delay",
            originalSpec: "90s",
            nextFireAt: 1_700_000_090_000,
            createdAt: 1_699_999_000_000,
            fireCount: 0,
          },
        ],
      },
      {
        sessionId: "s2",
        sessionNum: 51,
        name: "Docs Sweep",
        backendType: "codex",
        state: "idle",
        cliConnected: false,
        cwd: "/repo/docs",
        gitBranch: "docs/timers",
        timers: [
          {
            id: "t9",
            sessionId: "s2",
            title: "Refresh docs",
            description: "Regenerate the screenshots.",
            type: "recurring",
            originalSpec: "10m",
            nextFireAt: 1_700_000_600_000,
            createdAt: 1_699_999_000_000,
            intervalMs: 600_000,
            fireCount: 3,
          },
        ],
      },
    ]);

    render(<ActiveTimersPage embedded />);

    expect(await screen.findByText("Active Timers")).toBeInTheDocument();
    expect(await screen.findByText("Current Timers")).toBeInTheDocument();
    expect(screen.getByText("2 timers across 2 sessions.")).toBeInTheDocument();
    expect(screen.getByText("Check build health")).toBeInTheDocument();
    expect(screen.getByText("Refresh docs")).toBeInTheDocument();
    expect(screen.getByText("next in 1:30")).toBeInTheDocument();
    expect(screen.getByText("every 10m")).toBeInTheDocument();
    expect(screen.getByText("/repo/build")).toBeInTheDocument();
    expect(screen.getByText("docs/timers")).toBeInTheDocument();
    expect(screen.getAllByTestId("session-inline-link")[0]).toHaveAttribute("href", "#/session/s1");
  });

  it("renders an empty state when no timers exist", async () => {
    // Verifies the repurposed view does not suggest cron creation anymore.
    mockListActiveTimers.mockResolvedValue([]);

    render(<ActiveTimersPage embedded />);

    expect(await screen.findByText("No active timers across sessions.")).toBeInTheDocument();
  });

  it("renders the source session name through the shared session link component", async () => {
    mockListActiveTimers.mockResolvedValue([
      {
        sessionId: "s1",
        sessionNum: 42,
        name: "Build Fixer",
        backendType: "claude",
        state: "running",
        cliConnected: true,
        cwd: "/repo/build",
        gitBranch: "fix/build",
        timers: [
          {
            id: "t1",
            sessionId: "s1",
            title: "Check build health",
            description: "Inspect the failing shard.",
            type: "delay",
            originalSpec: "90s",
            nextFireAt: 1_700_000_090_000,
            createdAt: 1_699_999_000_000,
            fireCount: 0,
          },
        ],
      },
    ]);

    render(<ActiveTimersPage embedded />);

    expect(await screen.findByRole("link", { name: "Build Fixer" })).toHaveAttribute("href", "#/session/s1");
  });

  it("shows API failures inline", async () => {
    mockListActiveTimers.mockRejectedValue(new Error("timer backend unavailable"));

    render(<ActiveTimersPage embedded />);

    expect(await screen.findByText("timer backend unavailable")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Loading active timers...")).not.toBeInTheDocument();
    });
  });
});
