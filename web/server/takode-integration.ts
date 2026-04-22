import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { buildInstalledCliWrapper, COMPANION_BIN_DIR, resolveStableWrapperScriptPath } from "./cli-wrapper-paths.js";

/**
 * Set up the Takode CLI wrapper script at ~/.companion/bin/takode.
 * Skill symlinking is handled centrally by ensureSkillSymlinks().
 */
export async function ensureTakodeIntegration(packageRoot: string): Promise<void> {
  mkdirSync(COMPANION_BIN_DIR, { recursive: true }); // sync-ok: startup cold path
  const sharedWrapperPath = join(COMPANION_BIN_DIR, "takode");
  const stableScript = await resolveStableWrapperScriptPath(packageRoot, "takode");
  const sharedWrapper = buildInstalledCliWrapper("takode", stableScript);
  writeFileSync(sharedWrapperPath, sharedWrapper, "utf-8"); // sync-ok: startup cold path
  chmodSync(sharedWrapperPath, 0o755); // sync-ok: startup cold path

  console.log("[takode-integration] CLI wrappers installed");
}
