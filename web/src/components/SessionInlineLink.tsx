import { useRef, useMemo, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useStore, countUserPermissions } from "../store.js";
import { navigateToSession, navigateToSessionMessage, sessionHash } from "../utils/routing.js";
import { SessionHoverCard } from "./SessionHoverCard.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

export function SessionInlineLink({
  sessionId,
  sessionNum,
  messageIndex,
  children,
  className,
  missingClassName,
}: {
  sessionId: string | null;
  sessionNum?: number | null;
  messageIndex?: number;
  children: ReactNode;
  className?: string;
  missingClassName?: string;
}) {
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);
  const sessionNames = useStore((s) => s.sessionNames);
  const sessionPreviews = useStore((s) => s.sessionPreviews);
  const sessionTaskHistory = useStore((s) => s.sessionTaskHistory);
  const pendingPermissions = useStore((s) => s.pendingPermissions);
  const cliConnected = useStore((s) => s.cliConnected);
  const sessionStatus = useStore((s) => s.sessionStatus);
  const askPermission = useStore((s) => s.askPermission);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason);

  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    },
    [],
  );

  const sdkInfo = useMemo(() => {
    if (sessionId) {
      return sdkSessions.find((session) => session.sessionId === sessionId) ?? null;
    }
    if (sessionNum != null) {
      return sdkSessions.find((session) => session.sessionNum === sessionNum) ?? null;
    }
    return null;
  }, [sdkSessions, sessionId, sessionNum]);
  const resolvedSessionId = sessionId ?? sdkInfo?.sessionId ?? null;
  const resolvedSessionNum = sdkInfo?.sessionNum ?? sessionNum ?? null;

  const sessionItem = useMemo<SessionItemType | null>(() => {
    if (!resolvedSessionId) return null;

    const bridgeState = sessions.get(resolvedSessionId);
    const sdkGitAhead = sdkInfo?.gitAhead ?? 0;
    const sdkGitBehind = sdkInfo?.gitBehind ?? 0;
    const gitAhead =
      bridgeState?.git_ahead === 0 && sdkGitAhead > 0 ? sdkGitAhead : (bridgeState?.git_ahead ?? sdkGitAhead);
    const gitBehind =
      bridgeState?.git_behind === 0 && sdkGitBehind > 0 ? sdkGitBehind : (bridgeState?.git_behind ?? sdkGitBehind);

    return {
      id: resolvedSessionId,
      model: bridgeState?.model || sdkInfo?.model || "",
      cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
      gitBranch: bridgeState?.git_branch || sdkInfo?.gitBranch || "",
      isContainerized: bridgeState?.is_containerized || !!sdkInfo?.containerId || false,
      gitAhead,
      gitBehind,
      linesAdded: bridgeState?.total_lines_added ?? sdkInfo?.totalLinesAdded ?? 0,
      linesRemoved: bridgeState?.total_lines_removed ?? sdkInfo?.totalLinesRemoved ?? 0,
      isConnected: cliConnected.get(resolvedSessionId) ?? sdkInfo?.cliConnected ?? false,
      status: sessionStatus.get(resolvedSessionId) ?? null,
      sdkState: sdkInfo?.state ?? null,
      createdAt: sdkInfo?.createdAt ?? 0,
      archived: sdkInfo?.archived ?? false,
      archivedAt: sdkInfo?.archivedAt,
      backendType: bridgeState?.backend_type || sdkInfo?.backendType || "claude",
      repoRoot: bridgeState?.repo_root || sdkInfo?.repoRoot || "",
      permCount: countUserPermissions(pendingPermissions.get(resolvedSessionId)),
      cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
      cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
      isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
      worktreeExists: sdkInfo?.worktreeExists,
      worktreeDirty: sdkInfo?.worktreeDirty,
      askPermission: askPermission.get(resolvedSessionId),
      idleKilled: cliDisconnectReason.get(resolvedSessionId) === "idle_limit",
      lastActivityAt: sdkInfo?.lastActivityAt,
      isOrchestrator: sdkInfo?.isOrchestrator || false,
      herdedBy: sdkInfo?.herdedBy,
      sessionNum: sdkInfo?.sessionNum ?? resolvedSessionNum,
    };
  }, [
    askPermission,
    cliConnected,
    cliDisconnectReason,
    pendingPermissions,
    resolvedSessionId,
    resolvedSessionNum,
    sdkInfo,
    sessionStatus,
    sessions,
  ]);

  function handleLinkMouseEnter(e: MouseEvent<HTMLAnchorElement>) {
    if (!sessionItem) return;
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    setHoverRect(e.currentTarget.getBoundingClientRect());
  }

  function handleLinkMouseLeave() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    hideHoverTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  function handleHoverCardEnter() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
  }

  function handleHoverCardLeave() {
    setHoverRect(null);
  }

  const href = resolvedSessionId
    ? messageIndex != null
      ? `${sessionHash(resolvedSessionId)}?msg=${messageIndex}`
      : sessionHash(resolvedSessionId)
    : "#";
  const sessionLabel = resolvedSessionNum != null ? `#${resolvedSessionNum}` : "session";
  const title = resolvedSessionId
    ? messageIndex != null
      ? `Open session ${sessionLabel}, message ${messageIndex}`
      : `Open session ${sessionLabel}`
    : `${sessionLabel} not found`;

  return (
    <>
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (!resolvedSessionId) return;
          if (messageIndex != null) {
            navigateToSessionMessage(resolvedSessionId, messageIndex);
          } else {
            navigateToSession(resolvedSessionId);
          }
        }}
        onMouseEnter={handleLinkMouseEnter}
        onMouseLeave={handleLinkMouseLeave}
        className={resolvedSessionId ? (className ?? "text-cc-primary hover:underline") : (missingClassName ?? "text-cc-muted")}
        title={title}
      >
        {children}
      </a>
      {resolvedSessionId && sessionItem && hoverRect && (
        <SessionHoverCard
          session={sessionItem}
          sessionName={sessionNames.get(resolvedSessionId)}
          sessionPreview={sessionPreviews.get(resolvedSessionId)}
          taskHistory={sessionTaskHistory.get(resolvedSessionId)}
          sessionState={sessions.get(resolvedSessionId)}
          cliSessionId={sdkInfo?.cliSessionId}
          anchorRect={hoverRect}
          onMouseEnter={handleHoverCardEnter}
          onMouseLeave={handleHoverCardLeave}
          messageIndex={messageIndex}
        />
      )}
    </>
  );
}
