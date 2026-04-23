import { useStore } from "../store.js";
import type { SdkSessionInfo } from "../types.js";

export type Route =
  | { page: "home" }
  | { page: "session"; sessionId: string; messageId?: string }
  | { page: "settings" }
  | { page: "logs" }
  | { page: "terminal" }
  | { page: "environments" }
  | { page: "scheduled" }
  | { page: "questmaster" }
  | { page: "playground" };

const SESSION_PREFIX = "#/session/";
const QUEST_ID_PATTERN = /^q-\d+$/i;

function splitHash(hash: string): { path: string; params: URLSearchParams } {
  const normalized = hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "#/";
  const qIdx = normalized.indexOf("?");
  const path = qIdx >= 0 ? normalized.slice(0, qIdx) : normalized;
  const query = qIdx >= 0 ? normalized.slice(qIdx + 1) : "";
  return { path: path || "#/", params: new URLSearchParams(query) };
}

function normalizeQuestId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return QUEST_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Parse a window.location.hash string into a typed Route.
 */
export function parseHash(hash: string): Route {
  const { path } = splitHash(hash);
  if (path === "#/settings") return { page: "settings" };
  if (path === "#/logs") return { page: "logs" };
  if (path === "#/terminal") return { page: "terminal" };
  if (path === "#/environments") return { page: "environments" };
  if (path === "#/scheduled") return { page: "scheduled" };
  if (path === "#/questmaster") return { page: "questmaster" };
  if (path === "#/playground") return { page: "playground" };

  if (path.startsWith(SESSION_PREFIX)) {
    const sessionPath = path.slice(SESSION_PREFIX.length);
    const messageMarker = "/msg/";
    const markerIdx = sessionPath.indexOf(messageMarker);
    const rawSessionId = markerIdx >= 0 ? sessionPath.slice(0, markerIdx) : sessionPath;
    const rawMessageId = markerIdx >= 0 ? sessionPath.slice(markerIdx + messageMarker.length) : "";
    const sessionId = decodeURIComponent(rawSessionId);
    const messageId = rawMessageId ? decodeURIComponent(rawMessageId) : undefined;
    if (sessionId) return messageId ? { page: "session", sessionId, messageId } : { page: "session", sessionId };
  }

  return { page: "home" };
}

/**
 * Read quest overlay ID from the hash query (if present).
 */
export function questIdFromHash(hash: string): string | null {
  const { params } = splitHash(hash);
  return normalizeQuestId(params.get("quest"));
}

/**
 * Return a hash string with quest overlay query param set.
 */
