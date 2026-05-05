export const GIT_STATUS_AUTO_REFRESH_STALE_MS = 5 * 60 * 1000;

export function isGitStatusStale(refreshedAt: number | undefined, now = Date.now()): boolean {
  return !refreshedAt || now - refreshedAt >= GIT_STATUS_AUTO_REFRESH_STALE_MS;
}

export function formatGitStatusAge(refreshedAt: number | undefined, now = Date.now()): string {
  if (!refreshedAt) return "not refreshed yet";
  const ageMs = Math.max(0, now - refreshedAt);
  if (ageMs < 60_000) return "just now";
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
