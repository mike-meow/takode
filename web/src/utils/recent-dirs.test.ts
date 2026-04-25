// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { scopedKey } from "./scoped-storage.js";
import { addRecentDir, getRecentDirs } from "./recent-dirs.js";

describe("recent-dirs", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cc-server-id", "test-server");
  });

  it("persists global recent dirs in server-scoped storage", () => {
    // Global New Session should still have its own server-scoped recent list
    // that survives reloads and server restarts with the same server ID.
    addRecentDir("/repo/global-a");
    addRecentDir("/repo/global-b");

    expect(getRecentDirs()).toEqual(["/repo/global-b", "/repo/global-a"]);
    expect(localStorage.getItem(scopedKey("cc-recent-dirs"))).toBe('["/repo/global-b","/repo/global-a"]');
  });

  it("keeps tree-group recent dirs isolated from global and other groups", () => {
    // Group plus buttons should only show locations chosen in that same group.
    addRecentDir("/repo/global");
    addRecentDir("/repo/team-alpha", "tree-group:team-alpha");
    addRecentDir("/repo/team-beta", "tree-group:team-beta");

    expect(getRecentDirs()).toEqual(["/repo/global"]);
    expect(getRecentDirs("tree-group:team-alpha")).toEqual(["/repo/team-alpha"]);
    expect(getRecentDirs("tree-group:team-beta")).toEqual(["/repo/team-beta"]);
  });

  it("deduplicates and caps group recent dirs", () => {
    // The most recent selection wins, and long-lived workspaces should not
    // accumulate unbounded localStorage payloads for each group.
    addRecentDir("/repo/one", "tree-group:team-alpha");
    addRecentDir("/repo/two", "tree-group:team-alpha");
    addRecentDir("/repo/one", "tree-group:team-alpha");
    addRecentDir("/repo/three", "tree-group:team-alpha");
    addRecentDir("/repo/four", "tree-group:team-alpha");
    addRecentDir("/repo/five", "tree-group:team-alpha");
    addRecentDir("/repo/six", "tree-group:team-alpha");

    expect(getRecentDirs("tree-group:team-alpha")).toEqual([
      "/repo/six",
      "/repo/five",
      "/repo/four",
      "/repo/three",
      "/repo/one",
    ]);
  });
});
