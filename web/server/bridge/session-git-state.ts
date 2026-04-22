import { exec as execCb } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_CMD_TIMEOUT, SERVER_GIT_CMD } from "../constants.js";
import * as gitUtils from "../git-utils.js";
import type { BackendType, SessionState } from "../session-types.js";

const execPromise = promisify(execCb);
const GIT_SHA_REF_RE = /^[0-9a-f]{7,40}$/i;

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

interface SessionDiffStateLike {
  state: SessionState;
  worktreeStateFingerprint: string;
}

interface SessionDiffRefreshLike extends SessionDiffStateLike {
  id: string;
  backendSocket: unknown | null;
  codexAdapter: unknown | null;
  browserSockets: { size: number };
  diffStatsDirty: boolean;
}

interface RecomputeDiffIfDirtyDeps {
  broadcastDiffTotals: (session: SessionDiffRefreshLike) => void;
  persistSession: (session: SessionDiffRefreshLike) => void;
}

interface RefreshWorktreeGitStateForSnapshotDeps {
  sessions: Map<string, SessionDiffRefreshLike>;
  inFlightRefreshes: Map<string, Promise<SessionState | null>>;
  refreshGitInfo: (
    session: SessionDiffRefreshLike,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean },
  ) => Promise<void>;
  broadcastDiffTotals: (session: SessionDiffRefreshLike) => void;
  persistSession: (session: SessionDiffRefreshLike) => void;
}

interface RefreshGitInfoDeps {
  gitSessionKeys: readonly (keyof SessionState)[];
  broadcastGitUpdate: (session: SessionDiffRefreshLike) => void;
  persistSession: (session: SessionDiffRefreshLike) => void;
  notifyPoller: (session: SessionDiffRefreshLike) => void;
  updateBranchIndex: (session: SessionDiffRefreshLike) => void;
  invalidateSessionsSharingBranch: (session: SessionDiffRefreshLike, previousHeadSha: string) => void;
}

interface SetDiffBaseBranchDeps {
  broadcastSessionUpdate: (session: SessionDiffRefreshLike, update: Record<string, unknown>) => void;
  persistSession: (session: SessionDiffRefreshLike) => void;
  refreshGitInfo: (
    session: SessionDiffRefreshLike,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean },
  ) => Promise<void>;
  updateBranchIndex: (session: SessionDiffRefreshLike) => void;
}

interface RefreshGitInfoPublicDeps {
  refreshGitInfo: (
    session: SessionDiffRefreshLike,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean },
  ) => Promise<void>;
  persistSession: (session: SessionDiffRefreshLike) => void;
}

export async function updateDiffBaseStartSha(
  session: SessionDiffStateLike,
  previousHeadSha: string,
): Promise<boolean> {
  if (!session.state.is_worktree) return false;
  const cwd = session.state.cwd;
  const currentHeadSha = session.state.git_head_sha?.trim() || "";
  if (!cwd || !currentHeadSha) return false;

  const existingAnchor = session.state.diff_base_start_sha?.trim() || "";
  const ref = (session.state.diff_base_branch || session.state.git_default_branch || "").trim();

  if (ref && GIT_SHA_REF_RE.test(ref)) {
    if (!existingAnchor) {
      session.state.diff_base_start_sha = currentHeadSha;
      return true;
    }
    if (previousHeadSha && previousHeadSha !== currentHeadSha) {
      try {
        await execPromise(`${SERVER_GIT_CMD} merge-base --is-ancestor ${previousHeadSha} ${currentHeadSha}`, {
          cwd,
          timeout: GIT_CMD_TIMEOUT,
        });
      } catch {
        session.state.diff_base_start_sha = currentHeadSha;
        return true;
      }
    }
    return false;
  }

  let nextAnchor = currentHeadSha;
  if (ref) {
    try {
      const { stdout } = await execPromise(`${SERVER_GIT_CMD} merge-base ${ref} HEAD`, {
        cwd,
        timeout: GIT_CMD_TIMEOUT,
      });
      const mergeBase = stdout.trim();
      if (mergeBase) nextAnchor = mergeBase;
    } catch {
      // Fall back to current HEAD when merge-base is unavailable.
    }
  }

  if (nextAnchor !== existingAnchor) {
    session.state.diff_base_start_sha = nextAnchor;
    return true;
  }
  return false;
}

