import { existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getLegacyCodexHome } from "./codex-home.js";
import { resolveStableWrapperRepoRoot } from "./cli-wrapper-paths.js";

/**
 * Resolve the main repository root, not the current worktree.
 * In a worktree, `import.meta.url` points to an ephemeral path that breaks when
 * the worktree is removed. `git rev-parse --git-common-dir` gives the main repo's
 * .git directory, from which we derive a stable root.
 */
let mainRepoRootPromise: Promise<string> | null = null;

function resolveMainRepoRoot(): Promise<string> {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  mainRepoRootPromise ??= resolveStableWrapperRepoRoot(packageRoot);
  return mainRepoRootPromise;
}

const HOME = homedir();
const CLAUDE_SKILLS_HOME = join(HOME, ".claude", "skills");
const CODEX_SKILLS_HOME = join(getLegacyCodexHome(), "skills");
const AGENTS_SKILLS_HOME = join(HOME, ".agents", "skills");

/**
 * Symlink repo skills into the global Claude, Codex, and agent skill homes so
 * all sessions discover the same project-defined skills regardless of working
 * directory or backend.
 *
 * Call once at startup with the list of skill directory names (slugs) that
 * live under `.claude/skills/` in the repo.
 */
export async function ensureSkillSymlinks(slugs: string[]): Promise<void> {
  const mainRepoRoot = await resolveMainRepoRoot();
  const repoClaudeSkillsHome = join(mainRepoRoot, ".claude", "skills");
  const repoCodexSkillsHome = join(mainRepoRoot, ".codex", "skills");
  const repoAgentsSkillsHome = join(mainRepoRoot, ".agents", "skills");

  for (const slug of slugs) {
    const repoDir = join(repoClaudeSkillsHome, slug);
    if (!existsSync(repoDir)) {
      // sync-ok: startup cold path
      console.warn(`[skill-symlink] Skipping missing repo skill source: ${repoDir}`);
      continue;
    }
    ensureSymlink(repoDir, join(CLAUDE_SKILLS_HOME, slug));
    ensureSymlink(resolveRepoSkillDir(slug, repoCodexSkillsHome, repoClaudeSkillsHome), join(CODEX_SKILLS_HOME, slug));
    ensureSymlink(
      resolveRepoSkillDir(slug, repoAgentsSkillsHome, repoClaudeSkillsHome),
      join(AGENTS_SKILLS_HOME, slug),
    );
  }
  console.log(`[skill-symlink] ${slugs.join(", ")} symlinked for Claude, Codex, and agents`);
}

function resolveRepoSkillDir(slug: string, preferredRepoHome: string, fallbackRepoHome: string): string {
  const preferredDir = join(preferredRepoHome, slug);
  if (existsSync(preferredDir)) return preferredDir; // sync-ok: startup cold path
  return join(fallbackRepoHome, slug);
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
