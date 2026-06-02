import { useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { connectSession } from "../ws.js";
import type { ChatMessage, SlackThreadRecord } from "../types.js";
import { MessageBubble } from "./MessageBubble.js";

const EMPTY_MESSAGES: ChatMessage[] = [];

export function SlackThreadPanel({
  rootSessionId,
  thread,
  onClose,
}: {
  rootSessionId: string;
  thread: SlackThreadRecord;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const messages = useStore((s) => s.messages.get(thread.childSessionId) ?? EMPTY_MESSAGES);
  const loading = useStore((s) => s.historyLoading.get(thread.childSessionId) ?? false);
  const visibleMessages = messages.filter((message) => !message.ephemeral);

  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await api.sendSlackThreadMessage(rootSessionId, thread.id, content);
      setText("");
      connectSession(thread.childSessionId);
    } catch (error) {
      console.warn("[slack-thread] failed to send thread message", error);
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="flex min-h-0 w-full shrink-0 flex-col border-l border-cc-border bg-cc-card sm:w-[360px] lg:w-[420px]">
      <div className="flex items-start gap-3 border-b border-cc-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-cc-fg">Thread</h2>
            <span className="rounded-full border border-cc-border bg-cc-hover/60 px-2 py-0.5 text-[11px] text-cc-muted">
              {thread.messageCount}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-cc-muted">{thread.anchorPreview || "Root reply"}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
          aria-label="Close thread"
          title="Close thread"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4 w-4">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {loading && visibleMessages.length === 0 ? (
          <div className="text-xs text-cc-muted">Loading thread...</div>
        ) : visibleMessages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-cc-border px-3 py-3 text-xs text-cc-muted">
            Ask a follow-up in this read-only branch.
          </div>
        ) : (
          visibleMessages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              sessionId={thread.childSessionId}
              currentThreadKey="main"
            />
          ))
        )}
      </div>
      <div className="border-t border-cc-border p-3">
        <div className="rounded-lg border border-cc-border bg-cc-bg">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={3}
            placeholder="Reply in thread..."
            className="min-h-[76px] w-full resize-none bg-transparent px-3 py-2 text-sm text-cc-fg outline-none placeholder:text-cc-muted"
          />
          <div className="flex items-center justify-between border-t border-cc-border/70 px-2 py-2">
            <span className="text-[11px] text-cc-muted">Read-only branch</span>
            <button
              type="button"
              onClick={() => void send()}
              disabled={!text.trim() || sending}
              className="rounded-md bg-cc-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cc-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? "Sending" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
