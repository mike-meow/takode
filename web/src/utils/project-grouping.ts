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
  isOrchestrator?: boolean;
  herdedBy?: string;
  sessionNum?: number | null;
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
 * Groups sessions by project directory, sorts groups by most recent activity,
 * and sorts sessions within each group (running first, then by createdAt desc).
 */
export function groupSessionsByProject(
  sessions: SessionItem[],
  sessionAttention?: Map<string, "action" | "error" | "review" | null>,
  sessionOrder?: Map<string, string[]>,
  groupOrder?: string[],
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

    const group = groups.get(key)!;
    group.sessions.push(session);
    // Use the same priority logic as SessionStatusDot so counts match visible dots
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
    group.mostRecentActivity = Math.max(group.mostRecentActivity, session.createdAt);
  }

  // Sort groups by custom group order when available; otherwise alphabetically.
  const sorted = Array.from(groups.values());
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

  // Within each group, sort sessions by custom order if available, else by createdAt desc
  for (const group of sorted) {
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
        if (bIdx === undefined) return 1;  // b is new, goes first
        return aIdx - bIdx;
      });
    } else {
      group.sessions.sort((a, b) => b.createdAt - a.createdAt);
    }
  }

  return sorted;
}
