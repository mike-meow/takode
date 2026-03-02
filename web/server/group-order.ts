import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const DEFAULT_PATH = join(homedir(), ".companion", "group-order.json");

let groupOrder: string[] = [];
let loaded = false;
let filePath = DEFAULT_PATH;
let pendingWrite: Promise<void> = Promise.resolve();

function sanitizeOrder(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await readFile(filePath, "utf-8");
    groupOrder = sanitizeOrder(JSON.parse(raw));
  } catch {
    groupOrder = [];
  }
  loaded = true;
}

function persist(): void {
  const path = filePath;
  const data = JSON.stringify(groupOrder, null, 2);
  pendingWrite = pendingWrite
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data, "utf-8");
    })
    .catch(() => {});
}

export async function getAllOrder(): Promise<string[]> {
  await ensureLoaded();
  return [...groupOrder];
}

export async function setAllOrder(next: string[]): Promise<void> {
  await ensureLoaded();
  groupOrder = sanitizeOrder(next);
  persist();
}

/** Wait for pending async writes to complete. Test-only. */
export function _flushForTest(): Promise<void> {
  return pendingWrite;
}

/** Reset internal state and optionally override file path (for tests). */
export function _resetForTest(customPath?: string): void {
  groupOrder = [];
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  pendingWrite = Promise.resolve();
}
