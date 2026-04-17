import { mkdirSync } from "node:fs"; // sync-ok: cold path, once at startup
import { appendFile, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  LOG_LEVELS,
  type LogLevel,
  type LogQuery,
  type LogQueryResponse,
  type ServerLogEntry,
} from "../shared/logging.js";

const DEFAULT_MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_ROTATION_COUNT = 3;
const FLUSH_INTERVAL_MS = 200;
const DEFAULT_COMPONENT = "console";
const LOG_PREFIX_RE = /^\[([^\]]+)\]\s*/;
const COLOR_RESET = "\x1b[0m";
const COLOR_DIM = "\x1b[2m";
const COLOR_GRAY = "\x1b[90m";
const COLOR_YELLOW = "\x1b[33m";
const COLOR_RED = "\x1b[31m";

type LogSink = (entry: ServerLogEntry) => void;

interface LoggerOptions {
  baseMeta?: Record<string, unknown>;
}

interface InitLoggerOptions {
  logDir?: string;
  captureConsole?: boolean;
  maxLogSize?: number;
  rotationCount?: number;
}

interface LogSubscriber {
  query: LogQuery;
  sink: LogSink;
}

interface InternalLogQuery extends LogQuery {
  _compiledPattern?: RegExp;
}

const originalConsole = {
  log: console.log.bind(console),
  info: (console.info ?? console.log).bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: (console.debug ?? console.log).bind(console),
};

let logPath: string | null = null;
let logDirPath: string | null = null;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let consoleCaptureInstalled = false;
let maxLogSize = DEFAULT_MAX_LOG_SIZE;
let rotationCount = DEFAULT_ROTATION_COUNT;
let sequence = 0;
let nextSubscriberId = 1;
const subscribers = new Map<number, LogSubscriber>();

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.message;
  try {
    return JSON.stringify(serializeValue(a));
  } catch {
    return String(a);
  }
}

function scheduleFlush(): void {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function rotateLogFiles(currentLogPath: string): Promise<void> {
  const oldest = `${currentLogPath}.${rotationCount}`;
  if (await fileExists(oldest)) {
    await unlink(oldest).catch(() => {});
  }

  for (let i = rotationCount - 1; i >= 1; i -= 1) {
    const src = `${currentLogPath}.${i}`;
    const dest = `${currentLogPath}.${i + 1}`;
    if (await fileExists(src)) {
      await rename(src, dest).catch(() => {});
    }
  }

  if (await fileExists(currentLogPath)) {
    await rename(currentLogPath, `${currentLogPath}.1`).catch(() => {});
  }
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (flushing || buffer.length === 0 || !logPath) return;
  flushing = true;
  const currentLogPath = logPath;
  const data = buffer.join("");
  buffer = [];
  try {
    await appendFile(currentLogPath, data);
    const currentStat = await stat(currentLogPath).catch(() => null);
    if (currentStat && currentStat.size > maxLogSize) {
      await rotateLogFiles(currentLogPath);
    }
  } catch {
    // Disk availability should never crash the server.
  }
  flushing = false;
  if (buffer.length > 0) scheduleFlush();
}

function getOutputThreshold(): LogLevel {
  const env = (process.env.LOG_LEVEL || "").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(env) ? (env as LogLevel) : "info";
}

function levelRank(level: LogLevel): number {
  switch (level) {
    case "debug":
      return 10;
    case "info":
      return 20;
    case "warn":
      return 30;
    case "error":
      return 40;
  }
}

function shouldPrintToTerminal(level: LogLevel): boolean {
  return levelRank(level) >= levelRank(getOutputThreshold());
}

function serializeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Error) {
    const errorRecord: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    if ("cause" in value && value.cause !== undefined) {
      errorRecord.cause = serializeValue(value.cause, seen);
    }
    for (const key of Object.keys(value)) {
      if (!(key in errorRecord)) {
        errorRecord[key] = serializeValue((value as unknown as Record<string, unknown>)[key], seen);
      }
    }
    return errorRecord;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map((item) => serializeValue(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = serializeValue(child, seen);
    }
    return out;
  }

  return String(value);
}

function normalizeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const entries = Object.entries(meta).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([key, value]) => [key, serializeValue(value)]));
}

