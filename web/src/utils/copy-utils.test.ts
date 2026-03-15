import { describe, it, expect, vi, beforeEach } from "vitest";
import { getMessageMarkdown, getMessagePlainText, copyRichText } from "./copy-utils.js";
import type { ChatMessage } from "../types.js";

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "test-msg",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("getMessageMarkdown", () => {
  it("joins text content blocks with double newlines", () => {
    const msg = makeMessage({
      contentBlocks: [
        { type: "text", text: "First paragraph" } as any,
        { type: "text", text: "Second paragraph" } as any,
      ],
    });
    expect(getMessageMarkdown(msg)).toBe("First paragraph\n\nSecond paragraph");
  });

  it("filters out non-text content blocks (tool_use, thinking)", () => {
    const msg = makeMessage({
      contentBlocks: [
        { type: "thinking", thinking: "internal thought" } as any,
        { type: "text", text: "Visible text" } as any,
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } } as any,
      ],
    });
    expect(getMessageMarkdown(msg)).toBe("Visible text");
  });

  it("falls back to message.content when no content blocks", () => {
    const msg = makeMessage({ content: "Fallback content", contentBlocks: undefined });
    expect(getMessageMarkdown(msg)).toBe("Fallback content");
  });

  it("falls back to message.content when content blocks are empty", () => {
    const msg = makeMessage({ content: "Fallback content", contentBlocks: [] });
    expect(getMessageMarkdown(msg)).toBe("Fallback content");
  });

  it("falls back to message.content when no text blocks exist", () => {
    const msg = makeMessage({
      content: "Fallback content",
      contentBlocks: [{ type: "tool_use", id: "t1", name: "Read", input: {} } as any],
    });
    expect(getMessageMarkdown(msg)).toBe("Fallback content");
  });
});

describe("getMessagePlainText", () => {
  it("strips heading markers", () => {
    const msg = makeMessage({
      contentBlocks: [{ type: "text", text: "## Heading\n\nParagraph" } as any],
    });
    expect(getMessagePlainText(msg)).toContain("Heading");
    expect(getMessagePlainText(msg)).not.toContain("##");
  });

  it("strips bold and italic markers", () => {
    const msg = makeMessage({
      contentBlocks: [{ type: "text", text: "This is **bold** and *italic*" } as any],
    });
    const result = getMessagePlainText(msg);
    expect(result).toBe("This is bold and italic");
  });

  it("converts links to just their text", () => {
    const msg = makeMessage({
      contentBlocks: [{ type: "text", text: "Click [here](https://example.com) for more" } as any],
    });
    expect(getMessagePlainText(msg)).toBe("Click here for more");
  });

  it("strips fenced code block markers but keeps content", () => {
    const msg = makeMessage({
      contentBlocks: [{ type: "text", text: "```typescript\nconst x = 1;\n```" } as any],
    });
    const result = getMessagePlainText(msg);
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("```");
  });

  it("strips inline code backticks", () => {
    const msg = makeMessage({
      contentBlocks: [{ type: "text", text: "Use `npm install` to install" } as any],
    });
    expect(getMessagePlainText(msg)).toBe("Use npm install to install");
  });

  it("strips blockquote markers", () => {
    const msg = makeMessage({
      contentBlocks: [{ type: "text", text: "> This is a quote" } as any],
    });
    expect(getMessagePlainText(msg)).toBe("This is a quote");
  });

  it("strips list markers", () => {
    const msg = makeMessage({
      contentBlocks: [{ type: "text", text: "- Item one\n- Item two\n1. Ordered" } as any],
    });
    const result = getMessagePlainText(msg);
    expect(result).toContain("Item one");
    expect(result).toContain("Item two");
    expect(result).toContain("Ordered");
    expect(result).not.toMatch(/^- /m);
    expect(result).not.toMatch(/^1\. /m);
  });
});

describe("copyRichText", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses ClipboardItem API when available", async () => {
    const mockWrite = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { write: mockWrite, writeText: vi.fn() } });
    // Ensure ClipboardItem is defined
    if (typeof globalThis.ClipboardItem === "undefined") {
      (globalThis as any).ClipboardItem = class {
        constructor(public items: Record<string, Blob>) {}
      };
    }

    await copyRichText("<b>Hello</b>", "Hello");

    expect(mockWrite).toHaveBeenCalledTimes(1);
    const item = mockWrite.mock.calls[0][0][0];
    expect(item.items["text/html"]).toBeInstanceOf(Blob);
    expect(item.items["text/plain"]).toBeInstanceOf(Blob);
  });

  it("falls back to writeText when ClipboardItem is undefined", async () => {
    const origClipboardItem = globalThis.ClipboardItem;
    (globalThis as any).ClipboardItem = undefined;
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { write: vi.fn(), writeText: mockWriteText } });

    await copyRichText("<b>Hello</b>", "Hello");

    expect(mockWriteText).toHaveBeenCalledWith("Hello");
    // Restore
    (globalThis as any).ClipboardItem = origClipboardItem;
  });
});
