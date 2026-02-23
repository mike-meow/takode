import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync, copyFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { spawn } from "node:child_process";
import * as gitUtils from "./git-utils.js";
import type { SdkSessionInfo } from "./cli-launcher.js";
import type { CliLauncher } from "./cli-launcher.js";
import type { WorktreeTracker } from "./worktree-tracker.js";
import type { WsBridge } from "./ws-bridge.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MigrationManifest {
  version: 1;
  exportedAt: number;
  hostname: string;
  homeDir: string;
  port: number;
  includeRecordings: boolean;
  stats: { sessionCount: number };
}

export interface ImportStats {
  sessionsNew: number;
  sessionsUpdated: number;
  sessionsSkipped: number;
  worktreeSessionsNeedingRecreation: number;
  pathsRewritten: boolean;
  filesImported: number;
  filesSkipped: number;
  warnings: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const COMPANION_HOME = join(homedir(), ".companion");
const MANIFEST_NAME = ".export-manifest.json";
const STAGING_DIR = ".import-staging";

const ASSET_DIRS = ["images", "questmaster", "codex-home", "envs", "cron", "assistant"];
const EXPORT_FILES = ["worktrees.json", "containers.json", "session-names.json"];

// ─── Export ─────────────────────────────────────────────────────────────────

export async function runExport(options: {
  port: number;
  outputPath: string;
  includeRecordings?: boolean;
}): Promise<void> {
  const { port, outputPath, includeRecordings } = options;
  const paths: string[] = [];

  // Only export sessions for the current port
  const portSessionDir = join("sessions", String(port));
  if (existsSync(join(COMPANION_HOME, portSessionDir))) paths.push(portSessionDir);

  for (const dir of ASSET_DIRS) {
    if (existsSync(join(COMPANION_HOME, dir))) paths.push(dir);
  }
  for (const file of EXPORT_FILES) {
    if (existsSync(join(COMPANION_HOME, file))) paths.push(file);
  }
  if (includeRecordings && existsSync(join(COMPANION_HOME, "recordings"))) {
    paths.push("recordings");
  }

  // Count sessions
  let sessionCount = 0;
  const portDir = join(COMPANION_HOME, portSessionDir);
  if (existsSync(portDir)) {
    for (const f of readdirSync(portDir)) {
      if (f.endsWith(".json") && f !== "launcher.json") sessionCount++;
    }
  }

  // Write manifest
  const manifest: MigrationManifest = {
    version: 1,
    exportedAt: Date.now(),
    hostname: hostname(),
    homeDir: homedir(),
    port,
    includeRecordings: !!includeRecordings,
    stats: { sessionCount },
  };
  const manifestPath = join(COMPANION_HOME, MANIFEST_NAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  paths.push(MANIFEST_NAME);

  console.log(`Exporting ${sessionCount} sessions (port ${port}) from ${COMPANION_HOME}`);
  if (includeRecordings) console.log(`  Including recordings`);

  try {
    await runShell(
      `tar -cf - ${paths.map(shellEscape).join(" ")} | zstd -3 -o ${shellEscape(outputPath)}`,
      { cwd: COMPANION_HOME },
    );
  } finally {
    try { rmSync(manifestPath); } catch { /* ignore */ }
  }

  const archiveSize = statSync(outputPath).size;
  console.log(`Archive created: ${outputPath} (${(archiveSize / 1024 / 1024).toFixed(1)} MB)`);
}

// ─── Import ─────────────────────────────────────────────────────────────────

/**
 * Import from a .tar.zst archive. Idempotent: files in the archive overwrite
 * existing ones only if the archive version is newer (by mtime).
 */
export async function runImport(archivePath: string, targetPort: number): Promise<ImportStats> {
  const stagingDir = join(COMPANION_HOME, STAGING_DIR);
  const stats: ImportStats = {
    sessionsNew: 0, sessionsUpdated: 0, sessionsSkipped: 0,
    worktreeSessionsNeedingRecreation: 0, pathsRewritten: false,
    filesImported: 0, filesSkipped: 0, warnings: [],
  };

  mkdirSync(COMPANION_HOME, { recursive: true });
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });

