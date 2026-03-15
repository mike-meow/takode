export const FIVE_HOURS_MS = 5 * 3_600_000;
export const SEVEN_DAYS_MS = 7 * 86_400_000;

export function usageBarColor(pct: number): string {
  if (pct > 80) return "bg-cc-error";
  if (pct > 50) return "bg-cc-warning";
  return "bg-cc-primary";
}

export function formatUsageResetTime(
  resetsAt: string,
  options: { includeDays?: boolean; invalidFallback?: string } = {},
): string {
  const { includeDays = false, invalidFallback = "" } = options;

  try {
    const diffMs = new Date(resetsAt).getTime() - Date.now();
    if (diffMs <= 0) return "now";

    const days = Math.floor(diffMs / 86_400_000);
    const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
    const minutes = Math.floor((diffMs % 3_600_000) / 60_000);

    if (includeDays && days > 0) return `${days}d ${hours}h${minutes}m`;

    if (hours > 0 || days > 0) {
      const totalHours = includeDays ? hours : Math.floor(diffMs / 3_600_000);
      return `${totalHours}h${minutes}m`;
    }

    return `${minutes}m`;
  } catch {
    return invalidFallback;
  }
}

/** Compute elapsed % within a reset cycle. Returns null if unknown. */
export function cycleElapsedPct(resetsAt: string | null | undefined, cycleDurationMs: number): number | null {
  if (!resetsAt) return null;
  try {
    const remainingMs = new Date(resetsAt).getTime() - Date.now();
    if (remainingMs <= 0) return 100;
    const elapsed = 1 - remainingMs / cycleDurationMs;
    return Math.max(0, Math.min(100, elapsed * 100));
  } catch {
    return null;
  }
}
