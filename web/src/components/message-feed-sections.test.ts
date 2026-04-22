import { describe, expect, it } from "vitest";
import {
  buildFeedSections,
  findActiveTaskTurnIdForScroll,
  findSectionWindowStartIndexForTarget,
  findVisibleSectionEndIndex,
  findVisibleSectionStartIndex,
} from "./message-feed-sections.js";

function makeTurns(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `t${index + 1}` })) as Array<{ id: string }>;
}

describe("message-feed sections", () => {
  it("chunks turns into stable sections", () => {
    // Sectioning is the backbone of the windowed-history UI, so chunk IDs and
    // boundaries must stay deterministic across refactors.
    const sections = buildFeedSections(makeTurns(5) as never, 2);
    expect(sections.map((section) => section.id)).toEqual(["t1", "t3", "t5"]);
    expect(sections.map((section) => section.turns.length)).toEqual([2, 2, 1]);
  });

  it("computes visible windows around a target section", () => {
    // The feed keeps one section of context above the target when possible.
    const sections = buildFeedSections(makeTurns(8) as never, 2);
    expect(findVisibleSectionStartIndex(sections, 2)).toBe(2);
    expect(findVisibleSectionEndIndex(sections, 2, 2)).toBe(4);
    expect(findSectionWindowStartIndexForTarget(sections, 2, 2)).toBe(1);
  });

  it("picks the closest active turn for the current scroll position", () => {
    // The task rail should follow the last turn whose header has crossed the
    // viewport offset rather than jumping ahead too early.
    expect(
      findActiveTaskTurnIdForScroll(
        [
          { turnId: "t1", offsetTop: 0 },
          { turnId: "t2", offsetTop: 120 },
          { turnId: "t3", offsetTop: 260 },
        ],
        100,
        "t1",
      ),
    ).toBe("t2");
  });
});
