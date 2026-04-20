import type { SdkSessionInfo } from "../types.js";
import { deriveSessionStatus } from "../components/SessionStatusDot.js";

export interface SessionItem {
  id: string;
  claimedQuestStatus?: string;
  model: string;
  cwd: string;
  gitBranch: string;
  isContainerized: boolean;
  gitAhead: number;
  gitBehind: number;
  linesAdded: number;
  linesRemoved: number;
  isConnected: boolean;
  status: "idle" | "running" | "compacting" | "reverting" | null;
  sdkState: "starting" | "connected" | "running" | "exited" | null;
  createdAt: number;
  archived: boolean;
  archivedAt?: number;
  backendType: "claude" | "codex" | "claude-sdk";
  repoRoot: string;
  permCount: number;
  pendingTimerCount?: number;
  cronJobId?: string;
  cronJobName?: string;
  isWorktree?: boolean;
  worktreeExists?: boolean;
  worktreeDirty?: boolean;
  askPermission?: boolean;
  idleKilled?: boolean;
  lastActivityAt?: number;
  lastUserMessageAt?: number;
  isOrchestrator?: boolean;
  herdedBy?: string;
  sessionNum?: number | null;
  reviewerOf?: number;
}

export interface ProjectGroup {
  key: string;
  label: string;
  sessions: SessionItem[];
  runningCount: number;
  permCount: number;
  unreadCount: number;
  mostRecentActivity: number;
}

/**
 * Extracts a project key from a cwd path.
 * Uses repoRoot when available (normalizes to the parent repo).
 */
export function extractProjectKey(cwd: string, repoRoot?: string): string {
  const basePath = repoRoot || cwd;
  return basePath.replace(/\/+$/, "") || "/";
}

/**
 * Extracts a display label from a project key (last path component).
 */
export function extractProjectLabel(projectKey: string): string {
  if (projectKey === "/") return "/";
  const parts = projectKey.split("/").filter(Boolean);
  if (parts.length === 0) return "/";
  return parts[parts.length - 1];
}

/**
 * Groups sessions by project directory, sorts groups and sessions within each group.
 *
 * sortMode controls ordering:
 * - "created" (default): custom drag order if set, otherwise createdAt desc
 * - "activity": lastActivityAt desc, ignoring custom drag orders
 */
