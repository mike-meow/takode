/**
 * Persistent work board widget for orchestrator sessions.
 *
 * Positioned above the message feed in ChatView. The tab rail stays visible for
 * leader navigation, while the Work Board summary/table behaves like a compact
 * Main-thread banner. Once opened, it stays open until the user explicitly
 * collapses it.
 */
import type { CSSProperties, ReactNode } from "react";
import { useMemo, useState, useEffect, useRef } from "react";
import { useStore } from "../store.js";
import {
  getQuestJourneyCurrentPhaseId,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  getQuestJourneyPresentation,
} from "../../shared/quest-journey.js";
import type { ActiveTurnRoute } from "../types.js";
import { BoardTable, orderBoardRows } from "./BoardTable.js";
import type { BoardRowData } from "./BoardTable.js";
import { isCompletedJourneyPresentationStatus } from "./QuestJourneyTimeline.js";
import { scopedGetItem, scopedSetItem } from "../utils/scoped-storage.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY } from "../utils/thread-projection.js";
import { isAttentionRecordActive, type AttentionRecord } from "../utils/attention-records.js";
import type { QuestmasterTask } from "../types.js";
import { QuestHoverCard } from "./QuestHoverCard.js";

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

const DONE_THREAD_TITLE_COLOR = "var(--color-cc-muted)";
const QUEUED_THREAD_TITLE_COLOR = "var(--color-cc-fg)";

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

