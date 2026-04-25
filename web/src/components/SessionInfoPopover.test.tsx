// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { api } from "../api.js";
import { openPathWithEditorPreference } from "../utils/vscode-bridge.js";

interface MockStoreState {
  sessions: Map<
    string,
    {
      session_id?: string;
      cwd?: string;
      model?: string;
      backend_type?: "claude" | "codex" | "claude-sdk";
      num_turns?: number;
      total_cost_usd?: number;
      context_used_percent?: number;
      message_history_bytes?: number;
      codex_retained_payload_bytes?: number;
      codex_token_details?: { modelContextWindow?: number };
      claude_token_details?: { modelContextWindow?: number };
      git_branch?: string | null;
      is_worktree?: boolean;
      git_ahead?: number;
      git_behind?: number;
      total_lines_added?: number;
      total_lines_removed?: number;
      repo_root?: string;
    }
  >;
  sdkSessions: Array<{
    sessionId: string;
    cwd?: string;
    backendType?: "claude" | "codex" | "claude-sdk";
    contextUsedPercent?: number;
    codexTokenDetails?: { modelContextWindow?: number };
    claudeTokenDetails?: { modelContextWindow?: number };
    sessionNum?: number | null;
    herdedBy?: string;
    isOrchestrator?: boolean;
    archived?: boolean;
  }>;
  sessionTaskHistory: Map<string, Array<{ title: string; source?: "quest"; questId?: string }>>;
  sessionNames: Map<string, string>;
  connectionStatus: Map<string, string>;
}

let storeState: MockStoreState;

