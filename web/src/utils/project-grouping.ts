import type { SdkSessionInfo } from "../types.js";
import { deriveSessionStatus } from "../components/SessionStatusDot.js";

export interface SessionItem {
  id: string;
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
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();

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
      group.sessions.sort((a, b) =>
        (b.lastUserMessageAt ?? b.createdAt) - (a.lastUserMessageAt ?? a.createdAt),
      );
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
  }

  return sorted;
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
