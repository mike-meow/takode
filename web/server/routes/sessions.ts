import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { resolveBinary, expandTilde } from "../path-resolver.js";
import { readFile, writeFile, stat, readdir, access as accessAsync } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { CliLauncher, LaunchOptions } from "../cli-launcher.js";
import * as envManager from "../env-manager.js";
import * as gitUtils from "../git-utils.js";
import * as sessionNames from "../session-names.js";
import * as sessionOrderStore from "../session-order.js";
import * as groupOrderStore from "../group-order.js";
import { recreateWorktreeIfMissing } from "../migration.js";
import { containerManager, ContainerManager, type ContainerConfig, type ContainerInfo } from "../container-manager.js";
import type { CreationStepId } from "../session-types.js";
import { hasContainerClaudeAuth } from "../claude-container-auth.js";
import { hasContainerCodexAuth } from "../codex-container-auth.js";
import { getSettings, getClaudeUserDefaultModel } from "../settings-manager.js";
import { searchSessionDocuments, type SessionSearchDocument } from "../session-search.js";
import { ensureAssistantWorkspace, ASSISTANT_DIR } from "../assistant-workspace.js";
import { trafficStats } from "../traffic-stats.js";
import { generateUniqueSessionName } from "../../src/utils/names.js";
import { GIT_CMD_TIMEOUT } from "../constants.js";
import { getDefaultModelForBackend } from "../../shared/backend-defaults.js";
import type { RouteContext } from "./context.js";

