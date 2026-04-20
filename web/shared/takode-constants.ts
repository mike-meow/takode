/**
 * Shared constants and formatting helpers for the Takode CLI and server peek/scan APIs.
 */

/** Content truncation limit for message text in peek, scan, and list views. */
export const TAKODE_PEEK_CONTENT_LIMIT = 500;

/** Max worker sessions a leader should keep active in their herd at once. */
export const HERD_WORKER_SLOT_LIMIT = 5;

/** Escape a string for TypeScript-style string literal display.
 *  Used by herd event formatter, takode scan, and takode peek for consistent quoting. */
export function escapeStringLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r");
}

/** Truncate and format as a quoted string literal.
 *  Full message: "complete content."  Truncated: "truncated content" +42 chars
 *  Escapes special characters so multi-line content stays on one visual line. */
export function formatQuotedContent(s: string, limit: number): string {
  if (s.length <= limit) return `"${escapeStringLiteral(s)}"`;
  const remaining = s.length - limit;
  return `"${escapeStringLiteral(s.slice(0, limit))}" +${remaining} chars`;
}
