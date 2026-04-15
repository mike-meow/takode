import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { SessionTimer } from "../types.js";

const EMPTY_TIMERS: SessionTimer[] = [];

/** Format an epoch timestamp as a consistent countdown from now.
 *  < 1 hour: M:SS (e.g., "1:30", "0:45", "12:05")
 *  >= 1 hour: Xh Ym (e.g., "2h 15m", "1h 0m") */
function formatRelativeTime(epochMs: number): string {
  const diffMs = epochMs - Date.now();
  if (diffMs <= 0) return "firing...";
  const totalSeconds = Math.ceil(diffMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return `${hours}h ${remainMins}m`;
}

// ─── Shared hooks ────────────────────────────────────────────────────────────

/** Read session timers from the store, sorted by soonest-first. Auto-refresh countdown every 10s. */
function useTimers(sessionId: string) {
  const timers = useStore((s) => s.sessionTimers?.get(sessionId) ?? EMPTY_TIMERS);

  // Tick forces re-render so formatRelativeTime picks up the latest wall clock.
  // 1s interval since we now display seconds in the M:SS format.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (timers.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(interval);
  }, [timers.length]);

  // Sort by nextFireAt ascending (soonest first). Called before any early return
  // so hook count stays stable across renders.
  const sorted = useMemo(() => [...timers].sort((a, b) => a.nextFireAt - b.nextFireAt), [timers]);

  return { timers, sorted };
}

// ─── Timer Popover ───────────────────────────────────────────────────────────

function TimerModalRow({ timer, sessionId }: { timer: SessionTimer; sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const typeLabel =
    timer.type === "recurring"
      ? `every ${timer.originalSpec}`
      : timer.type === "at"
        ? `at ${timer.originalSpec}`
        : null;
  const descriptionLines = timer.description.split(/\r?\n/);
  const collapsedDescription = descriptionLines[0] ?? "";
  const canExpandDescription = descriptionLines.length > 1;
  const visibleDescription = expanded ? timer.description : collapsedDescription;

  return (
    <div className="flex items-start gap-3 px-4 py-3 group hover:bg-white/[0.03] transition-colors">
      <span className="font-mono text-cc-muted text-[11px] shrink-0 pt-0.5">{timer.id}</span>
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-[13px] font-medium text-cc-fg leading-snug break-words">{timer.title}</p>
        {timer.description && (
          <div className="space-y-1">
            <p className="text-[12px] text-cc-fg/65 leading-snug break-words whitespace-pre-wrap">{visibleDescription}</p>
            {canExpandDescription && (
              <button
                onClick={() => setExpanded((value) => !value)}
                className="text-[11px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                aria-label={expanded ? `Collapse timer ${timer.id} description` : `Expand timer ${timer.id} description`}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 text-[11px] text-cc-muted">
          {typeLabel && <span>{typeLabel}</span>}
          <span>{formatRelativeTime(timer.nextFireAt)}</span>
        </div>
      </div>
      <button
        onClick={() => void api.cancelTimer(sessionId, timer.id)}
        className="text-cc-muted hover:text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0 text-xs pt-0.5 cursor-pointer"
        title="Cancel timer"
      >
        ✕
      </button>
    </div>
  );
}

export function TimerModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { sorted } = useTimers(sessionId);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on Escape — stop propagation so stacked handlers (search overlay, etc.) don't also fire.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  }, [onClose]);

  // Click-outside to close (mousedown for early dismissal)
  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed bottom-14 right-3 z-50 w-80 max-w-[calc(100vw-1.5rem)] max-h-[50vh] flex flex-col rounded-2xl border border-cc-border bg-cc-card/95 shadow-[0_25px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl overflow-hidden"
      role="dialog"
      aria-label="Session timers"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-cc-border/50 shrink-0">
        <h2 className="text-[13px] font-medium text-cc-fg">
          Session Timers
          <span className="ml-1.5 text-[11px] text-cc-muted font-normal">({sorted.length})</span>
        </h2>
        <button
          onClick={onClose}
          className="text-cc-muted hover:text-cc-fg transition-colors p-1 -mr-1 cursor-pointer"
          aria-label="Close"
        >
          <svg
            className="w-3.5 h-3.5"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Timer list */}
      <div className="overflow-y-auto flex-1 divide-y divide-cc-border/30">
        {sorted.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-cc-muted">No active timers</p>
        ) : (
          sorted.map((timer) => <TimerModalRow key={timer.id} timer={timer} sessionId={sessionId} />)
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─── Timer Chip (floating pill) ──────────────────────────────────────────────

/** Glassmorphic floating pill matching the Purring indicator style. Renders nothing when no timers exist. */
export function TimerChip({ sessionId }: { sessionId: string }) {
  const { timers, sorted } = useTimers(sessionId);
  const [modalOpen, setModalOpen] = useState(false);

  const openModal = useCallback(() => setModalOpen(true), []);
  const closeModal = useCallback(() => setModalOpen(false), []);

  if (timers.length === 0) return null;
  const primaryLabel = `${timers.length} timer${timers.length !== 1 ? "s" : ""}`;

  return (
    <>
      <button
        onClick={openModal}
        className="pointer-events-auto relative inline-flex max-w-[min(18rem,calc(100vw-2.75rem))] items-center gap-1.5 overflow-hidden rounded-[18px] border border-white/8 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-2.5 py-1 text-[11px] text-cc-muted font-mono-code shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-md cursor-pointer hover:border-white/15 transition-colors"
      >
        <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.10),transparent_55%)]" />
        <span className="relative">⏰</span>
        <span className="relative truncate text-cc-fg/90">{primaryLabel}</span>
        <span className="relative text-cc-muted/75">next in {formatRelativeTime(sorted[0].nextFireAt)}</span>
      </button>

      {modalOpen && <TimerModal sessionId={sessionId} onClose={closeModal} />}
    </>
  );
}