export function createSessionsRoutes(ctx: RouteContext) {
  const api = new Hono();
  const {
    launcher,
    wsBridge,
    sessionStore,
    worktreeTracker,
    prPoller,
    imageStore,
    resolveId,
    authenticateTakodeCaller,
    execCaptureStdoutAsync,
    pathExists,
    WEB_DIR,
    buildOrchestratorSystemPrompt,
    resolveInitialModeState,
  } = ctx;

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
      mapping.actualBranch && mapping.actualBranch !== mapping.branch ? mapping.actualBranch : undefined;
    const result = gitUtils.removeWorktree(mapping.repoRoot, mapping.worktreePath, {
      force: dirty,
      branchToDelete,
    });
    if (result.removed) {
      worktreeTracker.removeBySession(sessionId);
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }
  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────
  type SessionBackend = "claude" | "codex" | "claude-sdk";
  type CreationProgressStatus = "in_progress" | "done" | "error";
  type SessionPreparationStatus = 400 | 503;
  type EmitCreationProgress = (
    step: CreationStepId,
    label: string,
    status: CreationProgressStatus,
    detail?: string,
  ) => Promise<void>;

  interface WorktreeSessionInfo {
    isWorktree: boolean;
    repoRoot: string;
    branch: string;
    actualBranch: string;
    worktreePath: string;
    defaultBranch: string;
  }

  interface SessionConfig {
    launchOptions: LaunchOptions;
    initialModeState: ReturnType<RouteContext["resolveInitialModeState"]>;
    initialCwd: string;
    isAssistantMode: boolean;
    isOrchestrator: boolean;
    envSlug?: string;
    createdBy?: unknown;
    worktreeInfo?: WorktreeSessionInfo;
    containerInfo?: ContainerInfo;
    resumeCliSessionId?: string;
  }

  class SessionPreparationError extends Error {
    constructor(
      message: string,
      public status: SessionPreparationStatus,
      public step?: CreationStepId,
    ) {
      super(message);
      this.name = "SessionPreparationError";
    }
  }

  const resolveBackend = (raw: unknown): SessionBackend | null => {
    if (raw === "claude" || raw === "codex" || raw === "claude-sdk") return raw;
    return null;
  };

  /** Resolve "claude" to the user's configured default (WebSocket or SDK). */
  const applyDefaultClaudeBackend = (backend: SessionBackend): SessionBackend => {
    if (backend !== "claude") return backend;
    const configured = getSettings().defaultClaudeBackend;
    return configured === "claude-sdk" ? "claude-sdk" : "claude";
  };

  const throwPreparationError = (message: string, status: SessionPreparationStatus, step?: CreationStepId): never => {
    throw new SessionPreparationError(message, status, step);
  };

  const markOrchestratorSession = (sessionId: string, backend: SessionBackend) => {
    // Fire-and-forget: wait for CLI to connect, then send identity message
    (async () => {
      const maxWait = 30_000;
      const pollMs = 200;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const info = launcher.getSession(sessionId);
        if (info && (info.state === "connected" || info.state === "running")) {
          wsBridge.injectUserMessage(sessionId, buildOrchestratorSystemPrompt(backend));
          return;
        }
        if (info?.state === "exited") return; // CLI crashed, don't inject
        await new Promise((r) => setTimeout(r, pollMs));
      }
    })().catch((e) => console.error(`[routes] Failed to inject orchestrator message:`, e));
  };

  const applySessionPostLaunch = (
    session: Awaited<ReturnType<CliLauncher["launch"]>>,
    sessionConfig: SessionConfig,
  ) => {
    if (sessionConfig.containerInfo) {
      containerManager.retrack(sessionConfig.containerInfo.containerId, session.sessionId);
      wsBridge.markContainerized(session.sessionId, sessionConfig.initialCwd);
    }

    if (sessionConfig.worktreeInfo) {
      wsBridge.markWorktree(
        session.sessionId,
        sessionConfig.worktreeInfo.repoRoot,
        sessionConfig.initialCwd,
        sessionConfig.worktreeInfo.defaultBranch,
        sessionConfig.worktreeInfo.branch,
      );
      worktreeTracker.addMapping({
        sessionId: session.sessionId,
        repoRoot: sessionConfig.worktreeInfo.repoRoot,
        branch: sessionConfig.worktreeInfo.branch,
        actualBranch: sessionConfig.worktreeInfo.actualBranch,
        worktreePath: sessionConfig.worktreeInfo.worktreePath,
        createdAt: Date.now(),
      });
    }

    wsBridge.setInitialCwd(session.sessionId, sessionConfig.initialCwd);
    wsBridge.setInitialAskPermission(
      session.sessionId,
      sessionConfig.initialModeState.askPermission,
      sessionConfig.initialModeState.uiMode,
    );
    if (sessionConfig.resumeCliSessionId) {
      wsBridge.markResumedFromExternal(session.sessionId);
    }

    if (sessionConfig.isAssistantMode) {
      session.isAssistant = true;
    }
    if (sessionConfig.isOrchestrator) {
      session.isOrchestrator = true;
      markOrchestratorSession(session.sessionId, sessionConfig.launchOptions.backendType || "claude");
    }
    if (sessionConfig.envSlug) session.envSlug = sessionConfig.envSlug;

    if (sessionConfig.isAssistantMode) {
      sessionNames.setName(session.sessionId, "Takode");
    } else {
      const existingNames = new Set(Object.values(sessionNames.getAllNames()));
      sessionNames.setName(session.sessionId, generateUniqueSessionName(existingNames));
    }

    if (sessionConfig.createdBy) {
      const creatorId = resolveId(String(sessionConfig.createdBy));
      const creator = creatorId ? launcher.getSession(creatorId) : null;
      if (creator?.isOrchestrator) {
        launcher.herdSessions(creator.sessionId, [session.sessionId]);
      }
    }

    wsBridge.broadcastGlobal({ type: "session_created", session_id: session.sessionId });
  };

  const prepareSession = async (
    body: any,
    backend: SessionBackend,
    emitProgress?: EmitCreationProgress,
  ): Promise<SessionConfig> => {
    const emit = async (step: CreationStepId, label: string, status: CreationProgressStatus, detail?: string) => {
      if (!emitProgress) return;
      await emitProgress(step, label, status, detail);
    };

    const isOrchestrator = body.role === "orchestrator";

    if (body.resumeCliSessionId) {
      if (backend !== "claude" && backend !== "codex") {
        throwPreparationError("Resuming CLI sessions is only supported for Claude and Codex backends", 400);
      }

      await emit("resolving_env", "Resolving environment...", "in_progress");
      let envVars: Record<string, string> | undefined = body.env;
      if (body.envSlug) {
        const companionEnv = await envManager.getEnv(body.envSlug);
        if (companionEnv) envVars = { ...companionEnv.variables, ...body.env };
      }
      envVars = { ...envVars, COMPANION_PORT: String(launcher.getPort()) };
      if (isOrchestrator) {
        envVars.TAKODE_ROLE = "orchestrator";
        envVars.TAKODE_API_PORT = String(launcher.getPort());
      }
      await emit("resolving_env", "Environment resolved", "done");

      const resumeAskPermission = body.askPermission !== false;
      const initialModeState: ReturnType<RouteContext["resolveInitialModeState"]> = {
        permissionMode: resumeAskPermission ? "plan" : "bypassPermissions",
        askPermission: resumeAskPermission,
        uiMode: resumeAskPermission ? "plan" : "agent",
      };
      const initialCwd = body.cwd ? resolve(expandTilde(body.cwd)) : process.cwd();
      const binarySettings = getSettings();
      const launchOptions: LaunchOptions = {
        cwd: initialCwd,
        claudeBinary: body.claudeBinary || binarySettings.claudeBinary || undefined,
        codexBinary: body.codexBinary || binarySettings.codexBinary || undefined,
        env: envVars,
        backendType: backend,
        resumeCliSessionId: body.resumeCliSessionId,
        permissionMode: initialModeState.permissionMode,
        askPermission: initialModeState.askPermission,
      };
      return {
        launchOptions,
        initialModeState,
        initialCwd,
        isAssistantMode: false,
        isOrchestrator,
        envSlug: body.envSlug,
        createdBy: body.createdBy,
        resumeCliSessionId: body.resumeCliSessionId,
      };
    }

    await emit("resolving_env", "Resolving environment...", "in_progress");

    let envVars: Record<string, string> | undefined = body.env;
    const companionEnv = body.envSlug ? await envManager.getEnv(body.envSlug) : null;
    if (body.envSlug) {
      if (companionEnv) {
        console.log(
          `[routes] Injecting env "${companionEnv.name}" (${Object.keys(companionEnv.variables).length} vars):`,
          Object.keys(companionEnv.variables).join(", "),
        );
        envVars = { ...companionEnv.variables, ...body.env };
      } else {
        console.warn(`[routes] Environment "${body.envSlug}" not found, ignoring`);
      }
    }

    let cwd = body.cwd as string | undefined;
    const isAssistantMode = body.assistantMode === true;
    let worktreeInfo: WorktreeSessionInfo | undefined;

    if (cwd) {
      cwd = resolve(expandTilde(cwd));
      if (!existsSync(cwd)) {
        // sync-ok: route handler, not called during message handling
        throwPreparationError(`Directory does not exist: ${cwd}`, 400, "resolving_env");
      }
    }

    envVars = { ...envVars, COMPANION_PORT: String(launcher.getPort()) };
    if (isOrchestrator) {
      envVars.TAKODE_ROLE = "orchestrator";
      envVars.TAKODE_API_PORT = String(launcher.getPort());
    }

    if (isAssistantMode) {
      ensureAssistantWorkspace();
      cwd = ASSISTANT_DIR;
    }

    await emit("resolving_env", "Environment resolved", "done");

    if (body.branch && !/^[a-zA-Z0-9/_.\-]+$/.test(body.branch)) {
      throwPreparationError("Invalid branch name", 400, "checkout_branch");
    }

    if (body.useWorktree) {
      const worktreeBaseCwd = cwd;
      if (!worktreeBaseCwd) {
        throwPreparationError("Worktree mode requires a cwd", 400, "creating_worktree");
      }
      await emit("creating_worktree", "Creating worktree...", "in_progress");
      const repoInfo = gitUtils.getRepoInfo(worktreeBaseCwd as string);
      if (!repoInfo) {
        throwPreparationError("Worktree mode requires a git repository", 400, "creating_worktree");
      } else {
        const targetBranch = body.branch || repoInfo.currentBranch;
        if (!targetBranch) {
          throwPreparationError("Unable to determine branch for worktree session", 400, "creating_worktree");
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
      }
      await emit("creating_worktree", "Worktree ready", "done");
    } else if (body.branch && cwd) {
      const repoInfo = gitUtils.getRepoInfo(cwd);
      if (repoInfo) {
        await emit("fetching_git", "Fetching from remote...", "in_progress");
        const fetchResult = gitUtils.gitFetch(repoInfo.repoRoot);
        if (!fetchResult.success) {
          console.warn(`[routes] git fetch warning (non-fatal): ${fetchResult.output}`);
          await emit("fetching_git", "Fetch skipped (offline or auth issue)", "done");
        } else {
          await emit("fetching_git", "Fetch complete", "done");
        }

        if (repoInfo.currentBranch !== body.branch) {
          await emit("checkout_branch", `Checking out ${body.branch}...`, "in_progress");
          try {
            gitUtils.checkoutBranch(repoInfo.repoRoot, body.branch);
            await emit("checkout_branch", `On branch ${body.branch}`, "done");
          } catch (err) {
            console.warn(`[routes] git checkout warning (non-fatal, repo may have uncommitted changes): ${err}`);
            await emit("checkout_branch", "Checkout skipped (uncommitted changes)", "done");
          }
        }

        await emit("pulling_git", "Pulling latest changes...", "in_progress");
        const pullResult = gitUtils.gitPull(repoInfo.repoRoot);
        if (!pullResult.success) {
          console.warn(`[routes] git pull warning (non-fatal): ${pullResult.output}`);
        }
        await emit("pulling_git", "Up to date", "done");
      }
    }

    let effectiveImage = companionEnv
      ? body.envSlug
        ? await envManager.getEffectiveImage(body.envSlug)
        : null
      : body.container?.image || null;

    let containerInfo: ContainerInfo | undefined;
    let containerId: string | undefined;
    let containerName: string | undefined;
    let containerImage: string | undefined;

    if (effectiveImage && backend === "claude" && !hasContainerClaudeAuth(envVars)) {
      throwPreparationError(
        "Containerized Claude requires auth available inside the container. " +
          "Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_AUTH_TOKEN) in the selected environment.",
        400,
      );
    }
    if (effectiveImage && backend === "codex" && !hasContainerCodexAuth(envVars)) {
      throwPreparationError(
        "Containerized Codex requires auth available inside the container. " +
          "Set OPENAI_API_KEY in the selected environment, or ensure ~/.codex/auth.json exists on the host.",
        400,
      );
    }

    if (effectiveImage) {
      const containerWorkspaceCwd = cwd || process.cwd();
      if (!containerManager.imageExists(effectiveImage)) {
        const isDefaultImage = effectiveImage === "the-companion:latest" || effectiveImage === "companion-dev:latest";
        if (isDefaultImage) {
          if (effectiveImage === "the-companion:latest" && containerManager.imageExists("companion-dev:latest")) {
            console.warn("[routes] the-companion:latest not found, falling back to companion-dev:latest (deprecated)");
            effectiveImage = "companion-dev:latest";
          } else {
            const registryImage = ContainerManager.getRegistryImage(effectiveImage);
            let pulled = false;
            if (registryImage) {
              console.log(`[routes] ${effectiveImage} missing locally, trying docker pull ${registryImage}...`);
              await emit("pulling_image", "Pulling Docker image...", "in_progress");
              pulled = await containerManager.pullImage(registryImage, effectiveImage);
              if (pulled) {
                await emit("pulling_image", "Image pulled", "done");
              } else {
                await emit("pulling_image", "Pull failed, falling back to build", "error");
              }
            }
            if (!pulled) {
              const dockerfileName =
                effectiveImage === "the-companion:latest" ? "Dockerfile.the-companion" : "Dockerfile.companion-dev";
              const dockerfilePath = join(WEB_DIR, "docker", dockerfileName);
              if (!existsSync(dockerfilePath)) {
                // sync-ok: route handler, not called during message handling
                throwPreparationError(
                  `Docker image ${effectiveImage} is missing, pull failed, and Dockerfile not found at ${dockerfilePath}`,
                  503,
                  "building_image",
                );
              }
              try {
                await emit("building_image", "Building Docker image (this may take a minute)...", "in_progress");
                containerManager.buildImage(dockerfilePath, effectiveImage);
                await emit("building_image", "Image built", "done");
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                throwPreparationError(
                  `Docker image ${effectiveImage} is missing: pull and build both failed: ${reason}`,
                  503,
                  "building_image",
                );
              }
            }
          }
        } else {
          throwPreparationError(
            `Docker image not found locally: ${effectiveImage}. Build/pull the image first, then retry.`,
            503,
          );
        }
      }

      await emit("creating_container", "Starting container...", "in_progress");
      const tempId = crypto.randomUUID().slice(0, 8);
      const cConfig: ContainerConfig = {
        image: effectiveImage,
        ports:
          companionEnv?.ports ??
          (Array.isArray(body.container?.ports) ? body.container.ports.map(Number).filter((n: number) => n > 0) : []),
        volumes: companionEnv?.volumes ?? body.container?.volumes,
        env: envVars,
      };
      let createdContainerInfo: ContainerInfo | null = null;
      try {
        createdContainerInfo = containerManager.createContainer(tempId, containerWorkspaceCwd, cConfig);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throwPreparationError(
          `Docker is required to run this environment image (${effectiveImage}) ` +
            `but container startup failed: ${reason}`,
          503,
          "creating_container",
        );
      }
      if (!createdContainerInfo) {
        throwPreparationError(
          `Docker is required to run this environment image (${effectiveImage}) but container startup failed`,
          503,
          "creating_container",
        );
      }
      const activeContainerInfo = createdContainerInfo as ContainerInfo;
      containerInfo = activeContainerInfo;
      containerId = activeContainerInfo.containerId;
      containerName = activeContainerInfo.name;
      containerImage = effectiveImage;
      await emit("creating_container", "Container running", "done");

      await emit("copying_workspace", "Copying workspace files...", "in_progress");
      try {
        await containerManager.copyWorkspaceToContainer(activeContainerInfo.containerId, containerWorkspaceCwd);
        containerManager.reseedGitAuth(activeContainerInfo.containerId);
        await emit("copying_workspace", "Workspace copied", "done");
      } catch (err) {
        containerManager.removeContainer(tempId);
        const reason = err instanceof Error ? err.message : String(err);
        throwPreparationError(`Failed to copy workspace to container: ${reason}`, 503, "copying_workspace");
      }

      if (companionEnv?.initScript?.trim()) {
        await emit("running_init_script", "Running init script...", "in_progress");
        try {
          console.log(
            `[routes] Running init script for env "${companionEnv.name}" in container ${activeContainerInfo.name}...`,
          );
          const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
          const result = await containerManager.execInContainerAsync(
            activeContainerInfo.containerId,
            ["sh", "-lc", companionEnv.initScript],
            { timeout: initTimeout },
          );
          if (result.exitCode !== 0) {
            console.error(
              `[routes] Init script failed for env "${companionEnv.name}" (exit ${result.exitCode}):\n${result.output}`,
            );
            containerManager.removeContainer(tempId);
            const truncated =
              result.output.length > 2000
                ? result.output.slice(0, 500) + "\n...[truncated]...\n" + result.output.slice(-1500)
                : result.output;
            throwPreparationError(
              `Init script failed (exit ${result.exitCode}):\n${truncated}`,
              503,
              "running_init_script",
            );
          }
          await emit("running_init_script", "Init script complete", "done");
        } catch (e) {
          if (!(e instanceof SessionPreparationError)) {
            containerManager.removeContainer(tempId);
          }
          const reason = e instanceof Error ? e.message : String(e);
          if (e instanceof SessionPreparationError) throw e;
          throwPreparationError(`Init script execution failed: ${reason}`, 503, "running_init_script");
        }
      }
    }

    const askPermissionRequested = body.askPermission !== false;
    const initialModeState = resolveInitialModeState(backend, body.permissionMode, askPermissionRequested);
    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    // Resolve model: for Claude backends with no explicit model ("Default" selected),
    // read the user's ~/.claude/settings.json model and pass it explicitly. Without
    // this, the CLI subprocess uses project-level settings that may override the
    // user's intended default model.
    const model =
      requestedModel ||
      (backend === "codex" ? getDefaultModelForBackend("codex") : undefined) ||
      (backend === "claude" || backend === "claude-sdk" ? (await getClaudeUserDefaultModel()) || undefined : undefined);
    const codexReasoningEffort =
      backend === "codex" && typeof body.codexReasoningEffort === "string"
        ? body.codexReasoningEffort.trim() || undefined
        : undefined;
    // Orchestrator guardrails are injected via system prompt, not file writes
    const orchestratorGuardrails = isOrchestrator
      ? launcher.getOrchestratorGuardrails(launcher.getPort(), backend)
      : undefined;

    const initialCwd = cwd || process.cwd();
    const binarySettings = getSettings();
    const launchOptions: LaunchOptions = {
      model,
      permissionMode: initialModeState.permissionMode,
      askPermission: initialModeState.askPermission,
      cwd: initialCwd,
      claudeBinary: body.claudeBinary || binarySettings.claudeBinary || undefined,
      codexBinary: body.codexBinary || binarySettings.codexBinary || undefined,
      codexInternetAccess: backend === "codex" && body.codexInternetAccess === true,
      codexSandbox: backend === "codex" && body.codexInternetAccess === true ? "danger-full-access" : "workspace-write",
      codexReasoningEffort,
      allowedTools: body.allowedTools,
      env: envVars,
      backendType: backend,
      containerId,
      containerName,
      containerImage,
      worktreeInfo,
      extraInstructions: orchestratorGuardrails,
    };

    return {
      launchOptions,
      initialModeState,
      initialCwd,
      isAssistantMode,
      isOrchestrator,
      envSlug: body.envSlug,
      createdBy: body.createdBy,
      worktreeInfo,
      containerInfo,
    };
  };

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const backendRaw = body.backend ?? "claude";
      const backend = resolveBackend(backendRaw);
      if (!backend) {
        return c.json({ error: `Invalid backend: ${String(backendRaw)}` }, 400);
      }

      const sessionConfig = await prepareSession(body, applyDefaultClaudeBackend(backend));
      const session = await launcher.launch(sessionConfig.launchOptions);
      applySessionPostLaunch(session, sessionConfig);
      return c.json(session);
    } catch (e: unknown) {
      if (e instanceof SessionPreparationError) {
        return c.json({ error: e.message }, e.status);
      }
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
      status: CreationProgressStatus,
      detail?: string,
    ) =>
      stream.writeSSE({
        event: "progress",
        data: JSON.stringify({ step, label, status, detail }),
      });

    return streamSSE(c, async (stream) => {
      try {
        const backendRaw = body.backend ?? "claude";
        const backend = resolveBackend(backendRaw);
        if (!backend) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: `Invalid backend: ${String(backendRaw)}` }),
          });
          return;
        }

        const sessionConfig = await prepareSession(body, applyDefaultClaudeBackend(backend), (step, label, status, detail) =>
          emitProgress(stream, step, label, status, detail),
        );

        await emitProgress(
          stream,
          "launching_cli",
          sessionConfig.resumeCliSessionId ? "Resuming CLI session..." : "Launching Claude Code...",
          "in_progress",
        );

        const session = await launcher.launch(sessionConfig.launchOptions);
        applySessionPostLaunch(session, sessionConfig);

        await emitProgress(
          stream,
          "launching_cli",
          sessionConfig.resumeCliSessionId ? "Session resumed" : "Session started",
          "done",
        );

        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            sessionId: session.sessionId,
            state: session.state,
            cwd: session.cwd,
          }),
        });
      } catch (e: unknown) {
        if (e instanceof SessionPreparationError) {
          const payload: Record<string, unknown> = { error: e.message };
          if (e.step) payload.step = e.step;
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify(payload),
          });
          return;
        }
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
      const backendFilter = c.req.query("backend") as "claude" | "codex" | undefined;

      // Collect active CLI session IDs so we can filter them out
      const activeCliSessionIds = new Set<string>();
      for (const s of launcher.listSessions()) {
        if (s.cliSessionId) activeCliSessionIds.add(s.cliSessionId);
      }

      interface CliSessionFile {
        id: string;
        path: string;
        lastModified: number;
        sizeBytes: number;
        backend: "claude" | "codex";
      }
      const allFiles: CliSessionFile[] = [];

      // ── Scan Claude Code sessions (~/.claude/projects/*/*.jsonl) ──
      if (backendFilter !== "codex") {
        const claudeProjectsDir = join(homedir(), ".claude", "projects");
        try {
          const projectDirs = await readdir(claudeProjectsDir);
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
              if (sessionId.startsWith("agent-")) continue;
              if (activeCliSessionIds.has(sessionId)) continue;

              const filePath = join(projectPath, entry);
              try {
                const st = await stat(filePath);
                allFiles.push({
                  id: sessionId,
                  path: filePath,
                  lastModified: st.mtimeMs,
                  sizeBytes: st.size,
                  backend: "claude",
                });
              } catch {
                continue;
              }
            }
          }
        } catch {
          // ~/.claude/projects may not exist — that's fine
        }
      }

      // ── Scan Codex sessions (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ──
      if (backendFilter !== "claude") {
        const codexSessionsDir = join(homedir(), ".codex", "sessions");
        try {
          // Walk YYYY/MM/DD directory structure
          const years = await readdir(codexSessionsDir);
          for (const year of years) {
            const yearPath = join(codexSessionsDir, year);
            let months: string[];
            try {
              months = await readdir(yearPath);
            } catch {
              continue;
            }
            for (const month of months) {
              const monthPath = join(yearPath, month);
              let days: string[];
              try {
                days = await readdir(monthPath);
              } catch {
                continue;
              }
              for (const day of days) {
                const dayPath = join(monthPath, day);
                let entries: string[];
                try {
                  entries = await readdir(dayPath);
                } catch {
                  continue;
                }
                for (const entry of entries) {
                  if (!entry.endsWith(".jsonl")) continue;
                  // Filename: rollout-{timestamp}-{threadId}.jsonl
                  // Extract threadId: everything after the last occurrence of the timestamp pattern
                  const match = entry.match(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-(.+)\.jsonl$/);
                  if (!match) continue;
                  const threadId = match[1];
                  if (activeCliSessionIds.has(threadId)) continue;

                  const filePath = join(dayPath, entry);
                  try {
                    const st = await stat(filePath);
                    allFiles.push({
                      id: threadId,
                      path: filePath,
                      lastModified: st.mtimeMs,
                      sizeBytes: st.size,
                      backend: "codex",
                    });
                  } catch {
                    continue;
                  }
                }
              }
            }
          }
        } catch {
          // ~/.codex/sessions may not exist — that's fine
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
                // Claude Code metadata
                if (obj.cwd && !cwd) cwd = obj.cwd;
                if (obj.slug && !slug) slug = obj.slug;
                if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;
                // Codex metadata (inside session_meta payload)
                if (obj.type === "session_meta" && obj.payload) {
                  const p = obj.payload;
                  if (p.cwd && !cwd) cwd = p.cwd;
                  if (p.git?.branch && !gitBranch) gitBranch = p.git.branch;
                }
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
            backend: f.backend,
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

  const buildEnrichedSessions = async (filterFn?: (s: ReturnType<CliLauncher["listSessions"]>[number]) => boolean) => {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const bridgeStates = wsBridge.getAllSessions();
    const bridgeMap = new Map(bridgeStates.map((state) => [state.session_id, state]));
    const pool = filterFn ? sessions.filter(filterFn) : sessions;
    return Promise.all(
      pool.map(async (s) => {
        try {
          const { sessionAuthToken: _token, ...safeSession } = s;
          const bridgeSession = wsBridge.getSession(s.sessionId);
          if (bridgeSession?.state?.is_worktree && !safeSession.archived) {
            await wsBridge.refreshWorktreeGitStateForSnapshot(s.sessionId, {
              broadcastUpdate: true,
              notifyPoller: true,
            });
          }
          const bridge = wsBridge.getSession(s.sessionId)?.state ?? bridgeMap.get(s.sessionId);
          const cliConnected = wsBridge.isBackendConnected(s.sessionId);
          const effectiveState = cliConnected && bridgeSession?.isGenerating ? "running" : safeSession.state;
          let gitAhead = bridge?.git_ahead || 0;
          let gitBehind = bridge?.git_behind || 0;
          // Worktree sessions are force-refreshed above so external git resets
          // clear stale +/- stats; non-worktree sessions still use cached bridge
          // values to avoid expensive git calls on every sidebar poll.
          return {
            ...safeSession,
            // Bridge model (from system.init) is more accurate than launcher model
            // (creation-time value, often empty for "default").
            model: bridge?.model || safeSession.model,
            state: effectiveState,
            sessionNum: launcher.getSessionNum(s.sessionId) ?? null,
            name: names[s.sessionId] ?? s.name,
            gitBranch: bridge?.git_branch || "",
            gitDefaultBranch: bridge?.git_default_branch || "",
            diffBaseBranch: bridge?.diff_base_branch || "",
            gitAhead,
            gitBehind,
            totalLinesAdded: bridge?.total_lines_added || 0,
            totalLinesRemoved: bridge?.total_lines_removed || 0,
            numTurns: bridge?.num_turns || 0,
            contextUsedPercent: bridge?.context_used_percent || 0,
            ...(bridge?.codex_token_details ? { codexTokenDetails: bridge.codex_token_details } : {}),
            ...(bridge?.claude_token_details ? { claudeTokenDetails: bridge.claude_token_details } : {}),
            lastMessagePreview: wsBridge.getLastUserMessage(s.sessionId) || "",
            cliConnected,
            taskHistory: wsBridge.getSessionTaskHistory(s.sessionId),
            keywords: wsBridge.getSessionKeywords(s.sessionId),
            claimedQuestId: bridge?.claimedQuestId ?? null,
            claimedQuestStatus: bridge?.claimedQuestStatus ?? null,
            ...(wsBridge.getSessionAttentionState(s.sessionId) ?? {}),
            // Worktree liveness status for archived worktree sessions
            // Only check existence (one async access() call), skip expensive git status
            ...(s.isWorktree && s.archived
              ? await (async () => {
                  let exists = false;
                  try {
                    await accessAsync(s.cwd);
                    exists = true;
                  } catch {
                    /* not found */
                  }
                  return { worktreeExists: exists };
                })()
              : {}),
          };
        } catch (e) {
          console.warn(`[routes] Failed to enrich session ${s.sessionId}:`, e);
          return { ...s, name: names[s.sessionId] ?? s.name };
        }
      }),
    );
  };

  const backfillSessionProjectMeta = async (
    info: { cwd: string; repoRoot?: string },
    bridgeSession?: { state?: { repo_root?: string; cwd?: string } } | null,
  ): Promise<void> => {
    if ((!info.cwd || !info.cwd.trim()) && bridgeSession?.state?.cwd) {
      info.cwd = bridgeSession.state.cwd;
    }
    if (info.repoRoot && info.repoRoot.trim()) return;
    const fromBridge = bridgeSession?.state?.repo_root?.trim();
    if (fromBridge) {
      info.repoRoot = fromBridge;
      return;
    }
    if (!info.cwd || !info.cwd.trim()) return;
    const inferred = await gitUtils.getRepoInfoAsync(info.cwd);
    if (inferred?.repoRoot) info.repoRoot = inferred.repoRoot;
  };

  api.get("/sessions", async (c) => {
    const enriched = await buildEnrichedSessions();
    return c.json(enriched);
  });

  api.get("/sessions/search", (c) => {
    const rawQuery = (c.req.query("q") || "").trim();
    if (!rawQuery) {
      return c.json({ error: "q is required" }, 400);
    }

    const limitParam = Number.parseInt(c.req.query("limit") || "50", 10);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 200)) : 50;

    const msgLimitParam = Number.parseInt(c.req.query("messageLimitPerSession") || "400", 10);
    const messageLimitPerSession = Number.isFinite(msgLimitParam) ? Math.max(50, Math.min(msgLimitParam, 2000)) : 400;

    const includeArchivedRaw = c.req.query("includeArchived");
    const includeArchived =
      includeArchivedRaw === undefined ? true : !["0", "false", "no"].includes(includeArchivedRaw.toLowerCase());

    const startedAt = Date.now();
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const bridgeStates = wsBridge.getAllSessions();
    const bridgeMap = new Map(bridgeStates.map((s) => [s.session_id, s]));

    const docs: SessionSearchDocument[] = sessions.map((s) => {
      const bridge = bridgeMap.get(s.sessionId);
      return {
        sessionId: s.sessionId,
        archived: !!s.archived,
        createdAt: s.createdAt || 0,
        lastActivityAt: s.lastActivityAt,
        name: names[s.sessionId] ?? s.name ?? "",
        taskHistory: wsBridge.getSessionTaskHistory(s.sessionId),
        keywords: wsBridge.getSessionKeywords(s.sessionId),
        gitBranch: bridge?.git_branch || "",
        cwd: bridge?.cwd || s.cwd || "",
        repoRoot: bridge?.repo_root || s.repoRoot || "",
        messageHistory: wsBridge.getMessageHistory(s.sessionId) || [],
      };
    });

    const { results, totalMatches } = searchSessionDocuments(docs, {
      query: rawQuery,
      limit,
      includeArchived,
      messageLimitPerSession,
    });

    return c.json({
      query: rawQuery,
      tookMs: Date.now() - startedAt,
      totalMatches,
      results,
    });
  });

  api.get("/sessions/:id", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({
      ...session,
      isGenerating: wsBridge.isSessionBusy(id),
    });
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

  api.patch("/sessions/order", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const groupKey = typeof body.groupKey === "string" ? body.groupKey.trim() : "";
    if (!groupKey) {
      return c.json({ error: "groupKey is required" }, 400);
    }
    if (!Array.isArray(body.orderedIds)) {
      return c.json({ error: "orderedIds must be an array" }, 400);
    }

    const orderedIds = body.orderedIds
      .filter((value: unknown): value is string => typeof value === "string")
      .map((value: string) => value.trim())
      .filter(Boolean);

    const sessionOrder = wsBridge.updateSessionOrder(groupKey, orderedIds);
    await sessionOrderStore.setAllOrder(sessionOrder);
    wsBridge.broadcastSessionOrderUpdate();
    return c.json({ ok: true, sessionOrder });
  });

  api.patch("/sessions/groups/order", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!Array.isArray(body.orderedGroupKeys)) {
      return c.json({ error: "orderedGroupKeys must be an array" }, 400);
    }

    const orderedGroupKeys = body.orderedGroupKeys
      .filter((value: unknown): value is string => typeof value === "string")
      .map((value: string) => value.trim())
      .filter(Boolean);

    const groupOrder = wsBridge.updateGroupOrder(orderedGroupKeys);
    await groupOrderStore.setAllOrder(groupOrder);
    wsBridge.broadcastGroupOrderUpdate();
    return c.json({ ok: true, groupOrder });
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
    if (!killed) return c.json({ error: "Session not found or already exited" }, 404);

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
      typeof body.callerSessionId === "string" &&
      body.callerSessionId.trim() &&
      body.callerSessionId.trim() !== auth.callerId
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

    // Preserve project metadata used for grouping. Some sessions only have repo
    // root in bridge state (derived from git), not in launcher state.
    const session = wsBridge.getSession(id);
    await backfillSessionProjectMeta(workerInfo, session);

    // Inject a visible system message into the worker's chat before stopping
    const leaderNum = launcher.getSessionNum(callerSessionId);
    const leaderName = sessionNames.getName(callerSessionId) || callerSessionId.slice(0, 8);
    const stopMsg = `Session stopped by leader #${leaderNum ?? "?"} ${leaderName}`;
    const ts = Date.now();
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

    const targetSession = session || wsBridge.getOrCreateSession(id, workerInfo.backendType || "claude");
    await wsBridge.routeExternalInterrupt(targetSession, "leader");

    return c.json({ ok: true, sessionId: id, stoppedBy: callerSessionId });
  });

  api.post("/sessions/:id/relaunch", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);
    await backfillSessionProjectMeta(info, wsBridge.getSession(id));

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
      const status =
        result.error && (result.error.includes("not found") || result.error.includes("Session not found")) ? 404 : 503;
      return c.json({ error: result.error || "Relaunch failed" }, status);
    }
    return c.json({ ok: true });
  });

  // ─── Transport Upgrade: WebSocket → SDK ───────────────────────
  api.post("/sessions/:id/upgrade-transport", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    console.log(`[transport] Upgrading session ${id.slice(0, 8)} from claude → claude-sdk`);
    const result = await launcher.upgradeToSdk(id);
    if (!result.ok) {
      console.log(`[transport] Upgrade failed for ${id.slice(0, 8)}: ${result.error}`);
      const status = result.error && result.error.includes("not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }

    // Update the ws-bridge session's backendType so it attaches the
    // SDK adapter (instead of expecting a WebSocket CLI connection).
    // Broadcast the change so all connected browsers update their UI
    // (e.g. context menu shows "Switch to WebSocket" instead of "Switch to SDK").
    const bridgeSession = wsBridge.getSession(id);
    if (bridgeSession) {
      bridgeSession.backendType = "claude-sdk";
      bridgeSession.state.backend_type = "claude-sdk";
      wsBridge.broadcastSessionUpdate(id, { backend_type: "claude-sdk" });
    }

    console.log(`[transport] Upgrade complete for ${id.slice(0, 8)}`);
    return c.json(result);
  });

  // ─── Transport Downgrade: SDK → WebSocket ─────────────────────
  api.post("/sessions/:id/downgrade-transport", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    console.log(`[transport] Downgrading session ${id.slice(0, 8)} from claude-sdk → claude`);
    const result = await launcher.downgradeToWebSocket(id);
    if (!result.ok) {
      console.log(`[transport] Downgrade failed for ${id.slice(0, 8)}: ${result.error}`);
      const status = result.error && result.error.includes("not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }

    // Update the ws-bridge session's backendType so it expects a WebSocket
    // CLI connection instead of an SDK adapter.
    // Broadcast so all browsers see the transport change immediately.
    const bridgeSession = wsBridge.getSession(id);
    if (bridgeSession) {
      bridgeSession.backendType = "claude";
      bridgeSession.state.backend_type = "claude";
      wsBridge.broadcastSessionUpdate(id, { backend_type: "claude" });
    }

    console.log(`[transport] Downgrade complete for ${id.slice(0, 8)}`);
    return c.json(result);
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
    session.pendingMessages.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "/compact" },
        parent_tool_use_id: null,
        session_id: info.cliSessionId,
      }),
    );

    // Notify browsers compaction is starting
    wsBridge.broadcastToSession(id, { type: "status_change", status: "compacting" });

    const result = await launcher.relaunch(id);
    if (!result.ok) {
      return c.json({ error: result.error || "Relaunch failed" }, 503);
    }
    return c.json({ ok: true });
  });

  api.post("/sessions/:id/skills/refresh", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (session.backendType !== "codex")
      return c.json({ error: "Skill refresh is only supported for Codex sessions" }, 400);

    const result = await wsBridge.refreshCodexSkills(id, true);
    if (!result.ok) {
      const status = result.error === "Session not found" ? 404 : 503;
      return c.json({ error: result.error || "Failed to refresh skills" }, status);
    }
    return c.json({ ok: true, skills: result.skills ?? [] });
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

    // Emit herd event BEFORE killing — after removal the session info
    // (including herdedBy) is no longer accessible.
    const deletedSessionInfo = launcher.getSession(id);
    if (deletedSessionInfo?.herdedBy) {
      wsBridge.emitTakodeEvent(id, "session_deleted", {});
    }

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

    // Emit herd event before killing — the leader needs to know a worker was archived.
    const archivedSessionInfo = launcher.getSession(id);
    if (archivedSessionInfo?.herdedBy) {
      wsBridge.emitTakodeEvent(id, "session_archived", {});
    }

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
      if (!existsSync(info.cwd)) {
        // sync-ok: route handler, not called during message handling
        try {
          const result = recreateWorktreeIfMissing(id, info, { launcher, worktreeTracker, wsBridge });
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
        wsBridge.markWorktree(id, info.repoRoot, info.cwd, undefined, info.branch);
      }
    }

    // Auto-relaunch the CLI so the session is immediately usable
    const relaunchResult = await launcher.relaunch(id);

    return c.json({ ok: true, worktreeRecreated, relaunch: relaunchResult });
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
      .filter((t) => t.action !== "revise") // revise entries update in-place, skip them
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

  // ─── Tool result lazy fetch ────────────────────────────────

  api.get("/sessions/:id/tool-result/:toolUseId", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);
    const toolUseId = c.req.param("toolUseId");

    const result = wsBridge.getToolResult(sessionId, toolUseId);
    if (!result) {
      return c.json({ error: "Tool result not found" }, 404);
    }

    trafficStats.recordToolResultFetch({
      sessionId,
      toolUseId,
      payloadBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
      isError: result.is_error,
    });

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
    const path = thumbPath || (await imageStore.getOriginalPath(sessionId, imageId));
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

  return api;
}
