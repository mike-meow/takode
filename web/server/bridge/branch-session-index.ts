export interface BranchSessionLike {
  id: string;
  state: {
    git_branch?: string;
    diff_base_branch?: string;
    git_default_branch?: string;
  };
  diffStatsDirty: boolean;
}

interface BranchIndexArgs {
  branchToSessions: Map<string, Set<string>>;
  sessionBranches: Map<string, Set<string>>;
}

export function removeBranchIndexEntries(
  sessionId: string,
  { branchToSessions, sessionBranches }: BranchIndexArgs,
): void {
  const oldBranches = sessionBranches.get(sessionId);
  if (!oldBranches) return;

  for (const branch of oldBranches) {
    const sessionsForBranch = branchToSessions.get(branch);
    if (!sessionsForBranch) continue;
    sessionsForBranch.delete(sessionId);
    if (sessionsForBranch.size === 0) branchToSessions.delete(branch);
  }
  sessionBranches.delete(sessionId);
}

export function updateBranchIndex(
  session: BranchSessionLike,
  args: BranchIndexArgs & { isArchived: boolean },
): void {
  if (args.isArchived) {
    removeBranchIndexEntries(session.id, args);
    return;
  }

  removeBranchIndexEntries(session.id, args);

  const branches = new Set<string>();
  for (const ref of [session.state.git_branch, session.state.diff_base_branch, session.state.git_default_branch]) {
    const name = ref?.trim();
    if (!name) continue;
    branches.add(name);
    let sessionsForBranch = args.branchToSessions.get(name);
    if (!sessionsForBranch) {
      sessionsForBranch = new Set();
      args.branchToSessions.set(name, sessionsForBranch);
    }
    sessionsForBranch.add(session.id);
  }

  if (branches.size > 0) {
    args.sessionBranches.set(session.id, branches);
  }
}

export function cleanupBranchState(
  sessionId: string,
  args: BranchIndexArgs & { lastCrossSessionRefreshAt: Map<string, number> },
): void {
  removeBranchIndexEntries(sessionId, args);
  args.lastCrossSessionRefreshAt.delete(sessionId);
}

export function invalidateSessionsSharingBranch(
  triggerSession: BranchSessionLike,
  args: BranchIndexArgs & {
    sessions: Map<string, BranchSessionLike>;
    lastCrossSessionRefreshAt: Map<string, number>;
    throttleMs: number;
    isArchived: (sessionId: string) => boolean;
    refreshSession: (session: BranchSessionLike) => void;
    now?: number;
  },
): { changedBranch: string | null; invalidatedCount: number } {
  const changedBranch = triggerSession.state.git_branch?.trim() || "";
  if (!changedBranch) {
    return { changedBranch: null, invalidatedCount: 0 };
  }

  const affectedSessionIds = args.branchToSessions.get(changedBranch);
  if (!affectedSessionIds || affectedSessionIds.size === 0) {
    return { changedBranch, invalidatedCount: 0 };
  }

  const snapshot = Array.from(affectedSessionIds);
  const now = args.now ?? Date.now();
  let invalidatedCount = 0;

  for (const sessionId of snapshot) {
    if (sessionId === triggerSession.id) continue;

    const session = args.sessions.get(sessionId);
    if (!session) continue;
    if (args.isArchived(sessionId)) continue;

    const lastRefresh = args.lastCrossSessionRefreshAt.get(sessionId) ?? 0;
    if (now - lastRefresh < args.throttleMs) continue;

    args.lastCrossSessionRefreshAt.set(sessionId, now);
    session.diffStatsDirty = true;
    args.refreshSession(session);
    invalidatedCount++;
  }

  return { changedBranch, invalidatedCount };
}
