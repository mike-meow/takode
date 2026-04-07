import { describe, it, expect } from "vitest";
import {
  extractProjectKey,
  extractProjectLabel,
  groupSessionsByProject,
  nestReviewerSessions,
  type SessionItem,
} from "./project-grouping.js";

function makeItem(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: "s1",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/home/user/projects/myapp",
    gitBranch: "",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: false,
    status: null,
    sdkState: null,
    createdAt: 1000,
    archived: false,
    backendType: "claude",
    repoRoot: "",
    permCount: 0,
    ...overrides,
  };
}

describe("extractProjectKey", () => {
  it("uses repoRoot when available (worktree normalization)", () => {
    expect(extractProjectKey("/home/user/myapp-wt-1234", "/home/user/myapp")).toBe("/home/user/myapp");
  });

  it("falls back to cwd when repoRoot is undefined", () => {
    expect(extractProjectKey("/home/user/projects/myapp")).toBe("/home/user/projects/myapp");
  });

  it("removes trailing slashes", () => {
    expect(extractProjectKey("/home/user/myapp/")).toBe("/home/user/myapp");
  });

  it("returns / for empty cwd", () => {
    expect(extractProjectKey("")).toBe("/");
  });

  it("prefers repoRoot over cwd even when both are valid", () => {
    expect(extractProjectKey("/home/user/myapp/web", "/home/user/myapp")).toBe("/home/user/myapp");
  });
});

describe("extractProjectLabel", () => {
  it("returns last path component for normal paths", () => {
    expect(extractProjectLabel("/home/user/projects/myapp")).toBe("myapp");
  });

  it("returns / for root path", () => {
    expect(extractProjectLabel("/")).toBe("/");
  });

  it("handles single component path", () => {
    expect(extractProjectLabel("/myapp")).toBe("myapp");
  });

  it("handles deep nested paths", () => {
    expect(extractProjectLabel("/a/b/c/d/e")).toBe("e");
  });
});

