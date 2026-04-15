import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import {
  parseLogLevels,
  parseLogTime,
  splitCsvParam,
  type LogQuery,
  type LogQueryResponse,
  type ServerLogEntry,
} from "../../shared/logging.js";
import { queryServerLogs, subscribeToServerLogs } from "../server-logger.js";
import { COMPANION_CLIENT_IP_HEADER, isLoopbackAddress } from "./auth.js";
import type { RouteContext } from "./context.js";

type ValidatedLogQuery = LogQuery & { _compiledPattern?: RegExp };

function parseLimit(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseLogQueryFromRequest(c: import("hono").Context): LogQuery {
  const level = parseLogLevels(c.req.query("level"));
  const components = splitCsvParam(c.req.query("component"));
  return {
    levels: level.length > 0 ? level : undefined,
    components: components.length > 0 ? components : undefined,
    sessionId: c.req.query("session") || undefined,
    pattern: c.req.query("pattern") || undefined,
    regex: c.req.query("regex") === "1" || c.req.query("regex") === "true",
    since: parseLogTime(c.req.query("since")),
    until: parseLogTime(c.req.query("until")),
    limit: parseLimit(c.req.query("limit")),
  };
}

function validateLogQuery(c: import("hono").Context): ValidatedLogQuery | Response {
  const query = parseLogQueryFromRequest(c) as ValidatedLogQuery;
  if (query.regex && query.pattern) {
    try {
      query._compiledPattern = new RegExp(query.pattern, "i");
    } catch {
      return c.json({ error: `Invalid log regex: ${query.pattern}` }, 400);
    }
  }
  return query;
}

function requireLogsAccess(c: import("hono").Context, ctx: RouteContext): Response | null {
  const auth = ctx.authenticateCompanionCallerOptional(c);
  if (auth && "response" in auth) return auth.response;
  if (auth) return null;

  const clientIp = c.req.header(COMPANION_CLIENT_IP_HEADER);
  if (isLoopbackAddress(clientIp)) return null;
  return c.json({ error: "Logs require Companion auth or loopback access" }, 403);
}

async function writeEntry(stream: SSEStreamingApi, entry: ServerLogEntry): Promise<void> {
  await stream.writeSSE({
    event: "entry",
    data: JSON.stringify(entry),
  });
}

function entryKey(entry: ServerLogEntry): string {
  return `${entry.pid}:${entry.seq}`;
}

async function writeBufferedEntries(
  stream: SSEStreamingApi,
  bufferedEntries: ServerLogEntry[],
  seenKeys: Set<string>,
): Promise<void> {
  for (const entry of bufferedEntries) {
    const key = entryKey(entry);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    await writeEntry(stream, entry);
  }
}

export function createLogsRoutes(ctx: RouteContext) {
  const api = new Hono();

  api.get("/logs", async (c) => {
    const accessError = requireLogsAccess(c, ctx);
    if (accessError) return accessError;

    const validated = validateLogQuery(c);
    if (validated instanceof Response) return validated;
    return c.json(await queryServerLogs(validated));
  });

  api.get("/logs/stream", (c) => {
    const accessError = requireLogsAccess(c, ctx);
    if (accessError) return accessError;

    const validated = validateLogQuery(c);
    if (validated instanceof Response) return validated;

    const query = validated;
    const tail = parseLimit(c.req.query("tail"));

    return streamSSE(c, async (stream) => {
      const abortSignal = c.req.raw.signal;
      let closed = false;
      let ping: ReturnType<typeof setInterval> | null = null;
      const liveBuffer: ServerLogEntry[] = [];

      let unsubscribe = () => {};
      const teardown = () => {
        if (closed) return;
        closed = true;
        if (ping) {
          clearInterval(ping);
          ping = null;
        }
        unsubscribe();
      };

      try {
        let buffering = true;
        unsubscribe = subscribeToServerLogs(query, (entry) => {
          if (closed) return;
          if (buffering) {
            liveBuffer.push(entry);
            return;
          }
          void writeEntry(stream, entry).catch(() => {
            teardown();
          });
        });

        const initial: LogQueryResponse = tail ? await queryServerLogs({ ...query, limit: tail }) : await queryServerLogs(query);
        const seenKeys = new Set<string>();

        if (tail) {
          for (const entry of initial.entries) {
            seenKeys.add(entryKey(entry));
            await writeEntry(stream, entry);
          }
        }

        while (liveBuffer.length > 0) {
          const bufferedEntries = liveBuffer.splice(0, liveBuffer.length);
          await writeBufferedEntries(stream, bufferedEntries, seenKeys);
        }

        buffering = false;

        await stream.writeSSE({
          event: "ready",
          data: JSON.stringify({
            ok: true,
            availableComponents: initial.availableComponents,
            logFile: initial.logFile,
          }),
        });

        ping = setInterval(() => {
          if (closed) return;
          void stream
            .writeSSE({
              event: "ping",
              data: JSON.stringify({ ts: Date.now() }),
            })
            .catch(() => {
              teardown();
            });
        }, 15_000);

        await new Promise<void>((resolve) => {
          const onAbort = () => {
            teardown();
            resolve();
          };
          abortSignal.addEventListener("abort", onAbort, { once: true });
        });
      } finally {
        teardown();
      }
    });
  });

  return api;
}
