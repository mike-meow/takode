import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useStore } from "./store.js";
import { connectSession, disconnectSession, sendVsCodeSelectionUpdate } from "./ws.js";
import { api, checkHealth } from "./api.js";

import { parseHash, navigateToSession, navigateToMostRecentSession } from "./utils/routing.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatView } from "./components/ChatView.js";
import { TopBar } from "./components/TopBar.js";
import { EmptyState } from "./components/EmptyState.js";
import { TaskPanel } from "./components/TaskPanel.js";
import { DiffPanel } from "./components/DiffPanel.js";
import { Playground } from "./components/Playground.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { EnvManager } from "./components/EnvManager.js";
import { CronManager } from "./components/CronManager.js";
import { TerminalPage } from "./components/TerminalPage.js";
import { SessionCreationView } from "./components/SessionCreationView.js";
import { NewSessionModal } from "./components/NewSessionModal.js";
import { QuestmasterPage } from "./components/QuestmasterPage.js";
import { QuestDetailModal } from "./components/QuestDetailModal.js";
import { isPendingId } from "./utils/pending-creation.js";
import { isDesktopShellLayout, isDesktopTaskPanelLayout } from "./utils/layout.js";
import {
  announceVsCodeReady,
  type VsCodeSelectionContextPayload,
  maybeReadVsCodeSelectionContext,
} from "./utils/vscode-context.js";
import { ensureVsCodeEditorPreference } from "./utils/vscode-bridge.js";

type TakodeDebugWindow = Window &
  typeof globalThis & {
    __TAKODE_VSCODE_CONTEXT__?: VsCodeSelectionContextPayload | null;
    __TAKODE_SET_VSCODE_CONTEXT__?: (payload: VsCodeSelectionContextPayload | null) => void;
    __TAKODE_CLEAR_VSCODE_CONTEXT__?: () => void;
  };

function useHash() {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
}

export default function App() {
  const colorTheme = useStore((s) => s.colorTheme);
  const darkMode = useStore((s) => s.darkMode);
  const zoomLevel = useStore((s) => s.zoomLevel);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const activeTab = useStore((s) => s.activeTab);
  const newSessionModalState = useStore((s) => s.newSessionModalState);
  const serverRestarting = useStore((s) => s.serverRestarting);
  const serverReachable = useStore((s) => s.serverReachable);
  const hash = useHash();
  const route = useMemo(() => parseHash(hash), [hash]);
  const isSettingsPage = route.page === "settings";
  const isTerminalPage = route.page === "terminal";
  const isEnvironmentsPage = route.page === "environments";
  const isScheduledPage = route.page === "scheduled";
  const isQuestmasterPage = route.page === "questmaster";
  const isSessionView = route.page === "session" || route.page === "home";
  const isDesktopShell = isDesktopShellLayout(zoomLevel);
  const isDesktopTaskPanel = isDesktopTaskPanelLayout(zoomLevel);

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
      if (store.currentSessionId !== route.sessionId) {
        store.setCurrentSession(route.sessionId);
      }
      // Don't connect WebSocket or fire REST calls for pending sessions
      // (they don't exist on the server yet)
      if (isPendingId(route.sessionId)) {
        if (connectedSessionIdRef.current) {
          disconnectSession(connectedSessionIdRef.current);
          connectedSessionIdRef.current = null;
        }
      } else {
        if (connectedSessionIdRef.current && connectedSessionIdRef.current !== route.sessionId) {
          disconnectSession(connectedSessionIdRef.current);
        }
        store.markSessionViewed(route.sessionId);
        api.markSessionRead?.(route.sessionId).catch(() => {});
        connectSession(route.sessionId);
        connectedSessionIdRef.current = route.sessionId;
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
  }, [route]);

  useEffect(() => {
    return () => {
      if (connectedSessionIdRef.current) {
        disconnectSession(connectedSessionIdRef.current);
        connectedSessionIdRef.current = null;
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
      <div
        className={`
          ${isDesktopShell ? "relative z-auto" : "fixed inset-y-0 left-0 z-40"}
          h-full shrink-0 transition-all duration-200
          ${
            isDesktopShell
              ? sidebarOpen
                ? "w-[260px] translate-x-0"
                : "w-0"
              : sidebarOpen
                ? "w-[80vw] translate-x-0"
                : "w-0 -translate-x-full"
          }
          overflow-hidden
        `}
        style={{
          touchAction: "pan-y",
          overscrollBehaviorX: "none",
        }}
      >
        <Sidebar />
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        <div className="flex-1 overflow-hidden relative">
          {/* Server unreachable banner — overlays content to avoid layout shift */}
          {!serverReachable && (
            <div className="absolute top-0 left-0 right-0 z-10 px-4 py-2 bg-red-500/10 border-b border-red-500/20 backdrop-blur-sm text-center flex items-center justify-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />
              <span className="text-xs text-red-400 font-medium">Server unreachable</span>
            </div>
          )}
          <div className={`absolute inset-0 ${isSettingsPage ? "" : "hidden"}`}>
            <SettingsPage embedded isActive={isSettingsPage} />
          </div>

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
              <CronManager embedded />
            </div>
          )}

          <div className={`absolute inset-0 ${isQuestmasterPage ? "" : "hidden"}`}>
            <QuestmasterPage isActive={isQuestmasterPage} />
          </div>

          {isSessionView && (
            <>
              {/* Chat tab — visible when activeTab is "chat" or no session */}
              <div className={`absolute inset-0 ${activeTab === "chat" || !currentSessionId ? "" : "hidden"}`}>
                {currentSessionId && isPendingId(currentSessionId) ? (
                  <SessionCreationView pendingId={currentSessionId} />
                ) : currentSessionId ? (
                  <ChatView key={currentSessionId} sessionId={currentSessionId} />
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
        onClose={() => useStore.getState().closeNewSessionModal()}
      />

      {/* Global read-only quest detail overlay */}
      <QuestDetailModal />

      {/* Task panel — overlay on mobile, inline on desktop */}
      {currentSessionId && isSessionView && !isPendingId(currentSessionId) && (
        <>
          {/* Mobile overlay backdrop */}
          {taskPanelOpen && !isDesktopTaskPanel && (
            <div
              className="fixed inset-0 bg-black/30 z-30"
              onClick={() => useStore.getState().setTaskPanelOpen(false)}
            />
          )}

          <div
            className={`
              ${isDesktopTaskPanel ? "relative z-auto" : "fixed z-40 right-0 top-0"}
              h-full shrink-0 transition-all duration-200
              ${taskPanelOpen ? "w-[280px] translate-x-0" : "w-0 translate-x-full"}
              overflow-hidden
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
