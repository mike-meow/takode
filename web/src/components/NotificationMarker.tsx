import { useCallback } from "react";
import type { MouseEvent } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { runAfterNotificationOwnerThreadSelected } from "../utils/notification-thread.js";

/** Compact marker rendered inline for notification tool calls.
 *  When sessionId and messageId are provided, shows the checkbox affordance immediately
 *  and resolves the backing notification lazily for done-state toggles. */
export function NotificationMarker({
  category,
  summary,
  sessionId,
  messageId,
  notificationId,
  doneOverride,
  onToggleDone,
  showReplyAction = true,
  currentThreadKey,
  onSelectThread,
}: {
  category: "needs-input" | "review";
  summary?: string;
  sessionId?: string;
  messageId?: string;
  notificationId?: string;
  doneOverride?: boolean;
  onToggleDone?: () => void;
  showReplyAction?: boolean;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
}) {
  const isAction = category === "needs-input";
  const label = summary || (isAction ? "Needs input" : "Ready for review");

  // Find the matching notification in the store to enable interactive controls
  const notif = useStore((s) => {
    if (!sessionId) return null;
    const notifications = s.sessionNotifications?.get(sessionId);
    if (!notifications) return null;
    if (notificationId) return notifications.find((n) => n.id === notificationId && n.category === category) ?? null;
    if (!messageId) return null;
    return notifications.find((n) => n.messageId === messageId && n.category === category) ?? null;
  });

  const canToggleDone = !!onToggleDone || (!!sessionId && (!!messageId || !!notificationId));
  const isDone = doneOverride ?? notif?.done ?? false;
  const isToggleReady = !!onToggleDone || !!notif;
  const suggestedAnswers = isAction && !isDone ? (notif?.suggestedAnswers ?? []) : [];
  const showReplyButton = !!showReplyAction && !!notif && !!sessionId && (!isAction || !isDone);
  const toggleLabel =
    category === "review"
      ? isDone
        ? "Mark as not reviewed"
        : "Mark as reviewed"
      : isDone
        ? "Mark unhandled"
        : "Mark handled";

  const toggleDone = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (onToggleDone) {
        onToggleDone();
        return;
      }
      if (!sessionId) return;
      const liveNotif =
        notif ??
        useStore
          .getState()
          .sessionNotifications.get(sessionId)
          ?.find((n) =>
            notificationId
              ? n.id === notificationId && n.category === category
              : n.messageId === messageId && n.category === category,
          ) ??
        null;
      if (!liveNotif) return;
      api.markNotificationDone(sessionId, liveNotif.id, !liveNotif.done).catch(() => {});
    },
    [sessionId, messageId, notificationId, category, onToggleDone, notif],
  );

  const handleReply = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (!sessionId) return;
      const previewText = label;
      const liveNotif =
        notif ??
        (messageId
          ? (useStore
              .getState()
              .sessionNotifications.get(sessionId)
              ?.find((n) => n.messageId === messageId && n.category === category) ?? null)
          : null);
      runAfterNotificationOwnerThreadSelected({
        notification: liveNotif,
        currentThreadKey,
        onSelectThread,
        action: () => {
          useStore.getState().setReplyContext(sessionId, {
            ...(messageId ? { messageId } : {}),
            ...(liveNotif ? { notificationId: liveNotif.id } : {}),
            previewText,
          });
          useStore.getState().focusComposer();
        },
      });
    },
    [sessionId, messageId, label, notif, category, currentThreadKey, onSelectThread],
  );

  const handleSuggestedAnswer = useCallback(
    (answer: string) => (e: MouseEvent) => {
      e.stopPropagation();
      if (!sessionId) return;
      const previewText = label;
      const current = useStore.getState().composerDrafts.get(sessionId);
      const liveNotif =
        notif ??
        (messageId
          ? (useStore
              .getState()
              .sessionNotifications.get(sessionId)
              ?.find((n) => n.messageId === messageId && n.category === category) ?? null)
          : null);
      runAfterNotificationOwnerThreadSelected({
        notification: liveNotif,
        currentThreadKey,
        onSelectThread,
        action: () => {
          useStore.getState().setReplyContext(sessionId, {
            ...(messageId ? { messageId } : {}),
            ...(liveNotif ? { notificationId: liveNotif.id } : {}),
            previewText,
          });
          useStore.getState().setComposerDraft(sessionId, { text: answer, images: current?.images ?? [] });
          useStore.getState().focusComposer();
        },
      });
    },
    [sessionId, messageId, label, notif, category, currentThreadKey, onSelectThread],
  );

  const replyButton = showReplyButton ? (
    <button
      onClick={handleReply}
      className={`shrink-0 cursor-pointer hover:opacity-80 transition-opacity ${
        suggestedAnswers.length > 0 ? "rounded border border-amber-400/20 px-1.5 py-0.5 text-[10px] text-amber-100" : ""
      }`}
      title={suggestedAnswers.length > 0 ? "Write a custom answer" : "Reply to this notification"}
      aria-label={suggestedAnswers.length > 0 ? "Custom answer" : "Reply to this notification"}
    >
      {suggestedAnswers.length > 0 ? (
        "Custom answer"
      ) : (
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
          <path d="M6.78 1.97a.75.75 0 010 1.06L3.81 6h6.44A4.75 4.75 0 0115 10.75v1.5a.75.75 0 01-1.5 0v-1.5a3.25 3.25 0 00-3.25-3.25H3.81l2.97 2.97a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" />
        </svg>
      )}
    </button>
  ) : null;

  return (
    <div
      className={`inline-flex max-w-full flex-col items-start gap-1 mt-2 px-2 py-0.5 rounded-xl text-[11px] font-medium border transition-opacity ${
        isDone
          ? "border-cc-border bg-cc-hover/30 text-cc-muted opacity-60"
          : isAction
            ? "border-amber-500/20 bg-amber-500/5 text-amber-400"
            : "border-emerald-500/20 bg-emerald-500/5 text-cc-muted"
      }`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {/* Checkbox (shown as soon as the marker has a message anchor) */}
        {canToggleDone && (
          <button
            onClick={toggleDone}
            className="shrink-0 cursor-pointer hover:opacity-80 transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
            title={isToggleReady ? toggleLabel : "Waiting for notification sync"}
            aria-label={toggleLabel}
            disabled={!isToggleReady}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
              {isDone ? (
                <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm11.354-1.646a.5.5 0 00-.708-.708L7 9.293 5.354 7.646a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z" />
              ) : (
                <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8z" />
              )}
            </svg>
          </button>
        )}

        {/* Bell icon (used for both categories) */}
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
          <path d="M8 1.5A3.5 3.5 0 004.5 5v2.5c0 .78-.26 1.54-.73 2.16L3 10.66V11.5h10v-.84l-.77-1A3.49 3.49 0 0111.5 7.5V5A3.5 3.5 0 008 1.5zM6.5 13a1.5 1.5 0 003 0h-3z" />
        </svg>

        {/* Label */}
        <span className={`min-w-0 ${isDone ? "line-through" : ""}`}>{label}</span>

        {suggestedAnswers.length === 0 && replyButton}
      </div>

      {suggestedAnswers.length > 0 && (
        <div
          className="flex w-full max-w-full flex-col items-stretch gap-1 pl-5"
          data-testid="notification-answer-actions"
        >
          {suggestedAnswers.map((answer) => (
            <button
              key={answer}
              onClick={handleSuggestedAnswer(answer)}
              className="w-full min-w-0 whitespace-normal break-words rounded border border-amber-400/25 bg-amber-400/10 px-1.5 py-1 text-left text-[10px] leading-snug text-amber-200 transition-colors hover:bg-amber-400/20 cursor-pointer"
              title={`Use suggested answer: ${answer}`}
              aria-label={`Use suggested answer: ${answer}`}
            >
              {answer}
            </button>
          ))}
          {replyButton}
        </div>
      )}
    </div>
  );
}
