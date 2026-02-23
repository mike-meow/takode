import { useRef, useState, useEffect } from "react";
import { useStore } from "../store.js";

export function TaskOutlineBar({ sessionId }: { sessionId: string }) {
  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const requestScrollToTurn = useStore((s) => s.requestScrollToTurn);
  const activeTaskTurnId = useStore((s) => s.activeTaskTurnId.get(sessionId));
  const session = useStore((s) => s.sessions.get(sessionId));
  const claimedQuestId = session?.claimedQuestId;
  const claimedQuestTitle = session?.claimedQuestTitle;
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeChipRef = useRef<HTMLButtonElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Track scroll overflow state for fade indicators
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      setCanScrollLeft(el.scrollLeft > 2);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", check); ro.disconnect(); };
  }, [taskHistory]);

  // Auto-scroll the active chip into view within the horizontal scroll container
  useEffect(() => {
    const chip = activeChipRef.current;
    const container = scrollRef.current;
    if (!chip || !container) return;
    const chipRect = chip.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (chipRect.left < containerRect.left || chipRect.right > containerRect.right) {
      chip.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [activeTaskTurnId]);

  if ((!taskHistory || taskHistory.length === 0) && !claimedQuestId) return null;

  return (
    <div className="shrink-0 relative border-b border-cc-border bg-cc-card">
      {/* Left fade */}
      {canScrollLeft && (
        <div className="absolute left-0 top-0 bottom-0 w-6 bg-gradient-to-r from-cc-card to-transparent z-10 pointer-events-none" />
      )}
      {/* Right fade */}
      {canScrollRight && (
        <div className="absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-cc-card to-transparent z-10 pointer-events-none" />
      )}

      <div
        ref={scrollRef}
        className="flex gap-1.5 px-3 py-1.5 overflow-x-auto scrollbar-hide"
      >
        {claimedQuestId && claimedQuestTitle && (
          <a
            href="#/questmaster"
            className="shrink-0 text-[11px] px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-400 font-medium truncate max-w-[220px] flex items-center gap-1 hover:bg-amber-500/25 transition-colors"
            title={`Quest: ${claimedQuestTitle}`}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
              <path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM4 5.75a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 014 5.75z" />
            </svg>
            {claimedQuestTitle}
          </a>
        )}
        {taskHistory?.map((task, i) => {
          const isActive = task.triggerMessageId === activeTaskTurnId;
          const isQuest = task.source === "quest";
          return (
            <button
              key={`${task.triggerMessageId}-${i}`}
              ref={isActive ? activeChipRef : undefined}
              type="button"
              onClick={() => requestScrollToTurn(sessionId, task.triggerMessageId)}
              className={`shrink-0 text-[11px] px-2.5 py-1 rounded-full transition-colors cursor-pointer truncate max-w-[200px] ${
                isQuest
                  ? "bg-amber-500/15 text-amber-400 font-medium"
                  : isActive
                    ? "bg-cc-primary/15 text-cc-primary font-medium"
                    : "bg-cc-hover/60 hover:bg-cc-border text-cc-fg/70 hover:text-cc-fg"
              }`}
              title={task.title}
            >
              {task.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}