describe("groupSessionsByProject", () => {
  it("groups sessions sharing the same cwd into one group", () => {
    const sessions = [makeItem({ id: "s1", cwd: "/home/user/myapp" }), makeItem({ id: "s2", cwd: "/home/user/myapp" })];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
    expect(groups[0].label).toBe("myapp");
  });

  it("groups worktree sessions with their parent repo", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/home/user/myapp", repoRoot: "/home/user/myapp" }),
      makeItem({ id: "s2", cwd: "/home/user/myapp-wt-1234", repoRoot: "/home/user/myapp", isContainerized: true }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
  });

  it("sorts groups alphabetically by label", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/zebra", createdAt: 200 }),
      makeItem({ id: "s2", cwd: "/a/alpha", createdAt: 100 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].label).toBe("alpha");
    expect(groups[1].label).toBe("zebra");
  });

  it("sorts groups by custom group order when provided", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/zebra", createdAt: 200 }),
      makeItem({ id: "s2", cwd: "/a/alpha", createdAt: 100 }),
      makeItem({ id: "s3", cwd: "/a/beta", createdAt: 50 }),
    ];
    const groups = groupSessionsByProject(sessions, undefined, undefined, ["/a/beta", "/a/zebra", "/a/alpha"]);
    expect(groups.map((g) => g.key)).toEqual(["/a/beta", "/a/zebra", "/a/alpha"]);
  });

  it("keeps unordered groups after ordered groups (alphabetical fallback)", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/zebra", createdAt: 200 }),
      makeItem({ id: "s2", cwd: "/a/alpha", createdAt: 100 }),
      makeItem({ id: "s3", cwd: "/a/beta", createdAt: 50 }),
    ];
    const groups = groupSessionsByProject(sessions, undefined, undefined, ["/a/zebra"]);
    expect(groups.map((g) => g.key)).toEqual(["/a/zebra", "/a/alpha", "/a/beta"]);
  });

  it("sorts sessions within group by createdAt desc regardless of status", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 300, status: null }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 100, status: "running" }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 200, status: null }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s1", "s3", "s2"]);
  });

  it("handles sessions with empty cwd as a separate group", () => {
    const sessions = [makeItem({ id: "s1", cwd: "/a/app" }), makeItem({ id: "s2", cwd: "" })];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(2);
  });

  it("counts are mutually exclusive using dot priority (permission > running > unread)", () => {
    // s1: running + has permissions → permission takes priority (counted as waiting)
    // s2: running + no permissions → counted as running
    // s3: idle + no permissions → not counted
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", status: "running", permCount: 1, isConnected: true, sdkState: "running" }),
      makeItem({ id: "s2", cwd: "/a/app", status: "running", permCount: 0, isConnected: true, sdkState: "running" }),
      makeItem({ id: "s3", cwd: "/a/app", status: null, permCount: 0 }),
    ];
    const groups = groupSessionsByProject(sessions);
    // s1 shows amber (permission), s2 shows green (running)
    expect(groups[0].runningCount).toBe(1);
    expect(groups[0].permCount).toBe(1);
  });

  it("counts unread only when no higher-priority state applies", () => {
    const attention = new Map<string, "action" | "error" | "review" | null>([
      ["s1", "review"], // has permissions → counted as waiting, not unread
      ["s2", "review"], // idle + unread → counted as unread
    ]);
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", permCount: 1 }),
      makeItem({ id: "s2", cwd: "/a/app", permCount: 0, isConnected: true }),
    ];
    const groups = groupSessionsByProject(sessions, attention);
    expect(groups[0].permCount).toBe(1);
    expect(groups[0].unreadCount).toBe(1);
  });

  it("disconnected session with running status does not count as running", () => {
    // A session that lost connection while running should show as disconnected,
    // not running. deriveSessionStatus prioritizes disconnected over running.
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", status: "running", isConnected: false, sdkState: "running" }),
      makeItem({ id: "s2", cwd: "/a/app", status: "running", isConnected: true, sdkState: "running" }),
    ];
    const groups = groupSessionsByProject(sessions);
    // s1 is disconnected (not counted), s2 is running
    expect(groups[0].runningCount).toBe(1);
  });

  it("creates separate groups for different directories", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app1" }),
      makeItem({ id: "s2", cwd: "/a/app2" }),
      makeItem({ id: "s3", cwd: "/a/app1" }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(2);
  });

  it("does not reorder sessions when status changes from idle to running", () => {
    // Simulate initial state: all idle, ordered by createdAt
    const sessionsIdle = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 300, status: null }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 200, status: null }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 100, status: null }),
    ];
    const groupsBefore = groupSessionsByProject(sessionsIdle);
    const orderBefore = groupsBefore[0].sessions.map((s) => s.id);

    // Simulate s3 (oldest) starting to run
    const sessionsWithRunning = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 300, status: null }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 200, status: null }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 100, status: "running" }),
    ];
    const groupsAfter = groupSessionsByProject(sessionsWithRunning);
    const orderAfter = groupsAfter[0].sessions.map((s) => s.id);

    expect(orderBefore).toEqual(orderAfter);
  });

  it("maintains stable order with mixed running/idle/compacting statuses", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 500, status: "idle" }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 400, status: "running" }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 300, status: "compacting" }),
      makeItem({ id: "s4", cwd: "/a/app", createdAt: 200, status: null }),
      makeItem({ id: "s5", cwd: "/a/app", createdAt: 100, status: "running" }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
  });

  it("tracks mostRecentActivity using lastActivityAt when available", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 100, lastActivityAt: 800 }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 500 }), // no lastActivityAt, falls back to createdAt
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 300, lastActivityAt: 300 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].mostRecentActivity).toBe(800);
  });

  it("returns empty array for empty input", () => {
    expect(groupSessionsByProject([])).toEqual([]);
  });

  it("handles a single session as its own group", () => {
    const sessions = [makeItem({ id: "s1", cwd: "/a/solo" })];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(1);
    expect(groups[0].label).toBe("solo");
  });

  it("order is stable across repeated calls with same input", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 300, status: "running" }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 200, status: null }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 100, status: "running" }),
      makeItem({ id: "s4", cwd: "/b/other", createdAt: 400, status: null }),
    ];
    const first = groupSessionsByProject(sessions);
    const second = groupSessionsByProject(sessions);
    expect(first.map((g) => g.key)).toEqual(second.map((g) => g.key));
    for (let i = 0; i < first.length; i++) {
      expect(first[i].sessions.map((s) => s.id)).toEqual(second[i].sessions.map((s) => s.id));
    }
  });

  it("sessions with identical createdAt maintain consistent order", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 100 }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 100 }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 100 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].sessions).toHaveLength(3);
  });

  it("groups across multiple projects each sort independently by createdAt", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/proj-a", createdAt: 100 }),
      makeItem({ id: "s2", cwd: "/a/proj-b", createdAt: 400 }),
      makeItem({ id: "s3", cwd: "/a/proj-a", createdAt: 300 }),
      makeItem({ id: "s4", cwd: "/a/proj-b", createdAt: 200 }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups[0].label).toBe("proj-a");
    expect(groups[1].label).toBe("proj-b");
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s3", "s1"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["s2", "s4"]);
  });

  it("multiple worktrees of the same repo all land in one group", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/home/user/repo", repoRoot: "/home/user/repo", createdAt: 300 }),
      makeItem({
        id: "s2",
        cwd: "/home/user/repo-wt-feat1",
        repoRoot: "/home/user/repo",
        isContainerized: true,
        createdAt: 200,
      }),
      makeItem({
        id: "s3",
        cwd: "/home/user/repo-wt-feat2",
        repoRoot: "/home/user/repo",
        isContainerized: true,
        createdAt: 100,
      }),
    ];
    const groups = groupSessionsByProject(sessions);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("nests reviewer sessions directly after their parent within a group", () => {
    // Worker #10 (oldest) has a reviewer; worker #20 (newest) does not
    const sessions = [
      makeItem({ id: "worker-20", cwd: "/a/app", createdAt: 300, sessionNum: 20 }),
      makeItem({ id: "worker-10", cwd: "/a/app", createdAt: 100, sessionNum: 10 }),
      makeItem({ id: "reviewer-of-10", cwd: "/a/app", createdAt: 200, sessionNum: 30, reviewerOf: 10 }),
    ];
    const groups = groupSessionsByProject(sessions);
    // Default sort is createdAt desc: worker-20, reviewer-of-10, worker-10
    // After nesting: worker-20, worker-10, reviewer-of-10
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["worker-20", "worker-10", "reviewer-of-10"]);
  });

  it("reassigns reviewer to parent's group when CWDs differ (e.g., worktree vs main repo)", () => {
    // Worker is in a worktree, reviewer has the main repo CWD (no worktree).
    // Without reassignment, they'd end up in different groups.
    const sessions = [
      makeItem({
        id: "worker",
        cwd: "/home/user/.companion/worktrees/repo/wt-1234",
        repoRoot: "/home/user/.companion/worktrees/repo/wt-1234",
        createdAt: 200,
        sessionNum: 134,
      }),
      makeItem({
        id: "reviewer",
        cwd: "/home/user/repo",
        repoRoot: "/home/user/repo",
        createdAt: 100,
        sessionNum: 135,
        reviewerOf: 134,
      }),
    ];
    const groups = groupSessionsByProject(sessions);
    // Reviewer should be reassigned to the worker's group, not its own
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["worker", "reviewer"]);
  });

  it("updates aggregate counters correctly after cross-group reviewer reassignment", () => {
    // Running reviewer starts in a different group than its parent worker.
    // After reassignment, the destination group's runningCount must include it
    // and the source group (if non-empty) must not count it.
    const sessions = [
      makeItem({
        id: "worker",
        cwd: "/home/user/.companion/worktrees/repo/wt-1",
        repoRoot: "/home/user/.companion/worktrees/repo/wt-1",
        createdAt: 300,
        sessionNum: 10,
        status: "idle",
        isConnected: true,
        sdkState: "connected",
      }),
      makeItem({
        id: "other",
        cwd: "/home/user/repo",
        repoRoot: "/home/user/repo",
        createdAt: 200,
        sessionNum: 20,
        status: null,
      }),
      makeItem({
        id: "reviewer",
        cwd: "/home/user/repo",
        repoRoot: "/home/user/repo",
        createdAt: 100,
        sessionNum: 11,
        reviewerOf: 10,
        status: "running",
        isConnected: true,
        sdkState: "running",
      }),
    ];
    const groups = groupSessionsByProject(sessions);
    // Two groups: worktree group (worker + reviewer) and repo group (other)
    expect(groups).toHaveLength(2);
    const worktreeGroup = groups.find((g) => g.sessions.some((s) => s.id === "worker"))!;
    const repoGroup = groups.find((g) => g.sessions.some((s) => s.id === "other"))!;
    // Reviewer (running) was reassigned to worktree group -- count must reflect it
    expect(worktreeGroup.runningCount).toBe(1);
    // Source group lost the reviewer -- must not count it
    expect(repoGroup.runningCount).toBe(0);
  });
});

