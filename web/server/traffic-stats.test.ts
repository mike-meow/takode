import { describe, expect, it } from "vitest";
import { TrafficStatsCollector, getTrafficMessageType } from "./traffic-stats.js";

describe("getTrafficMessageType", () => {
  it("prefers type + subtype when both are present", () => {
    expect(getTrafficMessageType({ type: "system", subtype: "init" })).toBe("system.init");
  });

  it("uses JSON-RPC methods when present", () => {
    expect(getTrafficMessageType({ jsonrpc: "2.0", method: "turn/completed", params: {} })).toBe(
      "method:turn/completed",
    );
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
        bucket.channel === "browser" && bucket.direction === "out" && bucket.messageType === "message_history",
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
    expect(snapshot.historySyncBreakdown).toEqual({
      totals: {
        requests: 0,
        frozenDeltaBytes: 0,
        hotMessagesBytes: 0,
        frozenDeltaMessages: 0,
        hotMessagesCount: 0,
      },
      sessions: {},
    });
    expect(snapshot.toolResultFetches).toEqual({
      totals: { requests: 0, repeatedRequests: 0, payloadBytes: 0, errorRequests: 0 },
      sessions: {},
      topRepeated: [],
    });
  });

  it("tracks history_sync frozen delta and hot tail bytes separately", () => {
    const stats = new TrafficStatsCollector();

    stats.recordHistorySyncBreakdown({
      sessionId: "s1",
      frozenDeltaBytes: 1000,
      hotMessagesBytes: 250,
      frozenDeltaMessages: 12,
      hotMessagesCount: 3,
    });
    stats.recordHistorySyncBreakdown({
      sessionId: "s1",
      frozenDeltaBytes: 150,
      hotMessagesBytes: 400,
      frozenDeltaMessages: 2,
      hotMessagesCount: 5,
    });

    const snapshot = stats.snapshot();
    expect(snapshot.historySyncBreakdown).toEqual({
      totals: {
        requests: 2,
        frozenDeltaBytes: 1150,
        hotMessagesBytes: 650,
        frozenDeltaMessages: 14,
        hotMessagesCount: 8,
      },
      sessions: {
        s1: {
          requests: 2,
          frozenDeltaBytes: 1150,
          hotMessagesBytes: 650,
          frozenDeltaMessages: 14,
          hotMessagesCount: 8,
        },
      },
    });
  });

  it("tracks tool result fetch bytes and repeated downloads per tool", () => {
    const stats = new TrafficStatsCollector();

    stats.recordToolResultFetch({
      sessionId: "s1",
      toolUseId: "tu-1",
      payloadBytes: 1200,
      isError: false,
    });
    stats.recordToolResultFetch({
      sessionId: "s1",
      toolUseId: "tu-1",
      payloadBytes: 1200,
      isError: false,
    });
    stats.recordToolResultFetch({
      sessionId: "s1",
      toolUseId: "tu-2",
      payloadBytes: 300,
      isError: true,
    });

    const snapshot = stats.snapshot();
    expect(snapshot.toolResultFetches.totals).toEqual({
      requests: 3,
      repeatedRequests: 1,
      payloadBytes: 2700,
      errorRequests: 1,
    });
    expect(snapshot.toolResultFetches.sessions.s1).toMatchObject({
      requests: 3,
      repeatedRequests: 1,
      payloadBytes: 2700,
      errorRequests: 1,
    });
    expect(snapshot.toolResultFetches.sessions.s1?.tools).toEqual([
      {
        sessionId: "s1",
        toolUseId: "tu-1",
        requests: 2,
        repeatedRequests: 1,
        payloadBytes: 2400,
        errorRequests: 0,
        lastFetchedAt: expect.any(Number),
        maxPayloadBytes: 1200,
      },
      {
        sessionId: "s1",
        toolUseId: "tu-2",
        requests: 1,
        repeatedRequests: 0,
        payloadBytes: 300,
        errorRequests: 1,
        lastFetchedAt: expect.any(Number),
        maxPayloadBytes: 300,
      },
    ]);
    expect(snapshot.toolResultFetches.topRepeated[0]).toMatchObject({
      sessionId: "s1",
      toolUseId: "tu-1",
      repeatedRequests: 1,
      payloadBytes: 2400,
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
      historySyncBreakdown: {
        totals: {
          requests: 0,
          frozenDeltaBytes: 0,
          hotMessagesBytes: 0,
          frozenDeltaMessages: 0,
          hotMessagesCount: 0,
        },
        sessions: {},
      },
      toolResultFetches: {
        totals: { requests: 0, repeatedRequests: 0, payloadBytes: 0, errorRequests: 0 },
        sessions: {},
        topRepeated: [],
      },
    });
    expect(stats.snapshot().windowStartedAt).toBeGreaterThanOrEqual(firstWindowStartedAt);
  });
});
