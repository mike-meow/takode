/**
 * Tests for the generation lifecycle's queued turn handling (q-307).
 *
 * Validates that:
 * - On "result" reason: next queued turn is promoted (existing behavior)
 * - On recovery reasons: ALL queued turns are drained (not promoted)
 * - On other reasons: queued turns are left alone (no drain, no promote)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setGenerating,
  markRunningFromUserDispatch,
  markTurnInterrupted,
  runStuckSessionWatchdogSweep,
  RECOVERY_REASONS,
  type GenerationLifecycleSession,
  type GenerationLifecycleDeps,
  type StuckWatchdogSession,
  type StuckWatchdogDeps,
} from "./generation-lifecycle.js";
import { deriveActiveTurnRoute } from "./browser-transport-controller.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<GenerationLifecycleSession> = {}): GenerationLifecycleSession {
  return {
    id: "test-session",
    isGenerating: false,
    generationStartedAt: null,
    stuckNotifiedAt: null,
    questStatusAtTurnStart: null,
    messageCountAtTurnStart: 0,
    interruptedDuringTurn: false,
    interruptSourceDuringTurn: null,
    compactedDuringTurn: false,
    userMessageIdsThisTurn: [],
    activeTurnRoute: null,
    queuedTurnStarts: 0,
    queuedTurnReasons: [],
    queuedTurnUserMessageIds: [],
    queuedTurnInterruptSources: [],
    queuedTurnActiveRoutes: [],
    optimisticRunningTimer: null,
    state: {},
    messageHistory: [],
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<GenerationLifecycleDeps<GenerationLifecycleSession>> = {},
): GenerationLifecycleDeps<GenerationLifecycleSession> {
  const sessions = new Map<string, GenerationLifecycleSession>();
  return {
    sessions,
    userMessageRunningTimeoutMs: 30_000,
    broadcastStatus: vi.fn(),
    persistSession: vi.fn(),
    onSessionActivityStateChanged: vi.fn(),
    emitTakodeEvent: vi.fn(),
    buildTurnToolSummary: vi.fn().mockReturnValue({}),
    ...overrides,
  };
}

function makeStuckWatchdogSession(overrides: Partial<StuckWatchdogSession> = {}): StuckWatchdogSession {
  const base = makeSession();
  return {
    ...base,
    backendType: "codex",
    pendingCodexInputs: [],
    codexAdapter: null,
    toolStartTimes: new Map(),
    lastCliMessageAt: 0,
    lastToolProgressAt: 0,
    state: {
      cwd: "/repo",
      backend_state: "connected",
    },
    ...overrides,
  };
}

function makeStuckWatchdogDeps(
  overrides: Partial<StuckWatchdogDeps<StuckWatchdogSession>> = {},
): StuckWatchdogDeps<StuckWatchdogSession> {
  return {
    stuckPendingDeliveryMs: 60_000,
    stuckThresholdMs: 120_000,
    autoRecoverMs: 300_000,
    autoRecoverOrchestratorMs: 120_000,
    requestCodexAutoRecovery: vi.fn(),
    broadcastMessage: vi.fn(),
    backendConnected: vi.fn(() => false),
    markTurnInterrupted: vi.fn(),
    setGenerating: vi.fn(),
    ...overrides,
  };
}

/** Helper: put the session into generating state with N queued turns. */
function setupWithQueuedTurns(
  session: GenerationLifecycleSession,
  deps: GenerationLifecycleDeps<GenerationLifecycleSession>,
  queueCount: number,
): void {
  // Start the first (current) generation
  deps.sessions.set(session.id, session);
  setGenerating(deps, session, true, "initial");

  // Queue additional turns
  for (let i = 0; i < queueCount; i++) {
    markRunningFromUserDispatch(deps, session, `queued_msg_${i}`);
  }
  expect(session.isGenerating).toBe(true);
  expect(session.queuedTurnStarts).toBe(queueCount);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("setGenerating(false) — queued turn handling", () => {
  let session: GenerationLifecycleSession;
  let deps: GenerationLifecycleDeps<GenerationLifecycleSession>;

  beforeEach(() => {
    session = makeSession();
    deps = makeDeps();
    deps.sessions.set(session.id, session);
  });

  it("promotes next queued turn on 'result' reason", () => {
    setupWithQueuedTurns(session, deps, 2);

    // End current turn with "result" — should promote next queued turn
    setGenerating(deps, session, false, "result");

    // Session should be generating again (promoted turn)
    expect(session.isGenerating).toBe(true);
    // One queued turn was consumed, one remains
    expect(session.queuedTurnStarts).toBe(1);
  });

  it("preserves a queued Codex quest-thread active route through promotion", () => {
    const statusRoutes: unknown[] = [];
    deps = makeDeps({
      isHerdedWorker: vi.fn(() => true),
      broadcastStatus: vi.fn((targetSession, status) => {
        statusRoutes.push({
          status,
          activeTurnRoute: deriveActiveTurnRoute(targetSession as any),
        });
      }),
    });
    deps.sessions.set(session.id, session);

    markRunningFromUserDispatch(deps, session, "user_message");
    markRunningFromUserDispatch(deps, session, "user_message", null, undefined, {
      threadKey: "q-968",
      questId: "q-968",
    });

    expect(session.queuedTurnStarts).toBe(1);
    expect(session.queuedTurnActiveRoutes).toEqual([{ threadKey: "q-968", questId: "q-968" }]);

    setGenerating(deps, session, false, "result");

    expect(statusRoutes).toEqual([
      { status: "running", activeTurnRoute: { threadKey: "main" } },
      { status: "running", activeTurnRoute: { threadKey: "q-968", questId: "q-968" } },
    ]);
    expect(session.activeTurnRoute).toEqual({ threadKey: "q-968", questId: "q-968" });
    expect(session.userMessageIdsThisTurn).toEqual([]);
  });

  it("drains ALL queued turns on 'stuck_auto_recovery' reason", () => {
    setupWithQueuedTurns(session, deps, 3);

    setGenerating(deps, session, false, "stuck_auto_recovery");

    // Session should be idle — no promotion, all drained
    expect(session.isGenerating).toBe(false);
    expect(session.queuedTurnStarts).toBe(0);
    expect(session.queuedTurnReasons).toEqual([]);
  });

  it("drains ALL queued turns on 'system_init_reset' reason", () => {
    setupWithQueuedTurns(session, deps, 2);

    setGenerating(deps, session, false, "system_init_reset");

    expect(session.isGenerating).toBe(false);
    expect(session.queuedTurnStarts).toBe(0);
  });

  it("drains ALL queued turns on 'cli_disconnect' reason", () => {
    setupWithQueuedTurns(session, deps, 1);

    setGenerating(deps, session, false, "cli_disconnect");

    expect(session.isGenerating).toBe(false);
    expect(session.queuedTurnStarts).toBe(0);
  });

  it("drains ALL queued turns on 'user_message_timeout' reason", () => {
    setupWithQueuedTurns(session, deps, 2);

    setGenerating(deps, session, false, "user_message_timeout");

    expect(session.isGenerating).toBe(false);
    expect(session.queuedTurnStarts).toBe(0);
  });

  it("leaves queued turns alone on non-recovery, non-result reason", () => {
    // For reasons like "interrupt" that don't indicate a dead CLI,
    // queued turns should remain for the CLI to process later.
    setupWithQueuedTurns(session, deps, 2);

    setGenerating(deps, session, false, "some_other_reason");

    expect(session.isGenerating).toBe(false);
    // Queued turns should be untouched
    expect(session.queuedTurnStarts).toBe(2);
  });

  it("handles drain with no queued turns gracefully", () => {
    // Start generating with no queued turns
    setGenerating(deps, session, true, "initial");

    // Should not throw
    setGenerating(deps, session, false, "stuck_auto_recovery");

    expect(session.isGenerating).toBe(false);
    expect(session.queuedTurnStarts).toBe(0);
  });

  it("runs the end-of-generation hook after turn teardown completes", () => {
    // WsBridge now hangs history-byte recompute and Codex image-stage cleanup
    // off the shared lifecycle hook instead of a local wrapper method.
    const onGenerationStopped = vi.fn();
    deps = makeDeps({ onGenerationStopped });
    deps.sessions.set(session.id, session);

    setGenerating(deps, session, true, "initial");
    setGenerating(deps, session, false, "result");

    expect(onGenerationStopped).toHaveBeenCalledWith(session, "result");
  });

  it("preserves explicit leader interrupt source when later system cleanup ends the turn", () => {
    setGenerating(deps, session, true, "initial");

    // A human/leader interrupt can be followed by disconnect cleanup before
    // the turn_end event is emitted. The explicit source should win.
    markTurnInterrupted(session, "leader");
    markTurnInterrupted(session, "system");
    setGenerating(deps, session, false, "cli_disconnect");

    expect(deps.emitTakodeEvent).toHaveBeenLastCalledWith(
      session.id,
      "turn_end",
      expect.objectContaining({ interrupted: true, interrupt_source: "leader" }),
    );
  });

  it("emits active quest-thread route metadata on turn_end before clearing turn state", () => {
    markRunningFromUserDispatch(deps, session, "user_message", null, 2, {
      threadKey: "q-941",
      questId: "q-941",
    });

    setGenerating(deps, session, false, "result");

    expect(deps.emitTakodeEvent).toHaveBeenLastCalledWith(
      session.id,
      "turn_end",
      expect.objectContaining({
        threadKey: "q-941",
        questId: "q-941",
      }),
    );
    expect(session.activeTurnRoute).toBeNull();
  });

  it("emits system interrupt source when no explicit human source was recorded", () => {
    setGenerating(deps, session, true, "initial");

    // Recovery-only interruptions should continue to surface as system so herd
    // summaries can distinguish them from human redirects.
    markTurnInterrupted(session, "system");
    setGenerating(deps, session, false, "cli_disconnect");

    expect(deps.emitTakodeEvent).toHaveBeenLastCalledWith(
      session.id,
      "turn_end",
      expect.objectContaining({ interrupted: true, interrupt_source: "system" }),
    );
  });

  it("emits restart-prep origin metadata without changing user interrupt semantics", () => {
    setGenerating(deps, session, true, "initial");

    session.restartPrepInterruptOrigin = "restart_prep";
    session.restartPrepInterruptOperationId = "prep-1";
    markTurnInterrupted(session, "user");
    setGenerating(deps, session, false, "interrupt");

    expect(deps.emitTakodeEvent).toHaveBeenLastCalledWith(
      session.id,
      "turn_end",
      expect.objectContaining({
        interrupted: true,
        interrupt_source: "user",
        interrupt_origin: "restart_prep",
        restart_prep_operation_id: "prep-1",
      }),
    );
    expect(session.restartPrepInterruptOrigin).toBeNull();
    expect(session.restartPrepInterruptOperationId).toBeNull();
  });
});

describe("runStuckSessionWatchdogSweep", () => {
  it("does not warn or recover stale pending Codex inputs for launcher-archived sessions", () => {
    // Archived sessions can keep old pendingCodexInputs for history/debugging,
    // but they are not recoverable live delivery work and should not log every sweep.
    const session = makeStuckWatchdogSession({
      pendingCodexInputs: [{ timestamp: 1 }],
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const requestCodexAutoRecovery = vi.fn();

    runStuckSessionWatchdogSweep(
      [session],
      120_000,
      makeStuckWatchdogDeps({
        requestCodexAutoRecovery,
        getLauncherSessionInfo: vi.fn(() => ({ archived: true })),
      }),
    );

    expect(warnSpy).not.toHaveBeenCalled();
    expect(requestCodexAutoRecovery).not.toHaveBeenCalled();
  });

  it("pokes stale connected-adapter pending delivery without relaunching", () => {
    const session = makeStuckWatchdogSession({
      pendingCodexInputs: [{ timestamp: 1 }],
      codexAdapter: { isConnected: () => true },
    });
    const pokeStaleCodexPendingDelivery = vi.fn(() => true);
    const requestCodexAutoRecovery = vi.fn();

    runStuckSessionWatchdogSweep(
      [session],
      120_000,
      makeStuckWatchdogDeps({
        requestCodexAutoRecovery,
        pokeStaleCodexPendingDelivery,
        getLauncherSessionInfo: vi.fn(() => ({})),
      }),
    );

    expect(pokeStaleCodexPendingDelivery).toHaveBeenCalledWith(session, "stuck_pending_delivery_connected_watchdog");
    expect(requestCodexAutoRecovery).not.toHaveBeenCalled();
  });

  it("does not poke connected-adapter pending delivery while the session is generating", () => {
    const session = makeStuckWatchdogSession({
      isGenerating: true,
      generationStartedAt: 1,
      pendingCodexInputs: [{ timestamp: 1 }],
      codexAdapter: { isConnected: () => true },
    });
    const pokeStaleCodexPendingDelivery = vi.fn(() => true);

    runStuckSessionWatchdogSweep(
      [session],
      120_000,
      makeStuckWatchdogDeps({
        pokeStaleCodexPendingDelivery,
        getLauncherSessionInfo: vi.fn(() => ({})),
      }),
    );

    expect(pokeStaleCodexPendingDelivery).not.toHaveBeenCalled();
  });
});

describe("RECOVERY_REASONS", () => {
  it("contains all expected recovery reasons", () => {
    expect(RECOVERY_REASONS.has("stuck_auto_recovery")).toBe(true);
    expect(RECOVERY_REASONS.has("system_init_reset")).toBe(true);
    expect(RECOVERY_REASONS.has("cli_disconnect")).toBe(true);
    expect(RECOVERY_REASONS.has("user_message_timeout")).toBe(true);
  });

  it("does not include 'result'", () => {
    // "result" is the normal end-of-turn reason — it should promote, not drain
    expect(RECOVERY_REASONS.has("result")).toBe(false);
  });
});
