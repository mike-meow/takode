/**
 * Message processing for the Takode orchestration peek/read API.
 *
 * Transforms raw BrowserIncomingMessage history into structured responses
 * that orchestrator agents can consume to monitor session progress without
 * needing the full WebSocket firehose.
 */

import type { BrowserIncomingMessage, CLIResultMessage, ContentBlock, ToolResultPreview } from "./session-types.js";
import type { ImageRef } from "./image-store.js";
import { TAKODE_PEEK_CONTENT_LIMIT } from "../shared/takode-constants.js";
import { join } from "node:path";
import { homedir } from "node:os";

/** Default image store base directory (must match image-store.ts). */
const IMAGE_STORE_BASE = join(homedir(), ".companion", "images");

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
  /** Source of the message if injected programmatically (user_message only) */
  agentSource?: { sessionId: string; sessionLabel?: string };
  /** Disk paths of images attached to this message (user_message only).
   *  Points to the full-quality original files in ~/.companion/images/. */
  imagePaths?: string[];
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
  messages: number; // assistant messages count
  subagents: number; // Task tool calls count
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
  /** Source of the user message if injected programmatically */
  agentSource?: { sessionId: string; sessionLabel?: string };
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
  expandedTurn:
    | (TakodePeekTurn & {
        stats: TurnStats;
        omittedMessageCount: number;
      })
    | null;
}

export interface PeekRangeResponse {
  mode: "range";
  totalMessages: number;
  from: number;
  to: number;
  messages: TakodePeekMessage[];
  turnBoundaries: { turnNum: number; startIdx: number; endIdx: number }[];
}

