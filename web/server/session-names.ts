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

/** Persisted format: { names: Record<string, string>, leaderCounter: number }
 *  Backwards-compatible: if the file is a flat Record (old format), migrate on load. */
interface PersistedData {
  names: Record<string, string>;
  leaderCounter: number;
  userNamed?: string[];
}

let names: Record<string, string> = {};
let leaderCounter = 0;
let userNamed: Set<string> = new Set();
let loaded = false;
let filePath = DEFAULT_PATH;
let _pendingWrite: Promise<void> = Promise.resolve();

function ensureLoaded(): void {
  if (loaded) return;
  try {
    if (existsSync(filePath)) {
      // sync-ok: cold path, cached after first load
      const raw = readFileSync(filePath, "utf-8"); // sync-ok: cold path, cached after first load
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "names" in parsed) {
        // New format
        names = parsed.names as Record<string, string>;
        leaderCounter = typeof parsed.leaderCounter === "number" ? parsed.leaderCounter : 0;
        userNamed = new Set(Array.isArray(parsed.userNamed) ? parsed.userNamed : []);
      } else {
        // Old format: flat Record<string, string>
        names = parsed as Record<string, string>;
        leaderCounter = 0;
      }
    }
  } catch {
    names = {};
    leaderCounter = 0;
    userNamed = new Set();
  }
  loaded = true;
}

function persist(): void {
  const data: PersistedData = { names, leaderCounter, userNamed: [...userNamed] };
  const json = JSON.stringify(data, null, 2);
  const path = filePath;
  mkdirSync(dirname(path), { recursive: true }); // sync-ok: cold path, ensure dir exists
  // Chain writes so each waits for the previous to finish.
  _pendingWrite = _pendingWrite.then(() => writeFile(path, json, "utf-8").catch(() => {}));
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
  userNamed.delete(sessionId);
  persist();
}

/** Increment and return the next leader session number (persisted across restarts). */
export function getNextLeaderNumber(): number {
  ensureLoaded();
  leaderCounter += 1;
  persist();
  return leaderCounter;
}

/** Mark a session as manually named by the user (prevents auto-namer from overwriting). */
export function setUserNamed(sessionId: string): void {
  ensureLoaded();
  userNamed.add(sessionId);
  persist();
}

/** Check if a session was manually named by the user. */
export function isUserNamed(sessionId: string): boolean {
  ensureLoaded();
  return userNamed.has(sessionId);
}

/** Clear the user-named flag (e.g. when a session is deleted). */
export function clearUserNamed(sessionId: string): void {
  ensureLoaded();
  userNamed.delete(sessionId);
  persist();
}

/** Wait for any pending async writes to complete. Test-only. */
export function _flushForTest(): Promise<void> {
  return _pendingWrite;
}

/** Reset internal state and optionally set a custom file path (for testing). */
export function _resetForTest(customPath?: string): void {
  names = {};
  leaderCounter = 0;
  loaded = false;
  filePath = customPath || DEFAULT_PATH;
  _pendingWrite = Promise.resolve();
}
