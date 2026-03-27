import { mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

/**
 * Resolve the main repository root, not the current worktree.
 * In a worktree, `import.meta.url` points to an ephemeral path that breaks when
 * the worktree is removed. `git rev-parse --git-common-dir` gives the main repo's
 * .git directory, from which we derive a stable root.
 */
function resolveMainRepoRoot(): string {
  const localRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    // sync-ok: startup cold path, one-shot git query
    const gitCommonDir = execSync("git rev-parse --git-common-dir", {
      cwd: localRoot,
      encoding: "utf-8",
    }).trim();
    return gitCommonDir === ".git" ? localRoot : dirname(gitCommonDir);
  } catch {
    return localRoot;
  }
}

const MAIN_REPO_ROOT = resolveMainRepoRoot();
const HOME = homedir();

/**
 * Symlink repo skills into ~/.claude/skills/ and ~/.codex/skills/ so all
 * sessions discover them regardless of working directory.
 *
 * Call once at startup with the list of skill directory names (slugs) that
 * live under `.claude/skills/` in the repo.
 */
export function ensureSkillSymlinks(slugs: string[]): void {
  for (const slug of slugs) {
    const repoDir = join(MAIN_REPO_ROOT, ".claude", "skills", slug);
    ensureSymlink(repoDir, join(HOME, ".claude", "skills", slug));
    ensureSymlink(repoDir, join(HOME, ".codex", "skills", slug));
  }
  console.log(`[skill-symlink] ${slugs.join(", ")} symlinked for Claude and Codex`);
}

/**
 * Idempotent symlink: points targetDir → sourceDir, replacing whatever
 * was there before (stale symlink, real directory from old copy-based install, etc.).
 */
function ensureSymlink(sourceDir: string, targetDir: string): void {
  mkdirSync(dirname(targetDir), { recursive: true }); // sync-ok: startup cold path

  try {
    const stat = lstatSync(targetDir); // sync-ok: startup cold path
    if (stat.isSymbolicLink()) {
      if (readlinkSync(targetDir) === sourceDir) return; // sync-ok: startup cold path
      unlinkSync(targetDir); // sync-ok: startup cold path
    } else {
      rmSync(targetDir, { recursive: true }); // sync-ok: startup cold path
    }
  } catch {
    // Doesn't exist -- will create below
  }

  symlinkSync(sourceDir, targetDir); // sync-ok: startup cold path
}
