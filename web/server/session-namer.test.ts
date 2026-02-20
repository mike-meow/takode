import { describe, it, expect } from "vitest";
import type { BrowserIncomingMessage } from "./session-types.js";
import { _testHelpers } from "./session-namer.js";

const {
  buildFirstTurnPrompt,
  buildUpdatePrompt,
  buildConversationBlock,
  formatToolCall,
  parseResponse,
  sanitizeTitle,
} = _testHelpers;

// ─── Helper to build a mock message history ────────────────────────────────

function userMsg(content: string, ts = Date.now()): BrowserIncomingMessage {
  return { type: "user_message", content, timestamp: ts, id: `user-${ts}` };
}

function assistantMsg(
  contentBlocks: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }>,
): BrowserIncomingMessage {
  return {
    type: "assistant",
    message: {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: contentBlocks,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    parent_tool_use_id: null,
  } as unknown as BrowserIncomingMessage;
}

// ─── sanitizeTitle ─────────────────────────────────────────────────────────

describe("sanitizeTitle", () => {
  it("returns trimmed title", () => {
    expect(sanitizeTitle("  Fix Auth Bug  ")).toBe("Fix Auth Bug");
  });

  it("strips surrounding double quotes", () => {
    expect(sanitizeTitle('"Fix Auth Bug"')).toBe("Fix Auth Bug");
  });

  it("strips surrounding single quotes", () => {
    expect(sanitizeTitle("'Fix Auth Bug'")).toBe("Fix Auth Bug");
  });

  it("returns null for empty string", () => {
    expect(sanitizeTitle("")).toBeNull();
  });

  it("returns null for titles >= 100 chars", () => {
    expect(sanitizeTitle("A".repeat(100))).toBeNull();
  });

  it("allows titles up to 99 chars", () => {
    expect(sanitizeTitle("A".repeat(99))).toBe("A".repeat(99));
  });
});

// ─── parseResponse ─────────────────────────────────────────────────────────

describe("parseResponse", () => {
  describe("first turn", () => {
    it("returns name action with the title", () => {
      expect(parseResponse("Fix Auth Bug", true)).toEqual({
        action: "name",
        title: "Fix Auth Bug",
      });
    });

    it("strips quotes from title", () => {
      expect(parseResponse('"Fix Auth Bug"', true)).toEqual({
        action: "name",
        title: "Fix Auth Bug",
      });
    });

    it("returns null for empty response", () => {
      expect(parseResponse("", true)).toBeNull();
    });
  });

  describe("subsequent turns", () => {
    it("parses NO_CHANGE", () => {
      expect(parseResponse("NO_CHANGE", false)).toEqual({ action: "no_change" });
    });

    it("parses NO_CHANGE case-insensitive", () => {
      expect(parseResponse("no_change", false)).toEqual({ action: "no_change" });
    });

    it("parses No Change with space", () => {
      expect(parseResponse("No Change", false)).toEqual({ action: "no_change" });
    });

    it("parses REVISE: title", () => {
      expect(parseResponse("REVISE: Better Title", false)).toEqual({
        action: "revise",
        title: "Better Title",
      });
    });

    it("parses revise: case-insensitive", () => {
      expect(parseResponse("revise: Better Title", false)).toEqual({
        action: "revise",
        title: "Better Title",
      });
    });

    it("parses NEW: title", () => {
      expect(parseResponse("NEW: Add Dark Mode", false)).toEqual({
        action: "new",
        title: "Add Dark Mode",
      });
    });

    it("parses new: case-insensitive", () => {
      expect(parseResponse("new: Add Dark Mode", false)).toEqual({
        action: "new",
        title: "Add Dark Mode",
      });
    });

    it("falls back to revise for bare title on subsequent turns", () => {
      // Model might just output a title without prefix
      expect(parseResponse("Fix Auth Bug", false)).toEqual({
        action: "revise",
        title: "Fix Auth Bug",
      });
    });

    it("parses NO_CHANGE even when model adds explanation on subsequent lines", () => {
      // Model sometimes outputs "NO_CHANGE" then explains its reasoning — parser
      // should extract the first line only
      expect(parseResponse(
        "NO_CHANGE\n\nThe current title accurately describes what's happening.",
        false,
      )).toEqual({ action: "no_change" });
    });

    it("parses REVISE with trailing explanation lines", () => {
      expect(parseResponse(
        "REVISE: Fix token refresh\n\nThe task narrowed to just the refresh flow.",
        false,
      )).toEqual({ action: "revise", title: "Fix token refresh" });
    });

    it("parses first-turn title even with trailing explanation", () => {
      expect(parseResponse(
        "Debug auth pipeline\n\nThis session focuses on authentication.",
        true,
      )).toEqual({ action: "name", title: "Debug auth pipeline" });
    });

    it("falls back to revise using first line for unstructured multi-line output", () => {
      // First line is a bare title, subsequent lines are explanation
      expect(parseResponse("Fix Auth Bug\nSome extra reasoning here", false)).toEqual({
        action: "revise",
        title: "Fix Auth Bug",
      });
    });
  });
});

// ─── formatToolCall ────────────────────────────────────────────────────────

describe("formatToolCall", () => {
  const home = process.env.HOME || process.env.USERPROFILE || "";

  it("formats Read with file path and shortens home dir", () => {
    expect(formatToolCall("Read", { file_path: `${home}/project/src/auth.ts` })).toBe(
      "[Read: ~/project/src/auth.ts]",
    );
  });

  it("formats Edit with file path and shortens home dir", () => {
    expect(formatToolCall("Edit", { file_path: `${home}/src/main.ts` })).toBe(
      "[Edit: ~/src/main.ts]",
    );
  });

  it("formats Write with file path (no home shortening for /tmp)", () => {
    expect(formatToolCall("Write", { file_path: "/tmp/test.txt" })).toBe(
      "[Write: /tmp/test.txt]",
    );
  });

  it("formats Bash with truncated command", () => {
    // MAX_BASH_CMD_CHARS is 200, so a 300-char command should be truncated
    const longCmd = "cd web && bun run test -- --reporter=verbose " + "x".repeat(300);
    const result = formatToolCall("Bash", { command: longCmd });
    expect(result).toMatch(/^\[Bash: .+\]$/);
    // "[Bash: " (7) + 200 chars + "..." (3) + "]" (1) = 211
    expect(result.length).toBeLessThan(220);
    expect(result).toContain("...");
  });

  it("formats Grep with pattern and path", () => {
    expect(formatToolCall("Grep", { pattern: "session_name", path: `${home}/src` })).toBe(
      '[Grep: "session_name" in ~/src]',
    );
  });

  it("formats Glob with pattern", () => {
    expect(formatToolCall("Glob", { pattern: "**/*.test.ts" })).toBe(
      "[Glob: **/*.test.ts]",
    );
  });

  it("formats Task with agent type and description", () => {
    expect(formatToolCall("Task", { subagent_type: "Explore", description: "Find auth code" })).toBe(
      '[Task: Explore — "Find auth code"]',
    );
  });

  it("formats AskUserQuestion with first question", () => {
    expect(
      formatToolCall("AskUserQuestion", {
        questions: [{ question: "Which approach should we use?" }],
      }),
    ).toBe('[AskUserQuestion: "Which approach should we use?"]');
  });

  it("formats TodoWrite with item count", () => {
    expect(formatToolCall("TodoWrite", { todos: [{}, {}, {}] })).toBe("[TodoWrite: 3 items]");
  });

  it("formats unknown tool with first string input", () => {
    expect(formatToolCall("CustomTool", { query: "search this" })).toBe(
      "[CustomTool: query=search this]",
    );
  });

  it("formats unknown tool with no string inputs as bare name", () => {
    expect(formatToolCall("CustomTool", { count: 5 })).toBe("[CustomTool]");
  });

  // ─── cwd-relative path tests ─────────────────────────────────────────────

  it("uses cwd-relative path when cwd is provided and path is under it", () => {
    // When the file is inside the session's cwd, strip the cwd prefix
    expect(formatToolCall("Read", { file_path: "/home/user/project/web/server/foo.ts" }, "/home/user/project")).toBe(
      "[Read: web/server/foo.ts]",
    );
  });

  it("falls back to home-shortened path when file is outside cwd", () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    // File outside the cwd falls back to ~/... shortening
    expect(formatToolCall("Read", { file_path: `${home}/other/file.ts` }, "/home/user/project")).toBe(
      "[Read: ~/other/file.ts]",
    );
  });

  it("uses cwd-relative path for Grep path parameter", () => {
    expect(formatToolCall("Grep", { pattern: "foo", path: "/proj/web/server" }, "/proj")).toBe(
      '[Grep: "foo" in web/server]',
    );
  });
});

