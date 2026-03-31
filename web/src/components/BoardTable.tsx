/**
 * Shared board table rendering used by both the inline BoardBlock (chat feed)
 * and the persistent WorkBoardBar (bottom widget for orchestrator sessions).
 *
 * Extracted so the table layout, QuestLink hover cards, and WorkerLink hover
 * cards are defined once and reused.
 */
import { useState, useRef, useCallback, useMemo, useEffect, memo, type MouseEvent } from "react";
import { useStore, countUserPermissions } from "../store.js";
import { navigateToSession } from "../utils/routing.js";
import { QuestHoverCard } from "./QuestHoverCard.js";
import { SessionHoverCard } from "./SessionHoverCard.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";

/** A row in the leader's work board (matches server BoardRow). */
export interface BoardRowData {
  questId: string;
  title?: string;
  worker?: string;
  workerNum?: number;
  status?: string;
  waitFor?: string[];
  createdAt?: number;
  updatedAt: number;
}

/** Clickable quest ID link with hover preview card -- navigates to Questmaster detail view. */
export function QuestLink({ questId }: { questId: string }) {
  const quests = useStore((s) => s.quests);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const quest = useMemo(
    () => quests.find((q) => q.questId.toLowerCase() === questId.toLowerCase()) ?? null,
    [questId, quests],
  );

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      useStore.getState().openQuestOverlay(questId);
    },
    [questId],
  );

  function handleMouseEnter(e: MouseEvent<HTMLButtonElement>) {
    if (!quest) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setHoverRect(e.currentTarget.getBoundingClientRect());
  }

  function handleMouseLeave() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="font-mono-code text-blue-400 hover:text-blue-300 hover:underline cursor-pointer transition-colors"
      >
        {questId}
      </button>
      {quest && hoverRect && (
        <QuestHoverCard
          quest={quest}
          anchorRect={hoverRect}
          onMouseEnter={() => {
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          }}
          onMouseLeave={() => setHoverRect(null)}
        />
      )}
    </>
  );
}

