import { GIT_STATUS_AUTO_REFRESH_STALE_MS, isGitStatusStale } from "../../shared/git-status-freshness.js";
import { api } from "../api.js";

const AUTO_REFRESH_RETRY_MS = 60_000;
const MAX_VISIBLE_REFRESHES = 8;

const inFlightRefreshes = new Map<string, Promise<void>>();
const lastRefreshStartedAt = new Map<string, number>();

export interface GitStatusAutoRefreshCandidate {
  id: string;
  archived?: boolean;
  isWorktree?: boolean;
  gitStatusRefreshedAt?: number | null;
}

export interface GitStatusAutoRefreshOptions {
  requireStale?: boolean;
  maxCount?: number;
  now?: number;
}

export function requestAutoSessionGitStatusRefresh(
  session: GitStatusAutoRefreshCandidate | null | undefined,
  options: GitStatusAutoRefreshOptions = {},
): boolean {
  if (!session || session.archived || !session.isWorktree) return false;
  const now = options.now ?? Date.now();
  if (options.requireStale && !isGitStatusStale(session.gitStatusRefreshedAt ?? undefined, now)) return false;
  if (inFlightRefreshes.has(session.id)) return false;

  const lastStartedAt = lastRefreshStartedAt.get(session.id) ?? 0;
  if (now - lastStartedAt < AUTO_REFRESH_RETRY_MS) return false;

  lastRefreshStartedAt.set(session.id, now);
  const refresh = api
    .refreshSessionGitStatus(session.id, { force: false })
    .then(() => undefined)
    .catch((err) => {
      console.warn("[git-status] automatic session git status refresh failed:", err);
    })
    .finally(() => {
      if (inFlightRefreshes.get(session.id) === refresh) {
        inFlightRefreshes.delete(session.id);
      }
    });
  inFlightRefreshes.set(session.id, refresh);
  return true;
}

export function requestAutoSessionGitStatusRefreshes(
  sessions: Array<GitStatusAutoRefreshCandidate | null | undefined>,
  options: GitStatusAutoRefreshOptions = {},
): number {
  const maxCount = options.maxCount ?? MAX_VISIBLE_REFRESHES;
  let started = 0;
  for (const session of sessions) {
    if (started >= maxCount) break;
    if (requestAutoSessionGitStatusRefresh(session, options)) {
      started++;
    }
  }
  return started;
}

export function resetSessionGitStatusAutoRefreshForTest(): void {
  inFlightRefreshes.clear();
  lastRefreshStartedAt.clear();
}

export { AUTO_REFRESH_RETRY_MS, GIT_STATUS_AUTO_REFRESH_STALE_MS, MAX_VISIBLE_REFRESHES };
