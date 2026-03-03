import { describe, it, expect } from "vitest";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { SessionTaskEntry } from "./session-types.js";
import {
  _testHelpers,
  buildTranscriptionContext,
  buildEnhancementPrompt,
  buildSttPrompt,
  enhanceTranscript,
} from "./transcription-enhancer.js";

const { trunc, extractAssistantText, MAX_TURNS, MIN_WORDS_FOR_ENHANCEMENT, HALLUCINATION_LENGTH_RATIO, STT_PROMPT_MAX_CHARS } = _testHelpers;

// ─── Helper to build mock messages ──────────────────────────────────────────

function userMsg(content: string): BrowserIncomingMessage {
  return { type: "user_message", content, timestamp: Date.now() } as BrowserIncomingMessage;
}

function assistantMsg(text: string): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  } as unknown as BrowserIncomingMessage;
}

function assistantToolUse(toolName: string): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tu-1", name: toolName, input: {} }],
    },
    parent_tool_use_id: null,
  } as unknown as BrowserIncomingMessage;
}

function subagentMsg(text: string): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    parent_tool_use_id: "parent-1",
  } as unknown as BrowserIncomingMessage;
}

function compactMarker(summary?: string): BrowserIncomingMessage {
  return {
    type: "compact_marker",
    timestamp: Date.now(),
    summary,
  } as BrowserIncomingMessage;
}

// ─── trunc ──────────────────────────────────────────────────────────────────

describe("trunc", () => {
  it("returns short strings unchanged", () => {
    expect(trunc("hello", 10)).toBe("hello");
  });

  it("truncates long strings with ellipsis", () => {
    expect(trunc("hello world", 5)).toBe("hello...");
  });

  it("handles exact boundary", () => {
    expect(trunc("hello", 5)).toBe("hello");
  });
});

// ─── extractAssistantText ───────────────────────────────────────────────────

describe("extractAssistantText", () => {
  it("extracts text blocks only", () => {
    const result = extractAssistantText([
      { type: "text", text: "Found the bug." },
      { type: "tool_use", id: "t1", name: "Edit", input: {} },
      { type: "text", text: "Fixed it." },
    ]);
    expect(result).toBe("Found the bug. Fixed it.");
  });

  it("skips thinking blocks", () => {
    const result = extractAssistantText([
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Here's the fix." },
    ]);
    expect(result).toBe("Here's the fix.");
  });

  it("returns empty for tool-only messages", () => {
    const result = extractAssistantText([
      { type: "tool_use", id: "t1", name: "Read", input: {} },
    ]);
    expect(result).toBe("");
  });
});

// ─── buildTranscriptionContext ──────────────────────────────────────────────

