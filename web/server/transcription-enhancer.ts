/**
 * Tier-2 transcription enhancement: uses conversation context from the active
 * session to correct misheard technical terms via an LLM polish pass.
 *
 * Inspired by VoiceInk's two-tier architecture:
 *   Tier 1: Whisper STT (raw transcript)
 *   Tier 2: LLM correction using session context
 */

import type { BrowserIncomingMessage, ContentBlock, SessionTaskEntry } from "./session-types.js";
import type { TranscriptionConfig } from "./settings-manager.js";

// ─── Tunable limits ─────────────────────────────────────────────────────────

/** Max recent turns to include in enhancer context. */
const MAX_TURNS = 8;

/** Enhancer context: per-turn char limits by recency (index 0 = most recent).
 *  For the most recent (active) turn, both user and assistant get these limits.
 *  For older turns, user messages get the limit but only the LAST assistant
 *  message is included (intermediate assistant messages are pruned). */
const ENHANCER_USER_CHAR_LIMITS = [800, 600, 400, 300, 200, 200, 150, 150];
const ENHANCER_ASST_CHAR_LIMITS = [800, 500, 300, 200, 150, 150, 100, 100];

/** Timeout for the enhancement LLM call. */
const ENHANCEMENT_TIMEOUT_MS = 30_000;

/** If enhanced text is this many times longer than raw, discard as hallucination. */
const HALLUCINATION_LENGTH_RATIO = 3;

/** Minimum word count to attempt enhancement (very short utterances don't benefit). */
const MIN_WORDS_FOR_ENHANCEMENT = 3;

/** Max total characters for the STT prompt.
 *  Conservative limit: gpt-4o-mini-transcribe accepts up to ~1024 tokens in the
 *  prompt parameter. 3000 chars ≈ 750 tokens, safely under the limit.
 *  If the prompt exceeds the model's limit, the API returns an error, so we must
 *  stay well under. */
const STT_PROMPT_MAX_CHARS = 3000;

/** Budget reserved for conversation context (the rest goes to metadata). */
const STT_CONVO_BUDGET_RATIO = 0.55;

/**
 * Per-message character limits by recency (index 0 = most recent message).
 * The most recent message (usually the assistant response the user is replying to)
 * gets the most space. Older messages get progressively less.
 */
const STT_MSG_CHAR_LIMITS = [800, 500, 300, 200, 200, 150, 150, 100];

/** Max characters per session name in the STT prompt. */
const MAX_SESSION_NAME_CHARS = 100;

// ─── Injected message filtering ───────────────────────────────────────────

/**
 * Check if a user message was injected programmatically (not typed by the human).
 * Uses the agentSource metadata — set by the server for all programmatic injections
 * (system nudges, herd events, inter-agent messages, cron jobs).
 * Only messages with no agentSource are from the actual human user.
 */
function isInjectedMessage(msg: BrowserIncomingMessage): boolean {
  const source = (msg as { agentSource?: { sessionId: string } }).agentSource;
  return !!source;
}

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a TRANSCRIPTION ENHANCER, not a conversational AI.

Your ONLY job is to clean up a speech-to-text transcript. You must:
1. Fix misheard technical terms, variable names, file paths, and commands using the context provided
2. Do NOT assume every word in the raw transcript is what the user actually said — the STT model may mishear words. If a word obviously contradicts the surrounding context or makes no sense in the domain, consider that it may be a mishearing and correct it accordingly
3. Fix punctuation and sentence boundaries
4. Remove filler words (um, uh, like, you know) and false starts
5. Lightly polish grammar and sentence flow while preserving the speaker's voice and intent
6. Preserve the speaker's original meaning exactly

