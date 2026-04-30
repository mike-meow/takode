/**
 * Persistent work board widget for orchestrator sessions.
 *
 * Positioned above the message feed in ChatView. Shows a thin
 * summary bar (collapsed, default) that expands on click to show the full
 * board table. Once opened, it stays open until the user explicitly collapses
 * it. Visible for orchestrator sessions even before the first board item exists
 * because it is also the primary Main / All Threads / quest navigator.
 */
import type { CSSProperties } from "react";
import { useMemo, useState, useEffect } from "react";
import { useStore } from "../store.js";
import {
  getQuestJourneyCurrentPhaseId,
  getQuestJourneyPhase,
  getQuestJourneyPresentation,
} from "../../shared/quest-journey.js";
import { BoardTable, orderBoardRows } from "./BoardTable.js";
import type { BoardRowData } from "./BoardTable.js";
import { scopedGetItem, scopedSetItem } from "../utils/scoped-storage.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY, isMainThreadKey } from "../utils/thread-projection.js";
import { isAttentionRecordActive, type AttentionRecord } from "../utils/attention-records.js";

export interface WorkBoardThreadNavigationRow {
  threadKey: string;
  questId?: string;
  title: string;
  messageCount?: number;
  section?: "active" | "done";
}

export interface BoardSummarySegment {
  text: string;
  className: string;
  style?: CSSProperties;
}

/**
 * Build a compact status summary for the collapsed board bar.
 * Active phase colors come from phase metadata; non-phase statuses stay neutral.
 */
export function boardSummary(board: BoardRowData[], completedCount: number): BoardSummarySegment[] {
  if (board.length === 0 && completedCount === 0) return [{ text: "Empty", className: "text-cc-muted" }];
  const counts = new Map<string, { count: number; className: string; style?: CSSProperties }>();
  for (const row of orderBoardRows(board)) {
    const currentPhase = getQuestJourneyPhase(getQuestJourneyCurrentPhaseId(row.journey, row.status));
    const presentation = getQuestJourneyPresentation(row.status);
    const label = currentPhase?.label ?? presentation?.label ?? row.status ?? "unknown";
    const className = currentPhase ? "text-cc-fg" : presentation ? "text-cc-muted" : "text-cc-fg/80";
    const style = currentPhase ? { color: currentPhase.color.accent } : undefined;
    const entry = counts.get(label);
    if (entry) entry.count++;
    else counts.set(label, { count: 1, className, style });
  }
  const segments: BoardSummarySegment[] = [...counts.entries()].map(([label, { count, className, style }]) => ({
    text: `${count} ${label}`,
    className,
    ...(style ? { style } : {}),
  }));
  if (completedCount > 0) segments.push({ text: `${completedCount} done`, className: "text-cc-muted" });
  return segments;
}

function workBoardExpandedKey(sessionId: string): string {
  return `cc-work-board-expanded:${sessionId}`;
}

function readExpandedState(sessionId: string): boolean {
  if (typeof window === "undefined") return false;
  return scopedGetItem(workBoardExpandedKey(sessionId)) === "1";
}

function normalizeThreadKey(threadKey: string): string {
  return threadKey.trim().toLowerCase();
}

function isSelectedThread(currentThreadKey: string, targetThreadKey: string): boolean {
  return normalizeThreadKey(currentThreadKey) === normalizeThreadKey(targetThreadKey);
}

function rowMatchesQuery(row: BoardRowData, query: string): boolean {
  if (!query) return true;
  return [row.questId, row.title, row.status, row.worker, row.workerNum?.toString(), ...(row.waitFor ?? [])]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(query));
}

function threadRowMatchesQuery(row: WorkBoardThreadNavigationRow, query: string): boolean {
  if (!query) return true;
  return [row.threadKey, row.questId, row.title, row.section, row.messageCount?.toString()]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(query));
}

