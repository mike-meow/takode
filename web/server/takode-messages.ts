/**
 * Message processing for the Takode orchestration peek/read API.
 *
 * Transforms raw BrowserIncomingMessage history into structured responses
 * that orchestrator agents can consume to monitor session progress without
 * needing the full WebSocket firehose.
 */

import type { BrowserIncomingMessage, CLIResultMessage, ContentBlock } from "./session-types.js";

// ─── Peek Response Types ──────────────────────────────────────────────────────

export interface TakodePeekTool {
  /** Index of the tool_use content block within the assistant message's contentBlocks */
  idx: number;
  name: string;
  /** One-line summary (e.g. "server/routes.ts +15 lines") */
  summary: string;
}

export interface TakodePeekMessage {
  /** Array index in messageHistory */
  idx: number;
  type: "user" | "assistant" | "result" | "system";
  /** Text content (truncated in peek mode) */
  content: string;
  /** Epoch ms timestamp */
  ts: number;
  /** Tool calls (only for assistant messages) */
  tools?: TakodePeekTool[];
  /** Turn duration in ms (only for result messages) */
  turnDurationMs?: number;
  /** Whether the result was successful (only for result messages) */
  success?: boolean;
}

export interface TakodePeekTurn {
  turnNum: number;
  /** Timestamp of the user message that started this turn */
  startedAt: number;
  /** Timestamp of the result message (null if still running) */
  endedAt: number | null;
  durationMs: number | null;
  messages: TakodePeekMessage[];
}

export interface TakodeReadResponse {
  idx: number;
  type: string;
  ts: number;
  totalLines: number;
  offset: number;
  limit: number;
  /** Full text content (paginated by lines) */
  content: string;
  /** Raw content blocks for assistant messages */
  contentBlocks?: unknown[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `... [+${s.length - max} chars]`;
}

/** Extract the most informative argument for each tool type as a one-line summary. */
export function buildToolSummary(name: string, input: Record<string, unknown>): string {
  const path = (input.file_path as string) || "";
  const basename = path.split("/").pop() || path;
  switch (name) {
    case "Bash": return truncate(String(input.command || ""), 60);
    case "Edit": return basename;
    case "Read": return basename;
    case "Write": return `${basename} (new)`;
    case "Glob": return truncate(String(input.pattern || ""), 40);
    case "Grep": return truncate(String(input.pattern || ""), 40);
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === "string") return truncate(v, 40);
      }
      return "";
    }
  }
}

// ─── Message Text Extraction ──────────────────────────────────────────────────

/** Extract text from content blocks (join all text blocks). */
function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Extract tool_use blocks from content blocks. */
function extractToolUseBlocks(blocks: ContentBlock[]): { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }[] {
  return blocks.filter(
    (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use",
  );
}

/** Stringify a tool_use block for full-text read output. */
function stringifyToolUse(block: { name: string; input: Record<string, unknown> }): string {
  return `[Tool: ${block.name}] ${JSON.stringify(block.input)}`;
}

/** Stringify a tool_result block for full-text read output. */
function stringifyToolResult(block: { tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }): string {
  const content = typeof block.content === "string"
    ? block.content
    : block.content.map((b) => ("text" in b ? b.text : JSON.stringify(b))).join("\n");
  const prefix = block.is_error ? "[Tool Error]" : "[Tool Result]";
  return `${prefix} ${content}`;
}

/** Get the full text content of any message in the history. */
function extractFullText(msg: BrowserIncomingMessage): string {
  switch (msg.type) {
    case "user_message":
      return msg.content || "";

    case "assistant": {
      const blocks = msg.message?.content || [];
      const parts: string[] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          parts.push(block.text);
        } else if (block.type === "tool_use") {
          parts.push(stringifyToolUse(block));
        } else if (block.type === "tool_result") {
          parts.push(stringifyToolResult(block));
        }
      }
      return parts.join("\n\n");
    }

    case "result": {
      const data = msg.data;
      const parts: string[] = [];
      if (data.result) parts.push(data.result);
      if (data.is_error && data.errors?.length) {
        parts.push("Errors: " + data.errors.join("; "));
      }
      return parts.join("\n");
    }

    case "permission_approved":
      return `Approved: ${msg.tool_name} — ${msg.summary}`;

    case "permission_denied":
      return `Denied: ${msg.tool_name} — ${msg.summary}`;

    case "compact_marker":
      return msg.summary || "[Context compacted]";

    default:
      return "";
  }
}

