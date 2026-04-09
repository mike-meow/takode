import { describe, it, expect } from "vitest";
import { buildTreeViewGroups, type TreeNode } from "./tree-grouping.js";
import type { SessionItem } from "./project-grouping.js";
import type { TreeGroup } from "../types.js";

// Helper to create a minimal SessionItem for testing
function makeSession(overrides: Partial<SessionItem> & { id: string }): SessionItem {
  return {
    model: "claude",
    cwd: "/test",
    gitBranch: "main",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: true,
    status: "running",
    sdkState: "running",
    createdAt: Date.now(),
    archived: false,
    backendType: "claude",
    repoRoot: "/test",
    permCount: 0,
    ...overrides,
  };
}

describe("buildTreeViewGroups", () => {
  const defaultGroups: TreeGroup[] = [{ id: "default", name: "Default" }];
  const emptyAssignments = new Map<string, string>();

  it("places all sessions in default group when no assignments exist", () => {
    const sessions = [
      makeSession({ id: "s1", sessionNum: 1 }),
      makeSession({ id: "s2", sessionNum: 2 }),
    ];

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("default");
    expect(result[0].nodes).toHaveLength(2);
  });

  it("groups leader with its workers", () => {
    const sessions = [
      makeSession({ id: "leader-1", sessionNum: 1, isOrchestrator: true }),
      makeSession({ id: "worker-1", sessionNum: 2, herdedBy: "leader-1" }),
      makeSession({ id: "worker-2", sessionNum: 3, herdedBy: "leader-1" }),
    ];

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments);
    expect(result).toHaveLength(1);
    expect(result[0].nodes).toHaveLength(1); // one tree: leader + 2 workers

    const node = result[0].nodes[0];
    expect(node.leader.id).toBe("leader-1");
    expect(node.workers).toHaveLength(2);
  });

  it("standalone sessions become solo root nodes", () => {
    const sessions = [
      makeSession({ id: "standalone-1", sessionNum: 1 }),
      makeSession({ id: "standalone-2", sessionNum: 2 }),
    ];

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments);
    expect(result[0].nodes).toHaveLength(2);
    // Each standalone has no workers
    for (const node of result[0].nodes) {
      expect(node.workers).toHaveLength(0);
    }
  });

  it("workers follow their leader's group regardless of own assignment", () => {
    const groups: TreeGroup[] = [
      { id: "default", name: "Default" },
      { id: "group-a", name: "Group A" },
    ];
    const assignments = new Map([
      ["leader-1", "group-a"],
      ["worker-1", "default"], // explicitly assigned to default, but should follow leader
    ]);
    const sessions = [
      makeSession({ id: "leader-1", sessionNum: 1, isOrchestrator: true }),
      makeSession({ id: "worker-1", sessionNum: 2, herdedBy: "leader-1" }),
    ];

    const result = buildTreeViewGroups(sessions, groups, assignments);

    // Worker should be in group-a with its leader, not in default
    const groupA = result.find((g) => g.id === "group-a");
    expect(groupA).toBeTruthy();
    expect(groupA!.nodes).toHaveLength(1);
    expect(groupA!.nodes[0].workers).toHaveLength(1);
    expect(groupA!.nodes[0].workers[0].id).toBe("worker-1");

    // Default should be empty (filtered out)
    const defaultGroup = result.find((g) => g.id === "default");
    expect(defaultGroup).toBeUndefined(); // empty groups are excluded
  });

  it("reviewers are collected as chips, not separate tree nodes", () => {
    const sessions = [
      makeSession({ id: "leader-1", sessionNum: 1, isOrchestrator: true }),
      makeSession({ id: "reviewer-1", sessionNum: 10, reviewerOf: 1 }),
    ];

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments);
    expect(result[0].nodes).toHaveLength(1);
    expect(result[0].nodes[0].leader.id).toBe("leader-1");
    expect(result[0].nodes[0].reviewers).toHaveLength(1);
    expect(result[0].nodes[0].reviewers[0].id).toBe("reviewer-1");
    expect(result[0].nodes[0].workers).toHaveLength(0);
  });

  it("orphaned workers (leader not in same group) appear as standalone nodes", () => {
    const groups: TreeGroup[] = [
      { id: "default", name: "Default" },
      { id: "group-a", name: "Group A" },
    ];
    const assignments = new Map([
      ["leader-1", "group-a"],
      // worker explicitly assigned to default -- leader is NOT in default
    ]);
    const sessions = [
      makeSession({ id: "leader-1", sessionNum: 1, isOrchestrator: true }),
      // Worker that references a non-existent leader (orphan case)
      makeSession({ id: "orphan-worker", sessionNum: 2, herdedBy: "nonexistent-leader" }),
    ];

    const result = buildTreeViewGroups(sessions, groups, assignments);
    const defaultGroup = result.find((g) => g.id === "default");
    expect(defaultGroup).toBeTruthy();
    // Orphan worker should appear as a standalone node
    expect(defaultGroup!.nodes).toHaveLength(1);
    expect(defaultGroup!.nodes[0].leader.id).toBe("orphan-worker");
    expect(defaultGroup!.nodes[0].workers).toHaveLength(0);
  });

  it("sorts by activity when sortMode is 'activity'", () => {
    const now = Date.now();
    const sessions = [
      makeSession({ id: "old", sessionNum: 1, createdAt: now - 2000, lastUserMessageAt: now - 2000 }),
      makeSession({ id: "recent", sessionNum: 2, createdAt: now - 1000, lastUserMessageAt: now }),
    ];

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments, undefined, "activity");
    expect(result[0].nodes[0].leader.id).toBe("recent");
    expect(result[0].nodes[1].leader.id).toBe("old");
  });

  it("sorts by creation time by default", () => {
    const now = Date.now();
    const sessions = [
      makeSession({ id: "older", sessionNum: 1, createdAt: now - 2000 }),
      makeSession({ id: "newer", sessionNum: 2, createdAt: now }),
    ];

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments);
    // Default sort: createdAt desc (newer first)
    expect(result[0].nodes[0].leader.id).toBe("newer");
    expect(result[0].nodes[1].leader.id).toBe("older");
  });

  it("assigns to default group when assignment references a deleted group", () => {
    const assignments = new Map([
      ["s1", "deleted-group-id"],
    ]);
    const sessions = [makeSession({ id: "s1", sessionNum: 1 })];

    const result = buildTreeViewGroups(sessions, defaultGroups, assignments);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("default");
    expect(result[0].nodes).toHaveLength(1);
  });

  it("preserves group order from treeGroups array", () => {
    const groups: TreeGroup[] = [
      { id: "default", name: "Default" },
      { id: "second", name: "Second" },
      { id: "first", name: "First" },
    ];
    const assignments = new Map([
      ["s1", "first"],
      ["s2", "second"],
      ["s3", "default"],
    ]);
    const sessions = [
      makeSession({ id: "s1", sessionNum: 1 }),
      makeSession({ id: "s2", sessionNum: 2 }),
      makeSession({ id: "s3", sessionNum: 3 }),
    ];

    const result = buildTreeViewGroups(sessions, groups, assignments);
    expect(result.map((g) => g.id)).toEqual(["default", "second", "first"]);
  });

  it("computes aggregate status counts", () => {
    const sessions = [
      makeSession({ id: "s1", sessionNum: 1, status: "running", sdkState: "running", isConnected: true }),
      makeSession({ id: "s2", sessionNum: 2, permCount: 1, status: "idle", sdkState: "connected", isConnected: true }),
    ];
    const attention = new Map<string, "action" | "error" | "review" | null>([["s2", "action"]]);

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments, attention);
    expect(result[0].runningCount).toBe(1);
    expect(result[0].permCount).toBe(1);
  });

  it("respects custom nodeOrder for sorting within a group", () => {
    const now = Date.now();
    const sessions = [
      makeSession({ id: "s1", sessionNum: 1, createdAt: now - 3000 }),
      makeSession({ id: "s2", sessionNum: 2, createdAt: now - 2000 }),
      makeSession({ id: "s3", sessionNum: 3, createdAt: now - 1000 }),
    ];
    // Custom order: s3 first, then s1, then s2
    const nodeOrder = new Map([["default", ["s3", "s1", "s2"]]]);

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments, undefined, "created", nodeOrder);
    expect(result[0].nodes.map((n) => n.leader.id)).toEqual(["s3", "s1", "s2"]);
  });

  it("puts new sessions first when not in custom nodeOrder", () => {
    const now = Date.now();
    const sessions = [
      makeSession({ id: "s1", sessionNum: 1, createdAt: now - 2000 }),
      makeSession({ id: "s2", sessionNum: 2, createdAt: now - 1000 }),
      makeSession({ id: "new-session", sessionNum: 3, createdAt: now }), // not in custom order
    ];
    const nodeOrder = new Map([["default", ["s2", "s1"]]]);

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments, undefined, "created", nodeOrder);
    // New session should appear first (before ordered ones)
    expect(result[0].nodes[0].leader.id).toBe("new-session");
  });

  it("ignores nodeOrder in activity sort mode", () => {
    const now = Date.now();
    const sessions = [
      makeSession({ id: "old-active", sessionNum: 1, createdAt: now - 3000, lastUserMessageAt: now }),
      makeSession({ id: "new-inactive", sessionNum: 2, createdAt: now, lastUserMessageAt: now - 5000 }),
    ];
    const nodeOrder = new Map([["default", ["new-inactive", "old-active"]]]);

    // In activity mode, nodeOrder should be ignored
    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments, undefined, "activity", nodeOrder);
    expect(result[0].nodes[0].leader.id).toBe("old-active"); // more recent activity wins
  });
});