/** Clickable worker session link with hover preview card -- navigates to the worker session. */
export function WorkerLink({ sessionId, sessionNum }: { sessionId: string; sessionNum?: number }) {
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
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  // Resolve SDK session info for this worker
  const sdkInfo = useMemo(() => sdkSessions.find((s) => s.sessionId === sessionId), [sdkSessions, sessionId]);

  // Assemble the full SessionItem for the hover card
  const sessionItem = useMemo<SessionItemType | null>(() => {
    const bridgeState = sessions.get(sessionId);
    if (!bridgeState && !sdkInfo) return null;

    const sdkGitAhead = sdkInfo?.gitAhead ?? 0;
    const sdkGitBehind = sdkInfo?.gitBehind ?? 0;
    const gitAhead =
      bridgeState?.git_ahead === 0 && sdkGitAhead > 0 ? sdkGitAhead : (bridgeState?.git_ahead ?? sdkGitAhead);
    const gitBehind =
      bridgeState?.git_behind === 0 && sdkGitBehind > 0 ? sdkGitBehind : (bridgeState?.git_behind ?? sdkGitBehind);

    return {
      id: sessionId,
      model: bridgeState?.model || sdkInfo?.model || "",
      cwd: bridgeState?.cwd || sdkInfo?.cwd || "",
      gitBranch: bridgeState?.git_branch || sdkInfo?.gitBranch || "",
      isContainerized: bridgeState?.is_containerized || !!sdkInfo?.containerId || false,
      gitAhead,
      gitBehind,
      linesAdded: bridgeState?.total_lines_added ?? sdkInfo?.totalLinesAdded ?? 0,
      linesRemoved: bridgeState?.total_lines_removed ?? sdkInfo?.totalLinesRemoved ?? 0,
      isConnected: cliConnected.get(sessionId) ?? sdkInfo?.cliConnected ?? false,
      status: sessionStatus.get(sessionId) ?? null,
      sdkState: sdkInfo?.state ?? null,
      createdAt: sdkInfo?.createdAt ?? 0,
      archived: sdkInfo?.archived ?? false,
      archivedAt: sdkInfo?.archivedAt,
      backendType: bridgeState?.backend_type || sdkInfo?.backendType || "claude",
      repoRoot: bridgeState?.repo_root || sdkInfo?.repoRoot || "",
      permCount: countUserPermissions(pendingPermissions.get(sessionId)),
      cronJobId: bridgeState?.cronJobId || sdkInfo?.cronJobId,
      cronJobName: bridgeState?.cronJobName || sdkInfo?.cronJobName,
      isWorktree: bridgeState?.is_worktree || sdkInfo?.isWorktree || false,
      worktreeExists: sdkInfo?.worktreeExists,
      worktreeDirty: sdkInfo?.worktreeDirty,
      askPermission: askPermission.get(sessionId),
      idleKilled: cliDisconnectReason.get(sessionId) === "idle_limit",
      lastActivityAt: sdkInfo?.lastActivityAt,
      isOrchestrator: sdkInfo?.isOrchestrator || false,
      herdedBy: sdkInfo?.herdedBy,
      sessionNum: sdkInfo?.sessionNum ?? sessionNum ?? null,
    };
  }, [
    askPermission,
    cliConnected,
    cliDisconnectReason,
    pendingPermissions,
    sdkInfo,
    sessionId,
    sessionNum,
    sessionStatus,
    sessions,
  ]);

  const handleClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      navigateToSession(sessionId);
    },
    [sessionId],
  );

  function handleMouseEnter(e: MouseEvent<HTMLButtonElement>) {
    if (!sessionItem) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setHoverRect(e.currentTarget.getBoundingClientRect());
  }

  function handleMouseLeave() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="font-mono-code text-green-400 hover:text-green-300 hover:underline cursor-pointer transition-colors"
      >
        #{sessionNum ?? "?"}
      </button>
      {sessionItem && hoverRect && (
        <SessionHoverCard
          session={sessionItem}
          sessionName={sessionNames.get(sessionId)}
          sessionPreview={sessionPreviews.get(sessionId)}
          taskHistory={sessionTaskHistory.get(sessionId)}
          sessionState={sessions.get(sessionId)}
          cliSessionId={sdkInfo?.cliSessionId}
          anchorRect={hoverRect}
          onMouseEnter={() => {
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          }}
          onMouseLeave={() => setHoverRect(null)}
        />
      )}
    </>
  );
}

/** Shared board table -- renders the rows without any card chrome or collapse logic. */
export const BoardTable = memo(function BoardTable({ board }: { board: BoardRowData[] }) {
  if (board.length === 0) {
    return <div className="px-3 py-3 text-xs text-cc-muted italic">Board is empty</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-cc-muted border-b border-cc-border">
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Quest</th>
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Title</th>
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Worker</th>
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Wait For</th>
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Status</th>
          </tr>
        </thead>
        <tbody>
          {board.map((row) => (
            <tr key={row.questId} className="border-b border-cc-border last:border-0 hover:bg-cc-hover/30">
              <td className="px-3 py-1.5 whitespace-nowrap">
                <QuestLink questId={row.questId} />
              </td>
              <td className="px-3 py-1.5 text-cc-fg max-w-[200px] truncate">{row.title || "\u2014"}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                {row.worker ? (
                  <WorkerLink sessionId={row.worker} sessionNum={row.workerNum} />
                ) : (
                  <span className="text-cc-muted">{"\u2014"}</span>
                )}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                {row.waitFor && row.waitFor.length > 0 ? (
                  <span className="flex gap-1.5 flex-wrap">
                    {row.waitFor.map((qId) => (
                      <QuestLink key={qId} questId={qId} />
                    ))}
                  </span>
                ) : (
                  <span className="text-cc-muted">{"\u2014"}</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-cc-muted max-w-[250px] truncate">{row.status || "\u2014"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
