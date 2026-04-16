/**
 * Tests for the herd activity formatter.
 *
 * Verifies that formatActivitySummary() produces correct compact summaries
 * from messageHistory slices, including:
 * - User message rendering with source labels
 * - Tool-call compression into one aggregate summary line
 * - Result message rendering with success/error icons
 * - Permission request/approved/denied rendering
 * - Tail-priority truncation when exceeding maxLines cap
 * - Edge cases: empty input, non-formattable messages, single messages
 *
 * Format conventions tested:
 * - No indent before [N] message IDs
 * - No role tag for assistant messages (they're the default)
 * - All content as escaped string literals with truncation showing char count
 * - Tool-call noise hidden from per-message lines
 */

import { describe, it, expect } from "vitest";
import { formatActivitySummary } from "./herd-activity-formatter.js";
import type { BrowserIncomingMessage } from "./session-types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal user_message for testing. */
function userMsg(content: string, agentSource?: { sessionId: string; sessionLabel?: string }): BrowserIncomingMessage {
  return {
    type: "user_message",
    content,
    timestamp: Date.now(),
    ...(agentSource ? { agentSource } : {}),
  } as BrowserIncomingMessage;
}

/** Build a minimal assistant message with tool_use blocks. */
function assistantMsg(
  text: string,
  tools: Array<{ name: string; input: Record<string, unknown> }> = [],
): BrowserIncomingMessage {
  const content: unknown[] = [];
  if (text) content.push({ type: "text", text });
  for (const t of tools) {
    content.push({ type: "tool_use", id: `tu-${Math.random()}`, name: t.name, input: t.input });
  }
  return {
    type: "assistant",
    message: { content },
    timestamp: Date.now(),
  } as BrowserIncomingMessage;
}

/** Build a minimal result message. */
function resultMsg(result: string, is_error = false): BrowserIncomingMessage {
  return {
    type: "result",
    data: { result, is_error, duration_ms: 5000 },
  } as BrowserIncomingMessage;
}

/** Build a permission_request message. */
function permissionRequestMsg(tool_name: string, description?: string): BrowserIncomingMessage {
  return {
    type: "permission_request",
    request: { request_id: "r-1", tool_name, tool_use_id: "tu-1", input: {}, timestamp: Date.now(), description },
  } as BrowserIncomingMessage;
}

/** Build a permission_approved message. */
function permissionApprovedMsg(tool_name: string, summary: string): BrowserIncomingMessage {
  return {
    type: "permission_approved",
    tool_name,
    summary,
    timestamp: Date.now(),
  } as BrowserIncomingMessage;
}

