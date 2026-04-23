import { describe, it, expect } from "vitest";
import {
  buildPeekDefault,
  buildPeekRange,
  buildPeekResponse,
  buildPeekTurnScan,
  buildReadResponse,
  buildToolSummary,
  grepMessageHistory,
  escapeStringLiteral,
  formatQuotedContent,
} from "./takode-messages.js";
import type { BrowserIncomingMessage, CLIResultMessage } from "./session-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a user_message entry for testing. */
function userMsg(content: string, ts: number, id?: string): BrowserIncomingMessage {
  return {
    type: "user_message",
    content,
    timestamp: ts,
    ...(id ? { id } : {}),
  } as BrowserIncomingMessage;
}

/** Create an assistant message entry for testing. */
function assistantMsg(
  textContent: string,
  ts: number,
  toolUses?: { name: string; input: Record<string, unknown> }[],
  parentToolUseId: string | null = null,
): BrowserIncomingMessage {
  const content: unknown[] = [{ type: "text" as const, text: textContent }];
  if (toolUses) {
    for (const t of toolUses) {
      content.push({ type: "tool_use" as const, id: `tu-${t.name}`, name: t.name, input: t.input });
    }
  }
  return {
    type: "assistant",
    message: {
      id: `msg-${ts}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: parentToolUseId,
    timestamp: ts,
  } as BrowserIncomingMessage;
}

function toolResultPreview(toolUseId: string, content: string): BrowserIncomingMessage {
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
  } as BrowserIncomingMessage;
}

/** Create a result message entry for testing. */
function resultMsg(durationMs: number, isError = false): BrowserIncomingMessage {
  return {
    type: "result",
    data: {
      type: "result",
      subtype: isError ? "error_during_execution" : "success",
      is_error: isError,
      result: isError ? "Something went wrong" : "Task completed successfully",
      duration_ms: durationMs,
      duration_api_ms: durationMs - 100,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: `result-${durationMs}`,
      session_id: "test-session",
    } as CLIResultMessage,
  } as BrowserIncomingMessage;
}

/** Create a compact_marker entry. */
function compactMarker(
  summary: string,
  ts: number,
  opts?: { trigger?: "auto" | "manual"; preTokens?: number },
): BrowserIncomingMessage {
  return {
    type: "compact_marker",
    timestamp: ts,
    summary,
    id: `compact-${ts}`,
    ...(opts?.trigger ? { trigger: opts.trigger } : {}),
    ...(opts?.preTokens ? { preTokens: opts.preTokens } : {}),
  } as BrowserIncomingMessage;
}

/** Create a permission_approved entry. */
function permissionApproved(toolName: string, summary: string, ts: number): BrowserIncomingMessage {
  return {
    type: "permission_approved",
    id: `approval-${ts}`,
    tool_name: toolName,
    tool_use_id: `tu-${ts}`,
    summary,
    timestamp: ts,
  } as BrowserIncomingMessage;
}

// ─── escapeStringLiteral & formatQuotedContent ──────────────────────────────

describe("escapeStringLiteral", () => {
  it("escapes backslashes, double quotes, newlines, tabs, and carriage returns", () => {
    expect(escapeStringLiteral('hello "world"')).toBe('hello \\"world\\"');
    expect(escapeStringLiteral("line1\nline2")).toBe("line1\\nline2");
    expect(escapeStringLiteral("col1\tcol2")).toBe("col1\\tcol2");
    expect(escapeStringLiteral("back\\slash")).toBe("back\\\\slash");
    expect(escapeStringLiteral("cr\rhere")).toBe("cr\\rhere");
  });

  it("handles strings with no special characters", () => {
    expect(escapeStringLiteral("simple text")).toBe("simple text");
  });

  it("handles empty string", () => {
    expect(escapeStringLiteral("")).toBe("");
  });

  it("escapes multiple special characters in sequence", () => {
    expect(escapeStringLiteral('a\n"b"\tc')).toBe('a\\n\\"b\\"\\tc');
  });
});

describe("formatQuotedContent", () => {
  it("wraps short content in double quotes", () => {
    expect(formatQuotedContent("hello", 100)).toBe('"hello"');
  });

  it("escapes special characters inside quotes", () => {
    expect(formatQuotedContent('say "hi"\nthere', 100)).toBe('"say \\"hi\\"\\nthere"');
  });

  it("truncates long content with char count", () => {
    const result = formatQuotedContent("a".repeat(200), 100);
    expect(result).toBe('"' + "a".repeat(100) + '" +100 chars');
  });

  it("does not truncate content at exactly the limit", () => {
    const result = formatQuotedContent("a".repeat(100), 100);
    expect(result).toBe('"' + "a".repeat(100) + '"');
  });

  it("truncates content one char over the limit", () => {
    const result = formatQuotedContent("a".repeat(101), 100);
    expect(result).toBe('"' + "a".repeat(100) + '" +1 chars');
  });
});

// ─── buildToolSummary ─────────────────────────────────────────────────────────

describe("buildToolSummary", () => {
  it("summarizes Bash with truncated command", () => {
    const result = buildToolSummary("Bash", { command: "ls -la /some/very/long/path/that/goes/on/and/on" });
    expect(result).toBe("ls -la /some/very/long/path/that/goes/on/and/on");
  });

  it("truncates long Bash commands at 60 chars", () => {
    const longCmd = "a".repeat(100);
    const result = buildToolSummary("Bash", { command: longCmd });
    expect(result.length).toBeLessThanOrEqual(80); // 60 + "... [+N chars]" suffix
    expect(result).toContain("... [+40 chars]");
  });

  it("summarizes Edit with basename", () => {
    const result = buildToolSummary("Edit", { file_path: "/home/user/project/server/routes.ts" });
    expect(result).toBe("routes.ts");
  });

  it("summarizes Read with basename", () => {
    const result = buildToolSummary("Read", { file_path: "/home/user/.config/settings.json" });
    expect(result).toBe("settings.json");
  });

  it("summarizes Write with basename and (new) suffix", () => {
    const result = buildToolSummary("Write", { file_path: "/tmp/output.txt" });
    expect(result).toBe("output.txt (new)");
  });

  it("summarizes Glob with pattern", () => {
    const result = buildToolSummary("Glob", { pattern: "**/*.test.ts" });
    expect(result).toBe("**/*.test.ts");
  });

  it("summarizes Grep with pattern", () => {
    const result = buildToolSummary("Grep", { pattern: "TODO|FIXME" });
    expect(result).toBe("TODO|FIXME");
  });

  it("uses first string value for unknown tools", () => {
    const result = buildToolSummary("CustomTool", { url: "https://example.com", count: 42 });
    expect(result).toBe("https://example.com");
  });

  it("returns empty string when no string values in input", () => {
    const result = buildToolSummary("CustomTool", { count: 42, enabled: true });
    expect(result).toBe("");
  });

  it("handles empty file_path gracefully for Edit", () => {
    const result = buildToolSummary("Edit", { file_path: "" });
    expect(result).toBe("");
  });
});

// ─── buildPeekResponse ────────────────────────────────────────────────────────

describe("buildPeekResponse", () => {
  it("returns empty array for empty history", () => {
    const result = buildPeekResponse([], { turns: 1 });
    expect(result).toEqual([]);
  });

  it("extracts a single turn from history", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Hello, help me fix a bug", 1000),
      assistantMsg("I'll help you fix the bug.", 2000),
      resultMsg(5000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result).toHaveLength(1);

    const turn = result[0];
    expect(turn.turn).toBe(0);
    expect(turn.start).toBe(1000);
    expect(turn.dur).toBe(5000);
    expect(turn.messages).toHaveLength(3);

    // User message
    expect(turn.messages[0].type).toBe("user");
    expect(turn.messages[0].content).toBe("Hello, help me fix a bug");
    expect(turn.messages[0].idx).toBe(0);

    // Assistant message
    expect(turn.messages[1].type).toBe("assistant");
    expect(turn.messages[1].idx).toBe(1);

    // Result message
    expect(turn.messages[2].type).toBe("result");
    expect(turn.messages[2].success).toBe(true);
    expect(turn.messages[2].dur).toBe(5000);
  });

  it("extracts multiple turns when requested", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("First question", 1000),
      assistantMsg("First answer", 2000),
      resultMsg(3000),
      userMsg("Second question", 4000),
      assistantMsg("Second answer", 5000),
      resultMsg(2000),
    ];

    const result = buildPeekResponse(history, { turns: 2 });
    expect(result).toHaveLength(2);
    expect(result[0].turn).toBe(0);
    expect(result[1].turn).toBe(1);
  });

  it("returns only last N turns from longer history", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Reply 1", 2000),
      resultMsg(1000),
      userMsg("Turn 2", 3000),
      assistantMsg("Reply 2", 4000),
      resultMsg(1000),
      userMsg("Turn 3", 5000),
      assistantMsg("Reply 3", 6000),
      resultMsg(1000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result).toHaveLength(1);
    // Should be the last turn (Turn 3)
    expect(result[0].messages[0].content).toBe("Turn 3");
  });

  it("truncates long content in peek mode (full=false)", () => {
    const longText = "x".repeat(600);
    const history: BrowserIncomingMessage[] = [userMsg(longText, 1000), assistantMsg(longText, 2000), resultMsg(1000)];

    const result = buildPeekResponse(history, { turns: 1, full: false });
    // User messages are short but this one is long — should be truncated at 500 chars
    expect(result[0].messages[0].content.length).toBeLessThan(600);
    expect(result[0].messages[0].content).toContain("... [+");
  });

  it("preserves full content when full=true", () => {
    const longText = "x".repeat(200);
    const history: BrowserIncomingMessage[] = [userMsg(longText, 1000), assistantMsg(longText, 2000), resultMsg(1000)];

    const result = buildPeekResponse(history, { turns: 1, full: true });
    expect(result[0].messages[0].content).toBe(longText);
  });

  it("extracts tool calls from assistant messages", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Read the file", 1000),
      assistantMsg("Let me read that file.", 2000, [
        { name: "Read", input: { file_path: "/home/user/server/routes.ts" } },
        { name: "Bash", input: { command: "ls -la" } },
      ]),
      resultMsg(3000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    const assistantPeek = result[0].messages[1];
    expect(assistantPeek.tools).toHaveLength(2);
    expect(assistantPeek.tools![0].name).toBe("Read");
    expect(assistantPeek.tools![0].summary).toBe("routes.ts");
    expect(assistantPeek.tools![1].name).toBe("Bash");
    expect(assistantPeek.tools![1].summary).toBe("ls -la");
  });

  it("handles in-progress turn (no result yet)", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Do something", 1000),
      assistantMsg("Working on it...", 2000),
      // No result message yet
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].end).toBeUndefined();
    expect(result[0].dur).toBeUndefined();
    expect(result[0].messages).toHaveLength(2);
  });

  it("filters turns by since timestamp", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Old turn", 1000),
      assistantMsg("Old reply", 2000),
      resultMsg(1000),
      userMsg("New turn", 5000),
      assistantMsg("New reply", 6000),
      resultMsg(2000),
    ];

    const result = buildPeekResponse(history, { turns: 10, since: 4000 });
    // Only the second turn should match (started at 5000 >= since 4000)
    expect(result).toHaveLength(1);
    expect(result[0].messages[0].content).toBe("New turn");
  });

  it("includes compact_marker as system type", () => {
    const history: BrowserIncomingMessage[] = [
      compactMarker("Context was compacted", 500),
      userMsg("Continue working", 1000),
      assistantMsg("Sure, continuing.", 2000),
      resultMsg(1000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    // compact_marker is before the turn, so it should not be in the turn
    expect(result).toHaveLength(1);
    // The turn starts at userMsg, compact_marker is at idx 0 which is before startIdx
    expect(result[0].messages[0].type).toBe("user");
  });

  it("includes permission_approved as system message within a turn", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Edit the file", 1000),
      assistantMsg("Let me edit that.", 2000),
      permissionApproved("Edit", "server/routes.ts", 2500),
      resultMsg(3000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    const systemMsgs = result[0].messages.filter((m) => m.type === "system");
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].content).toContain("Approved: Edit");
  });

  it("handles error result correctly", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Do dangerous thing", 1000),
      assistantMsg("Attempting...", 2000),
      resultMsg(1000, true),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    const resultPeek = result[0].messages[2];
    expect(resultPeek.success).toBe(false);
  });

  it("assigns correct idx values from original messageHistory", () => {
    // Stream events and other non-peekable messages are skipped but indices should
    // still reflect the original array position
    const history: BrowserIncomingMessage[] = [
      userMsg("Question", 1000), // idx 0
      { type: "stream_event", event: {}, parent_tool_use_id: null } as BrowserIncomingMessage, // idx 1 - skipped
      assistantMsg("Answer", 2000), // idx 2
      {
        type: "tool_progress",
        tool_use_id: "tu1",
        tool_name: "Bash",
        elapsed_time_seconds: 1,
      } as BrowserIncomingMessage, // idx 3 - skipped
      resultMsg(1000), // idx 4
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result[0].messages[0].idx).toBe(0); // user_message
    expect(result[0].messages[1].idx).toBe(2); // assistant (skipped stream_event at 1)
    expect(result[0].messages[2].idx).toBe(4); // result (skipped tool_progress at 3)
  });

  it("collapses subagent child chatter into the parent assistant preview", () => {
    const subagentResult = JSON.stringify([
      { type: "text", text: "Final agent answer" },
      { type: "text", text: "agentId: worker-1" },
    ]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Investigate the bug", 1000),
      assistantMsg("", 2000, [{ name: "Agent", input: { prompt: "Look into the websocket bug" } }]),
      assistantMsg("streaming child detail", 2500, undefined, "tu-Agent"),
      toolResultPreview("tu-Agent", subagentResult),
      resultMsg(3000),
    ];

    const result = buildPeekResponse(history, { turns: 1 });
    expect(result[0].messages).toHaveLength(3);
    expect(result[0].messages[1].type).toBe("assistant");
    expect(result[0].messages[1].content).toBe("Final agent answer");
    expect(result[0].messages[1].tools).toBeUndefined();
    expect(result[0].messages.some((msg) => msg.content.includes("streaming child detail"))).toBe(false);
  });
});

describe("buildPeekDefault", () => {
  it("uses the subagent final result as the collapsed turn preview", () => {
    const subagentResult = JSON.stringify([
      { type: "text", text: "Subagent finished the audit" },
      { type: "text", text: "<usage>tokens</usage>" },
    ]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("", 2000, [{ name: "Agent", input: { prompt: "Audit the websocket path" } }]),
      assistantMsg("child detail", 2500, undefined, "tu-Agent"),
      toolResultPreview("tu-Agent", subagentResult),
      resultMsg(3000),
      userMsg("Turn 2", 6000),
      assistantMsg("Done with follow-up", 7000),
      resultMsg(1000),
    ];

    const result = buildPeekDefault(history);
    expect(result.collapsed).toHaveLength(1);
    expect(result.collapsed[0].result).toBe("Subagent finished the audit");
  });

  it("prefers the turn-local assistant reply over later synthetic subagent preview text", () => {
    const childPreview = JSON.stringify([{ type: "text", text: "Repeated apology from a nested agent" }]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Actual first-turn reply", 2000),
      assistantMsg("", 2500, [{ name: "Agent", input: { prompt: "double-check details" } }]),
      toolResultPreview("tu-Agent", childPreview),
      resultMsg(3000),
      userMsg("Turn 2", 7000),
      assistantMsg("Distinct second-turn reply", 8000),
      resultMsg(1000),
    ];

    const result = buildPeekDefault(history);
    expect(result.collapsed).toHaveLength(1);
    expect(result.collapsed[0].result).toBe("Actual first-turn reply");
  });

  it("ignores a trailing injected stop message instead of treating it as a running turn", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Investigate the bug", 1000),
      assistantMsg("Final diagnosis", 2000),
      resultMsg(3000),
      {
        type: "user_message",
        content: "Session stopped by leader #158 Debug stuck worker session",
        timestamp: 5000,
        id: "stop-5000",
        agentSource: { sessionId: "leader-158", sessionLabel: "#158 Debug stuck worker session" },
      } as BrowserIncomingMessage,
    ];

    const result = buildPeekDefault(history);
    expect(result.totalTurns).toBe(1);
    expect(result.expanded?.start).toBe(1000);
    expect(result.expanded?.end).toBe(4000);
    expect(result.expanded?.messages.at(-1)?.type).toBe("result");
  });
});

describe("buildPeekRange", () => {
  it("shows the subagent result preview and hides child messages in range mode", () => {
    const subagentResult = JSON.stringify([{ type: "text", text: "Range preview from child agent" }]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Range turn", 1000),
      assistantMsg("", 2000, [{ name: "Task", input: { prompt: "Check one narrow thing" } }]),
      assistantMsg("child detail", 2300, undefined, "tu-Task"),
      toolResultPreview("tu-Task", subagentResult),
      resultMsg(500),
    ];

    const result = buildPeekRange(history, { from: 0, count: 10 });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1].content).toBe("Range preview from child agent");
    expect(result.messages[1].toolCounts).toBeUndefined();
    expect(result.messages.some((msg) => msg.content.includes("child detail"))).toBe(false);
  });

  it("supports inclusive backward paging via until while keeping chronological order", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Answer 1", 2000),
      resultMsg(500),
      userMsg("Turn 2", 4000),
      assistantMsg("Answer 2", 5000),
      resultMsg(500),
    ];

    const result = buildPeekRange(history, { until: 4, count: 3 });
    expect(result.from).toBe(2);
    expect(result.to).toBe(4);
    expect(result.messages.map((msg) => msg.idx)).toEqual([2, 3, 4]);

    const previousPage = buildPeekRange(history, { until: result.messages[0].idx, count: 3 });
    expect(previousPage.messages.map((msg) => msg.idx)).toEqual([0, 1, 2]);
  });

  it("accepts from/until as an inclusive explicit range", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Answer 1", 2000),
      resultMsg(500),
      userMsg("Turn 2", 4000),
      assistantMsg("Answer 2", 5000),
      resultMsg(500),
    ];

    const result = buildPeekRange(history, { from: 2, until: 4 });
    expect(result.from).toBe(2);
    expect(result.to).toBe(4);
    expect(result.messages.map((msg) => msg.idx)).toEqual([2, 3, 4]);
  });
});

describe("buildPeekTurnScan", () => {
  it("uses the actual turn-local assistant reply for collapsed summaries", () => {
    const childPreview = JSON.stringify([{ type: "text", text: "Repeated apology from a nested agent" }]);
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("Actual first-turn reply", 2000),
      assistantMsg("", 2500, [{ name: "Agent", input: { prompt: "double-check details" } }]),
      toolResultPreview("tu-Agent", childPreview),
      resultMsg(3000),
      userMsg("Turn 2", 7000),
      assistantMsg("Distinct second-turn reply", 8000),
      resultMsg(1000),
      userMsg("Turn 3", 10000),
      assistantMsg("Third-turn reply", 11000),
      resultMsg(1000),
    ];

    const result = buildPeekTurnScan(history, { fromTurn: 0, turnCount: 3 });
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0].result).toBe("Actual first-turn reply");
    expect(result.turns[1].result).toBe("Distinct second-turn reply");
    expect(result.turns[2].result).toBe("Third-turn reply");
  });

  it("returns a safe empty slice for metadata-only zero-count probes", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Turn 1", 1000),
      assistantMsg("reply", 2000),
      resultMsg(3000),
      userMsg("Turn 2", 4000),
      assistantMsg("reply 2", 5000),
      resultMsg(6000),
    ];

    const result = buildPeekTurnScan(history, { fromTurn: 0, turnCount: 0 });
    expect(result.totalTurns).toBe(2);
    expect(result.totalMessages).toBe(6);
    expect(result.from).toBe(0);
    expect(result.count).toBe(0);
    expect(result.turns).toEqual([]);
    expect(result.compactionEvents).toBeUndefined();
  });
});

// ─── buildReadResponse ────────────────────────────────────────────────────────

describe("buildReadResponse", () => {
  it("returns null for out-of-bounds index", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Hello", 1000)];
    expect(buildReadResponse(history, 5)).toBeNull();
    expect(buildReadResponse(history, -1)).toBeNull();
  });

  it("reads a user message with full content", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Hello world\nSecond line\nThird line", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.idx).toBe(0);
    expect(result.type).toBe("user_message");
    expect(result.ts).toBe(1000);
    expect(result.totalLines).toBe(3);
    expect(result.content).toBe("Hello world\nSecond line\nThird line");
  });

  it("reads an assistant message with text and tool blocks", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Let me help.", 1000, [{ name: "Bash", input: { command: "ls -la" } }]),
    ];

    const result = buildReadResponse(history, 0)!;
    expect(result.type).toBe("assistant");
    expect(result.content).toContain("Let me help.");
    expect(result.content).toContain("[Tool: Bash]");
    expect(result.contentBlocks).toBeDefined();
    expect(result.contentBlocks!.length).toBe(2); // text + tool_use
  });

  it("reads a result message", () => {
    const history: BrowserIncomingMessage[] = [resultMsg(5000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.type).toBe("result");
    expect(result.content).toContain("Task completed successfully");
  });

  it("reads a result message with errors", () => {
    const history: BrowserIncomingMessage[] = [resultMsg(1000, true)];

    const result = buildReadResponse(history, 0)!;
    expect(result.content).toContain("Something went wrong");
  });

  it("paginates content by lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
    const history: BrowserIncomingMessage[] = [userMsg(lines.join("\n"), 1000)];

    // Get lines 3-5 (offset=2, limit=3)
    const result = buildReadResponse(history, 0, { offset: 2, limit: 3 })!;
    expect(result.totalLines).toBe(10);
    expect(result.offset).toBe(2);
    expect(result.limit).toBe(3);
    expect(result.content).toBe("Line 3\nLine 4\nLine 5");
  });

  it("handles offset beyond total lines", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Short message", 1000)];

    const result = buildReadResponse(history, 0, { offset: 100, limit: 10 })!;
    expect(result.totalLines).toBe(1);
    expect(result.content).toBe("");
  });

  it("does not include contentBlocks for non-assistant messages", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Hello", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.contentBlocks).toBeUndefined();
  });

  it("reads a compact_marker message", () => {
    const history: BrowserIncomingMessage[] = [compactMarker("Context was compacted to save tokens", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.type).toBe("compact_marker");
    expect(result.content).toBe("Context was compacted to save tokens");
  });

  it("reads a permission_approved message", () => {
    const history: BrowserIncomingMessage[] = [permissionApproved("Edit", "server/routes.ts +15 lines", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.type).toBe("permission_approved");
    expect(result.content).toContain("Approved: Edit");
  });

  it("defaults offset to 0 and limit to 200", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Hello", 1000)];

    const result = buildReadResponse(history, 0)!;
    expect(result.offset).toBe(0);
    expect(result.limit).toBe(200);
  });

  it("expands a parent subagent message to the full stored tool result", () => {
    const preview = JSON.stringify([{ type: "text", text: "Short preview" }]);
    const full = JSON.stringify([
      { type: "text", text: "Full subagent answer" },
      { type: "text", text: "agentId: worker-2" },
    ]);
    const history: BrowserIncomingMessage[] = [
      assistantMsg("", 1000, [{ name: "Agent", input: { prompt: "Write the summary" } }]),
      toolResultPreview("tu-Agent", preview),
    ];

    const result = buildReadResponse(history, 0, {
      getToolResult: (toolUseId) => (toolUseId === "tu-Agent" ? { content: full, is_error: false } : null),
    })!;

    expect(result.content).toBe("Full subagent answer");
    expect(result.content).not.toContain("[Tool: Agent]");
    expect(result.content).not.toContain("agentId:");
  });

  it("pairs non-subagent tool calls with their full results via getToolResult", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Let me check.", 1000, [
        { name: "Bash", input: { command: "ls -la" } },
        { name: "Read", input: { file_path: "/tmp/foo.txt" } },
      ]),
    ];

    const result = buildReadResponse(history, 0, {
      getToolResult: (toolUseId) => {
        if (toolUseId === "tu-Bash") return { content: "file1.ts\nfile2.ts", is_error: false };
        if (toolUseId === "tu-Read") return { content: "hello world", is_error: false };
        return null;
      },
    })!;

    expect(result.content).toContain("[Tool: Bash]");
    expect(result.content).toContain("[Tool Result] file1.ts\nfile2.ts");
    expect(result.content).toContain("[Tool: Read]");
    expect(result.content).toContain("[Tool Result] hello world");
  });

  it("pairs tool calls with truncated preview when full result unavailable", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Reading file.", 1000, [{ name: "Read", input: { file_path: "/tmp/big.txt" } }]),
      toolResultPreview("tu-Read", "last 300 chars..."),
    ];
    // Patch the preview to be truncated
    const previews = (history[1] as any).previews;
    previews[0].is_truncated = true;
    previews[0].total_size = 45000;

    const result = buildReadResponse(history, 0)!;

    expect(result.content).toContain("[Tool: Read]");
    expect(result.content).toContain("[Tool Result] last 300 chars...");
    expect(result.content).toContain("[truncated, 45000 bytes total]");
  });

  it("shows tool error prefix for failed tool results", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Running command.", 1000, [{ name: "Bash", input: { command: "bad-cmd" } }]),
    ];

    const result = buildReadResponse(history, 0, {
      getToolResult: (toolUseId) =>
        toolUseId === "tu-Bash" ? { content: "command not found: bad-cmd", is_error: true } : null,
    })!;

    expect(result.content).toContain("[Tool Error] command not found: bad-cmd");
  });

  it("renders tool call without result when no result is available", () => {
    const history: BrowserIncomingMessage[] = [
      assistantMsg("Checking.", 1000, [{ name: "Bash", input: { command: "echo hi" } }]),
    ];

    const result = buildReadResponse(history, 0)!;

    expect(result.content).toContain("[Tool: Bash]");
    // No result line should appear
    expect(result.content).not.toContain("[Tool Result]");
    expect(result.content).not.toContain("[Tool Error]");
  });

  it("returns tool_result_preview content when reading a preview message directly", () => {
    // tool_result_preview messages are not peekable (filtered from peek/scan),
    // but they are accessible via read by index and should show actual content
    const history: BrowserIncomingMessage[] = [
      userMsg("Question", 1000),
      assistantMsg("Working on it", 2000),
      toolResultPreview("tu-1", "file contents here"),
    ];

    const result = buildReadResponse(history, 2)!;
    expect(result.type).toBe("tool_result_preview");
    expect(result.content).toContain("[Tool Result] file contents here");
  });
});

// ─── grepMessageHistory ───────────────────────────────────────────────────────

describe("grepMessageHistory", () => {
  const history: BrowserIncomingMessage[] = [
    userMsg("How do I combine image and quality filters?", 1000),
    assistantMsg("You can use the pipe operator to combine them.", 2000),
    resultMsg(500),
  ];

  it("returns matches for a valid regex pattern", () => {
    const result = grepMessageHistory(history, "pipe");
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].snippet).toContain("pipe");
    expect(result.warning).toBeUndefined();
  });

  it("supports ERE alternation with |", () => {
    const result = grepMessageHistory(history, "image|quality");
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.warning).toBeUndefined();
  });

  // Backslash-pipe (\|) matches a literal pipe in JS regex, not alternation.
  // When this yields 0 matches, a warning should help the user.
  it("warns when \\| pattern returns zero matches", () => {
    const result = grepMessageHistory(history, "image\\|quality");
    expect(result.totalMatches).toBe(0);
    expect(result.warning).toMatch(/literal pipe/);
    expect(result.warning).toContain('"|"');
  });

  // If \| actually matches content (message contains a literal pipe), no warning.
  it("does not warn when \\| pattern finds matches", () => {
    const historyWithPipe: BrowserIncomingMessage[] = [userMsg("image|quality is a valid filter", 1000)];
    const result = grepMessageHistory(historyWithPipe, "image\\|quality");
    expect(result.totalMatches).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("does not warn for zero matches without \\|", () => {
    const result = grepMessageHistory(history, "nonexistent_xyz");
    expect(result.totalMatches).toBe(0);
    expect(result.warning).toBeUndefined();
  });

  it("falls back to literal match for invalid regex", () => {
    // Unbalanced bracket is invalid regex -- should fall back to literal match
    const historyWithBracket: BrowserIncomingMessage[] = [userMsg("array[0 is broken syntax", 1000)];
    const result = grepMessageHistory(historyWithBracket, "array[0");
    expect(result.totalMatches).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("respects the limit option", () => {
    const bigHistory: BrowserIncomingMessage[] = Array.from({ length: 10 }, (_, i) =>
      userMsg(`message ${i} with keyword`, i * 1000),
    );
    const result = grepMessageHistory(bigHistory, "keyword", { limit: 3 });
    expect(result.totalMatches).toBe(10);
    expect(result.matches).toHaveLength(3);
  });
});

// ─── Compaction events in scan and peek ──────────────────────────────────────

describe("buildPeekTurnScan compactionEvents", () => {
  it("returns compaction events between turns", () => {
    // Turn 0: user -> result, then compaction, then Turn 1: user -> result
    const history: BrowserIncomingMessage[] = [
      userMsg("first task", 1000),
      assistantMsg("working on it", 1100),
      resultMsg(500),
      compactMarker("Context compacted to 4%", 2000, { trigger: "auto", preTokens: 50000 }),
      userMsg("second task", 3000),
      assistantMsg("done", 3100),
      resultMsg(300),
    ];

    const result = buildPeekTurnScan(history);
    expect(result.turns).toHaveLength(2);
    expect(result.compactionEvents).toBeDefined();
    expect(result.compactionEvents).toHaveLength(1);

    const event = result.compactionEvents![0];
    expect(event.idx).toBe(3);
    expect(event.ts).toBe(2000);
    expect(event.trigger).toBe("auto");
    expect(event.preTokens).toBe(50000);
    expect(event.summary).toBe("Context compacted to 4%");
    // Compaction is after turn 0 (which ends at idx 2)
    expect(event.afterTurn).toBe(0);
  });

  it("omits compactionEvents field when no compaction events exist", () => {
    const history: BrowserIncomingMessage[] = [userMsg("hello", 1000), assistantMsg("hi", 1100), resultMsg(200)];

    const result = buildPeekTurnScan(history);
    expect(result.compactionEvents).toBeUndefined();
  });

  it("detects compaction before first turn", () => {
    const history: BrowserIncomingMessage[] = [
      compactMarker("Initial compaction", 500, { trigger: "manual" }),
      userMsg("start", 1000),
      resultMsg(200),
    ];

    const result = buildPeekTurnScan(history);
    expect(result.compactionEvents).toHaveLength(1);
    expect(result.compactionEvents![0].afterTurn).toBe(-1);
  });

  it("detects multiple compaction events", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("t1", 1000),
      resultMsg(100),
      compactMarker("First compaction", 2000),
      userMsg("t2", 3000),
      resultMsg(100),
      compactMarker("Second compaction", 4000),
      userMsg("t3", 5000),
      resultMsg(100),
    ];

    const result = buildPeekTurnScan(history);
    expect(result.turns).toHaveLength(3);
    expect(result.compactionEvents).toHaveLength(2);
    expect(result.compactionEvents![0].afterTurn).toBe(0);
    expect(result.compactionEvents![1].afterTurn).toBe(1);
  });
});

describe("buildPeekDefault compactionEvents", () => {
  it("includes compaction events in default peek within visible range", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("t1", 1000),
      resultMsg(100),
      compactMarker("Compacted", 2000, { trigger: "auto" }),
      userMsg("t2", 3000),
      assistantMsg("response", 3100),
      resultMsg(200),
    ];

    const result = buildPeekDefault(history);
    expect(result.compactionEvents).toBeDefined();
    expect(result.compactionEvents).toHaveLength(1);
    expect(result.compactionEvents![0].summary).toBe("Compacted");
  });

  it("omits compactionEvents when none in visible range", () => {
    const history: BrowserIncomingMessage[] = [userMsg("hello", 1000), assistantMsg("hi", 1100), resultMsg(200)];

    const result = buildPeekDefault(history);
    expect(result.compactionEvents).toBeUndefined();
  });
});
