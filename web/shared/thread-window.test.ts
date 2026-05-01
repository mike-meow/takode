import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../server/session-types.js";
import { buildThreadWindowSync } from "./thread-window.js";

function user(id: string, content: string, threadKey?: string): BrowserIncomingMessage {
  return {
    type: "user_message",
    id,
    content,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    ...(threadKey ? { threadKey, questId: threadKey } : {}),
    ...(threadKey ? { threadRefs: [{ threadKey, questId: threadKey, source: "explicit" as const }] } : {}),
  };
}

function assistant(
  id: string,
  text: string,
  options: { threadKey?: string; toolUseId?: string; parentToolUseId?: string } = {},
): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude",
      content: options.toolUseId
        ? [
            { type: "text", text },
            { type: "tool_use", id: options.toolUseId, name: "Read", input: { file_path: "a.ts" } },
          ]
        : [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: options.parentToolUseId ?? null,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    ...(options.threadKey ? { threadKey: options.threadKey, questId: options.threadKey } : {}),
    ...(options.threadKey
      ? { threadRefs: [{ threadKey: options.threadKey, questId: options.threadKey, source: "explicit" as const }] }
      : {}),
  };
}

describe("thread window hydration", () => {
  it("returns bounded selected quest feed items with tool closure context", () => {
    const history = [
      user("u1", "unrelated", "q-2"),
      user("u2", "quest request", "q-1"),
      assistant("a3", "using a tool", { threadKey: "q-1", toolUseId: "tool-1" }),
      assistant("a4", "tool result follow-up", { parentToolUseId: "tool-1" }),
      user("u5", "also unrelated", "q-3"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sync.threadKey).toBe("q-1");
    expect(sync.window.total_items).toBe(3);
    expect(
      sync.entries.map((entry) => (entry.message.type === "assistant" ? entry.message.message.id : entry.message.id)),
    ).toEqual(["u2", "a3", "a4"]);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([1, 2, 3]);
  });

  it("expands tool closure context across requested quest window boundaries", () => {
    const history = [
      assistant("a1", "using a tool", { threadKey: "q-1", toolUseId: "tool-1" }),
      {
        type: "tool_result_preview",
        previews: [
          {
            tool_use_id: "tool-1",
            content: "preview",
            is_error: false,
            total_size: 7,
            is_truncated: false,
          },
        ],
      },
      assistant("a2", "tool result follow-up", { parentToolUseId: "tool-1" }),
    ] satisfies BrowserIncomingMessage[];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.window.item_count).toBe(1);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2]);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["assistant", "tool_result_preview", "assistant"]);
  });

  it("preserves current Main feed semantics without returning quest-thread messages", () => {
    const history = [
      user("u1", "main request"),
      user("u2", "quest request", "q-1"),
      assistant("a3", "quest reply", { threadKey: "q-1" }),
      user("u4", "main follow-up"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(
      sync.entries.map((entry) => (entry.message.type === "assistant" ? entry.message.message.id : entry.message.id)),
    ).toEqual(["u1", "u4"]);
  });

  it("uses Main cross-thread markers for non-quest hidden activity", () => {
    const history = [
      user("u1", "main request"),
      user("u2", "side thread", "project-notes"),
      assistant("a3", "side reply", { threadKey: "project-notes" }),
      user("u4", "quest request", "q-1"),
      assistant("a5", "quest reply", { threadKey: "q-1" }),
      user("u6", "main follow-up"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sync.entries.map((entry) => entry.message.type)).toEqual([
      "user_message",
      "cross_thread_activity_marker",
      "user_message",
    ]);
    expect(sync.entries[1]?.message).toEqual(
      expect.objectContaining({
        type: "cross_thread_activity_marker",
        threadKey: "project-notes",
        count: 2,
      }),
    );
  });

  it("uses matching rendered feed items as the window unit for large histories", () => {
    const history: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 1_000; i++) {
      history.push(user(`u${i}`, `message ${i}`, i % 100 === 0 ? "q-1" : "q-2"));
    }

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: -1,
      itemCount: 3,
      sectionItemCount: 3,
      visibleItemCount: 1,
    });

    expect(sync.window.source_history_length).toBe(1_000);
    expect(sync.window.total_items).toBe(10);
    expect(sync.entries).toHaveLength(3);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([700, 800, 900]);
  });
});
