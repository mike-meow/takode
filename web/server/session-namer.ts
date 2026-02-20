/**
 * Session auto-namer: constructs a compressed conversation summary and asks
 * Claude Haiku (via `claude -p`) to generate or update a concise session title.
 *
 * Triggered on each new user message. The model can respond with:
 * - A title (first turn — always generates)
 * - NO_CHANGE  — current title is still accurate
 * - REVISE: <title> — same task, better wording
 * - NEW: <title> — fundamentally different task
 */
import type { BrowserIncomingMessage, ContentBlock } from "./session-types.js";
import { resolveBinary, getEnrichedPath } from "./path-resolver.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type NamingResult =
  | { action: "name"; title: string }       // first turn: generated title
  | { action: "no_change" }                  // title still accurate
  | { action: "revise"; title: string }      // same task, better name
  | { action: "new"; title: string };        // new task

// ─── Prompt construction ─────────────────────────────────────────────────────

// ─── Tunable limits ──────────────────────────────────────────────────────────
// All truncation / budget constants live here for easy review.

const INDENT = "    | ";

/** Max characters per user message in the prompt. User messages are the most
 *  informative signal, so this is intentionally generous. */
const MAX_USER_MSG_CHARS = 1_000;

/** Max user turns (user message + agent activity) included in history. */
const MAX_TURNS = 6;

/** Timeout for the `claude -p` subprocess. */
const TIMEOUT_MS = 15_000;

/** Max title length accepted from the model. */
const MAX_TITLE_CHARS = 100;

/** Max characters for a Bash command in a tool-call line. */
const MAX_BASH_CMD_CHARS = 200;

/** Max characters for search patterns (Grep, WebSearch, etc.). */
const MAX_PATTERN_CHARS = 100;

/** Max characters for file paths in tool-call lines. */
const MAX_PATH_CHARS = 100;

/** Max characters for task/agent descriptions. */
const MAX_DESCRIPTION_CHARS = 200;

/** Max characters for generic tool input values. */
const MAX_GENERIC_INPUT_CHARS = 200;

/** Max characters of stderr to log on subprocess failure. */
const MAX_STDERR_LOG_CHARS = 200;

/**
 * Format a single tool_use block into a one-line textual representation.
 * Shows the tool name + key identifying parameter, truncated.
 */
function formatToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
      return `[Read: ${truncPath(str(input.file_path))}]`;
    case "Edit":
      return `[Edit: ${truncPath(str(input.file_path))}]`;
    case "Write":
      return `[Write: ${truncPath(str(input.file_path))}]`;
    case "Bash":
      return `[Bash: ${trunc(str(input.command), MAX_BASH_CMD_CHARS)}]`;
    case "Grep":
      return `[Grep: "${trunc(str(input.pattern), MAX_PATTERN_CHARS)}"${input.path ? ` in ${truncPath(str(input.path))}` : ""}]`;
    case "Glob":
      return `[Glob: ${trunc(str(input.pattern), MAX_PATTERN_CHARS)}]`;
    case "Task": {
      const desc = str(input.description) || str(input.prompt).slice(0, MAX_DESCRIPTION_CHARS);
      const agentType = str(input.subagent_type);
      return `[Task: ${agentType}${desc ? ` — "${trunc(desc, MAX_DESCRIPTION_CHARS)}"` : ""}]`;
    }
    case "AskUserQuestion": {
      const questions = input.questions;
      if (Array.isArray(questions) && questions[0]?.question) {
        return `[AskUserQuestion: "${trunc(str(questions[0].question), MAX_PATTERN_CHARS)}"]`;
      }
      return `[AskUserQuestion]`;
    }
    case "TodoWrite": {
      const todos = input.todos;
      const count = Array.isArray(todos) ? todos.length : "?";
      return `[TodoWrite: ${count} items]`;
    }
    case "WebSearch":
      return `[WebSearch: "${trunc(str(input.query), MAX_PATTERN_CHARS)}"]`;
    case "WebFetch":
      return `[WebFetch: ${trunc(str(input.url), MAX_PATTERN_CHARS)}]`;
    case "NotebookEdit":
      return `[NotebookEdit: ${truncPath(str(input.notebook_path))}]`;
    default:
      // Generic fallback: show tool name + first string-valued input key
      for (const [k, v] of Object.entries(input)) {
        if (typeof v === "string" && v.length > 0) {
          return `[${name}: ${k}=${trunc(v, MAX_GENERIC_INPUT_CHARS)}]`;
        }
      }
      return `[${name}]`;
  }
}

