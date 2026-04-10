/**
 * Formats a slice of session messageHistory into a compact activity summary
 * for injection into herd event batches. Also reusable by the CLI peek formatter.
 *
 * Design goals:
 * - High-signal: user messages, permission requests, and turn results get generous
 *   content limits (1000 chars) because they're what the leader needs to act on.
 * - Low-noise: assistant messages with tool calls collapse to one-line tool counts.
 * - Bounded: capped at MAX_LINES to prevent context bloat in the leader's conversation.
 */

import type { BrowserIncomingMessage, ContentBlock } from "./session-types.js";
import { buildToolSummary } from "./takode-messages.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Max output lines before truncation. Keeps herd event messages bounded. */
const MAX_LINES = 15;
/** Content limit for high-signal messages (user, permission, result). */
const HIGH_SIGNAL_LIMIT = 1000;
/** Content limit for assistant text (lower signal -- tools carry the info). */
const ASST_TEXT_LIMIT = 120;

// ─── Public API ─────────────────────────────────────────────────────────────────

export interface FormatActivityOptions {
  /** Base message index offset for display (e.g. msgRange.from). */
  startIdx: number;
  /** Max output lines (default: 15). */
  maxLines?: number;
}

/**
 * Format a slice of messageHistory into a compact activity summary.
 *
 * Returns a multi-line string showing what happened during a turn,
 * suitable for injection into herd event batches.
 *
 * Message types and their treatment:
 * - user_message: shown with generous 1000-char limit (high signal)
 * - permission_request: shown with tool name + description (leader needs context)
 * - assistant: tool calls collapsed to counts; text truncated short
 * - result: shown with generous 1000-char limit (the outcome)
 * - permission_approved/denied: one-line summary
 * - others (stream_event, tool_progress, etc.): skipped
 */
export function formatActivitySummary(
  messages: BrowserIncomingMessage[],
  options: FormatActivityOptions,
): string {
  const maxLines = options.maxLines ?? MAX_LINES;
  const startIdx = options.startIdx;

  const lines: string[] = [];
  let skipped = 0;
  let lastSkippedIdx = -1;
  let firstSkippedIdx = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const idx = startIdx + i;

    // If we're already at the limit, count remaining as skipped
    // (but always allow the last message through if it's a result -- it's the turn outcome)
    if (lines.length >= maxLines) {
      const isLastAndResult = i === messages.length - 1 && msg.type === "result";
      if (!isLastAndResult) {
        if (!isFormattable(msg)) continue;
        if (firstSkippedIdx < 0) firstSkippedIdx = idx;
        lastSkippedIdx = idx;
        skipped++;
        continue;
      }
    }

    const line = formatMessage(msg, idx);
    if (line !== null) lines.push(line);
  }

  // Insert skip marker before the last line if we skipped messages
  if (skipped > 0) {
    const skipLine = `  ... ${skipped} message${skipped === 1 ? "" : "s"} skipped [${firstSkippedIdx}]-[${lastSkippedIdx}]`;
    // Insert before the last line (which is the result we preserved)
    if (lines.length > 0 && skipped > 0) {
      lines.splice(lines.length - 1, 0, skipLine);
    } else {
      lines.push(skipLine);
    }
  }

  return lines.join("\n");
}

// ─── Message Formatting ──────────────────────────────────────────────────────

/** Message types worth including in the activity summary. */
function isFormattable(msg: BrowserIncomingMessage): boolean {
  return (
    msg.type === "user_message" ||
    msg.type === "assistant" ||
    msg.type === "result" ||
    msg.type === "permission_request" ||
    msg.type === "permission_approved" ||
    msg.type === "permission_denied"
  );
}

/** Format a single message into one or more lines. Returns null if the message
 *  should be skipped (non-formattable type, or assistant with no useful content). */
