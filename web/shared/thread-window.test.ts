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

function bashAssistant(
  id: string,
  command: string,
  options: { threadKey?: string; toolUseId: string },
): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude",
      content: [
        { type: "text", text: "running shell command" },
        { type: "tool_use", id: options.toolUseId, name: "Bash", input: { command } },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
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

function transitionMarker(overrides: {
  id: string;
  sourceThreadKey: string;
  threadKey: string;
}): BrowserIncomingMessage {
  return {
    type: "thread_transition_marker",
    id: overrides.id,
    timestamp: 3,
    markerKey: `thread-transition:${overrides.sourceThreadKey}->${overrides.threadKey}:0`,
    sourceThreadKey: overrides.sourceThreadKey,
    ...(overrides.sourceThreadKey === "main" ? {} : { sourceQuestId: overrides.sourceThreadKey }),
    threadKey: overrides.threadKey,
    questId: overrides.threadKey,
    transitionedAt: 3,
    reason: "route_switch",
  };
}

function toolResultPreview(toolUseId: string, content = "preview"): BrowserIncomingMessage {
  return {
    type: "tool_result_preview",
    previews: [
      {
        tool_use_id: toolUseId,
        content,
        is_error: false,
        total_size: content.length,
        is_truncated: false,
      },
    ],
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

  it("keeps q-thread tool result previews out of Main while preserving them in the quest thread", () => {
    const history = [
      user("u1", "main request"),
      assistant("a2", "quest tool", { threadKey: "q-1119", toolUseId: "tool-q" }),
      toolResultPreview("tool-q", "quest preview"),
      user("u4", "main follow-up"),
    ];

    const mainSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const questSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1119",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(mainSync.entries.map((entry) => entry.history_index)).toEqual([0, 3]);
    expect(mainSync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "user_message"]);
    expect(questSync.entries.map((entry) => entry.history_index)).toEqual([1, 2]);
    expect(questSync.entries.map((entry) => entry.message.type)).toEqual(["assistant", "tool_result_preview"]);
  });

  it("preserves Main previews for visible and orphaned tools", () => {
    const visibleMainHistory = [
      assistant("a1", "main tool", { toolUseId: "tool-main" }),
      toolResultPreview("tool-main", "main preview"),
    ];
    const orphanHistory = [toolResultPreview("tool-orphan", "orphan preview")];

    const visibleMainSync = buildThreadWindowSync({
      messageHistory: visibleMainHistory,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const orphanSync = buildThreadWindowSync({
      messageHistory: orphanHistory,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(visibleMainSync.entries.map((entry) => entry.message.type)).toEqual(["assistant", "tool_result_preview"]);
    expect(orphanSync.entries.map((entry) => entry.message.type)).toEqual(["tool_result_preview"]);
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

  it("surfaces a compact Main audit row for q-routed thread attach commands that attach Main source messages", () => {
    const attachedMainMessage = {
      ...user("u6211", "Main follow-up with screenshot context"),
      threadRefs: [{ threadKey: "q-1152", questId: "q-1152", source: "backfill" as const }],
    };
    const attachedMainTool = {
      ...assistant("a6212", "viewing attached screenshot", { toolUseId: "tool-view-image" }),
      threadRefs: [{ threadKey: "q-1152", questId: "q-1152", source: "backfill" as const }],
    };
    const mainToQuest = transitionMarker({
      id: "transition-main-q1152",
      sourceThreadKey: "main",
      threadKey: "q-1152",
    });
    const attachCommand = bashAssistant(
      "a6224",
      "# thread:q-1152\nquest feedback add q-1152 --text-file /tmp/body.md && takode thread attach q-1152 --turn 417",
      { threadKey: "q-1152", toolUseId: "tool-attach-q1152" },
    );
    const marker = attachmentMarker({
      id: "marker-q1152-main-source",
      threadKey: "q-1152",
      questId: "q-1152",
      count: 4,
      messageIds: ["u6211", "a6212", "history-2", "transition-main-q1152"],
      messageIndices: [0, 1, 2, 3],
      ranges: ["0-3"],
      firstMessageId: "u6211",
      firstMessageIndex: 0,
    });
    const futureQuestTool = bashAssistant("a6230", "# thread:q-1152\nquest status q-1152", {
      threadKey: "q-1152",
      toolUseId: "tool-future-q1152",
    });
    const history = [
      attachedMainMessage,
      attachedMainTool,
      toolResultPreview("tool-view-image", "screenshot opened"),
      mainToQuest,
      attachCommand,
      toolResultPreview("tool-attach-q1152", "Attached 6211, 6212, 6213, 6214 to q-1152"),
      marker,
      futureQuestTool,
      toolResultPreview("tool-future-q1152", "quest status output"),
      user("u6232", "Main continues after manual nudge"),
    ];

    const mainSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const questSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1152",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(mainSync.entries.map((entry) => entry.history_index)).toEqual([0, 1, 2, 3, 4, 9]);
    expect(mainSync.entries.map((entry) => entry.message.type)).toEqual([
      "user_message",
      "assistant",
      "tool_result_preview",
      "thread_transition_marker",
      "cross_thread_activity_marker",
      "user_message",
    ]);
    expect(mainSync.entries[4]?.message).toEqual(
      expect.objectContaining({
        type: "cross_thread_activity_marker",
        activityKind: "thread_attach",
        threadKey: "q-1152",
        attachedCount: 4,
        summary: "Thread attach command added 4 Main messages to thread:q-1152",
      }),
    );
    expect(mainSync.entries.some((entry) => entry.message.type === "thread_attachment_marker")).toBe(false);
    expect(mainSync.entries.some((entry) => entry.message === futureQuestTool)).toBe(false);
    expect(
      mainSync.entries.some(
        (entry) =>
          entry.message.type === "tool_result_preview" &&
          entry.message.previews.some((preview) => preview.tool_use_id === "tool-attach-q1152"),
      ),
    ).toBe(false);

    expect(questSync.entries).toContainEqual(expect.objectContaining({ history_index: 4, message: attachCommand }));
    expect(questSync.entries).toContainEqual(expect.objectContaining({ history_index: 5 }));
    expect(questSync.entries).toContainEqual(expect.objectContaining({ history_index: 7, message: futureQuestTool }));
    expect(questSync.entries.some((entry) => entry.message.type === "cross_thread_activity_marker")).toBe(false);
  });

  it("does not add a Main attach audit row for q-routed thread attach commands that attach another quest source", () => {
    const sourceQuestMessage = {
      ...user("u1", "source quest context", "q-1140"),
      threadRefs: [
        { threadKey: "q-1140", questId: "q-1140", source: "explicit" as const },
        { threadKey: "q-1152", questId: "q-1152", source: "backfill" as const },
      ],
    };
    const attachCommand = bashAssistant("a2", "# thread:q-1152\ntakode thread attach q-1152 --turn 417", {
      threadKey: "q-1152",
      toolUseId: "tool-attach-q-source",
    });
    const history = [
      user("u0", "main request"),
      sourceQuestMessage,
      attachCommand,
      attachmentMarker({
        id: "marker-q1152-source-quest",
        threadKey: "q-1152",
        questId: "q-1152",
        sourceThreadKey: "q-1140",
        sourceQuestId: "q-1140",
        messageIds: ["u1"],
        messageIndices: [1],
        ranges: ["1"],
        count: 1,
        firstMessageId: "u1",
        firstMessageIndex: 1,
      }),
      user("u4", "main tail"),
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([0, 4]);
    expect(sync.entries.some((entry) => entry.message.type === "cross_thread_activity_marker")).toBe(false);
  });

  it("retains Main attachment sources for a latest window without hydrating marker rows", () => {
    const attachedMain = {
      ...user("u2", "old Main context attached to q-1"),
      threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "backfill" as const }],
    };
    const futureQuestOnly = user("u3", "future q-1-only reply", "q-1");
    const marker = attachmentMarker({
      id: "marker-q1-late",
      timestamp: 4,
      messageIds: ["u2", "u3"],
      messageIndices: [1, 2],
      ranges: ["1-2"],
      count: 2,
      firstMessageId: "u2",
      firstMessageIndex: 1,
    });
    const history = [user("u1", "main request"), attachedMain, futureQuestOnly, marker, user("u5", "main follow-up")];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([1, 4]);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "user_message"]);
    expect(sync.entries.some((entry) => entry.message.type === "thread_attachment_marker")).toBe(false);
    expect(sync.entries.some((entry) => entry.message.type === "cross_thread_activity_marker")).toBe(false);
  });

  it("retains Main attachment sources when the suppressed marker is appended after the latest Main item", () => {
    const attachedMain = {
      ...user("u2", "old Main source attached to q-1"),
      threadRefs: [{ threadKey: "q-1", questId: "q-1", source: "backfill" as const }],
    };
    const futureQuestOnly = user("u4", "future q-1-only reply", "q-1");
    const marker = attachmentMarker({
      id: "marker-q1-tail",
      timestamp: 5,
      messageIds: ["u2", "u4"],
      messageIndices: [1, 3],
      ranges: ["1", "3"],
      count: 2,
      firstMessageId: "u2",
      firstMessageIndex: 1,
    });
    const history = [
      user("u1", "main request"),
      attachedMain,
      user("u3", "current Main tail"),
      futureQuestOnly,
      marker,
    ];

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: -1,
      itemCount: 1,
      sectionItemCount: 1,
      visibleItemCount: 1,
    });

    expect(sync.entries.map((entry) => entry.history_index)).toEqual([1, 2]);
    expect(sync.entries.map((entry) => entry.message.type)).toEqual(["user_message", "user_message"]);
    expect(sync.entries.some((entry) => entry.message.type === "thread_attachment_marker")).toBe(false);
    expect(sync.entries.some((entry) => (entry.message as { id?: string }).id === "u4")).toBe(false);
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

  it("scopes quest route-switch handoffs to affected thread windows", () => {
    const sourceToDestination = transitionMarker({
      id: "transition-q1139-q1141",
      sourceThreadKey: "q-1139",
      threadKey: "q-1141",
    });
    const unrelatedPair = transitionMarker({
      id: "transition-q1141-q1135",
      sourceThreadKey: "q-1141",
      threadKey: "q-1135",
    });
    const history = [
      user("u1", "source quest visible before handoff", "q-1139"),
      sourceToDestination,
      unrelatedPair,
      user("u4", "destination quest receives work", "q-1141"),
    ];

    const sourceSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1139",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const destinationSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1141",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const thirdThreadSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-1140",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    // Thread-window payloads are server-owned. This regression keeps route
    // transition rows local to the source/destination pair instead of letting
    // sibling quest transitions accumulate in unrelated selected feeds.
    expect(sourceSync.entries.map((entry) => entry.message)).toEqual([history[0], sourceToDestination]);
    expect(destinationSync.entries.map((entry) => entry.message)).toEqual([
      sourceToDestination,
      unrelatedPair,
      history[3],
    ]);
    expect(thirdThreadSync.entries).toEqual([]);
  });

  it("keeps Main-origin route-switch handoffs visible in the Main source window", () => {
    const mainToDestination = transitionMarker({
      id: "transition-main-q948",
      sourceThreadKey: "main",
      threadKey: "q-948",
    });
    const unrelatedPair = transitionMarker({
      id: "transition-q950-q951",
      sourceThreadKey: "q-950",
      threadKey: "q-951",
    });
    const history = [
      user("u1", "Please work on q-948"),
      assistant("a2", "Checking context", { toolUseId: "tool-view-image" }),
      toolResultPreview("tool-view-image", "Viewed screenshot"),
      mainToDestination,
      assistant("a5", "Continuing in the quest thread", { threadKey: "q-948" }),
      unrelatedPair,
    ];

    const mainSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "main",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const destinationSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-948",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });
    const thirdThreadSync = buildThreadWindowSync({
      messageHistory: history,
      threadKey: "q-949",
      fromItem: 0,
      itemCount: 10,
      sectionItemCount: 5,
      visibleItemCount: 2,
    });

    // This mirrors the producer-owned Main window shape for the production
    // feedback: a Main request can do local tool work before moving output into
    // a quest tab, and Main still needs the durable handoff marker.
    expect(mainSync.entries.map((entry) => entry.message)).toEqual([
      history[0],
      history[1],
      history[2],
      mainToDestination,
    ]);
    expect(destinationSync.entries.map((entry) => entry.message)).toEqual([mainToDestination, history[4]]);
    expect(thirdThreadSync.entries).toEqual([]);
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
