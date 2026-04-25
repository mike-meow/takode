import type { SidebarSessionItem as SessionItem } from "./sidebar-session-item.js";
import type { TreeGroup } from "../types.js";
import { deriveSessionStatus } from "../components/SessionStatusDot.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TreeNode {
  /** Leader session or standalone session (the root of this node). */
  leader: SessionItem;
  /** Herded workers (empty for standalone sessions). */
  workers: SessionItem[];
  /** Reviewer sessions (displayed as chips, not separate rows). */
  reviewers: SessionItem[];
}

export interface TreeViewGroupData {
  id: string;
  name: string;
  nodes: TreeNode[];
  runningCount: number;
  permCount: number;
  unreadCount: number;
}

// ─── Sort helpers ────────────────────────────────────────────────────────────

/** Sort sessions in-place by most recent user activity. */
function sortByActivity(sessions: SessionItem[]): void {
  sessions.sort((a, b) => (b.lastUserMessageAt ?? b.createdAt) - (a.lastUserMessageAt ?? a.createdAt));
}

/** Sort sessions in-place by custom order (new sessions first), or by createdAt desc if no custom order. */
function sortByCustomOrder(sessions: SessionItem[], customOrder?: string[]): void {
  if (customOrder && customOrder.length > 0) {
    const orderMap = new Map(customOrder.map((id, idx) => [id, idx]));
    sessions.sort((a, b) => {
      const aIdx = orderMap.get(a.id);
      const bIdx = orderMap.get(b.id);
      if (aIdx === undefined && bIdx === undefined) return b.createdAt - a.createdAt;
      if (aIdx === undefined) return -1; // new sessions first
      if (bIdx === undefined) return 1;
      return aIdx - bIdx;
    });
  } else {
    sessions.sort((a, b) => b.createdAt - a.createdAt);
  }
}

/** Prefer active reviewer chips, then newer archived reviewer records. */
function sortReviewersForParent(reviewers: SessionItem[]): void {
  reviewers.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return b.createdAt - a.createdAt;
  });
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build tree view groups from a flat session list.
 *
 * Groups sessions by their tree-group assignment, builds leader-worker trees
 * within each group, and sorts by manual order or activity.
 */
