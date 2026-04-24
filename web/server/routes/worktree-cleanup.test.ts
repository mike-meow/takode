import { beforeEach, describe, expect, it, vi } from "vitest";
import * as gitUtils from "../git-utils.js";
import { createArchivedWorktreeCleanupQueue } from "./worktree-cleanup.js";

vi.mock("../git-utils.js", () => ({
  archiveBranchAsync: vi.fn(async () => true),
  isWorktreeDirtyAsync: vi.fn(async () => false),
  removeWorktreeAsync: vi.fn(async () => ({ removed: true })),
}));

function makeLauncher(session?: {
  sessionId: string;
  cwd: string;
  isWorktree?: boolean;
  repoRoot?: string;
  branch?: string;
  actualBranch?: string;
}) {
  return {
    getSession: vi.fn((_sessionId: string) => session),
    setWorktreeCleanupState: vi.fn(),
  };
}

function makeTracker(mapping?: {
  sessionId: string;
  repoRoot: string;
  branch: string;
  actualBranch?: string;
  worktreePath: string;
  createdAt: number;
}) {
  return {
    getBySession: vi.fn((_sessionId: string) => mapping ?? null),
    isWorktreeInUse: vi.fn(() => false),
    removeBySession: vi.fn(),
    addMapping: vi.fn(),
    getSessionsForWorktree: vi.fn(() => []),
    getSessionsForRepo: vi.fn(() => []),
  };
}

describe("createArchivedWorktreeCleanupQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gitUtils.archiveBranchAsync).mockResolvedValue(true);
    vi.mocked(gitUtils.isWorktreeDirtyAsync).mockResolvedValue(false);
    vi.mocked(gitUtils.removeWorktreeAsync).mockResolvedValue({ removed: true });
  });

  it("force-deletes an archived worktree from the tracker mapping", async () => {
    // Protects the normal archive path: tracker metadata should drive forced
    // cleanup and remove the tracker entry after git removes the worktree.
    const launcher = makeLauncher();
    const pending = new Map<string, Promise<void>>();
    const tracker = makeTracker({
      sessionId: "s1",
      repoRoot: "/repo",
      branch: "feat",
      actualBranch: "feat-wt-1234",
      worktreePath: "/repo-wt",
      createdAt: 1,
    });
    const queueCleanup = createArchivedWorktreeCleanupQueue({
      launcher,
      pendingWorktreeCleanups: pending,
      worktreeTracker: tracker as any,
      logger: { error: vi.fn(), log: vi.fn() },
    });

    const result = queueCleanup("s1", { archiveBranch: true });
    expect(result).toEqual({ status: "pending", path: "/repo-wt" });
    await pending.get("s1");

    expect(gitUtils.archiveBranchAsync).toHaveBeenCalledWith("/repo", "feat-wt-1234");
    expect(gitUtils.removeWorktreeAsync).toHaveBeenCalledWith("/repo", "/repo-wt", { force: false });
    expect(tracker.removeBySession).toHaveBeenCalledWith("s1");
    expect(launcher.setWorktreeCleanupState).toHaveBeenLastCalledWith(
      "s1",
      expect.objectContaining({ status: "done", error: undefined, finishedAt: expect.any(Number) }),
    );
  });

  it("falls back to launcher worktree metadata when the tracker mapping is missing", async () => {
    // Some historical/recovered sessions can retain worktree metadata on the
    // session while missing the tracker entry; archiving still must delete.
    const launcher = makeLauncher({
      sessionId: "s1",
      cwd: "/repo-wt",
      isWorktree: true,
      repoRoot: "/repo",
      branch: "feat",
      actualBranch: "feat-wt-1234",
    });
    const tracker = makeTracker();
    const pending = new Map<string, Promise<void>>();
    const queueCleanup = createArchivedWorktreeCleanupQueue({
      launcher,
      pendingWorktreeCleanups: pending,
      worktreeTracker: tracker as any,
      logger: { error: vi.fn(), log: vi.fn() },
    });

    const result = queueCleanup("s1", { archiveBranch: true });
    expect(result).toEqual({ status: "pending", path: "/repo-wt" });
    await pending.get("s1");

    expect(gitUtils.archiveBranchAsync).toHaveBeenCalledWith("/repo", "feat-wt-1234");
    expect(gitUtils.removeWorktreeAsync).toHaveBeenCalledWith("/repo", "/repo-wt", { force: false });
    expect(launcher.setWorktreeCleanupState).toHaveBeenLastCalledWith(
      "s1",
      expect.objectContaining({ status: "done", error: undefined, finishedAt: expect.any(Number) }),
    );
  });

  it("surfaces and logs archive cleanup failures once", async () => {
    // A failed git worktree removal should be visible through session state and
    // backend logs without throwing from the archive request path.
    const logger = { error: vi.fn(), log: vi.fn() };
    const launcher = makeLauncher({
      sessionId: "s1",
      cwd: "/repo-wt",
      isWorktree: true,
      repoRoot: "/repo",
      branch: "feat",
      actualBranch: "feat-wt-1234",
    });
    const tracker = makeTracker();
    const pending = new Map<string, Promise<void>>();
    vi.mocked(gitUtils.removeWorktreeAsync).mockResolvedValue({ removed: false, reason: "git refused removal" });
    const queueCleanup = createArchivedWorktreeCleanupQueue({
      launcher,
      pendingWorktreeCleanups: pending,
      worktreeTracker: tracker as any,
      logger,
    });

    queueCleanup("s1", { archiveBranch: true });
    await pending.get("s1");

    expect(launcher.setWorktreeCleanupState).toHaveBeenLastCalledWith(
      "s1",
      expect.objectContaining({
        status: "failed",
        error: "git refused removal",
        finishedAt: expect.any(Number),
      }),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "[routes] Archived worktree cleanup failed for s1: /repo-wt (git refused removal)",
    );
  });

  it("returns while slow archive cleanup remains pending", async () => {
    // Large worktrees can take a long time to remove; queuing must not wait for
    // the git remove promise to settle before the archive route responds.
    const launcher = makeLauncher({
      sessionId: "s1",
      cwd: "/repo-wt",
      isWorktree: true,
      repoRoot: "/repo",
      branch: "feat",
      actualBranch: "feat-wt-1234",
    });
    const tracker = makeTracker();
    const pending = new Map<string, Promise<void>>();
    let finishRemove = (_value: { removed: boolean }) => {};
    vi.mocked(gitUtils.removeWorktreeAsync).mockImplementation(
      () =>
        new Promise<{ removed: boolean }>((resolve) => {
          finishRemove = resolve;
        }),
    );
    const queueCleanup = createArchivedWorktreeCleanupQueue({
      launcher,
      pendingWorktreeCleanups: pending,
      worktreeTracker: tracker as any,
      logger: { error: vi.fn(), log: vi.fn() },
    });

    const result = queueCleanup("s1", { archiveBranch: true });
    expect(result).toEqual({ status: "pending", path: "/repo-wt" });
    expect(pending.has("s1")).toBe(true);
    expect(launcher.setWorktreeCleanupState).toHaveBeenLastCalledWith(
      "s1",
      expect.objectContaining({ status: "pending", finishedAt: undefined }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(gitUtils.removeWorktreeAsync).toHaveBeenCalled();
    finishRemove({ removed: true });
    await pending.get("s1");
    expect(pending.has("s1")).toBe(false);
  });
});
