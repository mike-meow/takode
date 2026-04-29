import { useMemo, useState, useEffect, useRef, useLayoutEffect, type KeyboardEvent, type MouseEvent } from "react";
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
import { WorkBoardBar } from "./WorkBoardBar.js";
import { YarnBallDot } from "./CatIcons.js";
import { SearchBar } from "./SearchBar.js";
import { useSessionSearch } from "../hooks/useSessionSearch.js";
import type { BoardRowData } from "./BoardTable.js";
import { isCompletedJourneyPresentationStatus, QuestJourneyPreviewCard } from "./QuestJourneyTimeline.js";
import { QuestInlineLink } from "./QuestInlineLink.js";
import { SessionInlineLink } from "./SessionInlineLink.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { useParticipantSessionStatusDotProps } from "./session-participant-status.js";
import {
  formatWaitForRefLabel,
  getQuestJourneyCurrentPhaseId,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  getQuestJourneyPresentation,
  getWaitForRefKind,
} from "../../shared/quest-journey.js";
import { parseCommandThreadComment, parseThreadTextPrefix } from "../../shared/thread-routing.js";
import { ALL_THREADS_KEY, MAIN_THREAD_KEY, filterMessagesForThread } from "../utils/thread-projection.js";
import type { BoardParticipantStatus, BoardRowSessionStatus, ChatMessage, QuestmasterTask } from "../types.js";

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
    if (messageCount <= 0) return;
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

function isQueuedThreadRowStatus(status?: string): boolean {
  return (status || "").trim().toUpperCase() === "QUEUED";
}

function formatThreadWaitForRefLabel(depRef: string): string {
  switch (getWaitForRefKind(depRef)) {
    case "quest":
      return `wait ${depRef.toLowerCase()}`;
    case "session":
      return `wait ${depRef}`;
    case "free-worker":
      return "wait worker";
    case "invalid":
      return `wait ${formatWaitForRefLabel(depRef)}`;
  }
}

function formatThreadWaitForInputLabel(notificationId: string): string {
  const match = /^n-(\d+)$/i.exec(notificationId.trim());
  return match ? `wait input ${match[1]}` : "wait input";
}

function waitForLabelForThread(row: LeaderThreadRow): string | null {
  const boardRow = row.boardRow;
  if (!boardRow) return null;

  if (isQueuedThreadRowStatus(boardRow.status)) {
    const depRef = boardRow.waitFor?.[0];
    return depRef ? formatThreadWaitForRefLabel(depRef) : null;
  }

  const notificationId = boardRow.waitForInput?.[0];
  return notificationId ? formatThreadWaitForInputLabel(notificationId) : null;
}

