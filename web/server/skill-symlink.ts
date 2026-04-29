import {
  existsSync,
  mkdirSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  unlinkSync,
  rmSync,
  type Dirent,
} from "node:fs";
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
const AGENTS_SKILLS_HOME = join(HOME, ".agents", "skills");
const LEGACY_CODEX_SKILLS_HOME = join(getLegacyCodexHome(), "skills");

/**
 * Symlink repo skills into the global Claude and agent skill homes so all
 * sessions discover the same project-defined skills regardless of working
 * directory. `.agents` is the non-Claude source used by Codex/new agents;
 * legacy `.codex/skills` content is compatibility-only migration input.
 *
 * Call once at startup with the core skill directory names (slugs). Startup
 * also discovers repo skill slugs from `.claude/skills` and `.agents/skills`
 * so agent-only project skills are installed without touching Claude's root.
 */
export async function ensureSkillSymlinks(slugs: string[]): Promise<void> {
  const mainRepoRoot = await resolveMainRepoRoot();
  const repoClaudeSkillsHome = join(mainRepoRoot, ".claude", "skills");
  const repoAgentsSkillsHome = join(mainRepoRoot, ".agents", "skills");

  migrateLegacyCodexSkillsToAgents();

  const allSlugs = discoverRepoSkillSlugs(slugs, repoClaudeSkillsHome, repoAgentsSkillsHome);
  for (const slug of allSlugs) {
    const repoClaudeDir = join(repoClaudeSkillsHome, slug);
    const repoAgentsDir = join(repoAgentsSkillsHome, slug);
    const hasClaudeSource = existsSync(repoClaudeDir); // sync-ok: startup cold path
    const hasAgentsSource = existsSync(repoAgentsDir); // sync-ok: startup cold path
    if (!hasClaudeSource && !hasAgentsSource) {
      console.warn(`[skill-symlink] Skipping missing repo skill source: ${repoClaudeDir} or ${repoAgentsDir}`);
      continue;
    }

    if (hasClaudeSource) {
      ensureSymlink(repoClaudeDir, join(CLAUDE_SKILLS_HOME, slug));
    }
    ensureSymlink(hasAgentsSource ? repoAgentsDir : repoClaudeDir, join(AGENTS_SKILLS_HOME, slug));
  }
  console.log(`[skill-symlink] ${allSlugs.join(", ")} symlinked for Claude and agents`);
}

function discoverRepoSkillSlugs(
  requiredSlugs: string[],
  repoClaudeSkillsHome: string,
  repoAgentsSkillsHome: string,
): string[] {
  return [
    ...new Set([
      ...requiredSlugs,
      ...readRepoSkillSlugs(repoClaudeSkillsHome),
      ...readRepoSkillSlugs(repoAgentsSkillsHome),
    ]),
  ];
}

function migrateLegacyCodexSkillsToAgents(): void {
  if (!existsSync(LEGACY_CODEX_SKILLS_HOME)) return; // sync-ok: startup cold path

  let entries: Dirent[];
  try {
    entries = readdirSync(LEGACY_CODEX_SKILLS_HOME, { withFileTypes: true }); // sync-ok: startup cold path
  } catch (error) {
    console.warn(`[skill-symlink] Failed to inspect legacy Codex skills:`, error);
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const legacyDir = join(LEGACY_CODEX_SKILLS_HOME, entry.name);
    const agentsDir = join(AGENTS_SKILLS_HOME, entry.name);
    if (existsSync(agentsDir)) continue; // sync-ok: startup cold path
    ensureSymlink(legacyDir, agentsDir);
  }
}

function readRepoSkillSlugs(repoSkillsHome: string): string[] {
  if (!existsSync(repoSkillsHome)) return []; // sync-ok: startup cold path

  try {
    return readdirSync(repoSkillsHome, { withFileTypes: true }) // sync-ok: startup cold path
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    console.warn(`[skill-symlink] Failed to inspect repo skills: ${repoSkillsHome}`, error);
    return [];
  }
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
