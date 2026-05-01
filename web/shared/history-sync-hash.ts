import type { BrowserIncomingMessage, ContentBlock } from "../server/session-types.js";

type ComparableHistoryEntry = {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentBlocks?: unknown;
  images?: unknown;
  metadata?: unknown;
  agentSource?: unknown;
  parentToolUseId?: string | null;
  model?: string;
  stopReason?: string | null;
  turnDurationMs?: number;
  variant?: string;
  cliUuid?: string;
  timestamp?: number | null;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function mixHash(state: number, token: string): number {
  let next = state;
  next ^= 0x1f;
  next = Math.imul(next, 0x01000193);
  for (let i = 0; i < token.length; i++) {
    next ^= token.charCodeAt(i);
    next = Math.imul(next, 0x01000193);
  }
  return next >>> 0;
}

function finalizeMixedHash(state: number): string {
  return state.toString(16).padStart(8, "0");
}

function extractTextFromBlocks(blocks: ContentBlock[] | undefined): string {
  if (!blocks?.length) return "";
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function normalizeErrorText(msg: Extract<BrowserIncomingMessage, { type: "result" }>["data"]): string | null {
  if (!msg.is_error) return null;
  if (msg.errors?.length) return msg.errors.join(", ");
  if (typeof msg.result === "string" && msg.result.trim().length > 0) return msg.result;
  return "An error occurred";
}

function fingerprintComparableEntry(entry: ComparableHistoryEntry): string {
  if (entry.id) {
    return `id:${entry.id}`;
  }
  return hashString(stableStringify(entry));
}

function foldFingerprints(fingerprints: Iterable<string>): string {
  let state = 0x811c9dc5;
  for (const fingerprint of fingerprints) {
    state = mixHash(state, fingerprint);
  }
  return finalizeMixedHash(state);
}

function forEachComparableHistoryEntry(
  historyMessages: readonly BrowserIncomingMessage[],
  startIndex: number,
  visitor: (entry: ComparableHistoryEntry, renderedIndex: number) => void,
): number {
  let renderedIndex = 0;
  for (let i = 0; i < historyMessages.length; i++) {
    const historyIndex = startIndex + i;
    const message = historyMessages[i];
    if (!message) continue;
    if (message.type === "user_message") {
      visitor(
        {
          id: message.id || `hist-user-${historyIndex}`,
          role: "user",
          content: message.content,
          images: message.images,
          metadata: message.vscodeSelection ? { vscodeSelection: message.vscodeSelection } : undefined,
          agentSource: message.agentSource,
          timestamp: message.timestamp,
        },
        renderedIndex++,
      );
      continue;
    }
    if (message.type === "assistant") {
      visitor(
        {
          id: message.message.id,
          role: "assistant",
          content: extractTextFromBlocks(message.message.content),
          contentBlocks: message.message.content,
          parentToolUseId: message.parent_tool_use_id,
          model: message.message.model,
          stopReason: message.message.stop_reason ?? null,
          turnDurationMs: typeof message.turn_duration_ms === "number" ? message.turn_duration_ms : undefined,
          cliUuid: message.uuid,
          timestamp: message.timestamp ?? null,
        },
        renderedIndex++,
      );
      continue;
    }
    if (message.type === "compact_marker") {
      visitor(
        {
          id: message.id || `compact-${historyIndex}`,
          role: "system",
          content: message.summary || "Conversation compacted",
          variant: "info",
          timestamp: null,
        },
        renderedIndex++,
      );
      continue;
    }
    if (message.type === "permission_denied") {
      visitor(
        {
          id: message.id,
          role: "system",
          content: message.summary,
          variant: "denied",
          timestamp: null,
        },
        renderedIndex++,
      );
      continue;
    }
    if (message.type === "permission_approved") {
      visitor(
        {
          id: message.id,
          role: "system",
          content: message.summary,
          variant: "approved",
          metadata: message.answers?.length ? { answers: message.answers } : undefined,
          timestamp: null,
        },
        renderedIndex++,
      );
      continue;
    }
    if (message.type === "task_notification") {
      // Match normalizeHistoryMessages: only produce a ChatMessage when summary exists
      const taskMsg = message as { task_id?: string; summary?: string };
      if (taskMsg.summary) {
        visitor(
          {
            id: `task-notif-${taskMsg.task_id || historyIndex}`,
            role: "system",
            content: taskMsg.summary,
            variant: "task_completed",
            timestamp: null,
          },
          renderedIndex++,
        );
      }
      continue;
    }
    if (message.type === "result") {
      const errorText = normalizeErrorText(message.data);
      if (errorText) {
        visitor(
          {
            id: `hist-error-${historyIndex}`,
            role: "system",
            content: `Error: ${errorText}`,
            variant: "error",
            timestamp: null,
          },
          renderedIndex++,
        );
      }
    }
  }
  return renderedIndex;
}

export function computeHistoryMessagesSyncHash(
  historyMessages: readonly BrowserIncomingMessage[],
  startIndex = 0,
): { hash: string; renderedCount: number } {
  const fingerprints: string[] = [];
  const renderedCount = forEachComparableHistoryEntry(historyMessages, startIndex, (entry) => {
    fingerprints.push(fingerprintComparableEntry(entry));
  });
  return {
    hash: foldFingerprints(fingerprints),
    renderedCount,
  };
}

export function computeHistoryPayloadSyncHash(value: unknown): string {
  return hashString(stableStringify(value));
}

export function computeHistoryPrefixSyncHash(
  historyMessages: readonly BrowserIncomingMessage[],
  renderedCount: number,
  startIndex = 0,
): { hash: string; renderedCount: number; totalRenderedCount: number } {
  const normalizedRenderedCount = Math.max(0, Math.floor(renderedCount));
  const fingerprints: string[] = [];
  const totalRenderedCount = forEachComparableHistoryEntry(historyMessages, startIndex, (entry, renderedIndex) => {
    if (renderedIndex < normalizedRenderedCount) {
      fingerprints.push(fingerprintComparableEntry(entry));
    }
  });
  return {
    hash: foldFingerprints(fingerprints),
    renderedCount: Math.min(normalizedRenderedCount, totalRenderedCount),
    totalRenderedCount,
  };
}
