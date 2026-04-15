export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogQuery {
  levels?: LogLevel[];
  components?: string[];
  sessionId?: string;
  pattern?: string;
  regex?: boolean;
  since?: number;
  until?: number;
  limit?: number;
}

export interface ServerLogEntry {
  ts: number;
  isoTime: string;
  level: LogLevel;
  component: string;
  message: string;
  sessionId?: string | null;
  source?: string | null;
  meta?: Record<string, unknown>;
  pid: number;
  seq: number;
}

export interface LogQueryResponse {
  entries: ServerLogEntry[];
  availableComponents: string[];
  logFile: string | null;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export function normalizeLogLevel(value: unknown): LogLevel | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isLogLevel(normalized) ? normalized : null;
}

export function splitCsvParam(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseLogLevels(value: string | null | undefined): LogLevel[] {
  return splitCsvParam(value)
    .map((part) => normalizeLogLevel(part))
    .filter((level): level is LogLevel => level !== null);
}

const RELATIVE_TIME_RE = /^(\d+)(ms|s|m|h|d)$/i;

export function parseLogTime(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    return trimmed.length <= 10 ? parsed * 1000 : parsed;
  }

  const relativeMatch = trimmed.match(RELATIVE_TIME_RE);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const unitMs =
      unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return now - amount * unitMs;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function encodeLogQuery(query: LogQuery & { tail?: number }): string {
  const params = new URLSearchParams();
  if (query.levels?.length) params.set("level", query.levels.join(","));
  if (query.components?.length) params.set("component", query.components.join(","));
  if (query.sessionId) params.set("session", query.sessionId);
  if (query.pattern) params.set("pattern", query.pattern);
  if (query.regex) params.set("regex", "1");
  if (typeof query.since === "number") params.set("since", String(query.since));
  if (typeof query.until === "number") params.set("until", String(query.until));
  if (typeof query.limit === "number") params.set("limit", String(query.limit));
  if (typeof query.tail === "number") params.set("tail", String(query.tail));
  return params.toString();
}
