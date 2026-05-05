/**
 * Persistent work board widget for orchestrator sessions.
 *
 * Positioned above the message feed in ChatView. The tab rail stays visually
 * anchored for leader navigation, while the Work Board summary/table behaves
 * like a compact Main-thread banner below the tabs. Once opened, it stays open
 * until the user explicitly collapses it.
 */
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useMemo, useState, useEffect, useRef } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS, type Transform } from "@dnd-kit/utilities";
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
const MAX_WORK_BOARD_BOOLEAN_STORAGE_CHARS = 8;

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

export function reorderThreadTabsAfterDrag(
  threadKeys: ReadonlyArray<string>,
  activeThreadKey: unknown,
  overThreadKey: unknown,
): string[] {
  const keys = threadKeys.map((key) => normalizeThreadKey(key));
  const activeKey = normalizeThreadKey(String(activeThreadKey ?? ""));
  const overKey = normalizeThreadKey(String(overThreadKey ?? ""));
  if (!activeKey || !overKey || activeKey === overKey) return keys;
  const oldIndex = keys.indexOf(activeKey);
  const newIndex = keys.indexOf(overKey);
  if (oldIndex < 0 || newIndex < 0) return keys;
  return arrayMove(keys, oldIndex, newIndex);
}

export function constrainThreadTabTransformToHorizontal(transform: Transform | null): Transform | null {
  if (!transform || transform.y === 0) return transform;
  return { ...transform, y: 0 };
}

function stringArraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workBoardExpandedKey(sessionId: string): string {
  return `cc-work-board-expanded:${sessionId}`;
}

function workBoardOtherThreadsExpandedKey(sessionId: string): string {
  return `cc-work-board-other-threads-expanded:${sessionId}`;
}

function readExpandedState(sessionId: string): boolean {
  return readWorkBoardBooleanState(workBoardExpandedKey(sessionId));
}

function readOtherThreadsExpandedState(sessionId: string): boolean {
  return readWorkBoardBooleanState(workBoardOtherThreadsExpandedKey(sessionId));
}

function readWorkBoardBooleanState(storageKey: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const value = scopedGetItem(storageKey);
    if (!value) return false;
    if (value.length > MAX_WORK_BOARD_BOOLEAN_STORAGE_CHARS) {
      warnWorkBoardStorage("Ignoring oversized Work Board storage value.", { storageKey, length: value.length });
      return false;
    }
    return value === "1";
  } catch (error) {
    warnWorkBoardStorage("Could not read Work Board storage value; using collapsed state.", error);
    return false;
  }
}

function persistWorkBoardBooleanState(storageKey: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    scopedSetItem(storageKey, value ? "1" : "0");
  } catch (error) {
    warnWorkBoardStorage("Could not persist Work Board storage value; continuing in memory.", error);
  }
}

function warnWorkBoardStorage(message: string, error: unknown): void {
  console.warn(`[takode] ${message}`, error);
}

function normalizeThreadKey(threadKey: string): string {
  return threadKey.trim().toLowerCase();
}

function isSelectedThread(currentThreadKey: string, targetThreadKey: string): boolean {
  return normalizeThreadKey(currentThreadKey) === normalizeThreadKey(targetThreadKey);
}

