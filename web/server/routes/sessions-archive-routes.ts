import type { Hono } from "hono";
import { recreateWorktreeIfMissing } from "../migration.js";
import { containerManager } from "../container-manager.js";
import { getActorSessionId, getArchiveSource } from "./sessions-helpers.js";
import type { RouteContext } from "./context.js";

type WorktreeCleanupStatus = "pending" | "done" | "failed";
type QueuedWorktreeCleanupResult = { status: WorktreeCleanupStatus; path?: string } | undefined;
type WorktreeInitialState = {
  cwd: string;
  worktree: {
    repoRoot: string;
    defaultBranch?: string;
    diffBaseBranch: string;
  };
};

interface SessionsArchiveRoutesDeps {
  authenticateCompanionCallerOptional: RouteContext["authenticateCompanionCallerOptional"];
  applyInitialSessionState: (sessionId: string, options: WorktreeInitialState) => void;
  launcher: RouteContext["launcher"];
  pathExists: RouteContext["pathExists"];
  pendingWorktreeCleanups: Map<string, Promise<void>>;
  prPoller?: RouteContext["prPoller"];
  queueArchivedWorktreeCleanup: (
    sessionId: string,
    options?: { archiveBranch?: boolean },
  ) => QueuedWorktreeCleanupResult;
  resolveId: RouteContext["resolveId"];
  sessionStore: RouteContext["sessionStore"];
  timerManager?: RouteContext["timerManager"];
  worktreeTracker: RouteContext["worktreeTracker"];
  wsBridge: RouteContext["wsBridge"];
}

