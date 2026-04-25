import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore, countUserPermissions, getSessionSearchState } from "../store.js";
import { api } from "../api.js";
import { writeClipboardText } from "../utils/copy-utils.js";
import { SessionStatusDot, deriveSessionStatus } from "./SessionStatusDot.js";
import { YarnBallDot } from "./CatIcons.js";
import { parseHash } from "../utils/routing.js";
import { navigateTo, navigateToSession } from "../utils/navigation.js";
import { isDesktopShellLayout } from "../utils/layout.js";
import { SessionInfoPopover } from "./SessionInfoPopover.js";
import { coalesceSessionViewModel, type SessionViewModel } from "../utils/session-view-model.js";
import { questLabel } from "../utils/quest-helpers.js";
import { getShortcutTitle } from "../shortcuts.js";

const ATTENTION_SESSION_KEY_SEPARATOR = "\u001f";

type TopBarState = ReturnType<typeof useStore.getState>;

function countScopedChangedFiles(state: TopBarState, sessionId: string, sessionVm: SessionViewModel | null): number {
  const files = state.changedFiles.get(sessionId);
  if (!files) return 0;

  const sessionCwd = sessionVm?.cwd;
  if (!sessionCwd) return files.size;

  // Use repo_root only when it's an ancestor of cwd (worktrees have a different root).
  const scope =
    sessionVm?.repoRoot && sessionCwd.startsWith(sessionVm.repoRoot + "/") ? sessionVm.repoRoot : sessionCwd;
  const prefix = `${scope}/`;
  const scopedFiles = [...files].filter((fp) => fp === scope || fp.startsWith(prefix));
  const stats = state.diffFileStats.get(sessionId);
  if (!stats || stats.size === 0) return scopedFiles.length;

  return scopedFiles.filter((fp) => {
    const st = stats.get(fp);
    return !st || st.additions > 0 || st.deletions > 0;
  }).length;
}

export function getTopBarStatusSummary(state: TopBarState) {
  let running = 0;
  let waiting = 0;
  let unread = 0;
  const attentionSessionIds: Array<{ sessionId: string; createdAt: number }> = [];

  for (const sdk of state.sdkSessions) {
    if (sdk.archived) continue;

    const visualStatus = deriveSessionStatus({
      permCount: countUserPermissions(state.pendingPermissions.get(sdk.sessionId)),
      isConnected: state.cliConnected.get(sdk.sessionId) ?? sdk.cliConnected ?? false,
      sdkState: sdk.state ?? null,
      status: state.sessionStatus.get(sdk.sessionId) ?? null,
      hasUnread: !!state.sessionAttention.get(sdk.sessionId),
      idleKilled: state.cliDisconnectReason.get(sdk.sessionId) === "idle_limit",
    });

    if (visualStatus === "running" || visualStatus === "compacting") running++;
    else if (visualStatus === "permission") waiting++;
    else if (visualStatus === "completed_unread") unread++;

    if (visualStatus === "permission" || visualStatus === "completed_unread") {
      attentionSessionIds.push({ sessionId: sdk.sessionId, createdAt: sdk.createdAt });
    }
  }

  attentionSessionIds.sort((a, b) => b.createdAt - a.createdAt);

  return {
    running,
    waiting,
    unread,
    attentionSessionIdsKey: attentionSessionIds.map((item) => item.sessionId).join(ATTENTION_SESSION_KEY_SEPARATOR),
  };
}

export function splitAttentionSessionIdsKey(key: string): string[] {
  return key ? key.split(ATTENTION_SESSION_KEY_SEPARATOR) : [];
}

export function getCurrentTopBarSessionState(state: TopBarState) {
  const currentSessionId = state.currentSessionId;
  if (!currentSessionId) {
    return {
      currentSessionId: null,
      isConnected: false,
      status: null,
      currentPermCount: 0,
      currentSdkState: null,
      currentHasUnread: false,
      sessionName: null,
      sessionNum: null,
      isQuestNamed: false,
      questStatus: undefined,
      cliSessionId: null,
      idleKilled: false,
      changedFilesCount: 0,
    };
  }

  const currentSession = state.sessions.get(currentSessionId) ?? null;
  const currentSdkSession = state.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId) ?? null;
  const currentSessionVm = coalesceSessionViewModel(currentSession, currentSdkSession);

  return {
    currentSessionId,
    isConnected: state.cliConnected.get(currentSessionId) ?? false,
    status: state.sessionStatus.get(currentSessionId) ?? null,
    currentPermCount: countUserPermissions(state.pendingPermissions.get(currentSessionId)),
    currentSdkState: currentSessionVm?.state ?? null,
    currentHasUnread: !!state.sessionAttention.get(currentSessionId),
    sessionName:
      state.sessionNames.get(currentSessionId) || currentSessionVm?.name || `Session ${currentSessionId.slice(0, 8)}`,
    sessionNum: currentSessionVm?.sessionNum ?? null,
    isQuestNamed: state.questNamedSessions.has(currentSessionId),
    questStatus: currentSessionVm?.claimedQuestStatus,
    cliSessionId: currentSessionVm?.cliSessionId ?? null,
    idleKilled: state.cliDisconnectReason.get(currentSessionId) === "idle_limit",
    changedFilesCount: countScopedChangedFiles(state, currentSessionId, currentSessionVm),
  };
}