function ThreadWaitForChip({ label }: { label: string }) {
  return (
    <span
      className="inline-flex max-w-full shrink-0 items-center rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 font-mono-code text-[10px] leading-none text-amber-200"
      data-testid="leader-thread-wait-for-chip"
      title={label}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

function ThreadParticipantChip({
  label,
  participant,
  fallbackSessionId,
  fallbackSessionNum,
}: {
  label: string;
  participant?: BoardParticipantStatus | null;
  fallbackSessionId?: string;
  fallbackSessionNum?: number;
}) {
  const sessionId = participant?.sessionId ?? fallbackSessionId ?? null;
  const sessionNum = participant?.sessionNum ?? fallbackSessionNum ?? null;
  const dotProps = useParticipantSessionStatusDotProps(sessionId, participant?.status);
  if (!sessionId) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-cc-border/60 bg-cc-hover/40 px-1.5 py-0.5 text-[10px] leading-none">
      {dotProps && <SessionStatusDot className="mt-0" {...dotProps} />}
      <span className="text-cc-muted">{label}</span>
      <SessionInlineLink
        sessionId={sessionId}
        sessionNum={sessionNum}
        className="font-mono-code text-amber-400 hover:text-amber-300 hover:underline decoration-dotted underline-offset-2"
      >
        {`#${sessionNum ?? "?"}`}
      </SessionInlineLink>
    </span>
  );
}

function ThreadJourneyHover({ row, label }: { row: LeaderThreadRow; label: { label: string; color?: string } }) {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const zoomLevel = useStore((s) => s.zoomLevel ?? 1);
  const cardWidth = 360;
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
  }, [hoverRect]);

  function handleMouseEnter(e: MouseEvent<HTMLDivElement>) {
    if (!row.journey?.phaseIds?.length) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setHoverRect(e.currentTarget.getBoundingClientRect());
  }

  function handleMouseLeave() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  return (
    <>
      <div
        className="inline-flex max-w-full items-center gap-1 rounded-full border border-cc-border/60 bg-cc-card/70 px-1.5 py-0.5 text-[10px] leading-none text-cc-muted"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        data-testid="leader-thread-journey-hover-target"
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          style={label.color ? { color: label.color } : undefined}
        />
        <span className="truncate" style={label.color ? { color: label.color } : undefined}>
          {label.label}
        </span>
      </div>
      {hoverRect &&
        row.journey &&
        createPortal(
          <div
            ref={cardRef}
            className="fixed z-50 pointer-events-auto hidden-on-touch"
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
            data-testid="leader-thread-journey-hover-card"
          >
            <div className="rounded-lg border border-cc-border bg-cc-card p-2.5 shadow-xl">
              <QuestJourneyPreviewCard
                journey={row.journey}
                status={journeyStatusForThread(row)}
                quest={{ questId: row.questId ?? row.threadKey, title: row.title }}
                onQuestClick={() => row.questId && useStore.getState().openQuestOverlay(row.questId)}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function LeaderThreadRowItem({
  row,
  selected,
  onSelect,
  layout = "desktop",
}: {
  row: LeaderThreadRow;
  selected: boolean;
  onSelect: () => void;
  layout?: "desktop" | "mobileSheet";
}) {
  const phase = phaseLabelForThread(row);
  const waitForLabel = waitForLabelForThread(row);
  const messageCountLabel = waitForLabel
    ? `${row.messageCount} msg${row.messageCount !== 1 ? "s" : ""}`
    : `${row.messageCount} message${row.messageCount !== 1 ? "s" : ""}`;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect();
  };
  const rowClassName =
    layout === "mobileSheet"
      ? `w-full cursor-pointer border-b border-cc-border/60 px-2.5 py-2 text-left outline-none transition-colors last:border-b-0 ${
          selected ? "bg-cc-hover" : "hover:bg-cc-hover/50 focus:bg-cc-hover/50"
        }`
      : `min-w-52 shrink-0 cursor-pointer border-r border-cc-border/60 px-2.5 py-2 outline-none transition-colors sm:min-w-0 sm:w-full sm:border-r-0 sm:border-b ${
          selected ? "bg-cc-hover" : "hover:bg-cc-hover/50 focus:bg-cc-hover/50"
        }`;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={rowClassName}
      data-testid="leader-thread-row"
      data-thread-key={row.threadKey}
      data-thread-section={row.section}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        {row.questId ? (
          <>
            <QuestInlineLink
              questId={row.questId}
              stopPropagation
              className="shrink-0 text-left text-xs font-medium font-mono-code text-blue-300 hover:text-blue-200 hover:underline"
            >
              {row.questId}
            </QuestInlineLink>
            <span className="min-w-0 truncate text-xs font-medium text-cc-fg">{row.title}</span>
          </>
        ) : (
          <span className="min-w-0 truncate text-xs font-medium text-cc-fg">{row.title}</span>
        )}
      </div>
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
        {phase && <ThreadJourneyHover row={row} label={phase} />}
        <ThreadParticipantChip
          label="W"
          participant={row.rowStatus?.worker}
          fallbackSessionId={row.boardRow?.worker}
          fallbackSessionNum={row.boardRow?.workerNum}
        />
        <ThreadParticipantChip label="R" participant={row.rowStatus?.reviewer} />
      </div>
      <div
        className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] tabular-nums text-cc-muted/85"
        data-testid="leader-thread-row-stats"
      >
        {waitForLabel && <ThreadWaitForChip label={waitForLabel} />}
        <span className="min-w-0 truncate">{messageCountLabel}</span>
      </div>
    </div>
  );
}

