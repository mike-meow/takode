import { Hono } from "hono";
import { exec as execCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { resolveBinary, getEnrichedPath } from "../path-resolver.js";
import type { RestartPrepOperationSnapshot, RestartPrepSessionSummary } from "../herd-event-dispatcher.js";
import {
  buildRestartContinuationPlan,
  saveRestartContinuationPlan,
  type RestartContinuationTarget,
} from "../restart-continuation-store.js";
import {
  getSettings,
  updateSettings,
  getServerName,
  setServerName,
  getServerId,
  getClaudeUserDefaultModel,
  getCodexUserDefaultModel,
  STT_MODELS,
  QUESTMASTER_COMPACT_SORT_COLUMNS,
  DEFAULT_QUESTMASTER_COMPACT_SORT,
  type NamerConfig,
  type TranscriptionConfig,
  type SttModel,
  type EditorConfig,
  type EnhancementMode,
  type QuestmasterViewMode,
  type QuestmasterCompactSort,
  type QuestmasterCompactSortColumn,
} from "../settings-manager.js";
import { DEFAULT_PUSHOVER_EVENT_FILTERS, type PushoverEventFilters } from "../pushover.js";
import { getLogPath } from "../server-logger.js";
import type { RouteContext } from "./context.js";

export function createSettingsRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, wsBridge, sessionStore, options, pushoverNotifier } = ctx;
  const execPromise = promisify(execCb);
  const restartPrepTimeoutMs = Number(process.env.COMPANION_RESTART_PREP_TIMEOUT_MS || "8000");

  interface RestartBlockingSession {
    sessionId: string;
    label: string;
    herdedBy: string | null;
    reasons: string[];
    originalIndex: number;
  }

  interface RestartPrepResult {
    ok: boolean;
    operationId: string | null;
    mode: "standalone" | "restart";
    restartRequested: boolean;
    timedOut: boolean;
    interrupted: Array<{ sessionId: string; label: string; reasons: string[] }>;
    skipped: Array<{ sessionId: string; label: string; reasons: string[]; detail: string }>;
    failures: Array<{ sessionId: string; label: string; reasons: string[]; detail: string }>;
    protectedLeaders: RestartPrepSessionSummary[];
    unresolvedBlockers: Array<{ sessionId: string; label: string; reasons: string[]; detail?: string }>;
    herdDelivery: {
      suppressed: number;
      held: number;
      trackingActive: boolean;
      countsFinal: boolean;
      detail?: string;
    };
  }

  interface RestartPrepCoordinator {
    beginRestartPrepOperation: (options: {
      operationId: string;
      mode: "standalone" | "restart";
      targetSessions: RestartPrepSessionSummary[];
      protectedLeaders: RestartPrepSessionSummary[];
      timeoutMs: number;
      suppressionTtlMs?: number;
    }) => RestartPrepOperationSnapshot;
    updateRestartPrepUnresolvedBlockers: (operationId: string, blockers: RestartPrepSessionSummary[]) => void;
    getRestartPrepOperationSnapshot: (operationId: string) => RestartPrepOperationSnapshot | null;
  }

  function getRestartBlockingSessions(): RestartBlockingSession[] {
    return launcher.listSessions().flatMap((sessionInfo, originalIndex) => {
      if (sessionInfo.state === "exited") return [];
      const bridgeSession = wsBridge.getSession(sessionInfo.sessionId);
      if (!bridgeSession) return [];

      const reasons: string[] = [];
      if (bridgeSession.isGenerating) reasons.push("running");
      const pendingPermissionCount = bridgeSession.pendingPermissions.size;
      if (pendingPermissionCount > 0) {
        reasons.push(
          pendingPermissionCount === 1 ? "1 pending permission" : `${pendingPermissionCount} pending permissions`,
        );
      }
      if (reasons.length === 0) return [];

      const sessionNum =
        typeof launcher.getSessionNum === "function" ? launcher.getSessionNum(sessionInfo.sessionId) : null;
      const label = sessionInfo.name || (sessionNum != null ? `#${sessionNum}` : sessionInfo.sessionId.slice(0, 8));
      return [
        {
          sessionId: sessionInfo.sessionId,
          label,
          herdedBy: sessionInfo.herdedBy ?? null,
          reasons,
          originalIndex,
        },
      ];
    });
  }

  function sortInterruptSessionsByDependency(blockers: RestartBlockingSession[]): RestartBlockingSession[] {
    const blockerById = new Map(blockers.map((blocker) => [blocker.sessionId, blocker]));
    const depthMemo = new Map<string, number>();

    const getDepth = (sessionId: string): number => {
      const cached = depthMemo.get(sessionId);
      if (cached !== undefined) return cached;

      let depth = 0;
      const seen = new Set<string>([sessionId]);
      let parentId = blockerById.get(sessionId)?.herdedBy ?? null;
      while (parentId) {
        const parent = blockerById.get(parentId);
        if (!parent || seen.has(parentId)) break;
        seen.add(parentId);
        depth += 1;
        parentId = parent.herdedBy;
      }
      depthMemo.set(sessionId, depth);
      return depth;
    };

    return [...blockers].sort((left, right) => {
      const depthDiff = getDepth(right.sessionId) - getDepth(left.sessionId);
      if (depthDiff !== 0) return depthDiff;
      return left.originalIndex - right.originalIndex;
    });
  }

  function getRestartPrepCoordinator(): RestartPrepCoordinator | null {
    return (
      ((wsBridge as unknown as { herdEventDispatcher?: unknown }).herdEventDispatcher as RestartPrepCoordinator) ?? null
    );
  }

  function summarizeSession(sessionId: string, fallbackLabel?: string): RestartPrepSessionSummary {
    const sessionInfo = launcher.getSession(sessionId);
    const sessionNum = typeof launcher.getSessionNum === "function" ? launcher.getSessionNum(sessionId) : null;
    return {
      sessionId,
      label: sessionInfo?.name || fallbackLabel || (sessionNum != null ? `#${sessionNum}` : sessionId.slice(0, 8)),
    };
  }

  function getProtectedLeaders(blockers: RestartBlockingSession[]): RestartPrepSessionSummary[] {
    const protectedById = new Map<string, RestartPrepSessionSummary>();
    const launcherSessions = new Map(
      launcher.listSessions().map((sessionInfo) => [sessionInfo.sessionId, sessionInfo]),
    );

    for (const blocker of blockers) {
      const blockerInfo = launcherSessions.get(blocker.sessionId);
      if (blockerInfo?.isOrchestrator) {
        protectedById.set(blocker.sessionId, summarizeSession(blocker.sessionId, blocker.label));
      }

      const seen = new Set<string>([blocker.sessionId]);
      let leaderId = blocker.herdedBy;
      while (leaderId && !seen.has(leaderId)) {
        seen.add(leaderId);
        protectedById.set(leaderId, summarizeSession(leaderId));
        leaderId = launcherSessions.get(leaderId)?.herdedBy ?? null;
      }
    }

    return [...protectedById.values()];
  }

  function blockerToResultItem(blocker: RestartBlockingSession): {
    sessionId: string;
    label: string;
    reasons: string[];
    detail?: string;
  } {
    const permissionReason = blocker.reasons.find((reason) => reason.includes("pending permission"));
    return {
      sessionId: blocker.sessionId,
      label: blocker.label,
      reasons: blocker.reasons,
      ...(permissionReason
        ? {
            detail:
              "Pending permission blockers remain unresolved until the backend reports cancellation or resolution.",
          }
        : {}),
    };
  }

  function snapshotHerdDelivery(operationId: string | null): RestartPrepResult["herdDelivery"] {
    if (!operationId) {
      return {
        suppressed: 0,
        held: 0,
        trackingActive: false,
        countsFinal: true,
        detail: "No restart-prep herd delivery operation was created.",
      };
    }
    const snapshot = getRestartPrepCoordinator()?.getRestartPrepOperationSnapshot(operationId);
    if (!snapshot) {
      return {
        suppressed: 0,
        held: 0,
        trackingActive: false,
        countsFinal: true,
        detail: "Restart-prep herd delivery tracking is no longer active.",
      };
    }
    return {
      suppressed: snapshot.suppressedHerdEvents,
      held: snapshot.heldHerdEvents,
      trackingActive: true,
      countsFinal: false,
      detail:
        "Restart-prep herd delivery tracking is active. Counts are current as of this response and may increase as worker events settle.",
    };
  }

  function beginRestartPrepOperation(
    blockers: RestartBlockingSession[],
    mode: "standalone" | "restart",
    timeoutMs: number,
  ): string | null {
    if (blockers.length === 0) return null;
    const coordinator = getRestartPrepCoordinator();
    if (!coordinator) return null;

    const operationId = randomUUID();
    coordinator.beginRestartPrepOperation({
      operationId,
      mode,
      targetSessions: blockers.map((blocker) => ({ sessionId: blocker.sessionId, label: blocker.label })),
      protectedLeaders: getProtectedLeaders(blockers),
      timeoutMs,
    });
    return operationId;
  }

  async function interruptRestartBlockers(
    blockers: RestartBlockingSession[],
    operationId: string | null,
  ): Promise<Pick<RestartPrepResult, "interrupted" | "skipped" | "failures">> {
    const interrupted: RestartPrepResult["interrupted"] = [];
    const skipped: RestartPrepResult["skipped"] = [];
    const failures: RestartPrepResult["failures"] = [];

    for (const blocker of sortInterruptSessionsByDependency(blockers)) {
      try {
        const routed = await wsBridge.interruptSession(
          blocker.sessionId,
          "user",
          operationId ? { interruptOrigin: "restart_prep", restartPrepOperationId: operationId } : undefined,
        );
        if (!routed) {
          skipped.push({
            sessionId: blocker.sessionId,
            label: blocker.label,
            reasons: blocker.reasons,
            detail: "Session was no longer loaded when interrupts were dispatched.",
          });
          continue;
        }
        interrupted.push({
          sessionId: blocker.sessionId,
          label: blocker.label,
          reasons: blocker.reasons,
        });
      } catch (error) {
        failures.push({
          sessionId: blocker.sessionId,
          label: blocker.label,
          reasons: blocker.reasons,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { interrupted, skipped, failures };
  }

  async function waitForRestartReadiness(
    timeoutMs: number,
  ): Promise<{ timedOut: boolean; blockers: RestartBlockingSession[] }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const blockers = getRestartBlockingSessions();
      if (blockers.length === 0) return { timedOut: false, blockers: [] };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const blockers = getRestartBlockingSessions();
    return { timedOut: blockers.length > 0, blockers };
  }

  function buildRestartPrepResult(options: {
    mode: "standalone" | "restart";
    operationId: string | null;
    restartRequested: boolean;
    timedOut: boolean;
    interrupted: RestartPrepResult["interrupted"];
    skipped: RestartPrepResult["skipped"];
    failures: RestartPrepResult["failures"];
    protectedLeaders: RestartPrepSessionSummary[];
    unresolvedBlockers: RestartBlockingSession[];
  }): RestartPrepResult {
    const unresolvedBlockers = options.unresolvedBlockers.map(blockerToResultItem);
    if (options.operationId) {
      getRestartPrepCoordinator()?.updateRestartPrepUnresolvedBlockers(options.operationId, unresolvedBlockers);
    }
    return {
      ok: options.failures.length === 0 && unresolvedBlockers.length === 0,
      operationId: options.operationId,
      mode: options.mode,
      restartRequested: options.restartRequested,
      timedOut: options.timedOut,
      interrupted: options.interrupted,
      skipped: options.skipped,
      failures: options.failures,
      protectedLeaders: options.protectedLeaders,
      unresolvedBlockers,
      herdDelivery: snapshotHerdDelivery(options.operationId),
    };
  }

  async function queueRestartContinuations(options: {
    operationId: string | null;
    interrupted: RestartPrepResult["interrupted"];
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!options.operationId) return { ok: true };

    const sessions: RestartContinuationTarget[] = options.interrupted
      .filter((item) => item.reasons.includes("running"))
      .map((item) => ({ sessionId: item.sessionId, label: item.label }));
    if (sessions.length === 0) return { ok: true };

    try {
      await saveRestartContinuationPlan(
        sessionStore.directory,
        buildRestartContinuationPlan({ operationId: options.operationId, sessions }),
      );
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: `Restart continuation queue could not be saved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  // ─── Server restart ───────────────────────────────────────────────

  api.post("/server/restart", async (c) => {
    if (!options?.requestRestart) {
      return c.json({ error: "Restart not supported in this mode" }, 503);
    }
    // Block restart while sessions are still holding the restart readiness gate.
    const busySessions = getRestartBlockingSessions();
    if (busySessions.length > 0) {
      const timeoutMs = restartPrepTimeoutMs;
      const operationId = beginRestartPrepOperation(busySessions, "restart", timeoutMs);
      const protectedLeaders = getProtectedLeaders(busySessions);
      const { interrupted, skipped, failures } = await interruptRestartBlockers(busySessions, operationId);
      const readiness =
        failures.length === 0
          ? await waitForRestartReadiness(timeoutMs)
          : { timedOut: false, blockers: getRestartBlockingSessions() };
      if (readiness.blockers.length > 0 || failures.length > 0) {
        const result = buildRestartPrepResult({
          mode: "restart",
          operationId,
          restartRequested: false,
          timedOut: readiness.timedOut,
          interrupted,
          skipped,
          failures,
          protectedLeaders,
          unresolvedBlockers: readiness.blockers,
        });
        return c.json(
          {
            error: `Cannot restart while ${readiness.blockers.length} session(s) are still blocking restart readiness: ${readiness.blockers
              .map((session) => session.label)
              .join(", ")}`,
            result,
          },
          409,
        );
      }
      const continuation = await queueRestartContinuations({ operationId, interrupted });
      const result = buildRestartPrepResult({
        mode: "restart",
        operationId,
        restartRequested: continuation.ok,
        timedOut: false,
        interrupted,
        skipped,
        failures,
        protectedLeaders,
        unresolvedBlockers: [],
      });
      if (!continuation.ok) {
        return c.json({ error: continuation.error, result }, 500);
      }

      options.requestRestart();
      return c.json(result);
    }
    options.requestRestart();
    return c.json({ ok: true, restartRequested: true });
  });

  api.post("/server/interrupt-all", async (c) => {
    const blockers = getRestartBlockingSessions();
    const timeoutMs = restartPrepTimeoutMs;
    const operationId = beginRestartPrepOperation(blockers, "standalone", timeoutMs);
    const protectedLeaders = getProtectedLeaders(blockers);
    const { interrupted, skipped, failures } = await interruptRestartBlockers(blockers, operationId);
    const unresolvedBlockers = getRestartBlockingSessions();

    return c.json(
      buildRestartPrepResult({
        mode: "standalone",
        operationId,
        restartRequested: false,
        timedOut: false,
        interrupted,
        skipped,
        failures,
        protectedLeaders,
        unresolvedBlockers,
      }),
    );
  });

  // ─── Settings (~/.companion/settings-{port}.json; migrates legacy settings.json) ────────────────────────

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

  function parseCodexLeaderRecycleThresholdTokensByModelFromBody(
    raw: unknown,
  ): { ok: true; value: Record<string, number> } | { ok: false; error: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "codexLeaderRecycleThresholdTokensByModel must be an object" };
    }
    const normalizedEntries: Array<[string, number]> = [];
    const seenModelIds = new Set<string>();
    for (const [rawModelId, rawThreshold] of Object.entries(raw as Record<string, unknown>)) {
      const modelId = rawModelId.trim();
      if (!modelId) {
        return { ok: false, error: "codexLeaderRecycleThresholdTokensByModel keys must be non-empty strings" };
      }
      if (seenModelIds.has(modelId)) {
        return {
          ok: false,
          error: `codexLeaderRecycleThresholdTokensByModel contains duplicate model key after trimming: ${modelId}`,
        };
      }
      if (typeof rawThreshold !== "number" || rawThreshold < 1 || !Number.isInteger(rawThreshold)) {
        return {
          ok: false,
          error: `codexLeaderRecycleThresholdTokensByModel.${modelId} must be a positive integer`,
        };
      }
      seenModelIds.add(modelId);
      normalizedEntries.push([modelId, rawThreshold]);
    }
    normalizedEntries.sort(([left], [right]) => left.localeCompare(right));
    return { ok: true, value: Object.fromEntries(normalizedEntries) };
  }

  /** Mask sensitive fields in TranscriptionConfig for API responses. */
  function maskTranscriptionConfig(config: TranscriptionConfig): TranscriptionConfig {
    return { ...config, apiKey: config.apiKey ? "***" : "" };
  }

  /** Parse a transcriptionConfig from a request body.
   *  If apiKey is "***" (masked sentinel), preserve the existing key from settings. */
  function parseTranscriptionConfigFromBody(tc: Record<string, unknown>): TranscriptionConfig {
    const current = getSettings().transcriptionConfig;
    let apiKey = current.apiKey;
    if (typeof tc.apiKey === "string") {
      const trimmedApiKey = tc.apiKey.trim();
      apiKey = trimmedApiKey === "***" ? current.apiKey : trimmedApiKey;
    }
    return {
      apiKey,
      baseUrl: typeof tc.baseUrl === "string" ? tc.baseUrl.trim() : current.baseUrl,
      enhancementEnabled:
        typeof tc.enhancementEnabled === "boolean" ? tc.enhancementEnabled : current.enhancementEnabled,
      enhancementModel: typeof tc.enhancementModel === "string" ? tc.enhancementModel.trim() : current.enhancementModel,
      customVocabulary:
        typeof tc.customVocabulary === "string" ? tc.customVocabulary.trim() : current.customVocabulary || "",
      sttModel:
        typeof tc.sttModel === "string" && (STT_MODELS as readonly string[]).includes(tc.sttModel)
          ? (tc.sttModel as SttModel)
          : current.sttModel,
      enhancementMode:
        typeof tc.enhancementMode === "string" && (tc.enhancementMode === "default" || tc.enhancementMode === "bullet")
          ? (tc.enhancementMode as EnhancementMode)
          : current.enhancementMode,
      voiceCaptureMode:
        typeof tc.voiceCaptureMode === "string" && (tc.voiceCaptureMode === "edit" || tc.voiceCaptureMode === "append")
          ? (tc.voiceCaptureMode as "edit" | "append")
          : current.voiceCaptureMode,
    };
  }

  function parseEditorConfigFromBody(ec: Record<string, unknown>): EditorConfig {
    const editor = ec.editor;
    if (editor === "vscode-local" || editor === "vscode-remote" || editor === "cursor" || editor === "none") {
      return { editor };
    }
    if (editor === "vscode") return { editor: "vscode-local" };
    return { editor: "none" };
  }

  function normalizeQuestmasterViewMode(mode: unknown): QuestmasterViewMode {
    return mode === "compact" ? "compact" : "cards";
  }

  function normalizeQuestmasterCompactSort(sort: unknown): QuestmasterCompactSort {
    if (!sort || typeof sort !== "object" || Array.isArray(sort)) return DEFAULT_QUESTMASTER_COMPACT_SORT;
    const raw = sort as Record<string, unknown>;
    if (
      !QUESTMASTER_COMPACT_SORT_COLUMNS.includes(raw.column as QuestmasterCompactSortColumn) ||
      (raw.direction !== "asc" && raw.direction !== "desc")
    ) {
      return DEFAULT_QUESTMASTER_COMPACT_SORT;
    }
    return { column: raw.column as QuestmasterCompactSortColumn, direction: raw.direction };
  }

  function normalizePushoverEventFilters(filters: unknown): PushoverEventFilters {
    const raw =
      filters && typeof filters === "object" && !Array.isArray(filters) ? (filters as Record<string, unknown>) : {};
    return {
      needsInput: typeof raw.needsInput === "boolean" ? raw.needsInput : DEFAULT_PUSHOVER_EVENT_FILTERS.needsInput,
      review: typeof raw.review === "boolean" ? raw.review : DEFAULT_PUSHOVER_EVENT_FILTERS.review,
      error: typeof raw.error === "boolean" ? raw.error : DEFAULT_PUSHOVER_EVENT_FILTERS.error,
    };
  }

  function parsePushoverEventFiltersFromBody(raw: Record<string, unknown>): PushoverEventFilters {
    const current = normalizePushoverEventFilters(getSettings().pushoverEventFilters);
    return {
      needsInput: typeof raw.needsInput === "boolean" ? raw.needsInput : current.needsInput,
      review: typeof raw.review === "boolean" ? raw.review : current.review,
      error: typeof raw.error === "boolean" ? raw.error : current.error,
    };
  }

  function buildSettingsResponse(
    settings: ReturnType<typeof getSettings>,
    extras?: { claudeDefaultModel?: string; includeRuntimeInfo?: boolean },
  ): Record<string, unknown> {
    return {
      serverName: getServerName(),
      serverId: getServerId(),
      pushoverConfigured: !!(settings.pushoverUserKey.trim() && settings.pushoverApiToken.trim()),
      pushoverEnabled: settings.pushoverEnabled,
      pushoverEventFilters: normalizePushoverEventFilters(settings.pushoverEventFilters),
      pushoverDelaySeconds: settings.pushoverDelaySeconds,
      pushoverBaseUrl: settings.pushoverBaseUrl,
      claudeBinary: settings.claudeBinary,
      codexBinary: settings.codexBinary,
      maxKeepAlive: settings.maxKeepAlive,
      heavyRepoModeEnabled: settings.heavyRepoModeEnabled,
      autoApprovalEnabled: settings.autoApprovalEnabled,
      autoApprovalModel: settings.autoApprovalModel,
      namerConfig: maskNamerConfig(settings.namerConfig),
      autoNamerEnabled: settings.autoNamerEnabled,
      transcriptionConfig: maskTranscriptionConfig(settings.transcriptionConfig),
      editorConfig: settings.editorConfig,
      defaultClaudeBackend: settings.defaultClaudeBackend,
      sleepInhibitorEnabled: settings.sleepInhibitorEnabled,
      sleepInhibitorDurationMinutes: settings.sleepInhibitorDurationMinutes,
      questmasterViewMode: normalizeQuestmasterViewMode(settings.questmasterViewMode),
      questmasterCompactSort: normalizeQuestmasterCompactSort(settings.questmasterCompactSort),
      codexLeaderContextWindowOverrideTokens: settings.codexLeaderContextWindowOverrideTokens,
      ...(typeof settings.codexNonLeaderAutoCompactThresholdPercent === "number"
        ? { codexNonLeaderAutoCompactThresholdPercent: settings.codexNonLeaderAutoCompactThresholdPercent }
        : {}),
      codexLeaderRecycleThresholdTokens: settings.codexLeaderRecycleThresholdTokens,
      codexLeaderRecycleThresholdTokensByModel: settings.codexLeaderRecycleThresholdTokensByModel ?? {},
      ...(extras?.includeRuntimeInfo
        ? {
            restartSupported: !!process.env.COMPANION_SUPERVISED,
            logFile: getLogPath(),
          }
        : {}),
      ...(extras?.claudeDefaultModel !== undefined ? { claudeDefaultModel: extras.claudeDefaultModel } : {}),
    };
  }

  // ─── Caffeinate status ──────────────────────────────────────────

  api.get("/caffeinate-status", (c) => {
    if (!ctx.sleepInhibitor) {
      return c.json({ active: false, engagedAt: null, expiresAt: null });
    }
    return c.json(ctx.sleepInhibitor.getStatus());
  });

  api.get("/settings", async (c) => {
    const settings = getSettings();
    const claudeDefaultModel = await getClaudeUserDefaultModel();
    return c.json(buildSettingsResponse(settings, { claudeDefaultModel, includeRuntimeInfo: true }));
  });

  api.get("/settings/codex-default-model", async (c) => {
    const model = await getCodexUserDefaultModel();
    return c.json({ model });
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsedCodexLeaderRecycleThresholdTokensByModel =
      body.codexLeaderRecycleThresholdTokensByModel !== undefined
        ? parseCodexLeaderRecycleThresholdTokensByModelFromBody(body.codexLeaderRecycleThresholdTokensByModel)
        : null;
    if (body.serverName !== undefined && typeof body.serverName !== "string") {
      return c.json({ error: "serverName must be a string" }, 400);
    }
    if (body.pushoverUserKey !== undefined && typeof body.pushoverUserKey !== "string") {
      return c.json({ error: "pushoverUserKey must be a string" }, 400);
    }
    if (body.pushoverApiToken !== undefined && typeof body.pushoverApiToken !== "string") {
      return c.json({ error: "pushoverApiToken must be a string" }, 400);
    }
    if (
      body.pushoverDelaySeconds !== undefined &&
      (typeof body.pushoverDelaySeconds !== "number" ||
        body.pushoverDelaySeconds < 5 ||
        body.pushoverDelaySeconds > 300)
    ) {
      return c.json({ error: "pushoverDelaySeconds must be a number between 5 and 300" }, 400);
    }
    if (body.pushoverEnabled !== undefined && typeof body.pushoverEnabled !== "boolean") {
      return c.json({ error: "pushoverEnabled must be a boolean" }, 400);
    }
    if (body.pushoverEventFilters !== undefined) {
      if (
        typeof body.pushoverEventFilters !== "object" ||
        body.pushoverEventFilters === null ||
        Array.isArray(body.pushoverEventFilters)
      ) {
        return c.json({ error: "pushoverEventFilters must be an object" }, 400);
      }
      const filters = body.pushoverEventFilters as Record<string, unknown>;
      if (filters.needsInput !== undefined && typeof filters.needsInput !== "boolean") {
        return c.json({ error: "pushoverEventFilters.needsInput must be a boolean" }, 400);
      }
      if (filters.review !== undefined && typeof filters.review !== "boolean") {
        return c.json({ error: "pushoverEventFilters.review must be a boolean" }, 400);
      }
      if (filters.error !== undefined && typeof filters.error !== "boolean") {
        return c.json({ error: "pushoverEventFilters.error must be a boolean" }, 400);
      }
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
    if (
      body.maxKeepAlive !== undefined &&
      (typeof body.maxKeepAlive !== "number" || body.maxKeepAlive < 0 || !Number.isInteger(body.maxKeepAlive))
    ) {
      return c.json({ error: "maxKeepAlive must be a non-negative integer" }, 400);
    }
    if (body.heavyRepoModeEnabled !== undefined && typeof body.heavyRepoModeEnabled !== "boolean") {
      return c.json({ error: "heavyRepoModeEnabled must be a boolean" }, 400);
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
    if (body.editorConfig !== undefined) {
      if (typeof body.editorConfig !== "object" || body.editorConfig === null || Array.isArray(body.editorConfig)) {
        return c.json({ error: "editorConfig must be an object" }, 400);
      }
      const ec = body.editorConfig as Record<string, unknown>;
      if (
        ec.editor !== undefined &&
        ec.editor !== "vscode" &&
        ec.editor !== "vscode-local" &&
        ec.editor !== "vscode-remote" &&
        ec.editor !== "cursor" &&
        ec.editor !== "none"
      ) {
        return c.json(
          { error: 'editorConfig.editor must be "vscode-local", "vscode-remote", "cursor", or "none"' },
          400,
        );
      }
    }
    if (body.sleepInhibitorEnabled !== undefined && typeof body.sleepInhibitorEnabled !== "boolean") {
      return c.json({ error: "sleepInhibitorEnabled must be a boolean" }, 400);
    }
    if (
      body.sleepInhibitorDurationMinutes !== undefined &&
      (typeof body.sleepInhibitorDurationMinutes !== "number" ||
        body.sleepInhibitorDurationMinutes < 1 ||
        body.sleepInhibitorDurationMinutes > 30 ||
        !Number.isInteger(body.sleepInhibitorDurationMinutes))
    ) {
      return c.json({ error: "sleepInhibitorDurationMinutes must be an integer between 1 and 30" }, 400);
    }
    if (
      body.questmasterViewMode !== undefined &&
      body.questmasterViewMode !== "cards" &&
      body.questmasterViewMode !== "compact"
    ) {
      return c.json({ error: 'questmasterViewMode must be "cards" or "compact"' }, 400);
    }
    if (body.questmasterCompactSort !== undefined) {
      if (
        typeof body.questmasterCompactSort !== "object" ||
        body.questmasterCompactSort === null ||
        Array.isArray(body.questmasterCompactSort)
      ) {
        return c.json({ error: "questmasterCompactSort must be an object" }, 400);
      }
      const sort = body.questmasterCompactSort as Record<string, unknown>;
      if (!QUESTMASTER_COMPACT_SORT_COLUMNS.includes(sort.column as QuestmasterCompactSortColumn)) {
        return c.json({ error: "questmasterCompactSort.column is invalid" }, 400);
      }
      if (sort.direction !== "asc" && sort.direction !== "desc") {
        return c.json({ error: 'questmasterCompactSort.direction must be "asc" or "desc"' }, 400);
      }
    }
    if (
      body.codexLeaderContextWindowOverrideTokens !== undefined &&
      (typeof body.codexLeaderContextWindowOverrideTokens !== "number" ||
        body.codexLeaderContextWindowOverrideTokens < 1 ||
        !Number.isInteger(body.codexLeaderContextWindowOverrideTokens))
    ) {
      return c.json({ error: "codexLeaderContextWindowOverrideTokens must be a positive integer" }, 400);
    }
    if (
      body.codexNonLeaderAutoCompactThresholdPercent !== undefined &&
      (typeof body.codexNonLeaderAutoCompactThresholdPercent !== "number" ||
        body.codexNonLeaderAutoCompactThresholdPercent < 1 ||
        body.codexNonLeaderAutoCompactThresholdPercent > 100 ||
        !Number.isInteger(body.codexNonLeaderAutoCompactThresholdPercent))
    ) {
      return c.json({ error: "codexNonLeaderAutoCompactThresholdPercent must be an integer between 1 and 100" }, 400);
    }
    if (
      body.codexLeaderRecycleThresholdTokens !== undefined &&
      (typeof body.codexLeaderRecycleThresholdTokens !== "number" ||
        body.codexLeaderRecycleThresholdTokens < 1 ||
        !Number.isInteger(body.codexLeaderRecycleThresholdTokens))
    ) {
      return c.json({ error: "codexLeaderRecycleThresholdTokens must be a positive integer" }, 400);
    }
    if (
      body.codexLeaderRecycleThresholdTokensByModel !== undefined &&
      parsedCodexLeaderRecycleThresholdTokensByModel &&
      !parsedCodexLeaderRecycleThresholdTokensByModel.ok
    ) {
      return c.json({ error: parsedCodexLeaderRecycleThresholdTokensByModel.error }, 400);
    }

    // Check that at least one known field is present
    const knownFields = [
      "serverName",
      "pushoverUserKey",
      "pushoverApiToken",
      "pushoverDelaySeconds",
      "pushoverEnabled",
      "pushoverEventFilters",
      "pushoverBaseUrl",
      "claudeBinary",
      "codexBinary",
      "maxKeepAlive",
      "heavyRepoModeEnabled",
      "autoApprovalEnabled",
      "autoApprovalModel",
      "namerConfig",
      "autoNamerEnabled",
      "transcriptionConfig",
      "editorConfig",
      "defaultClaudeBackend",
      "sleepInhibitorEnabled",
      "sleepInhibitorDurationMinutes",
      "questmasterViewMode",
      "questmasterCompactSort",
      "codexLeaderContextWindowOverrideTokens",
      "codexNonLeaderAutoCompactThresholdPercent",
      "codexLeaderRecycleThresholdTokens",
      "codexLeaderRecycleThresholdTokensByModel",
    ];
    if (!knownFields.some((f) => body[f] !== undefined)) {
      return c.json({ error: "At least one settings field is required" }, 400);
    }

    if (typeof body.serverName === "string") {
      setServerName(body.serverName);
    }

    const settings = updateSettings({
      pushoverUserKey: typeof body.pushoverUserKey === "string" ? body.pushoverUserKey.trim() : undefined,
      pushoverApiToken: typeof body.pushoverApiToken === "string" ? body.pushoverApiToken.trim() : undefined,
      pushoverDelaySeconds: typeof body.pushoverDelaySeconds === "number" ? body.pushoverDelaySeconds : undefined,
      pushoverEnabled: typeof body.pushoverEnabled === "boolean" ? body.pushoverEnabled : undefined,
      pushoverEventFilters: body.pushoverEventFilters
        ? parsePushoverEventFiltersFromBody(body.pushoverEventFilters as Record<string, unknown>)
        : undefined,
      pushoverBaseUrl: typeof body.pushoverBaseUrl === "string" ? body.pushoverBaseUrl.trim() : undefined,
      claudeBinary: typeof body.claudeBinary === "string" ? body.claudeBinary.trim() : undefined,
      codexBinary: typeof body.codexBinary === "string" ? body.codexBinary.trim() : undefined,
      maxKeepAlive: typeof body.maxKeepAlive === "number" ? body.maxKeepAlive : undefined,
      heavyRepoModeEnabled: typeof body.heavyRepoModeEnabled === "boolean" ? body.heavyRepoModeEnabled : undefined,
      autoApprovalEnabled: typeof body.autoApprovalEnabled === "boolean" ? body.autoApprovalEnabled : undefined,
      autoApprovalModel: typeof body.autoApprovalModel === "string" ? body.autoApprovalModel.trim() : undefined,
      namerConfig: body.namerConfig ? parseNamerConfigFromBody(body.namerConfig) : undefined,
      autoNamerEnabled: typeof body.autoNamerEnabled === "boolean" ? body.autoNamerEnabled : undefined,
      transcriptionConfig: body.transcriptionConfig
        ? parseTranscriptionConfigFromBody(body.transcriptionConfig)
        : undefined,
      editorConfig: body.editorConfig ? parseEditorConfigFromBody(body.editorConfig) : undefined,
      defaultClaudeBackend:
        body.defaultClaudeBackend === "claude" || body.defaultClaudeBackend === "claude-sdk"
          ? body.defaultClaudeBackend
          : undefined,
      sleepInhibitorEnabled: typeof body.sleepInhibitorEnabled === "boolean" ? body.sleepInhibitorEnabled : undefined,
      sleepInhibitorDurationMinutes:
        typeof body.sleepInhibitorDurationMinutes === "number" ? body.sleepInhibitorDurationMinutes : undefined,
      questmasterViewMode:
        body.questmasterViewMode === "cards" || body.questmasterViewMode === "compact"
          ? body.questmasterViewMode
          : undefined,
      questmasterCompactSort:
        body.questmasterCompactSort && typeof body.questmasterCompactSort === "object"
          ? normalizeQuestmasterCompactSort(body.questmasterCompactSort)
          : undefined,
      codexLeaderContextWindowOverrideTokens:
        typeof body.codexLeaderContextWindowOverrideTokens === "number"
          ? body.codexLeaderContextWindowOverrideTokens
          : undefined,
      codexNonLeaderAutoCompactThresholdPercent:
        typeof body.codexNonLeaderAutoCompactThresholdPercent === "number"
          ? body.codexNonLeaderAutoCompactThresholdPercent
          : undefined,
      codexLeaderRecycleThresholdTokens:
        typeof body.codexLeaderRecycleThresholdTokens === "number" ? body.codexLeaderRecycleThresholdTokens : undefined,
      codexLeaderRecycleThresholdTokensByModel: parsedCodexLeaderRecycleThresholdTokensByModel?.ok
        ? parsedCodexLeaderRecycleThresholdTokensByModel.value
        : undefined,
    });

    return c.json(buildSettingsResponse(settings));
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
      const quotedBinary = JSON.stringify(resolved);
      const { stdout } = await execPromise(`${quotedBinary} --version`, {
        timeout: 5_000,
        env: process.env,
      });
      const version = stdout.trim();
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

  return api;
}
