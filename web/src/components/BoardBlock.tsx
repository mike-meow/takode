import { useState, useRef, useCallback, useEffect, memo } from "react";
import { CollapseFooter } from "./CollapseFooter.js";
import { useStore } from "../store.js";
import { BoardTable } from "./BoardTable.js";

// Re-export for backward compatibility (ToolBlock imports BoardRowData from here)
export type { BoardRowData } from "./BoardTable.js";
import type { BoardRowData } from "./BoardTable.js";

interface BoardBlockProps {
  board: BoardRowData[];
  operation?: string;
  toolUseId?: string;
  sessionId?: string;
}

/**
 * Collapsible card that renders the leader's work board inline in the chat feed.
 * Displayed when a `takode board` CLI command produces output containing
 * `__takode_board__: true` in the Bash tool result.
 *
 * Auto-collapse: when a new board renders, it registers as the latest via Zustand.
 * All BoardBlock instances subscribe to the latest ID -- non-latest boards collapse.
 */
export const BoardBlock = memo(function BoardBlock({ board, operation, toolUseId, sessionId }: BoardBlockProps) {
  // Subscribe to the latest board ID for this session via Zustand (reactive)
  const latestId = useStore((s) => (sessionId ? s.latestBoardToolUseId.get(sessionId) : undefined));
  const setLatest = useStore((s) => s.setLatestBoardToolUseId);

  // Determine if this board is the latest (should be expanded)
  const isLatest = !toolUseId || !latestId || toolUseId === latestId;

  // Track whether the user has manually toggled this board
  const userToggled = useRef(false);
  const [open, setOpen] = useState(true);

  // Register as the latest board on mount
  useEffect(() => {
    if (toolUseId && sessionId) {
      setLatest(sessionId, toolUseId);
    }
  }, [toolUseId, sessionId, setLatest]);

  // Auto-collapse when a newer board takes over (unless user manually toggled)
  useEffect(() => {
    if (!userToggled.current) {
      setOpen(isLatest);
    }
  }, [isLatest]);

  const handleToggle = useCallback(() => {
    userToggled.current = true;
    setOpen((prev) => !prev);
  }, []);

  const headerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <button
        ref={headerRef}
        onClick={handleToggle}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        {/* Kanban board icon */}
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-blue-400 shrink-0">
          <path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11z" />
          <path d="M4 4h2v5H4zM7 4h2v7H7zM10 4h2v3h-2z" />
        </svg>
        <span className="text-xs font-medium text-cc-fg">Work Board</span>
        {operation && <span className="text-xs text-cc-muted">-- {operation}</span>}
        <span className="text-xs text-cc-muted ml-auto">
          {board.length} {board.length === 1 ? "item" : "items"}
        </span>
      </button>

      {open && (
        <div className="border-t border-cc-border">
          <BoardTable board={board} />
          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
});
