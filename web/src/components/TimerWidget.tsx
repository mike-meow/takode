import { useState, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { SessionTimer } from "../types.js";

const EMPTY_TIMERS: SessionTimer[] = [];

/** Format an epoch timestamp as a relative human-readable duration from now. */
function formatRelativeTime(epochMs: number): string {
  const diffMs = epochMs - Date.now();
  if (diffMs <= 0) return "firing...";
  const totalSeconds = Math.ceil(diffMs / 1_000);
  if (totalSeconds < 60) return `in ${totalSeconds}s`;
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return remainMins > 0 ? `in ${hours}h${remainMins}m` : `in ${hours}h`;
}

// ─── Shared hooks ────────────────────────────────────────────────────────────

/** Read session timers from the store, sorted by soonest-first. Auto-refresh countdown every 10s. */
function useTimers(sessionId: string) {
  const timers = useStore((s) => s.sessionTimers?.get(sessionId) ?? EMPTY_TIMERS);

  // Tick forces re-render so formatRelativeTime picks up the latest wall clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (timers.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(interval);
  }, [timers.length]);

  // Sort by nextFireAt ascending (soonest first). Called before any early return
  // so hook count stays stable across renders.
  const sorted = useMemo(
    () => [...timers].sort((a, b) => a.nextFireAt - b.nextFireAt),
    [timers],
  );

  return { timers, sorted };
}

// ─── Timer Modal ─────────────────────────────────────────────────────────────

function TimerModalRow({ timer, sessionId }: { timer: SessionTimer; sessionId: string }) {
  const typeLabel =
    timer.type === "recurring"
      ? `every ${timer.originalSpec}`
      : timer.type === "at"
        ? `at ${timer.originalSpec}`
        : null;

  return (
    <div className="flex items-start gap-3 px-4 py-3 group hover:bg-white/[0.03] transition-colors">
      <span className="font-mono text-cc-muted text-[11px] shrink-0 pt-0.5">{timer.id}</span>
      <div className="flex-1 min-w-0 space-y-0.5">
        {/* Full untruncated prompt */}
        <p className="text-[13px] text-cc-fg/90 leading-snug break-words">{timer.prompt}</p>
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

export function TimerModal({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { sorted } = useTimers(sessionId);

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

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Session timers"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal card */}
      <div
        className="relative w-full max-w-md mx-4 rounded-2xl border border-cc-border bg-cc-card/95 shadow-[0_25px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-cc-border/50">
          <h2 className="text-sm font-medium text-cc-fg">
            Session Timers
            <span className="ml-2 text-[11px] text-cc-muted font-normal">({sorted.length})</span>
          </h2>
          <button
            onClick={onClose}
            className="text-cc-muted hover:text-cc-fg transition-colors p-1 -mr-1 cursor-pointer"
            aria-label="Close"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Timer list */}
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-cc-border/30">
          {sorted.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-cc-muted">No active timers</p>
          ) : (
            sorted.map((timer) => (
              <TimerModalRow key={timer.id} timer={timer} sessionId={sessionId} />
            ))
          )}
        </div>
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

  return (
    <>
      <button
        onClick={openModal}
        className="pointer-events-auto relative inline-flex max-w-[min(18rem,calc(100vw-2.75rem))] items-center gap-1.5 overflow-hidden rounded-[18px] border border-white/8 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-2.5 py-1 text-[11px] text-cc-muted font-mono-code shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-md cursor-pointer hover:border-white/15 transition-colors"
      >
        <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.10),transparent_55%)]" />
        <span className="relative">⏰</span>
        <span className="relative truncate text-cc-fg/90">
          {timers.length} timer{timers.length !== 1 ? "s" : ""}
        </span>
        <span className="relative text-cc-muted/75">
          next {formatRelativeTime(sorted[0].nextFireAt)}
        </span>
      </button>

      {modalOpen && <TimerModal sessionId={sessionId} onClose={closeModal} />}
    </>
  );
}