describe("buildTranscriptionContext", () => {
  it("returns empty string for empty history", () => {
    expect(buildTranscriptionContext([])).toBe("");
  });

  it("builds context from a single turn", () => {
    const history = [
      userMsg("Fix the auth bug"),
      assistantMsg("I found the issue in auth.ts"),
    ];
    const ctx = buildTranscriptionContext(history);
    expect(ctx).toContain("User:");
    expect(ctx).toContain("Fix the auth bug");
    expect(ctx).toContain("Assistant:");
    expect(ctx).toContain("I found the issue in auth.ts");
  });

  it("builds context from multiple turns", () => {
    const history = [
      userMsg("Fix the auth bug"),
      assistantMsg("Fixed in auth.ts"),
      userMsg("Now add tests"),
      assistantMsg("Added tests in auth.test.ts"),
    ];
    const ctx = buildTranscriptionContext(history);
    // Both turns should appear
    expect(ctx).toContain("Fix the auth bug");
    expect(ctx).toContain("Fixed in auth.ts");
    expect(ctx).toContain("Now add tests");
    expect(ctx).toContain("Added tests in auth.test.ts");
  });

  it("limits to MAX_TURNS", () => {
    // Create more turns than MAX_TURNS
    const history: BrowserIncomingMessage[] = [];
    for (let i = 0; i < MAX_TURNS + 3; i++) {
      history.push(userMsg(`Turn ${i} user`));
      history.push(assistantMsg(`Turn ${i} response`));
    }
    const ctx = buildTranscriptionContext(history);

    // Oldest turns should be dropped
    expect(ctx).not.toContain("Turn 0 user");
    expect(ctx).not.toContain("Turn 1 user");
    expect(ctx).not.toContain("Turn 2 user");

    // Recent turns should be present
    expect(ctx).toContain(`Turn ${MAX_TURNS + 2} user`);
    expect(ctx).toContain(`Turn ${MAX_TURNS + 2} response`);
  });

  it("skips subagent messages", () => {
    const history = [
      userMsg("Fix the bug"),
      subagentMsg("Subagent internal text"),
      assistantMsg("Main agent response"),
    ];
    const ctx = buildTranscriptionContext(history);
    expect(ctx).not.toContain("Subagent internal text");
    expect(ctx).toContain("Main agent response");
  });

  it("skips tool-only assistant messages and uses the last text response", () => {
    const history = [
      userMsg("Read the file"),
      assistantToolUse("Read"),
      assistantMsg("Here's what I found in the file"),
    ];
    const ctx = buildTranscriptionContext(history);
    expect(ctx).toContain("Here's what I found in the file");
  });

  it("includes compact_marker summary and stops scanning further back", () => {
    const history = [
      userMsg("Old message that should be dropped"),
      assistantMsg("Old response"),
      compactMarker("Session was working on fixing authentication bugs"),
      userMsg("Now fix the tests"),
      assistantMsg("Tests are fixed"),
    ];
    const ctx = buildTranscriptionContext(history);
    // Compact summary should appear
    expect(ctx).toContain("Earlier conversation summary");
    expect(ctx).toContain("fixing authentication bugs");
    // Post-compact messages should appear
    expect(ctx).toContain("Now fix the tests");
    expect(ctx).toContain("Tests are fixed");
  });

  it("handles user-only turns (no assistant response yet)", () => {
    const history = [
      userMsg("Fix the auth bug"),
      assistantMsg("Done"),
      userMsg("Now add tests"),
      // No assistant response yet
    ];
    const ctx = buildTranscriptionContext(history);
    expect(ctx).toContain("Now add tests");
    // Second turn has no assistant text — that's fine
  });

  it("uses proper indentation format", () => {
    const history = [
      userMsg("Fix bug"),
      assistantMsg("Fixed it"),
    ];
    const ctx = buildTranscriptionContext(history);
    // Check indentation structure — first "User:" may lose leading spaces after trim(),
    // but the content lines and "Assistant:" still have proper indentation
    expect(ctx).toContain("User:");
    expect(ctx).toMatch(/\s{4}Fix bug/);
    expect(ctx).toMatch(/\s{2}Assistant:/);
    expect(ctx).toMatch(/\s{4}Fixed it/);
  });
});

// ─── buildEnhancementPrompt ─────────────────────────────────────────────────

describe("buildEnhancementPrompt", () => {
  it("wraps transcript in XML tags", () => {
    const prompt = buildEnhancementPrompt("hello world", "");
    expect(prompt).toContain("<TRANSCRIPT>");
    expect(prompt).toContain("hello world");
    expect(prompt).toContain("</TRANSCRIPT>");
  });

  it("includes conversation context when provided", () => {
    const prompt = buildEnhancementPrompt("fix the bug", "User: Fix the auth bug");
    expect(prompt).toContain("<CONVERSATION_CONTEXT>");
    expect(prompt).toContain("Fix the auth bug");
    expect(prompt).toContain("</CONVERSATION_CONTEXT>");
    expect(prompt).toContain("<TRANSCRIPT>");
    expect(prompt).toContain("fix the bug");
  });

  it("omits context section when empty", () => {
    const prompt = buildEnhancementPrompt("hello", "");
    expect(prompt).not.toContain("<CONVERSATION_CONTEXT>");
    expect(prompt).toContain("<TRANSCRIPT>");
  });
});

// ─── enhanceTranscript ──────────────────────────────────────────────────────

describe("enhanceTranscript", () => {
  const defaultConfig = {
    apiKey: "test-key",
    baseUrl: "https://api.openai.com/v1",
    enhancementEnabled: true,
    enhancementModel: "gpt-5-mini",
  };

  it("skips enhancement when disabled in config", async () => {
    const config = { ...defaultConfig, enhancementEnabled: false };
    const result = await enhanceTranscript("fix the auth bug", [], config, "key");
    expect(result.enhanced).toBe(false);
    expect(result.text).toBe("fix the auth bug");
    expect(result.rawText).toBeUndefined();
  });

  it("skips enhancement for short transcripts", async () => {
    // Less than MIN_WORDS_FOR_ENHANCEMENT words
    const result = await enhanceTranscript("yes", [userMsg("hello")], defaultConfig, "key");
    expect(result.enhanced).toBe(false);
    expect(result.text).toBe("yes");
  });

  it("skips enhancement with null history", async () => {
    const result = await enhanceTranscript(
      "fix the auth token refresh bug",
      null,
      defaultConfig,
      "key",
    );
    expect(result.enhanced).toBe(false);
  });

  it("skips enhancement with empty history", async () => {
    const result = await enhanceTranscript(
      "fix the auth token refresh bug",
      [],
      defaultConfig,
      "key",
    );
    expect(result.enhanced).toBe(false);
  });
});

