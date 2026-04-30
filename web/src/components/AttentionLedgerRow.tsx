import { useCallback } from "react";
import { useStore } from "../store.js";
import type { SessionAttentionRecord } from "../types.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY, normalizeThreadKey } from "../utils/thread-projection.js";
import { QuestInlineLink } from "./QuestInlineLink.js";

type AttentionRecord = SessionAttentionRecord;

const STATE_LABELS: Record<AttentionRecord["state"], string> = {
  unresolved: "Needs attention",
  seen: "Seen",
  resolved: "Resolved",
  dismissed: "Dismissed",
  reopened: "Reopened",
  superseded: "Superseded",
};

export function AttentionLedgerRow({
  record,
  sessionId,
  currentThreadKey = MAIN_THREAD_KEY,
  onSelectThread,
}: {
  record: AttentionRecord;
  sessionId: string;
  currentThreadKey?: string;
  onSelectThread?: (threadKey: string) => void;
}) {
  const isActive = record.state === "unresolved" || record.state === "seen" || record.state === "reopened";
  const isReview = record.priority === "review";
  const isJourneyLifecycle = record.type === "quest_journey_started" || record.type === "quest_completed_recent";
  const targetThread = normalizeThreadKey(record.route.threadKey || record.threadKey || MAIN_THREAD_KEY);

  const openRoute = useCallback(() => {
    const selectedThread = normalizeThreadKey(currentThreadKey || MAIN_THREAD_KEY);
    const shouldSelectThread = selectedThread === ALL_THREADS_KEY || selectedThread !== targetThread;
    const scrollToRouteTarget = () => {
      if (!record.route.messageId) return;
      const store = useStore.getState();
      store.requestScrollToMessage(sessionId, record.route.messageId);
      store.setExpandAllInTurn(sessionId, record.route.messageId);
    };

    if (shouldSelectThread && onSelectThread) {
      onSelectThread(targetThread);
      setTimeout(scrollToRouteTarget, 0);
      return;
    }

    scrollToRouteTarget();
  }, [currentThreadKey, onSelectThread, record.route.messageId, sessionId, targetThread]);

  const statusClasses = isActive
    ? isReview
      ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-100"
      : "border-amber-500/25 bg-amber-500/5 text-amber-100"
    : "border-cc-border/70 bg-cc-card/35 text-cc-muted";
  const iconClasses = isActive ? (isReview ? "text-emerald-300" : "text-amber-300") : "text-cc-muted/70";
  const stateLabel = STATE_LABELS[record.state];
  const summary = record.summary.trim();
  const showSummary = summary.length > 0 && summary !== record.title.trim();
  const shellClasses = isReview ? "rounded-md px-3 py-2" : "rounded-lg px-3 py-2.5";
  const showThreadLink = targetThread !== MAIN_THREAD_KEY;

  return (
    <div
      className={`group border transition-colors ${shellClasses} ${statusClasses}`}
      data-testid="attention-ledger-row"
      data-attention-state={record.state}
      data-attention-type={record.type}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span className={`mt-0.5 shrink-0 ${iconClasses}`} aria-hidden="true">
          <AttentionStateIcon state={record.state} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-medium text-cc-fg">{record.title}</span>
            {!isReview && (
              <span className="rounded-md border border-current/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-normal opacity-80">
                {stateLabel}
              </span>
            )}
            {record.questId && (
              <QuestInlineLink
                questId={record.questId}
                stopPropagation
                className="font-mono-code text-[11px] text-blue-300/85 hover:text-blue-200 hover:underline"
              />
            )}
            {showThreadLink && (
              <button
                type="button"
                onClick={openRoute}
                className="font-mono-code text-[11px] text-sky-300/80 transition-colors cursor-pointer hover:text-sky-200 hover:underline"
                aria-label={`Open thread:${targetThread}`}
              >
                thread:{targetThread}
              </button>
            )}
          </div>
          {showSummary && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-cc-muted">{summary}</p>}
        </div>
        {!isJourneyLifecycle && (
          <button
            type="button"
            onClick={openRoute}
            className={`shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
              isActive
                ? "border-current/25 bg-cc-card/70 text-cc-fg hover:bg-cc-hover"
                : "border-cc-border bg-cc-hover/40 text-cc-muted hover:text-cc-fg"
            }`}
          >
            {record.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function AttentionStateIcon({ state }: { state: AttentionRecord["state"] }) {
  if (state === "resolved") {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
        <path d="M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5Zm3.15 5.1-3.75 3.75a.6.6 0 0 1-.85 0l-1.7-1.7a.6.6 0 1 1 .85-.85l1.27 1.27 3.33-3.32a.6.6 0 0 1 .85.85Z" />
      </svg>
    );
  }
  if (state === "dismissed" || state === "superseded") {
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
        <path d="M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5Zm-2.65 4.7a.6.6 0 0 1 .85-.85L8 7.15l1.8-1.8a.6.6 0 1 1 .85.85L8.85 8l1.8 1.8a.6.6 0 0 1-.85.85L8 8.85l-1.8 1.8a.6.6 0 0 1-.85-.85L7.15 8 5.35 6.2Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
      <path d="M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5Zm0 3a.65.65 0 0 1 .65.65v3.4a.65.65 0 1 1-1.3 0v-3.4A.65.65 0 0 1 8 4.5Zm0 7.05a.85.85 0 1 1 0-1.7.85.85 0 0 1 0 1.7Z" />
    </svg>
  );
}
