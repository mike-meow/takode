import { describe, it, expect } from "vitest";
import { generateReplyPreview } from "./reply-preview.js";

describe("generateReplyPreview", () => {
  it("returns first line when no other messages exist", () => {
    expect(generateReplyPreview("Hello world", [])).toBe("Hello world");
  });

  it("returns first line when unique among other messages", () => {
    const others = ["Different first line\nMore text", "Another message entirely"];
    expect(generateReplyPreview("Hello world\nSecond line", others)).toBe("Hello world");
  });

  it("adds lines until unique when first line is shared", () => {
    // Both messages start with "Let me help you with that."
    // but diverge on the second line.
    const target = "Let me help you with that.\nHere's approach A.\nMore details.";
    const others = ["Let me help you with that.\nHere's approach B.\nOther details."];
    expect(generateReplyPreview(target, others)).toBe(
      "Let me help you with that.\nHere's approach A.",
    );
  });

  it("uses all lines as best effort when content is truly duplicated", () => {
    const target = "Identical content";
    const others = ["Identical content"];
    // Can't achieve uniqueness, returns all lines (the single line)
    expect(generateReplyPreview(target, others)).toBe("Identical content");
  });

  it("truncates at ~200 chars with ellipsis", () => {
    const longLine = "A".repeat(250);
    expect(generateReplyPreview(longLine, [])).toBe("A".repeat(200) + "...");
  });

  it("returns '(empty message)' for empty content", () => {
    expect(generateReplyPreview("", [])).toBe("(empty message)");
  });

  it("returns '(empty message)' for whitespace-only content", () => {
    expect(generateReplyPreview("   \n  \n\n  ", [])).toBe("(empty message)");
  });

  it("skips blank lines when building preview", () => {
    const target = "\n\n  First real line\n\n  Second real line";
    const others = ["  First real line\nDifferent second line"];
    // First non-empty line is "  First real line" which matches other's start,
    // so it should add "  Second real line" to disambiguate
    expect(generateReplyPreview(target, others)).toBe("  First real line\n  Second real line");
  });

  it("handles multi-line disambiguation correctly", () => {
    // Three messages share lines 1-2 but differ on line 3
    const target = "Line 1\nLine 2\nLine 3A";
    const others = ["Line 1\nLine 2\nLine 3B", "Line 1\nLine 2\nLine 3C"];
    expect(generateReplyPreview(target, others)).toBe("Line 1\nLine 2\nLine 3A");
  });

  it("truncates mid-line when accumulated lines exceed 200 chars", () => {
    const line1 = "A".repeat(100);
    const line2 = "B".repeat(150);
    const target = `${line1}\n${line2}`;
    // line1 is shared, so we need both lines, but combined they're 251 chars (100 + \n + 150)
    const others = [`${line1}\nC${"C".repeat(149)}`];
    const result = generateReplyPreview(target, others);
    expect(result.length).toBe(203); // 200 + "..."
    expect(result.endsWith("...")).toBe(true);
  });
});