// ─── buildSttPrompt ──────────────────────────────────────────────────────────

function makeTask(title: string): SessionTaskEntry {
  return { title, action: "name", timestamp: Date.now(), triggerMessageId: "msg-1" };
}

describe("buildSttPrompt", () => {
  it("returns empty string with no input", () => {
    expect(buildSttPrompt({})).toBe("");
  });

  it("includes task titles", () => {
    const prompt = buildSttPrompt({
      taskHistory: [makeTask("Fix WsBridge reconnect"), makeTask("Add useVoiceInput hook")],
    });
    expect(prompt).toContain("Tasks:");
    expect(prompt).toContain("Fix WsBridge reconnect");
    expect(prompt).toContain("Add useVoiceInput hook");
  });

  it("deduplicates task titles (keeps unique only)", () => {
    const prompt = buildSttPrompt({
      taskHistory: [
        makeTask("Fix auth bug"),
        makeTask("Fix auth bug"),  // duplicate
        makeTask("Add tests"),
      ],
    });
    // "Fix auth bug" should appear only once
    const matches = prompt.match(/Fix auth bug/g);
    expect(matches).toHaveLength(1);
    expect(prompt).toContain("Add tests");
  });

  it("includes session name", () => {
    const prompt = buildSttPrompt({ sessionName: "Debug voice transcription" });
    expect(prompt).toContain("Session:");
    expect(prompt).toContain("Debug voice transcription");
  });

  it("includes composer context", () => {
    const prompt = buildSttPrompt({
      composerBefore: "Fix the bug in",
      composerAfter: "and add tests",
    });
    expect(prompt).toContain("Context:");
    expect(prompt).toContain("Fix the bug in");
    expect(prompt).toContain("[...]");
    expect(prompt).toContain("and add tests");
  });

  it("includes only composerBefore when composerAfter is empty", () => {
    const prompt = buildSttPrompt({ composerBefore: "Implement the" });
    expect(prompt).toContain("Context:");
    expect(prompt).toContain("Implement the");
    expect(prompt).not.toContain("[...]");
  });

  it("includes recent user messages", () => {
    const prompt = buildSttPrompt({
      messageHistory: [
        userMsg("Fix the auth token refresh in middleware"),
        assistantMsg("Done, fixed it"),
        userMsg("Now add unit tests for WsBridge"),
      ],
    });
    expect(prompt).toContain("Recent messages:");
    expect(prompt).toContain("Fix the auth token refresh");
    expect(prompt).toContain("Now add unit tests for WsBridge");
  });

  it("fills in priority order: tasks > session > composer > messages", () => {
    const prompt = buildSttPrompt({
      taskHistory: [makeTask("Fix auth bug")],
      sessionName: "Debug session",
      composerBefore: "Add a test for",
      messageHistory: [userMsg("Some earlier message")],
    });
    const lines = prompt.split("\n");
    // Tasks first
    expect(lines[0]).toMatch(/^Tasks:/);
    // Session second
    expect(lines[1]).toMatch(/^Session:/);
    // Composer third
    expect(lines[2]).toMatch(/^Context:/);
    // Messages last
    expect(lines[3]).toMatch(/^Recent messages:/);
  });

  it("respects the character budget", () => {
    const prompt = buildSttPrompt({
      taskHistory: [makeTask("A".repeat(100))],
      sessionName: "B".repeat(100),
      composerBefore: "C".repeat(100),
      messageHistory: [
        userMsg("D".repeat(500)),
        userMsg("E".repeat(500)),
        userMsg("F".repeat(500)),
        userMsg("G".repeat(500)),
      ],
    });
    // Should not exceed the budget
    expect(prompt.length).toBeLessThanOrEqual(STT_PROMPT_MAX_CHARS + 50); // small margin for labels
  });

  it("skips assistant messages when extracting user messages", () => {
    const prompt = buildSttPrompt({
      messageHistory: [
        userMsg("Fix the bug"),
        assistantMsg("I fixed it"),
        userMsg("Add tests"),
      ],
    });
    // Only user messages in the "Recent messages" section
    expect(prompt).toContain("Fix the bug");
    expect(prompt).toContain("Add tests");
    expect(prompt).not.toContain("I fixed it");
  });
});
