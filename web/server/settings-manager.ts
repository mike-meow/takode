import {
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
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
  /** Max number of live CLI processes to keep alive (0 = unlimited) */
  maxKeepAlive: number;
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
  updatedAt: number;
}

/** Configuration for voice transcription (STT + optional LLM enhancement). */
export interface TranscriptionConfig {
  /** OpenAI-compatible API key (used for both Whisper STT and enhancement) */
  apiKey: string;
  /** Base URL for the enhancement LLM (default: OpenAI) */
  baseUrl: string;
  /** Whether context-aware LLM enhancement is enabled */
  enhancementEnabled: boolean;
  /** Model to use for enhancement (e.g. "gpt-4o-mini", "gpt-4o") */
  enhancementModel: string;
}

/** Discriminated union for session auto-namer backend. */
export type NamerConfig =
  | { backend: "claude"; model?: string }
  | { backend: "openai"; apiKey: string; baseUrl: string; model: string };

const DEFAULT_PATH = join(homedir(), ".companion", "settings.json");
/** Shared legacy path — exported for tests only */
export const LEGACY_PATH = DEFAULT_PATH;

let loaded = false;
let filePath = DEFAULT_PATH;
let _pendingWrite: Promise<void> = Promise.resolve();
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
  maxKeepAlive: 0,
  autoApprovalEnabled: false,
  autoApprovalModel: "",
  autoApprovalMaxConcurrency: 4,
  autoApprovalTimeoutSeconds: 45,
  namerConfig: { backend: "claude" },
  autoNamerEnabled: true,
  transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-4o-mini" },
  updatedAt: 0,
};

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
    return {
      apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
      baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : "https://api.openai.com/v1",
      enhancementEnabled: typeof c.enhancementEnabled === "boolean" ? c.enhancementEnabled : true,
      enhancementModel: typeof c.enhancementModel === "string" ? c.enhancementModel : "gpt-4o-mini",
    };
  }
  return { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-4o-mini" };
}

function normalize(raw: Partial<CompanionSettings> | null | undefined): CompanionSettings {
  return {
    serverName: typeof raw?.serverName === "string" ? raw.serverName : "",
    serverId: typeof raw?.serverId === "string" ? raw.serverId : "",
    pushoverUserKey: typeof raw?.pushoverUserKey === "string" ? raw.pushoverUserKey : "",
    pushoverApiToken: typeof raw?.pushoverApiToken === "string" ? raw.pushoverApiToken : "",
    pushoverDelaySeconds: typeof raw?.pushoverDelaySeconds === "number" && raw.pushoverDelaySeconds >= 5 ? raw.pushoverDelaySeconds : 30,
    pushoverEnabled: typeof raw?.pushoverEnabled === "boolean" ? raw.pushoverEnabled : true,
    pushoverBaseUrl: typeof raw?.pushoverBaseUrl === "string" ? raw.pushoverBaseUrl : "",
    claudeBinary: typeof raw?.claudeBinary === "string" ? raw.claudeBinary : "",
    codexBinary: typeof raw?.codexBinary === "string" ? raw.codexBinary : "",
    maxKeepAlive: typeof raw?.maxKeepAlive === "number" && raw.maxKeepAlive >= 0 ? Math.floor(raw.maxKeepAlive) : 0,
    autoApprovalEnabled: typeof raw?.autoApprovalEnabled === "boolean" ? raw.autoApprovalEnabled : false,
    autoApprovalModel: typeof raw?.autoApprovalModel === "string" ? raw.autoApprovalModel : "",
    autoApprovalMaxConcurrency: typeof raw?.autoApprovalMaxConcurrency === "number" && raw.autoApprovalMaxConcurrency >= 1 ? Math.floor(raw.autoApprovalMaxConcurrency) : 4,
    autoApprovalTimeoutSeconds: typeof raw?.autoApprovalTimeoutSeconds === "number" && raw.autoApprovalTimeoutSeconds >= 5 ? Math.floor(raw.autoApprovalTimeoutSeconds) : 45,
    namerConfig: normalizeNamerConfig(raw),
    autoNamerEnabled: typeof raw?.autoNamerEnabled === "boolean" ? raw.autoNamerEnabled : true,
    transcriptionConfig: normalizeTranscriptionConfig(raw),
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) { // sync-ok: cold path, cached after first load
      const raw = readFileSync(filePath, "utf-8"); // sync-ok: cold path, cached after first load
      settings = normalize(JSON.parse(raw) as Partial<CompanionSettings>);
    }
  } catch {
    settings = normalize(null);
  }
  loaded = true;
}

function persist(): void {
  const data = JSON.stringify(settings, null, 2);
  const path = filePath; // capture current path before any async re-assignment
  mkdirSync(dirname(path), { recursive: true });
  // Chain writes so each waits for the previous to finish. This prevents
  // an earlier write from completing after a later one and overwriting it.
  _pendingWrite = _pendingWrite.then(() =>
    writeFile(path, data, "utf-8").catch(() => {}),
  );
}

export function getSettings(): CompanionSettings {
  ensureLoaded();
  return { ...settings };
}

export function updateSettings(
  patch: Partial<Pick<CompanionSettings,
    "pushoverUserKey" | "pushoverApiToken" | "pushoverDelaySeconds" | "pushoverEnabled" | "pushoverBaseUrl" | "claudeBinary" | "codexBinary" | "maxKeepAlive" | "autoApprovalEnabled" | "autoApprovalModel" | "autoApprovalMaxConcurrency" | "autoApprovalTimeoutSeconds" | "namerConfig" | "autoNamerEnabled" | "transcriptionConfig"
  >>,
): CompanionSettings {
  ensureLoaded();
  // Filter out undefined values so they don't overwrite existing settings
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  settings = {
    ...settings,
    ...defined,
    updatedAt: Date.now(),
  };
  persist();
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
  if (!existsSync(portPath) && existsSync(LEGACY_PATH)) { // sync-ok: cold path, cached after first load
    try {
      const raw = readFileSync(LEGACY_PATH, "utf-8"); // sync-ok: cold path, cached after first load
      const legacy = normalize(JSON.parse(raw) as Partial<CompanionSettings>);
      const migrated = { ...legacy, serverId: "", updatedAt: Date.now() };
      mkdirSync(dirname(portPath), { recursive: true });
      await writeFile(portPath, JSON.stringify(migrated, null, 2), "utf-8");
    } catch {
      // Migration failed — start fresh from the new path
    }
  }
  filePath = portPath;
  loaded = false;
}

/** Wait for any pending async writes to complete. Test-only. */
export function _flushForTest(): Promise<void> {
  return _pendingWrite;
}

export function _resetForTest(customPath?: string): void {
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  settings = normalize(null);
  _pendingWrite = Promise.resolve();
}