/** Truncate a string with "..." if it exceeds maxLen. */
function trunc(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

/** Truncate a file path: shorten home dir and cap length. */
function truncPath(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const shortened = home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  return trunc(shortened, MAX_PATH_CHARS);
}

/** Safely coerce unknown to string. */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Extract tool calls from an assistant message's content blocks.
 */
function extractToolCalls(content: ContentBlock[]): string[] {
  const lines: string[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      lines.push(formatToolCall(block.name, block.input));
    }
  }
  return lines;
}

/**
 * Build the conversation section of the prompt from message history.
 * Groups messages into turns: user message → agent tool calls → next user message.
 * Only includes the last MAX_TURNS user messages.
 */
function buildConversationBlock(history: BrowserIncomingMessage[]): string {
  // Collect turns: each turn starts with a user_message
  const turns: Array<{
    userContent: string;
    toolCalls: string[];
  }> = [];

  let currentTurn: { userContent: string; toolCalls: string[] } | null = null;

  for (const msg of history) {
    if (msg.type === "user_message") {
      // Start a new turn
      if (currentTurn) turns.push(currentTurn);
      currentTurn = {
        userContent: typeof msg.content === "string" ? msg.content : "",
        toolCalls: [],
      };
    } else if (msg.type === "assistant" && currentTurn) {
      // Extract tool calls from assistant message
      const content = (msg as { message?: { content?: ContentBlock[] } }).message?.content;
      if (Array.isArray(content)) {
        currentTurn.toolCalls.push(...extractToolCalls(content));
      }
    }
    // Skip all other message types (result, stream_event, tool_progress, etc.)
  }
  if (currentTurn) turns.push(currentTurn);

  // Take only the last MAX_TURNS
  const recentTurns = turns.slice(-MAX_TURNS);

  // Format with indentation
  const lines: string[] = [];
  for (const turn of recentTurns) {
    const truncatedMsg = trunc(turn.userContent.trim(), MAX_USER_MSG_CHARS);
    // Wrap user message lines
    lines.push(`${INDENT}User: ${truncatedMsg}`);

    // Add tool calls (no blank line between them — compact)
    if (turn.toolCalls.length > 0) {
      lines.push(`${INDENT}`);
      for (const tc of turn.toolCalls) {
        lines.push(`${INDENT}${tc}`);
      }
    }

    lines.push(`${INDENT}`);
  }

  return lines.join("\n");
}

// ─── Prompt templates ────────────────────────────────────────────────────────

function buildFirstTurnPrompt(history: BrowserIncomingMessage[]): string {
  const conversation = buildConversationBlock(history);
  return `Generate a concise 3-5 word title for this coding session.
Output ONLY the title, nothing else.

Conversation:

${conversation}`;
}

function buildUpdatePrompt(
  currentName: string,
  history: BrowserIncomingMessage[],
  isManuallyNamed: boolean,
): string {
  const conversation = buildConversationBlock(history);
  const manualNote = isManuallyNamed
    ? "\nNote: the current title was set by the user. Only change it if the task has clearly shifted.\n"
    : "";

  return `The current title is:

${INDENT}"${currentName}"
${manualNote}
Based on the conversation below, choose one action:

- NO_CHANGE — the current title is still accurate
- REVISE: <title> — same task, but a more accurate title
  (e.g. fixing a typo, narrowing scope, better wording)
- NEW: <title> — the user has moved to a fundamentally different task

Output ONLY one of the above. Titles should be 3-5 words.

Conversation:

${conversation}`;
}

const SYSTEM_PROMPT = "You maintain titles for coding sessions.";

// ─── Claude invocation ───────────────────────────────────────────────────────

let resolvedBinary: string | null | undefined;

function getClaudeBinary(): string | null {
  if (resolvedBinary !== undefined) return resolvedBinary;
  resolvedBinary = resolveBinary("claude");
  return resolvedBinary;
}

/**
 * Call `claude -p` with Haiku to generate/evaluate a session name.
 * Returns null on any failure (binary not found, timeout, bad output).
 */
async function callHaiku(prompt: string): Promise<string | null> {
  const binary = getClaudeBinary();
  if (!binary) {
    console.warn("[session-namer] claude binary not found, skipping auto-name");
    return null;
  }

  const args = [
    binary,
    "-p",
    "--no-session-persistence",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--system-prompt", SYSTEM_PROMPT,
    "--model", "haiku",
    prompt,
  ];

  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: getEnrichedPath() },
    });

    // Race against timeout
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => {
        proc.kill();
        resolve(null);
      }, TIMEOUT_MS);
    });

    const outputPromise = (async () => {
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        console.warn(`[session-namer] claude -p exited with code ${exitCode}: ${stderr.slice(0, MAX_STDERR_LOG_CHARS)}`);
        return null;
      }
      return output.trim();
    })();

    return await Promise.race([outputPromise, timeoutPromise]);
  } catch (err) {
    console.warn("[session-namer] Failed to run claude -p:", err);
    return null;
  }
}

