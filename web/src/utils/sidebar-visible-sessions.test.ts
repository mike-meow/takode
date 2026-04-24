import { describe, expect, it } from "vitest";
import { buildSidebarVisibleSessions } from "./sidebar-visible-sessions.js";
import type { SessionState, SdkSessionInfo, TreeGroup } from "../types.js";

function makeSessionState(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: id,
    model: "model",
    cwd: `/repo/${id}`,
    tools: [],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "/repo",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    ...overrides,
  };
}

function makeSdkSession(id: string, overrides: Partial<SdkSessionInfo> = {}): SdkSessionInfo {
  return {
    sessionId: id,
    state: "connected",
    cwd: `/repo/${id}`,
    createdAt: 1,
    archived: false,
    ...overrides,
  };
}

describe("buildSidebarVisibleSessions", () => {
  it("derives ordered visible rows without reviewer sessions", () => {
    const sessions = new Map<string, SessionState>([
      ["leader", makeSessionState("leader")],
      ["worker", makeSessionState("worker")],
      ["reviewer", makeSessionState("reviewer")],
    ]);
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("leader", { createdAt: 3, sessionNum: 10, isOrchestrator: true }),
      makeSdkSession("worker", { createdAt: 2, herdedBy: "leader", sessionNum: 11 }),
      makeSdkSession("reviewer", { createdAt: 1, reviewerOf: 11, sessionNum: 12 }),
    ];
    const treeGroups: TreeGroup[] = [{ id: "default", name: "Default" }];

    const result = buildSidebarVisibleSessions({
      sessions,
      sdkSessions,
      cliConnected: new Map(),
      cliDisconnectReason: new Map(),
      sessionStatus: new Map(),
      pendingPermissions: new Map(),
      askPermission: new Map(),
      diffFileStats: new Map(),
      treeGroups,
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
      countUserPermissions: () => 0,
    });

    expect(result.orderedVisibleSessionIds).toEqual(["leader", "worker"]);
  });
});
