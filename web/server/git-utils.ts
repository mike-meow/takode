import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GitRepoInfo {
  repoRoot: string;
  repoName: string;
  currentBranch: string;
  defaultBranch: string;
  isWorktree: boolean;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  worktreePath: string | null;
  ahead: number;
  behind: number;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
  isDirty: boolean;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  /** The conceptual branch the user selected */
  branch: string;
  /** The actual git branch in the worktree (may be e.g. `main-wt-2` for duplicate sessions) */
  actualBranch: string;
  isNew: boolean;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const WORKTREES_BASE = join(homedir(), ".companion", "worktrees");

function sanitizeBranch(branch: string): string {
  return branch.replace(/\//g, "--");
}

function worktreeDir(repoName: string, branch: string): string {
  return join(WORKTREES_BASE, repoName, sanitizeBranch(branch));
}

/** Find a unique directory path by appending a random suffix if needed. */
function findUniquePath(basePath: string): string {
  if (!existsSync(basePath)) return basePath;
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const candidate = `${basePath}-${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${basePath}-${Date.now()}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitSafe(cmd: string, cwd: string): string | null {
  try {
    return git(cmd, cwd);
  } catch {
    return null;
  }
}

// ─── Functions ──────────────────────────────────────────────────────────────

export function getRepoInfo(cwd: string): GitRepoInfo | null {
  const repoRoot = gitSafe("rev-parse --show-toplevel", cwd);
  if (!repoRoot) return null;

  const currentBranch = gitSafe("rev-parse --abbrev-ref HEAD", cwd) || "HEAD";
  const gitDir = gitSafe("rev-parse --git-dir", cwd) || "";
  // A linked worktree's .git dir is inside the main repo's .git/worktrees/
  const isWorktree = gitDir.includes("/worktrees/");

  const defaultBranch = resolveDefaultBranch(repoRoot, currentBranch);

  return {
    repoRoot,
    repoName: basename(repoRoot),
    currentBranch,
    defaultBranch,
    isWorktree,
  };
}

export function resolveDefaultBranch(repoRoot: string, currentBranch?: string): string {
  // If we know the current branch, try to find the closest parent branch.
  // This handles worktree branches (e.g. jiayi-wt-4719 → jiayi) and
  // feature branches (e.g. feat/x → main) automatically.
  if (currentBranch && currentBranch !== "HEAD") {
    const closest = findClosestParentBranch(repoRoot, currentBranch);
    if (closest) return closest;
  }

  // Fallback: try origin HEAD
  const originRef = gitSafe("symbolic-ref refs/remotes/origin/HEAD", repoRoot);
  if (originRef) {
    return originRef.replace("refs/remotes/origin/", "");
  }
  // Fallback: check if main or master exists
  const branches = gitSafe("branch --list main master", repoRoot) || "";
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  // Last resort
  return "main";
}

/**
 * Find the closest local branch that contains HEAD (i.e. HEAD is an ancestor
 * of the branch tip). This identifies the parent branch from which the current
 * branch was created. Uses a single `git for-each-ref --contains=HEAD` call
 * (~11ms) and only disambiguates with rev-list when multiple candidates exist.
 */
function findClosestParentBranch(repoRoot: string, currentBranch: string): string | null {
  // Fast path: name-based match for worktree branches (e.g. "jiayi-wt-4719" → "jiayi").
  // This runs BEFORE --contains=HEAD because diverged worktrees (with commits ahead of
  // the parent) won't have the parent listed by --contains, which only shows branches
  // whose tip is a descendant of HEAD.
  const wtMatch = currentBranch.match(/^(.+)-wt-\d+$/);
  if (wtMatch) {
    const parentName = wtMatch[1];
    const exists = gitSafe(`rev-parse --verify refs/heads/${parentName}`, repoRoot);
    if (exists) return parentName;
  }

  const output = gitSafe("for-each-ref --format=%(refname:short) --contains=HEAD refs/heads/", repoRoot);
  if (!output) return null;

  const candidates = output.split("\n")
    .map(b => b.trim())
    .filter(b => b && b !== currentBranch);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple candidates: pick the one closest to HEAD (fewest commits ahead)
  let bestBranch = candidates[0];
  let bestCount = Infinity;
  for (const candidate of candidates) {
    const countStr = gitSafe(`rev-list --count HEAD..${candidate}`, repoRoot);
    const count = countStr ? parseInt(countStr, 10) : Infinity;
    if (count < bestCount) {
      bestCount = count;
      bestBranch = candidate;
      if (count === 0) break;
    }
  }
  return bestBranch;
}

export function listBranches(repoRoot: string): GitBranchInfo[] {
  // Get worktree mappings first
  const worktrees = listWorktrees(repoRoot);
  const worktreeByBranch = new Map<string, string>();
  for (const wt of worktrees) {
    if (wt.branch) worktreeByBranch.set(wt.branch, wt.path);
  }

  const result: GitBranchInfo[] = [];

  // Local branches
  const localRaw = gitSafe(
    "for-each-ref '--format=%(refname:short)%09%(HEAD)' refs/heads/",
    repoRoot,
  );
  if (localRaw) {
    for (const line of localRaw.split("\n")) {
      if (!line.trim()) continue;
      const [name, head] = line.split("\t");
      const isCurrent = head?.trim() === "*";
      const { ahead, behind } = getBranchStatus(repoRoot, name);
      result.push({
        name,
        isCurrent,
        isRemote: false,
        worktreePath: worktreeByBranch.get(name) || null,
        ahead,
        behind,
      });
    }
  }

  // Remote branches (only those without a local counterpart)
  const localNames = new Set(result.map((b) => b.name));
  const remoteRaw = gitSafe(
    "for-each-ref '--format=%(refname:short)' refs/remotes/origin/",
    repoRoot,
  );
  if (remoteRaw) {
    for (const line of remoteRaw.split("\n")) {
      const full = line.trim();
      if (!full || full === "origin/HEAD") continue;
      const name = full.replace("origin/", "");
      if (localNames.has(name)) continue;
      result.push({
        name,
        isCurrent: false,
        isRemote: true,
        worktreePath: null,
        ahead: 0,
        behind: 0,
      });
    }
  }

  return result;
}

export function listWorktrees(repoRoot: string): GitWorktreeInfo[] {
  const raw = gitSafe("worktree list --porcelain", repoRoot);
  if (!raw) return [];

  const worktrees: GitWorktreeInfo[] = [];
  let current: Partial<GitWorktreeInfo> = {};

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current as GitWorktreeInfo);
      }
      current = { path: line.slice(9), isDirty: false, isMainWorktree: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.isMainWorktree = true;
    } else if (line === "") {
      // End of entry — check if main worktree (first one is always main)
      if (worktrees.length === 0 && current.path) {
        current.isMainWorktree = true;
      }
    }
  }
  // Push last entry
  if (current.path) {
    if (worktrees.length === 0) current.isMainWorktree = true;
    worktrees.push(current as GitWorktreeInfo);
  }

  // Check dirty status for each worktree
  for (const wt of worktrees) {
    wt.isDirty = isWorktreeDirty(wt.path);
  }

  return worktrees;
}

export function ensureWorktree(
  repoRoot: string,
  branchName: string,
  options?: { baseBranch?: string; createBranch?: boolean; forceNew?: boolean },
): WorktreeCreateResult {
  const repoName = basename(repoRoot);

  // Check if a worktree already exists for this branch
  const existing = listWorktrees(repoRoot);
  const found = existing.find((wt) => wt.branch === branchName);

  if (found && !options?.forceNew) {
    // Don't reuse the main worktree — it's the original repo checkout
    if (!found.isMainWorktree) {
      return { worktreePath: found.path, branch: branchName, actualBranch: branchName, isNew: false };
    }
  }

  // Ensure parent directory exists
  mkdirSync(join(WORKTREES_BASE, repoName), { recursive: true });

  // Helper: always generate a unique -wt-XXXX branch and derive the directory
  // path from it so both share the same suffix (e.g. jiayi-wt-8076).
  // This ensures worktrees never check out the user's original branch directly.
  const createWithUniqueBranch = (commitish: string, isNew = false): WorktreeCreateResult => {
    const uniqueBranch = generateUniqueWorktreeBranch(repoRoot, branchName);
    const targetPath = worktreeDir(repoName, uniqueBranch);
    git(`worktree add -b ${uniqueBranch} "${targetPath}" ${commitish}`, repoRoot);
    return { worktreePath: targetPath, branch: branchName, actualBranch: uniqueBranch, isNew };
  };

  // A worktree already exists for this branch — create a new uniquely-named
  // branch so multiple sessions can work on the same branch independently.
  if (found) {
    const commitHash = git("rev-parse HEAD", found.path);
    return createWithUniqueBranch(commitHash);
  }

  // Check if branch already exists locally or on remote
  const branchExists =
    gitSafe(`rev-parse --verify refs/heads/${branchName}`, repoRoot) !== null;
  const remoteBranchExists =
    gitSafe(`rev-parse --verify refs/remotes/origin/${branchName}`, repoRoot) !== null;

  if (branchExists) {
    const commitHash = git(`rev-parse refs/heads/${branchName}`, repoRoot);
    return createWithUniqueBranch(commitHash);
  }

  if (remoteBranchExists) {
    return createWithUniqueBranch(`origin/${branchName}`);
  }

  if (options?.createBranch !== false) {
    const base = options?.baseBranch || resolveDefaultBranch(repoRoot);
    return createWithUniqueBranch(base, true);
  }

  throw new Error(`Branch "${branchName}" does not exist and createBranch is false`);
}

/**
 * Generate a unique branch name for a companion-managed worktree.
 * Pattern: `{branch}-wt-{random4digit}` (e.g. `main-wt-8374`).
 * Uses random suffixes to avoid collisions with leftover branches.
 */
export function generateUniqueWorktreeBranch(repoRoot: string, baseBranch: string): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const candidate = `${baseBranch}-wt-${suffix}`;
    if (gitSafe(`rev-parse --verify refs/heads/${candidate}`, repoRoot) === null) {
      return candidate;
    }
  }
  // Fallback: use timestamp if all random attempts collide (extremely unlikely)
  return `${baseBranch}-wt-${Date.now()}`;
}

export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  options?: { force?: boolean; branchToDelete?: string },
): { removed: boolean; reason?: string } {
  if (!existsSync(worktreePath)) {
    // Already gone, clean up git's reference
    gitSafe("worktree prune", repoRoot);
    if (options?.branchToDelete) {
      gitSafe(`branch -D ${options.branchToDelete}`, repoRoot);
    }
    return { removed: true };
  }

  if (!options?.force && isWorktreeDirty(worktreePath)) {
    return {
      removed: false,
      reason: "Worktree has uncommitted changes. Use force to remove anyway.",
    };
  }

  try {
    const forceFlag = options?.force ? " --force" : "";
    git(`worktree remove "${worktreePath}"${forceFlag}`, repoRoot);
    // Clean up the companion-managed branch after worktree removal
    if (options?.branchToDelete) {
      gitSafe(`branch -D ${options.branchToDelete}`, repoRoot);
    }
    return { removed: true };
  } catch (e: unknown) {
    return {
      removed: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export function isWorktreeDirty(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const status = gitSafe("status --porcelain", worktreePath);
  return status !== null && status.length > 0;
}

export function gitFetch(cwd: string): { success: boolean; output: string } {
  try {
    const output = git("fetch --prune", cwd);
    return { success: true, output };
  } catch (e: unknown) {
    return { success: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export function gitPull(
  cwd: string,
): { success: boolean; output: string } {
  try {
    const output = git("pull", cwd);
    return { success: true, output };
  } catch (e: unknown) {
    return { success: false, output: e instanceof Error ? e.message : String(e) };
  }
}


export function checkoutBranch(cwd: string, branchName: string): void {
  git(`checkout ${branchName}`, cwd);
}

export function getBranchStatus(
  repoRoot: string,
  branchName: string,
): { ahead: number; behind: number } {
  const raw = gitSafe(
    `rev-list --left-right --count origin/${branchName}...${branchName}`,
    repoRoot,
  );
  if (!raw) return { ahead: 0, behind: 0 };
  const [behind, ahead] = raw.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}
