import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface CompanionSettings {
  /** Display name for this server instance */
  serverName: string;
  /** Stable unique identifier for this server instance (auto-generated UUID) */
  serverId: string;
  /** Pushover user key for push notifications */
  pushoverUserKey: string;
  /** Pushover API/app token */
  pushoverApiToken: string;
  /** Seconds to wait before sending a push notification (default: 30) */
  pushoverDelaySeconds: number;
  /** Whether Pushover notifications are enabled (default: true) */
  pushoverEnabled: boolean;
  /** External base URL for deep links in push notifications */
  pushoverBaseUrl: string;
  /** Custom Claude Code CLI binary path or command (empty = auto-detect "claude") */
  claudeBinary: string;
  /** Custom Codex CLI binary path or command (empty = auto-detect "codex") */
  codexBinary: string;
  /** Default backend for new Claude Code sessions: "claude" (WebSocket) or "claude-sdk" (Agent SDK) */
  defaultClaudeBackend: "claude" | "claude-sdk";
  /** Max number of live CLI processes to keep alive (0 = unlimited) */
  maxKeepAlive: number;
  /** Whether session list git refreshes should run in the background for large/slow repos */
  heavyRepoModeEnabled: boolean;
  /** Whether LLM auto-approval is enabled globally (default: false) */
  autoApprovalEnabled: boolean;
  /** Model to use for auto-approval LLM calls (empty = use session model, falls back to "haiku") */
  autoApprovalModel: string;
  /** Max concurrent auto-approval LLM subprocess calls (default: 4) */
  autoApprovalMaxConcurrency: number;
  /** Timeout in seconds for each auto-approval LLM call (default: 45) */
  autoApprovalTimeoutSeconds: number;
  /** Session auto-namer backend configuration */
  namerConfig: NamerConfig;
  /** Whether the AI session auto-namer is enabled (default: true) */
  autoNamerEnabled: boolean;
  /** Voice transcription configuration */
  transcriptionConfig: TranscriptionConfig;
  /** Preferred local editor for clickable file: links */
  editorConfig: EditorConfig;
  /** Whether sleep inhibition via caffeinate is enabled (macOS only, default: false) */
  sleepInhibitorEnabled: boolean;
  /** Duration in minutes for each caffeinate engagement (default: 5, minimum: 1) */
  sleepInhibitorDurationMinutes: number;
  updatedAt: number;
}

/** Enhancement output style: "default" = clean prose paragraphs, "bullet" = structured bullet points. */
export type EnhancementMode = "default" | "bullet";

/** Available OpenAI STT models. */
export const STT_MODELS = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe-2025-12-15"] as const;
export type SttModel = (typeof STT_MODELS)[number];

/** Configuration for voice transcription (STT + optional LLM enhancement). */
export interface TranscriptionConfig {
  /** OpenAI-compatible API key (used for both Whisper STT and enhancement) */
  apiKey: string;
  /** Base URL for the enhancement LLM (default: OpenAI) */
  baseUrl: string;
  /** Whether context-aware LLM enhancement is enabled */
  enhancementEnabled: boolean;
  /** Model to use for enhancement (e.g. "gpt-5-mini", "gpt-4o") */
  enhancementModel: string;
  /** Comma-separated custom vocabulary terms for STT recognition (e.g. "Takode, LiteLLM, worktree") */
  customVocabulary?: string;
  /** Enhancement output style. Optional for backward compat — undefined treated as "default". */
  enhancementMode?: EnhancementMode;
  /** OpenAI STT model to use for speech-to-text. */
  sttModel?: SttModel;
  /** Preferred voice capture mode when composer has text: "edit" (interpret as instructions) or "append" (add text). */
  voiceCaptureMode?: "edit" | "append";
}

export type EditorKind = "vscode-local" | "vscode-remote" | "cursor" | "none";

export interface EditorConfig {
  editor: EditorKind;
}

/** Discriminated union for session auto-namer backend. */
export type NamerConfig =
  | { backend: "claude"; model?: string }
  | { backend: "openai"; apiKey: string; baseUrl: string; model: string };

interface CompanionSecrets {
  namerOpenAIApiKey: string;
  transcriptionApiKey: string;
}

const DEFAULT_PATH = join(homedir(), ".companion", "settings.json");
/** Shared legacy path — exported for tests only */
export const LEGACY_PATH = DEFAULT_PATH;
const DEFAULT_SECRETS_PATH = join(homedir(), ".companion", "settings-secrets.json");

