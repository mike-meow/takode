import type { SidebarSessionItem as SessionItem } from "./sidebar-session-item.js";
import type { TreeGroup } from "../types.js";
import { deriveSessionStatus } from "../components/SessionStatusDot.js";

export const PENDING_TREE_GROUP_ID = "__pending_session_location__";
const PENDING_TREE_GROUP: TreeGroup = { id: PENDING_TREE_GROUP_ID, name: "Locating..." };
const DEFAULT_TREE_GROUP: TreeGroup = { id: "default", name: "Default" };

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
  /** Render-only fallback synthesized from session metadata while authoritative tree groups hydrate. */
  inferred?: boolean;
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

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

type HydratedTreeGroup = TreeGroup & { inferred?: boolean };

interface OrderedGroupsResult {
  groups: HydratedTreeGroup[];
  groupAliases: Map<string, string>;
  groupIdBySessionSpace: Map<string, string>;
}

function buildOrderedGroups(
  treeGroups: TreeGroup[],
  sessions: SessionItem[],
  treeAssignments: Map<string, string>,
): OrderedGroupsResult {
  const orderedGroups: HydratedTreeGroup[] = [];
  const groupAliases = new Map<string, string>();
  const groupIdBySessionSpace = new Map<string, string>();
  for (const group of treeGroups) {
    const id = normalizeNonEmptyString(group.id) ?? "";
    const name = normalizeNonEmptyString(group.name) ?? "";
    if (!id || !name) continue;
    if (id !== DEFAULT_TREE_GROUP.id) {
      const canonicalGroupId = groupIdBySessionSpace.get(name);
      if (canonicalGroupId) {
        groupAliases.set(id, canonicalGroupId);
        continue;
      }
      groupIdBySessionSpace.set(name, id);
    }
    orderedGroups.push({ id, name });
  }
  if (!orderedGroups.some((group) => group.id === DEFAULT_TREE_GROUP.id)) {
    orderedGroups.unshift({ ...DEFAULT_TREE_GROUP });
  }

  const knownGroupIds = new Set(orderedGroups.map((group) => group.id));
  for (const session of sessions) {
    const groupId =
      normalizeNonEmptyString(treeAssignments.get(session.id)) ?? normalizeNonEmptyString(session.treeGroupId);
    if (!groupId || groupId === DEFAULT_TREE_GROUP.id || knownGroupIds.has(groupId)) continue;
    const groupName = normalizeNonEmptyString(session.memorySessionSpaceSlug);
    if (!groupName) continue;
    const canonicalGroupId = groupIdBySessionSpace.get(groupName);
    if (canonicalGroupId) {
      groupAliases.set(groupId, canonicalGroupId);
      continue;
    }

    // Session snapshots can arrive before the tree-group list during refresh,
    // reconnect, or cross-tab updates. Preserve the user's known space instead
    // of sending the session through the transient "Locating..." bucket.
    orderedGroups.push({ id: groupId, name: groupName, inferred: true });
    knownGroupIds.add(groupId);
    groupIdBySessionSpace.set(groupName, groupId);
  }
  return { groups: orderedGroups, groupAliases, groupIdBySessionSpace };
}

