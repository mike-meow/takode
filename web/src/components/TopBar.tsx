import { useState, useMemo, useCallback, useSyncExternalStore } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { writeClipboardText } from "../utils/copy-utils.js";
import { ClaudeMdEditor } from "./ClaudeMdEditor.js";
import { SessionStatusDot, deriveSessionStatus } from "./SessionStatusDot.js";
import { YarnBallDot } from "./CatIcons.js";
import { parseHash } from "../utils/routing.js";
import { shortenHome } from "../utils/path-display.js";

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
  const currentSessionId = useStore((s) => s.currentSessionId);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const sessionNames = useStore((s) => s.sessionNames);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const taskPanelOpen = useStore((s) => s.taskPanelOpen);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const [claudeMdOpen, setClaudeMdOpen] = useState(false);
  const [copiedCliId, setCopiedCliId] = useState(false);

  const cliSessionId = useStore((s) => {
    if (!currentSessionId) return null;
    return s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cliSessionId ?? null;
  });

  const handleCopyCliSessionId = useCallback(() => {
    if (!cliSessionId) return;
    writeClipboardText(cliSessionId).then(() => {
      setCopiedCliId(true);
      setTimeout(() => setCopiedCliId(false), 1500);
    }).catch(console.error);
  }, [cliSessionId]);
  const changedFilesCount = useStore((s) => {
    if (!currentSessionId) return 0;
    const session = s.sessions.get(currentSessionId);
    const sessionCwd =
      session?.cwd ||
      s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd;
    const files = s.changedFiles.get(currentSessionId);
    if (!files) return 0;
    if (!sessionCwd) return files.size;
    // Use repo_root only when it's an ancestor of cwd (worktrees have a different root)
    const scope = (session?.repo_root && sessionCwd.startsWith(session.repo_root + "/"))
      ? session.repo_root
      : sessionCwd;
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

  const cwd = useStore((s) => {
    if (!currentSessionId) return null;
    return (
      s.sessions.get(currentSessionId)?.cwd ||
      s.sdkSessions.find((sdk) => sdk.sessionId === currentSessionId)?.cwd ||
      null
    );
  });

  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const sessionAttention = useStore((s) => s.sessionAttention);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason);
  const serverReachable = useStore((s) => s.serverReachable);

  // Aggregate session status counts using the same priority logic as SessionStatusDot
  // so that each session contributes to exactly one category, matching the visible dots.
  const statusSummary = useMemo(() => {
    let running = 0, waiting = 0, unread = 0;
    for (const sdk of sdkSessions) {
      if (sdk.archived) continue;
      const vs = deriveSessionStatus({
        permCount: pendingPermissions.get(sdk.sessionId)?.size ?? 0,
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

  const isConnected = currentSessionId ? (cliConnected.get(currentSessionId) ?? false) : false;
  const status = currentSessionId ? (sessionStatus.get(currentSessionId) ?? null) : null;
  const currentPermCount = currentSessionId ? (pendingPermissions.get(currentSessionId)?.size ?? 0) : 0;
  const currentSdkState = currentSessionId
    ? (sdkSessions.find((s) => s.sessionId === currentSessionId)?.state ?? null)
    : null;
  const currentHasUnread = currentSessionId ? !!(sessionAttention.get(currentSessionId)) : false;
  const sessionName = currentSessionId
    ? (sessionNames?.get(currentSessionId) ||
      sdkSessions.find((s) => s.sessionId === currentSessionId)?.name ||
      `Session ${currentSessionId.slice(0, 8)}`)
    : null;

  return (
    <header className="shrink-0 flex items-center justify-between px-2 sm:px-4 py-2 sm:py-2.5 bg-cc-card border-b border-cc-border">
      <div className="flex items-center gap-3">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center justify-center w-7 h-7 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Server unreachable banner */}
        {!serverReachable && (
          <span className="flex items-center gap-1 text-[11px] text-red-400 font-medium">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
            Server unreachable
          </span>
        )}

        {/* Current session status + title */}
        {currentSessionId && (
          <div className="flex items-center gap-1.5">
            <div className="[&>div]:mt-0">
              <SessionStatusDot
                permCount={currentPermCount}
                isConnected={isConnected}
                sdkState={currentSdkState}
                status={status}
                hasUnread={currentHasUnread}
                idleKilled={currentSessionId ? cliDisconnectReason.get(currentSessionId) === "idle_limit" : false}
              />
            </div>
            <div className="min-w-0">
              {sessionName && (
                <span className="text-[11px] font-medium text-cc-fg max-w-[9rem] sm:max-w-none truncate block" title={sessionName}>
                  {sessionName}
                </span>
              )}
              {cwd && (
                <span className="text-[10px] text-cc-muted font-mono-code truncate block max-w-[12rem] sm:max-w-[20rem]" title={cwd}>
                  {shortenHome(cwd)}
                </span>
              )}
            </div>
            {/* Copy CLI Session ID button */}
            {cliSessionId && (
              <button
                onClick={handleCopyCliSessionId}
                className="flex items-center justify-center w-5 h-5 rounded text-cc-muted/50 hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer relative"
                title={`Copy CLI Session ID: ${cliSessionId}`}
              >
                {copiedCliId ? (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3 text-cc-success">
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

        {/* Global session status summary — after title for visual separation from session dot */}
        {(statusSummary.running > 0 || statusSummary.waiting > 0 || statusSummary.unread > 0) && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex items-center gap-1 text-[10px] font-medium cursor-pointer hover:opacity-80 transition-opacity"
            title="Open sidebar"
          >
            {statusSummary.running > 0 && (
              <span className="text-cc-success flex items-center gap-0.5">{statusSummary.running}<YarnBallDot className="text-cc-success" /></span>
            )}
            {statusSummary.waiting > 0 && (
              <span className="text-cc-warning flex items-center gap-0.5">{statusSummary.waiting}<YarnBallDot className="text-cc-warning" /></span>
            )}
            {statusSummary.unread > 0 && (
              <span className="text-blue-500 flex items-center gap-0.5">{statusSummary.unread}<YarnBallDot className="text-blue-500" /></span>
            )}
          </button>
        )}
      </div>

      {/* Right side */}
      {currentSessionId && isSessionView && (
        <div className="flex items-center gap-2 sm:gap-3 text-[12px] text-cc-muted">
          {status === "compacting" && (
            <span className="text-cc-warning font-medium animate-pulse">Compacting...</span>
          )}
          {status === "reverting" && (
            <span className="text-cc-warning font-medium animate-pulse">Reverting...</span>
          )}

          {/* Chat / Editor tab toggle */}
          <div className="flex items-center bg-cc-hover rounded-lg p-0.5">
            <button
              onClick={() => setActiveTab("chat")}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                activeTab === "chat"
                  ? "bg-cc-card text-cc-fg shadow-sm"
                  : "text-cc-muted hover:text-cc-fg"
              }`}
            >
              Chat
            </button>
            <button
              onClick={() => setActiveTab("diff")}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === "diff"
                  ? "bg-cc-card text-cc-fg shadow-sm"
                  : "text-cc-muted hover:text-cc-fg"
              }`}
            >
              Diffs
              {changedFilesCount > 0 && (
                <span className="text-[9px] bg-cc-muted/20 text-cc-fg rounded-full min-w-[16px] h-4 flex items-center justify-center font-semibold leading-none px-1">
                  {changedFilesCount}
                </span>
              )}
            </button>
          </div>

          {/* CLAUDE.md editor */}
          {cwd && (
            <button
              onClick={() => setClaudeMdOpen(true)}
              className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
                claudeMdOpen
                  ? "text-cc-primary bg-cc-active"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title="Edit CLAUDE.md"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
              </svg>
            </button>
          )}

          <button
            onClick={() => setTaskPanelOpen(!taskPanelOpen)}
            className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
              taskPanelOpen
                ? "text-cc-primary bg-cc-active"
                : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
            }`}
            title="Toggle session panel"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path fillRule="evenodd" d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2H6zm1 3a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h6a1 1 0 100-2H7zm0 4a1 1 0 000 2h4a1 1 0 100-2H7z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}

      {/* CLAUDE.md editor modal */}
      {cwd && (
        <ClaudeMdEditor
          cwd={cwd}
          open={claudeMdOpen}
          onClose={() => setClaudeMdOpen(false)}
        />
      )}
    </header>
  );
}