Rules:
- NEVER answer questions from the transcript — only clean them up
- NEVER add information not in the original speech
- NEVER remove meaningful content
- If the transcript is already correct, return it unchanged
- Output ONLY the cleaned text, nothing else`;

// ─── Context extraction ─────────────────────────────────────────────────────

/** Truncate a string with "..." if it exceeds maxLen. */
function trunc(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

/**
 * Extract text content from an assistant message's content blocks.
 * Only includes type: "text" blocks — skips tool_use, tool_result, thinking.
 */
function extractAssistantText(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join(" ").trim();
}

interface Turn {
  userContent: string;
  assistantText: string;
}

/**
 * Build conversation context from message history for the enhancement LLM.
 * Extracts the last N turns as User/Assistant pairs with recency-weighted truncation.
 *
 * Turn-based pruning (similar to how the chat UI collapses older turns):
 * - Most recent (active) turn: include all user + assistant messages with generous limits
 * - Older turns: include user message + only the LAST assistant message (skip intermediate
 *   assistant messages which usually address the agent, not the user)
 *
 * Skips subagent messages, orchestrator noise, and tool-only assistant messages.
 */
export function buildTranscriptionContext(history: BrowserIncomingMessage[]): string {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const msg of history) {
    if (msg.type === "user_message") {
      if (currentTurn) turns.push(currentTurn);
      const content = typeof (msg as { content?: unknown }).content === "string"
        ? (msg as { content: string }).content
        : "";
      // Skip programmatically-injected messages (system nudges, herd events, agent msgs)
      if (isInjectedMessage(msg)) {
        currentTurn = null;
        continue;
      }
      currentTurn = {
        userContent: content,
        assistantText: "",
      };
    } else if (msg.type === "assistant" && currentTurn) {
      // Skip subagent messages
      const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
      if (parentId) continue;

      const content = (msg as { message?: { content?: ContentBlock[] } }).message?.content;
      if (Array.isArray(content)) {
        const text = extractAssistantText(content);
        if (text) {
          // Keep updating — the last text content is the final response
          currentTurn.assistantText = text;
        }
      }
    } else if (msg.type === "compact_marker") {
      // Include compact summary as context and stop scanning further back
      const summary = (msg as { summary?: string }).summary;
      if (summary && typeof summary === "string" && summary.trim()) {
        if (currentTurn) turns.push(currentTurn);
        currentTurn = null;
        const lastAstLimit = ENHANCER_ASST_CHAR_LIMITS[ENHANCER_ASST_CHAR_LIMITS.length - 1];
        turns.push({
          userContent: "",
          assistantText: `[Earlier conversation summary: ${trunc(summary.trim(), lastAstLimit)}]`,
        });
      }
    }
  }
  if (currentTurn) turns.push(currentTurn);

  // Take only the last MAX_TURNS
  const recentTurns = turns.slice(-MAX_TURNS);

  if (recentTurns.length === 0) return "";

  // Format with recency-weighted truncation
  const lines: string[] = [];
  const numTurns = recentTurns.length;
  for (let i = 0; i < numTurns; i++) {
    const turn = recentTurns[i];
    // Recency index: 0 = most recent (last element)
    const recencyIdx = numTurns - 1 - i;
    const userLimit = recencyIdx < ENHANCER_USER_CHAR_LIMITS.length
      ? ENHANCER_USER_CHAR_LIMITS[recencyIdx]
      : ENHANCER_USER_CHAR_LIMITS[ENHANCER_USER_CHAR_LIMITS.length - 1];
    const asstLimit = recencyIdx < ENHANCER_ASST_CHAR_LIMITS.length
      ? ENHANCER_ASST_CHAR_LIMITS[recencyIdx]
      : ENHANCER_ASST_CHAR_LIMITS[ENHANCER_ASST_CHAR_LIMITS.length - 1];

    if (turn.userContent) {
      lines.push("");
      lines.push("[user]");
      for (const line of trunc(turn.userContent.trim(), userLimit).split("\n")) {
        lines.push(`    ${line}`);
      }
    }

    if (turn.assistantText) {
      lines.push("");
      lines.push("[assistant]");
      for (const line of trunc(turn.assistantText.trim(), asstLimit).split("\n")) {
        lines.push(`    ${line}`);
      }
    }
  }

  return lines.join("\n").trim();
}

// ─── Prompt construction ────────────────────────────────────────────────────

export interface EnhancementContextInput {
  /** Text before the cursor in the composer. */
  composerBefore?: string;
  /** Text after the cursor in the composer. */
  composerAfter?: string;
  /** Task titles from the session auto-namer. */
  taskTitles?: string[];
  /** Session display name. */
  sessionName?: string;
  /** Names of other active sessions (vocabulary from the user's workspace). */
  activeSessionNames?: string[];
}

/**
 * Build the full user message for the enhancement LLM call.
 * Wraps conversation context, supplementary context, and transcript in XML tags.
 */
export function buildEnhancementPrompt(
  rawTranscript: string,
  conversationContext: string,
  extra?: EnhancementContextInput,
): string {
  const parts: string[] = [];

  if (conversationContext) {
    parts.push(`<CONVERSATION_CONTEXT>\nRecent conversation in this coding session:\n\n${conversationContext}\n</CONVERSATION_CONTEXT>`);
    parts.push("");
  }

  // Composer context — shows where the voice text will be inserted
  if (extra?.composerBefore || extra?.composerAfter) {
    const composerLines: string[] = [];
    if (extra.composerBefore) composerLines.push(`Text before cursor: ${trunc(extra.composerBefore.trim(), 500)}`);
    if (extra.composerAfter) composerLines.push(`Text after cursor: ${trunc(extra.composerAfter.trim(), 500)}`);
    parts.push(`<COMPOSER_CONTEXT>\n${composerLines.join("\n")}\n</COMPOSER_CONTEXT>`);
    parts.push("");
  }

  // Supplementary context — vocabulary and domain knowledge
  const supplementary: string[] = [];

  if (extra?.taskTitles && extra.taskTitles.length > 0) {
    supplementary.push(`Session tasks: ${extra.taskTitles.join("; ")}`);
  }

  if (extra?.sessionName) {
    supplementary.push(`Current session: ${extra.sessionName}`);
  }

  if (extra?.activeSessionNames && extra.activeSessionNames.length > 0) {
    supplementary.push(`Other active sessions: ${extra.activeSessionNames.join("; ")}`);
  }

  if (supplementary.length > 0) {
    parts.push(`<SESSION_CONTEXT>\n${supplementary.join("\n")}\n</SESSION_CONTEXT>`);
    parts.push("");
  }

  parts.push(`<TRANSCRIPT>\n${rawTranscript}\n</TRANSCRIPT>`);

  return parts.join("\n");
}

// ─── STT prompt construction ─────────────────────────────────────────────────

export interface SttPromptInput {
  /** Task titles from the session auto-namer (highest priority context). */
  taskHistory?: SessionTaskEntry[];
  /** Session display name. */
  sessionName?: string;
  /** Names of other active sessions (vocabulary from the user's workspace). */
  activeSessionNames?: string[];
  /** Text before the cursor in the composer (for mid-prompt voice insertion). */
  composerBefore?: string;
  /** Text after the cursor in the composer. */
  composerAfter?: string;
  /** Full message history for extracting recent user messages. */
  messageHistory?: BrowserIncomingMessage[] | null;
}

/**
 * Build a prompt string for the STT model (gpt-4o-mini-transcribe).
 *
 * Optimized for information density — every token should carry vocabulary signal.
 * The STT model uses this text purely for vocabulary recognition, not instruction following.
 *
 * Budget allocation strategy:
 *   - Start with metadata budget (~45%) and conversation budget (~55%)
 *   - Fill metadata sections; any unused metadata budget is reallocated to conversation
 *   - Conversation: allocate per-message in reverse chronological order with
 *     recency weighting — most recent message gets the most chars, older messages
 *     get progressively less. When budget runs out, stop.
 *
 * Returns empty string if no useful context is available.
 */
export function buildSttPrompt(input: SttPromptInput): string {
  const metaBudget = Math.floor(STT_PROMPT_MAX_CHARS * (1 - STT_CONVO_BUDGET_RATIO));

  // ── Phase 1: Build metadata sections with metaBudget ──────────────────
  const metaParts: string[] = [];
  let metaRemaining = metaBudget;

  const addMeta = (text: string): boolean => {
    if (text.length > metaRemaining) {
      if (metaRemaining > 20) {
        metaParts.push(trunc(text, metaRemaining));
        metaRemaining = 0;
      }
      return false;
    }
    metaParts.push(text);
    metaRemaining -= text.length + 1;
    return metaRemaining > 0;
  };

  // 1. Task titles — highest density vocabulary (file names, features, libraries)
  if (input.taskHistory && input.taskHistory.length > 0) {
    const seen = new Set<string>();
    const titles: string[] = [];
    for (let i = input.taskHistory.length - 1; i >= 0; i--) {
      const t = input.taskHistory[i].title;
      if (!seen.has(t)) {
        seen.add(t);
        titles.push(t);
      }
    }
    if (!addMeta("Tasks: " + trunc(titles.join(", "), 400))) {}
  }

  // 2. Session name
  if (input.sessionName && metaRemaining > 0) {
    addMeta("Session: " + trunc(input.sessionName, MAX_SESSION_NAME_CHARS));
  }

  // 3. Other session names (pre-filtered by caller)
  if (input.activeSessionNames && input.activeSessionNames.length > 0 && metaRemaining > 0) {
    const truncated = input.activeSessionNames.slice(0, 5).map((n) => trunc(n, 60));
    addMeta("Sessions: " + truncated.join(", "));
  }

  // 4. Composer text with cursor position marker
  if ((input.composerBefore || input.composerAfter) && metaRemaining > 0) {
    const before = input.composerBefore ? trunc(input.composerBefore.trim(), 500) + " " : "";
    const after = input.composerAfter ? " " + trunc(input.composerAfter.trim(), 500) : "";
    addMeta(`Composer: ${before}[CURSOR]${after}`);
  }

  // ── Phase 2: Allocate conversation budget (base + unused metadata) ────
  // Any chars the metadata section didn't use get reallocated to conversation.
  const convoBudget = (STT_PROMPT_MAX_CHARS - metaBudget) + metaRemaining;
  const convoEntries: Array<{ role: "User" | "Assistant"; text: string }> = [];

  if (input.messageHistory && convoBudget > 50) {
    // Group messages into turns (user + last assistant response), scanning backwards.
    // This mirrors how the chat UI collapses older turns: each turn shows the user's
    // message and only the FINAL assistant text (intermediate assistant messages that
    // address the agent itself are skipped). This prevents long multi-message exchanges
    // about a single topic from consuming the entire conversation budget.
    interface SttTurn { userText: string; assistantText: string }
    const turns: SttTurn[] = [];
    let currentTurn: SttTurn | null = null;

    for (const msg of input.messageHistory) {
      if (msg.type === "user_message") {
        if (currentTurn) turns.push(currentTurn);
        const content = typeof (msg as { content?: unknown }).content === "string"
          ? (msg as { content: string }).content : "";
        if (isInjectedMessage(msg)) {
          currentTurn = null;
          continue;
        }
        currentTurn = { userText: content, assistantText: "" };
      } else if (msg.type === "assistant" && currentTurn) {
        const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
        if (parentId) continue;
        const blocks = (msg as { message?: { content?: ContentBlock[] } }).message?.content;
        if (Array.isArray(blocks)) {
          const text = extractAssistantText(blocks);
          if (text) currentTurn.assistantText = text; // keep overwriting → last wins
        }
      }
    }
    if (currentTurn) turns.push(currentTurn);

    // Allocate budget to turns in reverse chronological order (most recent first)
    let convoRemaining = convoBudget;
    let turnIdx = 0;

    for (let i = turns.length - 1; i >= 0 && convoRemaining > 20; i--) {
      const turn = turns[i];
      const charLimit = turnIdx < STT_MSG_CHAR_LIMITS.length
        ? STT_MSG_CHAR_LIMITS[turnIdx]
        : STT_MSG_CHAR_LIMITS[STT_MSG_CHAR_LIMITS.length - 1];

      // Add user message
      if (turn.userText.trim()) {
        const userTrunc = trunc(turn.userText.trim(), Math.min(charLimit, convoRemaining - 12));
        const userLine = `[user]\n    ${userTrunc.split("\n").join("\n    ")}`;
        if (userLine.length + 1 > convoRemaining) break;
        convoEntries.push({ role: "User", text: userTrunc });
        convoRemaining -= userLine.length + 1;
      }

      // Add last assistant message (with slightly smaller limit for balance)
      if (turn.assistantText.trim() && convoRemaining > 20) {
        const asstLimit = Math.max(Math.floor(charLimit * 0.7), 80);
        const asstTrunc = trunc(turn.assistantText.trim(), Math.min(asstLimit, convoRemaining - 16));
        const asstLine = `[assistant]\n    ${asstTrunc.split("\n").join("\n    ")}`;
        if (asstLine.length + 1 <= convoRemaining) {
          convoEntries.push({ role: "Assistant", text: asstTrunc });
          convoRemaining -= asstLine.length + 1;
        }
      }

      turnIdx++;
    }
  }

  // ── Phase 3: Assemble final prompt ────────────────────────────────────
  const parts = [...metaParts];
  if (convoEntries.length > 0) {
    // Reverse to chronological order (scan was most-recent-first)
    convoEntries.reverse();
    for (const entry of convoEntries) {
      const indented = entry.text.split("\n").join("\n    ");
      parts.push(`[${entry.role.toLowerCase()}]\n    ${indented}`);
    }
  }

  return parts.join("\n");
}

// ─── LLM call ───────────────────────────────────────────────────────────────

/** Result from callEnhancementLLM — either the enhanced text or an error message. */
type LLMCallResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/**
 * Call an OpenAI-compatible chat completions API to enhance the transcript.
 * Returns the enhanced text on success, or an error message on failure.
 */
async function callEnhancementLLM(
  prompt: string,
  config: TranscriptionConfig,
  apiKey: string,
): Promise<LLMCallResult> {
  const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = config.enhancementModel || "gpt-5-mini";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ENHANCEMENT_TIMEOUT_MS);

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_completion_tokens: 1000,
        reasoning_effort: "low",
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const errorMsg = `API error ${res.status}: ${body.slice(0, 300) || res.statusText}`;
      console.warn(`[transcription-enhancer] ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, error: "Empty response from LLM" };
    return { ok: true, text };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn("[transcription-enhancer] LLM call failed:", errorMsg);
    return { ok: false, error: errorMsg };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface EnhancementResult {
  /** The final text (enhanced or raw fallback). */
  text: string;
  /** The original Whisper output (only set when enhancement was attempted). */
  rawText?: string;
  /** Whether LLM enhancement was actually applied. */
  enhanced: boolean;
  /** Debug info about the enhancement call (for debug panel). */
  _debug?: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    enhancedText: string | null;
    durationMs: number;
    skipReason?: string;
  };
}