let loaded = false;
let secretsLoaded = false;
let filePath = DEFAULT_PATH;
let secretsPath = DEFAULT_SECRETS_PATH;
let _pendingWrite: Promise<void> = Promise.resolve();
let _pendingSecretsWrite: Promise<void> = Promise.resolve();
let settings: CompanionSettings = {
  serverName: "",
  serverId: "",
  pushoverUserKey: "",
  pushoverApiToken: "",
  pushoverDelaySeconds: 30,
  pushoverEnabled: true,
  pushoverBaseUrl: "",
  claudeBinary: "",
  codexBinary: "",
  defaultClaudeBackend: "claude",
  maxKeepAlive: 0,
  heavyRepoModeEnabled: false,
  autoApprovalEnabled: false,
  autoApprovalModel: "",
  autoApprovalMaxConcurrency: 4,
  autoApprovalTimeoutSeconds: 45,
  namerConfig: { backend: "claude" },
  autoNamerEnabled: true,
  transcriptionConfig: {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    enhancementEnabled: true,
    enhancementModel: "gpt-5-mini",
    customVocabulary: "",
    enhancementMode: "default",
    sttModel: "gpt-4o-mini-transcribe",
  },
  editorConfig: { editor: "none" },
  sleepInhibitorEnabled: false,
  sleepInhibitorDurationMinutes: 5,
  updatedAt: 0,
};
let secrets: CompanionSecrets = {
  namerOpenAIApiKey: "",
  transcriptionApiKey: "",
};

function deriveSecretsPath(settingsPath: string): string {
  const dir = dirname(settingsPath);
  const file = basename(settingsPath);
  if (file === "settings.json") return join(dir, "settings-secrets.json");
  const match = /^settings-(.+)\.json$/.exec(file);
  if (match) return join(dir, `settings-secrets-${match[1]}.json`);
  const ext = extname(file);
  const stem = ext ? file.slice(0, -ext.length) : file;
  return join(dir, `${stem}.secrets${ext || ".json"}`);
}

function resetPaths(nextFilePath: string): void {
  filePath = nextFilePath;
  secretsPath = deriveSecretsPath(nextFilePath);
}

/** Parse namerConfig from raw settings, with backward compat for old flat fields. */
function normalizeNamerConfig(raw: Record<string, unknown> | null | undefined): NamerConfig {
  // New format: namerConfig object
  const cfg = raw?.namerConfig;
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const c = cfg as Record<string, unknown>;
    if (c.backend === "openai") {
      return {
        backend: "openai",
        apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
        baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : "",
        model: typeof c.model === "string" ? c.model : "",
      };
    }
    return { backend: "claude" };
  }
  // Backward compat: migrate from old flat fields (namerBackend, namerOpenaiApiKey, etc.)
  if (raw?.namerBackend === "openai") {
    return {
      backend: "openai",
      apiKey: typeof raw.namerOpenaiApiKey === "string" ? raw.namerOpenaiApiKey : "",
      baseUrl: typeof raw.namerOpenaiBaseUrl === "string" ? raw.namerOpenaiBaseUrl : "",
      model: typeof raw.namerOpenaiModel === "string" ? raw.namerOpenaiModel : "",
    };
  }
  return { backend: "claude" };
}

function normalizeTranscriptionConfig(raw: Record<string, unknown> | null | undefined): TranscriptionConfig {
  const cfg = raw?.transcriptionConfig;
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const c = cfg as Record<string, unknown>;
    const rawSttModel = typeof c.sttModel === "string" ? c.sttModel : "";
    const sttModel = (STT_MODELS as readonly string[]).includes(rawSttModel)
      ? (rawSttModel as SttModel)
      : "gpt-4o-mini-transcribe";
    const rawEnhancementMode = typeof c.enhancementMode === "string" ? c.enhancementMode : "";
    const enhancementMode: EnhancementMode =
      rawEnhancementMode === "default" || rawEnhancementMode === "bullet" ? rawEnhancementMode : "default";
    const rawVoiceCaptureMode = typeof c.voiceCaptureMode === "string" ? c.voiceCaptureMode : "";
    const voiceCaptureMode: "edit" | "append" | undefined =
      rawVoiceCaptureMode === "edit" || rawVoiceCaptureMode === "append" ? rawVoiceCaptureMode : undefined;
    return {
      apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
      baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : "https://api.openai.com/v1",
      enhancementEnabled: typeof c.enhancementEnabled === "boolean" ? c.enhancementEnabled : true,
      enhancementModel: typeof c.enhancementModel === "string" ? c.enhancementModel : "gpt-5-mini",
      customVocabulary: typeof c.customVocabulary === "string" ? c.customVocabulary : "",
      sttModel,
      enhancementMode,
      voiceCaptureMode,
    };
  }
  return {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    enhancementEnabled: true,
    enhancementModel: "gpt-5-mini",
    customVocabulary: "",
    sttModel: "gpt-4o-mini-transcribe",
    enhancementMode: "default",
  };
}

