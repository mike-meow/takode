import { useState, useCallback, useEffect, useMemo, useRef, useLayoutEffect, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { SessionNotification, ChatMessage } from "../types.js";

const EMPTY: SessionNotification[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];

function useNotifications(sessionId: string) {
  const all = useStore((s) => s.sessionNotifications?.get(sessionId)) ?? EMPTY;
  const active = useMemo(() => all.filter((n) => !n.done), [all]);
  const done = useMemo(() => all.filter((n) => n.done), [all]);
  return { all, active, done };
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function truncateContent(msg: ChatMessage, maxLen = 100): string {
  const text = msg.content?.trim() || "";
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

// ─── Hover Preview Card ──────────────────────────────────────────────────────

/** Shows 1 message before + the linked message + 1 message after from the session history. */
function NotificationPreviewCard({
  messageId,
  sessionId,
  anchorRect,
  summary,
  onMouseEnter,
  onMouseLeave,
}: {
  messageId: string;
  sessionId: string;
  anchorRect: DOMRect;
  summary?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const messages = useStore((s) => s.messages.get(sessionId)) ?? EMPTY_MESSAGES;
  const zoomLevel = useStore((s) => s.zoomLevel ?? 1);

  const targetIdx = useMemo(() => messages.findIndex((m) => m.id === messageId), [messages, messageId]);
  const contextMessages = useMemo(() => {
    if (targetIdx < 0) return [];
    const start = Math.max(0, targetIdx - 1);
    const end = Math.min(messages.length, targetIdx + 2);
    return messages.slice(start, end).map((m) => ({ msg: m, isTarget: m.id === messageId }));
  }, [messages, targetIdx, messageId]);

  const cardWidth = 320;
  const gap = 6;
  // Position above the anchor element
  const left = anchorRect.left;
  const top = anchorRect.top - gap;

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const el = cardRef.current;
    // Flip above -> below if no space above
    if (rect.top < 8) {
      el.style.top = `${anchorRect.bottom + gap}px`;
    } else {
      el.style.top = `${anchorRect.top - rect.height - gap}px`;
    }
    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${Math.max(8, window.innerWidth - cardWidth - 8)}px`;
    }
  }, [anchorRect, cardWidth]);

  // Message not found in store -- show summary fallback if available, otherwise hide
  if (contextMessages.length === 0 && !summary) return null;

  const cardContent =
    contextMessages.length > 0 ? (
      <div className="bg-cc-card border border-cc-border rounded-xl shadow-xl overflow-hidden">
        {contextMessages.map(({ msg, isTarget }) => (
          <div
            key={msg.id}
            className={`px-3 py-2 border-b border-cc-border/20 last:border-b-0 ${isTarget ? "bg-amber-500/15" : ""}`}
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className={`text-[10px] font-medium ${msg.role === "user" ? "text-blue-400" : "text-emerald-400"}`}>
                {msg.role === "user" ? "You" : "Assistant"}
              </span>
            </div>
            <div className={`text-[11px] leading-relaxed ${isTarget ? "text-cc-fg" : "text-cc-muted"}`}>
              {truncateContent(msg)}
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div className="bg-cc-card border border-cc-border rounded-xl shadow-xl overflow-hidden px-3 py-2">
        <div className="text-[11px] leading-relaxed text-cc-muted">{summary}</div>
      </div>
    );

  return createPortal(
    <div
      ref={cardRef}
      className="fixed z-50 pointer-events-auto hidden-on-touch"
      style={{ left, top, width: cardWidth, transform: `scale(${zoomLevel})`, transformOrigin: "bottom left" }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {cardContent}
    </div>,
    document.body,
  );
}

// ─── Notification Item ───────────────────────────────────────────────────────

function NotificationItem({
  notif,
  sessionId,
}: {
  notif: SessionNotification;
  sessionId: string;
}) {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const toggleDone = useCallback(() => {
    api.markNotificationDone(sessionId, notif.id, !notif.done).catch(() => {});
  }, [sessionId, notif.id, notif.done]);

  const jumpToMessage = useCallback(() => {
    if (!notif.messageId) return;
    const store = useStore.getState();
    store.requestScrollToMessage(sessionId, notif.messageId);
    store.setExpandAllInTurn(sessionId, notif.messageId);
    // Don't close panel -- user may want to click multiple notifications
  }, [sessionId, notif.messageId]);

  function handleMouseEnter(e: MouseEvent<HTMLButtonElement>) {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setHoverRect(e.currentTarget.getBoundingClientRect());
  }

  function handleMouseLeave() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  function handleCardEnter() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }

  function handleCardLeave() {
    setHoverRect(null);
  }

  const isNeedsInput = notif.category === "needs-input";
  const label = notif.summary || (isNeedsInput ? "Needs your input" : "Ready for review");

  return (
    <div className="flex items-start gap-2 px-3 py-2 hover:bg-cc-hover/40 transition-colors group">
      {/* Checkbox */}
      <button
        onClick={toggleDone}
        className="mt-0.5 shrink-0 w-4 h-4 rounded border border-cc-border/60 flex items-center justify-center cursor-pointer hover:border-cc-primary/50 transition-colors"
        aria-label={notif.done ? "Mark as active" : "Mark as done"}
      >
        {notif.done && (
          <svg
            className="w-3 h-3 text-cc-primary"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.5 8.5l3 3 6-6" />
          </svg>
        )}
      </button>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${isNeedsInput ? "bg-amber-400" : "bg-emerald-400"}`}
          />
          {notif.messageId ? (
            <button
              onClick={jumpToMessage}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              className={`text-[12px] text-left truncate max-w-[240px] cursor-pointer hover:underline ${notif.done ? "text-cc-muted/60 line-through" : "text-cc-fg/90"}`}
            >
              {label}
            </button>
          ) : (
            <span className={`text-[12px] truncate max-w-[240px] ${notif.done ? "text-cc-muted/60 line-through" : "text-cc-fg/90"}`}>
              {label}
            </span>
          )}
        </div>
        <div className="text-[10px] text-cc-muted/60 mt-0.5 pl-3">{formatRelativeTime(notif.timestamp)}</div>
      </div>

      {/* Hover preview card */}
      {notif.messageId && hoverRect && (
        <NotificationPreviewCard
          messageId={notif.messageId}
          sessionId={sessionId}
          anchorRect={hoverRect}
          summary={notif.summary}
          onMouseEnter={handleCardEnter}
          onMouseLeave={handleCardLeave}
        />
      )}
    </div>
  );
}

// ─── Notification Popover ────────────────────────────────────────────────────

function NotificationPopover({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { active, done } = useNotifications(sessionId);
  const [showDone, setShowDone] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  }, [onClose]);

  // Click-outside to close (mousedown for early dismissal)
  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Defer to avoid closing immediately from the chip click that opened this
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed bottom-14 right-3 z-50 w-80 max-w-[calc(100vw-1.5rem)] max-h-[50vh] flex flex-col rounded-2xl border border-cc-border bg-cc-card/95 shadow-[0_25px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl overflow-hidden"
      role="dialog"
      aria-label="Notification inbox"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-cc-border/50 shrink-0">
        <h2 className="text-[13px] font-medium text-cc-fg">
          Notifications
          {active.length > 0 && <span className="ml-1.5 text-[11px] text-cc-muted font-normal">({active.length})</span>}
        </h2>
        <button
          onClick={onClose}
          className="text-cc-muted hover:text-cc-fg transition-colors p-1 -mr-1 cursor-pointer"
          aria-label="Close"
        >
          <svg
            className="w-3.5 h-3.5"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Notification list */}
      <div className="overflow-y-auto flex-1">
        {active.length === 0 && done.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-cc-muted">No notifications</p>
        ) : (
          <>
            {active.length > 0 && (
              <div className="divide-y divide-cc-border/20">
                {[...active].reverse().map((n) => (
                  <NotificationItem key={n.id} notif={n} sessionId={sessionId} />
                ))}
              </div>
            )}

            {done.length > 0 && (
              <div className="border-t border-cc-border/30">
                <button
                  onClick={() => setShowDone((p) => !p)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-cc-muted/70 hover:text-cc-muted cursor-pointer transition-colors"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${showDone ? "rotate-90" : ""}`}
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path d="M6 4l4 4-4 4z" />
                  </svg>
                  Done ({done.length})
                </button>
                {showDone && (
                  <div className="divide-y divide-cc-border/10 opacity-60">
                    {[...done].reverse().map((n) => (
                      <NotificationItem key={n.id} notif={n} sessionId={sessionId} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─── Notification Chip (floating pill) ───────────────────────────────────────

/** Glassmorphic floating pill for notification inbox. Renders nothing when no active notifications exist. */
export function NotificationChip({ sessionId }: { sessionId: string }) {
  const { active } = useNotifications(sessionId);
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => setOpen((p) => !p), []);
  const close = useCallback(() => setOpen(false), []);

  if (active.length === 0) return null;

  return (
    <>
      <button
        onClick={toggle}
        className="pointer-events-auto relative inline-flex max-w-[min(18rem,calc(100vw-2.75rem))] items-center gap-1.5 overflow-hidden rounded-[18px] border border-white/8 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-2.5 py-1 text-[11px] text-cc-muted font-mono-code shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-md cursor-pointer hover:border-white/15 transition-colors"
      >
        <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.10),transparent_55%)]" />
        <span className="relative">
          <svg
            className="w-3.5 h-3.5"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 2.5-1.5 4-1.5 4h12s-1.5-1.5-1.5-4A4.5 4.5 0 0 0 8 1.5z" />
            <path d="M6 12a2 2 0 0 0 4 0" />
          </svg>
        </span>
        <span className="relative truncate text-cc-fg/90">
          {active.length} {active.length === 1 ? "notification" : "notifications"}
        </span>
      </button>

      {open && <NotificationPopover sessionId={sessionId} onClose={close} />}
    </>
  );
}
