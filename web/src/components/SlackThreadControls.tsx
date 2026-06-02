import { useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { ChatMessage, SlackThreadRecord } from "../types.js";
import { normalizeThreadKey } from "../utils/thread-projection.js";

function openSlackThread(sessionId: string, thread: SlackThreadRecord) {
  window.dispatchEvent(
    new CustomEvent("takode:open-slack-thread", {
      detail: { sessionId, threadId: thread.id, childSessionId: thread.childSessionId },
    }),
  );
}

export function SlackThreadButton({
  message,
  sessionId,
  currentThreadKey,
}: {
  message: ChatMessage;
  sessionId: string;
  currentThreadKey?: string;
}) {
  const [creating, setCreating] = useState(false);
  const thread = useStore((s) => {
    const threads = s.sessions.get(sessionId)?.slackThreads ?? {};
    return Object.values(threads).find((candidate) => candidate.anchorMessageId === message.id) ?? null;
  });
  const isRootAssistant = message.role === "assistant" && normalizeThreadKey(currentThreadKey || "main") === "main";
  if (!isRootAssistant || message.metadata?.slackThreadId) return null;

  const handleClick = async () => {
    if (thread) {
      openSlackThread(sessionId, thread);
      return;
    }
    setCreating(true);
    try {
      const created = await api.createSlackThread(sessionId, message.id);
      openSlackThread(sessionId, created.thread);
    } catch (error) {
      console.warn("[slack-thread] failed to create thread", error);
    } finally {
      setCreating(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={creating}
      className="p-1 rounded hover:bg-cc-hover transition-all cursor-pointer disabled:cursor-wait disabled:opacity-60"
      title={thread ? `Open thread (${thread.messageCount})` : "Start thread"}
      aria-label={thread ? `Open thread with ${thread.messageCount} messages` : "Start thread"}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        className="w-3.5 h-3.5 text-cc-muted hover:text-cc-fg"
      >
        <path d="M3 4.5h10M3 8h7M3 11.5h5" strokeLinecap="round" />
        <path d="M11 9.5l2 2 2-2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function useSlackThreadForMessage(sessionId: string | undefined, message: ChatMessage) {
  return useStore((s) => {
    if (!sessionId || message.role !== "assistant" || message.metadata?.slackThreadId) return null;
    const threads = s.sessions.get(sessionId)?.slackThreads ?? {};
    return Object.values(threads).find((candidate) => candidate.anchorMessageId === message.id) ?? null;
  });
}

export function SlackThreadSummary({ thread, sessionId }: { thread: SlackThreadRecord; sessionId?: string }) {
  const count = thread.messageCount ?? 0;
  const label = `${count} ${count === 1 ? "reply" : "replies"}`;
  return (
    <button
      type="button"
      onClick={() => {
        if (!sessionId) return;
        openSlackThread(sessionId, thread);
      }}
      className="mt-2 inline-flex max-w-full items-center gap-2 rounded-md border border-cc-border bg-cc-hover/40 px-2.5 py-1 text-left text-xs text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="h-3.5 w-3.5 shrink-0">
        <path d="M3 4.5h10M3 8h7M3 11.5h5" strokeLinecap="round" />
      </svg>
      <span className="shrink-0 font-medium text-cc-fg/80">{label}</span>
      {thread.lastMessagePreview && <span className="min-w-0 truncate">{thread.lastMessagePreview}</span>}
    </button>
  );
}
