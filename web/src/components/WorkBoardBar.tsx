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
import type { CSSProperties } from "react";
import { useState, useEffect } from "react";
import { useStore } from "../store.js";
import {
  getQuestJourneyCurrentPhaseId,
  getQuestJourneyPhase,
  getQuestJourneyPresentation,
} from "../../shared/quest-journey.js";
import { BoardTable, orderBoardRows } from "./BoardTable.js";
import type { BoardRowData } from "./BoardTable.js";
import { scopedGetItem, scopedSetItem } from "../utils/scoped-storage.js";
import { isMainThreadKey } from "../utils/thread-projection.js";

export interface BoardSummarySegment {
  text: string;
  className: string;
  style?: CSSProperties;
}

/**
 * Build a compact status summary for the collapsed board bar.
 * Active phase colors come from phase metadata; non-phase statuses stay neutral.
 */
export function boardSummary(board: BoardRowData[], completedCount: number): BoardSummarySegment[] {
  if (board.length === 0 && completedCount === 0) return [{ text: "Empty", className: "text-cc-muted" }];
  const counts = new Map<string, { count: number; className: string; style?: CSSProperties }>();
  for (const row of orderBoardRows(board)) {
    const currentPhase = getQuestJourneyPhase(getQuestJourneyCurrentPhaseId(row.journey, row.status));
    const presentation = getQuestJourneyPresentation(row.status);
    const label = currentPhase?.label ?? presentation?.label ?? row.status ?? "unknown";
    const className = currentPhase ? "text-cc-fg" : presentation ? "text-cc-muted" : "text-cc-fg/80";
    const style = currentPhase ? { color: currentPhase.color.accent } : undefined;
    const entry = counts.get(label);
    if (entry) entry.count++;
    else counts.set(label, { count: 1, className, style });
  }
  const segments: BoardSummarySegment[] = [...counts.entries()].map(([label, { count, className, style }]) => ({
    text: `${count} ${label}`,
    className,
    ...(style ? { style } : {}),
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

export function WorkBoardBar({
  sessionId,
  currentThreadKey = "main",
  currentThreadLabel = "Main",
  onReturnToMain,
}: {
  sessionId: string;
  currentThreadKey?: string;
  currentThreadLabel?: string;
  onReturnToMain?: () => void;
}) {
  const board = useStore((s) => s.sessionBoards.get(sessionId));
  const rowSessionStatuses = useStore((s) => s.sessionBoardRowStatuses.get(sessionId));
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
  const showReturnToMain = !isMainThreadKey(currentThreadKey) && !!onReturnToMain;

  // Only show for orchestrator sessions with a non-empty board (active or completed)
  if (!isOrchestrator || (activeCount === 0 && completedCount === 0)) return null;

  return (
    <div className="shrink-0 flex flex-col min-h-0">
      {/* Expanded board table -- inline, pushes chat content up */}
      {expanded && (
        <div className="border-t border-cc-border bg-cc-card max-h-[40dvh] overflow-y-auto">
          {activeCount > 0 && <BoardTable board={board!} rowSessionStatuses={rowSessionStatuses} />}
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
                  <BoardTable board={completedBoard!} mode="completed" rowSessionStatuses={rowSessionStatuses} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Summary bar -- click the board area to toggle expanded */}
      <div className="flex items-stretch border-t border-cc-border bg-cc-card">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-cc-hover/50 sm:px-4"
          data-testid="workboard-summary-button"
        >
          {/* Kanban board icon */}
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-blue-400 shrink-0">
            <path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11z" />
            <path d="M4 4h2v5H4zM7 4h2v7H7zM10 4h2v3h-2z" />
          </svg>

          {/* Summary text — each status segment gets its own color */}
          <span className="min-w-0 flex-1 truncate text-[11px]">
            {boardSummary(board ?? [], completedCount).map((seg, i, arr) => (
              <span key={i}>
                <span className={seg.className} style={seg.style}>
                  {seg.text}
                </span>
                {i < arr.length - 1 && <span className="text-cc-fg/40">, </span>}
              </span>
            ))}
          </span>

          <span
            className="hidden max-w-[9rem] shrink-0 truncate rounded border border-cc-border/70 bg-cc-hover/45 px-1.5 py-0.5 text-[10px] font-medium text-cc-muted sm:inline"
            title={currentThreadLabel}
            data-testid="workboard-current-thread"
          >
            {currentThreadLabel}
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
        {showReturnToMain && (
          <button
            type="button"
            onClick={onReturnToMain}
            className="flex shrink-0 items-center justify-center border-l border-cc-border/70 px-3 text-cc-muted transition-colors hover:bg-cc-hover/60 hover:text-cc-fg"
            title="Return to Main"
            aria-label="Return to Main"
            data-testid="workboard-return-main"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
