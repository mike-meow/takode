import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { api, type GitHubPRInfo } from "../api.js";
import type { TaskItem, SessionTaskEntry, SdkSessionInfo } from "../types.js";
import { McpSection } from "./McpPanel.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import {
  cycleElapsedPct,
  FIVE_HOURS_MS,
  formatUsageResetTime,
  SEVEN_DAYS_MS,
  usageBarColor,
} from "../utils/usage-bars.js";

const EMPTY_TASKS: TaskItem[] = [];

// ─── Persistent collapsed state for panel sections ──────────────────────────

const collapseListeners = new Set<() => void>();

export function usePersistedCollapse(key: string): [boolean, () => void] {
  const value = useSyncExternalStore(
    (cb) => { collapseListeners.add(cb); return () => collapseListeners.delete(cb); },
    () => localStorage.getItem(key) === "1",
  );
  const toggle = useCallback(() => {
    localStorage.setItem(key, value ? "0" : "1");
    collapseListeners.forEach((l) => l());
  }, [key, value]);
  return [value, toggle];
}

function SectionHeader({ title, collapsed, onToggle, right }: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="shrink-0 px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 text-[12px] font-semibold text-cc-fg cursor-pointer select-none hover:text-cc-primary transition-colors"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
        {title}
      </button>
      {!collapsed && right && <div className="flex items-center gap-1">{right}</div>}
    </div>
  );
}

import { useUsageLimits } from "../hooks/useUsageLimits.js";