function ThreadNavButton({
  label,
  detail,
  selected,
  onClick,
  testId,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
        selected
          ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
          : "border-cc-border/70 bg-cc-hover/35 text-cc-muted hover:bg-cc-hover/65 hover:text-cc-fg"
      }`}
      data-testid={testId}
      aria-pressed={selected}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${selected ? "bg-cc-primary" : "bg-cc-muted/50"}`}
        aria-hidden="true"
      />
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-medium">{label}</span>
        {detail && <span className="block truncate text-[10px] text-cc-muted/80">{detail}</span>}
      </span>
    </button>
  );
}

interface PrimaryThreadChip {
  threadKey: string;
  questId?: string;
  title: string;
  detail?: string;
  messageCount?: number;
  needsInput: boolean;
  route?: AttentionRecord["route"];
  updatedAt: number;
}

function OtherThreadList({
  rows,
  currentThreadKey,
  onSelectThread,
}: {
  rows: WorkBoardThreadNavigationRow[];
  currentThreadKey: string;
  onSelectThread: (threadKey: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="border-t border-cc-border px-3 py-2" data-testid="workboard-off-board-threads">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-cc-muted/70">Other Threads</div>
      <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => {
          const selected = isSelectedThread(currentThreadKey, row.threadKey);
          const count = row.messageCount ?? 0;
          const detail = `${count} message${count === 1 ? "" : "s"}`;
          return (
            <ThreadNavButton
              key={row.threadKey}
              label={row.questId ? `${row.questId} ${row.title}` : row.title}
              detail={detail}
              selected={selected}
              onClick={() => onSelectThread(row.threadKey)}
              testId="workboard-off-board-thread"
            />
          );
        })}
      </div>
    </div>
  );
}

function recordThreadKey(record: AttentionRecord): string {
  return normalizeThreadKey(record.route.threadKey || record.threadKey || record.questId || "main");
}

function isPrimaryThreadAttention(record: AttentionRecord): boolean {
  if (!isAttentionRecordActive(record)) return false;
  if (record.priority === "review" || record.priority === "completed") return false;
  return record.type !== "review_ready" && record.type !== "quest_completed_recent";
}

function isNeedsInputAttention(record: AttentionRecord): boolean {
  return isAttentionRecordActive(record) && record.priority === "needs_input" && record.type === "needs_input";
}

function boardRowDetail(row: BoardRowData): string | undefined {
  if ((row.waitForInput?.length ?? 0) > 0) return "Needs input";
  const currentPhase = getQuestJourneyPhase(getQuestJourneyCurrentPhaseId(row.journey, row.status));
  if (currentPhase) return currentPhase.label;
  const presentation = getQuestJourneyPresentation(row.status);
  if (presentation) return presentation.label;
  return row.status;
}

function threadRowDetail(row: WorkBoardThreadNavigationRow): string {
  const count = row.messageCount ?? 0;
  return `${count} message${count === 1 ? "" : "s"}`;
}

function doneThreadDetail(row?: WorkBoardThreadNavigationRow): string {
  if (!row) return "History";
  if (row.section === "done") return "Done";
  return threadRowDetail(row);
}

function mergePrimaryThreadChip(chips: Map<string, PrimaryThreadChip>, chip: PrimaryThreadChip) {
  const existing = chips.get(chip.threadKey);
  if (!existing) {
    chips.set(chip.threadKey, chip);
    return;
  }
  chips.set(chip.threadKey, {
    ...existing,
    questId: existing.questId ?? chip.questId,
    title: existing.title || chip.title,
    detail: existing.needsInput ? existing.detail : (chip.detail ?? existing.detail),
    messageCount: Math.max(existing.messageCount ?? 0, chip.messageCount ?? 0),
    needsInput: existing.needsInput || chip.needsInput,
    route: existing.route ?? chip.route,
    updatedAt: Math.max(existing.updatedAt, chip.updatedAt),
  });
}

