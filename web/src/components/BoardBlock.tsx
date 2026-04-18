import { useState, useRef, useCallback, useEffect, memo } from "react";
import { CollapseFooter } from "./CollapseFooter.js";
import { useStore } from "../store.js";
import { BoardTable } from "./BoardTable.js";
import { ToolBlock } from "./ToolBlock.js";
import { formatQuestJourneyText } from "../../shared/quest-journey.js";

// Re-export for backward compatibility (ToolBlock imports BoardRowData from here)
export type { BoardRowData } from "./BoardTable.js";
import type { BoardRowData } from "./BoardTable.js";

interface BoardBlockProps {
  board: BoardRowData[];
  operation?: string;
  toolUseId?: string;
  sessionId?: string;
  originalCommand?: string;
  originalToolName?: string;
  originalInput?: Record<string, unknown>;
  defaultShowOriginalCommand?: boolean;
}

/**
 * Collapsible card that renders the leader's work board inline in the chat feed.
 * Displayed when a `takode board` CLI command produces output containing
 * `__takode_board__: true` in the Bash tool result.
 *
 * Auto-collapse: when a new board renders, it registers as the latest via Zustand.
 * All BoardBlock instances subscribe to the latest ID -- non-latest boards collapse.
 */
export const BoardBlock = memo(function BoardBlock({
  board,
  operation,
  toolUseId,
  sessionId,
  originalCommand,
  originalToolName,
  originalInput,
  defaultShowOriginalCommand = false,
}: BoardBlockProps) {
  // Subscribe to the latest board ID for this session via Zustand (reactive)
  const latestId = useStore((s) => (sessionId ? s.latestBoardToolUseId.get(sessionId) : undefined));
  const setLatest = useStore((s) => s.setLatestBoardToolUseId);

  // Determine if this board is the latest (should be expanded)
  const isLatest = !toolUseId || !latestId || toolUseId === latestId;

  // Track whether the user has manually toggled this board
  const userToggled = useRef(false);
  const [open, setOpen] = useState(true);
  const [showOriginalCommand, setShowOriginalCommand] = useState(defaultShowOriginalCommand);
  const canShowOriginalCommand = !!originalToolName && !!originalInput && !!toolUseId && !!sessionId;

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

  const handleOriginalCommandToggle = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    setOpen(true);
    setShowOriginalCommand((prev) => !prev);
  }, []);

  const headerRef = useRef<HTMLDivElement>(null);
  const formattedOperation = operation ? formatQuestJourneyText(operation) : undefined;

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <div
        ref={headerRef}
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggle();
          }
        }}
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
        {formattedOperation && <span className="text-xs text-cc-muted">-- {formattedOperation}</span>}
        {canShowOriginalCommand && (
          <span
            role="button"
            tabIndex={0}
            onClick={handleOriginalCommandToggle}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(true);
                setShowOriginalCommand((prev) => !prev);
              }
            }}
            className="ml-1.5 shrink-0 px-0.5 py-0.5 text-[10px] leading-none text-cc-muted/55 hover:text-cc-muted focus-visible:text-cc-muted transition-colors"
            title={originalCommand ? `Original command: ${originalCommand}` : "Show raw command output"}
          >
            {showOriginalCommand ? "hide raw" : "raw"}
          </span>
        )}
        <span className="text-xs text-cc-muted ml-auto">
          {board.length} {board.length === 1 ? "item" : "items"}
        </span>
      </div>

      {open && (
        <div className="border-t border-cc-border">
          {showOriginalCommand && canShowOriginalCommand && (
            <div className="border-b border-cc-border px-3 py-3 bg-cc-bg/30">
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-cc-muted">
                Original command
              </div>
              <ToolBlock
                name={originalToolName}
                input={originalInput}
                toolUseId={toolUseId}
                sessionId={sessionId}
                defaultOpen
                disableInlineSpecialCases
              />
            </div>
          )}
          <BoardTable board={board} />
          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
});
