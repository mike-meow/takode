import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import type { ChatMessage, PendingCodexInput, PendingUserUpload } from "../types.js";
import { YarnBallDot } from "./CatIcons.js";
import { MessageBubble } from "./MessageBubble.js";
import { NotificationChip } from "./NotificationChip.js";
import { TimerChip } from "./TimerWidget.js";
import { formatElapsed, formatTokens, getFooterFeedBlockId, getPendingCodexFeedBlockId } from "./message-feed-utils.js";
import { formatReplyContentForPreview } from "../utils/reply-context.js";

export function ElapsedTimer({
  sessionId,
  latestIndicatorVisible = false,
  onJumpToLatest,
  variant = "bar",
  onVisibleHeightChange,
}: {
  sessionId: string;
  latestIndicatorVisible?: boolean;
  onJumpToLatest?: () => void;
  variant?: "bar" | "floating";
  onVisibleHeightChange?: (height: number) => void;
}) {
  const streamingStartedAt = useStore((s) => s.streamingStartedAt.get(sessionId));
  const streamingOutputTokens = useStore((s) => s.streamingOutputTokens.get(sessionId));
  const streamingPausedDuration = useStore((s) => s.streamingPausedDuration.get(sessionId) ?? 0);
  const streamingPauseStartedAt = useStore((s) => s.streamingPauseStartedAt.get(sessionId));
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const isStuck = useStore((s) => s.sessionStuck.get(sessionId) ?? false);
  const [elapsed, setElapsed] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!streamingStartedAt && sessionStatus !== "running") {
      setElapsed(0);
      return;
    }
    const start = streamingStartedAt || Date.now();
    const calcElapsed = () => {
      const pauseOffset =
        streamingPausedDuration + (streamingPauseStartedAt ? Date.now() - streamingPauseStartedAt : 0);
      return Math.max(0, Date.now() - start - pauseOffset);
    };
    setElapsed(calcElapsed());
    const interval = setInterval(() => setElapsed(calcElapsed()), 1000);
    return () => clearInterval(interval);
  }, [streamingStartedAt, sessionStatus, streamingPausedDuration, streamingPauseStartedAt]);

  const showTimer = sessionStatus === "running" && elapsed > 0;

  useLayoutEffect(() => {
    if (!onVisibleHeightChange) return;
    if (!showTimer) {
      onVisibleHeightChange(0);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const reportHeight = () => {
      onVisibleHeightChange(Math.ceil(root.getBoundingClientRect().height));
    };
    reportHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reportHeight);
    observer.observe(root);
    return () => observer.disconnect();
  }, [onVisibleHeightChange, showTimer, streamingOutputTokens, variant]);

  if (!showTimer) return null;

  const handleRelaunch = () => {
    api.relaunchSession(sessionId).catch(() => {});
  };

  const label = isStuck ? "Session may be stuck" : streamingPauseStartedAt ? "Napping..." : "Purring...";
  const dotColor = isStuck
    ? "text-amber-400"
    : streamingPauseStartedAt
      ? "text-amber-400"
      : "text-cc-primary animate-pulse";

  if (variant === "floating") {
    return (
      <div
        ref={rootRef}
        className="pointer-events-auto relative inline-flex max-w-[min(18rem,calc(100vw-2.75rem))] items-center gap-1.5 overflow-hidden rounded-[18px] border border-white/8 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-2.5 py-1 text-[11px] text-cc-muted font-mono-code shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-md"
      >
        <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.10),transparent_55%)]" />
        <YarnBallDot className={dotColor} />
        <span className="relative truncate text-cc-fg/90">{label}</span>
        <span className="relative text-cc-muted/75">{formatElapsed(elapsed)}</span>
        {(streamingOutputTokens ?? 0) > 0 && (
          <span className="relative hidden sm:inline truncate text-cc-muted/70">
            ↓ {formatTokens(streamingOutputTokens ?? 0)}
          </span>
        )}
        {isStuck && (
          <button
            onClick={handleRelaunch}
            className="relative ml-1 text-amber-400 hover:text-amber-300 underline cursor-pointer"
          >
            Relaunch
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="shrink-0 flex items-center gap-1.5 border-t border-cc-border bg-cc-card px-3 sm:px-4 py-1.5 text-[11px] text-cc-muted font-mono-code"
    >
      <YarnBallDot className={dotColor} />
      <span>{label}</span>
      <span className="text-cc-muted/60">(</span>
      <span>{formatElapsed(elapsed)}</span>
      {(streamingOutputTokens ?? 0) > 0 && (
        <>
          <span className="text-cc-muted/40">·</span>
          <span>↓ {formatTokens(streamingOutputTokens ?? 0)}</span>
        </>
      )}
      <span className="text-cc-muted/60">)</span>
      {isStuck && (
        <button onClick={handleRelaunch} className="ml-1 text-amber-400 hover:text-amber-300 underline cursor-pointer">
          Relaunch
        </button>
      )}
      {latestIndicatorVisible && onJumpToLatest && (
        <button
          type="button"
          onClick={onJumpToLatest}
          className="ml-auto inline-flex min-w-0 items-center gap-1.5 rounded-full border border-cc-primary/25 bg-cc-card/70 px-2.5 py-0.5 text-[11px] font-medium text-cc-fg transition-colors hover:bg-cc-hover cursor-pointer"
          title="Jump to latest"
          aria-label="Jump to latest"
        >
          <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-cc-primary animate-pulse" />
          <span className="truncate">New content below</span>
        </button>
      )}
    </div>
  );
}