function UsageLimitsSection({ sessionId }: { sessionId: string }) {
  const limits = useUsageLimits(sessionId);

  if (!limits) return null;

  const has5h = limits.five_hour !== null;
  const has7d = limits.seven_day !== null;
  const hasExtra = !has5h && !has7d && limits.extra_usage?.is_enabled;

  if (!has5h && !has7d && !hasExtra) return null;

  return (
    <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2.5">
      {/* 5-hour limit */}
      {limits.five_hour && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              5h Limit
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              {limits.five_hour.utilization}%
              {limits.five_hour.resets_at && (
                <span className="ml-1 text-cc-muted">
                  ({formatUsageResetTime(limits.five_hour.resets_at, { includeDays: true, invalidFallback: "N/A" })})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden relative">
            <div
              className={`h-full rounded-full transition-all duration-500 ${usageBarColor(limits.five_hour.utilization)}`}
              style={{
                width: `${Math.min(limits.five_hour.utilization, 100)}%`,
              }}
            />
            {(() => {
              const tp = cycleElapsedPct(limits.five_hour.resets_at, FIVE_HOURS_MS);
              return tp !== null ? (
                <div className="absolute top-0 h-full w-0.5 bg-cc-fg/80 rounded-full shadow-[0_0_2px_rgba(0,0,0,0.5)]" style={{ left: `${Math.min(tp, 100)}%` }} />
              ) : null;
            })()}
          </div>
        </div>
      )}

      {/* 7-day limit */}
      {limits.seven_day && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              7d Limit
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              {limits.seven_day.utilization}%
              {limits.seven_day.resets_at && (
                <span className="ml-1 text-cc-muted">
                  ({formatUsageResetTime(limits.seven_day.resets_at, { includeDays: true, invalidFallback: "N/A" })})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden relative">
            <div
              className={`h-full rounded-full transition-all duration-500 ${usageBarColor(limits.seven_day.utilization)}`}
              style={{
                width: `${Math.min(limits.seven_day.utilization, 100)}%`,
              }}
            />
            {(() => {
              const tp = cycleElapsedPct(limits.seven_day.resets_at, SEVEN_DAYS_MS);
              return tp !== null ? (
                <div className="absolute top-0 h-full w-0.5 bg-cc-fg/80 rounded-full shadow-[0_0_2px_rgba(0,0,0,0.5)]" style={{ left: `${Math.min(tp, 100)}%` }} />
              ) : null;
            })()}
          </div>
        </div>
      )}

      {/* Extra usage (only if 5h/7d not available) */}
      {hasExtra && limits.extra_usage && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              Extra
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              ${limits.extra_usage.used_credits.toFixed(2)} / $
              {limits.extra_usage.monthly_limit}
            </span>
          </div>
          {limits.extra_usage.utilization !== null && (
            <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${usageBarColor(limits.extra_usage.utilization)}`}
                style={{
                  width: `${Math.min(limits.extra_usage.utilization, 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Codex Rate Limits ───────────────────────────────────────────────────────

function formatCodexResetTime(resetsAtMs: number): string {
  // Codex resetsAt values are usually epoch-seconds, but normalize defensively
  // if a newer payload uses epoch-milliseconds.
  const absoluteMs = resetsAtMs > 1_000_000_000_000 ? resetsAtMs : resetsAtMs * 1000;
  const diffMs = absoluteMs - Date.now();
  if (diffMs <= 0) return "now";
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

function formatWindowDuration(mins: number): string {
  if (mins >= 1440) return `${Math.round(mins / 1440)}d`;
  if (mins >= 60) return `${Math.round(mins / 60)}h`;
  return `${mins}m`;
}

function CodexRateLimitsSection({ sessionId }: { sessionId: string }) {
  const rateLimits = useStore((s) => s.sessions.get(sessionId)?.codex_rate_limits);

  // Tick for countdown refresh
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!rateLimits) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [rateLimits]);

  if (!rateLimits) return null;
  const { primary, secondary } = rateLimits;
  if (!primary && !secondary) return null;

  return (
    <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2.5">
      {primary && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              {formatWindowDuration(primary.windowDurationMins)} Limit
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              {Math.round(primary.usedPercent)}%
              {primary.resetsAt > 0 && (
                <span className="ml-1">
                  ({formatCodexResetTime(primary.resetsAt)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
              <div
              className={`h-full rounded-full transition-all duration-500 ${usageBarColor(primary.usedPercent)}`}
              style={{ width: `${Math.min(primary.usedPercent, 100)}%` }}
            />
          </div>
        </div>
      )}
      {secondary && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted uppercase tracking-wider">
              {formatWindowDuration(secondary.windowDurationMins)} Limit
            </span>
            <span className="text-[11px] text-cc-muted tabular-nums">
              {Math.round(secondary.usedPercent)}%
              {secondary.resetsAt > 0 && (
                <span className="ml-1">
                  ({formatCodexResetTime(secondary.resetsAt)})
                </span>
              )}
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${usageBarColor(secondary.usedPercent)}`}
              style={{ width: `${Math.min(secondary.usedPercent, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Codex Token Details ─────────────────────────────────────────────────────

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function CodexTokenDetailsSection({ sessionId }: { sessionId: string }) {
  const details = useStore((s) => s.sessions.get(sessionId)?.codex_token_details);
  // Use the server-computed context percentage (backend-specific, capped 0-100).
  const contextPct = useStore((s) => s.sessions.get(sessionId)?.context_used_percent ?? 0);

  if (!details) return null;

  return (
    <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2">
      <span className="text-[11px] text-cc-muted uppercase tracking-wider">Tokens</span>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-cc-muted">Input</span>
          <span className="text-[11px] text-cc-fg tabular-nums font-medium">{formatTokenCount(details.inputTokens)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-cc-muted">Output</span>
          <span className="text-[11px] text-cc-fg tabular-nums font-medium">{formatTokenCount(details.outputTokens)}</span>
        </div>
        {details.cachedInputTokens > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted">Cached</span>
            <span className="text-[11px] text-cc-fg tabular-nums font-medium">{formatTokenCount(details.cachedInputTokens)}</span>
          </div>
        )}
        {details.reasoningOutputTokens > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted">Reasoning</span>
            <span className="text-[11px] text-cc-fg tabular-nums font-medium">{formatTokenCount(details.reasoningOutputTokens)}</span>
          </div>
        )}
      </div>
      {details.modelContextWindow > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-cc-muted">Context</span>
            <span className="text-[11px] text-cc-muted tabular-nums">{contextPct}%</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-cc-hover overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${usageBarColor(contextPct)}`}
              style={{ width: `${Math.min(contextPct, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GitHub PR Status ────────────────────────────────────────────────────────

function prStatePill(state: GitHubPRInfo["state"], isDraft: boolean) {
  if (isDraft) return { label: "Draft", cls: "text-cc-muted bg-cc-hover" };
  switch (state) {
    case "OPEN": return { label: "Open", cls: "text-cc-success bg-cc-success/10" };
    case "MERGED": return { label: "Merged", cls: "text-purple-400 bg-purple-400/10" };
    case "CLOSED": return { label: "Closed", cls: "text-cc-error bg-cc-error/10" };
  }
}

export function GitHubPRDisplay({ pr }: { pr: GitHubPRInfo }) {
  const pill = prStatePill(pr.state, pr.isDraft);
  const { checksSummary: cs, reviewThreads: rt } = pr;

  return (
    <div className="shrink-0 px-4 py-3 border-b border-cc-border space-y-2">
      {/* Row 1: PR number + state pill */}
      <div className="flex items-center gap-1.5">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[12px] font-semibold text-cc-fg hover:text-cc-primary transition-colors"
        >
          PR #{pr.number}
        </a>
        <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] ${pill.cls}`}>
          {pill.label}
        </span>
      </div>

      {/* Row 2: Title */}
      <p className="text-[11px] text-cc-muted truncate" title={pr.title}>
        {pr.title}
      </p>

      {/* Row 3: CI Checks */}
      {cs.total > 0 && (
        <div className="flex items-center gap-2 text-[11px]">
          {cs.failure > 0 ? (
            <>
              <span className="flex items-center gap-1 text-cc-error">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                  <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </svg>
                {cs.failure} failing
              </span>
              {cs.success > 0 && (
                <span className="flex items-center gap-1 text-cc-success">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" clipRule="evenodd" />
                  </svg>
                  {cs.success} passed
                </span>
              )}
            </>
          ) : cs.pending > 0 ? (
            <span className="flex items-center gap-1 text-cc-warning">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 animate-spin">
                <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8z" opacity=".2" />
                <path d="M8 0a8 8 0 018 8h-2A6 6 0 008 2V0z" />
              </svg>
              {cs.pending} pending
              {cs.success > 0 && (
                <span className="text-cc-success ml-1">{cs.success} passed</span>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-cc-success">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" clipRule="evenodd" />
              </svg>
              {cs.total}/{cs.total} checks passed
            </span>
          )}
        </div>
      )}

      {/* Row 4: Review + unresolved comments */}
      <div className="flex items-center gap-2 text-[11px]">
        {pr.reviewDecision === "APPROVED" && (
          <span className="flex items-center gap-1 text-cc-success">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" clipRule="evenodd" />
            </svg>
            Approved
          </span>
        )}
        {pr.reviewDecision === "CHANGES_REQUESTED" && (
          <span className="flex items-center gap-1 text-cc-error">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path fillRule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 11-2 0 1 1 0 012 0zM8 7a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 7z" clipRule="evenodd" />
            </svg>
            Changes requested
          </span>
        )}
        {(pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === null) && pr.state === "OPEN" && (
          <span className="flex items-center gap-1 text-cc-muted">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
              <circle cx="8" cy="8" r="6" />
            </svg>
            Review pending
          </span>
        )}
        {rt.unresolved > 0 && (
          <span className="flex items-center gap-1 text-cc-warning">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              <path d="M2.5 2A1.5 1.5 0 001 3.5v8A1.5 1.5 0 002.5 13h2v2.5l3.5-2.5h5.5a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0013.5 2h-11z" />
            </svg>
            {rt.unresolved} unresolved
          </span>
        )}
      </div>

      {/* Row 5: Diff stats */}
      <div className="flex items-center gap-1.5 text-[10px] text-cc-muted">
        <span className="text-green-500">+{pr.additions}</span>
        <span className="text-red-400">-{pr.deletions}</span>
        <span>&middot; {pr.changedFiles} files</span>
      </div>
    </div>
  );
}

export function GitHubPRSection({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdk = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const prStatus = useStore((s) => s.prStatus.get(sessionId));

  const cwd = session?.cwd || sdk?.cwd;
  const branch = session?.git_branch || sdk?.gitBranch;

  // One-time REST fallback on mount if no pushed data yet
  useEffect(() => {
    if (prStatus || !cwd || !branch) return;
    api.getPRStatus(cwd, branch).then((data) => {
      useStore.getState().setPRStatus(sessionId, data);
    }).catch(() => {});
  }, [sessionId, cwd, branch, prStatus]);

  if (!prStatus?.available || !prStatus.pr) return null;

  return <GitHubPRDisplay pr={prStatus.pr} />;
}

// ─── Collapsible wrappers ────────────────────────────────────────────────────

function UsageCollapsible({ sessionId, isCodex }: { sessionId: string; isCodex: boolean }) {
  const [collapsed, toggle] = usePersistedCollapse("cc-collapse-usage");
  return (
    <>
      <SectionHeader title="Usage" collapsed={collapsed} onToggle={toggle} />
      {!collapsed && (
        isCodex ? (
          <>
            <CodexRateLimitsSection sessionId={sessionId} />
            <CodexTokenDetailsSection sessionId={sessionId} />
          </>
        ) : (
          <UsageLimitsSection sessionId={sessionId} />
        )
      )}
    </>
  );
}

export function McpCollapsible({ sessionId }: { sessionId: string }) {
  const [collapsed, toggle] = usePersistedCollapse("cc-collapse-mcp");
  return <McpSection sessionId={sessionId} collapsed={collapsed} onToggle={toggle} />;
}

export function ClaudeMdCollapsible({ cwd, repoRoot }: { cwd: string; repoRoot?: string }) {
  const [collapsed, toggle] = usePersistedCollapse("cc-collapse-claudemd");
  const [files, setFiles] = useState<{ path: string; content: string; writable?: boolean }[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [initialEditorView, setInitialEditorView] = useState<"file" | "autoApproval">("file");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [hasAutoApprovalConfig, setHasAutoApprovalConfig] = useState(false);

  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    Promise.all([
      api.getClaudeMdFiles(cwd).catch(() => ({ files: [] })),
      api.getAutoApprovalConfigForPath(cwd, repoRoot).catch(() => ({ config: null })),
    ]).then(([res, aaRes]) => {
      if (cancelled) return;
      setFiles(res.files);
      setHasAutoApprovalConfig(!!aaRes.config);
    }).catch(() => {
      if (cancelled) return;
      setFiles([]);
      setHasAutoApprovalConfig(false);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, repoRoot, collapsed]);

  const relPath = (p: string) => p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;

  return (
    <>
      <SectionHeader title="CLAUDE.md" collapsed={collapsed} onToggle={toggle} />
      {!collapsed && (
        <div className="px-3 py-2 space-y-1">
          {files.length === 0 ? (
            <button
              onClick={() => {
                setInitialEditorView("file");
                setEditorOpen(true);
              }}
              className="w-full text-left px-2 py-1.5 text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
            >
              + Create CLAUDE.md
            </button>
          ) : (
            files.map((f) => (
              <button
                key={f.path}
                onClick={() => {
                  setInitialEditorView("file");
                  setSelectedPath(f.path);
                  setEditorOpen(true);
                }}
                className="flex items-center gap-2 w-full px-2 py-1.5 text-[11px] text-cc-fg/80 hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-primary shrink-0">
                  <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13z" />
                </svg>
                <span className="truncate font-mono-code">{relPath(f.path)}</span>
              </button>
            ))
          )}
          {hasAutoApprovalConfig && (
            <button
              onClick={() => {
                setInitialEditorView("autoApproval");
                setSelectedPath(null);
                setEditorOpen(true);
              }}
              className="flex items-center gap-2 w-full px-2 py-1.5 text-[11px] text-cc-warning/90 hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-warning shrink-0">
                <path d="M8 1.5a.5.5 0 01.424.235l6.5 10.5A.5.5 0 0114.5 13h-13a.5.5 0 01-.424-.765l6.5-10.5A.5.5 0 018 1.5zM7.5 6v3.5a.5.5 0 001 0V6a.5.5 0 00-1 0zm.5 5.5a.6.6 0 100 1.2.6.6 0 000-1.2z" />
              </svg>
              <span className="truncate">Auto-Approval Rules</span>
            </button>
          )}
        </div>
      )}
      <ClaudeMdEditor
        cwd={cwd}
        repoRoot={repoRoot}
        open={editorOpen}
        initialView={initialEditorView}
        initialPath={selectedPath ?? undefined}
        onClose={() => {
          setEditorOpen(false);
          setInitialEditorView("file");
          setSelectedPath(null);
        }}
      />
    </>
  );
}

// ─── Task Panel ──────────────────────────────────────────────────────────────

export { CodexRateLimitsSection, CodexTokenDetailsSection };

function SessionTasksSection({ sessionId }: { sessionId: string }) {
  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const requestScrollToTurn = useStore((s) => s.requestScrollToTurn);
  const [collapsed, toggle] = usePersistedCollapse("cc-collapse-session-tasks");

  if (!taskHistory || taskHistory.length === 0) return null;

  return (
    <>
      <SectionHeader title="Session Tasks" collapsed={collapsed} onToggle={toggle} />
      {!collapsed && (
        <div className="px-3 py-2 space-y-0.5">
          {taskHistory.map((task, i) => (
            <button
              key={i}
              type="button"
              onClick={() => requestScrollToTurn(sessionId, task.triggerMessageId)}
              className="w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left hover:bg-cc-hover transition-colors cursor-pointer group"
            >
              <span className="text-[11px] text-cc-muted/50 shrink-0 mt-px tabular-nums">{i + 1}.</span>
              <div className="flex-1 min-w-0">
                <span className="text-[13px] text-cc-fg leading-snug line-clamp-2 group-hover:text-cc-primary transition-colors">
                  {task.title}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Herded sessions (orchestrator panel) ────────────────────────────────────

function HerdedSessionsSection({ sessionId }: { sessionId: string }) {
  const [collapsed, toggle] = usePersistedCollapse("cc-collapse-herded");
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessionNames = useStore((s) => s.sessionNames);

  const herded = sdkSessions.filter(
    (s: SdkSessionInfo) => s.herdedBy === sessionId
  );

  const handleUnherd = useCallback(async (workerId: string) => {
    try {
      await api.unherdSession(sessionId, workerId);
      api.listSessions().then((sessions: SdkSessionInfo[]) => {
        useStore.getState().setSdkSessions(sessions);
      }).catch(() => {});
    } catch (e) {
      console.error("[TaskPanel] Failed to unherd:", e);
    }
  }, [sessionId]);

  return (
    <>
      <SectionHeader
        title="Herded Sessions"
        collapsed={collapsed}
        onToggle={toggle}
        right={herded.length > 0 ? (
          <span className="text-[10px] text-cc-muted tabular-nums">{herded.length}</span>
        ) : undefined}
      />
      {!collapsed && (
        <div className="px-3 py-2 space-y-1">
          {herded.length === 0 ? (
            <p className="text-[11px] text-cc-muted italic">No herded sessions.</p>
          ) : (
            herded.map((s: SdkSessionInfo) => {
              const name = sessionNames.get(s.sessionId) || s.name || "(unnamed)";
              const isRunning = s.state === "running" || s.state === "connected";
              const dotColor = s.state === "exited" ? "text-cc-muted/40"
                : isRunning ? "text-cc-success"
                : "text-cc-muted/60";
              return (
                <div key={s.sessionId} className="flex items-center gap-2 py-1 group/herd">
                  <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotColor} bg-current`} />
                  <button
                    className="flex-1 text-left text-[11px] text-cc-fg truncate hover:underline cursor-pointer"
                    onClick={() => { window.location.hash = `#/sessions/${s.sessionId}`; }}
                    title={name}
                  >
                    {s.sessionNum != null && <span className="text-cc-muted font-mono mr-1">#{s.sessionNum}</span>}
                    {name}
                  </button>
                  <button
                    className="opacity-0 group-hover/herd:opacity-100 text-cc-muted hover:text-cc-error transition-all cursor-pointer p-0.5"
                    title="Unherd this session"
                    onClick={() => handleUnherd(s.sessionId)}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </>
  );
}

// ─── Herd diagnostics (orchestrator debug panel) ─────────────────────────────

export function HerdDiagnosticsSection({ sessionId }: { sessionId: string }) {
  const [collapsed, toggle] = usePersistedCollapse("cc-collapse-herd-diag");
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const data = await api.getHerdDiagnostics(sessionId);
        if (active) setDiag(data);
      } catch { /* ignore */ }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [sessionId]);

  if (!diag) return null;

  const dispatcher = diag.herdDispatcher as Record<string, unknown> | null;
  const pendingCount = dispatcher?.pendingEventCount as number || 0;
  const isGen = diag.isGenerating as boolean;
  const cliConn = diag.cliConnected as boolean;
  const cliInitReceived = diag.cliInitReceived as boolean;
  const pendingMsgs = diag.pendingMessagesCount as number || 0;
  const graceActive = diag.disconnectGraceActive as boolean;
  const eventHistory = (dispatcher?.eventHistory || []) as Array<{
    event: string; sessionName: string; ts: number; deliveredAt: number | null; status: string;
  }>;

  // Compact status line
  const statusParts: string[] = [];
  if (pendingCount > 0) statusParts.push(`${pendingCount} events`);
  if (isGen) statusParts.push("generating");
  if (!cliConn) statusParts.push("cli disconnected");
  else if (!cliInitReceived) statusParts.push("cli connected (init pending)");
  if (graceActive) statusParts.push("grace period");
  if (pendingMsgs > 0) statusParts.push(`${pendingMsgs} queued msgs`);
  const statusLine = statusParts.length > 0 ? statusParts.join(" · ") : "✓ idle";

  return (
    <>
      <SectionHeader
        title="Herd Diagnostics"
        collapsed={collapsed}
        onToggle={toggle}
        right={pendingCount > 0 ? (
          <span className="text-[10px] text-amber-400 tabular-nums">{pendingCount} pending</span>
        ) : undefined}
      />
      {!collapsed && (
        <div className="px-3 py-2 text-[10px] font-mono text-cc-muted space-y-0.5">
          <div>{statusLine}</div>
          {pendingCount > 0 && dispatcher != null && (
            <div className="text-amber-400/70">
              Events: {String((dispatcher.pendingEventTypes as string[] || []).join(", "))}
            </div>
          )}
          <div className="opacity-50">
            workers: {(diag.herdedWorkers as Array<Record<string, unknown>> || []).length}
            {" · "}perms: {diag.pendingPermissionsCount as number || 0}
          </div>
          {/* Persistent event history */}
          {eventHistory.length > 0 && (
            <div className="mt-1.5 pt-1.5 border-t border-cc-border/30">
              <div className="text-[9px] text-cc-muted/50 mb-0.5">Recent events ({eventHistory.length})</div>
              <div className="max-h-24 overflow-y-auto space-y-px">
                {eventHistory.slice(-15).map((h, i) => {
                  const time = new Date(h.ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
                  const statusIcon = h.status === "delivered" ? "✓" : h.status === "dropped" ? "✗" : "⏳";
                  const statusColor = h.status === "delivered" ? "text-green-500/60" : h.status === "dropped" ? "text-red-500/60" : "text-amber-400/60";
                  return (
                    <div key={i} className="flex items-center gap-1">
                      <span className={`${statusColor} shrink-0`}>{statusIcon}</span>
                      <span className="text-cc-muted/40">{time}</span>
                      <span className="truncate">{h.event} · {h.sessionName}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function TaskPanel({ sessionId }: { sessionId: string }) {
  const tasks = useStore((s) => s.sessionTasks.get(sessionId) || EMPTY_TASKS);
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((x) => x.sessionId === sessionId));
  const sdkBackendType = sdkSession?.backendType;
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);

  if (!taskPanelOpen) return null;

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const isCodex = (session?.backend_type || sdkBackendType) === "codex";
  const showTasks = !!session;
  const cwd = session?.cwd || sdkSession?.cwd || null;

  return (
    <aside className="w-[280px] h-full flex flex-col overflow-hidden bg-cc-card border-l border-cc-border">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-cc-border">
        <span className="text-sm font-semibold text-cc-fg tracking-tight">
          Session
        </span>
        <button
          onClick={() => setTaskPanelOpen(false)}
          className="flex items-center justify-center w-6 h-6 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="w-3.5 h-3.5"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div data-testid="task-panel-content" className="min-h-0 flex-1 overflow-y-auto">
        {/* Usage limits — Claude Code uses REST-polled limits, Codex uses streamed rate limits */}
        <UsageCollapsible sessionId={sessionId} isCodex={isCodex} />

        {/* GitHub PR status */}
        <GitHubPRSection sessionId={sessionId} />

        {/* MCP servers */}
        <McpCollapsible sessionId={sessionId} />

        {/* CLAUDE.md files */}
        {cwd && <ClaudeMdCollapsible cwd={cwd} repoRoot={session?.repo_root || undefined} />}

        {/* Session-level tasks recognized by the auto-namer */}
        {showTasks && <SessionTasksSection sessionId={sessionId} />}

        {/* Herded sessions — only for orchestrator sessions */}
        {sdkSession?.isOrchestrator && <HerdedSessionsSection sessionId={sessionId} />}

        {/* Herd diagnostics — only for orchestrator sessions */}
        {sdkSession?.isOrchestrator && <HerdDiagnosticsSection sessionId={sessionId} />}

        {/* Agent to-do items — hidden when empty or all completed */}
        {showTasks && tasks.length > 0 && completedCount < tasks.length && (
          <>
            <div className="px-4 py-2.5 border-b border-cc-border flex items-center justify-between">
              <span className="text-[12px] font-semibold text-cc-fg">Current To-Dos</span>
              <span className="text-[11px] text-cc-muted tabular-nums">
                {completedCount}/{tasks.length}
              </span>
            </div>

            <div className="px-3 py-2">
              <div className="space-y-0.5">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} sessionId={sessionId} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

export function TaskRow({ task, sessionId }: { task: TaskItem; sessionId?: string }) {
  const isRunning = useStore((s) => sessionId ? s.sessionStatus.get(sessionId) === "running" : false);
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div
      className={`px-2.5 py-2 rounded-lg ${isCompleted ? "opacity-50" : ""}`}
    >
      <div className="flex items-start gap-2">
        {/* Status icon */}
        <span className="shrink-0 flex items-center justify-center w-4 h-4 mt-px">
          {isInProgress ? (
            <svg
              className={`w-4 h-4 text-cc-primary ${isRunning ? "animate-spin" : ""}`}
              viewBox="0 0 16 16"
              fill="none"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="28"
                strokeDashoffset="8"
                strokeLinecap="round"
              />
            </svg>
          ) : isCompleted ? (
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-4 h-4 text-cc-success"
            >
              <path
                fillRule="evenodd"
                d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              fill="none"
              className="w-4 h-4 text-cc-muted"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          )}
        </span>

        {/* Subject — allow wrapping */}
        <span
          className={`text-[13px] leading-snug flex-1 ${
            isCompleted ? "text-cc-muted line-through" : "text-cc-fg"
          }`}
        >
          {task.subject}
        </span>
      </div>

      {/* Active form text (in_progress only) */}
      {isInProgress && task.activeForm && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted italic truncate">
          {task.activeForm}
        </p>
      )}

      {/* Blocked by */}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 shrink-0">
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M5 8h6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <span>
            blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}
          </span>
        </p>
      )}
    </div>
  );
}
