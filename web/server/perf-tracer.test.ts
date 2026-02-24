import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PerfTracer, RingBuffer } from "./perf-tracer.js";

// ─── RingBuffer ──────────────────────────────────────────────────────────────

describe("RingBuffer", () => {
  it("stores items up to capacity", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.toArray()).toEqual([1, 2, 3]);
    expect(buf.count).toBe(3);
  });

  it("overwrites oldest when full", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // overwrites 1
    expect(buf.toArray()).toEqual([2, 3, 4]);
    expect(buf.count).toBe(3);
  });

  it("recent() returns newest first", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(10);
    buf.push(20);
    buf.push(30);
    expect(buf.recent(2)).toEqual([30, 20]);
  });

  it("clear() resets the buffer", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.toArray()).toEqual([]);
    expect(buf.count).toBe(0);
  });

  it("handles empty buffer gracefully", () => {
    const buf = new RingBuffer<number>(3);
    expect(buf.toArray()).toEqual([]);
    expect(buf.recent(5)).toEqual([]);
    expect(buf.count).toBe(0);
  });

  it("wraps around multiple times", () => {
    const buf = new RingBuffer<number>(2);
    for (let i = 1; i <= 10; i++) buf.push(i);
    // Should contain the last 2 items
    expect(buf.toArray()).toEqual([9, 10]);
  });
});

// ─── PerfTracer ──────────────────────────────────────────────────────────────

describe("PerfTracer", () => {
  let tracer: PerfTracer;

  beforeEach(() => {
    tracer = new PerfTracer({ lagThresholdMs: 10, httpSlowThresholdMs: 5, wsSlowThresholdMs: 5 });
  });

  afterEach(() => {
    tracer.stop();
  });

  it("records event loop lag events", () => {
    tracer.recordEventLoopLag(120);
    tracer.recordEventLoopLag(80);

    const events = tracer.getLagEvents();
    expect(events).toHaveLength(2);
    expect(events[0].lagMs).toBe(80);  // newest first
    expect(events[1].lagMs).toBe(120);
  });

  it("records slow HTTP requests", () => {
    tracer.recordSlowRequest("GET", "/api/fs/read", 1500);
    tracer.recordSlowRequest("GET", "/api/health", 200);

    const events = tracer.getSlowRequests();
    expect(events).toHaveLength(2);
    expect(events[0].path).toBe("/api/health"); // newest first
    expect(events[0].ms).toBe(200);
    expect(events[1].path).toBe("/api/fs/read");
    expect(events[1].ms).toBe(1500);
  });

  it("records slow WebSocket messages", () => {
    tracer.recordSlowWsMessage("session-1", "cli", "assistant", 150);

    const events = tracer.getSlowWsMessages();
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("session-1");
    expect(events[0].dir).toBe("cli");
    expect(events[0].msgType).toBe("assistant");
    expect(events[0].ms).toBe(150);
  });

  it("getSummary returns cumulative stats", () => {
    tracer.recordEventLoopLag(100);
    tracer.recordEventLoopLag(200);
    tracer.recordSlowRequest("GET", "/api/test", 500);
    tracer.recordSlowWsMessage("s1", "browser", "user", 80);

    const summary = tracer.getSummary();
    expect(summary.lag.count).toBe(2);
    expect(summary.lag.maxMs).toBe(200);
    expect(summary.lag.avgMs).toBe(150);
    expect(summary.http.slowCount).toBe(1);
    expect(summary.http.maxMs).toBe(500);
    expect(summary.ws.slowCount).toBe(1);
    expect(summary.ws.maxMs).toBe(80);
    expect(summary.memory.heapUsedMB).toBeGreaterThan(0);
    expect(summary.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("reset clears all counters and buffers", () => {
    tracer.recordEventLoopLag(100);
    tracer.recordSlowRequest("GET", "/test", 500);
    tracer.recordSlowWsMessage("s1", "cli", "result", 80);

    tracer.reset();

    const summary = tracer.getSummary();
    expect(summary.lag.count).toBe(0);
    expect(summary.lag.maxMs).toBe(0);
    expect(summary.http.slowCount).toBe(0);
    expect(summary.ws.slowCount).toBe(0);
    expect(tracer.getLagEvents()).toHaveLength(0);
    expect(tracer.getSlowRequests()).toHaveLength(0);
    expect(tracer.getSlowWsMessages()).toHaveLength(0);
  });

  it("lag monitor detects artificial event loop blocks", async () => {
    // Gap-based detection: measure interval tick gaps exceeding the expected interval.
    // Use a short interval (30ms) and block for much longer (80ms) to guarantee
    // at least one tick arrives late.
    const sensitive = new PerfTracer({ lagThresholdMs: 5 });
    sensitive.startLagMonitor(30);

    // Let a few interval ticks establish the baseline
    await new Promise((r) => setTimeout(r, 80));

    // Block the event loop for 80ms — at least 2 interval ticks will be delayed
    const start = performance.now();
    while (performance.now() - start < 80) { /* busy wait */ }

    // Wait for the next tick(s) to measure the gap from the block
    await new Promise((r) => setTimeout(r, 120));

    const events = sensitive.getLagEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].lagMs).toBeGreaterThanOrEqual(5);

    sensitive.stop();
  });

  it("logs warning for significant lag (>200ms)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    tracer.recordEventLoopLag(250);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("250ms"));
    warnSpy.mockRestore();
  });

  it("does not log warning for minor lag", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    tracer.recordEventLoopLag(50);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("stop() cleans up all intervals", () => {
    tracer.startLagMonitor();
    tracer.startSummaryLogging();
    tracer.stop();
    // No assertion — just verifying no throw and intervals are cleared
  });
});
