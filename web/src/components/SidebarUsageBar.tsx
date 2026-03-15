import { useStore } from "../store.js";
import { useUsageLimits } from "../hooks/useUsageLimits.js";
import {
  cycleElapsedPct,
  FIVE_HOURS_MS,
  formatUsageResetTime,
  SEVEN_DAYS_MS,
  usageBarColor,
} from "../utils/usage-bars.js";

function UsageRow({
  label,
  pct,
  resetStr,
  timePct,
}: {
  label: string;
  pct: number;
  resetStr: string;
  timePct: number | null;
}) {
  return (
    <div
      className="flex items-center gap-1.5"
      title={`${label} Limit: ${pct}%${resetStr ? ` (resets in ${resetStr})` : ""}${timePct !== null ? ` · ${Math.round(timePct)}% of cycle elapsed` : ""}`}
    >
      <span className="text-[9px] text-cc-muted uppercase tracking-wider font-medium w-4 text-right">{label}</span>
      <div className="flex-1 h-1 rounded-full bg-cc-hover overflow-hidden relative">
        <div
          className={`h-full rounded-full transition-all duration-500 ${usageBarColor(pct)}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
        {timePct !== null && (
          <div
            className="absolute top-0 h-full w-0.5 bg-cc-fg/80 rounded-full shadow-[0_0_2px_rgba(0,0,0,0.5)]"
            style={{ left: `${Math.min(timePct, 100)}%` }}
          />
        )}
      </div>
      <span className="text-[9px] text-cc-muted tabular-nums">{pct}%</span>
    </div>
  );
}

export function SidebarUsageBar() {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const showUsageBars = useStore((s) => s.showUsageBars);
  const backendType = useStore((s) => {
    if (!currentSessionId) return "claude";
    const bridgeBackend = s.sessions.get(currentSessionId)?.backend_type;
    const sdkBackend = s.sdkSessions.find((ss) => ss.sessionId === currentSessionId)?.backendType;
    return (bridgeBackend || sdkBackend || "claude") as "claude" | "codex";
  });
  const limits = useUsageLimits(currentSessionId);

  if (!showUsageBars || !limits) return null;

  const fiveHour = limits.five_hour;
  const sevenDay = limits.seven_day;
  const extra = limits.extra_usage;

  const rows: { label: string; pct: number; resetStr: string; timePct: number | null }[] = [];

  if (fiveHour) {
    rows.push({
      label: "5H",
      pct: fiveHour.utilization,
      resetStr: fiveHour.resets_at ? formatUsageResetTime(fiveHour.resets_at, { invalidFallback: "" }) : "",
      timePct: cycleElapsedPct(fiveHour.resets_at, FIVE_HOURS_MS),
    });
  }
  if (sevenDay) {
    rows.push({
      label: "7D",
      pct: sevenDay.utilization,
      resetStr: sevenDay.resets_at ? formatUsageResetTime(sevenDay.resets_at, { invalidFallback: "" }) : "",
      timePct: cycleElapsedPct(sevenDay.resets_at, SEVEN_DAYS_MS),
    });
  }
  if (rows.length === 0 && extra?.is_enabled && extra.utilization !== null) {
    rows.push({ label: "Extra", pct: extra.utilization, resetStr: "", timePct: null });
  }

  if (rows.length === 0) return null;

  const backendLabel = backendType === "codex" ? "Codex" : "Claude";
  const backendLogo = backendType === "codex" ? "/logo-codex.svg" : "/logo.png";

  return (
    <div className="px-3 pb-1.5 space-y-1">
      <div className="flex items-center gap-1.5 pb-0.5" title={`${backendLabel} usage`}>
        <img
          src={backendLogo}
          alt={`${backendLabel} usage`}
          className="w-3 h-3 rounded-[3px] object-contain opacity-90"
          draggable={false}
        />
        <span
          className={`text-[9px] uppercase tracking-wider font-medium ${backendType === "codex" ? "text-blue-400/90" : "text-[#D97757]"}`}
        >
          {backendLabel}
        </span>
      </div>
      {rows.map((r) => (
        <UsageRow key={r.label} label={r.label} pct={r.pct} resetStr={r.resetStr} timePct={r.timePct} />
      ))}
    </div>
  );
}
