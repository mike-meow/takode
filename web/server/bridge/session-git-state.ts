import { exec as execCb } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_CMD_TIMEOUT, SERVER_GIT_CMD } from "../constants.js";
import * as gitUtils from "../git-utils.js";
import type { BackendType, SessionState } from "../session-types.js";

const execPromise = promisify(execCb);

async function resolveUpstreamRef(state: SessionState): Promise<string | null> {
  if (!state.cwd || !state.git_branch || state.git_branch === "HEAD" || state.is_worktree) return null;
  try {
    const { stdout } = await execPromise(
      `${SERVER_GIT_CMD} rev-parse --abbrev-ref --symbolic-full-name ${state.git_branch}@{upstream} 2>/dev/null`,
      { cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT },
    );
    const upstreamRef = stdout.trim();
    return upstreamRef || null;
  } catch {
    return null;
  }
}

export function makeDefaultState(sessionId: string, backendType: BackendType = "claude"): SessionState {
  return {
    session_id: sessionId,
    backend_type: backendType,
    backend_state: "disconnected",
    backend_error: null,
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "default",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    skill_metadata: [],
    apps: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    codex_retained_payload_bytes: 0,
    is_compacting: false,
    git_branch: "",
    git_head_sha: "",
    git_default_branch: "",
    diff_base_branch: "",
    diff_base_branch_explicit: false,
    diff_base_start_sha: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

export async function resolveGitInfo(state: SessionState): Promise<void> {
  if (!state.cwd) return;
  const wasContainerized = state.is_containerized;
  try {
    const { stdout: branchOut } = await execPromise(`${SERVER_GIT_CMD} rev-parse --abbrev-ref HEAD 2>/dev/null`, {
      cwd: state.cwd,
      encoding: "utf-8",
      timeout: GIT_CMD_TIMEOUT,
    });
    state.git_branch = branchOut.trim();
    try {
      const { stdout: headOut } = await execPromise(`${SERVER_GIT_CMD} rev-parse HEAD 2>/dev/null`, {
        cwd: state.cwd,
        encoding: "utf-8",
        timeout: GIT_CMD_TIMEOUT,
      });
      state.git_head_sha = headOut.trim();
    } catch {
      state.git_head_sha = "";
    }

    try {
      const { stdout: gitDirOut } = await execPromise(`${SERVER_GIT_CMD} rev-parse --git-dir 2>/dev/null`, {
        cwd: state.cwd,
        encoding: "utf-8",
        timeout: GIT_CMD_TIMEOUT,
      });
      state.is_worktree = gitDirOut.trim().includes("/worktrees/");
    } catch {
      state.is_worktree = false;
    }

    try {
      if (state.is_worktree) {
        const { stdout: commonDirOut } = await execPromise(`${SERVER_GIT_CMD} rev-parse --git-common-dir 2>/dev/null`, {
          cwd: state.cwd,
          encoding: "utf-8",
          timeout: GIT_CMD_TIMEOUT,
        });
        state.repo_root = resolve(state.cwd, commonDirOut.trim(), "..");
      } else {
        const { stdout: toplevelOut } = await execPromise(`${SERVER_GIT_CMD} rev-parse --show-toplevel 2>/dev/null`, {
          cwd: state.cwd,
          encoding: "utf-8",
          timeout: GIT_CMD_TIMEOUT,
        });
        state.repo_root = toplevelOut.trim();
      }
    } catch {
      /* ignore */
    }

    const upstreamRef = await resolveUpstreamRef(state);
    let legacyDefaultBranch: string | null = null;
    const getLegacyDefaultBranch = async () => {
      if (!legacyDefaultBranch) {
        legacyDefaultBranch = await gitUtils.resolveDefaultBranchAsync(state.repo_root || state.cwd, state.git_branch);
      }
      return legacyDefaultBranch;
    };

    if (upstreamRef) {
      state.git_default_branch = upstreamRef;
      if (!state.diff_base_branch_explicit) {
        if (!state.diff_base_branch) {
          state.diff_base_branch = upstreamRef;
        } else {
          const legacyDefault = await getLegacyDefaultBranch();
          if (state.diff_base_branch === legacyDefault) {
            state.diff_base_branch = upstreamRef;
          }
        }
      }
    } else {
      const fallbackBase = await getLegacyDefaultBranch();
      state.git_default_branch = fallbackBase;
      if (!state.diff_base_branch_explicit && !state.diff_base_branch && state.git_branch) {
        state.diff_base_branch = fallbackBase;
      }
    }

    const ref = state.diff_base_branch || state.git_default_branch;
    if (ref) {
      try {
        const { stdout: countsOut } = await execPromise(
          `${SERVER_GIT_CMD} rev-list --left-right --count ${ref}...HEAD 2>/dev/null`,
          { cwd: state.cwd, encoding: "utf-8", timeout: GIT_CMD_TIMEOUT },
        );
        const [behind, ahead] = countsOut.trim().split(/\s+/).map(Number);
        state.git_ahead = ahead || 0;
        state.git_behind = behind || 0;
      } catch {
        state.git_ahead = 0;
        state.git_behind = 0;
      }
    } else {
      state.git_ahead = 0;
      state.git_behind = 0;
    }
  } catch {
    const preservedDiffBaseBranch = state.diff_base_branch;
    const preservedDiffBaseExplicit = state.diff_base_branch_explicit;
    state.git_branch = "";
    state.git_default_branch = "";
    state.diff_base_branch = preservedDiffBaseBranch;
    state.diff_base_branch_explicit = preservedDiffBaseExplicit;
    state.git_head_sha = "";
    state.diff_base_start_sha = "";
    state.is_worktree = false;
    state.repo_root = "";
    state.git_ahead = 0;
    state.git_behind = 0;
  }
  state.is_containerized = wasContainerized;
}

export async function readWorktreeStateFingerprint(cwd: string): Promise<string | null> {
  try {
    const gitFile = await readFile(join(cwd, ".git"), "utf-8");
    const match = gitFile.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return null;
    const gitDir = resolve(cwd, match[1].trim());
    const [headStat, indexStat] = await Promise.all([
      stat(join(gitDir, "HEAD")).catch(() => null),
      stat(join(gitDir, "index")).catch(() => null),
    ]);
    return [
      headStat ? `${headStat.mtimeMs}:${headStat.size}` : "missing",
      indexStat ? `${indexStat.mtimeMs}:${indexStat.size}` : "missing",
    ].join("|");
  } catch {
    return null;
  }
}
