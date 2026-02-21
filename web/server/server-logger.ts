/**
 * File-based server logging.
 *
 * Tees all console.log/warn/error output to a persistent log file at
 * ~/.companion/logs/server-{port}.log so that agents and humans can
 * inspect server logs after the fact (instead of only having tmux scrollback).
 *
 * Call `initServerLogger(port)` once, early in server startup.
 * No other code changes are needed — existing console.* calls are
 * automatically captured.
 */

import { mkdirSync, appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const ROTATION_CHECK_INTERVAL_MS = 60_000; // 1 minute

let logPath: string | null = null;

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function writeToFile(level: string, args: unknown[]) {
  if (!logPath) return;
  const ts = new Date().toISOString();
  const msg = args.map(formatArg).join(" ");
  const line = `[${ts}] [${level}] ${msg}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    // Silently ignore write errors (disk full, etc.)
  }
}

export function initServerLogger(port: number): void {
  const logDir = join(homedir(), ".companion", "logs");
  mkdirSync(logDir, { recursive: true });
  logPath = join(logDir, `server-${port}.log`);

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeToFile("info", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeToFile("warn", args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    writeToFile("error", args);
  };

  // Periodic rotation: rename to .log.1 when file exceeds MAX_LOG_SIZE
  setInterval(() => {
    if (!logPath) return;
    try {
      const stat = statSync(logPath);
      if (stat.size > MAX_LOG_SIZE) {
        renameSync(logPath, logPath + ".1");
      }
    } catch {
      // File may not exist yet
    }
  }, ROTATION_CHECK_INTERVAL_MS);
}

/** Returns the current log file path (null if logger not initialized). */
export function getLogPath(): string | null {
  return logPath;
}
