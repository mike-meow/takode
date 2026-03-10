import { describe, expect, it } from "vitest";
import type { SessionState, SdkSessionInfo } from "../types.js";
import { coalesceSessionViewModel, toSessionViewModel } from "./session-view-model.js";

const codexTokenDetails = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningOutputTokens: 0,
  modelContextWindow: 258_400,
};

describe("toSessionViewModel", () => {
  it("maps SessionState snake_case fields to camelCase", () => {
    const session = {
      session_id: "s1",
      backend_type: "codex",
      model: "gpt-5",
      cwd: "/repo",
      tools: [],
      permissionMode: "plan",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 1.25,
      num_turns: 3,
      context_used_percent: 42,
      codex_token_details: codexTokenDetails,
      is_compacting: false,
      git_branch: "jiayi",
      is_worktree: true,
      is_containerized: false,
      repo_root: "/repo",
      git_ahead: 2,
      git_behind: 1,
      total_lines_added: 10,
      total_lines_removed: 4,
    } as SessionState;

    const vm = toSessionViewModel(session);

    expect(vm.sessionId).toBe("s1");
    expect(vm.backendType).toBe("codex");
    expect(vm.gitBranch).toBe("jiayi");
    expect(vm.repoRoot).toBe("/repo");
    expect(vm.totalLinesAdded).toBe(10);
    expect(vm.totalCostUsd).toBe(1.25);
    expect(vm.modelContextWindow).toBe(258_400);
  });

  it("maps SdkSessionInfo camelCase fields directly", () => {
    const sdk = {
      sessionId: "s2",
      state: "connected",
      cwd: "/work",
      createdAt: 1,
      backendType: "claude",
      gitBranch: "main",
      gitAhead: 0,
      gitBehind: 0,
      totalLinesAdded: 3,
      totalLinesRemoved: 2,
      contextUsedPercent: 27,
      codexTokenDetails,
      repoRoot: "/work",
      sessionNum: 9,
      name: "Test",
    } as SdkSessionInfo;

    const vm = toSessionViewModel(sdk);

    expect(vm.sessionId).toBe("s2");
    expect(vm.backendType).toBe("claude");
    expect(vm.gitBranch).toBe("main");
    expect(vm.totalLinesRemoved).toBe(2);
    expect(vm.contextUsedPercent).toBe(27);
    expect(vm.modelContextWindow).toBe(258_400);
    expect(vm.sessionNum).toBe(9);
  });
});

describe("coalesceSessionViewModel", () => {
  it("prefers primary values and falls back to secondary", () => {
    const primary = {
      session_id: "s3",
      backend_type: "codex",
      model: "gpt-5",
      cwd: "/repo",
      tools: [],
      permissionMode: "plan",
      claude_code_version: "1.0.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 1,
      context_used_percent: 11,
      codex_token_details: codexTokenDetails,
      is_compacting: false,
      git_branch: "feature",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/repo",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    } as SessionState;

    const fallback = {
      sessionId: "s3",
      state: "running",
      cwd: "/fallback",
      createdAt: 1,
      name: "Fallback Name",
      sessionNum: 42,
    } as SdkSessionInfo;

    const vm = coalesceSessionViewModel(primary, fallback);

    expect(vm?.cwd).toBe("/repo");
    expect(vm?.backendType).toBe("codex");
    expect(vm?.name).toBe("Fallback Name");
    expect(vm?.state).toBe("running");
    expect(vm?.sessionNum).toBe(42);
  });
});
