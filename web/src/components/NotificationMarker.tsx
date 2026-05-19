import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { ChatMessage, SessionNotification } from "../types.js";
import { formatNeedsInputResponse, getNeedsInputQuestionViews } from "../utils/notification-questions.js";
import {
  isNotificationOwnerSelected,
  resolveNotificationOwnerThreadKey,
  runAfterNotificationOwnerThreadSelected,
} from "../utils/notification-thread.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY, normalizeThreadKey } from "../utils/thread-projection.js";
import { useVisibleReviewNotificationAutoResolve } from "../hooks/useVisibleReviewNotificationAutoResolve.js";
import { getNotificationSourceContext } from "../utils/notification-source-context.js";
import { NeedsInputAnswerField } from "./NeedsInputAnswerField.js";

const EMPTY_MESSAGES: ChatMessage[] = [];

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
  category: SessionNotification["category"];
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
  const isReview = category === "review";
  const label = summary || (isAction ? "Needs input" : isReview ? "Ready for review" : "Waiting");

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
  const showReplyButton = !!showReplyAction && !!notif && !!sessionId && (isAction ? !isDone : isReview);
  const questionViews = useMemo(
    () => (isAction && !isDone && notif ? getNeedsInputQuestionViews(notif) : []),
    [isAction, isDone, notif],
  );
  const messages = useStore((s) => (sessionId ? (s.messages?.get(sessionId) ?? EMPTY_MESSAGES) : EMPTY_MESSAGES));
  const sourceContext = useMemo(
    () => (notif ? getNotificationSourceContext(notif, messages, messageId) : null),
    [messageId, messages, notif],
  );
  const [answersByQuestion, setAnswersByQuestion] = useState<Record<string, string>>({});
  const canSendQuickReply =
    !!sessionId && !!notif && questionViews.length > 0 && questionViews.every((q) => answersByQuestion[q.key]?.trim());
  const markerRef = useVisibleReviewNotificationAutoResolve<HTMLDivElement>({ sessionId, notification: notif });

  useEffect(() => {
    setAnswersByQuestion({});
  }, [notif?.id, isDone]);
  const toggleLabel = isReview
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
        findNotification({
          sessionId,
          notificationId,
          messageId,
          category,
        });
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
    [sessionId, notificationId, messageId, label, notif, category, currentThreadKey, onSelectThread],
  );

  const handleSuggestedAnswer = useCallback(
    ({ questionKey, value }: { questionKey: string; value: string }) =>
      (e: MouseEvent) => {
        e.stopPropagation();
        setAnswersByQuestion((prev) => ({ ...prev, [questionKey]: value }));
      },
    [],
  );

  const sendQuickReply = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (!sessionId || !notif || !canSendQuickReply) return;
      runAfterNotificationOwnerThreadSelected({
        notification: notif,
        currentThreadKey,
        onSelectThread,
        action: () => {
          const threadKey = resolveNotificationOwnerThreadKey(notif);
          const content = formatNeedsInputResponse(notif.summary ?? summary, questionViews, answersByQuestion);
          api
            .sendNeedsInputResponse(sessionId, notif.id, {
              content,
              threadKey,
              ...(threadKey !== MAIN_THREAD_KEY ? { questId: notif.questId ?? threadKey } : {}),
            })
            .then(() => {
              useStore.getState().requestBottomAlignOnNextUserMessage?.(sessionId);
              setAnswersByQuestion({});
            })
            .catch(() => {});
        },
      });
    },
    [
      answersByQuestion,
      canSendQuickReply,
      currentThreadKey,
      messageId,
      notif,
      onSelectThread,
      questionViews,
      sessionId,
      summary,
    ],
  );

  const setQuestionAnswer = useCallback((questionKey: string, value: string) => {
    setAnswersByQuestion((prev) => ({ ...prev, [questionKey]: value }));
  }, []);

  const selectedThreadKey = currentThreadKey ? normalizeThreadKey(currentThreadKey) : undefined;
  if (
    isAction &&
    notif &&
    selectedThreadKey &&
    selectedThreadKey !== ALL_THREADS_KEY &&
    !isNotificationOwnerSelected(notif, selectedThreadKey)
  ) {
    return null;
  }

  const replyButton = showReplyButton ? (
    <button
      onClick={handleReply}
      className="shrink-0 cursor-pointer rounded border border-cc-border/50 p-1 text-cc-muted transition-colors hover:border-cc-primary/40 hover:text-cc-fg"
      title="reply in composer"
      aria-label="reply in composer"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
        <path d="M6.78 1.97a.75.75 0 010 1.06L3.81 6h6.44A4.75 4.75 0 0115 10.75v1.5a.75.75 0 01-1.5 0v-1.5a3.25 3.25 0 00-3.25-3.25H3.81l2.97 2.97a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z" />
      </svg>
    </button>
  ) : null;
  const voiceThreadKey = notif ? resolveNotificationOwnerThreadKey(notif) : MAIN_THREAD_KEY;
  const voiceThreadTitle = voiceThreadKey === MAIN_THREAD_KEY ? "Main Thread" : (notif?.questId ?? voiceThreadKey);

  return (
    <div
      ref={markerRef}
      className={`inline-flex max-w-full flex-col items-start gap-1 mt-2 px-2 py-0.5 rounded-xl text-[11px] font-medium border transition-opacity ${
        questionViews.length > 0 ? "w-full sm:w-[min(30rem,100%)]" : ""
      } ${
        isDone
          ? "border-cc-border bg-cc-hover/30 text-cc-muted opacity-60"
          : isAction
            ? "border-cc-attention-border bg-cc-attention-bg text-cc-attention"
            : isReview
              ? "border-emerald-500/20 bg-emerald-500/5 text-cc-muted"
              : "border-cc-border/60 bg-cc-hover/20 text-cc-muted"
      }`}
      data-notification-id={notif?.id ?? notificationId ?? ""}
      data-notification-category={category}
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

        {!isAction && replyButton}
      </div>

      {questionViews.length > 0 && (
        <div
          className="flex w-full max-w-full flex-col items-stretch gap-1 pl-5"
          data-testid="notification-answer-actions"
        >
          {questionViews.map((question, index) => (
            <div key={question.key} className="space-y-1.5" data-testid="notification-question-block">
              {questionViews.length > 1 && (
                <div className="text-[10px] leading-snug text-cc-attention">
                  <span className="text-cc-muted">{index + 1}. </span>
                  {question.prompt}
                </div>
              )}
              {question.suggestedAnswers.map((answer) => (
                <button
                  key={answer}
                  type="button"
                  onClick={handleSuggestedAnswer({ questionKey: question.key, value: answer })}
                  className="w-full min-w-0 whitespace-normal break-words rounded border border-cc-attention-border bg-cc-attention-bg px-1.5 py-1 text-left text-[10px] leading-snug text-cc-attention transition-colors hover:bg-cc-attention-bg/80 cursor-pointer"
                  title={`Use suggested answer: ${answer}`}
                  aria-label={`Use suggested answer: ${answer}`}
                >
                  {answer}
                </button>
              ))}
              {sessionId && notif && (
                <NeedsInputAnswerField
                  sessionId={sessionId}
                  notification={notif}
                  question={question}
                  questionCount={questionViews.length}
                  value={answersByQuestion[question.key] ?? ""}
                  onChange={(value) => setQuestionAnswer(question.key, value)}
                  placeholder="Your answer"
                  sourceContext={sourceContext}
                  threadKey={voiceThreadKey}
                  threadTitle={voiceThreadTitle}
                  className="w-full min-w-0"
                  textareaClassName="border-cc-attention-border px-1.5 py-1 text-[11px] text-cc-fg"
                />
              )}
              {questionViews.length === 1 && (
                <div className="flex flex-wrap items-center gap-1 pt-0.5" data-testid="notification-answer-footer">
                  <button
                    type="button"
                    onClick={sendQuickReply}
                    disabled={!canSendQuickReply}
                    className="rounded border border-cc-attention-border bg-cc-attention-bg px-2 py-1 text-[11px] text-cc-attention transition-colors hover:bg-cc-attention-bg/80 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
                  >
                    Reply
                  </button>
                  {replyButton}
                </div>
              )}
            </div>
          ))}
          {questionViews.length > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={sendQuickReply}
                disabled={!canSendQuickReply}
                className="rounded border border-cc-attention-border bg-cc-attention-bg px-2 py-1 text-[11px] text-cc-attention transition-colors hover:bg-cc-attention-bg/80 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
              >
                Reply
              </button>
              {replyButton}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function findNotification({
  sessionId,
  notificationId,
  messageId,
  category,
}: {
  sessionId: string;
  notificationId?: string;
  messageId?: string;
  category: SessionNotification["category"];
}): SessionNotification | null {
  const notifications = useStore.getState().sessionNotifications.get(sessionId);
  if (!notifications) return null;
  if (notificationId) return notifications.find((n) => n.id === notificationId && n.category === category) ?? null;
  if (!messageId) return null;
  return notifications.find((n) => n.messageId === messageId && n.category === category) ?? null;
}