function normalizeEditorConfig(raw: Record<string, unknown> | null | undefined): EditorConfig {
  const cfg = raw?.editorConfig;
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const c = cfg as Record<string, unknown>;
    const editor = c.editor;
    if (editor === "vscode-local" || editor === "vscode-remote" || editor === "cursor" || editor === "none") {
      return { editor };
    }
    if (editor === "vscode") {
      return { editor: "vscode-local" };
    }
  }
  return { editor: "none" };
}

function normalizeSecrets(raw: Record<string, unknown> | null | undefined): CompanionSecrets {
  return {
    namerOpenAIApiKey: typeof raw?.namerOpenAIApiKey === "string" ? raw.namerOpenAIApiKey : "",
    transcriptionApiKey: typeof raw?.transcriptionApiKey === "string" ? raw.transcriptionApiKey : "",
  };
}

function mergeSecretsIntoSettings(base: CompanionSettings, nextSecrets: CompanionSecrets): CompanionSettings {
  return {
    ...base,
    namerConfig:
      base.namerConfig.backend === "openai"
        ? { ...base.namerConfig, apiKey: nextSecrets.namerOpenAIApiKey }
        : base.namerConfig,
    transcriptionConfig: {
      ...base.transcriptionConfig,
      apiKey: nextSecrets.transcriptionApiKey,
    },
  };
}

function stripSecretsFromSettings(base: CompanionSettings): CompanionSettings {
  return {
    ...base,
    namerConfig: base.namerConfig.backend === "openai" ? { ...base.namerConfig, apiKey: "" } : base.namerConfig,
    transcriptionConfig: {
      ...base.transcriptionConfig,
      apiKey: "",
    },
  };
}

function hasInlineSecrets(base: CompanionSettings): boolean {
  return (
    (base.namerConfig.backend === "openai" && base.namerConfig.apiKey.length > 0) ||
    base.transcriptionConfig.apiKey.length > 0
  );
}