/** Get the timestamp for any message in the history. */
function extractTimestamp(msg: BrowserIncomingMessage): number {
  switch (msg.type) {
    case "user_message":
      return msg.timestamp || 0;
    case "assistant":
      return (msg as { timestamp?: number }).timestamp || 0;
    case "result":
      // Result messages don't have a direct timestamp; try duration_ms offset from turn start
      return 0;
    case "compact_marker":
      return msg.timestamp || 0;
    case "permission_approved":
    case "permission_denied":
      return msg.timestamp || 0;
    default:
      return 0;
  }
}

// ─── Type Guard Helpers ───────────────────────────────────────────────────────

/** Message types that carry meaningful content for the peek/read API. */
type PeekableType = "user_message" | "assistant" | "result" | "compact_marker"
  | "permission_approved" | "permission_denied";

const PEEKABLE_TYPES = new Set<string>([
  "user_message", "assistant", "result", "compact_marker",
  "permission_approved", "permission_denied",
]);

function isPeekable(msg: BrowserIncomingMessage): boolean {
  return PEEKABLE_TYPES.has(msg.type);
}

/** Map message type to the simplified peek type. */
function toPeekType(type: string): "user" | "assistant" | "result" | "system" {
  if (type === "user_message") return "user";
  if (type === "assistant") return "assistant";
  if (type === "result") return "result";
  return "system";
}

// ─── Turn Detection ───────────────────────────────────────────────────────────

interface TurnBoundary {
  /** Index of the user_message that starts this turn */
  startIdx: number;
  /** Index of the result message that ends this turn, or -1 if still in progress */
  endIdx: number;
}

/**
 * Find turn boundaries by scanning messageHistory.
 * A turn starts with a top-level user_message and ends with a result message.
 */
function findTurnBoundaries(messages: BrowserIncomingMessage[]): TurnBoundary[] {
  const turns: TurnBoundary[] = [];
  let currentStart = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type === "user_message") {
      // If there's a previous turn without a result, close it
      if (currentStart >= 0) {
        turns.push({ startIdx: currentStart, endIdx: -1 });
      }
      currentStart = i;
    } else if (msg.type === "result" && currentStart >= 0) {
      turns.push({ startIdx: currentStart, endIdx: i });
      currentStart = -1;
    }
  }

  // Handle in-progress turn (no result yet)
  if (currentStart >= 0) {
    turns.push({ startIdx: currentStart, endIdx: -1 });
  }

  return turns;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PeekOptions {
  /** Number of recent turns to include (default: 1) */
  turns?: number;
  /** Only include messages with timestamp >= since (epoch ms) */
  since?: number;
  /** If true, include full text (no truncation). Default: false. */
  full?: boolean;
}

/**
 * Build a peek response from message history.
 *
 * Walks the history to identify turn boundaries, then extracts the last N turns
 * with message summaries. Tool calls are summarized with their key argument.
 */
