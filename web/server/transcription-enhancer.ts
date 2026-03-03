/**
 * Tier-2 transcription enhancement: uses conversation context from the active
 * session to correct misheard technical terms via an LLM polish pass.
 *
 * Inspired by VoiceInk's two-tier architecture:
 *   Tier 1: Whisper STT (raw transcript)
 *   Tier 2: LLM correction using session context
 */

import type { BrowserIncomingMessage, ContentBlock } from "./session-types.js";
import type { TranscriptionConfig } from "./settings-manager.js";

// ─── Tunable limits ─────────────────────────────────────────────────────────

/** Max recent turns to include in context. */
const MAX_TURNS = 5;

/** Max characters per user message in context. */
const MAX_USER_MSG_CHARS = 500;

/** Max characters of assistant text per turn. */
const MAX_ASSISTANT_TEXT_CHARS = 500;

/** Timeout for the enhancement LLM call. */
const ENHANCEMENT_TIMEOUT_MS = 10_000;

/** If enhanced text is this many times longer than raw, discard as hallucination. */
const HALLUCINATION_LENGTH_RATIO = 3;

/** Minimum word count to attempt enhancement (very short utterances don't benefit). */
const MIN_WORDS_FOR_ENHANCEMENT = 3;

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a TRANSCRIPTION ENHANCER, not a conversational AI.

Your ONLY job is to clean up a speech-to-text transcript. You must:
1. Fix misheard technical terms, variable names, file paths, and commands using the context provided
2. Fix punctuation and sentence boundaries
3. Remove filler words (um, uh, like, you know) and false starts
4. Preserve the speaker's original meaning exactly

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
 * Build conversation context from message history.
 * Extracts the last N turns as simple User/Assistant pairs with indentation.
 * Skips subagent messages and tool-only assistant messages.
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
        // Add a synthetic turn representing the compacted context
        turns.push({
          userContent: "",
          assistantText: `[Earlier conversation summary: ${trunc(summary.trim(), MAX_ASSISTANT_TEXT_CHARS)}]`,
        });
      }
    }
  }
  if (currentTurn) turns.push(currentTurn);

  // Take only the last MAX_TURNS
  const recentTurns = turns.slice(-MAX_TURNS);

  if (recentTurns.length === 0) return "";

  // Format as indented text
  const lines: string[] = [];
  for (const turn of recentTurns) {
    if (turn.userContent) {
      lines.push("");
      lines.push("  User:");
      for (const line of trunc(turn.userContent.trim(), MAX_USER_MSG_CHARS).split("\n")) {
        lines.push(`    ${line}`);
      }
    }

    if (turn.assistantText) {
      lines.push("");
      lines.push("  Assistant:");
      for (const line of trunc(turn.assistantText.trim(), MAX_ASSISTANT_TEXT_CHARS).split("\n")) {
        lines.push(`    ${line}`);
      }
    }
  }

  return lines.join("\n").trim();
}

// ─── Prompt construction ────────────────────────────────────────────────────

/**
 * Build the full user message for the enhancement LLM call.
 * Wraps conversation context and transcript in XML tags.
 */
export function buildEnhancementPrompt(rawTranscript: string, context: string): string {
  const parts: string[] = [];

  if (context) {
    parts.push(`<CONVERSATION_CONTEXT>\nRecent conversation in this coding session:\n\n${context}\n</CONVERSATION_CONTEXT>`);
    parts.push("");
  }

  parts.push(`<TRANSCRIPT>\n${rawTranscript}\n</TRANSCRIPT>`);

  return parts.join("\n");
}

// ─── LLM call ───────────────────────────────────────────────────────────────

/**
 * Call an OpenAI-compatible chat completions API to enhance the transcript.
 * Returns the enhanced text, or null on failure.
 */
async function callEnhancementLLM(
  prompt: string,
  config: TranscriptionConfig,
  apiKey: string,
): Promise<string | null> {
  const baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = config.enhancementModel || "gpt-4o-mini";

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
        max_tokens: 1000,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[transcription-enhancer] LLM API error ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    console.warn("[transcription-enhancer] LLM call failed:", err);
    return null;
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
}

/**
 * Enhance a raw transcript using conversation context from the active session.
 *
 * Returns the raw text unchanged (with enhanced=false) when:
 * - The transcript is too short (< 3 words)
 * - No conversation context is available
 * - Enhancement is disabled in config
 * - The LLM call fails
 * - The LLM output looks like hallucination (> 3x original length)
 */
export async function enhanceTranscript(
  rawText: string,
  history: BrowserIncomingMessage[] | null,
  config: TranscriptionConfig,
  apiKey: string,
): Promise<EnhancementResult> {
  // Skip if enhancement is disabled
  if (!config.enhancementEnabled) {
    return { text: rawText, enhanced: false };
  }

  // Skip for very short transcripts
  const wordCount = rawText.trim().split(/\s+/).length;
  if (wordCount < MIN_WORDS_FOR_ENHANCEMENT) {
    return { text: rawText, enhanced: false };
  }

  // Build context from session history
  const context = history ? buildTranscriptionContext(history) : "";

  // Skip if no meaningful context
  if (!context) {
    return { text: rawText, enhanced: false };
  }

  // Build prompt and call LLM
  const prompt = buildEnhancementPrompt(rawText, context);
  const enhanced = await callEnhancementLLM(prompt, config, apiKey);

  if (!enhanced) {
    return { text: rawText, enhanced: false };
  }

  // Hallucination guard: if the enhanced text is way longer than the raw, discard it
  if (enhanced.length > rawText.length * HALLUCINATION_LENGTH_RATIO) {
    console.warn(
      `[transcription-enhancer] Discarding hallucinated output (${enhanced.length} chars vs ${rawText.length} raw)`,
    );
    return { text: rawText, enhanced: false };
  }

  return { text: enhanced, rawText, enhanced: true };
}

// ─── Test helpers ───────────────────────────────────────────────────────────

export const _testHelpers = {
  SYSTEM_PROMPT,
  MAX_TURNS,
  MAX_USER_MSG_CHARS,
  MAX_ASSISTANT_TEXT_CHARS,
  MIN_WORDS_FOR_ENHANCEMENT,
  HALLUCINATION_LENGTH_RATIO,
  trunc,
  extractAssistantText,
  buildTranscriptionContext,
  buildEnhancementPrompt,
};
