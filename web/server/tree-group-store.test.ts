import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getState,
  setState,
  createGroup,
  renameGroup,
  deleteGroup,
  assignSession,
  removeSession,
  getGroupForSession,
  setNodeOrder,
  _flushForTest,
  _resetForTest,
} from "./tree-group-store.js";

describe("tree-group-store", () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tree-group-store-test-"));
    tempFile = join(tempDir, "tree-groups.json");
    _resetForTest(tempFile);
  });

  afterEach(async () => {
    await _flushForTest();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("initializes with a default group when no file exists", async () => {
    const state = await getState();
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]).toEqual({ id: "default", name: "Default" });
    expect(state.assignments).toEqual({});
  });

  it("creates a new group and returns it", async () => {
    const group = await createGroup("My Group");
    expect(group.name).toBe("My Group");
    expect(group.id).toBeTruthy();
    expect(group.id).not.toBe("default");

    const state = await getState();
    expect(state.groups).toHaveLength(2);
    expect(state.groups[1].name).toBe("My Group");
  });

  it("trims whitespace on group name and falls back to 'Untitled'", async () => {
    const g1 = await createGroup("  Trimmed  ");
    expect(g1.name).toBe("Trimmed");

    const g2 = await createGroup("   ");
    expect(g2.name).toBe("Untitled");
  });

  it("renames a group", async () => {
    const group = await createGroup("Old Name");
    const ok = await renameGroup(group.id, "New Name");
    expect(ok).toBe(true);

    const state = await getState();
    const renamed = state.groups.find((g) => g.id === group.id);
    expect(renamed?.name).toBe("New Name");
  });

  it("cannot rename the default group", async () => {
    const ok = await renameGroup("default", "Custom Default");
    expect(ok).toBe(false);

    const state = await getState();
    expect(state.groups[0].name).toBe("Default");
  });

  it("deletes a group and reassigns members to default", async () => {
    const group = await createGroup("Temp Group");
    await assignSession("session-1", group.id);
    await assignSession("session-2", group.id);

    // Verify assignment before delete
    expect(await getGroupForSession("session-1")).toBe(group.id);

    const ok = await deleteGroup(group.id);
    expect(ok).toBe(true);

    // Verify reassignment to default
    expect(await getGroupForSession("session-1")).toBe("default");
    expect(await getGroupForSession("session-2")).toBe("default");

    // Verify group is gone
    const state = await getState();
    expect(state.groups.find((g) => g.id === group.id)).toBeUndefined();
  });

  it("cannot delete the default group", async () => {
    const ok = await deleteGroup("default");
    expect(ok).toBe(false);

    const state = await getState();
    expect(state.groups.some((g) => g.id === "default")).toBe(true);
  });

  it("assigns and retrieves session group", async () => {
    const group = await createGroup("My Group");
    await assignSession("session-1", group.id);

    expect(await getGroupForSession("session-1")).toBe(group.id);
    expect(await getGroupForSession("session-unknown")).toBeUndefined();
  });

  it("ignores assignment to non-existent group", async () => {
    await assignSession("session-1", "nonexistent-group-id");
    expect(await getGroupForSession("session-1")).toBeUndefined();
  });

  it("removes a session assignment", async () => {
    const group = await createGroup("Group");
    await assignSession("session-1", group.id);
    await removeSession("session-1");

    expect(await getGroupForSession("session-1")).toBeUndefined();
  });

  it("setState replaces full state", async () => {
    await createGroup("Will be replaced");

    await setState({
      groups: [
        { id: "default", name: "Default" },
        { id: "custom-1", name: "Custom" },
      ],
      assignments: { "s1": "custom-1" },
      nodeOrder: {},
    });

    const state = await getState();
    expect(state.groups).toHaveLength(2);
    expect(state.groups[1]).toEqual({ id: "custom-1", name: "Custom" });
    expect(state.assignments["s1"]).toBe("custom-1");
  });

  it("setState auto-creates default group if missing", async () => {
    await setState({
      groups: [{ id: "custom", name: "Only Custom" }],
      assignments: {},
      nodeOrder: {},
    });

    const state = await getState();
    expect(state.groups[0].id).toBe("default");
    expect(state.groups).toHaveLength(2);
  });

  it("persists to disk and survives reload", async () => {
    await createGroup("Persistent");
    await assignSession("s1", (await getState()).groups[1].id);
    await _flushForTest();

    // Reload from disk
    _resetForTest(tempFile);
    const state = await getState();
    expect(state.groups).toHaveLength(2);
    expect(state.groups[1].name).toBe("Persistent");
    expect(state.assignments["s1"]).toBe(state.groups[1].id);
  });

  it("sanitizes corrupt data on load", async () => {
    // Write corrupt data
    const { writeFile } = await import("node:fs/promises");
    const { mkdirSync } = await import("node:fs"); // sync-ok: test setup
    mkdirSync(tempDir, { recursive: true });
    await writeFile(tempFile, JSON.stringify({ groups: "not an array", assignments: 42 }));
    await _flushForTest();

    _resetForTest(tempFile);
    const state = await getState();
    // Should fall back to default group
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].id).toBe("default");
    expect(state.assignments).toEqual({});
  });

  // ─── setNodeOrder tests ──────────────────────────────────────────────

  it("sets and retrieves node order for a group", async () => {
    const group = await createGroup("Ordered");
    await setNodeOrder(group.id, ["s1", "s2", "s3"]);

    const state = await getState();
    expect(state.nodeOrder[group.id]).toEqual(["s1", "s2", "s3"]);
  });

  it("setNodeOrder deduplicates and trims IDs", async () => {
    const group = await createGroup("Dedup");
    await setNodeOrder(group.id, ["s1", "  s2  ", "s1", "s3", "s2"]);

    const state = await getState();
    expect(state.nodeOrder[group.id]).toEqual(["s1", "s2", "s3"]);
  });

  it("setNodeOrder with empty array deletes the entry", async () => {
    const group = await createGroup("EmptyOrder");
    await setNodeOrder(group.id, ["s1", "s2"]);
    await setNodeOrder(group.id, []);

    const state = await getState();
    expect(state.nodeOrder[group.id]).toBeUndefined();
  });

  it("setNodeOrder ignores non-existent group", async () => {
    await setNodeOrder("nonexistent-group", ["s1"]);
    const state = await getState();
    expect(state.nodeOrder["nonexistent-group"]).toBeUndefined();
  });

  it("setNodeOrder persists to disk", async () => {
    const group = await createGroup("Persist");
    await setNodeOrder(group.id, ["s1", "s2"]);
    await _flushForTest();

    _resetForTest(tempFile);
    const state = await getState();
    expect(state.nodeOrder[group.id]).toEqual(["s1", "s2"]);
  });

  // ─── removeSession cleans nodeOrder ──────────────────────────────────

  it("removeSession also cleans nodeOrder arrays", async () => {
    const group = await createGroup("OrderCleanup");
    await assignSession("session-to-remove", group.id);
    await setNodeOrder(group.id, ["session-keep", "session-to-remove", "session-other"]);

    await removeSession("session-to-remove");

    const state = await getState();
    expect(state.assignments["session-to-remove"]).toBeUndefined();
    expect(state.nodeOrder[group.id]).toEqual(["session-keep", "session-other"]);
  });
});
