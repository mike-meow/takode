import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access, readFile, writeFile, unlink, symlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Stats } from "node:fs";
import type { BackendType } from "./session-types.js";

const execPromise = promisify(execCb);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanStaleGuardrailsFile(worktreePath: string): Promise<void> {
  const staleStart = "<!-- WORKTREE_GUARDRAILS_START -->";
  const staleEnd = "<!-- WORKTREE_GUARDRAILS_END -->";
  const claudeMdPath = join(worktreePath, ".claude", "CLAUDE.md");
  try {
    if (!(await fileExists(claudeMdPath))) return;
    const content = await readFile(claudeMdPath, "utf-8");
    const startIdx = content.indexOf(staleStart);
    const endIdx = content.indexOf(staleEnd);
    if (startIdx === -1 || endIdx === -1) return;

    const cleaned = (content.slice(0, startIdx) + content.slice(endIdx + staleEnd.length)).trim();
    if (cleaned.length === 0) {
      await unlink(claudeMdPath);
      console.log(`[cli-launcher] Removed stale .claude/CLAUDE.md (contained only old guardrails)`);
    } else {
      await writeFile(claudeMdPath, `${cleaned}\n`, "utf-8");
      console.log(`[cli-launcher] Stripped stale guardrails block from .claude/CLAUDE.md`);
    }

    try {
      await execPromise(`git --no-optional-locks update-index --skip-worktree .claude/CLAUDE.md`, {
        cwd: worktreePath,
        timeout: 5000,
      });
    } catch (error) {
      console.debug(`[cli-launcher] Could not mark .claude/CLAUDE.md skip-worktree:`, error);
    }
  } catch (error) {
    console.debug(`[cli-launcher] cleanStaleGuardrailsFile error (non-critical):`, error);
  }
}

async function addWorktreeGitExclude(worktreePath: string, pattern: string): Promise<void> {
  try {
    const dotGitPath = join(worktreePath, ".git");
    if (!(await fileExists(dotGitPath))) return;

    const gitPointer = (await readFile(dotGitPath, "utf-8")).trim();
    if (!gitPointer.startsWith("gitdir: ")) return;

    const gitDir = gitPointer.slice("gitdir: ".length);
    const excludeDir = join(gitDir, "info");
    const excludePath = join(excludeDir, "exclude");

    await mkdir(excludeDir, { recursive: true });

    if (await fileExists(excludePath)) {
      const existing = await readFile(excludePath, "utf-8");
      if (existing.includes(pattern)) return;
    }

    const existingContent = (await fileExists(excludePath)) ? await readFile(excludePath, "utf-8") : "";
    await writeFile(excludePath, `${existingContent}\n${pattern}\n`, "utf-8");
    console.log(`[cli-launcher] Added "${pattern}" to worktree git exclude`);
  } catch (error) {
    console.warn(`[cli-launcher] Failed to add git exclude entry:`, error);
  }
}

function isExpectedGitUntrackedPathError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const gitError = error as { message?: string; stderr?: string; code?: number | string };
  const stderr = typeof gitError.stderr === "string" ? gitError.stderr : "";
  const message = typeof gitError.message === "string" ? gitError.message : "";
  const text = `${stderr}\n${message}`.toLowerCase();
  return (
    gitError.code === 1 &&
    (text.includes("did not match any file(s) known to git") ||
      text.includes("pathspec") ||
      text.includes("error: pathspec"))
  );
}

async function getWorktreeFileTrackingState(
  worktreePath: string,
  relativePath: string,
): Promise<"tracked" | "untracked" | "unknown"> {
  try {
    await execPromise(`git --no-optional-locks ls-files --error-unmatch -- "${relativePath}"`, {
      cwd: worktreePath,
      timeout: 5000,
    });
    return "tracked";
  } catch (error) {
    if (isExpectedGitUntrackedPathError(error)) return "untracked";
    console.warn(`[cli-launcher] Failed to determine git tracking state for ${relativePath}; preserving file`, error);
    return "unknown";
  }
}

