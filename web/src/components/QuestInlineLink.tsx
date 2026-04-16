import { useState, useRef, useMemo, useEffect, type MouseEvent, type ReactNode } from "react";
import { useStore } from "../store.js";
import { QuestHoverCard } from "./QuestHoverCard.js";
import { withQuestIdInHash } from "../utils/routing.js";

export function QuestInlineLink({
  questId,
  children,
  className = "text-cc-primary hover:underline",
  stopPropagation = false,
}: {
  questId: string;
  children?: ReactNode;
  className?: string;
  stopPropagation?: boolean;
}) {
  const quests = useStore((s) => s.quests);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    },
    [],
  );

  const quest = useMemo(
    () => quests.find((item) => item.questId.toLowerCase() === questId.toLowerCase()) ?? null,
    [questId, quests],
  );

  const questHash = withQuestIdInHash(window.location.hash, questId);

  function handleLinkMouseEnter(e: MouseEvent<HTMLAnchorElement>) {
    if (!quest) return;
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    setHoverRect(e.currentTarget.getBoundingClientRect());
  }

  function handleLinkMouseLeave() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    hideHoverTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  function handleHoverCardEnter() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
  }

  function handleHoverCardLeave() {
    setHoverRect(null);
  }

  return (
    <>
      <a
        href={questHash}
        onClick={(e) => {
          e.preventDefault();
          if (stopPropagation) e.stopPropagation();
          useStore.getState().openQuestOverlay(questId);
        }}
        onMouseEnter={handleLinkMouseEnter}
        onMouseLeave={handleLinkMouseLeave}
        className={className}
        title={`Open ${questId}`}
      >
        {children ?? questId}
      </a>
      {quest && hoverRect && (
        <QuestHoverCard
          quest={quest}
          anchorRect={hoverRect}
          onMouseEnter={handleHoverCardEnter}
          onMouseLeave={handleHoverCardLeave}
        />
      )}
    </>
  );
}