// ─── Response parsing ────────────────────────────────────────────────────────

function sanitizeTitle(raw: string): string | null {
  const title = raw.replace(/^["']|["']$/g, "").trim();
  if (!title || title.length >= MAX_TITLE_CHARS) return null;
  return title;
}

function parseResponse(raw: string, isFirstTurn: boolean): NamingResult | null {
  const trimmed = raw.trim();

  if (isFirstTurn) {
    const title = sanitizeTitle(trimmed);
    return title ? { action: "name", title } : null;
  }

  // Check NO_CHANGE
  if (/^no.?change$/i.test(trimmed)) {
    return { action: "no_change" };
  }

  // Check REVISE: <title>
  const reviseMatch = trimmed.match(/^revise:\s*(.+)$/i);
  if (reviseMatch) {
    const title = sanitizeTitle(reviseMatch[1]);
    return title ? { action: "revise", title } : null;
  }

  // Check NEW: <title>
  const newMatch = trimmed.match(/^new:\s*(.+)$/i);
  if (newMatch) {
    const title = sanitizeTitle(newMatch[1]);
    return title ? { action: "new", title } : null;
  }

  // Fallback: if the model just output a title without a prefix (common for
  // first-turn-like responses), treat as a revision
  const fallbackTitle = sanitizeTitle(trimmed);
  if (fallbackTitle && !trimmed.includes("\n")) {
    return { action: "revise", title: fallbackTitle };
  }

  return null;
}

// ─── Call log (in-memory, for debugging UI) ──────────────────────────────────

export interface NamerLogEntry {
  id: number;
  sessionId: string;
  timestamp: number;
  prompt: string;
  rawResponse: string | null;
  parsed: NamingResult | null;
  currentName: string | null;   // name at time of call (null for first-turn)
  durationMs: number;
}

/** Max log entries kept in memory. Oldest are evicted first. */
const MAX_LOG_ENTRIES = 200;

let logIdCounter = 0;
const namerLog: NamerLogEntry[] = [];

function addLogEntry(entry: Omit<NamerLogEntry, "id">): NamerLogEntry {
  const full = { ...entry, id: ++logIdCounter };
  namerLog.push(full);
  if (namerLog.length > MAX_LOG_ENTRIES) {
    namerLog.splice(0, namerLog.length - MAX_LOG_ENTRIES);
  }
  return full;
}

/** List all log entries (lightweight: no prompt/rawResponse). Newest first. */
export function getNamerLogIndex(): Array<Omit<NamerLogEntry, "prompt" | "rawResponse">> {
  return namerLog
    .map(({ prompt: _p, rawResponse: _r, ...rest }) => rest)
    .reverse();
}

/** Get a single log entry by ID (includes full prompt + response). */
export function getNamerLogEntry(id: number): NamerLogEntry | undefined {
  return namerLog.find((e) => e.id === id);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a session name for the first turn.
 * @param sessionId - Session ID (for logging)
 * @param history - The message history (should contain at least one user_message)
 */
export async function generateFirstName(
  sessionId: string,
  history: BrowserIncomingMessage[],
): Promise<NamingResult | null> {
  const prompt = buildFirstTurnPrompt(history);
  const start = Date.now();
  const raw = await callHaiku(prompt);
  const parsed = raw ? parseResponse(raw, true) : null;
  addLogEntry({
    sessionId,
    timestamp: Date.now(),
    prompt,
    rawResponse: raw,
    parsed,
    currentName: null,
    durationMs: Date.now() - start,
  });
  return parsed;
}

/**
 * Evaluate whether a session should be renamed.
 * @param sessionId - Session ID (for logging)
 * @param currentName - The current session title
 * @param history - The full message history
 * @param isManuallyNamed - Whether the current name was set by the user
 */
export async function evaluateSessionName(
  sessionId: string,
  currentName: string,
  history: BrowserIncomingMessage[],
  isManuallyNamed: boolean,
): Promise<NamingResult | null> {
  const prompt = buildUpdatePrompt(currentName, history, isManuallyNamed);
  const start = Date.now();
  const raw = await callHaiku(prompt);
  const parsed = raw ? parseResponse(raw, false) : null;
  addLogEntry({
    sessionId,
    timestamp: Date.now(),
    prompt,
    rawResponse: raw,
    parsed,
    currentName,
    durationMs: Date.now() - start,
  });
  return parsed;
}

// ─── Test helpers ────────────────────────────────────────────────────────────

export const _testHelpers = {
  buildFirstTurnPrompt,
  buildUpdatePrompt,
  buildConversationBlock,
  formatToolCall,
  parseResponse,
  sanitizeTitle,
};
