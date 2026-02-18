import type { ChatMessage } from "../types.js";

/**
 * Extract the raw markdown text from an assistant message.
 * Joins all text content blocks, falling back to message.content.
 */
export function getMessageMarkdown(message: ChatMessage): string {
  const blocks = message.contentBlocks;
  if (blocks && blocks.length > 0) {
    const textParts = blocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text);
    if (textParts.length > 0) return textParts.join("\n\n");
  }
  return message.content;
}

/**
 * Strip markdown syntax to produce plain text.
 */
export function getMessagePlainText(message: ChatMessage): string {
  const md = getMessageMarkdown(message);
  return stripMarkdown(md);
}

/**
 * Remove common markdown formatting to produce readable plain text.
 */
function stripMarkdown(md: string): string {
  let text = md;
  // Remove fenced code block markers (``` lang ... ```)
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    // Keep the content inside, strip the fences
    const inner = match.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    return inner;
  });
  // Remove inline code backticks
  text = text.replace(/`([^`]+)`/g, "$1");
  // Remove images ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // Remove links [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Remove heading markers
  text = text.replace(/^#{1,6}\s+/gm, "");
  // Remove bold/italic markers
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");
  // Remove strikethrough
  text = text.replace(/~~([^~]+)~~/g, "$1");
  // Remove blockquote markers
  text = text.replace(/^>\s?/gm, "");
  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, "");
  // Remove list markers (unordered)
  text = text.replace(/^[\t ]*[-*+]\s+/gm, "");
  // Remove list markers (ordered)
  text = text.replace(/^[\t ]*\d+\.\s+/gm, "");
  return text.trim();
}

/**
 * Copy rich text (HTML) to clipboard using the Clipboard API.
 * Falls back to plain text if the ClipboardItem API is unavailable.
 */
export async function copyRichText(html: string, plainText: string): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    const item = new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plainText], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
  } else {
    // Fallback: copy as plain text
    await navigator.clipboard.writeText(plainText);
  }
}
