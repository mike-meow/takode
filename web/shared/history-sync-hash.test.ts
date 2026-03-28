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

  it("matches task_notification messages across history and normalized chat messages", () => {
    // task_notification with summary produces a system ChatMessage;
    // forEachComparableHistoryEntry must mirror this so hashes agree.
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

    const chatMessages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello", timestamp: 1000 },
      {
        id: "task-notif-task-abc",
        role: "system",
        content: "Background agent finished",
        timestamp: 9999, // doesn't matter -- system role always uses null in comparable entry
        variant: "task_completed",
      },
    ];

    expect(computeHistoryMessagesSyncHash(history).hash).toBe(computeChatMessagesSyncHash(chatMessages));
  });

  it("skips task_notification without summary to match browser normalization", () => {
    // task_notification without summary does not produce a ChatMessage on the
    // browser side, so the hash function must also skip it.
    const withNotif: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
      {
        type: "task_notification",
        task_id: "task-abc",
        tool_use_id: "tu-1",
        status: "running",
        // no summary
      },
    ];

    const withoutNotif: BrowserIncomingMessage[] = [
      { type: "user_message", id: "u1", content: "hello", timestamp: 1000 },
    ];

    expect(computeHistoryMessagesSyncHash(withNotif).hash).toBe(
      computeHistoryMessagesSyncHash(withoutNotif).hash,
    );
  });

  it("excludes ephemeral ChatMessages from hash computation", () => {
    // Browser-only messages (tool_use_summary, permission_auto_approved, etc.)
    // are marked ephemeral and must not affect the sync hash.
    const base: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello", timestamp: 1000 },
      { id: "a1", role: "assistant", content: "reply", timestamp: 2000 },
    ];

    const withEphemeral: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello", timestamp: 1000 },
      { id: "msg-123-1", role: "system", content: "tool summary", timestamp: 1500, ephemeral: true },
      { id: "a1", role: "assistant", content: "reply", timestamp: 2000 },
      { id: "msg-123-2", role: "system", content: "Auto-approved: Bash", timestamp: 2500, variant: "approved", ephemeral: true },
    ];

    expect(computeChatMessagesSyncHash(withEphemeral)).toBe(computeChatMessagesSyncHash(base));
  });

  it("matches result errors regardless of synthesized id (live vs history)", () => {
    // During live streaming, the browser creates result error ChatMessages with
    // nextId() (e.g. "msg-123-1"). During history replay, the id is "hist-error-N".
    // Both must produce the same content-based fingerprint since id is excluded
    // from content-based hashing.
    const history: BrowserIncomingMessage[] = [
      {
        type: "result",
        data: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["something broke"],
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

    // Live-created ChatMessage with browser-generated id
    const liveChat: ChatMessage[] = [
      {
        id: "msg-1774683137238-1",
        role: "system",
        content: "Error: something broke",
        timestamp: Date.now(),
        variant: "error",
      },
    ];

    // History-normalized ChatMessage with synthesized id
    const historyChat: ChatMessage[] = [
      {
        id: "hist-error-0",
        role: "system",
        content: "Error: something broke",
        timestamp: 9999,
        variant: "error",
      },
    ];

    const serverHash = computeHistoryMessagesSyncHash(history).hash;
    expect(computeChatMessagesSyncHash(liveChat)).toBe(serverHash);
    expect(computeChatMessagesSyncHash(historyChat)).toBe(serverHash);
  });

  it("matches compact markers with different ids across live and history", () => {
    // Both live-created and history-replayed compact markers use content-based
    // hashing (id starts with "compact-"). The id is excluded from the content
    // hash, so markers with different ids but same content match.
    const marker1: ChatMessage[] = [
      {
        id: "compact-boundary-1234",
        role: "system",
        content: "Summary of compaction",
        timestamp: 1234,
        variant: "info",
      },
    ];

    const marker2: ChatMessage[] = [
      {
        id: "compact-5",
        role: "system",
        content: "Summary of compaction",
        timestamp: 5678,
        variant: "info",
      },
    ];

    expect(computeChatMessagesSyncHash(marker1)).toBe(computeChatMessagesSyncHash(marker2));
  });
});