function buildPrimaryThreadChips({
  activeBoardRows,
  threadRows,
  attentionRecords,
}: {
  activeBoardRows: BoardRowData[];
  threadRows: WorkBoardThreadNavigationRow[];
  attentionRecords: ReadonlyArray<AttentionRecord>;
}): PrimaryThreadChip[] {
  const chips = new Map<string, PrimaryThreadChip>();
  const primaryAttentionByThread = new Map<string, AttentionRecord[]>();

  for (const record of attentionRecords) {
    if (!isPrimaryThreadAttention(record)) continue;
    const key = recordThreadKey(record);
    const existing = primaryAttentionByThread.get(key);
    if (existing) existing.push(record);
    else primaryAttentionByThread.set(key, [record]);
  }

  const boardRowKeys = new Set<string>();
  for (const row of orderBoardRows(activeBoardRows)) {
    const threadKey = normalizeThreadKey(row.questId);
    boardRowKeys.add(threadKey);
    const attention = primaryAttentionByThread.get(threadKey) ?? [];
    mergePrimaryThreadChip(chips, {
      threadKey,
      questId: row.questId,
      title: row.title ?? row.questId,
      detail: boardRowDetail(row),
      needsInput: (row.waitForInput?.length ?? 0) > 0 || attention.some(isNeedsInputAttention),
      route: attention[0]?.route,
      updatedAt: Math.max(row.updatedAt, ...attention.map((record) => record.updatedAt), 0),
    });
  }

  for (const row of threadRows) {
    const threadKey = normalizeThreadKey(row.threadKey);
    if (row.section !== "active" || boardRowKeys.has(threadKey)) continue;
    const attention = primaryAttentionByThread.get(threadKey) ?? [];
    if (attention.length === 0) continue;
    mergePrimaryThreadChip(chips, {
      threadKey,
      questId: row.questId,
      title: row.title,
      detail: threadRowDetail(row),
      messageCount: row.messageCount,
      needsInput: attention.some(isNeedsInputAttention),
      route: attention[0]?.route,
      updatedAt: Math.max(...attention.map((record) => record.updatedAt), 0),
    });
  }

  for (const records of primaryAttentionByThread.values()) {
    const record = records[0];
    const threadKey = recordThreadKey(record);
    if (chips.has(threadKey)) continue;
    mergePrimaryThreadChip(chips, {
      threadKey,
      questId: record.route.questId ?? record.questId,
      title: record.title,
      detail: record.actionLabel,
      needsInput: records.some(isNeedsInputAttention),
      route: record.route,
      updatedAt: Math.max(...records.map((candidate) => candidate.updatedAt), 0),
    });
  }

  return [...chips.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.threadKey.localeCompare(b.threadKey));
}

function buildOpenThreadTabs({
  openThreadKeys,
  threadRows,
  activeThreadChips,
  activeBoardRows,
  completedBoardRows,
}: {
  openThreadKeys: ReadonlyArray<string>;
  threadRows: WorkBoardThreadNavigationRow[];
  activeThreadChips: PrimaryThreadChip[];
  activeBoardRows: BoardRowData[];
  completedBoardRows: BoardRowData[];
}): PrimaryThreadChip[] {
  const activeByKey = new Map(activeThreadChips.map((chip) => [chip.threadKey, chip]));
  const rowByKey = new Map(threadRows.map((row) => [normalizeThreadKey(row.threadKey), row]));
  const boardByKey = new Map(
    [...activeBoardRows, ...completedBoardRows].map((row) => [normalizeThreadKey(row.questId), row]),
  );
  const seen = new Set<string>();
  const tabs: PrimaryThreadChip[] = [];

  for (const rawKey of openThreadKeys) {
    const threadKey = normalizeThreadKey(rawKey);
    if (!threadKey || threadKey === MAIN_THREAD_KEY || threadKey === ALL_THREADS_KEY || seen.has(threadKey)) continue;
    seen.add(threadKey);

    const active = activeByKey.get(threadKey);
    const row = rowByKey.get(threadKey);
    const boardRow = boardByKey.get(threadKey);
    if (!active && !row && !boardRow) continue;

    tabs.push({
      threadKey,
      questId: active?.questId ?? row?.questId ?? boardRow?.questId,
      title: active?.title ?? row?.title ?? boardRow?.title ?? threadKey,
      detail: active?.detail ?? (boardRow ? boardRowDetail(boardRow) : doneThreadDetail(row)),
      messageCount: active?.messageCount ?? row?.messageCount,
      needsInput: active?.needsInput ?? (boardRow?.waitForInput?.length ?? 0) > 0,
      route: active?.route,
      updatedAt: active?.updatedAt ?? boardRow?.updatedAt ?? 0,
    });
  }

  return tabs;
}

