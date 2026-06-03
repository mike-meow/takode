import { describe, expect, it } from "vitest";
import { buildTreeGroupCreateSessionModalContext } from "./tree-group-create-session.js";

describe("buildTreeGroupCreateSessionModalContext", () => {
  it("carries the portable Session Space name for non-default group creation", () => {
    expect(
      buildTreeGroupCreateSessionModalContext("team-alpha", [
        { id: "default", name: "Default" },
        { id: "team-alpha", name: "Team Alpha" },
      ]),
    ).toEqual({
      treeGroupId: "team-alpha",
      memorySessionSpaceSlug: "Team Alpha",
      newSessionDefaultsKey: "tree-group:team-alpha",
    });
  });

  it("keeps default creation on the server default memory space", () => {
    expect(buildTreeGroupCreateSessionModalContext(" default ", [{ id: "default", name: "Default" }])).toEqual({
      treeGroupId: "default",
      memorySessionSpaceSlug: undefined,
      newSessionDefaultsKey: "tree-group:default",
    });
  });

  it("rejects unknown non-default group ids", () => {
    expect(buildTreeGroupCreateSessionModalContext("missing", [{ id: "default", name: "Default" }])).toBeNull();
  });
});
