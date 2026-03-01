import { Hono, type Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { execSync, exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { resolveBinary, expandTilde } from "./path-resolver.js";
import { readdir, readFile, writeFile, stat, access as accessAsync } from "node:fs/promises";
import { resolve, join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { CliLauncher } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { SessionStore } from "./session-store.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { TerminalManager } from "./terminal-manager.js";
import * as envManager from "./env-manager.js";
import * as questStore from "./quest-store.js";
import * as cronStore from "./cron-store.js";
import * as gitUtils from "./git-utils.js";
import * as sessionNames from "./session-names.js";
import { getNamerLogIndex, getNamerLogEntry } from "./session-namer.js";
import * as autoApprovalStore from "./auto-approval-store.js";
import { getApprovalLogIndex, getApprovalLogEntry } from "./auto-approver.js";
import { recreateWorktreeIfMissing, runExport, runImport, type ImportStats } from "./migration.js";
import { containerManager, ContainerManager, type ContainerConfig, type ContainerInfo } from "./container-manager.js";
import type { CreationStepId } from "./session-types.js";
import { hasContainerClaudeAuth } from "./claude-container-auth.js";
import { hasContainerCodexAuth } from "./codex-container-auth.js";
import { getSettings, updateSettings, getServerName, setServerName, getServerId, type NamerConfig } from "./settings-manager.js";
import { getLogPath } from "./server-logger.js";
import { getUsageLimits } from "./usage-limits.js";
import { buildPeekResponse, buildPeekDefault, buildPeekRange, buildReadResponse } from "./takode-messages.js";
import { ensureAssistantWorkspace, ASSISTANT_DIR } from "./assistant-workspace.js";
import { generateUniqueSessionName } from "../src/utils/names.js";
import { transcribeWithGemini, transcribeWithOpenai, getAvailableBackends } from "./transcription.js";
import { getLegacyCodexHome } from "./codex-home.js";
import type { PerfTracer } from "./perf-tracer.js";
import { GIT_CMD_TIMEOUT } from "./constants.js";

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = dirname(ROUTES_DIR);

function execCaptureStdout(
  command: string,
  options: { cwd: string; encoding: "utf-8"; timeout: number },
): string {
  try {
    return execSync(command, options); // sync-ok: route handler, not called during message handling
  } catch (err: unknown) {
    const maybe = err as { stdout?: Buffer | string };
    if (typeof maybe.stdout === "string") return maybe.stdout;
    if (maybe.stdout && Buffer.isBuffer(maybe.stdout)) {
      return maybe.stdout.toString("utf-8");
    }
    throw err;
  }
}

const execPromise = promisify(execCb);

/** Non-blocking exec — runs a shell command without stalling the event loop. */
async function execAsync(command: string, cwd: string): Promise<string> {
  const { stdout } = await execPromise(command, { cwd, timeout: GIT_CMD_TIMEOUT });
  return stdout.trim();
}

/** Non-blocking version of execCaptureStdout — always returns stdout even on non-zero exit. */
async function execCaptureStdoutAsync(command: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execPromise(command, { cwd, timeout: GIT_CMD_TIMEOUT });
    return stdout.trim();
  } catch (err: unknown) {
    const maybe = err as { stdout?: string };
    if (typeof maybe.stdout === "string") return maybe.stdout.trim();
    throw err;
  }
}

export function createRoutes(
  launcher: CliLauncher,
  wsBridge: WsBridge,
  sessionStore: SessionStore,
  worktreeTracker: WorktreeTracker,
  terminalManager: TerminalManager,
  prPoller?: import("./pr-poller.js").PRPoller,
  recorder?: import("./recorder.js").RecorderManager,
  cronScheduler?: import("./cron-scheduler.js").CronScheduler,
  imageStore?: import("./image-store.js").ImageStore,
  pushoverNotifier?: import("./pushover.js").PushoverNotifier,
  options?: { requestRestart?: () => void },
  perfTracer?: PerfTracer,
) {
  const api = new Hono();

  /** Resolve a session ID from an integer, UUID, or UUID prefix. */
  const resolveId = (raw: string): string | null => launcher.resolveSessionId(raw);
  const TAKODE_SESSION_ID_HEADER = "x-companion-session-id";
  const TAKODE_AUTH_TOKEN_HEADER = "x-companion-auth-token";

  type TakodeCaller = { callerId: string; caller: NonNullable<ReturnType<CliLauncher["getSession"]>> };

  const authenticateTakodeCaller = (
    c: Context,
    options?: { requireOrchestrator?: boolean },
  ): TakodeCaller | { response: Response } => {
    const rawCallerId = c.req.header(TAKODE_SESSION_ID_HEADER)?.trim();
    const authToken = c.req.header(TAKODE_AUTH_TOKEN_HEADER)?.trim();
    if (!rawCallerId || !authToken) {
      return { response: c.json({ error: "Missing Takode auth headers" }, 403) };
    }

    const callerId = resolveId(rawCallerId);
    if (!callerId) {
      return { response: c.json({ error: "Caller session not found" }, 403) };
    }
    const caller = launcher.getSession(callerId);
    if (!caller) {
      return { response: c.json({ error: "Caller session not found" }, 403) };
    }
    if (!launcher.verifySessionAuthToken(callerId, authToken)) {
      return { response: c.json({ error: "Invalid Takode auth token" }, 403) };
    }
    if (options?.requireOrchestrator && !caller.isOrchestrator) {
      return { response: c.json({ error: "Caller is not an orchestrator session" }, 403) };
    }
    return { callerId, caller };
  };

  // Performance tracing middleware — records slow API requests
  if (perfTracer) {
    api.use("/*", async (c, next) => {
      const start = performance.now();
      await next();
      const ms = performance.now() - start;
      if (ms > perfTracer.httpSlowThresholdMs) {
        perfTracer.recordSlowRequest(c.req.method, c.req.path, ms);
      }
    });
  }

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

  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const backend = body.backend ?? "claude";
      if (backend !== "claude" && backend !== "codex" && backend !== "claude-sdk") {
        return c.json({ error: `Invalid backend: ${String(backend)}` }, 400);
      }

      // ── Resume fast-path: skip git/worktree/container logic ──
      if (body.resumeCliSessionId) {
        if (backend !== "claude") {
          return c.json({ error: "Resuming CLI sessions is only supported for Claude backend" }, 400);
        }
        let envVars: Record<string, string> | undefined = body.env;
        if (body.envSlug) {
          const companionEnv = await envManager.getEnv(body.envSlug);
          if (companionEnv) envVars = { ...companionEnv.variables, ...body.env };
        }
        // Inject COMPANION_PORT so resumed sessions can call the local API.
        envVars = { ...envVars, COMPANION_PORT: String(launcher.getPort()) };
        // Add orchestrator env vars if role is specified
        if (body.role === "orchestrator") {
          envVars.TAKODE_ROLE = "orchestrator";
          envVars.TAKODE_API_PORT = String(launcher.getPort());
        }
        const binarySettings = getSettings();
        const session = await launcher.launch({
          cwd: body.cwd ? resolve(expandTilde(body.cwd)) : process.cwd(),
          claudeBinary: body.claudeBinary || binarySettings.claudeBinary || undefined,
          env: envVars,
          backendType: "claude",
          resumeCliSessionId: body.resumeCliSessionId,
          permissionMode: body.askPermission !== false ? "plan" : "bypassPermissions",
        });
        if (body.role === "orchestrator") {
          session.isOrchestrator = true;
        }
        if (body.envSlug) session.envSlug = body.envSlug;
        wsBridge.setInitialAskPermission(session.sessionId, body.askPermission !== false);
        wsBridge.markResumedFromExternal(session.sessionId);
        const existingNames = new Set(Object.values(sessionNames.getAllNames()));
        sessionNames.setName(session.sessionId, generateUniqueSessionName(existingNames));
        // Auto-herd: if creator is an orchestrator, herd the new session
        if (body.createdBy) {
          const creatorId = resolveId(String(body.createdBy));
          const creator = creatorId ? launcher.getSession(creatorId) : null;
          if (creator?.isOrchestrator) {
            launcher.herdSessions(creator.sessionId, [session.sessionId]);
          }
        }
        return c.json(session);
      }

      // Resolve environment variables from envSlug
      let envVars: Record<string, string> | undefined = body.env;
      if (body.envSlug) {
        const companionEnv = await envManager.getEnv(body.envSlug);
        if (companionEnv) {
          console.log(
            `[routes] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
            Object.keys(companionEnv.variables).join(", "),
          );
          envVars = { ...companionEnv.variables, ...body.env };
        } else {
          console.warn(
            `[routes] Environment "${body.envSlug}" not found, ignoring`,
          );
        }
      }

      let cwd = body.cwd;
      const isAssistantMode = body.assistantMode === true;
      let worktreeInfo: { isWorktree: boolean; repoRoot: string; branch: string; actualBranch: string; worktreePath: string; defaultBranch: string } | undefined;

      // Expand tilde and validate cwd before any downstream use
      if (cwd) {
        cwd = resolve(expandTilde(cwd));
        if (!existsSync(cwd)) { // sync-ok: route handler, not called during message handling
          return c.json({ error: `Directory does not exist: ${cwd}` }, 400);
        }
      }

      // Inject COMPANION_PORT so agents in any session can call the REST API
      envVars = { ...envVars, COMPANION_PORT: String(launcher.getPort()) };
      // Add orchestrator env vars if role is specified
      if (body.role === "orchestrator") {
        envVars.TAKODE_ROLE = "orchestrator";
        envVars.TAKODE_API_PORT = String(launcher.getPort());
      }

      // Assistant mode: override cwd and ensure workspace exists
      if (isAssistantMode) {
        ensureAssistantWorkspace();
        cwd = ASSISTANT_DIR;
      }

      // Validate branch name to prevent command injection via shell metacharacters
      if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch)) {
        return c.json({ error: "Invalid branch name" }, 400);
      }

      if (body.useWorktree) {
        if (!cwd) {
          return c.json({ error: "Worktree mode requires a cwd" }, 400);
        }
        // Worktree isolation: create/reuse a worktree for the selected branch.
        // If the UI hasn't loaded branch metadata yet, fall back to current branch.
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (!repoInfo) {
          return c.json({ error: "Worktree mode requires a git repository" }, 400);
        }
        const targetBranch = body.branch || repoInfo.currentBranch;
        if (!targetBranch) {
          return c.json({ error: "Unable to determine branch for worktree session" }, 400);
        }
        const result = gitUtils.ensureWorktree(repoInfo.repoRoot, targetBranch, {
          baseBranch: repoInfo.defaultBranch,
          createBranch: body.createBranch,
          forceNew: true,
        });
        cwd = result.worktreePath;
        worktreeInfo = {
          isWorktree: true,
          repoRoot: repoInfo.repoRoot,
          branch: targetBranch,
          actualBranch: result.actualBranch,
          worktreePath: result.worktreePath,
          defaultBranch: repoInfo.defaultBranch,
        };
      } else if (body.branch && cwd) {
        // Non-worktree: checkout the selected branch in-place (lightweight)
        const repoInfo = gitUtils.getRepoInfo(cwd);
        if (repoInfo) {
          const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
          if (!fetchResult.success) {
            console.warn(`[routes] git fetch warning (non-fatal): ${fetchResult.output}`);
          }

          if (repoInfo.currentBranch !== body.branch) {
            gitUtils.checkoutBranch(repoInfo.repoRoot, body.branch);
          }

          const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
          if (!pullResult.success) {
            console.warn(`[routes] git pull warning (non-fatal): ${pullResult.output}`);
          }
        }
      }

      // Resolve Docker image from environment or explicit container config
      const companionEnv = body.envSlug ? await envManager.getEnv(body.envSlug) : null;
      let effectiveImage = companionEnv
        ? (body.envSlug ? await envManager.getEffectiveImage(body.envSlug) : null)
        : (body.container?.image || null);

      let containerInfo: ContainerInfo | undefined;
      let containerId: string | undefined;
      let containerName: string | undefined;
      let containerImage: string | undefined;

      // Containers cannot use host keychain auth.
      // Fail fast with a clear error when no container-compatible auth is present.
      if (effectiveImage && backend === "claude" && !hasContainerClaudeAuth(envVars)) {
        return c.json({
          error:
            "Containerized Claude requires auth available inside the container. " +
            "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_AUTH_TOKEN) in the selected environment.",
        }, 400);
      }
      if (effectiveImage && backend === "codex" && !hasContainerCodexAuth(envVars)) {
        return c.json({
          error:
            "Containerized Codex requires auth available inside the container. " +
            "Set OPENAI_API_KEY in the selected environment, or ensure ~/.codex/auth.json exists on the host.",
        }, 400);
      }

      // Create container if a Docker image is available.
      // Do not silently fall back to host execution: if container startup fails,
      // return an explicit error.
      if (effectiveImage) {
        if (!containerManager.imageExists(effectiveImage)) {
          // Auto-build for default images (the-companion or legacy companion-dev)
          const isDefaultImage = effectiveImage === "the-companion:latest" || effectiveImage === "companion-dev:latest";
          if (isDefaultImage) {
            // Try fallback: if the-companion requested but companion-dev exists, use it
            if (effectiveImage === "the-companion:latest" && containerManager.imageExists("companion-dev:latest")) {
              console.warn("[routes] the-companion:latest not found, falling back to companion-dev:latest (deprecated)");
              effectiveImage = "companion-dev:latest";
            } else {
              // Try pulling from Docker Hub first, fall back to local build
              const registryImage = ContainerManager.getRegistryImage(effectiveImage);
              let pulled = false;
              if (registryImage) {
                console.log(`[routes] ${effectiveImage} missing locally, trying docker pull ${registryImage}...`);
                pulled = await containerManager.pullImage(registryImage, effectiveImage);
              }

              if (!pulled) {
                // Fall back to local Dockerfile build
                const dockerfileName = effectiveImage === "the-companion:latest"
                  ? "Dockerfile.the-companion"
                  : "Dockerfile.companion-dev";
                const dockerfilePath = join(WEB_DIR, "docker", dockerfileName);
                if (!existsSync(dockerfilePath)) { // sync-ok: route handler, not called during message handling
                  return c.json({
                    error:
                      `Docker image ${effectiveImage} is missing, pull failed, and Dockerfile not found at ${dockerfilePath}`,
                  }, 503);
                }
                try {
                  console.log(`[routes] Pull failed/unavailable, building ${effectiveImage} from Dockerfile...`);
                  containerManager.buildImage(dockerfilePath, effectiveImage);
                } catch (err) {
                  const reason = err instanceof Error ? err.message : String(err);
                  return c.json({
                    error:
                      `Docker image ${effectiveImage} is missing: pull and build both failed: ${reason}`,
                  }, 503);
                }
              }
            }
          } else {
            return c.json({
              error:
                `Docker image not found locally: ${effectiveImage}. ` +
                "Build/pull the image first, then retry.",
            }, 503);
          }
        }

        const tempId = crypto.randomUUID().slice(0, 8);
        const cConfig: ContainerConfig = {
          image: effectiveImage,
          ports: companionEnv?.ports
            ?? (Array.isArray(body.container?.ports)
              ? body.container.ports.map(Number).filter((n: number) => n > 0)
              : []),
          volumes: companionEnv?.volumes ?? body.container?.volumes,
          env: envVars,
        };
        try {
          containerInfo = containerManager.createContainer(tempId, cwd, cConfig);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return c.json({
            error:
              `Docker is required to run this environment image (${effectiveImage}) ` +
              `but container startup failed: ${reason}`,
          }, 503);
        }
        containerId = containerInfo.containerId;
        containerName = containerInfo.name;
        containerImage = effectiveImage;

        // Copy workspace files into the container's isolated volume
        try {
          await containerManager.copyWorkspaceToContainer(containerInfo.containerId, cwd);
          containerManager.reseedGitAuth(containerInfo.containerId);
        } catch (err) {
          containerManager.removeContainer(tempId);
          const reason = err instanceof Error ? err.message : String(err);
          return c.json({
            error: `Failed to copy workspace to container: ${reason}`,
          }, 503);
        }

        // Run per-environment init script if configured
        if (companionEnv?.initScript?.trim()) {
          try {
            console.log(`[routes] Running init script for env "${companionEnv.name}" in container ${containerInfo.name}...`);
            const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
            const result = await containerManager.execInContainerAsync(
              containerInfo.containerId,
              ["sh", "-lc", companionEnv.initScript],
              { timeout: initTimeout },
            );
            if (result.exitCode !== 0) {
              console.error(
                `[routes] Init script failed for env "${companionEnv.name}" (exit ${result.exitCode}):\n${result.output}`,
              );
              containerManager.removeContainer(tempId);
              const truncated = result.output.length > 2000
                ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
                : result.output;
              return c.json({
                error: `Init script failed (exit ${result.exitCode}):\n${truncated}`,
              }, 503);
            }
            console.log(`[routes] Init script completed successfully for env "${companionEnv.name}"`);
          } catch (e) {
            containerManager.removeContainer(tempId);
            const reason = e instanceof Error ? e.message : String(e);
            return c.json({
              error: `Init script execution failed: ${reason}`,
            }, 503);
          }
        }
      }

      // Resolve initial permission mode from askPermission for Claude sessions.
      // For Codex, default to gpt-5.3-codex if no model provided (Codex requires explicit model).
      // For Claude, undefined is fine — the CLI uses its own configured default.
      const askPermission = body.askPermission !== false;
      const initialPermissionMode = backend === "codex"
        ? (body.permissionMode || "suggest")
        : (askPermission ? "plan" : "bypassPermissions");
      const model = body.model || (backend === "codex" ? "gpt-5.3-codex" : undefined);
      const codexReasoningEffort = backend === "codex" && typeof body.codexReasoningEffort === "string"
        ? (body.codexReasoningEffort.trim() || undefined)
        : undefined;
      // Inject orchestrator guardrails into .claude/CLAUDE.md before launch
      if (body.role === "orchestrator" && cwd) {
        await launcher.injectOrchestratorGuardrails(cwd, launcher.getPort());
      }

      const binarySettings = getSettings();
      const session = await launcher.launch({
        model,
        permissionMode: initialPermissionMode,
        cwd,
        claudeBinary: body.claudeBinary || binarySettings.claudeBinary || undefined,
        codexBinary: body.codexBinary || binarySettings.codexBinary || undefined,
        codexInternetAccess: backend === "codex" && body.codexInternetAccess === true,
        codexSandbox: backend === "codex" && body.codexInternetAccess === true
          ? "danger-full-access"
          : "workspace-write",
        codexReasoningEffort,
        allowedTools: body.allowedTools,
        env: envVars,
        backendType: backend,
        containerId,
        containerName,
        containerImage,
        worktreeInfo,
      });

      // Re-track container with real session ID and mark session as containerized
      // so the bridge preserves the host cwd for sidebar grouping
      if (containerInfo) {
        containerManager.retrack(containerInfo.containerId, session.sessionId);
        wsBridge.markContainerized(session.sessionId, cwd);
      }

      // Track the worktree mapping and pre-populate session state
      // so the browser gets correct sidebar grouping immediately
      if (worktreeInfo) {
        wsBridge.markWorktree(session.sessionId, worktreeInfo.repoRoot, cwd, worktreeInfo.defaultBranch, worktreeInfo.branch);
        worktreeTracker.addMapping({
          sessionId: session.sessionId,
          repoRoot: worktreeInfo.repoRoot,
          branch: worktreeInfo.branch,
          actualBranch: worktreeInfo.actualBranch,
          worktreePath: worktreeInfo.worktreePath,
          createdAt: Date.now(),
        });
      }

      // Set initial askPermission state on the session for Claude backends
      if (backend !== "codex") {
        wsBridge.setInitialAskPermission(session.sessionId, askPermission);
      }

      // Mark as assistant session if in assistant mode
      if (isAssistantMode) {
        session.isAssistant = true;
      }

      // Mark as orchestrator session if role is specified
      if (body.role === "orchestrator") {
        session.isOrchestrator = true;
        // Fire-and-forget: wait for CLI to connect, then send identity message
        (async () => {
          const maxWait = 30_000;
          const pollMs = 200;
          const start = Date.now();
          while (Date.now() - start < maxWait) {
            const info = launcher.getSession(session.sessionId);
            if (info && (info.state === "connected" || info.state === "running")) {
              wsBridge.injectUserMessage(session.sessionId,
                `[System] You are a leader agent. Your job is to coordinate worker sessions in your herd.\n\n` +
                `Your user messages are tagged by source: [User] = human operator, [Herd] = automatic event from herded workers, [Agent] = message from another agent.\n\n` +
                `Events from herded workers arrive automatically — you do NOT need to poll or call \`watch\`. When workers finish turns, need permissions, or hit errors, you'll receive a [Herd] message with a compact summary. React to these events by peeking at workers (\`takode peek\`) and sending follow-up instructions (\`takode send\`).\n\n` +
                `**Task queuing:** Workers should only focus on one task at a time. Never send an unrelated new task to a busy worker. Queue new tasks in your own todo list and wait for the worker's turn_end event. Only send the next task after the worker finishes and goes idle. It IS okay to send mid-work messages that steer the current task (refining scope, correcting mistakes) or urgent interventions.\n\n` +
                `Use \`takode herd <ids>\` to add sessions to your herd, \`takode unherd <id>\` to release them.\n\n` +
                `Start by running \`takode list --active\` to discover all sessions, then \`takode herd <ids>\` to claim your workers. After herding, \`takode list\` shows only your flock.\n\n` +
                `Read your project CLAUDE.md for full documentation of the takode CLI and orchestration workflow.`
              );
              return;
            }
            if (info?.state === "exited") return; // CLI crashed, don't inject
            await new Promise(r => setTimeout(r, pollMs));
          }
        })().catch(e => console.error(`[routes] Failed to inject orchestrator message:`, e));
      }

      if (body.envSlug) session.envSlug = body.envSlug;

      // Generate a session name so all creation paths (browser, CLI, API) get names
      if (isAssistantMode) {
        sessionNames.setName(session.sessionId, "Takode");
      } else {
        const existingNames = new Set(Object.values(sessionNames.getAllNames()));
        const generatedName = generateUniqueSessionName(existingNames);
        sessionNames.setName(session.sessionId, generatedName);
      }

      // Auto-herd: if creator is an orchestrator, herd the new session
      if (body.createdBy) {
        const creatorId = resolveId(String(body.createdBy));
        const creator = creatorId ? launcher.getSession(creatorId) : null;
        if (creator?.isOrchestrator) {
          launcher.herdSessions(creator.sessionId, [session.sessionId]);
        }
      }

      return c.json(session);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to create session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  // ─── SSE Session Creation (with progress streaming) ─────────────────────

  api.post("/sessions/create-stream", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    const emitProgress = (
      stream: SSEStreamingApi,
      step: CreationStepId,
      label: string,
      status: "in_progress" | "done" | "error",
      detail?: string,
    ) =>
      stream.writeSSE({
        event: "progress",
        data: JSON.stringify({ step, label, status, detail }),
      });

    return streamSSE(c, async (stream) => {
      try {
        const backend = body.backend ?? "claude";
        if (backend !== "claude" && backend !== "codex" && backend !== "claude-sdk") {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: `Invalid backend: ${String(backend)}` }),
          });
          return;
        }

        // ── Resume fast-path: skip git/worktree/container logic ──
        if (body.resumeCliSessionId) {
          if (backend !== "claude") {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ error: "Resuming CLI sessions is only supported for Claude backend" }),
            });
            return;
          }
          await emitProgress(stream, "resolving_env", "Resolving environment...", "in_progress");
          let envVars: Record<string, string> | undefined = body.env;
          if (body.envSlug) {
            const companionEnv = await envManager.getEnv(body.envSlug);
            if (companionEnv) envVars = { ...companionEnv.variables, ...body.env };
          }
          // Inject COMPANION_PORT so resumed sessions can call the local API.
          envVars = { ...envVars, COMPANION_PORT: String(launcher.getPort()) };
          // Add orchestrator env vars if role is specified
          if (body.role === "orchestrator") {
            envVars.TAKODE_ROLE = "orchestrator";
            envVars.TAKODE_API_PORT = String(launcher.getPort());
          }
          await emitProgress(stream, "resolving_env", "Environment resolved", "done");

          await emitProgress(stream, "launching_cli", "Resuming CLI session...", "in_progress");
          const binarySettings = getSettings();
          const session = await launcher.launch({
            cwd: body.cwd ? resolve(expandTilde(body.cwd)) : process.cwd(),
            claudeBinary: body.claudeBinary || binarySettings.claudeBinary || undefined,
            env: envVars,
            backendType: "claude",
            resumeCliSessionId: body.resumeCliSessionId,
            permissionMode: body.askPermission !== false ? "plan" : "bypassPermissions",
          });
          if (body.role === "orchestrator") {
            session.isOrchestrator = true;
          }
          if (body.envSlug) session.envSlug = body.envSlug;
          wsBridge.setInitialCwd(session.sessionId, body.cwd ? resolve(expandTilde(body.cwd)) : process.cwd());
          wsBridge.setInitialAskPermission(session.sessionId, body.askPermission !== false);
          wsBridge.markResumedFromExternal(session.sessionId);
          const existingNames = new Set(Object.values(sessionNames.getAllNames()));
          sessionNames.setName(session.sessionId, generateUniqueSessionName(existingNames));
          await emitProgress(stream, "launching_cli", "Session resumed", "done");

          await stream.writeSSE({
            event: "done",
            data: JSON.stringify({
              sessionId: session.sessionId,
              state: session.state,
              cwd: session.cwd,
            }),
          });
          return;
        }

        // --- Step: Resolve environment ---
        await emitProgress(stream, "resolving_env", "Resolving environment...", "in_progress");

        let envVars: Record<string, string> | undefined = body.env;
        const companionEnv = body.envSlug ? await envManager.getEnv(body.envSlug) : null;
        if (body.envSlug && companionEnv) {
          envVars = { ...companionEnv.variables, ...body.env };
        }

        await emitProgress(stream, "resolving_env", "Environment resolved", "done");

        let cwd = body.cwd;
        const isAssistantMode = body.assistantMode === true;
        let worktreeInfo: { isWorktree: boolean; repoRoot: string; branch: string; actualBranch: string; worktreePath: string; defaultBranch: string } | undefined;

        // Expand tilde and validate cwd before any downstream use
        if (cwd) {
          cwd = resolve(expandTilde(cwd));
          if (!existsSync(cwd)) { // sync-ok: route handler, not called during message handling
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ error: `Directory does not exist: ${cwd}`, step: "resolving_env" }),
            });
            return;
          }
        }

        // Inject COMPANION_PORT so agents in any session can call the REST API
        envVars = { ...envVars, COMPANION_PORT: String(launcher.getPort()) };
        // Add orchestrator env vars if role is specified
        if (body.role === "orchestrator") {
          envVars.TAKODE_ROLE = "orchestrator";
          envVars.TAKODE_API_PORT = String(launcher.getPort());
        }

        // Assistant mode: override cwd and ensure workspace exists
        if (isAssistantMode) {
          ensureAssistantWorkspace();
          cwd = ASSISTANT_DIR;
        }

        // Validate branch name
        if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch)) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: "Invalid branch name", step: "checkout_branch" }),
          });
          return;
        }

        // --- Step: Git operations ---
        if (body.useWorktree) {
          if (!cwd) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ error: "Worktree mode requires a cwd", step: "creating_worktree" }),
            });
            return;
          }
          await emitProgress(stream, "creating_worktree", "Creating worktree...", "in_progress");
          const repoInfo = gitUtils.getRepoInfo(cwd);
          if (!repoInfo) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ error: "Worktree mode requires a git repository", step: "creating_worktree" }),
            });
            return;
          }
          // If branch metadata hasn't loaded in the client yet, default to current branch.
          const targetBranch = body.branch || repoInfo.currentBranch;
          if (!targetBranch) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ error: "Unable to determine branch for worktree session", step: "creating_worktree" }),
            });
            return;
          }
          const result = gitUtils.ensureWorktree(repoInfo.repoRoot, targetBranch, {
            baseBranch: repoInfo.defaultBranch,
            createBranch: body.createBranch,
            forceNew: true,
          });
          cwd = result.worktreePath;
          worktreeInfo = {
            isWorktree: true,
            repoRoot: repoInfo.repoRoot,
            branch: targetBranch,
            actualBranch: result.actualBranch,
            worktreePath: result.worktreePath,
            defaultBranch: repoInfo.defaultBranch,
          };
          await emitProgress(stream, "creating_worktree", "Worktree ready", "done");
        } else if (body.branch && cwd) {
          const repoInfo = gitUtils.getRepoInfo(cwd);
          if (repoInfo) {
            await emitProgress(stream, "fetching_git", "Fetching from remote...", "in_progress");
            const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
            if (!fetchResult.success) {
              console.warn(`[routes] git fetch warning (non-fatal): ${fetchResult.output}`);
              await emitProgress(stream, "fetching_git", "Fetch skipped (offline or auth issue)", "done");
            } else {
              await emitProgress(stream, "fetching_git", "Fetch complete", "done");
            }

            if (repoInfo.currentBranch !== body.branch) {
              await emitProgress(stream, "checkout_branch", `Checking out ${body.branch}...`, "in_progress");
              gitUtils.checkoutBranch(repoInfo.repoRoot, body.branch);
              await emitProgress(stream, "checkout_branch", `On branch ${body.branch}`, "done");
            }

            await emitProgress(stream, "pulling_git", "Pulling latest changes...", "in_progress");
            const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
            if (!pullResult.success) {
              console.warn(`[routes] git pull warning (non-fatal): ${pullResult.output}`);
            }
            await emitProgress(stream, "pulling_git", "Up to date", "done");
          }
        }

        // --- Step: Docker image resolution ---
        let effectiveImage = companionEnv
          ? (body.envSlug ? await envManager.getEffectiveImage(body.envSlug) : null)
          : (body.container?.image || null);

        let containerInfo: ContainerInfo | undefined;
        let containerId: string | undefined;
        let containerName: string | undefined;
        let containerImage: string | undefined;

        // Auth check for containerized sessions
        if (effectiveImage && backend === "claude" && !hasContainerClaudeAuth(envVars)) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              error:
                "Containerized Claude requires auth available inside the container. " +
                "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_AUTH_TOKEN) in the selected environment.",
            }),
          });
          return;
        }
        if (effectiveImage && backend === "codex" && !hasContainerCodexAuth(envVars)) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              error:
                "Containerized Codex requires auth available inside the container. " +
                "Set OPENAI_API_KEY in the selected environment, or ensure ~/.codex/auth.json exists on the host.",
            }),
          });
          return;
        }

        if (effectiveImage) {
          if (!containerManager.imageExists(effectiveImage)) {
            const isDefaultImage = effectiveImage === "the-companion:latest" || effectiveImage === "companion-dev:latest";
            if (isDefaultImage) {
              if (effectiveImage === "the-companion:latest" && containerManager.imageExists("companion-dev:latest")) {
                effectiveImage = "companion-dev:latest";
              } else {
                // Try pulling from Docker Hub first
                const registryImage = ContainerManager.getRegistryImage(effectiveImage);
                let pulled = false;
                if (registryImage) {
                  await emitProgress(stream, "pulling_image", "Pulling Docker image...", "in_progress");
                  pulled = await containerManager.pullImage(registryImage, effectiveImage);
                  if (pulled) {
                    await emitProgress(stream, "pulling_image", "Image pulled", "done");
                  } else {
                    await emitProgress(stream, "pulling_image", "Pull failed, falling back to build", "error");
                  }
                }

                // Fall back to local build if pull failed
                if (!pulled) {
                  const dockerfileName = effectiveImage === "the-companion:latest"
                    ? "Dockerfile.the-companion"
                    : "Dockerfile.companion-dev";
                  const dockerfilePath = join(WEB_DIR, "docker", dockerfileName);
                  if (!existsSync(dockerfilePath)) { // sync-ok: route handler, not called during message handling
                    await stream.writeSSE({
                      event: "error",
                      data: JSON.stringify({
                        error: `Docker image ${effectiveImage} is missing, pull failed, and Dockerfile not found at ${dockerfilePath}`,
                        step: "building_image",
                      }),
                    });
                    return;
                  }
                  try {
                    await emitProgress(stream, "building_image", "Building Docker image (this may take a minute)...", "in_progress");
                    containerManager.buildImage(dockerfilePath, effectiveImage);
                    await emitProgress(stream, "building_image", "Image built", "done");
                  } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    await stream.writeSSE({
                      event: "error",
                      data: JSON.stringify({
                        error: `Docker image build failed: ${reason}`,
                        step: "building_image",
                      }),
                    });
                    return;
                  }
                }
              }
            } else {
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  error: `Docker image not found locally: ${effectiveImage}. Build/pull the image first, then retry.`,
                }),
              });
              return;
            }
          }

          // --- Step: Create container ---
          await emitProgress(stream, "creating_container", "Starting container...", "in_progress");
          const tempId = crypto.randomUUID().slice(0, 8);
          const cConfig: ContainerConfig = {
            image: effectiveImage,
            ports: companionEnv?.ports
              ?? (Array.isArray(body.container?.ports)
                ? body.container.ports.map(Number).filter((n: number) => n > 0)
                : []),
            volumes: companionEnv?.volumes ?? body.container?.volumes,
            env: envVars,
          };
          try {
            containerInfo = containerManager.createContainer(tempId, cwd, cConfig);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                error: `Container startup failed: ${reason}`,
                step: "creating_container",
              }),
            });
            return;
          }
          containerId = containerInfo.containerId;
          containerName = containerInfo.name;
          containerImage = effectiveImage;
          await emitProgress(stream, "creating_container", "Container running", "done");

          // --- Step: Copy workspace into isolated volume ---
          await emitProgress(stream, "copying_workspace", "Copying workspace files...", "in_progress");
          try {
            await containerManager.copyWorkspaceToContainer(containerInfo.containerId, cwd);
            containerManager.reseedGitAuth(containerInfo.containerId);
            await emitProgress(stream, "copying_workspace", "Workspace copied", "done");
          } catch (err) {
            containerManager.removeContainer(tempId);
            const reason = err instanceof Error ? err.message : String(err);
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                error: `Failed to copy workspace: ${reason}`,
                step: "copying_workspace",
              }),
            });
            return;
          }

          // --- Step: Init script ---
          if (companionEnv?.initScript?.trim()) {
            await emitProgress(stream, "running_init_script", "Running init script...", "in_progress");
            try {
              const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
              const result = await containerManager.execInContainerAsync(
                containerInfo.containerId,
                ["sh", "-lc", companionEnv.initScript],
                { timeout: initTimeout },
              );
              if (result.exitCode !== 0) {
                console.error(
                  `[routes] Init script failed for env "${companionEnv.name}" (exit ${result.exitCode}):\n${result.output}`,
                );
                containerManager.removeContainer(tempId);
                const truncated = result.output.length > 2000
                  ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
                  : result.output;
                await stream.writeSSE({
                  event: "error",
                  data: JSON.stringify({
                    error: `Init script failed (exit ${result.exitCode}):\n${truncated}`,
                    step: "running_init_script",
                  }),
                });
                return;
              }
              await emitProgress(stream, "running_init_script", "Init script complete", "done");
            } catch (e) {
              containerManager.removeContainer(tempId);
              const reason = e instanceof Error ? e.message : String(e);
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({
                  error: `Init script execution failed: ${reason}`,
                  step: "running_init_script",
                }),
              });
              return;
            }
          }
        }

        // --- Step: Launch CLI ---
        await emitProgress(stream, "launching_cli", "Launching Claude Code...", "in_progress");

        // Resolve initial permission mode from askPermission for Claude sessions.
        const askPermission = body.askPermission !== false;
        const initialPermissionMode = backend === "codex"
          ? (body.permissionMode || "suggest")
          : (askPermission ? "plan" : "bypassPermissions");
        const model = body.model || (backend === "codex" ? "gpt-5.3-codex" : undefined);
        const codexReasoningEffort = backend === "codex" && typeof body.codexReasoningEffort === "string"
          ? (body.codexReasoningEffort.trim() || undefined)
          : undefined;
        // Inject orchestrator guardrails into .claude/CLAUDE.md before launch
        if (body.role === "orchestrator" && cwd) {
          await launcher.injectOrchestratorGuardrails(cwd, launcher.getPort());
        }

        const streamBinarySettings = getSettings();
        const session = await launcher.launch({
          model,
          permissionMode: initialPermissionMode,
          cwd,
          claudeBinary: body.claudeBinary || streamBinarySettings.claudeBinary || undefined,
          codexBinary: body.codexBinary || streamBinarySettings.codexBinary || undefined,
          codexInternetAccess: backend === "codex" && body.codexInternetAccess === true,
          codexSandbox: backend === "codex" && body.codexInternetAccess === true
            ? "danger-full-access"
            : "workspace-write",
          codexReasoningEffort,
          allowedTools: body.allowedTools,
          env: envVars,
          backendType: backend,
          containerId,
          containerName,
          containerImage,
          worktreeInfo,
        });

        // Re-track container and mark session as containerized
        if (containerInfo) {
          containerManager.retrack(containerInfo.containerId, session.sessionId);
          wsBridge.markContainerized(session.sessionId, cwd);
        }

        // Track worktree mapping and pre-populate session state
        // so the browser gets correct sidebar grouping immediately
        if (worktreeInfo) {
          wsBridge.markWorktree(session.sessionId, worktreeInfo.repoRoot, cwd, worktreeInfo.defaultBranch, worktreeInfo.branch);
          worktreeTracker.addMapping({
            sessionId: session.sessionId,
            repoRoot: worktreeInfo.repoRoot,
            branch: worktreeInfo.branch,
            actualBranch: worktreeInfo.actualBranch,
            worktreePath: worktreeInfo.worktreePath,
            createdAt: Date.now(),
          });
        }

        // Set cwd early so slash command cache lookup works before CLI sends system/init.
        // For worktree/container sessions markWorktree/markContainerized already set cwd,
        // so setInitialCwd only fills it for plain sessions and pre-fills slash commands.
        wsBridge.setInitialCwd(session.sessionId, cwd);

        // Set initial askPermission state on the session for Claude backends
        if (backend !== "codex") {
          wsBridge.setInitialAskPermission(session.sessionId, askPermission);
        }

        // Mark as assistant session if in assistant mode
        if (isAssistantMode) {
          session.isAssistant = true;
        }

        // Mark as orchestrator session if role is specified
        if (body.role === "orchestrator") {
          session.isOrchestrator = true;
          // Fire-and-forget: wait for CLI to connect, then send identity message
          (async () => {
            const maxWait = 30_000;
            const pollMs = 200;
            const start = Date.now();
            while (Date.now() - start < maxWait) {
              const info = launcher.getSession(session.sessionId);
              if (info && (info.state === "connected" || info.state === "running")) {
                wsBridge.injectUserMessage(session.sessionId,
                  `[System] You are a leader agent. Your job is to coordinate worker sessions in your herd.\n\n` +
                  `Your user messages are tagged by source: [User] = human operator, [Herd] = automatic event from herded workers, [Agent] = message from another agent.\n\n` +
                  `Events from herded workers arrive automatically — you do NOT need to poll or call \`watch\`. When workers finish turns, need permissions, or hit errors, you'll receive a [Herd] message with a compact summary. React to these events by peeking at workers (\`takode peek\`) and sending follow-up instructions (\`takode send\`).\n\n` +
                  `Use \`takode herd <ids>\` to add sessions to your herd, \`takode unherd <id>\` to release them.\n\n` +
                `Start by running \`takode list --active\` to discover all sessions, then \`takode herd <ids>\` to claim your workers. After herding, \`takode list\` shows only your flock.\n\n` +
                  `Read your project CLAUDE.md for full documentation of the takode CLI and orchestration workflow.`
                );
                return;
              }
              if (info?.state === "exited") return; // CLI crashed, don't inject
              await new Promise(r => setTimeout(r, pollMs));
            }
          })().catch(e => console.error(`[routes] Failed to inject orchestrator message:`, e));
        }

        if (body.envSlug) session.envSlug = body.envSlug;

        // Generate a session name so all creation paths (browser, CLI, API) get names
        if (isAssistantMode) {
          sessionNames.setName(session.sessionId, "Takode");
        } else {
          const existingNames = new Set(Object.values(sessionNames.getAllNames()));
          const generatedName = generateUniqueSessionName(existingNames);
          sessionNames.setName(session.sessionId, generatedName);
        }

        await emitProgress(stream, "launching_cli", "Session started", "done");

        // --- Done ---
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            sessionId: session.sessionId,
            state: session.state,
            cwd: session.cwd,
          }),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[routes] Failed to create session (stream):", msg);
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: msg }),
        });
      }
    });
  });

  // ─── CLI Session Discovery (for resume) ──────────────────────────────────

  api.get("/cli-sessions", async (c) => {
    try {
      const claudeProjectsDir = join(homedir(), ".claude", "projects");
      if (!existsSync(claudeProjectsDir)) { // sync-ok: route handler, not called during message handling
        return c.json({ sessions: [] });
      }

      // Collect active CLI session IDs so we can filter them out
      const activeCliSessionIds = new Set<string>();
      for (const s of launcher.listSessions()) {
        if (s.cliSessionId) activeCliSessionIds.add(s.cliSessionId);
      }

      // Scan all project directories for .jsonl files
      interface CliSessionFile {
        id: string;
        projectDir: string;
        path: string;
        lastModified: number;
        sizeBytes: number;
      }
      const allFiles: CliSessionFile[] = [];

      let projectDirs: string[];
      try {
        projectDirs = await readdir(claudeProjectsDir);
      } catch {
        return c.json({ sessions: [] });
      }

      for (const projectDir of projectDirs) {
        const projectPath = join(claudeProjectsDir, projectDir);
        let entries: string[];
        try {
          entries = await readdir(projectPath);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.endsWith(".jsonl")) continue;
          const sessionId = entry.slice(0, -6); // strip .jsonl
          // Skip subagent sessions
          if (sessionId.startsWith("agent-")) continue;
          // Skip sessions already active in the Companion
          if (activeCliSessionIds.has(sessionId)) continue;

          const filePath = join(projectPath, entry);
          try {
            const st = await stat(filePath);
            allFiles.push({
              id: sessionId,
              projectDir,
              path: filePath,
              lastModified: st.mtimeMs,
              sizeBytes: st.size,
            });
          } catch {
            continue;
          }
        }
      }

      // Sort by mtime desc and take top 50
      allFiles.sort((a, b) => b.lastModified - a.lastModified);
      const top = allFiles.slice(0, 50);

      // Read first few lines of each to extract metadata
      const results = await Promise.all(
        top.map(async (f) => {
          let cwd: string | undefined;
          let slug: string | undefined;
          let gitBranch: string | undefined;

          try {
            // Read first 4KB which should contain enough lines for metadata
            const fd = Bun.file(f.path);
            const chunk = await fd.slice(0, 4096).text();
            const lines = chunk.split("\n").slice(0, 10);
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const obj = JSON.parse(line);
                if (obj.cwd && !cwd) cwd = obj.cwd;
                if (obj.slug && !slug) slug = obj.slug;
                if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;
                if (cwd && slug && gitBranch) break;
              } catch {
                continue;
              }
            }
          } catch {
            // Metadata extraction failed — still return the session with basic info
          }

          return {
            id: f.id,
            cwd: cwd || null,
            slug: slug || null,
            gitBranch: gitBranch || null,
            lastModified: f.lastModified,
            sizeBytes: f.sizeBytes,
          };
        }),
      );

      return c.json({ sessions: results });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to list CLI sessions:", msg);
      return c.json({ sessions: [] });
    }
  });

  const buildEnrichedSessions = async (
    filterFn?: (s: ReturnType<CliLauncher["listSessions"]>[number]) => boolean,
  ) => {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const bridgeStates = wsBridge.getAllSessions();
    const bridgeMap = new Map(bridgeStates.map((s) => [s.session_id, s]));
    const pool = filterFn ? sessions.filter(filterFn) : sessions;
    return Promise.all(pool.map(async (s) => {
      try {
        const bridge = bridgeMap.get(s.sessionId);
        let gitAhead = bridge?.git_ahead || 0;
        let gitBehind = bridge?.git_behind || 0;
        // Ahead/behind counts come from the bridge's cached git info (refreshed
        // lazily on CLI connect, not on every sidebar poll). Previously this ran
        // a `git rev-list` per worktree session on every /api/sessions request,
        // causing 800-1300ms latency on NFS.
        // Strip sessionAuthToken — never expose to browser clients
        const { sessionAuthToken: _token, ...safeSession } = s;
        return {
          ...safeSession,
          sessionNum: launcher.getSessionNum(s.sessionId) ?? null,
          name: names[s.sessionId] ?? s.name,
          gitBranch: bridge?.git_branch || "",
          gitAhead,
          gitBehind,
          totalLinesAdded: bridge?.total_lines_added || 0,
          totalLinesRemoved: bridge?.total_lines_removed || 0,
          lastMessagePreview: wsBridge.getLastUserMessage(s.sessionId) || "",
          cliConnected: wsBridge.isCliConnected(s.sessionId),
          taskHistory: wsBridge.getSessionTaskHistory(s.sessionId),
          keywords: wsBridge.getSessionKeywords(s.sessionId),
          claimedQuestId: bridge?.claimedQuestId ?? null,
          claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
          ...(wsBridge.getSessionAttentionState(s.sessionId) ?? {}),
          // Worktree liveness status for archived worktree sessions
          // Only check existence (one async access() call), skip expensive git status
          ...(s.isWorktree && s.archived ? await (async () => {
            let exists = false;
            try { await accessAsync(s.cwd); exists = true; } catch { /* not found */ }
            return { worktreeExists: exists };
          })() : {}),
        };
      } catch (e) {
        console.warn(`[routes] Failed to enrich session ${s.sessionId}:`, e);
        return { ...s, name: names[s.sessionId] ?? s.name };
      }
    }));
  };

  api.get("/takode/me", (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;
    return c.json({
      sessionId: auth.callerId,
      sessionNum: launcher.getSessionNum(auth.callerId) ?? null,
      isOrchestrator: auth.caller.isOrchestrator === true,
      state: auth.caller.state,
      backendType: auth.caller.backendType || "claude",
    });
  });

  api.get("/sessions", async (c) => {
    const enriched = await buildEnrichedSessions();
    return c.json(enriched);
  });

  api.get("/takode/sessions", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;
    const enriched = await buildEnrichedSessions();
    return c.json(enriched);
  });

  api.get("/sessions/:id", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(session);
  });

  api.patch("/sessions/:id/name", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    sessionNames.setName(id, body.name.trim());
    wsBridge.broadcastSessionUpdate(id, { name: body.name.trim() });
    return c.json({ ok: true, name: body.name.trim() });
  });

  api.patch("/sessions/:id/diff-base", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const branch = typeof body.branch === "string" ? body.branch : "";
    if (!wsBridge.setDiffBaseBranch(id, branch)) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ ok: true, diff_base_branch: branch });
  });

  api.patch("/sessions/:id/read", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (!wsBridge.markSessionRead(id)) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ ok: true });
  });

  api.patch("/sessions/:id/unread", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (!wsBridge.markSessionUnread(id)) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ ok: true });
  });

  api.post("/sessions/mark-all-read", (c) => {
    wsBridge.markAllSessionsRead();
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/kill", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const killed = await launcher.kill(id);
    if (!killed)
      return c.json({ error: "Session not found or already exited" }, 404);

    // Clean up container if any
    containerManager.removeContainer(id);

    return c.json({ ok: true });
  });

  // Leader-initiated stop: gracefully stop a herded worker session
  api.post("/sessions/:id/stop", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (
      typeof body.callerSessionId === "string"
      && body.callerSessionId.trim()
      && body.callerSessionId.trim() !== auth.callerId
    ) {
      return c.json({ error: "callerSessionId does not match authenticated caller" }, 403);
    }
    const callerSessionId = auth.callerId;

    // Herd guard: only the herding leader can stop
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (!callerSessionId || workerInfo.herdedBy !== callerSessionId) {
      return c.json({ error: "Only the leader who herded this session can stop it" }, 403);
    }

    // Inject a visible system message into the worker's chat before stopping
    const leaderNum = launcher.getSessionNum(callerSessionId);
    const leaderName = sessionNames.getName(callerSessionId) || callerSessionId.slice(0, 8);
    const stopMsg = `Session stopped by leader #${leaderNum ?? "?"} ${leaderName}`;
    const ts = Date.now();
    const session = wsBridge.getSession(id);
    if (session) {
      const historyEntry = {
        type: "user_message" as const,
        content: stopMsg,
        timestamp: ts,
        id: `stop-${ts}`,
        agentSource: { sessionId: callerSessionId, sessionLabel: `#${leaderNum ?? "?"} ${leaderName}` },
      };
      session.messageHistory.push(historyEntry as any);
      wsBridge.broadcastToSession(id, historyEntry as any);
    }

    const killed = await launcher.kill(id);
    if (!killed)
      return c.json({ error: "Session not found or already exited" }, 404);

    return c.json({ ok: true, sessionId: id, stoppedBy: callerSessionId });
  });

  api.post("/sessions/:id/relaunch", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);

    // Worktree sessions: validate the worktree still exists and isn't used by another session
    if (info.isWorktree && info.repoRoot && info.branch) {
      const cwdExists = existsSync(info.cwd); // sync-ok: route handler, not called during message handling
      const usedByOther = worktreeTracker.isWorktreeInUse(info.cwd, id);

      if (!cwdExists || usedByOther) {
        // Recreate the worktree at a new unique path
        const wt = gitUtils.ensureWorktree(info.repoRoot, info.branch, { forceNew: true });
        info.cwd = wt.worktreePath;
        info.actualBranch = wt.actualBranch;
        wsBridge.markWorktree(id, info.repoRoot, wt.worktreePath, undefined, info.branch);
        worktreeTracker.addMapping({
          sessionId: id,
          repoRoot: info.repoRoot,
          branch: info.branch,
          actualBranch: wt.actualBranch,
          worktreePath: wt.worktreePath,
          createdAt: Date.now(),
        });
      } else if (!worktreeTracker.getBySession(id)) {
        // Re-register this session with the tracker (e.g., mapping was lost during archive)
        worktreeTracker.addMapping({
          sessionId: id,
          repoRoot: info.repoRoot,
          branch: info.branch,
          actualBranch: info.actualBranch || info.branch,
          worktreePath: info.cwd,
          createdAt: Date.now(),
        });
      }
    }

    const result = await launcher.relaunch(id);
    if (!result.ok) {
      const status = result.error?.includes("not found") || result.error?.includes("Session not found") ? 404 : 503;
      return c.json({ error: result.error || "Relaunch failed" }, status);
    }
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/force-compact", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);
    if (!info.cliSessionId) return c.json({ error: "No CLI session to resume" }, 400);
    if (info.backendType === "codex") return c.json({ error: "Force compact not supported for Codex" }, 400);

    // Queue /compact to be sent as first message after relaunch.
    // The CLI in SDK mode doesn't intercept slash commands from user messages,
    // so we kill and relaunch with --resume. On a fresh connection, /compact
    // as the first user message will fit in the context and trigger compaction.
    const session = wsBridge.getOrCreateSession(id);
    session.pendingMessages.push(JSON.stringify({
      type: "user",
      message: { role: "user", content: "/compact" },
      parent_tool_use_id: null,
      session_id: info.cliSessionId,
    }));

    // Notify browsers compaction is starting
    wsBridge.broadcastToSession(id, { type: "status_change", status: "compacting" });

    const result = await launcher.relaunch(id);
    if (!result.ok) {
      return c.json({ error: result.error || "Relaunch failed" }, 503);
    }
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/revert", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json<{ messageId: string }>();
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);
    if (!info.cliSessionId) return c.json({ error: "No CLI session to resume" }, 400);
    if (info.backendType === "codex") return c.json({ error: "Revert not supported for Codex" }, 400);

    const session = wsBridge.getOrCreateSession(id);

    // Find the target user message in history
    const targetIdx = session.messageHistory.findIndex(
      (m) => m.type === "user_message" && (m as { id?: string }).id === body.messageId,
    );
    if (targetIdx < 0) return c.json({ error: "Message not found in history" }, 404);

    // Find the preceding assistant message with a UUID for --resume-session-at
    let assistantUuid: string | undefined;
    for (let i = targetIdx - 1; i >= 0; i--) {
      const m = session.messageHistory[i];
      if (m.type === "assistant" && (m as { uuid?: string }).uuid) {
        assistantUuid = (m as { uuid?: string }).uuid;
        break;
      }
    }

    // Truncate server-side message history
    session.messageHistory = session.messageHistory.slice(0, targetIdx);

    // Truncate task history: keep only entries whose trigger message survived truncation
    if (session.taskHistory?.length) {
      const remainingUserMsgIds = new Set(
        session.messageHistory
          .filter((m) => m.type === "user_message")
          .map((m) => (m as { id?: string }).id)
          .filter((id): id is string => typeof id === "string"),
      );
      const prevCount = session.taskHistory.length;
      session.taskHistory = session.taskHistory.filter((t) => remainingUserMsgIds.has(t.triggerMessageId));
      if (session.taskHistory.length !== prevCount) {
        wsBridge.broadcastToSession(id, { type: "session_task_history", tasks: session.taskHistory });
      }
    }

    // Clear orphaned permission dialogs
    session.pendingPermissions.clear();
    wsBridge.broadcastToSession(id, { type: "permissions_cleared" });

    // Notify browsers that revert is in progress
    wsBridge.broadcastToSession(id, { type: "status_change", status: "reverting" });

    // Persist immediately (don't rely on debounce — crash would lose truncation)
    wsBridge.persistSessionSync(id);

    // Kill CLI and relaunch with --resume-session-at to truncate CLI's history
    let result: { ok: boolean; error?: string };
    if (assistantUuid) {
      result = await launcher.relaunchWithResumeAt(id, assistantUuid);
    } else {
      // Reverting the first user message — start fresh
      info.cliSessionId = undefined;
      result = await launcher.relaunch(id);
    }

    if (!result.ok) {
      return c.json({ error: result.error || "Relaunch failed" }, 503);
    }

    // Broadcast updated (truncated) history to all browsers
    wsBridge.broadcastToSession(id, { type: "message_history", messages: session.messageHistory });

    return c.json({ ok: true });
  });

  api.delete("/sessions/:id", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    const worktreeResult = cleanupWorktree(id, true);
    prPoller?.unwatch(id);
    launcher.removeSession(id);
    // Broadcast deletion to all browsers BEFORE closing the session sockets.
    // This ensures every browser tab (not just the one that triggered delete)
    // removes the session from the sidebar immediately.
    wsBridge.broadcastGlobal({ type: "session_deleted", session_id: id });
    wsBridge.closeSession(id);
    await imageStore?.removeSession(id);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.post("/sessions/:id/archive", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    // Stop PR polling for this session
    prPoller?.unwatch(id);

    // Always force-delete the worktree on archive. Worktrees contain only
    // generated/derived content — the branch preserves any committed changes.
    // Without force, dirty worktrees (any untracked file) accumulate forever,
    // inflating git branch lists and slowing NFS operations.
    const worktreeResult = cleanupWorktree(id, true);
    launcher.setArchived(id, true);
    await sessionStore.setArchived(id, true);
    return c.json({ ok: true, worktree: worktreeResult });
  });

  api.post("/sessions/:id/unarchive", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);

    launcher.setArchived(id, false);
    await sessionStore.setArchived(id, false);

    // For worktree sessions: recreate the worktree if it was deleted during archiving
    let worktreeRecreated = false;
    if (info.isWorktree && info.repoRoot && info.branch) {
      if (!existsSync(info.cwd)) { // sync-ok: route handler, not called during message handling
        try {
          const result = recreateWorktreeIfMissing(id, info, { launcher, worktreeTracker, wsBridge });
          if (result.error) {
            return c.json({ ok: false, error: `Failed to recreate worktree: ${result.error}` }, 500);
          }
          worktreeRecreated = result.recreated;
        } catch (e) {
          console.error(`[routes] Failed to recreate worktree for session ${id}:`, e);
          return c.json({
            ok: false,
            error: `Failed to recreate worktree: ${e instanceof Error ? e.message : String(e)}`,
          }, 500);
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
        wsBridge.markWorktree(id, info.repoRoot, info.cwd, undefined, info.branch);
      }
    }

    // Auto-relaunch the CLI so the session is immediately usable
    const relaunchResult = await launcher.relaunch(id);

    return c.json({ ok: true, worktreeRecreated, relaunch: relaunchResult });
  });

  // ─── Takode: Message Peek & Read ────────────────────────────

  api.get("/sessions/:id/messages", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const history = wsBridge.getMessageHistory(sessionId);
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const sessionNum = launcher.getSessionNum(sessionId) ?? -1;
    const sessionName = sessionNames.getName(sessionId) || sessionId.slice(0, 8);
    const cliConnected = wsBridge.isCliConnected(sessionId);

    // Derive status: check bridge session for generation state
    const bridgeSession = wsBridge.getSession(sessionId);
    let status: "idle" | "running" | "disconnected" = "disconnected";
    if (cliConnected) {
      status = bridgeSession?.isGenerating ? "running" : "idle";
    }

    // Quest info from the bridge session state (set via quest claiming)
    const sessionState = bridgeSession?.state;
    const quest = sessionState?.claimedQuestId
      ? {
          id: sessionState.claimedQuestId,
          title: sessionState.claimedQuestTitle || "",
          status: sessionState.claimedQuestStatus || "",
        }
      : null;

    const base = { sessionId, sessionNum, sessionName, status, quest };

    // ── Mode detection ──
    const fromParam = c.req.query("from");
    const detail = c.req.query("detail") === "true";

    if (fromParam !== undefined) {
      // Range browsing mode: show messages around a specific index
      const from = parseInt(fromParam, 10);
      const count = parseInt(c.req.query("count") ?? "30", 10);
      return c.json({ ...base, ...buildPeekRange(history, from, count) });
    }

    if (detail) {
      // Detail mode: legacy full-detail behavior
      const turns = parseInt(c.req.query("turns") ?? "1", 10);
      const since = parseInt(c.req.query("since") ?? "0", 10);
      const full = c.req.query("full") === "true";
      return c.json({ ...base, ...{ mode: "detail" as const, turns: buildPeekResponse(history, { turns, since, full }) } });
    }

    // Default mode: smart overview (collapsed recent turns + expanded last turn)
    const collapsedCount = parseInt(c.req.query("collapsed") ?? "5", 10);
    const expandLimit = parseInt(c.req.query("expand") ?? "10", 10);
    return c.json({ ...base, ...buildPeekDefault(history, { collapsedCount, expandLimit }) });
  });

  api.get("/sessions/:id/messages/:idx", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const idx = parseInt(c.req.param("idx"), 10);
    if (isNaN(idx)) return c.json({ error: "Invalid message index" }, 400);

    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const limit = parseInt(c.req.query("limit") ?? "200", 10);

    const history = wsBridge.getMessageHistory(sessionId);
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const result = buildReadResponse(history, idx, { offset, limit });
    if (!result) {
      return c.json(
        { error: `Message index ${idx} out of range (0-${history.length - 1})` },
        404,
      );
    }

    return c.json(result);
  });

  // ─── Task History (table of contents) ──────────────────────

  api.get("/sessions/:id/tasks", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const taskHistory = wsBridge.getSessionTaskHistory(sessionId);
    const messageHistory = wsBridge.getMessageHistory(sessionId);
    if (!messageHistory) return c.json({ error: "Session not found in bridge" }, 404);

    const sessionNum = launcher.getSessionNum(sessionId) ?? -1;
    const sessionName = sessionNames.getName(sessionId) || sessionId.slice(0, 8);

    // Build a message ID → array index lookup map for all user messages
    const idToIdx = new Map<string, number>();
    for (let i = 0; i < messageHistory.length; i++) {
      const msg = messageHistory[i];
      if (msg.type === "user_message" && (msg as any).id) {
        idToIdx.set((msg as any).id, i);
      }
    }

    // Resolve each task's triggerMessageId to an array index and compute ranges
    const tasks = taskHistory
      .filter(t => t.action !== "revise") // revise entries update in-place, skip them
      .map((task, i, arr) => {
        const startIdx = idToIdx.get(task.triggerMessageId) ?? 0;

        // endIdx = start of next task - 1, or end of history
        let endIdx = messageHistory.length - 1;
        if (i + 1 < arr.length) {
          const nextStart = idToIdx.get(arr[i + 1].triggerMessageId);
          if (nextStart !== undefined && nextStart > 0) {
            endIdx = nextStart - 1;
          }
        }

        return {
          taskNum: i + 1,
          title: task.title,
          startIdx,
          endIdx,
          startedAt: task.timestamp,
          source: task.source || "namer",
          questId: task.questId || null,
        };
      });

    return c.json({
      sessionId,
      sessionNum,
      sessionName,
      totalMessages: messageHistory.length,
      tasks,
    });
  });

  // ─── Recording Management ──────────────────────────────────

  api.post("/sessions/:id/recording/start", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.enableForSession(id);
    return c.json({ ok: true, recording: true });
  });

  api.post("/sessions/:id/recording/stop", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (!recorder) return c.json({ error: "Recording not available" }, 501);
    recorder.disableForSession(id);
    return c.json({ ok: true, recording: false });
  });

  api.get("/sessions/:id/recording/status", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    if (!recorder) return c.json({ recording: false, available: false });
    return c.json({
      recording: recorder.isRecording(id),
      available: true,
      ...recorder.getRecordingStatus(id),
    });
  });

  api.get("/recordings", async (c) => {
    if (!recorder) return c.json({ recordings: [] });
    return c.json({ recordings: await recorder.listRecordings() });
  });

  // ─── Tool result lazy fetch ────────────────────────────────

  api.get("/sessions/:id/tool-result/:toolUseId", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);
    const toolUseId = c.req.param("toolUseId");

    const result = wsBridge.getToolResult(sessionId, toolUseId);
    if (!result) {
      return c.json({ error: "Tool result not found" }, 404);
    }

    return c.json(result);
  });

  // ─── Background agent output file ────────────────────────────

  api.get("/sessions/:id/agent-output", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.text("Missing path parameter", 400);
    // Security: only allow reading from temp directories
    if (!filePath.startsWith("/tmp/")) return c.text("Access denied", 403);
    try {
      const content = await readFile(filePath, "utf-8");
      return c.text(content);
    } catch {
      return c.text("File not found", 404);
    }
  });

  // ─── Image serving ─────────────────────────────────────────

  api.get("/images/:sessionId/:imageId/thumb", async (c) => {
    if (!imageStore) return c.json({ error: "Image store not configured" }, 503);
    const { sessionId, imageId } = c.req.param();
    // Try thumbnail first, fall back to original
    const thumbPath = await imageStore.getThumbnailPath(sessionId, imageId);
    const path = thumbPath || await imageStore.getOriginalPath(sessionId, imageId);
    if (!path) return c.json({ error: "Image not found" }, 404);
    return new Response(Bun.file(path), {
      headers: {
        "Content-Type": thumbPath ? "image/jpeg" : "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  api.get("/images/:sessionId/:imageId/full", async (c) => {
    if (!imageStore) return c.json({ error: "Image store not configured" }, 503);
    const { sessionId, imageId } = c.req.param();
    const path = await imageStore.getOriginalPath(sessionId, imageId);
    if (!path) return c.json({ error: "Image not found" }, 404);
    const file = Bun.file(path);
    return new Response(file, {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  // ─── Available backends ─────────────────────────────────────

  api.get("/backends", (c) => {
    const s = getSettings();
    const backends: Array<{ id: string; name: string; available: boolean }> = [];

    backends.push({ id: "claude", name: "Claude Code", available: resolveBinary(s.claudeBinary || "claude") !== null });
    backends.push({ id: "claude-sdk", name: "Claude SDK", available: resolveBinary(s.claudeBinary || "claude") !== null });
    backends.push({ id: "codex", name: "Codex", available: resolveBinary(s.codexBinary || "codex") !== null });

    return c.json(backends);
  });

  api.get("/backends/:id/models", (c) => {
    const backendId = c.req.param("id");

    if (backendId === "codex") {
      // Read Codex model list from its local cache file
      const cachePath = join(homedir(), ".codex", "models_cache.json");
      if (!existsSync(cachePath)) { // sync-ok: route handler, not called during message handling
        return c.json({ error: "Codex models cache not found. Run codex once to populate it." }, 404);
      }
      try {
        const raw = readFileSync(cachePath, "utf-8"); // sync-ok: route handler, not called during message handling
        const cache = JSON.parse(raw) as {
          models: Array<{
            slug: string;
            display_name?: string;
            description?: string;
            visibility?: string;
            priority?: number;
          }>;
        };
        // Only return visible models, sorted by priority
        const models = cache.models
          .filter((m) => m.visibility === "list")
          .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
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

  // ─── Filesystem browsing ─────────────────────────────────────

  api.get("/fs/list", async (c) => {
    const rawPath = c.req.query("path") || homedir();
    const basePath = resolve(expandTilde(rawPath));
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      const dirs: { name: string; path: string }[] = [];
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          dirs.push({ name: entry.name, path: join(basePath, entry.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ path: basePath, dirs, home: homedir() });
    } catch {
      return c.json(
        {
          error: "Cannot read directory",
          path: basePath,
          dirs: [],
          home: homedir(),
        },
        400,
      );
    }
  });

  api.get("/fs/home", (c) => {
    const home = homedir();
    const cwd = process.cwd();
    // Only report cwd if the user launched companion from a real project directory
    // (not from the package root or the home directory itself)
    const packageRoot = process.env.__COMPANION_PACKAGE_ROOT;
    const isProjectDir =
      cwd !== home &&
      (!packageRoot || !cwd.startsWith(packageRoot));
    return c.json({ home, cwd: isProjectDir ? cwd : home });
  });

  // ─── Editor filesystem APIs ─────────────────────────────────────

  /** Recursive directory tree for the editor file explorer */
  api.get("/fs/tree", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path required" }, 400);
    const basePath = resolve(rawPath);

    interface TreeNode {
      name: string;
      path: string;
      type: "file" | "directory";
      children?: TreeNode[];
    }

    async function buildTree(dir: string, depth: number): Promise<TreeNode[]> {
      if (depth > 10) return []; // Safety limit
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const nodes: TreeNode[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            const children = await buildTree(fullPath, depth + 1);
            nodes.push({
              name: entry.name,
              path: fullPath,
              type: "directory",
              children,
            });
          } else if (entry.isFile()) {
            nodes.push({ name: entry.name, path: fullPath, type: "file" });
          }
        }
        nodes.sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        return nodes;
      } catch {
        return [];
      }
    }

    const tree = await buildTree(basePath, 0);
    return c.json({ path: basePath, tree });
  });

  /** Read a single file */
  api.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const absPath = resolve(filePath);
    try {
      const info = await stat(absPath);
      if (info.size > 2 * 1024 * 1024) {
        return c.json({ error: "File too large (>2MB)" }, 413);
      }
      const content = await readFile(absPath, "utf-8");
      return c.json({ path: absPath, content });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot read file" },
        404,
      );
    }
  });

  api.get("/fs/image", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path required" }, 400);
    const absPath = resolve(path);
    const ext = extname(absPath).toLowerCase();
    const mimeByExt: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".bmp": "image/bmp",
      ".ico": "image/x-icon",
      ".avif": "image/avif",
      ".tif": "image/tiff",
      ".tiff": "image/tiff",
      ".heic": "image/heic",
      ".heif": "image/heif",
    };
    const contentType = mimeByExt[ext];
    if (!contentType) {
      return c.json({ error: "file is not a supported image type" }, 400);
    }
    try {
      const content = await readFile(absPath);
      return c.body(content, 200, {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=30",
      });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot read image file" },
        404,
      );
    }
  });

  /** Write a single file */
  api.put("/fs/write", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    const absPath = resolve(filePath);
    try {
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
  });

  /** Git diff for a single file (unified diff) */
  api.get("/fs/diff", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "path required" }, 400);
    const base = c.req.query("base");
    if (!base) return c.json({ error: "base branch required" }, 400);
    const absPath = resolve(filePath);
    try {
      const repoRoot = await execAsync("git rev-parse --show-toplevel", dirname(absPath));
      const relPath = (await execAsync(`git -C "${repoRoot}" ls-files --full-name -- "${absPath}"`, repoRoot)) || absPath;

      let diff = "";
      try {
        // Compare directly to the selected base ref tip. Using merge-base here
        // makes cherry-picked commits appear as unsynced in the UI.
        diff = await execCaptureStdoutAsync(`git diff ${base} -- "${relPath}"`, repoRoot);
      } catch {
        // Base ref unavailable — leave diff empty
      }

      // For untracked files, base-branch diff is empty. Show full file as added.
      if (!diff.trim()) {
        const untracked = await execAsync(`git ls-files --others --exclude-standard -- "${relPath}"`, repoRoot);
        if (untracked) {
          diff = await execCaptureStdoutAsync(`git diff --no-index -- /dev/null "${absPath}"`, repoRoot);
        }
      }

      return c.json({ path: absPath, diff, baseBranch: base });
    } catch {
      return c.json({ path: absPath, diff: "" });
    }
  });

  /**
   * Bulk diff stats — returns per-file additions/deletions for a list of files
   * in a single `git diff --numstat` call. Much cheaper than fetching full diffs.
   */
  api.post("/fs/diff-stats", async (c) => {
    const body = await c.req.json<{ files: string[]; base?: string; repoRoot: string }>();
    if (!body?.files?.length || !body.repoRoot) {
      return c.json({ error: "files[] and repoRoot required" }, 400);
    }
    if (!body.base) {
      return c.json({ error: "base branch required" }, 400);
    }
    const repoRoot = resolve(body.repoRoot);
    try {
      // git diff --numstat returns: "additions\tdeletions\tfilepath" per line
      const rootPrefix = `${repoRoot}/`;
      const relFiles = body.files.map((f) =>
        f.startsWith(rootPrefix) ? f.slice(rootPrefix.length) : f,
      );
      const fileArgs = relFiles.map((f) => `"${f}"`).join(" ");
      const raw = await execCaptureStdoutAsync(
        `git diff --numstat ${body.base} -- ${fileArgs}`,
        repoRoot,
      );

      const stats: Record<string, { additions: number; deletions: number }> = {};
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const [add, del, file] = line.split("\t");
        if (file) {
          const absPath = `${repoRoot}/${file}`;
          stats[absPath] = {
            additions: add === "-" ? 0 : parseInt(add, 10) || 0,
            deletions: del === "-" ? 0 : parseInt(del, 10) || 0,
          };
        }
      }
      return c.json({ stats, baseBranch: body.base });
    } catch {
      return c.json({ stats: {} });
    }
  });

  /** Find Claude config files for a project (CLAUDE.md + .claude/settings*.json) */
  api.get("/fs/claude-md", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) return c.json({ error: "cwd required" }, 400);

    // Resolve to absolute path to prevent path traversal
    const resolvedCwd = resolve(cwd);

    const candidates: Array<{ path: string; writable: boolean }> = [
      { path: join(resolvedCwd, "CLAUDE.md"), writable: true },
      { path: join(resolvedCwd, ".claude", "CLAUDE.md"), writable: true },
      { path: join(resolvedCwd, ".claude", "settings.json"), writable: false },
      { path: join(resolvedCwd, ".claude", "settings.local.json"), writable: false },
    ];

    const files: { path: string; content: string; writable: boolean }[] = [];
    for (const { path: p, writable } of candidates) {
      try {
        const content = await readFile(p, "utf-8");
        files.push({ path: p, content, writable });
      } catch {
        // file doesn't exist — skip
      }
    }

    return c.json({ cwd: resolvedCwd, files });
  });

  /** Create or update a CLAUDE.md file */
  api.put("/fs/claude-md", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { path: filePath, content } = body;
    if (!filePath || typeof content !== "string") {
      return c.json({ error: "path and content required" }, 400);
    }
    // Only allow writing CLAUDE.md files
    const base = filePath.split("/").pop();
    if (base !== "CLAUDE.md") {
      return c.json({ error: "Can only write CLAUDE.md files" }, 400);
    }
    const absPath = resolve(filePath);
    // Verify the resolved path ends with CLAUDE.md or .claude/CLAUDE.md
    if (!absPath.endsWith("/CLAUDE.md") && !absPath.endsWith("/.claude/CLAUDE.md")) {
      return c.json({ error: "Invalid CLAUDE.md path" }, 400);
    }
    try {
      // Ensure parent directory exists
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf-8");
      return c.json({ ok: true, path: absPath });
    } catch (e: unknown) {
      return c.json(
        { error: e instanceof Error ? e.message : "Cannot write file" },
        500,
      );
    }
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

  // ─── Server restart ───────────────────────────────────────────────

  api.post("/server/restart", (c) => {
    if (!options?.requestRestart) {
      return c.json({ error: "Restart not supported in this mode" }, 503);
    }
    // Block restart while sessions are actively running to prevent stuck sessions
    const busySessions = launcher.listSessions().filter(
      (s) => s.state !== "exited" && wsBridge.isSessionBusy(s.sessionId),
    );
    if (busySessions.length > 0) {
      const names = busySessions.map((s) => s.name || s.sessionId.slice(0, 8));
      return c.json({
        error: `Cannot restart while ${busySessions.length} session(s) are running. Please stop them first: ${names.join(", ")}`,
      }, 409);
    }
    options.requestRestart();
    return c.json({ ok: true });
  });

  // ─── Settings (~/.companion/settings.json) ────────────────────────

  /** Mask sensitive fields in NamerConfig for API responses. */
  function maskNamerConfig(config: NamerConfig): NamerConfig {
    if (config.backend === "openai") {
      return { ...config, apiKey: config.apiKey ? "***" : "" };
    }
    return config;
  }

  /** Parse a namerConfig from a request body (already validated).
   *  If apiKey is "***" (masked sentinel), preserve the existing key from settings. */
  function parseNamerConfigFromBody(nc: Record<string, unknown>): NamerConfig {
    if (nc.backend === "openai") {
      let apiKey = typeof nc.apiKey === "string" ? nc.apiKey.trim() : "";
      if (apiKey === "***") {
        const current = getSettings().namerConfig;
        apiKey = current.backend === "openai" ? current.apiKey : "";
      }
      return {
        backend: "openai",
        apiKey,
        baseUrl: typeof nc.baseUrl === "string" ? nc.baseUrl.trim() : "",
        model: typeof nc.model === "string" ? nc.model.trim() : "",
      };
    }
    return { backend: "claude" };
  }

  api.get("/settings", (c) => {
    const settings = getSettings();
    return c.json({
      serverName: getServerName(),
      serverId: getServerId(),
      pushoverConfigured: !!(settings.pushoverUserKey.trim() && settings.pushoverApiToken.trim()),
      pushoverEnabled: settings.pushoverEnabled,
      pushoverDelaySeconds: settings.pushoverDelaySeconds,
      pushoverBaseUrl: settings.pushoverBaseUrl,
      claudeBinary: settings.claudeBinary,
      codexBinary: settings.codexBinary,
      maxKeepAlive: settings.maxKeepAlive,
      autoApprovalEnabled: settings.autoApprovalEnabled,
      autoApprovalModel: settings.autoApprovalModel,
      namerConfig: maskNamerConfig(settings.namerConfig),
      autoNamerEnabled: settings.autoNamerEnabled,
      restartSupported: !!process.env.COMPANION_SUPERVISED,
      logFile: getLogPath(),
    });
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.serverName !== undefined && typeof body.serverName !== "string") {
      return c.json({ error: "serverName must be a string" }, 400);
    }
    if (body.pushoverUserKey !== undefined && typeof body.pushoverUserKey !== "string") {
      return c.json({ error: "pushoverUserKey must be a string" }, 400);
    }
    if (body.pushoverApiToken !== undefined && typeof body.pushoverApiToken !== "string") {
      return c.json({ error: "pushoverApiToken must be a string" }, 400);
    }
    if (body.pushoverDelaySeconds !== undefined && (typeof body.pushoverDelaySeconds !== "number" || body.pushoverDelaySeconds < 5 || body.pushoverDelaySeconds > 300)) {
      return c.json({ error: "pushoverDelaySeconds must be a number between 5 and 300" }, 400);
    }
    if (body.pushoverEnabled !== undefined && typeof body.pushoverEnabled !== "boolean") {
      return c.json({ error: "pushoverEnabled must be a boolean" }, 400);
    }
    if (body.pushoverBaseUrl !== undefined && typeof body.pushoverBaseUrl !== "string") {
      return c.json({ error: "pushoverBaseUrl must be a string" }, 400);
    }
    if (body.claudeBinary !== undefined && typeof body.claudeBinary !== "string") {
      return c.json({ error: "claudeBinary must be a string" }, 400);
    }
    if (body.codexBinary !== undefined && typeof body.codexBinary !== "string") {
      return c.json({ error: "codexBinary must be a string" }, 400);
    }
    if (body.maxKeepAlive !== undefined && (typeof body.maxKeepAlive !== "number" || body.maxKeepAlive < 0 || !Number.isInteger(body.maxKeepAlive))) {
      return c.json({ error: "maxKeepAlive must be a non-negative integer" }, 400);
    }
    if (body.autoApprovalEnabled !== undefined && typeof body.autoApprovalEnabled !== "boolean") {
      return c.json({ error: "autoApprovalEnabled must be a boolean" }, 400);
    }
    if (body.autoApprovalModel !== undefined && typeof body.autoApprovalModel !== "string") {
      return c.json({ error: "autoApprovalModel must be a string" }, 400);
    }
    if (body.namerConfig !== undefined) {
      if (typeof body.namerConfig !== "object" || body.namerConfig === null || Array.isArray(body.namerConfig)) {
        return c.json({ error: "namerConfig must be an object" }, 400);
      }
      const nc = body.namerConfig;
      if (nc.backend !== "claude" && nc.backend !== "openai") {
        return c.json({ error: 'namerConfig.backend must be "claude" or "openai"' }, 400);
      }
      if (nc.backend === "openai") {
        if (nc.apiKey !== undefined && typeof nc.apiKey !== "string") {
          return c.json({ error: "namerConfig.apiKey must be a string" }, 400);
        }
        if (nc.baseUrl !== undefined && typeof nc.baseUrl !== "string") {
          return c.json({ error: "namerConfig.baseUrl must be a string" }, 400);
        }
        if (nc.model !== undefined && typeof nc.model !== "string") {
          return c.json({ error: "namerConfig.model must be a string" }, 400);
        }
      }
    }
    if (body.autoNamerEnabled !== undefined && typeof body.autoNamerEnabled !== "boolean") {
      return c.json({ error: "autoNamerEnabled must be a boolean" }, 400);
    }

    // Check that at least one known field is present
    const knownFields = [
      "serverName",
      "pushoverUserKey", "pushoverApiToken", "pushoverDelaySeconds", "pushoverEnabled", "pushoverBaseUrl",
      "claudeBinary", "codexBinary",
      "maxKeepAlive",
      "autoApprovalEnabled", "autoApprovalModel",
      "namerConfig",
      "autoNamerEnabled",
    ];
    if (!knownFields.some((f) => body[f] !== undefined)) {
      return c.json({ error: "At least one settings field is required" }, 400);
    }

    if (typeof body.serverName === "string") {
      setServerName(body.serverName);
    }

    const settings = updateSettings({
      pushoverUserKey:
        typeof body.pushoverUserKey === "string"
          ? body.pushoverUserKey.trim()
          : undefined,
      pushoverApiToken:
        typeof body.pushoverApiToken === "string"
          ? body.pushoverApiToken.trim()
          : undefined,
      pushoverDelaySeconds:
        typeof body.pushoverDelaySeconds === "number"
          ? body.pushoverDelaySeconds
          : undefined,
      pushoverEnabled:
        typeof body.pushoverEnabled === "boolean"
          ? body.pushoverEnabled
          : undefined,
      pushoverBaseUrl:
        typeof body.pushoverBaseUrl === "string"
          ? body.pushoverBaseUrl.trim()
          : undefined,
      claudeBinary:
        typeof body.claudeBinary === "string"
          ? body.claudeBinary.trim()
          : undefined,
      codexBinary:
        typeof body.codexBinary === "string"
          ? body.codexBinary.trim()
          : undefined,
      maxKeepAlive:
        typeof body.maxKeepAlive === "number"
          ? body.maxKeepAlive
          : undefined,
      autoApprovalEnabled:
        typeof body.autoApprovalEnabled === "boolean"
          ? body.autoApprovalEnabled
          : undefined,
      autoApprovalModel:
        typeof body.autoApprovalModel === "string"
          ? body.autoApprovalModel.trim()
          : undefined,
      namerConfig: body.namerConfig ? parseNamerConfigFromBody(body.namerConfig) : undefined,
      autoNamerEnabled:
        typeof body.autoNamerEnabled === "boolean"
          ? body.autoNamerEnabled
          : undefined,
    });

    return c.json({
      serverName: getServerName(),
      serverId: getServerId(),
      pushoverConfigured: !!(settings.pushoverUserKey.trim() && settings.pushoverApiToken.trim()),
      pushoverEnabled: settings.pushoverEnabled,
      pushoverDelaySeconds: settings.pushoverDelaySeconds,
      pushoverBaseUrl: settings.pushoverBaseUrl,
      claudeBinary: settings.claudeBinary,
      codexBinary: settings.codexBinary,
      maxKeepAlive: settings.maxKeepAlive,
      autoApprovalEnabled: settings.autoApprovalEnabled,
      autoApprovalModel: settings.autoApprovalModel,
      namerConfig: maskNamerConfig(settings.namerConfig),
      autoNamerEnabled: settings.autoNamerEnabled,
    });
  });

  // ─── Binary test ──────────────────────────────────────────────────

  api.post("/settings/test-binary", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const binary = typeof body.binary === "string" ? body.binary.trim() : "";
    if (!binary) {
      return c.json({ ok: false, error: "binary is required" }, 400);
    }

    const resolved = resolveBinary(binary);
    if (!resolved) {
      return c.json({ ok: false, error: `"${binary}" not found in PATH` }, 400);
    }

    try {
      const version = execSync(`${resolved} --version`, { // sync-ok: route handler, not called during message handling
        encoding: "utf-8",
        timeout: 5_000,
        env: process.env,
      }).trim();
      return c.json({ ok: true, resolvedPath: resolved, version });
    } catch {
      // Binary exists but --version failed — still report it as found
      return c.json({ ok: true, resolvedPath: resolved, version: "(version unknown)" });
    }
  });

  // ─── Pushover test ──────────────────────────────────────────────────

  api.post("/pushover/test", async (c) => {
    if (!pushoverNotifier) {
      return c.json({ error: "Pushover notifier not available" }, 500);
    }
    const result = await pushoverNotifier.sendTest();
    if (result.ok) {
      return c.json({ ok: true });
    }
    return c.json({ error: result.error || "Test notification failed" }, 400);
  });

  // ─── Audio transcription ─────────────────────────────────────────────

  api.get("/transcribe/status", (c) => {
    return c.json(getAvailableBackends());
  });

  api.post("/transcribe", async (c) => {

    const body = await c.req.parseBody();
    const audioFile = body["audio"];
    if (!audioFile || typeof audioFile === "string") {
      return c.json({ error: "audio field is required (multipart)" }, 400);
    }

    const requestedBackend = typeof body["backend"] === "string" ? body["backend"] : undefined;
    const { default: defaultBackend } = getAvailableBackends();
    const backend = requestedBackend || defaultBackend;

    if (!backend) {
      return c.json(
        { error: "No transcription backend available. Set GOOGLE_API_KEY (Gemini) or OPENAI_API_KEY (Whisper) in your environment." },
        400,
      );
    }

    const buf = Buffer.from(await audioFile.arrayBuffer());
    const mimeType = audioFile.type || "audio/webm";

    try {
      let text: string;
      if (backend === "gemini") {
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
          return c.json({ error: "GOOGLE_API_KEY not set in environment" }, 400);
        }
        text = await transcribeWithGemini(buf, mimeType, apiKey);
      } else if (backend === "openai") {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          return c.json({ error: "OPENAI_API_KEY not set in environment" }, 400);
        }
        text = await transcribeWithOpenai(buf, mimeType, apiKey);
      } else {
        return c.json({ error: `Unknown backend: ${backend}` }, 400);
      }

      return c.json({ text, backend });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[transcription] ${backend} failed:`, msg);
      return c.json({ error: `Transcription failed: ${msg}` }, 500);
    }
  });

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
      const raw = await execCaptureStdoutAsync(
        `git log --format="%H%x00%h%x00%s%x00%ct" -${limit}`,
        repoRoot,
      );
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

    const { isGhAvailable, fetchPRInfoAsync } = await import("./github-pr.js");
    if (!isGhAvailable()) {
      return c.json({ available: false, pr: null });
    }

    const pr = await fetchPRInfoAsync(cwd, branch);
    return c.json({ available: true, pr });
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

  // ─── Cross-session messaging ───────────────────────────────────────

  api.post("/sessions/:id/message", async (c) => {
    const auth = authenticateTakodeCaller(c);
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!launcher.isAlive(id)) return c.json({ error: "Session is not running" }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content is required" }, 400);
    }
    // Validate optional agentSource label from callers.
    let sessionLabel: string | undefined;
    if (body.agentSource && typeof body.agentSource === "object") {
      if (typeof body.agentSource.sessionId === "string" && body.agentSource.sessionId.trim()) {
        const claimed = resolveId(body.agentSource.sessionId.trim());
        if (!claimed || claimed !== auth.callerId) {
          return c.json({ error: "agentSource.sessionId does not match authenticated caller" }, 403);
        }
      }
      if (typeof body.agentSource.sessionLabel === "string" && body.agentSource.sessionLabel.trim()) {
        sessionLabel = body.agentSource.sessionLabel;
      }
    }
    const agentSource = { sessionId: auth.callerId, ...(sessionLabel ? { sessionLabel } : {}) };

    // Herd guard: if the target session is herded, only its leader can send messages.
    if (session.herdedBy) {
      if (auth.callerId !== session.herdedBy) {
        return c.json({ error: "Session is herded — only its leader can send messages" }, 403);
      }
    }
    wsBridge.injectUserMessage(id, body.content, agentSource);
    return c.json({ ok: true, sessionId: id });
  });

  // ─── Cat herding (orchestrator→worker relationships) ──────────────

  api.post("/sessions/:id/herd", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const orch = launcher.getSession(orchId);
    if (!orch) return c.json({ error: "Orchestrator session not found" }, 404);

    // Server-side role check: only orchestrators can herd
    if (!orch.isOrchestrator) {
      return c.json({ error: "Session is not an orchestrator" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    if (!Array.isArray(body.workerIds) || body.workerIds.length === 0) {
      return c.json({ error: "workerIds array is required" }, 400);
    }
    // Resolve each worker ref (supports #N, UUID, prefix)
    const resolved: string[] = [];
    const notFound: string[] = [];
    for (const ref of body.workerIds) {
      const wid = resolveId(String(ref));
      if (wid) { resolved.push(wid); } else { notFound.push(String(ref)); }
    }
    const result = launcher.herdSessions(orchId, resolved);
    return c.json({ herded: result.herded, notFound: [...notFound, ...result.notFound], conflicts: result.conflicts });
  });

  api.delete("/sessions/:id/herd/:workerId", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const workerId = resolveId(c.req.param("workerId"));
    if (!workerId) return c.json({ error: "Worker session not found" }, 404);
    const removed = launcher.unherdSession(orchId, workerId);
    return c.json({ ok: true, removed });
  });

  api.get("/sessions/:id/herd", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const orchId = resolveId(c.req.param("id"));
    if (!orchId) return c.json({ error: "Orchestrator session not found" }, 404);
    if (orchId !== auth.callerId) {
      return c.json({ error: "Authenticated caller does not match orchestrator id" }, 403);
    }
    const herded = launcher.getHerdedSessions(orchId);
    return c.json(herded.map(s => ({
      sessionId: s.sessionId,
      sessionNum: s.sessionNum,
      name: sessionNames.getName(s.sessionId),
      state: s.state,
      cwd: s.cwd,
      backendType: s.backendType,
      cliConnected: wsBridge.isCliConnected(s.sessionId),
      isOrchestrator: s.isOrchestrator,
      herdedBy: s.herdedBy,
    })));
  });

  // ─── Leader answer (resolve AskUserQuestion / ExitPlanMode) ─────────

  /** Answerable tool names — tool permissions (can_use_tool) are human-only */
  const ANSWERABLE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

  api.get("/sessions/:id/pending", (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (workerInfo.herdedBy !== auth.callerId) {
      return c.json({ error: "Only the leader who herded this session can view pending prompts" }, 403);
    }
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const pending = [];
    for (const [, perm] of session.pendingPermissions) {
      if (!ANSWERABLE_TOOLS.has(perm.tool_name)) continue;
      pending.push({
        request_id: perm.request_id,
        tool_name: perm.tool_name,
        timestamp: perm.timestamp,
        ...(perm.tool_name === "AskUserQuestion" ? { questions: perm.input.questions } : {}),
        ...(perm.tool_name === "ExitPlanMode" ? { plan: perm.input.plan, allowedPrompts: perm.input.allowedPrompts } : {}),
      });
    }
    return c.json({ pending });
  });

  api.post("/sessions/:id/answer", async (c) => {
    const auth = authenticateTakodeCaller(c, { requireOrchestrator: true });
    if ("response" in auth) return auth.response;

    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found in bridge" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const response = typeof body.response === "string" ? body.response : "";
    if (
      typeof body.callerSessionId === "string"
      && body.callerSessionId.trim()
      && body.callerSessionId.trim() !== auth.callerId
    ) {
      return c.json({ error: "callerSessionId does not match authenticated caller" }, 403);
    }
    const callerSessionId = auth.callerId;

    // Herd guard: only the leader can answer
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (!callerSessionId || workerInfo.herdedBy !== callerSessionId) {
      return c.json({ error: "Only the leader who herded this session can answer" }, 403);
    }

    // Find the first answerable pending permission
    let target: { request_id: string; tool_name: string; input: Record<string, unknown> } | null = null;
    for (const [, perm] of session.pendingPermissions) {
      if (ANSWERABLE_TOOLS.has(perm.tool_name)) {
        target = perm;
        break;
      }
    }
    if (!target) return c.json({ error: "No pending question or plan to answer" }, 404);

    // Build the permission_response based on tool type
    if (target.tool_name === "AskUserQuestion") {
      // Parse response: number = pick option, otherwise free text
      const questions = target.input.questions as Array<{ options?: Array<{ label: string }> }> | undefined;
      const optIdx = parseInt(response, 10);
      let answerValue: string;
      if (!isNaN(optIdx) && questions?.[0]?.options && optIdx >= 1 && optIdx <= questions[0].options.length) {
        answerValue = questions[0].options[optIdx - 1].label; // 1-indexed
      } else {
        answerValue = response; // free text
      }

      wsBridge.routeExternalPermissionResponse(session, {
        type: "permission_response",
        request_id: target.request_id,
        behavior: "allow",
        updated_input: { ...target.input, answers: { "0": answerValue } },
      });
      return c.json({ ok: true, tool_name: target.tool_name, answer: answerValue });
    }

    if (target.tool_name === "ExitPlanMode") {
      const isApprove = response.toLowerCase().startsWith("approve");
      if (isApprove) {
        wsBridge.routeExternalPermissionResponse(session, {
          type: "permission_response",
          request_id: target.request_id,
          behavior: "allow",
          updated_input: target.input,
        });
        return c.json({ ok: true, tool_name: target.tool_name, action: "approved" });
      } else {
        // "reject" or "reject: feedback text"
        const feedback = response.replace(/^reject:?\s*/i, "").trim() || "Rejected by leader";
        wsBridge.routeExternalPermissionResponse(session, {
          type: "permission_response",
          request_id: target.request_id,
          behavior: "deny",
          message: feedback,
        });
        return c.json({ ok: true, tool_name: target.tool_name, action: "rejected", feedback });
      }
    }

    return c.json({ error: "Unsupported tool type" }, 400);
  });

  // ─── Herd diagnostics ────────────────────────────────────────────────

  api.get("/sessions/:id/herd-diagnostics", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);

    const bridgeDiag = wsBridge.getHerdDiagnostics(id);
    const herded = info.isOrchestrator ? launcher.getHerdedSessions(id) : [];

    return c.json({
      sessionId: id,
      sessionNum: info.sessionNum,
      isOrchestrator: info.isOrchestrator || false,
      herdedBy: info.herdedBy,
      herdedWorkers: herded.map(s => ({
        sessionId: s.sessionId,
        sessionNum: s.sessionNum,
        name: sessionNames.getName(s.sessionId),
        state: s.state,
        cliConnected: wsBridge.isCliConnected(s.sessionId),
      })),
      ...(bridgeDiag || {}),
    });
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
        if (!existsSync(root.dir)) continue; // sync-ok: route handler, not called during message handling
        const entries = await readdir(root.dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillMdPath = join(root.dir, entry.name, "SKILL.md");
          if (!existsSync(skillMdPath)) continue; // sync-ok: route handler, not called during message handling
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
      if (!existsSync(skillMdPath)) continue; // sync-ok: route handler, not called during message handling
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
      if (existsSync(skillMdPath)) { // sync-ok: route handler, not called during message handling
        return c.json({ error: `Skill "${slug}" already exists in ${root.backend}` }, 409);
      }
    }

    const { mkdirSync, writeFileSync } = await import("node:fs"); // sync-ok: route handler, not called during message handling
    const md = `---\nname: ${slug}\ndescription: ${JSON.stringify(description || `Skill: ${name}`)}\n---\n\n${content || `# ${name}\n\nDescribe what this skill does and how to use it.\n`}`;
    const paths: Record<string, string> = {};
    for (const root of roots) {
      const skillDir = join(root.dir, slug);
      const skillMdPath = join(skillDir, "SKILL.md");
      mkdirSync(skillDir, { recursive: true }); // sync-ok: route handler, not called during message handling
      writeFileSync(skillMdPath, md); // sync-ok: route handler, not called during message handling
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
      if (!existsSync(skillMdPath)) continue; // sync-ok: route handler, not called during message handling
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
    const { rmSync } = await import("node:fs");
    const removed: Array<"claude" | "codex"> = [];
    for (const root of getSkillRoots(backend)) {
      const skillDir = join(root.dir, slug);
      if (!existsSync(skillDir)) continue; // sync-ok: route handler, not called during message handling
      rmSync(skillDir, { recursive: true }); // sync-ok: route handler, not called during message handling
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

  // ─── Worktree cleanup helper ────────────────────────────────────

  function cleanupWorktree(
    sessionId: string,
    force?: boolean,
  ): { cleaned?: boolean; dirty?: boolean; path?: string } | undefined {
    const mapping = worktreeTracker.getBySession(sessionId);
    if (!mapping) return undefined;

    // Check if other sessions still use this worktree
    if (worktreeTracker.isWorktreeInUse(mapping.worktreePath, sessionId)) {
      worktreeTracker.removeBySession(sessionId);
      return { cleaned: false, path: mapping.worktreePath };
    }

    // Auto-remove if clean, or force-remove if requested
    const dirty = gitUtils.isWorktreeDirty(mapping.worktreePath);
    if (dirty && !force) {
      return { cleaned: false, dirty: true, path: mapping.worktreePath };
    }

    // Delete companion-managed branch if it differs from the user-selected branch
    const branchToDelete =
      mapping.actualBranch && mapping.actualBranch !== mapping.branch
        ? mapping.actualBranch
        : undefined;
    const result = gitUtils.removeWorktree(mapping.repoRoot, mapping.worktreePath, {
      force: dirty,
      branchToDelete,
    });
    if (result.removed) {
      worktreeTracker.removeBySession(sessionId);
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }

  // ─── Questmaster (~/.companion/questmaster/) ──────────────────────

  // ─── Quest image upload/serve ────────────────────────────────────
  // Must be registered before parameterized /:questId routes.

  api.post("/quests/_images", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") {
        return c.json({ error: "file field is required (multipart)" }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const image = await questStore.saveQuestImage(file.name, buf, file.type);
      return c.json(image, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.get("/quests/_images/:imageId", async (c) => {
    const result = await questStore.readQuestImageFile(c.req.param("imageId"));
    if (!result) return c.json({ error: "Image not found" }, 404);
    return new Response(new Uint8Array(result.data), {
      headers: {
        "Content-Type": result.mimeType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  // Notification endpoint for the quest CLI tool — triggers browser refresh.
  // Must be registered before parameterized /:questId routes.
  api.post("/quests/_notify", (c) => {
    wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
    return c.json({ ok: true });
  });

  const transitionQuestAndSync = async (
    questId: string,
    input: import("./quest-types.js").QuestTransitionInput,
  ): Promise<import("./quest-types.js").QuestmasterTask | null> => {
    const current = await questStore.getQuest(questId);
    const currentSessionId = current && "sessionId" in current && typeof current.sessionId === "string"
      ? current.sessionId
      : null;
    const quest = await questStore.transitionQuest(questId, input);
    if (!quest) return null;

    const nextSessionId = "sessionId" in quest && typeof quest.sessionId === "string"
      ? quest.sessionId
      : null;
    if (currentSessionId && currentSessionId !== nextSessionId) {
      wsBridge.setSessionClaimedQuest(currentSessionId, null);
    }
    if (nextSessionId) {
      wsBridge.setSessionClaimedQuest(nextSessionId, {
        id: quest.questId,
        title: quest.title,
        status: quest.status,
      });
    }

    wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
    return quest;
  };

  api.get("/quests", async (c) => {
    const statusFilter = c.req.query("status")?.split(",") as import("./quest-types.js").QuestStatus[] | undefined;
    const parentId = c.req.query("parentId");
    const sessionId = c.req.query("sessionId");
    let quests = await questStore.listQuests();
    if (statusFilter?.length) quests = quests.filter((q) => statusFilter.includes(q.status));
    if (parentId) quests = quests.filter((q) => q.parentId === parentId);
    if (sessionId) quests = quests.filter((q) => "sessionId" in q && (q as { sessionId: string }).sessionId === sessionId);
    return c.json(quests);
  });

  api.get("/quests/:questId", async (c) => {
    const quest = await questStore.getQuest(c.req.param("questId"));
    if (!quest) return c.json({ error: "Quest not found" }, 404);
    return c.json(quest);
  });

  api.get("/quests/:questId/history", async (c) => {
    const history = await questStore.getQuestHistory(c.req.param("questId"));
    return c.json(history);
  });

  api.get("/quests/:questId/version/:versionId", async (c) => {
    const version = await questStore.getQuestVersion(c.req.param("versionId"));
    if (!version) return c.json({ error: "Version not found" }, 404);
    return c.json(version);
  });

  api.post("/quests", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const quest = await questStore.createQuest(body);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.patch("/quests/:questId", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const quest = await questStore.patchQuest(c.req.param("questId"), body);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      if (
        typeof body.title === "string" &&
        "sessionId" in quest &&
        quest.status === "in_progress" &&
        typeof quest.sessionId === "string" &&
        body.title.trim().length > 0
      ) {
        // Keep quest-owned session names in sync when a claimed quest is retitled.
        // setSessionClaimedQuest broadcasts session_quest_claimed + session_name_update
        // source:quest, and persists the name via callback.
        wsBridge.setSessionClaimedQuest(quest.sessionId, {
          id: quest.questId,
          title: quest.title,
          status: quest.status,
        });
        // Update task history entries that reference this quest
        wsBridge.updateQuestTaskEntries(quest.sessionId, quest.questId, quest.title);
      }
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/transition", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const questId = c.req.param("questId");
      const quest = await transitionQuestAndSync(questId, body);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/quests/:questId", async (c) => {
    const deleted = await questStore.deleteQuest(c.req.param("questId"));
    if (!deleted) return c.json({ error: "Quest not found" }, 404);
    wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
    return c.json({ ok: true });
  });

  api.post("/quests/:questId/claim", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const rawSessionId = body.sessionId as string | undefined;
    const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
    const knownSession = launcher.getSession(sessionId);
    if (!knownSession) {
      return c.json(
        {
          error:
            `Unknown sessionId: ${sessionId}. ` +
            "Claim a quest from an active Companion session or choose a valid session in Questmaster.",
        },
        400,
      );
    }
    try {
      const quest = await questStore.claimQuest(c.req.param("questId"), sessionId, {
        allowArchivedOwnerTakeover: true,
        isSessionArchived: (sid: string) => !!launcher.getSession(sid)?.archived,
      });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      // setSessionClaimedQuest broadcasts session_quest_claimed + session_name_update
      // source:quest, cancels in-flight namers, and persists the name via callback.
      wsBridge.setSessionClaimedQuest(sessionId, { id: quest.questId, title: quest.title, status: quest.status });
      console.log(`[quest-claim] Setting session name for ${sessionId} to "${quest.title}" (quest ${quest.questId})`);
      // Use the last user message as trigger so clicking the quest chip scrolls
      // to the user message that initiated the claim (matches auto-namer behavior).
      const session = wsBridge.getSession(sessionId);
      let triggerMsgId = "quest-" + quest.questId;
      if (session) {
        for (let i = session.messageHistory.length - 1; i >= 0; i--) {
          const m = session.messageHistory[i];
          if (m.type === "user_message" && m.id) { triggerMsgId = m.id; break; }
        }
      }
      wsBridge.addTaskEntry(sessionId, {
        title: quest.title,
        action: "new",
        timestamp: Date.now(),
        triggerMessageId: triggerMsgId,
        source: "quest",
        questId: quest.questId,
      });
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/complete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const items = body.verificationItems as import("./quest-types.js").QuestVerificationItem[] | undefined;
    if (!items || !Array.isArray(items)) return c.json({ error: "verificationItems array is required" }, 400);
    try {
      const quest = await questStore.completeQuest(c.req.param("questId"), items);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      // Update session's quest status so browsers can show "pending review" badge
      if ("sessionId" in quest) {
        const sid = (quest as { sessionId: string }).sessionId;
        wsBridge.setSessionClaimedQuest(sid, { id: quest.questId, title: quest.title, status: quest.status });
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/done", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { notes?: string; cancelled?: boolean };
      const quest = await transitionQuestAndSync(c.req.param("questId"), {
        status: "done",
        ...(body.notes ? { notes: body.notes } : {}),
        ...(body.cancelled ? { cancelled: true } : {}),
      });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      c.header("X-Companion-Deprecated", "Use /api/quests/:questId/transition with {status:\"done\"}");
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/cancel", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { notes?: string };
      const current = await questStore.getQuest(c.req.param("questId"));
      const quest = await questStore.cancelQuest(c.req.param("questId"), body.notes);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      // Clear the claimed quest from the active owner session since it's now cancelled.
      if (current && "sessionId" in current && typeof current.sessionId === "string") {
        wsBridge.setSessionClaimedQuest(current.sessionId, null);
      }
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.patch("/quests/:questId/verification/:index", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const index = parseInt(c.req.param("index"), 10);
    if (Number.isNaN(index)) return c.json({ error: "Invalid index" }, 400);
    try {
      const quest = await questStore.checkVerificationItem(c.req.param("questId"), index, body.checked ?? false);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/verification/read", async (c) => {
    try {
      const quest = await questStore.markQuestVerificationRead(c.req.param("questId"));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/verification/inbox", async (c) => {
    try {
      const quest = await questStore.markQuestVerificationInboxUnread(c.req.param("questId"));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Append a feedback entry to a quest's thread
  api.post("/quests/:questId/feedback", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const text = body.text;
    const author = body.author === "agent" ? "agent" : "human";
    const rawAuthorSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (author === "agent" && rawAuthorSessionId.length === 0) {
      return c.json({ error: "sessionId is required for agent feedback" }, 400);
    }
    const authorSessionId = author === "agent" ? rawAuthorSessionId : undefined;
    if (!text || typeof text !== "string" || !text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }
    if (authorSessionId && !launcher.getSession(authorSessionId)) {
      return c.json(
        {
          error:
            `Unknown sessionId: ${authorSessionId}. ` +
            "Agent feedback must include a valid Companion session ID.",
        },
        400,
      );
    }
    try {
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("./quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current ? (current as { feedback?: import("./quest-types.js").QuestFeedbackEntry[] }).feedback ?? [] : [];
      const entry: import("./quest-types.js").QuestFeedbackEntry = { author, text: text.trim(), ts: Date.now() };
      if (authorSessionId) entry.authorSessionId = authorSessionId;
      if (Array.isArray(body.images) && body.images.length > 0) entry.images = body.images;
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: [...existing, entry] });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Edit an existing feedback entry by index
  api.patch("/quests/:questId/feedback/:index", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const index = parseInt(c.req.param("index"), 10);
      if (isNaN(index) || index < 0) return c.json({ error: "Invalid index" }, 400);
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("./quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current ? (current as { feedback?: import("./quest-types.js").QuestFeedbackEntry[] }).feedback ?? [] : [];
      if (index >= existing.length) return c.json({ error: "Index out of range" }, 400);
      const updated = [...existing];
      if (typeof body.text === "string" && body.text.trim()) updated[index] = { ...updated[index], text: body.text.trim() };
      if (body.images !== undefined) updated[index] = { ...updated[index], images: Array.isArray(body.images) && body.images.length > 0 ? body.images : undefined };
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // Toggle addressed status on a feedback entry
  api.post("/quests/:questId/feedback/:index/addressed", async (c) => {
    try {
      const index = parseInt(c.req.param("index"), 10);
      if (isNaN(index) || index < 0) return c.json({ error: "Invalid index" }, 400);
      const current = await questStore.getQuest(c.req.param("questId"));
      if (!current) return c.json({ error: "Quest not found" }, 404);
      const existing: import("./quest-types.js").QuestFeedbackEntry[] =
        "feedback" in current ? (current as { feedback?: import("./quest-types.js").QuestFeedbackEntry[] }).feedback ?? [] : [];
      if (index >= existing.length) return c.json({ error: "Index out of range" }, 400);
      const updated = [...existing];
      updated[index] = { ...updated[index], addressed: !updated[index].addressed };
      const quest = await questStore.patchQuest(c.req.param("questId"), { feedback: updated });
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.post("/quests/:questId/images", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") {
        return c.json({ error: "file field is required (multipart)" }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const image = await questStore.saveQuestImage(file.name, buf, file.type);
      const quest = await questStore.addQuestImages(c.req.param("questId"), [image]);
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  api.delete("/quests/:questId/images/:imageId", async (c) => {
    try {
      const quest = await questStore.removeQuestImage(c.req.param("questId"), c.req.param("imageId"));
      if (!quest) return c.json({ error: "Quest not found" }, 404);
      wsBridge.broadcastGlobal({ type: "quest_list_updated" } as import("./session-types.js").BrowserIncomingMessage);
      return c.json(quest);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
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
      // Read into memory before responding — unlinkSync in finally would race
      // with a lazy stream and produce a 0-byte download.
      const buf = readFileSync(tempPath); // sync-ok: route handler, not called during message handling
      const timestamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
      c.header("Content-Type", "application/zstd");
      c.header("Content-Disposition", `attachment; filename="companion-export-${timestamp}.tar.zst"`);
      c.header("Content-Length", String(buf.byteLength));
      return c.body(buf);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    } finally {
      try { unlinkSync(tempPath); } catch { /* ignore */ } // sync-ok: route handler, not called during message handling
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
    writeFileSync(tempPath, buf); // sync-ok: route handler, not called during message handling

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
        try { unlinkSync(tempPath); } catch { /* ignore */ } // sync-ok: route handler, not called during message handling
        // writer.close() returns a Promise — swallow if stream already closed
        writer.close().catch(() => {});
      }
    })();

    return new Response(readable, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  });

  return api;
}