export function buildTreeViewGroups(
  sessions: SessionItem[],
  treeGroups: TreeGroup[],
  treeAssignments: Map<string, string> | undefined,
  sessionAttention?: Map<string, "action" | "error" | "review" | null>,
  sortMode?: "created" | "activity",
  treeNodeOrder?: Map<string, string[]>,
  /** Reviewer sessions, supplied separately since the Sidebar filters them out of the top-level session list. */
  reviewerSessions?: SessionItem[],
): TreeViewGroupData[] {
  const assignments = treeAssignments ?? new Map<string, string>();
  // 1. Build lookup maps (include reviewer sessions for sessionByNum resolution)
  const sessionById = new Map<string, SessionItem>();
  const sessionByNum = new Map<number, SessionItem>();
  for (const s of sessions) {
    sessionById.set(s.id, s);
    if (s.sessionNum != null) sessionByNum.set(s.sessionNum, s);
  }
  if (reviewerSessions) {
    for (const s of reviewerSessions) {
      sessionById.set(s.id, s);
      if (s.sessionNum != null) sessionByNum.set(s.sessionNum, s);
    }
  }

  // 2. Separate reviewers from the main list.
  // If reviewerSessions was passed in, use it directly (the main `sessions`
  // list may have reviewers pre-filtered out by the caller).
  const reviewers: SessionItem[] = reviewerSessions ?? [];
  const nonReviewers: SessionItem[] = [];
  if (reviewerSessions) {
    // All of `sessions` are non-reviewers when caller supplies reviewers separately
    nonReviewers.push(...sessions);
  } else {
    for (const s of sessions) {
      if (s.reviewerOf !== undefined) {
        reviewers.push(s);
      } else {
        nonReviewers.push(s);
      }
    }
  }

  // 3. Partition non-reviewers into groups.
  // Workers follow their leader's group regardless of their own assignment.
  const leaderGroupMap = new Map<string, string>(); // leaderId -> groupId
  for (const s of nonReviewers) {
    if (s.isOrchestrator && !s.herdedBy) {
      const groupId = assignments.get(s.id) || "default";
      leaderGroupMap.set(s.id, groupId);
    }
  }

  const groupBuckets = new Map<string, SessionItem[]>();
  // Initialize buckets for all defined groups
  for (const g of treeGroups) {
    groupBuckets.set(g.id, []);
  }
  if (!groupBuckets.has("default")) {
    groupBuckets.set("default", []);
  }

  for (const s of nonReviewers) {
    let groupId: string;
    if (s.herdedBy) {
      // Worker follows its leader's group
      groupId = leaderGroupMap.get(s.herdedBy) || assignments.get(s.id) || "default";
    } else {
      groupId = assignments.get(s.id) || "default";
    }
    // Ensure bucket exists (assignment might reference a deleted group)
    if (!groupBuckets.has(groupId)) groupId = "default";
    groupBuckets.get(groupId)!.push(s);
  }

  // 4. Build TreeNodes within each group
  const result: TreeViewGroupData[] = [];

  // Use treeGroups order; ensure default group is included
  const orderedGroups = [...treeGroups];
  if (!orderedGroups.some((g) => g.id === "default")) {
    orderedGroups.unshift({ id: "default", name: "Default" });
  }

  for (const group of orderedGroups) {
    const bucket = groupBuckets.get(group.id);
    if (!bucket || bucket.length === 0) {
      // Include empty non-default groups so the user can see and manage them
      if (group.id !== "default") {
        result.push({ id: group.id, name: group.name, nodes: [], runningCount: 0, permCount: 0, unreadCount: 0 });
      }
      continue;
    }

    // Separate leaders/standalone from workers
    const leaders: SessionItem[] = [];
    const workers: SessionItem[] = [];
    for (const s of bucket) {
      if (s.herdedBy) {
        workers.push(s);
      } else {
        leaders.push(s);
      }
    }

    // Build worker map: leaderId -> workers
    const workersByLeader = new Map<string, SessionItem[]>();
    for (const w of workers) {
      const list = workersByLeader.get(w.herdedBy!) || [];
      list.push(w);
      workersByLeader.set(w.herdedBy!, list);
    }

    // Build reviewer map: sessionNum -> reviewers (only for parents in this group)
    const bucketIds = new Set(bucket.map((s) => s.id));
    const reviewersByParent = new Map<number, SessionItem[]>();
    for (const r of reviewers) {
      const parent = sessionByNum.get(r.reviewerOf!);
      if (!parent) continue;
      // Only include reviewer if its parent is in this group
      if (!bucketIds.has(parent.id)) continue;
      const list = reviewersByParent.get(r.reviewerOf!) || [];
      list.push(r);
      reviewersByParent.set(r.reviewerOf!, list);
    }
    for (const list of reviewersByParent.values()) {
      sortReviewersForParent(list);
    }

    // Sort leaders/standalone by activity or by custom order / creation
    if (sortMode === "activity") {
      sortByActivity(leaders);
    } else {
      sortByCustomOrder(leaders, treeNodeOrder?.get(group.id));
    }

    // Build nodes
    const nodes: TreeNode[] = [];
    for (const leader of leaders) {
      const leaderWorkers = workersByLeader.get(leader.id) || [];
      // Sort workers by activity or creation time
      if (sortMode === "activity") {
        sortByActivity(leaderWorkers);
      } else {
        sortByCustomOrder(leaderWorkers);
      }

      // Collect reviewers for the leader and all its workers
      const nodeReviewers: SessionItem[] = [];
      if (leader.sessionNum != null) {
        nodeReviewers.push(...(reviewersByParent.get(leader.sessionNum) || []));
      }
      for (const w of leaderWorkers) {
        if (w.sessionNum != null) {
          nodeReviewers.push(...(reviewersByParent.get(w.sessionNum) || []));
        }
      }

      nodes.push({
        leader,
        workers: leaderWorkers,
        reviewers: nodeReviewers,
      });
    }

    // Append orphan workers (whose leader is in a different group or doesn't exist) as standalone nodes
    for (const w of workers) {
      const leaderInBucket = leaders.some((l) => l.id === w.herdedBy);
      if (!leaderInBucket) {
        nodes.push({ leader: w, workers: [], reviewers: [] });
      }
    }

    // Compute aggregate counters (include reviewers whose parent is in this group)
    const allSessions = [
      ...bucket,
      ...reviewers.filter((r) => {
        const parent = r.reviewerOf != null ? sessionByNum.get(r.reviewerOf) : undefined;
        return parent && bucketIds.has(parent.id);
      }),
    ];

    let runningCount = 0;
    let permCount = 0;
    let unreadCount = 0;
    for (const s of allSessions) {
      const visualStatus = deriveSessionStatus({
        archived: s.archived,
        permCount: s.permCount,
        isConnected: s.isConnected,
        sdkState: s.sdkState,
        status: s.status,
        hasUnread: !!sessionAttention?.get(s.id),
        idleKilled: s.idleKilled,
      });
      if (visualStatus === "running" || visualStatus === "compacting") runningCount++;
      else if (visualStatus === "permission") permCount++;
      else if (visualStatus === "completed_unread") unreadCount++;
    }

    result.push({
      id: group.id,
      name: group.name,
      nodes,
      runningCount,
      permCount,
      unreadCount,
    });
  }

  return result;
}