// ─── buildConversationBlock ────────────────────────────────────────────────

describe("buildConversationBlock", () => {
  it("formats a single user message with [User] header", () => {
    const history: BrowserIncomingMessage[] = [userMsg("Fix the auth bug")];
    const block = buildConversationBlock(history);
    expect(block).toContain("    [User]");
    expect(block).toContain("    | Fix the auth bug");
  });

  it("includes tool calls under [Assistant] header", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Fix the auth bug"),
      assistantMsg([
        { type: "text", text: "I'll fix that." },
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/src/auth.ts" } },
        { type: "tool_use", id: "tu-2", name: "Edit", input: { file_path: "/src/auth.ts" } },
      ]),
    ];
    const block = buildConversationBlock(history);
    expect(block).toContain("    [User]");
    expect(block).toContain("    | Fix the auth bug");
    expect(block).toContain("    [Assistant]");
    expect(block).toContain("    | I'll fix that.");
    expect(block).toContain("    | [Read: /src/auth.ts]");
    expect(block).toContain("    | [Edit: /src/auth.ts]");
  });

  it("groups tool calls between user messages correctly", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Fix the auth bug"),
      assistantMsg([
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/src/auth.ts" } },
      ]),
      userMsg("Now add dark mode"),
      assistantMsg([
        { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/src/theme.ts" } },
      ]),
    ];
    const block = buildConversationBlock(history);
    expect(block).toContain("    | Fix the auth bug");
    expect(block).toContain("    | Now add dark mode");
  });

  it("truncates long user messages", () => {
    const longMsg = "A".repeat(2000);
    const history: BrowserIncomingMessage[] = [userMsg(longMsg)];
    const block = buildConversationBlock(history);
    // Should be truncated to MAX_USER_MSG_CHARS (1000) + "..."
    expect(block).toContain("A".repeat(1000) + "...");
    expect(block).not.toContain("A".repeat(1001));
  });

  it("limits to last 6 turns (MAX_TURNS)", () => {
    // Create 10 user messages with tool calls
    const history: BrowserIncomingMessage[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(userMsg(`Message ${i}`));
      history.push(
        assistantMsg([{ type: "tool_use", id: `tu-${i}`, name: "Read", input: { file_path: `/f${i}.ts` } }]),
      );
    }
    const block = buildConversationBlock(history);
    // First 4 messages should be excluded (only last 6 kept)
    expect(block).not.toContain("Message 0");
    expect(block).not.toContain("Message 3");
    // Last 6 should be included
    expect(block).toContain("Message 4");
    expect(block).toContain("Message 9");
  });

  it("uses indentation prefix on content lines and headers without prefix", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Hello"),
      assistantMsg([
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo hello" } },
      ]),
    ];
    const block = buildConversationBlock(history);
    const contentLines = block.split("\n").filter((l) => l.trim() !== "");
    for (const line of contentLines) {
      // Headers like "    [User]" or content like "    | text"
      expect(line).toMatch(/^ {4}(\[|[|] )/);
    }
  });

  it("annotates user messages that have image attachments", () => {
    const msgWithImages = {
      type: "user_message" as const,
      content: "Fix this CSS",
      timestamp: Date.now(),
      id: "u-img",
      images: [{ imageId: "img1", media_type: "image/png" }, { imageId: "img2", media_type: "image/png" }],
    };
    const block = buildConversationBlock([msgWithImages]);
    expect(block).toContain("Fix this CSS [2 images attached]");
  });

  it("includes assistant text responses in turns", () => {
    const history: BrowserIncomingMessage[] = [
      userMsg("Fix the login bug"),
      assistantMsg([
        { type: "text", text: "I'll investigate the authentication flow and fix the issue." },
        { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/src/auth.ts" } },
      ]),
    ];
    const block = buildConversationBlock(history);
    expect(block).toContain("    [Assistant]");
    expect(block).toContain("    | I'll investigate the authentication flow");
    expect(block).toContain("    | [Read: ");
  });

  it("does not annotate messages without images", () => {
    const block = buildConversationBlock([userMsg("Hello")]);
    expect(block).not.toContain("image");
  });
});

