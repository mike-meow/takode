import { memo, type ReactNode } from "react";

/**
 * Escape special regex characters in a string so it can be used as a literal pattern.
 * Same logic as web/src/utils/highlight.ts but co-located here to avoid circular deps.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits text into segments, wrapping matched portions in <mark> tags.
 *
 * - Strict mode: case-insensitive exact substring matching
 * - Fuzzy mode: highlights every query word independently (all words must be present
 *   for the message to appear in results, but highlighting is per-word)
 *
 * `isCurrent` controls the highlight intensity:
 *   true  = bright amber (the message containing the active match)
 *   false = subtle amber (other matching messages)
 */
export const HighlightedText = memo(function HighlightedText({
  text,
  query,
  mode,
  isCurrent,
}: {
  text: string;
  query: string;
  mode: "strict" | "fuzzy";
  isCurrent: boolean;
}) {
  if (!query || !text) return <>{text}</>;

  const pattern = buildHighlightPattern(query, mode);
  if (!pattern) return <>{text}</>;

  const segments = text.split(pattern);
  if (segments.length === 1) return <>{text}</>;

  const markClass = isCurrent
    ? "bg-amber-400/70 dark:bg-amber-400/50 text-inherit rounded-sm"
    : "bg-amber-400/25 dark:bg-amber-400/20 text-inherit rounded-sm";

  const result: ReactNode[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    // Odd indices are capture-group matches from the split
    if (i % 2 === 1) {
      result.push(
        <mark key={i} className={markClass}>
          {seg}
        </mark>,
      );
    } else {
      result.push(seg);
    }
  }
  return <>{result}</>;
});

/**
 * Build a regex pattern that captures the portions of text to highlight.
 * Returns null if the query is empty or produces no valid pattern.
 *
 * The returned regex uses a capture group so `String.split(regex)` places
 * matched text at odd indices.
 */
export function buildHighlightPattern(query: string, mode: "strict" | "fuzzy"): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  if (mode === "strict") {
    return new RegExp(`(${escapeRegExp(trimmed)})`, "ig");
  }

  // Fuzzy: highlight each word independently
  const words = trimmed.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (words.length === 0) return null;
  return new RegExp(`(${words.join("|")})`, "ig");
}
