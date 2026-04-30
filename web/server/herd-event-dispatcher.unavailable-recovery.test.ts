import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerdEventDispatcher, type LauncherHandle, type WsBridgeHandle } from "./herd-event-dispatcher.js";
import type { TakodeEvent } from "./session-types.js";

let eventCallback: ((evt: TakodeEvent) => void) | null = null;

function makeEvent(overrides: Partial<TakodeEvent> = {}): TakodeEvent {
  return {
    id: 1,
    event: "turn_end",
    sessionId: "worker-1",
    sessionNum: 5,
    sessionName: "worker",
    ts: Date.now(),
    data: { duration_ms: 1000, msgRange: { from: 0, to: 0 } },
    ...overrides,
  } as TakodeEvent;
}

function createMocks() {
  eventCallback = null;
  const bridge = {
    subscribeTakodeEvents: vi.fn<WsBridgeHandle["subscribeTakodeEvents"]>((sessions, cb) => {
      eventCallback = (evt) => {
        if (sessions.has(evt.sessionId)) cb(evt);
      };
      return vi.fn();
    }),
    injectUserMessage: vi.fn<WsBridgeHandle["injectUserMessage"]>(() => "sent"),
    isSessionIdle: vi.fn<NonNullable<WsBridgeHandle["isSessionIdle"]>>(() => false),
    wakeIdleKilledSession: vi.fn<NonNullable<WsBridgeHandle["wakeIdleKilledSession"]>>(() => false),
    wakeUnavailableOrchestratorForPendingEvents: vi.fn<
      NonNullable<WsBridgeHandle["wakeUnavailableOrchestratorForPendingEvents"]>
    >(() => false),
    getSession: vi.fn<WsBridgeHandle["getSession"]>(() => undefined),
  } satisfies WsBridgeHandle;
  const launcher: LauncherHandle = {
    getHerdedSessions: vi.fn(() => [{ sessionId: "worker-1" }]),
    getSession: vi.fn(() => undefined),
  };
  return { bridge, launcher };
}

function triggerEvent(evt: TakodeEvent) {
  eventCallback?.(evt);
}

describe("HerdEventDispatcher unavailable leader recovery retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a second pending event after a prior recovery request clears on attach", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.wakeUnavailableOrchestratorForPendingEvents)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    triggerEvent(makeEvent({ id: 1, data: { duration_ms: 1000, msgRange: { from: 0, to: 0 } } }));
    triggerEvent(makeEvent({ id: 2, data: { duration_ms: 1000, msgRange: { from: 1, to: 1 } } }));

    expect(bridge.wakeUnavailableOrchestratorForPendingEvents).toHaveBeenCalledTimes(2);
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();
    expect(dispatcher._getInbox("orch-1")?.entries.length).toBe(2);

    vi.advanceTimersByTime(2000);

    expect(bridge.wakeUnavailableOrchestratorForPendingEvents).toHaveBeenCalledTimes(3);
    expect(bridge.wakeUnavailableOrchestratorForPendingEvents).toHaveBeenLastCalledWith(
      "orch-1",
      "pending_herd_event_flush_retry",
    );
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();
    expect(dispatcher._getInbox("orch-1")?.entries.length).toBe(2);

    dispatcher.destroy();
  });

  it("keeps retrying a pending event until failed recovery state clears", () => {
    const { bridge, launcher } = createMocks();
    const dispatcher = new HerdEventDispatcher(bridge, launcher);
    dispatcher.setupForOrchestrator("orch-1");

    vi.mocked(bridge.wakeUnavailableOrchestratorForPendingEvents)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    triggerEvent(makeEvent({ id: 1, data: { duration_ms: 1000, msgRange: { from: 0, to: 0 } } }));

    expect(bridge.wakeUnavailableOrchestratorForPendingEvents).toHaveBeenCalledTimes(1);
    expect(dispatcher._getInbox("orch-1")?.entries.length).toBe(1);

    vi.advanceTimersByTime(2000);

    expect(bridge.wakeUnavailableOrchestratorForPendingEvents).toHaveBeenCalledTimes(2);
    expect(dispatcher._getInbox("orch-1")?.entries.length).toBe(1);

    vi.advanceTimersByTime(2000);

    expect(bridge.wakeUnavailableOrchestratorForPendingEvents).toHaveBeenCalledTimes(3);
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();
    expect(dispatcher._getInbox("orch-1")?.entries.length).toBe(1);

    dispatcher.destroy();
  });
});
