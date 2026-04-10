/**
 * Tests for the herd activity formatter.
 *
 * Verifies that formatActivitySummary() produces correct compact summaries
 * from messageHistory slices, including:
 * - User message rendering with source labels
 * - Assistant tool call collapsing
 * - Result message rendering with success/error icons
 * - Permission request/approved/denied rendering
 * - Truncation when exceeding maxLines cap
 * - Edge cases: empty input, non-formattable messages, single messages
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

    // User message with index and quotes
    expect(result).toContain('[100] user: "Fix the login bug"');
    // Assistant with tool counts
    expect(result).toContain("[101] asst:");
    expect(result).toContain("Read: auth.ts");
    expect(result).toContain("Edit: auth.ts");
    // Result with success icon
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

  it("collapses multiple tool calls of the same type", () => {
    // 3 Read calls → should show Read×3
    const messages = [
      assistantMsg("", [
        { name: "Read", input: { file_path: "/a.ts" } },
        { name: "Read", input: { file_path: "/b.ts" } },
        { name: "Read", input: { file_path: "/c.ts" } },
      ]),
    ];
    const result = formatActivitySummary(messages, { startIdx: 50 });
    expect(result).toContain("Read×3");
  });

  it("shows single tool call with summary instead of count", () => {
    const messages = [
      assistantMsg("", [
        { name: "Bash", input: { command: "bun test" } },
      ]),
    ];
    const result = formatActivitySummary(messages, { startIdx: 10 });
    expect(result).toContain("Bash: bun test");
    expect(result).not.toContain("×");
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

  it("formats permission_approved and permission_denied", () => {
    const messages = [
      permissionApprovedMsg("Bash", "bun test"),
      permissionDeniedMsg("Edit", "modify /etc/hosts"),
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    expect(result).toContain("[0] ✓ approved Bash -- bun test");
    expect(result).toContain("[1] ✗ denied Edit -- modify /etc/hosts");
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
    expect(result).not.toContain("[0] asst");
    expect(result).toContain("[1] user:");
  });

  it("truncates output at maxLines, preserving last result", () => {
    // Create 20 messages: many assistant messages plus a final result
    const messages: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 19; i++) {
      messages.push(
        assistantMsg(`step ${i}`, [{ name: "Read", input: { file_path: `/file${i}.ts` } }]),
      );
    }
    messages.push(resultMsg("All done"));

    const result = formatActivitySummary(messages, { startIdx: 0, maxLines: 5 });

    // Should contain skip marker
    expect(result).toContain("... ");
    expect(result).toContain("skipped");
    // Final result should still be present (preserved even past maxLines)
    expect(result).toContain("✓");
    expect(result).toContain("All done");
    // Total lines should be bounded: 5 initial + 1 skip marker + 1 preserved result = ~7
    const lines = result.split("\n");
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it("truncates long user message content", () => {
    const longContent = "a".repeat(2000);
    const messages = [userMsg(longContent)];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    // Should be truncated (1000 char limit + ellipsis)
    expect(result.length).toBeLessThan(2000);
    expect(result).toContain("…");
  });

  it("truncates non-final assistant text to short 120-char limit", () => {
    // Non-final assistant messages (narration) use the short limit
    const longText = "b".repeat(300);
    const messages = [
      assistantMsg(longText),
      assistantMsg("final conclusion"), // this is the final assistant
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    // The first assistant's text should be truncated at 120 chars
    const firstLine = result.split("\n")[0];
    expect(firstLine.length).toBeLessThan(200);
    expect(firstLine).toContain("…");
  });

  it("uses generous 5000-char limit for the final assistant message (worker conclusion)", () => {
    // The last assistant message in a turn is the worker's conclusion/summary
    // and should get a generous content limit, not the 120-char narration limit.
    const conclusion = "This is the worker's detailed summary. ".repeat(50); // ~1900 chars
    const messages = [
      userMsg("Fix the bug"),
      assistantMsg("Looking into it", [{ name: "Read", input: { file_path: "/src/auth.ts" } }]),
      assistantMsg(conclusion),
    ];
    const result = formatActivitySummary(messages, { startIdx: 0 });

    // The final assistant message should NOT be truncated (it's under 5000 chars)
    expect(result).toContain("This is the worker's detailed summary.");
    // Count how much of the conclusion appears
    const lastLine = result.split("\n").find((l) => l.includes("worker's detailed summary"));
    expect(lastLine).toBeDefined();
    expect(lastLine!.length).toBeGreaterThan(500); // way more than the 120-char limit
  });

  it("truncates final assistant at 5000 chars, not at 120", () => {
    const hugeConclusion = "x".repeat(6000);
    const messages = [assistantMsg(hugeConclusion)];
    const result = formatActivitySummary(messages, { startIdx: 0 });
    // Should be truncated at ~5000, not at 120
    expect(result.length).toBeGreaterThan(4000);
    expect(result.length).toBeLessThan(5100);
    expect(result).toContain("…");
  });
});