async function mergeSettingsIntoRepo(worktreeFile: string, repoFile: string): Promise<void> {
  try {
    const wtRaw = await readFile(worktreeFile, "utf-8");
    const wtData = JSON.parse(wtRaw) as Record<string, unknown>;

    let repoData: Record<string, unknown> = {};
    try {
      const repoRaw = await readFile(repoFile, "utf-8");
      repoData = JSON.parse(repoRaw) as Record<string, unknown>;
    } catch {
      /* empty or corrupt — start fresh */
    }

    const wtPerms = (wtData.permissions ?? {}) as Record<string, unknown>;
    const repoPerms = (repoData.permissions ?? {}) as Record<string, unknown>;

    for (const key of ["allow", "deny"] as const) {
      const wtRules = Array.isArray(wtPerms[key]) ? (wtPerms[key] as string[]) : [];
      const repoRules = Array.isArray(repoPerms[key]) ? (repoPerms[key] as string[]) : [];
      const merged = [...new Set([...repoRules, ...wtRules])];
      if (merged.length > 0) {
        repoPerms[key] = merged;
      }
    }

    if (Object.keys(repoPerms).length > 0) {
      repoData.permissions = repoPerms;
    }

    await writeFile(repoFile, JSON.stringify(repoData, null, 2) + "\n", "utf-8");
  } catch (error) {
    console.warn(`[cli-launcher] Failed to merge settings into repo:`, error);
  }
}

async function symlinkProjectSettings(worktreePath: string, repoRoot: string): Promise<void> {
  if (!repoRoot) return;

  const settingsFiles = ["settings.json", "settings.local.json"];
  const worktreeClaudeDir = join(worktreePath, ".claude");
  const repoClaudeDir = join(repoRoot, ".claude");

  try {
    await mkdir(repoClaudeDir, { recursive: true });
  } catch {
    return;
  }

  for (const filename of settingsFiles) {
    const worktreeFile = join(worktreeClaudeDir, filename);
    const repoFile = join(repoClaudeDir, filename);
    const relativeSettingsPath = `.claude/${filename}`;

    try {
      let worktreeFileStat: Stats | null = null;
      try {
        worktreeFileStat = await lstat(worktreeFile);
      } catch {
        worktreeFileStat = null;
      }

      if (worktreeFileStat) {
        if (worktreeFileStat.isSymbolicLink()) continue;

        const trackingState = await getWorktreeFileTrackingState(worktreePath, relativeSettingsPath);
        if (trackingState !== "untracked") {
          const reason = trackingState === "tracked" ? "tracked" : "uncertain";
          console.log(`[cli-launcher] Leaving ${reason} ${worktreeFile} in place`);
          continue;
        }

        if (!(await fileExists(repoFile))) {
          await writeFile(repoFile, "{}\n", "utf-8");
          console.log(`[cli-launcher] Seeded ${repoFile} for symlink target`);
        }
        await mergeSettingsIntoRepo(worktreeFile, repoFile);
        await unlink(worktreeFile);
        console.log(`[cli-launcher] Merged and removed real ${worktreeFile} (was broken symlink)`);
      }

      if (!(await fileExists(repoFile))) {
        await writeFile(repoFile, "{}\n", "utf-8");
        console.log(`[cli-launcher] Seeded ${repoFile} for symlink target`);
      }

      await symlink(repoFile, worktreeFile);
      console.log(`[cli-launcher] Symlinked ${worktreeFile} → ${repoFile}`);
      await addWorktreeGitExclude(worktreePath, relativeSettingsPath);
    } catch (error) {
      console.warn(`[cli-launcher] Failed to symlink .claude/${filename}:`, error);
    }
  }
}

export async function prepareWorktreeSessionArtifacts(options: {
  worktreePath: string;
  repoRoot: string;
  branch: string;
  backendType: BackendType;
}): Promise<void> {
  const { worktreePath, repoRoot, branch, backendType } = options;

  if (worktreePath === repoRoot) {
    console.warn(`[cli-launcher] Skipping worktree setup: worktree path is the main repo (${repoRoot})`);
    return;
  }
  if (!(await fileExists(worktreePath))) {
    console.warn(`[cli-launcher] Skipping worktree setup: worktree path does not exist (${worktreePath})`);
    return;
  }

  await cleanStaleGuardrailsFile(worktreePath);

  if (backendType === "claude" || backendType === "claude-sdk") {
    try {
      await symlinkProjectSettings(worktreePath, repoRoot);
      console.log(
        `[cli-launcher] Worktree setup complete for branch ${branch} (settings symlinked, guardrails via system prompt)`,
      );
    } catch (error) {
      console.warn(`[cli-launcher] Failed to symlink project settings for worktree:`, error);
    }
  }
}
