import {
  mkdirSync,
  readFileSync, // sync-ok: cold path, cached after first load
  existsSync, // sync-ok: cold path, cached after first load
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Paths ──────────────────────────────────────────────────────────────────

const DEFAULT_PATH = join(homedir(), ".companion", "session-names.json");

// ─── Store ──────────────────────────────────────────────────────────────────

let names: Record<string, string> = {};
let loaded = false;
let filePath = DEFAULT_PATH;
let _pendingWrite: Promise<void> = Promise.resolve();

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) { // sync-ok: cold path, cached after first load
      const raw = readFileSync(filePath, "utf-8"); // sync-ok: cold path, cached after first load
      names = JSON.parse(raw) as Record<string, string>;
    }
  } catch {
    names = {};
  }
  loaded = true;
}

function persist(): void {
  const data = JSON.stringify(names, null, 2);
  const path = filePath;
  mkdirSync(dirname(path), { recursive: true }); // sync-ok: cold path, ensure dir exists
  // Chain writes so each waits for the previous to finish.
  _pendingWrite = _pendingWrite.then(() =>
    writeFile(path, data, "utf-8").catch(() => {}),
  );
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function getName(sessionId: string): string | undefined {
  ensureLoaded();
  return names[sessionId];
}

export function setName(sessionId: string, name: string): void {
  ensureLoaded();
  names[sessionId] = name;
  persist();
}

export function getAllNames(): Record<string, string> {
  ensureLoaded();
  return { ...names };
}

export function removeName(sessionId: string): void {
  ensureLoaded();
  delete names[sessionId];
  persist();
}

/** Wait for any pending async writes to complete. Test-only. */
export function _flushForTest(): Promise<void> {
  return _pendingWrite;
}

/** Reset internal state and optionally set a custom file path (for testing). */
export function _resetForTest(customPath?: string): void {
  names = {};
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  _pendingWrite = Promise.resolve();
}
