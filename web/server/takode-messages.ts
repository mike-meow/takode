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
  /** Detailed tool calls (only in detail/expanded mode) */
  tools?: TakodePeekTool[];
  /** Compact tool counts by name, e.g. { Read: 3, Bash: 2 } (for peek/range modes) */
  toolCounts?: Record<string, number>;
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

export interface TurnStats {
  tools: number;
  messages: number;   // assistant messages count
  subagents: number;  // Task tool calls count
}

export interface TakodePeekTurnSummary {
  turnNum: number;
  startIdx: number;
  endIdx: number;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  stats: TurnStats;
  success: boolean | null;
  /** Truncated result or last assistant text for the collapsed one-liner */
  resultPreview: string;
  /** Truncated user message that started this turn */
  userPreview: string;
}

export interface PeekDefaultResponse {
  mode: "default";
  totalTurns: number;
  totalMessages: number;
  /** Collapsed summaries of recent completed turns */
  collapsedTurns: TakodePeekTurnSummary[];
  /** Number of earlier turns not shown */
  omittedTurnCount: number;
  /** The last turn, expanded with messages */
  expandedTurn: (TakodePeekTurn & {
    stats: TurnStats;
    omittedMessageCount: number;
  }) | null;
}

export interface PeekRangeResponse {
  mode: "range";
  totalMessages: number;
  from: number;
  to: number;
  messages: TakodePeekMessage[];
  turnBoundaries: { turnNum: number; startIdx: number; endIdx: number }[];
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

/** Count tools, assistant messages, and Task subagents within a turn range. */
function computeTurnStats(
  messages: BrowserIncomingMessage[],
  startIdx: number,
  endIdx: number,
): TurnStats {
  let tools = 0, msgs = 0, subagents = 0;
  const endBound = endIdx >= 0 ? endIdx : messages.length - 1;
  for (let i = startIdx; i <= endBound; i++) {
    const msg = messages[i];
    if (msg.type === "assistant" && msg.message?.content) {
      msgs++;
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          tools++;
          if ((block as { name: string }).name === "Task") subagents++;
        }
      }
    }
  }
  return { tools, messages: msgs, subagents };
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