  try {
    console.log(`Extracting archive...`);
    await runShell(`zstd -d -c ${shellEscape(archivePath)} | tar -xf -`, { cwd: stagingDir });

    const manifestPath = join(stagingDir, MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
      throw new Error("Invalid archive: missing manifest. Was this created with `companion export`?");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as MigrationManifest;

    console.log(`Archive from: ${manifest.hostname} (${manifest.homeDir})`);
    console.log(`Sessions: ${manifest.stats.sessionCount}`);

    // Path rewriting. rewritePathsInFile preserves original mtime via utimesSync,
    // so "newer wins" comparisons below work correctly even after rewriting.
    const oldHome = manifest.homeDir;
    const newHome = homedir();
    if (oldHome !== newHome) {
      console.log(`Rewriting paths: ${oldHome} → ${newHome}`);
      rewritePathsInDir(stagingDir, oldHome, newHome);
      stats.pathsRewritten = true;
    }

    // ── Sessions: merge all archived port dirs into the target port ──
    // Clear cliSessionId from staged launcher.json entries — the CLI's
    // internal conversations don't exist on the new machine, so --resume
    // would fail. Stripping before merge ensures fresh starts.
    const stagedSessions = join(stagingDir, "sessions");
    if (existsSync(stagedSessions)) {
      for (const portEntry of readdirSync(stagedSessions)) {
        const launcherPath = join(stagedSessions, portEntry, "launcher.json");
        if (existsSync(launcherPath)) {
          try {
            const entries = JSON.parse(readFileSync(launcherPath, "utf-8"));
            if (Array.isArray(entries)) {
              for (const entry of entries) delete entry.cliSessionId;
              writeFileSync(launcherPath, JSON.stringify(entries, null, 2), "utf-8");
            }
          } catch { /* skip */ }
        }
      }
    }

    const targetDir = join(COMPANION_HOME, "sessions", String(targetPort));
    mkdirSync(targetDir, { recursive: true });

    if (existsSync(stagedSessions)) {
      for (const portEntry of readdirSync(stagedSessions)) {
        const portDir = join(stagedSessions, portEntry);
        if (!statSync(portDir).isDirectory()) continue;

        for (const file of readdirSync(portDir)) {
          if (file === "launcher.json") {
            mergeLauncherArray(join(portDir, file), join(targetDir, file));
            continue;
          }
          if (!file.endsWith(".json")) continue;

          const srcPath = join(portDir, file);
          const targetPath = join(targetDir, file);

          if (!existsSync(targetPath)) {
            copyFileSync(srcPath, targetPath);
            stats.sessionsNew++;
          } else if (statSync(srcPath).mtimeMs > statSync(targetPath).mtimeMs) {
            copyFileSync(srcPath, targetPath);
            stats.sessionsUpdated++;
          } else {
            stats.sessionsSkipped++;
            continue;
          }
          // Count worktree sessions that need on-demand recreation
          try {
            const data = JSON.parse(readFileSync(targetPath, "utf-8"));
            if (data?.state?.is_worktree && !existsSync(data.state.cwd)) {
              stats.worktreeSessionsNeedingRecreation++;
            }
          } catch { /* skip */ }
        }
      }
    }

    // ── Metadata files (merge, don't overwrite) ──────────────────
    mergeJsonArray(join(stagingDir, "worktrees.json"), join(COMPANION_HOME, "worktrees.json"), "sessionId");
    mergeJsonByKey(join(stagingDir, "session-names.json"), join(COMPANION_HOME, "session-names.json"));
    const stagedContainers = join(stagingDir, "containers.json");
    if (existsSync(stagedContainers) && !existsSync(join(COMPANION_HOME, "containers.json"))) {
      copyFileSync(stagedContainers, join(COMPANION_HOME, "containers.json"));
    }

    // ── Asset directories (newer wins) ───────────────────────────
    for (const dir of ["images", "questmaster", "codex-home", "envs", "cron", "assistant", "recordings"]) {
      const stagedDir = join(stagingDir, dir);
      if (existsSync(stagedDir)) copyDirNewerWins(stagedDir, join(COMPANION_HOME, dir), stats);
    }

    return stats;
  } finally {
    try { rmSync(stagingDir, { recursive: true }); } catch { /* ignore */ }
  }
}

/** Print import stats to stdout (CLI only). */
export function printImportStats(stats: ImportStats): void {
  console.log(`\n─── Import complete ───\n`);
  console.log(`Sessions: ${stats.sessionsNew} new, ${stats.sessionsUpdated} updated, ${stats.sessionsSkipped} skipped`);
  console.log(`Files: ${stats.filesImported} imported, ${stats.filesSkipped} skipped`);
  if (stats.pathsRewritten) console.log(`Paths rewritten for this machine`);
  if (stats.worktreeSessionsNeedingRecreation > 0) {
    console.log(`${stats.worktreeSessionsNeedingRecreation} worktree sessions will recreate on open`);
  }
  if (stats.warnings.length > 0) {
    for (const w of stats.warnings) console.log(`  Warning: ${w}`);
  }
  console.log();
}

// ─── Path Rewriting ─────────────────────────────────────────────────────────

export function rewritePathsInDir(dir: string, oldHome: string, newHome: string): void {
  if (oldHome === newHome) return;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      rewritePathsInDir(fullPath, oldHome, newHome);
    } else if (entry.endsWith(".json")) {
      rewritePathsInFile(fullPath, oldHome, newHome);
    }
  }
}

/**
 * Rewrite paths in a single JSON file, preserving the original mtime.
 * Uses trailing-slash matching to avoid false prefix matches
 * (e.g. /home/jiayi won't match /home/jiayiwei).
 */
