import { useMemo, useState, useEffect, useRef, useCallback } from "react";
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
import { isCompletedJourneyPresentationStatus, QuestJourneyTimeline } from "./QuestJourneyTimeline.js";
import { QuestInlineLink } from "./QuestInlineLink.js";
import {
  getQuestJourneyCurrentPhaseId,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  getQuestJourneyPresentation,
} from "../../shared/quest-journey.js";
import { parseCommandThreadComment, parseThreadTextPrefix } from "../../shared/thread-routing.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY, normalizeThreadKey } from "../utils/thread-projection.js";
import { requestThreadViewportSnapshot } from "../utils/thread-viewport.js";
import { buildAttentionRecords } from "../utils/attention-records.js";
import { scopedGetItem, scopedSetItem } from "../utils/scoped-storage.js";
import type { BoardRowSessionStatus, ChatMessage, QuestmasterTask, SessionAttentionRecord } from "../types.js";

type LeaderThreadRow = {
  threadKey: string;
  questId?: string;
  title: string;
  status?: string;
  boardStatus?: string;
  journey?: BoardRowData["journey"];
  boardRow?: BoardRowData;
  rowStatus?: BoardRowSessionStatus;
  messageCount: number;
  createdAt: number;
  section: "active" | "done";
};

const EMPTY_BOARD_ROWS: BoardRowData[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ATTENTION_RECORDS: SessionAttentionRecord[] = [];

function messageThreadKeys(message: ChatMessage): string[] {
  const keys = new Set<string>();
  const metadata = message.metadata;
  const addThreadKey = (threadKey: string | undefined) => {
    if (!threadKey || threadKey === "main") return;
    keys.add(threadKey.toLowerCase());
  };

  addThreadKey(metadata?.threadKey);
  addThreadKey(metadata?.questId);
  addThreadKey(metadata?.quest?.questId);
  for (const ref of metadata?.threadRefs ?? []) {
    addThreadKey(ref.threadKey);
  }

  const parsedContentPrefix = parseThreadTextPrefix(message.content);
  if (parsedContentPrefix.ok) {
    addThreadKey(parsedContentPrefix.target.threadKey);
  }

  for (const block of message.contentBlocks ?? []) {
    if (block.type === "text") {
      const parsedBlockPrefix = parseThreadTextPrefix(block.text);
      if (parsedBlockPrefix.ok) addThreadKey(parsedBlockPrefix.target.threadKey);
    }
    if (block.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string") {
      addThreadKey(parseCommandThreadComment(block.input.command)?.threadKey);
    }
  }
  return [...keys];
}

function buildLeaderThreadRows({
  activeBoard,
  completedBoard,
  messages,
  quests,
  rowSessionStatuses,
}: {
  activeBoard: BoardRowData[];
  completedBoard: BoardRowData[];
  messages: ChatMessage[];
  quests: QuestmasterTask[];
  rowSessionStatuses?: Record<string, BoardRowSessionStatus>;
}): LeaderThreadRow[] {
  const questById = new Map(quests.map((quest) => [quest.questId.toLowerCase(), quest]));
  const rows = new Map<string, LeaderThreadRow>();
  const counts = new Map<string, number>();
  const firstMessageAt = new Map<string, number>();

  for (const message of messages) {
    for (const key of messageThreadKeys(message)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      firstMessageAt.set(key, Math.min(firstMessageAt.get(key) ?? Number.POSITIVE_INFINITY, message.timestamp));
    }
  }

  const activeKeys = new Set(activeBoard.map((row) => row.questId.toLowerCase()));
  const boardRowById = new Map<string, BoardRowData>();
  for (const row of [...activeBoard, ...completedBoard]) {
    boardRowById.set(row.questId.toLowerCase(), row);
  }

  const creationTimeFor = (questId: string, row?: BoardRowData) => {
    const key = questId.toLowerCase();
    return (
      questById.get(key)?.createdAt ??
      row?.createdAt ??
      firstMessageAt.get(key) ??
      row?.updatedAt ??
      Number.MAX_SAFE_INTEGER
    );
  };

  const addQuestRow = (questId: string, partial: Partial<LeaderThreadRow> = {}) => {
    const key = questId.toLowerCase();
    const quest = questById.get(key);
    const existing = rows.get(key);
    const boardRow = partial.boardRow ?? existing?.boardRow ?? boardRowById.get(key);
    const messageCount = counts.get(key) ?? existing?.messageCount ?? 0;
    if (messageCount <= 0 && !boardRow) return;
    const section = activeKeys.has(key) ? "active" : "done";
    rows.set(key, {
      threadKey: key,
      questId: key,
      title: partial.title ?? existing?.title ?? quest?.title ?? questId,
      status: partial.status ?? existing?.status ?? quest?.status,
      boardStatus: partial.boardStatus ?? existing?.boardStatus,
      journey: partial.journey ?? existing?.journey,
      boardRow,
      rowStatus: partial.rowStatus ?? existing?.rowStatus ?? rowSessionStatuses?.[key],
      messageCount,
      createdAt: Math.min(
        partial.createdAt ?? Number.MAX_SAFE_INTEGER,
        existing?.createdAt ?? creationTimeFor(key, boardRow),
      ),
      section,
    });
  };

  for (const row of activeBoard) {
    const key = row.questId.toLowerCase();
    addQuestRow(row.questId, {
      title: row.title,
      boardStatus: row.status,
      journey: row.journey,
      boardRow: row,
      rowStatus: rowSessionStatuses?.[key],
      createdAt: creationTimeFor(key, row),
    });
  }
  for (const row of completedBoard) {
    const key = row.questId.toLowerCase();
    addQuestRow(row.questId, {
      title: row.title,
      boardStatus: row.status,
      journey: row.journey,
      boardRow: row,
      rowStatus: rowSessionStatuses?.[key],
      createdAt: creationTimeFor(key, row),
    });
  }
  for (const key of counts.keys()) {
    if (/^q-\d+$/.test(key)) {
      addQuestRow(key, { createdAt: creationTimeFor(key, boardRowById.get(key)) });
    }
  }

  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt || a.threadKey.localeCompare(b.threadKey));
}

