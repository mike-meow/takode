/**
 * File-based server logging.
 *
 * Tees all console.log/warn/error output to a persistent log file at
 * ~/.companion/logs/server-{port}.log so that agents and humans can
 * inspect server logs after the fact (instead of only having tmux scrollback).
 *
 * Log lines are buffered in memory and flushed to disk asynchronously every
 * FLUSH_INTERVAL_MS (200ms) to avoid blocking the event loop on NFS.
 *
 * Call `initServerLogger(port)` once, early in server startup.
 * No other code changes are needed — existing console.* calls are
 * automatically captured.
 */

import { mkdirSync } from "node:fs"; // sync-ok: cold path, once at startup
import { appendFile, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const ROTATION_CHECK_INTERVAL_MS = 60_000; // 1 minute
const FLUSH_INTERVAL_MS = 200;

let logPath: string | null = null;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function scheduleFlush(): void {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (flushing || buffer.length === 0 || !logPath) return;
  flushing = true;
  const data = buffer.join("");
  buffer = [];
  try {
    await appendFile(logPath, data);
  } catch {
    // Silently ignore write errors (disk full, NFS unavailable, etc.)
  }
  flushing = false;
  // More lines may have arrived while we were flushing
  if (buffer.length > 0) scheduleFlush();
}

function writeToFile(level: string, args: unknown[]): void {
  if (!logPath) return;
  const ts = new Date().toISOString();
  const msg = args.map(formatArg).join(" ");
  buffer.push(`[${ts}] [${level}] ${msg}\n`);
  scheduleFlush();
}

export function initServerLogger(port: number): void {
  const logDir = join(homedir(), ".companion", "logs");
  mkdirSync(logDir, { recursive: true }); // sync-ok: cold path, once at startup
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
  setInterval(async () => {
    if (!logPath) return;
    try {
      const s = await stat(logPath);
      if (s.size > MAX_LOG_SIZE) {
        await rename(logPath, logPath + ".1");
      }
    } catch {
      // File may not exist yet
    }
  }, ROTATION_CHECK_INTERVAL_MS);
}

/** Flush any buffered log lines to disk. Call during graceful shutdown. */
export async function flushServerLogger(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}

/** Returns the current log file path (null if logger not initialized). */
export function getLogPath(): string | null {
  return logPath;
}
