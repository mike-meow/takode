/**
 * Persistent work board widget for orchestrator sessions.
 *
 * Positioned between TodoStatusLine and Composer in ChatView. Shows a thin
 * summary bar (collapsed, default) that expands on click to show the full
 * board table. Once opened, it stays open until the user explicitly collapses
 * it. Only visible for orchestrator sessions with a non-empty board (active
 * or completed items).
 *
 * Follows the TodoStatusLine pattern: shrink-0 at the bottom of the flex
 * column, outside the scrollable message feed.
 */
import { useState, useEffect } from "react";
import { useStore } from "../store.js";
import { getQuestJourneyPresentation } from "../../shared/quest-journey.js";
import { BoardTable, orderBoardRows } from "./BoardTable.js";
import type { BoardRowData } from "./BoardTable.js";
import { scopedGetItem, scopedSetItem } from "../utils/scoped-storage.js";

export interface BoardSummarySegment {
  text: string;
  className: string;
}

/**
 * Build a compact status summary for the collapsed board bar.
 * Returns colored segments for rendering, e.g. [{text:"2 Executing Plan", className:"text-green-400"}, ...].
 */
export function boardSummary(board: BoardRowData[], completedCount: number): BoardSummarySegment[] {
  if (board.length === 0 && completedCount === 0) return [{ text: "Empty", className: "text-cc-muted" }];
  const counts = new Map<string, { count: number; className: string }>();
  for (const row of orderBoardRows(board)) {
    const pres = row.status ? getQuestJourneyPresentation(row.status) : null;
    const label = pres?.label ?? row.status ?? "unknown";
    const className = pres?.textClassName ?? "text-cc-fg/80";
    const entry = counts.get(label);
    if (entry) entry.count++;
    else counts.set(label, { count: 1, className });
  }
  const segments: BoardSummarySegment[] = [...counts.entries()].map(([label, { count, className }]) => ({
    text: `${count} ${label}`,
    className,
  }));
  if (completedCount > 0) segments.push({ text: `${completedCount} done`, className: "text-cc-muted" });
  return segments;
}

function workBoardExpandedKey(sessionId: string): string {
  return `cc-work-board-expanded:${sessionId}`;
}

function readExpandedState(sessionId: string): boolean {
  if (typeof window === "undefined") return false;
  return scopedGetItem(workBoardExpandedKey(sessionId)) === "1";
}

export function WorkBoardBar({ sessionId }: { sessionId: string }) {
  const board = useStore((s) => s.sessionBoards.get(sessionId));
  const completedBoard = useStore((s) => s.sessionCompletedBoards.get(sessionId));
  const isOrchestrator = useStore((s) =>
    s.sdkSessions.some((session) => session.sessionId === sessionId && session.isOrchestrator === true),
  );

  const [expanded, setExpanded] = useState(() => readExpandedState(sessionId));
  const [completedExpanded, setCompletedExpanded] = useState(false);

  useEffect(() => {
    setExpanded(readExpandedState(sessionId));
    setCompletedExpanded(false);
  }, [sessionId]);

  useEffect(() => {
    scopedSetItem(workBoardExpandedKey(sessionId), expanded ? "1" : "0");
  }, [sessionId, expanded]);

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
    <div className="shrink-0 flex flex-col min-h-0">
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
                <span className="text-[11px] text-cc-muted">{completedCount} completed</span>
              </button>
              {completedExpanded && (
                <div className="opacity-60">
                  <BoardTable board={completedBoard!} mode="completed" />
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

        {/* Summary text — each status segment gets its own color */}
        <span className="text-[11px] truncate flex-1 text-left">
          {boardSummary(board ?? [], completedCount).map((seg, i, arr) => (
            <span key={i}>
              <span className={seg.className}>{seg.text}</span>
              {i < arr.length - 1 && <span className="text-cc-fg/40">, </span>}
            </span>
          ))}
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