function extractSessionId(meta: Record<string, unknown> | undefined): string | null {
  const raw = meta?.sessionId;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function extractSource(meta: Record<string, unknown> | undefined): string | null {
  const raw = meta?.source;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function colorForLevel(level: LogLevel): string {
  switch (level) {
    case "debug":
      return COLOR_GRAY;
    case "info":
      return "";
    case "warn":
      return COLOR_YELLOW;
    case "error":
      return COLOR_RED;
  }
}

function terminalLine(entry: ServerLogEntry): string {
  const time = entry.isoTime.slice(11, 23);
  const levelLabel = entry.level.toUpperCase().padEnd(5);
  const component = entry.component.slice(0, 18).padEnd(18);
  const trailingParts: string[] = [];
  if (entry.sessionId) trailingParts.push(`session=${entry.sessionId}`);
  if (entry.source) trailingParts.push(`source=${entry.source}`);
  if (entry.meta && Object.keys(entry.meta).length > 0) trailingParts.push(JSON.stringify(entry.meta));
  const trail = trailingParts.length > 0 ? ` ${COLOR_DIM}${trailingParts.join(" ")}${COLOR_RESET}` : "";
  const levelColor = colorForLevel(entry.level);
  const levelPrefix = levelColor ? `${levelColor}${levelLabel}${COLOR_RESET}` : levelLabel;
  const componentLabel = `${COLOR_DIM}${component}${COLOR_RESET}`;
  return `${time} ${levelPrefix} ${componentLabel} ${entry.message}${trail}`;
}

function printTerminalEntry(entry: ServerLogEntry): void {
  if (!shouldPrintToTerminal(entry.level)) return;
  const line = terminalLine(entry);
  if (entry.level === "error") {
    originalConsole.error(line);
  } else if (entry.level === "warn") {
    originalConsole.warn(line);
  } else if (entry.level === "debug") {
    originalConsole.debug(line);
  } else {
    originalConsole.log(line);
  }
}

function matchesPattern(entry: ServerLogEntry, query: InternalLogQuery): boolean {
  if (!query.pattern) return true;
  const haystack = [
    entry.message,
    entry.component,
    entry.sessionId || "",
    entry.source || "",
    entry.meta ? JSON.stringify(entry.meta) : "",
  ].join("\n");

  if (query.regex) {
    return !!query._compiledPattern?.test(haystack);
  }

  return haystack.toLowerCase().includes(query.pattern.toLowerCase());
}

function matchesQuery(entry: ServerLogEntry, query: InternalLogQuery): boolean {
  if (query.levels?.length && !query.levels.includes(entry.level)) return false;
  if (query.components?.length && !query.components.includes(entry.component)) return false;
  if (query.sessionId && entry.sessionId !== query.sessionId) return false;
  if (typeof query.since === "number" && entry.ts < query.since) return false;
  if (typeof query.until === "number" && entry.ts > query.until) return false;
  return matchesPattern(entry, query);
}

function prepareQuery(query: LogQuery): InternalLogQuery {
  const internal = query as InternalLogQuery;
  if (internal.regex && internal.pattern && !internal._compiledPattern) {
    internal._compiledPattern = new RegExp(internal.pattern, "i");
  }
  return internal;
}

function emitToSubscribers(entry: ServerLogEntry): void {
  for (const subscriber of subscribers.values()) {
    if (!matchesQuery(entry, subscriber.query)) continue;
    try {
      subscriber.sink(entry);
    } catch {
      // Streaming consumers should not interfere with logging.
    }
  }
}

function queueEntry(entry: ServerLogEntry): void {
  if (logPath) {
    buffer.push(`${JSON.stringify(entry)}\n`);
    scheduleFlush();
  }
  printTerminalEntry(entry);
  emitToSubscribers(entry);
}

function buildEntry(
  level: LogLevel,
  component: string,
  message: string,
  meta?: Record<string, unknown>,
): ServerLogEntry {
  const normalizedMeta = normalizeMeta(meta);
  const sessionId = extractSessionId(normalizedMeta);
  const source = extractSource(normalizedMeta);
  const entryMeta =
    normalizedMeta && Object.keys(normalizedMeta).length > 0
      ? Object.fromEntries(Object.entries(normalizedMeta).filter(([key]) => key !== "sessionId" && key !== "source"))
      : undefined;
  const ts = Date.now();
  return {
    ts,
    isoTime: new Date(ts).toISOString(),
    level,
    component: component.trim() || DEFAULT_COMPONENT,
    message,
    sessionId,
    source,
    meta: entryMeta && Object.keys(entryMeta).length > 0 ? entryMeta : undefined,
    pid: process.pid,
    seq: ++sequence,
  };
}

function parseLegacyConsoleArgs(args: unknown[]): {
  component: string;
  message: string;
  meta?: Record<string, unknown>;
} {
  if (args.length === 0) {
    return { component: DEFAULT_COMPONENT, message: "" };
  }

  const [first, ...rest] = args;
  let component = DEFAULT_COMPONENT;
  let firstText = formatArg(first);

  if (typeof first === "string") {
    const match = first.match(LOG_PREFIX_RE);
    if (match) {
      component = match[1].trim() || DEFAULT_COMPONENT;
      firstText = first.replace(LOG_PREFIX_RE, "").trim();
    }
  }

  const remainderText = rest
    .map((arg) => formatArg(arg))
    .filter(Boolean)
    .join(" ")
    .trim();
  const message = [firstText, remainderText].filter(Boolean).join(" ").trim();
  const extraArgs = rest.filter((arg) => typeof arg !== "string");
  const meta =
    extraArgs.length > 0
      ? {
          legacyArgs: extraArgs.map((arg) => serializeValue(arg)),
        }
      : undefined;

  return {
    component,
    message: message || formatArg(first),
    meta,
  };
}

function captureLegacyConsole(level: LogLevel, args: unknown[]): void {
  const parsed = parseLegacyConsoleArgs(args);
  queueEntry(buildEntry(level, parsed.component, parsed.message, parsed.meta));
}

function installConsoleCapture(): void {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;
  console.log = (...args: unknown[]) => captureLegacyConsole("info", args);
  console.info = (...args: unknown[]) => captureLegacyConsole("info", args);
  console.warn = (...args: unknown[]) => captureLegacyConsole("warn", args);
  console.error = (...args: unknown[]) => captureLegacyConsole("error", args);
  console.debug = (...args: unknown[]) => captureLegacyConsole("debug", args);
}

function restoreConsoleCapture(): void {
  if (!consoleCaptureInstalled) return;
  consoleCaptureInstalled = false;
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
}

async function readLogFileEntries(path: string): Promise<ServerLogEntry[]> {
  try {
    const raw = await readFile(path, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Partial<ServerLogEntry>;
          if (
            typeof parsed.ts === "number" &&
            typeof parsed.isoTime === "string" &&
            typeof parsed.level === "string" &&
            typeof parsed.component === "string" &&
            typeof parsed.message === "string" &&
            typeof parsed.pid === "number" &&
            typeof parsed.seq === "number"
          ) {
            return [parsed as ServerLogEntry];
          }
        } catch {
          // Ignore malformed historical lines.
        }
        return [];
      });
  } catch {
    return [];
  }
}

