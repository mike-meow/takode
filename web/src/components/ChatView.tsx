import {
  useMemo,
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import {
  PermissionBanner,
  PlanReviewOverlay,
  PlanCollapsedChip,
  PermissionsCollapsedChip,
} from "./PermissionBanner.js";
import { TaskOutlineBar } from "./TaskOutlineBar.js";
import { TodoStatusLine } from "./TodoStatusLine.js";
import { WorkBoardBar, type WorkBoardThreadNavigationRow } from "./WorkBoardBar.js";
import { YarnBallDot } from "./CatIcons.js";
import { SearchBar } from "./SearchBar.js";
import { useSessionSearch } from "../hooks/useSessionSearch.js";
import { navigateToSessionThread, threadRouteFromHash } from "../utils/routing.js";
import type { BoardRowData } from "./BoardTable.js";
import {
  isCompletedJourneyPresentationStatus,
  QuestJourneyPreviewCard,
  QuestJourneyTimeline,
} from "./QuestJourneyTimeline.js";
import { QuestInlineLink } from "./QuestInlineLink.js";
import { SessionInlineLink } from "./SessionInlineLink.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { useParticipantSessionStatusDotProps } from "./session-participant-status.js";
import {
  buildLeaderThreadRowsFromSummaries,
  collectLeaderThreadSummaries,
  mergeLeaderThreadSummaries,
} from "../../shared/leader-projection.js";
import {
  ALL_THREADS_KEY,
  MAIN_THREAD_KEY,
  normalizeThreadKey,
  isThreadAttachmentMarkerMessage,
} from "../utils/thread-projection.js";
import { requestThreadViewportSnapshot } from "../utils/thread-viewport.js";
import { buildAttentionRecords } from "../utils/attention-records.js";
import { scopedGetItem, scopedSetItem } from "../utils/scoped-storage.js";
import type {
  BoardRowSessionStatus,
  ChatMessage,
  LeaderProjectionSnapshot,
  QuestmasterTask,
  SessionAttentionRecord,
} from "../types.js";

export interface QuestThreadBannerRow {
  threadKey: string;
  questId?: string;
  title: string;
  status?: string;
  boardStatus?: string;
  journey?: BoardRowData["journey"];
  boardRow?: BoardRowData;
  rowStatus?: BoardRowSessionStatus;
  section?: "active" | "done";
}

type LeaderThreadRow = QuestThreadBannerRow & {
  messageCount: number;
  createdAt: number;
};

const EMPTY_BOARD_ROWS: BoardRowData[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ATTENTION_RECORDS: SessionAttentionRecord[] = [];

function isDoneThreadRow(row: QuestThreadBannerRow): boolean {
  return (
    row.section === "done" ||
    isCompletedJourneyPresentationStatus(row.status) ||
    isCompletedJourneyPresentationStatus(row.boardStatus)
  );
}

function journeyStatusForThread(row: QuestThreadBannerRow): string | undefined {
  return isDoneThreadRow(row) ? "done" : row.boardStatus;
}

function QuestJourneyHoverTarget({ row, children }: { row: QuestThreadBannerRow; children: ReactNode }) {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const zoomLevel = useStore((state) => state.zoomLevel ?? 1);
  const cardWidth = 380;
  const gap = 6;

  useEffect(
    () => () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!cardRef.current || !hoverRect) return;
    const rect = cardRef.current.getBoundingClientRect();
    const el = cardRef.current;
    if (rect.right > window.innerWidth - 8) {
      el.style.left = `${Math.max(8, window.innerWidth - cardWidth - 8)}px`;
    }
    if (rect.bottom > window.innerHeight - 8) {
      el.style.top = `${Math.max(8, hoverRect.top - rect.height - gap)}px`;
    }
    if (rect.top < 8) {
      el.style.top = "8px";
    }
  }, [hoverRect]);

  function showPreviewForTarget(target: HTMLElement) {
    if (!row.journey?.phaseIds?.length) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setHoverRect(target.getBoundingClientRect());
  }

  function showPreview(event: MouseEvent<HTMLDivElement>) {
    showPreviewForTarget(event.currentTarget);
  }

  function handlePreviewKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    showPreviewForTarget(event.currentTarget);
  }

  function scheduleHidePreview() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  return (
    <>
      <div
        className="inline-flex max-w-full min-w-0"
        onMouseEnter={showPreview}
        onMouseLeave={scheduleHidePreview}
        onClick={(event) => showPreviewForTarget(event.currentTarget)}
        onKeyDown={handlePreviewKeyDown}
        role={row.journey?.phaseIds?.length ? "button" : undefined}
        tabIndex={row.journey?.phaseIds?.length ? 0 : undefined}
        aria-label={row.journey?.phaseIds?.length ? "Show Quest Journey preview" : undefined}
        aria-haspopup={row.journey?.phaseIds?.length ? "dialog" : undefined}
        aria-expanded={hoverRect ? "true" : "false"}
        data-testid="quest-thread-journey-hover-target"
        data-touch-preview={row.journey?.phaseIds?.length ? "true" : "false"}
      >
        {children}
      </div>
      {row.journey &&
        hoverRect &&
        createPortal(
          <div
            ref={cardRef}
            className="fixed z-50 pointer-events-auto"
            style={{
              left: hoverRect.left,
              top: hoverRect.bottom + gap,
              width: cardWidth,
              transform: `scale(${zoomLevel})`,
              transformOrigin: "top left",
            }}
            onMouseEnter={() => {
              if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
            }}
            onMouseLeave={() => setHoverRect(null)}
            data-testid="quest-thread-journey-hover-card"
          >
            <div className="rounded-lg border border-cc-border bg-cc-card p-2.5 shadow-xl">
              <QuestJourneyPreviewCard
                journey={row.journey}
                status={journeyStatusForThread(row)}
                quest={{ questId: row.questId ?? row.threadKey, title: row.title }}
                onQuestClick={() => useStore.getState().openQuestOverlay(row.questId ?? row.threadKey)}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function QuestThreadParticipant({
  role,
  participant,
  fallbackSessionId,
  fallbackSessionNum,
}: {
  role: "Worker" | "Reviewer";
  participant?: BoardRowSessionStatus["worker"] | BoardRowSessionStatus["reviewer"];
  fallbackSessionId?: string;
  fallbackSessionNum?: number;
}) {
  const sessionId = participant?.sessionId ?? fallbackSessionId ?? null;
  const sessionNum = participant?.sessionNum ?? fallbackSessionNum ?? undefined;
  const dotProps = useParticipantSessionStatusDotProps(sessionId, participant?.status);
  if (!sessionId && sessionNum == null) return null;
  const label = `${role} #${sessionNum ?? "?"}${participant?.name ? ` ${participant.name}` : ""}`;

  return (
    <span
      className="inline-flex h-5 max-w-[9.5rem] min-w-0 items-center gap-1 rounded-full border border-cc-border/60 bg-cc-hover/25 px-1.5 text-[10px] leading-none text-cc-muted sm:max-w-[12rem]"
      data-testid="quest-thread-participant"
      title={label}
      aria-label={label}
    >
      {dotProps && <SessionStatusDot className="mt-0" {...dotProps} />}
      <span className="hidden shrink-0 text-cc-muted/75 sm:inline">{role}</span>
      {sessionId ? (
        <SessionInlineLink
          sessionId={sessionId}
          sessionNum={sessionNum}
          className="shrink-0 font-mono-code text-amber-400 hover:text-amber-300 hover:underline decoration-dotted underline-offset-2"
        >
          {`#${sessionNum ?? "?"}`}
        </SessionInlineLink>
      ) : (
        <span className="shrink-0 font-mono-code text-cc-muted">{`#${sessionNum ?? "?"}`}</span>
      )}
      {participant?.name && <span className="hidden min-w-0 truncate text-cc-fg/75 md:inline">{participant.name}</span>}
    </span>
  );
}

function CompactingIndicator({ sessionId }: { sessionId: string }) {
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  if (sessionStatus !== "compacting") return null;
  return (
    <div className="shrink-0 flex items-center gap-1.5 text-[11px] text-cc-muted font-mono-code px-4 py-1">
      <YarnBallDot className="text-cc-primary animate-pulse" />
      <span>Compacting conversation...</span>
    </div>
  );
}

function messageSummariesAfterProjection(messages: ChatMessage[], projection?: LeaderProjectionSnapshot) {
  if (!projection) return collectLeaderThreadSummaries(messages);
  return collectLeaderThreadSummaries(
    messages.filter((message) => {
      if (typeof message.historyIndex !== "number") return true;
      if (message.historyIndex < 0) return true;
      return message.historyIndex >= projection.sourceHistoryLength;
    }),
  );
}

function useLeaderThreadModel(sessionId: string, deferMessageDerivedRows = false) {
  const activeBoard = useStore((s) => s.sessionBoards.get(sessionId) ?? EMPTY_BOARD_ROWS);
  const completedBoard = useStore((s) => s.sessionCompletedBoards.get(sessionId) ?? EMPTY_BOARD_ROWS);
  const storedMessages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const leaderProjection = useStore((s) => s.leaderProjections.get(sessionId));
  const messages = deferMessageDerivedRows ? EMPTY_MESSAGES : storedMessages;
  const quests = useStore((s) => s.quests);
  const rowSessionStatuses = useStore((s) => s.sessionBoardRowStatuses.get(sessionId));
  const threadSummaries = useMemo(() => {
    const projected = leaderProjection?.threadSummaries ?? [];
    if (deferMessageDerivedRows) return projected;
    return mergeLeaderThreadSummaries(projected, messageSummariesAfterProjection(messages, leaderProjection));
  }, [deferMessageDerivedRows, leaderProjection, messages]);
  const rows = useMemo(
    () =>
      buildLeaderThreadRowsFromSummaries({
        activeBoard,
        completedBoard,
        threadSummaries,
        quests,
        rowSessionStatuses,
      }) as LeaderThreadRow[],
    [activeBoard, completedBoard, quests, rowSessionStatuses, threadSummaries],
  );
  const activeRows = useMemo(() => rows.filter((row) => row.section === "active"), [rows]);
  const doneRows = useMemo(() => rows.filter((row) => row.section === "done"), [rows]);
  return { activeBoard, completedBoard, leaderProjection, messages, rows, activeRows, doneRows };
}

function threadLabelForKey(threadKey: string, rows: LeaderThreadRow[]): string {
  const normalized = threadKey.toLowerCase();
  if (normalized === MAIN_THREAD_KEY) return "Main";
  if (normalized === ALL_THREADS_KEY) return "All Threads";
  const row = rows.find((candidate) => candidate.threadKey === normalized);
  return row?.questId ?? row?.title ?? threadKey;
}

function toWorkBoardThreadRows(rows: LeaderThreadRow[]): WorkBoardThreadNavigationRow[] {
  return rows.map((row) => ({
    threadKey: row.threadKey,
    questId: row.questId,
    title: row.title,
    messageCount: row.messageCount,
    section: row.section,
  }));
}

function attentionRouteTitle(record: SessionAttentionRecord): string {
  const questId = record.route.questId ?? record.questId;
  if (!questId) return record.title;
  const prefix = `${questId}:`;
  return record.title.startsWith(prefix) ? record.title.slice(prefix.length).trim() || questId : record.title;
}

function mergeAttentionThreadRows(
  rows: LeaderThreadRow[],
  attentionRecords: ReadonlyArray<SessionAttentionRecord>,
): LeaderThreadRow[] {
  if (attentionRecords.length === 0) return rows;
  const byKey = new Map(rows.map((row) => [row.threadKey, row]));
  for (const record of attentionRecords) {
    const threadKey = normalizeThreadKey(record.route.threadKey || record.threadKey);
    if (!threadKey || threadKey === MAIN_THREAD_KEY || threadKey === ALL_THREADS_KEY || byKey.has(threadKey)) continue;
    const questId = record.route.questId ?? record.questId;
    byKey.set(threadKey, {
      threadKey,
      ...(questId ? { questId } : {}),
      title: attentionRouteTitle(record),
      messageCount: 0,
      createdAt: record.createdAt,
      section: "active",
    });
  }
  return [...byKey.values()].sort((a, b) => a.createdAt - b.createdAt || a.threadKey.localeCompare(b.threadKey));
}

function isQuestThreadKey(threadKey: string): boolean {
  return /^q-\d+$/i.test(threadKey.trim());
}

function composeThreadKeyForSelection(threadKey: string): string {
  const normalized = threadKey.trim().toLowerCase();
  if (normalized === ALL_THREADS_KEY) return MAIN_THREAD_KEY;
  return normalized;
}

function threadAttachmentMarkerKey(message: ChatMessage): string | null {
  const marker = message.metadata?.threadAttachmentMarker;
  if (!marker) return null;
  return marker.markerKey || marker.id || message.id;
}

function markerIncludesMessage(
  marker: NonNullable<ChatMessage["metadata"]>["threadAttachmentMarker"],
  message: ChatMessage,
): boolean {
  if (!marker) return false;
  if (marker.messageIds.includes(message.id)) return true;
  return typeof message.historyIndex === "number" && marker.messageIndices.includes(message.historyIndex);
}

function newestUserAuthoredMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return null;
}

function markerMovesNewestUserMessage(
  marker: NonNullable<ChatMessage["metadata"]>["threadAttachmentMarker"],
  messages: ChatMessage[],
): boolean {
  const newestUserMessage = newestUserAuthoredMessage(messages);
  return !!newestUserMessage && markerIncludesMessage(marker, newestUserMessage);
}

function openThreadTabsKey(sessionId: string): string {
  return `cc-leader-open-thread-tabs:${sessionId}`;
}

function boardThreadKeySet(board: BoardRowData[]): Set<string> {
  return new Set(board.map((row) => normalizeThreadKey(row.questId)));
}

function shouldPersistOpenThreadTab(threadKey: string): boolean {
  const normalized = normalizeThreadKey(threadKey);
  return normalized !== "" && normalized !== MAIN_THREAD_KEY && normalized !== ALL_THREADS_KEY;
}

function normalizeOpenThreadTabKeys(threadKeys: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of threadKeys) {
    if (typeof value !== "string") continue;
    const key = normalizeThreadKey(value);
    if (!shouldPersistOpenThreadTab(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function placeOpenThreadTabKey(
  existingThreadKeys: ReadonlyArray<string>,
  threadKey: string,
  placement: "first" | "last",
): string[] {
  const normalized = normalizeThreadKey(threadKey);
  if (!shouldPersistOpenThreadTab(normalized)) return normalizeOpenThreadTabKeys(existingThreadKeys);
  const withoutTarget = normalizeOpenThreadTabKeys(existingThreadKeys).filter((key) => key !== normalized);
  return placement === "first" ? [normalized, ...withoutTarget] : [...withoutTarget, normalized];
}

function readOpenThreadTabKeys(sessionId: string): string[] {
  if (typeof window === "undefined") return [];
  const raw = scopedGetItem(openThreadTabsKey(sessionId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeOpenThreadTabKeys(parsed) : [];
  } catch {
    return [];
  }
}

function isAvailableLeaderThread(threadKey: string, rows: LeaderThreadRow[]): boolean {
  const normalized = normalizeThreadKey(threadKey);
  if (normalized === MAIN_THREAD_KEY || normalized === ALL_THREADS_KEY) return true;
  return rows.some((row) => row.threadKey === normalized);
}

export function QuestThreadBanner({ row, threadKey }: { row?: QuestThreadBannerRow; threadKey: string }) {
  const questId = row?.questId ?? threadKey.toLowerCase();
  const title = row?.title;
  const hasParticipantContext = !!(row?.rowStatus?.worker || row?.boardRow?.worker || row?.rowStatus?.reviewer);
  const hasMeta = !!row?.journey || hasParticipantContext;
  return (
    <div
      className="shrink-0 border-b border-cc-border/80 bg-cc-bg/95 px-2.5 py-1 sm:px-3"
      data-testid="quest-thread-banner"
      data-layout="compact-inline"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <div className="inline-flex min-w-0 max-w-full flex-[1_1_16rem] items-baseline gap-1.5">
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/65">Thread</span>
          <QuestInlineLink
            questId={questId}
            className="shrink-0 font-mono-code font-medium text-blue-300 hover:text-blue-200 hover:underline"
          >
            {questId}
          </QuestInlineLink>
          {title && <span className="min-w-0 truncate text-xs font-medium text-cc-fg sm:text-[13px]">{title}</span>}
        </div>
        {hasMeta && (
          <div
            className="inline-flex min-w-0 flex-[1_1_auto] flex-wrap items-center gap-1.5 sm:flex-[0_1_auto] sm:justify-end"
            data-testid="quest-thread-meta-strip"
          >
            {row?.journey && (
              <QuestJourneyHoverTarget row={row}>
                <QuestJourneyTimeline
                  journey={row.journey}
                  status={journeyStatusForThread(row)}
                  compact
                  showNotes={false}
                  className="rounded-full border border-cc-border/55 bg-cc-hover/20 px-1.5 py-0.5"
                />
              </QuestJourneyHoverTarget>
            )}
            {hasParticipantContext && (
              <div className="inline-flex min-w-0 items-center gap-1.5" data-testid="quest-thread-participant-strip">
                <QuestThreadParticipant
                  role="Worker"
                  participant={row?.rowStatus?.worker}
                  fallbackSessionId={row?.boardRow?.worker}
                  fallbackSessionNum={row?.boardRow?.workerNum}
                />
                <QuestThreadParticipant role="Reviewer" participant={row?.rowStatus?.reviewer} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatView({
  sessionId,
  preview = false,
  routeThreadKey,
  hasThreadRoute,
}: {
  sessionId: string;
  preview?: boolean;
  routeThreadKey?: string | null;
  hasThreadRoute?: boolean;
}) {
  const {
    sessionPerms,
    connStatus,
    backendState,
    backendError,
    cliConnected,
    cliEverConnected,
    cliDisconnectReason,
    isArchived,
    isLeaderSession,
    historyLoading,
    hasKnownThreadSources,
  } = useStore(
    useShallow((s) => ({
      sessionPerms: s.pendingPermissions.get(sessionId),
      connStatus: s.connectionStatus.get(sessionId) ?? "disconnected",
      backendState: s.sessions.get(sessionId)?.backend_state ?? "disconnected",
      backendError: s.sessions.get(sessionId)?.backend_error ?? null,
      cliConnected: s.cliConnected.get(sessionId) ?? false,
      cliEverConnected: s.cliEverConnected.get(sessionId) ?? false,
      cliDisconnectReason: s.cliDisconnectReason.get(sessionId) ?? null,
      isArchived: s.sdkSessions.find((sdk) => sdk.sessionId === sessionId)?.archived ?? false,
      isLeaderSession:
        s.sessions.get(sessionId)?.isOrchestrator === true ||
        s.sdkSessions.some((sdk) => sdk.sessionId === sessionId && sdk.isOrchestrator === true),
      historyLoading: s.historyLoading.get(sessionId) ?? false,
      hasKnownThreadSources:
        s.messages.has(sessionId) ||
        s.leaderProjections.has(sessionId) ||
        s.sessionBoards.has(sessionId) ||
        s.sessionCompletedBoards.has(sessionId),
    })),
  );
  const [selectedThreadKey, setSelectedThreadKey] = useState("main");
  const [openThreadTabKeys, setOpenThreadTabKeys] = useState(() => readOpenThreadTabKeys(sessionId));
  const {
    activeBoard,
    completedBoard,
    leaderProjection,
    messages: allMessages,
    rows: threadRows,
  } = useLeaderThreadModel(sessionId, historyLoading);
  const sessionNotifications = useStore((s) => s.sessionNotifications.get(sessionId));
  const persistedAttentionRecords = useStore((s) => s.sessionAttentionRecords.get(sessionId));
  const routeSyncEnabled = hasThreadRoute !== undefined || routeThreadKey !== undefined;
  const showQuestThreadBanner =
    isLeaderSession &&
    selectedThreadKey.toLowerCase() !== MAIN_THREAD_KEY &&
    selectedThreadKey.toLowerCase() !== ALL_THREADS_KEY &&
    isQuestThreadKey(selectedThreadKey);
  const composerThreadKey = isLeaderSession ? composeThreadKeyForSelection(selectedThreadKey) : MAIN_THREAD_KEY;
  const composerQuestId = isLeaderSession && isQuestThreadKey(composerThreadKey) ? composerThreadKey : undefined;
  const attentionRecords = useMemo(
    () =>
      isLeaderSession
        ? buildAttentionRecords({
            leaderSessionId: sessionId,
            records: [...(persistedAttentionRecords ?? []), ...(leaderProjection?.messageAttentionRecords ?? [])],
            notifications: sessionNotifications,
            boardRows: activeBoard,
            completedBoardRows: completedBoard,
            messages: leaderProjection || historyLoading ? EMPTY_MESSAGES : allMessages,
          })
        : EMPTY_ATTENTION_RECORDS,
    [
      activeBoard,
      allMessages,
      completedBoard,
      historyLoading,
      isLeaderSession,
      leaderProjection,
      persistedAttentionRecords,
      sessionId,
      sessionNotifications,
    ],
  );
  const navigationThreadRows = useMemo(
    () => mergeAttentionThreadRows(threadRows, attentionRecords),
    [attentionRecords, threadRows],
  );
  const selectedThreadLabel = useMemo(
    () => threadLabelForKey(selectedThreadKey, navigationThreadRows),
    [navigationThreadRows, selectedThreadKey],
  );
  const selectedThreadRow = useMemo(
    () => navigationThreadRows.find((row) => row.threadKey === selectedThreadKey.toLowerCase()),
    [navigationThreadRows, selectedThreadKey],
  );
  const workBoardThreadRows = useMemo(() => toWorkBoardThreadRows(navigationThreadRows), [navigationThreadRows]);
  const openThreadTab = useCallback((threadKey: string) => {
    const normalized = normalizeThreadKey(threadKey);
    if (!shouldPersistOpenThreadTab(normalized)) return;
    setOpenThreadTabKeys((existing) =>
      existing.includes(normalized) ? existing : placeOpenThreadTabKey(existing, normalized, "first"),
    );
  }, []);
  const previousActiveBoardThreadKeysRef = useRef<Set<string> | null>(null);
  const recentlyInactiveBoardThreadKeysRef = useRef<Set<string>>(new Set());
  const lastManualThreadSelectionAtRef = useRef(0);
  const initializedAttachmentMarkerKeysRef = useRef(false);
  const baselineAttachmentMarkersAfterHistoryLoadRef = useRef(false);
  const observedAttachmentMarkerKeysRef = useRef<Set<string>>(new Set());
  const handleSelectThread = useCallback(
    (threadKey: string) => {
      const nextThreadKey = normalizeThreadKey(threadKey || MAIN_THREAD_KEY);
      lastManualThreadSelectionAtRef.current = Date.now();
      openThreadTab(nextThreadKey);
      if (nextThreadKey === normalizeThreadKey(selectedThreadKey)) return;
      requestThreadViewportSnapshot(sessionId);
      setSelectedThreadKey(nextThreadKey);
      if (!preview) {
        navigateToSessionThread(sessionId, nextThreadKey);
      }
    },
    [openThreadTab, preview, selectedThreadKey, sessionId],
  );
  const handleCloseThreadTab = useCallback(
    (threadKey: string) => {
      const normalized = normalizeThreadKey(threadKey);
      setOpenThreadTabKeys((existing) => existing.filter((key) => key !== normalized));
      if (normalizeThreadKey(selectedThreadKey) === normalized) {
        handleSelectThread(MAIN_THREAD_KEY);
      }
    },
    [handleSelectThread, selectedThreadKey],
  );

  useEffect(() => {
    initializedAttachmentMarkerKeysRef.current = false;
    baselineAttachmentMarkersAfterHistoryLoadRef.current = false;
    observedAttachmentMarkerKeysRef.current = new Set();
    lastManualThreadSelectionAtRef.current = 0;
    previousActiveBoardThreadKeysRef.current = null;
    recentlyInactiveBoardThreadKeysRef.current = new Set();
  }, [sessionId]);

  useEffect(() => {
    if (routeSyncEnabled) return;
    setSelectedThreadKey(MAIN_THREAD_KEY);
  }, [routeSyncEnabled, sessionId]);

  useEffect(() => {
    setOpenThreadTabKeys(readOpenThreadTabKeys(sessionId));
  }, [sessionId]);

  useEffect(() => {
    scopedSetItem(openThreadTabsKey(sessionId), JSON.stringify(openThreadTabKeys));
  }, [openThreadTabKeys, sessionId]);

  useEffect(() => {
    if (!isLeaderSession || preview) return;
    const currentActiveKeys = boardThreadKeySet(activeBoard);
    const previousActiveKeys = previousActiveBoardThreadKeysRef.current;
    previousActiveBoardThreadKeysRef.current = currentActiveKeys;
    if (!previousActiveKeys) return;

    const recentlyInactiveKeys = recentlyInactiveBoardThreadKeysRef.current;
    for (const key of previousActiveKeys) {
      if (!currentActiveKeys.has(key)) recentlyInactiveKeys.add(key);
    }
    for (const key of currentActiveKeys) {
      recentlyInactiveKeys.delete(key);
    }

    const completedKeys = boardThreadKeySet(completedBoard);
    const selectedThread = normalizeThreadKey(selectedThreadKey || MAIN_THREAD_KEY);
    const completedInactiveKeys = [...recentlyInactiveKeys].filter((key) => completedKeys.has(key));
    for (const key of completedInactiveKeys) {
      recentlyInactiveKeys.delete(key);
    }

    const newlyCompletedKeys = completedInactiveKeys.filter((key) => key !== selectedThread);
    if (newlyCompletedKeys.length === 0) return;

    const newlyCompleted = new Set(newlyCompletedKeys);
    setOpenThreadTabKeys((existing) => existing.filter((key) => !newlyCompleted.has(key)));
  }, [activeBoard, completedBoard, isLeaderSession, preview, selectedThreadKey]);

  useEffect(() => {
    if (!routeSyncEnabled || preview) return;
    const liveThreadRoute = threadRouteFromHash(window.location.hash);
    if (liveThreadRoute.hasThreadParam !== hasThreadRoute || liveThreadRoute.threadKey !== (routeThreadKey ?? null)) {
      return;
    }

    if (!isLeaderSession) {
      if (selectedThreadKey !== MAIN_THREAD_KEY) {
        setSelectedThreadKey(MAIN_THREAD_KEY);
      }
      if (hasThreadRoute) {
        navigateToSessionThread(sessionId, MAIN_THREAD_KEY, true);
      }
      return;
    }

    if (!hasThreadRoute) {
      if (selectedThreadKey !== MAIN_THREAD_KEY) {
        setSelectedThreadKey(MAIN_THREAD_KEY);
      }
      return;
    }

    if (!routeThreadKey) {
      if (selectedThreadKey !== MAIN_THREAD_KEY) {
        setSelectedThreadKey(MAIN_THREAD_KEY);
      }
      navigateToSessionThread(sessionId, MAIN_THREAD_KEY, true);
      return;
    }

    const nextThreadKey = normalizeThreadKey(routeThreadKey);
    if (isAvailableLeaderThread(nextThreadKey, navigationThreadRows)) {
      openThreadTab(nextThreadKey);
      if (selectedThreadKey !== nextThreadKey) {
        setSelectedThreadKey(nextThreadKey);
      }
      if (nextThreadKey === MAIN_THREAD_KEY && hasThreadRoute) {
        navigateToSessionThread(sessionId, MAIN_THREAD_KEY, true);
      }
      return;
    }

    if (!historyLoading && hasKnownThreadSources) {
      if (selectedThreadKey !== MAIN_THREAD_KEY) {
        setSelectedThreadKey(MAIN_THREAD_KEY);
      }
      navigateToSessionThread(sessionId, MAIN_THREAD_KEY, true);
    }
  }, [
    hasKnownThreadSources,
    hasThreadRoute,
    historyLoading,
    isLeaderSession,
    preview,
    routeSyncEnabled,
    routeThreadKey,
    selectedThreadKey,
    sessionId,
    navigationThreadRows,
    openThreadTab,
  ]);

  useEffect(() => {
    if (!isLeaderSession || preview) return;
    if (historyLoading) {
      baselineAttachmentMarkersAfterHistoryLoadRef.current = true;
      return;
    }

    const currentMarkerKeys = new Set<string>();
    const unseenMarkers: ChatMessage[] = [];
    for (const message of allMessages) {
      if (!isThreadAttachmentMarkerMessage(message)) continue;
      const markerKey = threadAttachmentMarkerKey(message);
      if (!markerKey) continue;
      currentMarkerKeys.add(markerKey);
      if (initializedAttachmentMarkerKeysRef.current && !observedAttachmentMarkerKeysRef.current.has(markerKey)) {
        unseenMarkers.push(message);
      }
    }

    if (!initializedAttachmentMarkerKeysRef.current || baselineAttachmentMarkersAfterHistoryLoadRef.current) {
      initializedAttachmentMarkerKeysRef.current = true;
      baselineAttachmentMarkersAfterHistoryLoadRef.current = false;
      observedAttachmentMarkerKeysRef.current = currentMarkerKeys;
      return;
    }

    if (unseenMarkers.length === 0) {
      observedAttachmentMarkerKeysRef.current = currentMarkerKeys;
      return;
    }

    let nextSelectedThreadKey: string | null = null;
    const selectedThread = normalizeThreadKey(selectedThreadKey || MAIN_THREAD_KEY);
    const hasSpecificRouteThread =
      hasThreadRoute === true && routeThreadKey !== null && routeThreadKey !== undefined && routeThreadKey !== "";

    for (const message of unseenMarkers) {
      const marker = message.metadata?.threadAttachmentMarker;
      if (!marker) continue;
      const targetThreadKey = normalizeThreadKey(marker.threadKey || marker.questId || "");
      if (!shouldPersistOpenThreadTab(targetThreadKey)) continue;

      const wasOpen = openThreadTabKeys.includes(targetThreadKey);
      if (!wasOpen) {
        setOpenThreadTabKeys((existing) => placeOpenThreadTabKey(existing, targetThreadKey, "first"));
      }

      const manualNavigationAfterAttachment = lastManualThreadSelectionAtRef.current > marker.attachedAt;
      const sourceStillSelected = selectedThread === MAIN_THREAD_KEY;
      const routeAllowsAutoSelect =
        !hasSpecificRouteThread || normalizeThreadKey(routeThreadKey ?? "") === MAIN_THREAD_KEY;
      if (
        !wasOpen &&
        !nextSelectedThreadKey &&
        sourceStillSelected &&
        routeAllowsAutoSelect &&
        !manualNavigationAfterAttachment &&
        markerMovesNewestUserMessage(marker, allMessages)
      ) {
        nextSelectedThreadKey = targetThreadKey;
      }
    }

    observedAttachmentMarkerKeysRef.current = currentMarkerKeys;

    if (nextSelectedThreadKey && nextSelectedThreadKey !== selectedThread) {
      requestThreadViewportSnapshot(sessionId);
      setSelectedThreadKey(nextSelectedThreadKey);
      if (!preview) {
        navigateToSessionThread(sessionId, nextSelectedThreadKey);
      }
    }
  }, [
    allMessages,
    hasThreadRoute,
    historyLoading,
    isLeaderSession,
    openThreadTabKeys,
    preview,
    routeThreadKey,
    selectedThreadKey,
    sessionId,
  ]);

  // Within-session search
  const searchInputRef = useRef<HTMLInputElement>(null);
  useSessionSearch(sessionId, !preview);

  const perms = useMemo(() => (sessionPerms ? Array.from(sessionPerms.values()) : []), [sessionPerms]);

  // Separate plan permission from other permissions
  const planPerm = perms.find((p) => p.tool_name === "ExitPlanMode") || null;
  const otherPerms = perms.filter((p) => p.tool_name !== "ExitPlanMode");

  // Plan collapse state — auto-expand when a new plan arrives
  const [planCollapsed, setPlanCollapsed] = useState(false);
  const planPermId = planPerm?.request_id;
  useEffect(() => {
    if (planPermId) setPlanCollapsed(false);
  }, [planPermId]);

  const showPlanOverlay = planPerm && !planCollapsed;

  // Permissions collapse state — auto-expand only when new permissions arrive
  const [permsCollapsed, setPermsCollapsed] = useState(false);
  const prevOtherPermsCount = useRef(0);
  useEffect(() => {
    if (otherPerms.length > prevOtherPermsCount.current) {
      setPermsCollapsed(false);
    }
    prevOtherPermsCount.current = otherPerms.length;
  }, [otherPerms.length]);

  const showStartingBanner =
    connStatus === "connected" &&
    !cliConnected &&
    backendState !== "broken" &&
    (backendState === "initializing" ||
      backendState === "resuming" ||
      backendState === "recovering" ||
      !cliEverConnected);
  const isResumeMissingRolloutError =
    backendError?.includes("could not be resumed because its local rollout is missing or unreadable") ?? false;
  return (
    <div className="relative flex flex-col h-full min-h-0">
      {preview ? (
        <div className="shrink-0 px-4 py-2 border-b border-cc-border bg-cc-card/80 text-[11px] text-cc-muted font-medium">
          Previewing search result. Press Enter to select this conversation.
        </div>
      ) : (
        /* Within-session message search bar */
        <SearchBar sessionId={sessionId} inputRef={searchInputRef} />
      )}

      {/* CLI starting / resuming banner */}
      {!preview && showStartingBanner && (
        <div className="px-4 py-2 bg-cc-border/30 border-b border-cc-border text-center flex items-center justify-center gap-2">
          <svg
            className="animate-spin h-3 w-3 text-cc-text-secondary"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-xs text-cc-text-secondary font-medium">
            {backendState === "recovering"
              ? "Recovering session..."
              : backendState === "resuming" || cliEverConnected
                ? "Reconnecting session..."
                : "Starting session..."}
          </span>
        </div>
      )}

      {/* Broken session banner */}
      {!preview && connStatus === "connected" && !cliConnected && backendState === "broken" && (
        <div className="px-4 py-2 bg-cc-warning/10 border-b border-cc-warning/20 text-center flex items-center justify-center gap-3">
          <span className="text-xs text-cc-warning font-medium">
            {backendError || "CLI failed to recover. Relaunch to resume queued messages."}
          </span>
          <button
            onClick={() => api.relaunchSession(sessionId).catch(console.error)}
            className="text-xs font-medium px-3 py-1 rounded-md bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-warning transition-colors cursor-pointer"
          >
            {isResumeMissingRolloutError ? "Start Fresh" : "Relaunch"}
          </button>
        </div>
      )}

      {/* CLI disconnected banner (CLI was connected before but dropped) */}
      {!preview &&
        connStatus === "connected" &&
        !cliConnected &&
        cliEverConnected &&
        backendState !== "broken" &&
        backendState !== "initializing" &&
        backendState !== "resuming" &&
        backendState !== "recovering" && (
          <div
            className={`px-4 py-2 border-b text-center flex items-center justify-center gap-3 ${
              cliDisconnectReason === "idle_limit"
                ? "bg-cc-border/30 border-cc-border"
                : "bg-cc-warning/10 border-cc-warning/20"
            }`}
          >
            <span
              className={`text-xs font-medium ${
                cliDisconnectReason === "idle_limit" ? "text-cc-text-secondary" : "text-cc-warning"
              }`}
            >
              {cliDisconnectReason === "idle_limit"
                ? "Session paused to stay within keep-alive limit"
                : "CLI disconnected"}
            </span>
            <button
              onClick={() => api.relaunchSession(sessionId).catch(console.error)}
              className={`text-xs font-medium px-3 py-1 rounded-md transition-colors cursor-pointer ${
                cliDisconnectReason === "idle_limit"
                  ? "bg-cc-hover hover:bg-cc-border text-cc-fg"
                  : "bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-warning"
              }`}
            >
              Resume
            </button>
          </div>
        )}

      {/* WebSocket disconnected banner */}
      {!preview && connStatus === "disconnected" && (
        <div className="px-4 py-2 bg-cc-warning/10 border-b border-cc-warning/20 text-center">
          <span className="text-xs text-cc-warning font-medium">Reconnecting to session...</span>
        </div>
      )}

      {/* Archived session banner */}
      {!preview && isArchived && (
        <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/25 flex items-center justify-center gap-3">
          <span className="text-xs text-amber-300 font-medium">This session is archived.</span>
          <button
            onClick={() => api.unarchiveSession(sessionId).catch(console.error)}
            className="text-xs font-medium px-3 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 transition-colors cursor-pointer"
          >
            Unarchive
          </button>
        </div>
      )}

      {/* Session task outline — horizontal milestone chips */}
      {!preview && <TaskOutlineBar sessionId={sessionId} />}

      {/* Persistent work board for orchestrator sessions -- primary thread navigation above the feed */}
      {!preview && (
        <WorkBoardBar
          sessionId={sessionId}
          currentThreadKey={isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY}
          currentThreadLabel={isLeaderSession ? selectedThreadLabel : "Main"}
          onSelectThread={isLeaderSession ? handleSelectThread : undefined}
          openThreadKeys={isLeaderSession ? openThreadTabKeys : undefined}
          onCloseThreadTab={isLeaderSession ? handleCloseThreadTab : undefined}
          threadRows={isLeaderSession ? workBoardThreadRows : undefined}
          attentionRecords={isLeaderSession ? attentionRecords : undefined}
        />
      )}

      {/* Plan overlay fills the chat area, OR show the normal message feed */}
      {!preview && showPlanOverlay ? (
        <PlanReviewOverlay permission={planPerm} sessionId={sessionId} onCollapse={() => setPlanCollapsed(true)} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {!preview && showQuestThreadBanner && (
            <QuestThreadBanner row={selectedThreadRow} threadKey={selectedThreadKey} />
          )}
          <MessageFeed
            sessionId={sessionId}
            threadKey={isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY}
            onSelectThread={isLeaderSession ? handleSelectThread : undefined}
          />
        </div>
      )}

      {/* Collapsed plan chip (when plan exists but is collapsed) */}
      {!preview && planPerm && planCollapsed && (
        <div className="shrink-0 border-t border-cc-border bg-cc-card px-2 sm:px-4 py-2">
          <PlanCollapsedChip permission={planPerm} sessionId={sessionId} onExpand={() => setPlanCollapsed(false)} />
        </div>
      )}

      {/* Non-plan permission banners — collapsible */}
      {!preview &&
        otherPerms.length > 0 &&
        (permsCollapsed ? (
          <PermissionsCollapsedChip permissions={otherPerms} onExpand={() => setPermsCollapsed(false)} />
        ) : (
          <div className="shrink-0 max-h-[60dvh] overflow-y-auto border-t border-cc-border bg-cc-card">
            <div
              onClick={() => setPermsCollapsed(true)}
              className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-cc-card border-b border-cc-border/50 cursor-pointer hover:bg-cc-hover/50 transition-colors"
              role="button"
              title="Minimize approvals"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning">
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="text-[11px] font-medium text-cc-warning">
                {otherPerms.length} pending approval{otherPerms.length !== 1 ? "s" : ""}
              </span>
              <span className="ml-auto p-1.5 rounded-md text-cc-muted">
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
                  <path d="M4 8h4" />
                </svg>
              </span>
            </div>
            {otherPerms.map((p) => (
              <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
            ))}
          </div>
        ))}

      {/* Compacting indicator — fixed above composer, green like running state */}
      {!preview && <CompactingIndicator sessionId={sessionId} />}

      {/* Active todo status — shows current in-progress task */}
      {!preview && <TodoStatusLine sessionId={sessionId} />}

      {/* Composer */}
      {!preview && <Composer sessionId={sessionId} threadKey={composerThreadKey} questId={composerQuestId} />}
    </div>
  );
}
