import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { useStore, countUserPermissions, getSessionSearchState } from "../store.js";
import { api } from "../api.js";
import { writeClipboardText } from "../utils/copy-utils.js";
import { SessionStatusDot, deriveSessionStatus } from "./SessionStatusDot.js";
import { YarnBallDot } from "./CatIcons.js";
import { parseHash } from "../utils/routing.js";
import { navigateTo, navigateToSession } from "../utils/navigation.js";
import { isDesktopShellLayout } from "../utils/layout.js";
import { SessionInfoPopover } from "./SessionInfoPopover.js";
import { coalesceSessionViewModel, toSessionViewModel } from "../utils/session-view-model.js";

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
  const currentSessionId = useStore((s) => s.currentSessionId);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const sessionNames = useStore((s) => s.sessionNames);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const zoomLevel = useStore((s) => s.zoomLevel);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const setSessionInfoOpenSessionId = useStore((s) => s.setSessionInfoOpenSessionId);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const [copiedCliId, setCopiedCliId] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const currentSession = useStore((s) => (currentSessionId ? (s.sessions.get(currentSessionId) ?? null) : null));
  const currentSdkSession = useStore((s) =>
    currentSessionId ? (s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId) ?? null) : null,
  );
  const currentSessionVm = useMemo(
    () => coalesceSessionViewModel(currentSession, currentSdkSession),
    [currentSession, currentSdkSession],
  );

  useEffect(() => {
    const openSessionId = infoOpen && isSessionView ? currentSessionId : null;
    setSessionInfoOpenSessionId(openSessionId);
    return () => setSessionInfoOpenSessionId(null);
  }, [infoOpen, isSessionView, currentSessionId, setSessionInfoOpenSessionId]);

  // Count of active (non-done) quests for the quest toggle badge
  const activeQuestCount = useStore((s) => s.quests.filter((q) => q.status !== "done").length);
  const refreshQuests = useStore((s) => s.refreshQuests);

  // Load quests on mount and keep the badge count fresh. The quest_list_updated
  // WebSocket broadcast only reaches browsers with an active session WS connection,
  // so we also poll and refresh on tab visibility/focus as a fallback.
  useEffect(() => {
    refreshQuests();
    const interval = setInterval(refreshQuests, 15_000);
    function handleVisibility() {
      if (document.visibilityState === "visible") refreshQuests();
    }
    function handleFocus() {
      refreshQuests();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const cliSessionId = currentSessionVm?.cliSessionId ?? null;

  const handleCopyCliSessionId = useCallback(() => {
    if (!cliSessionId) return;
    writeClipboardText(cliSessionId)
      .then(() => {
        setCopiedCliId(true);
        setTimeout(() => setCopiedCliId(false), 1500);
      })
      .catch(console.error);
  }, [cliSessionId]);
  const changedFilesCount = useStore((s) => {
    if (!currentSessionId) return 0;
    const session = s.sessions.get(currentSessionId);
    const sdk = s.sdkSessions.find((item) => item.sessionId === currentSessionId);
    const sessionVm = session ? toSessionViewModel(session) : sdk ? toSessionViewModel(sdk) : null;
    const sessionCwd = sessionVm?.cwd;
    const files = s.changedFiles.get(currentSessionId);
    if (!files) return 0;
    if (!sessionCwd) return files.size;
    // Use repo_root only when it's an ancestor of cwd (worktrees have a different root)
    const scope =
      sessionVm?.repoRoot && sessionCwd.startsWith(sessionVm.repoRoot + "/") ? sessionVm.repoRoot : sessionCwd;
    const prefix = `${scope}/`;
    const scopedFiles = [...files].filter((fp) => fp === scope || fp.startsWith(prefix));
    // Filter out files with +0/-0 diff stats (no actual changes vs base branch)
    const stats = s.diffFileStats.get(currentSessionId);
    if (!stats || stats.size === 0) return scopedFiles.length;
    return scopedFiles.filter((fp) => {
      const st = stats.get(fp);
      return !st || st.additions > 0 || st.deletions > 0;
    }).length;
  });

  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const sessionAttention = useStore((s) => s.sessionAttention);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason);

  // Aggregate session status counts using the same priority logic as SessionStatusDot
  // so that each session contributes to exactly one category, matching the visible dots.
  const statusSummary = useMemo(() => {
    let running = 0,
      waiting = 0,
      unread = 0;
    for (const sdk of sdkSessions) {
      if (sdk.archived) continue;
      const vs = deriveSessionStatus({
        permCount: countUserPermissions(pendingPermissions.get(sdk.sessionId)),
        isConnected: cliConnected.get(sdk.sessionId) ?? sdk.cliConnected ?? false,
        sdkState: sdk.state ?? null,
        status: sessionStatus.get(sdk.sessionId) ?? null,
        hasUnread: !!sessionAttention.get(sdk.sessionId),
        idleKilled: cliDisconnectReason.get(sdk.sessionId) === "idle_limit",
      });
      if (vs === "running" || vs === "compacting") running++;
      else if (vs === "permission") waiting++;
      else if (vs === "completed_unread") unread++;
    }
    return { running, waiting, unread };
  }, [sdkSessions, sessionStatus, pendingPermissions, sessionAttention, cliConnected, cliDisconnectReason]);

  // Sessions needing attention (permission or unread), sorted newest-first
  const attentionSessionIds = useMemo(() => {
    return sdkSessions
      .filter((sdk) => {
        if (sdk.archived) return false;
        const vs = deriveSessionStatus({
          permCount: countUserPermissions(pendingPermissions.get(sdk.sessionId)),
          isConnected: cliConnected.get(sdk.sessionId) ?? sdk.cliConnected ?? false,
          sdkState: sdk.state ?? null,
          status: sessionStatus.get(sdk.sessionId) ?? null,
          hasUnread: !!sessionAttention.get(sdk.sessionId),
          idleKilled: cliDisconnectReason.get(sdk.sessionId) === "idle_limit",
        });
        return vs === "permission" || vs === "completed_unread";
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((sdk) => sdk.sessionId);
  }, [sdkSessions, sessionStatus, pendingPermissions, sessionAttention, cliConnected, cliDisconnectReason]);

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

  const isConnected = currentSessionId ? (cliConnected.get(currentSessionId) ?? false) : false;
  const status = currentSessionId ? (sessionStatus.get(currentSessionId) ?? null) : null;
  const currentPermCount = currentSessionId ? countUserPermissions(pendingPermissions.get(currentSessionId)) : 0;
  const currentSdkState = currentSessionVm?.state ?? null;
  const currentHasUnread = currentSessionId ? !!sessionAttention.get(currentSessionId) : false;
  const sessionName = currentSessionId
    ? sessionNames?.get(currentSessionId) || currentSessionVm?.name || `Session ${currentSessionId.slice(0, 8)}`
    : null;
  const sessionNum = currentSessionVm?.sessionNum ?? null;
  const isQuestNamed = useStore((s) => (currentSessionId ? s.questNamedSessions.has(currentSessionId) : false));
  const questStatus = currentSessionVm?.claimedQuestStatus;

  return (
    <header className="shrink-0 flex items-center justify-between px-2 sm:px-4 py-2 sm:py-2.5 bg-cc-card border-b border-cc-border">
      <div className="flex items-center gap-3 min-w-0">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
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
                  idleKilled={currentSessionId ? cliDisconnectReason.get(currentSessionId) === "idle_limit" : false}
                />
              </div>
              {typeof sessionNum === "number" && (
                <span className="text-[11px] font-medium text-cc-muted shrink-0" title={`Session #${sessionNum}`}>
                  #{sessionNum}
                </span>
              )}
              {sessionName && (
                <span
                  className={`text-[11px] font-medium truncate ${isQuestNamed && questStatus !== "needs_verification" ? "text-amber-400" : "text-cc-fg"}`}
                  title={sessionName}
                >
                  {isQuestNamed && questStatus === "needs_verification" ? `☑ ${sessionName}` : sessionName}
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
        {(statusSummary.running > 0 || statusSummary.waiting > 0 || statusSummary.unread > 0) && (
          <button
            onClick={handleAttentionCycle}
            className="flex items-center gap-1 text-[10px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
            title="Cycle through sessions needing attention"
          >
            {statusSummary.running > 0 && (
              <span className="text-cc-success flex items-center gap-0.5">
                {statusSummary.running}
                <YarnBallDot className="text-cc-success" />
              </span>
            )}
            {statusSummary.waiting > 0 && (
              <span className="text-cc-warning flex items-center gap-0.5">
                {statusSummary.waiting}
                <YarnBallDot className="text-cc-warning" />
              </span>
            )}
            {statusSummary.unread > 0 && (
              <span className="text-blue-500 flex items-center gap-0.5">
                {statusSummary.unread}
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
  const isOpen = useStore((s) => getSessionSearchState(s, sessionId).isOpen);
  const openSearch = useStore((s) => s.openSessionSearch);
  const closeSearch = useStore((s) => s.closeSessionSearch);

  return (
    <button
      onClick={() => (isOpen ? closeSearch(sessionId) : openSearch(sessionId))}
      className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
        isOpen ? "text-cc-primary bg-cc-active" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
      }`}
      title="Search messages (⌘F)"
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
        <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85-.017.016zm-5.442.156a5 5 0 110-10 5 5 0 010 10z" />
      </svg>
    </button>
  );
}
