import { describe, expect, it, vi } from "vitest";
import {
  cleanupBranchState,
  invalidateSessionsSharingBranch,
  removeBranchIndexEntries,
  updateBranchIndex,
  type BranchSessionLike,
} from "./branch-session-index.js";

function makeSession(
  id: string,
  refs: { git_branch?: string; diff_base_branch?: string; git_default_branch?: string },
): BranchSessionLike {
  return {
    id,
    state: refs,
    diffStatsDirty: false,
  };
}

describe("branch-session-index", () => {
  // Ensures a session's branch index entries are replaced atomically when refs change,
  // so stale branch memberships do not linger after a branch rename/switch.
  it("updates and replaces indexed branch refs for a live session", () => {
    const branchToSessions = new Map<string, Set<string>>();
    const sessionBranches = new Map<string, Set<string>>();
    const session = makeSession("s1", {
      git_branch: "feature",
      diff_base_branch: "origin/main",
      git_default_branch: "origin/main",
    });

    updateBranchIndex(session, {
      isArchived: false,
      branchToSessions,
      sessionBranches,
    });

    expect(branchToSessions.get("feature")).toEqual(new Set(["s1"]));
    expect(branchToSessions.get("origin/main")).toEqual(new Set(["s1"]));

    session.state.git_branch = "feature-next";
    updateBranchIndex(session, {
      isArchived: false,
      branchToSessions,
      sessionBranches,
    });

    expect(branchToSessions.has("feature")).toBe(false);
    expect(branchToSessions.get("feature-next")).toEqual(new Set(["s1"]));
    expect(sessionBranches.get("s1")).toEqual(new Set(["feature-next", "origin/main"]));
  });

  // Verifies cleanup removes both reverse-index entries and throttle bookkeeping,
  // and that removing a missing session remains a harmless no-op.
  it("removes indexed refs and throttle state during cleanup", () => {
    const branchToSessions = new Map<string, Set<string>>([
      ["feature", new Set(["s1"])],
      ["origin/main", new Set(["s1"])],
    ]);
    const sessionBranches = new Map<string, Set<string>>([
      ["s1", new Set(["feature", "origin/main"])],
    ]);
    const lastCrossSessionRefreshAt = new Map<string, number>([["s1", 123]]);

    cleanupBranchState("s1", {
      branchToSessions,
      sessionBranches,
      lastCrossSessionRefreshAt,
    });

    expect(branchToSessions.size).toBe(0);
    expect(sessionBranches.size).toBe(0);
    expect(lastCrossSessionRefreshAt.size).toBe(0);

    removeBranchIndexEntries("missing", {
      branchToSessions,
      sessionBranches,
    });
    expect(branchToSessions.size).toBe(0);
  });

  // Confirms cross-session invalidation only touches eligible sessions:
  // matching live sessions refresh, while archived, throttled, and unrelated sessions are skipped.
  it("invalidates matching live sessions while skipping archived and throttled ones", () => {
    const triggerSession = makeSession("leader", {
      git_branch: "feature",
    });
    const matching = makeSession("worker-1", {
      git_branch: "branch-a",
      diff_base_branch: "feature",
    });
    const archived = makeSession("worker-2", {
      git_branch: "branch-b",
      diff_base_branch: "feature",
    });
    const throttled = makeSession("worker-3", {
      git_branch: "branch-c",
      git_default_branch: "feature",
    });
    const unrelated = makeSession("worker-4", {
      git_branch: "branch-d",
      diff_base_branch: "origin/main",
    });

    const sessions = new Map<string, BranchSessionLike>([
      [triggerSession.id, triggerSession],
      [matching.id, matching],
      [archived.id, archived],
      [throttled.id, throttled],
      [unrelated.id, unrelated],
    ]);
    const branchToSessions = new Map<string, Set<string>>([
      ["feature", new Set(["leader", "worker-1", "worker-2", "worker-3"])],
    ]);
    const sessionBranches = new Map<string, Set<string>>();
    const lastCrossSessionRefreshAt = new Map<string, number>([["worker-3", 990]]);
    const refreshSession = vi.fn();

    const result = invalidateSessionsSharingBranch(triggerSession, {
      sessions,
      branchToSessions,
      sessionBranches,
      lastCrossSessionRefreshAt,
      throttleMs: 30,
      now: 1_000,
      isArchived: (sessionId) => sessionId === "worker-2",
      refreshSession,
    });

    expect(result).toEqual({ changedBranch: "feature", invalidatedCount: 1 });
    expect(matching.diffStatsDirty).toBe(true);
    expect(archived.diffStatsDirty).toBe(false);
    expect(throttled.diffStatsDirty).toBe(false);
    expect(unrelated.diffStatsDirty).toBe(false);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshSession).toHaveBeenCalledWith(matching);
    expect(lastCrossSessionRefreshAt.get("worker-1")).toBe(1_000);
    expect(lastCrossSessionRefreshAt.get("worker-3")).toBe(990);
  });
});
