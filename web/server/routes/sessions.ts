import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { resolveBinary, expandTilde } from "../path-resolver.js";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { CliLauncher, LaunchOptions } from "../cli-launcher.js";
import * as envManager from "../env-manager.js";
import * as gitUtils from "../git-utils.js";
import * as sessionNames from "../session-names.js";
import * as treeGroupStore from "../tree-group-store.js";
import * as newSessionDefaultsStore from "../new-session-defaults-store.js";
import { containerManager, ContainerManager, type ContainerConfig, type ContainerInfo } from "../container-manager.js";
import type { CreationStepId, TakodeSessionArchivedEventData } from "../session-types.js";
import { hasContainerClaudeAuth } from "../claude-container-auth.js";
import { hasContainerCodexAuth } from "../codex-container-auth.js";
import { getSettings, getClaudeUserDefaultModel, getServerId } from "../settings-manager.js";
import { buildReadResponse } from "../takode-messages.js";
import { ensureAssistantWorkspace, ASSISTANT_DIR } from "../assistant-workspace.js";
import { trafficStats } from "../traffic-stats.js";
import { generateUniqueSessionName } from "../../src/utils/names.js";
import type { HerdSessionsResponse } from "../../shared/herd-types.js";
import type { RouteContext, OptionalAuthResult } from "./context.js";
import { resolveSessionCreateModel } from "./session-create-model.js";
import {
  applyInitialSessionState as applyInitialSessionStateController,
  clearAttentionAndMarkRead as clearAttentionAndMarkReadController,
  markSessionUnread as markSessionUnreadController,
} from "../bridge/session-registry-controller.js";
import {
  refreshGitInfoPublic as refreshGitInfoPublicController,
  setDiffBaseBranch as setDiffBaseBranchController,
} from "../bridge/session-git-state.js";
import {
  SessionBackend,
  SessionPreparationError,
  SessionPreparationStatus,
  applyDefaultClaudeBackend,
  computeCodexRevertPlan,
  getActorSessionId,
  getArchiveSource,
  markOrchestratorSessionAfterConnect,
  resolveBackend,
  throwPreparationError,
} from "./sessions-helpers.js";
import { registerSessionsArchiveRoutes } from "./sessions-archive-routes.js";
import { withProgressHeartbeat } from "./progress-heartbeat.js";
import { cleanupWorktree, createArchivedWorktreeCleanupQueue } from "./worktree-cleanup.js";
import { buildEnrichedSessionsSnapshot } from "./session-list-snapshot.js";
import { registerSessionMessageSearchRoute } from "./session-message-search-route.js";
import { parseIncludeArchived, registerSessionSearchRoute } from "./session-search-route.js";
import { registerSessionPermissionModeRoute, resolveCodexSandboxForPermissionMode } from "./session-permission-mode.js";
import { registerSessionPauseRoutes } from "./session-pause-routes.js";
import { registerSessionLeaderProfileRoute } from "./session-leader-profile-route.js";
import { registerSessionReplacementRoutes } from "./session-replacement-routes.js";
import { registerSessionNotificationContextRoute } from "./session-notification-context.js";
import { registerSessionImageRoutes } from "./session-image-routes.js";
import { prepareWorktreeForSessionCreate, type WorktreeSessionInfo } from "./session-worktree-create.js";
import { chooseRandomLeaderProfilePortraitId } from "../leader-profile-assignments.js";
import { isSessionPaused } from "../session-pause.js";
import { LEADER_KICKOFF_SOURCE_ID, LEADER_KICKOFF_SOURCE_LABEL } from "../../shared/injected-event-message.js";
import { COMPANION_MEMORY_SPACE_SLUG_ENV, normalizeMemorySessionSpaceSlug } from "../memory-session-space.js";
import { registerSessionSlackThreadRoutes } from "./session-slack-thread-routes.js";

