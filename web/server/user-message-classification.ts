import type { BrowserIncomingMessage } from "./session-types.js";

export interface UserMessageSourceLike {
  type?: unknown;
  agentSource?: unknown;
  timestamp?: unknown;
}

export interface UserInputSourceLike {
  agentSource?: unknown;
}

export function isActualHumanUserMessage(
  message: UserMessageSourceLike,
): message is UserMessageSourceLike & { type: "user_message" } {
  return message.type === "user_message" && message.agentSource == null;
}

export function isActualHumanUserInput(input: UserInputSourceLike): boolean {
  return input.agentSource == null;
}

export function getLastActualHumanUserMessageTimestamp(
  messages: readonly BrowserIncomingMessage[],
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !isActualHumanUserMessage(message)) continue;
    if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
  }
  return undefined;
}
