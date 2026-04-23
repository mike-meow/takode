import { useState, useEffect, useCallback, useRef, useMemo, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
  type DraggableAttributes,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStore, countUserPermissions, type PendingSession } from "../store.js";
import { api, type SessionSearchResult } from "../api.js";
import { writeClipboardText } from "../utils/copy-utils.js";
import { connectSession, disconnectSession } from "../ws.js";
import { navigateToSession, navigateToMostRecentSession, parseHash } from "../utils/routing.js";
import { cancelPendingCreation } from "../utils/pending-creation.js";
import { getTreeGroupNewSessionDefaultsKey } from "../utils/new-session-defaults.js";
import { bootstrapServerId, scopedGetItem } from "../utils/scoped-storage.js";
import { TreeViewGroup } from "./TreeViewGroup.js";
import { SessionItem, type ArchiveConfirmationState } from "./SessionItem.js";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { SessionHoverCard } from "./SessionHoverCard.js";
import { SidebarUsageBar } from "./SidebarUsageBar.js";
import { YarnBallSpinner } from "./CatIcons.js";
import { deriveSessionStatus } from "./SessionStatusDot.js";
import type { SessionTaskEntry, SdkSessionInfo } from "../types.js";

import type { SidebarSessionItem as SessionItemType } from "../utils/sidebar-session-item.js";
import { buildTreeViewGroups } from "../utils/tree-grouping.js";
import { isDesktopShellLayout } from "../utils/layout.js";
import { questOwnsSessionName } from "../utils/quest-helpers.js";
import {
  buildHerdGroupBadgeThemes,
  getHerdGroupLeaderId,
  type HerdGroupBadgeTheme,
} from "../utils/herd-group-theme.js";

const SIDEBAR_SESSION_POLL_INTERVAL_MS = 5000;
const SIDEBAR_SESSION_STALE_REFRESH_MS = 3 * 60 * 1000;
const SIDEBAR_SLOW_REFRESH_INDICATOR_DELAY_MS = 400;

/** Restrict drag movement to vertical axis only. */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

function sumDiffFileStats(fileStats: Map<string, { additions: number; deletions: number }> | undefined) {
  let additions = 0;
  let deletions = 0;
  for (const stats of fileStats?.values() ?? []) {
    additions += stats.additions;
    deletions += stats.deletions;
  }
  return { additions, deletions };
}

function sessionTaskHistoryEqual(a: SessionTaskEntry[] | undefined, b: SessionTaskEntry[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.title !== right.title ||
      left.action !== right.action ||
      left.timestamp !== right.timestamp ||
      left.triggerMessageId !== right.triggerMessageId ||
      left.source !== right.source ||
      left.questId !== right.questId
    ) {
      return false;
    }
  }
  return true;
}

function stringArrayEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function stripSearchMetadata(session: SdkSessionInfo): SdkSessionInfo {
  const { taskHistory: _taskHistory, keywords: _keywords, ...rest } = session;
  return rest;
}

/** Build "Move to..." submenu items for the session context menu (tree view only). */
function buildMoveToSubmenu(
  treeGroups: Array<{ id: string; name: string }>,
  treeAssignments: Map<string, string>,
  sessionId: string,
): ContextMenuItem[] {
  if (treeGroups.length === 0) return [];
  const currentGroup = treeAssignments.get(sessionId) || "default";
  const otherGroups = treeGroups.filter((g) => g.id !== currentGroup);
  if (otherGroups.length === 0) return [];
  return [
    {
      label: "Move to...",
      onClick: () => {},
      children: otherGroups.map((g) => ({
        label: g.name,
        onClick: () => {
          api.assignSessionToTreeGroup(sessionId, g.id).catch(console.error);
        },
      })),
    },
  ];
}

function SortableTreeGroup({
  id,
  children,
}: {
  id: string;
  children: (props: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: CSSProperties;
    listeners: Record<string, Function> | undefined;
    attributes: DraggableAttributes;
    isDragging: boolean;
  }) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.75 : 1,
  };

  return <>{children({ setNodeRef, style, listeners, attributes, isDragging })}</>;
}

