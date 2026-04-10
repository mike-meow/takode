// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { htmlFragmentToMarkdown } from "./html-to-markdown.js";

/**
 * Helper: creates a Range from an HTML string by parsing it into a document,
 * selecting the full body content, and returning the range.
 */
function rangeFromHtml(html: string): Range {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const range = document.createRange();
  range.selectNodeContents(doc.body);
  return range;
}

describe("htmlFragmentToMarkdown", () => {
  it("converts plain text", () => {
    const range = rangeFromHtml("Hello world");
    expect(htmlFragmentToMarkdown(range)).toBe("Hello world");
  });

  it("converts bold text", () => {
    const range = rangeFromHtml("Hello <strong>bold</strong> world");
    expect(htmlFragmentToMarkdown(range)).toBe("Hello **bold** world");
  });

  it("converts italic text", () => {
    const range = rangeFromHtml("Hello <em>italic</em> world");
    expect(htmlFragmentToMarkdown(range)).toBe("Hello *italic* world");
  });

  it("converts inline code", () => {
    const range = rangeFromHtml("Use <code>console.log</code> here");
    expect(htmlFragmentToMarkdown(range)).toBe("Use `console.log` here");
  });

  it("converts nested bold+italic", () => {
    const range = rangeFromHtml("<strong><em>bold italic</em></strong>");
    expect(htmlFragmentToMarkdown(range)).toBe("***bold italic***");
  });

  it("converts strikethrough", () => {
    const range = rangeFromHtml("This is <del>deleted</del> text");
    expect(htmlFragmentToMarkdown(range)).toBe("This is ~~deleted~~ text");
  });

  it("converts links", () => {
    const range = rangeFromHtml('<a href="https://example.com">click here</a>');
    expect(htmlFragmentToMarkdown(range)).toBe("[click here](https://example.com)");
  });

  it("converts code blocks with language", () => {
    const range = rangeFromHtml('<pre><code class="language-js">const x = 1;\n</code></pre>');
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("```js");
    expect(md).toContain("const x = 1;");
    expect(md).toContain("```");
  });

  it("converts code blocks without language", () => {
    const range = rangeFromHtml("<pre><code>plain code\n</code></pre>");
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("```");
    expect(md).toContain("plain code");
  });

  it("converts headings", () => {
    const range = rangeFromHtml("<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>");
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("# Title");
    expect(md).toContain("## Subtitle");
    expect(md).toContain("### Section");
  });

  it("converts paragraphs with spacing", () => {
    const range = rangeFromHtml("<p>First paragraph</p><p>Second paragraph</p>");
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("First paragraph");
    expect(md).toContain("Second paragraph");
    // Should have double-newline separation
    expect(md).toMatch(/First paragraph\n\n+Second paragraph/);
  });

  it("converts unordered lists", () => {
    const range = rangeFromHtml("<ul><li>Item one</li><li>Item two</li></ul>");
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("- Item one");
    expect(md).toContain("- Item two");
  });

  it("converts ordered lists", () => {
    const range = rangeFromHtml("<ol><li>First</li><li>Second</li><li>Third</li></ol>");
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("1. First");
    expect(md).toContain("2. Second");
    expect(md).toContain("3. Third");
  });

  it("converts blockquotes", () => {
    const range = rangeFromHtml("<blockquote><p>Quoted text</p></blockquote>");
    const md = htmlFragmentToMarkdown(range);
    // Should have > prefix lines
    expect(md).toMatch(/>\s*Quoted text/);
  });

  it("converts horizontal rules", () => {
    const range = rangeFromHtml("<p>Before</p><hr><p>After</p>");
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("---");
  });

  it("converts images", () => {
    const range = rangeFromHtml('<img alt="Logo" src="https://example.com/logo.png">');
    expect(htmlFragmentToMarkdown(range)).toBe("![Logo](https://example.com/logo.png)");
  });

  it("converts simple tables", () => {
    const html = `
      <table>
        <thead><tr><th>Name</th><th>Age</th></tr></thead>
        <tbody><tr><td>Alice</td><td>30</td></tr></tbody>
      </table>
    `;
    const range = rangeFromHtml(html);
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("| Name | Age |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| Alice | 30 |");
  });

  it("handles mixed inline formatting", () => {
    const range = rangeFromHtml("<p>This has <strong>bold</strong>, <em>italic</em>, and <code>code</code>.</p>");
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("**bold**");
    expect(md).toContain("*italic*");
    expect(md).toContain("`code`");
  });

  it("handles empty input gracefully", () => {
    const range = rangeFromHtml("");
    expect(htmlFragmentToMarkdown(range)).toBe("");
  });

  it("handles break tags", () => {
    const range = rangeFromHtml("Line one<br>Line two");
    const md = htmlFragmentToMarkdown(range);
    expect(md).toContain("Line one\nLine two");
  });
});
