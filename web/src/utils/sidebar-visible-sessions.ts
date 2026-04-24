import type { SidebarSessionItem } from "./sidebar-session-item.js";
import { buildTreeViewGroups } from "./tree-grouping.js";
import type { TreeGroup, SessionTaskEntry, SdkSessionInfo, SessionState } from "../types.js";

function sumDiffFileStats(fileStats: Map<string, { additions: number; deletions: number }> | undefined) {
  let additions = 0;
  let deletions = 0;
  for (const stats of fileStats?.values() ?? []) {
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return { additions, deletions };
}

export interface SidebarVisibleSessionsInput {
  sessions: Map<string, SessionState>;
  sdkSessions: SdkSessionInfo[];
  cliConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  askPermission: Map<string, boolean>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  treeGroups: TreeGroup[];
  treeAssignments: Map<string, string>;
  treeNodeOrder: Map<string, string[]>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionSortMode: "created" | "activity";
  countUserPermissions: (perms: Map<string, unknown> | undefined) => number;
}

export interface SidebarVisibleSessionsResult {
  allSessionList: SidebarSessionItem[];
  activeSessions: SidebarSessionItem[];
  activeReviewers: SidebarSessionItem[];
  cronSessions: SidebarSessionItem[];
  archivedSessions: SidebarSessionItem[];
  orderedVisibleSessionIds: string[];
  treeViewGroups: ReturnType<typeof buildTreeViewGroups>;
}

export function buildSidebarVisibleSessions(input: SidebarVisibleSessionsInput): SidebarVisibleSessionsResult {
  const {
    sessions,
    sdkSessions,
    cliConnected,
    cliDisconnectReason,
    sessionStatus,
    pendingPermissions,
    askPermission,
    diffFileStats,
    treeGroups,
    treeAssignments,
    treeNodeOrder,
    sessionAttention,
    sessionSortMode,
    countUserPermissions,
  } = input;

  const allSessionIds = new Set<string>();
  for (const id of sessions.keys()) allSessionIds.add(id);
  for (const session of sdkSessions) allSessionIds.add(session.sessionId);

  const allSessionList: SidebarSessionItem[] = Array.from(allSessionIds)
    .map((id) => {
      const bridgeState = sessions.get(id);
      const sdkInfo = sdkSessions.find((session) => session.sessionId === id);
      const sdkGitAhead = sdkInfo?.gitAhead ?? 0;
      const sdkGitBehind = sdkInfo?.gitBehind ?? 0;
      const gitAhead =
        bridgeState?.git_ahead === 0 && sdkGitAhead > 0 ? sdkGitAhead : (bridgeState?.git_ahead ?? sdkGitAhead);
      const gitBehind =
        bridgeState?.git_behind === 0 && sdkGitBehind > 0 ? sdkGitBehind : (bridgeState?.git_behind ?? sdkGitBehind);
      const serverLinesAdded = bridgeState?.total_lines_added ?? sdkInfo?.totalLinesAdded ?? 0;
      const serverLinesRemoved = bridgeState?.total_lines_removed ?? sdkInfo?.totalLinesRemoved ?? 0;
      const localLineStats = sumDiffFileStats(diffFileStats.get(id));
      const linesAdded =
        serverLinesAdded === 0 &&
        serverLinesRemoved === 0 &&
        (localLineStats.additions > 0 || localLineStats.deletions > 0)
          ? localLineStats.additions
          : serverLinesAdded;
      const linesRemoved =
        serverLinesAdded === 0 &&
        serverLinesRemoved === 0 &&
        (localLineStats.additions > 0 || localLineStats.deletions > 0)
          ? localLineStats.deletions
          : serverLinesRemoved;
      return {
        id,
        claimedQuestStatus: bridgeState?.claimedQuestStatus ?? sdkInfo?.claimedQuestStatus ?? undefined,
        model: bridgeState?.model || sdkInfo?.model || "",
        cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
        gitBranch: bridgeState?.git_branch || sdkInfo?.gitBranch || "",
        isContainerized: bridgeState?.is_containerized || !!sdkInfo?.containerId || false,
        gitAhead,
        gitBehind,
        linesAdded,
        linesRemoved,
        isConnected: cliConnected.get(id) ?? sdkInfo?.cliConnected ?? false,
        status: sessionStatus.get(id) ?? null,
        sdkState: sdkInfo?.state ?? null,
        createdAt: sdkInfo?.createdAt ?? 0,
        archived: sdkInfo?.archived ?? false,
        archivedAt: sdkInfo?.archivedAt,
        backendType: bridgeState?.backend_type || sdkInfo?.backendType || "claude",
        repoRoot: bridgeState?.repo_root || sdkInfo?.repoRoot || "",
        permCount: countUserPermissions(pendingPermissions.get(id)),
        pendingTimerCount: sdkInfo?.pendingTimerCount ?? 0,
        cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
        cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
        isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
        worktreeExists: sdkInfo?.worktreeExists,
        worktreeDirty: sdkInfo?.worktreeDirty,
        askPermission: askPermission.get(id),
        idleKilled: cliDisconnectReason.get(id) === "idle_limit",
        lastActivityAt: sdkInfo?.lastActivityAt,
        lastUserMessageAt: sdkInfo?.lastUserMessageAt,
        isOrchestrator: sdkInfo?.isOrchestrator || false,
        herdedBy: sdkInfo?.herdedBy,
        sessionNum: sdkInfo?.sessionNum ?? null,
        reviewerOf: sdkInfo?.reviewerOf,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  const activeSessions = allSessionList.filter((session) => !session.archived && !session.cronJobId && session.reviewerOf === undefined);
  const activeReviewers = allSessionList.filter((session) => !session.archived && session.reviewerOf !== undefined);
  const cronSessions = allSessionList.filter((session) => !session.archived && !!session.cronJobId);
  const archivedSessions = allSessionList
    .filter((session) => session.archived && session.reviewerOf === undefined)
    .sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt));

  const treeViewGroups = buildTreeViewGroups(
    activeSessions,
    treeGroups,
    treeAssignments,
    sessionAttention,
    sessionSortMode,
    treeNodeOrder,
    activeReviewers,
  );
  const orderedVisibleSessionIds = treeViewGroups.flatMap((group) =>
    group.nodes.flatMap((node) => [node.leader.id, ...node.workers.map((worker) => worker.id)]),
  );

  return {
    allSessionList,
    activeSessions,
    activeReviewers,
    cronSessions,
    archivedSessions,
    orderedVisibleSessionIds,
    treeViewGroups,
  };
}