export function createSessionsRoutes(ctx: RouteContext) {
  const api = new Hono();
  const bridgeAny = ctx.wsBridge as any;
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
    pathExists,
    WEB_DIR,
    buildOrchestratorSystemPrompt,
    resolveInitialModeState,
  } = ctx;
  const pendingWorktreeCleanups = new Map<string, Promise<void>>();
  const sessionAttentionDeps = {
    broadcastToBrowsers: (session: NonNullable<ReturnType<typeof wsBridge.getSession>>, msg: unknown) =>
      wsBridge.broadcastToSession(session.id, msg as any),
    persistSession: (session: NonNullable<ReturnType<typeof wsBridge.getSession>>) =>
      wsBridge.persistSessionById(session.id),
  };
  const sessionUnreadDeps = {
    ...sessionAttentionDeps,
    isHerdedWorkerSession: (session: NonNullable<ReturnType<typeof wsBridge.getSession>>) =>
      !!launcher.getSession(session.id)?.herdedBy,
  };
  const getSessionGitDeps = () => bridgeAny.getSessionGitStateDeps?.();
  const setDiffBaseBranch = (sessionId: string, branch: string): boolean => {
    const session = wsBridge.getSession(sessionId);
    const deps = getSessionGitDeps();
    if (session && deps) {
      setDiffBaseBranchController(session as any, branch, deps);
      return true;
    }
    return bridgeAny.setDiffBaseBranch?.(sessionId, branch) ?? false;
  };
  const applyInitialSessionState = (
    sessionId: string,
    options: Parameters<typeof applyInitialSessionStateController>[1],
  ): void => {
    const session = wsBridge.getOrCreateSession(sessionId);
    const prefill = bridgeAny.prefillSlashCommands;
    if (session && typeof prefill === "function") {
      applyInitialSessionStateController(session as any, options, {
        persistSession: (targetSession) => wsBridge.persistSessionById((targetSession as any).id),
        prefillSlashCommands: (targetSession) => prefill.call(bridgeAny, targetSession),
      });
      return;
    }
    bridgeAny.applyInitialSessionState?.(sessionId, options);
  };

  const queueArchivedWorktreeCleanup = createArchivedWorktreeCleanupQueue({
    launcher,
    pendingWorktreeCleanups,
    worktreeTracker,
  });

  // ─── SDK Sessions (--sdk-url) ─────────────────────────────────────
  type CreationProgressStatus = "in_progress" | "done" | "error";
  type EmitCreationProgress = (
    step: CreationStepId,
    label: string,
    status: CreationProgressStatus,
    detail?: string,
  ) => Promise<void>;

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
    treeGroupId?: string;
    treeGroupExplicitlyRequested: boolean;
    worktreeInfo?: WorktreeSessionInfo;
    containerInfo?: ContainerInfo;
    resumeCliSessionId?: string;
    memorySessionSpaceSlug: string;
  }

  const markOrchestratorSession = (sessionId: string, backend: SessionBackend) =>
    markOrchestratorSessionAfterConnect({ launcher, wsBridge }, sessionId, buildOrchestratorSystemPrompt(backend), {
      sessionId: LEADER_KICKOFF_SOURCE_ID,
      sessionLabel: LEADER_KICKOFF_SOURCE_LABEL,
    });

  /** Helper: broadcast current tree group state to all browsers. */
  async function broadcastTreeGroups() {
    const tgs = await treeGroupStore.getState();
    wsBridge.broadcastGlobal({
      type: "tree_groups_update",
      treeGroups: tgs.groups,
      treeAssignments: tgs.assignments,
      treeNodeOrder: tgs.nodeOrder,
    } as any);
  }

  const normalizeTreeGroupId = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
  };

  const memorySessionSpaceSlugForTreeGroup = (
    treeState: Awaited<ReturnType<typeof treeGroupStore.getState>>,
    groupId: string | undefined,
  ): string | undefined => {
    const normalizedGroupId = normalizeDurableTreeGroupId(groupId);
    if (normalizedGroupId === "default") return normalizeMemorySessionSpaceSlug(launcher.getMemorySessionSpaceSlug());
    const group = treeState.groups.find((candidate) => candidate.id === normalizedGroupId);
    if (!group) return undefined;
    return normalizeMemorySessionSpaceSlug(group.name);
  };

  const resolveInitialTreeGroupIdForCreate = async (body: any): Promise<string | undefined> => {
    const requestedGroupId = await validateRequestedTreeGroupId(body.treeGroupId);
    if (requestedGroupId) return requestedGroupId;
    const creatorId = body.createdBy ? resolveId(String(body.createdBy)) : undefined;
    if (!creatorId) return undefined;
    return getCurrentSessionTreeGroupId(creatorId);
  };

  const resolveMemorySessionSpaceSlugForCreate = async (
    body: any,
    treeGroupId: string | undefined,
  ): Promise<string> => {
    if (body.memorySessionSpaceSlug !== undefined && typeof body.memorySessionSpaceSlug !== "string") {
      throwPreparationError("memorySessionSpaceSlug must be a string", 400, "resolving_env");
    }
    if (typeof body.memorySessionSpaceSlug === "string") {
      return normalizeMemorySessionSpaceSlug(body.memorySessionSpaceSlug);
    }
    const treeState = await treeGroupStore.getState();
    return (
      memorySessionSpaceSlugForTreeGroup(treeState, treeGroupId) ??
      normalizeMemorySessionSpaceSlug(launcher.getMemorySessionSpaceSlug())
    );
  };

  const normalizeDurableTreeGroupId = (value: unknown): string => normalizeTreeGroupId(value) || "default";

  const validateRequestedTreeGroupId = async (value: unknown): Promise<string | undefined> => {
    const requestedGroupId = normalizeTreeGroupId(value);
    if (!requestedGroupId || requestedGroupId === "default") return requestedGroupId;
    const treeState = await treeGroupStore.getState();
    if (!treeState.groups.some((group) => group.id === requestedGroupId)) {
      throwPreparationError(`Tree group not found: ${requestedGroupId}`, 400, "resolving_env");
    }
    return requestedGroupId;
  };

  const updateSessionTreeGroupMetadata = async (
    sessionId: string,
    groupId: string,
    options?: { broadcastSession?: boolean; persist?: boolean; syncMemorySessionSpace?: boolean },
  ): Promise<void> => {
    const session = wsBridge.getSession(sessionId);
    const normalizedGroupId = normalizeDurableTreeGroupId(groupId);
    const memorySessionSpaceSlug = options?.syncMemorySessionSpace
      ? memorySessionSpaceSlugForTreeGroup(await treeGroupStore.getState(), normalizedGroupId)
      : undefined;
    const launcherMemoryChanged =
      memorySessionSpaceSlug !== undefined && launcher.setMemorySessionSpaceSlug(sessionId, memorySessionSpaceSlug);
    let bridgeChanged = launcherMemoryChanged;
    if (session) {
      if (session.state.treeGroupId !== normalizedGroupId) {
        session.state.treeGroupId = normalizedGroupId;
        bridgeChanged = true;
      }
      if (memorySessionSpaceSlug !== undefined && session.state.memorySessionSpaceSlug !== memorySessionSpaceSlug) {
        session.state.memorySessionSpaceSlug = memorySessionSpaceSlug;
        bridgeChanged = true;
      }
    }
    if (!session && !bridgeChanged) return;
    if (session && options?.persist !== false) {
      if ((session as any).searchDataOnly) {
        const persisted = await sessionStore.load(sessionId);
        if (persisted) {
          persisted.state.treeGroupId = normalizedGroupId;
          if (memorySessionSpaceSlug !== undefined) {
            persisted.state.memorySessionSpaceSlug = memorySessionSpaceSlug;
          }
          sessionStore.saveSync(persisted);
        }
      } else if (bridgeChanged) {
        wsBridge.persistSessionById(sessionId);
      }
    }
    if (session && bridgeChanged && options?.broadcastSession !== false) {
      wsBridge.broadcastToSession(sessionId, {
        type: "session_update",
        session: {
          treeGroupId: normalizedGroupId,
          ...(memorySessionSpaceSlug !== undefined ? { memorySessionSpaceSlug } : {}),
        },
      } as any);
    }
  };

  const assignDurableSessionTreeGroup = async (
    sessionId: string,
    groupId: string,
    options?: {
      broadcastSession?: boolean;
      broadcastTreeGroups?: boolean;
      persist?: boolean;
      syncMemorySessionSpace?: boolean;
    },
  ): Promise<string> => {
    const normalizedGroupId = normalizeDurableTreeGroupId(groupId);
    await treeGroupStore.assignSession(sessionId, normalizedGroupId);
    await updateSessionTreeGroupMetadata(sessionId, normalizedGroupId, {
      broadcastSession: options?.broadcastSession,
      persist: options?.persist,
      syncMemorySessionSpace: options?.syncMemorySessionSpace,
    });
    if (options?.broadcastTreeGroups !== false) {
      await broadcastTreeGroups();
    }
    return normalizedGroupId;
  };

  const syncRestoredSessionMetadataFromAssignments = async (): Promise<void> => {
    const treeState = await treeGroupStore.getState();
    for (const info of launcher.listSessions()) {
      await updateSessionTreeGroupMetadata(info.sessionId, treeState.assignments[info.sessionId] || "default", {
        syncMemorySessionSpace: true,
      });
    }
  };

  const getTreeGroupDisplayName = (groups: Array<{ id: string; name: string }>, groupId: string): string =>
    groups.find((group) => group.id === groupId)?.name || (groupId === "default" ? "Default" : groupId);

  const getCurrentSessionTreeGroupId = async (sessionId: string): Promise<string | undefined> => {
    const session = wsBridge.getSession(sessionId);
    const metadataGroupId = normalizeTreeGroupId(session?.state.treeGroupId);
    if (metadataGroupId) return metadataGroupId;
    const assignedGroupId = await treeGroupStore.getGroupForSession(sessionId);
    return normalizeTreeGroupId(assignedGroupId);
  };

  const migrateStreamsForTreeGroupChange = async (
    sourceGroupId: string,
    destinationGroupId: string,
    sourceGroupName?: string,
  ): Promise<void> => {
    const normalizedSourceGroupId = normalizeDurableTreeGroupId(sourceGroupId);
    const normalizedDestinationGroupId = normalizeDurableTreeGroupId(destinationGroupId);
    if (normalizedSourceGroupId === normalizedDestinationGroupId) return;
    const { migrateSessionGroupStreams } = await import("../stream-store.js");
    await migrateSessionGroupStreams({
      serverId: getServerId(),
      sourceGroupId: normalizedSourceGroupId,
      destinationGroupId: normalizedDestinationGroupId,
      sourceGroupName,
    });
  };

  const shouldMigrateSourceGroupStreamsOnReassign = (
    treeState: Awaited<ReturnType<typeof treeGroupStore.getState>>,
    sessionId: string,
    sourceGroupId: string,
  ): boolean =>
    !Object.entries(treeState.assignments).some(
      ([candidateSessionId, candidateGroupId]) =>
        candidateSessionId !== sessionId && candidateGroupId === sourceGroupId,
    );

  const applySessionPostLaunch = async (
    session: Awaited<ReturnType<CliLauncher["launch"]>>,
    sessionConfig: SessionConfig,
  ) => {
    const initialTreeGroupId = normalizeDurableTreeGroupId(sessionConfig.treeGroupId);
    if (sessionConfig.containerInfo) {
      containerManager.retrack(sessionConfig.containerInfo.containerId, session.sessionId);
    }

    if (sessionConfig.worktreeInfo) {
      worktreeTracker.addMapping({
        sessionId: session.sessionId,
        repoRoot: sessionConfig.worktreeInfo.repoRoot,
        branch: sessionConfig.worktreeInfo.branch,
        actualBranch: sessionConfig.worktreeInfo.actualBranch,
        worktreePath: sessionConfig.worktreeInfo.worktreePath,
        createdAt: Date.now(),
      });
    }

    applyInitialSessionState(session.sessionId, {
      ...(sessionConfig.containerInfo ? { containerizedHostCwd: sessionConfig.initialCwd } : {}),
      cwd: sessionConfig.initialCwd,
      treeGroupId: initialTreeGroupId,
      memorySessionSpaceSlug: sessionConfig.memorySessionSpaceSlug,
      askPermission: sessionConfig.initialModeState.askPermission,
      uiMode: sessionConfig.initialModeState.uiMode,
      ...(sessionConfig.resumeCliSessionId ? { resumedFromExternal: true } : {}),
      ...(sessionConfig.worktreeInfo
        ? {
            worktree: {
              repoRoot: sessionConfig.worktreeInfo.repoRoot,
              defaultBranch: sessionConfig.worktreeInfo.defaultBranch,
              diffBaseBranch: sessionConfig.worktreeInfo.branch,
            },
          }
        : {}),
    });

    if (sessionConfig.isAssistantMode) {
      session.isAssistant = true;
    }
    if (sessionConfig.isOrchestrator) {
      session.isOrchestrator = true;
      session.leaderProfilePortraitId = chooseRandomLeaderProfilePortraitId(getSettings().leaderProfilePools);
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

    await assignDurableSessionTreeGroup(session.sessionId, initialTreeGroupId, { broadcastSession: false });

    if (sessionConfig.createdBy) {
      const creatorId = resolveId(String(sessionConfig.createdBy));
      const creator = creatorId ? launcher.getSession(creatorId) : null;
      if (creator?.isOrchestrator) {
        launcher.herdSessions(creator.sessionId, [session.sessionId]);
        // Auto-assign new worker to leader's tree group
        Promise.resolve(wsBridge.getSession(creator.sessionId)?.state.treeGroupId)
          .then((leaderGroupFromState) => leaderGroupFromState || treeGroupStore.getGroupForSession(creator.sessionId))
          .then((leaderGroup) => {
            if (sessionConfig.treeGroupExplicitlyRequested) return undefined;
            return assignDurableSessionTreeGroup(session.sessionId, leaderGroup || "default", {
              broadcastSession: false,
            });
          })
          .catch((err) => {
            console.warn("[tree-group] failed to assign worker to leader group:", err);
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
      const treeGroupExplicitlyRequested = normalizeTreeGroupId(body.treeGroupId) !== undefined;
      const requestedTreeGroupId = await resolveInitialTreeGroupIdForCreate(body);
      const memorySessionSpaceSlug = await resolveMemorySessionSpaceSlugForCreate(body, requestedTreeGroupId);
      envVars = {
        ...envVars,
        COMPANION_PORT: String(launcher.getPort()),
        [COMPANION_MEMORY_SPACE_SLUG_ENV]: memorySessionSpaceSlug,
      };
      if (isOrchestrator) {
        envVars.TAKODE_ROLE = "orchestrator";
        envVars.TAKODE_API_PORT = String(launcher.getPort());
      }
      await emit("resolving_env", "Environment resolved", "done");

      const resumeAskPermission = body.askPermission !== false;
      const initialModeState = resolveInitialModeState(backend, body.permissionMode, resumeAskPermission);
      const initialCwd = body.cwd ? resolve(expandTilde(body.cwd)) : process.cwd();
      const binarySettings = getSettings();
      const launchOptions: LaunchOptions = {
        cwd: initialCwd,
        claudeBinary: body.claudeBinary || binarySettings.claudeBinary || undefined,
        codexBinary: body.codexBinary || binarySettings.codexBinary || undefined,
        codexLeaderContextWindowOverrideTokens: binarySettings.codexLeaderContextWindowOverrideTokens,
        codexNonLeaderAutoCompactThresholdPercent: binarySettings.codexNonLeaderAutoCompactThresholdPercent,
        env: envVars,
        backendType: backend,
        resumeCliSessionId: body.resumeCliSessionId,
        permissionMode: initialModeState.permissionMode,
        askPermission: initialModeState.askPermission,
        memorySessionSpaceSlug,
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
        treeGroupId: requestedTreeGroupId,
        treeGroupExplicitlyRequested,
        memorySessionSpaceSlug,
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

    const treeGroupExplicitlyRequested = normalizeTreeGroupId(body.treeGroupId) !== undefined;
    const requestedTreeGroupId = await resolveInitialTreeGroupIdForCreate(body);
    const memorySessionSpaceSlug = await resolveMemorySessionSpaceSlugForCreate(body, requestedTreeGroupId);
    envVars = {
      ...envVars,
      COMPANION_PORT: String(launcher.getPort()),
      [COMPANION_MEMORY_SPACE_SLUG_ENV]: memorySessionSpaceSlug,
    };
    if (isOrchestrator) {
      envVars.TAKODE_ROLE = "orchestrator";
      envVars.TAKODE_API_PORT = String(launcher.getPort());
    }

    if (isAssistantMode) {
      ensureAssistantWorkspace();
      cwd = ASSISTANT_DIR;
    }

    await emit("resolving_env", "Environment resolved", "done");

    const preparedWorktree = await prepareWorktreeForSessionCreate({
      body,
      cwd,
      isOrchestrator,
      emit,
      throwPreparationError,
    });
    if (preparedWorktree) {
      cwd = preparedWorktree.cwd;
      worktreeInfo = preparedWorktree.worktreeInfo;
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
              pulled = await withProgressHeartbeat(
                emit,
                {
                  step: "pulling_image",
                  label: "Pulling Docker image...",
                  detail: "Still pulling Docker image...",
                },
                () => containerManager.pullImage(registryImage, effectiveImage),
              );
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
                const buildResult = await withProgressHeartbeat(
                  emit,
                  {
                    step: "building_image",
                    label: "Building Docker image (this may take a minute)...",
                    detail: "Still building Docker image...",
                  },
                  () => containerManager.buildImageFromDockerfileAsync(dockerfilePath, effectiveImage),
                );
                if (!buildResult.success) {
                  const truncated =
                    buildResult.log.length > 2000
                      ? `${buildResult.log.slice(0, 500)}\n...[truncated]...\n${buildResult.log.slice(-1500)}`
                      : buildResult.log;
                  throw new Error(truncated || "docker build failed");
                }
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
        await withProgressHeartbeat(
          emit,
          {
            step: "copying_workspace",
            label: "Copying workspace files...",
            detail: "Still copying workspace files...",
          },
          () => containerManager.copyWorkspaceToContainer(activeContainerInfo.containerId, containerWorkspaceCwd),
        );
        containerManager.reseedGitAuth(activeContainerInfo.containerId);
        await emit("copying_workspace", "Workspace copied", "done");
      } catch (err) {
        containerManager.removeContainer(tempId);
        const reason = err instanceof Error ? err.message : String(err);
        throwPreparationError(`Failed to copy workspace to container: ${reason}`, 503, "copying_workspace");
      }

      if (companionEnv?.initScript?.trim()) {
        const initScript = companionEnv.initScript.trim();
        await emit("running_init_script", "Running init script...", "in_progress");
        try {
          console.log(
            `[routes] Running init script for env "${companionEnv.name}" in container ${activeContainerInfo.name}...`,
          );
          const initTimeout = Number(process.env.COMPANION_INIT_SCRIPT_TIMEOUT) || 120_000;
          const result = await withProgressHeartbeat(
            emit,
            {
              step: "running_init_script",
              label: "Running init script...",
              detail: "Still running init script...",
            },
            () =>
              containerManager.execInContainerAsync(activeContainerInfo.containerId, ["sh", "-lc", initScript], {
                timeout: initTimeout,
              }),
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
    const model = await resolveSessionCreateModel({
      backend,
      createdBy: body.createdBy,
      getClaudeUserDefaultModel,
      launcher,
      requestedModel: body.model,
    });
    const codexReasoningEffort =
      backend === "codex" && typeof body.codexReasoningEffort === "string"
        ? body.codexReasoningEffort.trim() || undefined
        : undefined;
    const orchestratorGuardrails = isOrchestrator ? launcher.getOrchestratorGuardrails(backend) : undefined;

    const initialCwd = cwd || process.cwd();
    const binarySettings = getSettings();
    const launchOptions: LaunchOptions = {
      model,
      permissionMode: initialModeState.permissionMode,
      askPermission: initialModeState.askPermission,
      uiMode: initialModeState.uiMode,
      cwd: initialCwd,
      claudeBinary: body.claudeBinary || binarySettings.claudeBinary || undefined,
      codexBinary: body.codexBinary || binarySettings.codexBinary || undefined,
      codexLeaderContextWindowOverrideTokens: binarySettings.codexLeaderContextWindowOverrideTokens,
      codexNonLeaderAutoCompactThresholdPercent: binarySettings.codexNonLeaderAutoCompactThresholdPercent,
      codexInternetAccess: backend === "codex" && body.codexInternetAccess === true,
      codexSandbox:
        backend === "codex" ? resolveCodexSandboxForPermissionMode(initialModeState.permissionMode) : undefined,
      codexReasoningEffort,
      allowedTools: body.allowedTools,
      env: envVars,
      backendType: backend,
      containerId,
      containerName,
      containerImage,
      worktreeInfo,
      extraInstructions: orchestratorGuardrails,
      memorySessionSpaceSlug,
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
      treeGroupId: requestedTreeGroupId,
      treeGroupExplicitlyRequested,
      memorySessionSpaceSlug,
      worktreeInfo,
      containerInfo,
    };
  };
  const createSessionFromBody = async (
    body: any,
    recycledWorktreeInfo?: WorktreeSessionInfo,
  ): Promise<Awaited<ReturnType<CliLauncher["launch"]>>> => {
    const backendRaw = body.backend ?? "claude";
    const backend = resolveBackend(backendRaw);
    if (!backend) {
      throwPreparationError(`Invalid backend: ${String(backendRaw)}`, 400);
    }

    const sessionConfig = await prepareSession(body, applyDefaultClaudeBackend(backend));
    if (recycledWorktreeInfo) {
      sessionConfig.initialCwd = recycledWorktreeInfo.worktreePath;
      sessionConfig.worktreeInfo = recycledWorktreeInfo;
      sessionConfig.launchOptions.cwd = recycledWorktreeInfo.worktreePath;
      sessionConfig.launchOptions.worktreeInfo = recycledWorktreeInfo;
    }
    const session = await launcher.launch(sessionConfig.launchOptions);
    await applySessionPostLaunch(session, sessionConfig);
    return session;
  };

  api.post("/sessions/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
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

      return c.json(await createSessionFromBody(body));
    } catch (e: unknown) {
      if (e instanceof SessionPreparationError) {
        return c.json({ error: e.message }, e.status);
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[routes] Failed to create session:", msg);
      return c.json({ error: msg }, 500);
    }
  });

  registerSessionSlackThreadRoutes(api, { launcher, wsBridge, resolveId });
  registerSessionReplacementRoutes(api, {
    resolveId,
    authenticateTakodeCaller,
    launcher,
    wsBridge,
    sessionStore,
    worktreeTracker,
    prPoller,
    timerManager: ctx.timerManager,
    createSessionFromBody,
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

        const session = await withProgressHeartbeat(
          (step, label, status, detail) => emitProgress(stream, step, label, status, detail),
          {
            step: "launching_cli",
            label: sessionConfig.resumeCliSessionId ? "Resuming CLI session..." : "Launching Claude Code...",
            detail: sessionConfig.worktreeInfo ? "Finishing worktree setup..." : "Still launching CLI...",
          },
          () => launcher.launch(sessionConfig.launchOptions),
        );
        await applySessionPostLaunch(session, sessionConfig);

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

  const buildEnrichedSessions = (filterFn?: (s: ReturnType<CliLauncher["listSessions"]>[number]) => boolean) =>
    buildEnrichedSessionsSnapshot(
      { launcher, wsBridge, timerManager: ctx.timerManager, pendingWorktreeCleanups },
      filterFn,
    );

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
    const includeArchived = parseIncludeArchived(c.req.query("includeArchived"));
    const enriched = await buildEnrichedSessions(includeArchived ? undefined : (session) => !session.archived);
    return c.json(enriched);
  });
  registerSessionSearchRoute(api, { launcher, wsBridge });
  registerSessionMessageSearchRoute(api, { launcher, wsBridge, resolveId });
  api.get("/sessions/:id", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = launcher.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const bridgeSession = wsBridge.getSession(id);
    const { injectedSystemPrompt: _prompt, ...rest } = session;
    const bridgeState = bridgeSession?.state;
    return c.json({
      ...rest,
      treeGroupId: bridgeState?.treeGroupId ?? rest.treeGroupId ?? null,
      memorySessionSpaceSlug: bridgeState?.memorySessionSpaceSlug ?? rest.memorySessionSpaceSlug ?? null,
      gitBranch: bridgeState?.git_branch ?? null,
      gitDefaultBranch: bridgeState?.git_default_branch ?? null,
      diffBaseBranch: bridgeState?.diff_base_branch ?? null,
      isWorktree: rest.isWorktree ?? bridgeState?.is_worktree ?? false,
      repoRoot: rest.repoRoot ?? bridgeState?.repo_root ?? null,
      branch: rest.branch ?? (bridgeState?.is_worktree ? bridgeState.git_branch : undefined),
      actualBranch: rest.actualBranch ?? (bridgeState?.is_worktree ? bridgeState.git_branch : undefined),
      ...(bridgeState?.leaderOpenThreadTabs ? { leaderOpenThreadTabs: bridgeState.leaderOpenThreadTabs } : {}),
      pause: bridgeState?.pause ?? null,
      pausedInputQueueCount: bridgeState?.pause?.queuedMessages.length ?? 0,
      codexResultErrorAutoPause: bridgeState?.codex_result_error_auto_pause ?? null,
      codexAutoPausedInputCount:
        bridgeState?.codex_result_error_auto_pause?.heldInputs.reduce(
          (total, item) => total + Math.max(1, item.count),
          0,
        ) ?? 0,
      sessionLifecycleEvents: bridgeState?.lifecycle_events ?? [],
      isGenerating: !!(bridgeSession?.isGenerating || bridgeSession?.pendingPermissions.size),
    });
  });
  registerSessionLeaderProfileRoute(api, ctx);

  api.get("/sessions/:id/messages/:idx/preview", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const idx = Number.parseInt(c.req.param("idx"), 10);
    if (Number.isNaN(idx)) return c.json({ error: "Invalid message index" }, 400);

    const history = wsBridge.getSession(sessionId)?.messageHistory ?? null;
    if (!history) return c.json({ error: "Session not found in bridge" }, 404);

    const result = buildReadResponse(
      history,
      idx,
      {
        limit: 1000,
        getToolResult: (toolUseId) => wsBridge.getToolResult(sessionId, toolUseId),
      },
      sessionId,
    );
    if (!result) {
      return c.json({ error: `Message index ${idx} out of range (0-${history.length - 1})` }, 404);
    }

    return c.json(result);
  });
  registerSessionNotificationContextRoute(api, { resolveId, wsBridge });

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
    sessionNames.setUserNamed(id);
    wsBridge.broadcastToSession(id, { type: "session_update", session: { name: body.name.trim() } } as any);
    return c.json({ ok: true, name: body.name.trim() });
  });
  // ─── Tree Groups (herd-centric grouping) ─────────────────────────────

  api.get("/tree-groups", async (c) => {
    const state = await treeGroupStore.getState();
    return c.json(state);
  });

  api.get("/new-session-defaults", async (c) => {
    const key = typeof c.req.query("key") === "string" ? c.req.query("key")!.trim() : "";
    if (!key) return c.json({ error: "key is required" }, 400);
    const entry = await newSessionDefaultsStore.getDefaults(key);
    return c.json({
      key,
      defaults: entry?.defaults ?? null,
      updatedAt: entry?.updatedAt ?? null,
    });
  });

  api.put("/new-session-defaults", async (c) => {
    const key = typeof c.req.query("key") === "string" ? c.req.query("key")!.trim() : "";
    if (!key) return c.json({ error: "key is required" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const entry = await newSessionDefaultsStore.saveDefaults(key, body?.defaults);
    if (!entry) return c.json({ error: "valid defaults are required" }, 400);
    return c.json({
      ok: true,
      key,
      defaults: entry.defaults,
      updatedAt: entry.updatedAt,
    });
  });

  api.put("/tree-groups", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid body" }, 400);
    }
    await treeGroupStore.setState(body);
    await syncRestoredSessionMetadataFromAssignments();
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
    await syncRestoredSessionMetadataFromAssignments();
    await broadcastTreeGroups();
    return c.json({ ok: true });
  });
  api.delete("/tree-groups/groups/:id", async (c) => {
    const id = c.req.param("id");
    const treeState = await treeGroupStore.getState();
    const group = treeState.groups.find((candidate) => candidate.id === id);
    if (!group && id !== "default") {
      return c.json({ error: "Group not found" }, 404);
    }
    await migrateStreamsForTreeGroupChange(id, "default", group?.name);
    const ok = await treeGroupStore.deleteGroup(id);
    if (!ok) return c.json({ error: "Cannot delete default group" }, 400);
    await syncRestoredSessionMetadataFromAssignments();
    await broadcastTreeGroups();
    return c.json({ ok: true });
  });
  api.patch("/tree-groups/assign", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const sessionIds = Array.isArray(body.sessionIds)
      ? [
          ...new Set(
            body.sessionIds.map((value: unknown) => (typeof value === "string" ? value.trim() : "")).filter(Boolean),
          ),
        ]
      : [];
    const groupId = typeof body.groupId === "string" ? body.groupId.trim() : "";
    const targetSessionIds = sessionIds.length > 0 ? sessionIds : sessionId ? [sessionId] : [];
    if (targetSessionIds.length === 0 || !groupId) {
      return c.json({ error: "sessionId/sessionIds and groupId are required" }, 400);
    }
    const treeState = await treeGroupStore.getState();
    if (!treeState.groups.some((group) => group.id === groupId)) {
      return c.json({ error: "Group not found" }, 404);
    }
    for (const targetSessionId of targetSessionIds) {
      const latestTreeState = await treeGroupStore.getState();
      const sourceGroupId = await getCurrentSessionTreeGroupId(targetSessionId);
      if (
        sourceGroupId &&
        sourceGroupId !== groupId &&
        shouldMigrateSourceGroupStreamsOnReassign(latestTreeState, targetSessionId, sourceGroupId)
      ) {
        await migrateStreamsForTreeGroupChange(
          sourceGroupId,
          groupId,
          getTreeGroupDisplayName(latestTreeState.groups, sourceGroupId),
        );
      }
      await assignDurableSessionTreeGroup(targetSessionId, groupId, {
        broadcastTreeGroups: false,
        syncMemorySessionSpace: true,
      });
    }
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
    if (!setDiffBaseBranch(id, branch)) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ ok: true, diff_base_branch: branch });
  });
  api.patch("/sessions/:id/read", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    clearAttentionAndMarkReadController(session, sessionAttentionDeps);
    return c.json({ ok: true });
  });
  api.patch("/sessions/:id/unread", (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const session = wsBridge.getSession(id);
    if (!session) return c.json({ error: "Session not found" }, 404);
    markSessionUnreadController(session, sessionUnreadDeps);
    return c.json({ ok: true });
  });
  api.post("/sessions/mark-all-read", (c) => {
    for (const info of launcher.listSessions()) {
      const session = wsBridge.getSession(info.sessionId);
      if (!session) continue;
      clearAttentionAndMarkReadController(session, sessionAttentionDeps);
    }
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

  registerSessionPermissionModeRoute(api, ctx);
  registerSessionPauseRoutes(api, ctx);

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

    if (!session) {
      wsBridge.getOrCreateSession(id, workerInfo.backendType || "claude");
    }
    const interrupted = await wsBridge.interruptSession(id, "leader");
    if (!interrupted) return c.json({ error: "Session not found" }, 404);

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
    if (isSessionPaused(wsBridge.getSession(id))) {
      return c.json({ error: "Session is paused; unpause before relaunching", code: "SESSION_PAUSED" }, 409);
    }
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
        applyInitialSessionState(id, {
          cwd: wt.worktreePath,
          worktree: { repoRoot: info.repoRoot, defaultBranch: undefined, diffBaseBranch: info.branch },
        });
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

    (wsBridge as any).clearCodexAutomaticRecoverySuppression?.(id);
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
      wsBridge.broadcastToSession(id, { type: "session_update", session: { backend_type: "claude-sdk" } } as any);
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
      wsBridge.broadcastToSession(id, { type: "session_update", session: { backend_type: "claude" } } as any);
    }

    console.log(`[transport] Downgrade complete for ${id.slice(0, 8)}`);
    return c.json(result);
  });
  api.post("/sessions/:id/force-compact", async (c) => {
    const id = resolveId(c.req.param("id"));
    if (!id) return c.json({ error: "Session not found" }, 404);
    const info = launcher.getSession(id);
    if (!info) return c.json({ error: "Session not found" }, 404);
    if (info.backendType === "codex") {
      if (!info.isOrchestrator) {
        return c.json({ error: "Force compact is only supported for Codex leaders" }, 400);
      }
      const recycle = await wsBridge.recycleCodexLeaderSession(id, "manual_compact");
      if (!recycle.ok) {
        return c.json({ error: recycle.error || "Failed to recycle Codex leader session" }, 503);
      }
      return c.json({ ok: true });
    }
    if (!info.cliSessionId) return c.json({ error: "No CLI session to resume" }, 400);

    const queued = wsBridge.queueForceCompactForRelaunch(id);
    if (!queued.ok) return c.json({ error: queued.error }, 400);

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
    return c.json(
      { error: "Skill updates are applied when the Codex session is relaunched", requires_relaunch: true },
      409,
    );
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
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Timed out waiting for Codex rollback")), 10_000),
          ),
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
      wsBridge.emitTakodeEvent(id, "session_archived", { archive_source: getArchiveSource(actorId) }, actorId);
    }

    await launcher.kill(id);

    // Clean up container if any
    containerManager.removeContainer(id);

    const mapping = worktreeTracker.getBySession(id);
    const worktreeResult = mapping ? await cleanupWorktree(mapping, worktreeTracker, true) : undefined;
    // Clean up any stale archived ref from a previous archive cycle (q-329)
    if (sessionInfo?.isWorktree && sessionInfo.repoRoot && sessionInfo.actualBranch) {
      await gitUtils.deleteArchivedRefAsync(sessionInfo.repoRoot, sessionInfo.actualBranch);
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
  registerSessionsArchiveRoutes(api, {
    resolveId,
    authenticateCompanionCallerOptional,
    launcher,
    wsBridge,
    sessionStore,
    worktreeTracker,
    prPoller,
    pathExists,
    timerManager: ctx.timerManager,
    queueArchivedWorktreeCleanup,
    pendingWorktreeCleanups,
    applyInitialSessionState,
  });
  // ─── Task History (table of contents) ──────────────────────
  api.get("/sessions/:id/tasks", (c) => {
    const sessionId = resolveId(c.req.param("id"));
    if (!sessionId) return c.json({ error: "Session not found" }, 404);

    const taskHistory = wsBridge.getSession(sessionId)?.taskHistory ?? [];
    const messageHistory = wsBridge.getSession(sessionId)?.messageHistory ?? null;
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
  registerSessionImageRoutes(api, { imageStore, resolveId });
  return api;
}
