/**
 * Shared board table rendering used by both the inline BoardBlock (chat feed)
 * and the persistent WorkBoardBar (bottom widget for orchestrator sessions).
 *
 * Extracted so the table layout, QuestLink hover cards, and WorkerLink hover
 * cards are defined once and reused.
 */
import { useState, useRef, useMemo, useEffect, useCallback, useLayoutEffect, memo, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store.js";
import {
  QUEST_JOURNEY_STATES,
  formatWaitForRefLabel,
  getQuestJourneyPresentation,
  getQuestJourneyPhaseForState,
  getWaitForRefKind,
  type QuestJourneyPlanState,
} from "../../shared/quest-journey.js";
import { QuestHoverCard } from "./QuestHoverCard.js";
import { SessionInlineLink } from "./SessionInlineLink.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { QuestJourneyPreviewCard, QuestJourneyTimeline } from "./QuestJourneyTimeline.js";
import type { BoardParticipantStatus, BoardRowSessionStatus } from "../types.js";
import type { QuestmasterTask } from "../types.js";

/** A row in the leader's work board (matches server BoardRow). */
export interface BoardRowData {
  questId: string;
  title?: string;
  worker?: string;
  workerNum?: number;
  journey?: QuestJourneyPlanState;
  status?: string;
  waitFor?: string[];
  waitForInput?: string[];
  createdAt?: number;
  updatedAt: number;
  completedAt?: number;
}

export type BoardTableMode = "active" | "completed";

const SESSION_LINK_CLASSNAME =
  "font-mono-code text-amber-400 hover:text-amber-300 hover:underline decoration-dotted underline-offset-2";

const JOURNEY_STATUS_PRIORITY = new Map([...QUEST_JOURNEY_STATES].reverse().map((status, index) => [status, index]));

function statusPriority(status?: string): number {
  if (!status) return Number.MAX_SAFE_INTEGER - 1;
  return JOURNEY_STATUS_PRIORITY.get(status as (typeof QUEST_JOURNEY_STATES)[number]) ?? Number.MAX_SAFE_INTEGER;
}

function compareByRecencyDesc(a: BoardRowData, b: BoardRowData): number {
  return b.updatedAt - a.updatedAt || a.questId.localeCompare(b.questId);
}

function isQueuedRowStatus(status?: string): boolean {
  return (status || "").trim().toUpperCase() === "QUEUED";
}

function topologicallySortStatusGroup(rows: BoardRowData[]): BoardRowData[] {
  if (rows.length <= 1) return [...rows];

  const rowById = new Map(rows.map((row) => [row.questId.toLowerCase(), row]));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const row of rows) {
    const key = row.questId.toLowerCase();
    indegree.set(key, 0);
    outgoing.set(key, []);
  }

  for (const row of rows) {
    const from = row.questId.toLowerCase();
    const deps = new Set(
      (row.waitFor ?? [])
        .map((dep) => dep.toLowerCase())
        .filter((dep) => dep.startsWith("q-") && rowById.has(dep) && dep !== from),
    );
    for (const dep of deps) {
      outgoing.get(dep)!.push(from);
      indegree.set(from, (indegree.get(from) ?? 0) + 1);
    }
  }

  const queue = rows.filter((row) => (indegree.get(row.questId.toLowerCase()) ?? 0) === 0).sort(compareByRecencyDesc);
  const result: BoardRowData[] = [];

  while (queue.length > 0) {
    const row = queue.shift()!;
    result.push(row);
    for (const neighbor of outgoing.get(row.questId.toLowerCase()) ?? []) {
      const next = (indegree.get(neighbor) ?? 0) - 1;
      indegree.set(neighbor, next);
      if (next === 0) {
        queue.push(rowById.get(neighbor)!);
        queue.sort(compareByRecencyDesc);
      }
    }
  }

  if (result.length !== rows.length) {
    return [...rows].sort(compareByRecencyDesc);
  }

  return result;
}

export function orderBoardRows(board: BoardRowData[], mode: BoardTableMode = "active"): BoardRowData[] {
  if (board.length <= 1) return [...board];
  if (mode === "completed") return [...board].sort(compareByRecencyDesc);

  const grouped = new Map<string, BoardRowData[]>();
  for (const row of board) {
    const key = row.status ?? "";
    const existing = grouped.get(key);
    if (existing) existing.push(row);
    else grouped.set(key, [row]);
  }

  return [...grouped.entries()]
    .sort(([statusA], [statusB]) => {
      const byPriority = statusPriority(statusA || undefined) - statusPriority(statusB || undefined);
      if (byPriority !== 0) return byPriority;
      return statusA.localeCompare(statusB);
    })
    .flatMap(([status, rows]) =>
      isQueuedRowStatus(status) ? topologicallySortStatusGroup(rows) : rows.sort(compareByRecencyDesc),
    );
}