export function withQuestIdInHash(hash: string, questId: string): string {
  const normalized = normalizeQuestId(questId);
  const { path, params } = splitHash(hash);
  if (!normalized) return path;
  params.set("quest", normalized);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Return a hash string with quest overlay query param removed.
 */
export function withoutQuestIdInHash(hash: string): string {
  const { path, params } = splitHash(hash);
  params.delete("quest");
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Build a hash string for a given session ID.
 */
export function sessionHash(sessionId: string | number): string {
  return `#/session/${encodeURIComponent(String(sessionId))}`;
}

/**
 * Build a hash string for a given session + stable message ID.
 */
export function sessionMessageHash(sessionId: string | number, messageId: string): string {
  return `${sessionHash(sessionId)}/msg/${encodeURIComponent(messageId)}`;
}

/**
 * Navigate to a session by updating the URL hash.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateToSession(sessionId: string, replace = false): void {
  const newHash = sessionHash(sessionId);
  if (replace) {
    history.replaceState(null, "", newHash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = `/session/${sessionId}`;
  }
}

/**
 * Resolve a message index to an ID and trigger scroll+expand.
 * If messages are loaded, scrolls immediately; otherwise stores a pending scroll.
 */
export function scrollToMessageIndex(sessionId: string, messageIndex: number): void {
  const store = useStore.getState();
  const messages = store.messages.get(sessionId);

  if (messages && messageIndex < messages.length) {
    const targetMsg = messages[messageIndex];
    if (targetMsg) {
      store.requestScrollToMessage(sessionId, targetMsg.id);
      store.setExpandAllInTurn(sessionId, targetMsg.id);
    }
  } else {
    store.setPendingScrollToMessageIndex(sessionId, messageIndex);
  }
}

/**
 * Navigate to a specific message within a session.
 * Opens the session and scrolls to the message at the given index.
 */
export function navigateToSessionMessage(sessionId: string, messageIndex: number): void {
  navigateToSession(sessionId);
  scrollToMessageIndex(sessionId, messageIndex);
}

/**
 * Navigate to a specific message ID within a session.
 */
export function navigateToSessionMessageId(
  sessionId: string,
  messageId: string,
  options: { replace?: boolean; routeSessionId?: string | number } = {},
): void {
  const { replace = false, routeSessionId = sessionId } = options;
  const newHash = sessionMessageHash(routeSessionId, messageId);
  if (replace) {
    history.replaceState(null, "", newHash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = newHash.startsWith("#") ? newHash.slice(1) : newHash;
  }
  const store = useStore.getState();
  store.requestScrollToMessage(sessionId, messageId);
  store.setExpandAllInTurn(sessionId, messageId);
}

/**
 * Read message index from hash query param (e.g. `?msg=42`).
 */
export function messageIndexFromHash(hash: string): number | null {
  const { params } = splitHash(hash);
  const raw = params.get("msg");
  if (!raw) return null;
  const idx = parseInt(raw, 10);
  return isNaN(idx) || idx < 0 ? null : idx;
}

/**
 * Resolve a stable message ID from the path portion of the hash.
 */
export function messageIdFromHash(hash: string): string | null {
  const route = parseHash(hash);
  return route.page === "session" ? (route.messageId ?? null) : null;
}

/**
 * Resolve a session route segment to a live session UUID.
 * Numeric references are treated as Takode session numbers.
 */
export function resolveSessionIdFromRoute(sessionRef: string, sdkSessions: SdkSessionInfo[]): string | null {
  if (!/^\d+$/.test(sessionRef)) {
    return sessionRef;
  }
  const sessionNum = Number.parseInt(sessionRef, 10);
  return sdkSessions.find((session) => session.sessionNum === sessionNum)?.sessionId ?? null;
}

/**
 * Pick the most readable route identifier for a live session.
 * Prefer the human session number, otherwise fall back to the UUID.
 */
export function routeSessionRefForId(sessionId: string, sdkSessions: SdkSessionInfo[]): string | number {
  return sdkSessions.find((session) => session.sessionId === sessionId)?.sessionNum ?? sessionId;
}

/**
 * Build an absolute app URL for the current server origin/path and the given hash.
 */
export function absoluteUrlForHash(hash: string): string {
  const url = new URL(window.location.href);
  url.hash = hash.startsWith("#") ? hash : `#${hash}`;
  return url.toString();
}

/**
 * Navigate to the home page (no session selected) by clearing the hash.
 * When replace=true, uses replaceState to avoid creating a history entry.
 */
export function navigateHome(replace = false): void {
  if (replace) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = "";
  }
}

/**
 * Navigate to the most recent non-archived, non-cron session.
 * If excludeId is provided, skip that session (used when deleting/archiving).
 * Falls back to navigateHome() if no sessions are available.
 * Returns true if navigated to a session, false if fell back to home.
 */
export function navigateToMostRecentSession(options: { excludeId?: string; replace?: boolean } = {}): boolean {
  const { excludeId, replace = false } = options;
  const candidates = (useStore.getState().sdkSessions as SdkSessionInfo[])
    .filter((s) => !s.archived && !s.cronJobId && s.sessionId !== excludeId)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (candidates.length > 0) {
    navigateToSession(candidates[0].sessionId, replace);
    return true;
  }
  navigateHome(replace);
  return false;
}
