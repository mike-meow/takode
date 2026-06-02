import { describe, expect, it } from "vitest";
import {
  buildSlackThreadSeedPrompt,
  findRootAssistantAnchor,
  updateSlackThreadRecordFromChildHistory,
} from "./slack-thread-branches.js";
import type { BrowserIncomingMessage, SlackThreadRecord } from "./session-types.js";

function user(id: string, content: string): BrowserIncomingMessage {
  return { type: "user_message", id, content, timestamp: 1 };
}

function assistant(id: string, text: string, extra: Partial<BrowserIncomingMessage> = {}): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "test",
      content: [{ type: "text", text }],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
    timestamp: 1,
    uuid: id,
    session_id: "root",
    ...extra,
  } as BrowserIncomingMessage;
}

describe("slack thread branch helpers", () => {
  it("builds seed context through the anchor and excludes later root messages", () => {
    // The hidden child backend receives this seed as its isolated branch context.
    // Later root turns must not leak into the child prompt.
    const history = [
      user("u0", "Discuss architecture"),
      assistant("a1", "Option X is best"),
      user("u1", "Unrelated build logs"),
      assistant("a2", "Different topic"),
    ];

    const seed = buildSlackThreadSeedPrompt(history, 1, "a1");

    expect(seed).toContain("Discuss architecture");
    expect(seed).toContain("Option X is best");
    expect(seed).not.toContain("Unrelated build logs");
    expect(seed).not.toContain("Different topic");
    expect(seed).toContain("thread anchor");
  });

  it("accepts only root assistant anchors for v1 thread creation", () => {
    // v1 explicitly excludes nested threads and non-root thread projections.
    const root = findRootAssistantAnchor([assistant("a1", "Root reply")], "a1");
    const projected = findRootAssistantAnchor([assistant("a2", "Quest reply", { threadKey: "q-1" })], "a2");
    const child = findRootAssistantAnchor([assistant("a3", "Child reply", { slackThreadId: "st-1" } as any)], "a3");

    expect(root?.historyIndex).toBe(0);
    expect(projected).toBeNull();
    expect(child).toBeNull();
  });

  it("updates counts and preview from child session history", () => {
    // Counts come from the server-owned hidden child history, not local UI state.
    const record: SlackThreadRecord = {
      id: "st-1",
      rootSessionId: "root",
      childSessionId: "child",
      anchorMessageId: "a1",
      anchorHistoryIndex: 1,
      anchorPreview: "Option X",
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      seeded: true,
    };

    const updated = updateSlackThreadRecordFromChildHistory(record, [
      user("tu1", "Expand option X"),
      assistant("ta1", "More detail"),
    ]);

    expect(updated.messageCount).toBe(2);
    expect(updated.lastMessagePreview).toBe("More detail");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(record.updatedAt);
  });

  it("counts only browser-visible user and assistant thread messages, not result bookkeeping", () => {
    // Successful result records are backend turn bookkeeping. The root thread
    // summary should stay aligned with messages visible in the thread panel.
    const record: SlackThreadRecord = {
      id: "st-1",
      rootSessionId: "root",
      childSessionId: "child",
      anchorMessageId: "a1",
      anchorHistoryIndex: 1,
      anchorPreview: "Option X",
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      seeded: true,
    };

    const updated = updateSlackThreadRecordFromChildHistory(record, [
      user("tu1", "Expand option X"),
      assistant("ta1", "More detail"),
      {
        type: "result",
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Backend result text",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          uuid: "r1",
          session_id: "child",
        },
      },
    ]);

    expect(updated.messageCount).toBe(2);
    expect(updated.lastMessagePreview).toBe("More detail");
  });
});
