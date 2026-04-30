import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getServerId } from "./settings-manager.js";

export type NewSessionBackend = "claude" | "codex";

export interface NewSessionDefaults {
  backend: NewSessionBackend;
  model: string;
  mode: string;
  askPermission: boolean;
  sessionRole: "worker" | "leader";
  envSlug: string;
  cwd: string;
  useWorktree: boolean;
  codexInternetAccess: boolean;
  codexReasoningEffort: string;
}

export interface StoredNewSessionDefaults {
  defaults: NewSessionDefaults;
  updatedAt: number;
}

interface NewSessionDefaultsState {
  entries: Record<string, StoredNewSessionDefaults>;
}

const DEFAULT_SCOPED_DIR = join(homedir(), ".companion", "new-session-defaults");
const MAX_DEFAULTS = 100;

let state: NewSessionDefaultsState = { entries: {} };
let loaded = false;
let explicitFilePath: string | undefined;
let scopedDir = DEFAULT_SCOPED_DIR;
let configuredServerId: string | undefined;
let pendingWrite: Promise<void> = Promise.resolve();

function sanitizeServerIdForPath(serverId: string): string {
  return serverId.trim().replace(/[^a-zA-Z0-9_.-]/g, "_") || "local";
}

function currentServerId(): string {
  return configuredServerId || getServerId();
}

function currentFilePath(): string {
  if (explicitFilePath) return explicitFilePath;
  return join(scopedDir, `${sanitizeServerIdForPath(currentServerId())}.json`);
}

function normalizeKey(key: string): string {
  return key.trim();
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDefaults(input: unknown): NewSessionDefaults | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const backend = raw.backend === "codex" ? "codex" : "claude";
  return {
    backend,
    model: normalizeString(raw.model),
    mode: normalizeString(raw.mode) || "agent",
    askPermission: raw.askPermission !== false,
    // Match the existing browser cache semantics: leader is a one-off choice,
    // not a remembered default for future sessions in the group.
    sessionRole: "worker",
    envSlug: normalizeString(raw.envSlug),
    cwd: normalizeString(raw.cwd),
    useWorktree: raw.useWorktree === undefined ? true : raw.useWorktree === true,
    codexInternetAccess: raw.codexInternetAccess === true,
    codexReasoningEffort: normalizeString(raw.codexReasoningEffort),
  };
}

function sanitizeState(input: unknown): NewSessionDefaultsState {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { entries: {} };
  const rawEntries = (input as Record<string, unknown>).entries;
  if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) return { entries: {} };

  const entries: Record<string, StoredNewSessionDefaults> = {};
  for (const [rawKey, rawEntry] of Object.entries(rawEntries as Record<string, unknown>)) {
    const key = normalizeKey(rawKey);
    if (!key || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;
    const defaults = normalizeDefaults(entry.defaults);
    if (!defaults) continue;
    const updatedAt = typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0;
    entries[key] = { defaults, updatedAt };
  }
  return { entries: capEntries(entries) };
}

function capEntries(entries: Record<string, StoredNewSessionDefaults>): Record<string, StoredNewSessionDefaults> {
  const pairs = Object.entries(entries);
  if (pairs.length <= MAX_DEFAULTS) return entries;
  const keep = new Set(
    pairs
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_DEFAULTS)
      .map(([key]) => key),
  );
  return Object.fromEntries(pairs.filter(([key]) => keep.has(key)));
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await readFile(currentFilePath(), "utf-8");
    state = sanitizeState(JSON.parse(raw));
  } catch {
    state = { entries: {} };
  }
  loaded = true;
}

function persist(): void {
  const path = currentFilePath();
  const data = JSON.stringify(state, null, 2);
  pendingWrite = pendingWrite
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, "utf-8");
    })
    .catch((err) => {
      console.error("[new-session-defaults-store] persist failed:", err);
    });
}

export async function getDefaults(key: string): Promise<StoredNewSessionDefaults | null> {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return null;
  await ensureLoaded();
  const entry = state.entries[normalizedKey];
  return entry ? { defaults: { ...entry.defaults }, updatedAt: entry.updatedAt } : null;
}

export async function saveDefaults(key: string, defaults: unknown): Promise<StoredNewSessionDefaults | null> {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return null;
  const normalizedDefaults = normalizeDefaults(defaults);
  if (!normalizedDefaults) return null;
  await ensureLoaded();
  const entry = { defaults: normalizedDefaults, updatedAt: Date.now() };
  state.entries[normalizedKey] = entry;
  state.entries = capEntries(state.entries);
  persist();
  return { defaults: { ...entry.defaults }, updatedAt: entry.updatedAt };
}

export function initNewSessionDefaultsStoreForServer(options: { serverId: string }): void {
  configuredServerId = options.serverId;
  explicitFilePath = undefined;
  loaded = false;
}

export function _flushForTest(): Promise<void> {
  return pendingWrite;
}

export function _resetForTest(customPath?: string, options?: { serverId?: string; scopedDir?: string }): void {
  state = { entries: {} };
  loaded = false;
  explicitFilePath = customPath;
  configuredServerId = options?.serverId;
  scopedDir = options?.scopedDir || DEFAULT_SCOPED_DIR;
  pendingWrite = Promise.resolve();
}
