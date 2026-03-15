import { useState, useRef, useEffect } from "react";
import { useStore } from "../store.js";
import { TaskRow } from "./TaskPanel.js";

export function TodoStatusLine({ sessionId }: { sessionId: string }) {
  const tasks = useStore((s) => s.sessionTasks.get(sessionId));
  const [popoverOpen, setPopoverOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popoverOpen]);

  // Close popover on Escape
  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopoverOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [popoverOpen]);

  if (!tasks || tasks.length === 0) return null;

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const activeTask = tasks.find((t) => t.status === "in_progress");
  const pendingCount = tasks.filter((t) => t.status === "pending").length;

  // Hide when all completed
  if (completedCount >= tasks.length) return null;
  // Hide when no active task (nothing in progress)
  if (!activeTask) return null;

  return (
    <div ref={containerRef} className="shrink-0 flex flex-col min-h-0">
      {/* Expanded task list — inline, pushes chat content up */}
      {popoverOpen && (
        <div className="border-t border-cc-border bg-cc-card max-h-[40dvh] overflow-y-auto">
          <div className="px-3 py-2 border-b border-cc-border/50 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-cc-fg">Current To-Dos</span>
            <span className="text-[10px] text-cc-muted tabular-nums">
              {completedCount}/{tasks.length}
            </span>
          </div>
          <div className="px-1 py-1">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} sessionId={sessionId} />
            ))}
          </div>
        </div>
      )}

      {/* Main strip — click to toggle popover */}
      <button
        type="button"
        onClick={() => setPopoverOpen(!popoverOpen)}
        className="w-full flex items-center gap-2 px-3 sm:px-4 py-1.5 border-t border-cc-border bg-cc-card hover:bg-cc-hover/50 transition-colors cursor-pointer"
      >
        {/* Spinning indicator */}
        <svg className="w-3.5 h-3.5 text-cc-primary animate-spin shrink-0" viewBox="0 0 16 16" fill="none">
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

        {/* Active task text */}
        <span className="text-[11px] text-cc-fg/80 truncate flex-1 text-left">
          {activeTask.activeForm ?? activeTask.subject}
        </span>

        {/* Pending count */}
        {pendingCount > 0 && <span className="text-[10px] text-cc-muted shrink-0">+{pendingCount}</span>}

        {/* Progress fraction */}
        <span className="text-[10px] text-cc-muted shrink-0 tabular-nums">
          {completedCount}/{tasks.length}
        </span>

        {/* Chevron */}
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`w-3 h-3 text-cc-muted shrink-0 transition-transform duration-150 ${popoverOpen ? "rotate-180" : ""}`}
        >
          <path d="M3 5l3-3 3 3" />
        </svg>
      </button>
    </div>
  );
}
