import { describe, expect, it } from "vitest";
import {
  formatReplyContentForAssistant,
  formatReplyContentForContext,
  formatReplyContentForPreview,
  getDisplayReplyContext,
  injectReplyContext,
  parseReplyContext,
} from "./reply-context.js";

describe("reply context formatting", () => {
  it("keeps legacy marker parsing backward-compatible", () => {
    const content = injectReplyContext("Original answer", "Continue this", "codex-agent-long-random-id");

    expect(parseReplyContext(content)).toEqual({
      previewText: "Original answer",
      userMessage: "Continue this",
      messageId: "codex-agent-long-random-id",
    });
  });

  it("formats assistant-bound reply text without raw marker syntax", () => {
    const formatted = formatReplyContentForAssistant("Continue this", {
      messageId: "codex-agent-long-random-id",
      previewText: "Original answer with\nextra spacing",
    });

    expect(formatted).toBe("[reply] Original answer with extra spacing\n\nContinue this");
    expect(formatted).not.toContain("<<<REPLY_TO");
    expect(formatted).not.toContain("codex-agent-long-random-id");
  });

  it("formats sidebar previews from the typed body first", () => {
    expect(formatReplyContentForPreview("Continue this", { previewText: "Original answer" })).toBe(
      "[reply] Continue this",
    );
    expect(formatReplyContentForPreview("", { previewText: "Original answer" })).toBe("[reply] Original answer");
  });

  it("sanitizes legacy marker messages for context and preview callers", () => {
    const legacy = injectReplyContext("Original answer", "Continue this", "msg-1");

    expect(formatReplyContentForContext(legacy)).toBe("[reply] Original answer\n\nContinue this");
    expect(formatReplyContentForPreview(legacy)).toBe("[reply] Continue this");
  });

  it("prefers explicit metadata when rendering new stored messages", () => {
    expect(getDisplayReplyContext("Continue this", { previewText: "Original answer", messageId: "msg-1" })).toEqual({
      previewText: "Original answer",
      userMessage: "Continue this",
      messageId: "msg-1",
    });
  });
});
