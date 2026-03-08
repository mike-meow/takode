import { describe, expect, it } from "vitest";
import {
  TrafficStatsCollector,
  getTrafficMessageType,
} from "./traffic-stats.js";

describe("getTrafficMessageType", () => {
  it("prefers type + subtype when both are present", () => {
    expect(getTrafficMessageType({ type: "system", subtype: "init" })).toBe("system.init");
  });

  it("uses JSON-RPC methods when present", () => {
    expect(getTrafficMessageType({ jsonrpc: "2.0", method: "turn/completed", params: {} })).toBe("method:turn/completed");
  });

  it("classifies JSON-RPC responses separately", () => {
    expect(getTrafficMessageType({ jsonrpc: "2.0", id: 7, result: {} })).toBe("jsonrpc_response");
  });
});

describe("TrafficStatsCollector", () => {
  it("aggregates totals, fanout, and per-session buckets", () => {
    const stats = new TrafficStatsCollector();

    stats.record({
      sessionId: "s1",
      channel: "browser",
      direction: "out",
      messageType: "message_history",
      payloadBytes: 100,
      fanout: 3,
    });
    stats.record({
      sessionId: "s1",
      channel: "cli",
      direction: "in",
      messageType: "system.init",
      payloadBytes: 40,
    });
    stats.record({
      sessionId: "s2",
      channel: "browser",
      direction: "out",
      messageType: "message_history",
      payloadBytes: 25,
      fanout: 1,
    });

    const snapshot = stats.snapshot();
    expect(snapshot.capturedAt).toBeGreaterThanOrEqual(snapshot.windowStartedAt);
    expect(snapshot.totals).toEqual({
      messages: 3,
      payloadBytes: 165,
      wireBytes: 365,
    });

    const historyBucket = snapshot.buckets.find(
      (bucket) =>
        bucket.channel === "browser"
        && bucket.direction === "out"
        && bucket.messageType === "message_history",
    );
    expect(historyBucket).toMatchObject({
      messages: 2,
      payloadBytes: 125,
      wireBytes: 325,
      fanoutSum: 4,
      maxFanout: 3,
    });

    expect(snapshot.sessions.s1?.totals).toEqual({
      messages: 2,
      payloadBytes: 140,
      wireBytes: 340,
    });
    expect(snapshot.sessions.s2?.totals).toEqual({
      messages: 1,
      payloadBytes: 25,
      wireBytes: 25,
    });
  });

  it("resets back to an empty snapshot", () => {
    const stats = new TrafficStatsCollector();
    const firstWindowStartedAt = stats.snapshot().windowStartedAt;
    stats.record({
      sessionId: "s1",
      channel: "browser",
      direction: "in",
      messageType: "session_subscribe",
      payloadBytes: 12,
    });

    stats.reset();

    expect(stats.snapshot()).toEqual({
      windowStartedAt: expect.any(Number),
      capturedAt: expect.any(Number),
      totals: { messages: 0, payloadBytes: 0, wireBytes: 0 },
      buckets: [],
      sessions: {},
    });
    expect(stats.snapshot().windowStartedAt).toBeGreaterThanOrEqual(firstWindowStartedAt);
  });
});
