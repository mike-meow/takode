import { parse } from "shell-quote";

/** Operators that separate independent commands (NOT pipes — pipes are data flow). */
export const COMMAND_SPLIT_OPS = new Set(["&&", "||", ";", "&"]);

/** All operators including pipes — used for policy scanning of every segment. */
export const ALL_SPLIT_OPS = new Set(["&&", "||", ";", "&", "|"]);

/**
 * Split a shell command on operators while respecting quoting and comments.
 *
 * For rule matching, pass `COMMAND_SPLIT_OPS` so pipelines stay attached to the
 * command they transform. For policy scanning, use `ALL_SPLIT_OPS` so every
 * independently executed segment is inspected.
 */
export function splitShellCommand(command: string, splitOps = ALL_SPLIT_OPS): string[] {
  let tokens: ReturnType<typeof parse>;
  try {
    tokens = parse(command);
  } catch {
    return [command.trim()].filter(Boolean);
  }

  const parts: string[] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (typeof token === "string") {
      current.push(token);
      continue;
    }
    if (!token || typeof token !== "object") continue;
    if ("op" in token && splitOps.has(token.op)) {
      if (current.length > 0) {
        parts.push(current.join(" "));
        current = [];
      }
      continue;
    }
    if ("op" in token) {
      current.push(token.op);
      continue;
    }
    if ("comment" in token) {
      continue;
    }
    if ("pattern" in token) {
      current.push(String(token.pattern));
    }
  }

  if (current.length > 0) {
    parts.push(current.join(" "));
  }

  return parts;
}
