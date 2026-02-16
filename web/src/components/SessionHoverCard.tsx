import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import type { SessionState } from "../../server/session-types.js";
import { useRef, useLayoutEffect } from "react";

interface SessionHoverCardProps {
  session: SessionItemType;
  sessionName: string | undefined;
  sessionPreview: string | undefined;
  sessionState: SessionState | undefined;
  anchorRect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/** Format model name for display (e.g. "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5") */
function formatModel(model: string): string {
  // Strip date suffixes like -20250929
  return model.replace(/-\d{8}$/, "");
}

export function SessionHoverCard({
  session: s,
  sessionName,
  sessionPreview,
  sessionState,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
}: SessionHoverCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Status info
  const isRunning = s.status === "running";
  const isCompacting = s.status === "compacting";
  const isExited = s.sdkState === "exited";
  const statusLabel = s.archived
    ? "archived"
    : isRunning
    ? "running"
    : isCompacting
    ? "compacting"
    : isExited
    ? "exited"
    : "idle";
  const statusDotClass = s.archived
    ? "bg-cc-muted/40"
    : s.permCount > 0
    ? "bg-cc-warning"
    : isExited
    ? "bg-cc-muted/40"
    : isRunning
    ? "bg-cc-success"
    : isCompacting
    ? "bg-cc-warning"
    : "bg-cc-success/60";

  const shortId = s.id.slice(0, 8);
  const label = sessionName || s.model || shortId;
  const model = sessionState?.model || s.model || "";
  const backendLabel = s.backendType === "codex" ? "Codex" : "Claude";

  // Stats from sessionState
  const turns = sessionState?.num_turns ?? 0;
  const cost = sessionState?.total_cost_usd ?? 0;
  const contextPercent = sessionState?.context_used_percent ?? 0;

  // Position: right of sidebar, vertically aligned with the hovered item
  // The sidebar is 260px wide. Position card to the right of the anchor.
  const cardWidth = 340;
  const gap = 4;

  // Initial position — will be corrected by useLayoutEffect for viewport clamping
  const left = anchorRect.right + gap;
  const top = anchorRect.top;

  // Clamp to viewport after render
  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const el = cardRef.current;

    // Clamp horizontal: if overflows right, show to the left of the anchor
    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${anchorRect.left - cardWidth - gap}px`;
    }
    // Clamp vertical
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
    if (rect.top < 8) {
      el.style.top = "8px";
    }
  }, [anchorRect, cardWidth]);

  return (
    <div
      ref={cardRef}
      className="fixed z-50 pointer-events-auto hidden-on-touch"
      style={{ left, top, width: cardWidth }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="bg-cc-card border border-cc-border rounded-xl shadow-xl overflow-hidden">
        {/* Header: Name + Status */}
        <div className="px-4 pt-3 pb-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[14px] font-semibold text-cc-fg leading-snug break-words min-w-0">
              {label}
            </span>
            <span className="flex items-center gap-1.5 shrink-0">
              <span className={`w-2 h-2 rounded-full ${statusDotClass}`} />
              <span className="text-[11px] text-cc-muted">{statusLabel}</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[11px] font-medium ${s.backendType === "codex" ? "text-blue-500" : "text-[#5BA8A0]"}`}>
              {backendLabel}
            </span>
            {model && (
              <>
                <span className="text-cc-muted/40 text-[10px]">&middot;</span>
                <span className="text-[11px] text-cc-muted">{formatModel(model)}</span>
              </>
            )}
            {s.cronJobId && (
              <>
                <span className="text-cc-muted/40 text-[10px]">&middot;</span>
                <span className="text-[11px] text-violet-500 font-medium">Cron</span>
              </>
            )}
          </div>
        </div>

        {/* Preview section */}
        {sessionPreview && (
          <div className="px-4 py-2 border-t border-cc-border/50">
            <p className="text-[12px] text-cc-muted leading-relaxed line-clamp-3 italic">
              &ldquo;{sessionPreview}&rdquo;
            </p>
          </div>
        )}

        {/* Git section */}
        {(s.gitBranch || s.gitAhead > 0 || s.gitBehind > 0 || s.linesAdded > 0 || s.linesRemoved > 0) && (
          <div className="px-4 py-2 border-t border-cc-border/50">
            {s.gitBranch && (
              <div className="flex items-center gap-1.5 text-[12px] text-cc-muted leading-tight">
                {s.isWorktree ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-50">
                    <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-50">
                    <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                  </svg>
                )}
                <span className="break-all">{s.gitBranch}</span>
                {s.isWorktree && (
                  <span className="text-[9px] bg-cc-primary/10 text-cc-primary px-1 rounded shrink-0">wt</span>
                )}
              </div>
            )}
            {(s.gitAhead > 0 || s.gitBehind > 0 || s.linesAdded > 0 || s.linesRemoved > 0) && (
              <div className="flex items-center gap-2 mt-1 text-[11px] text-cc-muted">
                {(s.gitAhead > 0 || s.gitBehind > 0) && (
                  <span className="flex items-center gap-1">
                    {s.gitAhead > 0 && <span className="text-green-500">{s.gitAhead}&#8593;</span>}
                    {s.gitBehind > 0 && <span className="text-cc-warning">{s.gitBehind}&#8595;</span>}
                  </span>
                )}
                {(s.linesAdded > 0 || s.linesRemoved > 0) && (
                  <span className="flex items-center gap-1">
                    <span className="text-green-500">+{s.linesAdded}</span>
                    <span className="text-red-400">-{s.linesRemoved}</span>
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Stats row */}
        {(turns > 0 || cost > 0 || contextPercent > 0) && (
          <div className="px-4 py-2 border-t border-cc-border/50">
            <div className="flex items-center gap-2 text-[11px] text-cc-muted">
              {turns > 0 && <span>{turns} {turns === 1 ? "turn" : "turns"}</span>}
              {cost > 0 && (
                <>
                  {turns > 0 && <span className="text-cc-muted/40">&middot;</span>}
                  <span>${cost.toFixed(2)}</span>
                </>
              )}
              {contextPercent > 0 && (
                <>
                  {(turns > 0 || cost > 0) && <span className="text-cc-muted/40">&middot;</span>}
                  <span>{Math.round(contextPercent)}% context</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