function normalize(raw: Partial<CompanionSettings> | null | undefined): CompanionSettings {
  return {
    serverName: typeof raw?.serverName === "string" ? raw.serverName : "",
    serverId: typeof raw?.serverId === "string" ? raw.serverId : "",
    pushoverUserKey: typeof raw?.pushoverUserKey === "string" ? raw.pushoverUserKey : "",
    pushoverApiToken: typeof raw?.pushoverApiToken === "string" ? raw.pushoverApiToken : "",
    pushoverDelaySeconds:
      typeof raw?.pushoverDelaySeconds === "number" && raw.pushoverDelaySeconds >= 5 ? raw.pushoverDelaySeconds : 30,
    pushoverEnabled: typeof raw?.pushoverEnabled === "boolean" ? raw.pushoverEnabled : true,
    pushoverBaseUrl: typeof raw?.pushoverBaseUrl === "string" ? raw.pushoverBaseUrl : "",
    claudeBinary: typeof raw?.claudeBinary === "string" ? raw.claudeBinary : "",
    codexBinary: typeof raw?.codexBinary === "string" ? raw.codexBinary : "",
    defaultClaudeBackend:
      raw?.defaultClaudeBackend === "claude" || raw?.defaultClaudeBackend === "claude-sdk"
        ? raw.defaultClaudeBackend
        : "claude",
    maxKeepAlive: typeof raw?.maxKeepAlive === "number" && raw.maxKeepAlive >= 0 ? Math.floor(raw.maxKeepAlive) : 0,
    heavyRepoModeEnabled: typeof raw?.heavyRepoModeEnabled === "boolean" ? raw.heavyRepoModeEnabled : false,
    autoApprovalEnabled: typeof raw?.autoApprovalEnabled === "boolean" ? raw.autoApprovalEnabled : false,
    autoApprovalModel: typeof raw?.autoApprovalModel === "string" ? raw.autoApprovalModel : "",
    autoApprovalMaxConcurrency:
      typeof raw?.autoApprovalMaxConcurrency === "number" && raw.autoApprovalMaxConcurrency >= 1
        ? Math.floor(raw.autoApprovalMaxConcurrency)
        : 4,
    autoApprovalTimeoutSeconds:
      typeof raw?.autoApprovalTimeoutSeconds === "number" && raw.autoApprovalTimeoutSeconds >= 5
        ? Math.floor(raw.autoApprovalTimeoutSeconds)
        : 45,
    namerConfig: normalizeNamerConfig(raw),
    autoNamerEnabled: typeof raw?.autoNamerEnabled === "boolean" ? raw.autoNamerEnabled : true,
    transcriptionConfig: normalizeTranscriptionConfig(raw),
    editorConfig: normalizeEditorConfig(raw),
    sleepInhibitorEnabled: typeof raw?.sleepInhibitorEnabled === "boolean" ? raw.sleepInhibitorEnabled : false,
    sleepInhibitorDurationMinutes:
      typeof raw?.sleepInhibitorDurationMinutes === "number" && raw.sleepInhibitorDurationMinutes >= 1
        ? Math.floor(raw.sleepInhibitorDurationMinutes)
        : 5,
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function loadSecretsFromDisk(): CompanionSecrets {
  try {
    if (existsSync(secretsPath)) {
      // sync-ok: cold path, cached after first load
      const raw = readFileSync(secretsPath, "utf-8"); // sync-ok: cold path, cached after first load
      return normalizeSecrets(JSON.parse(raw) as Record<string, unknown>);
    }
  } catch {
    return normalizeSecrets(null);
  }
  return normalizeSecrets(null);
}

function ensureLoaded(): void {
  if (loaded) return;
  let normalized = normalize(null);
  try {
    if (existsSync(filePath)) {
      // sync-ok: cold path, cached after first load
      const raw = readFileSync(filePath, "utf-8"); // sync-ok: cold path, cached after first load
      normalized = normalize(JSON.parse(raw) as Partial<CompanionSettings>);
    }
  } catch {
    normalized = normalize(null);
  }

  if (!secretsLoaded) {
    const persistedSecrets = loadSecretsFromDisk();
    secrets = {
      namerOpenAIApiKey:
        persistedSecrets.namerOpenAIApiKey ||
        (normalized.namerConfig.backend === "openai" ? normalized.namerConfig.apiKey : ""),
      transcriptionApiKey: persistedSecrets.transcriptionApiKey || normalized.transcriptionConfig.apiKey,
    };
    secretsLoaded = true;
  }

  settings = mergeSecretsIntoSettings(normalized, secrets);

  if (hasInlineSecrets(normalized)) {
    persist();
    persistSecrets();
  }
  loaded = true;
}

function persist(): void {
  const data = JSON.stringify(stripSecretsFromSettings(settings), null, 2);
  const path = filePath; // capture current path before any async re-assignment
  mkdirSync(dirname(path), { recursive: true });
  // Chain writes so each waits for the previous to finish. This prevents
  // an earlier write from completing after a later one and overwriting it.
  _pendingWrite = _pendingWrite.then(() => writeFile(path, data, "utf-8").catch(() => {}));
}

function persistSecrets(): void {
  const data = JSON.stringify(secrets, null, 2);
  const path = secretsPath; // capture current path before any async re-assignment
  mkdirSync(dirname(path), { recursive: true });
  _pendingSecretsWrite = _pendingSecretsWrite.then(() => writeFile(path, data, "utf-8").catch(() => {}));
}

export function getSettings(): CompanionSettings {
  ensureLoaded();
  return { ...settings };
}

export function updateSettings(
  patch: Partial<
    Pick<
      CompanionSettings,
      | "pushoverUserKey"
      | "pushoverApiToken"
      | "pushoverDelaySeconds"
      | "pushoverEnabled"
      | "pushoverBaseUrl"
      | "claudeBinary"
      | "codexBinary"
      | "defaultClaudeBackend"
      | "maxKeepAlive"
      | "heavyRepoModeEnabled"
      | "autoApprovalEnabled"
      | "autoApprovalModel"
      | "autoApprovalMaxConcurrency"
      | "autoApprovalTimeoutSeconds"
      | "namerConfig"
      | "autoNamerEnabled"
      | "transcriptionConfig"
      | "editorConfig"
      | "sleepInhibitorEnabled"
      | "sleepInhibitorDurationMinutes"
    >
  >,
): CompanionSettings {
  ensureLoaded();
  // Filter out undefined values so they don't overwrite existing settings
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));

  if (defined.namerConfig) {
    const nextNamerConfig = defined.namerConfig as NamerConfig;
    if (nextNamerConfig.backend === "openai") {
      secrets = {
        ...secrets,
        namerOpenAIApiKey: nextNamerConfig.apiKey,
      };
    }
  }

  if (defined.transcriptionConfig) {
    const nextTranscriptionConfig = defined.transcriptionConfig as TranscriptionConfig;
    secrets = {
      ...secrets,
      transcriptionApiKey: nextTranscriptionConfig.apiKey,
    };
  }

  settings = {
    ...settings,
    ...defined,
    updatedAt: Date.now(),
  };
  settings = mergeSecretsIntoSettings(settings, secrets);
  persist();
  if (defined.namerConfig || defined.transcriptionConfig) {
    persistSecrets();
  }
  return { ...settings };
}

