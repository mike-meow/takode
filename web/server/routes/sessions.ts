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
import * as treeGroupStore from "../tree-group-store.js";
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
import type { HerdSessionsResponse } from "../../shared/herd-types.js";
import type { RouteContext, OptionalAuthResult } from "./context.js";

/** Extract the caller's session ID from an optional auth result, if available. */
function getActorSessionId(auth: OptionalAuthResult): string | undefined {
  return auth && "callerId" in auth ? auth.callerId : undefined;
}

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
    authenticateCompanionCallerOptional,
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
    options?: { archiveBranch?: boolean },
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

    const managedBranch =
      mapping.actualBranch && mapping.actualBranch !== mapping.branch ? mapping.actualBranch : undefined;

    // Archive path (q-329): save the branch tip as a lightweight ref under
    // refs/companion/archived/ so it doesn't appear in `git branch` output
    // but can be restored on unarchive. Then delete the branch normally.
    if (options?.archiveBranch && managedBranch) {
      gitUtils.archiveBranch(mapping.repoRoot, managedBranch);
      // archiveBranch already deleted the branch, so skip branchToDelete
      const result = gitUtils.removeWorktree(mapping.repoRoot, mapping.worktreePath, {
        force: dirty,
      });
      if (result.removed) {
        worktreeTracker.removeBySession(sessionId);
      }
      return { cleaned: result.removed, path: mapping.worktreePath };
    }

    // Permanent delete: remove worktree and delete the branch
    const result = gitUtils.removeWorktree(mapping.repoRoot, mapping.worktreePath, {
      force: dirty,
      branchToDelete: managedBranch,
    });
    if (result.removed) {
      worktreeTracker.removeBySession(sessionId);
    }
    return { cleaned: result.removed, path: mapping.worktreePath };
  }

  function buildCodexTurnSegments(
    messageHistory: Array<{ type: string; id?: string }>,
  ): Array<{ startIdx: number; userMessageIds: string[] }> {
    const segments: Array<{ startIdx: number; userMessageIds: string[] }> = [];
    let startIdx: number | null = null;
    let userMessageIds: string[] = [];

    for (let idx = 0; idx < messageHistory.length; idx++) {
      const msg = messageHistory[idx];
      if (msg.type === "user_message") {
        if (startIdx === null) startIdx = idx;
        if (typeof msg.id === "string") userMessageIds.push(msg.id);
      }
      if (msg.type === "result" && startIdx !== null) {
        segments.push({ startIdx, userMessageIds: [...userMessageIds] });
        startIdx = null;
        userMessageIds = [];
      }
    }

    if (startIdx !== null) {
      segments.push({ startIdx, userMessageIds: [...userMessageIds] });
    }

    return segments;
  }

  function computeCodexRevertPlan(
    session: {
      messageHistory: Array<{ type: string; id?: string }>;
    },
    messageId: string,
  ): { truncateIdx: number; numTurns: number; exactTurnBoundary: boolean } | null {
    const segments = buildCodexTurnSegments(session.messageHistory);
    const targetTurnIndex = segments.findIndex((segment) => segment.userMessageIds.includes(messageId));
    if (targetTurnIndex < 0) return null;

    const targetSegment = segments[targetTurnIndex]!;
    return {
      truncateIdx: targetSegment.startIdx,
      numTurns: segments.length - targetTurnIndex,
      exactTurnBoundary: targetSegment.userMessageIds[0] === messageId,
    };
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
    noAutoName?: boolean;
    fixedName?: string;
    /** Session number of the parent worker this reviewer is reviewing */
    reviewerOf?: number;
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
      session.noAutoName = true; // Leaders handle multiple quests; autonamer would pick a misleading name
      markOrchestratorSession(session.sessionId, sessionConfig.launchOptions.backendType || "claude");
    }
    if (sessionConfig.envSlug) session.envSlug = sessionConfig.envSlug;
    if (sessionConfig.noAutoName) session.noAutoName = true;
    if (sessionConfig.reviewerOf !== undefined) session.reviewerOf = sessionConfig.reviewerOf;

    if (sessionConfig.isAssistantMode) {
      sessionNames.setName(session.sessionId, "Takode");
    } else if (sessionConfig.isOrchestrator) {
      sessionNames.setName(session.sessionId, `Leader ${sessionNames.getNextLeaderNumber()}`);
    } else if (sessionConfig.fixedName) {
      sessionNames.setName(session.sessionId, sessionConfig.fixedName);
    } else {
      const existingNames = new Set(Object.values(sessionNames.getAllNames()));
      sessionNames.setName(session.sessionId, generateUniqueSessionName(existingNames));
    }

    if (sessionConfig.createdBy) {
      const creatorId = resolveId(String(sessionConfig.createdBy));
      const creator = creatorId ? launcher.getSession(creatorId) : null;
      if (creator?.isOrchestrator) {
        launcher.herdSessions(creator.sessionId, [session.sessionId]);
        // Auto-assign new worker to leader's tree group
        treeGroupStore
          .getGroupForSession(creator.sessionId)
          .then((leaderGroup) => {
            if (leaderGroup) {
              treeGroupStore
                .assignSession(session.sessionId, leaderGroup)
                .then(() => broadcastTreeGroups())
                .catch((err) => {
                  console.warn("[tree-group] failed to assign worker to leader group:", err);
                });
            }
          })
          .catch((err) => {
            console.warn("[tree-group] failed to lookup leader group:", err);
          });
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
      if (!(await pathExists(cwd))) {
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

    if (body.useWorktree && !isOrchestrator) {
      const worktreeBaseCwd = cwd;
      if (!worktreeBaseCwd) {
        throwPreparationError("Worktree mode requires a cwd", 400, "creating_worktree");
      }
      await emit("creating_worktree", "Creating worktree...", "in_progress");
      const repoInfo = await gitUtils.getRepoInfoAsync(worktreeBaseCwd as string);
      if (!repoInfo) {
        throwPreparationError("Worktree mode requires a git repository", 400, "creating_worktree");
      } else {
        // When the CWD is already inside a worktree (e.g. a leader spawning a worker),
        // use the base branch so the new worktree branches off the same parent --
        // not the leader's worktree branch (which would create a worktree-of-a-worktree).
        const targetBranch = body.branch || (repoInfo.isWorktree ? repoInfo.defaultBranch : repoInfo.currentBranch);
        if (!targetBranch) {
          throwPreparationError("Unable to determine branch for worktree session", 400, "creating_worktree");
        }
        const result = await gitUtils.ensureWorktreeAsync(repoInfo.repoRoot, targetBranch, {
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
      const repoInfo = await gitUtils.getRepoInfoAsync(cwd);
      if (repoInfo) {
        await emit("fetching_git", "Fetching from remote...", "in_progress");
        const fetchResult = await gitUtils.gitFetchAsync(repoInfo.repoRoot);
        if (!fetchResult.success) {
          console.warn(`[routes] git fetch warning (non-fatal): ${fetchResult.output}`);
          await emit("fetching_git", "Fetch skipped (offline or auth issue)", "done");
        } else {
          await emit("fetching_git", "Fetch complete", "done");
        }

        if (repoInfo.currentBranch !== body.branch) {
          await emit("checkout_branch", `Checking out ${body.branch}...`, "in_progress");
          try {
            await gitUtils.checkoutBranchAsync(repoInfo.repoRoot, body.branch);
            await emit("checkout_branch", `On branch ${body.branch}`, "done");
          } catch (err) {
            console.warn(`[routes] git checkout warning (non-fatal, repo may have uncommitted changes): ${err}`);
            await emit("checkout_branch", "Checkout skipped (uncommitted changes)", "done");
          }
        }

        await emit("pulling_git", "Pulling latest changes...", "in_progress");
        const pullResult = await gitUtils.gitPullAsync(repoInfo.repoRoot);
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
              if (!(await pathExists(dockerfilePath))) {
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
    const orchestratorGuardrails = isOrchestrator ? launcher.getOrchestratorGuardrails(backend) : undefined;

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
      noAutoName: body.noAutoName === true,
      fixedName: typeof body.fixedName === "string" ? body.fixedName.trim() : undefined,
      reviewerOf: typeof body.reviewerOf === "number" ? body.reviewerOf : undefined,
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

      // Enforce one-reviewer-per-parent at the server level (prevents TOCTOU races
      // where two concurrent CLI spawn commands both pass the client-side check).
      if (typeof body.reviewerOf === "number") {
        const existing = launcher.listSessions().find((s) => !s.archived && s.reviewerOf === body.reviewerOf);
        if (existing) {
          const label = launcher.getSessionNum(existing.sessionId);
          return c.json(
            {
              error: `Session #${body.reviewerOf} already has an active reviewer${label !== undefined ? ` (#${label})` : ""}`,
            },
            409,
          );
        }
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

        const sessionConfig = await prepareSession(
          body,
          applyDefaultClaudeBackend(backend),
          (step, label, status, detail) => emitProgress(stream, step, label, status, detail),
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
    const heavyRepoModeEnabled = getSettings().heavyRepoModeEnabled;
    return Promise.all(
      pool.map(async (s) => {
        try {
          const { sessionAuthToken: _token, injectedSystemPrompt: _prompt, ...safeSession } = s;
          const bridgeSession = wsBridge.getSession(s.sessionId);
          if (bridgeSession?.state?.is_worktree && !safeSession.archived && !heavyRepoModeEnabled) {
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
            messageHistoryBytes: bridge?.message_history_bytes || 0,
            codexRetainedPayloadBytes: bridge?.codex_retained_payload_bytes || 0,
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
    const { injectedSystemPrompt: _prompt, ...rest } = session;
    return c.json({
      ...rest,
      isGenerating: wsBridge.isSessionBusy(id),
    });
  });

  // Dedicated endpoint for the injected system prompt (fetched on-demand by Session Info panel)
  api.get("/sessions/:id/system-prompt", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ prompt: session.injectedSystemPrompt ?? null });
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

  // ─── Tree Groups (herd-centric grouping) ─────────────────────────────

  /** Helper: broadcast current tree group state to all browsers. */
  async function broadcastTreeGroups() {
    const tgs = await treeGroupStore.getState();
    wsBridge.broadcastTreeGroupsUpdate(tgs.groups, tgs.assignments, tgs.nodeOrder);
  }

  api.get("/tree-groups", async (c) => {
    const state = await treeGroupStore.getState();
    return c.json(state);
  });

  api.put("/tree-groups", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid body" }, 400);
    }
    await treeGroupStore.setState(body);
    await broadcastTreeGroups();
    return c.json({ ok: true });
  });

  api.post("/tree-groups/groups", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 200) {
      return c.json({ error: "Group name must be 1-200 characters" }, 400);
    }
    const group = await treeGroupStore.createGroup(name);
    await broadcastTreeGroups();
    return c.json({ ok: true, group });
  });

  api.patch("/tree-groups/groups/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 200) {
      return c.json({ error: "Group name must be 1-200 characters" }, 400);
    }
    const ok = await treeGroupStore.renameGroup(id, name);
    if (!ok) return c.json({ error: "Group not found or is default" }, 404);
    await broadcastTreeGroups();
    return c.json({ ok: true });
  });

  api.delete("/tree-groups/groups/:id", async (c) => {
    const id = c.req.param("id");
    const ok = await treeGroupStore.deleteGroup(id);
    if (!ok) return c.json({ error: "Cannot delete default group" }, 400);
    await broadcastTreeGroups();
    return c.json({ ok: true });
  });

  api.patch("/tree-groups/assign", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const groupId = typeof body.groupId === "string" ? body.groupId : "";
    if (!sessionId || !groupId) {
      return c.json({ error: "sessionId and groupId are required" }, 400);
    }
    await treeGroupStore.assignSession(sessionId, groupId);
    await broadcastTreeGroups();
    return c.json({ ok: true });
  });

  api.patch("/tree-groups/node-order", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const groupId = typeof body.groupId === "string" ? body.groupId : "";
    const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds : [];
    if (!groupId) {
      return c.json({ error: "groupId is required" }, 400);
    }
    await treeGroupStore.setNodeOrder(groupId, orderedIds);
    await broadcastTreeGroups();
    return c.json({ ok: true });
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

  // Leader-initiated interrupt: halt a herded worker's current turn so the
  // leader can redirect.
  const handleInterrupt = async (c: any) => {
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

    // Herd guard: only the herding leader can interrupt
    const workerInfo = launcher.getSession(id);
    if (!workerInfo) return c.json({ error: "Session not found" }, 404);
    if (!callerSessionId || workerInfo.herdedBy !== callerSessionId) {
      return c.json({ error: "Only the leader who herded this session can interrupt it" }, 403);
    }

    // Preserve project metadata used for grouping. Some sessions only have repo
    // root in bridge state (derived from git), not in launcher state.
    const session = wsBridge.getSession(id);
    await backfillSessionProjectMeta(workerInfo, session);

    // Inject a visible system message into the worker's chat before interrupting
    const leaderNum = launcher.getSessionNum(callerSessionId);
    const leaderName = sessionNames.getName(callerSessionId) || callerSessionId.slice(0, 8);
    const interruptMsg = `Session interrupted by leader #${leaderNum ?? "?"} ${leaderName}`;
    const ts = Date.now();
    if (session) {
      const historyEntry = {
        type: "user_message" as const,
        content: interruptMsg,
        timestamp: ts,
        id: `interrupt-${ts}`,
        agentSource: { sessionId: callerSessionId, sessionLabel: `#${leaderNum ?? "?"} ${leaderName}` },
      };
      session.messageHistory.push(historyEntry as any);
      wsBridge.broadcastToSession(id, historyEntry as any);
    }

    const targetSession = session || wsBridge.getOrCreateSession(id, workerInfo.backendType || "claude");
    await wsBridge.routeExternalInterrupt(targetSession, "leader");

    return c.json({ ok: true, sessionId: id, interruptedBy: callerSessionId });
  };
  api.post("/sessions/:id/interrupt", handleInterrupt);

  // Browser-initiated herd action. Unlike the Takode route, this endpoint is
  // called by the local web UI and therefore cannot rely on Takode auth
  // headers; it validates the requested leader session directly instead.
  api.post("/sessions/:id/herd-to", async (c) => {
    const workerId = resolveId(c.req.param("id"));
    if (!workerId) return c.json({ error: "Worker session not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const leaderId = typeof body.leaderSessionId === "string" ? resolveId(body.leaderSessionId) : null;
    if (!leaderId) return c.json({ error: "Leader session not found" }, 404);
    if (body.force !== undefined && typeof body.force !== "boolean") {
      return c.json({ error: "force must be a boolean" }, 400);
    }

    const leaderInfo = launcher.getSession(leaderId);
    if (!leaderInfo) return c.json({ error: "Leader session not found" }, 404);
    if (!leaderInfo.isOrchestrator) return c.json({ error: "Session is not an orchestrator" }, 403);

    const result = launcher.herdSessions(leaderId, [workerId], body.force === true ? { force: true } : undefined);
    if (result.notFound.length > 0) {
      return c.json({ error: "Worker session not found" }, 404);
    }
    if (result.leaders.length > 0) {
      return c.json({ error: "Cannot herd a leader session" }, 400);
    }
    if (result.conflicts.length > 0) {
      return c.json({ error: `Session is already herded by ${result.conflicts[0].herder}` }, 409);
    }
    if (result.herded.length === 0) {
      return c.json({ error: "Failed to herd session" }, 500);
    }

    return c.json(result as HerdSessionsResponse);
  });

  api.post("/sessions/:id/relaunch", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);
    await backfillSessionProjectMeta(info, wsBridge.getSession(id));

    // Worktree sessions: validate the worktree still exists and isn't used by another session
    if (info.isWorktree && info.repoRoot && info.branch) {
      const cwdExists = await pathExists(info.cwd);
      const usedByOther = worktreeTracker.isWorktreeInUse(info.cwd, id);

      if (!cwdExists || usedByOther) {
        // Recreate the worktree at a new unique path
        const wt = await gitUtils.ensureWorktreeAsync(info.repoRoot, info.branch, { forceNew: true });
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
    // SDK sessions flush pendingMessages through adapter.sendBrowserMessage()
    // (browser format), WebSocket sessions flush through sendToCLI() (NDJSON).
    const session = wsBridge.getOrCreateSession(id);
    if (info.backendType === "claude-sdk") {
      session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "/compact" }));
    } else {
      session.pendingMessages.push(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "/compact" },
          parent_tool_use_id: null,
          session_id: info.cliSessionId,
        }),
      );
    }

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

    const session = wsBridge.getOrCreateSession(id);

    console.log(
      `[revert] === REVERT START === session=${id.slice(0, 8)} messageId=${body.messageId} cliSessionId=${info.cliSessionId} historyLen=${session.messageHistory.length}`,
    );

    // Find the target user message in history
    const targetIdx = session.messageHistory.findIndex(
      (m: any) => m.type === "user_message" && (m as { id?: string }).id === body.messageId,
    );
    if (targetIdx < 0) {
      console.log(
        `[revert] Message not found. Available user messages: ${JSON.stringify(
          session.messageHistory
            .map((m: any, i: number) => (m.type === "user_message" ? { idx: i, id: (m as { id?: string }).id } : null))
            .filter(Boolean),
        )}`,
      );
      return c.json({ error: "Message not found in history" }, 404);
    }
    console.log(`[revert] Found target user message at index ${targetIdx} of ${session.messageHistory.length}`);

    let truncateIdx = targetIdx;
    let codexRollbackTurns: number | null = null;
    if (info.backendType === "codex") {
      const codexPlan = computeCodexRevertPlan(session, body.messageId);
      if (!codexPlan) {
        return c.json({ error: "Message not found in Codex turn history" }, 404);
      }
      if (!codexPlan.exactTurnBoundary) {
        const error =
          "Codex revert only supports the first user message in a Codex turn. This message shares a turn with earlier input; revert the first message in that turn instead.";
        wsBridge.broadcastToSession(id, { type: "error", message: error });
        return c.json({ error }, 409);
      }
      truncateIdx = codexPlan.truncateIdx;
      codexRollbackTurns = codexPlan.numTurns;
      console.log(
        `[revert] Codex rollback plan: truncateIdx=${truncateIdx} numTurns=${codexRollbackTurns} (messageId=${body.messageId})`,
      );
    }

    // Find the preceding assistant message with a UUID for --resume-session-at
    let assistantUuid: string | undefined;
    if (info.backendType !== "codex") {
      for (let i = truncateIdx - 1; i >= 0; i--) {
        const m = session.messageHistory[i];
        if (m.type === "assistant" && (m as { uuid?: string }).uuid) {
          assistantUuid = (m as { uuid?: string }).uuid;
          console.log(`[revert] Found preceding assistant UUID=${assistantUuid} at index ${i}`);
          break;
        }
      }
      if (!assistantUuid) {
        console.log(
          `[revert] No preceding assistant UUID found. Message types before target: ${session.messageHistory
            .slice(0, truncateIdx)
            .map(
              (m: any, i: number) =>
                `${i}:${m.type}${m.type === "assistant" ? `(uuid=${(m as { uuid?: string }).uuid ?? "NONE"})` : ""}`,
            )
            .join(", ")}`,
        );
      }
    }

    // Notify browsers that revert is in progress
    wsBridge.broadcastToSession(id, { type: "status_change", status: "reverting" });

    try {
      if (info.backendType === "codex") {
        console.log(`[revert] Rolling back Codex thread by ${codexRollbackTurns} turn(s)`);
        const { promise, requiresRelaunch } = wsBridge.beginCodexRollback(id, {
          numTurns: codexRollbackTurns || 1,
          truncateIdx,
          clearCodexState: true,
        });
        if (requiresRelaunch && info.state !== "starting") {
          const result = await launcher.relaunch(id);
          if (!result.ok) {
            wsBridge.broadcastToSession(id, { type: "status_change", status: "idle" });
            const error = result.error || "Relaunch failed";
            wsBridge.broadcastToSession(id, { type: "error", message: error });
            return c.json({ error }, 503);
          }
        }
        await Promise.race([
          promise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for Codex rollback")), 10_000)),
        ]);
      } else {
        // Kill CLI and relaunch with --resume-session-at to truncate CLI's history
        let result: { ok: boolean; error?: string };
        if (assistantUuid) {
          console.log(`[revert] Relaunching with --resume-session-at ${assistantUuid}`);
          result = await launcher.relaunchWithResumeAt(id, assistantUuid);
        } else {
          // Reverting the first user message — start fresh
          console.log(`[revert] No assistant UUID: clearing cliSessionId and relaunching fresh`);
          info.cliSessionId = undefined;
          result = await launcher.relaunch(id);
        }

        if (!result.ok) {
          console.log(`[revert] Relaunch FAILED: ${result.error}`);
          const error = result.error || "Relaunch failed";
          wsBridge.broadcastToSession(id, { type: "status_change", status: "idle" });
          wsBridge.broadcastToSession(id, { type: "error", message: error });
          return c.json({ error }, 503);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`[revert] Backend rollback FAILED: ${error}`);
      wsBridge.broadcastToSession(id, { type: "status_change", status: "idle" });
      wsBridge.broadcastToSession(id, { type: "error", message: error });
      return c.json({ error }, 503);
    }

    if (info.backendType === "codex") {
      const revertedSession = wsBridge.getSession(id);
      console.log(
        `[revert] Backend revert succeeded. Codex history now has ${revertedSession?.messageHistory.length ?? 0} msgs`,
      );
    } else {
      const revertedSession = wsBridge.prepareSessionForRevert(id, truncateIdx);
      if (!revertedSession) {
        wsBridge.broadcastToSession(id, { type: "status_change", status: "idle" });
        return c.json({ error: "Session not found" }, 404);
      }
      console.log(
        `[revert] Truncated server messageHistory to ${revertedSession.messageHistory.length} entries (frozenCount=${revertedSession.frozenCount})`,
      );

      // Persist immediately (don't rely on debounce — crash would lose truncation)
      wsBridge.persistSessionSync(id);
      console.log(
        `[revert] Backend revert succeeded. Broadcasting truncated history (${revertedSession.messageHistory.length} msgs)`,
      );

      // Broadcast updated (truncated) history to all browsers
      wsBridge.broadcastToSession(id, { type: "message_history", messages: revertedSession.messageHistory });
      wsBridge.broadcastToSession(id, { type: "status_change", status: "idle" });
    }

    console.log(`[revert] === REVERT COMPLETE === session=${id.slice(0, 8)}`);
    return c.json({ ok: true });
  });

  api.delete("/sessions/:id", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);

    // If not already archived, emit session_archived so the leader gets a
    // herd notification through the same proven path as explicit archiving.
    // Must happen BEFORE kill -- after removal the session info is gone.
    const sessionInfo = launcher.getSession(id);
    if (sessionInfo?.herdedBy && !sessionInfo.archived) {
      const actorId = getActorSessionId(authenticateCompanionCallerOptional(c));
      wsBridge.emitTakodeEvent(id, "session_archived", {}, actorId);
    }

    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    const worktreeResult = cleanupWorktree(id, true);
    // Clean up any stale archived ref from a previous archive cycle (q-329)
    if (sessionInfo?.isWorktree && sessionInfo.repoRoot && sessionInfo.actualBranch) {
      gitUtils.deleteArchivedRef(sessionInfo.repoRoot, sessionInfo.actualBranch);
    }
    prPoller?.unwatch(id);
    launcher.removeSession(id);
    // Broadcast deletion to all browsers BEFORE closing the session sockets.
    // This ensures every browser tab (not just the one that triggered delete)
    // removes the session from the sidebar immediately.
    wsBridge.broadcastGlobal({ type: "session_deleted", session_id: id });
    wsBridge.closeSession(id);
    await imageStore?.removeSession(id);
    // Clean up tree group assignment (fire-and-forget)
    treeGroupStore.removeSession(id).catch((err) => {
      console.warn("[tree-group] cleanup failed for session:", id, err);
    });
    return c.json({ ok: true, worktree: worktreeResult });
  });

  // Shared helper: archive a single session (kill, cleanup, persist).
  // Used by both /archive and /archive-group endpoints.
  async function archiveSingleSession(id: string, actorSessionId?: string) {
    // Emit herd event before killing -- the leader needs to know a worker was archived.
    const archivedSessionInfo = launcher.getSession(id);
    if (archivedSessionInfo?.herdedBy) {
      wsBridge.emitTakodeEvent(id, "session_archived", {}, actorSessionId);
    }

    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    // Stop PR polling for this session
    prPoller?.unwatch(id);

    // Force-delete the worktree directory on archive. The branch tip is saved
    // as an archived ref (refs/companion/archived/) so committed work can be
    // restored on unarchive without polluting the active branch list (q-329).
    const worktreeResult = cleanupWorktree(id, true, { archiveBranch: true });
    launcher.setArchived(id, true);
    await sessionStore.setArchived(id, true);

    // Cancel all session-scoped timers when archiving.
    if (ctx.timerManager) {
      void ctx.timerManager.cancelAllTimers(id);
    }

    // Auto-stop reviewer sessions tied to this parent.
    // Reviewer sessions are temporary quality gates -- when the parent worker is
    // archived, the reviewer is no longer useful and should be cleaned up.
    // listSessions() returns a new array (Array.from), and kill() only mutates
    // session.state without removing from the sessions map, so iteration is safe.
    const archivedNum = launcher.getSessionNum(id);
    if (archivedNum !== undefined) {
      const allSessions = launcher.listSessions();
      for (const s of allSessions) {
        if (s.reviewerOf === archivedNum && !s.archived) {
          console.log(`[routes] Auto-stopping reviewer session ${s.sessionId} (reviewerOf=#${archivedNum})`);
          await launcher.kill(s.sessionId);
          containerManager.removeContainer(s.sessionId);
          cleanupWorktree(s.sessionId, true);
          launcher.setArchived(s.sessionId, true);
          await sessionStore.setArchived(s.sessionId, true);
          // Emit after kill so the leader doesn't query a still-alive session
          if (s.herdedBy) {
            wsBridge.emitTakodeEvent(s.sessionId, "session_archived", {});
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
