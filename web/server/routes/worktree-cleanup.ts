import * as gitUtils from "../git-utils.js";
import type { WorktreeMapping, WorktreeTracker } from "../worktree-tracker.js";

export type WorktreeCleanupStatus = "pending" | "done" | "failed";
export type WorktreeCleanupResult = { cleaned?: boolean; dirty?: boolean; path?: string; reason?: string } | undefined;

interface WorktreeSessionInfo {
  sessionId: string;
  cwd: string;
  isWorktree?: boolean;
  repoRoot?: string;
  branch?: string;
  actualBranch?: string;
}

interface WorktreeCleanupLauncher {
  getSession(sessionId: string): WorktreeSessionInfo | undefined;
  setWorktreeCleanupState(
    sessionId: string,
    updates: {
      status?: WorktreeCleanupStatus;
      error?: string;
      startedAt?: number;
      finishedAt?: number;
    },
  ): void;
}

interface ArchivedWorktreeCleanupDeps {
  launcher: WorktreeCleanupLauncher;
  pendingWorktreeCleanups: Map<string, Promise<void>>;
  worktreeTracker: WorktreeTracker;
  logger?: Pick<Console, "error" | "log">;
}

type WorktreeCleanupTarget = WorktreeMapping;

function resolveWorktreeCleanupTarget(
  sessionId: string,
  launcher: WorktreeCleanupLauncher,
  worktreeTracker: WorktreeTracker,
): WorktreeCleanupTarget | null {
  const mapping = worktreeTracker.getBySession(sessionId);
  if (mapping) return mapping;

  const session = launcher.getSession(sessionId);
  if (!session?.isWorktree || !session.repoRoot || !session.branch || !session.cwd) return null;

  return {
    sessionId,
    repoRoot: session.repoRoot,
    branch: session.branch,
    actualBranch: session.actualBranch,
    worktreePath: session.cwd,
    createdAt: Date.now(),
  };
}

async function cleanupWorktree(
  target: WorktreeCleanupTarget,
  worktreeTracker: WorktreeTracker,
  force?: boolean,
  options?: { archiveBranch?: boolean },
): Promise<WorktreeCleanupResult> {
  if (worktreeTracker.isWorktreeInUse(target.worktreePath, target.sessionId)) {
    worktreeTracker.removeBySession(target.sessionId);
    return { cleaned: false, path: target.worktreePath };
  }

  const dirty = await gitUtils.isWorktreeDirtyAsync(target.worktreePath);
  if (dirty && !force) {
    return { cleaned: false, dirty: true, path: target.worktreePath };
  }

  const managedBranch = target.actualBranch && target.actualBranch !== target.branch ? target.actualBranch : undefined;

  if (options?.archiveBranch && managedBranch) {
    await gitUtils.archiveBranchAsync(target.repoRoot, managedBranch);
    const result = await gitUtils.removeWorktreeAsync(target.repoRoot, target.worktreePath, {
      force: dirty,
    });
    if (result.removed) {
      worktreeTracker.removeBySession(target.sessionId);
    }
    return { cleaned: result.removed, path: target.worktreePath, reason: result.reason };
  }

  const result = await gitUtils.removeWorktreeAsync(target.repoRoot, target.worktreePath, {
    force: dirty,
    branchToDelete: managedBranch,
  });
  if (result.removed) {
    worktreeTracker.removeBySession(target.sessionId);
  }
  return { cleaned: result.removed, path: target.worktreePath, reason: result.reason };
}

export function createArchivedWorktreeCleanupQueue(deps: ArchivedWorktreeCleanupDeps) {
  const { launcher, pendingWorktreeCleanups, worktreeTracker, logger = console } = deps;

  return (
    sessionId: string,
    options?: { archiveBranch?: boolean },
  ): { status: WorktreeCleanupStatus; path?: string } | undefined => {
    const target = resolveWorktreeCleanupTarget(sessionId, launcher, worktreeTracker);
    if (!target) return undefined;

    if (pendingWorktreeCleanups.has(sessionId)) {
      return { status: "pending", path: target.worktreePath };
    }

    const startedAt = Date.now();
    launcher.setWorktreeCleanupState(sessionId, {
      status: "pending",
      error: undefined,
      startedAt,
      finishedAt: undefined,
    });

    const task = (async () => {
      try {
        const result = await cleanupWorktree(target, worktreeTracker, true, options);
        const finishedAt = Date.now();
        const cleanupStatus: WorktreeCleanupStatus = result?.reason ? "failed" : "done";
        launcher.setWorktreeCleanupState(sessionId, {
          status: cleanupStatus,
          error: result?.reason,
          startedAt,
          finishedAt,
        });
        if (result?.path) {
          const message = `[routes] Archived worktree cleanup ${cleanupStatus} for ${sessionId}: ${result.path}${
            result.reason ? ` (${result.reason})` : ""
          }`;
          if (cleanupStatus === "failed") {
            logger.error(message);
          } else {
            logger.log(message);
          }
        }
      } catch (e) {
        const finishedAt = Date.now();
        const error = e instanceof Error ? e.message : String(e);
        launcher.setWorktreeCleanupState(sessionId, {
          status: "failed",
          error,
          startedAt,
          finishedAt,
        });
        logger.error(`[routes] Archived worktree cleanup failed for ${sessionId}:`, e);
      } finally {
        pendingWorktreeCleanups.delete(sessionId);
      }
    })();

    pendingWorktreeCleanups.set(sessionId, task);
    void task;
    return { status: "pending", path: target.worktreePath };
  };
}