// ─── buildFirstTurnPrompt ──────────────────────────────────────────────────

describe("buildFirstTurnPrompt", () => {
  it("includes generation instruction", () => {
    const prompt = buildFirstTurnPrompt([userMsg("Fix login bug")]);
    expect(prompt).toContain("Generate a concise 3-5 word title");
    expect(prompt).toContain("Output ONLY the title");
  });

  it("includes user message", () => {
    const prompt = buildFirstTurnPrompt([userMsg("Refactor the auth module")]);
    expect(prompt).toContain("Refactor the auth module");
  });

  it("does not include a current title", () => {
    const prompt = buildFirstTurnPrompt([userMsg("Fix login bug")]);
    expect(prompt).not.toContain("current title");
    expect(prompt).not.toContain("NO_CHANGE");
    expect(prompt).not.toContain("REVISE");
  });
});

// ─── buildUpdatePrompt ─────────────────────────────────────────────────────

describe("buildUpdatePrompt", () => {
  it("includes current title in indented block", () => {
    const prompt = buildUpdatePrompt("Fix Auth Bug", [userMsg("Continue fixing")]);
    expect(prompt).toContain('    | "Fix Auth Bug"');
  });

  it("includes all three action options", () => {
    const prompt = buildUpdatePrompt("Fix Auth Bug", [userMsg("Continue")]);
    expect(prompt).toContain("NO_CHANGE");
    expect(prompt).toContain("REVISE:");
    expect(prompt).toContain("NEW:");
  });

  it("includes conversation history with indentation", () => {
    const prompt = buildUpdatePrompt("Auth Fix", [userMsg("Fix the login"), userMsg("Also handle tokens")]);
    expect(prompt).toContain("    | Fix the login");
    expect(prompt).toContain("    | Also handle tokens");
  });
});
