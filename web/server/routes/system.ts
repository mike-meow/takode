import { Hono } from "hono";
import { readFile, writeFile, stat, rm, mkdir, unlink, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";
import * as envManager from "../env-manager.js";
import * as cronStore from "../cron-store.js";
import * as autoApprovalStore from "../auto-approval-store.js";
import { getNamerLogIndex, getNamerLogEntry } from "../session-namer.js";
import { getApprovalLogIndex, getApprovalLogEntry } from "../auto-approver.js";
import { runExport, runImport, type ImportStats } from "../migration.js";
import { containerManager } from "../container-manager.js";
import { resolveBinary } from "../path-resolver.js";
import { getSettings } from "../settings-manager.js";
import { getLogPath } from "../server-logger.js";
import { getUsageLimits } from "../usage-limits.js";
import { ensureAssistantWorkspace, ASSISTANT_DIR } from "../assistant-workspace.js";
import { getLegacyCodexHome } from "../codex-home.js";
import { getTranscriptionLogIndex, getTranscriptionLogEntry } from "../transcription-enhancer.js";
import type { RouteContext } from "./context.js";

function getCodexModelVariantRank(slug: string): number {
  if (slug.includes("-codex-spark")) return 2;
  if (slug.includes("-codex")) return 0;
  return 1;
}

function compareCodexModelSlugs(a: string, b: string): number {
  const aMatch = a.match(/^gpt-(\d+)\.(\d+)(?:\.(\d+))?/);
  const bMatch = b.match(/^gpt-(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!aMatch || !bMatch) return a.localeCompare(b);

  const aVersion = [Number(aMatch[1]), Number(aMatch[2]), Number(aMatch[3] ?? 0)];
  const bVersion = [Number(bMatch[1]), Number(bMatch[2]), Number(bMatch[3] ?? 0)];
  for (let i = 0; i < aVersion.length; i += 1) {
    if (aVersion[i] !== bVersion[i]) return bVersion[i] - aVersion[i];
  }

  const variantDelta = getCodexModelVariantRank(a) - getCodexModelVariantRank(b);
  if (variantDelta !== 0) return variantDelta;
  return a.localeCompare(b);
}

export function createSystemRoutes(ctx: RouteContext) {
  const api = new Hono();
  const {
    launcher,
    terminalManager,
    cronScheduler,
    recorder,
    perfTracer,
    WEB_DIR,
    wsBridge,
    sessionStore,
    pathExists,
    resolveId,
  } = ctx;

  // ─── Health ─────────────────────────────────────────────────────────

  api.get("/health", (c) => c.json({ ok: true, timestamp: Date.now() }));

  // ─── Performance Tracing ─────────────────────────────────────────────
  if (perfTracer) {
    api.get("/perf/summary", (c) => c.json(perfTracer.getSummary()));
    api.get("/perf/lag", (c) => c.json(perfTracer.getLagEvents(Number(c.req.query("limit")) || 50)));
    api.get("/perf/slow", (c) => c.json(perfTracer.getSlowRequests(Number(c.req.query("limit")) || 50)));
    api.get("/perf/ws", (c) => c.json(perfTracer.getSlowWsMessages(Number(c.req.query("limit")) || 50)));
    api.post("/perf/reset", (c) => { perfTracer.reset(); return c.json({ ok: true }); });
  }

  // ─── Available backends ─────────────────────────────────────

  api.get("/backends", (c) => {
    const s = getSettings();
    const backends: Array<{ id: string; name: string; available: boolean }> = [];

    backends.push({ id: "claude", name: "Claude Code", available: resolveBinary(s.claudeBinary || "claude") !== null });
    backends.push({ id: "claude-sdk", name: "Claude SDK", available: resolveBinary(s.claudeBinary || "claude") !== null });
    backends.push({ id: "codex", name: "Codex", available: resolveBinary(s.codexBinary || "codex") !== null });

    return c.json(backends);
  });

  api.get("/backends/:id/models", async (c) => {
    const backendId = c.req.param("id");

    if (backendId === "codex") {
      // Read Codex model list from its local cache file
      const cachePath = join(homedir(), ".codex", "models_cache.json");
      if (!(await pathExists(cachePath))) {
        return c.json({ error: "Codex models cache not found. Run codex once to populate it." }, 404);
      }
      try {
        const raw = await readFile(cachePath, "utf-8");
        const cache = JSON.parse(raw) as {
          models: Array<{
            slug: string;
            display_name?: string;
            description?: string;
            visibility?: string;
            priority?: number;
          }>;
        };
        // Keep only current visible models and enforce a stable Takode-facing order.
        const models = cache.models
          .filter((m) => m.visibility === "list")
          .filter((m) => !m.slug.startsWith("gpt-5.2") && !m.slug.startsWith("gpt-5.1"))
          .sort((a, b) => compareCodexModelSlugs(a.slug, b.slug))
          .map((m) => ({
            value: m.slug,
            label: m.display_name || m.slug,
            description: m.description || "",
          }));
        return c.json(models);
      } catch (e) {
        return c.json({ error: "Failed to parse Codex models cache" }, 500);
      }
    }

    // Claude models are hardcoded on the frontend
    return c.json({ error: "Use frontend defaults for this backend" }, 404);
  });

  // ─── Containers ─────────────────────────────────────────────────

  api.get("/containers/status", (c) => {
    const available = containerManager.checkDocker();
    const version = available ? containerManager.getDockerVersion() : null;
    return c.json({ available, version });
  });

  api.get("/containers/images", (c) => {
    const images = containerManager.listImages();
    return c.json(images);
  });

  // ─── Environments (~/.companion/envs/) ────────────────────────────

  api.get("/envs", async (c) => {
    try {
      return c.json(await envManager.listEnvs());
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/envs/:slug", async (c) => {
    const env = await envManager.getEnv(c.req.param("slug"));
    if (!env) return c.json({ error: "Environment not found" }, 404);
    return c.json(env);
  });

  api.post("/envs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const env = await envManager.createEnv(body.name, body.variables || {}, {
        dockerfile: body.dockerfile,
        baseImage: body.baseImage,
        ports: body.ports,
        volumes: body.volumes,
        initScript: body.initScript,
      });
      return c.json(env, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/envs/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));
    try {
      const env = await envManager.updateEnv(slug, {
        name: body.name,
        variables: body.variables,
        dockerfile: body.dockerfile,
        imageTag: body.imageTag,
        baseImage: body.baseImage,
        ports: body.ports,
        volumes: body.volumes,
        initScript: body.initScript,
      });
      if (!env) return c.json({ error: "Environment not found" }, 404);
      return c.json(env);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/envs/:slug", async (c) => {
    const deleted = await envManager.deleteEnv(c.req.param("slug"));
    if (!deleted) return c.json({ error: "Environment not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Docker Image Builds ─────────────────────────────────────────

  api.post("/envs/:slug/build", async (c) => {
    const slug = c.req.param("slug");
    const env = await envManager.getEnv(slug);
    if (!env) return c.json({ error: "Environment not found" }, 404);
    if (!env.dockerfile) return c.json({ error: "No Dockerfile configured for this environment" }, 400);
    if (!containerManager.checkDocker()) return c.json({ error: "Docker is not available" }, 503);

    const tag = `companion-env-${slug}:latest`;
    await envManager.updateBuildStatus(slug, "building");

    try {
      const result = await containerManager.buildImageStreaming(env.dockerfile, tag);
      if (result.success) {
        await envManager.updateBuildStatus(slug, "success", { imageTag: tag });
        return c.json({ success: true, imageTag: tag, log: result.log });
      } else {
        await envManager.updateBuildStatus(slug, "error", { error: result.log.slice(-500) });
        return c.json({ success: false, log: result.log }, 500);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await envManager.updateBuildStatus(slug, "error", { error: msg });
      return c.json({ success: false, error: msg }, 500);
    }
  });

  api.get("/envs/:slug/build-status", async (c) => {
    const env = await envManager.getEnv(c.req.param("slug"));
    if (!env) return c.json({ error: "Environment not found" }, 404);
    return c.json({
      buildStatus: env.buildStatus || "idle",
      buildError: env.buildError,
      lastBuiltAt: env.lastBuiltAt,
      imageTag: env.imageTag,
    });
  });

  api.post("/docker/build-base", async (c) => {
    if (!containerManager.checkDocker()) return c.json({ error: "Docker is not available" }, 503);
    // Build the-companion base image from the repo's Dockerfile
    const dockerfilePath = join(WEB_DIR, "docker", "Dockerfile.the-companion");
    if (!existsSync(dockerfilePath)) { // sync-ok: route handler, not called during message handling
      return c.json({ error: "Base Dockerfile not found at " + dockerfilePath }, 404);
    }
    try {
      const log = containerManager.buildImage(dockerfilePath, "the-companion:latest");
      return c.json({ success: true, log });
    } catch (e: unknown) {
      return c.json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/docker/base-image", (c) => {
    const exists = containerManager.imageExists("the-companion:latest");
    return c.json({ exists, image: "the-companion:latest" });
  });

  // ─── Usage Limits ─────────────────────────────────────────────────────

  api.get("/usage-limits", async (c) => {
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  api.get("/sessions/:id/usage-limits", async (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);
    const session = wsBridge.getSession(sessionId);
    const empty = { five_hour: null, seven_day: null, extra_usage: null };

    if (session?.backendType === "codex") {
      const rl = wsBridge.getCodexRateLimits(sessionId);
      if (!rl) return c.json(empty);
      const toEpochMs = (value: number): number => {
        // Codex has historically sent seconds; guard for future millisecond payloads.
        return value > 1_000_000_000_000 ? value : value * 1000;
      };
      const mapLimit = (l: { usedPercent: number; windowDurationMins: number; resetsAt: number } | null) => {
        if (!l) return null;
        return {
          utilization: l.usedPercent,
          resets_at: l.resetsAt ? new Date(toEpochMs(l.resetsAt)).toISOString() : null,
        };
      };
      return c.json({
        five_hour: mapLimit(rl.primary),
        seven_day: mapLimit(rl.secondary),
        extra_usage: null,
      });
    }

    // Claude sessions: use existing logic
    const limits = await getUsageLimits();
    return c.json(limits);
  });

  // ─── Terminal ──────────────────────────────────────────────────────

  api.get("/terminal", (c) => {
    const info = terminalManager.getInfo();
    if (!info) return c.json({ active: false });
    return c.json({ active: true, terminalId: info.id, cwd: info.cwd });
  });

  api.post("/terminal/spawn", async (c) => {
    const body = await c.req.json<{ cwd: string; cols?: number; rows?: number }>();
    if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
    const terminalId = terminalManager.spawn(body.cwd, body.cols, body.rows);
    return c.json({ terminalId });
  });

  api.post("/terminal/kill", (c) => {
    terminalManager.kill();
    return c.json({ ok: true });
  });

  // ─── Skills ─────────────────────────────────────────────────────────

  type SkillBackend = "claude" | "codex" | "both";
  const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");
  const CODEX_SKILLS_DIR = join(getLegacyCodexHome(), "skills");

  function parseSkillBackend(raw: string | undefined): SkillBackend | null {
    if (!raw || raw === "both") return "both";
    if (raw === "claude" || raw === "codex") return raw;
    return null;
  }

  function getSkillRoots(backend: SkillBackend): Array<{ backend: "claude" | "codex"; dir: string }> {
    if (backend === "claude") return [{ backend: "claude", dir: CLAUDE_SKILLS_DIR }];
    if (backend === "codex") return [{ backend: "codex", dir: CODEX_SKILLS_DIR }];
    return [
      { backend: "claude", dir: CLAUDE_SKILLS_DIR },
      { backend: "codex", dir: CODEX_SKILLS_DIR },
    ];
  }

  api.get("/skills", async (c) => {
    try {
      const backend = parseSkillBackend(c.req.query("backend"));
      if (!backend) return c.json({ error: "Invalid backend. Use claude, codex, or both." }, 400);

      const roots = getSkillRoots(backend);
      const bySlug = new Map<string, { slug: string; name: string; description: string; path: string; backends: Array<"claude" | "codex"> }>();
      for (const root of roots) {
        if (!(await pathExists(root.dir))) continue;
        const entries = await readdir(root.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillMdPath = join(root.dir, entry.name, "SKILL.md");
          if (!(await pathExists(skillMdPath))) continue;
          const content = await readFile(skillMdPath, "utf-8");
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
          let name = entry.name;
          let description = "";
          if (fmMatch) {
            for (const line of fmMatch[1].split("\n")) {
              const nameMatch = line.match(/^name:\s*(.+)/);
              if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
              const descMatch = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
              if (descMatch) description = descMatch[1];
            }
          }

          const existing = bySlug.get(entry.name);
          if (!existing) {
            bySlug.set(entry.name, {
              slug: entry.name,
              name,
              description,
              path: skillMdPath,
              backends: [root.backend],
            });
          } else if (!existing.backends.includes(root.backend)) {
            existing.backends.push(root.backend);
          }
        }
      }
      return c.json(Array.from(bySlug.values()));
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  api.get("/skills/:slug", async (c) => {
    const backend = parseSkillBackend(c.req.query("backend"));
    if (!backend) return c.json({ error: "Invalid backend. Use claude, codex, or both." }, 400);

    const slug = c.req.param("slug");
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const roots = getSkillRoots(backend);
    for (const root of roots) {
      const skillMdPath = join(root.dir, slug, "SKILL.md");
      if (!(await pathExists(skillMdPath))) continue;
      const content = await readFile(skillMdPath, "utf-8");
      return c.json({ slug, path: skillMdPath, content, backend: root.backend });
    }
    return c.json({ error: "Skill not found" }, 404);
  });

  api.post("/skills", async (c) => {
    const backend = parseSkillBackend(c.req.query("backend"));
    if (!backend) return c.json({ error: "Invalid backend. Use claude, codex, or both." }, 400);

    const body = await c.req.json().catch(() => ({}));
    const { name, description, content } = body;
    if (!name || typeof name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    // Slugify: lowercase, replace non-alphanumeric with dashes
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) return c.json({ error: "Invalid name" }, 400);

    const roots = getSkillRoots(backend);
    for (const root of roots) {
      const skillMdPath = join(root.dir, slug, "SKILL.md");
      if (await pathExists(skillMdPath)) {
        return c.json({ error: `Skill "${slug}" already exists in ${root.backend}` }, 409);
      }
    }

    const md = `---\nname: ${slug}\ndescription: ${JSON.stringify(description || `Skill: ${name}`)}\n---\n\n${content || `# ${name}\n\nDescribe what this skill does and how to use it.\n`}`;
    const paths: Record<string, string> = {};
    for (const root of roots) {
      const skillDir = join(root.dir, slug);
      const skillMdPath = join(skillDir, "SKILL.md");
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillMdPath, md);
      paths[root.backend] = skillMdPath;
    }

    return c.json({ slug, name, description: description || `Skill: ${name}`, backends: roots.map((r) => r.backend), paths });
  });

  api.put("/skills/:slug", async (c) => {
    const backend = parseSkillBackend(c.req.query("backend"));
    if (!backend) return c.json({ error: "Invalid backend. Use claude, codex, or both." }, 400);

    const slug = c.req.param("slug");
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }
    const updatedPaths: Record<string, string> = {};
    for (const root of getSkillRoots(backend)) {
      const skillMdPath = join(root.dir, slug, "SKILL.md");
      if (!(await pathExists(skillMdPath))) continue;
      await writeFile(skillMdPath, body.content);
      updatedPaths[root.backend] = skillMdPath;
    }
    if (Object.keys(updatedPaths).length === 0) return c.json({ error: "Skill not found" }, 404);
    return c.json({ ok: true, slug, backends: Object.keys(updatedPaths), paths: updatedPaths });
  });

  api.delete("/skills/:slug", async (c) => {
    const backend = parseSkillBackend(c.req.query("backend"));
    if (!backend) return c.json({ error: "Invalid backend. Use claude, codex, or both." }, 400);

    const slug = c.req.param("slug");
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
      return c.json({ error: "Invalid slug" }, 400);
    }
    const removed: Array<"claude" | "codex"> = [];
    for (const root of getSkillRoots(backend)) {
      const skillDir = join(root.dir, slug);
      if (!(await pathExists(skillDir))) continue;
      await rm(skillDir, { recursive: true, force: true });
      removed.push(root.backend);
    }
    if (removed.length === 0) return c.json({ error: "Skill not found" }, 404);
    return c.json({ ok: true, slug, backends: removed });
  });

  // ─── Cron Jobs ──────────────────────────────────────────────────────

  api.get("/cron/jobs", async (c) => {
    const jobs = await cronStore.listJobs();
    const enriched = jobs.map((j) => ({
      ...j,
      nextRunAt: cronScheduler?.getNextRunTime(j.id)?.getTime() ?? null,
    }));
    return c.json(enriched);
  });

  api.get("/cron/jobs/:id", async (c) => {
    const job = await cronStore.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json({
      ...job,
      nextRunAt: cronScheduler?.getNextRunTime(job.id)?.getTime() ?? null,
    });
  });

  api.post("/cron/jobs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const job = await cronStore.createJob({
        name: body.name || "",
        prompt: body.prompt || "",
        schedule: body.schedule || "",
        recurring: body.recurring ?? true,
        backendType: body.backendType || "claude",
        model: body.model || "",
        cwd: body.cwd || "",
        envSlug: body.envSlug,
        enabled: body.enabled ?? true,
        permissionMode: body.permissionMode || "bypassPermissions",
        codexInternetAccess: body.codexInternetAccess,
        codexReasoningEffort: typeof body.codexReasoningEffort === "string"
          ? (body.codexReasoningEffort.trim() || undefined)
          : undefined,
      });
      if (job.enabled) cronScheduler?.scheduleJob(job);
      return c.json(job, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/cron/jobs/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      // Only allow user-editable fields — prevent tampering with internal tracking
      const allowed: Record<string, unknown> = {};
      for (const key of ["name", "prompt", "schedule", "recurring", "backendType", "model", "cwd", "envSlug", "enabled", "permissionMode", "codexInternetAccess", "codexReasoningEffort"] as const) {
        if (key in body) allowed[key] = body[key];
      }
      if (typeof allowed.codexReasoningEffort === "string") {
        allowed.codexReasoningEffort = allowed.codexReasoningEffort.trim() || undefined;
      }
      const job = await cronStore.updateJob(id, allowed);
      if (!job) return c.json({ error: "Job not found" }, 404);
      // Stop the old timer (id may differ from job.id after a rename)
      if (job.id !== id) cronScheduler?.stopJob(id);
      cronScheduler?.scheduleJob(job);
      return c.json(job);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/cron/jobs/:id", async (c) => {
    const id = c.req.param("id");
    cronScheduler?.stopJob(id);
    const deleted = await cronStore.deleteJob(id);
    if (!deleted) return c.json({ error: "Job not found" }, 404);
    return c.json({ ok: true });
  });

  api.post("/cron/jobs/:id/toggle", async (c) => {
    const id = c.req.param("id");
    const job = await cronStore.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    const updated = await cronStore.updateJob(id, { enabled: !job.enabled });
    if (updated?.enabled) {
      cronScheduler?.scheduleJob(updated);
    } else {
      cronScheduler?.stopJob(id);
    }
    return c.json(updated);
  });

  api.post("/cron/jobs/:id/run", async (c) => {
    const id = c.req.param("id");
    const job = await cronStore.getJob(id);
    if (!job) return c.json({ error: "Job not found" }, 404);
    cronScheduler?.executeJobManually(id);
    return c.json({ ok: true, message: "Job triggered" });
  });

  api.get("/cron/jobs/:id/executions", (c) => {
    const id = c.req.param("id");
    return c.json(cronScheduler?.getExecutions(id) ?? []);
  });

  // ─── Transcription Debug Logs ────────────────────────────────────

  api.get("/transcription-logs", (c) => {
    return c.json(getTranscriptionLogIndex());
  });

  api.get("/transcription-logs/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const entry = getTranscriptionLogEntry(id);
    if (!entry) return c.json({ error: "Not found" }, 404);
    return c.json(entry);
  });

  // ─── Session Namer Debug Logs ─────────────────────────────────────

  api.get("/namer-logs", (c) => {
    return c.json(getNamerLogIndex());
  });

  api.get("/namer-logs/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const entry = getNamerLogEntry(id);
    if (!entry) return c.json({ error: "Not found" }, 404);
    return c.json(entry);
  });

  // ─── Auto-Approval Configs ──────────────────────────────────────

  api.get("/auto-approval/configs", async (c) => {
    try {
      return c.json(await autoApprovalStore.listConfigs());
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  /** Find the matching auto-approval config for a given cwd (longest prefix match).
   *  Optional `repo_root` param for worktree sessions whose cwd differs from the main repo. */
  api.get("/auto-approval/configs/match", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "Missing cwd query parameter" }, 400);
    const repoRoot = c.req.query("repo_root");
    const extraPaths = repoRoot ? [repoRoot] : undefined;
    const config = await autoApprovalStore.getConfigForPath(cwd, extraPaths);
    return c.json({ config });
  });

  api.get("/auto-approval/configs/:slug", async (c) => {
    const config = await autoApprovalStore.getConfig(c.req.param("slug"));
    if (!config) return c.json({ error: "Config not found" }, 404);
    return c.json(config);
  });

  api.post("/auto-approval/configs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const config = await autoApprovalStore.createConfig(
        body.projectPath,
        body.label,
        body.criteria,
        body.enabled,
        body.projectPaths,
      );
      return c.json(config, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/auto-approval/configs/:slug", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));
    try {
      const config = await autoApprovalStore.updateConfig(slug, {
        label: body.label,
        criteria: body.criteria,
        enabled: body.enabled,
        projectPaths: body.projectPaths,
      });
      if (!config) return c.json({ error: "Config not found" }, 404);
      return c.json(config);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/auto-approval/configs/:slug", async (c) => {
    const deleted = await autoApprovalStore.deleteConfig(c.req.param("slug"));
    if (!deleted) return c.json({ error: "Config not found" }, 404);
    return c.json({ ok: true });
  });

  // ─── Auto-Approval Logs ───────────────────────────────────────

  api.get("/auto-approval/logs", (c) => {
    return c.json(getApprovalLogIndex());
  });

  api.get("/auto-approval/logs/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
    const entry = getApprovalLogEntry(id);
    if (!entry) return c.json({ error: "Not found" }, 404);
    return c.json(entry);
  });

  // ─── Session Export/Import ───────────────────────────────────────

  api.get("/migration/export", async (c) => {
    const tempPath = join(tmpdir(), `companion-export-${Date.now()}.tar.zst`);
    try {
      // Flush debounced session writes so the archive includes latest messages
      await sessionStore.flushAll();
      await runExport({ port: launcher.getPort(), outputPath: tempPath });
      // Read into memory before responding — unlink in finally would race
      // with a lazy stream and produce a 0-byte download.
      const buf = await readFile(tempPath);
      const timestamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
      c.header("Content-Type", "application/zstd");
      c.header("Content-Disposition", `attachment; filename="companion-export-${timestamp}.tar.zst"`);
      c.header("Content-Length", String(buf.byteLength));
      return c.body(buf);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    } finally {
      try {
        await unlink(tempPath);
      } catch {
        /* ignore */
      }
    }
  });

  api.post("/migration/import", async (c) => {
    // Parse the upload first (blocking), then stream progress as NDJSON
    const body = await c.req.parseBody();
    const file = body["archive"];
    if (!file || typeof file === "string") {
      return c.json({ error: "archive field is required (multipart)" }, 400);
    }
    const buf = Buffer.from(await file.arrayBuffer());
    const tempPath = join(tmpdir(), `companion-import-${Date.now()}.tar.zst`);
    await writeFile(tempPath, buf);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let streamClosed = false;
    const sendLine = (data: Record<string, unknown>) => {
      if (streamClosed) return;
      // writer.write() returns a Promise — swallow rejections (client disconnected)
      writer.write(encoder.encode(JSON.stringify(data) + "\n")).catch(() => {
        streamClosed = true;
      });
    };

    // Run import asynchronously, streaming progress lines
    (async () => {
      try {
        const stats = await runImport(tempPath, launcher.getPort(), (step, message, pct) => {
          sendLine({ step, message, pct });
        });
        // Load brand-new sessions into memory, merge updated fields
        // (cliSessionId, rewritten paths) into existing sessions
        await launcher.restoreFromDisk();
        await launcher.mergeFromDisk();
        await wsBridge.restoreFromDisk();
        sendLine({ step: "done", result: stats });
      } catch (e) {
        sendLine({ step: "error", error: e instanceof Error ? e.message : String(e) });
      } finally {
        try {
          await unlink(tempPath);
        } catch {
          /* ignore */
        }
        // writer.close() returns a Promise — swallow if stream already closed
        writer.close().catch(() => {});
      }
    })();

    return new Response(readable, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  });

  return api;

  return api;
}
