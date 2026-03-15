import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage, ChatMessage } from "../src/types.js";
import { computeChatMessagesSyncHash, computeHistoryMessagesSyncHash } from "./history-sync-hash.js";

describe("history-sync-hash", () => {
  it("matches equivalent history and chat message views", () => {
    const history: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
      {
        type: "assistant",
        message: {
          id: "a1",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-20250514",
          content: [{ type: "text", text: "reply" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2000,
      },
      {
        type: "permission_approved",
        id: "p1",
        request_id: "req-1",
        summary: "Approved Bash",
        timestamp: 3000,
        answers: [{ question: "Q", answer: "A" }],
      },
      {
        type: "result",
        data: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["boom"],
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          session_id: "s1",
          uuid: "r1",
          stop_reason: "end_turn",
        },
      },
    ];

    const chatMessages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello", timestamp: 1000 },
      {
        id: "a1",
        role: "assistant",
        content: "reply",
        contentBlocks: [{ type: "text", text: "reply" }],
        timestamp: 2000,
        parentToolUseId: null,
        model: "claude-opus-4-20250514",
        stopReason: "end_turn",
      },
      {
        id: "p1",
        role: "system",
        content: "Approved Bash",
        timestamp: 3000,
        variant: "approved",
        metadata: { answers: [{ question: "Q", answer: "A" }] },
      },
      {
        id: "hist-error-3",
        role: "system",
        content: "Error: boom",
        timestamp: 9999,
        variant: "error",
      },
    ];

    expect(computeHistoryMessagesSyncHash(history).hash).toBe(computeChatMessagesSyncHash(chatMessages));
  });

  it("changes when semantic content changes", () => {
    const base: ChatMessage[] = [{ id: "u1", role: "user", content: "hello", timestamp: 1000 }];
    const changed: ChatMessage[] = [{ id: "u1", role: "user", content: "goodbye", timestamp: 1000 }];

    expect(computeChatMessagesSyncHash(base)).toBe(computeChatMessagesSyncHash(changed));
  });

  it("falls back to semantic hashing when only a synthesized id exists", () => {
    const base: ChatMessage[] = [
      { id: "hist-error-3", role: "system", content: "Error: boom", timestamp: 1000, variant: "error" },
    ];
    const changed: ChatMessage[] = [
      { id: "hist-error-3", role: "system", content: "Error: different", timestamp: 1000, variant: "error" },
    ];

    expect(computeChatMessagesSyncHash(base)).not.toBe(computeChatMessagesSyncHash(changed));
  });

  it("matches compact markers across history and normalized chat messages", () => {
    const history: BrowserIncomingMessage[] = [
      {
        type: "compact_marker",
        id: "compact-boundary-1",
        timestamp: 123,
        summary: "Conversation compacted to summary",
      },
    ];

    const chatMessages: ChatMessage[] = [
      {
        id: "compact-boundary-1",
        role: "system",
        content: "Conversation compacted to summary",
        timestamp: 123,
        variant: "info",
      },
    ];

    expect(computeHistoryMessagesSyncHash(history).hash).toBe(computeChatMessagesSyncHash(chatMessages));
  });

  it("matches synthesized history error rows across history and normalized chat messages", () => {
    const history: BrowserIncomingMessage[] = [
      {
        type: "result",
        data: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["boom"],
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          session_id: "s1",
          uuid: "r1",
          stop_reason: "end_turn",
        },
      },
    ];

    const chatMessages: ChatMessage[] = [
      {
        id: "hist-error-0",
        role: "system",
        content: "Error: boom",
        timestamp: 9999,
        variant: "error",
      },
    ];

    expect(computeHistoryMessagesSyncHash(history).hash).toBe(computeChatMessagesSyncHash(chatMessages));
  });

  it("matches legacy user history rows without ids once normalized deterministically", () => {
    const history: BrowserIncomingMessage[] = [{ type: "user_message", content: "legacy user row", timestamp: 1234 }];

    const chatMessages: ChatMessage[] = [
      {
        id: "hist-user-0",
        role: "user",
        content: "legacy user row",
        timestamp: 1234,
      },
    ];

    expect(computeHistoryMessagesSyncHash(history).hash).toBe(computeChatMessagesSyncHash(chatMessages));
  });
});
