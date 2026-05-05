import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore, getSessionSearchState } from "./store.js";
import { connectSession, disconnectSession, sendVsCodeSelectionUpdate } from "./ws.js";
import { api, checkHealth } from "./api.js";
import type { SdkSessionInfo } from "./types.js";

import {
  parseHash,
  navigateToSession,
  navigateToMostRecentSession,
  messageIndexFromHash,
  threadRouteFromHash,
  resolveSessionIdFromRoute,
  scrollToMessageIndex,
} from "./utils/routing.js";
import { navigateTo } from "./utils/navigation.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { TopBar } from "./components/TopBar.js";
import { EmptyState } from "./components/EmptyState.js";
import { setSdkSessionsWithNotificationFreshness } from "./notification-status.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { DiffPanel } from "./components/DiffPanel.js";
import { Playground } from "./components/Playground.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { LogsPage } from "./components/LogsPage.js";
import { EnvManager } from "./components/EnvManager.js";
import { ActiveTimersPage } from "./components/ActiveTimersPage.js";
import { StreamsPage } from "./components/StreamsPage.js";
import { TerminalPage } from "./components/TerminalPage.js";
import { SessionCreationView } from "./components/SessionCreationView.js";
import { NewSessionModal } from "./components/NewSessionModal.js";
import { QuestmasterPage } from "./components/QuestmasterPage.js";
import { QuestDetailPanel } from "./components/QuestDetailPanel.js";
import { SearchEverythingOverlay } from "./components/SearchEverythingOverlay.js";
import { isPendingId } from "./utils/pending-creation.js";
import { isDesktopShellLayout, isDesktopTaskPanelLayout } from "./utils/layout.js";
import { getLastSessionCreationContext } from "./utils/new-session-defaults.js";
import { buildSidebarVisibleSessions } from "./utils/sidebar-visible-sessions.js";
import { requestThreadViewportSnapshot } from "./utils/thread-viewport.js";
import { requestAutoSessionGitStatusRefresh } from "./utils/session-git-status-auto-refresh.js";
import {
  announceVsCodeReady,
  type VsCodeSelectionContextPayload,
  maybeReadVsCodeSelectionContext,
} from "./utils/vscode-context.js";
import { ensureVsCodeEditorPreference } from "./utils/vscode-bridge.js";
import {
  getMatchingShortcutAction,
  isAppGlobalShortcutAction,
  isShortcutEventTargetEditable,
  performShortcutAction,
  shouldBlurVimEscape,
} from "./shortcuts.js";

type TakodeDebugWindow = Window &
  typeof globalThis & {
    __TAKODE_VSCODE_CONTEXT__?: VsCodeSelectionContextPayload | null;
    __TAKODE_SET_VSCODE_CONTEXT__?: (payload: VsCodeSelectionContextPayload | null) => void;
    __TAKODE_CLEAR_VSCODE_CONTEXT__?: () => void;
  };

function stripSessionSearchMetadata(session: SdkSessionInfo): SdkSessionInfo {
  const { taskHistory: _taskHistory, keywords: _keywords, ...rest } = session;
  return rest;
}

function useHash() {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
}

function buildSidebarOrderedShortcutSessions(state: ReturnType<typeof useStore.getState>) {
  const { orderedVisibleSessionIds } = buildSidebarVisibleSessions({
    sessions: state.sessions,
    sdkSessions: state.sdkSessions,
    cliConnected: state.cliConnected,
    cliDisconnectReason: state.cliDisconnectReason,
    sessionStatus: state.sessionStatus,
    pendingPermissions: state.pendingPermissions,
    askPermission: state.askPermission,
    diffFileStats: state.diffFileStats,
    treeGroups: state.treeGroups,
    treeAssignments: state.treeAssignments,
    treeNodeOrder: state.treeNodeOrder,
    collapsedTreeGroups: state.collapsedTreeGroups,
    expandedHerdNodes: state.expandedHerdNodes,
    sessionAttention: state.sessionAttention,
    sessionSortMode: state.sessionSortMode,
    countUserPermissions: () => 0,
  });
  const sdkById = new Map(state.sdkSessions.map((session) => [session.sessionId, session] as const));
  return orderedVisibleSessionIds
    .map((sessionId, index) => {
      const session = sdkById.get(sessionId);
      if (!session) return null;
      return {
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        archived: session.archived,
        cronJobId: session.cronJobId ?? null,
        orderIndex: index,
      };
    })
    .filter((session): session is NonNullable<typeof session> => session !== null);
}