export function registerSessionsArchiveRoutes(api: Hono, deps: SessionsArchiveRoutesDeps) {
  const {
    authenticateCompanionCallerOptional,
    applyInitialSessionState,
    launcher,
    pathExists,
    pendingWorktreeCleanups,
    prPoller,
    queueArchivedWorktreeCleanup,
    resolveId,
    sessionStore,
    timerManager,
    worktreeTracker,
    wsBridge,
  } = deps;

  // Shared helper: archive a single session (kill, cleanup, persist).
  // Used by both /archive and /archive-group endpoints.
  async function archiveSingleSession(id: string, actorSessionId?: string) {
    // Emit herd event before killing -- the leader needs to know a worker was archived.
    const archivedSessionInfo = launcher.getSession(id);
    if (archivedSessionInfo?.herdedBy) {
      wsBridge.emitTakodeEvent(
        id,
        "session_archived",
        { archive_source: getArchiveSource(actorSessionId) },
        actorSessionId,
      );
    }

    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    // Stop PR polling for this session
    prPoller?.unwatch(id);

    // Force-delete the worktree directory on archive. The branch tip is saved
    // as an archived ref (refs/companion/archived/) so committed work can be
    // restored on unarchive without polluting the active branch list (q-329).
    const worktreeResult = queueArchivedWorktreeCleanup(id, { archiveBranch: true });
    launcher.setArchived(id, true);
    await sessionStore.setArchived(id, true);

    // Cancel all session-scoped timers when archiving.
    if (timerManager) {
      void timerManager.cancelAllTimers(id);
    }

    // Auto-archive reviewer sessions tied to this parent.
    // Reviewer sessions are historical quality records; when the parent is
    // archived, keep the reviewer trajectory inspectable without leaving a live
    // reviewer process or a standalone active-sidebar row.
    // listSessions() returns a new array (Array.from), and kill() only mutates
    // session.state without removing from the sessions map, so iteration is safe.
    const archivedNum = launcher.getSessionNum(id);
    if (archivedNum !== undefined) {
      const allSessions = launcher.listSessions();
      for (const s of allSessions) {
        if (s.reviewerOf === archivedNum && !s.archived) {
          console.log(`[routes] Auto-archiving reviewer session ${s.sessionId} (reviewerOf=#${archivedNum})`);
          await launcher.kill(s.sessionId);
          containerManager.removeContainer(s.sessionId);
          queueArchivedWorktreeCleanup(s.sessionId, { archiveBranch: true });
          launcher.setArchived(s.sessionId, true);
          await sessionStore.setArchived(s.sessionId, true);
          // Emit after kill so the leader doesn't query a still-alive session
          if (s.herdedBy) {
            wsBridge.emitTakodeEvent(s.sessionId, "session_archived", { archive_source: "cascade" });
          }
        }
      }
    }
    return worktreeResult;
  }

  api.post("/sessions/:id/archive", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    await c.req.json().catch(() => ({}));

    const actorId = getActorSessionId(authenticateCompanionCallerOptional(c));
    const worktreeResult = await archiveSingleSession(id, actorId);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.post("/sessions/:id/archive-group", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const leader = launcher.getSession(id);
    if (!leader) return c.json({ error: "Session not found" }, 404);
    if (!leader.isOrchestrator) {
      return c.json({ error: "Session is not an orchestrator" }, 400);
    }

    const actorId = getActorSessionId(authenticateCompanionCallerOptional(c));

    // Find all non-archived herded workers
    const workers = launcher.getHerdedSessions(id).filter((s) => !s.archived);
    const results: Array<{ sessionId: string; ok: boolean; error?: string }> = [];

    // Archive workers first, then the leader (avoids herd events to a dead leader)
    for (const w of workers) {
      try {
        await archiveSingleSession(w.sessionId, actorId);
        results.push({ sessionId: w.sessionId, ok: true });
      } catch (e) {
        results.push({
          sessionId: w.sessionId,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Archive the leader itself
    try {
      await archiveSingleSession(id);
      results.push({ sessionId: id, ok: true });
    } catch (e) {
      results.push({
        sessionId: id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const anyFailed = results.some((r) => !r.ok);
    return c.json({
      ok: !anyFailed,
      archived: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  });

  api.post("/sessions/:id/unarchive", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);
    if (info.worktreeCleanupStatus === "pending") {
      if (pendingWorktreeCleanups.has(id)) {
        return c.json({ error: "Worktree cleanup is still running. Try unarchiving again in a few seconds." }, 409);
      }
      launcher.setWorktreeCleanupState(id, {
        status: "failed",
        error: info.worktreeCleanupError || "Cleanup was interrupted before completion.",
        startedAt: info.worktreeCleanupStartedAt,
        finishedAt: Date.now(),
      });
    }

    launcher.setArchived(id, false);
    await sessionStore.setArchived(id, false);

    // For worktree sessions: recreate the worktree if it was deleted during archiving
    let worktreeRecreated = false;
    if (info.isWorktree && info.repoRoot && info.branch) {
      if (!(await pathExists(info.cwd))) {
        try {
          const result = await recreateWorktreeIfMissing(id, info, { launcher, worktreeTracker, wsBridge });
          if (result.error) {
            return c.json({ ok: false, error: `Failed to recreate worktree: ${result.error}` }, 500);
          }
          worktreeRecreated = result.recreated;
        } catch (e) {
          console.error(`[routes] Failed to recreate worktree for session ${id}:`, e);
          return c.json(
            {
              ok: false,
              error: `Failed to recreate worktree: ${e instanceof Error ? e.message : String(e)}`,
            },
            500,
          );
        }
      } else {
        // Worktree still exists — re-register tracker and bridge state
        worktreeTracker.addMapping({
          sessionId: id,
          repoRoot: info.repoRoot,
          branch: info.branch,
          actualBranch: info.actualBranch || info.branch,
          worktreePath: info.cwd,
          createdAt: Date.now(),
        });
        applyInitialSessionState(id, {
          cwd: info.cwd,
          worktree: { repoRoot: info.repoRoot, defaultBranch: undefined, diffBaseBranch: info.branch },
        });
      }
    }

    // Auto-relaunch the CLI so the session is immediately usable
    const relaunchResult = await launcher.relaunch(id);
    return c.json({ ok: true, worktreeRecreated, relaunch: relaunchResult });
  });
}
