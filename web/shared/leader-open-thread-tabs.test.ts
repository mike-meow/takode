import { describe, expect, it } from "vitest";
import {
  applyLeaderThreadTabUpdate,
  canServerCandidateOpenThread,
  createLeaderOpenThreadTabsState,
  MAX_LEADER_CLOSED_THREAD_TOMBSTONES,
  MAX_LEADER_OPEN_THREAD_TABS,
  normalizeLeaderOpenThreadKeys,
  normalizeLeaderOpenThreadTabsState,
  reorderLeaderOpenThreadKeys,
} from "./leader-open-thread-tabs.js";

describe("leader open thread tab state", () => {
  it("normalizes open keys and caps the authoritative server list at 50", () => {
    const manyKeys = Array.from({ length: MAX_LEADER_OPEN_THREAD_TABS + 5 }, (_, index) => `q-${index + 1}`);

    expect(normalizeLeaderOpenThreadKeys(["main", "all", " Q-1 ", "q-1", ...manyKeys])).toEqual(
      ["q-1", ...manyKeys.filter((key) => key !== "q-1")].slice(0, MAX_LEADER_OPEN_THREAD_TABS),
    );
  });

  it("evicts older open tabs when a new first-position tab exceeds the cap", () => {
    const baseline = Array.from({ length: MAX_LEADER_OPEN_THREAD_TABS }, (_, index) => `q-${index + 1}`);
    const state = {
      ...createLeaderOpenThreadTabsState(10),
      orderedOpenThreadKeys: baseline,
    };

    const next = applyLeaderThreadTabUpdate(state, { type: "open", threadKey: "q-1000", placement: "first" }, 20);

    expect(next.orderedOpenThreadKeys).toHaveLength(MAX_LEADER_OPEN_THREAD_TABS);
    expect(next.orderedOpenThreadKeys[0]).toBe("q-1000");
    expect(next.orderedOpenThreadKeys).not.toContain("q-50");
  });

  it("ignores obsolete or unsupported update operations without replacing state", () => {
    const state = {
      ...createLeaderOpenThreadTabsState(10),
      orderedOpenThreadKeys: ["q-1", "q-2"],
    };

    expect(applyLeaderThreadTabUpdate(state, { type: "auto_close", threadKeys: ["q-1"] }, 20)).toEqual(state);
    expect(applyLeaderThreadTabUpdate(state, { type: "unknown_operation" }, 20)).toEqual(state);
    expect(applyLeaderThreadTabUpdate(undefined, { type: "unknown_operation" }, 20)).toBeUndefined();
  });

  it("reorders existing server-open tabs without changing tombstones", () => {
    const state = {
      ...createLeaderOpenThreadTabsState(10),
      orderedOpenThreadKeys: ["q-1", "q-2", "q-3"],
      closedThreadTombstones: [{ threadKey: "q-9", closedAt: 9 }],
    };

    const next = applyLeaderThreadTabUpdate(state, { type: "reorder", orderedOpenThreadKeys: ["q-3", "q-1"] }, 20);

    expect(next.orderedOpenThreadKeys).toEqual(["q-3", "q-1", "q-2"]);
    expect(next.closedThreadTombstones).toEqual([{ threadKey: "q-9", closedAt: 9 }]);
    expect(next.updatedAt).toBe(20);
  });

  it("treats stale reorder payloads as order hints rather than close instructions", () => {
    expect(reorderLeaderOpenThreadKeys(["q-1", "q-2", "q-3"], ["q-3", "q-4", "q-1", "main"])).toEqual([
      "q-3",
      "q-1",
      "q-2",
    ]);

    const state = {
      ...createLeaderOpenThreadTabsState(10),
      orderedOpenThreadKeys: ["q-1", "q-2", "q-3"],
    };
    const next = applyLeaderThreadTabUpdate(state, { type: "reorder", orderedOpenThreadKeys: ["q-3"] }, 20);

    expect(next.orderedOpenThreadKeys).toEqual(["q-3", "q-1", "q-2"]);
  });

  it("keeps new first-position opens ahead of a manually reordered existing order", () => {
    const reordered = applyLeaderThreadTabUpdate(
      { ...createLeaderOpenThreadTabsState(10), orderedOpenThreadKeys: ["q-1", "q-2", "q-3"] },
      { type: "reorder", orderedOpenThreadKeys: ["q-3", "q-1", "q-2"] },
      20,
    );

    const opened = applyLeaderThreadTabUpdate(reordered, { type: "open", threadKey: "q-4", placement: "first" }, 30);

    expect(opened.orderedOpenThreadKeys).toEqual(["q-4", "q-3", "q-1", "q-2"]);
  });

  it("preserves user closes as bounded tombstones and explicit user opens remove them", () => {
    const closed = applyLeaderThreadTabUpdate(
      { ...createLeaderOpenThreadTabsState(1), orderedOpenThreadKeys: ["q-1", "q-2"] },
      { type: "close", threadKey: "q-1", closedAt: 100 },
      100,
    );

    expect(closed.orderedOpenThreadKeys).toEqual(["q-2"]);
    expect(closed.closedThreadTombstones).toEqual([{ threadKey: "q-1", closedAt: 100 }]);

    const reopened = applyLeaderThreadTabUpdate(closed, { type: "open", threadKey: "q-1", source: "user" }, 110);
    expect(reopened.orderedOpenThreadKeys[0]).toBe("q-1");
    expect(reopened.closedThreadTombstones).toEqual([]);
  });

  it("allows fresh server-created candidates to reopen only when newer than the close tombstone", () => {
    const closed = {
      ...createLeaderOpenThreadTabsState(1),
      closedThreadTombstones: [{ threadKey: "q-9", closedAt: 100 }],
    };

    expect(canServerCandidateOpenThread(closed, "q-9", 99)).toBe(false);
    expect(
      applyLeaderThreadTabUpdate(
        closed,
        { type: "open", threadKey: "q-9", source: "server_candidate", eventAt: 99 },
        101,
      ),
    ).toEqual(closed);

    const reopened = applyLeaderThreadTabUpdate(
      closed,
      { type: "open", threadKey: "q-9", source: "server_candidate", eventAt: 101 },
      102,
    );
    expect(reopened.orderedOpenThreadKeys).toEqual(["q-9"]);
    expect(reopened.closedThreadTombstones).toEqual([]);
  });

  it("caps closed tombstones while keeping the newest close decisions", () => {
    let state = createLeaderOpenThreadTabsState(0);
    for (let index = 0; index < MAX_LEADER_CLOSED_THREAD_TOMBSTONES + 5; index++) {
      state = applyLeaderThreadTabUpdate(state, { type: "close", threadKey: `q-${index}`, closedAt: index }, index);
    }

    expect(state.closedThreadTombstones).toHaveLength(MAX_LEADER_CLOSED_THREAD_TOMBSTONES);
    expect(state.closedThreadTombstones[0]).toEqual({
      threadKey: `q-${MAX_LEADER_CLOSED_THREAD_TOMBSTONES + 4}`,
      closedAt: MAX_LEADER_CLOSED_THREAD_TOMBSTONES + 4,
    });
    expect(state.closedThreadTombstones).not.toContainEqual({ threadKey: "q-0", closedAt: 0 });
  });

  it("normalizes persisted state defensively", () => {
    expect(
      normalizeLeaderOpenThreadTabsState({
        version: 1,
        orderedOpenThreadKeys: ["q-1", "main", "q-1", "q-2"],
        closedThreadTombstones: [
          { threadKey: "q-3", closedAt: 10 },
          { threadKey: "main", closedAt: 9 },
          { threadKey: "q-3", closedAt: 8 },
        ],
        updatedAt: -1,
        migratedFromLocalStorageAt: 5,
      }),
    ).toEqual({
      version: 1,
      orderedOpenThreadKeys: ["q-1", "q-2"],
      closedThreadTombstones: [{ threadKey: "q-3", closedAt: 10 }],
      updatedAt: 0,
      migratedFromLocalStorageAt: 5,
    });
  });
});