/**
 * Enhance a raw transcript using conversation context from the active session.
 *
 * Returns the raw text unchanged (with enhanced=false) when:
 * - The transcript is too short (< 3 words)
 * - No context is available (no conversation turns AND no supplementary context)
 * - Enhancement is disabled in config
 * - The LLM call fails
 * - The LLM output looks like hallucination (> 3x original length)
 */
export async function enhanceTranscript(
  rawText: string,
  history: BrowserIncomingMessage[] | null,
  config: TranscriptionConfig,
  apiKey: string,
  extra?: EnhancementContextInput,
): Promise<EnhancementResult> {
  const model = config.enhancementModel || "gpt-5-mini";

  // Skip if enhancement is disabled
  if (!config.enhancementEnabled) {
    return { text: rawText, enhanced: false, _debug: { model, systemPrompt: SYSTEM_PROMPT, userMessage: "", enhancedText: null, durationMs: 0, skipReason: "disabled" } };
  }

  // Skip for very short transcripts
  const wordCount = rawText.trim().split(/\s+/).length;
  if (wordCount < MIN_WORDS_FOR_ENHANCEMENT) {
    return { text: rawText, enhanced: false, _debug: { model, systemPrompt: SYSTEM_PROMPT, userMessage: "", enhancedText: null, durationMs: 0, skipReason: "too short" } };
  }

  // Build context from session history
  const conversationContext = history ? buildTranscriptionContext(history) : "";

  // Check if we have any meaningful context at all
  const hasExtra = !!(extra?.composerBefore || extra?.composerAfter || extra?.taskTitles?.length || extra?.sessionName || extra?.activeSessionNames?.length);
  if (!conversationContext && !hasExtra) {
    return { text: rawText, enhanced: false, _debug: { model, systemPrompt: SYSTEM_PROMPT, userMessage: "", enhancedText: null, durationMs: 0, skipReason: "no context" } };
  }

  // Build prompt and call LLM
  const prompt = buildEnhancementPrompt(rawText, conversationContext, extra);
  const t0 = Date.now();
  const llmResult = await callEnhancementLLM(prompt, config, apiKey);
  const durationMs = Date.now() - t0;

  if (!llmResult.ok) {
    return { text: rawText, enhanced: false, _debug: { model, systemPrompt: SYSTEM_PROMPT, userMessage: prompt, enhancedText: null, durationMs, skipReason: llmResult.error } };
  }

  const enhanced = llmResult.text;

  // Hallucination guard: if the enhanced text is way longer than the raw, discard it
  if (enhanced.length > rawText.length * HALLUCINATION_LENGTH_RATIO) {
    console.warn(
      `[transcription-enhancer] Discarding hallucinated output (${enhanced.length} chars vs ${rawText.length} raw)`,
    );
    return { text: rawText, enhanced: false, _debug: { model, systemPrompt: SYSTEM_PROMPT, userMessage: prompt, enhancedText: enhanced, durationMs, skipReason: "hallucination guard" } };
  }

  return { text: enhanced, rawText, enhanced: true, _debug: { model, systemPrompt: SYSTEM_PROMPT, userMessage: prompt, enhancedText: enhanced, durationMs } };
}