export function rewritePathsInFile(filePath: string, oldHome: string, newHome: string): void {
  if (oldHome === newHome) return;
  const st = statSync(filePath);
  const content = readFileSync(filePath, "utf-8");
  let rewritten = content.replaceAll(oldHome + "/", newHome + "/");
  rewritten = rewritten.replaceAll(oldHome + '"', newHome + '"');
  if (rewritten !== content) {
    writeFileSync(filePath, rewritten, "utf-8");
    utimesSync(filePath, st.atime, st.mtime); // preserve original mtime
  }
}

// ─── On-Demand Worktree Recreation ──────────────────────────────────────────

export function recreateWorktreeIfMissing(
  sessionId: string,
  info: SdkSessionInfo,
  deps: { launcher: CliLauncher; worktreeTracker: WorktreeTracker; wsBridge: WsBridge },
): { recreated: boolean; error?: string } {
  if (existsSync(info.cwd)) return { recreated: false };

  if (!info.isWorktree || !info.repoRoot || !info.branch) {
    return { recreated: false, error: `Working directory not found: ${info.cwd}` };
  }

  const repoInfo = gitUtils.getRepoInfo(info.repoRoot);
  if (!repoInfo) {
    return { recreated: false, error: `Repository not found at ${info.repoRoot}. Please clone it first, then try again.` };
  }

  const result = gitUtils.ensureWorktree(repoInfo.repoRoot, info.branch, {
    baseBranch: repoInfo.defaultBranch,
    createBranch: false,
    forceNew: true,
  });

  deps.launcher.updateWorktree(sessionId, { cwd: result.worktreePath, actualBranch: result.actualBranch });
  deps.worktreeTracker.addMapping({
    sessionId, repoRoot: info.repoRoot, branch: info.branch,
    actualBranch: result.actualBranch, worktreePath: result.worktreePath, createdAt: Date.now(),
  });
  deps.wsBridge.markWorktree(sessionId, info.repoRoot, result.worktreePath, repoInfo.defaultBranch, info.branch);

  console.log(`[migration] Recreated worktree for session ${sessionId}: ${result.worktreePath}`);
  return { recreated: true };
}

// ─── Merge Helpers ──────────────────────────────────────────────────────────

/** Merge launcher.json arrays by sessionId. */
function mergeLauncherArray(importedPath: string, targetPath: string): void {
  mergeJsonArray(importedPath, targetPath, "sessionId");
}

/** Merge a JSON object: imported keys fill gaps or overwrite existing. */
function mergeJsonByKey(importedPath: string, targetPath: string): void {
  if (!existsSync(importedPath)) return;
  try {
    const imported = JSON.parse(readFileSync(importedPath, "utf-8"));
    if (!existsSync(targetPath)) {
      mkdirSync(join(targetPath, ".."), { recursive: true });
      writeFileSync(targetPath, JSON.stringify(imported, null, 2), "utf-8");
      return;
    }
    const existing = JSON.parse(readFileSync(targetPath, "utf-8"));
    Object.assign(existing, imported);
    writeFileSync(targetPath, JSON.stringify(existing, null, 2), "utf-8");
  } catch { /* keep existing on failure */ }
}

/** Merge a JSON array by a unique key field. Imported entries replace existing. */
function mergeJsonArray(importedPath: string, targetPath: string, key: string): void {
  if (!existsSync(importedPath)) return;
  try {
    const imported = JSON.parse(readFileSync(importedPath, "utf-8")) as Array<Record<string, unknown>>;
    if (!existsSync(targetPath)) {
      mkdirSync(join(targetPath, ".."), { recursive: true });
      writeFileSync(targetPath, JSON.stringify(imported, null, 2), "utf-8");
      return;
    }
    const existing = JSON.parse(readFileSync(targetPath, "utf-8")) as Array<Record<string, unknown>>;
    const map = new Map(existing.map((item) => [item[key] as string, item]));
    for (const item of imported) map.set(item[key] as string, item);
    writeFileSync(targetPath, JSON.stringify([...map.values()], null, 2), "utf-8");
  } catch { /* keep existing on failure */ }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Recursively copy a directory. Existing files are only overwritten if src is newer. */
function copyDirNewerWins(src: string, dest: string, stats: ImportStats): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirNewerWins(srcPath, destPath, stats);
    } else if (!existsSync(destPath) || statSync(srcPath).mtimeMs > statSync(destPath).mtimeMs) {
      copyFileSync(srcPath, destPath);
      stats.filesImported++;
    } else {
      stats.filesSkipped++;
    }
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function runShell(cmd: string, opts: { cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-c", cmd], { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (exit ${code}): ${cmd}\n${stderr}`));
    });
    proc.on("error", (err) => reject(new Error(`Failed to spawn: ${cmd}\n${err.message}`)));
  });
}
