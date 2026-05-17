import { describe, expect, it, vi } from "vitest";
import {
  collectStartupRecoveryReasons,
  requestStartupRecoveryRelaunch,
  runStartupRecovery,
  type StartupRecoveryLauncherSession,
  type StartupRecoverySession,
  type StartupRecoveryTimerManager,
} from "./startup-recovery.js";
import { RelaunchQueue } from "./relaunch-queue.js";

function userMessage(agentSource?: { sessionId: string; sessionLabel?: string }): string {
  return JSON.stringify({
    type: "user_message",
    content: "queued",
    ...(agentSource ? { agentSource } : {}),
  });
}

describe("startup-recovery", () => {
  it("requests relaunch for restart continuations and restored pending messages", async () => {
    // Restart-prep continuations are injected before startup recovery runs; this
    // verifies the recovery pass wakes an idle-killed backend without adding a
    // second continuation message.
    const launcherSessions: StartupRecoveryLauncherSession[] = [
      { sessionId: "worker-1", state: "exited", killedByIdleManager: true },
      { sessionId: "needs-permission", state: "exited", killedByIdleManager: true },
    ];
    const sessions = new Map<string, StartupRecoverySession>([
      ["worker-1", { pendingMessages: [userMessage({ sessionId: "system:restart-continuation:prep-1" })] }],
      ["needs-permission", { pendingPermissions: { size: 1 } }],
    ]);
    const requestCliRelaunch = vi.fn();

    const result = await runStartupRecovery({
      listLauncherSessions: () => launcherSessions,
      getSession: (sessionId) => sessions.get(sessionId),
      isBackendConnected: () => false,
      requestCliRelaunch,
      restartContinuationSessionIds: ["worker-1"],
    });

    expect(requestCliRelaunch).toHaveBeenCalledWith("worker-1");
    expect(requestCliRelaunch).toHaveBeenCalledTimes(1);
    expect(launcherSessions[0].killedByIdleManager).toBe(false);
    expect(launcherSessions[1].killedByIdleManager).toBe(true);
    expect(result.recovered).toEqual([
      {
        sessionId: "worker-1",
        reasons: ["restart_continuation", "pending_messages"],
        requestedRelaunch: true,
        clearedIdleKilled: true,
      },
    ]);
  });

  it("skips restart continuations that already requested relaunch during startup injection", async () => {
    // Restart-continuation injection can request a relaunch before startup
    // recovery scans restored sessions. The recovery pass must not request the
    // same relaunch again, because RelaunchQueue would treat that as trailing
    // work instead of a harmless duplicate.
    const launcherSessions = [{ sessionId: "worker-1", state: "exited" }];
    const sessions = new Map<string, StartupRecoverySession>([
      ["worker-1", { pendingMessages: [userMessage({ sessionId: "system:restart-continuation:prep-1" })] }],
    ]);
    const requestCliRelaunch = vi.fn();

    const result = await runStartupRecovery({
      listLauncherSessions: () => launcherSessions,
      getSession: (sessionId) => sessions.get(sessionId),
      isBackendConnected: () => false,
      requestCliRelaunch,
      restartContinuationSessionIds: ["worker-1"],
      alreadyRequestedRelaunchSessionIds: ["worker-1"],
    });

    expect(requestCliRelaunch).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([
      {
        sessionId: "worker-1",
        reasons: ["restart_continuation", "pending_messages"],
        requestedRelaunch: false,
        clearedIdleKilled: false,
        skippedReason: "relaunch_already_requested",
      },
    ]);
  });

  it("does not relaunch paused sessions with restored pending work", async () => {
    const launcherSessions = [{ sessionId: "worker-1", state: "exited" }];
    const sessions = new Map<string, StartupRecoverySession>([
      ["worker-1", { pendingMessages: [userMessage({ sessionId: "herd-events", sessionLabel: "Herd Events" })] }],
    ]);
    const requestCliRelaunch = vi.fn();

    const result = await runStartupRecovery({
      listLauncherSessions: () => launcherSessions,
      getSession: (sessionId) => sessions.get(sessionId),
      isBackendConnected: () => false,
      isSessionPaused: (sessionId) => sessionId === "worker-1",
      requestCliRelaunch,
    });

    expect(requestCliRelaunch).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([
      {
        sessionId: "worker-1",
        reasons: ["pending_messages", "pending_herd_delivery"],
        requestedRelaunch: false,
        clearedIdleKilled: false,
        skippedReason: "session_paused",
      },
    ]);
  });

  it("recognizes durable queued herd delivery without requiring the raw in-memory herd inbox", () => {
    // Raw HerdEventDispatcher inbox entries are not durable, but once a herd
    // batch has become a queued user message or Codex pending input, startup
    // recovery can safely resume that persisted delivery.
    expect(
      collectStartupRecoveryReasons({
        pendingMessages: [userMessage({ sessionId: "herd-events", sessionLabel: "Herd Events" })],
      }),
    ).toContain("pending_herd_delivery");

    expect(
      collectStartupRecoveryReasons({
        pendingCodexInputs: [{ id: "u1", agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" } }],
        pendingCodexTurns: [{ status: "queued", userMessageId: "u1" }],
      }),
    ).toEqual(expect.arrayContaining(["pending_codex_inputs", "pending_codex_turns", "pending_herd_delivery"]));
  });

  it("fires due timers during startup recovery and does not repeat them after they are no longer due", async () => {
    // Due timer sessions are captured before the immediate sweep, so the
    // backend gets relaunched even when the timer itself is removed during the
    // same startup pass. A second pass has no work and no duplicate wakeup.
    let dueTimerSessionIds = ["timer-session"];
    const timerManager: StartupRecoveryTimerManager = {
      getDueTimerSessionIds: vi.fn(() => dueTimerSessionIds),
      sweepDueTimersNow: vi.fn(async () => {
        const fired = dueTimerSessionIds.map((sessionId) => ({
          sessionId,
          timerId: "t1",
          delivery: "queued" as const,
        }));
        dueTimerSessionIds = [];
        return { fired, skipped: [] };
      }),
    };
    const requestCliRelaunch = vi.fn();
    const launcherSessions = [{ sessionId: "timer-session", state: "exited" }];
    const sessions = new Map<string, StartupRecoverySession>([["timer-session", {}]]);

    const first = await runStartupRecovery({
      listLauncherSessions: () => launcherSessions,
      getSession: (sessionId) => sessions.get(sessionId),
      isBackendConnected: () => false,
      requestCliRelaunch,
      timerManager,
      now: 1000,
    });
    const second = await runStartupRecovery({
      listLauncherSessions: () => launcherSessions,
      getSession: (sessionId) => sessions.get(sessionId),
      isBackendConnected: () => false,
      requestCliRelaunch,
      timerManager,
      now: 1000,
    });

    expect(first.recovered).toEqual([
      {
        sessionId: "timer-session",
        reasons: ["due_timer"],
        requestedRelaunch: true,
        clearedIdleKilled: false,
      },
    ]);
    expect(first.timerSweep?.fired).toHaveLength(1);
    expect(second.recovered).toHaveLength(0);
    expect(second.timerSweep?.fired).toHaveLength(0);
    expect(requestCliRelaunch).toHaveBeenCalledTimes(1);
  });

  it("does not queue a trailing relaunch when due-timer injection already requested one", async () => {
    // This covers the real queue behavior behind the mental-simulation
    // challenge: a second request while the first relaunch is in flight would
    // enqueue a trailing relaunch and run the backend again after cooldown.
    vi.useFakeTimers();
    try {
      let finishRelaunch!: () => void;
      const firstRelaunch = new Promise<void>((resolve) => {
        finishRelaunch = resolve;
      });
      const runRelaunch = vi.fn(() => firstRelaunch);
      const relaunchQueue = new RelaunchQueue(runRelaunch, 10);
      const alreadyRequested = new Set<string>();
      const requestCliRelaunch = vi.fn((sessionId: string) => {
        alreadyRequested.add(sessionId);
        relaunchQueue.request(sessionId);
      });
      const timerManager: StartupRecoveryTimerManager = {
        getDueTimerSessionIds: vi.fn(() => ["timer-session"]),
        sweepDueTimersNow: vi.fn(async () => {
          requestCliRelaunch("timer-session");
          return {
            fired: [{ sessionId: "timer-session", timerId: "t1", delivery: "queued" as const }],
            skipped: [],
          };
        }),
      };

      const result = await runStartupRecovery({
        listLauncherSessions: () => [{ sessionId: "timer-session", state: "exited" }],
        getSession: (sessionId) => (sessionId === "timer-session" ? {} : undefined),
        isBackendConnected: () => false,
        requestCliRelaunch,
        timerManager,
        alreadyRequestedRelaunchSessionIds: alreadyRequested,
        now: 1000,
      });

      expect(requestCliRelaunch).toHaveBeenCalledTimes(1);
      expect(runRelaunch).toHaveBeenCalledTimes(1);
      expect(result.recovered).toEqual([
        {
          sessionId: "timer-session",
          reasons: ["due_timer"],
          requestedRelaunch: false,
          clearedIdleKilled: false,
          skippedReason: "relaunch_already_requested",
        },
      ]);

      finishRelaunch();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(11);

      expect(runRelaunch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not relaunch pending-permission-only or already connected sessions", async () => {
    // Pending permissions may need user action, but q-952 explicitly excludes
    // permission-only blockers from automatic resume. Connected sessions also
    // do not need a startup relaunch even if durable queues are present.
    const launcherSessions = [
      { sessionId: "permission-only", state: "exited" },
      { sessionId: "connected-with-queue", state: "connected" },
    ];
    const sessions = new Map<string, StartupRecoverySession>([
      ["permission-only", { pendingPermissions: { size: 1 } }],
      ["connected-with-queue", { pendingMessages: [userMessage()] }],
    ]);
    const requestCliRelaunch = vi.fn();

    const result = await runStartupRecovery({
      listLauncherSessions: () => launcherSessions,
      getSession: (sessionId) => sessions.get(sessionId),
      isBackendConnected: (sessionId) => sessionId === "connected-with-queue",
      requestCliRelaunch,
    });

    expect(requestCliRelaunch).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([
      {
        sessionId: "connected-with-queue",
        reasons: ["pending_messages"],
        requestedRelaunch: false,
        clearedIdleKilled: false,
        skippedReason: "already_connected",
      },
    ]);
  });

  it("requests bounded startup relaunch for newest active dead Codex sessions", async () => {
    const launcherSessions: StartupRecoveryLauncherSession[] = [
      {
        sessionId: "old-codex",
        backendType: "codex",
        state: "exited",
        exitCode: -1,
        createdAt: 1,
        lastActivityAt: 10,
      },
      {
        sessionId: "new-codex",
        backendType: "codex",
        state: "exited",
        exitCode: -1,
        createdAt: 2,
        lastActivityAt: 30,
      },
      {
        sessionId: "middle-codex",
        backendType: "codex",
        state: "exited",
        exitCode: -1,
        createdAt: 3,
        lastActivityAt: 20,
      },
    ];
    const sessions = new Map<string, StartupRecoverySession>(
      launcherSessions.map((session) => [
        session.sessionId,
        { backendType: "codex", state: { backend_state: "disconnected" } },
      ]),
    );
    const requestCliRelaunch = vi.fn();

    const result = await runStartupRecovery({
      listLauncherSessions: () => launcherSessions,
      getSession: (sessionId) => sessions.get(sessionId),
      isBackendConnected: () => false,
      requestCliRelaunch,
      activeRecoveryLimit: 2,
      activeRecoverySpacingMs: 250,
    });

    expect(requestCliRelaunch).toHaveBeenCalledTimes(2);
    expect(requestCliRelaunch).toHaveBeenNthCalledWith(1, "new-codex", {
      delayMs: 0,
      reason: "active_dead_backend",
    });
    expect(requestCliRelaunch).toHaveBeenNthCalledWith(2, "middle-codex", {
      delayMs: 250,
      reason: "active_dead_backend",
    });
    expect(result.recovered).toEqual([
      {
        sessionId: "new-codex",
        reasons: ["active_dead_backend"],
        requestedRelaunch: true,
        clearedIdleKilled: false,
      },
      {
        sessionId: "middle-codex",
        reasons: ["active_dead_backend"],
        requestedRelaunch: true,
        requestedRelaunchDelayMs: 250,
        clearedIdleKilled: false,
      },
    ]);
  });

  it("excludes inactive or suppressed dead Codex sessions from startup active recovery", async () => {
    const launcherSessions: StartupRecoveryLauncherSession[] = [
      { sessionId: "idle-killed", backendType: "codex", state: "exited", exitCode: -1, killedByIdleManager: true },
      { sessionId: "paused", backendType: "codex", state: "exited", exitCode: -1 },
      { sessionId: "suppressed", backendType: "codex", state: "exited", exitCode: -1 },
      { sessionId: "claude", backendType: "claude", state: "exited", exitCode: -1 },
      { sessionId: "clean-exit", backendType: "codex", state: "exited", exitCode: 0 },
    ];
    const sessions = new Map<string, StartupRecoverySession>([
      ["idle-killed", { backendType: "codex", state: { backend_state: "disconnected" } }],
      ["paused", { backendType: "codex", state: { backend_state: "disconnected" } }],
      ["suppressed", { backendType: "codex", state: { backend_state: "recovery_suppressed" } }],
      ["claude", { backendType: "claude", state: { backend_state: "disconnected" } }],
      ["clean-exit", { backendType: "codex", state: { backend_state: "disconnected" } }],
    ]);
    const requestCliRelaunch = vi.fn();

    const result = await runStartupRecovery({
      listLauncherSessions: () => launcherSessions,
      getSession: (sessionId) => sessions.get(sessionId),
      isBackendConnected: () => false,
      isSessionPaused: (sessionId) => sessionId === "paused",
      requestCliRelaunch,
      activeRecoveryLimit: 10,
    });

    expect(requestCliRelaunch).not.toHaveBeenCalled();
    expect(result.recovered).toEqual([]);
  });

  it("revalidates delayed active-dead recovery before requesting recovery", () => {
    vi.useFakeTimers();
    try {
      const launcherSessions = new Map<string, StartupRecoveryLauncherSession>([
        ["connected", { sessionId: "connected", backendType: "codex", state: "exited", exitCode: -1 }],
        ["paused", { sessionId: "paused", backendType: "codex", state: "exited", exitCode: -1 }],
      ]);
      const sessions = new Map<string, StartupRecoverySession>([
        ["connected", { backendType: "codex", state: { backend_state: "disconnected" } }],
        ["paused", { backendType: "codex", state: { backend_state: "disconnected" } }],
      ]);
      const requestCodexAutoRecovery = vi.fn(() => true);
      const requestCliRelaunch = vi.fn();
      const connected = new Set<string>();
      const paused = new Set<string>();

      const deps = {
        getLauncherSession: (sessionId: string) => launcherSessions.get(sessionId),
        getSession: (sessionId: string) => sessions.get(sessionId),
        isBackendConnected: (sessionId: string) => connected.has(sessionId),
        isBackendAttached: (sessionId: string) => connected.has(sessionId),
        isSessionPaused: (sessionId: string) => paused.has(sessionId),
        requestCodexAutoRecovery,
        requestCliRelaunch,
      };

      requestStartupRecoveryRelaunch("connected", { delayMs: 250, reason: "active_dead_backend" }, deps);
      requestStartupRecoveryRelaunch("paused", { delayMs: 250, reason: "active_dead_backend" }, deps);

      connected.add("connected");
      paused.add("paused");
      vi.advanceTimersByTime(250);

      expect(requestCodexAutoRecovery).not.toHaveBeenCalled();
      expect(requestCliRelaunch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