export function groupSessionsByProject(
  sessions: SessionItem[],
  sessionAttention?: Map<string, "action" | "error" | "review" | null>,
  sessionOrder?: Map<string, string[]>,
  groupOrder?: string[],
  sortMode?: "created" | "activity",
  leaderFirstHerds = false,
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const leadersWithVisibleWorkers = leaderFirstHerds ? findLeadersWithVisibleWorkers(sessions) : undefined;

  for (const session of sessions) {
    const key = extractProjectKey(session.cwd, session.repoRoot || undefined);
    const label = extractProjectLabel(key);

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label,
        sessions: [],
        runningCount: 0,
        permCount: 0,
        unreadCount: 0,
        mostRecentActivity: 0,
      });
    }

    groups.get(key)!.sessions.push(session);
  }

  // Reassign reviewer sessions to their parent's group so nesting works correctly.
  // Reviewers may have different CWDs (e.g., no worktree) than their parent worker.
  const sessionNumToGroup = new Map<number, string>();
  for (const [key, group] of groups) {
    for (const s of group.sessions) {
      if (s.sessionNum != null) sessionNumToGroup.set(s.sessionNum, key);
    }
  }
  for (const [key, group] of groups) {
    const toRemove: number[] = [];
    for (let i = 0; i < group.sessions.length; i++) {
      const s = group.sessions[i];
      if (s.reviewerOf === undefined) continue;
      const parentGroupKey = sessionNumToGroup.get(s.reviewerOf);
      if (parentGroupKey && parentGroupKey !== key) {
        groups.get(parentGroupKey)!.sessions.push(s);
        toRemove.push(i);
      }
    }
    for (let i = toRemove.length - 1; i >= 0; i--) {
      group.sessions.splice(toRemove[i], 1);
    }
  }
  for (const [key, group] of groups) {
    if (group.sessions.length === 0) groups.delete(key);
  }

  // Compute aggregate counters after reassignment so they reflect final group membership.
  for (const [, group] of groups) {
    group.runningCount = 0;
    group.permCount = 0;
    group.unreadCount = 0;
    group.mostRecentActivity = 0;
    for (const session of group.sessions) {
      const visualStatus = deriveSessionStatus({
        archived: session.archived,
        permCount: session.permCount,
        isConnected: session.isConnected,
        sdkState: session.sdkState,
        status: session.status,
        hasUnread: !!sessionAttention?.get(session.id),
        idleKilled: session.idleKilled,
      });
      if (visualStatus === "running" || visualStatus === "compacting") group.runningCount++;
      else if (visualStatus === "permission") group.permCount++;
      else if (visualStatus === "completed_unread") group.unreadCount++;
      group.mostRecentActivity = Math.max(group.mostRecentActivity, session.lastActivityAt ?? session.createdAt);
    }
  }

  // Sort groups: always by custom order or alphabetically.
  // Activity sort mode only affects session ordering WITHIN groups --
  // group order stays under manual user control.
  const sorted = Array.from(groups.values());
  {
    const customGroupOrder = Array.isArray(groupOrder) ? groupOrder : [];
    if (customGroupOrder.length > 0) {
      const orderMap = new Map(customGroupOrder.map((groupKey, idx) => [groupKey, idx]));
      sorted.sort((a, b) => {
        const aIdx = orderMap.get(a.key);
        const bIdx = orderMap.get(b.key);
        // Ordered groups stay in explicit user-defined order.
        // New/unordered groups appear after ordered groups, sorted by label.
        if (aIdx === undefined && bIdx === undefined) return a.label.localeCompare(b.label);
        if (aIdx === undefined) return 1;
        if (bIdx === undefined) return -1;
        return aIdx - bIdx;
      });
    } else {
      sorted.sort((a, b) => a.label.localeCompare(b.label));
    }
  }

  // Sort sessions within each group: by last user message time or by custom/created order.
  for (const group of sorted) {
    if (sortMode === "activity") {
      // Sort strictly by last USER message time -- not by assistant activity or
      // tool progress, which would cause sessions to flip order constantly while
      // concurrently working.  Fall back to createdAt for sessions with no user
      // messages yet.
      group.sessions.sort((a, b) => (b.lastUserMessageAt ?? b.createdAt) - (a.lastUserMessageAt ?? a.createdAt));
    } else {
      const customOrder = sessionOrder?.get(group.key);
      if (customOrder && customOrder.length > 0) {
        const orderMap = new Map(customOrder.map((id, idx) => [id, idx]));
        group.sessions.sort((a, b) => {
          const aIdx = orderMap.get(a.id);
          const bIdx = orderMap.get(b.id);
          // Sessions in custom order come first, in that order
          // Sessions not in custom order (newly created) go to the top
          if (aIdx === undefined && bIdx === undefined) return b.createdAt - a.createdAt;
          if (aIdx === undefined) return -1; // a is new, goes first
          if (bIdx === undefined) return 1; // b is new, goes first
          return aIdx - bIdx;
        });
      } else {
        group.sessions.sort((a, b) => b.createdAt - a.createdAt);
      }
    }
    // Post-sort: move reviewer sessions directly after their parent session
    // so they visually nest under the parent in the sidebar.
    nestReviewerSessions(group.sessions);
    if (leaderFirstHerds) {
      moveHerdLeadersBeforeWorkers(group.sessions, leadersWithVisibleWorkers);
    }
  }

  return sorted;
}

function findLeadersWithVisibleWorkers(sessions: SessionItem[]): Set<string> {
  const sessionIds = new Set(sessions.map((s) => s.id));
  const leaderIds = new Set<string>();
  for (const session of sessions) {
    if (session.herdedBy && sessionIds.has(session.herdedBy)) {
      leaderIds.add(session.herdedBy);
    }
  }
  return leaderIds;
}

