import { describe, expect, it, vi } from "vitest";
import type { BrowserIncomingMessage } from "../types.js";
import { normalizeHistoryMessageToChatMessages } from "./history-message-normalization.js";

describe("normalizeHistoryMessageToChatMessages", () => {
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
        variant: "approved",
        metadata: {
          answers: [{ question: "Proceed?", answer: "Yes" }],
        },
      },
    ]);
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
        variant: "task_completed",
      },
    ]);
    now.mockRestore();
  });
});
