import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { ChatMessage, SdkSessionInfo } from "../types.js";
import { attentionLedgerMessageIdForNotificationId } from "../utils/attention-records.js";
import { formatNeedsInputResponse, getNeedsInputQuestionViews } from "../utils/notification-questions.js";
import {
  getNotificationSourceContext,
  getNotificationTitle,
  normalizeNotificationSourceContext,
  shouldShowNeedsInputQuestionPrompt,
} from "../utils/notification-source-context.js";
import { resolveNotificationOwnerThreadKey } from "../utils/notification-thread.js";
import { navigateToSessionMessageId, navigateToSessionThread, routeSessionRefForId } from "../utils/routing.js";
import { MAIN_THREAD_KEY } from "../utils/thread-projection.js";
import { NeedsInputSourceTarget } from "./NeedsInputSourceTarget.js";
import { NeedsInputAnswerField } from "./NeedsInputAnswerField.js";
import {
  getGlobalNeedsInputEntries,
  type GlobalNeedsInputEntry,
  type GlobalNeedsInputState,
} from "../utils/global-needs-input.js";

const MENU_TOP_PX = 44;
const EMPTY_MESSAGES: ChatMessage[] = [];

export { getGlobalNeedsInputEntries } from "../utils/global-needs-input.js";

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function needsInputFetchKeys(state: GlobalNeedsInputState): string[] {
  return state.sdkSessions
    .filter(
      (session) =>
        !session.archived &&
        session.notificationUrgency === "needs-input" &&
        (session.activeNotificationCount ?? 0) > 0,
    )
    .map(
      (session) =>
        `${session.sessionId}:${session.notificationStatusVersion ?? ""}:${session.notificationStatusUpdatedAt ?? ""}`,
    );
}

function parseFetchKey(key: string): string {
  return key.split(":")[0] ?? key;
}

function jumpToNotification(entry: GlobalNeedsInputEntry, sdkSessions: SdkSessionInfo[]) {
  const threadKey = resolveNotificationOwnerThreadKey(entry.notification);
  const routeSessionId = routeSessionRefForId(entry.sessionId, sdkSessions);
  const fallbackMessageId =
    !entry.notification.messageId && threadKey !== MAIN_THREAD_KEY
      ? attentionLedgerMessageIdForNotificationId(entry.notification.id)
      : null;
  const messageId = entry.notification.messageId ?? fallbackMessageId;

  if (messageId) {
    navigateToSessionMessageId(entry.sessionId, messageId, {
      routeSessionId,
      threadKey,
      preserveMainThreadRoute: true,
    });
    return;
  }

  navigateToSessionThread(entry.sessionId, threadKey, false, routeSessionId, { preserveMainThreadRoute: true });
}

function markLocalNotificationDone(sessionId: string, notificationId: string) {
  const store = useStore.getState();
  const notifications = store.sessionNotifications.get(sessionId);
  if (!notifications) return;
  store.setSessionNotifications(
    sessionId,
    notifications.map((notification) =>
      notification.id === notificationId ? { ...notification, done: true } : notification,
    ),
  );
}

function BellIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 2.5-1.5 4-1.5 4h12s-1.5-1.5-1.5-4A4.5 4.5 0 0 0 8 1.5z" />
      <path d="M6 12a2 2 0 0 0 4 0" />
    </svg>
  );
}

