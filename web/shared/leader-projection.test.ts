import { describe, expect, it } from "vitest";
import {
  buildLeaderProjectionSnapshot,
  buildLeaderThreadRowsFromSummaries,
  collectLeaderThreadSummaries,
  mergeLeaderThreadSummaries,
} from "./leader-projection.js";
import type { BrowserIncomingMessage, ContentBlock } from "../server/session-types.js";

function assistantMessage(id: string, content: ContentBlock[], timestamp: number): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude",
      content,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    timestamp,
  } as BrowserIncomingMessage;
}

describe("leader projection summaries", () => {
  it("derives thread summaries from direct refs, text prefixes, Bash comments, and handoff markers", () => {
    // This protects the leader navigation parity cases that used to come from
    // ChatView scans over the raw message array.
    const messages: BrowserIncomingMessage[] = [
      {
        type: "user_message",
        id: "u1",
        content: "Direct quest thread",
        timestamp: 1,
        threadRefs: [{ threadKey: "q-100", questId: "q-100", source: "explicit" }],
      } as BrowserIncomingMessage,
      {
        type: "user_message",
        id: "u2",
        content: "[thread:q-101]\nRoute by prefix",
        timestamp: 2,
      } as BrowserIncomingMessage,
      assistantMessage(
        "a1",
        [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: { command: "# thread:q-102\nquest show q-102" },
          },
        ],
        3,
      ),
      {
        type: "thread_attachment_marker",
        id: "marker-1",
        markerKey: "move-q-103",
        timestamp: 4,
        sourceThreadKey: "main",
        threadKey: "q-103",
        questId: "q-103",
        attachedAt: 4,
        attachedBy: "leader",
        messageIds: ["u2"],
        messageIndices: [1],
        ranges: ["1"],
        count: 1,
      } as BrowserIncomingMessage,
      {
        type: "thread_transition_marker",
        id: "transition-1",
        markerKey: "continue-q-104",
        timestamp: 5,
        sourceThreadKey: "q-103",
        sourceQuestId: "q-103",
        threadKey: "q-104",
        questId: "q-104",
        transitionedAt: 5,
        reason: "route_switch",
      } as BrowserIncomingMessage,
    ];

    const summaries = collectLeaderThreadSummaries(messages);
    expect(summaries.map((summary) => summary.threadKey)).toEqual(["q-100", "q-101", "q-102", "q-103", "q-104"]);
    expect(summaries.find((summary) => summary.threadKey === "q-103")).toMatchObject({
      questId: "q-103",
      messageCount: 2,
      firstMessageAt: 4,
      lastMessageAt: 5,
    });
  });

  it("builds board-backed rows and message-derived attention without feed hydration", () => {
    // Projection summaries should provide navigation and attention metadata,
    // while leaving selected-thread feed windows to later work.
    const snapshot = buildLeaderProjectionSnapshot({
      leaderSessionId: "leader-1",
      messageHistory: [
        {
          type: "user_message",
          id: "u-rework",
          content: "Please ask the agent to fix the rough edge.",
          timestamp: 10,
          threadRefs: [{ threadKey: "q-200", questId: "q-200", source: "explicit" }],
        } as BrowserIncomingMessage,
      ],
      activeBoard: [
        { questId: "q-200", title: "Projection summaries", status: "IMPLEMENT", createdAt: 1, updatedAt: 2 },
      ],
      notifications: [
        {
          id: "n-1",
          category: "needs-input",
          summary: "Worker has a question",
          suggestedAnswers: [],
          timestamp: 20,
          messageId: null,
          threadKey: "q-200",
          questId: "q-200",
          done: false,
        },
      ],
    });

    expect(snapshot.sourceHistoryLength).toBe(1);
    expect(snapshot.rawTurnBoundaries).toEqual([{ turnIndex: 0, startHistoryIndex: 0, endHistoryIndex: null }]);
    expect(snapshot.threadRows).toEqual([
      expect.objectContaining({
        threadKey: "q-200",
        title: "Projection summaries",
        messageCount: 1,
        section: "active",
      }),
    ]);
    expect(snapshot.workBoardThreadRows).toEqual([
      expect.objectContaining({ threadKey: "q-200", title: "Projection summaries", messageCount: 1 }),
    ]);
    expect(snapshot.messageAttentionRecords).toEqual([
      expect.objectContaining({ id: "message-rework:u-rework", type: "quest_reopened_or_rework" }),
    ]);
    expect(snapshot.attentionRecords.map((record) => record.id)).toEqual([
      "message-rework:u-rework",
      "notification:n-1",
    ]);
  });

  it("merges projection summaries with only post-projection live messages", () => {
    // Cold windows may overlap the projection's raw history. Only messages
    // appended after the projection source length should extend the summary.
    const projected = [{ threadKey: "q-300", questId: "q-300", messageCount: 100, firstMessageAt: 1 }];
    const windowSummaries = collectLeaderThreadSummaries(
      [
        {
          id: "old",
          role: "assistant",
          content: "old",
          timestamp: 2,
          historyIndex: 50,
          metadata: { threadRefs: [{ threadKey: "q-300", questId: "q-300", source: "explicit" }] },
        },
        {
          id: "new",
          role: "assistant",
          content: "new",
          timestamp: 3,
          historyIndex: 101,
          metadata: { threadRefs: [{ threadKey: "q-301", questId: "q-301", source: "explicit" }] },
        },
      ].filter((message) => typeof message.historyIndex !== "number" || message.historyIndex >= 101),
    );

    const rows = buildLeaderThreadRowsFromSummaries({
      threadSummaries: mergeLeaderThreadSummaries(projected, windowSummaries),
      quests: [
        { questId: "q-300", title: "Existing projected thread", status: "in_progress", createdAt: 1 },
        { questId: "q-301", title: "Live thread", status: "in_progress", createdAt: 3 },
      ],
    });

    expect(rows.map((row) => [row.threadKey, row.messageCount])).toEqual([
      ["q-300", 100],
      ["q-301", 1],
    ]);
  });

  it("summarizes a large leader history without retaining raw feed messages in the projection", () => {
    // Large-session regression guard for the cold-load class: summaries scale
    // with threads, not with every raw message object being sent again.
    const messages: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 2_500; i++) {
      const questId = `q-${1000 + (i % 25)}`;
      messages.push({
        type: "user_message",
        id: `u-${i}`,
        content: `work item ${i}`,
        timestamp: i,
        threadRefs: [{ threadKey: questId, questId, source: "explicit" }],
      } as BrowserIncomingMessage);
    }

    const snapshot = buildLeaderProjectionSnapshot({ leaderSessionId: "leader-large", messageHistory: messages });

    expect(snapshot.sourceHistoryLength).toBe(2_500);
    expect(snapshot.threadSummaries).toHaveLength(25);
    expect(snapshot.threadRows).toHaveLength(25);
    expect(JSON.stringify(snapshot)).not.toContain("work item 2499");
  });
});
