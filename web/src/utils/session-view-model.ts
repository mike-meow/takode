import type { SessionState } from "../types.js";
import type { BackendType, SdkSessionInfo } from "../types.js";

export interface SessionViewModel {
  sessionId: string;
  backendType?: BackendType;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  repoRoot?: string;
  gitBranch?: string | null;
  gitDefaultBranch?: string;
  diffBaseBranch?: string;
  isWorktree?: boolean;
  isContainerized?: boolean;
  gitAhead?: number;
  gitBehind?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  numTurns?: number;
  totalCostUsd?: number;
  contextUsedPercent?: number;
  modelContextWindow?: number;
  state?: SdkSessionInfo["state"];
  createdAt?: number;
  cliSessionId?: string;
  sessionNum?: number | null;
  name?: string;
  isOrchestrator?: boolean;
  herdedBy?: string;
  claimedQuestStatus?: string;
  askPermission?: boolean;
}

function isSessionState(session: SessionState | SdkSessionInfo): session is SessionState {
  return "session_id" in session;
}

export function toSessionViewModel(session: SessionState | SdkSessionInfo): SessionViewModel {
  if (isSessionState(session)) {
    return {
      sessionId: session.session_id,
      backendType: session.backend_type,
      model: session.model,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      repoRoot: session.repo_root,
      gitBranch: session.git_branch,
      gitDefaultBranch: session.git_default_branch,
      diffBaseBranch: session.diff_base_branch,
      isWorktree: session.is_worktree,
      isContainerized: session.is_containerized,
      gitAhead: session.git_ahead,
      gitBehind: session.git_behind,
      totalLinesAdded: session.total_lines_added,
      totalLinesRemoved: session.total_lines_removed,
      numTurns: session.num_turns,
      totalCostUsd: session.total_cost_usd,
      contextUsedPercent: session.context_used_percent,
      modelContextWindow: session.codex_token_details?.modelContextWindow,
      claimedQuestStatus: session.claimedQuestStatus,
      askPermission: session.askPermission,
    };
  }

  return {
    sessionId: session.sessionId,
    backendType: session.backendType,
    model: session.model,
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    repoRoot: session.repoRoot,
    gitBranch: session.gitBranch,
    isWorktree: session.isWorktree,
    gitAhead: session.gitAhead,
    gitBehind: session.gitBehind,
    totalLinesAdded: session.totalLinesAdded,
    totalLinesRemoved: session.totalLinesRemoved,
    contextUsedPercent: session.contextUsedPercent,
    modelContextWindow: session.codexTokenDetails?.modelContextWindow,
    state: session.state,
    createdAt: session.createdAt,
    cliSessionId: session.cliSessionId,
    sessionNum: session.sessionNum,
    name: session.name,
    isOrchestrator: session.isOrchestrator,
    herdedBy: session.herdedBy,
    claimedQuestStatus: undefined,
    askPermission: undefined,
  };
}

export function coalesceSessionViewModel(
  primary: SessionState | SdkSessionInfo | null | undefined,
  fallback?: SessionState | SdkSessionInfo | null,
): SessionViewModel | null {
  if (!primary && !fallback) return null;

  const fallbackVm = fallback ? toSessionViewModel(fallback) : null;
  const primaryVm = primary ? toSessionViewModel(primary) : null;

  if (!primaryVm && fallbackVm) return fallbackVm;
  if (!fallbackVm && primaryVm) return primaryVm;

  const merged: Partial<SessionViewModel> = { ...(fallbackVm || {}) };
  if (primaryVm) {
    for (const [key, value] of Object.entries(primaryVm) as [keyof SessionViewModel, SessionViewModel[keyof SessionViewModel]][]) {
      if (value !== undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return {
    ...(merged as SessionViewModel),
    sessionId: primaryVm?.sessionId || fallbackVm?.sessionId || "",
  };
}
