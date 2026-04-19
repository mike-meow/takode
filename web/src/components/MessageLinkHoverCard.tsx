import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import type { ChatMessage } from "../types.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { MessageBubble } from "./MessageBubble.js";
import { HidePawContext } from "./PawTrail.js";
import { useStore } from "../store.js";

interface MessageLinkHoverCardProps {
  session: SessionItemType;
  sessionName?: string;
  anchorRect: DOMRect;
  messageIndex: number;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  prefetchedMessage?: ChatMessage | null;
}

export function MessageLinkHoverCard({
  session,
  sessionName,
  anchorRect,
  messageIndex,
  onMouseEnter,
  onMouseLeave,
  prefetchedMessage,
}: MessageLinkHoverCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const fetchedKeyRef = useRef<string | null>(null);
  const [message, setMessage] = useState<ChatMessage | null>(prefetchedMessage ?? null);
  const [loading, setLoading] = useState(prefetchedMessage === undefined);
  const zoomLevel = useStore((state) => state.zoomLevel ?? 1);

  useEffect(() => {
    if (prefetchedMessage !== undefined) {
      setMessage(prefetchedMessage);
      setLoading(false);
      fetchedKeyRef.current = null;
      return;
    }

    const cacheKey = `${session.id}:${messageIndex}`;
    if (fetchedKeyRef.current === cacheKey) return;
    fetchedKeyRef.current = cacheKey;

    let cancelled = false;
    setLoading(true);
    setMessage(null);

    api
      .fetchMessagePreview(session.id, messageIndex)
      .then((result) => {
        if (cancelled) return;
        setMessage(result);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMessage(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [messageIndex, prefetchedMessage, session.id]);

  const headerLabel = useMemo(
    () => sessionName || (session.sessionNum != null ? `#${session.sessionNum}` : session.id.slice(0, 8)),
    [session.id, session.sessionNum, sessionName],
  );
  const statusLabel = session.archived
    ? "archived"
    : session.status === "running"
      ? "running"
      : session.sdkState === "exited"
        ? "exited"
        : "idle";
  const statusDotClass = session.archived
    ? "bg-cc-muted/40"
    : session.status === "running"
      ? "bg-cc-success"
      : session.sdkState === "exited"
        ? "bg-cc-muted/40"
        : "bg-cc-success/60";

  const cardWidth = 460;
  const gap = 4;
  const left = anchorRect.right + gap;
  const top = anchorRect.top;

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const el = cardRef.current;

    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${anchorRect.left - cardWidth - gap}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
    if (rect.top < 8) {
      el.style.top = "8px";
    }
  }, [anchorRect]);

  return createPortal(
    <div
      ref={cardRef}
      className="fixed z-50 pointer-events-auto hidden-on-touch"
      style={{ left, top, width: cardWidth, transform: `scale(${zoomLevel})`, transformOrigin: "top left" }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-testid="message-link-hover-card"
    >
      <div className="overflow-hidden rounded-xl border border-cc-border bg-cc-card shadow-xl">
        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-[14px] font-semibold leading-snug text-cc-fg">{headerLabel}</span>
                {session.sessionNum != null && (
                  <span className="shrink-0 text-[10px] font-mono text-cc-muted/60">#{session.sessionNum}</span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-cc-muted">Message {messageIndex}</div>
            </div>
            <span className="flex shrink-0 items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${statusDotClass}`} />
              <span className="text-[11px] text-cc-muted">{statusLabel}</span>
            </span>
          </div>
        </div>

        <div className="border-t border-cc-border/50 px-3 py-3">
          {loading ? (
            <div className="px-2 py-4 text-[12px] italic text-cc-muted/70">Loading message…</div>
          ) : message ? (
            <div
              data-testid="message-link-hover-body"
              className="max-h-[360px] overflow-y-auto pr-1"
              style={{ scrollbarGutter: "stable both-edges" }}
            >
              <HidePawContext.Provider value={true}>
                <MessageBubble message={message} sessionId={session.id} showTimestamp={false} />
              </HidePawContext.Provider>
            </div>
          ) : (
            <div className="px-2 py-4 text-[12px] italic text-cc-muted/70">Message unavailable.</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