export function formatCompletedTime(timestamp?: number): string {
  if (!timestamp || timestamp <= 0) return "\u2014";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
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

/** Clickable session link with the shared orange inline-session styling. */
export function WorkerLink({ sessionId, sessionNum }: { sessionId: string; sessionNum?: number }) {
  return (
    <SessionInlineLink sessionId={sessionId} sessionNum={sessionNum} className={SESSION_LINK_CLASSNAME}>
      {`#${sessionNum ?? "?"}`}
    </SessionInlineLink>
  );
}

function dotPropsForParticipant(status: BoardParticipantStatus["status"]) {
  if (status === "archived") {
    return { archived: true, permCount: 0, isConnected: false, sdkState: "exited" as const, status: null };
  }
  if (status === "disconnected") {
    return { permCount: 0, isConnected: false, sdkState: "exited" as const, status: null };
  }
  if (status === "running") {
    return { permCount: 0, isConnected: true, sdkState: "running" as const, status: "running" as const };
  }
  return { permCount: 0, isConnected: true, sdkState: "connected" as const, status: "idle" as const };
}

function BoardSessionEntry({
  participant,
  sessionId,
  sessionNum,
}: {
  participant?: BoardParticipantStatus | null;
  sessionId?: string;
  sessionNum?: number;
}) {
  const resolvedSessionId = participant?.sessionId ?? sessionId ?? null;
  const resolvedSessionNum = participant?.sessionNum ?? sessionNum ?? undefined;
  if (!resolvedSessionId) return null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {participant && <SessionStatusDot className="mt-0" {...dotPropsForParticipant(participant.status)} />}
      <SessionInlineLink
        sessionId={resolvedSessionId}
        sessionNum={resolvedSessionNum}
        className={SESSION_LINK_CLASSNAME}
      >
        {`#${resolvedSessionNum ?? "?"}`}
      </SessionInlineLink>
    </span>
  );
}

function SessionCell({ row, rowStatus }: { row: BoardRowData; rowStatus?: BoardRowSessionStatus }) {
  const hasWorker = !!row.worker || !!rowStatus?.worker;
  const hasReviewer = !!rowStatus?.reviewer;
  if (!hasWorker && !hasReviewer) return <span className="text-cc-muted">{"\u2014"}</span>;

  return (
    <div className="flex min-w-0 flex-row flex-wrap items-center gap-x-3 gap-y-1">
      {hasWorker && (
        <BoardSessionEntry participant={rowStatus?.worker} sessionId={row.worker} sessionNum={row.workerNum} />
      )}
      {hasReviewer && <BoardSessionEntry participant={rowStatus?.reviewer} />}
    </div>
  );
}

/** Renders a single wait-for dependency -- QuestLink for q-N, WorkerLink for #N. */
function WaitForRef({ depRef }: { depRef: string }) {
  const sdkSessions = useStore((s) => s.sdkSessions);

  if (getWaitForRefKind(depRef) === "session") {
    const num = parseInt(depRef.slice(1), 10);
    const session = sdkSessions.find((s) => s.sessionNum === num);
    if (session) {
      return <WorkerLink sessionId={session.sessionId} sessionNum={num} />;
    }
    // Session not found in store -- render as plain text
    return <span className="font-mono-code text-cc-muted">{depRef}</span>;
  }
  if (getWaitForRefKind(depRef) === "quest") {
    return <QuestLink questId={depRef} />;
  }
  return <span className="text-cc-muted">{formatWaitForRefLabel(depRef)}</span>;
}

function WaitForInputRef({ notificationId }: { notificationId: string }) {
  const match = /^n-(\d+)$/i.exec(notificationId.trim());
  return <span className="text-amber-200/90">{`input ${match ? match[1] : notificationId}`}</span>;
}