function resetStore(taskHistory: Array<{ title: string; source?: "quest"; questId?: string }>) {
  storeState = {
    sessions: new Map([
      [
        "s1",
        {
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
        },
      ],
    ]),
    sdkSessions: [{ sessionId: "s1", cwd: "/repo", backendType: "codex" }],
    sessionTaskHistory: new Map([["s1", taskHistory]]),
    sessionNames: new Map(),
    connectionStatus: new Map([["s1", "connected"]]),
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

vi.mock("./TaskPanel.js", () => ({
  GitHubPRSection: () => null,
  McpCollapsible: () => null,
  ClaudeMdCollapsible: () => null,
  HerdDiagnosticsSection: () => null,
  SystemPromptCollapsible: () => null,
}));

vi.mock("../ws.js", () => ({
  sendToSession: vi.fn(),
}));

vi.mock("../api.js", () => ({
  api: {
    getSettings: vi.fn(),
  },
}));

vi.mock("../utils/vscode-bridge.js", () => ({
  openPathWithEditorPreference: vi.fn(),
}));

import { SessionInfoPopover } from "./SessionInfoPopover.js";

describe("SessionInfoPopover", () => {
  beforeEach(() => {
    window.location.hash = "#/session/s1";
    vi.mocked(api.getSettings).mockReset();
    vi.mocked(api.getSettings).mockResolvedValue({ editorConfig: { editor: "cursor" } } as Awaited<
      ReturnType<typeof api.getSettings>
    >);
    vi.mocked(openPathWithEditorPreference).mockReset();
    vi.mocked(openPathWithEditorPreference).mockResolvedValue(true);
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
      resetStore(Array.from({ length: 20 }, (_, i) => ({ title: `Task ${i + 1}` })));
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

  it("does not close when clicking inside SystemPromptModal portal content", () => {
    // System prompt modal is portaled to document.body, so clicks inside it
    // would normally trigger the popover's outside-click handler. The guard
    // for data-session-info-modal prevents this.
    resetStore([]);
    const onClose = vi.fn();
    vi.useFakeTimers();
    try {
      render(<SessionInfoPopover sessionId="s1" onClose={onClose} />);
      vi.runAllTimers();

      const modalNode = document.createElement("div");
      modalNode.setAttribute("data-session-info-modal", "true");
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

  it("shows worktree and base repo paths separately with the trailing worktree segment emphasized", () => {
    resetStore([]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    session.cwd = "/Users/test/.companion/worktrees/companion/jiayi-wt-3116";
    session.repo_root = "/Users/test/Code/companion";
    session.is_worktree = true;
    storeState.sdkSessions = [
      {
        sessionId: "s1",
        cwd: session.cwd,
        backendType: "codex",
      },
    ];

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("Worktree")).toBeInTheDocument();
    expect(screen.getByText("Base repo")).toBeInTheDocument();
    expect(screen.getByTestId("session-info-path-worktree-tail")).toHaveTextContent("jiayi-wt-3116");
    expect(screen.getByTestId("session-info-path-repo-tail")).toHaveTextContent("companion");
    expect(screen.getByTitle("/Users/test/.companion/worktrees/companion/jiayi-wt-3116")).toBeInTheDocument();
    expect(screen.getByTitle("/Users/test/Code/companion")).toBeInTheDocument();
    expect(screen.getByTestId("session-info-path-worktree-scroller")).toHaveClass("overflow-x-auto");
    expect(screen.getByTestId("session-info-path-worktree-tail")).toHaveTextContent(
      "/Users/test/.companion/worktrees/companion/jiayi-wt-3116",
    );
    expect(screen.getByRole("button", { name: "Copy Worktree" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Base repo" })).toBeInTheDocument();
  });

  it("opens the session working directory through the configured editor", async () => {
    resetStore([]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    session.cwd = "/Users/test/.companion/worktrees/companion/jiayi-wt-3116";
    session.repo_root = "/Users/test/Code/companion";
    session.is_worktree = true;
    storeState.sdkSessions = [
      {
        sessionId: "s1",
        cwd: session.cwd,
        backendType: "codex",
      },
    ];
    vi.mocked(api.getSettings).mockResolvedValue({ editorConfig: { editor: "cursor" } } as Awaited<
      ReturnType<typeof api.getSettings>
    >);

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const button = await screen.findByTestId("session-info-open-working-directory");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    await waitFor(() => {
      expect(openPathWithEditorPreference).toHaveBeenCalledWith(
        {
          absolutePath: "/Users/test/.companion/worktrees/companion/jiayi-wt-3116",
          targetKind: "directory",
        },
        "cursor",
      );
    });
  });

  it("disables the working directory open action when no editor is configured", async () => {
    resetStore([]);
    vi.mocked(api.getSettings).mockResolvedValue({ editorConfig: { editor: "none" } } as Awaited<
      ReturnType<typeof api.getSettings>
    >);

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const button = await screen.findByTestId("session-info-open-working-directory");
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute("title", "Configure an editor in Settings to open this directory.");
  });

  it("shows an inline error when the configured editor cannot open the working directory", async () => {
    resetStore([]);
    vi.mocked(openPathWithEditorPreference).mockRejectedValue(new Error("Editor failed"));

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    const button = await screen.findByTestId("session-info-open-working-directory");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    expect(await screen.findByTestId("session-info-open-editor-error")).toHaveTextContent("Editor failed");
  });

  it("shows concise herd relationship chips in the info panel", () => {
    resetStore([]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    session.cwd = "/repo/worker";
    storeState.sdkSessions = [
      {
        sessionId: "leader-1",
        cwd: "/repo",
        backendType: "codex",
        sessionNum: 7,
        isOrchestrator: true,
      },
      {
        sessionId: "s1",
        cwd: "/repo/worker",
        backendType: "codex",
        sessionNum: 11,
        herdedBy: "leader-1",
      },
    ];

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("Herded by")).toBeInTheDocument();
    expect(screen.getByTestId("session-info-herded-by")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "#7" })).toBeInTheDocument();
  });

  it("shows concise herding chips for leader sessions in the info panel", () => {
    resetStore([]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    session.cwd = "/repo";
    storeState.sdkSessions = [
      {
        sessionId: "s1",
        cwd: "/repo",
        backendType: "codex",
        sessionNum: 11,
        isOrchestrator: true,
      },
      {
        sessionId: "worker-1",
        cwd: "/repo/worktree-1",
        backendType: "codex",
        sessionNum: 21,
        herdedBy: "s1",
      },
      {
        sessionId: "worker-2",
        cwd: "/repo/worktree-2",
        backendType: "claude",
        sessionNum: 22,
        herdedBy: "s1",
      },
    ];
    storeState.sessionNames = new Map([
      ["worker-1", "Fix notification links"],
      ["worker-2", "Improve hover chips"],
    ]);

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("Herding")).toBeInTheDocument();
    const section = screen.getByTestId("session-info-herding");
    expect(within(section).getByRole("button", { name: "#21" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "#22" })).toBeInTheDocument();
    expect(within(section).queryByText("Fix notification links")).toBeNull();
    expect(within(section).queryByText("Improve hover chips")).toBeNull();
  });

  it("shows the max context window rounded to whole K tokens", () => {
    // Codex sessions should show both replay and retained payload metrics in
    // the shared stats row when the server provides both values.
    resetStore([]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    session.context_used_percent = 73;
    session.message_history_bytes = 1_572_864;
    session.codex_retained_payload_bytes = 2_621_440;
    session.codex_token_details = { modelContextWindow: 258_400 };

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("73% context")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB replay")).toBeInTheDocument();
    expect(screen.getByText("2.5 MB retained")).toBeInTheDocument();
    expect(screen.getByText("258 K tokens")).toBeInTheDocument();
  });

  it("keeps non-Codex sessions on history wording and hides retained payload", () => {
    // Claude-family sessions should keep the generic history label and should
    // not render the Codex-only retained payload metric.
    resetStore([]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    session.backend_type = "claude-sdk";
    session.context_used_percent = 41;
    session.message_history_bytes = 972_800;
    session.claude_token_details = { modelContextWindow: 200_000 };

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("950 KB history")).toBeInTheDocument();
    expect(screen.queryByText(/retained/)).toBeNull();
  });

  it("falls back to sdk session metadata for context stats after restore", () => {
    resetStore([]);
    storeState.sessions = new Map();
    storeState.sdkSessions = [
      {
        sessionId: "s1",
        cwd: "/repo",
        backendType: "codex",
        contextUsedPercent: 73,
        codexTokenDetails: { modelContextWindow: 258_400 },
      },
    ];

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("73% context")).toBeInTheDocument();
    expect(screen.getByText("258 K tokens")).toBeInTheDocument();
  });

  it("shows turns, context, and context window for Claude SDK sessions (no cost)", () => {
    resetStore([]);
    const session = storeState.sessions.get("s1");
    if (!session) throw new Error("missing session fixture");
    session.backend_type = "claude-sdk";
    session.num_turns = 7;
    session.total_cost_usd = 1.25;
    session.context_used_percent = 41;
    session.claude_token_details = { modelContextWindow: 200_000 };

    render(<SessionInfoPopover sessionId="s1" onClose={() => {}} />);

    expect(screen.getByText("41% context")).toBeInTheDocument();
    expect(screen.getByText("200 K tokens")).toBeInTheDocument();
    // Turns now shown for all backends
    expect(screen.getByText("7 turns")).toBeInTheDocument();
    // Cost is never shown
    expect(screen.queryByText("$1.25")).toBeNull();
  });
});
