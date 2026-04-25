import type { BrowserIncomingMessage, TakodeUserMessageEventData } from "../session-types.js";

export const USER_MESSAGE_TAKODE_TEXT_LIMIT = 5000;

type StoredUserMessage = Extract<BrowserIncomingMessage, { type: "user_message" }>;

export type UserMessageTakodeTurnTarget = "current" | "queued" | null;

export function truncateUserMessageForTakodeEvent(content: string): string {
  return content.length <= USER_MESSAGE_TAKODE_TEXT_LIMIT
    ? content
    : content.slice(0, USER_MESSAGE_TAKODE_TEXT_LIMIT - 1) + "…";
}

export function buildUserMessageTakodeEventData(
  entry: StoredUserMessage,
  options: {
    historyIndex?: number;
    turnTarget?: UserMessageTakodeTurnTarget;
    turnId?: string | null;
  } = {},
): TakodeUserMessageEventData {
  return {
    content: truncateUserMessageForTakodeEvent(entry.content || ""),
    ...(typeof options.historyIndex === "number" && options.historyIndex >= 0
      ? { msg_index: options.historyIndex }
      : {}),
    ...(entry.id ? { message_id: entry.id } : {}),
    ...(options.turnTarget !== undefined ? { turn_target: options.turnTarget } : {}),
    ...(typeof options.turnId === "string" && options.turnId ? { turn_id: options.turnId } : {}),
    ...(entry.agentSource ? { agentSource: entry.agentSource } : {}),
  };
}

export function emitStoredUserMessageTakodeEvent(
  deps: {
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>, actorSessionId?: string) => void;
  },
  sessionId: string,
  entry: StoredUserMessage,
  options?: Parameters<typeof buildUserMessageTakodeEventData>[1],
): void {
  deps.emitTakodeEvent(
    sessionId,
    "user_message",
    buildUserMessageTakodeEventData(entry, options) as unknown as Record<string, unknown>,
  );
}