export function FeedStatusPill({
  sessionId,
  onVisibleHeightChange,
}: {
  sessionId: string;
  onVisibleHeightChange?: (height: number) => void;
}) {
  const leftStackRef = useRef<HTMLDivElement>(null);
  const rightStackRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!onVisibleHeightChange) return;
    const reportHeight = () => {
      const visibleHeight = Math.max(
        Math.ceil(leftStackRef.current?.getBoundingClientRect().height ?? 0),
        Math.ceil(rightStackRef.current?.getBoundingClientRect().height ?? 0),
      );
      onVisibleHeightChange(visibleHeight);
    };

    reportHeight();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(reportHeight);
    if (leftStackRef.current) observer.observe(leftStackRef.current);
    if (rightStackRef.current) observer.observe(rightStackRef.current);
    return () => observer.disconnect();
  }, [onVisibleHeightChange, sessionId]);

  return (
    <>
      <div
        ref={leftStackRef}
        data-testid="feed-status-pill-left"
        className="pointer-events-none absolute bottom-2 left-2 z-10 sm:bottom-3 sm:left-3"
      >
        <ElapsedTimer sessionId={sessionId} variant="floating" />
      </div>
      <div
        ref={rightStackRef}
        data-testid="feed-status-pill-right"
        className="pointer-events-none absolute bottom-2 right-2 z-10 flex flex-row items-end gap-1.5 sm:bottom-3 sm:right-3"
      >
        <TimerChip sessionId={sessionId} />
        <NotificationChip sessionId={sessionId} />
      </div>
    </>
  );
}

