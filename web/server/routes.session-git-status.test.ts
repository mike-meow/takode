import { vi, describe, it, expect, beforeEach } from "vitest";

const mockExec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ exec: mockExec }));

import { Hono } from "hono";
import { createSessionGitStatusRoutes } from "./routes/session-git-status.js";

describe("session git status routes", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("returns ok false when manual refresh cannot recompute diff stats", async () => {
    mockExec.mockImplementation((cmd: string, opts: unknown, cb?: Function) => {
      const callback = typeof opts === "function" ? opts : cb;
      if (cmd.includes("diff --numstat")) {
        callback?.(new Error("diff timed out"), { stdout: "", stderr: "timed out" });
        return;
      }
      if (cmd.includes("merge-base")) {
        callback?.(null, { stdout: "base-sha\n", stderr: "" });
        return;
      }
      callback?.(null, { stdout: "", stderr: "" });
    });

    const session = {
      id: "s1",
      state: {
        cwd: "/repo",
        git_branch: "feature",
        git_default_branch: "main",
        diff_base_branch: "main",
        git_ahead: 2,
        git_behind: 0,
        is_worktree: false,
        total_lines_added: 25,
        total_lines_removed: 4,
        git_status_refreshed_at: 1234,
        git_status_refresh_error: null,
      },
      worktreeStateFingerprint: "",
      backendSocket: null,
      codexAdapter: null,
      browserSockets: { size: 1 },
      diffStatsDirty: false,
    };
    const deps = {
      refreshGitInfo: vi.fn(async (targetSession: typeof session) => {
        targetSession.state.git_status_refreshed_at = 9999;
        targetSession.state.git_status_refresh_error = null;
      }),
      broadcastSessionUpdate: vi.fn(),
      broadcastDiffTotals: vi.fn(),
      persistSession: vi.fn(),
    };
    const app = new Hono();
    app.route(
      "/api",
      createSessionGitStatusRoutes({
        resolveId: (id: string) => id,
        wsBridge: {
          getSession: vi.fn(() => session),
          getSessionGitStateDeps: vi.fn(() => deps),
        },
      } as any),
    );

    const res = await app.request("/api/sessions/s1/git-status/refresh", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      error: "Unable to refresh diff stats",
      totalLinesAdded: 25,
      totalLinesRemoved: 4,
      gitStatusRefreshedAt: 1234,
      gitStatusRefreshError: "Unable to refresh diff stats",
    });
    expect(deps.broadcastDiffTotals).not.toHaveBeenCalled();
  });

  it("uses the cheap snapshot refresh path for automatic refresh requests", async () => {
    const session = {
      id: "s1",
      state: {
        cwd: "/repo",
        git_branch: "feature",
        git_default_branch: "main",
        diff_base_branch: "main",
        git_ahead: 1,
        git_behind: 0,
        is_worktree: true,
        total_lines_added: 12,
        total_lines_removed: 3,
        git_status_refreshed_at: 1234,
        git_status_refresh_error: null,
      },
      worktreeStateFingerprint: "",
      backendSocket: null,
      codexAdapter: null,
      browserSockets: { size: 1 },
      diffStatsDirty: false,
    };
    const refreshWorktreeGitStateForSnapshot = vi.fn(async () => {
      session.state.git_status_refreshed_at = 4321;
      return session.state;
    });
    const manualDeps = {
      refreshGitInfo: vi.fn(),
      broadcastSessionUpdate: vi.fn(),
      broadcastDiffTotals: vi.fn(),
      persistSession: vi.fn(),
    };
    const app = new Hono();
    app.route(
      "/api",
      createSessionGitStatusRoutes({
        resolveId: (id: string) => id,
        wsBridge: {
          getSession: vi.fn(() => session),
          getSessionGitStateDeps: vi.fn(() => manualDeps),
          refreshWorktreeGitStateForSnapshot,
        },
      } as any),
    );

    const res = await app.request("/api/sessions/s1/git-status/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: false }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(refreshWorktreeGitStateForSnapshot).toHaveBeenCalledWith("s1", {
      broadcastUpdate: true,
      notifyPoller: true,
    });
    expect(manualDeps.refreshGitInfo).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      ok: true,
      gitAhead: 1,
      totalLinesAdded: 12,
      gitStatusRefreshedAt: 4321,
      gitStatusRefreshError: null,
    });
  });
});
