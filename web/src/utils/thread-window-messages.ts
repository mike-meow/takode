import type { ChatMessage, ThreadWindowState } from "../types.js";

export function composeSelectedFeedMessages(input: {
  allMessages: ChatMessage[];
  historyLoading: boolean;
  selectedFeedWindowEnabled: boolean;
  selectedFeedWindow: ThreadWindowState | null;
  selectedFeedWindowMessages: ChatMessage[];
  retainedMessageIds?: ReadonlySet<string>;
}): ChatMessage[] {
  if (!input.selectedFeedWindowEnabled) return input.historyLoading ? [] : input.allMessages;
  if (!input.selectedFeedWindow) {
    return input.allMessages.filter((message) => typeof message.historyIndex !== "number" || message.historyIndex < 0);
  }

  const seen = new Set<string>();
  const merged: ChatMessage[] = [];
  for (const message of input.selectedFeedWindowMessages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  for (const message of input.allMessages) {
    if (seen.has(message.id)) continue;
    if (typeof message.historyIndex === "number" && message.historyIndex >= 0) {
      if (
        message.historyIndex < input.selectedFeedWindow.source_history_length &&
        !input.retainedMessageIds?.has(message.id)
      ) {
        continue;
      }
    }
    seen.add(message.id);
    merged.push(message);
  }
  return merged.sort((a, b) => a.timestamp - b.timestamp);
}
