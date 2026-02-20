import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
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
  updatedAt: number;
}

const DEFAULT_PATH = join(homedir(), ".companion", "settings.json");
/** Shared legacy path — exported for tests only */
export const LEGACY_PATH = DEFAULT_PATH;

let loaded = false;
let filePath = DEFAULT_PATH;
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
  updatedAt: 0,
};

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
    updatedAt: typeof raw?.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      settings = normalize(JSON.parse(raw) as Partial<CompanionSettings>);
    }
  } catch {
    settings = normalize(null);
  }
  loaded = true;
}

function persist(): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2), "utf-8");
}

export function getSettings(): CompanionSettings {
  ensureLoaded();
  return { ...settings };
}

export function updateSettings(
  patch: Partial<Pick<CompanionSettings,
    "pushoverUserKey" | "pushoverApiToken" | "pushoverDelaySeconds" | "pushoverEnabled" | "pushoverBaseUrl" | "claudeBinary" | "codexBinary"
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
export function initWithPort(port: number): void {
  const portPath = join(homedir(), ".companion", `settings-${port}.json`);
  if (!existsSync(portPath) && existsSync(LEGACY_PATH)) {
    try {
      const raw = readFileSync(LEGACY_PATH, "utf-8");
      const legacy = normalize(JSON.parse(raw) as Partial<CompanionSettings>);
      const migrated = { ...legacy, serverId: "", updatedAt: Date.now() };
      mkdirSync(dirname(portPath), { recursive: true });
      writeFileSync(portPath, JSON.stringify(migrated, null, 2), "utf-8");
    } catch {
      // Migration failed — start fresh from the new path
    }
  }
  filePath = portPath;
  loaded = false;
}

export function _resetForTest(customPath?: string): void {
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  settings = normalize(null);
}
