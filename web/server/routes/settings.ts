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
} from "../settings-manager.js";
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
      .filter((s) => s.state !== "exited" && wsBridge.isSessionBusy(s.sessionId));
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

  api.get("/settings", async (c) => {
    const settings = getSettings();
    const claudeDefaultModel = await getClaudeUserDefaultModel();
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
      transcriptionConfig: maskTranscriptionConfig(settings.transcriptionConfig),
      editorConfig: settings.editorConfig,
      restartSupported: !!process.env.COMPANION_SUPERVISED,
      logFile: getLogPath(),
      claudeDefaultModel,
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

    // Check that at least one known field is present
    const knownFields = [
      "serverName",
      "pushoverUserKey",
      "pushoverApiToken",
      "pushoverDelaySeconds",
      "pushoverEnabled",
      "pushoverBaseUrl",
      "claudeBinary",
      "codexBinary",
      "maxKeepAlive",
      "autoApprovalEnabled",
      "autoApprovalModel",
      "namerConfig",
      "autoNamerEnabled",
      "transcriptionConfig",
      "editorConfig",
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
      pushoverBaseUrl: typeof body.pushoverBaseUrl === "string" ? body.pushoverBaseUrl.trim() : undefined,
      claudeBinary: typeof body.claudeBinary === "string" ? body.claudeBinary.trim() : undefined,
      codexBinary: typeof body.codexBinary === "string" ? body.codexBinary.trim() : undefined,
      maxKeepAlive: typeof body.maxKeepAlive === "number" ? body.maxKeepAlive : undefined,
      autoApprovalEnabled: typeof body.autoApprovalEnabled === "boolean" ? body.autoApprovalEnabled : undefined,
      autoApprovalModel: typeof body.autoApprovalModel === "string" ? body.autoApprovalModel.trim() : undefined,
      namerConfig: body.namerConfig ? parseNamerConfigFromBody(body.namerConfig) : undefined,
      autoNamerEnabled: typeof body.autoNamerEnabled === "boolean" ? body.autoNamerEnabled : undefined,
      transcriptionConfig: body.transcriptionConfig
        ? parseTranscriptionConfigFromBody(body.transcriptionConfig)
        : undefined,
      editorConfig: body.editorConfig ? parseEditorConfigFromBody(body.editorConfig) : undefined,
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
      transcriptionConfig: maskTranscriptionConfig(settings.transcriptionConfig),
      editorConfig: settings.editorConfig,
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
