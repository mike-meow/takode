import { mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

/**
 * Resolve the skill source to the main repository root, not the current worktree.
 * In a worktree, `import.meta.url` points to an ephemeral path that breaks when
 * the worktree is removed. `git rev-parse --git-common-dir` gives the main repo's
 * .git directory, from which we derive a stable root.
 */
function resolveMainRepoSkillDir(): string {
  const localRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    // sync-ok: startup cold path, one-shot git query
    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      cwd: localRoot,
      encoding: "utf-8",
    }).trim();
    // gitCommonDir is either ".git" (main repo) or an absolute path like "/path/to/main/.git"
    const mainRoot = gitCommonDir === ".git" ? localRoot : dirname(gitCommonDir);
    return join(mainRoot, ".claude", "skills", "cron-scheduling");
  } catch {
    // Not in a git repo or git unavailable -- fall back to local path
    return join(localRoot, ".claude", "skills", "cron-scheduling");
  }
}

const REPO_SKILL_DIR = resolveMainRepoSkillDir();
const CLAUDE_SKILL_DIR = join(homedir(), ".claude", "skills", "cron-scheduling");
const CODEX_SKILL_DIR = join(homedir(), ".codex", "skills", "cron-scheduling");

/**
 * Set up the /cron-scheduling skill for both Claude Code and Codex sessions.
 * Creates symlinks from the user's global skill directories to the
 * repo-local copy so all sessions discover it automatically.
 */
export function ensureCronIntegration(): void {
  ensureSkillSymlink(CLAUDE_SKILL_DIR);
  ensureSkillSymlink(CODEX_SKILL_DIR);
  console.log("[cron-integration] skill symlinked for Claude and Codex");
}

function ensureSkillSymlink(targetDir: string): void {
  mkdirSync(dirname(targetDir), { recursive: true }); // sync-ok: startup cold path

  // If it already exists, check if it's the correct symlink
  try {
    const stat = lstatSync(targetDir); // sync-ok: startup cold path
    if (stat.isSymbolicLink()) {
      const existing = readlinkSync(targetDir); // sync-ok: startup cold path
      if (existing === REPO_SKILL_DIR) return; // Already correct
      // Wrong target -- remove and re-create
      unlinkSync(targetDir); // sync-ok: startup cold path
    } else {
      // It's a real directory (e.g. from a previous copy-based install) -- remove
      // so we can replace with a symlink to the repo copy
      rmSync(targetDir, { recursive: true }); // sync-ok: startup cold path
    }
  } catch {
    // Doesn't exist -- fine, we'll create it
  }

  symlinkSync(REPO_SKILL_DIR, targetDir); // sync-ok: startup cold path
}
