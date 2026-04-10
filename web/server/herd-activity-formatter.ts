/**
 * Formats a slice of session messageHistory into a compact activity summary
 * for injection into herd event batches. Also reusable by the CLI peek formatter.
 *
 * Design goals:
 * - High-signal: user messages, permission requests, and turn results get generous
 *   content limits (1000 chars) because they're what the leader needs to act on.
 * - Low-noise: assistant messages with tool calls collapse to one-line tool counts.
 * - Key message: the last formattable message in each slice gets a generous 5000-char
 *   limit because it's the event's "key message" (turn conclusion, permission content,
 *   user instruction, etc.). This message is NEVER skipped by MAX_LINES truncation.
 * - Bounded: capped at MAX_LINES to prevent context bloat in the leader's conversation.
 */

import type { BrowserIncomingMessage, ContentBlock } from "./session-types.js";
import { buildToolSummary } from "./takode-messages.js";

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Max output lines before truncation. Keeps herd event messages bounded. */
const MAX_LINES = 15;
/** Content limit for high-signal messages (user, permission, result). */
const HIGH_SIGNAL_LIMIT = 1000;
/** Content limit for assistant narration text (lower signal -- tools carry the info). */
const ASST_TEXT_LIMIT = 120;
/** Content limit for the key message in each event (the triggering message). */
const KEY_MESSAGE_LIMIT = 5000;

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
 * - assistant (non-key): tool calls collapsed to counts; text truncated short (120 chars)
 * - result (non-key): shown with generous 1000-char limit (the outcome)
 * - permission_approved/denied: one-line summary
 * - others (stream_event, tool_progress, etc.): skipped
 *
 * The LAST formattable message is the "key message" -- it gets a 5000-char limit
 * and is never skipped by MAX_LINES truncation. This is the event's triggering
 * message: the worker's conclusion (turn_end), permission content (permission_request),
 * user instruction (user_message), or resolution details (permission_resolved).
 */
export function formatActivitySummary(
  messages: BrowserIncomingMessage[],
  options: FormatActivityOptions,
): string {
  const maxLines = options.maxLines ?? MAX_LINES;
  const startIdx = options.startIdx;

  // Find the last formattable message -- it's the "key message" that triggered the event
  // and gets the generous content limit + skip protection.
  const keyMessageIdx = findLastFormattableIndex(messages);

  const lines: string[] = [];
  let skipped = 0;
  let lastSkippedIdx = -1;
  let firstSkippedIdx = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const idx = startIdx + i;
    const isKeyMessage = i === keyMessageIdx;

    // Key message is never skipped -- always preserve it regardless of line count
    if (lines.length >= maxLines && !isKeyMessage) {
      if (!isFormattable(msg)) continue;
      if (firstSkippedIdx < 0) firstSkippedIdx = idx;
      lastSkippedIdx = idx;
      skipped++;
      continue;
    }

    const line = formatMessage(msg, idx, isKeyMessage);
    if (line !== null) lines.push(line);
  }

  // Insert skip marker before the last line if we skipped messages
  if (skipped > 0) {
    const skipLine = `  ... ${skipped} message${skipped === 1 ? "" : "s"} skipped [${firstSkippedIdx}]-[${lastSkippedIdx}]`;
    // Insert before the last line (which is the key message we preserved)
    if (lines.length > 0) {
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
 *  should be skipped (non-formattable type, or assistant with no useful content).
 *  isKeyMessage: when true, uses generous KEY_MESSAGE_LIMIT for content. */
function formatMessage(msg: BrowserIncomingMessage, idx: number, isKeyMessage: boolean): string | null {
  switch (msg.type) {
    case "user_message": {
      const content = msg.content || "";
      const source = formatUserSource(msg);
      const limit = isKeyMessage ? KEY_MESSAGE_LIMIT : HIGH_SIGNAL_LIMIT;
      return `  [${idx}] ${source}: "${truncate(content, limit)}"`;
    }

    case "assistant":
      return formatAssistantMessage(msg, idx, isKeyMessage);

    case "result": {
      const data = msg.data as { result?: string; is_error?: boolean };
      const icon = data.is_error ? "✗" : "✓";
      const text = data.result?.trim() || "done";
      const limit = isKeyMessage ? KEY_MESSAGE_LIMIT : HIGH_SIGNAL_LIMIT;
      return `  [${idx}] ${icon} "${truncate(text, limit)}"`;
    }

    case "permission_request": {
      const req = (msg as { request?: { tool_name?: string; description?: string } }).request;
      const tool = req?.tool_name || "unknown";
      const limit = isKeyMessage ? KEY_MESSAGE_LIMIT : HIGH_SIGNAL_LIMIT;
      const desc = req?.description ? `: ${truncate(req.description, limit)}` : "";
      return `  [${idx}] ⏸ permission ${tool}${desc}`;
    }

    case "permission_approved": {
      const m = msg as { tool_name?: string; summary?: string };
      const limit = isKeyMessage ? KEY_MESSAGE_LIMIT : 80;
      return `  [${idx}] ✓ approved ${m.tool_name || ""}${m.summary ? ` -- ${truncate(m.summary, limit)}` : ""}`;
    }

    case "permission_denied": {
      const m = msg as { tool_name?: string; summary?: string };
      const limit = isKeyMessage ? KEY_MESSAGE_LIMIT : 80;
      return `  [${idx}] ✗ denied ${m.tool_name || ""}${m.summary ? ` -- ${truncate(m.summary, limit)}` : ""}`;
    }

    default:
      return null;
  }
}

/** Format an assistant message: text content + collapsed tool counts.
 *  Key messages get a generous content limit for the worker's conclusion. */
function formatAssistantMessage(msg: BrowserIncomingMessage, idx: number, isKeyMessage: boolean): string | null {
  const blocks: ContentBlock[] = (msg as { message?: { content?: ContentBlock[] } }).message?.content || [];
  const textLimit = isKeyMessage ? KEY_MESSAGE_LIMIT : ASST_TEXT_LIMIT;

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
    parts.push(truncate(combinedText, textLimit));
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

/** Find the index of the last formattable message in the slice.
 *  This is the "key message" that triggered the event and gets generous treatment. */
function findLastFormattableIndex(messages: BrowserIncomingMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isFormattable(messages[i])) return i;
  }
  return -1;
}

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
