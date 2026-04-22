import { Hono } from "hono";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { resolveBinary, getEnrichedPath } from "../path-resolver.js";
import {
  getSettings,
  updateSettings,
  getServerName,
  setServerName,
  getServerId,
  getClaudeUserDefaultModel,
  STT_MODELS,
  type NamerConfig,
  type TranscriptionConfig,
  type SttModel,
  type EditorConfig,
  type EnhancementMode,
  type QuestmasterViewMode,
} from "../settings-manager.js";
import { DEFAULT_PUSHOVER_EVENT_FILTERS, type PushoverEventFilters } from "../pushover.js";
import { getLogPath } from "../server-logger.js";
import type { RouteContext } from "./context.js";

export function createSettingsRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, wsBridge, options, pushoverNotifier } = ctx;
  const execPromise = promisify(execCb);

  // ─── Server restart ───────────────────────────────────────────────

  api.post("/server/restart", (c) => {
    if (!options?.requestRestart) {
      return c.json({ error: "Restart not supported in this mode" }, 503);
    }
    // Block restart while sessions are actively running to prevent stuck sessions
    const busySessions = launcher
      .listSessions()
      .filter((s) => {
        if (s.state === "exited") return false;
        const bridgeSession = wsBridge.getSession(s.sessionId);
        return !!(bridgeSession?.isGenerating || bridgeSession?.pendingPermissions.size);
      });
    if (busySessions.length > 0) {
      const names = busySessions.map((s) => {
        const num = launcher.getSessionNum(s.sessionId);
        return s.name || (num != null ? `#${num}` : s.sessionId.slice(0, 8));
      });
      return c.json(
        {
          error: `Cannot restart while ${busySessions.length} session(s) are running. Please stop them first: ${names.join(", ")}`,
        },
        409,
      );
    }
    options.requestRestart();
    return c.json({ ok: true });
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