export async function computeDiffStatsAsync(session: SessionDiffStateLike): Promise<boolean> {
  const cwd = session.state.cwd;
  if (!cwd) return false;

  try {
    let diffBase = "";
    let worktreeBaseIsExplicitCommit = false;
    if (session.state.is_worktree) {
      const selectedBase = (session.state.diff_base_branch || session.state.git_default_branch || "").trim();
      if (selectedBase && GIT_SHA_REF_RE.test(selectedBase)) {
        diffBase = selectedBase;
        worktreeBaseIsExplicitCommit = true;
      } else {
        diffBase = session.state.diff_base_start_sha?.trim() || session.state.git_head_sha?.trim() || "";
        if (!diffBase) {
          diffBase = selectedBase;
        }
      }
    } else {
      diffBase = (session.state.diff_base_branch || session.state.git_default_branch || "").trim();
    }
    if (!diffBase) return false;

    if (session.state.is_worktree && !worktreeBaseIsExplicitCommit && (session.state.git_ahead || 0) <= 0) {
      session.state.total_lines_added = 0;
      session.state.total_lines_removed = 0;
      session.worktreeStateFingerprint = (await readWorktreeStateFingerprint(cwd)) || "";
      return true;
    }

    let diffRef = diffBase;
    if (!session.state.is_worktree) {
      try {
        const { stdout: mbOut } = await execPromise(`${SERVER_GIT_CMD} merge-base ${diffBase} HEAD`, {
          cwd,
          timeout: GIT_CMD_TIMEOUT,
        });
        const mergeBase = mbOut.trim();
        if (mergeBase) diffRef = mergeBase;
      } catch {
        // Fall back to a direct diff when merge-base is unavailable.
      }
    }

    const { stdout } = await execPromise(`${SERVER_GIT_CMD} diff --numstat ${diffRef}`, {
      cwd,
      timeout: GIT_CMD_TIMEOUT,
    });
    let added = 0;
    let removed = 0;
    const raw = stdout.trim();
    if (raw) {
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const [addStr, delStr] = line.split("\t");
        if (addStr !== "-") added += parseInt(addStr, 10) || 0;
        if (delStr !== "-") removed += parseInt(delStr, 10) || 0;
      }
    }

    session.state.total_lines_added = added;
    session.state.total_lines_removed = removed;
    if (session.state.is_worktree) {
      session.worktreeStateFingerprint = (await readWorktreeStateFingerprint(cwd)) || "";
    }
    return true;
  } catch {
    return false;
  }
}

export function recomputeDiffIfDirty(
  session: SessionDiffRefreshLike,
  deps: RecomputeDiffIfDirtyDeps,
): void {
  if (!session.diffStatsDirty) return;
  if (!session.backendSocket && !session.codexAdapter && !(session.state.is_worktree && session.browserSockets.size > 0)) {
    return;
  }
  computeDiffStatsAsync(session)
    .then((didRun) => {
      if (!didRun) return;
      session.diffStatsDirty = false;
      deps.broadcastDiffTotals(session);
      deps.persistSession(session);
    })
    .catch(() => {
      /* git not available */
    });
}

export function setDiffBaseBranch(
  session: SessionDiffRefreshLike,
  branch: string,
  deps: SetDiffBaseBranchDeps,
): void {
  session.state.diff_base_branch = branch;
  session.state.diff_base_branch_explicit = true;
  deps.broadcastSessionUpdate(session, { diff_base_branch: branch });
  void deps.refreshGitInfo(session, { broadcastUpdate: true }).then(async () => {
    const didRun = await computeDiffStatsAsync(session);
    if (!didRun) return;
    deps.broadcastSessionUpdate(session, {
      total_lines_added: session.state.total_lines_added,
      total_lines_removed: session.state.total_lines_removed,
    });
    deps.persistSession(session);
  });
  deps.updateBranchIndex(session);
  deps.persistSession(session);
}

