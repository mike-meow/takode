/**
 * Tests for the push-based herd event dispatcher.
 *
 * Uses mock interfaces for WsBridge and Launcher to test inbox accumulation,
 * debounce batching, delivery timing, filtering, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HerdEventDispatcher, formatHerdEventBatch, type WsBridgeHandle, type LauncherHandle } from "./herd-event-dispatcher.js";
import type { TakodeEvent, TakodeEventType } from "./session-types.js";

// ─── Mock helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<TakodeEvent> = {}): TakodeEvent {
  return {
    id: 1,
    event: "turn_end",
    sessionId: "worker-1",
    sessionNum: 5,
    sessionName: "auth-module",
    ts: Date.now(),
    data: {},
    ...overrides,
  };
}

function createMockBridge(): WsBridgeHandle & {
  _triggerEvent: (evt: TakodeEvent) => void;
  _lastInjected: { sessionId: string; content: string; agentSource?: { sessionId: string; sessionLabel?: string } } | null;
} {
  let callback: ((evt: TakodeEvent) => void) | null = null;

  return {
    subscribeTakodeEvents: vi.fn((sessions, cb) => {
      callback = cb;
      return vi.fn(); // unsubscribe
    }),
    injectUserMessage: vi.fn((sessionId, content, agentSource) => {
      (bridge as any)._lastInjected = { sessionId, content, agentSource };
    }),
    isSessionIdle: vi.fn(() => false),
    _triggerEvent: (evt: TakodeEvent) => { callback?.(evt); },
    _lastInjected: null,
  };
  // Note: bridge is referenced before assignment — we need to use a variable
  const bridge = {} as any;
  return bridge;
}

// Actual mock setup that works:
let eventCallback: ((evt: TakodeEvent) => void) | null = null;

function createMocks() {
  eventCallback = null;
  const bridge: WsBridgeHandle = {
    subscribeTakodeEvents: vi.fn((sessions, cb) => {
      eventCallback = cb;
      return vi.fn(); // unsubscribe
    }),
    injectUserMessage: vi.fn(),
    isSessionIdle: vi.fn(() => false),
  };
  const launcher: LauncherHandle = {
    getHerdedSessions: vi.fn(() => [{ sessionId: "worker-1" }, { sessionId: "worker-2" }]),
  };
  return { bridge, launcher };
}

function triggerEvent(evt: TakodeEvent) {
  eventCallback?.(evt);
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe("HerdEventDispatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accumulates events while orchestrator is generating, flushes on turnEnd", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // Orchestrator is generating (not idle)
    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);

    // Worker events arrive
    triggerEvent(makeEvent({ event: "turn_end", data: { duration_ms: 5000 } }));
    triggerEvent(makeEvent({ event: "permission_request", sessionId: "worker-2", sessionNum: 6, sessionName: "api-tests", data: { tool_name: "Bash" } }));

    // Nothing injected yet
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    // Orchestrator finishes turn
    dispatcher.onOrchestratorTurnEnd("orch-1");

    // After debounce
    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    // Verify message content includes both events
    const call = vi.mocked(bridge.injectUserMessage).mock.calls[0];
    expect(call[0]).toBe("orch-1");
    expect(call[1]).toContain("2 events from 2 sessions");
    expect(call[2]).toEqual({ sessionId: "herd-events", sessionLabel: "Herd Events" });

    dispatcher.destroy();
  });

  it("delivers immediately (within debounce) when orchestrator is idle", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // Orchestrator is idle
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(makeEvent({ event: "turn_end" }));

    // Not yet — debounce pending
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    // After debounce
    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    dispatcher.destroy();
  });

  it("batches rapid events within debounce window", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    // Multiple events within 500ms
    triggerEvent(makeEvent({ id: 1, event: "turn_end" }));
    vi.advanceTimersByTime(100);
    triggerEvent(makeEvent({ id: 2, event: "session_error", data: { error: "test failed" } }));
    vi.advanceTimersByTime(100);
    triggerEvent(makeEvent({ id: 3, event: "permission_request", data: { tool_name: "Bash" } }));

    // Still within debounce — no delivery yet
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    // Debounce fires (500ms from first event)
    vi.advanceTimersByTime(400);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    // All 3 events in one message
    const content = vi.mocked(bridge.injectUserMessage).mock.calls[0][1];
    expect(content).toContain("3 events");

    dispatcher.destroy();
  });

  it("filters non-actionable events (turn_start, permission_resolved)", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    // Non-actionable events
    triggerEvent(makeEvent({ event: "turn_start" }));
    triggerEvent(makeEvent({ event: "permission_resolved" as TakodeEventType }));

    vi.advanceTimersByTime(600);

    // No delivery — all events were filtered
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("does not inject when inbox is empty on turnEnd", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    dispatcher.onOrchestratorTurnEnd("orch-1");
    vi.advanceTimersByTime(600);

    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("re-subscribes when herd changes", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    expect(bridge.subscribeTakodeEvents).toHaveBeenCalledTimes(1);

    // Change workers
    vi.mocked(launcher.getHerdedSessions).mockReturnValue([{ sessionId: "worker-3" }]);
    dispatcher.onHerdChanged("orch-1");

    // Unsubscribe old (via returned function) + subscribe new
    expect(bridge.subscribeTakodeEvents).toHaveBeenCalledTimes(2);

    dispatcher.destroy();
  });

  it("teardown cleans up subscription and timers", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    triggerEvent(makeEvent({ event: "turn_end" }));

    // Teardown before debounce fires
    dispatcher.teardownForOrchestrator("orch-1");

    vi.advanceTimersByTime(600);

    // No delivery — inbox was cleaned up
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    // Inbox removed
    expect(dispatcher._getInbox("orch-1")).toBeUndefined();
  });

  it("caps inbox at 100 events (drops oldest)", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);

    // Push 110 events
    for (let i = 0; i < 110; i++) {
      triggerEvent(makeEvent({ id: i, event: "turn_end" }));
    }

    const inbox = dispatcher._getInbox("orch-1");
    expect(inbox?.events.length).toBe(100);
    // Oldest dropped: first event should be id=10
    expect(inbox?.events[0].id).toBe(10);

    dispatcher.destroy();
  });

  it("tags injected messages with herd-events agentSource", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    triggerEvent(makeEvent({ event: "turn_end" }));
    vi.advanceTimersByTime(600);

    const call = vi.mocked(bridge.injectUserMessage).mock.calls[0];
    expect(call[2]).toEqual({ sessionId: "herd-events", sessionLabel: "Herd Events" });

    dispatcher.destroy();
  });

  it("tears down when herd becomes empty", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // All workers unherded
    vi.mocked(launcher.getHerdedSessions).mockReturnValue([]);
    dispatcher.onHerdChanged("orch-1");

    expect(dispatcher._getInbox("orch-1")).toBeUndefined();

    dispatcher.destroy();
  });
});

// ─── formatHerdEventBatch ───────────────────────────────────────────────────────

describe("formatHerdEventBatch", () => {
  it("formats turn_end events with duration and tools", () => {
    const events = [makeEvent({
      event: "turn_end",
      data: { duration_ms: 12300, tools: { Edit: 3, Bash: 2 }, resultPreview: "Added JWT validation" },
    })];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("1 event from 1 session");
    expect(result).toContain("#5 auth-module");
    expect(result).toContain("turn_end");
    expect(result).toContain("12.3s");
    expect(result).toContain("Edit(3)");
    expect(result).toContain("Added JWT validation");
  });

  it("formats permission_request events", () => {
    const events = [makeEvent({
      event: "permission_request",
      data: { tool_name: "Bash", summary: "rm -rf node_modules" },
    })];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("permission_request");
    expect(result).toContain("Bash: rm -rf node_modules");
  });

  it("formats session_error events", () => {
    const events = [makeEvent({
      event: "session_error",
      data: { error: "Test suite failed: 3 assertions" },
    })];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("session_error");
    expect(result).toContain("Test suite failed");
  });

  it("counts sessions correctly in header", () => {
    const events = [
      makeEvent({ sessionId: "w1", sessionNum: 5, sessionName: "auth" }),
      makeEvent({ sessionId: "w2", sessionNum: 6, sessionName: "api" }),
      makeEvent({ sessionId: "w1", sessionNum: 5, sessionName: "auth" }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("3 events from 2 sessions");
  });
});
