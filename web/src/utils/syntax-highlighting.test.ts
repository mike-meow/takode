import { describe, expect, it } from "vitest";
import { buildHighlightedLines, inferLanguageFromPath, splitHighlightedHtmlByLine } from "./syntax-highlighting.js";

describe("syntax-highlighting utils", () => {
  it("infers language from file path", () => {
    expect(inferLanguageFromPath("/repo/src/App.tsx")).toBe("typescript");
    expect(inferLanguageFromPath("script.py")).toBe("python");
    expect(inferLanguageFromPath("unknown.customext")).toBeNull();
  });

  it("splits highlighted html by line while carrying open spans", () => {
    const lines = splitHighlightedHtmlByLine('<span class="hljs-string">"a\n b"</span>');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('<span class="hljs-string">');
    expect(lines[1]).toContain('<span class="hljs-string">');
    expect(lines[1]).toContain("</span>");
  });

  it("builds highlighted lines with stable line count", () => {
    const highlighted = buildHighlightedLines("const a = 1;\nconst b = 2;\n", "typescript");
    expect(highlighted).not.toBeNull();
    expect(highlighted).toHaveLength(2);
  });
});