function isActiveOutputThread(activeTurnRoute: ActiveTurnRoute | null | undefined, targetThreadKey: string): boolean {
  return normalizeThreadKey(activeTurnRoute?.threadKey ?? MAIN_THREAD_KEY) === normalizeThreadKey(targetThreadKey);
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
  variant = "card",
  secondary = false,
}: {
  label: string;
  detail?: string;
  selected: boolean;
  onClick: () => void;
  testId: string;
  variant?: "card" | "compact";
  secondary?: boolean;
}) {
  const tone = selected
    ? "border-cc-primary/45 bg-cc-primary/12 text-cc-fg"
    : secondary
      ? "border-cc-border/45 bg-transparent text-cc-muted hover:bg-cc-hover/45 hover:text-cc-fg"
      : "border-cc-border/70 bg-cc-hover/35 text-cc-muted hover:bg-cc-hover/65 hover:text-cc-fg";
  const layout =
    variant === "compact"
      ? "inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1"
      : "flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${layout} text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70 focus-visible:ring-inset ${tone}`}
      data-testid={testId}
      data-variant={variant}
      data-secondary={secondary ? "true" : "false"}
      aria-pressed={selected}
    >
      {variant === "compact" ? (
        <>
          <span className="min-w-0 truncate text-[11px] font-medium">{label}</span>
          {detail && <span className="hidden shrink-0 text-[10px] text-cc-muted/75 sm:inline">{detail}</span>}
        </>
      ) : (
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-medium">{label}</span>
          {detail && <span className="block truncate text-[10px] text-cc-muted/80">{detail}</span>}
        </span>
      )}
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
  titleColor?: string;
  canClose: boolean;
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

function boardRowTitleColor(row: BoardRowData): string | undefined {
  if ((row.status ?? "").trim().toUpperCase() === "QUEUED") return QUEUED_THREAD_TITLE_COLOR;
  const currentPhase = getQuestJourneyPhase(getQuestJourneyCurrentPhaseId(row.journey, row.status));
  const phase = currentPhase ?? getQuestJourneyPhaseForState(row.status);
  return phase?.color.accent;
}

function doneThreadTitleColor({
  boardRow,
  row,
  completed,
}: {
  boardRow?: BoardRowData;
  row?: WorkBoardThreadNavigationRow;
  completed?: boolean;
}): string | undefined {
  if (completed || row?.section === "done" || isCompletedJourneyPresentationStatus(boardRow?.status)) {
    return DONE_THREAD_TITLE_COLOR;
  }
  return undefined;
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
    titleColor: existing.titleColor ?? chip.titleColor,
    canClose: existing.canClose && chip.canClose,
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
      titleColor: boardRowTitleColor(row),
      canClose: false,
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
      canClose: true,
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
      canClose: true,
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
  const activeBoardByKey = new Map(activeBoardRows.map((row) => [normalizeThreadKey(row.questId), row]));
  const completedBoardByKey = new Map(completedBoardRows.map((row) => [normalizeThreadKey(row.questId), row]));
  const seen = new Set<string>();
  const tabs: PrimaryThreadChip[] = [];

  for (const rawKey of openThreadKeys) {
    const threadKey = normalizeThreadKey(rawKey);
    if (!threadKey || threadKey === MAIN_THREAD_KEY || threadKey === ALL_THREADS_KEY || seen.has(threadKey)) continue;
    seen.add(threadKey);

    const active = activeByKey.get(threadKey);
    const row = rowByKey.get(threadKey);
    const activeBoardRow = activeBoardByKey.get(threadKey);
    const completedBoardRow = completedBoardByKey.get(threadKey);
    const boardRow = activeBoardRow ?? completedBoardRow;
    if (!active && !row && !boardRow) continue;
    const completedTitleColor = doneThreadTitleColor({ boardRow, row, completed: !!completedBoardRow });

    tabs.push({
      threadKey,
      questId: active?.questId ?? row?.questId ?? boardRow?.questId,
      title: active?.title ?? row?.title ?? boardRow?.title ?? threadKey,
      detail: active?.detail ?? (boardRow ? boardRowDetail(boardRow) : doneThreadDetail(row)),
      messageCount: active?.messageCount ?? row?.messageCount,
      needsInput: active?.needsInput ?? (boardRow?.waitForInput?.length ?? 0) > 0,
      titleColor: completedTitleColor ?? active?.titleColor ?? (boardRow ? boardRowTitleColor(boardRow) : undefined),
      canClose: !activeBoardRow,
      route: active?.route,
      updatedAt: active?.updatedAt ?? boardRow?.updatedAt ?? 0,
    });
  }

  return tabs;
}

function ThreadTabRail({
  mainState,
  tabs,
  sessionId,
  currentThreadKey,
  onSelectThread,
  onCloseThreadTab,
  newTabKeys,
}: {
  mainState?: PrimaryThreadChip;
  tabs: PrimaryThreadChip[];
  sessionId: string;
  currentThreadKey: string;
  onSelectThread?: (threadKey: string) => void;
  onCloseThreadTab?: (threadKey: string) => void;
  newTabKeys?: ReadonlySet<string>;
}) {
  function NeedsInputBell({ activeOutput }: { activeOutput: boolean }) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3 w-3 shrink-0 text-amber-400"
        aria-hidden="true"
        data-testid="thread-tab-needs-input-bell"
        data-active-output={activeOutput ? "true" : "false"}
      >
        <path d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5v1.8c0 .7-.24 1.38-.68 1.92L3 10.75h10l-.82-1.03a3.05 3.05 0 0 1-.68-1.92V6A3.5 3.5 0 0 0 8 2.5Z" />
        <path d="M6.75 12.5a1.35 1.35 0 0 0 2.5 0" />
      </svg>
    );
  }

  function ActiveTitle({
    activeOutput,
    titleColor,
    children,
  }: {
    activeOutput: boolean;
    titleColor?: string;
    children: ReactNode;
  }) {
    const style: CSSProperties | undefined =
      activeOutput || titleColor
        ? {
            ...(activeOutput
              ? {
                  ["--glow-color" as string]: "rgba(56, 189, 248, 0.55)",
                  animation: "thread-title-glow 2s ease-in-out infinite",
                }
              : {}),
            ...(titleColor ? { color: titleColor } : {}),
          }
        : undefined;
    return (
      <span
        className={`inline-flex min-w-0 items-center gap-1.5 px-1 ${activeOutput ? "text-sky-100" : ""}`.trim()}
        style={style}
        data-testid="thread-tab-title"
        data-active-output={activeOutput ? "true" : "false"}
        data-title-color={titleColor ?? ""}
      >
        {children}
      </span>
    );
  }

  function tabTone({ selected, needsInput }: { selected: boolean; needsInput: boolean }): string {
    if (selected) {
      return needsInput
        ? "relative z-10 -mb-px rounded-b-none border-amber-400/60 border-b-cc-bg bg-cc-bg text-cc-fg shadow-[0_-1px_0_rgba(251,191,36,0.4),inset_0_1px_0_rgba(251,191,36,0.2)]"
        : "relative z-10 -mb-px rounded-b-none border-cc-primary/70 border-b-cc-bg bg-cc-bg text-cc-fg shadow-[0_-1px_0_rgba(96,165,250,0.42),inset_0_1px_0_rgba(255,255,255,0.08)]";
    }
    return needsInput
      ? "border-amber-400/35 bg-amber-400/10 text-amber-100 hover:bg-amber-400/15"
      : "border-cc-border/70 bg-cc-hover/30 text-cc-muted hover:bg-cc-hover/60 hover:text-cc-fg";
  }

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

  const mainSelected = isSelectedThread(currentThreadKey, MAIN_THREAD_KEY);
  const mainNeedsInput = mainState?.needsInput ?? false;
  const sessionStatus = useStore((s) => s.sessionStatus.get(sessionId));
  const activeTurnRoute = useStore((s) => s.activeTurnRoutes.get(sessionId));
  const quests = useStore((s) => s.quests);
  const questById = useMemo(() => new Map(quests.map((quest) => [normalizeThreadKey(quest.questId), quest])), [quests]);
  const [hoveredQuest, setHoveredQuest] = useState<{ quest: QuestmasterTask; anchorRect: DOMRect } | null>(null);
  const hideQuestHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningActiveTurnRoute = sessionStatus === "running" ? activeTurnRoute : null;
  const mainActiveOutput = isActiveOutputThread(runningActiveTurnRoute, MAIN_THREAD_KEY);
  const mainTone = tabTone({ selected: mainSelected, needsInput: mainNeedsInput });
  useEffect(
    () => () => {
      if (hideQuestHoverTimerRef.current) clearTimeout(hideQuestHoverTimerRef.current);
    },
    [],
  );

  function showQuestHover(quest: QuestmasterTask | undefined, anchorRect: DOMRect) {
    if (!quest) return;
    if (hideQuestHoverTimerRef.current) clearTimeout(hideQuestHoverTimerRef.current);
    setHoveredQuest({ quest, anchorRect });
  }

  function scheduleQuestHoverHide() {
    if (hideQuestHoverTimerRef.current) clearTimeout(hideQuestHoverTimerRef.current);
    hideQuestHoverTimerRef.current = setTimeout(() => setHoveredQuest(null), 100);
  }

  return (
    <div
      className="border-b border-cc-border bg-cc-card px-3 pb-0 pt-1.5 sm:px-4"
      data-testid="thread-tab-rail"
      data-open-tab-count={tabs.length + 1}
      data-closed-chip-count="0"
      data-unified-tab-track="true"
      data-overflow="horizontal-scroll-after-min"
    >
      <div className="flex min-w-0 items-end gap-1.5 overflow-x-auto">
        <span className="mb-1 shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-cc-muted/70">
          Tabs
        </span>
        <button
          type="button"
          onClick={() => openThread(MAIN_THREAD_KEY)}
          title={
            mainNeedsInput ? `${mainState?.title ?? "Main Thread"} needs input` : (mainState?.title ?? "Main Thread")
          }
          className={`inline-flex min-w-[7.75rem] max-w-[14rem] flex-[0_1_9.5rem] items-center gap-1.5 rounded-t-md border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70 focus-visible:ring-inset ${mainTone}`}
          data-testid="thread-main-tab"
          data-thread-key={MAIN_THREAD_KEY}
          data-needs-input={mainNeedsInput ? "true" : "false"}
          data-min-label="Main Thread"
          aria-pressed={mainSelected}
        >
          {mainNeedsInput && <NeedsInputBell activeOutput={mainActiveOutput} />}
          <ActiveTitle activeOutput={mainActiveOutput}>
            <span className="min-w-0 truncate">Main Thread</span>
          </ActiveTitle>
          {mainState?.detail && <span className="shrink-0 text-[10px] text-cc-muted/80">{mainState.detail}</span>}
        </button>
        {tabs.map((tab) => {
          const selected = isSelectedThread(currentThreadKey, tab.threadKey);
          const activeOutput = isActiveOutputThread(runningActiveTurnRoute, tab.threadKey);
          const tone = tabTone({ selected, needsInput: tab.needsInput });
          const newTab = newTabKeys?.has(tab.threadKey) ?? false;
          const hoverQuest = tab.questId ? questById.get(normalizeThreadKey(tab.questId)) : undefined;
          return (
            <div
              key={tab.threadKey}
              title={
                hoverQuest
                  ? undefined
                  : `${tab.questId ? `${tab.questId}: ${tab.title}` : tab.title}${tab.needsInput ? " needs input" : ""}`
              }
              onMouseEnter={(event) => showQuestHover(hoverQuest, event.currentTarget.getBoundingClientRect())}
              onMouseLeave={hoverQuest ? scheduleQuestHoverHide : undefined}
              className={`group inline-flex min-w-[6.25rem] max-w-[18rem] flex-[1_1_11rem] items-stretch rounded-t-md border text-[11px] font-medium transition-colors ${newTab ? "thread-tab-pop" : ""} ${tone}`}
              data-testid="thread-tab"
              data-thread-key={tab.threadKey}
              data-needs-input={tab.needsInput ? "true" : "false"}
              data-new-tab={newTab ? "true" : "false"}
              data-min-label={tab.questId ?? tab.threadKey}
              data-closable={tab.canClose ? "true" : "false"}
              data-has-quest-hover={hoverQuest ? "true" : "false"}
            >
              <button
                type="button"
                onClick={() => openThread(tab.threadKey, tab.route)}
                className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-t-[inherit] px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70 focus-visible:ring-inset"
                data-testid="thread-tab-select"
                aria-pressed={selected}
              >
                {tab.needsInput && <NeedsInputBell activeOutput={activeOutput} />}
                <ActiveTitle activeOutput={activeOutput} titleColor={tab.titleColor}>
                  {tab.questId && <span className="shrink-0 font-mono-code">{tab.questId}</span>}
                  <span className="min-w-0 truncate">{tab.title}</span>
                </ActiveTitle>
              </button>
              {onCloseThreadTab && tab.canClose && (
                <button
                  type="button"
                  aria-label={`Close ${tab.questId ?? tab.title}`}
                  className={`inline-flex w-5 shrink-0 items-center justify-center border-l border-current/10 text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:opacity-100 ${
                    selected ? "opacity-100" : "opacity-70 sm:opacity-0 sm:group-hover:opacity-100"
                  }`}
                  data-testid="thread-tab-close"
                  data-compact-close="true"
                  data-selected={selected ? "true" : "false"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseThreadTab(tab.threadKey);
                  }}
                >
                  <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
      {hoveredQuest && (
        <QuestHoverCard
          quest={hoveredQuest.quest}
          anchorRect={hoveredQuest.anchorRect}
          onMouseEnter={() => {
            if (hideQuestHoverTimerRef.current) clearTimeout(hideQuestHoverTimerRef.current);
          }}
          onMouseLeave={() => setHoveredQuest(null)}
        />
      )}
    </div>
  );
}

export function WorkBoardBar({
  sessionId,
  currentThreadKey = "main",
  onSelectThread,
  openThreadKeys = [],
  onCloseThreadTab,
  threadRows = [],
  attentionRecords = [],
}: {
  sessionId: string;
  currentThreadKey?: string;
  currentThreadLabel?: string;
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
  const showMainWorkBoard = isSelectedThread(currentThreadKey, MAIN_THREAD_KEY);

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
    if (!expanded || !showMainWorkBoard) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [expanded, showMainWorkBoard]);

  const activeCount = board?.length ?? 0;
  const completedCount = completedBoard?.length ?? 0;
  const activeBoardRows = board ?? [];
  const completedBoardRows = completedBoard ?? [];
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
  const previousOpenThreadTabKeysRef = useRef<string[] | null>(null);
  const newThreadTabTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [newThreadTabKeys, setNewThreadTabKeys] = useState<Set<string>>(() => new Set());
  const [dismissedAutoThreadTabKeys, setDismissedAutoThreadTabKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setDismissedAutoThreadTabKeys(new Set());
  }, [sessionId]);
  useEffect(() => {
    const currentKeys = openThreadTabs.map((tab) => tab.threadKey);
    const previousKeys = previousOpenThreadTabKeysRef.current;
    previousOpenThreadTabKeysRef.current = currentKeys;
    if (previousKeys === null) return;

    const previous = new Set(previousKeys);
    const addedKeys = currentKeys.filter((key) => !previous.has(key));
    if (addedKeys.length === 0) return;

    setNewThreadTabKeys((existing) => new Set([...existing, ...addedKeys]));
    for (const key of addedKeys) {
      const existingTimeout = newThreadTabTimeoutsRef.current.get(key);
      if (existingTimeout) clearTimeout(existingTimeout);
      const timeout = setTimeout(() => {
        newThreadTabTimeoutsRef.current.delete(key);
        setNewThreadTabKeys((existing) => {
          const next = new Set(existing);
          next.delete(key);
          return next;
        });
      }, 900);
      newThreadTabTimeoutsRef.current.set(key, timeout);
    }
  }, [openThreadTabs]);
  useEffect(
    () => () => {
      for (const timeout of newThreadTabTimeoutsRef.current.values()) clearTimeout(timeout);
      newThreadTabTimeoutsRef.current.clear();
    },
    [],
  );
  const mainThreadState = useMemo(
    () => activeThreadChips.find((chip) => chip.threadKey === MAIN_THREAD_KEY),
    [activeThreadChips],
  );
  const openThreadTabKeys = useMemo(() => new Set(openThreadTabs.map((tab) => tab.threadKey)), [openThreadTabs]);
  const activeBoardThreadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const row of activeBoardRows) keys.add(normalizeThreadKey(row.questId));
    return keys;
  }, [activeBoardRows]);
  const closedActiveThreadChips = useMemo(
    () =>
      activeThreadChips.filter(
        (chip) =>
          chip.threadKey !== MAIN_THREAD_KEY &&
          chip.threadKey !== ALL_THREADS_KEY &&
          !openThreadTabKeys.has(chip.threadKey) &&
          (activeBoardThreadKeys.has(chip.threadKey) || !dismissedAutoThreadTabKeys.has(chip.threadKey)),
      ),
    [activeBoardThreadKeys, activeThreadChips, dismissedAutoThreadTabKeys, openThreadTabKeys],
  );
  const unifiedThreadTabs = useMemo(
    () => [...openThreadTabs, ...closedActiveThreadChips],
    [closedActiveThreadChips, openThreadTabs],
  );
  const handleCloseThreadTab = (threadKey: string) => {
    const normalized = normalizeThreadKey(threadKey);
    onCloseThreadTab?.(normalized);
    if (openThreadTabKeys.has(normalized)) return;

    setDismissedAutoThreadTabKeys((existing) => new Set([...existing, normalized]));
    if (isSelectedThread(currentThreadKey, normalized)) {
      onSelectThread?.(MAIN_THREAD_KEY);
    }
  };
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
      {showMainWorkBoard && (
        <div
          className="flex min-w-0 items-center gap-2 border-b border-cc-border bg-cc-card px-3 py-1.5 sm:px-4"
          data-testid="workboard-main-banner"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-blue-400 shrink-0">
            <path d="M1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11z" />
            <path d="M4 4h2v5H4zM7 4h2v7H7zM10 4h2v3h-2z" />
          </svg>

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

          <span className="text-[10px] text-cc-muted shrink-0 tabular-nums">
            {activeCount} {activeCount === 1 ? "item" : "items"}
          </span>

          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-cc-border/70 bg-cc-hover/40 px-2 py-0.5 text-[10px] font-medium text-cc-fg transition-colors hover:bg-cc-hover/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70 focus-visible:ring-inset"
            data-testid="workboard-summary-button"
            aria-expanded={expanded}
          >
            <span>{expanded ? "Close Workboard" : "Open Workboard"}</span>
            <svg
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`w-3 h-3 text-cc-muted shrink-0 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
              aria-hidden="true"
            >
              <path d="M3 5l3-3 3 3" />
            </svg>
          </button>
        </div>
      )}

      <ThreadTabRail
        mainState={mainThreadState}
        tabs={unifiedThreadTabs}
        sessionId={sessionId}
        currentThreadKey={currentThreadKey}
        onSelectThread={onSelectThread}
        onCloseThreadTab={onCloseThreadTab ? handleCloseThreadTab : undefined}
        newTabKeys={newThreadTabKeys}
      />

      {/* Expanded board table -- inline, pushes the feed down */}
      {showMainWorkBoard && expanded && (
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
            <div className="border-b border-cc-border px-3 py-1.5" data-testid="workboard-thread-nav">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <ThreadNavButton
                  label="Main Thread"
                  detail="Clean staging thread"
                  selected={isSelectedThread(currentThreadKey, "main")}
                  onClick={() => onSelectThread("main")}
                  testId="workboard-thread-main"
                  variant="compact"
                />
                <ThreadNavButton
                  label="All Threads"
                  detail="Global debug feed"
                  selected={isSelectedThread(currentThreadKey, "all")}
                  onClick={() => onSelectThread("all")}
                  testId="workboard-thread-all"
                  variant="compact"
                  secondary
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