// ─── Debug log (in-memory, for Settings debug panel) ─────────────────────────

export interface TranscriptionLogEntry {
  id: number;
  timestamp: number;
  sessionId: string | null;
  /** STT phase */
  sttModel: string;
  sttDurationMs: number;
  rawTranscript: string;
  audioSizeBytes: number;
  /** Prompt sent to the STT model to guide vocabulary recognition. */
  sttPrompt: string;
  /** Enhancement phase (null if not attempted) */
  enhancement: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    enhancedText: string | null;
    durationMs: number;
    skipReason?: string;
  } | null;
}

const MAX_LOG_ENTRIES = 50;
let logIdCounter = 0;
const transcriptionLog: TranscriptionLogEntry[] = [];

/** Add a transcription log entry. Called from routes.ts after each transcription. */
export function addTranscriptionLogEntry(entry: Omit<TranscriptionLogEntry, "id" | "timestamp">): TranscriptionLogEntry {
  const full = { ...entry, id: ++logIdCounter, timestamp: Date.now() };
  transcriptionLog.push(full);
  if (transcriptionLog.length > MAX_LOG_ENTRIES) {
    transcriptionLog.splice(0, transcriptionLog.length - MAX_LOG_ENTRIES);
  }
  return full;
}

/** List all log entries (lightweight: no sttPrompt, system prompt, or user message). Newest first. */
export function getTranscriptionLogIndex(): Array<Omit<TranscriptionLogEntry, "sttPrompt" | "enhancement"> & {
  enhancement: Omit<NonNullable<TranscriptionLogEntry["enhancement"]>, "systemPrompt" | "userMessage"> | null;
}> {
  return transcriptionLog
    .map((entry) => {
      const { sttPrompt: _p, enhancement, ...rest } = entry;
      if (!enhancement) return { ...rest, enhancement: null };
      const { systemPrompt: _s, userMessage: _u, ...enhRest } = enhancement;
      return { ...rest, enhancement: enhRest };
    })
    .reverse();
}

/** Get a single log entry by ID (includes full details). */
export function getTranscriptionLogEntry(id: number): TranscriptionLogEntry | undefined {
  return transcriptionLog.find((e) => e.id === id);
}

// ─── Test helpers ───────────────────────────────────────────────────────────

export const _testHelpers = {
  SYSTEM_PROMPT,
  MAX_TURNS,
  ENHANCER_USER_CHAR_LIMITS,
  ENHANCER_ASST_CHAR_LIMITS,
  MIN_WORDS_FOR_ENHANCEMENT,
  HALLUCINATION_LENGTH_RATIO,
  STT_PROMPT_MAX_CHARS,
  STT_CONVO_BUDGET_RATIO,
  STT_MSG_CHAR_LIMITS,
  MAX_SESSION_NAME_CHARS,
  trunc,
  extractAssistantText,
  isInjectedMessage,
  buildTranscriptionContext,
  buildEnhancementPrompt,
  buildSttPrompt,
};
