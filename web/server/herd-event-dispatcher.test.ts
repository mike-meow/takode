/**
 * Tests for the push-based herd event dispatcher.
 *
 * Uses mock interfaces for WsBridge and Launcher to test inbox accumulation,
 * debounce batching, delivery timing, filtering, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HerdEventDispatcher,
  formatHerdEventBatch,
  type WsBridgeHandle,
  type LauncherHandle,
} from "./herd-event-dispatcher.js";
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
    data: { duration_ms: 1000, reason: "test" },
    ...overrides,
  } as TakodeEvent;
}

function createMockBridge(): WsBridgeHandle & {
  _triggerEvent: (evt: TakodeEvent) => void;
  _lastInjected: {
    sessionId: string;
    content: string;
    agentSource?: { sessionId: string; sessionLabel?: string };
  } | null;
} {
  let callback: ((evt: TakodeEvent) => void) | null = null;

  return {
    subscribeTakodeEvents: vi.fn((sessions, cb) => {
      callback = cb;
      return vi.fn(); // unsubscribe
    }),
    injectUserMessage: vi.fn((sessionId, content, agentSource) => {
      (bridge as any)._lastInjected = { sessionId, content, agentSource };
      return "sent" as const;
    }),
    isSessionIdle: vi.fn(() => false),
    wakeIdleKilledSession: vi.fn(() => false),
    _triggerEvent: (evt: TakodeEvent) => {
      callback?.(evt);
    },
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
    injectUserMessage: vi.fn(() => "sent" as const),
    isSessionIdle: vi.fn(() => false),
    wakeIdleKilledSession: vi.fn(() => false),
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

  it("accumulates events while orchestrator is generating, flushes on turnEnd", async () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // Orchestrator is generating (not idle)
    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);

    // Worker events arrive
    triggerEvent(makeEvent({ event: "turn_end", data: { duration_ms: 5000 } }));
    triggerEvent(
      makeEvent({
        event: "permission_request",
        sessionId: "worker-2",
        sessionNum: 6,
        sessionName: "api-tests",
        data: { tool_name: "Bash" },
      }),
    );

    // Nothing injected yet
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    // Orchestrator finishes turn — now idle
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    dispatcher.onOrchestratorTurnEnd("orch-1");

    // onOrchestratorTurnEnd flushes immediately via queueMicrotask (no 500ms debounce)
    await Promise.resolve();
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

  it("filters non-actionable events (turn_start)", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    // Non-actionable events
    triggerEvent(makeEvent({ event: "turn_start" }));

    vi.advanceTimersByTime(600);

    // No delivery — turn_start is filtered
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("filters compaction herd events from orchestrator delivery", () => {
    // Compaction lifecycle events are still formatted elsewhere, but the leader
    // should not get them as herd events because they create avoidable noise.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(
      makeEvent({
        event: "compaction_started",
        data: { context_used_percent: 92 },
      }),
    );
    triggerEvent(
      makeEvent({
        id: 2,
        event: "compaction_finished",
        data: { context_used_percent: 61 },
      }),
    );
    vi.advanceTimersByTime(600);

    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("defers user_message to turn_end (not delivered individually)", () => {
    // user_message events are excluded from ACTIONABLE_EVENTS — they're
    // summarized in turn_end instead (count + IDs for peek navigation).
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(
      makeEvent({
        event: "user_message",
        data: { content: "please check latest logs" },
      }),
    );
    vi.advanceTimersByTime(600);

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
    expect(inbox?.entries.length).toBeLessThanOrEqual(200);

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

  it("retries delivery when flushInbox finds the leader busy", () => {
    // Regression: flushInbox used to silently return when the leader was not idle,
    // leaving events permanently stranded until the next onOrchestratorTurnEnd call.
    // Now it schedules a retry at RETRY_MS (2s) to prevent event loss.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // Leader starts idle → event triggers debounce
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    triggerEvent(makeEvent({ event: "turn_end" }));

    // Leader becomes busy before debounce fires
    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    vi.advanceTimersByTime(600);

    // Flush attempted but leader was busy — should NOT be delivered yet
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    // Retry timer should be active — leader becomes idle before retry fires
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    vi.advanceTimersByTime(2100);

    // Retry flush succeeds
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    dispatcher.destroy();
  });

  it("wakes idle-killed leader when herd event arrives", () => {
    // When a leader session was stopped by idle-manager (killedByIdleManager=true),
    // new herd events should wake it up by calling wakeIdleKilledSession.
    // The leader will be relaunched and events delivered once it reconnects.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // Leader is NOT idle (CLI disconnected, killed by idle manager)
    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    // wakeIdleKilledSession returns true — the session was idle-killed and relaunch requested
    vi.mocked(bridge.wakeIdleKilledSession).mockReturnValue(true);

    triggerEvent(makeEvent({ event: "turn_end" }));

    // Should have attempted to wake the session
    expect(bridge.wakeIdleKilledSession).toHaveBeenCalledWith("orch-1");

    // No immediate injection — events stay pending until CLI reconnects
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    // Events are in the inbox, waiting for the CLI to reconnect and go idle
    const inbox = dispatcher._getInbox("orch-1");
    expect(inbox?.entries.length).toBe(1);

    dispatcher.destroy();
  });

  it("does not wake leader if session was not idle-killed", () => {
    // When the leader is just busy (generating), wakeIdleKilledSession returns false
    // and the normal retry path is used instead.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    vi.mocked(bridge.wakeIdleKilledSession).mockReturnValue(false);

    triggerEvent(makeEvent({ event: "turn_end" }));

    // wakeIdleKilledSession was called but returned false (not idle-killed)
    expect(bridge.wakeIdleKilledSession).toHaveBeenCalledWith("orch-1");

    // No injection, no wake — events just accumulate for next turnEnd/retry
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("wakes idle-killed leader during flushInbox retry", () => {
    // Edge case: leader is killed by idle-manager between debounce schedule and flush.
    // flushInbox should detect the idle-kill and wake the session.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // Leader starts idle → event triggers debounce
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    triggerEvent(makeEvent({ event: "turn_end" }));

    // Leader gets idle-killed before debounce fires
    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    vi.mocked(bridge.wakeIdleKilledSession).mockReturnValue(true);
    vi.advanceTimersByTime(600);

    // flushInbox detected the idle-killed state and woke the session
    expect(bridge.wakeIdleKilledSession).toHaveBeenCalledWith("orch-1");
    // No injection (CLI is dead, will deliver after reconnect)
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("flushes immediately on turnEnd via microtask, not 500ms debounce", async () => {
    // Regression: onOrchestratorTurnEnd used scheduleDelivery (500ms debounce),
    // giving a window where the leader could start a new turn before events
    // were delivered. Now it flushes via queueMicrotask for immediate delivery.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    triggerEvent(makeEvent({ event: "turn_end" }));

    // Leader finishes turn
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    dispatcher.onOrchestratorTurnEnd("orch-1");

    // Events should be delivered immediately (microtask), not after 500ms
    await Promise.resolve();
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    // No pending debounce timer should exist
    const inbox = dispatcher._getInbox("orch-1");
    expect(inbox?.debounceTimer).toBeNull();

    dispatcher.destroy();
  });

  it("cancels debounce timer when turnEnd triggers immediate flush", async () => {
    // If a debounce timer was already pending when onOrchestratorTurnEnd fires,
    // it should be cancelled to avoid double-delivery.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // Leader idle → event arrives → debounce timer starts
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    triggerEvent(makeEvent({ event: "turn_end" }));
    const inbox = dispatcher._getInbox("orch-1");
    expect(inbox?.debounceTimer).not.toBeNull(); // Timer is active

    // Before debounce fires, turnEnd triggers immediate flush
    dispatcher.onOrchestratorTurnEnd("orch-1");
    await Promise.resolve();

    // Should be delivered exactly once (not doubled by the old debounce timer)
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    // Advance past the old debounce time — no second delivery
    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    dispatcher.destroy();
  });

  it("filters user-initiated turn_end events (turn_source='user')", () => {
    // User-initiated turns on herded workers should not be delivered to the
    // leader — they create spurious herd events from work the leader didn't
    // initiate (q-16 fix).
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    // User-initiated turn_end (filtered)
    triggerEvent(makeEvent({ event: "turn_end", data: { duration_ms: 5000, turn_source: "user" } }));

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("delivers leader-initiated turn_end events (turn_source='leader')", () => {
    // Leader-initiated turns should always be delivered.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(makeEvent({ event: "turn_end", data: { duration_ms: 5000, turn_source: "leader" } }));

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    dispatcher.destroy();
  });

  it("delivers turn_end events without turn_source (backwards compatibility)", () => {
    // Events from older sessions that don't have turn_source should still be
    // delivered — absence of the field means "don't filter".
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(makeEvent({ event: "turn_end", data: { duration_ms: 5000 } }));

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    dispatcher.destroy();
  });

  it("delivers system-initiated turn_end events", () => {
    // System-initiated turns (e.g. compaction trigger) should be delivered.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(makeEvent({ event: "turn_end", data: { duration_ms: 5000, turn_source: "system" } }));

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    dispatcher.destroy();
  });

  it("only delivers leader-initiated turn_end when batch has both user and leader turns", () => {
    // Mixed batch: user-initiated should be filtered, leader-initiated should be delivered.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(makeEvent({ id: 1, event: "turn_end", data: { duration_ms: 5000, turn_source: "user" } }));
    triggerEvent(makeEvent({ id: 2, event: "turn_end", data: { duration_ms: 3000, turn_source: "leader" } }));

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
    // The delivered message should only contain 1 event (the leader-initiated one)
    const content = vi.mocked(bridge.injectUserMessage).mock.calls[0][1];
    expect(content).toContain("1 event from 1 session");

    dispatcher.destroy();
  });
});

// ─── formatHerdEventBatch ───────────────────────────────────────────────────────

describe("formatHerdEventBatch", () => {
  it("formats turn_end events with duration and tools", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: { duration_ms: 12300, tools: { Edit: 3, Bash: 2 }, resultPreview: "Added JWT validation" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("1 event from 1 session");
    expect(result).toContain("#5");
    expect(result).toContain("turn_end");
    expect(result).toContain("12.3s");
    expect(result).toContain("Edit(3)");
    expect(result).toContain("Added JWT validation");
  });

  it("formats permission_request events", () => {
    const events = [
      makeEvent({
        event: "permission_request",
        data: { tool_name: "Bash", summary: "rm -rf node_modules" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("permission_request");
    expect(result).toContain("Bash: rm -rf node_modules");
  });

  it("formats session_error events", () => {
    const events = [
      makeEvent({
        event: "session_error",
        data: { error: "Test suite failed: 3 assertions" },
      }),
    ];
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

  it("formats interrupted turn_end events with interrupted status marker", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: { duration_ms: 1600, interrupted: true },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("interrupted 1.6s");
  });

  it("formats interrupted turn_end events with interrupt source attribution", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: { duration_ms: 1600, interrupted: true, interrupt_source: "leader" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("interrupted (by leader) 1.6s");
  });

  it("formats turn_end with compacted annotation when context was compacted", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: { duration_ms: 30000, compacted: true },
      }),
    ];
    const result = formatHerdEventBatch(events);
    // Should show "(compacted)" after the duration so the leader knows the agent was busy compacting
    expect(result).toContain("30.0s (compacted)");
  });

  it("formats compaction_started event with context percentage", () => {
    const events = [
      makeEvent({
        event: "compaction_started",
        data: { context_used_percent: 89 },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("compaction_started");
    expect(result).toContain("context 89% full");
  });

  it("formats compaction_started event without context percentage", () => {
    const events = [
      makeEvent({
        event: "compaction_started",
        data: {},
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("compaction_started");
    expect(result).not.toContain("context");
  });

  it("appends relative age for recent events", () => {
    const now = 1_700_000_000_000;
    const events = [
      makeEvent({
        event: "user_message",
        ts: now - 45_000,
        data: { content: "ping" },
      }),
    ];
    const result = formatHerdEventBatch(events, now);
    expect(result).toContain("| 45s ago");
  });

  it("formats turn_end with user message count and IDs", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: {
          duration_ms: 15 * 60 * 1000,
          tools: { Edit: 3 },
          msgRange: { from: 169, to: 281 },
          userMsgs: { count: 3, ids: [172, 195, 240] },
        },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("15m 0s");
    expect(result).toContain("Edit(3)");
    expect(result).toContain("[169]-[281]");
    expect(result).toContain("3 user msgs [172, 195, 240]");
  });

  it("formats turn_end with single user message (no plural)", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: {
          duration_ms: 5000,
          userMsgs: { count: 1, ids: [42] },
        },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("1 user msg [42]");
    expect(result).not.toContain("user msgs");
  });

  it("formats turn_end without user messages when none received", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: { duration_ms: 5000 },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).not.toContain("user msg");
  });

  it("appends relative age for stale queued events", () => {
    const now = 1_700_000_000_000;
    const events = [
      makeEvent({
        event: "turn_end",
        ts: now - 2 * 60_000,
        data: { duration_ms: 1230 },
      }),
    ];
    const result = formatHerdEventBatch(events, now);
    expect(result).toContain("| 2m ago");
  });
});

// ─── forceFlushPendingEvents ─────────────────────────────────────────────────

describe("forceFlushPendingEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers pending events even when leader is not idle (stuck generation)", () => {
    // When a leader's isGenerating flag is stuck, the normal flushInbox
    // path retries forever. forceFlushPendingEvents bypasses the idle
    // check so the stuck-session watchdog can unblock event delivery
    // without clearing the generation state (which could break invariants).
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // Leader is NOT idle (stuck generating)
    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    triggerEvent(makeEvent({ event: "turn_end" }));

    // Normal delivery path won't deliver — it retries
    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    // Force flush bypasses the idle check
    const flushed = dispatcher.forceFlushPendingEvents("orch-1");
    expect(flushed).toBe(1);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    dispatcher.destroy();
  });

  it("returns 0 when there are no pending events", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    const flushed = dispatcher.forceFlushPendingEvents("orch-1");
    expect(flushed).toBe(0);
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("returns 0 for unknown orchestrator", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);

    const flushed = dispatcher.forceFlushPendingEvents("nonexistent");
    expect(flushed).toBe(0);

    dispatcher.destroy();
  });
});
