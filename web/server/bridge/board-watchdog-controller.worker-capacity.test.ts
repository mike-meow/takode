import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _flushForTest, _resetForTest, updateSettings } from "../settings-manager.js";
import {
  getBoardQueueWarnings,
  getBoardWorkerSlotUsage,
  sweepBoardDispatchableWarnings,
  sweepBoardStallWarnings,
} from "./board-watchdog-controller.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "board-worker-capacity-test-"));
  _resetForTest(join(tempDir, "settings.json"));
});

afterEach(async () => {
  await _flushForTest();
  await rm(tempDir, { recursive: true, force: true });
  _resetForTest();
});

describe("board worker capacity", () => {
  it("reports active worker-owned board demand with the configured limit", () => {
    // Board capacity should ignore stale raw herded workers and use the
    // configured limit that leaders see in CLI and prompt guidance.
    updateSettings({ takodeWorkerConcurrency: 10 });
    const leader = {
      id: "leader-1",
      board: new Map([
        ["q-1", { questId: "q-1", status: "IMPLEMENTING" }],
        ["q-2", { questId: "q-2", status: "CODE_REVIEWING" }],
        ["q-3", { questId: "q-3", status: "MEMORY" }],
      ]),
    };

    const usage = getBoardWorkerSlotUsage("leader-1", {
      getSession: (sessionId: string) => (sessionId === "leader-1" ? leader : undefined),
      listSessions: () => [
        { sessionId: "worker-1", herdedBy: "leader-1", archived: false },
        { sessionId: "worker-2", herdedBy: "leader-1", archived: false },
        { sessionId: "reviewer-1", herdedBy: "leader-1", archived: false, reviewerOf: 7 },
      ],
    });

    expect(usage).toEqual({ used: 2, limit: 10 });
  });

  it("surfaces archived queued-worker assignments as dispatchable reassignment guidance", () => {
    // A queued row can be unblocked by free capacity while still pointing at an
    // archived worker. The watchdog should detect that stale assignment and
    // guide the leader to the existing replacement/reassignment commands.
    updateSettings({ takodeWorkerConcurrency: 10 });
    const row = {
      questId: "q-122",
      title: "Queued quest",
      status: "QUEUED",
      worker: "archived-worker",
      workerNum: 367,
      waitFor: ["free-worker"],
      createdAt: 1,
      updatedAt: 1,
    };
    const leader = {
      id: "leader-1",
      board: new Map([["q-122", row]]),
    };
    const deps = {
      getLauncherSessionInfo: (sessionId: string) =>
        sessionId === "archived-worker" ? { archived: true, sessionNum: 367, lastActivityAt: 1 } : {},
      getSession: vi.fn(),
      listSessions: () => [{ sessionId: "archived-worker", sessionNum: 367, herdedBy: "leader-1", archived: true }],
      resolveSessionId: vi.fn(),
      timerCount: vi.fn(() => 0),
      backendConnected: vi.fn(() => false),
      getBoard: vi.fn(() => [row]),
      notifyUser: vi.fn(),
      emitTakodeEvent: vi.fn(),
      markNotificationDone: vi.fn(),
      isSessionIdle: vi.fn(() => true),
    };

    const warnings = getBoardQueueWarnings(leader, deps);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.summary).toContain("assigned worker is missing");
    expect(warnings[0]?.summary).toContain("worker slots are available (0/10 active demand)");
    expect(warnings[0]?.action).toContain("takode spawn --replace-worktree-worker #367");
    expect(warnings[0]?.action).toContain("takode board set q-122 --worker <session>");
  });

  it("automatically kicks source-less dispatchable free-worker rows to the leader", () => {
    // Source-less rows used to require manual board inspection. The watchdog now
    // injects a leader-owned nudge once per live dispatchable signature so the
    // leader wakes up and can dispatch or reassign through existing primitives.
    updateSettings({ takodeWorkerConcurrency: 10 });
    const row = {
      questId: "q-122",
      title: "Queued quest",
      status: "QUEUED",
      waitFor: ["free-worker"],
      createdAt: 1,
      updatedAt: 1,
    };
    const leader = {
      id: "leader-1",
      board: new Map([["q-122", row]]),
      boardDispatchStates: new Map(),
    };
    const injectLeaderDispatchNudge = vi.fn();
    const deps = {
      getLauncherSessionInfo: (sessionId: string) => (sessionId === "leader-1" ? { isOrchestrator: true } : {}),
      getSession: vi.fn(),
      listSessions: () => [],
      resolveSessionId: vi.fn(),
      timerCount: vi.fn(() => 0),
      backendConnected: vi.fn(() => false),
      getBoard: vi.fn(() => [row]),
      notifyUser: vi.fn(() => ({ ok: true as const, notificationId: "n-1", anchoredMessageId: null })),
      emitTakodeEvent: vi.fn(),
      injectLeaderDispatchNudge,
      markNotificationDone: vi.fn(),
      isSessionIdle: vi.fn(() => true),
    };

    sweepBoardDispatchableWarnings([leader], Date.now(), deps);
    sweepBoardDispatchableWarnings([leader], Date.now() + 1_000, deps);

    expect(injectLeaderDispatchNudge).toHaveBeenCalledTimes(1);
    expect(injectLeaderDispatchNudge).toHaveBeenCalledWith(
      "leader-1",
      expect.objectContaining({
        questId: "q-122",
        summary: expect.stringContaining("q-122 can be dispatched now"),
        action: expect.stringContaining("Dispatch it now"),
      }),
    );
  });

  it("automatically kicks active stalled rows assigned to missing workers to the leader", () => {
    // Active approved phases can also lose their worker when an assigned worker
    // is archived. The stall watchdog should wake the leader directly instead
    // of emitting only to a missing worker source.
    const row = {
      questId: "q-122",
      title: "Active quest",
      status: "IMPLEMENTING",
      workerNum: 367,
      createdAt: 1,
      updatedAt: 1,
    };
    const leader = {
      id: "leader-1",
      board: new Map([["q-122", row]]),
      boardStallStates: new Map(),
    };
    const injectLeaderStallNudge = vi.fn();
    const emitTakodeEvent = vi.fn();
    const deps = {
      getLauncherSessionInfo: (sessionId: string) => (sessionId === "leader-1" ? { isOrchestrator: true } : {}),
      getSession: vi.fn(),
      listSessions: () => [{ sessionId: "archived-worker", sessionNum: 367, herdedBy: "leader-1", archived: true }],
      resolveSessionId: vi.fn(),
      timerCount: vi.fn(() => 0),
      backendConnected: vi.fn(() => false),
      getBoard: vi.fn(() => [row]),
      notifyUser: vi.fn(),
      emitTakodeEvent,
      injectLeaderStallNudge,
      markNotificationDone: vi.fn(),
      isSessionIdle: vi.fn(() => true),
    };

    sweepBoardStallWarnings([leader], 10_000, deps);
    sweepBoardStallWarnings([leader], 10_000 + 3 * 60_000 + 1, deps);
    sweepBoardStallWarnings([leader], 10_000 + 4 * 60_000, deps);

    expect(emitTakodeEvent).not.toHaveBeenCalled();
    expect(injectLeaderStallNudge).toHaveBeenCalledTimes(1);
    expect(injectLeaderStallNudge).toHaveBeenCalledWith(
      "leader-1",
      expect.objectContaining({
        questId: "q-122",
        stage: "IMPLEMENTING",
        reason: "worker missing",
        action: expect.stringContaining("takode spawn --replace-worktree-worker #367"),
      }),
    );
  });
});