export default function App() {
  const [searchEverythingOpen, setSearchEverythingOpen] = useState(false);
  const {
    colorTheme,
    darkMode,
    zoomLevel,
    currentSessionId,
    searchPreviewSessionId,
    currentSessionConnectionStatus,
    shortcutSettings,
    sidebarOpen,
    taskPanelOpen,
    activeTab,
    newSessionModalState,
    serverRestarting,
    serverReachable,
    sdkSessions,
  } = useStore(
    useShallow((s) => ({
      colorTheme: s.colorTheme,
      darkMode: s.darkMode,
      zoomLevel: s.zoomLevel,
      currentSessionId: s.currentSessionId,
      searchPreviewSessionId: s.searchPreviewSessionId,
      currentSessionConnectionStatus: s.currentSessionId ? (s.connectionStatus.get(s.currentSessionId) ?? null) : null,
      shortcutSettings: s.shortcutSettings,
      sidebarOpen: s.sidebarOpen,
      taskPanelOpen: s.taskPanelOpen,
      activeTab: s.activeTab,
      newSessionModalState: s.newSessionModalState,
      serverRestarting: s.serverRestarting,
      serverReachable: s.serverReachable,
      sdkSessions: s.sdkSessions,
    })),
  );
  const hash = useHash();
  const route = useMemo(() => parseHash(hash), [hash]);
  const threadRoute = useMemo(
    () => (route.page === "session" ? threadRouteFromHash(hash) : { hasThreadParam: false, threadKey: null }),
    [hash, route.page],
  );
  const isSettingsPage = route.page === "settings";
  const isLogsPage = route.page === "logs";
  const isTerminalPage = route.page === "terminal";
  const isEnvironmentsPage = route.page === "environments";
  const isScheduledPage = route.page === "scheduled";
  const isQuestmasterPage = route.page === "questmaster";
  const isStreamsPage = route.page === "streams";
  const isSessionView = route.page === "session" || route.page === "home";
  const isDesktopShell = isDesktopShellLayout(zoomLevel);
  const isDesktopTaskPanel = isDesktopTaskPanelLayout(zoomLevel);
  const suppressServerUnreachableBanner =
    route.page === "session" &&
    activeTab === "chat" &&
    !!currentSessionId &&
    !isPendingId(currentSessionId) &&
    currentSessionConnectionStatus === "connected";
  const showServerUnreachableBanner = !serverReachable && !suppressServerUnreachableBanner;
  const routeSessionId = useMemo(
    () => (route.page === "session" ? resolveSessionIdFromRoute(route.sessionId, sdkSessions) : null),
    [route, sdkSessions],
  );
  const displayedSessionId = searchPreviewSessionId ?? (route.page === "session" ? routeSessionId : currentSessionId);

  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", darkMode);
    // Theme-specific class (e.g. "theme-codex-dark") — remove all, then add current
    el.className = el.className.replace(/\btheme-\S+/g, "").trim();
    if (colorTheme !== "light" && colorTheme !== "dark") {
      el.classList.add(`theme-${colorTheme}`);
    }
  }, [colorTheme, darkMode]);

  useEffect(() => {
    const debugWindow = window as TakodeDebugWindow;
    const selectionSourceId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `browser:${crypto.randomUUID()}`
        : `browser:${Date.now()}`;
    const applyVsCodeContext = (context: VsCodeSelectionContextPayload | null) => {
      debugWindow.__TAKODE_VSCODE_CONTEXT__ = context;
      const updatedAt = Date.now();
      sendVsCodeSelectionUpdate({
        type: "vscode_selection_update",
        selection: context
          ? {
              absolutePath: context.absolutePath,
              startLine: context.startLine,
              endLine: context.endLine,
              lineCount: context.lineCount,
            }
          : null,
        updatedAt,
        sourceId: selectionSourceId,
        sourceType: "browser-panel",
        sourceLabel: "embedded-browser",
      });
    };

    debugWindow.__TAKODE_SET_VSCODE_CONTEXT__ = (payload) => {
      console.debug("[takode:vscode] debug set context", payload);
      applyVsCodeContext(payload);
    };
    debugWindow.__TAKODE_CLEAR_VSCODE_CONTEXT__ = () => {
      console.debug("[takode:vscode] debug clear context");
      applyVsCodeContext(null);
    };

    function handleParentMessage(event: MessageEvent) {
      const context = maybeReadVsCodeSelectionContext(event.data);
      if (typeof context === "undefined") {
        return;
      }
      console.debug("[takode:vscode] received context", context);
      if (context === null) {
        applyVsCodeContext(null);
        return;
      }
      applyVsCodeContext(context);
    }

    window.addEventListener("message", handleParentMessage);
    announceVsCodeReady();
    return () => {
      delete debugWindow.__TAKODE_SET_VSCODE_CONTEXT__;
      delete debugWindow.__TAKODE_CLEAR_VSCODE_CONTEXT__;
      window.removeEventListener("message", handleParentMessage);
    };
  }, []);

  useEffect(() => {
    if (route.page !== "session") return;
    if (!/^\d+$/.test(route.sessionId)) return;
    if (routeSessionId) return;

    let cancelled = false;
    api
      .listSessions()
      .then((sessions) => {
        if (cancelled) return;
        setSdkSessionsWithNotificationFreshness(sessions.map(stripSessionSearchMetadata));
      })
      .catch((err) => {
        console.warn("[app] failed to hydrate sessions for numeric route:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [route, routeSessionId]);

  useEffect(() => {
    void (async () => {
      try {
        await ensureVsCodeEditorPreference();
      } catch {
        // Ignore editor preference sync failures so the embedded app stays usable.
      }
    })();
  }, []);

  // Poll server health every 10s. Require 2+ consecutive failures before marking unreachable.
  useEffect(() => {
    let failures = 0;
    const poll = async () => {
      const ok = await checkHealth();
      if (ok) {
        failures = 0;
        useStore.getState().setServerReachable(true);
      } else {
        failures++;
        if (failures >= 2) {
          useStore.getState().setServerReachable(false);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const state = useStore.getState();
      const editableTarget = isShortcutEventTargetEditable(event.target);
      if (shouldBlurVimEscape(state.shortcutSettings, event, event.target)) {
        (event.target as HTMLElement | null)?.blur?.();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const actionId = getMatchingShortcutAction(state.shortcutSettings, event);
      if (!actionId) return;
      if (editableTarget && !isAppGlobalShortcutAction(actionId)) return;

      const currentSessionId = state.currentSessionId;
      const currentSession =
        (currentSessionId ? state.sessions.get(currentSessionId) : null) ??
        (currentSessionId ? state.sdkSessions.find((session) => session.sessionId === currentSessionId) : null) ??
        null;
      const handled = performShortcutAction(actionId, {
        route,
        currentSessionId,
        currentSessionCwd: currentSession?.cwd ?? null,
        terminalCwd: state.terminalCwd,
        activeTab: state.activeTab,
        isSearchOpen: currentSessionId ? getSessionSearchState(state, currentSessionId).isOpen : false,
        sessions: buildSidebarOrderedShortcutSessions(state),
        focusGlobalSearch: () => {
          setSearchEverythingOpen(true);
        },
        openSearch: state.openSessionSearch,
        closeSearch: state.closeSessionSearch,
        lastNewSessionContext: getLastSessionCreationContext(),
        openNewSessionModal: (context) => state.openNewSessionModal(context),
        openTerminal: state.openTerminal,
        captureConversationViewport: () => requestThreadViewportSnapshot(currentSessionId),
        setActiveTab: state.setActiveTab,
        toggleSidebar: () => state.setSidebarOpen(!state.sidebarOpen),
        navigateTo,
        navigateToSession,
        navigateToMostRecentSession: () => navigateToMostRecentSession(),
      });
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
    }

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [route, shortcutSettings]);

  useEffect(() => {
    // Size the parent chain (html → body → #root) to the viewport so the
    // app container can use percentage-based dimensions for zoom scaling.
    // We use % instead of viewport units (vw/dvh) because CSS `zoom`
    // interacts unpredictably with viewport units in some environments.
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");
    html.style.overflow = "hidden";
    html.style.height = "100dvh";
    html.style.width = "100vw";
    body.style.height = "100%";
    body.style.width = "100%";
    body.style.margin = "0";
    if (root) {
      root.style.height = "100%";
      root.style.width = "100%";
    }
  }, []);

  // Capture the localStorage-restored session ID during render (before any effects run)
  // so the mount logic can use it even if the hash-sync branch would clear it.
  const restoredIdRef = useRef(useStore.getState().currentSessionId);
  const connectedSessionIdRef = useRef<string | null>(null);
  const previewConnectedSessionIdRef = useRef<string | null>(null);
  const selectedGitRefreshSessionIdRef = useRef<string | null>(null);

  // Sync hash → store. On mount, restore a localStorage session into the URL first.
  useEffect(() => {
    // On first mount with no session hash, restore from localStorage
    if (restoredIdRef.current !== null && route.page === "home") {
      navigateToSession(restoredIdRef.current, true);
      restoredIdRef.current = null;
      return; // navigateToSession triggers hashchange → this effect re-runs with the session route
    }
    restoredIdRef.current = null;

    if (route.page === "session") {
      const store = useStore.getState();
      const resolvedSessionId = resolveSessionIdFromRoute(route.sessionId, store.sdkSessions);
      if (!resolvedSessionId) {
        if (store.currentSessionId !== null) {
          store.setCurrentSession(null);
        }
        if (connectedSessionIdRef.current) {
          disconnectSession(connectedSessionIdRef.current);
          connectedSessionIdRef.current = null;
        }
        return;
      }

      if (store.currentSessionId !== resolvedSessionId) {
        store.setCurrentSession(resolvedSessionId);
      }

      // Handle /msg/N and legacy ?msg=N message-level deep links.
      const msgIdx = messageIndexFromHash(hash);
      if (msgIdx != null) {
        scrollToMessageIndex(resolvedSessionId, msgIdx);
      }
      // Don't connect WebSocket or fire REST calls for pending sessions
      // (they don't exist on the server yet)
      if (isPendingId(resolvedSessionId)) {
        if (connectedSessionIdRef.current) {
          disconnectSession(connectedSessionIdRef.current);
          connectedSessionIdRef.current = null;
        }
      } else {
        if (connectedSessionIdRef.current && connectedSessionIdRef.current !== resolvedSessionId) {
          disconnectSession(connectedSessionIdRef.current);
        }
        store.markSessionViewed(resolvedSessionId);
        api.markSessionRead?.(resolvedSessionId).catch(() => {});
        connectSession(resolvedSessionId);
        connectedSessionIdRef.current = resolvedSessionId;
        if (selectedGitRefreshSessionIdRef.current !== resolvedSessionId) {
          const sdkSession = store.sdkSessions.find((session) => session.sessionId === resolvedSessionId);
          const bridgeSession = store.sessions.get(resolvedSessionId);
          requestAutoSessionGitStatusRefresh({
            id: resolvedSessionId,
            archived: sdkSession?.archived,
            isWorktree: bridgeSession?.is_worktree ?? sdkSession?.isWorktree ?? true,
            gitStatusRefreshedAt: bridgeSession?.git_status_refreshed_at ?? sdkSession?.gitStatusRefreshedAt,
          });
          selectedGitRefreshSessionIdRef.current = resolvedSessionId;
        }
      }
    } else if (route.page === "home") {
      const store = useStore.getState();
      if (store.currentSessionId !== null) {
        store.setCurrentSession(null);
      }
      if (connectedSessionIdRef.current) {
        disconnectSession(connectedSessionIdRef.current);
        connectedSessionIdRef.current = null;
      }
      // Auto-navigate to the most recent session if available
      navigateToMostRecentSession({ replace: true });
    } else {
      if (connectedSessionIdRef.current) {
        disconnectSession(connectedSessionIdRef.current);
        connectedSessionIdRef.current = null;
      }
    }
  }, [hash, route, sdkSessions]);

  useEffect(() => {
    const previewSessionId =
      searchPreviewSessionId && !isPendingId(searchPreviewSessionId) && searchPreviewSessionId !== currentSessionId
        ? searchPreviewSessionId
        : null;

    const previousPreviewSessionId = previewConnectedSessionIdRef.current;
    if (previousPreviewSessionId && previousPreviewSessionId !== previewSessionId) {
      disconnectSession(previousPreviewSessionId);
      previewConnectedSessionIdRef.current = null;
    }

    if (!previewSessionId) return;

    connectSession(previewSessionId);
    previewConnectedSessionIdRef.current = previewSessionId;

    return () => {
      if (previewConnectedSessionIdRef.current === previewSessionId && previewSessionId !== currentSessionId) {
        disconnectSession(previewSessionId);
        previewConnectedSessionIdRef.current = null;
      }
    };
  }, [searchPreviewSessionId, currentSessionId]);

  useEffect(() => {
    return () => {
      if (connectedSessionIdRef.current) {
        disconnectSession(connectedSessionIdRef.current);
        connectedSessionIdRef.current = null;
      }
      if (previewConnectedSessionIdRef.current) {
        disconnectSession(previewConnectedSessionIdRef.current);
        previewConnectedSessionIdRef.current = null;
      }
    };
  }, []);

  if (route.page === "playground") {
    return <Playground />;
  }

  return (
    <div
      className="flex font-sans-ui bg-cc-bg text-cc-fg antialiased"
      style={{
        transform: `scale(${zoomLevel})`,
        transformOrigin: "top left",
        width: `${100 / zoomLevel}%`,
        height: `${100 / zoomLevel}%`,
      }}
    >
      {/* Mobile overlay backdrop */}
      {sidebarOpen && !isDesktopShell && (
        <div className="fixed inset-0 bg-black/30 z-30" onClick={() => useStore.getState().setSidebarOpen(false)} />
      )}

      {/* Sidebar — overlay on mobile, inline on desktop */}
      {sidebarOpen && (
        <div
          className={`
            ${isDesktopShell ? "relative z-auto w-[260px] translate-x-0" : "fixed inset-y-0 left-0 z-40 w-[80vw] translate-x-0"}
            h-full shrink-0 transition-all duration-200 overflow-hidden
          `}
          style={{
            touchAction: "pan-y",
            overscrollBehaviorX: "none",
          }}
        >
          <Sidebar />
        </div>
      )}

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        <div className="flex-1 overflow-hidden relative">
          {/* Server unreachable banner — overlays content to avoid layout shift */}
          {showServerUnreachableBanner && (
            <div className="absolute top-0 left-0 right-0 z-10 px-4 py-2 bg-red-500/10 border-b border-red-500/20 backdrop-blur-sm text-center flex items-center justify-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />
              <span className="text-xs text-red-400 font-medium">Server unreachable</span>
            </div>
          )}
          {isSettingsPage && (
            <div className="absolute inset-0">
              <SettingsPage embedded isActive={true} />
            </div>
          )}

          {isLogsPage && (
            <div className="absolute inset-0">
              <LogsPage />
            </div>
          )}

          {isTerminalPage && (
            <div className="absolute inset-0">
              <TerminalPage />
            </div>
          )}

          {isEnvironmentsPage && (
            <div className="absolute inset-0">
              <EnvManager embedded />
            </div>
          )}

          {isScheduledPage && (
            <div className="absolute inset-0">
              <ActiveTimersPage embedded />
            </div>
          )}

          {isQuestmasterPage && (
            <div className="absolute inset-0">
              <QuestmasterPage isActive={true} />
            </div>
          )}

          {isStreamsPage && (
            <div className="absolute inset-0">
              <StreamsPage embedded />
            </div>
          )}

          {isSessionView && (
            <>
              {/* Chat tab — visible when activeTab is "chat" or no session */}
              <div className={`absolute inset-0 ${activeTab === "chat" || !displayedSessionId ? "" : "hidden"}`}>
                {displayedSessionId && isPendingId(displayedSessionId) ? (
                  <SessionCreationView pendingId={displayedSessionId} />
                ) : displayedSessionId ? (
                  <ChatView
                    key={displayedSessionId}
                    sessionId={displayedSessionId}
                    preview={searchPreviewSessionId === displayedSessionId}
                    routeThreadKey={threadRoute.threadKey}
                    hasThreadRoute={threadRoute.hasThreadParam}
                  />
                ) : (
                  <EmptyState />
                )}
              </div>

              {/* Diff tab */}
              {currentSessionId && !isPendingId(currentSessionId) && activeTab === "diff" && (
                <div className="absolute inset-0">
                  <DiffPanel sessionId={currentSessionId} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* New session modal */}
      <NewSessionModal
        open={newSessionModalState !== null}
        groupKey={newSessionModalState?.groupKey}
        groupCwd={newSessionModalState?.cwd}
        treeGroupId={newSessionModalState?.treeGroupId}
        newSessionDefaultsKey={newSessionModalState?.newSessionDefaultsKey}
        onClose={() => useStore.getState().closeNewSessionModal()}
      />

      {/* Global quest detail overlay */}
      <QuestDetailPanel />

      <SearchEverythingOverlay
        open={searchEverythingOpen}
        currentSessionId={currentSessionId}
        onClose={() => setSearchEverythingOpen(false)}
      />

      {/* Task panel — overlay on mobile, inline on desktop */}
      {currentSessionId && isSessionView && !isPendingId(currentSessionId) && taskPanelOpen && (
        <>
          {/* Mobile overlay backdrop */}
          {!isDesktopTaskPanel && (
            <div
              className="fixed inset-0 bg-black/30 z-30"
              onClick={() => useStore.getState().setTaskPanelOpen(false)}
            />
          )}

          <div
            className={`
              ${isDesktopTaskPanel ? "relative z-auto w-[280px] translate-x-0" : "fixed z-40 right-0 top-0 w-[280px] translate-x-0"}
              h-full shrink-0 transition-all duration-200 overflow-hidden
            `}
          >
            <TaskPanel sessionId={currentSessionId} />
          </div>
        </>
      )}

      {/* Server restart overlay */}
      {serverRestarting && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-cc-card border border-cc-border rounded-xl p-6 text-center max-w-sm">
            <div className="animate-spin w-8 h-8 border-2 border-cc-primary border-t-transparent rounded-full mx-auto mb-4" />
            <h2 className="text-sm font-semibold text-cc-fg">Server Restarting</h2>
            <p className="mt-2 text-xs text-cc-muted">Sessions will automatically reconnect when the server is back.</p>
          </div>
        </div>
      )}
    </div>
  );
}
