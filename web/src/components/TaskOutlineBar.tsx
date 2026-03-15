import { useRef, useState, useEffect } from "react";
import { useStore } from "../store.js";

export function TaskOutlineBar({ sessionId }: { sessionId: string }) {
  const taskHistory = useStore((s) => s.sessionTaskHistory.get(sessionId));
  const requestScrollToTurn = useStore((s) => s.requestScrollToTurn);
  const activeTaskTurnId = useStore((s) => s.activeTaskTurnId.get(sessionId));
  const session = useStore((s) => s.sessions.get(sessionId));
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
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
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

  if (!taskHistory || taskHistory.length === 0) return null;

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

      <div ref={scrollRef} className="flex gap-1.5 px-3 py-1.5 overflow-x-auto scrollbar-hide">
        {taskHistory?.map((task, i) => {
          const isScrollActive = task.triggerMessageId === activeTaskTurnId;
          const isQuest = task.source === "quest";
          // Quest pills should only highlight as active when the quest is
          // still in_progress for this session. Once a quest transitions to
          // needs_verification/done (or the session moves to a different
          // quest), the pill should appear inactive so the timeline doesn't
          // show stale "active" quests.
          const isQuestStale =
            isQuest && (session?.claimedQuestId !== task.questId || session?.claimedQuestStatus !== "in_progress");
          const isActive = isScrollActive && !isQuestStale;
          return (
            <button
              key={`${task.triggerMessageId}-${i}`}
              ref={isActive ? activeChipRef : undefined}
              type="button"
              onClick={() => requestScrollToTurn(sessionId, task.triggerMessageId)}
              className={`shrink-0 text-[11px] px-2.5 py-1 rounded-full transition-colors cursor-pointer truncate max-w-[200px] ${
                isActive
                  ? isQuest
                    ? "bg-amber-500/15 text-amber-400 font-medium"
                    : "bg-cc-primary/15 text-cc-primary font-medium"
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
