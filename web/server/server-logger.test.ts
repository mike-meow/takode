import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetServerLoggerForTest,
  createLogger,
  initServerLogger,
  queryServerLogs,
  subscribeToServerLogs,
} from "./server-logger.js";

describe("server-logger", () => {
  let logDir: string;

  beforeEach(async () => {
    _resetServerLoggerForTest();
    logDir = await mkdtemp(join(tmpdir(), "takode-logs-"));
  });

  afterEach(async () => {
    _resetServerLoggerForTest();
    await rm(logDir, { recursive: true, force: true });
  });

  it("writes structured log entries and filters them by query", async () => {
    // Validates the shared log entry shape and basic server-side filtering.
    initServerLogger(3456, { logDir, captureConsole: false });
    const logger = createLogger("ws-bridge");

    logger.info("Generation started", { sessionId: "session-1", detail: { turn: 3 } });
    logger.warn("Permission required", { sessionId: "session-2" });

    const result = await queryServerLogs({
      components: ["ws-bridge"],
      levels: ["info"],
      sessionId: "session-1",
    });

    expect(result.availableComponents).toEqual(["ws-bridge"]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      level: "info",
      component: "ws-bridge",
      message: "Generation started",
      sessionId: "session-1",
      meta: {
        detail: { turn: 3 },
      },
    });
  });

  it("streams live entries to subscribers", async () => {
    // Ensures subscriber filtering matches the historical query path for live fanout.
    initServerLogger(3456, { logDir, captureConsole: false });
    const logger = createLogger("server");
    const received: string[] = [];
    const unsubscribe = subscribeToServerLogs({ levels: ["error"] }, (entry) => {
      received.push(entry.message);
    });

    logger.info("Ignored");
    logger.error("Captured");
    unsubscribe();
    logger.error("Not captured");

    expect(received).toEqual(["Captured"]);
  });

  it("rotates JSONL log files when they exceed the max size", async () => {
    // Confirms rotation happens on the hot write path without requiring a periodic timer.
    initServerLogger(3456, {
      logDir,
      captureConsole: false,
      maxLogSize: 250,
      rotationCount: 2,
    });
    const logger = createLogger("rotation");

    for (let i = 0; i < 20; i += 1) {
      logger.info(`entry-${i}`, { payload: "x".repeat(80) });
    }

    await queryServerLogs();
    const files = await readdir(logDir);

    expect(files.some((file) => file.endsWith(".jsonl.1"))).toBe(true);
  });

  it("captures legacy console logs with component prefixes and serialized errors", async () => {
    // Production still relies on console interception for most runtime paths, so verify that
    // prefixed console output is ingested into structured logs with nested Error causes preserved.
    initServerLogger(3456, { logDir });

    const rootCause = new Error("inner failure");
    const error = new Error("outer failure", { cause: rootCause });
    console.error("[ws-bridge] reconnect failed", error);

    const result = await queryServerLogs({ levels: ["error"] });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      component: "ws-bridge",
      message: "reconnect failed outer failure",
      meta: {
        legacyArgs: [
          {
            message: "outer failure",
            cause: {
              message: "inner failure",
            },
          },
        ],
      },
    });
  });
});
