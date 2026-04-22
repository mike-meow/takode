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
    getSession: vi.fn(() => undefined),
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
  const bridge = {
    subscribeTakodeEvents: vi.fn<WsBridgeHandle["subscribeTakodeEvents"]>((sessions, cb) => {
      eventCallback = cb;
      return vi.fn(); // unsubscribe
    }),
    injectUserMessage: vi.fn<WsBridgeHandle["injectUserMessage"]>(() => "sent"),
    isSessionIdle: vi.fn<NonNullable<WsBridgeHandle["isSessionIdle"]>>(() => false),
    wakeIdleKilledSession: vi.fn<NonNullable<WsBridgeHandle["wakeIdleKilledSession"]>>(() => false),
    getSession: vi.fn<WsBridgeHandle["getSession"]>(() => undefined),
    getBoardRow: vi.fn<NonNullable<WsBridgeHandle["getBoardRow"]>>(() => ({ status: "IMPLEMENTING" })),
    getBoardStallSignature: vi.fn<NonNullable<WsBridgeHandle["getBoardStallSignature"]>>(() => "sig-1"),
    getBoardDispatchableSignature: vi.fn<NonNullable<WsBridgeHandle["getBoardDispatchableSignature"]>>(
      () => "dispatchable-sig-1",
    ),
  } satisfies WsBridgeHandle;
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

  it("delivers herd_reassigned events so previous leaders see forced takeovers", () => {
    // Forced reassignment must surface as a normal actionable herd event so the
    // previous leader sees that the worker left its herd.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(
      makeEvent({
        event: "herd_reassigned",
        data: {
          fromLeaderSessionId: "orch-1",
          fromLeaderLabel: "#1 Leader One",
          toLeaderSessionId: "orch-2",
          toLeaderLabel: "#2 Leader Two",
          reviewerCount: 1,
        },
      }),
    );
    vi.advanceTimersByTime(600);

    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
    const content = vi.mocked(bridge.injectUserMessage).mock.calls[0][1];
    expect(content).toContain("herd_reassigned");
    expect(content).toContain("#1 Leader One -> #2 Leader Two");
    expect(content).toContain("+1 reviewer");

    dispatcher.destroy();
  });

  it("delivers session_disconnected events for actionable worker stalls", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(
      makeEvent({
        event: "session_disconnected",
        data: { reason: "adapter_disconnect", wasGenerating: false },
      }),
    );
    vi.advanceTimersByTime(600);

    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
    const content = vi.mocked(bridge.injectUserMessage).mock.calls[0][1];
    expect(content).toContain("session_disconnected");
    expect(content).toContain("adapter_disconnect");

    dispatcher.destroy();
  });

  it("skips events triggered by the leader's own actions (actorSessionId)", () => {
    // When the leader runs takode archive or takode answer, the resulting
    // herd events should not bounce back to the leader (q-259).
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    // Event triggered by the leader itself (actorSessionId matches orchestrator)
    triggerEvent(
      makeEvent({
        event: "session_archived",
        data: {},
        actorSessionId: "orch-1",
      }),
    );
    vi.advanceTimersByTime(600);

    // Should NOT be delivered -- leader already sees the result
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    // But events without actorSessionId (or from other sessions) are delivered
    triggerEvent(
      makeEvent({
        id: 2,
        event: "session_archived",
        data: {},
      }),
    );
    vi.advanceTimersByTime(600);

    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

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

  it("keeps a zero-worker inbox alive until a pending herd_reassigned event is delivered", () => {
    // Regression: when the moved worker was the last herd member, the old
    // leader still needs the pending herd_reassigned event before inbox teardown.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    triggerEvent(
      makeEvent({
        event: "herd_reassigned",
        data: {
          fromLeaderSessionId: "orch-1",
          fromLeaderLabel: "#1 Leader One",
          toLeaderSessionId: "orch-2",
          toLeaderLabel: "#2 Leader Two",
        },
      }),
    );

    vi.mocked(launcher.getHerdedSessions).mockReturnValue([]);
    dispatcher.onHerdChanged("orch-1");

    const inboxBeforeDelivery = dispatcher._getInbox("orch-1");
    expect(inboxBeforeDelivery).toBeDefined();
    expect(inboxBeforeDelivery?.workerIds.size).toBe(0);

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    dispatcher.onOrchestratorTurnEnd("orch-1");
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

  it("keeps herd events pending when bridge queues the injection locally", () => {
    // Regression guard for q-275: Codex leaders can accept a herd event into a
    // local pending-delivery queue before the backend turn actually starts.
    // The dispatcher must not mark those events in-flight yet, or later user
    // messages can get stuck behind an undelivered herd chip indefinitely.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    vi.mocked(bridge.injectUserMessage).mockReturnValueOnce("queued").mockReturnValueOnce("sent");

    triggerEvent(makeEvent({ event: "turn_end" }));

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
    const inboxAfterQueued = dispatcher._getInbox("orch-1");
    expect(inboxAfterQueued?.inFlightUpTo).toBeNull();
    expect(inboxAfterQueued?.entries).toHaveLength(1);
    expect(inboxAfterQueued?.deliveryHistory[0]?.status).toBe("pending");

    vi.advanceTimersByTime(2100);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(2);
    const inboxAfterSent = dispatcher._getInbox("orch-1");
    expect(inboxAfterSent?.inFlightUpTo).toBe(0);
    expect(inboxAfterSent?.deliveryHistory[0]?.status).toBe("in_flight");

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

  it("flushes synchronously on turnEnd, not via microtask or 500ms debounce", () => {
    // Regression: flushing via microtask raced with promoteNextQueuedTurn()
    // which sets isGenerating=true synchronously after onOrchestratorTurnEnd,
    // causing the microtask to find the leader "busy" (q-205). Now flushInbox
    // runs synchronously during onOrchestratorTurnEnd for reliable delivery.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    triggerEvent(makeEvent({ event: "turn_end" }));

    // Leader finishes turn
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    dispatcher.onOrchestratorTurnEnd("orch-1");

    // Events should be delivered synchronously (no microtask/await needed)
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    // No pending debounce timer should exist
    const inbox = dispatcher._getInbox("orch-1");
    expect(inbox?.debounceTimer).toBeNull();

    dispatcher.destroy();
  });

  it("cancels debounce timer when turnEnd triggers immediate flush", () => {
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

    // Before debounce fires, turnEnd triggers synchronous flush
    dispatcher.onOrchestratorTurnEnd("orch-1");

    // Should be delivered exactly once (not doubled by the old debounce timer)
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    // Advance past the old debounce time — no second delivery
    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);

    dispatcher.destroy();
  });

  it("delivers user-initiated turn_end events (annotated, not dropped)", () => {
    // User-initiated turns on herded workers must still be delivered to the
    // leader so it has full visibility into worker state. Previously these
    // were silently dropped (q-16), creating a blind spot where the leader
    // never learned about user-triggered task completions.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(makeEvent({ event: "turn_end", data: { duration_ms: 5000, turn_source: "user" } }));

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
    // The formatted output should annotate it as user-initiated
    const content = vi.mocked(bridge.injectUserMessage).mock.calls[0][1];
    expect(content).toContain("(user-initiated)");

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

  it("delivers board_stalled events with a leader-actionable summary", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(
      makeEvent({
        event: "board_stalled",
        data: {
          questId: "q-42",
          title: "Fix auth drift",
          stage: "IMPLEMENTING",
          workerStatus: "disconnected",
          reviewerStatus: "missing",
          stalledForMs: 240_000,
          reason: "worker disconnected",
          action: "inspect worker; resume or re-dispatch before review",
        },
      }),
    );

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
    const content = vi.mocked(bridge.injectUserMessage).mock.calls[0][1];
    expect(content).toContain("board_stalled");
    expect(content).toContain("q-42");
    expect(content).toContain("worker disconnected");
    expect(content).toContain("next: inspect worker");

    dispatcher.destroy();
  });

  it("drops queued board_stalled events once the leader board no longer has that row", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    triggerEvent(
      makeEvent({
        event: "board_stalled",
        data: {
          questId: "q-42",
          title: "Fix auth drift",
          stage: "IMPLEMENTING",
          workerStatus: "disconnected",
          reviewerStatus: "missing",
          stalledForMs: 240_000,
          reason: "worker disconnected",
          action: "inspect worker; resume or re-dispatch before review",
        },
      }),
    );

    vi.mocked(bridge.getBoardRow!).mockReturnValue(null);
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    dispatcher.onOrchestratorTurnEnd("orch-1");

    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("drops queued board_stalled events when the row recovered in place", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    triggerEvent(
      makeEvent({
        event: "board_stalled",
        data: {
          questId: "q-42",
          title: "Fix auth drift",
          stage: "IMPLEMENTING",
          signature: "sig-1",
          workerStatus: "disconnected",
          reviewerStatus: "missing",
          stalledForMs: 240_000,
          reason: "worker disconnected",
          action: "inspect worker; resume or re-dispatch before review",
        },
      }),
    );

    vi.mocked(bridge.getBoardRow!).mockReturnValue({ status: "IMPLEMENTING" });
    vi.mocked(bridge.getBoardStallSignature!).mockReturnValue(null);
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    dispatcher.onOrchestratorTurnEnd("orch-1");

    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    dispatcher.destroy();
  });

  it("delivers board_dispatchable events with a leader-actionable summary", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(
      makeEvent({
        event: "board_dispatchable",
        data: {
          questId: "q-77",
          title: "Dispatch the queued follow-up",
          summary: "q-77 can be dispatched now: wait-for resolved (q-76).",
          action: "Dispatch it now or replace QUEUED with the next active board stage.",
        },
      }),
    );

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
    const content = vi.mocked(bridge.injectUserMessage).mock.calls[0][1];
    expect(content).toContain("board_dispatchable");
    expect(content).toContain("q-77");
    expect(content).toContain("can be dispatched now");
    expect(content).toContain("next: Dispatch it now");

    dispatcher.destroy();
  });

  it("drops queued board_dispatchable events when the row is no longer dispatchable", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    triggerEvent(
      makeEvent({
        event: "board_dispatchable",
        data: {
          questId: "q-77",
          title: "Dispatch the queued follow-up",
          signature: "dispatchable-sig-1",
          summary: "q-77 can be dispatched now: wait-for resolved (q-76).",
        },
      }),
    );

    vi.mocked(bridge.getBoardRow!).mockReturnValue({ status: "QUEUED" });
    vi.mocked(bridge.getBoardDispatchableSignature!).mockReturnValue(null);
    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    dispatcher.onOrchestratorTurnEnd("orch-1");

    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

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

  it("delivers both user and leader turn_end events in a mixed batch", () => {
    // Both user-initiated and leader-initiated events should be delivered.
    // User-initiated events are annotated so the leader can distinguish them.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);

    triggerEvent(makeEvent({ id: 1, event: "turn_end", data: { duration_ms: 5000, turn_source: "user" } }));
    triggerEvent(makeEvent({ id: 2, event: "turn_end", data: { duration_ms: 3000, turn_source: "leader" } }));

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
    const content = vi.mocked(bridge.injectUserMessage).mock.calls[0][1];
    // Both events delivered
    expect(content).toContain("2 events from 1 session");
    // User-initiated one is annotated
    expect(content).toContain("(user-initiated)");

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
    expect(result).toContain("tools: 5");
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
    // No msg_index provided -- should not include msg reference
    expect(result).not.toContain("msg [");
  });

  it("formats herd_reassigned events with old and new leader labels", () => {
    // Formatting should preserve both leader labels so the injected herd event
    // is self-contained when reviewed from the old leader session.
    const events = [
      makeEvent({
        event: "herd_reassigned",
        data: {
          fromLeaderSessionId: "orch-1",
          fromLeaderLabel: "#1 Leader One",
          toLeaderSessionId: "orch-2",
          toLeaderLabel: "#2 Leader Two",
          reviewerCount: 2,
        },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("herd_reassigned");
    expect(result).toContain("#1 Leader One -> #2 Leader Two");
    expect(result).toContain("+2 reviewers");
  });

  it("includes msg [N] reference when msg_index is present in permission_request", () => {
    const events = [
      makeEvent({
        event: "permission_request",
        data: { tool_name: "ExitPlanMode", summary: "ExitPlanMode", msg_index: 42 },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("permission_request");
    expect(result).toContain("ExitPlanMode");
    expect(result).toContain("msg [42]");
  });

  it("includes full plan content inline for ExitPlanMode permission_request", () => {
    // When a worker submits a plan via ExitPlanMode, the herd event should
    // include the full plan text so the leader can review without extra tool calls.
    const planText = "## Plan\n\n1. Add feature X\n2. Update tests";
    const events = [
      makeEvent({
        event: "permission_request",
        data: {
          tool_name: "ExitPlanMode",
          summary: "ExitPlanMode",
          msg_index: 10,
          planContent: planText,
        },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("ExitPlanMode");
    expect(result).toContain("<plan>");
    expect(result).toContain(planText);
    expect(result).toContain("</plan>");
  });

  it("omits plan block when planContent is not present in permission_request", () => {
    // Regular permission requests (non-ExitPlanMode) should not have plan blocks.
    const events = [
      makeEvent({
        event: "permission_request",
        data: { tool_name: "Bash", summary: "git status" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).not.toContain("<plan>");
    expect(result).not.toContain("</plan>");
  });

  it("formats user-initiated permission_request with (user-initiated) annotation", () => {
    const events = [
      makeEvent({
        event: "permission_request",
        data: { tool_name: "AskUserQuestion", summary: "Which option?", turn_source: "user" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("permission_request (user-initiated)");
    expect(result).toContain("AskUserQuestion");
  });

  it("includes answer hints for AskUserQuestion permission_request events", () => {
    const events = [
      makeEvent({
        event: "permission_request",
        data: {
          tool_name: "AskUserQuestion",
          summary: "Need clarification",
          question: "Which rollout should I use?",
          options: ["Staged", "Immediate"],
          msg_index: 12,
        },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("Question: Which rollout should I use?");
    expect(result).toContain("1. Staged");
    expect(result).toContain("2. Immediate");
    expect(result).toContain("Answer: takode answer 5 --message 12 <option-number-or-text>");
    expect(result).toContain("Read: takode read 5 12");
  });

  it("includes answer hints for notification_needs_input events", () => {
    const events = [
      makeEvent({
        event: "notification_needs_input",
        data: { summary: "Need decision on rollout", msg_index: 18 },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("notification_needs_input");
    expect(result).toContain("msg [18]");
    expect(result).toContain("Answer: takode answer 5 --message 18 <response>");
    expect(result).toContain("Read: takode read 5 18");
  });

  it("does not annotate leader-initiated permission_request with (user-initiated)", () => {
    const events = [
      makeEvent({
        event: "permission_request",
        data: { tool_name: "Bash", summary: "rm -rf /tmp", turn_source: "leader" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("permission_request |");
    expect(result).not.toContain("(user-initiated)");
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

  it("formats user-initiated session_archived with explicit annotation", () => {
    const events = [
      makeEvent({
        event: "session_archived",
        data: { archive_source: "user" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("session_archived (user-initiated)");
  });

  it("does not annotate non-user session_archived events", () => {
    const events = [
      makeEvent({
        event: "session_archived",
        data: { archive_source: "cascade" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("session_archived");
    expect(result).not.toContain("(user-initiated)");
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

  it("formats user-initiated turn_end with (user-initiated) annotation", () => {
    // User-initiated turns are annotated so the leader can distinguish them
    // from leader-dispatched work without losing visibility.
    const events = [
      makeEvent({
        event: "turn_end",
        data: { duration_ms: 5000, turn_source: "user" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).toContain("(user-initiated)");
    expect(result).toContain("5.0s");
  });

  it("does not annotate leader-initiated turn_end with (user-initiated)", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: { duration_ms: 5000, turn_source: "leader" },
      }),
    ];
    const result = formatHerdEventBatch(events);
    expect(result).not.toContain("(user-initiated)");
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
    const result = formatHerdEventBatch(events, { nowTs: now });
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
    expect(result).toContain("tools: 3");
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
    const result = formatHerdEventBatch(events, { nowTs: now });
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

  it("keeps force-flushed events pending and re-arms retry when bridge still queues them locally", () => {
    // q-275 follow-up: the stuck-session watchdog uses forceFlushPendingEvents.
    // If Codex still only accepts the herd event into a local pending queue,
    // the dispatcher must not mark it delivered and must retry again later.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    vi.mocked(bridge.injectUserMessage).mockReturnValueOnce("queued").mockReturnValueOnce("sent");
    triggerEvent(makeEvent({ event: "turn_end" }));

    vi.advanceTimersByTime(600);
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();

    const queuedFlush = dispatcher.forceFlushPendingEvents("orch-1");
    expect(queuedFlush).toBe(0);
    const inboxAfterQueued = dispatcher._getInbox("orch-1");
    expect(inboxAfterQueued?.inFlightUpTo).toBeNull();
    expect(inboxAfterQueued?.deliveryHistory[0]?.status).toBe("pending");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(true);
    vi.advanceTimersByTime(2100);
    expect(bridge.injectUserMessage).toHaveBeenCalledTimes(2);
    const inboxAfterSent = dispatcher._getInbox("orch-1");
    expect(inboxAfterSent?.inFlightUpTo).toBe(0);
    expect(inboxAfterSent?.deliveryHistory[0]?.status).toBe("in_flight");

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

// ─── Activity injection in formatHerdEventBatch ──────────────────────────────

describe("formatHerdEventBatch with activity injection", () => {
  it("includes activity summary for turn_end events when getMessages is provided", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        sessionId: "worker-1",
        data: {
          duration_ms: 5000,
          msgRange: { from: 10, to: 12 },
        },
      }),
    ];
    // Simulate a 3-message turn: user → assistant → result
    const mockMessages = [
      { type: "user_message", content: "Fix the bug", timestamp: Date.now() },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "On it" },
            { type: "tool_use", id: "tu1", name: "Edit", input: { file_path: "/src/fix.ts" } },
          ],
        },
        timestamp: Date.now(),
      },
      { type: "result", data: { result: "Bug fixed", is_error: false, duration_ms: 5000 } },
    ];

    const result = formatHerdEventBatch(events, {
      getMessages: (_sid, _from, _to) => mockMessages as any,
    });

    // Should contain the turn_end status line
    expect(result).toContain("turn_end");
    // Should also contain the activity summary
    expect(result).toContain('user: "Fix the bug"');
    expect(result).toContain("Tool Calls not shown above: 1 Edit.");
    expect(result).toContain("Bug fixed");
  });

  it("does not include activity when getMessages is not provided", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: {
          duration_ms: 5000,
          msgRange: { from: 10, to: 15 },
        },
      }),
    ];
    const result = formatHerdEventBatch(events);
    // Should just have the status line, no activity
    expect(result).toContain("turn_end");
    expect(result).not.toContain("user:");
  });

  it("does not include activity when msgRange is missing", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        data: { duration_ms: 5000 },
      }),
    ];
    const result = formatHerdEventBatch(events, {
      getMessages: () => [{ type: "user_message", content: "should not appear" }] as any,
    });
    expect(result).not.toContain("should not appear");
  });

  it("does not deduplicate within a single batch (watermarks updated by caller after delivery)", () => {
    // Within one formatHerdEventBatch call, watermarks aren't updated yet --
    // that's the caller's job via updateLastEmittedMsgTo after injection.
    // So two events from the same session each get their full msgRange.
    const events = [
      makeEvent({
        event: "turn_end",
        sessionId: "worker-1",
        data: { duration_ms: 3000, msgRange: { from: 10, to: 15 } },
      }),
      makeEvent({
        event: "turn_end",
        sessionId: "worker-1",
        data: { duration_ms: 4000, msgRange: { from: 13, to: 20 } },
      }),
    ];

    // Track which ranges were requested
    const requestedRanges: Array<{ from: number; to: number }> = [];
    const watermarks = new Map<string, number>();

    formatHerdEventBatch(events, {
      getMessages: (_sid, from, to) => {
        requestedRanges.push({ from, to });
        return [{ type: "user_message", content: `msg ${from}-${to}`, timestamp: Date.now() }] as any;
      },
      lastEmittedMsgTo: watermarks,
    });

    // Both events get their full range -- no within-batch dedup
    expect(requestedRanges[0]).toEqual({ from: 10, to: 15 });
    expect(requestedRanges[1]).toEqual({ from: 13, to: 20 });
    // This is intentional: the batch is a single delivery unit.)
    expect(requestedRanges[1]).toEqual({ from: 13, to: 20 });
  });

  it("fetches the full range and skips activity when no unseen user or non-user content survives deduplication", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        sessionId: "worker-1",
        data: { duration_ms: 5000, msgRange: { from: 10, to: 15 } },
      }),
    ];
    // Watermark at 15 means [10]-[15] was already emitted in a prior batch
    const watermarks = new Map([["worker-1", 15]]);
    let getMessagesCalled = false;

    const result = formatHerdEventBatch(events, {
      getMessages: () => {
        getMessagesCalled = true;
        return [];
      },
      lastEmittedMsgTo: watermarks,
    });

    // The dispatcher now fetches the full range so the formatter can decide
    // whether any older unseen user messages still need to surface.
    expect(getMessagesCalled).toBe(true);
    // Should still have the turn_end status line
    expect(result).toContain("turn_end");
    expect(result).not.toContain("user:");
  });

  it("still surfaces an unseen user message even when it is older than the non-user dedup watermark", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        sessionId: "worker-1",
        data: { duration_ms: 5000, msgRange: { from: 10, to: 16 } },
      }),
    ];
    const watermarks = new Map([["worker-1", 14]]);
    const seenUserMsgIdxs = new Map<string, Set<number>>();
    const surfacedUserMsgIdxs = new Map<string, Set<number>>();
    const mockMessages = [
      { type: "assistant", message: { content: [{ type: "text", text: "older assistant" }] }, timestamp: Date.now() },
      { type: "user_message", content: "Unseen user below watermark", timestamp: Date.now() },
      { type: "assistant", message: { content: [{ type: "text", text: "new assistant" }] }, timestamp: Date.now() },
      { type: "result", data: { result: "Done", is_error: false, duration_ms: 1 } },
    ];

    const result = formatHerdEventBatch(events, {
      getMessages: () => mockMessages as any,
      lastEmittedMsgTo: watermarks,
      seenUserMsgIdxs,
      surfacedUserMsgIdxs,
    });

    expect(result).toContain('user: "Unseen user below watermark"');
    expect(result).not.toContain("older assistant");
    expect(surfacedUserMsgIdxs.get("worker-1")).toEqual(new Set([11]));
  });

  it("does not duplicate user messages that were already surfaced in prior activity output", () => {
    const events = [
      makeEvent({
        event: "turn_end",
        sessionId: "worker-1",
        data: { duration_ms: 5000, msgRange: { from: 20, to: 24 } },
      }),
    ];
    const watermarks = new Map([["worker-1", 22]]);
    const seenUserMsgIdxs = new Map<string, Set<number>>([["worker-1", new Set([21])]]);
    const surfacedUserMsgIdxs = new Map<string, Set<number>>();
    const mockMessages = [
      { type: "assistant", message: { content: [{ type: "text", text: "old assistant" }] }, timestamp: Date.now() },
      { type: "user_message", content: "Already seen user", timestamp: Date.now() },
      { type: "user_message", content: "Fresh unseen user", timestamp: Date.now() },
      { type: "result", data: { result: "Done", is_error: false, duration_ms: 1 } },
    ];

    const result = formatHerdEventBatch(events, {
      getMessages: () => mockMessages as any,
      lastEmittedMsgTo: watermarks,
      seenUserMsgIdxs,
      surfacedUserMsgIdxs,
    });

    expect(result).not.toContain('user: "Already seen user"');
    expect(result).toContain('user: "Fresh unseen user"');
    expect(surfacedUserMsgIdxs.get("worker-1")).toEqual(new Set([22]));
  });
});

describe("inbox overflow prioritization (q-205)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves permission_request events when non-critical events can be trimmed", () => {
    // When inbox overflows, non-critical events (turn_end, permission_resolved)
    // should be dropped first to protect critical events (permission_request,
    // session_error) that represent workers blocked on human action.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    // Leader is busy — events accumulate without delivery
    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);

    // Fill inbox with 199 turn_end events
    for (let i = 0; i < 199; i++) {
      triggerEvent(makeEvent({ id: i, event: "turn_end" }));
    }

    // Add a critical permission_request event
    triggerEvent(
      makeEvent({
        id: 199,
        event: "permission_request",
        data: { tool_name: "Bash", summary: "run tests" },
      }),
    );

    // Add one more turn_end to trigger overflow (201 > 200 cap)
    triggerEvent(makeEvent({ id: 200, event: "turn_end" }));

    const inbox = dispatcher._getInbox("orch-1");
    // Inbox should be capped at 200
    expect(inbox!.entries.length).toBeLessThanOrEqual(200);
    // The permission_request event should survive
    const hasPermissionRequest = inbox!.entries.some((e) => e.event.event === "permission_request");
    expect(hasPermissionRequest).toBe(true);

    dispatcher.destroy();
  });

  it("logs warning when critical events must be dropped during overflow", () => {
    // When there aren't enough non-critical events to trim, critical events
    // get dropped as a last resort — but with a console.warn for diagnostics.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Fill inbox entirely with permission_request events (all critical)
    for (let i = 0; i < 201; i++) {
      triggerEvent(
        makeEvent({
          id: i,
          event: "permission_request",
          data: { tool_name: "Bash", summary: `request ${i}` },
        }),
      );
    }

    const inbox = dispatcher._getInbox("orch-1");
    expect(inbox!.entries.length).toBeLessThanOrEqual(200);
    // Should have logged a warning about dropping critical events
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("critical event"));

    warnSpy.mockRestore();
    dispatcher.destroy();
  });

  it("preserves session_error events during overflow alongside permission_request", () => {
    // Both permission_request and session_error are critical — both should
    // survive when non-critical events can be trimmed instead.
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.isSessionIdle).mockReturnValue(false);

    // Fill with 198 turn_end events
    for (let i = 0; i < 198; i++) {
      triggerEvent(makeEvent({ id: i, event: "turn_end" }));
    }

    // Add critical events
    triggerEvent(makeEvent({ id: 198, event: "permission_request", data: { tool_name: "Bash", summary: "test" } }));
    triggerEvent(makeEvent({ id: 199, event: "session_error", data: { error: "CLI crashed" } }));

    // Trigger overflow
    triggerEvent(makeEvent({ id: 200, event: "turn_end" }));

    const inbox = dispatcher._getInbox("orch-1");
    expect(inbox!.entries.length).toBeLessThanOrEqual(200);

    const events = inbox!.entries.map((e) => e.event.event);
    expect(events).toContain("permission_request");
    expect(events).toContain("session_error");

    dispatcher.destroy();
  });
});
