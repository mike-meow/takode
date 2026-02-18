import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export const DEFAULT_OPENROUTER_MODEL = "openrouter/free";

export interface CompanionSettings {
  openrouterApiKey: string;
  openrouterModel: string;
  /** Display name for this server instance */
  serverName: string;
  /** Stable unique identifier for this server instance (auto-generated UUID) */
  serverId: string;
  updatedAt: number;
}

const DEFAULT_PATH = join(homedir(), ".companion", "settings.json");

let loaded = false;
let filePath = DEFAULT_PATH;
let settings: CompanionSettings = {
  openrouterApiKey: "",
  openrouterModel: DEFAULT_OPENROUTER_MODEL,
  serverName: "",
  serverId: "",
  updatedAt: 0,
};

function normalize(raw: Partial<CompanionSettings> | null | undefined): CompanionSettings {
  return {
    openrouterApiKey: typeof raw?.openrouterApiKey === "string" ? raw.openrouterApiKey : "",
    openrouterModel:
      typeof raw?.openrouterModel === "string" && raw.openrouterModel.trim()
        ? raw.openrouterModel
        : DEFAULT_OPENROUTER_MODEL,
    serverName: typeof raw?.serverName === "string" ? raw.serverName : "",
    serverId: typeof raw?.serverId === "string" ? raw.serverId : "",
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
  patch: Partial<Pick<CompanionSettings, "openrouterApiKey" | "openrouterModel">>,
): CompanionSettings {
  ensureLoaded();
  settings = {
    ...settings,
    ...patch,
    openrouterModel: (patch.openrouterModel && patch.openrouterModel.trim()) || settings.openrouterModel || DEFAULT_OPENROUTER_MODEL,
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

export function _resetForTest(customPath?: string): void {
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  settings = normalize(null);
}
