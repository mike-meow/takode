import { getName } from "./session-names.js";

/**
 * Format a session ID for log output: short hash + human-readable name (if set).
 * Examples:
 *   bcc31e64 "Debug persistent NFS issues"
 *   7316c239
 */
export function sessionTag(id: string): string {
  const short = id.slice(0, 8);
  const name = getName(id);
  return name ? `${short} "${name}"` : short;
}
