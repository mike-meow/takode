import { describe, it, expect } from "vitest";
import { injectReplyContext, parseReplyContext } from "./reply-context.js";

describe("injectReplyContext", () => {
  it("wraps preview text in delimiters with messageId and appends user message", () => {
    const result = injectReplyContext("Hello world", "My reply", "msg-123");
    expect(result).toBe("<<<REPLY_TO:msg-123>>>Hello world<<<END_REPLY>>>\n\nMy reply");
  });

  it("omits messageId from tag when not provided", () => {
    const result = injectReplyContext("Hello world", "My reply");
    expect(result).toBe("<<<REPLY_TO>>>Hello world<<<END_REPLY>>>\n\nMy reply");
  });

  it("handles preview text with special characters (quotes, brackets, code)", () => {
    const preview = 'Here\'s some `code` with "quotes" and [brackets] and {braces}';
    const result = injectReplyContext(preview, "Follow up", "msg-456");
    expect(result).toContain(preview);
    expect(result).toBe(`<<<REPLY_TO:msg-456>>>${preview}<<<END_REPLY>>>\n\nFollow up`);
  });

  it("handles multi-line preview text", () => {
    const preview = "Line 1\nLine 2\nLine 3";
    const result = injectReplyContext(preview, "My message", "msg-789");
    expect(result).toBe(`<<<REPLY_TO:msg-789>>>${preview}<<<END_REPLY>>>\n\nMy message`);
  });
});

describe("parseReplyContext", () => {
  it("extracts preview, user message, and messageId from valid reply format", () => {
    const input = "<<<REPLY_TO:msg-123>>>Hello world<<<END_REPLY>>>\n\nMy reply";
    const parsed = parseReplyContext(input);
    expect(parsed).toEqual({ previewText: "Hello world", userMessage: "My reply", messageId: "msg-123" });
  });

  it("parses format without messageId (backward compat)", () => {
    const input = "<<<REPLY_TO>>>Hello world<<<END_REPLY>>>\n\nMy reply";
    const parsed = parseReplyContext(input);
    expect(parsed).toEqual({ previewText: "Hello world", userMessage: "My reply", messageId: undefined });
  });

  it("returns null for messages without reply prefix", () => {
    expect(parseReplyContext("Just a normal message")).toBeNull();
    expect(parseReplyContext("")).toBeNull();
  });

  it("returns null for malformed prefix (missing close delimiter)", () => {
    expect(parseReplyContext("<<<REPLY_TO:msg-1>>>some text without close")).toBeNull();
  });

  it("handles preview text with special characters", () => {
    const preview = 'Code: `fn main() { println!("hello"); }` with "quotes" and [brackets]';
    const input = `<<<REPLY_TO:msg-abc>>>${preview}<<<END_REPLY>>>\n\nMy reply`;
    const parsed = parseReplyContext(input);
    expect(parsed).toEqual({ previewText: preview, userMessage: "My reply", messageId: "msg-abc" });
  });

  it("handles multi-line preview text", () => {
    const preview = "First line\nSecond line\nThird line";
    const input = `<<<REPLY_TO:m1>>>${preview}<<<END_REPLY>>>\n\nUser message`;
    const parsed = parseReplyContext(input);
    expect(parsed).toEqual({ previewText: preview, userMessage: "User message", messageId: "m1" });
  });

  it("handles multi-line user message", () => {
    const input = "<<<REPLY_TO:m2>>>Preview<<<END_REPLY>>>\n\nLine 1\nLine 2\nLine 3";
    const parsed = parseReplyContext(input);
    expect(parsed).toEqual({ previewText: "Preview", userMessage: "Line 1\nLine 2\nLine 3", messageId: "m2" });
  });

  it("handles empty user message after reply context", () => {
    const input = "<<<REPLY_TO:m3>>>Preview<<<END_REPLY>>>\n\n";
    const parsed = parseReplyContext(input);
    expect(parsed).toEqual({ previewText: "Preview", userMessage: "", messageId: "m3" });
  });

  it("handles case where close delimiter is immediately followed by content (no newlines)", () => {
    const input = "<<<REPLY_TO>>>Preview<<<END_REPLY>>>Direct content";
    const parsed = parseReplyContext(input);
    expect(parsed).toEqual({ previewText: "Preview", userMessage: "Direct content", messageId: undefined });
  });

  it("roundtrips with injectReplyContext (with messageId)", () => {
    const preview = 'Complex "preview" with `code` and\nnewlines [1] {2}';
    const message = "The user's actual message\nwith multiple lines";
    const injected = injectReplyContext(preview, message, "roundtrip-id");
    const parsed = parseReplyContext(injected);
    expect(parsed).toEqual({ previewText: preview, userMessage: message, messageId: "roundtrip-id" });
  });

  it("roundtrips with injectReplyContext (without messageId)", () => {
    const preview = "Simple preview";
    const message = "Simple message";
    const injected = injectReplyContext(preview, message);
    const parsed = parseReplyContext(injected);
    expect(parsed).toEqual({ previewText: preview, userMessage: message, messageId: undefined });
  });

  it("handles messageId containing hyphens and numbers", () => {
    const input = "<<<REPLY_TO:msg-2024-01-15-abc123>>>Preview<<<END_REPLY>>>\n\nBody";
    const parsed = parseReplyContext(input);
    expect(parsed?.messageId).toBe("msg-2024-01-15-abc123");
  });
});
