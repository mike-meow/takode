/**
 * Shorten an absolute path by replacing the home directory prefix with ~.
 * Detects /home/<user> and /Users/<user> patterns from the path itself.
 */
export function shortenHome(path: string): string {
  // Match /home/<user> (Linux) or /Users/<user> (macOS)
  const match = path.match(/^(\/(?:home|Users)\/[^/]+)/);
  if (match) return path.replace(match[1], "~");
  return path;
}

/**
 * Returns cwd as a relative subpath of repoRoot, or null if they're the same.
 * Example: cwdRelativeToRoot("/home/user/repo/web", "/home/user/repo") => "web"
 */
export function cwdRelativeToRoot(cwd: string, repoRoot: string): string | null {
  if (cwd === repoRoot) return null;
  if (cwd.startsWith(repoRoot + "/")) return cwd.slice(repoRoot.length + 1);
  return null;
}
