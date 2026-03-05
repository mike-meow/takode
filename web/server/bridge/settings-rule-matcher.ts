/**
 * Settings.json permission rule matcher for SDK sessions.
 *
 * Replicates the Claude Code CLI's built-in permission rules (from ~/.claude/settings.json)
 * in the Companion server. SDK sessions bypass the CLI's rule engine because
 * --permission-prompt-tool stdio intercepts all permission requests first.
 *
 * Design philosophy: CONSERVATIVE — only approve when ALL subcommands match.
 * Reject on any ambiguity. No LLM calls — pure static matching.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "shell-quote";
import { NEVER_AUTO_APPROVE, isSensitiveBashCommand, isSensitiveConfigPath } from "./permission-pipeline.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ParsedToolRule {
  toolName: string;
  /** undefined = match any usage of this tool (e.g. bare "Read" or "Bash(*)") */
  ruleContent?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DANGEROUS_FIRST_TOKENS = new Set([
  "bash", "sh", "zsh", "fish", "csh", "tcsh", "ksh", "dash",
  "python", "python3", "node", "ruby", "perl", "php", "lua",
  "eval", "exec", "source", "ssh",
]);

const WRITE_COMMANDS = new Set([
  "rm", "mv", "cp", "chmod", "chown", "touch", "mkdir", "rmdir",
  "tee", "dd", "truncate", "install",
]);

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

const RULE_CACHE_TTL_MS = 30_000;

// ─── Rule Parsing ───────────────────────────────────────────────────────────

/** Find the first (or last if fromEnd=true) unescaped occurrence of `ch`. */
function findUnescaped(str: string, ch: string, fromEnd = false): number {
  const indices = fromEnd
    ? Array.from({ length: str.length }, (_, i) => str.length - 1 - i)
    : Array.from({ length: str.length }, (_, i) => i);
  for (const i of indices) {
    if (str[i] !== ch) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && str[j] === "\\"; j--) backslashes++;
    if (backslashes % 2 === 0) return i;
  }
  return -1;
}

/**
 * Parse a permission rule string like "Bash(grep *)" into structured form.
 * Returns null for empty/invalid rules.
 */
export function parseToolRule(rule: string): ParsedToolRule | null {
  const trimmed = rule.trim();
  if (!trimmed) return null;

  const openIdx = findUnescaped(trimmed, "(");
  if (openIdx === -1) return { toolName: trimmed };

  const closeIdx = findUnescaped(trimmed, ")", true);
  if (closeIdx === -1 || closeIdx <= openIdx) return { toolName: trimmed };
  if (closeIdx !== trimmed.length - 1) return { toolName: trimmed };

  const toolName = trimmed.substring(0, openIdx);
  if (!toolName) return { toolName: trimmed };

  const inner = trimmed.substring(openIdx + 1, closeIdx);
  const ruleContent = inner.replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");

  if (ruleContent === "" || ruleContent === "*") return { toolName };
  return { toolName, ruleContent };
}

// ─── Shell Command Splitting (via shell-quote) ──────────────────────────────

/** Operators that separate independent commands in a shell pipeline. */
const SHELL_SPLIT_OPS = new Set(["&&", "||", ";", "|"]);

/**
 * Split a Bash command on shell operators (&&, ||, ;, |) while respecting
 * quoting and comments. Delegates to the `shell-quote` package for correct
 * tokenization — handles single/double quotes, backticks, $(), escapes,
 * heredocs, and comments out of the box.
 */
export function splitShellCommand(command: string): string[] {
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    // If shell-quote can't parse (malformed input), return the whole command.
    // Narrow rules won't match → safe fallthrough to LLM/human.
    return [command.trim()].filter(Boolean);
  }

  const parts: string[] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (typeof token === "string") {
      current.push(token);
    } else if (token && typeof token === "object") {
      if ("op" in token && SHELL_SPLIT_OPS.has(token.op)) {
        // Operator token — flush current subcommand
        if (current.length > 0) {
          parts.push(current.join(" "));
          current = [];
        }
      } else if ("op" in token) {
        // Non-splitting operator (e.g. >, >>, <, etc.) — include in current subcommand
        current.push(token.op);
      } else if ("comment" in token) {
        // Comment — ignore (shell-quote already stripped it from the token stream)
      } else if ("pattern" in token) {
        // Glob pattern — include as-is
        current.push(String(token.pattern));
      }
    }
  }

  if (current.length > 0) {
    parts.push(current.join(" "));
  }

  return parts;
}

