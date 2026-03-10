// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  sessions: Map<string, {
    session_id?: string;
    cwd?: string;
    model?: string;
    backend_type?: "claude" | "codex";
    num_turns?: number;
    total_cost_usd?: number;
    context_used_percent?: number;
    codex_token_details?: { modelContextWindow?: number };
    git_branch?: string | null;
    is_worktree?: boolean;
    git_ahead?: number;
    git_behind?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
    repo_root?: string;
  }>;
  sdkSessions: Array<{
    sessionId: string;
    cwd?: string;
    backendType?: "claude" | "codex";
    contextUsedPercent?: number;
    codexTokenDetails?: { modelContextWindow?: number };
  }>;
  sessionTaskHistory: Map<string, Array<{ title: string; source?: "quest"; questId?: string }>>;
}

let storeState: MockStoreState;

function resetStore(taskHistory: Array<{ title: string; source?: "quest"; questId?: string }>) {
  storeState = {
    sessions: new Map([
      ["s1", {
        session_id: "s1",
        cwd: "/repo",
        model: "gpt-5.3-codex",
        backend_type: "codex",
        num_turns: 2,
        total_cost_usd: 0,
        context_used_percent: 0,
        git_branch: "jiayi",
        is_worktree: true,
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        repo_root: "/repo",
      }],
    ]),
    sdkSessions: [{ sessionId: "s1", cwd: "/repo", backendType: "codex" }],
    sessionTaskHistory: new Map([["s1", taskHistory]]),
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

vi.mock("./TaskPanel.js", () => ({
  GitHubPRSection: () => null,
  McpCollapsible: () => null,
  ClaudeMdCollapsible: () => null,
}));

import { SessionInfoPopover } from "./SessionInfoPopover.js";

describe("SessionInfoPopover", () => {
  beforeEach(() => {
    window.location.hash = "#/session/s1";
  });

  it("navigates to questmaster focused quest when clicking a quest history row", () => {
    resetStore([
      { title: "Install ripgrep in agent environment", source: "quest", questId: "q-67" },
      { title: "Fix codex usage bars stuck at zero" },
    ]);
    const onClose = vi.fn();
    render(<SessionInfoPopover sessionId="s1" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Install ripgrep in agent environment" }));

    expect(window.location.hash).toBe("#/questmaster?quest=q-67");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render quest history row as a link when questId is missing", () => {
    resetStore([{ title: "Quest without id", source: "quest" }]);
    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.queryByRole("button", { name: "Quest without id" })).toBeNull();
    expect(screen.getByText("Quest without id")).toBeInTheDocument();
  });

  it("renders quest task rows without native hover tooltips", () => {
    resetStore([{ title: "Open q-42", source: "quest", questId: "q-42" }]);
    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const questButton = screen.getByRole("button", { name: "Open q-42" });
    expect(questButton).not.toHaveAttribute("title");
  });

  it("keeps task history compact and auto-scrolls to newest task", async () => {
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(420);
    try {
      resetStore(
        Array.from({ length: 20 }, (_, i) => ({ title: `Task ${i + 1}` })),
      );
      render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

      const scroller = screen.getByTestId("task-history-scroll");
      expect(scroller).toHaveClass("max-h-40");
      expect(scroller).toHaveClass("overflow-y-auto");
      await waitFor(() => {
        expect(scroller.scrollTop).toBe(420);
      });
    } finally {
      scrollHeightSpy.mockRestore();
    }
  });

  it("does not close when clicking inside ClaudeMdEditor portal content", () => {
    resetStore([]);
    const onClose = vi.fn();
    vi.useFakeTimers();
    try {
      render(<SessionInfoPopover sessionId="s1" onClose={onClose} />);
      vi.runAllTimers();

      const modalNode = document.createElement("div");
      modalNode.setAttribute("data-claude-md-editor-root", "true");
      document.body.appendChild(modalNode);
      fireEvent.mouseDown(modalNode);

      expect(onClose).not.toHaveBeenCalled();
      modalNode.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders git branch and diff stats near the top below the path", () => {
    resetStore([{ title: "Task one" }]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    session.git_branch = "jiayi-wt-5788";
    session.is_worktree = true;
    session.git_ahead = 1;
    session.git_behind = 5;
    session.total_lines_added = 69;
    session.total_lines_removed = 13;
    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const pathLine = screen.getByTitle("/repo");
    const branch = screen.getByText("jiayi-wt-5788");
    const tasksLabel = screen.getByText("Tasks");

    expect(branch.textContent).toContain("jiayi-wt-5788");
    expect(screen.getByText("1↑")).toBeInTheDocument();
    expect(screen.getByText("5↓")).toBeInTheDocument();
    expect(screen.getByText("+69")).toBeInTheDocument();
    expect(screen.getByText("-13")).toBeInTheDocument();
    expect(pathLine.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(branch.compareDocumentPosition(tasksLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the max context window rounded to whole K tokens", () => {
    resetStore([]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    session.context_used_percent = 73;
    session.codex_token_details = { modelContextWindow: 258_400 };

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("73% context")).toBeInTheDocument();
    expect(screen.getByText("258 K tokens")).toBeInTheDocument();
  });

  it("falls back to sdk session metadata for context stats after restore", () => {
    resetStore([]);
    storeState.sessions = new Map();
    storeState.sdkSessions = [{
      sessionId: "s1",
      cwd: "/repo",
      backendType: "codex",
      contextUsedPercent: 73,
      codexTokenDetails: { modelContextWindow: 258_400 },
    }];

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("73% context")).toBeInTheDocument();
    expect(screen.getByText("258 K tokens")).toBeInTheDocument();
  });
});