export function PendingCodexInputList({ sessionId, inputs }: { sessionId: string; inputs: PendingCodexInput[] }) {
  if (inputs.length === 0) return null;

  return (
    <div className="space-y-2" data-feed-block-id={getFooterFeedBlockId("pending-codex-inputs")}>
      <div className="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wider text-cc-muted/60">
        <span>Pending delivery</span>
      </div>
      <div className="flex flex-col gap-2">
        {inputs.map((input) => {
          const preview = formatReplyContentForPreview(input.content, input.replyContext).trim().replace(/\s+/g, " ");
          const truncated = preview.length > 120 ? `${preview.slice(0, 120)}...` : preview;
          return (
            <div
              key={input.id}
              data-feed-block-id={getPendingCodexFeedBlockId(input.id)}
              className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-sm text-cc-fg"
            >
              <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-amber-400" />
              <span className="min-w-0 flex-1 truncate" title={preview || "Pending message"}>
                {truncated || "Pending message"}
              </span>
              <button
                type="button"
                disabled={!input.cancelable}
                onClick={() => {
                  sendToSession(sessionId, { type: "cancel_pending_codex_input", id: input.id });
                }}
                className={`shrink-0 rounded-full p-1 transition-colors ${
                  input.cancelable
                    ? "text-cc-muted hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
                    : "text-cc-muted/40 cursor-not-allowed"
                }`}
                title={input.cancelable ? "Cancel pending message" : "Already being delivered"}
                aria-label={input.cancelable ? "Cancel pending message" : "Pending message is already being delivered"}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PendingUserUploadList({ sessionId, uploads }: { sessionId: string; uploads: PendingUserUpload[] }) {
  if (uploads.length === 0) return null;

  return (
    <div className="space-y-2" data-feed-block-id={getFooterFeedBlockId("pending-user-uploads")}>
      <div className="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wider text-cc-muted/60">
        <span>Pending upload</span>
      </div>
      <div className="flex flex-col gap-3">
        {uploads.map((upload) => {
          const msg: ChatMessage = {
            id: `pending-upload-${upload.id}`,
            role: "user",
            content: upload.content,
            localImages: upload.images.map(({ name, base64, mediaType }) => ({
              name,
              base64,
              mediaType,
            })),
            timestamp: upload.timestamp,
            ...(upload.vscodeSelection || upload.replyContext || upload.threadKey || upload.questId
              ? {
                  metadata: {
                    ...(upload.replyContext ? { replyContext: upload.replyContext } : {}),
                    ...(upload.vscodeSelection ? { vscodeSelection: upload.vscodeSelection } : {}),
                    ...(upload.threadKey ? { threadKey: upload.threadKey } : {}),
                    ...(upload.questId ? { questId: upload.questId } : {}),
                  },
                }
              : {}),
            ephemeral: true,
            pendingState: upload.stage === "delivering" ? "delivering" : "failed",
            pendingError: upload.error,
            clientMsgId: upload.id,
          };

          const handleRestoreToDraft = () => {
            const store = useStore.getState();
            store.removePendingUserUpload(sessionId, upload.id);
            store.setComposerDraft(sessionId, { text: upload.content, images: upload.images });
            store.setReplyContext(sessionId, upload.replyContext ?? null);
            store.focusComposer();
          };

          const handleRetry = () => {
            if (!upload.prepared) return;
            const sent = sendToSession(sessionId, {
              type: "user_message",
              content: upload.content,
              deliveryContent: upload.prepared.deliveryContent,
              imageRefs: upload.prepared.imageRefs,
              ...(upload.replyContext ? { replyContext: upload.replyContext } : {}),
              ...(upload.vscodeSelection ? { vscodeSelection: upload.vscodeSelection } : {}),
              ...(upload.threadKey ? { threadKey: upload.threadKey } : {}),
              ...(upload.questId ? { questId: upload.questId } : {}),
              session_id: sessionId,
              client_msg_id: upload.id,
            });
            useStore
              .getState()
              .updatePendingUserUpload(sessionId, upload.id, (current) =>
                sent
                  ? { ...current, stage: "delivering", error: undefined }
                  : { ...current, stage: "failed", error: "Connection lost before delivery." },
              );
          };

          return (
            <div key={upload.id} className="space-y-1.5">
              <MessageBubble message={msg} sessionId={sessionId} showTimestamp={true} />
              <div className="flex justify-end gap-2 pr-10 text-xs">
                {upload.stage === "failed" && (
                  <>
                    {upload.prepared && (
                      <button
                        type="button"
                        onClick={handleRetry}
                        className="rounded-full border border-cc-primary/30 bg-cc-card px-3 py-1 text-cc-primary transition-colors hover:bg-cc-hover cursor-pointer"
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleRestoreToDraft}
                      className="rounded-full border border-cc-border bg-cc-card px-3 py-1 text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg cursor-pointer"
                    >
                      Edit
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