describe("groupSessionsByProject — activity sort mode", () => {
  it("sorts sessions by lastUserMessageAt desc when sortMode is 'activity'", () => {
    // Activity sort uses lastUserMessageAt (not lastActivityAt) to avoid
    // order flipping when sessions have concurrent assistant activity.
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 300, lastUserMessageAt: 100 }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 100, lastUserMessageAt: 500 }),
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 200, lastUserMessageAt: 300 }),
    ];
    const groups = groupSessionsByProject(sessions, undefined, undefined, undefined, "activity");
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s2", "s3", "s1"]);
  });

  it("falls back to createdAt when lastUserMessageAt is missing in activity mode", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 100 }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 300 }),
    ];
    const groups = groupSessionsByProject(sessions, undefined, undefined, undefined, "activity");
    // s2 (createdAt 300) before s1 (createdAt 100) since neither has lastUserMessageAt
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("sorts correctly with a mix of sessions with and without lastUserMessageAt", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 100, lastUserMessageAt: 500 }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 600 }), // no lastUserMessageAt, falls back to createdAt
      makeItem({ id: "s3", cwd: "/a/app", createdAt: 400, lastUserMessageAt: 300 }),
    ];
    const groups = groupSessionsByProject(sessions, undefined, undefined, undefined, "activity");
    // s2 uses createdAt 600 as fallback, s1 has user msg 500, s3 has user msg 300
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s2", "s1", "s3"]);
  });

  it("ignores custom session order when sortMode is 'activity'", () => {
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 100, lastUserMessageAt: 500 }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 200, lastUserMessageAt: 100 }),
    ];
    const customOrder = new Map([["/a/app", ["s2", "s1"]]]);
    const groups = groupSessionsByProject(sessions, undefined, customOrder, undefined, "activity");
    // Activity mode ignores custom order: s1 (user msg 500) before s2 (user msg 100)
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("does NOT reorder groups in activity mode — keeps manual/alphabetical order", () => {
    // q-136 fix: activity sort only applies WITHIN groups, not between them.
    // Groups stay in custom or alphabetical order regardless of session activity.
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/alpha", createdAt: 100, lastActivityAt: 100, lastUserMessageAt: 100 }),
      makeItem({ id: "s2", cwd: "/a/zebra", createdAt: 50, lastActivityAt: 500, lastUserMessageAt: 500 }),
    ];
    const groups = groupSessionsByProject(sessions, undefined, undefined, undefined, "activity");
    // Groups stay alphabetical even though zebra has more recent activity
    expect(groups[0].label).toBe("alpha");
    expect(groups[1].label).toBe("zebra");
  });

  it("preserves custom group order in activity mode", () => {
    // Even with activity sort, custom group order is preserved.
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/alpha", createdAt: 100, lastUserMessageAt: 500 }),
      makeItem({ id: "s2", cwd: "/a/zebra", createdAt: 200, lastUserMessageAt: 100 }),
    ];
    const groups = groupSessionsByProject(
      sessions,
      undefined,
      undefined,
      ["/a/zebra", "/a/alpha"], // custom group order puts zebra first
      "activity",
    );
    // Custom group order is preserved in activity mode
    expect(groups[0].label).toBe("zebra");
    expect(groups[1].label).toBe("alpha");
  });

  it("ignores lastActivityAt for sort order (uses lastUserMessageAt only)", () => {
    // Two sessions working concurrently: assistant activity flips rapidly,
    // but user messages have a clear order. Sort must be stable.
    const sessions = [
      makeItem({
        id: "worker-1",
        cwd: "/a/app",
        createdAt: 1000,
        lastActivityAt: 10000, // assistant very active right now
        lastUserMessageAt: 5000, // user sent message at t=5000
      }),
      makeItem({
        id: "worker-2",
        cwd: "/a/app",
        createdAt: 2000,
        lastActivityAt: 9500, // assistant was active 0.5s ago
        lastUserMessageAt: 7000, // user sent message at t=7000 (more recent)
      }),
    ];

    const result = groupSessionsByProject(sessions, undefined, undefined, undefined, "activity");
    // worker-2 has more recent lastUserMessageAt, so it comes first
    expect(result[0].sessions.map((s) => s.id)).toEqual(["worker-2", "worker-1"]);

    // Simulate assistant activity flip: worker-1 becomes more active, worker-2 less
    sessions[0].lastActivityAt = 11000;
    sessions[1].lastActivityAt = 9500;

    const result2 = groupSessionsByProject(sessions, undefined, undefined, undefined, "activity");
    // Order should NOT change because lastUserMessageAt didn't change
    expect(result2[0].sessions.map((s) => s.id)).toEqual(["worker-2", "worker-1"]);
  });

  it("still nests reviewers after parent in activity mode", () => {
    const sessions = [
      makeItem({ id: "reviewer", cwd: "/a/app", createdAt: 200, lastUserMessageAt: 500, sessionNum: 20, reviewerOf: 10 }),
      makeItem({ id: "worker", cwd: "/a/app", createdAt: 100, lastUserMessageAt: 100, sessionNum: 10 }),
    ];
    const groups = groupSessionsByProject(sessions, undefined, undefined, undefined, "activity");
    // Reviewer should nest after its parent regardless of higher user message time
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["worker", "reviewer"]);
  });

  it("reassigns cross-group reviewer and nests correctly in activity mode", () => {
    // Reviewer has different CWD than parent (worktree scenario) and highest activity.
    // It should be reassigned to the parent's group and nested after the parent.
    const sessions = [
      makeItem({
        id: "worker",
        cwd: "/home/user/wt",
        repoRoot: "/home/user/wt",
        createdAt: 100,
        lastUserMessageAt: 200,
        sessionNum: 10,
      }),
      makeItem({
        id: "other",
        cwd: "/home/user/repo",
        repoRoot: "/home/user/repo",
        createdAt: 500,
        lastUserMessageAt: 100,
      }),
      makeItem({
        id: "reviewer",
        cwd: "/home/user/repo",
        repoRoot: "/home/user/repo",
        createdAt: 300,
        lastUserMessageAt: 600,
        sessionNum: 11,
        reviewerOf: 10,
      }),
    ];
    const groups = groupSessionsByProject(sessions, undefined, undefined, undefined, "activity");
    // Reviewer reassigned to worker's group, nesting overrides activity sort
    const worktreeGroup = groups.find((g) => g.sessions.some((s) => s.id === "worker"))!;
    expect(worktreeGroup.sessions.map((s) => s.id)).toEqual(["worker", "reviewer"]);
  });

  it("does not affect default mode when sortMode is omitted", () => {
    // Verify backward compatibility: omitting sortMode uses createdAt desc
    const sessions = [
      makeItem({ id: "s1", cwd: "/a/app", createdAt: 100, lastUserMessageAt: 500 }),
      makeItem({ id: "s2", cwd: "/a/app", createdAt: 300, lastUserMessageAt: 100 }),
    ];
    const groups = groupSessionsByProject(sessions);
    // Default mode sorts by createdAt desc: s2 (300) before s1 (100)
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  });
});

