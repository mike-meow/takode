/**
 * Persistent work board widget for orchestrator sessions.
 *
 * Positioned between TodoStatusLine and Composer in ChatView. Shows a thin
 * summary bar (collapsed, default) that expands on click to show the full
 * board table. Only visible for orchestrator sessions with a non-empty board
 * (active or completed items).
 *
 * Follows the TodoStatusLine pattern: shrink-0 at the bottom of the flex
 * column, outside the scrollable message feed.
 */
import { useState, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { BoardTable } from "./BoardTable.js";
import type { BoardRowData } from "./BoardTable.js";

/**
 * Build a compact status summary for the collapsed board bar.
 * Groups rows by status and returns a comma-separated count string,
 * e.g. "2 IMPLEMENTING, 1 SKEPTIC_REVIEWING".
 * Rows with no status are grouped as "unknown".
 */
export function boardSummary(board: BoardRowData[], completedCount: number): string {
  if (board.length === 0 && completedCount === 0) return "Empty";
  const counts = new Map<string, number>();
  for (const row of board) {
    const status = row.status ?? "unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([s, n]) => `${n} ${s}`);
  if (completedCount > 0) parts.push(`${completedCount} done`);
  return parts.join(", ");
}

export function WorkBoardBar({ sessionId }: { sessionId: string }) {
  const board = useStore((s) => s.sessionBoards.get(sessionId));
  const completedBoard = useStore((s) => s.sessionCompletedBoards.get(sessionId));
  const isOrchestrator = useStore((s) =>
    s.sdkSessions.some((session) => session.sessionId === sessionId && session.isOrchestrator === true),
  );

  const [expanded, setExpanded] = useState(false);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [expanded]);

  // Close on Escape
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [expanded]);

  const activeCount = board?.length ?? 0;
  const completedCount = completedBoard?.length ?? 0;

  // Only show for orchestrator sessions with a non-empty board (active or completed)
  if (!isOrchestrator || (activeCount === 0 && completedCount === 0)) return null;

  return (
    <div ref={containerRef} className="shrink-0 flex flex-col min-h-0">
      {/* Expanded board table -- inline, pushes chat content up */}
      {expanded && (
        <div className="border-t border-cc-border bg-cc-card max-h-[40dvh] overflow-y-auto">
          {activeCount > 0 && <BoardTable board={board!} />}
          {activeCount === 0 && <div className="px-3 py-3 text-xs text-cc-muted italic">No active items</div>}

          {/* Collapsible completed section */}
          {completedCount > 0 && (
            <div className="border-t border-cc-border">
              <button
                type="button"
                onClick={() => setCompletedExpanded(!completedExpanded)}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-cc-hover/50 transition-colors cursor-pointer"
              >
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`w-2.5 h-2.5 text-cc-muted shrink-0 transition-transform duration-150 ${completedExpanded ? "rotate-90" : ""}`}
                >
                  <path d="M4 2l4 4-4 4" />
                </svg>
                <span className="text-[11px] text-cc-muted">
                  {completedCount} completed
                </span>
              </button>
              {completedExpanded && (
                <div className="opacity-60">
                  <BoardTable board={completedBoard!} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Summary bar -- click to toggle expanded */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 sm:px-4 py-1.5 border-t border-cc-border bg-cc-card hover:bg-cc-hover/50 transition-colors cursor-pointer"
      >
        {/* Kanban board icon */}
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-blue-400 shrink-0">
          <path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11z" />
          <path d="M4 4h2v5H4zM7 4h2v7H7zM10 4h2v3h-2z" />
        </svg>

        {/* Summary text */}
        <span className="text-[11px] text-cc-fg/80 truncate flex-1 text-left">
          {boardSummary(board ?? [], completedCount)}
        </span>

        {/* Item count */}
        <span className="text-[10px] text-cc-muted shrink-0 tabular-nums">
          {activeCount} {activeCount === 1 ? "item" : "items"}
        </span>

        {/* Chevron */}
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`w-3 h-3 text-cc-muted shrink-0 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
        >
          <path d="M3 5l3-3 3 3" />
        </svg>
      </button>
    </div>
  );
}