function phaseLabelForThread(row: LeaderThreadRow): { label: string; color?: string } | null {
  if (row.journey?.phaseIds?.length) {
    if (isDoneThreadRow(row)) return { label: "Done" };
    const phase = getQuestJourneyPhase(getQuestJourneyCurrentPhaseId(row.journey, row.boardStatus));
    if (phase) return { label: phase.label, color: phase.color.accent };
  }
  const phase = getQuestJourneyPhaseForState(row.boardStatus);
  if (phase) return { label: phase.label, color: phase.color.accent };
  const presentation = getQuestJourneyPresentation(row.boardStatus);
  if (presentation) return { label: presentation.label };
  if (row.status === "needs_verification") return { label: "Verification" };
  if (row.status === "done") return { label: "Done" };
  return null;
}

function isDoneThreadRow(row: LeaderThreadRow): boolean {
  return (
    row.section === "done" ||
    isCompletedJourneyPresentationStatus(row.status) ||
    isCompletedJourneyPresentationStatus(row.boardStatus)
  );
}

function journeyStatusForThread(row: LeaderThreadRow): string | undefined {
  return isDoneThreadRow(row) ? "done" : row.boardStatus;
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

function useLeaderThreadModel(sessionId: string) {
  const activeBoard = useStore((s) => s.sessionBoards.get(sessionId) ?? EMPTY_BOARD_ROWS);
  const completedBoard = useStore((s) => s.sessionCompletedBoards.get(sessionId) ?? EMPTY_BOARD_ROWS);
  const messages = useStore((s) => s.messages.get(sessionId) ?? EMPTY_MESSAGES);
  const quests = useStore((s) => s.quests);
  const rowSessionStatuses = useStore((s) => s.sessionBoardRowStatuses.get(sessionId));
  const rows = useMemo(
    () => buildLeaderThreadRows({ activeBoard, completedBoard, messages, quests, rowSessionStatuses }),
    [activeBoard, completedBoard, messages, quests, rowSessionStatuses],
  );
  const activeRows = useMemo(() => rows.filter((row) => row.section === "active"), [rows]);
  const doneRows = useMemo(() => rows.filter((row) => row.section === "done"), [rows]);
  return { activeBoard, completedBoard, messages, rows, activeRows, doneRows };
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

function openThreadTabsKey(sessionId: string): string {
  return `cc-leader-open-thread-tabs:${sessionId}`;
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

function QuestThreadBanner({
  row,
  threadKey,
  onReturnToMain,
}: {
  row?: LeaderThreadRow;
  threadKey: string;
  onReturnToMain: () => void;
}) {
  const questId = row?.questId ?? threadKey.toLowerCase();
  const title = row?.title;
  const phase = row ? phaseLabelForThread(row) : null;
  return (
    <div className="shrink-0 border-b border-cc-border bg-cc-card/85 px-3 py-2" data-testid="quest-thread-banner">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="shrink-0 font-medium text-cc-muted">Viewing quest thread</span>
            <QuestInlineLink
              questId={questId}
              className="shrink-0 font-mono-code font-medium text-blue-300 hover:text-blue-200 hover:underline"
            >
              {questId}
            </QuestInlineLink>
            {title && <span className="min-w-0 truncate font-medium text-cc-fg">{title}</span>}
            {phase && (
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-cc-muted">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-current"
                  style={phase.color ? { color: phase.color } : undefined}
                  aria-hidden="true"
                />
                <span style={phase.color ? { color: phase.color } : undefined}>{phase.label}</span>
              </span>
            )}
          </div>
          {row?.journey && (
            <QuestJourneyTimeline
              journey={row.journey}
              status={journeyStatusForThread(row)}
              compact
              className="mt-1 text-[10px]"
            />
          )}
        </div>
        <button
          type="button"
          onClick={onReturnToMain}
          className="shrink-0 text-xs font-medium text-blue-300 hover:text-blue-200 hover:underline"
          data-testid="quest-thread-banner-return-main"
        >
          Return to Main
        </button>
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
        s.messages.has(sessionId) || s.sessionBoards.has(sessionId) || s.sessionCompletedBoards.has(sessionId),
    })),
  );
  const [selectedThreadKey, setSelectedThreadKey] = useState("main");
  const [openThreadTabKeys, setOpenThreadTabKeys] = useState(() => readOpenThreadTabKeys(sessionId));
  const { activeBoard, completedBoard, messages: allMessages, rows: threadRows } = useLeaderThreadModel(sessionId);
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
            records: persistedAttentionRecords,
            notifications: sessionNotifications,
            boardRows: activeBoard,
            completedBoardRows: completedBoard,
            messages: allMessages,
          })
        : EMPTY_ATTENTION_RECORDS,
    [
      activeBoard,
      allMessages,
      completedBoard,
      isLeaderSession,
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
      existing.includes(normalized) ? existing : normalizeOpenThreadTabKeys([...existing, normalized]),
    );
  }, []);
  const handleSelectThread = useCallback(
    (threadKey: string) => {
      const nextThreadKey = normalizeThreadKey(threadKey || MAIN_THREAD_KEY);
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
    if (routeSyncEnabled) return;
    setSelectedThreadKey(MAIN_THREAD_KEY);
  }, [routeSyncEnabled, sessionId]);

  useEffect(() => {
    setOpenThreadTabKeys(readOpenThreadTabKeys(sessionId));
  }, [sessionId]);

  useEffect(() => {
    scopedSetItem(openThreadTabsKey(sessionId), JSON.stringify(openThreadTabKeys));
  }, [openThreadTabKeys]);

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
          onReturnToMain={isLeaderSession ? () => handleSelectThread(MAIN_THREAD_KEY) : undefined}
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
            <QuestThreadBanner
              row={selectedThreadRow}
              threadKey={selectedThreadKey}
              onReturnToMain={() => handleSelectThread(MAIN_THREAD_KEY)}
            />
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
