import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { writeClipboardText } from "../utils/copy-utils.js";
import { connectSession, connectAllSessions, disconnectSession } from "../ws.js";
import { navigateToSession, navigateToMostRecentSession, parseHash } from "../utils/routing.js";
import { bootstrapServerId, scopedGetItem } from "../utils/scoped-storage.js";
import { ProjectGroup } from "./ProjectGroup.js";
import { SessionItem } from "./SessionItem.js";
import { ContextMenu } from "./ContextMenu.js";
import { SessionHoverCard } from "./SessionHoverCard.js";

import { groupSessionsByProject, type SessionItem as SessionItemType } from "../utils/project-grouping.js";

export function Sidebar() {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
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
  const collapsedProjects = useStore((s) => s.collapsedProjects);
  const toggleProjectCollapse = useStore((s) => s.toggleProjectCollapse);
  const sessionAttention = useStore((s) => s.sessionAttention);
  const askPermissionMap = useStore((s) => s.askPermission);
  const sessionKeywords = useStore((s) => s.sessionKeywords);
  const sessionOrder = useStore((s) => s.sessionOrder);
  const reorderMode = useStore((s) => s.reorderMode);
  const setReorderMode = useStore((s) => s.setReorderMode);
  const serverName = useStore((s) => s.serverName);
  const setServerName = useStore((s) => s.setServerName);
  const [searchQuery, setSearchQuery] = useState("");
  const route = parseHash(hash);
  const isSettingsPage = route.page === "settings";
  const isTerminalPage = route.page === "terminal";
  const isEnvironmentsPage = route.page === "environments";
  const isScheduledPage = route.page === "scheduled";

  // Poll for SDK sessions on mount
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const list = await api.listSessions();
        if (active) {
          useStore.getState().setSdkSessions(list);
          // Connect all active sessions so we receive notifications for all of them
          connectAllSessions(list);
          // Hydrate session names from server (server is source of truth for auto-generated names)
          const store = useStore.getState();
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
            // Hydrate last message preview from server (only if client doesn't have one yet)
            if (s.lastMessagePreview && !store.sessionPreviews.has(s.sessionId)) {
              store.setSessionPreview(s.sessionId, s.lastMessagePreview);
            }
            // Hydrate task history and keywords from server for search
            if (s.taskHistory?.length) {
              store.setSessionTaskHistory(s.sessionId, s.taskHistory);
            }
            if (s.keywords?.length) {
              store.setSessionKeywords(s.sessionId, s.keywords);
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
        }
      } catch (e) {
        console.warn("[sidebar] session poll failed:", e);
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  // Fetch server settings (name + ID) on mount
  useEffect(() => {
    api.getSettings().then((s) => {
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
            } catch { /* ignore parse errors */ }
          }
        }
      }
    }).catch(() => {});
  }, []);

  // Update document.title when serverName, attention, or permission counts change
  useEffect(() => {
    // Only count attention for sessions that actually exist and are not archived
    const activeSessionIds = new Set(sdkSessions.filter(s => !s.archived).map(s => s.sessionId));
    const attentionIds = new Set<string>();
    for (const [id, a] of sessionAttention) {
      if (a !== null && activeSessionIds.has(id)) attentionIds.add(id);
    }
    for (const [id, perms] of pendingPermissions) {
      if (perms.size > 0 && activeSessionIds.has(id)) attentionIds.add(id);
    }
    const totalAttention = attentionIds.size;
    const suffix = import.meta.env.DEV ? "[DEV] Takode" : "Takode";
    const base = serverName ? `${serverName} — ${suffix}` : suffix;
    document.title = totalAttention > 0 ? `(${totalAttention}) ${base}` : base;
  }, [serverName, sessionAttention, pendingPermissions, sdkSessions]);

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

  function handleSelectSession(sessionId: string) {
    setContextMenu(null);
    useStore.getState().closeTerminal();
    useStore.getState().markSessionViewed(sessionId);
    // Navigate to session hash — App.tsx hash effect handles setCurrentSession + connectSession
    navigateToSession(sessionId);
    // Close sidebar on mobile
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
  }

  function handleNewSession() {
    useStore.getState().closeTerminal();
    useStore.getState().setShowNewSessionModal(true);
    if (window.innerWidth < 768) {
      useStore.getState().setSidebarOpen(false);
    }
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

  const handleDeleteSession = useCallback(async (e: React.MouseEvent, sessionId: string) => {
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
  }, [removeSession]);

  const handleArchiveSession = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    // Check if session uses a container or worktree — if so, ask for confirmation
    const sdkInfo = sdkSessions.find((s) => s.sessionId === sessionId);
    const bridgeState = sessions.get(sessionId);
    const isContainerized = bridgeState?.is_containerized || !!sdkInfo?.containerId || false;
    const isWorktree = bridgeState?.is_worktree || sdkInfo?.isWorktree || false;
    if (isContainerized || isWorktree) {
      setConfirmArchiveId(sessionId);
      return;
    }
    doArchive(sessionId);
  }, [sdkSessions, sessions]);

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
    if (confirmArchiveId) {
      doArchive(confirmArchiveId, true);
      setConfirmArchiveId(null);
    }
  }, [confirmArchiveId, doArchive]);

  const cancelArchive = useCallback(() => {
    setConfirmArchiveId(null);
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

  const allSessionList: SessionItemType[] = Array.from(allSessionIds).map((id) => {
    const bridgeState = sessions.get(id);
    const sdkInfo = sdkSessions.find((s) => s.sessionId === id);
    return {
      id,
      model: bridgeState?.model || sdkInfo?.model || "",
      cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
      gitBranch: bridgeState?.git_branch || sdkInfo?.gitBranch || "",
      isContainerized: bridgeState?.is_containerized || !!sdkInfo?.containerId || false,
      gitAhead: bridgeState?.git_ahead || sdkInfo?.gitAhead || 0,
      gitBehind: bridgeState?.git_behind || sdkInfo?.gitBehind || 0,
      linesAdded: bridgeState?.total_lines_added || sdkInfo?.totalLinesAdded || 0,
      linesRemoved: bridgeState?.total_lines_removed || sdkInfo?.totalLinesRemoved || 0,
      isConnected: cliConnected.get(id) ?? sdkInfo?.cliConnected ?? false,
      status: sessionStatus.get(id) ?? null,
      sdkState: sdkInfo?.state ?? null,
      createdAt: sdkInfo?.createdAt ?? 0,
      archived: sdkInfo?.archived ?? false,
      backendType: bridgeState?.backend_type || sdkInfo?.backendType || "claude",
      repoRoot: bridgeState?.repo_root || sdkInfo?.repoRoot || "",
      permCount: pendingPermissions.get(id)?.size ?? 0,
      cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
      cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
      isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
      worktreeExists: sdkInfo?.worktreeExists,
      worktreeDirty: sdkInfo?.worktreeDirty,
      askPermission: askPermissionMap?.get(id),
      idleKilled: cliDisconnectReason.get(id) === "idle_limit",
    };
  }).sort((a, b) => b.createdAt - a.createdAt);

  const activeSessions = allSessionList.filter((s) => !s.archived && !s.cronJobId);
  const cronSessions = allSessionList.filter((s) => !s.archived && !!s.cronJobId);
  const archivedSessions = allSessionList.filter((s) => s.archived);
  const currentSession = currentSessionId ? allSessionList.find((s) => s.id === currentSessionId) : null;
  const logoSrc = currentSession?.backendType === "codex" ? "/logo-codex.svg" : "/logo.svg";
  const [showCronSessions, setShowCronSessions] = useState(true);

  // Group active sessions by project
  const projectGroups = useMemo(
    () => groupSessionsByProject(activeSessions, sessionAttention, sessionOrder),
    [activeSessions, sessionAttention, sessionOrder],
  );

  // Search filtering: when query is non-empty, filter all sessions (active + cron + archived)
  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;

    return allSessionList.filter((s) => {
      const name = (sessionNames.get(s.id) || "").toLowerCase();
      if (name.includes(q)) return true;

      if (s.cwd.toLowerCase().includes(q)) return true;
      if (s.repoRoot.toLowerCase().includes(q)) return true;

      const preview = (sessionPreviews.get(s.id) || "").toLowerCase();
      if (preview.includes(q)) return true;

      const tasks = sessionTaskHistory.get(s.id);
      if (tasks?.some((t) => t.title.toLowerCase().includes(q))) return true;

      const kws = sessionKeywords.get(s.id);
      if (kws?.some((kw) => kw.includes(q))) return true;

      if (s.gitBranch.toLowerCase().includes(q)) return true;

      return false;
    });
  }, [searchQuery, allSessionList, sessionNames, sessionPreviews, sessionTaskHistory, sessionKeywords]);

  // Shared props for SessionItem / ProjectGroup
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
    confirmArchiveId,
    onConfirmArchive: confirmArchive,
    onCancelArchive: cancelArchive,
    sessionAttention,
  };

  return (
    <aside className="w-[260px] h-full flex flex-col bg-cc-sidebar border-r border-cc-border">
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
          {import.meta.env.DEV && (
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 leading-none">Dev</span>
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

        {/* Search input */}
        {allSessionList.length > 0 && (
          <div className="relative mt-2">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-cc-muted pointer-events-none">
              <circle cx="6.5" cy="6.5" r="4.5" />
              <path d="M10 10l3.5 3.5" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search sessions..."
              className="w-full pl-8 pr-7 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder-cc-muted outline-none focus:border-cc-primary/60 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-cc-muted hover:text-cc-fg cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {/* Reorder mode toggle */}
        {!filteredSessions && activeSessions.length > 1 && (
          <div className="px-2 pb-1.5 flex items-center justify-end">
            <button
              onClick={() => setReorderMode(!reorderMode)}
              className={`text-[10px] font-medium px-2 py-1 rounded-md transition-colors cursor-pointer ${
                reorderMode
                  ? "bg-cc-primary/10 text-cc-primary"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
            >
              {reorderMode ? "Done" : "Reorder"}
            </button>
          </div>
        )}

        {filteredSessions !== null ? (
          /* Search results: flat list across all sessions */
          filteredSessions.length === 0 ? (
            <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">
              No matching sessions.
            </p>
          ) : (
            <div className="space-y-0.5">
              {filteredSessions.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  isActive={currentSessionId === s.id}
                  isArchived={s.archived}
                  sessionName={sessionNames.get(s.id)}
                  sessionPreview={sessionPreviews.get(s.id)}
                  permCount={pendingPermissions.get(s.id)?.size ?? 0}
                  isRecentlyRenamed={recentlyRenamed.has(s.id)}
                  {...sessionItemProps}
                />
              ))}
            </div>
          )
        ) : activeSessions.length === 0 && cronSessions.length === 0 && archivedSessions.length === 0 ? (
          <p className="px-3 py-8 text-xs text-cc-muted text-center leading-relaxed">
            No sessions yet.
          </p>
        ) : (
          <>
            {projectGroups.map((group, i) => (
              <ProjectGroup
                key={group.key}
                group={group}
                isCollapsed={collapsedProjects.has(group.key)}
                onToggleCollapse={toggleProjectCollapse}
                currentSessionId={currentSessionId}
                sessionNames={sessionNames}
                sessionPreviews={sessionPreviews}
                pendingPermissions={pendingPermissions}
                recentlyRenamed={recentlyRenamed}
                isFirst={i === 0}
                {...sessionItemProps}
              />
            ))}

            {cronSessions.length > 0 && (
              <div className="mt-2 pt-2 border-t border-cc-border">
                <button
                  onClick={() => setShowCronSessions(!showCronSessions)}
                  className="w-full px-3 py-1.5 text-[11px] font-medium text-violet-400 uppercase tracking-wider flex items-center gap-1.5 hover:text-violet-300 transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 transition-transform ${showCronSessions ? "rotate-90" : ""}`}>
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60">
                    <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.293.707l2 2a1 1 0 001.414-1.414L9 7.586V5z" />
                  </svg>
                  Scheduled Runs ({cronSessions.length})
                </button>
                {showCronSessions && (
                  <div className="space-y-0.5 mt-1">
                    {cronSessions.map((s) => (
                      <SessionItem
                        key={s.id}
                        session={s}
                        isActive={currentSessionId === s.id}
                        sessionName={sessionNames.get(s.id)}
                        permCount={pendingPermissions.get(s.id)?.size ?? 0}
                        isRecentlyRenamed={recentlyRenamed.has(s.id)}
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
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 transition-transform ${showArchived ? "rotate-90" : ""}`}>
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                  Archived ({archivedSessions.length})
                </button>
                {showArchived && (
                  <div className="space-y-0.5 mt-1">
                    {archivedSessions.map((s) => (
                      <SessionItem
                        key={s.id}
                        session={s}
                        isActive={currentSessionId === s.id}
                        isArchived
                        sessionName={sessionNames.get(s.id)}
                        sessionPreview={sessionPreviews.get(s.id)}
                        permCount={pendingPermissions.get(s.id)?.size ?? 0}
                        isRecentlyRenamed={recentlyRenamed.has(s.id)}
                        {...sessionItemProps}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-cc-border space-y-0.5">
        <button
          onClick={() => {
            window.location.hash = "#/terminal";
            if (window.innerWidth < 768) {
              useStore.getState().setSidebarOpen(false);
            }
          }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm transition-colors cursor-pointer ${
            isTerminalPage
              ? "bg-cc-active text-cc-fg"
              : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3zm2 1.5l3 2.5-3 2.5V4.5zM8.5 10h3v1h-3v-1z" />
          </svg>
          <span>Terminal</span>
        </button>
        <button
          onClick={() => {
            useStore.getState().closeTerminal();
            window.location.hash = "#/environments";
            if (window.innerWidth < 768) {
              useStore.getState().setSidebarOpen(false);
            }
          }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm transition-colors cursor-pointer ${
            isEnvironmentsPage
              ? "bg-cc-active text-cc-fg"
              : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
          </svg>
          <span>Environments</span>
        </button>
        <button
          onClick={() => {
            useStore.getState().closeTerminal();
            window.location.hash = "#/scheduled";
            if (window.innerWidth < 768) {
              useStore.getState().setSidebarOpen(false);
            }
          }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm transition-colors cursor-pointer ${
            isScheduledPage
              ? "bg-cc-active text-cc-fg"
              : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M8 2a6 6 0 100 12A6 6 0 008 2zM0 8a8 8 0 1116 0A8 8 0 010 8zm9-3a1 1 0 10-2 0v3a1 1 0 00.293.707l2 2a1 1 0 001.414-1.414L9 7.586V5z" />
          </svg>
          <span>Scheduled</span>
        </button>
        <button
          onClick={() => {
            useStore.getState().closeTerminal();
            window.location.hash = "#/settings";
            if (window.innerWidth < 768) {
              useStore.getState().setSidebarOpen(false);
            }
          }}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[10px] text-sm transition-colors cursor-pointer ${
            isSettingsPage
              ? "bg-cc-active text-cc-fg"
              : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.35-.8-2.92.77-2.12 2.12.54.9.07 2.04-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.02.25 1.49 1.39.95 2.29-.8 1.35.77 2.92 2.12 2.12.9-.54 2.04-.07 2.29.95.38 1.56 2.6 1.56 2.98 0 .25-1.02 1.39-1.49 2.29-.95 1.35.8 2.92-.77 2.12-2.12-.54-.9-.07-2.04.95-2.29 1.56-.38 1.56-2.6 0-2.98-1.02-.25-1.49-1.39-.95-2.29.8-1.35-.77-2.92-2.12-2.12-.9.54-2.04.07-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
          <span>Settings</span>
        </button>
        <div className="text-[10px] text-cc-muted text-center pt-1 select-none" title={__BUILD_TIME__}>
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
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            {
              label: "Rename",
              onClick: () => {
                const name = sessionNames.get(contextMenu.sessionId) || "";
                handleStartRename(contextMenu.sessionId, name);
              },
            },
            ...(() => {
              const cliId = sdkSessions.find((s) => s.sessionId === contextMenu.sessionId)?.cliSessionId;
              if (!cliId) return [];
              return [{
                label: "Copy CLI Session ID",
                onClick: () => {
                  writeClipboardText(cliId).catch(console.error);
                },
              }];
            })(),
            ...(() => {
              const sdk = sdkSessions.find((s) => s.sessionId === contextMenu.sessionId);
              if (!sdk || sdk.state === "exited") return [];
              return [{
                label: "Relaunch",
                onClick: () => {
                  api.relaunchSession(contextMenu.sessionId).catch(console.error);
                },
              }];
            })(),
            ...(() => {
              const attention = sessionAttention.get(contextMenu.sessionId);
              if (attention) {
                return [{
                  label: "Mark as read",
                  onClick: () => {
                    useStore.getState().markSessionViewed(contextMenu.sessionId);
                  },
                }];
              }
              return [{
                label: "Mark as unread",
                onClick: () => {
                  useStore.getState().markSessionUnread(contextMenu.sessionId);
                },
              }];
            })(),
            {
              label: "Archive",
              onClick: () => {
                const syntheticEvent = { stopPropagation: () => {} } as React.MouseEvent;
                handleArchiveSession(syntheticEvent, contextMenu.sessionId);
              },
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}
      {/* Session hover card */}
      {hoveredSession && (() => {
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