/** Build peekable messages for a single turn. Reused by buildPeekResponse, buildPeekDefault, and buildPeekRange. */
function buildTurnMessages(
  messageHistory: BrowserIncomingMessage[],
  turn: TurnBoundary,
  contentLimit: number,
  opts: { full?: boolean; endedAt?: number | null } = {},
): TakodePeekMessage[] {
  const { full = false, endedAt = null } = opts;
  const startMsg = messageHistory[turn.startIdx];
  const startedAt = extractTimestamp(startMsg);

  const endBound = turn.endIdx >= 0 ? turn.endIdx : messageHistory.length - 1;
  const peekMessages: TakodePeekMessage[] = [];
  let lastKnownTs = startedAt;

  for (let i = turn.startIdx; i <= endBound; i++) {
    const msg = messageHistory[i];
    if (!isPeekable(msg)) continue;

    let ts = extractTimestamp(msg);
    // Result messages have no timestamp — use endedAt or last known timestamp
    if (ts === 0) ts = endedAt || lastKnownTs;
    if (ts > 0) lastKnownTs = ts;

    // For assistant messages, only show text blocks (not tool_use)
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

  return peekMessages;
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

  return filteredTurns.map((turn) => {
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

    const peekMessages = buildTurnMessages(messageHistory, turn, contentLimit, { full, endedAt });

    return {
      turnNum: allTurns.indexOf(turn),
      startedAt,
      endedAt,
      durationMs,
      messages: peekMessages,
    };
  });
}

/**
 * Build a "default" peek response: collapsed summaries of recent turns
 * plus the last turn expanded with messages.
 */
export function buildPeekDefault(
  messageHistory: BrowserIncomingMessage[],
  options: { collapsedCount?: number; expandLimit?: number } = {},
): PeekDefaultResponse {
  const { collapsedCount = 5, expandLimit = 10 } = options;
  const contentLimit = 120;

  const allTurns = findTurnBoundaries(messageHistory);
  const totalTurns = allTurns.length;
  const totalMessages = messageHistory.length;

  if (totalTurns === 0) {
    return { mode: "default", totalTurns: 0, totalMessages, collapsedTurns: [], omittedTurnCount: 0, expandedTurn: null };
  }

  // Last turn = expanded
  const lastTurn = allTurns[allTurns.length - 1];

  // Turns before last = candidates for collapsed summaries
  const priorTurns = allTurns.slice(0, -1);

  // Take last N prior turns as collapsed
  const collapsedSlice = priorTurns.slice(-collapsedCount);
  const omittedTurnCount = priorTurns.length - collapsedSlice.length;

  // Build collapsed summaries
  const collapsedTurns: TakodePeekTurnSummary[] = collapsedSlice.map(turn => {
    const startMsg = messageHistory[turn.startIdx];
    const endMsg = turn.endIdx >= 0 ? messageHistory[turn.endIdx] : null;
    const startedAt = extractTimestamp(startMsg);
    const durationMs = endMsg?.type === "result"
      ? ((endMsg.data as CLIResultMessage).duration_ms ?? null)
      : null;
    const endedAt = durationMs && startedAt ? startedAt + durationMs : null;
    const stats = computeTurnStats(messageHistory, turn.startIdx, turn.endIdx);

    // Success from result
    const success = endMsg?.type === "result" ? !(endMsg.data as CLIResultMessage).is_error : null;

    // Result preview: use result text or last assistant text
    let resultPreview = "";
    if (endMsg?.type === "result") {
      const data = endMsg.data as CLIResultMessage;
      resultPreview = truncate(data.result || "", contentLimit);
    }
    if (!resultPreview) {
      // Fall back to last assistant text in this turn
      const endBound = turn.endIdx >= 0 ? turn.endIdx : messageHistory.length - 1;
      for (let i = endBound; i >= turn.startIdx; i--) {
        const msg = messageHistory[i];
        if (msg.type === "assistant" && msg.message?.content) {
          const text = extractTextFromBlocks(msg.message.content).trim();
          if (text) { resultPreview = truncate(text, contentLimit); break; }
        }
      }
    }

    // User preview
    const userPreview = startMsg.type === "user_message"
      ? truncate(startMsg.content || "", 80)
      : "";

    return {
      turnNum: allTurns.indexOf(turn),
      startIdx: turn.startIdx,
      endIdx: turn.endIdx,
      startedAt,
      endedAt,
      durationMs,
      stats,
      success,
      resultPreview,
      userPreview,
    };
  });

  // Build expanded last turn (reuse extracted message-building logic)
  const startMsg = messageHistory[lastTurn.startIdx];
  const endMsg = lastTurn.endIdx >= 0 ? messageHistory[lastTurn.endIdx] : null;
  const startedAt = extractTimestamp(startMsg);
  const durationMs = endMsg?.type === "result"
    ? ((endMsg.data as CLIResultMessage).duration_ms ?? null)
    : null;
  const endedAt = durationMs && startedAt ? startedAt + durationMs : null;

  const expandedMessages = buildTurnMessages(messageHistory, lastTurn, contentLimit, { endedAt });
  const lastTurnStats = computeTurnStats(messageHistory, lastTurn.startIdx, lastTurn.endIdx);

  // Apply expandLimit — keep only the last N messages, track omitted count
  const omittedMessageCount = Math.max(0, expandedMessages.length - expandLimit);
  const visibleMessages = expandedMessages.slice(-expandLimit);

  return {
    mode: "default",
    totalTurns,
    totalMessages,
    collapsedTurns,
    omittedTurnCount,
    expandedTurn: {
      turnNum: allTurns.indexOf(lastTurn),
      startedAt,
      endedAt,
      durationMs,
      messages: visibleMessages,
      stats: lastTurnStats,
      omittedMessageCount,
    },
  };
}

/**
 * Build a "range" peek response: messages around a specific index,
 * with turn boundary annotations for context.
 */
export function buildPeekRange(
  messageHistory: BrowserIncomingMessage[],
  from: number,
  count: number = 30,
): PeekRangeResponse {
  const totalMessages = messageHistory.length;
  const clampedFrom = Math.max(0, Math.min(from, totalMessages - 1));

  const contentLimit = 120;
  const allTurns = findTurnBoundaries(messageHistory);

  // Collect peekable messages starting from `from`, up to `count` peekable messages
  const messages: TakodePeekMessage[] = [];
  let lastKnownTs = 0;
  let scanEnd = clampedFrom; // track how far we actually scanned

  for (let i = clampedFrom; i < totalMessages && messages.length < count; i++) {
    scanEnd = i;
    const msg = messageHistory[i];
    if (!isPeekable(msg)) continue;

    let ts = extractTimestamp(msg);
    if (ts === 0) ts = lastKnownTs;
    if (ts > 0) lastKnownTs = ts;

    let rawText: string;
    if (msg.type === "assistant" && msg.message?.content) {
      rawText = extractTextFromBlocks(msg.message.content);
    } else {
      rawText = extractFullText(msg);
    }
    const content = truncate(rawText, contentLimit);

    const peekMsg: TakodePeekMessage = { idx: i, type: toPeekType(msg.type), content, ts };

    // Compact tool counts (not individual tool lines — use `read` for details)
    if (msg.type === "assistant" && msg.message?.content) {
      const toolBlocks = extractToolUseBlocks(msg.message.content);
      if (toolBlocks.length > 0) {
        const counts: Record<string, number> = {};
        for (const block of toolBlocks) {
          counts[block.name] = (counts[block.name] || 0) + 1;
        }
        peekMsg.toolCounts = counts;
      }
    }

    if (msg.type === "result") {
      peekMsg.success = !(msg.data as CLIResultMessage).is_error;
      peekMsg.turnDurationMs = (msg.data as CLIResultMessage).duration_ms;
    }

    messages.push(peekMsg);
  }

  // Find overlapping turn boundaries
  const turnBoundaries = allTurns
    .filter(t => {
      const tEnd = t.endIdx >= 0 ? t.endIdx : totalMessages - 1;
      return t.startIdx <= scanEnd && tEnd >= clampedFrom;
    })
    .map(t => ({
      turnNum: allTurns.indexOf(t),
      startIdx: t.startIdx,
      endIdx: t.endIdx,
    }));

  return {
    mode: "range",
    totalMessages,
    from: clampedFrom,
    to: scanEnd,
    messages,
    turnBoundaries,
  };
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
  let ts = extractTimestamp(msg);
  // Backwards-scan fallback: if message has no timestamp, find the nearest prior one
  if (ts === 0 && idx > 0) {
    for (let i = idx - 1; i >= 0; i--) {
      const prevTs = extractTimestamp(messageHistory[i]);
      if (prevTs > 0) { ts = prevTs; break; }
    }
  }

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
