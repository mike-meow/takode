import { mkdir, readdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CompanionEnv {
  name: string;
  slug: string;
  variables: Record<string, string>;

  // Docker configuration
  /** Raw Dockerfile content (stored inline). When present, used to build a custom image. */
  dockerfile?: string;
  /** Tag of the built image (e.g. "companion-env-myproject:latest") */
  imageTag?: string;
  /** Base image to use when no custom Dockerfile is provided (e.g. "companion-dev:latest") */
  baseImage?: string;
  /** Current build status */
  buildStatus?: "idle" | "building" | "success" | "error";
  /** Last build error message */
  buildError?: string;
  /** Timestamp of last successful build */
  lastBuiltAt?: number;
  /** Container ports to expose */
  ports?: number[];
  /** Extra volume mounts in "host:container[:opts]" format */
  volumes?: string[];
  /** Shell script to run inside the container before the CLI session starts */
  initScript?: string;

  createdAt: number;
  updatedAt: number;
}

/** Fields that can be updated via the update API */
export interface EnvUpdateFields {
  name?: string;
  variables?: Record<string, string>;
  dockerfile?: string;
  imageTag?: string;
  baseImage?: string;
  ports?: number[];
  volumes?: string[];
  initScript?: string;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const ENVS_DIR = join(COMPANION_DIR, "envs");

async function ensureDir(): Promise<void> {
  await mkdir(ENVS_DIR, { recursive: true });
}

function filePath(slug: string): string {
  return join(ENVS_DIR, `${slug}.json`);
}

/** Check if a file exists without blocking. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listEnvs(): Promise<CompanionEnv[]> {
  await ensureDir();
  try {
    const files = (await readdir(ENVS_DIR)).filter((f) => f.endsWith(".json"));
    const envs: CompanionEnv[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(ENVS_DIR, file), "utf-8");
        envs.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    envs.sort((a, b) => a.name.localeCompare(b.name));
    return envs;
  } catch {
    return [];
  }
}

export async function getEnv(slug: string): Promise<CompanionEnv | null> {
  await ensureDir();
  try {
    const raw = await readFile(filePath(slug), "utf-8");
    return JSON.parse(raw) as CompanionEnv;
  } catch {
    return null;
  }
}

/**
 * Return the effective Docker image for an environment.
 * Priority: imageTag (custom built) > baseImage (user-selected) > default.
 */
export async function getEffectiveImage(slug: string): Promise<string | null> {
  const env = await getEnv(slug);
  if (!env) return null;
  return env.imageTag || env.baseImage || null;
}

export async function createEnv(
  name: string,
  variables: Record<string, string> = {},
  docker?: {
    dockerfile?: string;
    baseImage?: string;
    ports?: number[];
    volumes?: string[];
    initScript?: string;
  },
): Promise<CompanionEnv> {
  if (!name || !name.trim()) throw new Error("Environment name is required");
  const slug = slugify(name.trim());
  if (!slug) throw new Error("Environment name must contain alphanumeric characters");

  await ensureDir();
  if (await fileExists(filePath(slug))) {
    throw new Error(`An environment with a similar name already exists ("${slug}")`);
  }

  const now = Date.now();
  const env: CompanionEnv = {
    name: name.trim(),
    slug,
    variables,
    createdAt: now,
    updatedAt: now,
  };

  // Apply Docker config if provided
  if (docker) {
    if (docker.dockerfile !== undefined) env.dockerfile = docker.dockerfile;
    if (docker.baseImage !== undefined) env.baseImage = docker.baseImage;
    if (docker.ports !== undefined) env.ports = docker.ports;
    if (docker.volumes !== undefined) env.volumes = docker.volumes;
    if (docker.initScript !== undefined) env.initScript = docker.initScript;
  }

  await writeFile(filePath(slug), JSON.stringify(env, null, 2), "utf-8");
  return env;
}

export async function updateEnv(slug: string, updates: EnvUpdateFields): Promise<CompanionEnv | null> {
  await ensureDir();
  const existing = await getEnv(slug);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newSlug = slugify(newName);
  if (!newSlug) throw new Error("Environment name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different env
  if (newSlug !== slug && (await fileExists(filePath(newSlug)))) {
    throw new Error(`An environment with a similar name already exists ("${newSlug}")`);
  }

  const env: CompanionEnv = {
    ...existing,
    name: newName,
    slug: newSlug,
    variables: updates.variables ?? existing.variables,
    updatedAt: Date.now(),
  };

  // Apply Docker field updates (only override if explicitly provided)
  if (updates.dockerfile !== undefined) env.dockerfile = updates.dockerfile;
  if (updates.imageTag !== undefined) env.imageTag = updates.imageTag;
  if (updates.baseImage !== undefined) env.baseImage = updates.baseImage;
  if (updates.ports !== undefined) env.ports = updates.ports;
  if (updates.volumes !== undefined) env.volumes = updates.volumes;
  if (updates.initScript !== undefined) env.initScript = updates.initScript;

  // If slug changed, delete old file
  if (newSlug !== slug) {
    try {
      await unlink(filePath(slug));
    } catch {
      /* ok */
    }
  }

  await writeFile(filePath(newSlug), JSON.stringify(env, null, 2), "utf-8");
  return env;
}

/**
 * Update the build status fields of an environment.
 * Used during Docker image builds to track progress.
 */
export async function updateBuildStatus(
  slug: string,
  status: CompanionEnv["buildStatus"],
  opts?: { error?: string; imageTag?: string },
): Promise<CompanionEnv | null> {
  await ensureDir();
  const existing = await getEnv(slug);
  if (!existing) return null;

  existing.buildStatus = status;
  existing.updatedAt = Date.now();

  if (opts?.error !== undefined) existing.buildError = opts.error;
  if (opts?.imageTag !== undefined) existing.imageTag = opts.imageTag;
  if (status === "success") {
    existing.lastBuiltAt = Date.now();
    existing.buildError = undefined;
  }

  await writeFile(filePath(slug), JSON.stringify(existing, null, 2), "utf-8");
  return existing;
}

export async function deleteEnv(slug: string): Promise<boolean> {
  await ensureDir();
  if (!(await fileExists(filePath(slug)))) return false;
  try {
    await unlink(filePath(slug));
    return true;
  } catch {
    return false;
  }
}