// ─── Bash Rule Matching ─────────────────────────────────────────────────────

/**
 * Check if a command string matches a Bash rule pattern.
 *
 * Pattern types (from real settings.json):
 *   "grep *"        — space-star: prefix match
 *   "git commit:*"  — colon-star: prefix match
 *   "git status*"   — trailing star: startsWith
 *   "git status"    — exact match only
 */
export function matchesBashRule(command: string, ruleContent: string): boolean {
  const cmd = command.trim();
  const rule = ruleContent.trim();
  if (!cmd || !rule) return false;

  // Space-star: "grep *" → matches "grep", "grep -rn foo", etc.
  if (rule.endsWith(" *")) {
    const prefix = rule.slice(0, -2);
    return cmd === prefix || cmd.startsWith(prefix + " ") || cmd.startsWith(prefix + "\t");
  }

  // Colon-star: "git commit:*" → matches "git commit", "git commit -m msg"
  if (rule.endsWith(":*")) {
    const prefix = rule.slice(0, -2);
    return cmd === prefix || cmd.startsWith(prefix + " ") || cmd.startsWith(prefix + "\t");
  }

  // Trailing star (not space/colon before): "git status*" → startsWith
  if (rule.endsWith("*")) {
    const prefix = rule.slice(0, -1);
    return cmd.startsWith(prefix);
  }

  // Exact match
  return cmd === rule;
}

// ─── File Glob Matching ─────────────────────────────────────────────────────

