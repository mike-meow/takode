import { useState, useRef, useCallback, memo } from "react";
import { CollapseFooter } from "./CollapseFooter.js";
import { navigateTo } from "../utils/navigation.js";
import { navigateToSession } from "../utils/routing.js";

/** A row in the leader's work board (matches server BoardRow). */
export interface BoardRowData {
  questId: string;
  title?: string;
  worker?: string;
  workerNum?: number;
  status?: string;
  updatedAt: number;
}

/** Clickable quest ID link -- navigates to Questmaster detail view. */
function QuestLink({ questId }: { questId: string }) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigateTo(`/questmaster?quest=${encodeURIComponent(questId)}`);
    },
    [questId],
  );
  return (
    <button
      type="button"
      onClick={handleClick}
      className="font-mono-code text-blue-400 hover:text-blue-300 hover:underline cursor-pointer transition-colors"
    >
      {questId}
    </button>
  );
}

/** Clickable worker session link -- navigates to the worker session. */
function WorkerLink({ sessionId, sessionNum }: { sessionId: string; sessionNum?: number }) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      navigateToSession(sessionId);
    },
    [sessionId],
  );
  return (
    <button
      type="button"
      onClick={handleClick}
      className="font-mono-code text-green-400 hover:text-green-300 hover:underline cursor-pointer transition-colors"
    >
      #{sessionNum ?? "?"}
    </button>
  );
}

/**
 * Collapsible card that renders the leader's work board.
 * Displayed when a `takode board` CLI command produces output containing
 * `__takode_board__: true` in the Bash tool result.
 */
export const BoardBlock = memo(function BoardBlock({ board }: { board: BoardRowData[] }) {
  const [open, setOpen] = useState(true);
  const headerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <button
        ref={headerRef}
        onClick={() => setOpen(!open)}
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
        <span className="text-xs text-cc-muted ml-auto">
          {board.length} {board.length === 1 ? "item" : "items"}
        </span>
      </button>

      {open && (
        <div className="border-t border-cc-border">
          {board.length === 0 ? (
            <div className="px-3 py-3 text-xs text-cc-muted italic">Board is empty</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-cc-muted border-b border-cc-border">
                    <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Quest</th>
                    <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Title</th>
                    <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Worker</th>
                    <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((row) => (
                    <tr key={row.questId} className="border-b border-cc-border last:border-0 hover:bg-cc-hover/30">
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <QuestLink questId={row.questId} />
                      </td>
                      <td className="px-3 py-1.5 text-cc-fg max-w-[200px] truncate">
                        {row.title || "\u2014"}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {row.worker ? (
                          <WorkerLink sessionId={row.worker} sessionNum={row.workerNum} />
                        ) : (
                          <span className="text-cc-muted">{"\u2014"}</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-cc-muted max-w-[250px] truncate">
                        {row.status || "\u2014"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <CollapseFooter headerRef={headerRef} onCollapse={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
});
