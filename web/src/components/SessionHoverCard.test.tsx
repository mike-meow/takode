// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SessionState } from "../types.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

const mockStoreState = {
  zoomLevel: 1,
  sdkSessions: [] as Array<{
    sessionId: string;
    contextUsedPercent?: number;
    codexTokenDetails?: { modelContextWindow?: number };
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
  it("shows the max context window rounded to whole K tokens", () => {
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
    expect(screen.getByText("258 K tokens")).toBeInTheDocument();
  });

  it("falls back to sdk session metadata when no live session state is present", () => {
    mockStoreState.sdkSessions = [{
      sessionId: "s1",
      contextUsedPercent: 73,
      codexTokenDetails: { modelContextWindow: 258_400 },
    }];

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
      expect(screen.getByText("258 K tokens")).toBeInTheDocument();
    } finally {
      mockStoreState.sdkSessions = [];
    }
  });
});