function JourneyHoverCard({
  row,
  quest,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
}: {
  row: BoardRowData;
  quest?: QuestmasterTask;
  anchorRect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const zoomLevel = useStore((state) => state.zoomLevel ?? 1);
  const cardWidth = 380;
  const gap = 6;
  const left = anchorRect.left;
  const top = anchorRect.bottom + gap;

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const el = cardRef.current;
    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${Math.max(8, window.innerWidth - cardWidth - 8)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = `${Math.max(8, anchorRect.top - rect.height - gap)}px`;
    }
    if (rect.top < 8) {
      el.style.top = "8px";
    }
  }, [anchorRect]);

  if (!row.journey) return null;

  return createPortal(
    <div
      ref={cardRef}
      className="fixed z-50 pointer-events-auto hidden-on-touch"
      style={{ left, top, width: cardWidth, transform: `scale(${zoomLevel})`, transformOrigin: "top left" }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-testid="board-journey-hover-card"
    >
      <div className="rounded-lg border border-cc-border bg-cc-card p-2.5 shadow-xl">
        <QuestJourneyPreviewCard
          journey={row.journey}
          status={row.status}
          quest={{ questId: row.questId, title: quest?.title ?? row.title }}
          onQuestClick={() => useStore.getState().openQuestOverlay(row.questId)}
        />
      </div>
    </div>,
    document.body,
  );
}

function StatusCell({ row }: { row: BoardRowData }) {
  const status = row.status;
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
    () => quests.find((candidate) => candidate.questId.toLowerCase() === row.questId.toLowerCase()),
    [quests, row.questId],
  );

  function handleJourneyMouseEnter(e: MouseEvent<HTMLDivElement>) {
    if (!row.journey?.phaseIds?.length) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setHoverRect(e.currentTarget.getBoundingClientRect());
  }

  function handleJourneyMouseLeave() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  if (!status) return <span className="text-cc-muted">{"\u2014"}</span>;

  if (row.journey?.phaseIds?.length) {
    return (
      <>
        <div
          className="max-w-full"
          onMouseEnter={handleJourneyMouseEnter}
          onMouseLeave={handleJourneyMouseLeave}
          data-testid="board-journey-hover-target"
        >
          <QuestJourneyTimeline journey={row.journey} status={row.status} compact />
        </div>
        {hoverRect && (
          <JourneyHoverCard
            row={row}
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

  const phase = getQuestJourneyPhaseForState(status);
  if (phase) {
    return (
      <span className="block max-w-full truncate text-cc-fg" style={{ color: phase.color.accent }}>
        {phase.label}
      </span>
    );
  }

  const presentation = getQuestJourneyPresentation(status);
  return <span className="block max-w-full truncate text-cc-muted">{presentation?.label ?? status}</span>;
}

/** Shared board table -- renders the rows without any card chrome or collapse logic. */
export const BoardTable = memo(function BoardTable({
  board,
  mode = "active",
  rowSessionStatuses,
}: {
  board: BoardRowData[];
  mode?: BoardTableMode;
  rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
}) {
  if (board.length === 0) {
    return <div className="px-3 py-3 text-xs text-cc-muted italic">Board is empty</div>;
  }

  const isCompleted = mode === "completed";
  const orderedBoard = useMemo(() => orderBoardRows(board, mode), [board, mode]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-cc-muted border-b border-cc-border">
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Quest</th>
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap min-w-[8rem]">Sessions</th>
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Journey</th>
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">Title</th>
            <th className="text-left font-medium px-3 py-1.5 whitespace-nowrap">
              {isCompleted ? "Completed Time" : "Wait For"}
            </th>
          </tr>
        </thead>
        <tbody>
          {orderedBoard.map((row) => (
            <tr key={row.questId} className="border-b border-cc-border last:border-0 hover:bg-cc-hover/30">
              <td className="px-3 py-1.5 whitespace-nowrap">
                <QuestLink questId={row.questId} />
              </td>
              <td className="px-3 py-1.5 min-w-[8rem] whitespace-normal">
                <SessionCell row={row} rowStatus={rowSessionStatuses?.[row.questId]} />
              </td>
              <td className="px-3 py-1.5 max-w-[360px]">
                <StatusCell row={row} />
              </td>
              <td className="px-3 py-1.5 text-cc-fg max-w-[200px] truncate">{row.title || "\u2014"}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                {isCompleted ? (
                  <span
                    className="text-cc-muted"
                    title={row.completedAt ? new Date(row.completedAt).toLocaleString() : ""}
                  >
                    {formatCompletedTime(row.completedAt)}
                  </span>
                ) : (
                  <>
                    {(isQueuedRowStatus(row.status) && row.waitFor && row.waitFor.length > 0) ||
                    (!isQueuedRowStatus(row.status) && row.waitForInput && row.waitForInput.length > 0) ? (
                      <span className="flex gap-1.5 flex-wrap">
                        {isQueuedRowStatus(row.status)
                          ? row.waitFor?.map((dep) => <WaitForRef key={dep} depRef={dep} />)
                          : row.waitForInput?.map((notificationId) => (
                              <WaitForInputRef key={notificationId} notificationId={notificationId} />
                            ))}
                      </span>
                    ) : (
                      <span className="text-cc-muted">{"\u2014"}</span>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