async function readAllEntries(): Promise<ServerLogEntry[]> {
  if (!logPath) return [];
  const paths: string[] = [];
  for (let i = rotationCount; i >= 1; i -= 1) {
    paths.push(`${logPath}.${i}`);
  }
  paths.push(logPath);

  const all: ServerLogEntry[] = [];
  for (const path of paths) {
    const entries = await readLogFileEntries(path);
    all.push(...entries);
  }
  return all.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts - b.ts));
}

export function initServerLogger(port: number, options: InitLoggerOptions = {}): void {
  const configuredLogDir = options.logDir || join(homedir(), ".companion", "logs");
  mkdirSync(configuredLogDir, { recursive: true }); // sync-ok: cold path, once at startup
  logDirPath = configuredLogDir;
  logPath = join(configuredLogDir, `server-${port}.jsonl`);
  maxLogSize = options.maxLogSize ?? DEFAULT_MAX_LOG_SIZE;
  rotationCount = options.rotationCount ?? DEFAULT_ROTATION_COUNT;
  sequence = 0;
  if (options.captureConsole !== false) {
    installConsoleCapture();
  }
}

export async function flushServerLogger(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}

export function getLogPath(): string | null {
  return logPath;
}

export function getLogDirectory(): string | null {
  return logDirPath;
}

export function createLogger(component: string, options: LoggerOptions = {}) {
  const logAt = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    const mergedMeta = options.baseMeta || meta ? { ...(options.baseMeta || {}), ...(meta || {}) } : undefined;
    queueEntry(buildEntry(level, component, message, mergedMeta));
  };

  return {
    component,
    child(childComponent: string, childOptions: LoggerOptions = {}) {
      const nextComponent = childComponent.includes("/") ? childComponent : `${component}/${childComponent}`;
      return createLogger(nextComponent, {
        baseMeta: { ...(options.baseMeta || {}), ...(childOptions.baseMeta || {}) },
      });
    },
    debug(message: string, meta?: Record<string, unknown>) {
      logAt("debug", message, meta);
    },
    info(message: string, meta?: Record<string, unknown>) {
      logAt("info", message, meta);
    },
    warn(message: string, meta?: Record<string, unknown>) {
      logAt("warn", message, meta);
    },
    error(message: string, meta?: Record<string, unknown>) {
      logAt("error", message, meta);
    },
  };
}

export async function queryServerLogs(query: LogQuery = {}): Promise<LogQueryResponse> {
  await flushServerLogger();
  const preparedQuery = prepareQuery(query);
  const allEntries = await readAllEntries();
  const availableComponents = [...new Set(allEntries.map((entry) => entry.component))].sort((a, b) =>
    a.localeCompare(b),
  );
  const filtered = allEntries.filter((entry) => matchesQuery(entry, preparedQuery));
  const limited =
    typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
      ? filtered.slice(-query.limit)
      : filtered;

  return {
    entries: limited,
    availableComponents,
    logFile: logPath,
  };
}

export function subscribeToServerLogs(query: LogQuery, sink: LogSink): () => void {
  const id = nextSubscriberId++;
  subscribers.set(id, { query: prepareQuery(query), sink });
  return () => {
    subscribers.delete(id);
  };
}

export function _resetServerLoggerForTest(): void {
  restoreConsoleCapture();
  logPath = null;
  logDirPath = null;
  buffer = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushing = false;
  subscribers.clear();
  sequence = 0;
  nextSubscriberId = 1;
  maxLogSize = DEFAULT_MAX_LOG_SIZE;
  rotationCount = DEFAULT_ROTATION_COUNT;
}
