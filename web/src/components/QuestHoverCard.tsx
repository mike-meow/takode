import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { QuestmasterTask } from "../types.js";
import { getQuestStatusTheme } from "../utils/quest-status-theme.js";
import { useStore } from "../store.js";
import { SessionInlineLink } from "./SessionInlineLink.js";

interface QuestHoverCardProps {
  quest: QuestmasterTask;
  anchorRect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function QuestHoverCard({ quest, anchorRect, onMouseEnter, onMouseLeave }: QuestHoverCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const statusTheme = getQuestStatusTheme(quest.status);
  const zoomLevel = useStore((state) => state.zoomLevel ?? 1);
  const sessionName = useStore((state) =>
    "sessionId" in quest && quest.sessionId ? state.sessionNames.get(quest.sessionId) : undefined,
  );
  const sessionNum = useStore((state) =>
    "sessionId" in quest && quest.sessionId
      ? (state.sdkSessions.find((session) => session.sessionId === quest.sessionId)?.sessionNum ?? null)
      : null,
  );

  const cardWidth = 300;
  const gap = 6;
  const left = anchorRect.left;
  const top = anchorRect.bottom + gap;

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const el = cardRef.current;

    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${Math.max(8, window.innerWidth - cardWidth - 8)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = `${Math.max(8, anchorRect.top - rect.height - gap)}px`;
    }
    if (rect.top < 8) {
      el.style.top = "8px";
    }
  }, [anchorRect, cardWidth]);

  return createPortal(
    <div
      ref={cardRef}
      className="fixed z-50 pointer-events-auto hidden-on-touch"
      style={{ left, top, width: cardWidth, transform: `scale(${zoomLevel})`, transformOrigin: "top left" }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="bg-cc-card border border-cc-border rounded-xl shadow-xl px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] text-cc-muted">{quest.questId}</div>
            <div className="text-sm font-semibold text-cc-fg leading-snug break-words">{quest.title}</div>
          </div>
          <span
            className={`shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${statusTheme.bg} ${statusTheme.text} ${statusTheme.border}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${statusTheme.dot}`} />
            {statusTheme.label}
          </span>
        </div>
        {quest.tags && quest.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {quest.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted border border-cc-border"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        {"sessionId" in quest && quest.sessionId && (
          <div data-testid="quest-hover-owner-session" className="mt-2 pt-2 border-t border-cc-border/50">
            <div className="text-[10px] uppercase tracking-wider text-cc-muted/60">Owner session</div>
            <div className="mt-1 flex items-center gap-2 min-w-0 flex-wrap">
              <SessionInlineLink
                sessionId={quest.sessionId}
                sessionNum={sessionNum}
                className="inline-flex items-center rounded-full border border-cc-primary/15 bg-cc-primary/10 px-2 py-0.5 text-[11px] font-medium text-cc-primary transition-colors hover:bg-cc-primary/20"
              >
                {sessionNum != null ? `#${sessionNum}` : quest.sessionId.slice(0, 8)}
              </SessionInlineLink>
              {sessionName && <span className="min-w-0 truncate text-[11px] text-cc-muted">{sessionName}</span>}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