function isActiveOutputThread(activeTurnRoute: ActiveTurnRoute | null | undefined, targetThreadKey: string): boolean {
  if (!activeTurnRoute?.threadKey) return false;
  return normalizeThreadKey(activeTurnRoute.threadKey) === normalizeThreadKey(targetThreadKey);
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

function ThreadSearchField({
  query,
  expanded,
  onQueryChange,
  onFocusChange,
}: {
  query: string;
  expanded: boolean;
  onQueryChange: (query: string) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  return (
    <div
      className={`relative ml-auto h-8 ${
        expanded ? "min-w-[8.5rem] flex-1" : "w-9 flex-none"
      } sm:min-w-[12rem] sm:max-w-md sm:flex-1`}
      data-testid="workboard-thread-search"
      data-expanded={expanded ? "true" : "false"}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className={`pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cc-muted ${
          expanded ? "left-2" : "left-1/2 -translate-x-1/2 sm:left-2 sm:translate-x-0"
        }`}
        aria-hidden="true"
      >
        <circle cx="6.5" cy="6.5" r="4.5" />
        <path d="M10 10l3.5 3.5" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onQueryChange("");
          event.currentTarget.blur();
        }}
        placeholder="Search threads, board, history"
        className={`h-full w-full rounded-md border border-cc-border bg-cc-input-bg py-1.5 text-xs text-cc-fg outline-none transition-colors placeholder:text-cc-muted/65 focus:border-cc-primary/60 ${
          expanded
            ? "pl-7 pr-7"
            : "cursor-pointer px-0 text-transparent placeholder:text-transparent sm:pl-7 sm:pr-7 sm:text-cc-fg sm:placeholder:text-cc-muted/65"
        }`}
        aria-label="Search threads, board, and history"
      />
      {query && (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onQueryChange("")}
          className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70"
          aria-label="Clear thread search"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
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

function SortableThreadTabContainer({
  tab,
  className,
  title,
  minLabel,
  activeOutput,
  newTab,
  hoverQuest,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  tab: PrimaryThreadChip;
  className: string;
  title?: string;
  minLabel?: string;
  activeOutput: boolean;
  newTab: boolean;
  hoverQuest?: QuestmasterTask;
  onMouseEnter?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseLeave?: () => void;
  children: (dragSurfaceProps: {
    attributes: DraggableAttributes;
    listeners: ReturnType<typeof useSortable>["listeners"];
    isDragging: boolean;
  }) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.threadKey });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(constrainThreadTabTransformToHorizontal(transform)),
    transition,
    ...(isDragging ? { opacity: 0.78, zIndex: 30 } : {}),
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      title={title}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={className}
      data-testid="thread-tab"
      data-thread-key={tab.threadKey}
      data-needs-input={tab.needsInput ? "true" : "false"}
      data-active-output={activeOutput ? "true" : "false"}
      data-new-tab={newTab ? "true" : "false"}
      data-min-label={minLabel ?? tab.questId ?? tab.threadKey}
      data-closable={tab.canClose ? "true" : "false"}
      data-has-quest-hover={hoverQuest ? "true" : "false"}
      data-reorderable="true"
      data-dragging={isDragging ? "true" : "false"}
    >
      {children({ attributes, listeners, isDragging })}
    </div>
  );
}

function threadKeyToSelectAfterClosing(threadKey: string, tabs: ReadonlyArray<PrimaryThreadChip>): string {
  const normalized = normalizeThreadKey(threadKey);
  const closingIndex = tabs.findIndex((tab) => normalizeThreadKey(tab.threadKey) === normalized);
  if (closingIndex < 0) return MAIN_THREAD_KEY;

  const rightTab = tabs.slice(closingIndex + 1).find((tab) => normalizeThreadKey(tab.threadKey) !== normalized);
  return rightTab ? normalizeThreadKey(rightTab.threadKey) : MAIN_THREAD_KEY;
}

function OtherThreadSection({
  rows,
  totalCount,
  expanded,
  currentThreadKey,
  onToggle,
  onSelectThread,
}: {
  rows: WorkBoardThreadNavigationRow[];
  totalCount: number;
  expanded: boolean;
  currentThreadKey: string;
  onToggle: () => void;
  onSelectThread: (threadKey: string) => void;
}) {
  if (totalCount === 0) return null;

  return (
    <div className="border-t border-cc-border" data-testid="workboard-off-board-threads">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-cc-hover/50"
        data-testid="workboard-other-threads-toggle"
        aria-expanded={expanded}
      >
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-2.5 w-2.5 shrink-0 text-cc-muted transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          <path d="M4 2l4 4-4 4" />
        </svg>
        <span className="text-[11px] text-cc-muted">{totalCount} other</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2" data-testid="workboard-other-threads-content">
          {rows.length > 0 ? (
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
          ) : (
            <div className="py-1.5 text-xs text-cc-muted italic">No other threads match</div>
          )}
        </div>
      )}
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
    const completedTitleColor = doneThreadTitleColor({
      boardRow,
      row,
      completed: !activeBoardRow && !!completedBoardRow,
    });

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

function ActiveOutputIndicator() {
  return (
    <span
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      data-testid="thread-tab-active-output-indicator"
      data-reduced-motion-static="true"
      data-dot-position="stripe-origin"
      data-stripe-origin="top-left"
    >
      <span
        className="absolute inset-x-1 top-0 h-px overflow-hidden rounded-full bg-violet-100/30"
        data-testid="thread-tab-active-output-glint-track"
      >
        <span
          className="thread-tab-output-glint absolute inset-y-0 left-0 w-1/2 rounded-full bg-gradient-to-r from-transparent via-white to-sky-200 shadow-[0_0_8px_rgba(224,242,254,0.66)]"
          data-testid="thread-tab-active-output-glint"
          data-reduced-motion="animation-disabled"
        />
      </span>
      <span
        className="absolute left-1 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-50/95 shadow-[0_0_9px_rgba(224,242,254,0.78)] ring-1 ring-violet-100/75"
        data-testid="thread-tab-active-output-dot"
      />
    </span>
  );
}

function ThreadTabRail({
  mainState,
  tabs,
  reorderableThreadKeys,
  sessionId,
  currentThreadKey,
  onSelectThread,
  onCloseThreadTab,
  onReorderThreadTabs,
  newTabKeys,
}: {
  mainState?: PrimaryThreadChip;
  tabs: PrimaryThreadChip[];
  reorderableThreadKeys: string[];
  sessionId: string;
  currentThreadKey: string;
  onSelectThread?: (threadKey: string) => void;
  onCloseThreadTab?: (threadKey: string) => void;
  onReorderThreadTabs?: (orderedThreadKeys: string[]) => void;
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
        className="relative z-10 h-3 w-3 shrink-0 text-amber-400"
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
    const style: CSSProperties | undefined = titleColor
      ? {
          color: titleColor,
        }
      : undefined;
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 px-1"
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
      return "relative z-10 -mb-px rounded-b-none border-violet-100/45 border-b-transparent bg-white/[0.055] text-white shadow-[0_-1px_0_rgba(221,214,254,0.78),0_0_0_1px_rgba(196,181,253,0.16),0_10px_20px_-16px_rgba(196,181,253,0.78),inset_0_1px_0_rgba(255,255,255,0.14)]";
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
  const hideScrollbarTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollbarActive, setScrollbarActive] = useState(false);
  const runningActiveTurnRoute = sessionStatus === "running" ? activeTurnRoute : null;
  const mainActiveOutput = isActiveOutputThread(runningActiveTurnRoute, MAIN_THREAD_KEY);
  const mainTone = tabTone({ selected: mainSelected, needsInput: mainNeedsInput });
  const sortableTabKeys = useMemo(
    () => tabs.map((tab) => normalizeThreadKey(tab.threadKey)).filter((key) => reorderableThreadKeys.includes(key)),
    [reorderableThreadKeys, tabs],
  );
  const sortableTabKeySet = useMemo(() => new Set(sortableTabKeys), [sortableTabKeys]);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  function handleThreadTabDragEnd(event: DragEndEvent) {
    if (!onReorderThreadTabs || !event.over) return;
    const orderedThreadKeys = reorderThreadTabsAfterDrag(sortableTabKeys, event.active.id, event.over.id);
    if (stringArraysEqual(sortableTabKeys, orderedThreadKeys)) return;
    onReorderThreadTabs(orderedThreadKeys);
  }
  useEffect(
    () => () => {
      if (hideQuestHoverTimerRef.current) clearTimeout(hideQuestHoverTimerRef.current);
      if (hideScrollbarTimerRef.current) clearTimeout(hideScrollbarTimerRef.current);
    },
    [],
  );

  function handleTabStripScroll() {
    if (hideScrollbarTimerRef.current) clearTimeout(hideScrollbarTimerRef.current);
    setScrollbarActive(true);
    hideScrollbarTimerRef.current = setTimeout(() => setScrollbarActive(false), 800);
  }

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
      <div
        className="thread-tab-scroll flex min-w-0 items-end gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain"
        data-testid="thread-tab-strip"
        data-scrollbar="thin-transient"
        data-scrollbar-active={scrollbarActive ? "true" : "false"}
        aria-label="Thread tabs"
        onScroll={handleTabStripScroll}
      >
        <button
          type="button"
          onClick={() => openThread(MAIN_THREAD_KEY)}
          title={
            mainNeedsInput ? `${mainState?.title ?? "Main Thread"} needs input` : (mainState?.title ?? "Main Thread")
          }
          className={`relative inline-flex min-w-[7.75rem] max-w-[14rem] flex-[0_1_9.5rem] items-center gap-1.5 overflow-hidden rounded-t-md border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-100/70 focus-visible:ring-inset ${mainTone}`}
          data-testid="thread-main-tab"
          data-thread-key={MAIN_THREAD_KEY}
          data-needs-input={mainNeedsInput ? "true" : "false"}
          data-active-output={mainActiveOutput ? "true" : "false"}
          data-min-label="Main Thread"
          aria-pressed={mainSelected}
        >
          {mainActiveOutput && <ActiveOutputIndicator />}
          {mainNeedsInput && <NeedsInputBell activeOutput={mainActiveOutput} />}
          <ActiveTitle activeOutput={mainActiveOutput}>
            <span className="min-w-0 truncate">Main Thread</span>
          </ActiveTitle>
          {mainState?.detail && <span className="shrink-0 text-[10px] text-cc-muted/80">{mainState.detail}</span>}
        </button>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleThreadTabDragEnd}>
          <SortableContext items={sortableTabKeys} strategy={horizontalListSortingStrategy}>
            {tabs.map((tab) => {
              const selected = isSelectedThread(currentThreadKey, tab.threadKey);
              const activeOutput = isActiveOutputThread(runningActiveTurnRoute, tab.threadKey);
              const tone = tabTone({ selected, needsInput: tab.needsInput });
              const newTab = newTabKeys?.has(tab.threadKey) ?? false;
              const hoverQuest = tab.questId ? questById.get(normalizeThreadKey(tab.questId)) : undefined;
              const displayQuestId = hoverQuest?.questId ?? tab.questId;
              const displayTitle = hoverQuest?.title ?? tab.title;
              const reorderable = onReorderThreadTabs && sortableTabKeySet.has(normalizeThreadKey(tab.threadKey));
              const title = hoverQuest
                ? undefined
                : `${displayQuestId ? `${displayQuestId}: ${displayTitle}` : displayTitle}${tab.needsInput ? " needs input" : ""}`;
              const className = `group relative inline-flex min-w-[6.25rem] max-w-[18rem] flex-[1_1_11rem] items-stretch overflow-hidden rounded-t-md border text-[11px] font-medium transition-colors ${newTab ? "thread-tab-pop" : ""} ${reorderable ? "cursor-grab active:cursor-grabbing" : ""} ${tone}`;
              const mouseEnter = (event: ReactMouseEvent<HTMLDivElement>) =>
                showQuestHover(hoverQuest, event.currentTarget.getBoundingClientRect());
              const children = (dragSurfaceProps?: {
                attributes: DraggableAttributes;
                listeners: ReturnType<typeof useSortable>["listeners"];
                isDragging: boolean;
              }) => (
                <>
                  {activeOutput && <ActiveOutputIndicator />}
                  <button
                    type="button"
                    onClick={() => openThread(tab.threadKey, tab.route)}
                    className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-t-[inherit] px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-100/70 focus-visible:ring-inset"
                    data-testid="thread-tab-select"
                    data-dragging={dragSurfaceProps?.isDragging ? "true" : "false"}
                    {...(dragSurfaceProps?.attributes ?? {})}
                    {...(dragSurfaceProps?.listeners ?? {})}
                    aria-pressed={selected}
                  >
                    {tab.needsInput && <NeedsInputBell activeOutput={activeOutput} />}
                    <ActiveTitle activeOutput={activeOutput} titleColor={tab.titleColor}>
                      {displayQuestId && <span className="shrink-0 font-mono-code">{displayQuestId}</span>}
                      <span className="min-w-0 truncate">{displayTitle}</span>
                    </ActiveTitle>
                  </button>
                  {onCloseThreadTab && tab.canClose && (
                    <button
                      type="button"
                      aria-label={`Close ${displayQuestId ?? displayTitle}`}
                      className={`inline-flex shrink-0 items-center justify-center overflow-hidden border-l border-current/10 text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg focus-visible:w-5 focus-visible:border-l focus-visible:opacity-100 ${
                        selected
                          ? "w-5 opacity-100"
                          : "w-5 opacity-70 sm:w-0 sm:border-l-0 sm:opacity-0 sm:group-hover:w-5 sm:group-hover:border-l sm:group-hover:opacity-100"
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
                </>
              );

              return reorderable ? (
                <SortableThreadTabContainer
                  key={tab.threadKey}
                  tab={tab}
                  className={className}
                  title={title}
                  minLabel={displayQuestId ?? tab.threadKey}
                  activeOutput={activeOutput}
                  newTab={newTab}
                  hoverQuest={hoverQuest}
                  onMouseEnter={mouseEnter}
                  onMouseLeave={hoverQuest ? scheduleQuestHoverHide : undefined}
                >
                  {children}
                </SortableThreadTabContainer>
              ) : (
                <div
                  key={tab.threadKey}
                  title={title}
                  onMouseEnter={mouseEnter}
                  onMouseLeave={hoverQuest ? scheduleQuestHoverHide : undefined}
                  className={className}
                  data-testid="thread-tab"
                  data-thread-key={tab.threadKey}
                  data-needs-input={tab.needsInput ? "true" : "false"}
                  data-active-output={activeOutput ? "true" : "false"}
                  data-new-tab={newTab ? "true" : "false"}
                  data-min-label={displayQuestId ?? tab.threadKey}
                  data-closable={tab.canClose ? "true" : "false"}
                  data-has-quest-hover={hoverQuest ? "true" : "false"}
                  data-reorderable="false"
                >
                  {children()}
                </div>
              );
            })}
          </SortableContext>
        </DndContext>
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
  closedThreadKeys,
  onCloseThreadTab,
  onReorderThreadTabs,
  threadRows = [],
  attentionRecords = [],
}: {
  sessionId: string;
  currentThreadKey?: string;
  currentThreadLabel?: string;
  onSelectThread?: (threadKey: string) => void;
  openThreadKeys?: string[];
  closedThreadKeys?: string[];
  onCloseThreadTab?: (threadKey: string, nextThreadKey: string) => void;
  onReorderThreadTabs?: (orderedThreadKeys: string[]) => void;
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
  const [otherThreadsExpanded, setOtherThreadsExpanded] = useState(() => readOtherThreadsExpandedState(sessionId));
  const [threadQuery, setThreadQuery] = useState("");
  const [threadSearchFocused, setThreadSearchFocused] = useState(false);
  const showMainWorkBoard = isSelectedThread(currentThreadKey, MAIN_THREAD_KEY);

  useEffect(() => {
    setExpanded(readExpandedState(sessionId));
    setCompletedExpanded(false);
    setOtherThreadsExpanded(readOtherThreadsExpandedState(sessionId));
    setThreadQuery("");
    setThreadSearchFocused(false);
  }, [sessionId]);

  useEffect(() => {
    persistWorkBoardBooleanState(workBoardExpandedKey(sessionId), expanded);
  }, [sessionId, expanded]);

  useEffect(() => {
    persistWorkBoardBooleanState(workBoardOtherThreadsExpandedKey(sessionId), otherThreadsExpanded);
  }, [sessionId, otherThreadsExpanded]);

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
  const closedThreadKeySet = useMemo(() => {
    const keys = new Set<string>();
    for (const key of closedThreadKeys ?? []) {
      const normalized = normalizeThreadKey(key);
      if (normalized && normalized !== MAIN_THREAD_KEY && normalized !== ALL_THREADS_KEY) keys.add(normalized);
    }
    return keys;
  }, [closedThreadKeys]);
  useEffect(() => {
    setDismissedAutoThreadTabKeys(new Set());
  }, [sessionId]);
  useEffect(() => {
    if (closedThreadKeySet.size === 0) return;
    setDismissedAutoThreadTabKeys((existing) => {
      let changed = false;
      const next = new Set(existing);
      for (const key of closedThreadKeySet) {
        if (next.has(key)) continue;
        next.add(key);
        changed = true;
      }
      return changed ? next : existing;
    });
  }, [closedThreadKeySet]);
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
    const nextThreadKey = threadKeyToSelectAfterClosing(normalized, unifiedThreadTabs);
    onCloseThreadTab?.(normalized, nextThreadKey);

    setDismissedAutoThreadTabKeys((existing) => new Set([...existing, normalized]));
    if (openThreadTabKeys.has(normalized)) return;
    if (isSelectedThread(currentThreadKey, normalized)) {
      onSelectThread?.(nextThreadKey);
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
  const threadSearchExpanded = threadSearchFocused || normalizedThreadQuery.length > 0;
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
      <ThreadTabRail
        mainState={mainThreadState}
        tabs={unifiedThreadTabs}
        reorderableThreadKeys={openThreadTabs.map((tab) => normalizeThreadKey(tab.threadKey))}
        sessionId={sessionId}
        currentThreadKey={currentThreadKey}
        onSelectThread={onSelectThread}
        onCloseThreadTab={onCloseThreadTab ? handleCloseThreadTab : undefined}
        onReorderThreadTabs={onReorderThreadTabs}
        newTabKeys={newThreadTabKeys}
      />

      {showMainWorkBoard && (
        <div
          className="flex min-w-0 items-center gap-2 border-b border-cc-border bg-cc-card px-3 py-1.5 sm:px-4"
          data-testid="workboard-main-banner"
        >
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
        </div>
      )}

      {/* Expanded board table -- inline, pushes the feed down */}
      {showMainWorkBoard && expanded && (
        <div className="border-b border-cc-border bg-cc-card max-h-[55dvh] overflow-y-auto">
          <div
            className="flex min-w-0 items-center gap-1.5 border-b border-cc-border px-3 py-1.5"
            data-testid="workboard-thread-controls"
            data-search-expanded={threadSearchExpanded ? "true" : "false"}
          >
            {onSelectThread && (
              <div className="flex min-w-0 shrink-0 items-center gap-1.5" data-testid="workboard-thread-nav">
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
            )}
            <ThreadSearchField
              query={threadQuery}
              expanded={threadSearchExpanded}
              onQueryChange={setThreadQuery}
              onFocusChange={setThreadSearchFocused}
            />
          </div>
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
            <OtherThreadSection
              rows={filteredOffBoardThreads}
              totalCount={offBoardThreads.length}
              expanded={otherThreadsExpanded}
              currentThreadKey={currentThreadKey}
              onToggle={() => setOtherThreadsExpanded(!otherThreadsExpanded)}
              onSelectThread={onSelectThread}
            />
          )}
        </div>
      )}
    </div>
  );
}
