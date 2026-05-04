import { useEffect, useState } from "react";
import type { NeedsInputReminderViewModel } from "../utils/needs-input-reminder.js";
import type { QuestThreadReminderViewModel } from "../utils/quest-thread-reminder.js";
import type { ThreadRoutingReminderViewModel } from "../utils/thread-routing-reminder.js";

type ModelOnlyReminderViewModel = {
  title: string;
  description: string;
  rawContent: string;
};

export function ThreadRoutingReminderView({ reminder }: { reminder: ThreadRoutingReminderViewModel }) {
  return <ModelOnlyReminderView reminder={reminder} accent="sky" icon="route" />;
}

export function QuestThreadReminderView({ reminder }: { reminder: QuestThreadReminderViewModel }) {
  return <ModelOnlyReminderView reminder={reminder} accent="amber" icon="link" />;
}

function ModelOnlyReminderView({
  reminder,
  accent,
  icon,
}: {
  reminder: ModelOnlyReminderViewModel;
  accent: "amber" | "sky";
  icon: "link" | "route";
}) {
  const [expanded, setExpanded] = useState(false);
  const accentClass = accent === "sky" ? "text-sky-300/80" : "text-amber-200/80";
  const borderClass = accent === "sky" ? "border-sky-400/15" : "border-amber-300/15";

  return (
    <div className="text-left">
      <button
        type="button"
        className={`flex w-full min-w-0 items-center gap-2 rounded-md border ${borderClass} bg-cc-hover/20 px-2 py-1 text-left transition-colors hover:bg-cc-hover/35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cc-primary/60`}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${reminder.title}`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`h-3 w-3 shrink-0 text-cc-muted/55 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ModelOnlyReminderIcon icon={icon} className={`h-3.5 w-3.5 shrink-0 ${accentClass}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-snug text-cc-muted">
          {reminder.title}
        </span>
        <span className="shrink-0 rounded-full border border-cc-border/40 px-1.5 py-0.5 font-mono-code text-[9px] leading-none text-cc-muted/65">
          model-only
        </span>
      </button>
      {expanded && (
        <div className="mt-1.5 rounded-md border border-cc-border/25 bg-cc-card/35 px-2.5 py-2">
          <p className="mb-1.5 text-[11px] leading-snug text-cc-muted">{reminder.description}</p>
          <pre className="max-h-[260px] overflow-y-auto whitespace-pre-wrap break-words font-mono-code text-[11px] leading-relaxed text-cc-muted/90">
            {reminder.rawContent}
          </pre>
        </div>
      )}
    </div>
  );
}

function ModelOnlyReminderIcon({ icon, className }: { icon: "link" | "route"; className: string }) {
  if (icon === "link") {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
        data-testid="model-only-reminder-icon"
        data-icon-kind="link"
      >
        <path
          d="M6.85 4.45l.75-.75a3 3 0 014.25 4.25l-1.7 1.7a3 3 0 01-4.25 0"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M9.15 11.55l-.75.75a3 3 0 01-4.25-4.25l1.7-1.7a3 3 0 014.25 0"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M6.45 9.55l3.1-3.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={className}
      aria-hidden="true"
      data-testid="model-only-reminder-icon"
      data-icon-kind="route"
    >
      <path
        d="M3 4.5h5.5c2.5 0 4.5 2 4.5 4.5v2M10.5 8.5L13 11l-2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NeedsInputReminderView({ reminder }: { reminder: NeedsInputReminderViewModel }) {
  const hasActive = reminder.activeCount > 0;
  const isFullyResolved =
    !hasActive && !reminder.hasPartialState && reminder.resolvedCount > 0 && reminder.unknownCount === 0;
  const shouldCollapseByDefault = !hasActive && !reminder.hasPartialState;
  const [collapsed, setCollapsed] = useState(shouldCollapseByDefault);

  useEffect(() => {
    setCollapsed(shouldCollapseByDefault);
  }, [shouldCollapseByDefault]);

  const statusLabel = hasActive
    ? "active"
    : reminder.hasPartialState
      ? "partial state"
      : isFullyResolved
        ? "resolved"
        : reminder.unknownCount > 0
          ? "state unavailable"
          : "historical";
  const toneClass = hasActive
    ? "border-amber-500/25 bg-amber-500/6 text-amber-100"
    : reminder.hasPartialState
      ? "border-cc-border/60 bg-cc-hover/40 text-cc-muted"
      : "border-cc-border/50 bg-cc-hover/30 text-cc-muted";

  return (
    <div className={collapsed ? "" : "space-y-2"}>
      <button
        type="button"
        className="flex w-full min-w-0 items-start gap-2 rounded-md text-left transition-colors hover:bg-cc-hover/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cc-primary/60"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${reminder.title}`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`mt-1 h-3 w-3 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"} text-cc-muted/60`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${hasActive ? "text-amber-400" : "text-cc-muted/70"}`}
        >
          <path d="M8 1.5A3.5 3.5 0 004.5 5v2.5c0 .78-.26 1.54-.73 2.16L3 10.66V11.5h10v-.84l-.77-1A3.49 3.49 0 0111.5 7.5V5A3.5 3.5 0 008 1.5zM6.5 13a1.5 1.5 0 003 0h-3z" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{reminder.title}</span>
            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-mono-code ${toneClass}`}>
              {statusLabel}
            </span>
          </span>
          {!collapsed && (
            <span className="mt-0.5 block text-xs leading-relaxed text-cc-muted">{reminder.description}</span>
          )}
        </span>
      </button>

      {!collapsed && reminder.entries.length > 0 && (
        <div className="space-y-1 font-mono-code text-[12px] leading-relaxed">
          {reminder.entries.map((entry) => (
            <div key={`${entry.notificationId}-${entry.rawId}`} className="flex min-w-0 items-start gap-2">
              <span className="shrink-0 text-cc-muted/70">{entry.rawId}.</span>
              <span
                className={
                  entry.status === "active"
                    ? "min-w-0 flex-1 text-cc-fg"
                    : "min-w-0 flex-1 text-cc-muted line-through decoration-cc-muted/50"
                }
              >
                {entry.summary}
              </span>
              <span
                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
                  entry.status === "active"
                    ? "border-amber-500/25 text-amber-300"
                    : entry.status === "resolved"
                      ? "border-emerald-500/20 text-emerald-300/80"
                      : "border-cc-border/60 text-cc-muted"
                }`}
              >
                {entry.status === "unknown" ? "state unavailable" : entry.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
