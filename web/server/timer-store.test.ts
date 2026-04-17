import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTimers, saveTimers, deleteTimers, listTimerSessions } from "./timer-store.js";
import type { SessionTimerFile } from "./timer-types.js";

// Use a temp directory to isolate tests from the real timer store.
// We test the functions against real filesystem to validate I/O patterns,
// but we need to mock the directory. Since timer-store uses a module-level
// const for TIMER_DIR, we test via the public API which hits the real dir.
// For isolation, we use unique session IDs per test.

const TEST_PREFIX = `timer-store-test-${Date.now()}`;

function testId(suffix: string): string {
  return `${TEST_PREFIX}-${suffix}`;
}

describe("timer-store", () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    // Clean up any timer files created during tests
    for (const id of createdIds) {
      await deleteTimers(id);
    }
    createdIds.length = 0;
  });

  describe("loadTimers", () => {
    it("returns empty file struct for non-existent session", async () => {
      const id = testId("nonexistent");
      const result = await loadTimers(id);
      expect(result).toEqual({ sessionId: id, nextId: 1, timers: [] });
    });

    it("loads saved timers", async () => {
      const id = testId("load");
      createdIds.push(id);

      const data: SessionTimerFile = {
        sessionId: id,
        nextId: 3,
        timers: [
          {
            id: "t1",
            sessionId: id,
            title: "check build",
            description: "inspect latest failing jobs",
            type: "delay",
            originalSpec: "30m",
            nextFireAt: Date.now() + 1_800_000,
            createdAt: Date.now(),
            fireCount: 0,
          },
          {
            id: "t2",
            sessionId: id,
            title: "ping",
            description: "",
            type: "recurring",
            originalSpec: "10m",
            nextFireAt: Date.now() + 600_000,
            intervalMs: 600_000,
            createdAt: Date.now(),
            fireCount: 2,
            lastFiredAt: Date.now() - 600_000,
          },
        ],
      };

      await saveTimers(data);
      const loaded = await loadTimers(id);

      expect(loaded.sessionId).toBe(id);
      expect(loaded.nextId).toBe(3);
      expect(loaded.timers).toHaveLength(2);
      expect(loaded.timers[0].id).toBe("t1");
      expect(loaded.timers[1].id).toBe("t2");
      expect(loaded.timers[1].intervalMs).toBe(600_000);
      expect(loaded.timers[0].description).toBe("inspect latest failing jobs");
    });

    it("normalizes legacy prompt-only timers into title and description", async () => {
      // Older timer files stored one dense prompt field; loading should migrate
      // them into the new human-scannable title + description shape.
      const id = testId("legacy-prompt");
      createdIds.push(id);

      const legacyData = {
        sessionId: id,
        nextId: 2,
        timers: [
          {
            id: "t1",
            sessionId: id,
            prompt: "HOURLY DATAGEN CHECK -- inspect stalled shards and relaunch failed jobs",
            type: "recurring",
            originalSpec: "1h",
            nextFireAt: Date.now() + 3_600_000,
            intervalMs: 3_600_000,
            createdAt: Date.now(),
            fireCount: 0,
          },
        ],
      };

      await saveTimers(legacyData as unknown as SessionTimerFile);
      const loaded = await loadTimers(id);

      expect(loaded.timers[0].title).toBe("HOURLY DATAGEN CHECK");
      expect(loaded.timers[0].description).toContain("inspect stalled shards");
    });

    it("splits multiline and colon-delimited legacy prompts into title and description", async () => {
      // Legacy timers often used newline or colon separators instead of " -- ",
      // and those should still migrate into the new split structure.
      const newlineId = testId("legacy-newline");
      const colonId = testId("legacy-colon");
      createdIds.push(newlineId, colonId);

      await saveTimers({
        sessionId: newlineId,
        nextId: 2,
        timers: [
          {
            id: "t1",
            sessionId: newlineId,
            prompt: "Check build health\nInspect the latest failing shard if the build is red.",
            type: "delay",
            originalSpec: "30m",
            nextFireAt: Date.now() + 1_800_000,
            createdAt: Date.now(),
            fireCount: 0,
          } as any,
        ],
      } as SessionTimerFile);

      await saveTimers({
        sessionId: colonId,
        nextId: 2,
        timers: [
          {
            id: "t1",
            sessionId: colonId,
            prompt: "Refresh context: summarize blockers added since the last run.",
            type: "recurring",
            originalSpec: "10m",
            nextFireAt: Date.now() + 600_000,
            intervalMs: 600_000,
            createdAt: Date.now(),
            fireCount: 0,
          } as any,
        ],
      } as SessionTimerFile);

      const newlineLoaded = await loadTimers(newlineId);
      const colonLoaded = await loadTimers(colonId);

      expect(newlineLoaded.timers[0].title).toBe("Check build health");
      expect(newlineLoaded.timers[0].description).toBe("Inspect the latest failing shard if the build is red.");
      expect(colonLoaded.timers[0].title).toBe("Refresh context");
      expect(colonLoaded.timers[0].description).toBe("summarize blockers added since the last run.");
    });

    it("preserves an existing title when description is missing in partially migrated data", async () => {
      // Partially migrated files should not lose the already-curated title on reload.
      const id = testId("partial-migration");
      createdIds.push(id);

      await saveTimers({
        sessionId: id,
        nextId: 2,
        timers: [
          {
            id: "t1",
            sessionId: id,
            title: "Build check",
            prompt: "Build check -- inspect the latest failing shard if the build is red.",
            type: "delay",
            originalSpec: "30m",
            nextFireAt: Date.now() + 1_800_000,
            createdAt: Date.now(),
            fireCount: 0,
          } as any,
        ],
      } as SessionTimerFile);

      const loaded = await loadTimers(id);
      expect(loaded.timers[0].title).toBe("Build check");
      expect(loaded.timers[0].description).toBe("inspect the latest failing shard if the build is red.");
    });
  });

  describe("saveTimers", () => {
    it("persists and can round-trip", async () => {
      const id = testId("save-roundtrip");
      createdIds.push(id);

      const data: SessionTimerFile = {
        sessionId: id,
        nextId: 2,
        timers: [
          {
            id: "t1",
            sessionId: id,
            title: "test prompt",
            description: "full detail",
            type: "at",
            originalSpec: "3pm",
            nextFireAt: Date.now() + 3_600_000,
            createdAt: Date.now(),
            fireCount: 0,
          },
        ],
      };

      await saveTimers(data);
      const loaded = await loadTimers(id);
      expect(loaded.timers[0].title).toBe("test prompt");
      expect(loaded.timers[0].description).toBe("full detail");
      expect(loaded.timers[0].type).toBe("at");
    });
  });

  describe("deleteTimers", () => {
    it("deletes an existing timer file", async () => {
      const id = testId("delete-existing");
      // Don't add to createdIds since we delete manually
      await saveTimers({ sessionId: id, nextId: 1, timers: [] });

      // Verify it exists
      const before = await loadTimers(id);
      expect(before.sessionId).toBe(id);

      await deleteTimers(id);

      // After delete, should return empty
      const after = await loadTimers(id);
      expect(after.timers).toHaveLength(0);
    });

    it("does not throw for non-existent file", async () => {
      // Should not throw
      await deleteTimers(testId("nonexistent-delete"));
    });
  });

  describe("listTimerSessions", () => {
    it("lists sessions that have timer files", async () => {
      const id1 = testId("list-1");
      const id2 = testId("list-2");
      createdIds.push(id1, id2);

      await saveTimers({ sessionId: id1, nextId: 1, timers: [] });
      await saveTimers({ sessionId: id2, nextId: 1, timers: [] });

      const sessions = await listTimerSessions();
      expect(sessions).toContain(id1);
      expect(sessions).toContain(id2);
    });
  });
});