function formatMessage(msg: BrowserIncomingMessage, idx: number): string | null {
  switch (msg.type) {
    case "user_message": {
      const content = msg.content || "";
      const source = formatUserSource(msg);
      return `  [${idx}] ${source}: "${truncate(content, HIGH_SIGNAL_LIMIT)}"`;
    }

    case "assistant":
      return formatAssistantMessage(msg, idx);

    case "result": {
      const data = msg.data as { result?: string; is_error?: boolean };
      const icon = data.is_error ? "✗" : "✓";
      const text = data.result?.trim() || "done";
      return `  [${idx}] ${icon} "${truncate(text, HIGH_SIGNAL_LIMIT)}"`;
    }

    case "permission_request": {
      const req = (msg as { request?: { tool_name?: string; description?: string } }).request;
      const tool = req?.tool_name || "unknown";
      const desc = req?.description ? `: ${truncate(req.description, HIGH_SIGNAL_LIMIT)}` : "";
      return `  [${idx}] ⏸ permission ${tool}${desc}`;
    }

    case "permission_approved": {
      const m = msg as { tool_name?: string; summary?: string };
      return `  [${idx}] ✓ approved ${m.tool_name || ""}${m.summary ? ` -- ${truncate(m.summary, 80)}` : ""}`;
    }

    case "permission_denied": {
      const m = msg as { tool_name?: string; summary?: string };
      return `  [${idx}] ✗ denied ${m.tool_name || ""}${m.summary ? ` -- ${truncate(m.summary, 80)}` : ""}`;
    }

    default:
      return null;
  }
}

/** Format an assistant message: text content (short) + collapsed tool counts. */
function formatAssistantMessage(msg: BrowserIncomingMessage, idx: number): string | null {
  const blocks: ContentBlock[] = (msg as { message?: { content?: ContentBlock[] } }).message?.content || [];

  const textParts: string[] = [];
  const toolCounts: Record<string, number> = {};
  const toolSummaries: Record<string, string[]> = {};

  for (const block of blocks) {
    if (block.type === "text" && block.text?.trim()) {
      textParts.push(block.text.trim());
    } else if (block.type === "tool_use") {
      const name = block.name;
      toolCounts[name] = (toolCounts[name] || 0) + 1;
      if (!toolSummaries[name]) toolSummaries[name] = [];
      const summary = buildToolSummary(name, block.input);
      if (summary) toolSummaries[name].push(summary);
    }
  }

  const hasText = textParts.length > 0;
  const hasTools = Object.keys(toolCounts).length > 0;
  if (!hasText && !hasTools) return null;

  const parts: string[] = [`  [${idx}] asst:`];

  if (hasText) {
    const combinedText = textParts.join(" ");
    parts.push(truncate(combinedText, ASST_TEXT_LIMIT));
  }

  if (hasTools) {
    const toolStr = formatActivityToolLine(toolCounts, toolSummaries);
    if (hasText) {
      parts.push(`| ${toolStr}`);
    } else {
      parts.push(toolStr);
    }
  }

  return parts.join(" ");
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Format tool counts with optional summaries for low-count tools.
 *  e.g. "Read×2, Bash: bun test, Edit store.ts"
 *  Named distinctly from formatToolCounts in herd-event-dispatcher.ts (different signature). */
function formatActivityToolLine(
  counts: Record<string, number>,
  summaries: Record<string, string[]>,
): string {
  return Object.entries(counts)
    .map(([name, count]) => {
      if (count === 1 && summaries[name]?.[0]) {
        return `${name}: ${truncate(summaries[name][0], 40)}`;
      }
      return count > 1 ? `${name}×${count}` : name;
    })
    .join(", ");
}

function formatUserSource(msg: BrowserIncomingMessage): string {
  const agentSource = (msg as { agentSource?: { sessionId?: string; sessionLabel?: string } }).agentSource;
  if (!agentSource) return "user";
  if (agentSource.sessionId === "herd-events") return "herd";
  return agentSource.sessionLabel ? `agent(${agentSource.sessionLabel})` : "agent";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