export interface BuildPeekRangeOptions {
  from?: number;
  until?: number;
  count?: number;
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
  /** Disk paths of images attached to this message (user_message only). */
  imagePaths?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** MIME type to file extension mapping (must match image-store.ts). */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** Derive original image file paths from ImageRefs stored in message history.
 *  Original images preserve full quality and metadata — preferred over the
 *  compressed transport JPEGs for downstream consumption. */
function deriveImagePaths(sessionId: string, images: ImageRef[]): string[] {
  const dir = join(IMAGE_STORE_BASE, sessionId);
  return images.map((ref) => {
    const ext = MIME_TO_EXT[ref.media_type] || "bin";
    return join(dir, `${ref.imageId}.orig.${ext}`);
  });
}

/** Extract image paths from a user_message in message history, if present. */
function extractImagePaths(sessionId: string, msg: BrowserIncomingMessage): string[] | undefined {
  if (msg.type !== "user_message") return undefined;
  const images = (msg as { images?: ImageRef[] }).images;
  if (!images?.length) return undefined;
  return deriveImagePaths(sessionId, images);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `... [+${s.length - max} chars]`;
}

/** Extract the most informative argument for each tool type as a one-line summary. */
export function buildToolSummary(name: string, input: Record<string, unknown>): string {
  const path = (input.file_path as string) || "";
  const basename = path.split("/").pop() || path;
  switch (name) {
    case "Bash":
      return truncate(String(input.command || ""), 60);
    case "Edit":
      return basename;
    case "Read":
      return basename;
    case "Write":
      return `${basename} (new)`;
    case "Glob":
      return truncate(String(input.pattern || ""), 40);
    case "Grep":
      return truncate(String(input.pattern || ""), 40);
    default: {
      for (const v of Object.values(input)) {
        if (typeof v === "string") return truncate(v, 40);
      }
      return "";
    }
  }
}

function isSubagentToolName(name: string): boolean {
  return name === "Task" || name === "Agent";
}

function extractToolResultPreviewIndex(messageHistory: BrowserIncomingMessage[]): Map<string, ToolResultPreview> {
  const previews = new Map<string, ToolResultPreview>();
  for (const msg of messageHistory) {
    if (msg.type !== "tool_result_preview") continue;
    for (const preview of msg.previews) {
      previews.set(preview.tool_use_id, preview);
    }
  }
  return previews;
}

function extractSubagentToolUseIds(messageHistory: BrowserIncomingMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messageHistory) {
    if (msg.type !== "assistant" || !msg.message?.content) continue;
    for (const block of msg.message.content) {
      if (block.type === "tool_use" && isSubagentToolName(block.name)) {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

function extractSubagentPreviewText(
  blocks: ContentBlock[],
  toolResultPreviews: Map<string, ToolResultPreview>,
  maxLen: number,
): string {
  const lines = blocks
    .filter(
      (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
        block.type === "tool_use" && isSubagentToolName(block.name),
    )
    .map((block) => {
      const raw = toolResultPreviews.get(block.id)?.content?.trim() || "";
      if (!raw) return "";
      const parsed = parseSubagentResultText(raw).trim();
      return parsed || raw;
    })
    .filter(Boolean)
    .map((text) => truncate(text, maxLen));
  return lines.join("\n");
}

function parseSubagentResultText(raw: string): string {
  try {
    const blocks = JSON.parse(raw);
    if (!Array.isArray(blocks)) return raw;
    const texts: string[] = [];
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") {
        if (/^agentId:|^<usage>/i.test(block.text.trim())) continue;
        texts.push(block.text);
      }
    }
    return texts.length > 0 ? texts.join("\n") : raw;
  } catch {
    return raw;
  }
}

function buildSubagentIndexes(messageHistory: BrowserIncomingMessage[]): {
  subagentToolUseIds: Set<string>;
  toolResultPreviews: Map<string, ToolResultPreview>;
} {
  return {
    subagentToolUseIds: extractSubagentToolUseIds(messageHistory),
    toolResultPreviews: extractToolResultPreviewIndex(messageHistory),
  };
}

function extractSubagentReadText(
  blocks: ContentBlock[],
  toolResultPreviews: Map<string, ToolResultPreview>,
  getToolResult?: (toolUseId: string) => { content: string; is_error: boolean } | null,
): string {
  const subagentBlocks = blocks.filter(
    (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use" && isSubagentToolName(block.name),
  );
  if (subagentBlocks.length === 0) return "";

  const multiple = subagentBlocks.length > 1;
  return subagentBlocks
    .map((block, index) => {
      const fullResult = getToolResult?.(block.id);
      const raw = fullResult?.content || toolResultPreviews.get(block.id)?.content || "";
      if (!raw.trim()) return "";
      const parsed = parseSubagentResultText(raw).trim() || raw.trim();
      if (!parsed) return "";
      if (!multiple) return parsed;
      const summary = buildToolSummary(block.name, block.input);
      const header = summary ? `[Subagent ${index + 1}: ${summary}]` : `[Subagent ${index + 1}]`;
      return `${header}\n${parsed}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function extractAssistantReadText(
  blocks: ContentBlock[],
  toolResultPreviews: Map<string, ToolResultPreview>,
  getToolResult?: (toolUseId: string) => { content: string; is_error: boolean } | null,
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text) parts.push(block.text);
      continue;
    }
    if (block.type === "tool_use") {
      if (isSubagentToolName(block.name)) {
        const resultText = extractSubagentReadText([block], toolResultPreviews, getToolResult);
        parts.push(resultText || stringifyToolUse(block));
      } else {
        parts.push(stringifyToolUse(block));
      }
      continue;
    }
    if (block.type === "tool_result") {
      parts.push(stringifyToolResult(block));
    }
  }
  return parts.join("\n\n");
}

function deriveTurnResultPreview(
  peekMessages: TakodePeekMessage[],
  resultMessage: BrowserIncomingMessage | null,
  contentLimit: number,
): string {
  const assistantPreview = [...peekMessages]
    .reverse()
    .find((msg) => msg.type === "assistant" && msg.content.trim())
    ?.content.trim();
  if (assistantPreview) return truncate(assistantPreview, contentLimit);
  if (resultMessage?.type === "result") {
    return truncate((resultMessage.data as CLIResultMessage).result || "", contentLimit);
  }
  return "";
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
function extractToolUseBlocks(
  blocks: ContentBlock[],
): { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }[] {
  return blocks.filter(
    (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use",
  );
}

/** Stringify a tool_use block for full-text read output. */
function stringifyToolUse(block: { name: string; input: Record<string, unknown> }): string {
  return `[Tool: ${block.name}] ${JSON.stringify(block.input)}`;
}

/** Stringify a tool_result block for full-text read output. */
function stringifyToolResult(block: {
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}): string {
  const content =
    typeof block.content === "string"
      ? block.content
      : block.content.map((b) => ("text" in b ? b.text : JSON.stringify(b))).join("\n");
  const prefix = block.is_error ? "[Tool Error]" : "[Tool Result]";
  return `${prefix} ${content}`;
}

/** Get the full text content of any message in the history.
 *  When sessionId is provided, user messages with images include their file paths. */
function extractFullText(msg: BrowserIncomingMessage, sessionId?: string): string {
  switch (msg.type) {
    case "user_message": {
      const text = msg.content || "";
      if (sessionId) {
        const paths = extractImagePaths(sessionId, msg);
        if (paths?.length) {
          return `${text}\n[📎 ${paths.length} image${paths.length === 1 ? "" : "s"}: ${paths.join(", ")}]`;
        }
      }
      return text;
    }

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
type PeekableType =
  | "user_message"
  | "assistant"
  | "result"
  | "compact_marker"
  | "permission_approved"
  | "permission_denied";

const PEEKABLE_TYPES = new Set<string>([
  "user_message",
  "assistant",
  "result",
  "compact_marker",
  "permission_approved",
  "permission_denied",
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

export interface TurnBoundary {
  /** Index of the user_message that starts this turn */
  startIdx: number;
  /** Index of the result message that ends this turn, or -1 if still in progress */
  endIdx: number;
}

function isSyntheticStopTail(msg: BrowserIncomingMessage): boolean {
  if (msg.type !== "user_message") return false;
  if (!msg.id?.startsWith("stop-")) return false;
  if (!msg.agentSource?.sessionId) return false;
  return msg.content.startsWith("Session stopped by leader #");
}

/**
 * Find turn boundaries by scanning messageHistory.
 * A turn starts with a top-level user_message and ends with a result message.
 */
export function findTurnBoundaries(messages: BrowserIncomingMessage[]): TurnBoundary[] {
  const turns: TurnBoundary[] = [];
  let currentStart = -1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type === "user_message") {
      if (isSyntheticStopTail(msg)) continue;
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
function computeTurnStats(messages: BrowserIncomingMessage[], startIdx: number, endIdx: number): TurnStats {
  let tools = 0,
    msgs = 0,
    subagents = 0;
  const endBound = endIdx >= 0 ? endIdx : messages.length - 1;
  for (let i = startIdx; i <= endBound; i++) {
    const msg = messages[i];
    if (msg.type === "assistant" && msg.message?.content) {
      msgs++;
      for (const block of msg.message.content) {
        if (block.type === "tool_use") {
          tools++;
          const toolName = (block as { name: string }).name;
          if (toolName === "Task" || toolName === "Agent") subagents++;
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
  opts: {
    full?: boolean;
    endedAt?: number | null;
    sessionId?: string;
    subagentToolUseIds?: Set<string>;
    toolResultPreviews?: Map<string, ToolResultPreview>;
  } = {},
): TakodePeekMessage[] {
  const {
    full = false,
    endedAt = null,
    sessionId,
    subagentToolUseIds = new Set<string>(),
    toolResultPreviews = new Map<string, ToolResultPreview>(),
  } = opts;
  const startMsg = messageHistory[turn.startIdx];
  const startedAt = extractTimestamp(startMsg);

  const endBound = turn.endIdx >= 0 ? turn.endIdx : messageHistory.length - 1;
  const peekMessages: TakodePeekMessage[] = [];
  let lastKnownTs = startedAt;

  for (let i = turn.startIdx; i <= endBound; i++) {
    const msg = messageHistory[i];
    if (!isPeekable(msg)) continue;
    if (msg.type === "assistant" && msg.parent_tool_use_id && subagentToolUseIds.has(msg.parent_tool_use_id)) {
      continue;
    }

    let ts = extractTimestamp(msg);
    // Result messages have no timestamp — use endedAt or last known timestamp
    if (ts === 0) ts = endedAt || lastKnownTs;
    if (ts > 0) lastKnownTs = ts;

    // For assistant messages, only show text blocks (not tool_use)
    // since tools are displayed separately in the tools array
    let rawText: string;
    if (msg.type === "assistant" && msg.message?.content) {
      rawText = extractTextFromBlocks(msg.message.content);
      if (!rawText.trim()) {
        rawText = extractSubagentPreviewText(msg.message.content, toolResultPreviews, contentLimit);
      }
    } else {
      rawText = extractFullText(msg, sessionId);
    }
    const content = full ? rawText : truncate(rawText, contentLimit);

    const peekMsg: TakodePeekMessage = {
      idx: i,
      type: toPeekType(msg.type),
      content,
      ts,
    };

    // Include agentSource for user messages (identifies human vs agent vs herd origin)
    if (msg.type === "user_message" && (msg as any).agentSource) {
      peekMsg.agentSource = (msg as any).agentSource;
    }

    // Include image file paths for user messages with attached images
    if (sessionId) {
      const paths = extractImagePaths(sessionId, msg);
      if (paths) peekMsg.imagePaths = paths;
    }

    // Extract tool calls for assistant messages
    if (msg.type === "assistant" && msg.message?.content) {
      const toolBlocks = extractToolUseBlocks(msg.message.content);
      if (toolBlocks.length > 0) {
        const visibleToolBlocks = toolBlocks.filter((block) => {
          if (!isSubagentToolName(block.name)) return true;
          return !toolResultPreviews.has(block.id);
        });
        if (visibleToolBlocks.length > 0) {
          peekMsg.tools = visibleToolBlocks.map((block) => {
            const blockIdx = msg.message.content.indexOf(block);
            return {
              idx: blockIdx >= 0 ? blockIdx : 0,
              name: block.name,
              summary: buildToolSummary(block.name, block.input),
            };
          });
        }
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
  sessionId?: string,
): TakodePeekTurn[] {
  const { turns: turnCount = 1, since = 0, full = false } = options;
  const contentLimit = TAKODE_PEEK_CONTENT_LIMIT;
  const { subagentToolUseIds, toolResultPreviews } = buildSubagentIndexes(messageHistory);

  const allTurns = findTurnBoundaries(messageHistory);

  // Filter by `since`: keep only turns whose start message is >= since
  let filteredTurns =
    since > 0
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
    const durationMs = endMsg?.type === "result" ? ((endMsg.data as CLIResultMessage).duration_ms ?? null) : null;
    // Estimate endedAt: use duration offset from start, or find last assistant timestamp
    const endedAt = endMsg ? (durationMs && startedAt ? startedAt + durationMs : null) : null;

    const peekMessages = buildTurnMessages(messageHistory, turn, contentLimit, {
      full,
      endedAt,
      sessionId,
      subagentToolUseIds,
      toolResultPreviews,
    });

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
  sessionId?: string,
): PeekDefaultResponse {
  const { collapsedCount = 5, expandLimit = 10 } = options;
  const contentLimit = TAKODE_PEEK_CONTENT_LIMIT;
  const { subagentToolUseIds, toolResultPreviews } = buildSubagentIndexes(messageHistory);

  const allTurns = findTurnBoundaries(messageHistory);
  const totalTurns = allTurns.length;
  const totalMessages = messageHistory.length;

  if (totalTurns === 0) {
    return {
      mode: "default",
      totalTurns: 0,
      totalMessages,
      collapsedTurns: [],
      omittedTurnCount: 0,
      expandedTurn: null,
    };
  }

  // Last turn = expanded
  const lastTurn = allTurns[allTurns.length - 1];

  // Turns before last = candidates for collapsed summaries
  const priorTurns = allTurns.slice(0, -1);

  // Take last N prior turns as collapsed
  const collapsedSlice = priorTurns.slice(-collapsedCount);
  const omittedTurnCount = priorTurns.length - collapsedSlice.length;

  // Build collapsed summaries
  const collapsedTurns: TakodePeekTurnSummary[] = collapsedSlice.map((turn) => {
    const startMsg = messageHistory[turn.startIdx];
    const endMsg = turn.endIdx >= 0 ? messageHistory[turn.endIdx] : null;
    const startedAt = extractTimestamp(startMsg);
    const durationMs = endMsg?.type === "result" ? ((endMsg.data as CLIResultMessage).duration_ms ?? null) : null;
    const endedAt = durationMs && startedAt ? startedAt + durationMs : null;
    const stats = computeTurnStats(messageHistory, turn.startIdx, turn.endIdx);

    // Success from result
    const success = endMsg?.type === "result" ? !(endMsg.data as CLIResultMessage).is_error : null;

    const peekMessages = buildTurnMessages(messageHistory, turn, contentLimit, {
      endedAt,
      sessionId,
      subagentToolUseIds,
      toolResultPreviews,
    });
    const resultPreview = deriveTurnResultPreview(peekMessages, endMsg, contentLimit);

    // User preview
    const userPreview = startMsg.type === "user_message" ? truncate(startMsg.content || "", 80) : "";

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
      ...((startMsg as any).agentSource ? { agentSource: (startMsg as any).agentSource } : {}),
    };
  });

  // Build expanded last turn (reuse extracted message-building logic)
  const startMsg = messageHistory[lastTurn.startIdx];
  const endMsg = lastTurn.endIdx >= 0 ? messageHistory[lastTurn.endIdx] : null;
  const startedAt = extractTimestamp(startMsg);
  const durationMs = endMsg?.type === "result" ? ((endMsg.data as CLIResultMessage).duration_ms ?? null) : null;
  const endedAt = durationMs && startedAt ? startedAt + durationMs : null;

  const expandedMessages = buildTurnMessages(messageHistory, lastTurn, contentLimit, {
    endedAt,
    sessionId,
    subagentToolUseIds,
    toolResultPreviews,
  });
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
 * Build a "range" peek response using inclusive raw-history bounds.
 */
export function buildPeekRange(
  messageHistory: BrowserIncomingMessage[],
  options: BuildPeekRangeOptions = {},
  sessionId?: string,
): PeekRangeResponse {
  const totalMessages = messageHistory.length;
  if (totalMessages === 0) {
    return {
      mode: "range",
      totalMessages,
      from: 0,
      to: 0,
      messages: [],
      turnBoundaries: [],
    };
  }

  const count = Number.isFinite(options.count) ? Math.max(1, Math.trunc(options.count as number)) : 60;

  const contentLimit = TAKODE_PEEK_CONTENT_LIMIT;
  const allTurns = findTurnBoundaries(messageHistory);
  const { subagentToolUseIds, toolResultPreviews } = buildSubagentIndexes(messageHistory);

  const isVisibleRangeMessage = (msg: BrowserIncomingMessage): boolean => {
    if (!isPeekable(msg)) return false;
    if (msg.type === "assistant" && msg.parent_tool_use_id && subagentToolUseIds.has(msg.parent_tool_use_id)) {
      return false;
    }
    return true;
  };

  const clampRangeIndex = (idx: number): number => Math.max(0, Math.min(idx, totalMessages - 1));

  const hasFrom = Number.isFinite(options.from);
  const hasUntil = Number.isFinite(options.until);
  const resolvedFrom = hasFrom ? clampRangeIndex(options.from as number) : undefined;
  const resolvedUntil = hasUntil ? clampRangeIndex(options.until as number) : undefined;

  const selectedIndexes: number[] = [];
  let rangeFrom = resolvedFrom ?? 0;
  let rangeTo = resolvedUntil ?? totalMessages - 1;

  if (resolvedFrom !== undefined && resolvedUntil !== undefined) {
    rangeFrom = Math.min(resolvedFrom, resolvedUntil);
    rangeTo = Math.max(resolvedFrom, resolvedUntil);
    for (let i = rangeFrom; i <= rangeTo; i++) {
      const msg = messageHistory[i];
      if (isVisibleRangeMessage(msg)) selectedIndexes.push(i);
    }
  } else if (resolvedFrom !== undefined) {
    rangeFrom = resolvedFrom;
    rangeTo = resolvedFrom;
    for (let i = resolvedFrom; i < totalMessages && selectedIndexes.length < count; i++) {
      rangeTo = i;
      const msg = messageHistory[i];
      if (isVisibleRangeMessage(msg)) selectedIndexes.push(i);
    }
  } else if (resolvedUntil !== undefined) {
    rangeFrom = resolvedUntil;
    rangeTo = resolvedUntil;
    for (let i = resolvedUntil; i >= 0 && selectedIndexes.length < count; i--) {
      rangeFrom = i;
      const msg = messageHistory[i];
      if (isVisibleRangeMessage(msg)) selectedIndexes.push(i);
    }
    selectedIndexes.reverse();
  } else {
    for (let i = 0; i < totalMessages && selectedIndexes.length < count; i++) {
      rangeTo = i;
      const msg = messageHistory[i];
      if (isVisibleRangeMessage(msg)) selectedIndexes.push(i);
    }
  }

  const messages: TakodePeekMessage[] = [];
  let lastKnownTs = 0;
  for (const i of selectedIndexes) {
    const msg = messageHistory[i];

    let ts = extractTimestamp(msg);
    if (ts === 0) ts = lastKnownTs;
    if (ts > 0) lastKnownTs = ts;

    let rawText: string;
    if (msg.type === "assistant" && msg.message?.content) {
      rawText = extractTextFromBlocks(msg.message.content);
      if (!rawText.trim()) {
        rawText = extractSubagentPreviewText(msg.message.content, toolResultPreviews, contentLimit);
      }
    } else {
      rawText = extractFullText(msg, sessionId);
    }
    const content = truncate(rawText, contentLimit);

    const peekMsg: TakodePeekMessage = { idx: i, type: toPeekType(msg.type), content, ts };

    // Include agentSource for user messages (identifies human vs agent vs herd origin)
    if (msg.type === "user_message" && (msg as any).agentSource) {
      peekMsg.agentSource = (msg as any).agentSource;
    }

    // Include image file paths for user messages with attached images
    if (sessionId) {
      const paths = extractImagePaths(sessionId, msg);
      if (paths) peekMsg.imagePaths = paths;
    }

    // Compact tool counts (not individual tool lines — use `read` for details)
    if (msg.type === "assistant" && msg.message?.content) {
      const toolBlocks = extractToolUseBlocks(msg.message.content);
      if (toolBlocks.length > 0) {
        const counts: Record<string, number> = {};
        for (const block of toolBlocks) {
          if (isSubagentToolName(block.name) && toolResultPreviews.has(block.id)) continue;
          counts[block.name] = (counts[block.name] || 0) + 1;
        }
        if (Object.keys(counts).length > 0) {
          peekMsg.toolCounts = counts;
        }
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
    .filter((t) => {
      const tEnd = t.endIdx >= 0 ? t.endIdx : totalMessages - 1;
      return t.startIdx <= rangeTo && tEnd >= rangeFrom;
    })
    .map((t) => ({
      turnNum: allTurns.indexOf(t),
      startIdx: t.startIdx,
      endIdx: t.endIdx,
    }));

  return {
    mode: "range",
    totalMessages,
    from: rangeFrom,
    to: rangeTo,
    messages,
    turnBoundaries,
  };
}

export interface ReadOptions {
  /** Line offset (default: 0) */
  offset?: number;
  /** Max lines to return (default: 200) */
  limit?: number;
  /** Optional full tool_result lookup for expanding sub-agent results. */
  getToolResult?: (toolUseId: string) => { content: string; is_error: boolean } | null;
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
  sessionId?: string,
): TakodeReadResponse | null {
  if (idx < 0 || idx >= messageHistory.length) return null;

  const { offset = 0, limit = 200, getToolResult } = options;
  const msg = messageHistory[idx];
  const { toolResultPreviews } = buildSubagentIndexes(messageHistory);

  const fullText =
    msg.type === "assistant" && msg.message?.content
      ? extractAssistantReadText(msg.message.content, toolResultPreviews, getToolResult)
      : extractFullText(msg, sessionId);
  const lines = fullText.split("\n");
  const paginatedLines = lines.slice(offset, offset + limit);
  let ts = extractTimestamp(msg);
  // Backwards-scan fallback: if message has no timestamp, find the nearest prior one
  if (ts === 0 && idx > 0) {
    for (let i = idx - 1; i >= 0; i--) {
      const prevTs = extractTimestamp(messageHistory[i]);
      if (prevTs > 0) {
        ts = prevTs;
        break;
      }
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

  // Include image file paths for user messages with attached images
  if (sessionId) {
    const paths = extractImagePaths(sessionId, msg);
    if (paths) response.imagePaths = paths;
  }

  return response;
}

// ─── Turn Scan ────────────────────────────────────────────────────────────────

export interface PeekTurnScanResponse {
  mode: "turn_scan";
  totalTurns: number;
  totalMessages: number;
  fromTurn: number;
  /** Number of turns returned in this page */
  returnedTurns: number;
  turns: TakodePeekTurnSummary[];
}

/**
 * Build a paginated "turn scan" response: collapsed summaries for a slice of turns.
 * Used by `takode scan` to give agents a quick overview of what happened across a session.
 */
export function buildPeekTurnScan(
  messageHistory: BrowserIncomingMessage[],
  options: { fromTurn?: number; turnCount?: number } = {},
  sessionId?: string,
): PeekTurnScanResponse {
  const { fromTurn = 0, turnCount = 50 } = options;
  const contentLimit = TAKODE_PEEK_CONTENT_LIMIT;
  const { subagentToolUseIds, toolResultPreviews } = buildSubagentIndexes(messageHistory);

  const allTurns = findTurnBoundaries(messageHistory);
  const totalTurns = allTurns.length;
  const totalMessages = messageHistory.length;

  if (totalTurns === 0 || fromTurn >= totalTurns) {
    return { mode: "turn_scan", totalTurns, totalMessages, fromTurn, returnedTurns: 0, turns: [] };
  }

  const endTurn = Math.min(fromTurn + turnCount, totalTurns);
  const slice = allTurns.slice(fromTurn, endTurn);

  const turns: TakodePeekTurnSummary[] = slice.map((turn, i) => {
    const turnNum = fromTurn + i;
    const startMsg = messageHistory[turn.startIdx];
    const endMsg = turn.endIdx >= 0 ? messageHistory[turn.endIdx] : null;
    const startedAt = extractTimestamp(startMsg);
    const durationMs = endMsg?.type === "result" ? ((endMsg.data as CLIResultMessage).duration_ms ?? null) : null;
    const endedAt = durationMs && startedAt ? startedAt + durationMs : null;
    const stats = computeTurnStats(messageHistory, turn.startIdx, turn.endIdx);
    const success = endMsg?.type === "result" ? !(endMsg.data as CLIResultMessage).is_error : null;

    const peekMessages = buildTurnMessages(messageHistory, turn, contentLimit, {
      endedAt,
      sessionId,
      subagentToolUseIds,
      toolResultPreviews,
    });
    const resultPreview = deriveTurnResultPreview(peekMessages, endMsg, contentLimit);
    const userPreview = startMsg.type === "user_message" ? truncate(startMsg.content || "", 80) : "";

    return {
      turnNum,
      startIdx: turn.startIdx,
      endIdx: turn.endIdx,
      startedAt,
      endedAt,
      durationMs,
      stats,
      success,
      resultPreview,
      userPreview,
      ...((startMsg as any).agentSource ? { agentSource: (startMsg as any).agentSource } : {}),
    };
  });

  return { mode: "turn_scan", totalTurns, totalMessages, fromTurn, returnedTurns: turns.length, turns };
}

// ─── Grep (within-session search) ─────────────────────────────────────────────

export interface GrepMatch {
  /** Message index in history */
  idx: number;
  type: "user" | "assistant" | "result" | "system";
  ts: number;
  /** Snippet with matched text in context (~120 chars) */
  snippet: string;
  /** Which turn this message belongs to */
  turnNum: number | null;
}

export interface GrepResponse {
  totalMatches: number;
  matches: GrepMatch[];
}

/** Build a snippet centered on the first match occurrence. */
function buildGrepSnippet(content: string, re: RegExp, maxLen = 120): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;

  const m = re.exec(text);
  if (!m) return text.slice(0, maxLen).trimEnd();

  const matchLen = m[0].length;
  const contextRadius = Math.floor((maxLen - matchLen) / 2);
  const start = Math.max(0, m.index - contextRadius);
  const end = Math.min(text.length, start + maxLen);
  return text.slice(start, end).trim();
}

/** Try to compile a regex; returns null if invalid. */
function tryCompileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/**
 * Search within a session's message history. Supports regex patterns (case-insensitive).
 * Falls back to literal substring match if the pattern is not valid regex.
 * Optional `type` filter restricts matches to a specific message type.
 */
export function grepMessageHistory(
  history: BrowserIncomingMessage[],
  query: string,
  options: { limit?: number; type?: string } = {},
  sessionId?: string,
): GrepResponse {
  const q = query.trim();
  if (!q) return { totalMatches: 0, matches: [] };

  // Try as regex first, fall back to escaped literal
  const re = tryCompileRegex(q) ?? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const typeFilter = options.type ? options.type.toLowerCase() : null;
  const allTurns = findTurnBoundaries(history);

  // Build turn lookup: message index → turn number
  const turnLookup = new Map<number, number>();
  for (let t = 0; t < allTurns.length; t++) {
    const turn = allTurns[t];
    const endBound = turn.endIdx >= 0 ? turn.endIdx : history.length - 1;
    for (let i = turn.startIdx; i <= endBound; i++) {
      turnLookup.set(i, t);
    }
  }

  const matches: GrepMatch[] = [];
  let totalMatches = 0;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!isPeekable(msg)) continue;

    // Apply type filter
    const msgType = toPeekType(msg.type);
    if (typeFilter && msgType !== typeFilter) continue;

    const fullText = extractFullText(msg, sessionId);
    if (!re.test(fullText)) continue;

    totalMatches++;
    if (matches.length < limit) {
      // Resolve timestamp, with backwards-scan fallback for result messages
      let ts = extractTimestamp(msg);
      if (ts === 0 && i > 0) {
        for (let j = i - 1; j >= 0; j--) {
          const prevTs = extractTimestamp(history[j]);
          if (prevTs > 0) {
            ts = prevTs;
            break;
          }
        }
      }

      matches.push({
        idx: i,
        type: toPeekType(msg.type),
        ts,
        snippet: buildGrepSnippet(fullText, re),
        turnNum: turnLookup.get(i) ?? null,
      });
    }
  }

  return { totalMatches, matches };
}

// ─── Export (dump session to text) ────────────────────────────────────────────

/**
 * Export a full session as a plain text file suitable for offline searching.
 * Format: turn headers + [idx] HH:MM:SS type\ncontent
 */
export function exportSessionAsText(history: BrowserIncomingMessage[], sessionId?: string): string {
  const allTurns = findTurnBoundaries(history);
  const lines: string[] = [];
  let activeTurnIdx = -1;

  // Build message-to-turn lookup
  const turnLookup = new Map<number, number>();
  for (let t = 0; t < allTurns.length; t++) {
    const turn = allTurns[t];
    const endBound = turn.endIdx >= 0 ? turn.endIdx : history.length - 1;
    for (let i = turn.startIdx; i <= endBound; i++) {
      turnLookup.set(i, t);
    }
  }

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!isPeekable(msg)) continue;

    const turnNum = turnLookup.get(i);
    if (turnNum !== undefined && turnNum !== activeTurnIdx) {
      lines.push(`\n--- Turn ${turnNum} ---`);
      activeTurnIdx = turnNum;
    }

    let ts = extractTimestamp(msg);
    if (ts === 0 && i > 0) {
      for (let j = i - 1; j >= 0; j--) {
        const prevTs = extractTimestamp(history[j]);
        if (prevTs > 0) {
          ts = prevTs;
          break;
        }
      }
    }
    const timeStr = ts ? new Date(ts).toISOString().slice(11, 19) : "??:??:??";
    const type = toPeekType(msg.type);
    const text = extractFullText(msg, sessionId);

    lines.push(`[${i}] ${timeStr} ${type}`);
    if (text) lines.push(text);
    lines.push("");
  }

  return lines.join("\n");
}