function ThreadTabRail({
  tabs,
  closedChips,
  sessionId,
  currentThreadKey,
  onSelectThread,
  onCloseThreadTab,
}: {
  tabs: PrimaryThreadChip[];
  closedChips: PrimaryThreadChip[];
  sessionId: string;
  currentThreadKey: string;
  onSelectThread?: (threadKey: string) => void;
  onCloseThreadTab?: (threadKey: string) => void;
}) {
  const openThread = (threadKey: string, route?: AttentionRecord["route"]) => {
    const targetThread = normalizeThreadKey(threadKey || MAIN_THREAD_KEY);
    const selectedThread = normalizeThreadKey(currentThreadKey || "main");
    const scrollToRouteTarget = () => {
      if (!route?.messageId) return;
      const store = useStore.getState();
      store.requestScrollToMessage(sessionId, route.messageId);
      store.setExpandAllInTurn(sessionId, route.messageId);
    };

    if (onSelectThread && (selectedThread === ALL_THREADS_KEY || selectedThread !== targetThread)) {
      onSelectThread(targetThread);
      setTimeout(scrollToRouteTarget, 0);
      return;
    }

    scrollToRouteTarget();
  };

  return (
    <div
      className="border-b border-cc-border bg-cc-card px-3 py-1.5 sm:px-4"
      data-testid="thread-tab-rail"
      data-open-tab-count={tabs.length + 1}
      data-closed-chip-count={closedChips.length}
    >
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-cc-muted/70">Tabs</span>
        <button
          type="button"
          onClick={() => openThread(MAIN_THREAD_KEY)}
          className={`inline-flex max-w-[12rem] shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
            isSelectedThread(currentThreadKey, MAIN_THREAD_KEY)
              ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
              : "border-cc-border/70 bg-cc-hover/35 text-cc-muted hover:bg-cc-hover/65 hover:text-cc-fg"
          }`}
          data-testid="thread-main-tab"
          data-thread-key={MAIN_THREAD_KEY}
          aria-pressed={isSelectedThread(currentThreadKey, MAIN_THREAD_KEY)}
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              isSelectedThread(currentThreadKey, MAIN_THREAD_KEY) ? "bg-cc-primary" : "bg-cc-muted/50"
            }`}
            aria-hidden="true"
          />
          <span>Main</span>
        </button>
        {tabs.map((tab) => {
          const selected = isSelectedThread(currentThreadKey, tab.threadKey);
          const tone = tab.needsInput
            ? "border-amber-400/35 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
            : selected
              ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
              : "border-cc-border/70 bg-cc-hover/35 text-cc-muted hover:bg-cc-hover/65 hover:text-cc-fg";
          const dot = tab.needsInput ? "bg-amber-400" : selected ? "bg-cc-primary" : "bg-cc-muted/50";
          return (
            <button
              key={tab.threadKey}
              type="button"
              onClick={() => openThread(tab.threadKey, tab.route)}
              title={tab.questId ? `${tab.questId}: ${tab.title}` : tab.title}
              className={`inline-flex max-w-[18rem] shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${tone}`}
              data-testid="thread-tab"
              data-thread-key={tab.threadKey}
              data-needs-input={tab.needsInput ? "true" : "false"}
              aria-pressed={selected}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
              {tab.questId && <span className="shrink-0 font-mono-code">{tab.questId}</span>}
              <span className="min-w-0 truncate">{tab.title}</span>
              {tab.detail && <span className="shrink-0 text-[10px] text-cc-muted/80">{tab.detail}</span>}
              {onCloseThreadTab && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.questId ?? tab.title}`}
                  className="ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
                  data-testid="thread-tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseThreadTab(tab.threadKey);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    onCloseThreadTab(tab.threadKey);
                  }}
                >
                  <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </span>
              )}
            </button>
          );
        })}
        {closedChips.length > 0 && (
          <>
            <span className="shrink-0 pl-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-cc-muted/70">
              Active
            </span>
            {closedChips.map((chip) => {
              const selected = isSelectedThread(currentThreadKey, chip.threadKey);
              const tone = chip.needsInput
                ? "border-amber-400/35 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
                : selected
                  ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
                  : "border-cc-border/70 bg-cc-hover/35 text-cc-muted hover:bg-cc-hover/65 hover:text-cc-fg";
              const dot = chip.needsInput ? "bg-amber-400" : selected ? "bg-cc-primary" : "bg-cc-muted/50";
              return (
                <button
                  key={chip.threadKey}
                  type="button"
                  onClick={() => openThread(chip.threadKey, chip.route)}
                  title={chip.questId ? `${chip.questId}: ${chip.title}` : chip.title}
                  className={`inline-flex max-w-[18rem] shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${tone}`}
                  data-testid="thread-chip"
                  data-thread-key={chip.threadKey}
                  data-needs-input={chip.needsInput ? "true" : "false"}
                  aria-pressed={selected}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
                  {chip.questId && <span className="shrink-0 font-mono-code">{chip.questId}</span>}
                  <span className="min-w-0 truncate">{chip.title}</span>
                  {chip.detail && <span className="shrink-0 text-[10px] text-cc-muted/80">{chip.detail}</span>}
                </button>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

export function WorkBoardBar({
  sessionId,
  currentThreadKey = "main",
  currentThreadLabel = "Main",
  onReturnToMain,
  onSelectThread,
  openThreadKeys = [],
  onCloseThreadTab,
  threadRows = [],
  attentionRecords = [],
}: {
  sessionId: string;
  currentThreadKey?: string;
  currentThreadLabel?: string;
  onReturnToMain?: () => void;
  onSelectThread?: (threadKey: string) => void;
  openThreadKeys?: string[];
  onCloseThreadTab?: (threadKey: string) => void;
  threadRows?: WorkBoardThreadNavigationRow[];
  attentionRecords?: ReadonlyArray<AttentionRecord>;
}) {
  const board = useStore((s) => s.sessionBoards.get(sessionId));
  const rowSessionStatuses = useStore((s) => s.sessionBoardRowStatuses.get(sessionId));
  const completedBoard = useStore((s) => s.sessionCompletedBoards.get(sessionId));
  const isOrchestrator = useStore((s) =>
    s.sdkSessions.some((session) => session.sessionId === sessionId && session.isOrchestrator === true),
  );

  const [expanded, setExpanded] = useState(() => readExpandedState(sessionId));
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [threadQuery, setThreadQuery] = useState("");

  useEffect(() => {
    setExpanded(readExpandedState(sessionId));
    setCompletedExpanded(false);
    setThreadQuery("");
  }, [sessionId]);

  useEffect(() => {
    scopedSetItem(workBoardExpandedKey(sessionId), expanded ? "1" : "0");
  }, [sessionId, expanded]);

  // Close on Escape
  useEffect(() => {
    if (!expanded) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [expanded]);

  const activeCount = board?.length ?? 0;
  const completedCount = completedBoard?.length ?? 0;
  const activeBoardRows = board ?? [];
  const completedBoardRows = completedBoard ?? [];
  const showReturnToMain = !isMainThreadKey(currentThreadKey) && !!onReturnToMain;
  const activeThreadChips = useMemo(
    () => buildPrimaryThreadChips({ activeBoardRows, threadRows, attentionRecords }),
    [activeBoardRows, attentionRecords, threadRows],
  );
  const openThreadTabs = useMemo(
    () =>
      buildOpenThreadTabs({
        openThreadKeys,
        threadRows,
        activeThreadChips,
        activeBoardRows,
        completedBoardRows,
      }),
    [activeBoardRows, activeThreadChips, completedBoardRows, openThreadKeys, threadRows],
  );
  const openThreadTabKeys = useMemo(() => new Set(openThreadTabs.map((tab) => tab.threadKey)), [openThreadTabs]);
  const closedActiveThreadChips = useMemo(
    () => activeThreadChips.filter((chip) => !openThreadTabKeys.has(chip.threadKey)),
    [activeThreadChips, openThreadTabKeys],
  );
  const boardThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const row of activeBoardRows) keys.add(normalizeThreadKey(row.questId));
    for (const row of completedBoardRows) keys.add(normalizeThreadKey(row.questId));
    return keys;
  }, [activeBoardRows, completedBoardRows]);
  const offBoardThreads = useMemo(
    () =>
      threadRows
        .filter((row) => !boardThreadKeys.has(normalizeThreadKey(row.threadKey)))
        .sort((a, b) => a.threadKey.localeCompare(b.threadKey)),
    [boardThreadKeys, threadRows],
  );
  const normalizedThreadQuery = threadQuery.trim().toLowerCase();
  const filteredBoard = useMemo(
    () => activeBoardRows.filter((row) => rowMatchesQuery(row, normalizedThreadQuery)),
    [activeBoardRows, normalizedThreadQuery],
  );
  const filteredCompletedBoard = useMemo(
    () => completedBoardRows.filter((row) => rowMatchesQuery(row, normalizedThreadQuery)),
    [completedBoardRows, normalizedThreadQuery],
  );
  const filteredOffBoardThreads = useMemo(
    () => offBoardThreads.filter((row) => threadRowMatchesQuery(row, normalizedThreadQuery)),
    [normalizedThreadQuery, offBoardThreads],
  );
  const summarySegments = useMemo(() => {
    const segments =
      activeCount === 0 && completedCount === 0 && offBoardThreads.length > 0
        ? []
        : boardSummary(activeBoardRows, completedCount);
    if (offBoardThreads.length === 0) return segments;
    return [...segments, { text: `${offBoardThreads.length} other`, className: "text-cc-muted" }];
  }, [activeBoardRows, activeCount, completedCount, offBoardThreads.length]);

  // This is the primary thread navigator for leader sessions, so keep it visible
  // even before the first quest row exists.
  if (!isOrchestrator) return null;

  return (
    <div className="shrink-0 flex flex-col min-h-0">
      {/* Summary bar -- click the board area to toggle expanded */}
      <div className="flex items-stretch border-b border-cc-border bg-cc-card">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-cc-hover/50 sm:px-4"
          data-testid="workboard-summary-button"
        >
          {/* Kanban board icon */}
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-blue-400 shrink-0">
            <path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11z" />
            <path d="M4 4h2v5H4zM7 4h2v7H7zM10 4h2v3h-2z" />
          </svg>

          <span
            className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded border border-cc-border/70 bg-cc-hover/45 px-2 py-0.5 text-[11px] font-medium text-cc-fg sm:max-w-[16rem]"
            title={currentThreadLabel}
            data-testid="workboard-current-thread"
          >
            <span className="hidden shrink-0 text-cc-muted sm:inline">Thread</span>
            <span className="min-w-0 truncate">{currentThreadLabel}</span>
          </span>

          {/* Summary text -- each status segment gets its own color */}
          <span className="min-w-0 flex-1 truncate text-[11px]" data-testid="workboard-phase-summary">
            {summarySegments.map((seg, i, arr) => (
              <span key={i}>
                <span className={seg.className} style={seg.style}>
                  {seg.text}
                </span>
                {i < arr.length - 1 && <span className="text-cc-fg/40">, </span>}
              </span>
            ))}
          </span>

          {/* Item count */}
          <span className="text-[10px] text-cc-muted shrink-0 tabular-nums">
            {activeCount} {activeCount === 1 ? "item" : "items"}
          </span>

          {/* Chevron */}
          <svg
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`w-3 h-3 text-cc-muted shrink-0 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
          >
            <path d="M3 5l3-3 3 3" />
          </svg>
        </button>
        {showReturnToMain && (
          <button
            type="button"
            onClick={onReturnToMain}
            className="flex shrink-0 items-center justify-center border-l border-cc-border/70 px-3 text-cc-muted transition-colors hover:bg-cc-hover/60 hover:text-cc-fg"
            title="Return to Main"
            aria-label="Return to Main"
            data-testid="workboard-return-main"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      <ThreadTabRail
        tabs={openThreadTabs}
        closedChips={closedActiveThreadChips}
        sessionId={sessionId}
        currentThreadKey={currentThreadKey}
        onSelectThread={onSelectThread}
        onCloseThreadTab={onCloseThreadTab}
      />

      {/* Expanded board table -- inline, pushes the feed down */}
      {expanded && (
        <div className="border-b border-cc-border bg-cc-card max-h-[55dvh] overflow-y-auto">
          <div className="border-b border-cc-border px-3 py-2" data-testid="workboard-thread-search">
            <input
              type="search"
              value={threadQuery}
              onChange={(event) => setThreadQuery(event.target.value)}
              placeholder="Search threads, board, history"
              className="w-full rounded-md border border-cc-border bg-cc-input-bg px-2.5 py-1.5 text-xs text-cc-fg outline-none transition-colors placeholder:text-cc-muted/65 focus:border-cc-primary/60"
              aria-label="Search threads, board, and history"
            />
          </div>
          {onSelectThread && (
            <div className="border-b border-cc-border px-3 py-2" data-testid="workboard-thread-nav">
              <div className="grid gap-1.5 sm:grid-cols-2">
                <ThreadNavButton
                  label="Main"
                  detail="Clean staging thread"
                  selected={isSelectedThread(currentThreadKey, "main")}
                  onClick={() => onSelectThread("main")}
                  testId="workboard-thread-main"
                />
                <ThreadNavButton
                  label="All Threads"
                  detail="Global debug feed"
                  selected={isSelectedThread(currentThreadKey, "all")}
                  onClick={() => onSelectThread("all")}
                  testId="workboard-thread-all"
                />
              </div>
            </div>
          )}
          {filteredBoard.length > 0 && (
            <BoardTable
              board={filteredBoard}
              rowSessionStatuses={rowSessionStatuses}
              selectedThreadKey={currentThreadKey}
              onSelectQuestThread={onSelectThread}
            />
          )}
          {filteredBoard.length === 0 && (
            <div className="px-3 py-3 text-xs text-cc-muted italic">
              {activeCount === 0 ? "No active items" : "No active items match"}
            </div>
          )}

          {/* Collapsible completed section */}
          {completedCount > 0 && (
            <div className="border-t border-cc-border">
              <button
                type="button"
                onClick={() => setCompletedExpanded(!completedExpanded)}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-cc-hover/50 transition-colors cursor-pointer"
              >
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`w-2.5 h-2.5 text-cc-muted shrink-0 transition-transform duration-150 ${completedExpanded ? "rotate-90" : ""}`}
                >
                  <path d="M4 2l4 4-4 4" />
                </svg>
                <span className="text-[11px] text-cc-muted">{completedCount} completed</span>
              </button>
              {completedExpanded && (
                <div className="opacity-60">
                  {filteredCompletedBoard.length > 0 ? (
                    <BoardTable
                      board={filteredCompletedBoard}
                      mode="completed"
                      rowSessionStatuses={rowSessionStatuses}
                      selectedThreadKey={currentThreadKey}
                      onSelectQuestThread={onSelectThread}
                    />
                  ) : (
                    <div className="px-3 py-3 text-xs text-cc-muted italic">No completed items match</div>
                  )}
                </div>
              )}
            </div>
          )}
          {onSelectThread && (
            <OtherThreadList
              rows={filteredOffBoardThreads}
              currentThreadKey={currentThreadKey}
              onSelectThread={onSelectThread}
            />
          )}
        </div>
      )}
    </div>
  );
}