function buildNodeOrderGroupIdsBySession(treeNodeOrder: Map<string, string[]> | undefined): Map<string, string[]> {
  const bySession = new Map<string, string[]>();
  for (const [groupId, orderedIds] of treeNodeOrder ?? []) {
    for (const sessionId of orderedIds) {
      const groups = bySession.get(sessionId) ?? [];
      groups.push(groupId);
      bySession.set(sessionId, groups);
    }
  }
  return bySession;
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
  const {
    groups: orderedGroups,
    groupAliases,
    groupIdBySessionSpace,
  } = buildOrderedGroups(treeGroups, sessions, assignments);
  const validGroupIds = new Set(orderedGroups.map((group) => group.id));
  validGroupIds.add(DEFAULT_TREE_GROUP.id);
  validGroupIds.add(PENDING_TREE_GROUP_ID);
  const nodeOrderGroupIdsBySession = buildNodeOrderGroupIdsBySession(treeNodeOrder);
  const groupIdForSession = (session: SessionItem): string => {
    const assignedRaw = normalizeNonEmptyString(assignments.get(session.id));
    const metadataGroupIdRaw = normalizeNonEmptyString(session.treeGroupId);
    const assigned = assignedRaw ? (groupAliases.get(assignedRaw) ?? assignedRaw) : undefined;
    const metadataGroupId = metadataGroupIdRaw
      ? (groupAliases.get(metadataGroupIdRaw) ?? metadataGroupIdRaw)
      : undefined;
    const sessionSpaceSlug = normalizeNonEmptyString(session.memorySessionSpaceSlug);
    const matchingSessionSpaceGroupId = sessionSpaceSlug ? groupIdBySessionSpace.get(sessionSpaceSlug) : undefined;
    const nodeOrderGroupIds = nodeOrderGroupIdsBySession.get(session.id) ?? [];
    if (
      matchingSessionSpaceGroupId &&
      (assigned === DEFAULT_TREE_GROUP.id ||
        metadataGroupId === DEFAULT_TREE_GROUP.id ||
        (!assigned && !metadataGroupId)) &&
      nodeOrderGroupIds.includes(matchingSessionSpaceGroupId)
    ) {
      return matchingSessionSpaceGroupId;
    }
    if (
      matchingSessionSpaceGroupId &&
      ((assigned && !validGroupIds.has(assigned)) ||
        (metadataGroupId && metadataGroupId !== DEFAULT_TREE_GROUP.id && !validGroupIds.has(metadataGroupId)))
    ) {
      return matchingSessionSpaceGroupId;
    }
    if (assigned) return assigned;
    if (metadataGroupId) return metadataGroupId;
    return PENDING_TREE_GROUP_ID;
  };
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
      const groupId = groupIdForSession(s);
      leaderGroupMap.set(s.id, groupId);
    }
  }

  const groupBuckets = new Map<string, SessionItem[]>();
  // Initialize buckets for all defined groups
  for (const g of orderedGroups) {
    groupBuckets.set(g.id, []);
  }
  if (!groupBuckets.has(DEFAULT_TREE_GROUP.id)) {
    groupBuckets.set(DEFAULT_TREE_GROUP.id, []);
  }
  groupBuckets.set(PENDING_TREE_GROUP_ID, []);

  for (const s of nonReviewers) {
    let groupId: string;
    if (s.herdedBy) {
      // Worker follows its leader's group
      groupId = leaderGroupMap.get(s.herdedBy) || groupIdForSession(s);
    } else {
      groupId = groupIdForSession(s);
    }
    // Ensure bucket exists (assignment might reference a deleted group)
    if (!validGroupIds.has(groupId) || !groupBuckets.has(groupId)) groupId = PENDING_TREE_GROUP_ID;
    groupBuckets.get(groupId)!.push(s);
  }

  // 4. Build TreeNodes within each group
  const result: TreeViewGroupData[] = [];

  // Use treeGroups order; ensure default and inferred hydrated groups are included.
  const groupsToRender = [...orderedGroups];
  if ((groupBuckets.get(PENDING_TREE_GROUP_ID)?.length ?? 0) > 0) {
    groupsToRender.push(PENDING_TREE_GROUP);
  }

  for (const group of groupsToRender) {
    const bucket = groupBuckets.get(group.id);
    if (!bucket || bucket.length === 0) {
      // Empty Session Spaces still need a visible creation path, including
      // the default space in a brand-new install with zero sessions.
      result.push({
        id: group.id,
        name: group.name,
        ...(group.inferred ? { inferred: true } : {}),
        nodes: [],
        runningCount: 0,
        permCount: 0,
        unreadCount: 0,
      });
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
      ...(group.inferred ? { inferred: true } : {}),
      nodes,
      runningCount,
      permCount,
      unreadCount,
    });
  }

  return result;
}
