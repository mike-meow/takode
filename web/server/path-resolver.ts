/**
 * PATH discovery and binary resolution for service environments.
 *
 * When The Companion runs as a macOS launchd or Linux systemd service, it inherits
 * a restricted PATH that omits directories from version managers (nvm, fnm, volta,
 * mise, etc.) and user-local installs (~/.local/bin, ~/.cargo/bin). This module
 * captures the user's real shell PATH at runtime and provides binary resolution
 * that works regardless of how the server was started.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Capture the user's full interactive shell PATH by spawning a login shell.
 * This picks up all version manager initializations (nvm, fnm, volta, mise, etc.).
 * Falls back to probing common directories if shell sourcing fails.
 */
export function captureUserShellPath(): string {
  try {
    const shell = process.env.SHELL || "/bin/bash";
    const captured = execSync(
      // sync-ok: cold path, binary resolution at startup
      `${shell} -lic 'echo "___PATH_START___$PATH___PATH_END___"'`,
      {
        encoding: "utf-8",
        timeout: 10_000,
        env: { HOME: homedir(), USER: process.env.USER, SHELL: shell },
      },
    );
    const match = captured.match(/___PATH_START___(.+)___PATH_END___/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Shell sourcing failed (timeout, compinit prompt, etc.)
  }

  return buildFallbackPath();
}

/**
 * Build a PATH by probing common binary installation directories.
 * Used as fallback when shell-sourcing fails.
 */
export function buildFallbackPath(): string {
  const home = homedir();
  const candidates = [
    // Standard system paths
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    // Companion CLI tools
    join(home, ".companion", "bin"),
    // Bun
    join(home, ".bun", "bin"),
    // Claude CLI / user-local installs
    join(home, ".local", "bin"),
    // Cargo / Rust
    join(home, ".cargo", "bin"),
    // Volta (Node version manager)
    join(home, ".volta", "bin"),
    // mise (formerly rtx)
    join(home, ".local", "share", "mise", "shims"),
    // pyenv
    join(home, ".pyenv", "bin"),
    join(home, ".pyenv", "shims"),
    // Go
    join(home, "go", "bin"),
    "/usr/local/go/bin",
    // Deno
    join(home, ".deno", "bin"),
  ];

  // Probe nvm-managed node versions
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  const nvmVersionsDir = join(nvmDir, "versions", "node");
  if (existsSync(nvmVersionsDir)) {
    // sync-ok: cold path, binary resolution at startup
    try {
      for (const v of readdirSync(nvmVersionsDir)) {
        // sync-ok: cold path, binary resolution at startup
        candidates.push(join(nvmVersionsDir, v, "bin"));
      }
    } catch {
      /* ignore */
    }
  }

  // fnm (Fast Node Manager) — versions stored in fnm multishell or XDG data
  const fnmDir = join(home, "Library", "Application Support", "fnm", "node-versions");
  if (existsSync(fnmDir)) {
    // sync-ok: cold path, binary resolution at startup
    try {
      for (const v of readdirSync(fnmDir)) {
        // sync-ok: cold path, binary resolution at startup
        candidates.push(join(fnmDir, v, "installation", "bin"));
      }
    } catch {
      /* ignore */
    }
  }

  return [...new Set(candidates.filter((dir) => existsSync(dir)))].join(":"); // sync-ok: cold path, binary resolution at startup
}

// ─── Tilde expansion ─────────────────────────────────────────────────────────

/**
 * Expand leading `~` or `~/` to the current user's home directory.
 * Shell-style tilde expansion doesn't happen automatically when paths
 * come from browser text input — Node's path.resolve() treats `~` as literal.
 */
export function expandTilde(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return join(homedir(), inputPath.slice(2));
  return inputPath;
}

// ─── Shell environment capture (cached) ──────────────────────────────────────

let _cachedShellEnv: Record<string, string> | null = null;

/**
 * Capture specific environment variables from the user's interactive login shell.
 *
 * When the Companion runs as a daemon or is started outside the user's normal
 * shell (e.g. via systemd, launchd, or a bare `bun server/index.ts`), important
 * env vars set by shell profiles (e.g. LITELLM_API_KEY from mai-agents) are
 * missing from process.env. This function spawns a login shell — just like
 * captureUserShellPath() — to capture the specified env vars.
 *
 * Result is cached after the first call (the user's shell env doesn't change
 * during the server's lifetime).
 */
export function captureUserShellEnv(varNames: string[]): Record<string, string> {
  if (_cachedShellEnv) {
    const result: Record<string, string> = {};
    for (const name of varNames) {
      if (_cachedShellEnv[name] !== undefined) result[name] = _cachedShellEnv[name];
    }
    return result;
  }

  _cachedShellEnv = {};

  if (varNames.length === 0) return {};

  try {
    const shell = process.env.SHELL || "/bin/bash";
    // Print each requested var as KEY=VALUE, using a unique delimiter to avoid
    // collisions with noisy shell startup output.
    const printCommands = varNames.map((name) => `echo "___ENV_${name}___=\${${name}:-}"`).join("; ");
    const captured = execSync(
      // sync-ok: cold path, one-time capture at startup
      `${shell} -lic '${printCommands}'`,
      {
        encoding: "utf-8",
        timeout: 10_000,
        env: { HOME: homedir(), USER: process.env.USER, SHELL: shell },
      },
    );

    for (const name of varNames) {
      const pattern = new RegExp(`___ENV_${name}___=(.*)`);
      const match = captured.match(pattern);
      if (match?.[1] && match[1].length > 0) {
        _cachedShellEnv[name] = match[1];
      }
    }
  } catch {
    // Shell sourcing failed — fall back to process.env
  }

  // Also check process.env for any vars not captured from the shell
  for (const name of varNames) {
    if (!_cachedShellEnv[name] && process.env[name]) {
      _cachedShellEnv[name] = process.env[name]!;
    }
  }

  return { ..._cachedShellEnv };
}

/** Reset the cached shell env (for testing). */
export function _resetShellEnvCache(): void {
  _cachedShellEnv = null;
}

// ─── Enriched PATH (cached) ───────────────────────────────────────────────────

let _cachedPath: string | null = null;

/**
 * Returns an enriched PATH that merges the user's shell PATH (or probed common
 * directories) with the current process PATH. Deduplicates entries.
 * Result is cached after the first call.
 */
export function getEnrichedPath(): string {
  if (_cachedPath) return _cachedPath;

  const currentPath = process.env.PATH || "";
  const userPath = captureUserShellPath();

  // Agent-facing shims always come first so built-in commands remain
  // discoverable even when the user's shell PATH omits ~/.companion/bin
  // or ~/.local/bin.
  const companionBin = join(homedir(), ".companion", "bin");
  const localBin = join(homedir(), ".local", "bin");

  // Merge: companion/local shims first, then user shell PATH, then current process PATH
  const allDirs = [companionBin, localBin, ...userPath.split(":"), ...currentPath.split(":")];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const dir of allDirs) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      deduped.push(dir);
    }
  }

  _cachedPath = deduped.join(":");
  return _cachedPath;
}

/** Reset the cached PATH (for testing). */
export function _resetPathCache(): void {
  _cachedPath = null;
}

// ─── Binary resolution ────────────────────────────────────────────────────────

/**
 * Resolve a binary name to an absolute path using the enriched PATH.
 * Returns null if the binary is not found anywhere.
 */
export function resolveBinary(name: string): string | null {
  if (name.startsWith("/")) {
    return existsSync(name) ? name : null; // sync-ok: cold path, binary resolution at startup
  }

  const enrichedPath = getEnrichedPath();
  try {
    const resolved = execSync(`which ${name.replace(/[^a-zA-Z0-9._@/-]/g, "")}`, {
      // sync-ok: cold path, binary resolution at startup

      encoding: "utf-8",
      timeout: 5_000,
      env: { ...process.env, PATH: enrichedPath },
    }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/**
 * Returns a PATH string suitable for embedding in service definitions
 * (plist/systemd unit). Captures the user's shell PATH at install time.
 */
export function getServicePath(): string {
  return getEnrichedPath();
}
