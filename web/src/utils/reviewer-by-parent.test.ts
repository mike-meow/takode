import { describe, expect, it } from "vitest";
import { buildReviewerByParent } from "./reviewer-by-parent.js";
import type { SidebarSessionItem } from "./sidebar-session-item.js";

function makeSession(overrides: Partial<SidebarSessionItem> & { id: string }): SidebarSessionItem {
  return {
    model: "claude",
    cwd: "/test",
    gitBranch: "main",
    isContainerized: false,
    gitAhead: 0,
    gitBehind: 0,
    linesAdded: 0,
    linesRemoved: 0,
    isConnected: false,
    status: null,
    sdkState: "exited",
    createdAt: 1,
    archived: false,
    backendType: "claude",
    repoRoot: "/test",
    permCount: 0,
    ...overrides,
  };
}

describe("buildReviewerByParent", () => {
  it("keeps archived reviewer records attached to their parent", () => {
    // Archived reviewer sessions should remain inspectable through the parent
    // session row even though they are not standalone active sidebar rows.
    const reviewerByParent = buildReviewerByParent([
      makeSession({ id: "parent", sessionNum: 8 }),
      makeSession({ id: "reviewer", reviewerOf: 8, archived: true }),
    ]);

    expect(reviewerByParent.get(8)?.id).toBe("reviewer");
  });

  it("prefers an active reviewer over an archived historical record", () => {
    const reviewerByParent = buildReviewerByParent([
      makeSession({ id: "archived-reviewer", reviewerOf: 8, archived: true, createdAt: 20 }),
      makeSession({ id: "active-reviewer", reviewerOf: 8, archived: false, createdAt: 10 }),
    ]);

    expect(reviewerByParent.get(8)?.id).toBe("active-reviewer");
  });
});
