import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useStore } from "./store.js";
import { connectSession } from "./ws.js";
import { checkHealth } from "./api.js";

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
import { SessionLaunchOverlay } from "./components/SessionLaunchOverlay.js";
import { NewSessionModal } from "./components/NewSessionModal.js";
import { QuestmasterPage } from "./components/QuestmasterPage.js";

function useHash() {
  return useSyncExternalStore(
    (cb) => { window.addEventListener("hashchange", cb); return () => window.removeEventListener("hashchange", cb); },
    () => window.location.hash,
  );
}

export default function App() {
  const darkMode = useStore((s) => s.darkMode);
  const zoomLevel = useStore((s) => s.zoomLevel);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const activeTab = useStore((s) => s.activeTab);
  const sessionCreating = useStore((s) => s.sessionCreating);
  const sessionCreatingBackend = useStore((s) => s.sessionCreatingBackend);
  const creationProgress = useStore((s) => s.creationProgress);
  const creationError = useStore((s) => s.creationError);
  const showNewSessionModal = useStore((s) => s.showNewSessionModal);
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

  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
  }, [darkMode]);

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
      store.markSessionViewed(route.sessionId);
      connectSession(route.sessionId);
    } else if (route.page === "home") {
      const store = useStore.getState();
      if (store.currentSessionId !== null) {
        store.setCurrentSession(null);
      }
      // Auto-navigate to the most recent session if available
      navigateToMostRecentSession({ replace: true });
    }
    // For other pages (settings, terminal, etc.), preserve currentSessionId
  }, [route]);

  // Swipe-to-dismiss for mobile sidebar
  const sidebarRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef({ startX: 0, startY: 0, dx: 0, swiping: false });

  const handleSidebarTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.innerWidth >= 768) return;
    const t = e.touches[0];
    swipeRef.current = { startX: t.clientX, startY: t.clientY, dx: 0, swiping: false };
  }, []);

  const handleSidebarTouchMove = useCallback((e: React.TouchEvent) => {
    if (window.innerWidth >= 768) return;
    const t = e.touches[0];
    const dx = t.clientX - swipeRef.current.startX;
    const dy = t.clientY - swipeRef.current.startY;
    if (!swipeRef.current.swiping) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        swipeRef.current.swiping = true;
        if (sidebarRef.current) sidebarRef.current.style.transition = "none";
      } else {
        return;
      }
    }
    swipeRef.current.dx = Math.min(0, dx);
    if (sidebarRef.current) {
      sidebarRef.current.style.transform = `translateX(${swipeRef.current.dx}px)`;
    }
  }, []);

  const handleSidebarTouchEnd = useCallback(() => {
    if (!swipeRef.current.swiping) return;
    const el = sidebarRef.current;
    const shouldClose = swipeRef.current.dx < -60;
    swipeRef.current = { startX: 0, startY: 0, dx: 0, swiping: false };
    if (el) {
      el.style.transition = "transform 200ms ease-out";
      if (shouldClose) {
        el.style.transform = "translateX(-100%)";
        setTimeout(() => {
          el.style.transition = "";
          el.style.transform = "";
          useStore.getState().setSidebarOpen(false);
        }, 200);
      } else {
        el.style.transform = "translateX(0)";
        setTimeout(() => {
          el.style.transition = "";
          el.style.transform = "";
        }, 200);
      }
    }
  }, []);

  if (route.page === "playground") {
    return <Playground />;
  }

  return (
    <div className="flex font-sans-ui bg-cc-bg text-cc-fg antialiased" style={{ transform: `scale(${zoomLevel})`, transformOrigin: 'top left', width: `${100 / zoomLevel}%`, height: `${100 / zoomLevel}%` }}>
      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-30 md:hidden"
          onClick={() => useStore.getState().setSidebarOpen(false)}
        />
      )}

      {/* Sidebar — overlay on mobile, inline on desktop */}
      <div
        ref={sidebarRef}
        onTouchStart={handleSidebarTouchStart}
        onTouchMove={handleSidebarTouchMove}
        onTouchEnd={handleSidebarTouchEnd}
        className={`
          fixed md:relative z-40 md:z-auto
          h-full shrink-0 transition-all duration-200
          ${sidebarOpen ? "w-[80vw] md:w-[260px] translate-x-0" : "w-0 -translate-x-full md:w-0 md:-translate-x-full"}
          overflow-hidden
        `}
      >
        <Sidebar />
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar />
        {/* Server unreachable banner — always visible across all pages */}
        {!serverReachable && (
          <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/20 text-center flex items-center justify-center gap-2 shrink-0">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse shrink-0" />
            <span className="text-xs text-red-400 font-medium">
              Server unreachable
            </span>
          </div>
        )}
        <div className="flex-1 overflow-hidden relative">
          {isSettingsPage && (
            <div className="absolute inset-0">
              <SettingsPage embedded />
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
                {currentSessionId ? (
                  <ChatView key={currentSessionId} sessionId={currentSessionId} />
                ) : (
                  <EmptyState />
                )}
              </div>

              {/* Diff tab */}
              {currentSessionId && activeTab === "diff" && (
                <div className="absolute inset-0">
                  <DiffPanel sessionId={currentSessionId} />
                </div>
              )}

              {/* Session launch overlay — shown during creation */}
              {sessionCreating && creationProgress && creationProgress.length > 0 && (
                <SessionLaunchOverlay
                  steps={creationProgress}
                  error={creationError}
                  backend={sessionCreatingBackend ?? undefined}
                  onCancel={() => useStore.getState().clearCreation()}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* New session modal */}
      <NewSessionModal
        open={showNewSessionModal}
        onClose={() => useStore.getState().setShowNewSessionModal(false)}
      />

      {/* Task panel — overlay on mobile, inline on desktop */}
      {currentSessionId && isSessionView && (
        <>
          {/* Mobile overlay backdrop */}
          {taskPanelOpen && (
            <div
              className="fixed inset-0 bg-black/30 z-30 lg:hidden"
              onClick={() => useStore.getState().setTaskPanelOpen(false)}
            />
          )}

          <div
            className={`
              fixed lg:relative z-40 lg:z-auto right-0 top-0
              h-full shrink-0 transition-all duration-200
              ${taskPanelOpen ? "w-[280px] translate-x-0" : "w-0 translate-x-full lg:w-0 lg:translate-x-full"}
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
            <p className="mt-2 text-xs text-cc-muted">
              Sessions will automatically reconnect when the server is back.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
