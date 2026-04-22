import { Hono } from "hono";
import * as sessionNames from "../session-names.js";
import type { RouteContext } from "./context.js";

export function createTimerRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, wsBridge, authenticateTakodeCaller, resolveId } = ctx;

  // GET /api/timers/active — list all active timers for the browser UI
  api.get("/timers/active", async (c) => {
    if (!ctx.timerManager) return c.json({ error: "Timer manager not available" }, 503);

    const names = sessionNames.getAllNames();
    const sessions = launcher.listSessions();

    const activeTimers = sessions
      .filter((session) => !session.archived)
      .map((session) => {
        const timers = [...ctx.timerManager!.listTimers(session.sessionId)].sort((a, b) => a.nextFireAt - b.nextFireAt);
        if (timers.length === 0) return null;

        const bridgeSession = wsBridge.getSession(session.sessionId);
        const bridge = bridgeSession?.state;
        const cliConnected = wsBridge.isBackendConnected(session.sessionId);
        const effectiveState = cliConnected && bridgeSession?.isGenerating ? "running" : session.state;

        return {
          sessionId: session.sessionId,
          sessionNum: launcher.getSessionNum(session.sessionId) ?? null,
          name: names[session.sessionId] ?? session.name,
          backendType: bridge?.backend_type || session.backendType || "claude",
          state: effectiveState,
          cliConnected,
          cwd: session.cwd,
          gitBranch: bridge?.git_branch || "",
          timers,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.timers[0]!.nextFireAt - b.timers[0]!.nextFireAt);

    return c.json(activeTimers);
  });

  // POST /api/sessions/:id/timers — create a timer
  api.post("/sessions/:id/timers", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const raw = c.req.param("id");
    const sessionId = resolveId(raw);
    if (!sessionId) return c.json({ error: `Session not found: ${raw}` }, 404);

    if (!ctx.timerManager) return c.json({ error: "Timer manager not available" }, 503);

    try {
      const body = await c.req.json();
      const timer = await ctx.timerManager.createTimer(sessionId, body);
      return c.json({ timer }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  // GET /api/sessions/:id/timers — list timers for a session
  api.get("/sessions/:id/timers", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const raw = c.req.param("id");
    const sessionId = resolveId(raw);
    if (!sessionId) return c.json({ error: `Session not found: ${raw}` }, 404);

    if (!ctx.timerManager) return c.json({ error: "Timer manager not available" }, 503);

    const timers = ctx.timerManager.listTimers(sessionId);
    return c.json({ timers });
  });

  // DELETE /api/sessions/:id/timers/:timerId — cancel a timer
  api.delete("/sessions/:id/timers/:timerId", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const raw = c.req.param("id");
    const sessionId = resolveId(raw);
    if (!sessionId) return c.json({ error: `Session not found: ${raw}` }, 404);

    if (!ctx.timerManager) return c.json({ error: "Timer manager not available" }, 503);

    const timerId = c.req.param("timerId");
    const cancelled = await ctx.timerManager.cancelTimer(sessionId, timerId);
    if (!cancelled) return c.json({ error: `Timer not found: ${timerId}` }, 404);

    return c.json({ ok: true });
  });

  return api;
}