function GlobalNeedsInputRow({ entry, sdkSessions }: { entry: GlobalNeedsInputEntry; sdkSessions: SdkSessionInfo[] }) {
  const [answersByQuestion, setAnswersByQuestion] = useState<Record<string, string>>({});
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [remoteSourceContext, setRemoteSourceContext] = useState<{ key: string; value: string | null } | null>(null);
  const [sending, setSending] = useState(false);
  const messages = useStore((s) => s.messages?.get(entry.sessionId) ?? EMPTY_MESSAGES);
  const questionViews = useMemo(() => getNeedsInputQuestionViews(entry.notification), [entry.notification]);
  const canSendResponse = questionViews.length > 0 && questionViews.every((q) => answersByQuestion[q.key]?.trim());
  const canSubmitResponse = canSendResponse && !sending;
  const sessionLabel = entry.sessionNum == null ? entry.sessionName : `#${entry.sessionNum} ${entry.sessionName}`;
  const summary = getNotificationTitle(entry.notification);
  const ownerThreadKey = resolveNotificationOwnerThreadKey(entry.notification);
  const voiceThreadTitle =
    ownerThreadKey === MAIN_THREAD_KEY ? "Main Thread" : (entry.notification.questId ?? ownerThreadKey);
  const localSourceContext = useMemo(
    () => getNotificationSourceContext(entry.notification, messages),
    [entry.notification, messages],
  );
  const remoteContextKey = `${entry.sessionId}:${entry.notification.id}:${entry.notification.messageId ?? ""}`;
  const sourceContext =
    localSourceContext ?? (remoteSourceContext?.key === remoteContextKey ? remoteSourceContext.value : null);

  const setQuestionAnswer = useCallback((key: string, value: string) => {
    setDeliveryError(null);
    setAnswersByQuestion((prev) => ({ ...prev, [key]: value }));
  }, []);

  const jump = useCallback(() => {
    jumpToNotification(entry, sdkSessions);
  }, [entry, sdkSessions]);

  useEffect(() => {
    if (localSourceContext || !entry.notification.messageId) return;
    let cancelled = false;
    setRemoteSourceContext({ key: remoteContextKey, value: null });
    api.fetchNotificationContext(entry.sessionId, entry.notification.id).then((context) => {
      if (cancelled) return;
      setRemoteSourceContext({
        key: remoteContextKey,
        value: normalizeNotificationSourceContext(context, entry.notification),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [entry.notification, entry.sessionId, localSourceContext, remoteContextKey]);

  const sendResponse = useCallback(async () => {
    if (!canSubmitResponse) return;
    const threadKey = ownerThreadKey;
    const content = formatNeedsInputResponse(entry.notification.summary, questionViews, answersByQuestion);
    setSending(true);
    setDeliveryError(null);
    try {
      await api.sendNeedsInputResponse(entry.sessionId, entry.notification.id, {
        content,
        threadKey,
        ...(threadKey !== MAIN_THREAD_KEY ? { questId: entry.notification.questId ?? threadKey } : {}),
      });
      markLocalNotificationDone(entry.sessionId, entry.notification.id);
      useStore.getState().requestBottomAlignOnNextUserMessage?.(entry.sessionId);
      setAnswersByQuestion({});
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Please retry.";
      setDeliveryError(`Response could not be delivered. ${message}`);
    } finally {
      setSending(false);
    }
  }, [answersByQuestion, canSubmitResponse, entry, ownerThreadKey, questionViews]);

  return (
    <div className="px-3 py-2.5 hover:bg-cc-hover/35 transition-colors">
      <div className="flex items-start gap-2">
        <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-cc-attention" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[11px] font-medium text-cc-muted" title={sessionLabel}>
              {sessionLabel}
            </span>
            <span className="shrink-0 text-[10px] text-cc-muted/55">
              {formatRelativeTime(entry.notification.timestamp)}
            </span>
          </div>
          <NeedsInputSourceTarget
            title={summary}
            sourceContext={sourceContext}
            onNavigate={jump}
            testIdPrefix="global-needs-input"
          />
        </div>
      </div>

      {questionViews.length > 0 && (
        <div className="mt-2 space-y-2 pl-3" data-testid="global-needs-input-answer-actions">
          {questionViews.map((question, index) => (
            <div key={question.key} className="space-y-1.5" data-testid="global-needs-input-question-block">
              {shouldShowNeedsInputQuestionPrompt({
                prompt: question.prompt,
                title: summary,
                questionCount: questionViews.length,
              }) && (
                <div className="text-[11px] leading-snug text-cc-fg/80">
                  {questionViews.length > 1 && <span className="text-cc-muted">{index + 1}. </span>}
                  {question.prompt}
                </div>
              )}
              {question.suggestedAnswers.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {question.suggestedAnswers.map((answer) => (
                    <button
                      key={answer}
                      type="button"
                      onClick={() => setQuestionAnswer(question.key, answer)}
                      className="max-w-full truncate rounded border border-cc-attention-border bg-cc-attention-bg px-2 py-0.5 text-[11px] text-cc-attention transition-colors hover:bg-cc-attention-bg/80 cursor-pointer"
                      title={`Use suggested answer: ${answer}`}
                    >
                      {answer}
                    </button>
                  ))}
                </div>
              )}
              <NeedsInputAnswerField
                sessionId={entry.sessionId}
                notification={entry.notification}
                question={question}
                questionCount={questionViews.length}
                value={answersByQuestion[question.key] ?? ""}
                onChange={(value) => setQuestionAnswer(question.key, value)}
                placeholder="Your answer"
                sourceContext={sourceContext}
                threadKey={ownerThreadKey}
                threadTitle={voiceThreadTitle}
                textareaClassName="border-cc-border/60 px-2 py-1 text-[12px] text-cc-fg"
                onClickStopsPropagation={false}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={sendResponse}
            disabled={!canSubmitResponse}
            className="rounded border border-cc-attention-border bg-cc-attention-bg px-2 py-0.5 text-[11px] text-cc-attention transition-colors hover:bg-cc-attention-bg/80 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
          >
            {sending ? "Sending..." : deliveryError ? "Retry" : "Send Response"}
          </button>
          {deliveryError && <p className="text-[10px] leading-snug text-cc-attention">{deliveryError}</p>}
        </div>
      )}
    </div>
  );
}

function GlobalNeedsInputPopover({
  entries,
  sdkSessions,
  onClose,
  triggerRef,
}: {
  entries: GlobalNeedsInputEntry[];
  sdkSessions: SdkSessionInfo[];
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    const handler = (e: globalThis.MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose, triggerRef]);

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed right-3 z-50 flex max-h-[min(72vh,32rem)] w-[min(28rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-cc-border bg-cc-card/98 shadow-xl"
      style={{ top: MENU_TOP_PX }}
      role="dialog"
      aria-label="Global needs-input notifications"
    >
      <div className="flex items-center justify-between border-b border-cc-border/50 px-3 py-2.5">
        <h2 className="text-[13px] font-medium text-cc-fg">
          Needs Input <span className="ml-1 text-[11px] text-cc-muted font-normal">({entries.length})</span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
          aria-label="Close"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="overflow-y-auto divide-y divide-cc-border/20">
        {entries.map((entry) => (
          <GlobalNeedsInputRow
            key={`${entry.sessionId}:${entry.notification.id}`}
            entry={entry}
            sdkSessions={sdkSessions}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function GlobalNeedsInputMenu() {
  const { sessionNotifications, sdkSessions, sessionNames } = useStore(
    useShallow((s) => ({
      sessionNotifications: s.sessionNotifications,
      sdkSessions: s.sdkSessions,
      sessionNames: s.sessionNames,
    })),
  );
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fetchedKeysRef = useRef(new Set<string>());
  const state = useMemo(
    () => ({ sessionNotifications, sdkSessions, sessionNames }),
    [sessionNotifications, sdkSessions, sessionNames],
  );
  const entries = useMemo(() => getGlobalNeedsInputEntries(state), [state]);
  const fetchKeys = useMemo(() => needsInputFetchKeys(state), [state]);

  useEffect(() => {
    for (const key of fetchKeys) {
      if (fetchedKeysRef.current.has(key)) continue;
      fetchedKeysRef.current.add(key);
      const sessionId = parseFetchKey(key);
      api
        .getSessionNotifications(sessionId)
        .then((notifications) => useStore.getState().setSessionNotifications(sessionId, notifications))
        .catch((error) => {
          console.warn("Failed to load global needs-input notifications", error);
          fetchedKeysRef.current.delete(key);
        });
    }
  }, [fetchKeys]);

  const close = useCallback(() => setOpen(false), []);
  const count = entries.length;

  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  if (count === 0) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-7 items-center gap-1 rounded-lg border border-cc-attention-border bg-cc-attention-bg px-2 text-[11px] font-medium text-cc-attention transition-colors hover:bg-cc-attention-bg/80 cursor-pointer"
        aria-label={`${count} unresolved needs-input ${count === 1 ? "notification" : "notifications"} across sessions`}
        title="Needs-input notifications across sessions"
      >
        <span>{count}</span>
        <BellIcon className="h-3.5 w-3.5 shrink-0 text-cc-attention" />
      </button>
      {open && (
        <GlobalNeedsInputPopover entries={entries} sdkSessions={sdkSessions} onClose={close} triggerRef={triggerRef} />
      )}
    </>
  );
}
