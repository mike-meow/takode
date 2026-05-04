import { describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage } from "../types.js";
import { normalizeHistoryMessageToChatMessages } from "./history-message-normalization.js";

describe("normalizeHistoryMessageToChatMessages", () => {
  it("stores the raw messageHistory index on visible user and assistant messages", () => {
    // Message links use this raw index so `#/session/123/msg/N` matches
    // Takode CLI reads even when non-rendered history entries exist.
    const user = normalizeHistoryMessageToChatMessages(
      { type: "user_message", id: "u1", content: "Prompt", timestamp: 100 },
      3,
    )[0]!;
    const assistant = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "Answer" }],
        },
      },
      5,
    )[0]!;

    expect(user.historyIndex).toBe(3);
    expect(assistant.historyIndex).toBe(5);
  });

  it("preserves explicit reply metadata on user messages", () => {
    const user = normalizeHistoryMessageToChatMessages(
      {
        type: "user_message",
        id: "u-reply",
        content: "Continue the work",
        replyContext: { previewText: "Original answer", messageId: "msg-1" },
        timestamp: 100,
      },
      3,
    )[0]!;

    expect(user.content).toBe("Continue the work");
    expect(user.metadata?.replyContext).toEqual({ previewText: "Original answer", messageId: "msg-1" });
  });

  it("can expose successful result messages for preview-only callers", () => {
    // Preview callers opt into this path so hover cards can show successful
    // `result` text while the main session feed still omits non-error results.
    const now = vi.spyOn(Date, "now").mockReturnValue(123456);
    const message: BrowserIncomingMessage = {
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Linked result body",
        duration_ms: 10,
        duration_api_ms: 5,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: null,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "result-1",
        session_id: "session-1",
      },
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 9, {
      includeSuccessfulResult: true,
      fallbackTimestamp: 999,
    });

    expect(normalized).toEqual([
      {
        id: "hist-result-9",
        role: "assistant",
        content: "Linked result body",
        timestamp: 999,
        historyIndex: 9,
      },
    ]);
    now.mockRestore();
  });

  it("preserves approved variant metadata for permission_approved messages", () => {
    const message: BrowserIncomingMessage = {
      type: "permission_approved",
      id: "perm-1",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      summary: "Approved Bash",
      timestamp: 1000,
      request_id: "req-1",
      answers: [{ question: "Proceed?", answer: "Yes" }],
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 7);

    expect(normalized).toEqual([
      {
        id: "perm-1",
        role: "system",
        content: "Approved Bash",
        timestamp: 1000,
        historyIndex: 7,
        variant: "approved",
        metadata: {
          answers: [{ question: "Proceed?", answer: "Yes" }],
        },
      },
    ]);
  });

  it("normalizes thread attachment markers into compact system messages", () => {
    // Attachment markers are persisted in messageHistory and drive Main
    // projection display while keeping the raw marker available to UI filters.
    const message: BrowserIncomingMessage = {
      type: "thread_attachment_marker",
      id: "marker-q-941",
      timestamp: 1234,
      markerKey: "thread-attachment:q-941:m1,m2",
      threadKey: "q-941",
      questId: "q-941",
      attachedAt: 1234,
      attachedBy: "session-1",
      messageIds: ["m1", "m2"],
      messageIndices: [1, 2],
      ranges: ["1-2"],
      count: 2,
      firstMessageId: "m1",
      firstMessageIndex: 1,
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 9);

    expect(normalized).toEqual([
      {
        id: "marker-q-941",
        role: "system",
        content: "2 messages moved to q-941",
        timestamp: 1234,
        historyIndex: 9,
        variant: "info",
        metadata: { threadAttachmentMarker: message },
      },
    ]);
  });

  it("normalizes thread transition markers into handoff system messages", () => {
    const message: BrowserIncomingMessage = {
      type: "thread_transition_marker",
      id: "transition-q-940-q-941",
      timestamp: 1235,
      markerKey: "thread-transition:q-940->q-941:7",
      sourceThreadKey: "q-940",
      sourceQuestId: "q-940",
      threadKey: "q-941",
      questId: "q-941",
      transitionedAt: 1235,
      reason: "route_switch",
      sourceMessageIndex: 7,
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 10);

    expect(normalized).toEqual([
      {
        id: "transition-q-940-q-941",
        role: "system",
        content: "Work continued from thread:q-940 to thread:q-941",
        timestamp: 1235,
        historyIndex: 10,
        variant: "info",
        metadata: { threadTransitionMarker: message },
      },
    ]);
  });

  it("uses compact audit summaries for cross-thread activity markers when provided", () => {
    const message: BrowserIncomingMessage = {
      type: "cross_thread_activity_marker",
      id: "thread-attach-audit:q-941:a1:m1",
      timestamp: 1236,
      threadKey: "q-941",
      questId: "q-941",
      count: 1,
      activityKind: "thread_attach",
      attachedCount: 4,
      summary: "Thread attach command added 4 Main messages to thread:q-941",
      firstMessageId: "a1",
      lastMessageId: "m1",
      firstHistoryIndex: 7,
      lastHistoryIndex: 8,
      startedAt: 1235,
      updatedAt: 1236,
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 8);

    expect(normalized).toEqual([
      {
        id: "thread-attach-audit:q-941:a1:m1",
        role: "system",
        content: "Thread attach command added 4 Main messages to thread:q-941",
        timestamp: 1236,
        historyIndex: 8,
        ephemeral: true,
        metadata: {
          threadKey: "q-941",
          questId: "q-941",
          crossThreadActivityMarker: {
            threadKey: "q-941",
            questId: "q-941",
            count: 1,
            activityKind: "thread_attach",
            attachedCount: 4,
            summary: "Thread attach command added 4 Main messages to thread:q-941",
            firstMessageId: "a1",
            lastMessageId: "m1",
            firstHistoryIndex: 7,
            lastHistoryIndex: 8,
            startedAt: 1235,
            updatedAt: 1236,
          },
        },
      },
    ]);
  });

  it("replays leader user-visible messages as assistant Markdown", () => {
    const message: BrowserIncomingMessage = {
      type: "leader_user_message",
      id: "leader-user-1",
      content: "**Visible** leader update",
      timestamp: 2000,
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 11);

    expect(normalized).toEqual([
      {
        id: "leader-user-1",
        role: "assistant",
        content: "**Visible** leader update",
        timestamp: 2000,
        historyIndex: 11,
        metadata: { leaderUserMessage: true },
      },
    ]);
  });

  it("repairs persisted assistant thread prefixes in newline form", () => {
    // Older persisted history may contain the raw marker without routing
    // metadata. History sync repairs that so quest threads project correctly.
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-newline",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:q-941]\nImplementation update" }],
        },
      },
      12,
    )[0]!;

    expect(normalized.content).toBe("Implementation update");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "Implementation update" }]);
    expect(normalized.metadata).toMatchObject({
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
  });

  it("repairs persisted assistant thread prefixes in same-line form", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-same-line",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:q-941] Same-line update" }],
        },
      },
      13,
    )[0]!;

    expect(normalized.content).toBe("Same-line update");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "Same-line update" }]);
    expect(normalized.metadata).toMatchObject({
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
  });

  it("leaves no-space same-line quest thread prefixes unrepaired", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-no-space",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:q-941]Implementation update" }],
        },
      },
      14,
    )[0]!;

    expect(normalized.content).toBe("[thread:q-941]Implementation update");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "[thread:q-941]Implementation update" }]);
    expect(normalized.metadata).toBeUndefined();
  });

  it("hides persisted main thread markers without adding a quest projection", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-main",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:main] General update" }],
        },
      },
      14,
    )[0]!;

    expect(normalized.content).toBe("General update");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "General update" }]);
    expect(normalized.metadata).toEqual({ threadKey: "main" });
  });

  it("leaves no-space same-line main thread prefixes unrepaired", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-main-no-space",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "text", text: "[thread:main]Using quest workflow" }],
        },
      },
      15,
    )[0]!;

    expect(normalized.content).toBe("[thread:main]Using quest workflow");
    expect(normalized.contentBlocks).toEqual([{ type: "text", text: "[thread:main]Using quest workflow" }]);
    expect(normalized.metadata).toBeUndefined();
  });

  it("repairs persisted Bash command thread comments as tool routing metadata", () => {
    // Tool calls use shell-comment routing syntax, not chat text prefixes. Older
    // persisted tool-use-only messages may need this repair after history sync.
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-bash-command",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:q-941\npwd" } }],
        },
      },
      16,
    )[0]!;

    expect(normalized.contentBlocks).toEqual([
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
    ]);
    expect(normalized.metadata).toMatchObject({
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
  });

  it("repairs persisted main Bash command comments without adding a quest projection", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-main-bash-command",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:main\npwd" } }],
        },
      },
      17,
    )[0]!;

    expect(normalized.contentBlocks).toEqual([
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
    ]);
    expect(normalized.metadata).toEqual({ threadKey: "main" });
  });

  it("does not repair non-standalone Bash command comments", () => {
    const normalized = normalizeHistoryMessageToChatMessages(
      {
        type: "assistant",
        timestamp: 200,
        parent_tool_use_id: null,
        message: {
          id: "a-thread-inline-bash-comment",
          type: "message",
          role: "assistant",
          model: "claude-test",
          stop_reason: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:q-941 && pwd" } }],
        },
      },
      18,
    )[0]!;

    expect(normalized.contentBlocks).toEqual([
      { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "# thread:q-941 && pwd" } },
    ]);
    expect(normalized.metadata).toBeUndefined();
  });

  it("matches replay semantics for visible task_notification messages", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123456);
    const message: BrowserIncomingMessage = {
      type: "task_notification",
      status: "completed",
      task_id: "task-1",
      summary: "Background task finished",
      tool_use_id: "tool-1",
      output_file: "/tmp/out.txt",
    };

    const normalized = normalizeHistoryMessageToChatMessages(message, 4);

    expect(normalized).toEqual([
      {
        id: "task-notif-task-1",
        role: "system",
        content: "Background task finished",
        timestamp: 123456,
        historyIndex: 4,
        variant: "task_completed",
      },
    ]);
    now.mockRestore();
  });
});