/**
 * Moves each visible herd leader to just before the first worker in that herd.
 * If the leader is visible but its workers are in another project group, move
 * it to the top of this group instead. Leaders never move across groups.
 * Does not move unrelated orchestrators, does not reorder workers, and does not
 * otherwise collapse the sorted/manual session order.
 */
export function moveHerdLeadersBeforeWorkers(sessions: SessionItem[], leadersWithVisibleWorkers?: Set<string>): void {
  const ids = new Set(sessions.map((s) => s.id));
  const leaderToFirstWorkerIndex = new Map<string, number>();

  sessions.forEach((session, index) => {
    const leaderId = session.herdedBy;
    if (!leaderId || !ids.has(leaderId)) return;
    const first = leaderToFirstWorkerIndex.get(leaderId);
    if (first === undefined || index < first) {
      leaderToFirstWorkerIndex.set(leaderId, index);
    }
  });

  const leadersToMoveIds = new Set<string>(leaderToFirstWorkerIndex.keys());
  for (const session of sessions) {
    if (leadersWithVisibleWorkers?.has(session.id)) {
      leadersToMoveIds.add(session.id);
    }
  }

  if (leadersToMoveIds.size === 0) return;

  const leadersToMove = new Map<string, SessionItem>();
  const crossGroupLeadersToTop: SessionItem[] = [];
  const withoutMovedLeaders: SessionItem[] = [];

  for (const session of sessions) {
    if (leadersToMoveIds.has(session.id)) {
      leadersToMove.set(session.id, session);
      if (!leaderToFirstWorkerIndex.has(session.id)) {
        crossGroupLeadersToTop.push(session);
      }
    } else {
      withoutMovedLeaders.push(session);
    }
  }

  const inserted = new Set(crossGroupLeadersToTop.map((s) => s.id));
  const result: SessionItem[] = [...crossGroupLeadersToTop];
  for (const session of withoutMovedLeaders) {
    const leaderId = session.herdedBy;
    const leader = leaderId ? leadersToMove.get(leaderId) : undefined;
    if (leaderId && leader && !inserted.has(leaderId)) {
      result.push(leader);
      inserted.add(leaderId);
    }
    result.push(session);
  }

  // If a leader had workers only in a filtered-out list mutation edge case,
  // preserve it rather than dropping it.
  for (const [leaderId, leader] of leadersToMove) {
    if (!inserted.has(leaderId)) result.push(leader);
  }

  sessions.length = 0;
  sessions.push(...result);
}

/**
 * Moves reviewer sessions directly after their parent session (in-place).
 * Reviewers that have no matching parent in the list stay at their current position.
 */
export function nestReviewerSessions(sessions: SessionItem[]): void {
  // Extract reviewers from the list
  const reviewers: SessionItem[] = [];
  const nonReviewers: SessionItem[] = [];
  for (const s of sessions) {
    if (s.reviewerOf !== undefined) {
      reviewers.push(s);
    } else {
      nonReviewers.push(s);
    }
  }
  if (reviewers.length === 0) return;

  // Build the result: for each non-reviewer, append its reviewers right after it
  const reviewersByParent = new Map<number, SessionItem[]>();
  for (const r of reviewers) {
    const list = reviewersByParent.get(r.reviewerOf!) || [];
    list.push(r);
    reviewersByParent.set(r.reviewerOf!, list);
  }

  const result: SessionItem[] = [];
  for (const s of nonReviewers) {
    result.push(s);
    if (s.sessionNum !== undefined && s.sessionNum !== null) {
      const children = reviewersByParent.get(s.sessionNum);
      if (children) {
        result.push(...children);
        reviewersByParent.delete(s.sessionNum);
      }
    }
  }
  // Append orphaned reviewers at the end
  for (const [, orphans] of reviewersByParent) {
    result.push(...orphans);
  }

  // Replace in-place
  sessions.length = 0;
  sessions.push(...result);
}
