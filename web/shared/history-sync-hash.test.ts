import { describe, expect, it } from "vitest";
import type { BrowserIncomingMessage } from "../src/types.js";
import { computeHistoryMessagesSyncHash, computeHistoryPrefixSyncHash } from "./history-sync-hash.js";

describe("history-sync-hash", () => {
  it("produces a deterministic hash for a mixed history", () => {
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

    const result = computeHistoryMessagesSyncHash(history);
    expect(result.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(result.renderedCount).toBe(4);
    expect(computeHistoryMessagesSyncHash(history).hash).toBe(result.hash);
  });

  it("produces different hashes when messages differ", () => {
    const history1: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
    ];
    const history2: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u2", content: "goodbye", timestamp: 1000 },
    ];

    expect(computeHistoryMessagesSyncHash(history1).hash).not.toBe(
      computeHistoryMessagesSyncHash(history2).hash,
    );
  });

  it("uses identity-based hashing for messages with stable ids", () => {
    const history1: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
    ];
    const history2: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "goodbye", timestamp: 2000 },
    ];

    expect(computeHistoryMessagesSyncHash(history1).hash).toBe(
      computeHistoryMessagesSyncHash(history2).hash,
    );
  });

  it("skips non-error result messages", () => {
    const withSuccess: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
      {
        type: "result",
        data: {
          type: "result",
          subtype: "success",
          is_error: false,
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
    const withoutResult: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
    ];

    expect(computeHistoryMessagesSyncHash(withSuccess).hash).toBe(
      computeHistoryMessagesSyncHash(withoutResult).hash,
    );
    expect(computeHistoryMessagesSyncHash(withSuccess).renderedCount).toBe(1);
  });

  it("skips task_notification without summary", () => {
    const withNotif: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
      {
        type: "task_notification",
        task_id: "task-abc",
        tool_use_id: "tu-1",
        status: "running",
      },
    ];
    const withoutNotif: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
    ];

    expect(computeHistoryMessagesSyncHash(withNotif).hash).toBe(
      computeHistoryMessagesSyncHash(withoutNotif).hash,
    );
  });

  it("includes task_notification with summary", () => {
    const history: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
      {
        type: "task_notification",
        task_id: "task-abc",
        tool_use_id: "tu-1",
        status: "completed",
        summary: "Background agent finished",
      },
    ];

    const result = computeHistoryMessagesSyncHash(history);
    expect(result.renderedCount).toBe(2);
    const withoutNotif: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
    ];
    expect(result.hash).not.toBe(computeHistoryMessagesSyncHash(withoutNotif).hash);
  });

  it("computes prefix hash for a subset of rendered messages", () => {
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
      { type: "user_message", id: "u2", content: "follow up", timestamp: 3000 },
    ];

    const full = computeHistoryMessagesSyncHash(history);
    expect(full.renderedCount).toBe(3);

    const prefix = computeHistoryPrefixSyncHash(history, 2);
    expect(prefix.renderedCount).toBe(2);
    expect(prefix.totalRenderedCount).toBe(3);

    const firstTwo = computeHistoryMessagesSyncHash(history.slice(0, 2));
    expect(prefix.hash).toBe(firstTwo.hash);

    expect(prefix.hash).not.toBe(full.hash);
  });

  it("handles empty history", () => {
    const result = computeHistoryMessagesSyncHash([]);
    expect(result.hash).toMatch(/^[0-9a-f]{8}$/);
    expect(result.renderedCount).toBe(0);
  });

  it("handles compact markers", () => {
    const history: BrowserIncomingMessage[] = [
      {
        type: "compact_marker",
        id: "compact-boundary-1",
        timestamp: 123,
        summary: "Conversation compacted to summary",
      },
    ];

    const result = computeHistoryMessagesSyncHash(history);
    expect(result.renderedCount).toBe(1);
    expect(result.hash).toMatch(/^[0-9a-f]{8}$/);
  });
});
