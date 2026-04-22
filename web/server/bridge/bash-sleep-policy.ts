import { parse } from "shell-quote";
import { ALL_SPLIT_OPS, splitShellCommand } from "./shell-command-utils.js";

const COMMAND_WRAPPERS = new Set(["builtin", "command", "env", "nohup", "sudo", "time"]);
const SLEEP_DURATION_RE = /^(\d+(?:\.\d+)?)([smhd]?)$/i;
const INFINITE_SLEEP_TOKENS = new Set(["inf", "infinity"]);
const REDIRECTION_OPS = new Set([">", ">>", "<", "<<", "<<<", "<&", ">&", "<>", ">|", "&>", "&>>"]);
const MAX_ALLOWED_SLEEP_SECONDS = 60;
const WRAPPER_OPTIONS_WITH_VALUES: Record<string, Set<string>> = {
  env: new Set(["-u", "--unset", "--chdir", "-C", "--split-string", "-S"]),
  sudo: new Set([
    "-u",
    "--user",
    "-g",
    "--group",
    "-h",
    "--host",
    "-r",
    "--role",
    "-t",
    "--type",
    "-C",
    "--close-from",
    "-T",
    "--command-timeout",
  ]),
  time: new Set(),
  command: new Set(),
  builtin: new Set(),
  nohup: new Set(),
};

export const LONG_SLEEP_REMINDER_TEXT =
  "Do not use `sleep` longer than 1 minute. Use `takode timer` instead of long sleeps or polling waits.";
export const LONG_SLEEP_DENY_MESSAGE =
  "Denied: `sleep` commands longer than 60 seconds are not allowed. Use `takode timer` instead.";

export type LongSleepMatch = {
  durationSeconds: number;
  subcommand: string;
};

function shellTokenToWord(token: ReturnType<typeof parse>[number]): string | null {
  if (typeof token === "string") return token;
  if (!token || typeof token !== "object") return null;
  if ("pattern" in token) return String(token.pattern);
  return null;
}

function looksLikeEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
}

function baseCommandName(word: string): string {
  const normalized = word.trim();
  if (!normalized) return "";
  const slashParts = normalized.split("/");
  return (slashParts.at(-1) || normalized).toLowerCase();
}

function isRedirectionOp(op: string): boolean {
  return REDIRECTION_OPS.has(op);
}

function isNumericWord(word: string): boolean {
  return /^\d+$/.test(word.trim());
}

function isOptionWord(word: string): boolean {
  return word.startsWith("-") && word !== "-";
}

function getWrapperName(token: ReturnType<typeof parse>[number]): string | null {
  const word = shellTokenToWord(token);
  if (!word) return null;
  const base = baseCommandName(word);
  return COMMAND_WRAPPERS.has(base) ? base : null;
}

function shouldSkipWrapperOptionValue(wrapperName: string, option: string): boolean {
  const normalized = option.trim();
  const optionNames = WRAPPER_OPTIONS_WITH_VALUES[wrapperName];
  if (!optionNames) return false;
  if (optionNames.has(normalized)) return true;

  if (wrapperName === "sudo") {
    if (/^-[ughrtCT]/.test(normalized) && normalized.length === 2) return true;
    if (/^--(?:user|group|host|role|type|close-from|command-timeout)$/.test(normalized)) return true;
  }

  if (wrapperName === "env" && /^-(?:uC|S)$/.test(normalized) && normalized.length === 2) {
    return true;
  }

  return false;
}

function findWrappedExecutableIndex(tokens: ReturnType<typeof parse>): number {
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (token && typeof token === "object" && "comment" in token) return -1;

    const wrapperName = getWrapperName(token);
    const word = shellTokenToWord(token);
    if (!word) {
      i += 1;
      continue;
    }

    if (looksLikeEnvAssignment(word)) {
      i += 1;
      continue;
    }

    if (!wrapperName) return i;

    i += 1;
    while (i < tokens.length) {
      const current = tokens[i];
      if (current && typeof current === "object" && "comment" in current) return -1;
      const currentWord = shellTokenToWord(current);
      if (!currentWord) {
        i += 1;
        continue;
      }

      if (wrapperName === "env" && looksLikeEnvAssignment(currentWord)) {
        i += 1;
        continue;
      }

      if (currentWord === "--") {
        i += 1;
        break;
      }

      if (isOptionWord(currentWord)) {
        const skipValue = shouldSkipWrapperOptionValue(wrapperName, currentWord);
        i += skipValue ? 2 : 1;
        continue;
      }

      break;
    }
  }

  return -1;
}

function durationTokenToSeconds(word: string): number | null {
  const normalized = word.trim().toLowerCase();
  if (!normalized) return null;
  if (INFINITE_SLEEP_TOKENS.has(normalized)) return Number.POSITIVE_INFINITY;

  const match = SLEEP_DURATION_RE.exec(normalized);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;

  switch (match[2].toLowerCase()) {
    case "d":
      return value * 86_400;
    case "h":
      return value * 3_600;
    case "m":
      return value * 60;
    case "":
    case "s":
      return value;
    default:
      return null;
  }
}

function detectLongSleepInSubcommand(subcommand: string): LongSleepMatch | null {
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(subcommand);
  } catch {
    return null;
  }

  const executableIdx = findWrappedExecutableIndex(tokens);
  if (executableIdx === -1) return null;
  const executable = shellTokenToWord(tokens[executableIdx]);
  if (!executable || baseCommandName(executable) !== "sleep") return null;

  let totalSeconds = 0;
  let sawDuration = false;
  let parsingOptions = true;

  for (let i = executableIdx + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token && typeof token === "object") {
      if ("comment" in token) break;
      if ("op" in token) {
        if (isRedirectionOp(token.op)) break;
        continue;
      }
    }

    const word = shellTokenToWord(token);
    if (!word) continue;
    const nextToken = tokens[i + 1];
    if (
      sawDuration &&
      isNumericWord(word) &&
      nextToken &&
      typeof nextToken === "object" &&
      "op" in nextToken &&
      isRedirectionOp(nextToken.op)
    ) {
      break;
    }

    if (parsingOptions) {
      if (word === "--") {
        parsingOptions = false;
        continue;
      }
      if (word === "--verbose") continue;
      if (word.startsWith("-")) return null;
      parsingOptions = false;
    }

    const seconds = durationTokenToSeconds(word);
    if (seconds === null) return null;
    sawDuration = true;
    totalSeconds += seconds;
  }

  if (!sawDuration || totalSeconds <= MAX_ALLOWED_SLEEP_SECONDS) return null;
  return {
    durationSeconds: totalSeconds,
    subcommand: subcommand.trim(),
  };
}

export function detectLongSleepBashCommand(command: string): LongSleepMatch | null {
  if (!command.trim()) return null;
  const subcommands = splitShellCommand(command, ALL_SPLIT_OPS);
  for (const subcommand of subcommands) {
    const match = detectLongSleepInSubcommand(subcommand);
    if (match) return match;
  }
  return null;
}
