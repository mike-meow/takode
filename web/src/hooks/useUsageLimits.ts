import { useEffect, useState, useCallback } from "react";
import { api, type UsageLimits } from "../api.js";

const POLL_INTERVAL = 60_000;

// Module-level cache — survives component unmounts and session switches
const limitsCache = new Map<string, UsageLimits>();

export function useUsageLimits(sessionId: string | null): UsageLimits | null {
  const [limits, setLimits] = useState<UsageLimits | null>(sessionId ? (limitsCache.get(sessionId) ?? null) : null);

  const fetchLimits = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await api.getSessionUsageLimits(sessionId);
      limitsCache.set(sessionId, data);
      setLimits(data);
    } catch {
      // silent
    }
  }, [sessionId]);

  // When sessionId changes, show cached value immediately
  useEffect(() => {
    setLimits(sessionId ? (limitsCache.get(sessionId) ?? null) : null);
  }, [sessionId]);

  // Poll for fresh limits
  useEffect(() => {
    if (!sessionId) return;
    fetchLimits();
    const id = setInterval(fetchLimits, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetchLimits, sessionId]);

  // Tick every 30s to refresh "resets in" countdown displays
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [sessionId]);

  return limits;
}

// Re-export the cache for backward compat with TaskPanel's UsageLimitsSection
export { limitsCache };