export function Sidebar() {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [mobileReorderHandleActive, setMobileReorderHandleActive] = useState(false);
  const [archiveConfirmation, setArchiveConfirmation] = useState<ArchiveConfirmationState | null>(null);
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [hoveredSession, setHoveredSession] = useState<{ sessionId: string; rect: DOMRect } | null>(null);
  const [hash, setHash] = useState(() => (typeof window !== "undefined" ? window.location.hash : ""));
  const editInputRef = useRef<HTMLInputElement>(null);
  const [editingServerName, setEditingServerName] = useState(false);
  const [serverNameDraft, setServerNameDraft] = useState("");
  const serverNameInputRef = useRef<HTMLInputElement>(null);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const cliConnected = useStore((s) => s.cliConnected);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const removeSession = useStore((s) => s.removeSession);
  const sessionNames = useStore((s) => s.sessionNames);
  const recentlyRenamed = useStore((s) => s.recentlyRenamed);
  const clearRecentlyRenamed = useStore((s) => s.clearRecentlyRenamed);
  const sessionPreviews = useStore((s) => s.sessionPreviews);
  const sessionTaskHistory = useStore((s) => s.sessionTaskHistory);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const sessionAttention = useStore((s) => s.sessionAttention);
  const askPermissionMap = useStore((s) => s.askPermission);
  const reorderMode = useStore((s) => s.reorderMode);
  const setReorderMode = useStore((s) => s.setReorderMode);
  const sessionSortMode = useStore((s) => s.sessionSortMode);
  const setSessionSortMode = useStore((s) => s.setSessionSortMode);
  const treeGroups = useStore((s) => s.treeGroups);
  const treeAssignments = useStore((s) => s.treeAssignments);
  const collapsedTreeGroups = useStore((s) => s.collapsedTreeGroups);
  const toggleTreeGroupCollapse = useStore((s) => s.toggleTreeGroupCollapse);
  const collapsedTreeNodes = useStore((s) => s.collapsedTreeNodes);
  const toggleTreeNodeCollapse = useStore((s) => s.toggleTreeNodeCollapse);
  const treeNodeOrder = useStore((s) => s.treeNodeOrder);
  const pendingSessions = useStore((s) => s.pendingSessions);
  const diffFileStats = useStore((s) => s.diffFileStats);
  const serverName = useStore((s) => s.serverName);
  const setServerName = useStore((s) => s.setServerName);
  const zoomLevel = useStore((s) => s.zoomLevel ?? 1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchResults, setSearchResults] = useState<SessionSearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [showSessionRefreshStatus, setShowSessionRefreshStatus] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarMountedRef = useRef(true);
  const lastSuccessfulSessionRefreshAtRef = useRef(0);
  const inFlightSessionRefreshRef = useRef<Promise<void> | null>(null);
  const slowRefreshTimerRef = useRef<number | null>(null);
  const route = parseHash(hash);
  const isSettingsPage = route.page === "settings";
  const isTerminalPage = route.page === "terminal";
  const isScheduledPage = route.page === "scheduled";
  const isQuestmasterPage = route.page === "questmaster";
  const isDesktopLayout = isDesktopShellLayout(zoomLevel);
  const getSidebarPermissionCount = useCallback(
    (sessionId: string, fallbackCount?: number | null) => {
      const livePermissions = pendingPermissions.get(sessionId);
      if (livePermissions) return countUserPermissions(livePermissions);
      return fallbackCount ?? 0;
    },
    [pendingPermissions],
  );

  const applySessionSnapshot = useCallback((list: SdkSessionInfo[]) => {
    const store = useStore.getState();
    store.setSdkSessions(list.map(stripSearchMetadata));
    // Hydrate session names from server (server is source of truth for auto-generated names)
    let batchedAttention: Map<string, "action" | "error" | "review" | null> | null = null;
    for (const s of list) {
      if (s.name) {
        const currentStoreName = store.sessionNames.get(s.sessionId);
        if (currentStoreName !== s.name) {
          const hadRandomName = !!currentStoreName && /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(currentStoreName);
          store.setSessionName(s.sessionId, s.name);
          if (hadRandomName) {
            store.markRecentlyRenamed(s.sessionId);
          }
        }
      }
      if (!s.isOrchestrator && questOwnsSessionName(s.claimedQuestStatus ?? undefined)) {
        store.markQuestNamed(s.sessionId);
      } else {
        store.clearQuestNamed(s.sessionId);
      }
      // Hydrate last message preview from server (only if client doesn't have one yet)
      if (s.lastMessagePreview && !store.sessionPreviews.has(s.sessionId)) {
        store.setSessionPreview(s.sessionId, s.lastMessagePreview);
      }
      // Hydrate task history and keywords from server for search
      const nextTaskHistory = s.taskHistory ?? [];
      const currentTaskHistory = store.sessionTaskHistory.get(s.sessionId);
      if (!sessionTaskHistoryEqual(currentTaskHistory, nextTaskHistory)) {
        store.setSessionTaskHistory(s.sessionId, nextTaskHistory);
      }
      const nextKeywords = s.keywords ?? [];
      const currentKeywords = store.sessionKeywords.get(s.sessionId);
      if (!stringArrayEqual(currentKeywords, nextKeywords)) {
        store.setSessionKeywords(s.sessionId, nextKeywords);
      }
      // Batch server-authoritative attention state changes
      if (s.attentionReason !== undefined) {
        const currentAttention = store.sessionAttention.get(s.sessionId);
        if (currentAttention !== s.attentionReason) {
          // Suppress attention for the session the user is currently viewing
          if (store.currentSessionId === s.sessionId && s.attentionReason) {
            api.markSessionRead(s.sessionId).catch(() => {});
          } else {
            if (!batchedAttention) batchedAttention = new Map(store.sessionAttention);
            batchedAttention.set(s.sessionId, s.attentionReason ?? null);
          }
        }
      }
    }
    if (batchedAttention) {
      useStore.setState({ sessionAttention: batchedAttention });
    }
  }, []);

  const refreshSessionList = useCallback(
    ({ reason }: { reason: "mount" | "poll" | "focus" | "visibility" | "pageshow" }) => {
      if (inFlightSessionRefreshRef.current) {
        return inFlightSessionRefreshRef.current;
      }
      const currentRefreshPromise = (async () => {
        if (slowRefreshTimerRef.current !== null) {
          window.clearTimeout(slowRefreshTimerRef.current);
        }
        slowRefreshTimerRef.current = window.setTimeout(() => {
          if (sidebarMountedRef.current) {
            setShowSessionRefreshStatus(true);
          }
        }, SIDEBAR_SLOW_REFRESH_INDICATOR_DELAY_MS);
        try {
          const list = await api.listSessions();
          lastSuccessfulSessionRefreshAtRef.current = Date.now();
          applySessionSnapshot(list);
        } catch (e) {
          console.warn(`[sidebar] session refresh failed (${reason}):`, e);
        } finally {
          if (slowRefreshTimerRef.current !== null) {
            window.clearTimeout(slowRefreshTimerRef.current);
            slowRefreshTimerRef.current = null;
          }
          if (sidebarMountedRef.current) {
            setShowSessionRefreshStatus(false);
          }
          inFlightSessionRefreshRef.current = null;
        }
      })();
      inFlightSessionRefreshRef.current = currentRefreshPromise;
      return currentRefreshPromise;
    },
    [applySessionSnapshot],
  );

  // Poll for SDK sessions on mount and refresh stale snapshots when the page regains attention.
  useEffect(() => {
    let active = true;
    sidebarMountedRef.current = true;
    void refreshSessionList({ reason: "mount" });

    const interval = window.setInterval(() => {
      void refreshSessionList({ reason: "poll" });
    }, SIDEBAR_SESSION_POLL_INTERVAL_MS);

    const refreshIfStale = (reason: "focus" | "visibility" | "pageshow") => {
      if (!active) return;
      const lastRefreshAt = lastSuccessfulSessionRefreshAtRef.current;
      if (lastRefreshAt !== 0 && Date.now() - lastRefreshAt < SIDEBAR_SESSION_STALE_REFRESH_MS) {
        return;
      }
      void refreshSessionList({ reason });
    };

    const handleWindowFocus = () => refreshIfStale("focus");
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshIfStale("visibility");
      }
    };
    const handlePageShow = () => refreshIfStale("pageshow");

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      active = false;
      sidebarMountedRef.current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      if (slowRefreshTimerRef.current !== null) {
        window.clearTimeout(slowRefreshTimerRef.current);
        slowRefreshTimerRef.current = null;
      }
    };
  }, [refreshSessionList]);

  // Hydrate tree groups on mount so sidebar renders correct grouping immediately.
  // After this initial fetch, WebSocket tree_groups_update keeps groups in sync.
  useEffect(() => {
    api
      .getTreeGroups()
      .then((tgs) => {
        useStore.getState().setTreeGroups(tgs.groups, tgs.assignments, tgs.nodeOrder ?? {});
      })
      .catch((e) => {
        console.warn("[sidebar] tree group hydration failed:", e);
      });
  }, []);

  // Fetch server settings (name + ID) on mount
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        if (s.serverName) setServerName(s.serverName);
        if (s.serverId) {
          const migrated = bootstrapServerId(s.serverId);
          if (migrated) {
            // First visit to this server — re-read store state from now-scoped keys
            const store = useStore.getState();
            const sessionId = scopedGetItem("cc-current-session");
            store.setCurrentSession(sessionId);
            const namesRaw = scopedGetItem("cc-session-names");
            if (namesRaw) {
              try {
                for (const [id, name] of JSON.parse(namesRaw)) {
                  store.setSessionName(id, name);
                }
              } catch {
                /* ignore parse errors */
              }
            }
          }
        }
      })
      .catch(() => {});
  }, []);

  // Update document.title when serverName, attention, or permission counts change.
  // Uses the same deriveSessionStatus logic as the yarn ball indicator (TopBar)
  // so the tab badge count always matches the visible attention indicators.
  useEffect(() => {
    let totalAttention = 0;
    for (const sdk of sdkSessions) {
      if (sdk.archived) continue;
      const vs = deriveSessionStatus({
        permCount: getSidebarPermissionCount(sdk.sessionId, sdk.pendingPermissionCount),
        isConnected: cliConnected.get(sdk.sessionId) ?? sdk.cliConnected ?? false,
        sdkState: sdk.state ?? null,
        status: sessionStatus.get(sdk.sessionId) ?? null,
        hasUnread: !!sessionAttention.get(sdk.sessionId),
        idleKilled: cliDisconnectReason.get(sdk.sessionId) === "idle_limit",
      });
      if (vs === "permission" || vs === "completed_unread") totalAttention++;
    }
    const suffix = import.meta.env.DEV ? "[DEV] Takode" : "Takode";
    const base = serverName ? `${serverName} — ${suffix}` : suffix;
    document.title = totalAttention > 0 ? `(${totalAttention}) ${base}` : base;
  }, [
    serverName,
    sessionAttention,
    sdkSessions,
    sessionStatus,
    cliConnected,
    cliDisconnectReason,
    getSidebarPermissionCount,
  ]);

  // Focus server name input when entering edit mode
  useEffect(() => {
    if (editingServerName && serverNameInputRef.current) {
      serverNameInputRef.current.focus();
      serverNameInputRef.current.select();
    }
  }, [editingServerName]);

  function confirmServerNameEdit() {
    const trimmed = serverNameDraft.trim();
    setServerName(trimmed);
    api.updateSettings({ serverName: trimmed }).catch(() => {});
    setEditingServerName(false);
  }

  function cancelServerNameEdit() {
    setEditingServerName(false);
  }

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!mobileReorderHandleActive) return;

    const clearHandleState = () => setMobileReorderHandleActive(false);
    window.addEventListener("pointerup", clearHandleState);
    window.addEventListener("pointercancel", clearHandleState);
    window.addEventListener("touchend", clearHandleState);
    window.addEventListener("touchcancel", clearHandleState);

    return () => {
      window.removeEventListener("pointerup", clearHandleState);
      window.removeEventListener("pointercancel", clearHandleState);
      window.removeEventListener("touchend", clearHandleState);
      window.removeEventListener("touchcancel", clearHandleState);
    };
  }, [mobileReorderHandleActive]);

  useEffect(() => {
    if (!reorderMode && mobileReorderHandleActive) {
      setMobileReorderHandleActive(false);
    }
  }, [mobileReorderHandleActive, reorderMode]);

  function handleSelectSession(sessionId: string) {
    setContextMenu(null);
    useStore.getState().markSessionViewed(sessionId);
    api.markSessionRead?.(sessionId).catch(() => {});
    // Navigate to session hash — App.tsx hash effect handles setCurrentSession + connectSession
    navigateToSession(sessionId);
    // Close sidebar on mobile
    if (!isDesktopLayout) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleNewSession() {
    useStore.getState().openNewSessionModal();
    if (!isDesktopLayout) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  /** Tree view variant: assigns new session to the tree group after creation. */
  function handleCreateSessionInTreeGroup(treeGroupId: string) {
    const normalizedTreeGroupId = treeGroupId.trim();
    if (!normalizedTreeGroupId) return;

    useStore.getState().openNewSessionModal({
      treeGroupId: normalizedTreeGroupId,
      newSessionDefaultsKey: getTreeGroupNewSessionDefaultsKey(normalizedTreeGroupId),
    });

    if (!isDesktopLayout) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleCreateTreeGroup() {
    // Auto-increment: "Group 1", "Group 2", etc.
    const existing = new Set(treeGroups.map((g) => g.name));
    let n = 1;
    while (existing.has(`Group ${n}`)) n++;
    api.createTreeGroup(`Group ${n}`).catch(console.error);
  }

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (editingSessionId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingSessionId]);

  function confirmRename() {
    if (editingSessionId && editingName.trim()) {
      // Server will broadcast the name update to all browsers via session_update
      api.renameSession(editingSessionId, editingName.trim()).catch(() => {});
    }
    setEditingSessionId(null);
    setEditingName("");
  }

  function cancelRename() {
    setEditingSessionId(null);
    setEditingName("");
  }

  function handleStartRename(id: string, currentName: string) {
    setEditingSessionId(id);
    setEditingName(currentName);
  }

  function handleContextMenu(e: React.MouseEvent, sessionId: string) {
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY });
  }

  // Hover card: use a flag to detect if mouse moved to the popover card
  const hoverIntentRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleHoverStart(sessionId: string, rect: DOMRect) {
    if (hoverIntentRef.current) clearTimeout(hoverIntentRef.current);
    setHoveredSession({ sessionId, rect });
  }

  function handleHoverEnd() {
    // Small delay to allow mouse to move from session item to popover card
    hoverIntentRef.current = setTimeout(() => {
      setHoveredSession(null);
    }, 100);
  }

  function handleHoverCardEnter() {
    if (hoverIntentRef.current) clearTimeout(hoverIntentRef.current);
  }

  function handleHoverCardLeave() {
    setHoveredSession(null);
  }

  const handleDeleteSession = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      try {
        disconnectSession(sessionId);
        await api.deleteSession(sessionId);
      } catch {
        // best-effort
      }
      if (useStore.getState().currentSessionId === sessionId) {
        navigateToMostRecentSession({ excludeId: sessionId });
      }
      removeSession(sessionId);
    },
    [removeSession],
  );

  const handleArchiveSession = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      const sdkInfo = sdkSessions.find((s) => s.sessionId === sessionId);
      const bridgeState = sessions.get(sessionId);
      const isContainerized = bridgeState?.is_containerized || !!sdkInfo?.containerId || false;
      const isWorktree = bridgeState?.is_worktree || sdkInfo?.isWorktree || false;
      const activeWorkerCount =
        sdkInfo?.isOrchestrator === true
          ? sdkSessions.filter((s) => s.herdedBy === sessionId && !s.archived).length
          : 0;
      if (isWorktree || isContainerized || activeWorkerCount > 0) {
        setArchiveConfirmation({
          sessionId,
          kind: isWorktree ? "worktree" : isContainerized ? "container" : "leader",
          activeWorkerCount: activeWorkerCount > 0 ? activeWorkerCount : undefined,
        });
        return;
      }
      doArchive(sessionId);
    },
    [sdkSessions, sessions],
  );

  const doArchive = useCallback(async (sessionId: string, force?: boolean) => {
    try {
      disconnectSession(sessionId);
      useStore.getState().clearSessionAttention(sessionId);
      await api.archiveSession(sessionId, force ? { force: true } : undefined);
    } catch {
      // best-effort
    }
    if (useStore.getState().currentSessionId === sessionId) {
      navigateToMostRecentSession({ excludeId: sessionId });
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  const confirmArchive = useCallback(() => {
    if (archiveConfirmation) {
      doArchive(archiveConfirmation.sessionId, true);
      setArchiveConfirmation(null);
    }
  }, [archiveConfirmation, doArchive]);

  const cancelArchive = useCallback(() => {
    setArchiveConfirmation(null);
  }, []);

  const doArchiveGroup = useCallback(
    async (leaderId: string) => {
      const workers = sdkSessions.filter((s) => s.herdedBy === leaderId && !s.archived);
      try {
        // Disconnect all herded workers + the leader locally
        for (const w of workers) {
          disconnectSession(w.sessionId);
          useStore.getState().clearSessionAttention(w.sessionId);
        }
        disconnectSession(leaderId);
        useStore.getState().clearSessionAttention(leaderId);

        await api.archiveGroup(leaderId);
      } catch {
        // best-effort
      }
      // Navigate away if the current session is part of the archived group
      const currentId = useStore.getState().currentSessionId;
      if (currentId) {
        const allIds = [leaderId, ...workers.map((w) => w.sessionId)];
        if (allIds.includes(currentId)) {
          navigateToMostRecentSession({ excludeId: leaderId });
        }
      }
      try {
        const list = await api.listSessions();
        useStore.getState().setSdkSessions(list);
      } catch {
        // best-effort
      }
    },
    [sdkSessions],
  );

  const doHerdToCurrentSession = useCallback(async (workerId: string, force = false) => {
    const leaderId = useStore.getState().currentSessionId;
    if (!leaderId) return;
    try {
      const result = await api.herdWorkerToLeader(workerId, leaderId, force ? { force: true } : undefined);
      if (result.herded.length === 0) {
        throw new Error("Failed to herd session");
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to herd session");
      return;
    }
  }, []);

  const handleUnarchiveSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      await api.unarchiveSession(sessionId);
    } catch {
      // best-effort
    }
    try {
      const list = await api.listSessions();
      useStore.getState().setSdkSessions(list);
    } catch {
      // best-effort
    }
  }, []);

  // Combine sessions from WsBridge state + SDK sessions list
  const allSessionIds = new Set<string>();
  for (const id of sessions.keys()) allSessionIds.add(id);
  for (const s of sdkSessions) allSessionIds.add(s.sessionId);

  const allSessionList: SessionItemType[] = Array.from(allSessionIds)
    .map((id) => {
      const bridgeState = sessions.get(id);
      const sdkInfo = sdkSessions.find((s) => s.sessionId === id);
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
        permCount: getSidebarPermissionCount(id, sdkInfo?.pendingPermissionCount),
        pendingTimerCount: sdkInfo?.pendingTimerCount ?? 0,
        cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
        cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
        isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
        worktreeExists: sdkInfo?.worktreeExists,
        worktreeDirty: sdkInfo?.worktreeDirty,
        worktreeCleanupStatus: sdkInfo?.worktreeCleanupStatus,
        worktreeCleanupError: sdkInfo?.worktreeCleanupError,
        askPermission: askPermissionMap?.get(id),
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

  // Map: parentSessionNum → active reviewer SessionItem (for inline badge on parent row)
  const activeReviewerByParent = useMemo(() => {
    const map = new Map<number, SessionItemType>();
    for (const s of allSessionList) {
      if (s.reviewerOf !== undefined && !s.archived) {
        map.set(s.reviewerOf, s);
      }
    }
    return map;
  }, [allSessionList]);

  // Reviewer sessions render inline within herd groups rather than as top-level sidebar rows.
  const activeSessions = allSessionList.filter((s) => !s.archived && !s.cronJobId && s.reviewerOf === undefined);
  const activeReviewers = useMemo(
    () => allSessionList.filter((s) => !s.archived && s.reviewerOf !== undefined),
    [allSessionList],
  );
  const cronSessions = allSessionList.filter((s) => !s.archived && !!s.cronJobId);
  const archivedSessions = allSessionList
    .filter((s) => s.archived && s.reviewerOf === undefined)
    .sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt));
  const currentSession = currentSessionId ? allSessionList.find((s) => s.id === currentSessionId) : null;
  const logoSrc = currentSession?.backendType === "codex" ? "/logo-codex.svg" : "/logo.png";
  const [showCronSessions, setShowCronSessions] = useState(true);

  // Build tree view groups (herd-centric grouping)
  const treeViewGroups = useMemo(
    () =>
      buildTreeViewGroups(
        activeSessions,
        treeGroups,
        treeAssignments,
        sessionAttention,
        sessionSortMode,
        treeNodeOrder,
        activeReviewers,
      ),
    [activeSessions, treeGroups, treeAssignments, sessionAttention, sessionSortMode, treeNodeOrder, activeReviewers],
  );
  const treeGroupIds = useMemo(() => treeViewGroups.map((g) => g.id), [treeViewGroups]);
  const groupPointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
  const groupSensors = useSensors(groupPointerSensor);
  const handleTreeGroupDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = treeGroupIds.indexOf(active.id as string);
      const newIndex = treeGroupIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(treeViewGroups, oldIndex, newIndex);
      // Full state replace for group reorder
      const state = {
        groups: reordered.map((g) => ({ id: g.id, name: g.name })),
        assignments: Object.fromEntries(treeAssignments),
      };
      api.updateTreeGroups(state).catch((err) => {
        console.warn("[sidebar] failed to update tree group order:", err);
      });
    },
    [treeGroupIds, treeViewGroups, treeAssignments],
  );

  // Session-level DnD for cross-group moves in tree view.
  // Maps each root session ID to its group so we can detect cross-group drops.
  const sessionToGroupMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of treeViewGroups) {
      for (const n of g.nodes) map.set(n.leader.id, g.id);
    }
    return map;
  }, [treeViewGroups]);
  const allTreeSessionIds = useMemo(
    () => treeViewGroups.flatMap((g) => g.nodes.map((n) => n.leader.id)),
    [treeViewGroups],
  );
  const sessionPointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
  const sessionSensors = useSensors(sessionPointerSensor);
  const handleTreeSessionDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = active.id as string;
      const overId = over.id as string;
      const sourceGroup = sessionToGroupMap.get(activeId);
      const targetGroup = sessionToGroupMap.get(overId);
      if (!sourceGroup || !targetGroup) return;
      if (sourceGroup !== targetGroup) {
        // Cross-group move: assign session to the target's group
        api.assignSessionToTreeGroup(activeId, targetGroup).catch(console.error);
      } else {
        // Within-group reorder
        const group = treeViewGroups.find((g) => g.id === sourceGroup);
        if (!group) return;
        const nodeIds = group.nodes.map((n) => n.leader.id);
        const oldIndex = nodeIds.indexOf(activeId);
        const newIndex = nodeIds.indexOf(overId);
        if (oldIndex === -1 || newIndex === -1) return;
        const newOrder = arrayMove(nodeIds, oldIndex, newIndex);
        api.updateTreeNodeOrder(sourceGroup, newOrder).catch(console.error);
      }
    },
    [sessionToGroupMap, treeViewGroups],
  );

  // Server-side session search (debounced, abort on query change).
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const resp = await api.searchSessions(q, {
          includeArchived: true,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSearchResults(resp.results);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn("[sidebar] session search failed:", err);
        setSearchResults([]);
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    }, 220);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery]);

  // Search filtering: map server-side results back to current session rows.
  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return null;
    if (!searchResults) return [];

    const sessionsById = new Map(allSessionList.map((s) => [s.id, s]));
    const results: Array<{
      session: (typeof allSessionList)[number];
      matchContext: string | null;
      matchedField: SessionSearchResult["matchedField"];
    }> = [];
    for (const match of searchResults) {
      const session = sessionsById.get(match.sessionId);
      if (!session) continue;
      results.push({
        session,
        matchContext: match.matchContext,
        matchedField: match.matchedField,
      });
    }
    return results;
  }, [searchQuery, searchResults, allSessionList]);

  // Show sort/reorder controls when the session list is visible and has multiple sessions.
  const showSortControls = !searchFocused && !searchQuery && !filteredSessions && activeSessions.length > 1;

  const herdHoverHighlights = useMemo(() => new Map<string, "leader" | "worker">(), []);
  const herdGroupBadgeThemes = useMemo(() => {
    const leaderThemes = buildHerdGroupBadgeThemes(allSessionList);
    const sessionThemes = new Map<string, HerdGroupBadgeTheme>();

    for (const session of allSessionList) {
      const leaderId = getHerdGroupLeaderId(session);
      if (!leaderId) continue;
      const theme = leaderThemes.get(leaderId);
      if (theme) sessionThemes.set(session.id, theme);
    }

    return sessionThemes;
  }, [allSessionList]);

  // Shared props for sidebar session rows
  const sessionItemProps = {
    onSelect: handleSelectSession,
    onStartRename: handleStartRename,
    onArchive: handleArchiveSession,
    onUnarchive: handleUnarchiveSession,
    onDelete: handleDeleteSession,
    onClearRecentlyRenamed: clearRecentlyRenamed,
    onContextMenu: handleContextMenu,
    onHoverStart: handleHoverStart,
    onHoverEnd: handleHoverEnd,
    editingSessionId,
    editingName,
    setEditingName,
    onConfirmRename: confirmRename,
    onCancelRename: cancelRename,
    editInputRef,
    archiveConfirmation,
    onConfirmArchive: confirmArchive,
    onCancelArchive: cancelArchive,
    sessionAttention,
    herdHoverHighlights,
  };

  return (
    <aside className="w-full sm:w-[260px] h-full flex flex-col bg-cc-sidebar border-r border-cc-border">
      {/* Header */}
      <div className="p-4 pb-3">
        <div className="flex items-center gap-2 mb-4">
          <img src={logoSrc} alt="" className="w-7 h-7" />
          {editingServerName ? (
            <input
              ref={serverNameInputRef}
              value={serverNameDraft}
              onChange={(e) => setServerNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmServerNameEdit();
                if (e.key === "Escape") cancelServerNameEdit();
              }}
              onBlur={confirmServerNameEdit}
              className="text-sm font-semibold text-cc-fg tracking-tight bg-cc-input-bg border border-cc-border rounded px-1.5 py-0.5 outline-none focus:border-cc-primary/60 min-w-0 w-[140px]"
              placeholder="Takode"
              maxLength={30}
            />
          ) : (
            <span
              onClick={() => {
                setServerNameDraft(serverName || "");
                setEditingServerName(true);
              }}
              className="text-sm font-semibold text-cc-fg tracking-tight cursor-pointer hover:text-cc-primary transition-colors"
              title="Click to rename this server instance"
            >
              {serverName || "Takode"}
            </span>
          )}
          <button
            type="button"
            onClick={() => useStore.getState().setSidebarOpen(false)}
            className="sm:hidden ml-auto inline-flex items-center justify-center w-9 h-9 rounded-full border border-cc-border/70 bg-cc-hover/50 text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            aria-label="Dismiss sidebar"
            title="Dismiss sidebar"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="w-4 h-4">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
          {import.meta.env.DEV && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 leading-none">
              Dev
            </span>
          )}
        </div>

        <button
          onClick={handleNewSession}
          className="w-full py-2 px-3 text-sm font-medium rounded-[10px] bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors duration-150 flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
            <path d="M8 3v10M3 8h10" />
          </svg>
          New Session
        </button>
      </div>

      {/* Session list */}
      <div
        data-testid="sidebar-session-scroller"
        className={`flex-1 px-2 pb-2 overflow-x-hidden ${
          mobileReorderHandleActive ? "overflow-y-hidden overscroll-none" : "overflow-y-auto"
        }`}
        style={{
          touchAction: mobileReorderHandleActive ? "none" : "pan-y",
          overscrollBehaviorX: "none",
        }}
      >
        {/* Toolbar: search + mobile edit mode */}
        {allSessionList.length > 0 && (
          <div className="px-2 pb-1.5 flex items-center gap-1">
            <div className="relative flex-1 transition-all duration-200 ease-in-out">
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-cc-muted pointer-events-none"
              >
                <circle cx="6.5" cy="6.5" r="4.5" />
                <path d="M10 10l3.5 3.5" strokeLinecap="round" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchQuery("");
                    searchInputRef.current?.blur();
                  }
                }}
                placeholder="Search..."
                className="w-full pl-6 pr-6 py-1.5 text-[11px] bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder-cc-muted outline-none focus:border-cc-primary/60 transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-cc-muted hover:text-cc-fg cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
            {/* Edit/Done reorder toggle — mobile only, hidden in activity sort mode */}
            {showSortControls && sessionSortMode !== "activity" && (
              <button
                onClick={() => setReorderMode(!reorderMode)}
                className={`sm:hidden text-[10px] font-medium px-2.5 py-1 rounded-md transition-colors cursor-pointer shrink-0 ${
                  reorderMode ? "bg-cc-primary/10 text-cc-primary" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                {reorderMode ? "Done" : "Edit"}
              </button>
            )}
            {/* Sort mode toggle — switches between creation time and last activity */}
            {showSortControls && (
              <button
                onClick={() => setSessionSortMode(sessionSortMode === "created" ? "activity" : "created")}
                title={sessionSortMode === "activity" ? "Sorted by recent activity" : "Sorted by creation time"}
                className={`text-[10px] font-medium px-1.5 py-1 rounded-md transition-colors cursor-pointer shrink-0 ${
                  sessionSortMode === "activity"
                    ? "bg-cc-primary/10 text-cc-primary"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
                }`}
              >
                {sessionSortMode === "activity" ? (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                    <circle cx="8" cy="8" r="6" />
                    <path d="M8 5v3l2 2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                    <path d="M3 4h10M3 8h7M3 12h4" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            )}
          </div>
        )}

        {showSessionRefreshStatus && (
          <div
            className="mx-2 mb-2 px-2.5 py-2 rounded-lg border border-cc-border bg-cc-hover/50 flex items-center gap-2 text-[11px] text-cc-muted"
            aria-live="polite"
          >
            <YarnBallSpinner className="w-3.5 h-3.5 text-cc-primary shrink-0" />
            <span>Refreshing sessions...</span>
          </div>
        )}

        {filteredSessions !== null ? (
          /* Search results: flat list across all sessions */
          filteredSessions.length === 0 ? (
            <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">
              {isSearching ? "Searching..." : "No matching sessions."}
            </p>
          ) : (
            <div className="space-y-2 sm:space-y-0.5">
              {filteredSessions.map(({ session: s, matchContext, matchedField }) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  isActive={currentSessionId === s.id}
                  isArchived={s.archived}
                  sessionName={sessionNames.get(s.id)}
                  sessionPreview={sessionPreviews.get(s.id)}
                  permCount={getSidebarPermissionCount(s.id, s.permCount)}
                  isRecentlyRenamed={recentlyRenamed.has(s.id)}
                  herdGroupBadgeTheme={herdGroupBadgeThemes.get(s.id)}
                  herdHoverHighlight={herdHoverHighlights.get(s.id)}
                  matchContext={matchContext}
                  matchedField={matchedField}
                  matchQuery={searchQuery}
                  useStatusBar
                  {...sessionItemProps}
                />
              ))}
            </div>
          )
        ) : activeSessions.length === 0 && cronSessions.length === 0 && archivedSessions.length === 0 ? (
          <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">No sessions yet.</p>
        ) : (
          <>
            {/* Pending sessions — shown above project groups during creation */}
            {pendingSessions.size > 0 && (
              <div className="space-y-2 sm:space-y-0.5 mb-1">
                {Array.from(pendingSessions.values())
                  .sort((a, b) => b.createdAt - a.createdAt)
                  .map((ps) => (
                    <PendingSessionItem
                      key={ps.id}
                      pending={ps}
                      isActive={currentSessionId === ps.id}
                      onSelect={() => {
                        navigateToSession(ps.id);
                      }}
                      onCancel={() => cancelPendingCreation(ps.id)}
                    />
                  ))}
              </div>
            )}

            <DndContext
              sensors={sessionSortMode === "activity" ? [] : groupSensors}
              collisionDetection={closestCenter}
              onDragEnd={sessionSortMode === "activity" ? undefined : handleTreeGroupDragEnd}
              modifiers={[restrictToVerticalAxis]}
            >
              <SortableContext items={treeGroupIds} strategy={verticalListSortingStrategy}>
                {/* Session-level DndContext enables cross-group drag-and-drop */}
                <DndContext
                  sensors={sessionSortMode === "activity" ? [] : sessionSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={sessionSortMode === "activity" ? undefined : handleTreeSessionDragEnd}
                  modifiers={[restrictToVerticalAxis]}
                >
                  <SortableContext items={allTreeSessionIds} strategy={verticalListSortingStrategy}>
                    {treeViewGroups.map((group, i) => (
                      <SortableTreeGroup key={group.id} id={group.id}>
                        {({ setNodeRef, style, listeners, attributes, isDragging }) => (
                          <div ref={setNodeRef} style={style}>
                            <TreeViewGroup
                              group={group}
                              isGroupCollapsed={collapsedTreeGroups.has(group.id)}
                              collapsedTreeNodes={collapsedTreeNodes}
                              onToggleGroupCollapse={toggleTreeGroupCollapse}
                              onToggleNodeCollapse={toggleTreeNodeCollapse}
                              onCreateSession={handleCreateSessionInTreeGroup}
                              currentSessionId={currentSessionId}
                              sessionNames={sessionNames}
                              sessionPreviews={sessionPreviews}
                              pendingPermissions={pendingPermissions}
                              recentlyRenamed={recentlyRenamed}
                              isFirst={i === 0}
                              groupDragging={isDragging}
                              onMobileReorderHandleActiveChange={setMobileReorderHandleActive}
                              groupDragHandleProps={
                                treeViewGroups.length > 1 && sessionSortMode !== "activity"
                                  ? {
                                      listeners: listeners as Record<string, unknown> | undefined,
                                      attributes: attributes as unknown as Record<string, unknown>,
                                    }
                                  : undefined
                              }
                              herdGroupBadgeThemes={herdGroupBadgeThemes}
                              {...sessionItemProps}
                            />
                          </div>
                        )}
                      </SortableTreeGroup>
                    ))}
                  </SortableContext>
                </DndContext>
              </SortableContext>
            </DndContext>
            <button
              onClick={handleCreateTreeGroup}
              className="w-full mt-1 px-2 py-1.5 flex items-center gap-1.5 rounded-md text-[10px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3 h-3">
                <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
              </svg>
              <span className="font-medium">New Group</span>
            </button>

            {cronSessions.length > 0 && (
              <div className="mt-2 pt-2 border-t border-cc-border">
                <button
                  onClick={() => setShowCronSessions(!showCronSessions)}
                  className="w-full px-3 py-1.5 text-[11px] font-medium text-violet-400 uppercase tracking-wider flex items-center gap-1.5 hover:text-violet-300 transition-colors cursor-pointer"
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className={`w-3 h-3 transition-transform ${showCronSessions ? "rotate-90" : ""}`}
                  >
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60">
                    <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.293.707l2 2a1 1 0 001.414-1.414L9 7.586V5z" />
                  </svg>
                  Scheduled Runs ({cronSessions.length})
                </button>
                {showCronSessions && (
                  <div className="space-y-2 sm:space-y-0.5 mt-1">
                    {cronSessions.map((s) => (
                      <SessionItem
                        key={s.id}
                        session={s}
                        isActive={currentSessionId === s.id}
                        sessionName={sessionNames.get(s.id)}
                        permCount={getSidebarPermissionCount(s.id, s.permCount)}
                        isRecentlyRenamed={recentlyRenamed.has(s.id)}
                        herdGroupBadgeTheme={herdGroupBadgeThemes.get(s.id)}
                        herdHoverHighlight={herdHoverHighlights.get(s.id)}
                        reviewerSession={s.sessionNum != null ? activeReviewerByParent.get(s.sessionNum) : undefined}
                        useStatusBar
                        {...sessionItemProps}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {archivedSessions.length > 0 && (
              <div className="mt-2 pt-2 border-t border-cc-border">
                <button
                  onClick={() => setShowArchived(!showArchived)}
                  className="w-full px-3 py-1.5 text-[11px] font-medium text-cc-muted uppercase tracking-wider flex items-center gap-1.5 hover:text-cc-fg transition-colors cursor-pointer"
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className={`w-3 h-3 transition-transform ${showArchived ? "rotate-90" : ""}`}
                  >
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  Archived ({archivedSessions.length})
                </button>
                {showArchived && (
                  <div className="space-y-2 sm:space-y-0.5 mt-1">
                    {archivedSessions.map((s) => (
                      <div key={s.id}>
                        <SessionItem
                          session={s}
                          isActive={currentSessionId === s.id}
                          isArchived
                          sessionName={sessionNames.get(s.id)}
                          sessionPreview={sessionPreviews.get(s.id)}
                          permCount={getSidebarPermissionCount(s.id, s.permCount)}
                          isRecentlyRenamed={recentlyRenamed.has(s.id)}
                          herdGroupBadgeTheme={herdGroupBadgeThemes.get(s.id)}
                          herdHoverHighlight={herdHoverHighlights.get(s.id)}
                          reviewerSession={s.sessionNum != null ? activeReviewerByParent.get(s.sessionNum) : undefined}
                          useStatusBar
                          {...sessionItemProps}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-cc-border space-y-1.5">
        <SidebarUsageBar />
        <div className="flex items-center justify-around">
          <button
            title="Terminal"
            onClick={() => {
              if (isTerminalPage) {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              } else {
                window.location.hash = "#/terminal";
              }
              if (!isDesktopLayout) {
                useStore.getState().setSidebarOpen(false);
              }
            }}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${
              isTerminalPage ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="w-4 h-4">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
              <path d="M4.5 7l2.5 2-2.5 2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M9 11h3" strokeLinecap="round" />
            </svg>
          </button>
          <button
            title="Timers"
            onClick={() => {
              if (isScheduledPage) {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              } else {
                window.location.hash = "#/scheduled";
              }
              if (!isDesktopLayout) {
                useStore.getState().setSidebarOpen(false);
              }
            }}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${
              isScheduledPage ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.293.707l2 2a1 1 0 001.414-1.414L9 7.586V5z" />
            </svg>
          </button>
          <button
            title="Quests"
            onClick={() => {
              if (isQuestmasterPage) {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              } else {
                window.location.hash = "#/questmaster";
              }
              if (!isDesktopLayout) {
                useStore.getState().setSidebarOpen(false);
              }
            }}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${
              isQuestmasterPage ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5.75a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 014 5.75zM4.75 8a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5zM4 11.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
            </svg>
          </button>
          <button
            title="Settings"
            onClick={() => {
              if (isSettingsPage) {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              } else {
                window.location.hash = "#/settings";
              }
              if (!isDesktopLayout) {
                useStore.getState().setSidebarOpen(false);
              }
            }}
            className={`p-2 rounded-lg transition-colors cursor-pointer ${
              isSettingsPage ? "bg-cc-active text-cc-fg" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path
                fillRule="evenodd"
                d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.35-.8-2.92.77-2.12 2.12.54.9.07 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.02.25 1.49 1.39.95 2.29-.8 1.35.77 2.92 2.12 2.12.9-.54 2.04-.07 2.29.95.38 1.56 2.6 1.56 2.98 0 .25-1.02 1.39-1.49 2.29-.95 1.35.8 2.92-.77 2.12-2.12-.54-.9-.07-2.04.95-2.29 1.56-.38 1.56-2.6 0-2.98-1.02-.25-1.49-1.39-.95-2.29.8-1.35-.77-2.92-2.12-2.12-.9.54-2.04.07-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
        <div className="text-[10px] text-cc-muted text-center select-none" title={__BUILD_TIME__}>
          {`Built ${new Date(__BUILD_TIME__).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
            timeZone: "America/Los_Angeles",
          })} PT`}
        </div>
      </div>
      {/* Context menu */}
      {contextMenu &&
        (() => {
          const sdk = sdkSessions.find((s) => s.sessionId === contextMenu.sessionId);
          const sessionInfo = allSessionList.find((s) => s.id === contextMenu.sessionId);
          const cliId = sdk?.cliSessionId || "";
          const isArchived = sdk?.archived ?? sessionInfo?.archived ?? false;
          const isExited = sdk?.state === "exited";
          const attention = sessionAttention.get(contextMenu.sessionId);
          const backendType = sessionInfo?.backendType || sdk?.backendType || "claude";
          const currentLeader = currentSessionId
            ? sdkSessions.find((s) => s.sessionId === currentSessionId)
            : undefined;
          const canHerdToCurrentSession =
            !isArchived &&
            !isExited &&
            !!currentSessionId &&
            currentSessionId !== contextMenu.sessionId &&
            currentLeader?.isOrchestrator === true &&
            sdk?.isOrchestrator !== true;
          const needsForceHerd = canHerdToCurrentSession && !!sdk?.herdedBy && sdk.herdedBy !== currentSessionId;

          // Count non-archived herded workers for "Archive Group" option
          const herdedWorkers =
            !isArchived && sdk?.isOrchestrator
              ? sdkSessions.filter((s) => s.herdedBy === contextMenu.sessionId && !s.archived)
              : [];

          const sessionNum = sdk?.sessionNum;
          const items: ContextMenuItem[] = [
            ...(sessionNum != null
              ? [
                  {
                    label: "Copy Session Number",
                    onClick: () => {
                      writeClipboardText(String(sessionNum)).catch(console.error);
                    },
                  },
                ]
              : [
                  {
                    label: "Copy Session ID",
                    onClick: () => {
                      writeClipboardText(contextMenu.sessionId).catch(console.error);
                    },
                  },
                ]),
            ...(cliId
              ? [
                  {
                    label: "Copy CLI Session ID",
                    onClick: () => {
                      writeClipboardText(cliId).catch(console.error);
                    },
                  },
                ]
              : []),
            {
              label: "Rename",
              onClick: () => {
                const name = sessionNames.get(contextMenu.sessionId) || "";
                handleStartRename(contextMenu.sessionId, name);
              },
            },
            ...(!isExited && !isArchived
              ? [
                  {
                    label: "Relaunch",
                    onClick: () => {
                      api.relaunchSession(contextMenu.sessionId).catch(console.error);
                    },
                  },
                ]
              : []),
            // Transport switch: only for Claude-family sessions that are alive
            ...(backendType === "claude" && !isExited && !isArchived
              ? [
                  {
                    label: "Switch to SDK",
                    onClick: () => {
                      api.upgradeTransport(contextMenu.sessionId).catch(console.error);
                    },
                  },
                ]
              : []),
            ...(backendType === "claude-sdk" && !isExited && !isArchived
              ? [
                  {
                    label: "Switch to WebSocket",
                    onClick: () => {
                      api.downgradeTransport(contextMenu.sessionId).catch(console.error);
                    },
                  },
                ]
              : []),
            attention
              ? {
                  label: "Mark as read",
                  onClick: () => {
                    useStore.getState().markSessionViewed(contextMenu.sessionId);
                    api.markSessionRead?.(contextMenu.sessionId).catch(() => {});
                  },
                }
              : {
                  label: "Mark as unread",
                  onClick: () => {
                    useStore.getState().markSessionUnread(contextMenu.sessionId);
                  },
                },
            // Tree groups are now the only session-browsing mode in the sidebar.
            ...buildMoveToSubmenu(treeGroups, treeAssignments, contextMenu.sessionId),
            ...(canHerdToCurrentSession
              ? [
                  {
                    label: needsForceHerd ? "Force Herd to Current Session" : "Herd to Current Session",
                    onClick: () => {
                      void doHerdToCurrentSession(contextMenu.sessionId, needsForceHerd);
                    },
                    ...(needsForceHerd
                      ? {
                          confirm: {
                            title: "Force herd takeover?",
                            description:
                              "This will move the session out of its current leader's herd into your current leader session.",
                            confirmLabel: "Force Herd",
                          },
                        }
                      : {}),
                  },
                ]
              : []),
            isArchived
              ? {
                  label: "Unarchive",
                  onClick: () => {
                    const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
                    void handleUnarchiveSession(syntheticEvent, contextMenu.sessionId);
                  },
                }
              : {
                  label: "Archive",
                  onClick: () => {
                    const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
                    handleArchiveSession(syntheticEvent, contextMenu.sessionId);
                  },
                },
            // "Archive Group" — archives leader + all herded workers in one action
            ...(herdedWorkers.length > 0
              ? [
                  {
                    label: "Archive Group",
                    onClick: () => {
                      doArchiveGroup(contextMenu.sessionId);
                    },
                    confirm: {
                      title: "Archive entire group?",
                      description: `This will archive the leader and ${herdedWorkers.length} worker session${herdedWorkers.length === 1 ? "" : "s"}.`,
                      confirmLabel: "Archive All",
                      destructive: true,
                    },
                  },
                ]
              : []),
            {
              label: "Delete Session",
              onClick: () => {
                const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
                void handleDeleteSession(syntheticEvent, contextMenu.sessionId);
              },
              confirm: {
                title: "Delete session permanently?",
                description: "This cannot be undone. The session will be removed from history.",
                confirmLabel: "Delete",
                destructive: true,
              },
            },
          ];

          return <ContextMenu x={contextMenu.x} y={contextMenu.y} items={items} onClose={() => setContextMenu(null)} />;
        })()}
      {/* Session hover card */}
      {hoveredSession &&
        (() => {
          const s = allSessionList.find((item) => item.id === hoveredSession.sessionId);
          if (!s) return null;
          return (
            <SessionHoverCard
              session={s}
              sessionName={sessionNames.get(hoveredSession.sessionId)}
              sessionPreview={sessionPreviews.get(hoveredSession.sessionId)}
              taskHistory={sessionTaskHistory.get(hoveredSession.sessionId)}
              sessionState={sessions.get(hoveredSession.sessionId)}
              cliSessionId={sdkSessions.find((sdk) => sdk.sessionId === hoveredSession.sessionId)?.cliSessionId}
              anchorRect={hoveredSession.rect}
              onMouseEnter={handleHoverCardEnter}
              onMouseLeave={handleHoverCardLeave}
            />
          );
        })()}
    </aside>
  );
}

// ─── Pending Session Chip ────────────────────────────────────────────────────

function PendingSessionItem({
  pending,
  isActive,
  onSelect,
  onCancel,
}: {
  pending: PendingSession;
  isActive: boolean;
  onSelect: () => void;
  onCancel: () => void;
}) {
  const folderName = pending.cwd?.split("/").pop() || "New session";
  const logoSrc = pending.backend === "codex" ? "/logo-codex.svg" : "/logo.png";
  const hasError = pending.status === "error";
  const isCreating = pending.status === "creating";

  // Accent color based on backend (matching SessionItem pattern)
  const accentColor = pending.backend === "codex" ? "border-blue-500" : "border-[#c47a4e]";

  return (
    <div
      onClick={onSelect}
      className={`group relative flex items-center gap-2.5 px-3 py-2 mx-1 rounded-lg cursor-pointer transition-colors border-l-2 ${accentColor} ${
        isActive ? "bg-cc-active" : "hover:bg-cc-hover"
      }`}
    >
      {/* Status indicator */}
      <div className="w-4 h-4 shrink-0 flex items-center justify-center">
        {isCreating && <YarnBallSpinner className="w-3.5 h-3.5 text-cc-primary" />}
        {hasError && (
          <div className="w-3 h-3 rounded-full bg-cc-error/20 flex items-center justify-center">
            <div className="w-1.5 h-1.5 rounded-full bg-cc-error" />
          </div>
        )}
        {pending.status === "succeeded" && (
          <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-cc-success">
            <path
              d="M13.25 4.75L6 12 2.75 8.75"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>

      {/* Name and subtitle */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <img src={logoSrc} alt="" className="w-3 h-3 opacity-60" />
          <span className="text-xs font-medium text-cc-fg truncate">{folderName}</span>
        </div>
        <span className={`text-[10px] leading-tight truncate block ${hasError ? "text-cc-error" : "text-cc-muted"}`}>
          {hasError ? "Creation failed" : isCreating ? "Creating session..." : "Ready"}
        </span>
      </div>

      {/* Cancel/delete button (visible on hover) */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
        className="opacity-0 group-hover:opacity-100 p-0.5 text-cc-muted hover:text-cc-error transition-all cursor-pointer"
        title={hasError ? "Dismiss" : "Cancel creation"}
      >
        <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
