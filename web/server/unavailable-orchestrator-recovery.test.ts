import { describe, expect, it, vi } from "vitest";
import {
  createUnavailableOrchestratorRecoveryWake,
  shouldWakeUnavailableOrchestratorForPendingEvents,
} from "./unavailable-orchestrator-recovery.js";

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "leader-1",
    backendType: "codex",
    state: { backend_state: "disconnected" },
    isGenerating: false,
    ...overrides,
  };
}

function makeDeps(info: Record<string, unknown> | undefined = { isOrchestrator: true, state: "exited" }) {
  return {
    getLauncherSessionInfo: vi.fn(() => info),
  };
}

describe("shouldWakeUnavailableOrchestratorForPendingEvents", () => {
  it("allows unavailable orchestrator sessions with no attached backend", () => {
    expect(shouldWakeUnavailableOrchestratorForPendingEvents(makeSession(), makeDeps())).toBe(true);
  });

  it("does not wake ordinary workers", () => {
    expect(
      shouldWakeUnavailableOrchestratorForPendingEvents(
        makeSession(),
        makeDeps({ isOrchestrator: false, state: "exited" }),
      ),
    ).toBe(false);
  });

  it("does not wake archived or idle-manager-killed leaders", () => {
    expect(
      shouldWakeUnavailableOrchestratorForPendingEvents(
        makeSession(),
        makeDeps({ isOrchestrator: true, state: "exited", archived: true }),
      ),
    ).toBe(false);
    expect(
      shouldWakeUnavailableOrchestratorForPendingEvents(
        makeSession(),
        makeDeps({ isOrchestrator: true, state: "exited", killedByIdleManager: true }),
      ),
    ).toBe(false);
  });

  it("does not wake healthy attached or actively generating leaders", () => {
    expect(shouldWakeUnavailableOrchestratorForPendingEvents(makeSession({ codexAdapter: {} }), makeDeps())).toBe(
      false,
    );
    expect(shouldWakeUnavailableOrchestratorForPendingEvents(makeSession({ isGenerating: true }), makeDeps())).toBe(
      false,
    );
  });

  it("does not wake broken sessions", () => {
    expect(
      shouldWakeUnavailableOrchestratorForPendingEvents(
        makeSession({ state: { backend_state: "broken" } }),
        makeDeps(),
      ),
    ).toBe(false);
  });
});

describe("createUnavailableOrchestratorRecoveryWake", () => {
  it("dedupes recovery requests until the guard timeout clears", () => {
    vi.useFakeTimers();
    const requestCodexAutoRecovery = vi.fn(() => true);
    const wake = createUnavailableOrchestratorRecoveryWake({
      getSession: () => makeSession(),
      getLauncherSessionInfo: () => ({ isOrchestrator: true, state: "exited" }),
      requestCodexAutoRecovery,
      recoveryDedupeMs: 1000,
    });

    expect(wake("leader-1", "pending_herd_event_dead_backend")).toBe(true);
    expect(wake("leader-1", "pending_herd_event_dead_backend")).toBe(false);
    expect(requestCodexAutoRecovery).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);

    expect(wake("leader-1", "pending_herd_event_dead_backend")).toBe(true);
    expect(requestCodexAutoRecovery).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("uses the existing relaunch callback for non-Codex leaders", () => {
    const requestCliRelaunch = vi.fn();
    const wake = createUnavailableOrchestratorRecoveryWake({
      getSession: () => makeSession({ backendType: "claude-sdk" }),
      getLauncherSessionInfo: () => ({ isOrchestrator: true, state: "exited" }),
      requestCodexAutoRecovery: vi.fn(() => false),
      requestCliRelaunch,
    });

    expect(wake("leader-1", "pending_herd_event_dead_backend")).toBe(true);
    expect(requestCliRelaunch).toHaveBeenCalledWith("leader-1");
  });
});
