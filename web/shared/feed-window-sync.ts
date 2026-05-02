import type {
  BrowserIncomingMessage,
  HistoryWindowState,
  ThreadWindowEntry,
  ThreadWindowState,
} from "../server/session-types.js";

export const FEED_WINDOW_SYNC_VERSION = 1;

export type FeedWindowSyncSource = "history_window" | "thread_window";

export interface FeedWindowRenderItem {
  key: string;
  kind: "message";
  messageId: string;
  messageType: BrowserIncomingMessage["type"];
  historyIndex?: number;
  timestamp?: number;
  synthetic?: boolean;
}

export interface FeedWindowSync {
  version: typeof FEED_WINDOW_SYNC_VERSION;
  source: FeedWindowSyncSource;
  legacySyncType: "history_window_sync" | "thread_window_sync";
  threadKey: string;
  windowHash?: string;
  window: HistoryWindowState | ThreadWindowState;
  items: FeedWindowRenderItem[];
  bounds: {
    from: number;
    count: number;
    total: number;
    sourceHistoryLength?: number;
  };
}

export function supportsFeedWindowSync(version: unknown): version is typeof FEED_WINDOW_SYNC_VERSION {
  return version === FEED_WINDOW_SYNC_VERSION;
}

export function buildHistoryFeedWindowSync(input: {
  messages: ReadonlyArray<BrowserIncomingMessage>;
  window: HistoryWindowState;
}): FeedWindowSync {
  return {
    version: FEED_WINDOW_SYNC_VERSION,
    source: "history_window",
    legacySyncType: "history_window_sync",
    threadKey: "main",
    ...(input.window.window_hash ? { windowHash: input.window.window_hash } : {}),
    window: input.window,
    items: input.messages.map((message, index) =>
      renderItemForMessage(message, input.window.start_index == null ? undefined : input.window.start_index + index),
    ),
    bounds: {
      from: input.window.from_turn,
      count: input.window.turn_count,
      total: input.window.total_turns,
    },
  };
}

export function buildThreadFeedWindowSync(input: {
  threadKey: string;
  entries: ReadonlyArray<ThreadWindowEntry>;
  window: ThreadWindowState;
}): FeedWindowSync {
  return {
    version: FEED_WINDOW_SYNC_VERSION,
    source: "thread_window",
    legacySyncType: "thread_window_sync",
    threadKey: input.threadKey,
    ...(input.window.window_hash ? { windowHash: input.window.window_hash } : {}),
    window: input.window,
    items: input.entries.map((entry) =>
      renderItemForMessage(entry.message, entry.history_index, entry.synthetic === true),
    ),
    bounds: {
      from: input.window.from_item,
      count: input.window.item_count,
      total: input.window.total_items,
      sourceHistoryLength: input.window.source_history_length,
    },
  };
}

function renderItemForMessage(
  message: BrowserIncomingMessage,
  historyIndex: number | undefined,
  synthetic = false,
): FeedWindowRenderItem {
  const messageId = rawMessageId(message, historyIndex);
  return {
    key: `${historyIndex ?? "local"}:${messageId}`,
    kind: "message",
    messageId,
    messageType: message.type,
    ...(typeof historyIndex === "number" ? { historyIndex } : {}),
    ...(typeof timestampForMessage(message) === "number" ? { timestamp: timestampForMessage(message) } : {}),
    ...(synthetic ? { synthetic: true } : {}),
  };
}

function rawMessageId(message: BrowserIncomingMessage, historyIndex: number | undefined): string {
  const id = (message as { id?: unknown }).id;
  if (typeof id === "string" && id.trim()) return id;
  if (message.type === "assistant") {
    const assistantId = message.message?.id;
    if (typeof assistantId === "string" && assistantId.trim()) return assistantId;
  }
  return `${message.type}:${historyIndex ?? "unknown"}`;
}

function timestampForMessage(message: BrowserIncomingMessage): number | undefined {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" ? timestamp : undefined;
}
