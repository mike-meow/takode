/**
 * Shared constants and formatting helpers for the Takode CLI and server peek/scan APIs.
 */

/** Content truncation limit for message text in peek, scan, and list views. */
export const TAKODE_PEEK_CONTENT_LIMIT = 500;

/** Default max worker demand a leader should keep active at once. */
export const DEFAULT_TAKODE_WORKER_CONCURRENCY = 5;

/** Max accepted worker concurrency setting value. */
export const MAX_TAKODE_WORKER_CONCURRENCY = 50;

/** Compatibility alias for older call sites and tests. */
export const HERD_WORKER_SLOT_LIMIT = DEFAULT_TAKODE_WORKER_CONCURRENCY;

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

/** Collapse stored agent labels like "#1563 System Leader 2" to "#1563".
 *  Falls back to the original label when no visible session number is present. */
export function formatCompactAgentLabel(sessionLabel: string | undefined): string | null {
  const label = sessionLabel?.trim();
  if (!label) return null;
  const sessionNumber = /^#\d+(?=$|\s)/.exec(label);
  return sessionNumber?.[0] ?? label;
}
