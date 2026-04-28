import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { QuestInlineLink } from "./QuestInlineLink.js";
import type { SessionNotification } from "../types.js";

const EMPTY: SessionNotification[] = [];
type NotificationCategory = SessionNotification["category"];

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

function getNotificationBreakdown(notifications: ReadonlyArray<Pick<SessionNotification, "category">>) {
  let needsInput = 0;
  let review = 0;
  for (const notification of notifications) {
    if (notification.category === "needs-input") needsInput += 1;
    else if (notification.category === "review") review += 1;
  }
  return { needsInput, review };
}

function formatChipAriaLabel({ needsInput, review }: { needsInput: number; review: number }): string {
  const parts: string[] = [];
  if (needsInput > 0)
    parts.push(`${needsInput} ${needsInput === 1 ? "needs-input notification" : "needs-input notifications"}`);
  if (review > 0) parts.push(`${review} ${review === 1 ? "review notification" : "review notifications"}`);
  return `Notification inbox: ${parts.join(", ")}`;
}

function NotificationCountInline({ category, count }: { category: NotificationCategory; count: number }) {
  const isNeedsInput = category === "needs-input";
  const iconClassName = isNeedsInput ? "text-amber-400" : "text-blue-500";
  const label = isNeedsInput ? "Needs input" : "Review";

  return (
    <span
      data-testid={`notification-chip-${category}`}
      className="inline-flex items-center gap-1 whitespace-nowrap"
      aria-hidden="true"
      title={`${label}: ${count}`}
    >
      <span className="text-cc-fg/95">{count}</span>
      <svg
        className={`h-3.5 w-3.5 shrink-0 ${iconClassName}`}
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
  );
}

function parseSingleQuestSummary(summary?: string): { before: string; questId: string; after: string } | null {
  if (!summary) return null;
  const matches = Array.from(summary.matchAll(/\b(q-\d+)\b/gi));
  if (matches.length !== 1 || matches[0].index == null) return null;
  const questId = matches[0][1];
  const start = matches[0].index;
  const end = start + matches[0][0].length;
  return {
    before: summary.slice(0, start),
    questId,
    after: summary.slice(end),
  };
}

function getCompactReviewSummary(
  summary?: string,
): { text: string; questSummary: { before: string; questId: string; after: string } | null } | null {
  if (!summary) return null;

  const singleQuestMatch = summary.match(/^\s*(q-\d+)\s+ready\s+for\s+review(?:\s*:\s*(.+?))?\s*$/i);
  if (singleQuestMatch) {
    const questId = singleQuestMatch[1];
    const title = singleQuestMatch[2]?.trim();
    return {
      text: title ? `${questId}: ${title}` : questId,
      questSummary: {
        before: "",
        questId,
        after: title ? `: ${title}` : "",
      },
    };
  }

  const multiQuestMatch = summary.match(/^\s*\d+\s+quests?\s+ready\s+for\s+review\s*:\s*(.+?)\s*$/i);
  if (multiQuestMatch) {
    return {
      text: multiQuestMatch[1].trim(),
      questSummary: null,
    };
  }

  return { text: summary, questSummary: parseSingleQuestSummary(summary) };
}

// ─── Notification Item ───────────────────────────────────────────────────────

