import { mkdirSync } from "node:fs";
import { readdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CronJob, CronJobCreateInput } from "./cron-types.js";

// ─── Paths ──────────────────────────────────────────────────────────────────

const COMPANION_DIR = join(homedir(), ".companion");
const CRON_DIR = join(COMPANION_DIR, "cron");

// Cold-path initialization — sync is fine here (runs once at module load)
mkdirSync(CRON_DIR, { recursive: true });

function filePath(id: string): string {
  return join(CRON_DIR, `${id}.json`);
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listJobs(): Promise<CronJob[]> {
  try {
    const files = (await readdir(CRON_DIR)).filter((f) => f.endsWith(".json"));
    const jobs: CronJob[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(join(CRON_DIR, file), "utf-8");
        jobs.push(JSON.parse(raw));
      } catch {
        // Skip corrupt files
      }
    }
    jobs.sort((a, b) => a.name.localeCompare(b.name));
    return jobs;
  } catch {
    return [];
  }
}

export async function getJob(id: string): Promise<CronJob | null> {
  try {
    const raw = await readFile(filePath(id), "utf-8");
    return JSON.parse(raw) as CronJob;
  } catch {
    return null;
  }
}

export async function createJob(data: CronJobCreateInput): Promise<CronJob> {
  if (!data.name || !data.name.trim()) throw new Error("Job name is required");
  if (!data.prompt || !data.prompt.trim()) throw new Error("Job prompt is required");
  if (!data.schedule || !data.schedule.trim()) throw new Error("Job schedule is required");
  if (!data.cwd || !data.cwd.trim()) throw new Error("Job working directory is required");

  const id = slugify(data.name.trim());
  if (!id) throw new Error("Job name must contain alphanumeric characters");

  if (await fileExists(filePath(id))) {
    throw new Error(`A job with a similar name already exists ("${id}")`);
  }

  const now = Date.now();
  const job: CronJob = {
    ...data,
    id,
    name: data.name.trim(),
    prompt: data.prompt.trim(),
    schedule: data.schedule.trim(),
    cwd: data.cwd.trim(),
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
    totalRuns: 0,
  };
  await writeFile(filePath(id), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

export async function updateJob(id: string, updates: Partial<CronJob>): Promise<CronJob | null> {
  const existing = await getJob(id);
  if (!existing) return null;

  const newName = updates.name?.trim() || existing.name;
  const newId = slugify(newName);
  if (!newId) throw new Error("Job name must contain alphanumeric characters");

  // If name changed, check for slug collision with a different job
  if (newId !== id && (await fileExists(filePath(newId)))) {
    throw new Error(`A job with a similar name already exists ("${newId}")`);
  }

  const job: CronJob = {
    ...existing,
    ...updates,
    id: newId,
    name: newName,
    updatedAt: Date.now(),
    // Preserve immutable fields
    createdAt: existing.createdAt,
  };

  // If id changed, delete old file
  if (newId !== id) {
    try {
      await unlink(filePath(id));
    } catch {
      /* ok */
    }
  }

  await writeFile(filePath(newId), JSON.stringify(job, null, 2), "utf-8");
  return job;
}

export async function deleteJob(id: string): Promise<boolean> {
  if (!(await fileExists(filePath(id)))) return false;
  try {
    await unlink(filePath(id));
    return true;
  } catch {
    return false;
  }
}