export function buildPeekResponse(
  messageHistory: BrowserIncomingMessage[],
  options: PeekOptions = {},
): TakodePeekTurn[] {
  const { turns: turnCount = 1, since = 0, full = false } = options;
  const contentLimit = 120;

  const allTurns = findTurnBoundaries(messageHistory);

  // Filter by `since`: keep only turns whose start message is >= since
  let filteredTurns = since > 0
    ? allTurns.filter((t) => {
        const startMsg = messageHistory[t.startIdx];
        return extractTimestamp(startMsg) >= since;
      })
    : allTurns;

  // Take the last N turns
  filteredTurns = filteredTurns.slice(-turnCount);

  return filteredTurns.map((turn, turnIdx) => {
    const startMsg = messageHistory[turn.startIdx];
    const endMsg = turn.endIdx >= 0 ? messageHistory[turn.endIdx] : null;

    const startedAt = extractTimestamp(startMsg);
    const durationMs = endMsg?.type === "result"
      ? (endMsg.data as CLIResultMessage).duration_ms ?? null
      : null;
    // Estimate endedAt: use duration offset from start, or find last assistant timestamp
    const endedAt = endMsg
      ? (durationMs && startedAt ? startedAt + durationMs : null)
      : null;

    // Collect peekable messages within this turn's range
    const endBound = turn.endIdx >= 0 ? turn.endIdx : messageHistory.length - 1;
    const peekMessages: TakodePeekMessage[] = [];
    let lastKnownTs = startedAt; // track last known timestamp for result fallback

    for (let i = turn.startIdx; i <= endBound; i++) {
      const msg = messageHistory[i];
      if (!isPeekable(msg)) continue;

      let ts = extractTimestamp(msg);
      // Result messages have no timestamp — use endedAt or last known timestamp
      if (ts === 0) ts = endedAt || lastKnownTs;
      if (ts > 0) lastKnownTs = ts;

      // For assistant messages in peek mode, only show text blocks (not tool_use)
      // since tools are displayed separately in the tools array
      let rawText: string;
      if (msg.type === "assistant" && msg.message?.content) {
        rawText = extractTextFromBlocks(msg.message.content);
      } else {
        rawText = extractFullText(msg);
      }
      const content = full ? rawText : truncate(rawText, contentLimit);

      const peekMsg: TakodePeekMessage = {
        idx: i,
        type: toPeekType(msg.type),
        content,
        ts,
      };

      // Extract tool calls for assistant messages
      if (msg.type === "assistant" && msg.message?.content) {
        const toolBlocks = extractToolUseBlocks(msg.message.content);
        if (toolBlocks.length > 0) {
          peekMsg.tools = toolBlocks.map((block) => {
            const blockIdx = msg.message.content.indexOf(block);
            return {
              idx: blockIdx >= 0 ? blockIdx : 0,
              name: block.name,
              summary: buildToolSummary(block.name, block.input),
            };
          });
        }
      }

      // Extract result metadata
      if (msg.type === "result") {
        const data = msg.data;
        peekMsg.success = !data.is_error;
        peekMsg.turnDurationMs = data.duration_ms;
      }

      peekMessages.push(peekMsg);
    }

    return {
      turnNum: allTurns.indexOf(turn),
      startedAt,
      endedAt,
      durationMs,
      messages: peekMessages,
    };
  });
}

export interface ReadOptions {
  /** Line offset (default: 0) */
  offset?: number;
  /** Max lines to return (default: 200) */
  limit?: number;
}

/**
 * Build a read response for a single message by index.
 *
 * Returns the full text content of the message, paginated by lines,
 * plus raw content blocks for assistant messages.
 */
export function buildReadResponse(
  messageHistory: BrowserIncomingMessage[],
  idx: number,
  options: ReadOptions = {},
): TakodeReadResponse | null {
  if (idx < 0 || idx >= messageHistory.length) return null;

  const { offset = 0, limit = 200 } = options;
  const msg = messageHistory[idx];

  const fullText = extractFullText(msg);
  const lines = fullText.split("\n");
  const paginatedLines = lines.slice(offset, offset + limit);
  const ts = extractTimestamp(msg);

  const response: TakodeReadResponse = {
    idx,
    type: msg.type,
    ts,
    totalLines: lines.length,
    offset,
    limit,
    content: paginatedLines.join("\n"),
  };

  // Include raw content blocks for assistant messages
  if (msg.type === "assistant" && msg.message?.content) {
    response.contentBlocks = msg.message.content;
  }

  return response;
}
