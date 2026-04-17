import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionTimerFile } from "./timer-types.js";

// ─── Mock store state (module-level, shared by mock and tests) ───────────────

const mockFiles = new Map<string, SessionTimerFile>();

// Mock the timer-store module so tests don't touch disk.
vi.mock("./timer-store.js", () => ({
  loadTimers: vi.fn(async (sessionId: string) => {
    return mockFiles.get(sessionId) ?? { sessionId, nextId: 1, timers: [] };
  }),
  saveTimers: vi.fn(async (data: SessionTimerFile) => {
    mockFiles.set(data.sessionId, JSON.parse(JSON.stringify(data)));
  }),
  deleteTimers: vi.fn(async (sessionId: string) => {
    mockFiles.delete(sessionId);
  }),
  listTimerSessions: vi.fn(async () => [...mockFiles.keys()]),
  getTimerDir: vi.fn(() => "/tmp/mock-timers"),
}));

// Import after mock so the mock is in effect.
import { TimerManager } from "./timer-manager.js";

function createMockBridge() {
  return {
    injectUserMessage: vi.fn(() => "sent" as const),
    broadcastToSession: vi.fn(),
  } as any;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TimerManager", () => {
  let bridge: ReturnType<typeof createMockBridge>;
  let manager: TimerManager;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-04-08T12:00:00Z") });
    mockFiles.clear();
    bridge = createMockBridge();
    manager = new TimerManager(bridge);
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe("createTimer", () => {
    it("creates a one-shot delay timer", async () => {
      const timer = await manager.createTimer("session-1", {
        title: "check the build",
        description: "Inspect the latest failing shard if the build is red.",
        in: "30m",
      });

      expect(timer.id).toBe("t1");
      expect(timer.type).toBe("delay");
      expect(timer.title).toBe("check the build");
      expect(timer.description).toBe("Inspect the latest failing shard if the build is red.");
      expect(timer.nextFireAt).toBe(Date.now() + 1_800_000);
      expect(timer.fireCount).toBe(0);
    });

    it("creates a recurring timer", async () => {
      const timer = await manager.createTimer("session-1", {
        title: "refresh context",
        every: "10m",
      });

      expect(timer.id).toBe("t1");
      expect(timer.type).toBe("recurring");
      expect(timer.intervalMs).toBe(600_000);
    });

    it("increments timer IDs", async () => {
      const t1 = await manager.createTimer("session-1", { title: "a", in: "5m" });
      const t2 = await manager.createTimer("session-1", { title: "b", in: "10m" });
      const t3 = await manager.createTimer("session-1", { title: "c", every: "15m" });

      expect(t1.id).toBe("t1");
      expect(t2.id).toBe("t2");
      expect(t3.id).toBe("t3");
    });

    it("broadcasts timer update to browsers", async () => {
      await manager.createTimer("session-1", { title: "test", in: "5m" });

      expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", {
        type: "timer_update",
        timers: expect.arrayContaining([expect.objectContaining({ id: "t1" })]),
      });
    });

    it("rejects empty title", async () => {
      await expect(manager.createTimer("session-1", { title: "", in: "5m" })).rejects.toThrow("title is required");
    });

    it("rejects when timer limit is reached", async () => {
      // Create 50 timers (the max)
      for (let i = 0; i < 50; i++) {
        await manager.createTimer("session-1", { title: `timer ${i}`, in: "30m" });
      }
      // The 51st should be rejected
      await expect(manager.createTimer("session-1", { title: "one too many", in: "5m" })).rejects.toThrow(
        "Timer limit reached",
      );
    });
  });

  describe("cancelTimer", () => {
    it("removes a timer", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      const cancelled = await manager.cancelTimer("session-1", "t1");

      expect(cancelled).toBe(true);
      expect(manager.listTimers("session-1")).toHaveLength(0);
    });

    it("returns false for non-existent timer", async () => {
      const cancelled = await manager.cancelTimer("session-1", "t99");
      expect(cancelled).toBe(false);
    });

    it("broadcasts after cancel", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      bridge.broadcastToSession.mockClear();

      await manager.cancelTimer("session-1", "t1");

      expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", {
        type: "timer_update",
        timers: [],
      });
    });

    it("injects a cancellation message into the session", async () => {
      await manager.createTimer("session-1", {
        title: "check the build",
        description: "Inspect the latest failing shard if the build is red.",
        in: "5m",
      });
      bridge.injectUserMessage.mockClear();

      await manager.cancelTimer("session-1", "t1");

      expect(bridge.injectUserMessage).toHaveBeenCalledWith("session-1", "[⏰ Timer t1 cancelled] check the build", {
        sessionId: "timer:t1",
        sessionLabel: "Timer t1",
      });
    });
  });

  describe("listTimers", () => {
    it("returns empty array for unknown session", () => {
      expect(manager.listTimers("unknown")).toEqual([]);
    });

    it("returns all timers for a session", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      await manager.createTimer("session-1", { title: "b", every: "10m" });

      const timers = manager.listTimers("session-1");
      expect(timers).toHaveLength(2);
    });
  });

  describe("cancelAllTimers", () => {
    it("removes all timers for a session", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      await manager.createTimer("session-1", { title: "b", every: "10m" });

      await manager.cancelAllTimers("session-1");

      expect(manager.listTimers("session-1")).toHaveLength(0);
    });

    it("broadcasts empty timer list", async () => {
      await manager.createTimer("session-1", { title: "a", in: "5m" });
      bridge.broadcastToSession.mockClear();

      await manager.cancelAllTimers("session-1");

      expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", {
        type: "timer_update",
        timers: [],
      });
    });
  });

  describe("sweep (firing timers)", () => {
    /** Access the private sweep method for direct testing without waiting for setInterval. */
    async function triggerSweep(mgr: TimerManager) {
      await (mgr as any).sweep();
    }

    it("fires a one-shot delay timer when due", async () => {
      await manager.createTimer("session-1", {
        title: "do something",
        description: "Open the latest incident thread and summarize the blocker.",
        in: "5m",
      });

      // Advance time past the timer's fire time
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).toHaveBeenCalledWith(
        "session-1",
        "[⏰ Timer t1] do something\n\nOpen the latest incident thread and summarize the blocker.",
        {
          sessionId: "timer:t1",
          sessionLabel: "Timer t1",
        },
      );
      // One-shot should be removed after firing
      expect(manager.listTimers("session-1")).toHaveLength(0);
    });

    it("fires a recurring timer and advances nextFireAt", async () => {
      await manager.createTimer("session-1", { title: "ping", every: "10m" });

      // First fire
      vi.advanceTimersByTime(10 * 60_000 + 1);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
      // Recurring timer should still exist
      const timers = manager.listTimers("session-1");
      expect(timers).toHaveLength(1);
      expect(timers[0].fireCount).toBe(1);
      expect(timers[0].nextFireAt).toBeGreaterThan(Date.now());

      // Second fire
      bridge.injectUserMessage.mockClear();
      vi.advanceTimersByTime(10 * 60_000);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
      expect(manager.listTimers("session-1")[0].fireCount).toBe(2);
    });

    it("does not fire a timer before its time", async () => {
      await manager.createTimer("session-1", { title: "not yet", in: "30m" });

      vi.advanceTimersByTime(5 * 60_000); // Only 5 minutes
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).not.toHaveBeenCalled();
      expect(manager.listTimers("session-1")).toHaveLength(1);
    });

    it("handles recurring catchup (fires once, skips missed intervals)", async () => {
      await manager.createTimer("session-1", { title: "check", every: "10m" });

      // Advance 35 minutes (missed 3 intervals)
      vi.advanceTimersByTime(35 * 60_000 + 1);
      await triggerSweep(manager);

      // Should fire exactly once
      expect(bridge.injectUserMessage).toHaveBeenCalledTimes(1);
      // nextFireAt should be advanced past "now"
      const timers = manager.listTimers("session-1");
      expect(timers[0].nextFireAt).toBeGreaterThan(Date.now());
      expect(timers[0].fireCount).toBe(1);
    });

    it("cancelled timer never fires", async () => {
      await manager.createTimer("session-1", { title: "bye", in: "5m" });
      await manager.cancelTimer("session-1", "t1");

      // Clear mock after cancelTimer's notification, then verify sweep doesn't fire
      bridge.injectUserMessage.mockClear();
      vi.advanceTimersByTime(10 * 60_000);
      await triggerSweep(manager);

      expect(bridge.injectUserMessage).not.toHaveBeenCalled();
    });

    it("does not reuse timer IDs after all timers fire and are removed", async () => {
      // Create two one-shot timers: t1 and t2
      await manager.createTimer("session-1", { title: "first", in: "5m" });
      await manager.createTimer("session-1", { title: "second", in: "10m" });

      // Fire both timers (sweep removes one-shot timers after firing)
      vi.advanceTimersByTime(15 * 60_000);
      await triggerSweep(manager);

      // All timers should be gone from memory
      expect(manager.listTimers("session-1")).toHaveLength(0);

      // Creating a new timer should NOT reuse t1 -- nextId should have been
      // preserved on disk even though the session was evicted from memory
      const t3 = await manager.createTimer("session-1", { title: "third", in: "5m" });
      expect(t3.id).toBe("t3");
    });
  });

  describe("startAll (server restart recovery)", () => {
    it("loads timers from disk on startup", async () => {
      // Pre-populate the mock store with saved timer data
      mockFiles.set("session-saved", {
        sessionId: "session-saved",
        nextId: 2,
        timers: [
          {
            id: "t1",
            sessionId: "session-saved",
            title: "restored timer",
            description: "restore detail",
            type: "recurring",
            originalSpec: "10m",
            nextFireAt: Date.now() + 600_000,
            intervalMs: 600_000,
            createdAt: Date.now() - 3_600_000,
            fireCount: 5,
          },
        ],
      });

      await manager.startAll();

      const timers = manager.listTimers("session-saved");
      expect(timers).toHaveLength(1);
      expect(timers[0].title).toBe("restored timer");
    });
  });
});
