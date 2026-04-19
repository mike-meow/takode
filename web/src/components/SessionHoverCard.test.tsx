// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SessionState } from "../types.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

const mockStoreState = {
  zoomLevel: 1,
  sdkSessions: [] as Array<{
    sessionId: string;
    sessionNum?: number;
    state?: "idle" | "starting" | "connected" | "running" | "exited";
    backendType?: "claude" | "codex" | "claude-sdk";
    cwd?: string;
    herdedBy?: string;
    archived?: boolean;
    contextUsedPercent?: number;
    messageHistoryBytes?: number;
    codexRetainedPayloadBytes?: number;
    codexTokenDetails?: { modelContextWindow?: number };
    claudeTokenDetails?: { modelContextWindow?: number };
  }>,
  sessionNames: new Map<string, string>(),
};

vi.mock("../store.js", () => ({
  useStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { SessionHoverCard } from "./SessionHoverCard.js";

function makeSession(overrides: Partial<SessionItemType> = {}): SessionItemType {
  return {
    id: "s1",
    model: "gpt-5.4",
    cwd: "/repo",
    gitBranch: "jiayi",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    status: "idle",
    sdkState: "connected",
    createdAt: Date.now(),
    archived: false,
    backendType: "codex",
    repoRoot: "/repo",
    permCount: 0,
    ...overrides,
  };
}

describe("SessionHoverCard", () => {
  it("renders safely when the mocked store omits quests", () => {
    // q-425 follow-up: generic session hovers should not assume the store mock
    // includes a quests collection. Older tests and narrow mocks omit it.
    render(
      <SessionHoverCard
        session={makeSession()}
        sessionName="Safe Hover"
        sessionPreview="Preview text"
        taskHistory={undefined}
        sessionState={undefined}
        cliSessionId="cli-1"
        anchorRect={new DOMRect(120, 80, 200, 40)}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />,
    );

    expect(screen.getByText("Safe Hover")).toBeInTheDocument();
    expect(screen.getByText("Preview text")).toBeInTheDocument();
    expect(screen.queryByTestId("session-hover-active-quest")).toBeNull();
  });

  it("shows the max context window rounded to whole K tokens", () => {
    // q-291: live hover-card metrics should use the authoritative
    // sessionState message bytes plus Codex retained payload bytes from the server.
    const sessionState = {
      session_id: "s1",
      backend_type: "codex",
      model: "gpt-5.4",
      cwd: "/repo",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 1,
      context_used_percent: 73,
      message_history_bytes: 1_572_864,
      codex_retained_payload_bytes: 2_621_440,
      git_branch: "jiayi",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      codex_token_details: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        modelContextWindow: 258_400,
      },
      is_compacting: false,
    } as SessionState;

    render(
      <SessionHoverCard
        session={makeSession()}
        sessionName="Explain Codex Session Steering"
        sessionPreview={undefined}
        taskHistory={undefined}
        sessionState={sessionState}
        cliSessionId="cli-1"
        anchorRect={new DOMRect(120, 80, 200, 40)}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />,
    );

    expect(screen.getByText("73% context")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB replay")).toBeInTheDocument();
    expect(screen.getByText("2.5 MB retained")).toBeInTheDocument();
    expect(screen.getByText("258 K tokens")).toBeInTheDocument();
  });

  it("falls back to sdk session metadata when no live session state is present", () => {
    // q-291: when the full live session state is unavailable, the hover card
    // should still render Codex replay/retained sizes from sdkSessions fallback metadata.
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        contextUsedPercent: 73,
        messageHistoryBytes: 972_800,
        codexRetainedPayloadBytes: 1_228_800,
        codexTokenDetails: { modelContextWindow: 258_400 },
      },
    ];

    try {
      render(
        <SessionHoverCard
          session={makeSession()}
          sessionName="Explain Codex Session Steering"
          sessionPreview={undefined}
          taskHistory={undefined}
          sessionState={undefined}
          cliSessionId="cli-1"
          anchorRect={new DOMRect(120, 80, 200, 40)}
          onMouseEnter={() => {}}
          onMouseLeave={() => {}}
        />,
      );

      expect(screen.getByText("73% context")).toBeInTheDocument();
      expect(screen.getByText("950 KB replay")).toBeInTheDocument();
      expect(screen.getByText("1.2 MB retained")).toBeInTheDocument();
      expect(screen.getByText("258 K tokens")).toBeInTheDocument();
    } finally {
      mockStoreState.sdkSessions = [];
    }
  });

  it("prefers live session message-history bytes over sdk fallback metadata", () => {
    // q-291: when both sources exist, the live authoritative session state
    // must win over potentially stale sdkSessions fallback metadata for replay/retained metrics.
    mockStoreState.sdkSessions = [
      {
        sessionId: "s1",
        contextUsedPercent: 73,
        messageHistoryBytes: 972_800,
        codexRetainedPayloadBytes: 1_228_800,
        codexTokenDetails: { modelContextWindow: 258_400 },
      },
    ];

    const sessionState = {
      session_id: "s1",
      backend_type: "codex",
      model: "gpt-5.4",
      cwd: "/repo",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 1,
      context_used_percent: 73,
      message_history_bytes: 1_572_864,
      codex_retained_payload_bytes: 2_621_440,
      git_branch: "jiayi",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      codex_token_details: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        modelContextWindow: 258_400,
      },
      is_compacting: false,
    } as SessionState;

    try {
      render(
        <SessionHoverCard
          session={makeSession()}
          sessionName="Explain Codex Session Steering"
          sessionPreview={undefined}
          taskHistory={undefined}
          sessionState={sessionState}
          cliSessionId="cli-1"
          anchorRect={new DOMRect(120, 80, 200, 40)}
          onMouseEnter={() => {}}
          onMouseLeave={() => {}}
        />,
      );

      expect(screen.getByText("1.5 MB replay")).toBeInTheDocument();
      expect(screen.getByText("2.5 MB retained")).toBeInTheDocument();
      expect(screen.queryByText("950 KB replay")).toBeNull();
    } finally {
      mockStoreState.sdkSessions = [];
    }
  });

  it("keeps non-Codex sessions on history wording and hides retained payload", () => {
    // Non-Codex sessions should keep the legacy history label and must not
    // surface Codex-only retained payload UI.
    const sessionState = {
      session_id: "s1",
      backend_type: "claude-sdk",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/repo",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 2,
      context_used_percent: 41,
      message_history_bytes: 972_800,
      git_branch: "jiayi",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      claude_token_details: {
        inputTokens: 254,
        outputTokens: 77708,
        cachedInputTokens: 22001692,
        modelContextWindow: 200_000,
      },
      is_compacting: false,
    } as SessionState;

    render(
      <SessionHoverCard
        session={makeSession({ backendType: "claude-sdk", model: "claude-sonnet-4-5-20250929" })}
        sessionName="Explain Claude Session Metrics"
        sessionPreview={undefined}
        taskHistory={undefined}
        sessionState={sessionState}
        cliSessionId="cli-1"
        anchorRect={new DOMRect(120, 80, 200, 40)}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />,
    );

    expect(screen.getByText("950 KB history")).toBeInTheDocument();
    expect(screen.queryByText(/retained/)).toBeNull();
  });

  it("uses merged backend identity for header copy and stat labeling", () => {
    // If session list metadata lags, the hover card should still render a
    // consistent backend identity from the merged session data.
    const sessionState = {
      session_id: "s1",
      backend_type: "codex",
      model: "gpt-5.4",
      cwd: "/repo",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 1,
      context_used_percent: 73,
      message_history_bytes: 1_572_864,
      codex_retained_payload_bytes: 2_621_440,
      git_branch: "jiayi",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      codex_token_details: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        modelContextWindow: 258_400,
      },
      is_compacting: false,
    } as SessionState;

    render(
      <SessionHoverCard
        session={makeSession({ backendType: "claude-sdk" })}
        sessionName="Merged Backend Test"
        sessionPreview={undefined}
        taskHistory={undefined}
        sessionState={sessionState}
        cliSessionId="cli-1"
        anchorRect={new DOMRect(120, 80, 200, 40)}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />,
    );

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB replay")).toBeInTheDocument();
  });

  it("shows Claude SDK context stats with turns but no cost", () => {
    const sessionState = {
      session_id: "s1",
      backend_type: "claude-sdk",
      model: "claude-sonnet-4-5-20250929",
      cwd: "/repo",
      tools: [],
      permissionMode: "default",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 1.25,
      num_turns: 7,
      context_used_percent: 41,
      git_branch: "jiayi",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      claude_token_details: {
        inputTokens: 254,
        outputTokens: 77708,
        cachedInputTokens: 22001692,
        modelContextWindow: 200_000,
      },
      is_compacting: false,
    } as SessionState;

    render(
      <SessionHoverCard
        session={makeSession({ backendType: "claude-sdk", model: "claude-sonnet-4-5-20250929" })}
        sessionName="Explain Claude Session Metrics"
        sessionPreview={undefined}
        taskHistory={undefined}
        sessionState={sessionState}
        cliSessionId="cli-1"
        anchorRect={new DOMRect(120, 80, 200, 40)}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />,
    );

    expect(screen.getByText("41% context")).toBeInTheDocument();
    expect(screen.getByText("200 K tokens")).toBeInTheDocument();
    // Turns now shown for all backends
    expect(screen.getByText("7 turns")).toBeInTheDocument();
    // Cost is never shown
    expect(screen.queryByText("$1.25")).toBeNull();
  });

  it("shows worktree and base repo paths separately with concise path tails", () => {
    render(
      <SessionHoverCard
        session={makeSession({
          cwd: "/Users/test/.companion/worktrees/companion/jiayi-wt-3116",
          repoRoot: "/Users/test/Code/companion",
          isWorktree: true,
        })}
        sessionName="Fix hover card path layout"
        sessionPreview={undefined}
        taskHistory={undefined}
        sessionState={undefined}
        cliSessionId="cli-1"
        anchorRect={new DOMRect(120, 80, 200, 40)}
        onMouseEnter={() => {}}
        onMouseLeave={() => {}}
      />,
    );

    expect(screen.getByText("Worktree")).toBeInTheDocument();
    expect(screen.getByText("Base repo")).toBeInTheDocument();
    expect(screen.getByTestId("session-hover-path-worktree-tail")).toHaveTextContent("jiayi-wt-3116");
    expect(screen.getByTestId("session-hover-path-repo-tail")).toHaveTextContent("companion");
  });

  it("shows concise herding chips for leader sessions in the hover card", () => {
    mockStoreState.sdkSessions = [
      {
        sessionId: "worker-1",
        sessionNum: 21,
        state: "idle",
        backendType: "codex",
        cwd: "/repo/worktree-1",
        herdedBy: "s1",
      },
      {
        sessionId: "worker-2",
        sessionNum: 22,
        state: "running",
        backendType: "claude",
        cwd: "/repo/worktree-2",
        herdedBy: "s1",
      },
    ];
    mockStoreState.sessionNames = new Map([
      ["worker-1", "Fix notification links"],
      ["worker-2", "Improve hover chips"],
    ]);

    try {
      render(
        <SessionHoverCard
          session={makeSession({ isOrchestrator: true })}
          sessionName="Leader Session"
          sessionPreview={undefined}
          taskHistory={undefined}
          sessionState={undefined}
          cliSessionId="cli-1"
          anchorRect={new DOMRect(120, 80, 200, 40)}
          onMouseEnter={() => {}}
          onMouseLeave={() => {}}
        />,
      );

      expect(screen.getByText("Herding")).toBeInTheDocument();
      const section = screen.getByTestId("session-hover-herding");
      expect(within(section).getByRole("button", { name: "#21" })).toBeInTheDocument();
      expect(within(section).getByRole("button", { name: "#22" })).toBeInTheDocument();
      expect(within(section).queryByText("Fix notification links")).toBeNull();
      expect(within(section).queryByText("Improve hover chips")).toBeNull();
    } finally {
      mockStoreState.sdkSessions = [];
      mockStoreState.sessionNames = new Map();
    }
  });
});
