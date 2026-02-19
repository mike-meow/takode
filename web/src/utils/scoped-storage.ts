/**
 * Server-scoped localStorage wrapper.
 *
 * Each Companion server has a stable UUID (`serverId`) persisted in its
 * `~/.companion/settings.json`. The frontend caches this ID in localStorage
 * under `cc-server-id` so it's available synchronously on subsequent loads.
 *
 * All server-specific keys (sessions, selected backend, recent dirs, etc.)
 * are prefixed with `{serverId}:`. Global user preferences (dark mode, zoom)
 * are stored without a prefix so they apply everywhere.
 */

const SERVER_ID_KEY = "cc-server-id";

/** Keys that should NEVER be scoped — global user preferences */
const GLOBAL_KEYS = new Set([
  "cc-dark-mode",
  "cc-zoom-level",
  "cc-notification-sound",
  "cc-notification-desktop",

  "cc-collapse-usage",
  "cc-collapse-mcp",
]);

/** Server-scoped key names (without dynamic suffixes) for migration */
const SCOPED_KEYS = [
  "cc-current-session",
  "cc-session-names",
  "cc-collapsed-projects",
  "cc-backend",
  "cc-mode",
  "cc-codex-internet-access",
  "cc-ask-permission",
  "cc-selected-env",
  "cc-worktree",
  "cc-branch",
  "cc-diff-base",
  "cc-diff-base-session",
  "cc-recent-dirs",
  "cc-session-last-viewed",
  "cc-session-attention",
  "cc-session-order",
];

function getServerIdPrefix(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(SERVER_ID_KEY) || "";
}

/** Resolve the actual localStorage key — global keys pass through, others get prefixed. */
export function scopedKey(key: string): string {
  if (GLOBAL_KEYS.has(key)) return key;
  const prefix = getServerIdPrefix();
  return prefix ? `${prefix}:${key}` : key;
}

export function scopedGetItem(key: string): string | null {
  return localStorage.getItem(scopedKey(key));
}

export function scopedSetItem(key: string, value: string): void {
  localStorage.setItem(scopedKey(key), value);
}

export function scopedRemoveItem(key: string): void {
  localStorage.removeItem(scopedKey(key));
}

/**
 * Called once after fetching serverId from the server.
 * Caches the ID locally and migrates un-prefixed keys on first visit.
 * Returns true if migration was performed (caller should reinit store state).
 */
export function bootstrapServerId(serverId: string): boolean {
  const existing = localStorage.getItem(SERVER_ID_KEY);
  if (existing === serverId) return false; // already bootstrapped

  localStorage.setItem(SERVER_ID_KEY, serverId);

  // First time seeing this server — migrate un-prefixed keys to prefixed copies
  if (!existing) {
    migrateKeys(serverId);
    return true;
  }

  return false;
}

function migrateKeys(serverId: string): void {
  // Static keys
  for (const key of SCOPED_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) {
      localStorage.setItem(`${serverId}:${key}`, value);
      // Don't delete un-prefixed keys — other server tabs may still need them
    }
  }

  // Dynamic model keys (cc-model-claude, cc-model-codex, etc.)
  for (const backend of ["claude", "codex"]) {
    const key = `cc-model-${backend}`;
    const value = localStorage.getItem(key);
    if (value !== null) {
      localStorage.setItem(`${serverId}:${key}`, value);
    }
  }

  // Dynamic last-seq keys (companion:last-seq:*)
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith("companion:last-seq:")) {
      const value = localStorage.getItem(key);
      if (value !== null) {
        localStorage.setItem(`${serverId}:${key}`, value);
      }
    }
  }
}
