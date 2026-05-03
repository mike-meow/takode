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

function attachmentMarker(overrides: Partial<BrowserIncomingMessage> = {}): BrowserIncomingMessage {
  return {
    type: "thread_attachment_marker",
    id: "marker-q1",
    timestamp: 3,
    markerKey: "thread-attachment:q-1:u2",
    threadKey: "q-1",
    questId: "q-1",
    attachedAt: 3,
    attachedBy: "leader-1",
    messageIds: ["u2"],
    messageIndices: [1],
    ranges: ["1"],
    count: 1,
    firstMessageId: "u2",
    firstMessageIndex: 1,
    ...overrides,
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
    expect(sync.window.total_items).toBe(1);
    expect(sync.window.item_count).toBe(1);
    expect(
      sync.entries.map((entry) => (entry.message.type === "assistant" ? entry.message.message.id : entry.message.id)),
    ).toEqual(["u2", "a3", "a4"]);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([1, 2, 3]);
    expect(sync.window.has_older_items).toBe(false);
    expect(sync.window.has_newer_items).toBe(false);
  });

  it("uses thread-local conversation turns as the quest window unit", () => {
    const history = [
      user("u1", "quest request", "q-1"),
      assistant("a2", "small tool-only step", { threadKey: "q-1", toolUseId: "tool-1" }),
      assistant("a3", "tool result follow-up", { parentToolUseId: "tool-1" }),
      assistant("a4", "final answer", { threadKey: "q-1" }),
      user("u5", "second quest request", "q-1"),
      assistant("a6", "second answer", { threadKey: "q-1" }),
    ];

    const firstTurn = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(firstTurn.window.total_items).toBe(2);
    expect(firstTurn.window.item_count).toBe(1);
    expect(firstTurn.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2, 3]);
    expect(firstTurn.window.has_older_items).toBe(false);
    expect(firstTurn.window.has_newer_items).toBe(true);

    const secondTurn = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(secondTurn.window.total_items).toBe(2);
    expect(secondTurn.entries.map((entry) => entry.history_index)).toEqual([4, 5]);
    expect(secondTurn.window.has_older_items).toBe(true);
    expect(secondTurn.window.has_newer_items).toBe(false);
  });

  it("replays routed turn results into the thread-local conversation state", () => {
    const history = [
      user("u1", "quest request", "q-1"),
      assistant("a2", "quest work", { threadKey: "q-1" }),
      {
        type: "result",
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          session_id: "s1",
          total_cost_usd: 0,
          result: "done",
        },
      },
      user("u4", "main follow-up"),
    ] satisfies BrowserIncomingMessage[];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.window.total_items).toBe(1);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "assistant", "result"]);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2]);
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
    expect(sync.window.has_older_items).toBe(false);
    expect(sync.window.has_newer_items).toBe(false);
  });

  it("keeps newer availability when closure expansion does not cover every newer logical item", () => {
    const history = [
      assistant("a1", "using a tool", { threadKey: "q-1", toolUseId: "tool-1" }),
      user("u2", "intermediate quest message", "q-1"),
      assistant("a3", "tool result follow-up", { parentToolUseId: "tool-1" }),
      user("u4", "tail quest message", "q-1"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 2]);
    expect(sync.window.has_older_items).toBe(false);
    expect(sync.window.has_newer_items).toBe(true);
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

  it("keeps backfilled source messages visible in Main without rendering attachment markers", () => {
    const attachedMain = {
      ...user("u2", "main context attached to q-1"),
      threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "backfill" as const }],
    };
    const history = [user("u1", "main request"), attachedMain, attachmentMarker(), user("u4", "main follow-up")];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 3]);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "user_message", "user_message"]);
  });

  it("keeps source quest messages visible without rendering source attachment markers", () => {
    const sourceMessage = {
      ...user("u2", "source quest context", "q-2"),
      threadRefs: [
        { threadKey: "q-2", questId: "q-2", source: "explicit" as const },
        { threadKey: "q-1", questId: "q-1", source: "backfill" as const },
      ],
    };
    const history = [
      user("u1", "main request"),
      sourceMessage,
      attachmentMarker({ sourceThreadKey: "q-2", sourceQuestId: "q-2" }),
    ];

    const sourceSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-2",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const destinationSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sourceSync.entries.map((entry) => entry.history_index)).toEqual([1]);
    expect(destinationSync.entries.map((entry) => entry.history_index)).toEqual([1]);
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
    expect(sync.window.has_older_items).toBe(true);
    expect(sync.window.has_newer_items).toBe(false);
    expect(sync.entries).toHaveLength(3);
    expect(sync.entries.map((entry) => entry.history_index)).toEqual([700, 800, 900]);
  });
});
