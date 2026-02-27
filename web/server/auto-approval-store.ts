/**
 * Per-project auto-approval config store.
 *
 * All configs live in a single JSON file (`~/.companion/auto-approval.json`)
 * as an array. This minimizes NFS round-trips: one readFile to load, one
 * writeFile to save — no readdir or per-file I/O.
 *
 * Writes are chained via `_pendingWrite` (same pattern as settings-manager.ts)
 * to prevent concurrent writes from interleaving.
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AutoApprovalConfig {
  /** Canonical absolute path to the project directory (primary / first path) */
  projectPath: string;
  /** All project paths this rule applies to. When present, supersedes projectPath for matching. */
  projectPaths?: string[];
  /** Human-readable label (e.g. "companion", "my-api") */
  label: string;
  /** Stable slug derived from hashing projectPath — used as identifier */
  slug: string;
  /** Free-form natural language criteria for auto-approval */
  criteria: string;
  /** Whether this config is active */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
let storePath = join(COMPANION_DIR, "auto-approval.json");

// Cold-path: ensure parent dir exists at module load.
mkdirSync(dirname(storePath), { recursive: true }); // sync-ok: cold path, once at module load

/** Write chain to prevent concurrent writes from interleaving. */
let _pendingWrite: Promise<void> = Promise.resolve();

// ─── Migration from old per-file store ──────────────────────────────────────

/**
 * Derive the old per-file store directory from the current store path's parent.
 * In production: ~/.companion/auto-approval.json → ~/.companion/auto-approval/
 * In tests: /tmp/.../auto-approval.json → /tmp/.../auto-approval/ (won't exist)
 */
function oldStoreDirForMigration(): string {
  const base = storePath.replace(/\.json$/, "");
  return base; // e.g. ~/.companion/auto-approval
}

async function migrateFromOldStore(): Promise<AutoApprovalConfig[]> {
  try {
    const oldDir = oldStoreDirForMigration();
    if (!existsSync(oldDir)) return []; // sync-ok: cold path, migration runs once
    const files = (await readdir(oldDir)).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return [];
    const configs: AutoApprovalConfig[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(oldDir, file), "utf-8");
        configs.push(JSON.parse(raw) as AutoApprovalConfig);
      } catch {
        // Skip corrupt files
      }
    }
    return configs;
  } catch {
    return [];
  }
}

// ─── Internal I/O ───────────────────────────────────────────────────────────

async function readAll(): Promise<AutoApprovalConfig[]> {
  // Wait for any in-flight write to complete before reading, so we never
  // read stale data when createConfig/updateConfig/deleteConfig are called
  // in quick succession.
  await _pendingWrite;
  try {
    const raw = await readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: unknown) {
    // File doesn't exist yet — try migrating from old per-file store
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      const migrated = await migrateFromOldStore();
      if (migrated.length > 0) {
        // Persist migrated configs to the new single file
        await writeFile(storePath, JSON.stringify(migrated, null, 2), "utf-8");
      }
      return migrated;
    }
    return [];
  }
}