function NotificationItem({ notif, sessionId }: { notif: SessionNotification; sessionId: string }) {
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

  const startReply = useCallback(
    (answer?: string) => (e: React.MouseEvent) => {
      e.stopPropagation();
      const store = useStore.getState();
      const current = store.composerDrafts.get(sessionId);
      store.setReplyContext(sessionId, {
        ...(notif.messageId ? { messageId: notif.messageId } : {}),
        notificationId: notif.id,
        previewText: notif.summary || "Needs your input",
      });
      if (answer !== undefined) {
        store.setComposerDraft(sessionId, { text: answer, images: current?.images ?? [] });
      }
      store.focusComposer();
    },
    [sessionId, notif.id, notif.messageId, notif.summary],
  );

  const isNeedsInput = notif.category === "needs-input";
  const suggestedAnswers = isNeedsInput && !notif.done ? (notif.suggestedAnswers ?? []) : [];
  const compactReviewSummary = !isNeedsInput ? getCompactReviewSummary(notif.summary) : null;
  const label = compactReviewSummary?.text || notif.summary || (isNeedsInput ? "Needs your input" : "Ready for review");
  const questSummary = compactReviewSummary?.questSummary ?? null;
  const labelClassName = notif.done ? "text-cc-muted/60 line-through" : "text-cc-fg/90";

  const renderLabel = () => {
    if (!questSummary) {
      return <span className={`block max-w-full truncate ${labelClassName}`}>{label}</span>;
    }

    return (
      <span className={`block max-w-full truncate ${labelClassName}`}>
        {questSummary.before}
        <QuestInlineLink
          questId={questSummary.questId}
          stopPropagation={true}
          className={`font-mono-code hover:underline ${notif.done ? "text-cc-muted/60" : "text-cc-primary"}`}
        >
          {questSummary.questId}
        </QuestInlineLink>
        {questSummary.after}
      </span>
    );
  };

  const handleJumpKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    jumpToMessage();
  };

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
            <div
              role="button"
              tabIndex={0}
              onClick={jumpToMessage}
              onKeyDown={handleJumpKeyDown}
              className="min-w-0 flex-1 cursor-pointer"
            >
              <div className="text-[12px] text-left">{renderLabel()}</div>
            </div>
          ) : (
            <div className="text-[12px] text-left">{renderLabel()}</div>
          )}
        </div>
        <div className="text-[10px] text-cc-muted/60 mt-0.5 pl-3">{formatRelativeTime(notif.timestamp)}</div>
        {isNeedsInput && !notif.done && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-3">
            {suggestedAnswers.map((answer) => (
              <button
                key={answer}
                type="button"
                onClick={startReply(answer)}
                className="max-w-full truncate rounded border border-amber-400/25 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:bg-amber-400/20 cursor-pointer"
                title={`Use suggested answer: ${answer}`}
              >
                {answer}
              </button>
            ))}
            <button
              type="button"
              onClick={startReply()}
              className="rounded border border-cc-border/60 px-2 py-0.5 text-[11px] text-cc-muted transition-colors hover:border-cc-primary/40 hover:text-cc-fg cursor-pointer"
            >
              {suggestedAnswers.length > 0 ? "Custom" : "Reply"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Notification Popover ────────────────────────────────────────────────────

function NotificationPopover({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { active, done } = useNotifications(sessionId);
  const questOverlayId = useStore((s) => s.questOverlayId);
  const [showDone, setShowDone] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const markAllRead = useCallback(() => {
    api.markAllNotificationsDone(sessionId).catch(() => {});
  }, [sessionId]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (questOverlayId) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  }, [onClose, questOverlayId]);

  // Click-outside to close (mousedown for early dismissal)
  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      if (questOverlayId) return;
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
  }, [onClose, questOverlayId]);

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed inset-x-3 bottom-14 z-50 flex max-h-[min(60vh,28rem)] flex-col overflow-hidden rounded-2xl border border-cc-border bg-cc-card/95 shadow-[0_25px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl sm:inset-x-auto sm:right-3 sm:w-80 sm:max-w-[calc(100vw-1.5rem)] sm:max-h-[50vh]"
      role="dialog"
      aria-label="Notification inbox"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-cc-border/50 shrink-0">
        <h2 className="text-[13px] font-medium text-cc-fg">
          Notifications
          {active.length > 0 && <span className="ml-1.5 text-[11px] text-cc-muted font-normal">({active.length})</span>}
        </h2>
        <div className="flex items-center gap-1.5">
          {active.length > 0 && (
            <button
              onClick={markAllRead}
              className="text-[11px] text-cc-primary hover:text-cc-primary-hover transition-colors px-1.5 py-0.5 cursor-pointer"
            >
              Read All
            </button>
          )}
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
  const { needsInput, review } = useMemo(() => getNotificationBreakdown(active), [active]);
  const ariaLabel = useMemo(() => formatChipAriaLabel({ needsInput, review }), [needsInput, review]);
  const visibleSegments = useMemo(
    () =>
      [
        review > 0 ? { category: "review" as const, count: review } : null,
        needsInput > 0 ? { category: "needs-input" as const, count: needsInput } : null,
      ].filter((segment): segment is { category: NotificationCategory; count: number } => segment !== null),
    [needsInput, review],
  );

  const toggle = useCallback(() => setOpen((p) => !p), []);
  const close = useCallback(() => setOpen(false), []);

  if (active.length === 0) return null;

  return (
    <>
      <button
        onClick={toggle}
        aria-label={ariaLabel}
        className="pointer-events-auto relative inline-flex max-w-[min(18rem,calc(100vw-2.75rem))] items-center gap-1 overflow-hidden rounded-[18px] border border-white/8 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-2.5 py-1 text-[11px] text-cc-muted font-mono-code shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-md cursor-pointer hover:border-white/15 transition-colors"
      >
        <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.10),transparent_55%)]" />
        <span className="relative inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
          {visibleSegments.map((segment, index) => (
            <span key={segment.category} className="inline-flex items-center gap-1">
              {index > 0 && <span className="text-cc-muted/70">,</span>}
              <NotificationCountInline category={segment.category} count={segment.count} />
            </span>
          ))}
          <span className="text-cc-muted/85">unreads</span>
        </span>
      </button>

      {open && <NotificationPopover sessionId={sessionId} onClose={close} />}
    </>
  );
}
