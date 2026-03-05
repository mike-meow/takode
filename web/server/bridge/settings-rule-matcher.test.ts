/**
 * Tests for settings-rule-matcher.ts — the static rule matcher that replicates
 * Claude Code CLI's built-in permission rules for SDK sessions.
 *
 * Mocks node:fs/promises to control rule loading without touching the filesystem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import {
  parseToolRule,
  stripShellComments,
  splitShellCommand,
  matchesBashRule,
  matchesFileGlob,
  matchesToolRule,
  hasDangerousShellConstructs,
  isDangerousFirstToken,
  hasCdAndWritePattern,
  shouldSettingsRuleApprove,
  _testHelpers,
} from "./settings-rule-matcher.js";

import { readFile } from "node:fs/promises";

const mockReadFile = vi.mocked(readFile);

/** Set up mock rules as if they came from ~/.claude/settings.json */
function setupRules(rules: string[]) {
  mockReadFile.mockResolvedValue(
    JSON.stringify({ permissions: { allow: rules } }),
  );
}

afterEach(() => {
  _testHelpers.resetCache();
  mockReadFile.mockReset();
});

// ─── parseToolRule ──────────────────────────────────────────────────────────

describe("parseToolRule", () => {
  it("parses a bare tool name without parens", () => {
    expect(parseToolRule("Read")).toEqual({ toolName: "Read" });
  });

  it("parses a wildcard rule — Bash(*) — as tool-only (no ruleContent)", () => {
    expect(parseToolRule("Bash(*)")).toEqual({ toolName: "Bash" });
  });

  it("parses empty parens as tool-only", () => {
    expect(parseToolRule("Bash()")).toEqual({ toolName: "Bash" });
  });

  it("parses a rule with a pattern", () => {
    expect(parseToolRule("Bash(grep *)")).toEqual({
      toolName: "Bash",
      ruleContent: "grep *",
    });
  });

  it("parses a file glob rule", () => {
    expect(parseToolRule("Edit(src/**/*.ts)")).toEqual({
      toolName: "Edit",
      ruleContent: "src/**/*.ts",
    });
  });

  it("parses a colon-star rule", () => {
    expect(parseToolRule("Bash(git commit:*)")).toEqual({
      toolName: "Bash",
      ruleContent: "git commit:*",
    });
  });

  it("returns null for empty string", () => {
    expect(parseToolRule("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseToolRule("   ")).toBeNull();
  });

  it("parses MCP tool names with double underscores", () => {
    expect(parseToolRule("mcp__slack__send_message")).toEqual({
      toolName: "mcp__slack__send_message",
    });
  });
});

// ─── stripShellComments ────────────────────────────────────────────────────

describe("stripShellComments", () => {
  it("strips trailing comment", () => {
    expect(stripShellComments("grep foo # search")).toBe("grep foo");
  });

  it("preserves # inside single quotes", () => {
    expect(stripShellComments("echo 'hello # world'")).toBe("echo 'hello # world'");
  });

  it("preserves # inside double quotes", () => {
    expect(stripShellComments('echo "hello # world"')).toBe('echo "hello # world"');
  });

  it("preserves # mid-word (not preceded by whitespace)", () => {
    expect(stripShellComments("echo foo#bar")).toBe("echo foo#bar");
  });

  it("returns original when no comment present", () => {
    expect(stripShellComments("ls -la")).toBe("ls -la");
  });

  it("handles # at the very start of the string", () => {
    expect(stripShellComments("# this is all comment")).toBe("");
  });

  it("handles tab before #", () => {
    expect(stripShellComments("ls\t# comment")).toBe("ls");
  });
});

// ─── splitShellCommand ──────────────────────────────────────────────────────

describe("splitShellCommand", () => {
  it("returns a single command as-is", () => {
    expect(splitShellCommand("ls -la")).toEqual(["ls -la"]);
  });

  it("splits on &&", () => {
    expect(splitShellCommand("cd /tmp && ls")).toEqual(["cd /tmp", "ls"]);
  });

  it("splits on ||", () => {
    expect(splitShellCommand("test -f x || echo no")).toEqual([
      "test -f x",
      "echo no",
    ]);
  });

  it("splits on ;", () => {
    expect(splitShellCommand("echo a; echo b")).toEqual(["echo a", "echo b"]);
  });

  it("splits on |", () => {
    expect(splitShellCommand("cat file | grep foo")).toEqual([
      "cat file",
      "grep foo",
    ]);
  });

  it("does NOT split inside single-quoted strings", () => {
    expect(splitShellCommand("echo 'a && b'")).toEqual(["echo 'a && b'"]);
  });

  it("does NOT split inside double-quoted strings", () => {
    expect(splitShellCommand('echo "a | b"')).toEqual(['echo "a | b"']);
  });

  it("does NOT split inside $() subshell", () => {
    expect(splitShellCommand("echo $(cat a && cat b)")).toEqual([
      "echo $(cat a && cat b)",
    ]);
  });

  it("returns whole command on unclosed quote (conservative)", () => {
    expect(splitShellCommand("echo 'unclosed")).toEqual(["echo 'unclosed"]);
  });

  it("strips trailing shell comments", () => {
    expect(splitShellCommand("grep foo bar.txt # search for foo")).toEqual(["grep foo bar.txt"]);
  });

  it("does not strip # inside quoted strings", () => {
    expect(splitShellCommand("echo 'hello # world'")).toEqual(["echo 'hello # world'"]);
    expect(splitShellCommand('echo "hello # world"')).toEqual(['echo "hello # world"']);
  });

  it("strips comment after operator (prevents false split on comment content)", () => {
    // Without comment handling, the && inside the comment would cause a false split
    expect(splitShellCommand("ls -la # this && that")).toEqual(["ls -la"]);
  });

  it("does not treat # mid-word as a comment", () => {
    // echo foo#bar — the # is not preceded by whitespace, not a comment
    expect(splitShellCommand("echo foo#bar")).toEqual(["echo foo#bar"]);
  });
});

// ─── matchesBashRule ────────────────────────────────────────────────────────

describe("matchesBashRule", () => {
  describe("space-star pattern", () => {
    it("matches exact prefix", () => {
      expect(matchesBashRule("grep", "grep *")).toBe(true);
    });

    it("matches prefix with args", () => {
      expect(matchesBashRule("grep -rn foo", "grep *")).toBe(true);
    });

    it("rejects non-matching command", () => {
      expect(matchesBashRule("cat file", "grep *")).toBe(false);
    });
  });

  describe("colon-star pattern", () => {
    it("matches exact prefix", () => {
      expect(matchesBashRule("git commit", "git commit:*")).toBe(true);
    });

    it("matches prefix with args", () => {
      expect(matchesBashRule("git commit -m msg", "git commit:*")).toBe(true);
    });

    it("rejects non-matching command", () => {
      expect(matchesBashRule("git push", "git commit:*")).toBe(false);
    });
  });

  describe("trailing star pattern", () => {
    it("matches startsWith", () => {
      expect(matchesBashRule("git status", "git status*")).toBe(true);
    });

    it("matches startsWith with suffix", () => {
      expect(matchesBashRule("git status --short", "git status*")).toBe(true);
    });

    it("rejects non-matching", () => {
      expect(matchesBashRule("git log", "git status*")).toBe(false);
    });
  });

  describe("exact match", () => {
    it("matches identical strings", () => {
      expect(matchesBashRule("git status", "git status")).toBe(true);
    });

    it("rejects similar but different strings", () => {
      expect(matchesBashRule("git status -s", "git status")).toBe(false);
    });
  });

  it("returns false for empty command or rule", () => {
    expect(matchesBashRule("", "grep *")).toBe(false);
    expect(matchesBashRule("grep foo", "")).toBe(false);
  });
});

// ─── matchesFileGlob ────────────────────────────────────────────────────────

describe("matchesFileGlob", () => {
  it("matches single star in directory", () => {
    expect(matchesFileGlob("src/foo.ts", "src/*.ts")).toBe(true);
  });

  it("matches double star (recursive)", () => {
    expect(matchesFileGlob("src/deep/nested/foo.ts", "src/**/*.ts")).toBe(true);
  });

  it("rejects non-matching pattern", () => {
    expect(matchesFileGlob("lib/foo.js", "src/**/*.ts")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(matchesFileGlob("", "src/*.ts")).toBe(false);
    expect(matchesFileGlob("src/foo.ts", "")).toBe(false);
  });
});

// ─── matchesToolRule ────────────────────────────────────────────────────────

describe("matchesToolRule", () => {
  it("matches bare tool name (any usage)", () => {
    expect(
      matchesToolRule("Read", { file_path: "/any/file" }, { toolName: "Read" }),
    ).toBe(true);
  });

  it("rejects different tool name", () => {
    expect(
      matchesToolRule("Write", { file_path: "/any" }, { toolName: "Read" }),
    ).toBe(false);
  });

  it("matches Bash rule with command", () => {
    expect(
      matchesToolRule(
        "Bash",
        { command: "grep -rn foo" },
        { toolName: "Bash", ruleContent: "grep *" },
      ),
    ).toBe(true);
  });

  it("matches file tool with glob", () => {
    expect(
      matchesToolRule(
        "Edit",
        { file_path: "src/app.ts" },
        { toolName: "Edit", ruleContent: "src/*.ts" },
      ),
    ).toBe(true);
  });

  it("rejects unknown tool with ruleContent (conservative)", () => {
    expect(
      matchesToolRule(
        "CustomTool",
        { data: "abc" },
        { toolName: "CustomTool", ruleContent: "abc" },
      ),
    ).toBe(false);
  });
});

// ─── Security Guards ────────────────────────────────────────────────────────

describe("hasDangerousShellConstructs", () => {
  it("detects $() command substitution", () => {
    expect(hasDangerousShellConstructs("echo $(whoami)")).toBe(true);
  });

  it("detects backtick command substitution", () => {
    expect(hasDangerousShellConstructs("echo `whoami`")).toBe(true);
  });

  it("detects process substitution <()", () => {
    expect(hasDangerousShellConstructs("diff <(cmd1) <(cmd2)")).toBe(true);
  });

  it("returns false for safe commands", () => {
    expect(hasDangerousShellConstructs("ls -la /tmp")).toBe(false);
  });
});

describe("isDangerousFirstToken", () => {
  it("detects shell interpreter", () => {
    expect(isDangerousFirstToken("bash -c 'rm -rf /'")).toBe(true);
  });

  it("detects python", () => {
    expect(isDangerousFirstToken("python3 -c 'import os'")).toBe(true);
  });

  it("detects eval", () => {
    expect(isDangerousFirstToken("eval some-command")).toBe(true);
  });

  it("detects node", () => {
    expect(isDangerousFirstToken("node -e 'process.exit()'")).toBe(true);
  });

  it("returns false for safe commands", () => {
    expect(isDangerousFirstToken("grep -rn foo")).toBe(false);
    expect(isDangerousFirstToken("cat /etc/hosts")).toBe(false);
  });

  it("blocks ssh (can execute arbitrary remote commands)", () => {
    expect(isDangerousFirstToken("ssh evil-host 'rm -rf /'")).toBe(true);
  });

  it("handles absolute path to dangerous binary", () => {
    // The implementation strips the path and checks the basename
    expect(isDangerousFirstToken("/usr/bin/python3 script.py")).toBe(true);
  });
});

describe("hasCdAndWritePattern", () => {
  it("detects cd + write command combination", () => {
    expect(hasCdAndWritePattern(["cd /tmp", "rm -rf ."])).toBe(true);
  });

  it("detects cd + mv combination", () => {
    expect(hasCdAndWritePattern(["cd /opt", "mv a b"])).toBe(true);
  });

  it("returns false for cd-only commands", () => {
    expect(hasCdAndWritePattern(["cd /tmp", "ls"])).toBe(false);
  });

  it("returns false for write-only commands (no cd)", () => {
    expect(hasCdAndWritePattern(["rm file.txt"])).toBe(false);
  });
});

// ─── shouldSettingsRuleApprove (integration) ────────────────────────────────

describe("shouldSettingsRuleApprove", () => {
  beforeEach(() => {
    _testHelpers.resetCache();
    mockReadFile.mockReset();
  });

  it("approves a Read tool when rule exists", async () => {
    setupRules(["Read"]);
    const result = await shouldSettingsRuleApprove("Read", {
      file_path: "/some/file",
    });
    expect(result).toBe("Read");
  });

  it("approves grep command when Bash(grep *) rule exists", async () => {
    setupRules(["Bash(grep *)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "grep -rn foo src/",
    });
    expect(result).toBe("Bash(grep *)");
  });

  it("rejects compound command when only one subcommand matches", async () => {
    // Only grep is allowed, but the command also has rm
    setupRules(["Bash(grep *)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "grep foo file && rm file",
    });
    expect(result).toBeNull();
  });

  it("approves compound pipe when all subcommands match", async () => {
    setupRules(["Bash(cat *)", "Bash(grep *)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "cat file | grep foo",
    });
    expect(result).toBe("Bash(cat *) + Bash(grep *)");
  });

  it("rejects commands with dangerous first token", async () => {
    setupRules(["Bash(*)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "python3 -c 'import os; os.system(\"rm -rf /\")'",
    });
    expect(result).toBeNull();
  });

  it("rejects commands with dangerous shell constructs", async () => {
    setupRules(["Bash(*)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "echo $(cat /etc/passwd)",
    });
    expect(result).toBeNull();
  });

  it("rejects file edits to sensitive paths", async () => {
    setupRules(["Edit"]);
    // CLAUDE.md is a sensitive config path
    const result = await shouldSettingsRuleApprove("Edit", {
      file_path: "/project/CLAUDE.md",
    });
    expect(result).toBeNull();
  });

  it("rejects tools in NEVER_AUTO_APPROVE set", async () => {
    setupRules(["AskUserQuestion"]);
    const result = await shouldSettingsRuleApprove("AskUserQuestion", {});
    expect(result).toBeNull();
  });

  it("rejects cd+write pattern even with wildcard rule", async () => {
    setupRules(["Bash(*)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "cd /tmp && rm -rf .",
    });
    expect(result).toBeNull();
  });

  it("approves colon-star rule", async () => {
    setupRules(["Bash(git commit:*)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "git commit -m 'hello'",
    });
    expect(result).toBe("Bash(git commit:*)");
  });

  it("approves exact match rule", async () => {
    setupRules(["Bash(git status)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "git status",
    });
    expect(result).toBe("Bash(git status)");
  });

  it("rejects when command doesn't match exact rule", async () => {
    setupRules(["Bash(git status)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "git status -s",
    });
    expect(result).toBeNull();
  });

  it("returns null when no rules are configured", async () => {
    // readFile throws → loadRulesFromFile returns []
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const result = await shouldSettingsRuleApprove("Read", {
      file_path: "/any",
    });
    expect(result).toBeNull();
  });

  it("rejects sensitive bash commands even with wildcard", async () => {
    setupRules(["Bash(*)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "cat .claude/settings.json",
    });
    expect(result).toBeNull();
  });
});
