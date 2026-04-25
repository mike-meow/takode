import { describe, it, expect } from "vitest";
import { buildTreeViewGroups, type TreeNode } from "./tree-grouping.js";
import type { SidebarSessionItem as SessionItem } from "./sidebar-session-item.js";
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
    const sessions = [makeSession({ id: "s1", sessionNum: 1 }), makeSession({ id: "s2", sessionNum: 2 })];

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

  it("includes empty non-default groups so newly created groups are visible", () => {
    // When a user creates a new group before assigning any sessions to it,
    // it should still appear in the result so the UI can render its header.
    const groups: TreeGroup[] = [
      { id: "default", name: "Default" },
      { id: "empty-group", name: "My New Group" },
    ];
    const sessions = [makeSession({ id: "s1", sessionNum: 1 })];

    const result = buildTreeViewGroups(sessions, groups, emptyAssignments);
    const emptyGroup = result.find((g) => g.id === "empty-group");
    expect(emptyGroup).toBeTruthy();
    expect(emptyGroup!.nodes).toHaveLength(0);
    expect(emptyGroup!.runningCount).toBe(0);
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

  it("leader with only reviewers and no workers still has non-empty reviewers", () => {
    // Validates the UI's hasChildren = workers.length > 0 || reviewers.length > 0
    // path: a leader with no herded workers but with a reviewer should still
    // get an expand/collapse chevron in the tree view.
    const sessions = [
      makeSession({ id: "leader-1", sessionNum: 5, isOrchestrator: true }),
      makeSession({ id: "reviewer-a", sessionNum: 20, reviewerOf: 5 }),
      makeSession({ id: "reviewer-b", sessionNum: 21, reviewerOf: 5 }),
    ];

    const result = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments);
    const node = result[0].nodes[0];
    expect(node.leader.id).toBe("leader-1");
    expect(node.workers).toHaveLength(0);
    expect(node.reviewers).toHaveLength(2);
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
    const assignments = new Map([["s1", "deleted-group-id"]]);
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

  it("accepts reviewerSessions as a separate parameter (Sidebar pre-filters reviewers)", () => {
    // The Sidebar filters reviewers out of the top-level session list,
    // so reviewers must be passed separately via the reviewerSessions param.
    // This tests the real data flow where `sessions` has NO reviewers in it.
    const sessions = [
      makeSession({ id: "leader-1", sessionNum: 1, isOrchestrator: true }),
      makeSession({ id: "worker-1", sessionNum: 2, herdedBy: "leader-1" }),
    ];
    const reviewerSessions = [makeSession({ id: "reviewer-1", sessionNum: 10, reviewerOf: 2 })];

    const result = buildTreeViewGroups(
      sessions,
      defaultGroups,
      emptyAssignments,
      undefined,
      undefined,
      undefined,
      reviewerSessions,
    );
    expect(result[0].nodes).toHaveLength(1);
    const node = result[0].nodes[0];
    expect(node.leader.id).toBe("leader-1");
    expect(node.workers).toHaveLength(1);
    // Reviewer of worker-1 (sessionNum=2) should be in node.reviewers
    expect(node.reviewers).toHaveLength(1);
    expect(node.reviewers[0].id).toBe("reviewer-1");
    expect(node.reviewers[0].reviewerOf).toBe(2);
  });

  it("reviewerSessions param works for leader-only reviewers (no workers)", () => {
    // Reviewer targeting the leader directly, not a worker
    const sessions = [makeSession({ id: "leader-1", sessionNum: 5, isOrchestrator: true })];
    const reviewerSessions = [
      makeSession({ id: "reviewer-a", sessionNum: 20, reviewerOf: 5 }),
      makeSession({ id: "reviewer-b", sessionNum: 21, reviewerOf: 5 }),
    ];

    const result = buildTreeViewGroups(
      sessions,
      defaultGroups,
      emptyAssignments,
      undefined,
      undefined,
      undefined,
      reviewerSessions,
    );
    const node = result[0].nodes[0];
    expect(node.leader.id).toBe("leader-1");
    expect(node.workers).toHaveLength(0);
    expect(node.reviewers).toHaveLength(2);
  });

  it("empty reviewerSessions array behaves same as undefined (no reviewers)", () => {
    // [] is truthy in JS, so the `if (reviewerSessions)` branch fires.
    // Should still produce zero reviewers when the array is empty.
    const sessions = [
      makeSession({ id: "leader-1", sessionNum: 1, isOrchestrator: true }),
      makeSession({ id: "worker-1", sessionNum: 2, herdedBy: "leader-1" }),
    ];

    const withUndefined = buildTreeViewGroups(sessions, defaultGroups, emptyAssignments);
    const withEmpty = buildTreeViewGroups(
      sessions,
      defaultGroups,
      emptyAssignments,
      undefined,
      undefined,
      undefined,
      [],
    );

    expect(withUndefined[0].nodes[0].reviewers).toHaveLength(0);
    expect(withEmpty[0].nodes[0].reviewers).toHaveLength(0);
    // Both should produce identical node structure
    expect(withEmpty[0].nodes).toHaveLength(withUndefined[0].nodes.length);
  });

  it("orders active reviewers before archived historical reviewer records", () => {
    const sessions = [makeSession({ id: "worker-1", sessionNum: 5 })];
    const reviewerSessions = [
      makeSession({ id: "archived-reviewer", sessionNum: 21, reviewerOf: 5, archived: true, createdAt: 300 }),
      makeSession({ id: "active-reviewer", sessionNum: 20, reviewerOf: 5, archived: false, createdAt: 200 }),
    ];

    const result = buildTreeViewGroups(
      sessions,
      defaultGroups,
      emptyAssignments,
      undefined,
      undefined,
      undefined,
      reviewerSessions,
    );

    // Parent rows use the first reviewer as their compact badge target, so an
    // active reviewer should win over an archived record when both exist.
    expect(result[0].nodes[0].reviewers.map((r) => r.id)).toEqual(["active-reviewer", "archived-reviewer"]);
  });

  it("reviewers are isolated to their parent's group (no cross-group bleed)", () => {
    // Reviewers should only appear in the group where their parent session lives.
    const groups: TreeGroup[] = [
      { id: "default", name: "Default" },
      { id: "group-a", name: "Group A" },
    ];
    const assignments = new Map([
      ["leader-1", "group-a"],
      ["leader-2", "default"],
    ]);
    const sessions = [
      makeSession({ id: "leader-1", sessionNum: 1, isOrchestrator: true }),
      makeSession({ id: "leader-2", sessionNum: 2, isOrchestrator: true }),
    ];
    const reviewerSessions = [
      makeSession({ id: "reviewer-of-1", sessionNum: 10, reviewerOf: 1 }),
      makeSession({ id: "reviewer-of-2", sessionNum: 11, reviewerOf: 2 }),
    ];

    const result = buildTreeViewGroups(
      sessions,
      groups,
      assignments,
      undefined,
      undefined,
      undefined,
      reviewerSessions,
    );

    const groupA = result.find((g) => g.id === "group-a")!;
    const defaultGroup = result.find((g) => g.id === "default")!;

    // reviewer-of-1 belongs in group-a (where leader-1 is)
    expect(groupA.nodes[0].reviewers).toHaveLength(1);
    expect(groupA.nodes[0].reviewers[0].id).toBe("reviewer-of-1");

    // reviewer-of-2 belongs in default (where leader-2 is)
    expect(defaultGroup.nodes[0].reviewers).toHaveLength(1);
    expect(defaultGroup.nodes[0].reviewers[0].id).toBe("reviewer-of-2");
  });

  it("orphaned reviewer (parent sessionNum missing) is silently dropped", () => {
    // Reviewers whose reviewerOf points to a nonexistent sessionNum should
    // not appear in any node's reviewers array.
    const sessions = [makeSession({ id: "leader-1", sessionNum: 1, isOrchestrator: true })];
    const reviewerSessions = [makeSession({ id: "reviewer-orphan", sessionNum: 99, reviewerOf: 999 })];

    const result = buildTreeViewGroups(
      sessions,
      defaultGroups,
      emptyAssignments,
      undefined,
      undefined,
      undefined,
      reviewerSessions,
    );
    expect(result[0].nodes[0].reviewers).toHaveLength(0);
  });
});
