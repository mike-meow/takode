import { describe, expect, it } from "vitest";
import type { ChatMessage, ThreadWindowState } from "../types.js";
import { composeSelectedFeedMessages } from "./thread-window-messages.js";

function message(id: string, timestamp: number, historyIndex?: number): ChatMessage {
  return {
    id,
    role: "system",
    content: id,
    timestamp,
    ...(historyIndex === undefined ? {} : { historyIndex }),
  };
}

function windowState(overrides: Partial<ThreadWindowState> = {}): ThreadWindowState {
  return {
    thread_key: "q-1040",
    from_item: 0,
    item_count: 1,
    total_items: 10,
    source_history_length: 100,
    section_item_count: 5,
    visible_item_count: 2,
    ...overrides,
  };
}

describe("composeSelectedFeedMessages", () => {
  it("does not derive selected feeds from raw cold-window history before a thread window arrives", () => {
    const messages = composeSelectedFeedMessages({
      allMessages: [message("historical-overlap", 1, 42), message("live-marker", 2, -1), message("local-message", 3)],
      historyLoading: false,
      selectedFeedWindowEnabled: true,
      selectedFeedWindow: null,
      selectedFeedWindowMessages: [],
    });

    expect(messages.map((item) => item.id)).toEqual(["live-marker", "local-message"]);
  });

  it("merges installed thread windows with post-window live messages without replaying raw overlap", () => {
    const messages = composeSelectedFeedMessages({
      allMessages: [
        message("raw-overlap", 10, 60),
        message("live-marker", 30, -1),
        message("post-window-history", 40, 100),
      ],
      historyLoading: false,
      selectedFeedWindowEnabled: true,
      selectedFeedWindow: windowState({ source_history_length: 100 }),
      selectedFeedWindowMessages: [message("window-message", 20, 90)],
    });

    expect(messages.map((item) => item.id)).toEqual(["window-message", "live-marker", "post-window-history"]);
  });

  it("keeps existing raw-history composition when selected feed windows are disabled", () => {
    const allMessages = [message("raw", 1, 0)];

    expect(
      composeSelectedFeedMessages({
        allMessages,
        historyLoading: false,
        selectedFeedWindowEnabled: false,
        selectedFeedWindow: null,
        selectedFeedWindowMessages: [],
      }),
    ).toBe(allMessages);
  });
});
