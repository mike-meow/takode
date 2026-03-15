import { access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);

let cached: string | null = null;

/**
 * Resolve the ripgrep binary path.
 * Prefers the vendored binary from @anthropic-ai/claude-agent-sdk,
 * falls back to system-installed rg.
 */
export async function getRipgrepPath(): Promise<string> {
  if (cached) return cached;
  cached = (await resolveFromSdk()) ?? (await resolveFromSystem()) ?? "rg";
  return cached;
}

async function resolveFromSdk(): Promise<string | null> {
  try {
    const require = createRequire(import.meta.url);
    // Resolve the package root via its exported entrypoint. The internal
    // cli.js file exists on disk but is not exported, so resolving it directly
    // can fail under modern package "exports" rules.
    const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const pkgRoot = dirname(sdkEntry);
    const arch = process.arch; // 'x64' | 'arm64'
    const platform = process.platform; // 'linux' | 'darwin' | 'win32'
    const ext = platform === "win32" ? ".exe" : "";
    const rgPath = join(pkgRoot, "vendor", "ripgrep", `${arch}-${platform}`, `rg${ext}`);
    await access(rgPath);
    return rgPath;
  } catch {
    return null;
  }
}

async function resolveFromSystem(): Promise<string | null> {
  try {
    const cmd = process.platform === "win32" ? "where rg" : "which rg";
    const { stdout } = await execAsync(cmd, { timeout: 3000 });
    const path = stdout.trim().split("\n")[0];
    if (path) {
      await access(path);
      return path;
    }
  } catch {
    // not found
  }
  return null;
}