export function TopBar() {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  const route = useMemo(() => parseHash(hash), [hash]);
  const isSessionView = route.page === "session" || route.page === "home";
  const isQuestmasterPage = route.page === "questmaster";
  const {
    currentSessionId,
    zoomLevel,
    sidebarOpen,
    shortcutSettings,
    setSidebarOpen,
    setSessionInfoOpenSessionId,
    activeTab,
    setActiveTab,
    activeQuestCount,
    refreshQuests,
  } = useStore(
    useShallow((s) => ({
      currentSessionId: s.currentSessionId,
      zoomLevel: s.zoomLevel,
      sidebarOpen: s.sidebarOpen,
      shortcutSettings: s.shortcutSettings,
      setSidebarOpen: s.setSidebarOpen,
      setSessionInfoOpenSessionId: s.setSessionInfoOpenSessionId,
      activeTab: s.activeTab,
      setActiveTab: s.setActiveTab,
      activeQuestCount: s.quests.reduce((count, quest) => count + (quest.status !== "done" ? 1 : 0), 0),
      refreshQuests: s.refreshQuests,
    })),
  );
  const {
    isConnected,
    status,
    currentPermCount,
    currentSdkState,
    currentHasUnread,
    sessionName,
    sessionNum,
    isQuestNamed,
    questStatus,
    cliSessionId,
    idleKilled,
    changedFilesCount,
  } = useStore(useShallow(getCurrentTopBarSessionState));
  const { running, waiting, unread, attentionSessionIdsKey } = useStore(useShallow(getTopBarStatusSummary));
  const [copiedCliId, setCopiedCliId] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const attentionSessionIds = useMemo(
    () => splitAttentionSessionIdsKey(attentionSessionIdsKey),
    [attentionSessionIdsKey],
  );
  const shortcutPlatform = typeof navigator === "undefined" ? undefined : navigator.platform;

  useEffect(() => {
    const openSessionId = infoOpen && isSessionView ? currentSessionId : null;
    setSessionInfoOpenSessionId(openSessionId);
    return () => setSessionInfoOpenSessionId(null);
  }, [infoOpen, isSessionView, currentSessionId, setSessionInfoOpenSessionId]);

  // Load quests on mount and keep the badge count fresh. The quest_list_updated
  // WebSocket broadcast only reaches browsers with an active session WS connection,
  // so we also poll and refresh on tab visibility/focus as a fallback.
  useEffect(() => {
    let timeoutId: number | null = null;

    const scheduleNextPoll = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (document.visibilityState !== "visible") return;
      timeoutId = window.setTimeout(() => {
        void refreshQuests({ background: true });
        scheduleNextPoll();
      }, 15_000);
    };

    void refreshQuests();
    scheduleNextPoll();

    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void refreshQuests();
        scheduleNextPoll();
      } else if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    }
    function handleFocus() {
      void refreshQuests();
      scheduleNextPoll();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [refreshQuests]);
  const handleCopyCliSessionId = useCallback(() => {
    if (!cliSessionId) return;
    writeClipboardText(cliSessionId)
      .then(() => {
        setCopiedCliId(true);
        setTimeout(() => setCopiedCliId(false), 1500);
      })
      .catch(console.error);
  }, [cliSessionId]);
  // Cycle through attention sessions on yarn ball click
  const cycleIndexRef = useRef(-1);
  const attentionKey = attentionSessionIds.join(",");
  useEffect(() => {
    cycleIndexRef.current = -1;
  }, [attentionKey]);

  const handleAttentionCycle = useCallback(() => {
    if (attentionSessionIds.length === 0) return;

    if (!isDesktopShellLayout(zoomLevel)) {
      if (!currentSessionId) {
        navigateToSession(attentionSessionIds[0]);
        return;
      }

      const currentIdx = attentionSessionIds.indexOf(currentSessionId);
      if (currentIdx < 0) {
        navigateToSession(attentionSessionIds[0]);
        return;
      }

      const nextSessionId = attentionSessionIds[currentIdx + 1];
      if (!nextSessionId) return;

      navigateToSession(nextSessionId);
      return;
    }

    setSidebarOpen(true);
    // Find current session's position in the attention list to cycle from there
    const currentIdx = currentSessionId ? attentionSessionIds.indexOf(currentSessionId) : -1;
    const startFrom = currentIdx >= 0 ? currentIdx : cycleIndexRef.current;
    const nextIdx = (startFrom + 1) % attentionSessionIds.length;
    cycleIndexRef.current = nextIdx;
    navigateToSession(attentionSessionIds[nextIdx]);
  }, [attentionSessionIds, currentSessionId, setSidebarOpen, zoomLevel]);

  // Track the hash before navigating to questmaster so we can toggle back
  const prevHashRef = useRef<string>("");

  const handleQuestToggle = useCallback(() => {
    if (isQuestmasterPage) {
      // Toggle back to previous view (or home)
      const prev = prevHashRef.current;
      if (prev && prev !== "#/questmaster") {
        navigateTo(prev);
      } else {
        navigateTo("");
      }
    } else {
      // Save current hash before navigating to questmaster
      prevHashRef.current = window.location.hash;
      navigateTo("/questmaster");
    }
  }, [isQuestmasterPage]);

  return (
    <header className="shrink-0 flex items-center justify-between px-2 sm:px-4 py-2 sm:py-2.5 bg-cc-card border-b border-cc-border">
      <div className="flex items-center gap-3 min-w-0">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          title={getShortcutTitle("Toggle sidebar", shortcutSettings, "toggle_sidebar", shortcutPlatform)}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        {/* Current session status + title — clickable to open session info */}
        {currentSessionId && (
          <div className="flex items-center gap-1.5 min-w-0">
            <button
              onClick={() => setInfoOpen(!infoOpen)}
              className="flex items-center gap-1.5 min-w-0 cursor-pointer hover:opacity-80 transition-opacity"
            >
              <div className="[&>div]:mt-0 shrink-0">
                <SessionStatusDot
                  permCount={currentPermCount}
                  isConnected={isConnected}
                  sdkState={currentSdkState}
                  status={status}
                  hasUnread={currentHasUnread}
                  idleKilled={idleKilled}
                />
              </div>
              {typeof sessionNum === "number" && (
                <span className="text-[11px] font-medium text-cc-muted shrink-0" title={`Session #${sessionNum}`}>
                  #{sessionNum}
                </span>
              )}
              {sessionName && (
                <span className="text-[11px] font-medium truncate text-cc-fg" title={sessionName}>
                  {questLabel(sessionName, isQuestNamed, questStatus)}
                </span>
              )}
            </button>
            {/* Copy CLI Session ID button */}
            {cliSessionId && (
              <button
                onClick={handleCopyCliSessionId}
                className="flex items-center justify-center w-5 h-5 rounded text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer relative"
                title={`Copy CLI Session ID: ${cliSessionId}`}
              >
                {copiedCliId ? (
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="w-3 h-3 text-cc-success"
                  >
                    <path d="M3 8.5l3.5 3.5 6.5-8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-3 h-3">
                    <rect x="5.5" y="5.5" width="7" height="8" rx="1" />
                    <path d="M3.5 10.5V3a1 1 0 011-1h5.5" />
                  </svg>
                )}
              </button>
            )}
            {!isConnected && (
              <button
                onClick={() => currentSessionId && api.relaunchSession(currentSessionId).catch(console.error)}
                className="text-[11px] text-cc-warning hover:text-cc-warning/80 font-medium cursor-pointer hidden sm:inline"
              >
                Reconnect
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2 sm:gap-3 shrink-0 text-[12px] text-cc-muted">
        {/* Global session status summary — right-aligned so it stays in a fixed position */}
        {(running > 0 || waiting > 0 || unread > 0) && (
          <button
            onClick={handleAttentionCycle}
            className="flex items-center gap-1 text-[10px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
            title="Cycle through sessions needing attention"
          >
            {running > 0 && (
              <span className="text-cc-success flex items-center gap-0.5">
                {running}
                <YarnBallDot className="text-cc-success" />
              </span>
            )}
            {waiting > 0 && (
              <span className="text-cc-warning flex items-center gap-0.5">
                {waiting}
                <YarnBallDot className="text-cc-warning" />
              </span>
            )}
            {unread > 0 && (
              <span className="text-blue-500 flex items-center gap-0.5">
                {unread}
                <YarnBallDot className="text-blue-500" />
              </span>
            )}
          </button>
        )}
        {currentSessionId && isSessionView && (
          <>
            {status === "compacting" && (
              <span className="text-cc-warning font-medium animate-pulse">Compacting...</span>
            )}
            {status === "reverting" && <span className="text-cc-warning font-medium animate-pulse">Reverting...</span>}

            {/* Search toggle */}
            <SearchToggleButton sessionId={currentSessionId} />

            {/* Diffs toggle */}
            <button
              onClick={() => setActiveTab(activeTab === "diff" ? "chat" : "diff")}
              className={`relative flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
                activeTab === "diff"
                  ? "text-cc-primary bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title={activeTab === "diff" ? "Back to chat" : "Show diffs"}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M2.5 1A1.5 1.5 0 001 2.5v11A1.5 1.5 0 002.5 15h3a.5.5 0 000-1h-3a.5.5 0 01-.5-.5v-11a.5.5 0 01.5-.5h3a.5.5 0 000-1h-3zM10.5 1a.5.5 0 000 1h3a.5.5 0 01.5.5v11a.5.5 0 01-.5.5h-3a.5.5 0 000 1h3A1.5 1.5 0 0015 13.5v-11A1.5 1.5 0 0013.5 1h-3zM8 3.5a.5.5 0 01.5.5v8a.5.5 0 01-1 0V4a.5.5 0 01.5-.5zM5.5 6a.5.5 0 000 1h1a.5.5 0 000-1h-1zm4 0a.5.5 0 000 1h1a.5.5 0 000-1h-1zM5.5 9a.5.5 0 000 1h1a.5.5 0 000-1h-1zm4 0a.5.5 0 000 1h1a.5.5 0 000-1h-1z" />
              </svg>
              {changedFilesCount > 0 && (
                <span className="absolute -top-1 -right-1 text-[8px] bg-cc-primary text-white rounded-full min-w-[14px] h-[14px] flex items-center justify-center font-semibold leading-none px-0.5">
                  {changedFilesCount}
                </span>
              )}
            </button>

            {/* Session info popover toggle */}
            <button
              onClick={() => setInfoOpen(!infoOpen)}
              className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
                infoOpen ? "text-cc-primary bg-cc-active" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title="Session info"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path
                  fillRule="evenodd"
                  d="M8 1a7 7 0 100 14A7 7 0 008 1zM6.5 8a.5.5 0 01.5-.5h1a.5.5 0 01.5.5v3.5a.5.5 0 01-.5.5H7a.5.5 0 01-.5-.5V8zM8 4.5a1 1 0 100 2 1 1 0 000-2z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
            {infoOpen && currentSessionId && (
              <SessionInfoPopover sessionId={currentSessionId} onClose={() => setInfoOpen(false)} />
            )}
          </>
        )}
        {/* Quests toggle — rightmost for stable position across views */}
        <button
          onClick={handleQuestToggle}
          className={`relative flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
            isQuestmasterPage ? "text-cc-primary bg-cc-active" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
          }`}
          title={isQuestmasterPage ? "Back to session" : "Quests"}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
            <path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5.75a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 014 5.75zM4.75 8a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5zM4 11.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
          </svg>
          {activeQuestCount > 0 && (
            <span className="absolute -top-1 -right-1 text-[8px] bg-cc-primary text-white rounded-full min-w-[14px] h-[14px] flex items-center justify-center font-semibold leading-none px-0.5">
              {activeQuestCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}

function SearchToggleButton({ sessionId }: { sessionId: string }) {
  const { isOpen, openSearch, closeSearch } = useStore(
    useShallow((s) => ({
      isOpen: getSessionSearchState(s, sessionId).isOpen,
      openSearch: s.openSessionSearch,
      closeSearch: s.closeSessionSearch,
    })),
  );
  const shortcutSettings = useStore((s) => s.shortcutSettings);
  const shortcutPlatform = typeof navigator === "undefined" ? undefined : navigator.platform;

  return (
    <button
      onClick={() => (isOpen ? closeSearch(sessionId) : openSearch(sessionId))}
      className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
        isOpen ? "text-cc-primary bg-cc-active" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
      }`}
      title={getShortcutTitle("Search messages", shortcutSettings, "search_session", shortcutPlatform)}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
        <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85-.017.016zm-5.442.156a5 5 0 110-10 5 5 0 010 10z" />
      </svg>
    </button>
  );
}