/** Build a permission_denied message. */
function permissionDeniedMsg(tool_name: string, summary: string): BrowserIncomingMessage {
  return {
    type: "permission_denied",
    tool_name,
    summary,
    timestamp: Date.now(),
  } as BrowserIncomingMessage;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("formatActivitySummary", () => {
  it("formats a simple user → assistant → result turn", () => {
    const messages = [
      userMsg("Fix the login bug"),
      assistantMsg("Working on it", [
        { name: "Read", input: { file_path: "/src/auth.ts" } },
        { name: "Edit", input: { file_path: "/src/auth.ts" } },
      ]),
      resultMsg("Fixed the login validation logic"),
    ];
    const result = formatActivitySummary(messages, { startIdx: 100 });

    // User message: tagged, quoted, no indent
    expect(result).toContain('[100] user: "Fix the login bug"');
    // Assistant: no asst: tag, quoted text, tool details hidden in body
    expect(result).toContain('[101] "Working on it"');
    expect(result).not.toContain("Read: auth.ts");
    expect(result).toContain("Tool Calls not shown above: 1 Read, 1 Edit.");
    expect(result).not.toContain("asst:");
    // Result with success icon, quoted
    expect(result).toContain('[102] ✓ "Fixed the login validation logic"');
  });

  it("formats user messages from different sources", () => {
    const messages = [
      userMsg("direct user input"),
      userMsg("herd injected", { sessionId: "herd-events", sessionLabel: "Herd Events" }),
      userMsg("agent dispatched", { sessionId: "sess-123", sessionLabel: "#5" }),
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });

    expect(result).toContain('[0] user: "direct user input"');
    expect(result).toContain('[1] herd: "herd injected"');
    expect(result).toContain('[2] agent(#5): "agent dispatched"');
  });

  it("compresses tool-only periods into a placeholder plus aggregated counts", () => {
    const messages = [
      assistantMsg("", [
        { name: "Read", input: { file_path: "/a.ts" } },
        { name: "Read", input: { file_path: "/b.ts" } },
        { name: "Read", input: { file_path: "/c.ts" } },
      ]),
    ];
    const result = formatActivitySummary(messages, { startIdx: 50 });
    expect(result).toContain("[50] tool activity only (details hidden)");
    expect(result).toContain("Tool Calls not shown above: 3 Read.");
  });

  it("groups hidden tool counts by category and formats them concisely", () => {
    const messages = [
      assistantMsg("", [
        { name: "Bash", input: { command: "bun test" } },
        { name: "Read", input: { file_path: "/a.ts" } },
        { name: "Bash", input: { command: "bun typecheck" } },
      ]),
    ];
    const result = formatActivitySummary(messages, { startIdx: 10 });
    expect(result).toContain("Tool Calls not shown above: 2 Bash, 1 Read.");
  });

  it("hides individual tool-call lines in mixed periods but preserves important non-tool activity", () => {
    const messages = [
      userMsg("Fix the auth flow"),
      assistantMsg("Investigating the auth flow", [
        { name: "Bash", input: { command: "bun test auth" } },
        { name: "Read", input: { file_path: "/src/auth.ts" } },
      ]),
      resultMsg("Done"),
    ];
    const result = formatActivitySummary(messages, { startIdx: 10 });
    expect(result).toContain('[10] user: "Fix the auth flow"');
    expect(result).toContain('[11] "Investigating the auth flow"');
    expect(result).toContain('[12] ✓ "Done"');
    expect(result).not.toContain("Bash:");
    expect(result).not.toContain("Read:");
    expect(result).toContain("Tool Calls not shown above: 1 Bash, 1 Read.");
  });

  it("formats error results with ✗ icon", () => {
    const messages = [resultMsg("TypeError: x is not defined", true)];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    expect(result).toContain('[0] ✗ "TypeError: x is not defined"');
  });

  it("formats permission_request with tool name and description", () => {
    const messages = [permissionRequestMsg("Bash", "rm -rf /tmp/build")];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    expect(result).toContain("[0] ⏸ permission Bash: rm -rf /tmp/build");
  });

  it("formats permission_approved and permission_denied with sys: tag", () => {
    const messages = [permissionApprovedMsg("Bash", "bun test"), permissionDeniedMsg("Edit", "modify /etc/hosts")];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    expect(result).toContain("[0] sys: ✓ Bash -- bun test");
    expect(result).toContain("[1] sys: ✗ Edit -- modify /etc/hosts");
  });

  it("returns empty string for empty message array", () => {
    const result = formatActivitySummary([], { startIdx: 0 });
    expect(result).toBe("");
  });

  it("skips non-formattable message types", () => {
    const messages = [
      { type: "stream_event", event: {} } as BrowserIncomingMessage,
      { type: "tool_progress", tool_use_id: "x", tool_name: "Read" } as BrowserIncomingMessage,
      userMsg("visible message"),
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    // Only the user message should appear; indices count all messages
    expect(result).toContain("[2] user:");
    // Stream and tool_progress should not appear
    expect(result).not.toContain("stream");
    expect(result).not.toContain("tool_progress");
  });

  it("skips assistant messages with no text and no tools", () => {
    const messages = [
      assistantMsg("", []), // empty assistant message
      userMsg("next message"),
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    // The empty assistant should be skipped
    expect(result).not.toContain("[0]");
    expect(result).toContain("[1] user:");
  });

  it("truncates with tail-priority: keeps first line + skip marker + last N lines", () => {
    // Create 20 messages: many assistant messages plus a final result.
    // Each assistant has text + tools = 2 lines. With maxLines=5:
    //   first 2 lines (step 0) + skip marker + last 4 lines
    const messages: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 19; i++) {
      messages.push(assistantMsg(`step ${i}`, [{ name: "Read", input: { file_path: `/file${i}.ts` } }]));
    }
    messages.push(resultMsg("All done"));

    const result = formatActivitySummary(messages, { startIdx: 0, maxLines: 5 });
    const lines = result.split("\n");

    // First line should be the first message (step 0)
    expect(lines[0]).toContain("[0]");
    expect(lines[0]).toContain("step 0");
    // Skip marker should be present (no indent)
    expect(result).toContain("...");
    expect(result).toContain("skipped");
    // Last lines should be the TAIL (most recent messages)
    expect(result).toContain("All done");
  });

  it("handles maxLines=1 edge case: head + skip marker, no tail", () => {
    // With maxLines=1 and multiple messages, tailCount = 0, so output is
    // just the first line + skip marker (no tail lines).
    const messages = [userMsg("first"), userMsg("second"), userMsg("third")];
    const result = formatActivitySummary(messages, { startIdx: 0, maxLines: 1 });
    const lines = result.split("\n");

    expect(lines[0]).toContain('[0] user: "first"');
    expect(lines[1]).toContain("2 messages skipped");
    expect(lines.length).toBe(2);
  });

  it("does not truncate when exactly at maxLines boundary", () => {
    // 3 formattable messages with maxLines=3 should NOT truncate
    const messages = [userMsg("a"), userMsg("b"), userMsg("c")];
    const result = formatActivitySummary(messages, { startIdx: 0, maxLines: 3 });
    expect(result).not.toContain("skipped");
    expect(result.split("\n").length).toBe(3);

    // 4 formattable messages with maxLines=3 SHOULD truncate
    const messages4 = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    const result4 = formatActivitySummary(messages4, { startIdx: 0, maxLines: 3 });
    expect(result4).toContain("skipped");
    // Tail should have the last 2 messages
    expect(result4).toContain('[2] user: "c"');
    expect(result4).toContain('[3] user: "d"');
  });

  it("truncates long user message content with char count when not key message", () => {
    // When a user message is NOT the key message (i.e. not the last formattable),
    // it should be truncated at 1000 chars (HIGH_SIGNAL_LIMIT) with +N chars suffix.
    const longContent = "a".repeat(2000);
    const messages = [userMsg(longContent), resultMsg("done")];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    // The user message line should be truncated with char count
    const userLine = result.split("\n").find((l) => l.includes("[0] user:"));
    expect(userLine).toBeDefined();
    expect(userLine!.length).toBeLessThan(1100); // 1000 + prefix overhead
    expect(userLine!).toContain("+1000 chars");
  });

  it("truncates non-key assistant text to short 120-char limit with char count", () => {
    // Non-key assistant messages (narration) use the short limit
    const longText = "b".repeat(300);
    const messages = [
      assistantMsg(longText),
      assistantMsg("final conclusion"), // this is the key message (last formattable)
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    // The first assistant's text should be truncated at 120 chars with char count
    const firstLine = result.split("\n")[0];
    expect(firstLine.length).toBeLessThan(200);
    expect(firstLine).toContain("+180 chars");
  });

  it("uses generous 5000-char limit for the key message (last formattable)", () => {
    // The last formattable message is the "key message" and gets a generous limit.
    const conclusion = "This is the worker's detailed summary. ".repeat(50); // ~1900 chars
    const messages = [
      userMsg("Fix the bug"),
      assistantMsg("Looking into it", [{ name: "Read", input: { file_path: "/src/auth.ts" } }]),
      assistantMsg(conclusion),
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });

    // The key message should NOT be truncated (it's under 5000 chars)
    expect(result).toContain("This is the worker's detailed summary.");
    // Count how much of the conclusion appears
    const lastLine = result.split("\n").find((l) => l.includes("worker's detailed summary"));
    expect(lastLine).toBeDefined();
    expect(lastLine!.length).toBeGreaterThan(500); // way more than the 120-char limit
  });

  it("truncates key message at 5000 chars with char count, not at 120", () => {
    const hugeConclusion = "x".repeat(6000);
    const messages = [assistantMsg(hugeConclusion)];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    // Should be truncated at ~5000, not at 120
    expect(result.length).toBeGreaterThan(4000);
    expect(result.length).toBeLessThan(5200);
    expect(result).toContain("+1000 chars");
  });

  it("applies key message limit to user_message when it is the last formattable", () => {
    // When a user_message is the last formattable message (e.g. in a user_message event),
    // it should get the generous 5000-char limit instead of the standard 1000-char limit.
    const longUserMsg = "Important context: ".repeat(200); // ~3800 chars
    const messages = [assistantMsg("working", [{ name: "Read", input: { file_path: "/a.ts" } }]), userMsg(longUserMsg)];
    const result = formatActivitySummary(messages, { startIdx: 0 });

    // The user message should NOT be truncated (under 5000 chars)
    expect(result).not.toContain("+");
    expect(result).toContain("Important context:");
  });

  it("applies key message limit to result when it is the last formattable", () => {
    // When a result is the last formattable message, it should get 5000-char limit.
    const longResult = "Detailed output: ".repeat(200); // ~3400 chars
    const messages = [userMsg("run build"), resultMsg(longResult)];
    const result = formatActivitySummary(messages, { startIdx: 0 });

    // The result should NOT be truncated (under 5000 chars)
    expect(result).not.toContain("+");
    expect(result).toContain("Detailed output:");
  });

  it("applies key message limit to permission_request when it is the last formattable", () => {
    // When a permission_request is the last formattable message, its description
    // should get the generous 5000-char limit.
    const longDesc = "Plan: ".repeat(500); // ~3000 chars
    const messages = [
      assistantMsg("analyzing", [{ name: "Grep", input: { pattern: "foo" } }]),
      permissionRequestMsg("Bash", longDesc),
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });

    // The permission description should NOT be truncated (under 5000 chars)
    const permLine = result.split("\n").find((l) => l.includes("⏸ permission"));
    expect(permLine).toBeDefined();
    expect(permLine!).not.toContain("…");
  });

  it("preserves key message in the tail when maxLines exceeded", () => {
    // The key message (last formattable = worker's conclusion) is naturally
    // in the tail, so tail-priority truncation preserves it.
    const messages: BrowserIncomingMessage[] = [];
    // Fill 20 assistant messages to exceed maxLines (5)
    for (let i = 0; i < 19; i++) {
      messages.push(assistantMsg(`step ${i}`, [{ name: "Read", input: { file_path: `/file${i}.ts` } }]));
    }
    // Key message: the last assistant (worker's conclusion)
    const conclusion = "This is the worker's detailed conclusion with many important details.";
    messages.push(assistantMsg(conclusion));

    const result = formatActivitySummary(messages, { startIdx: 0, maxLines: 5 });

    // The key message (last assistant) should be preserved in the tail
    expect(result).toContain("worker's detailed conclusion");
    // Skip marker should be present
    expect(result).toContain("skipped");
    // Early messages (middle) should be skipped, not the tail
    expect(result).not.toContain("step 5");
    expect(result).not.toContain("step 10");
  });

  it("applies key message limit to permission_approved/denied when last formattable", () => {
    // When permission_approved is the key message, its summary
    // should get KEY_MESSAGE_LIMIT (5000) instead of the default 80-char limit.
    const longSummary = "Justification: ".repeat(250); // ~3750 chars
    const messages = [userMsg("Deploy"), permissionApprovedMsg("Bash", longSummary)];
    const result = formatActivitySummary(messages, { startIdx: 0 });

    // The summary should NOT be truncated at 80 chars
    const permLine = result.split("\n").find((l) => l.includes("sys:"));
    expect(permLine).toBeDefined();
    expect(permLine!).not.toContain("…");
    expect(permLine!.length).toBeGreaterThan(1000);
  });

  it("escapes special characters in string literals", () => {
    // Multi-line content should use \n escaping, not actual newlines
    const multiline = 'Line 1\nLine 2\tTabbed\n"Quoted"';
    const messages = [userMsg(multiline)];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    // Content should be on one visual line with escaped characters
    expect(result.split("\n").length).toBe(1);
    expect(result).toContain("\\n");
    expect(result).toContain("\\t");
    expect(result).toContain('\\"');
  });

  it("does not render a separate indented tool line below assistant text", () => {
    const messages = [
      assistantMsg("Let me check", [
        { name: "Read", input: { file_path: "/src/auth.ts" } },
        { name: "Bash", input: { command: "bun test" } },
      ]),
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    const lines = result.split("\n");
    // First line: assistant text only
    expect(lines[0]).toContain('"Let me check"');
    expect(lines[0]).not.toContain("Read");
    expect(lines[0]).not.toContain("Bash");
    // Second line: aggregate tool summary, not raw tool detail
    expect(lines[1]).toBe("Tool Calls not shown above: 1 Read, 1 Bash.");
  });
});