export async function refreshGitInfoPublic(
  session: SessionDiffRefreshLike,
  deps: RefreshGitInfoPublicDeps,
  options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean } = {},
): Promise<void> {
  session.diffStatsDirty = true;
  await deps.refreshGitInfo(session, options);
  await computeDiffStatsAsync(session);
  deps.persistSession(session);
}

export async function refreshGitInfo(
  session: SessionDiffRefreshLike,
  deps: RefreshGitInfoDeps,
  options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean } = {},
): Promise<void> {
  if (!options.force && !session.backendSocket && !session.codexAdapter && !(session.state.is_worktree && session.browserSockets.size > 0)) {
    return;
  }

  const before: Record<string, unknown> = {};
  for (const key of deps.gitSessionKeys) {
    before[key] = session.state[key];
  }
  const previousHeadSha = session.state.git_head_sha || "";

  await resolveGitInfo(session.state);
  if (!session.state.is_worktree) {
    session.worktreeStateFingerprint = "";
  }
  const anchorChanged = await updateDiffBaseStartSha(session, previousHeadSha);
  if (anchorChanged) {
    session.diffStatsDirty = true;
  }

  let changed = false;
  for (const key of deps.gitSessionKeys) {
    if (session.state[key] !== before[key]) {
      changed = true;
      break;
    }
  }

  if (changed) {
    if (options.broadcastUpdate) {
      deps.broadcastGitUpdate(session);
    }
    deps.persistSession(session);
  }

  if (options.notifyPoller && session.state.git_branch && session.state.cwd) {
    deps.notifyPoller(session);
  }

  deps.updateBranchIndex(session);

  const currentHeadSha = session.state.git_head_sha || "";
  if (previousHeadSha && currentHeadSha && currentHeadSha !== previousHeadSha) {
    deps.invalidateSessionsSharingBranch(session, previousHeadSha);
  }
}

export function refreshWorktreeGitStateForSnapshot(
  sessionId: string,
  deps: RefreshWorktreeGitStateForSnapshotDeps,
  options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
): Promise<SessionState | null> {
  const existing = deps.inFlightRefreshes.get(sessionId);
  if (existing) return existing;

  const refresh = runWorktreeGitStateRefreshForSnapshot(sessionId, deps, options).finally(() => {
    if (deps.inFlightRefreshes.get(sessionId) === refresh) {
      deps.inFlightRefreshes.delete(sessionId);
    }
  });
  deps.inFlightRefreshes.set(sessionId, refresh);
  return refresh;
}

async function runWorktreeGitStateRefreshForSnapshot(
  sessionId: string,
  deps: RefreshWorktreeGitStateForSnapshotDeps,
  options: { broadcastUpdate?: boolean; notifyPoller?: boolean } = {},
): Promise<SessionState | null> {
  const session = deps.sessions.get(sessionId);
  if (!session) return null;
  if (!session.state.is_worktree || !session.state.cwd) return session.state;

  const currentFingerprint = await readWorktreeStateFingerprint(session.state.cwd);
  const previousFingerprint = session.worktreeStateFingerprint.trim();
  if (currentFingerprint && previousFingerprint && currentFingerprint === previousFingerprint) {
    return session.state;
  }

  const beforeAdded = session.state.total_lines_added;
  const beforeRemoved = session.state.total_lines_removed;

  await deps.refreshGitInfo(session, {
    broadcastUpdate: options.broadcastUpdate,
    notifyPoller: options.notifyPoller,
    force: true,
  });

  const didRun = await computeDiffStatsAsync(session);
  if (!didRun) return session.state;

  session.diffStatsDirty = false;
  session.worktreeStateFingerprint = currentFingerprint || "";

  const totalsChanged =
    beforeAdded !== session.state.total_lines_added || beforeRemoved !== session.state.total_lines_removed;
  if (totalsChanged && options.broadcastUpdate) {
    deps.broadcastDiffTotals(session);
  }
  if (totalsChanged) {
    deps.persistSession(session);
  }
  return session.state;
}
