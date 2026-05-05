import { Hono } from "hono";
import { refreshGitInfoPublic as refreshGitInfoPublicController } from "../bridge/session-git-state.js";
import type { RouteContext } from "./context.js";

export function createSessionGitStatusRoutes(ctx: RouteContext) {
  const api = new Hono();
  const bridgeAny = ctx.wsBridge as any;
  const { wsBridge, resolveId } = ctx;

  api.post("/sessions/:id/git-status/refresh", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    const session = wsBridge.getSession(id);
    const deps = bridgeAny.getSessionGitStateDeps?.();
    if (!session || !deps) return c.json({ error: "Session not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const force =
      typeof body === "object" && body !== null && "force" in body
        ? (body as { force?: boolean }).force !== false
        : true;

    const refreshResult = force
      ? await refreshGitInfoPublicController(session as any, deps, {
          broadcastUpdate: true,
          notifyPoller: true,
          force: true,
        })
      : await wsBridge
          .refreshWorktreeGitStateForSnapshot(id, {
            broadcastUpdate: true,
            notifyPoller: true,
          })
          .then((state) => ({
            ok: !state?.git_status_refresh_error,
            error: state?.git_status_refresh_error ?? null,
          }));

    const state = wsBridge.getSession(id)?.state;
    return c.json({
      ok: refreshResult.ok,
      error: refreshResult.error,
      gitBranch: state?.git_branch || null,
      gitDefaultBranch: state?.git_default_branch || null,
      diffBaseBranch: state?.diff_base_branch || null,
      gitAhead: state?.git_ahead || 0,
      gitBehind: state?.git_behind || 0,
      totalLinesAdded: state?.total_lines_added || 0,
      totalLinesRemoved: state?.total_lines_removed || 0,
      gitStatusRefreshedAt: state?.git_status_refreshed_at || null,
      gitStatusRefreshError: state?.git_status_refresh_error || refreshResult.error,
    });
  });

  return api;
}