function LeaderThreadSwitcher({
  sessionId,
  selectedThreadKey,
  onSelectThread,
  mode = "auto",
}: {
  sessionId: string;
  selectedThreadKey: string;
  onSelectThread: (threadKey: string) => void;
  mode?: ThreadSelectorMode;
}) {
  const { messages, activeRows, doneRows } = useLeaderThreadModel(sessionId);
  const normalizedSelected = selectedThreadKey.toLowerCase();
  const mainMessageCount = useMemo(() => filterMessagesForThread(messages, MAIN_THREAD_KEY).length, [messages]);
  const desktopClass =
    mode === "mobile"
      ? "hidden"
      : "hidden shrink-0 overflow-x-auto border-b border-cc-border bg-cc-card/70 sm:flex sm:w-64 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:border-b-0 sm:border-r";

  return (
    <aside className={desktopClass} data-testid="leader-thread-switcher">
      <button
        type="button"
        onClick={() => onSelectThread(MAIN_THREAD_KEY)}
        className={`shrink-0 border-r border-cc-border/60 px-3 py-2 text-left transition-colors sm:w-full sm:border-r-0 sm:border-b ${
          normalizedSelected === MAIN_THREAD_KEY ? "bg-cc-hover text-cc-fg" : "text-cc-muted hover:bg-cc-hover/60"
        }`}
        data-testid="leader-thread-main-row"
      >
        <div className="text-xs font-semibold">Main</div>
        <div className="text-[10px] text-cc-muted/80 tabular-nums">{mainMessageCount} messages</div>
      </button>
      <button
        type="button"
        onClick={() => onSelectThread(ALL_THREADS_KEY)}
        className={`shrink-0 border-r border-cc-border/60 px-3 py-2 text-left transition-colors sm:w-full sm:border-r-0 sm:border-b ${
          normalizedSelected === ALL_THREADS_KEY ? "bg-cc-hover text-cc-fg" : "text-cc-muted hover:bg-cc-hover/60"
        }`}
        data-testid="leader-thread-all-row"
      >
        <div className="text-xs font-semibold">All Threads</div>
        <div className="text-[10px] text-cc-muted/80 tabular-nums">{messages.length} messages</div>
      </button>
      {activeRows.length > 0 && (
        <div className="flex shrink-0 sm:block">
          <div className="hidden px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-cc-muted/70 sm:block">
            Active
          </div>
          {activeRows.map((row) => (
            <LeaderThreadRowItem
              key={row.threadKey}
              row={row}
              selected={normalizedSelected === row.threadKey}
              onSelect={() => onSelectThread(row.threadKey)}
            />
          ))}
        </div>
      )}
      {doneRows.length > 0 && (
        <div className="flex shrink-0 sm:block">
          <div className="hidden px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-cc-muted/70 sm:block">
            Done
          </div>
          {doneRows.map((row) => (
            <LeaderThreadRowItem
              key={row.threadKey}
              row={row}
              selected={normalizedSelected === row.threadKey}
              onSelect={() => onSelectThread(row.threadKey)}
            />
          ))}
        </div>
      )}
    </aside>
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

type ThreadSelectorMode = "auto" | "mobile";

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
  return { messages, rows, activeRows, doneRows };
}

function isQueuedLeaderThreadRow(row: LeaderThreadRow): boolean {
  return isQueuedThreadRowStatus(row.boardStatus ?? row.boardRow?.status);
}

function splitMobileThreadRows(activeRows: LeaderThreadRow[]): {
  activeRows: LeaderThreadRow[];
  queuedRows: LeaderThreadRow[];
} {
  const queuedRows: LeaderThreadRow[] = [];
  const nonQueuedActiveRows: LeaderThreadRow[] = [];
  for (const row of activeRows) {
    if (isQueuedLeaderThreadRow(row)) queuedRows.push(row);
    else nonQueuedActiveRows.push(row);
  }
  return { activeRows: nonQueuedActiveRows, queuedRows };
}

function summarizeMobileThreadRows({
  activeRows,
  doneRows,
}: {
  activeRows: LeaderThreadRow[];
  doneRows: LeaderThreadRow[];
}): { primary: string; secondary: string } {
  const blockedCount = activeRows.filter((row) => waitForLabelForThread(row)).length;
  const queuedCount = activeRows.filter(isQueuedLeaderThreadRow).length;
  if (blockedCount > 0) {
    return { primary: `${blockedCount} blocked`, secondary: `${activeRows.length} active` };
  }
  if (queuedCount > 0) {
    return { primary: `${queuedCount} queued`, secondary: `${activeRows.length} active` };
  }
  if (activeRows.length > 0) {
    return {
      primary: `${activeRows.length} active`,
      secondary: doneRows.length > 0 ? `${doneRows.length} done` : "Main ready",
    };
  }
  if (doneRows.length > 0) {
    return { primary: `${doneRows.length} done`, secondary: "Main ready" };
  }
  return { primary: "Main", secondary: "No threads" };
}

function threadLabelForKey(threadKey: string, rows: LeaderThreadRow[]): string {
  const normalized = threadKey.toLowerCase();
  if (normalized === MAIN_THREAD_KEY) return "Main";
  if (normalized === ALL_THREADS_KEY) return "All Threads";
  const row = rows.find((candidate) => candidate.threadKey === normalized);
  return row?.questId ?? row?.title ?? threadKey;
}

function MobileMainThreadButton({
  selected,
  messageCount,
  onSelect,
  label = "Main",
  testId = "mobile-thread-main-row",
}: {
  selected: boolean;
  messageCount: number;
  onSelect: () => void;
  label?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-cc-primary/40 bg-cc-primary/10 text-cc-fg"
          : "border-cc-border/70 bg-cc-card/80 text-cc-muted hover:bg-cc-hover/60"
      }`}
      data-testid={testId}
    >
      <div className="text-xs font-semibold">{label}</div>
      <div className="mt-0.5 text-[10px] tabular-nums text-cc-muted/80">
        {messageCount} message{messageCount !== 1 ? "s" : ""}
      </div>
    </button>
  );
}

function MobileThreadSection({
  title,
  rows,
  selectedThreadKey,
  onSelectThread,
}: {
  title: string;
  rows: LeaderThreadRow[];
  selectedThreadKey: string;
  onSelectThread: (threadKey: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section>
      <div className="px-1 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-cc-muted/70">{title}</div>
      <div className="overflow-hidden rounded-md border border-cc-border/70 bg-cc-card/60">
        {rows.map((row) => (
          <LeaderThreadRowItem
            key={row.threadKey}
            row={row}
            layout="mobileSheet"
            selected={selectedThreadKey === row.threadKey}
            onSelect={() => onSelectThread(row.threadKey)}
          />
        ))}
      </div>
    </section>
  );
}

function MobileLeaderThreadSwitcher({
  sessionId,
  selectedThreadKey,
  onSelectThread,
  mode = "auto",
  initialOpen = false,
}: {
  sessionId: string;
  selectedThreadKey: string;
  onSelectThread: (threadKey: string) => void;
  mode?: ThreadSelectorMode;
  initialOpen?: boolean;
}) {
  const { messages, activeRows, doneRows } = useLeaderThreadModel(sessionId);
  const [open, setOpen] = useState(initialOpen);
  const normalizedSelected = selectedThreadKey.toLowerCase();
  const summary = summarizeMobileThreadRows({ activeRows, doneRows });
  const mobileRows = splitMobileThreadRows(activeRows);
  const mobileOnlyClass = mode === "mobile" ? "" : " sm:hidden";
  const mainMessageCount = useMemo(() => filterMessagesForThread(messages, MAIN_THREAD_KEY).length, [messages]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function handleSelectThread(threadKey: string) {
    onSelectThread(threadKey);
    setOpen(false);
  }

  return (
    <>
      <div
        className={`shrink-0 border-b border-cc-border bg-cc-card/80 px-3 py-2${mobileOnlyClass}`}
        data-testid="mobile-thread-overview"
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="ml-auto flex max-w-full items-center gap-2 rounded-md border border-cc-border/70 bg-cc-hover/50 px-2.5 py-1.5 text-left shadow-sm transition-colors hover:bg-cc-hover"
          aria-expanded={open}
          data-testid="mobile-thread-overview-button"
        >
          <span className="min-w-0 truncate text-xs font-semibold text-cc-fg">Threads</span>
          <span className="shrink-0 rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-200">
            {summary.primary}
          </span>
          <span className="hidden shrink-0 text-[10px] text-cc-muted min-[380px]:inline">{summary.secondary}</span>
        </button>
      </div>
      {open && (
        <div
          className={`absolute inset-0 z-40 flex flex-col bg-cc-bg text-cc-fg${mobileOnlyClass}`}
          role="dialog"
          aria-modal="true"
          aria-label="Thread selector"
          data-testid="mobile-thread-selector-sheet"
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-cc-border bg-cc-sidebar px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">Threads</div>
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-cc-muted">
                <span className="shrink-0">{summary.primary}</span>
                <span className="text-cc-muted/50">/</span>
                <span className="min-w-0 truncate">{summary.secondary}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-cc-border/70 bg-cc-hover/50 p-2 text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
              aria-label="Close thread selector"
              data-testid="mobile-thread-selector-close"
            >
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            <MobileMainThreadButton
              selected={normalizedSelected === MAIN_THREAD_KEY}
              messageCount={mainMessageCount}
              onSelect={() => handleSelectThread(MAIN_THREAD_KEY)}
            />
            <MobileMainThreadButton
              selected={normalizedSelected === ALL_THREADS_KEY}
              messageCount={messages.length}
              onSelect={() => handleSelectThread(ALL_THREADS_KEY)}
              label="All Threads"
              testId="mobile-thread-all-row"
            />
            <MobileThreadSection
              title="Active"
              rows={mobileRows.activeRows}
              selectedThreadKey={normalizedSelected}
              onSelectThread={handleSelectThread}
            />
            <MobileThreadSection
              title="Queued"
              rows={mobileRows.queuedRows}
              selectedThreadKey={normalizedSelected}
              onSelectThread={handleSelectThread}
            />
            <MobileThreadSection
              title="Done"
              rows={doneRows}
              selectedThreadKey={normalizedSelected}
              onSelectThread={handleSelectThread}
            />
          </div>
        </div>
      )}
    </>
  );
}

export function ChatView({
  sessionId,
  preview = false,
  threadSelectorMode = "auto",
  initialMobileThreadSelectorOpen = false,
}: {
  sessionId: string;
  preview?: boolean;
  threadSelectorMode?: ThreadSelectorMode;
  initialMobileThreadSelectorOpen?: boolean;
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
    })),
  );
  const [selectedThreadKey, setSelectedThreadKey] = useState("main");
  const { rows: threadRows } = useLeaderThreadModel(sessionId);
  const selectedThreadLabel = useMemo(
    () => threadLabelForKey(selectedThreadKey, threadRows),
    [selectedThreadKey, threadRows],
  );
  const selectedThreadCanCompose = !isLeaderSession || selectedThreadKey.toLowerCase() !== ALL_THREADS_KEY;

  useEffect(() => {
    setSelectedThreadKey(MAIN_THREAD_KEY);
  }, [sessionId]);

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

      {/* Plan overlay fills the chat area, OR show the normal message feed */}
      {!preview && showPlanOverlay ? (
        <PlanReviewOverlay permission={planPerm} sessionId={sessionId} onCollapse={() => setPlanCollapsed(true)} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {!preview && isLeaderSession && (
            <>
              <MobileLeaderThreadSwitcher
                sessionId={sessionId}
                selectedThreadKey={selectedThreadKey}
                onSelectThread={setSelectedThreadKey}
                mode={threadSelectorMode}
                initialOpen={initialMobileThreadSelectorOpen}
              />
              <LeaderThreadSwitcher
                sessionId={sessionId}
                selectedThreadKey={selectedThreadKey}
                onSelectThread={setSelectedThreadKey}
                mode={threadSelectorMode}
              />
            </>
          )}
          <MessageFeed
            sessionId={sessionId}
            threadKey={isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY}
            onSelectThread={isLeaderSession ? setSelectedThreadKey : undefined}
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

      {/* Persistent work board for orchestrator sessions */}
      {!preview && (
        <WorkBoardBar
          sessionId={sessionId}
          currentThreadKey={isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY}
          currentThreadLabel={isLeaderSession ? selectedThreadLabel : "Main"}
          onReturnToMain={isLeaderSession ? () => setSelectedThreadKey(MAIN_THREAD_KEY) : undefined}
        />
      )}

      {/* Composer */}
      {!preview && selectedThreadCanCompose && (
        <Composer
          sessionId={sessionId}
          threadKey={isLeaderSession ? selectedThreadKey : MAIN_THREAD_KEY}
          questId={isLeaderSession && selectedThreadKey !== MAIN_THREAD_KEY ? selectedThreadKey : undefined}
        />
      )}
      {!preview && !selectedThreadCanCompose && (
        <div className="shrink-0 border-t border-cc-border bg-cc-card px-3 py-2">
          <button
            type="button"
            onClick={() => setSelectedThreadKey(MAIN_THREAD_KEY)}
            className="inline-flex max-w-full items-center gap-2 rounded-md border border-cc-border/70 bg-cc-hover/50 px-3 py-1.5 text-xs font-medium text-cc-fg transition-colors hover:bg-cc-hover"
            data-testid="all-threads-return-main"
          >
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="truncate">Return to Main</span>
          </button>
        </div>
      )}
    </div>
  );
}
