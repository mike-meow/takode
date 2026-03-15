import { getHighlightParts } from "./highlight.js";

describe("getHighlightParts", () => {
  it("returns a single unmatched part when query is empty", () => {
    expect(getHighlightParts("Quest title", "")).toEqual([{ text: "Quest title", matched: false }]);
  });

  it("splits text and marks matched segments case-insensitively", () => {
    expect(getHighlightParts("Fix Codex trim crash", "codex")).toEqual([
      { text: "Fix ", matched: false },
      { text: "Codex", matched: true },
      { text: " trim crash", matched: false },
    ]);
  });

  it("marks multiple matches in the same string", () => {
    expect(getHighlightParts("tag tags TAG", "tag")).toEqual([
      { text: "tag", matched: true },
      { text: " ", matched: false },
      { text: "tag", matched: true },
      { text: "s ", matched: false },
      { text: "TAG", matched: true },
    ]);
  });

  it("treats regex metacharacters as plain text", () => {
    expect(getHighlightParts("a+b a+b", "a+b")).toEqual([
      { text: "a+b", matched: true },
      { text: " ", matched: false },
      { text: "a+b", matched: true },
    ]);
  });
});
