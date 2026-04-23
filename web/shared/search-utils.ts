/**
 * Search normalization utilities shared between server and client.
 * Provides CamelCase expansion so searches like "plan mode" match "ExitPlanMode".
 */

/**
 * Insert spaces at CamelCase boundaries.
 *
 * - "ExitPlanMode"    -> "Exit Plan Mode"
 * - "HTMLParser"      -> "HTML Parser"
 * - "getHTTPResponse" -> "get HTTP Response"
 * - "already spaced"  -> "already spaced"
 */
export function expandCamelCase(text: string): string {
  return text
    .replace(/([a-z\d])([A-Z])/g, "$1 $2") // lowerUpper boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"); // acronym boundary (e.g. HTMLParser -> HTML Parser)
}

/**
 * Normalize text for search: expand CamelCase boundaries, lowercase, and trim.
 * Apply to both query and haystack for consistent matching.
 */
export function normalizeForSearch(text: string): string {
  return expandCamelCase(text).toLowerCase().trim();
}

/** Returns true if every word in `query` appears somewhere in `text` (after normalization). */
export function multiWordMatch(text: string, query: string): boolean {
  const normalized = normalizeForSearch(text);
  const words = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.every((w) => normalized.includes(w));
}
