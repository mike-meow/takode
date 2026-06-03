import { describe, expect, it } from "vitest";
import { getLeaderWorkerCapacity, normalizeTakodeWorkerConcurrency } from "./takode-worker-capacity.js";

describe("Takode worker capacity", () => {
  it("counts active worker-owned board demand instead of raw retained herded sessions", () => {
    // Capacity decisions should follow the active board, not stale herded
    // sessions or reviewer rows that happen to remain visible to the leader.
    const capacity = getLeaderWorkerCapacity({
      leaderSessionId: "leader-1",
      limit: 10,
      boardRows: [{ status: "IMPLEMENTING" }, { status: "CODE_REVIEWING" }, { status: "MEMORY" }, { status: "QUEUED" }],
      sessions: [
        { herdedBy: "leader-1", archived: false },
        { herdedBy: "leader-1", archived: false },
        { herdedBy: "leader-1", archived: false, reviewerOf: 42 },
        { herdedBy: "leader-1", archived: true },
      ],
    });

    expect(capacity).toEqual({
      activeWorkerDemand: 2,
      rawSlotsUsed: 2,
      limit: 10,
    });
  });

  it("does not count active rows assigned to disconnected or archived workers", () => {
    // Assigned-but-unusable workers should not make leaders think active
    // capacity is consumed; those rows are handled by board warnings instead.
    const capacity = getLeaderWorkerCapacity({
      leaderSessionId: "leader-1",
      limit: 5,
      boardRows: [
        { status: "IMPLEMENTING", worker: "worker-1", workerNum: 1 },
        { status: "PLANNING", worker: "worker-2", workerNum: 2 },
        { status: "MEMORY", worker: "worker-3", workerNum: 3 },
      ],
      sessions: [
        { sessionId: "worker-1", sessionNum: 1, herdedBy: "leader-1", archived: false, cliConnected: true },
        { sessionId: "worker-2", sessionNum: 2, herdedBy: "leader-1", archived: false, cliConnected: false },
        { sessionId: "worker-3", sessionNum: 3, herdedBy: "leader-1", archived: true, cliConnected: true },
      ],
    });

    expect(capacity.activeWorkerDemand).toBe(1);
  });

  it("normalizes the configurable concurrency range", () => {
    // The setting must support at least 10 workers while clamping runaway
    // values and falling back to the default for invalid input.
    expect(normalizeTakodeWorkerConcurrency(10)).toBe(10);
    expect(normalizeTakodeWorkerConcurrency(99)).toBe(50);
    expect(normalizeTakodeWorkerConcurrency(0)).toBe(5);
  });
});