function persist(configs: AutoApprovalConfig[]): void {
  const data = JSON.stringify(configs, null, 2);
  const path = storePath; // capture before any async re-assignment
  _pendingWrite = _pendingWrite.then(() =>
    writeFile(path, data, "utf-8").catch(() => {}),
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate a deterministic 12-char hex slug from a project path. */
export function slugFromPath(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
}

/** Normalize a project path: resolve trailing slashes, but keep as-is otherwise. */
function normalizePath(p: string): string {
  // Remove trailing slash unless it's the root "/"
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listConfigs(): Promise<AutoApprovalConfig[]> {
  const configs = await readAll();
  configs.sort((a, b) => a.label.localeCompare(b.label));
  return configs;
}

export async function getConfig(slug: string): Promise<AutoApprovalConfig | null> {
  const configs = await readAll();
  return configs.find((c) => c.slug === slug) ?? null;
}

/**
 * Find the config that matches a session's working directory.
 * Uses longest-prefix matching: a session in `/home/user/project/sub`
 * matches `/home/user/project` rather than `/home/user`.
 *
 * `extraPaths` allows callers to supply additional paths to match against
 * (e.g. the git repo root for worktree sessions whose cwd differs from
 * the main repo path).
 *
 * Returns null if no config matches.
 */
export async function getConfigForPath(cwd: string, extraPaths?: string[]): Promise<AutoApprovalConfig | null> {
  const candidates = [normalizePath(cwd)];
  if (extraPaths) {
    for (const p of extraPaths) {
      const n = normalizePath(p);
      if (n && !candidates.includes(n)) candidates.push(n);
    }
  }

  const configs = (await readAll()).filter((c) => c.enabled);

  let bestMatch: AutoApprovalConfig | null = null;
  let bestLen = 0;

  for (const config of configs) {
    const configPaths = config.projectPaths?.length
      ? config.projectPaths
      : [config.projectPath];
    for (const pp of configPaths) {
      const normalizedProject = normalizePath(pp);
      for (const normalizedCwd of candidates) {
        if (
          normalizedCwd === normalizedProject ||
          normalizedCwd.startsWith(normalizedProject + "/")
        ) {
          if (normalizedProject.length > bestLen) {
            bestLen = normalizedProject.length;
            bestMatch = config;
          }
        }
      }
    }
  }

  return bestMatch;
}

export async function createConfig(
  projectPath: string,
  label: string,
  criteria: string,
  enabled: boolean = true,
  projectPaths?: string[],
): Promise<AutoApprovalConfig> {
  if (!projectPath || !projectPath.trim()) {
    throw new Error("Project path is required");
  }
  if (!label || !label.trim()) {
    throw new Error("Label is required");
  }

  const normalized = normalizePath(projectPath.trim());
  const slug = slugFromPath(normalized);

  const configs = await readAll();
  if (configs.some((c) => c.slug === slug)) {
    throw new Error("A config for this project path already exists");
  }

  // Normalize all additional paths
  const normalizedPaths = projectPaths?.length
    ? [...new Set(projectPaths.map((p) => normalizePath(p.trim())).filter(Boolean))]
    : undefined;

  const now = Date.now();
  const config: AutoApprovalConfig = {
    projectPath: normalized,
    ...(normalizedPaths && normalizedPaths.length > 0 ? { projectPaths: normalizedPaths } : {}),
    label: label.trim(),
    slug,
    criteria: criteria.trim(),
    enabled,
    createdAt: now,
    updatedAt: now,
  };

  configs.push(config);
  persist(configs);
  return config;
}

export async function updateConfig(
  slug: string,
  updates: { label?: string; criteria?: string; enabled?: boolean; projectPaths?: string[] },
): Promise<AutoApprovalConfig | null> {
  const configs = await readAll();
  const idx = configs.findIndex((c) => c.slug === slug);
  if (idx === -1) return null;

  const existing = configs[idx];
  const normalizedPaths = updates.projectPaths
    ? [...new Set(updates.projectPaths.map((p) => normalizePath(p.trim())).filter(Boolean))]
    : undefined;

  const config: AutoApprovalConfig = {
    ...existing,
    ...(updates.label !== undefined ? { label: updates.label.trim() } : {}),
    ...(updates.criteria !== undefined ? { criteria: updates.criteria.trim() } : {}),
    ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
    ...(normalizedPaths !== undefined ? { projectPaths: normalizedPaths.length > 0 ? normalizedPaths : undefined } : {}),
    updatedAt: Date.now(),
  };

  // Update primary projectPath to first element if projectPaths changed
  if (normalizedPaths && normalizedPaths.length > 0) {
    config.projectPath = normalizedPaths[0];
  }

  configs[idx] = config;
  persist(configs);
  return config;
}

export async function deleteConfig(slug: string): Promise<boolean> {
  const configs = await readAll();
  const idx = configs.findIndex((c) => c.slug === slug);
  if (idx === -1) return false;

  configs.splice(idx, 1);
  persist(configs);
  return true;
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Override the store file path for tests. */
export function _setStorePathForTest(path: string): void {
  storePath = path;
}

export function _resetStorePath(): void {
  storePath = join(COMPANION_DIR, "auto-approval.json");
}

/** Wait for any pending async writes to complete. Test-only. */
export function _flushForTest(): Promise<void> {
  return _pendingWrite;
}