export function getServerName(): string {
  ensureLoaded();
  return settings.serverName;
}

export function setServerName(name: string): void {
  ensureLoaded();
  settings = { ...settings, serverName: name.trim(), updatedAt: Date.now() };
  persist();
}

export function getServerId(): string {
  ensureLoaded();
  if (!settings.serverId) {
    settings = { ...settings, serverId: randomUUID(), updatedAt: Date.now() };
    persist();
  }
  return settings.serverId;
}

/**
 * Scope settings to a port-specific file (`settings-{port}.json`).
 * Must be called once at server startup, before any settings access.
 * On first use, migrates from the legacy shared `settings.json` (if it exists)
 * but clears `serverId` so each instance gets its own unique identity.
 */
export async function initWithPort(port: number): Promise<void> {
  const portPath = join(homedir(), ".companion", `settings-${port}.json`);
  const portSecretsPath = deriveSecretsPath(portPath);
  if (!existsSync(portPath) && existsSync(LEGACY_PATH)) {
    // sync-ok: cold path, cached after first load
    try {
      const raw = readFileSync(LEGACY_PATH, "utf-8"); // sync-ok: cold path, cached after first load
      const legacy = normalize(JSON.parse(raw) as Partial<CompanionSettings>);
      const migrated = {
        ...stripSecretsFromSettings(legacy),
        serverId: "",
        updatedAt: Date.now(),
      };
      const migratedSecrets = normalizeSecrets({
        namerOpenAIApiKey: legacy.namerConfig.backend === "openai" ? legacy.namerConfig.apiKey : "",
        transcriptionApiKey: legacy.transcriptionConfig.apiKey,
      });
      mkdirSync(dirname(portPath), { recursive: true });
      await writeFile(portPath, JSON.stringify(migrated, null, 2), "utf-8");
      if (migratedSecrets.namerOpenAIApiKey || migratedSecrets.transcriptionApiKey) {
        await writeFile(portSecretsPath, JSON.stringify(migratedSecrets, null, 2), "utf-8");
      }
    } catch {
      // Migration failed — start fresh from the new path
    }
  }
  resetPaths(portPath);
  loaded = false;
  secretsLoaded = false;
}

/** Wait for any pending async writes to complete. Test-only. */
export function _flushForTest(): Promise<void> {
  return Promise.all([_pendingWrite, _pendingSecretsWrite]).then(() => undefined);
}

export function _resetForTest(customPath?: string): void {
  loaded = false;
  secretsLoaded = false;
  resetPaths(customPath || DEFAULT_PATH);
  settings = normalize(null);
  secrets = normalizeSecrets(null);
  _pendingWrite = Promise.resolve();
  _pendingSecretsWrite = Promise.resolve();
}

export function _getSecretsPathForTest(customSettingsPath?: string): string {
  return deriveSecretsPath(customSettingsPath || filePath);
}

/**
 * Read the user's configured default model from ~/.claude/settings.json.
 * Returns empty string if the file doesn't exist, isn't valid JSON, or
 * has no model field. This is the user-level default — project-level
 * settings may override it in the CLI, which is why session creation
 * should pass it explicitly when the user selects "Default".
 */
export async function getClaudeUserDefaultModel(): Promise<string> {
  try {
    const raw = await readFile(join(homedir(), ".claude", "settings.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.model === "string") return parsed.model;
  } catch {
    // File doesn't exist or isn't valid JSON
  }
  return "";
}