/** Match a file path against a simple glob pattern (* and **). */
export function matchesFileGlob(filePath: string, pattern: string): boolean {
  if (!filePath || !pattern) return false;
  const normalized = pattern.replace(/\/\//g, "/");
  let regex = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  regex = regex.replace(/\*\*/g, "{{DOUBLESTAR}}");
  regex = regex.replace(/\*/g, "[^/]*");
  regex = regex.replace(/\{\{DOUBLESTAR\}\}/g, ".*");
  try {
    return new RegExp(`^${regex}$`).test(filePath);
  } catch {
    return false;
  }
}

// ─── Tool Rule Matching ─────────────────────────────────────────────────────

/** Check if a tool use matches a parsed permission rule. */
export function matchesToolRule(
  toolName: string,
  input: Record<string, unknown>,
  rule: ParsedToolRule,
): boolean {
  if (rule.toolName !== toolName) return false;
  if (rule.ruleContent === undefined) return true;

  if (toolName === "Bash") {
    return matchesBashRule(String(input.command ?? ""), rule.ruleContent);
  }
  if (FILE_TOOLS.has(toolName)) {
    return matchesFileGlob(String(input.file_path ?? ""), rule.ruleContent);
  }
  // Unknown tool shape with ruleContent — don't match (conservative)
  return false;
}

// ─── Security Guards ────────────────────────────────────────────────────────

/** Reject commands with shell constructs that could inject arbitrary code. */
export function hasDangerousShellConstructs(command: string): boolean {
  if (/\$\(/.test(command)) return true;
  if (/`/.test(command)) return true;
  if (/[<>]\(/.test(command)) return true;
  return false;
}

/** Reject commands whose first token is a shell interpreter or dangerous builtin. */
export function isDangerousFirstToken(command: string): boolean {
  const firstToken = command.trim().split(/\s+/)[0] ?? "";
  const base = firstToken.split("/").pop() ?? firstToken;
  return DANGEROUS_FIRST_TOKENS.has(base);
}

/** Reject compound commands that combine cd with write operations. */
export function hasCdAndWritePattern(subcommands: string[]): boolean {
  let hasCd = false;
  let hasWrite = false;
  for (const sub of subcommands) {
    const first = sub.trim().split(/\s+/)[0] ?? "";
    if (first === "cd") hasCd = true;
    if (WRITE_COMMANDS.has(first)) hasWrite = true;
  }
  return hasCd && hasWrite;
}

// ─── Rule Loading ───────────────────────────────────────────────────────────

interface CachedRules {
  rules: ParsedToolRule[];
  loadedAt: number;
}

let cachedUserRules: CachedRules | null = null;
const cachedProjectRules = new Map<string, CachedRules>();

async function loadRulesFromFile(filePath: string): Promise<ParsedToolRule[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    const allowRules: unknown[] = Array.isArray(data?.permissions?.allow)
      ? data.permissions.allow
      : [];
    return allowRules
      .filter((r): r is string => typeof r === "string")
      .map(parseToolRule)
      .filter((r): r is ParsedToolRule => r !== null);
  } catch {
    return [];
  }
}

/** Load allow rules from user and project settings, cached with 30s TTL. */
export async function loadAllowRules(cwd?: string): Promise<ParsedToolRule[]> {
  const now = Date.now();
  const allRules: ParsedToolRule[] = [];

  const userPath = join(homedir(), ".claude", "settings.json");
  if (!cachedUserRules || now - cachedUserRules.loadedAt > RULE_CACHE_TTL_MS) {
    cachedUserRules = { rules: await loadRulesFromFile(userPath), loadedAt: now };
  }
  allRules.push(...cachedUserRules.rules);

  if (cwd) {
    for (const filename of ["settings.json", "settings.local.json"]) {
      const path = join(cwd, ".claude", filename);
      const cached = cachedProjectRules.get(path);
      if (!cached || now - cached.loadedAt > RULE_CACHE_TTL_MS) {
        cachedProjectRules.set(path, { rules: await loadRulesFromFile(path), loadedAt: now });
      }
      allRules.push(...(cachedProjectRules.get(path)?.rules ?? []));
    }
  }

  return allRules;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Check if a tool use should be auto-approved based on settings.json allow rules.
 * Returns matched rule description, or null if no match.
 *
 * For Bash: splits compound commands and requires ALL subcommands to match.
 */
export async function shouldSettingsRuleApprove(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): Promise<string | null> {
  if (NEVER_AUTO_APPROVE.has(toolName)) return null;

  const rules = await loadAllowRules(cwd);
  if (rules.length === 0) return null;

  // ── Non-Bash tools ──
  if (toolName !== "Bash") {
    if (FILE_TOOLS.has(toolName) && isSensitiveConfigPath(String(input.file_path ?? ""))) {
      return null;
    }
    for (const rule of rules) {
      if (matchesToolRule(toolName, input, rule)) {
        return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
      }
    }
    return null;
  }

  // ── Bash commands ──
  const command = String(input.command ?? "");
  if (!command.trim()) return null;

  if (isSensitiveBashCommand(command)) return null;
  if (hasDangerousShellConstructs(command)) return null;

  const subcommands = splitShellCommand(command);

  for (const sub of subcommands) {
    if (isDangerousFirstToken(sub)) return null;
    if (hasDangerousShellConstructs(sub)) return null;
    if (isSensitiveBashCommand(sub)) return null;
  }

  if (hasCdAndWritePattern(subcommands)) return null;

  // Every subcommand must match at least one Bash rule
  const matchedRules: string[] = [];
  for (const sub of subcommands) {
    let matched = false;
    for (const rule of rules) {
      if (rule.toolName !== "Bash") continue;
      if (rule.ruleContent === undefined) {
        matched = true;
        matchedRules.push("Bash(*)");
        break;
      }
      if (matchesBashRule(sub.trim(), rule.ruleContent)) {
        matched = true;
        matchedRules.push(`Bash(${rule.ruleContent})`);
        break;
      }
    }
    if (!matched) return null;
  }

  return matchedRules.join(" + ");
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

/** @internal — exposed for test cleanup */
export const _testHelpers = {
  resetCache: (): void => {
    cachedUserRules = null;
    cachedProjectRules.clear();
  },
};
