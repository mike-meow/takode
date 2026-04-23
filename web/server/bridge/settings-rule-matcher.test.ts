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
  mockReadFile.mockResolvedValue(JSON.stringify({ permissions: { allow: rules } }));
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

// ─── splitShellCommand (backed by shell-quote) ─────────────────────────────

describe("splitShellCommand", () => {
  // Core splitting behavior
  it("returns a single command as-is", () => {
    expect(splitShellCommand("ls -la")).toEqual(["ls -la"]);
  });

  it("splits on &&", () => {
    expect(splitShellCommand("cd /tmp && ls")).toEqual(["cd /tmp", "ls"]);
  });

  it("splits on ||", () => {
    expect(splitShellCommand("test -f x || echo no")).toEqual(["test -f x", "echo no"]);
  });

  it("splits on ;", () => {
    expect(splitShellCommand("echo a; echo b")).toEqual(["echo a", "echo b"]);
  });

  it("splits on |", () => {
    expect(splitShellCommand("cat file | grep foo")).toEqual(["cat file", "grep foo"]);
  });

  it("splits on | with COMMAND_SPLIT_OPS keeps pipe intact", () => {
    // When using COMMAND_SPLIT_OPS (no pipes), the pipe stays as part of the command
    const COMMAND_SPLIT_OPS = new Set(["&&", "||", ";"]);
    expect(splitShellCommand("cat file | grep foo", COMMAND_SPLIT_OPS)).toEqual(["cat file | grep foo"]);
  });

  // Quoting prevents splitting (shell-quote returns unquoted tokens)
  it("does NOT split inside single-quoted strings", () => {
    const result = splitShellCommand("echo 'a && b'");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("a && b");
  });

  it("does NOT split inside double-quoted strings", () => {
    const result = splitShellCommand('echo "a | b"');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("a | b");
  });

  // Comments are stripped by shell-quote
  it("strips trailing shell comments", () => {
    const result = splitShellCommand("grep foo bar.txt # search for foo");
    expect(result).toEqual(["grep foo bar.txt"]);
  });

  it("strips comment containing operators (prevents false split)", () => {
    const result = splitShellCommand("ls -la # this && that");
    expect(result).toEqual(["ls -la"]);
  });

  // Edge cases
  it("handles empty command", () => {
    expect(splitShellCommand("")).toEqual([]);
  });

  it("handles multiple operators in sequence (default splits all)", () => {
    const result = splitShellCommand("a && b | c && d");
    expect(result).toEqual(["a", "b", "c", "d"]);
  });

  it("handles multiple operators with COMMAND_SPLIT_OPS (pipes preserved)", () => {
    const COMMAND_SPLIT_OPS = new Set(["&&", "||", ";"]);
    const result = splitShellCommand("a && b | c && d", COMMAND_SPLIT_OPS);
    expect(result).toEqual(["a", "b | c", "d"]);
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
    expect(matchesToolRule("Read", { file_path: "/any/file" }, { toolName: "Read" })).toBe(true);
  });

  it("rejects different tool name", () => {
    expect(matchesToolRule("Write", { file_path: "/any" }, { toolName: "Read" })).toBe(false);
  });

  it("matches Bash rule with command", () => {
    expect(matchesToolRule("Bash", { command: "grep -rn foo" }, { toolName: "Bash", ruleContent: "grep *" })).toBe(
      true,
    );
  });

  it("matches file tool with glob", () => {
    expect(matchesToolRule("Edit", { file_path: "src/app.ts" }, { toolName: "Edit", ruleContent: "src/*.ts" })).toBe(
      true,
    );
  });

  it("rejects unknown tool with ruleContent (conservative)", () => {
    expect(matchesToolRule("CustomTool", { data: "abc" }, { toolName: "CustomTool", ruleContent: "abc" })).toBe(false);
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

  it("allows safe heredoc $(cat <<'EOF' ... EOF)", () => {
    const cmd = `takode send 16 "$(cat <<'EOF'\nHello world\nMulti-line message\nEOF\n)"`;
    expect(hasDangerousShellConstructs(cmd)).toBe(false);
  });

  it("allows safe heredoc $(cat <<EOF ... EOF) without quotes", () => {
    const cmd = `takode send 16 "$(cat <<EOF\nHello world\nEOF\n)"`;
    expect(hasDangerousShellConstructs(cmd)).toBe(false);
  });

  it("allows heredoc with indent-stripping <<-", () => {
    const cmd = `git commit -m "$(cat <<-'EOF'\n  Commit message here.\n  EOF\n  )"`;
    expect(hasDangerousShellConstructs(cmd)).toBe(false);
  });

  it("still detects $() when mixed with heredoc", () => {
    // Heredoc is safe but there's ALSO a separate $() outside it
    const cmd = `takode send 16 "$(cat <<'EOF'\nhello\nEOF\n)" && echo $(whoami)`;
    expect(hasDangerousShellConstructs(cmd)).toBe(true);
  });

  it("still detects backticks inside heredoc command", () => {
    // The heredoc content is fine but backticks outside are dangerous
    const cmd = "echo `whoami` && takode send 16 \"$(cat <<'EOF'\nhello\nEOF\n)\"";
    expect(hasDangerousShellConstructs(cmd)).toBe(true);
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

  it("approves piped command when first command matches (pipes stay intact)", async () => {
    // `ls foo | head` matches `Bash(ls *)` because pipes are not split for rule matching
    setupRules(["Bash(ls *)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "ls ~/.companion/codex-home/ 2>/dev/null | head",
    });
    expect(result).toBe("Bash(ls *)");
  });

  it("approves pipe chain when first command matches rule", async () => {
    // The pipe target (grep) doesn't need its own rule — it's just data flow
    setupRules(["Bash(cat *)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "cat file | grep foo",
    });
    expect(result).toBe("Bash(cat *)");
  });

  it("approves pipe chain when both have rules (reports first match)", async () => {
    setupRules(["Bash(cat *)", "Bash(grep *)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "cat file | grep foo",
    });
    // Only the first-command's rule is reported since pipes stay intact
    expect(result).toBe("Bash(cat *)");
  });

  it("rejects commands with dangerous first token", async () => {
    setupRules(["Bash(*)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "python3 -c 'import os; os.system(\"rm -rf /\")'",
    });
    expect(result).toBeNull();
  });

  it("rejects pipe chain when pipe target has dangerous first token", async () => {
    // Even though pipes aren't split for rule matching, security guards still
    // scan every pipe segment — python in a pipe target is still dangerous
    setupRules(["Bash(cat *)"]);
    const result = await shouldSettingsRuleApprove("Bash", {
      command: "cat file | python3 -c 'import os'",
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
