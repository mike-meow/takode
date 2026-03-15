import { Hono } from "hono";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import * as gitUtils from "../git-utils.js";
import { GIT_CMD_TIMEOUT } from "../constants.js";
import type { RouteContext } from "./context.js";

export function createGitRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, prPoller, execCaptureStdoutAsync, wsBridge } = ctx;
  const execPromise = promisify(execCb);

  // ─── Git operations ─────────────────────────────────────────────────

  api.get("/git/repo-info", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const info = await gitUtils.getRepoInfoAsync(path);
    if (!info) return c.json({ error: "Not a git repository" }, 400);
    return c.json(info);
  });

  api.get("/git/branches", async (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    const localOnly = c.req.query("localOnly") === "1";
    try {
      return c.json(await gitUtils.listBranchesAsync(repoRoot, { localOnly }));
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/git/commits", async (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    const limitStr = c.req.query("limit");
    const limit = Math.min(Math.max(parseInt(limitStr || "20", 10) || 20, 1), 100);
    try {
      const raw = await execCaptureStdoutAsync(`git log --format="%H%x00%h%x00%s%x00%ct" -${limit}`, repoRoot);
      const commits = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, shortSha, message, ts] = line.split("\0");
          return { sha, shortSha, message, timestamp: parseInt(ts, 10) * 1000 };
        });
      return c.json({ commits });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.post("/git/fetch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot } = body;
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    return c.json(await gitUtils.gitFetchAsync(repoRoot));
  });

  api.get("/git/worktrees", async (c) => {
    const repoRoot = c.req.query("repoRoot");
    if (!repoRoot) return c.json({ error: "repoRoot required" }, 400);
    return c.json(await gitUtils.listWorktreesAsync(repoRoot));
  });

  api.post("/git/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, branch, baseBranch, createBranch } = body;
    if (!repoRoot || !branch) return c.json({ error: "repoRoot and branch required" }, 400);
    const result = gitUtils.ensureWorktree(repoRoot, branch, { baseBranch, createBranch });
    return c.json(result);
  });

  api.delete("/git/worktree", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { repoRoot, worktreePath, force } = body;
    if (!repoRoot || !worktreePath) return c.json({ error: "repoRoot and worktreePath required" }, 400);
    const result = gitUtils.removeWorktree(repoRoot, worktreePath, { force });
    return c.json(result);
  });

  api.post("/git/pull", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, sessionId } = body;
    if (!cwd) return c.json({ error: "cwd required" }, 400);
    const result = await gitUtils.gitPullAsync(cwd);
    // Return refreshed ahead/behind counts
    let git_ahead = 0,
      git_behind = 0;
    try {
      const { stdout: counts } = await execPromise(
        "git --no-optional-locks rev-list --left-right --count @{upstream}...HEAD",
        {
          cwd,
          encoding: "utf-8",
          timeout: GIT_CMD_TIMEOUT,
        },
      );
      const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
      git_ahead = ahead || 0;
      git_behind = behind || 0;
    } catch {
      /* no upstream */
    }
    // Broadcast updated git counts to all browsers for this session
    if (sessionId) {
      wsBridge.broadcastSessionUpdate(sessionId, { git_ahead, git_behind });
    }
    return c.json({ ...result, git_ahead, git_behind });
  });

  // ─── GitHub PR Status ────────────────────────────────────────────────

  api.get("/git/pr-status", async (c) => {
    const cwd = c.req.query("cwd");
    const branch = c.req.query("branch");
    if (!cwd || !branch) return c.json({ error: "cwd and branch required" }, 400);

    // Check poller cache first for instant response
    if (prPoller) {
      const cached = prPoller.getCached(cwd, branch);
      if (cached) return c.json(cached);
    }

    const { isGhAvailable, fetchPRInfoAsync } = await import("../github-pr.js");
    if (!isGhAvailable()) {
      return c.json({ available: false, pr: null });
    }

    const pr = await fetchPRInfoAsync(cwd, branch);
    return c.json({ available: true, pr });
  });

  return api;
}