describe("nestReviewerSessions", () => {
  it("places reviewer directly after its parent session", () => {
    const sessions = [
      makeItem({ id: "s1", sessionNum: 1 }),
      makeItem({ id: "s2", sessionNum: 2 }),
      makeItem({ id: "r1", sessionNum: 3, reviewerOf: 1 }),
    ];
    nestReviewerSessions(sessions);
    expect(sessions.map((s) => s.id)).toEqual(["s1", "r1", "s2"]);
  });

  it("handles multiple reviewers for different parents", () => {
    const sessions = [
      makeItem({ id: "s1", sessionNum: 10 }),
      makeItem({ id: "s2", sessionNum: 20 }),
      makeItem({ id: "r2", sessionNum: 31, reviewerOf: 20 }),
      makeItem({ id: "r1", sessionNum: 30, reviewerOf: 10 }),
    ];
    nestReviewerSessions(sessions);
    expect(sessions.map((s) => s.id)).toEqual(["s1", "r1", "s2", "r2"]);
  });

  it("appends orphaned reviewers at the end when parent is not in list", () => {
    const sessions = [
      makeItem({ id: "s1", sessionNum: 1 }),
      makeItem({ id: "r-orphan", sessionNum: 5, reviewerOf: 99 }),
    ];
    nestReviewerSessions(sessions);
    expect(sessions.map((s) => s.id)).toEqual(["s1", "r-orphan"]);
  });

  it("is a no-op when there are no reviewer sessions", () => {
    const sessions = [makeItem({ id: "s1", sessionNum: 1 }), makeItem({ id: "s2", sessionNum: 2 })];
    nestReviewerSessions(sessions);
    expect(sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("handles all sessions being reviewers (all orphaned)", () => {
    const sessions = [
      makeItem({ id: "r1", sessionNum: 10, reviewerOf: 1 }),
      makeItem({ id: "r2", sessionNum: 20, reviewerOf: 2 }),
    ];
    nestReviewerSessions(sessions);
    // Both are orphaned, appended in original order
    expect(sessions.map((s) => s.id)).toEqual(["r1", "r2"]);
  });

  it("handles sessions without sessionNum gracefully", () => {
    const sessions = [
      makeItem({ id: "s1" }), // no sessionNum
      makeItem({ id: "s2", sessionNum: 5 }),
      makeItem({ id: "r1", sessionNum: 10, reviewerOf: 5 }),
    ];
    nestReviewerSessions(sessions);
    // r1 should nest after s2 (sessionNum 5), s1 stays in place
    expect(sessions.map((s) => s.id)).toEqual(["s1", "s2", "r1"]);
  });
});
