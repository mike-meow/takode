import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaults, saveDefaults, _flushForTest, _resetForTest } from "./new-session-defaults-store.js";

describe("new-session-defaults-store", () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "new-session-defaults-store-test-"));
    tempFile = join(tempDir, "defaults.json");
    _resetForTest(tempFile);
  });

  afterEach(async () => {
    await _flushForTest();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists defaults and survives reload", async () => {
    await saveDefaults("tree-group:team-alpha", {
      backend: "codex",
      model: "gpt-5.5",
      mode: "agent",
      askPermission: false,
      sessionRole: "leader",
      envSlug: "sandbox",
      cwd: "/repo/companion",
      useWorktree: false,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });
    await _flushForTest();

    _resetForTest(tempFile);
    const entry = await getDefaults("tree-group:team-alpha");

    expect(entry?.defaults).toEqual({
      backend: "codex",
      model: "gpt-5.5",
      mode: "agent",
      askPermission: false,
      sessionRole: "worker",
      envSlug: "sandbox",
      cwd: "/repo/companion",
      useWorktree: false,
      codexInternetAccess: true,
      codexReasoningEffort: "high",
    });
    expect(typeof entry?.updatedAt).toBe("number");
  });

  it("scopes defaults by server id", async () => {
    const scopedDir = join(tempDir, "scoped");
    _resetForTest(undefined, { serverId: "server-a", scopedDir });
    await saveDefaults("tree-group:takode", {
      backend: "claude",
      model: "",
      mode: "agent",
      askPermission: true,
      sessionRole: "worker",
      envSlug: "",
      cwd: "/repo/server-a",
      useWorktree: true,
      codexInternetAccess: false,
      codexReasoningEffort: "",
    });
    await _flushForTest();

    _resetForTest(undefined, { serverId: "server-b", scopedDir });
    expect(await getDefaults("tree-group:takode")).toBeNull();

    _resetForTest(undefined, { serverId: "server-a", scopedDir });
    expect((await getDefaults("tree-group:takode"))?.defaults.cwd).toBe("/repo/server-a");
  });

  it("rejects empty keys and malformed defaults", async () => {
    expect(await saveDefaults("  ", { cwd: "/repo" })).toBeNull();
    expect(await saveDefaults("tree-group:bad", null)).toBeNull();
    expect(await getDefaults("tree-group:bad")).toBeNull();
  });
});
