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
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(["leader"]),
      sessionAttention: new Map(),
      sessionSortMode: "created",
      countUserPermissions: () => 0,
    });

    expect(result.orderedVisibleSessionIds).toEqual(["leader", "worker"]);
  });

  it("keeps archived reviewers attached to active parents without adding standalone archived rows", () => {
    const sessions = new Map<string, SessionState>([
      ["parent", makeSessionState("parent")],
      ["reviewer", makeSessionState("reviewer")],
    ]);
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("parent", { createdAt: 3, sessionNum: 11, archived: false }),
      makeSdkSession("reviewer", { createdAt: 2, reviewerOf: 11, sessionNum: 12, archived: true, archivedAt: 2500 }),
    ];

    const result = buildSidebarVisibleSessions({
      sessions,
      sdkSessions,
      cliConnected: new Map(),
      cliDisconnectReason: new Map(),
      sessionStatus: new Map(),
      pendingPermissions: new Map(),
      askPermission: new Map(),
      diffFileStats: new Map(),
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map(),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
      countUserPermissions: () => 0,
    });

    // Archived reviewer sessions should remain reachable from their parent
    // record, but should not become separate rows in the Archived section.
    expect(result.archivedSessions.map((s) => s.id)).toEqual([]);
    expect(result.activeReviewers).toEqual([]);
    expect(result.treeViewGroups[0].nodes[0].reviewers.map((s) => s.id)).toEqual(["reviewer"]);
  });

  it("hides workers from ordered visible rows when their herd is collapsed", () => {
    const sessions = new Map<string, SessionState>([
      ["leader", makeSessionState("leader")],
      ["worker", makeSessionState("worker")],
      ["standalone", makeSessionState("standalone")],
    ]);
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("leader", { createdAt: 3, sessionNum: 10, isOrchestrator: true }),
      makeSdkSession("worker", { createdAt: 2, herdedBy: "leader", sessionNum: 11 }),
      makeSdkSession("standalone", { createdAt: 1, sessionNum: 12 }),
    ];

    const result = buildSidebarVisibleSessions({
      sessions,
      sdkSessions,
      cliConnected: new Map(),
      cliDisconnectReason: new Map(),
      sessionStatus: new Map(),
      pendingPermissions: new Map(),
      askPermission: new Map(),
      diffFileStats: new Map(),
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map([["default", ["leader", "standalone"]]]),
      collapsedTreeGroups: new Set(),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
      countUserPermissions: () => 0,
    });

    expect(result.orderedVisibleSessionIds).toEqual(["leader", "standalone"]);
  });

  it("hides an entire collapsed tree group from ordered visible rows", () => {
    const sessions = new Map<string, SessionState>([
      ["default-session", makeSessionState("default-session")],
      ["quest-session", makeSessionState("quest-session")],
    ]);
    const sdkSessions: SdkSessionInfo[] = [
      makeSdkSession("default-session", { createdAt: 2, sessionNum: 10 }),
      makeSdkSession("quest-session", { createdAt: 1, sessionNum: 11 }),
    ];

    const result = buildSidebarVisibleSessions({
      sessions,
      sdkSessions,
      cliConnected: new Map(),
      cliDisconnectReason: new Map(),
      sessionStatus: new Map(),
      pendingPermissions: new Map(),
      askPermission: new Map(),
      diffFileStats: new Map(),
      treeGroups: [
        { id: "default", name: "Default" },
        { id: "quest", name: "Quest" },
      ],
      treeAssignments: new Map([["quest-session", "quest"]]),
      treeNodeOrder: new Map([
        ["default", ["default-session"]],
        ["quest", ["quest-session"]],
      ]),
      collapsedTreeGroups: new Set(["quest"]),
      expandedHerdNodes: new Set(),
      sessionAttention: new Map(),
      sessionSortMode: "created",
      countUserPermissions: () => 0,
    });

    expect(result.orderedVisibleSessionIds).toEqual(["default-session"]);
  });
});
