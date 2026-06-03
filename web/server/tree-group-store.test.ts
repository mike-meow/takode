import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getState,
  setState,
  createGroup,
  ensureGroupForMemorySessionSpaceSlug,
  renameGroup,
  deleteGroup,
  assignSession,
  removeSession,
  getGroupForSession,
  reconcileSessionTreeGroups,
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

  it("resolves portable memory session-space slugs to backend-local groups", async () => {
    const created = await ensureGroupForMemorySessionSpaceSlug("  test  ");
    expect(created).toEqual(expect.objectContaining({ name: "test" }));
    expect(created?.id).toBeTruthy();
    expect(created?.id).not.toBe("default");

    const reused = await ensureGroupForMemorySessionSpaceSlug("test");
    expect(reused).toEqual(created);

    const state = await getState();
    expect(state.groups.filter((group) => group.name === "test")).toHaveLength(1);
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
      assignments: { s1: "custom-1" },
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

  it("scopes group definitions and assignments by server id", async () => {
    // Different Takode server instances must not share session groups merely
    // because they run under the same user account.
    const scopedDir = join(tempDir, "scoped");
    const legacyPath = join(tempDir, "legacy-tree-groups.json");
    _resetForTest(undefined, { serverId: "server-a", port: 3457, scopedDir, legacyPath });
    const group = await createGroup("Server A");
    await assignSession("session-a", group.id);
    await _flushForTest();

    _resetForTest(undefined, { serverId: "server-b", port: 3457, scopedDir, legacyPath });
    const serverB = await getState();
    expect(serverB.groups).toEqual([{ id: "default", name: "Default" }]);
    expect(await getGroupForSession("session-a")).toBeUndefined();

    _resetForTest(undefined, { serverId: "server-a", port: 3457, scopedDir, legacyPath });
    const serverA = await getState();
    expect(serverA.groups.map((g) => g.name)).toEqual(["Default", "Server A"]);
    expect(serverA.assignments["session-a"]).toBe(group.id);
  });

  it("preserves legacy production groups without leaking them to dev server scopes", async () => {
    // Legacy installs stored all groups in ~/.companion/tree-groups.json. The
    // default production port may read that file as a compatibility fallback,
    // but dev/alternate server scopes must start isolated.
    const scopedDir = join(tempDir, "scoped");
    const legacyPath = join(tempDir, "legacy-tree-groups.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        groups: [
          { id: "default", name: "Default" },
          { id: "prod-group", name: "Production Group" },
        ],
        assignments: { "prod-session": "prod-group" },
        nodeOrder: {},
      }),
    );

    _resetForTest(undefined, { serverId: "prod-server", port: 3456, scopedDir, legacyPath });
    const prod = await getState();
    expect(prod.groups.map((g) => g.name)).toEqual(["Default", "Production Group"]);
    expect(prod.assignments["prod-session"]).toBe("prod-group");

    _resetForTest(undefined, { serverId: "dev-server", port: 3457, scopedDir, legacyPath });
    const dev = await getState();
    expect(dev.groups).toEqual([{ id: "default", name: "Default" }]);
    expect(dev.assignments).toEqual({});
  });

  it("reconciles restored sessions to explicit durable assignments, including default", async () => {
    const group = await createGroup("Team Alpha");
    await assignSession("legacy-sidecar", group.id);
    await _flushForTest();

    const result = await reconcileSessionTreeGroups([
      { sessionId: "metadata-wins", treeGroupId: "default" },
      { sessionId: "legacy-sidecar", treeGroupId: undefined },
      { sessionId: "brand-new-default", treeGroupId: undefined },
    ]);
    await _flushForTest();

    expect(result.resolvedGroups).toEqual({
      "metadata-wins": "default",
      "legacy-sidecar": group.id,
      "brand-new-default": "default",
    });
    expect(result.sessionMetadataUpdates).toEqual(
      expect.arrayContaining([
        { sessionId: "legacy-sidecar", treeGroupId: group.id, source: "scoped_assignment" },
        { sessionId: "brand-new-default", treeGroupId: "default", source: "default" },
      ]),
    );

    const state = await getState();
    expect(state.assignments["metadata-wins"]).toBe("default");
    expect(state.assignments["legacy-sidecar"]).toBe(group.id);
    expect(state.assignments["brand-new-default"]).toBe("default");
  });

  it("backfills only restored local session assignments from the legacy store", async () => {
    const scopedDir = join(tempDir, "scoped");
    const legacyPath = join(tempDir, "legacy-tree-groups.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        groups: [
          { id: "default", name: "Default" },
          { id: "legacy-a", name: "Legacy A" },
          { id: "legacy-b", name: "Legacy B" },
        ],
        assignments: {
          "session-a": "legacy-a",
          "session-b": "legacy-b",
          "other-server-session": "legacy-b",
        },
        nodeOrder: {
          "legacy-a": ["session-a"],
          "legacy-b": ["session-b", "other-server-session"],
        },
      }),
    );
    _resetForTest(undefined, { serverId: "dev-server", port: 3457, scopedDir, legacyPath });

    const result = await reconcileSessionTreeGroups([
      { sessionId: "session-a", treeGroupId: undefined },
      { sessionId: "session-b", treeGroupId: undefined },
    ]);
    await _flushForTest();

    expect(result.importedLegacyAssignments.sort()).toEqual(["session-a", "session-b"]);
    expect(result.importedLegacyGroups.sort()).toEqual(["legacy-a", "legacy-b"]);

    const state = await getState();
    expect(state.assignments).toEqual({
      "session-a": "legacy-a",
      "session-b": "legacy-b",
    });
    expect(state.nodeOrder["legacy-a"]).toEqual(["session-a"]);
    expect(state.nodeOrder["legacy-b"]).toEqual(["session-b"]);
    expect(state.assignments["other-server-session"]).toBeUndefined();
  });

  it("treats session metadata as canonical when there is no stale-default evidence", async () => {
    const group = await createGroup("Canonical");
    await assignSession("session-1", group.id);
    await _flushForTest();

    const result = await reconcileSessionTreeGroups([{ sessionId: "session-1", treeGroupId: "default" }]);
    await _flushForTest();

    expect(result.sessionMetadataUpdates).toEqual([]);
    expect(await getGroupForSession("session-1")).toBe("default");

    const rerun = await reconcileSessionTreeGroups([{ sessionId: "session-1", treeGroupId: "default" }]);
    expect(rerun.changed).toBe(false);
  });

  it("auto-reconciles a stale default assignment when memory slug matches old nodeOrder evidence", async () => {
    const oai = await createGroup("OAI");
    await setState({
      groups: [{ id: "default", name: "Default" }, oai],
      assignments: { "session-1": "default" },
      nodeOrder: {
        default: ["session-1", "default-neighbor"],
        [oai.id]: ["oai-neighbor", "session-1"],
      },
    });

    const result = await reconcileSessionTreeGroups([
      { sessionId: "session-1", treeGroupId: "default", memorySessionSpaceSlug: "OAI" },
    ]);
    await _flushForTest();

    expect(result.resolvedGroups["session-1"]).toBe(oai.id);
    expect(result.sessionMetadataUpdates).toEqual([
      { sessionId: "session-1", treeGroupId: oai.id, source: "stale_default_conflict" },
    ]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        metadataGroup: "default",
        scopedAssignment: "default",
        memorySessionSpaceSlug: "OAI",
        matchingMemoryGroupId: oai.id,
        nodeOrderGroupIds: ["default", oai.id],
        resolvedGroup: oai.id,
        action: "auto_reconciled_stale_default",
      }),
    ]);

    const state = await getState();
    expect(state.assignments["session-1"]).toBe(oai.id);
    expect(state.nodeOrder[oai.id]).toEqual(["oai-neighbor", "session-1"]);
    expect(state.nodeOrder.default).toEqual(["default-neighbor"]);
  });

  it("preserves intentional cross-space divergence without nodeOrder evidence", async () => {
    const oai = await createGroup("OAI");
    await assignSession("session-1", "default");
    await setNodeOrder(oai.id, ["other-session"]);

    const result = await reconcileSessionTreeGroups([
      { sessionId: "session-1", treeGroupId: "default", memorySessionSpaceSlug: "OAI" },
    ]);
    await _flushForTest();

    expect(result.resolvedGroups["session-1"]).toBe("default");
    expect(result.sessionMetadataUpdates).toEqual([]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        metadataGroup: "default",
        scopedAssignment: "default",
        memorySessionSpaceSlug: "OAI",
        matchingMemoryGroupId: oai.id,
        nodeOrderGroupIds: [],
        resolvedGroup: "default",
        action: "preserved_divergence",
      }),
    ]);
    expect(await getGroupForSession("session-1")).toBe("default");
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

  it("assignSession cleans stale nodeOrder entries from other groups", async () => {
    const source = await createGroup("Source");
    const target = await createGroup("Target");
    await setNodeOrder(source.id, ["s1", "moving-session", "s2"]);
    await setNodeOrder(target.id, ["target-neighbor"]);

    await assignSession("moving-session", target.id);

    const state = await getState();
    expect(state.assignments["moving-session"]).toBe(target.id);
    expect(state.nodeOrder[source.id]).toEqual(["s1", "s2"]);
    expect(state.nodeOrder[target.id]).toEqual(["target-neighbor"]);
  });
});
