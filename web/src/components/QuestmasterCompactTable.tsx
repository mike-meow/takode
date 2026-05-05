import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { QuestmasterCompactSort, QuestmasterCompactSortColumn, QuestmasterCompactSortDirection } from "../api.js";
import { useStore } from "../store.js";
import type { QuestFeedbackEntry, QuestmasterTask, QuestStatus } from "../types.js";
import { getHighlightParts } from "../utils/highlight.js";
import { markdownToPlainText, writeClipboardText } from "../utils/copy-utils.js";
import {
  getQuestLeaderSessionId,
  getQuestOwnerSessionId,
  timeAgo,
  verificationProgress,
} from "../utils/quest-helpers.js";
import type { QuestJourneyContext } from "../utils/quest-journey-context.js";
import { QUEST_STATUS_THEME } from "../utils/quest-status-theme.js";
import { getQuestJourneyPhaseForState, getQuestJourneyPresentation } from "../../shared/quest-journey.js";
import { QuestHoverCard } from "./QuestHoverCard.js";
import { SessionNumChip } from "./SessionNumChip.js";

const STATUS_SORT_RANK: Record<QuestStatus, number> = {
  idea: 0,
  refined: 1,
  in_progress: 2,
  done: 3,
};

const COMPACT_SORT_COLUMNS: readonly QuestmasterCompactSortColumn[] = [
  "quest",
  "title",
  "owner",
  "leader",
  "status",
  "verify",
  "feedback",
  "updated",
];
const DEFAULT_COMPACT_SORT: QuestmasterCompactSort = { column: "updated", direction: "desc" };
const DEFAULT_COMPACT_SORT_DIRECTIONS: Record<QuestmasterCompactSortColumn, QuestmasterCompactSortDirection> = {
  quest: "asc",
  title: "asc",
  owner: "asc",
  leader: "asc",
  status: "asc",
  verify: "desc",
  feedback: "desc",
  updated: "desc",
};
const COMPACT_TLDR_MAX_CHARS = 180;
const COMPACT_QUEST_ID_CONTROL_COLUMNS: CSSProperties = {
  gridTemplateColumns: "7.5ch 1.25rem",
};

type CompactSortContext = {
  sessionNumById: Map<string, number>;
  sessionNameById: Map<string, string>;
  journeyContextByQuestId: Map<string, QuestJourneyContext>;
};

export type QuestmasterDisplayStatus = {
  label: string;
  dotClass?: string;
  dotStyle?: CSSProperties;
  textClass: string;
  sortRank: number;
};

export function questRecencyTs(quest: QuestmasterTask): number {
  return Math.max(quest.createdAt, (quest as { updatedAt?: number }).updatedAt ?? 0, quest.statusChangedAt ?? 0);
}

export function normalizeCompactSort(sort: unknown): QuestmasterCompactSort {
  if (!sort || typeof sort !== "object" || Array.isArray(sort)) return DEFAULT_COMPACT_SORT;
  const raw = sort as Record<string, unknown>;
  if (
    !COMPACT_SORT_COLUMNS.includes(raw.column as QuestmasterCompactSortColumn) ||
    (raw.direction !== "asc" && raw.direction !== "desc")
  ) {
    return DEFAULT_COMPACT_SORT;
  }
  return { column: raw.column as QuestmasterCompactSortColumn, direction: raw.direction };
}

export function nextCompactSort(
  current: QuestmasterCompactSort,
  column: QuestmasterCompactSortColumn,
): QuestmasterCompactSort {
  if (current.column === column) {
    return { column, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { column, direction: DEFAULT_COMPACT_SORT_DIRECTIONS[column] };
}

export function getQuestmasterDisplayStatus(
  quest: QuestmasterTask,
  journeyContext?: QuestJourneyContext,
): QuestmasterDisplayStatus {
  const isCancelled = "cancelled" in quest && !!(quest as { cancelled?: boolean }).cancelled;
  if (isCancelled) {
    return {
      label: "Cancelled",
      dotClass: "bg-red-400",
      textClass: "text-red-300",
      sortRank: 5,
    };
  }

  if (quest.status === "done") {
    const cfg = { ...QUEST_STATUS_THEME.done, label: "Completed" };
    return {
      label: cfg.label,
      dotClass: cfg.dot,
      textClass: cfg.text,
      sortRank: STATUS_SORT_RANK.done,
    };
  }

  if (journeyContext && !journeyContext.completed) {
    const presentation = getQuestJourneyPresentation(journeyContext.row.status);
    const phase = getQuestJourneyPhaseForState(journeyContext.row.status);
    if (presentation || phase) {
      const accent = phase?.color.accent;
      return {
        label: presentation?.label ?? phase?.label ?? "In Progress",
        dotStyle: accent ? { backgroundColor: accent } : undefined,
        dotClass: accent ? undefined : QUEST_STATUS_THEME.in_progress.dot,
        textClass: "text-cc-muted",
        sortRank: 2,
      };
    }
  }

  const cfg =
    quest.status === "refined"
      ? { ...QUEST_STATUS_THEME.refined, label: "Actionable" }
      : QUEST_STATUS_THEME[quest.status];
  const sortRank = STATUS_SORT_RANK[quest.status] ?? 4;
  return {
    label: cfg.label,
    dotClass: cfg.dot,
    textClass: cfg.text,
    sortRank,
  };
}

export function renderSearchHighlightText(text: string, searchText: string): React.ReactNode {
  if (!searchText) return text;
  const parts = getHighlightParts(text, searchText);
  if (!parts.some((part) => part.matched)) return text;
  return (
    <>
      {parts.map((part, index) =>
        part.matched ? (
          <mark key={`${part.text}-${index}`} className="bg-amber-300/25 text-amber-100 rounded-[2px] px-0.5">
            {part.text}
          </mark>
        ) : (
          <span key={`${part.text}-${index}`}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function sortCompactQuests(
  quests: QuestmasterTask[],
  sort: QuestmasterCompactSort,
  context: CompactSortContext,
): QuestmasterTask[] {
  return [...quests].sort((left, right) => {
    const columnResult = compareCompactSortColumn(left, right, sort.column, context);
    const directed = sort.direction === "asc" ? columnResult : -columnResult;
    if (directed !== 0) return directed;
    const recencyResult = questRecencyTs(right) - questRecencyTs(left);
    if (recencyResult !== 0) return recencyResult;
    return compareQuestIds(left.questId, right.questId);
  });
}

export function QuestStatusHoverTarget({ quest, children }: { quest: QuestmasterTask; children: ReactNode }) {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    },
    [],
  );

  function handleMouseEnter(event: ReactMouseEvent<HTMLSpanElement>) {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    setHoverRect(event.currentTarget.getBoundingClientRect());
  }

  function handleMouseLeave() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    hideHoverTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  return (
    <>
      <span
        className="inline-flex cursor-help"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        title="Show quest journey"
      >
        {children}
      </span>
      {hoverRect && (
        <QuestHoverCard
          quest={quest}
          anchorRect={hoverRect}
          onMouseEnter={() => {
            if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
          }}
          onMouseLeave={() => setHoverRect(null)}
        />
      )}
    </>
  );
}

export function CompactQuestTable({
  quests,
  onOpenQuest,
  searchText,
  journeyContextByQuestId,
  sort,
  sortSaving,
  onSortChange,
}: {
  quests: QuestmasterTask[];
  onOpenQuest: (quest: QuestmasterTask) => void;
  searchText: string;
  journeyContextByQuestId: Map<string, QuestJourneyContext>;
  sort: QuestmasterCompactSort;
  sortSaving: boolean;
  onSortChange: (column: QuestmasterCompactSortColumn) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-cc-border bg-cc-card">
      <table className="w-full min-w-[840px] text-xs">
        <thead>
          <tr className="border-b border-cc-border bg-cc-bg/50 text-cc-muted">
            <CompactSortHeader
              column="quest"
              label="Quest"
              sort={sort}
              sortSaving={sortSaving}
              onSortChange={onSortChange}
            />
            <CompactSortHeader
              column="title"
              label="Title"
              sort={sort}
              sortSaving={sortSaving}
              onSortChange={onSortChange}
            />
            <CompactSortHeader
              column="owner"
              label="Owner"
              sort={sort}
              sortSaving={sortSaving}
              onSortChange={onSortChange}
            />
            <CompactSortHeader
              column="leader"
              label="Leader"
              sort={sort}
              sortSaving={sortSaving}
              onSortChange={onSortChange}
            />
            <CompactSortHeader
              column="status"
              label="Status"
              sort={sort}
              sortSaving={sortSaving}
              onSortChange={onSortChange}
            />
            <CompactSortHeader
              column="verify"
              label="Verify"
              sort={sort}
              sortSaving={sortSaving}
              onSortChange={onSortChange}
            />
            <CompactSortHeader
              column="feedback"
              label="Feedback"
              sort={sort}
              sortSaving={sortSaving}
              onSortChange={onSortChange}
            />
            <CompactSortHeader
              column="updated"
              label="Updated"
              sort={sort}
              sortSaving={sortSaving}
              onSortChange={onSortChange}
            />
          </tr>
        </thead>
        <tbody>
          {quests.map((quest) => (
            <CompactQuestRow
              key={quest.id}
              quest={quest}
              onOpenQuest={onOpenQuest}
              searchText={searchText}
              journeyContext={journeyContextByQuestId.get(quest.questId.toLowerCase())}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function questIdSortNumber(questId: string): number | null {
  const match = /^q-(\d+)$/i.exec(questId.trim());
  if (!match) return null;
  return Number(match[1]);
}

function compareQuestIds(left: string, right: string): number {
  const leftNumber = questIdSortNumber(left);
  const rightNumber = questIdSortNumber(right);
  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return leftNumber - rightNumber;
  if (leftNumber !== null && rightNumber === null) return -1;
  if (leftNumber === null && rightNumber !== null) return 1;
  return compareText(left, right);
}

function ownerSortLabel(quest: QuestmasterTask, context: CompactSortContext): string {
  const sessionId = getQuestOwnerSessionId(quest);
  if (!sessionId) return "";
  const sessionNum = context.sessionNumById.get(sessionId);
  if (typeof sessionNum === "number") return `#${String(sessionNum).padStart(8, "0")}`;
  return (context.sessionNameById.get(sessionId) || sessionId).trim().toLowerCase();
}

function leaderSortLabel(quest: QuestmasterTask, context: CompactSortContext): string {
  const sessionId = getQuestLeaderSessionId(quest);
  if (!sessionId) return "";
  const sessionNum = context.sessionNumById.get(sessionId);
  if (typeof sessionNum === "number") return `#${String(sessionNum).padStart(8, "0")}`;
  return (context.sessionNameById.get(sessionId) || sessionId).trim().toLowerCase();
}

function verificationSortTuple(quest: QuestmasterTask): [number, number, number] {
  const hasVerification = "verificationItems" in quest && quest.verificationItems?.length > 0;
  if (!hasVerification) return [0, 0, 0];
  const progress = verificationProgress(quest.verificationItems);
  const ratio = progress.total > 0 ? progress.checked / progress.total : 0;
  return [ratio, progress.checked, progress.total];
}

function feedbackSortTuple(quest: QuestmasterTask): [number, number] {
  const entries = "feedback" in quest ? (quest as { feedback?: QuestFeedbackEntry[] }).feedback : undefined;
  const humanEntries = entries?.filter((entry) => entry.author === "human") ?? [];
  const openCount = humanEntries.filter((entry) => !entry.addressed).length;
  return [openCount, humanEntries.length];
}

function compareNumberTuple(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function compareCompactSortColumn(
  left: QuestmasterTask,
  right: QuestmasterTask,
  column: QuestmasterCompactSortColumn,
  context: CompactSortContext,
): number {
  if (column === "quest") return compareQuestIds(left.questId, right.questId);
  if (column === "title") return compareText(left.title, right.title);
  if (column === "owner") return compareText(ownerSortLabel(left, context), ownerSortLabel(right, context));
  if (column === "leader") return compareText(leaderSortLabel(left, context), leaderSortLabel(right, context));
  if (column === "status") {
    const leftStatus = getQuestmasterDisplayStatus(
      left,
      context.journeyContextByQuestId.get(left.questId.toLowerCase()),
    );
    const rightStatus = getQuestmasterDisplayStatus(
      right,
      context.journeyContextByQuestId.get(right.questId.toLowerCase()),
    );
    return leftStatus.sortRank - rightStatus.sortRank || compareText(leftStatus.label, rightStatus.label);
  }
  if (column === "verify") return compareNumberTuple(verificationSortTuple(left), verificationSortTuple(right));
  if (column === "feedback") return compareNumberTuple(feedbackSortTuple(left), feedbackSortTuple(right));
  return questRecencyTs(left) - questRecencyTs(right);
}

function QuestTldrSnippet({
  text,
  searchText,
  className = "",
}: {
  text: string;
  searchText: string;
  className?: string;
}) {
  const plainText = useMemo(() => markdownToSingleLinePlainText(text), [text]);
  const snippet = useMemo(() => truncatePlainText(plainText, COMPACT_TLDR_MAX_CHARS), [plainText]);
  if (!snippet) return null;
  return (
    <div
      data-testid="quest-compact-tldr"
      className={`truncate text-cc-muted ${className}`}
      title={plainText.length > snippet.length ? plainText : undefined}
    >
      {renderSearchHighlightText(snippet, searchText)}
    </div>
  );
}

function markdownToSingleLinePlainText(markdown: string): string {
  return markdownToPlainText(markdown).replace(/\s+/g, " ").trim();
}

function truncatePlainText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return `${slice}…`;
}

function isInteractiveDescendantKeyTarget(target: EventTarget | null, container: HTMLElement): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const interactive = target.closest<HTMLElement>(
    "a,button,input,textarea,select,summary,[contenteditable='true'],[role='link'],[role='button']",
  );
  return !!interactive && interactive !== container;
}

function CompactSortHeader({
  column,
  label,
  sort,
  sortSaving,
  onSortChange,
}: {
  column: QuestmasterCompactSortColumn;
  label: string;
  sort: QuestmasterCompactSort;
  sortSaving: boolean;
  onSortChange: (column: QuestmasterCompactSortColumn) => void;
}) {
  const isActive = sort.column === column;
  const nextDirection = nextCompactSort(sort, column).direction;
  return (
    <th
      className="px-3 py-1.5 text-left font-medium whitespace-nowrap"
      aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSortChange(column)}
        disabled={sortSaving}
        aria-label={`Sort by ${label} ${nextDirection === "asc" ? "ascending" : "descending"}`}
        className="inline-flex items-center gap-1 font-medium text-current transition-colors hover:text-cc-fg disabled:cursor-wait disabled:opacity-60"
      >
        <span>{label}</span>
        <span aria-hidden="true" className={isActive ? "text-cc-fg" : "text-cc-muted/40"}>
          {isActive ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function CompactQuestIdControls({ quest, searchText }: { quest: QuestmasterTask; searchText: string }) {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [copied, setCopied] = useState(false);
  const hideHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  function handleMouseEnter(event: ReactMouseEvent<HTMLAnchorElement>) {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    setHoverRect(event.currentTarget.getBoundingClientRect());
  }

  function handleMouseLeave() {
    if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
    hideHoverTimerRef.current = setTimeout(() => setHoverRect(null), 100);
  }

  async function handleCopy(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    await writeClipboardText(quest.questId);
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
  }

  return (
    <span
      data-testid="quest-compact-id-controls"
      className="inline-grid items-center gap-1.5"
      style={COMPACT_QUEST_ID_CONTROL_COLUMNS}
    >
      <a
        href={`#/questmaster?quest=${quest.questId}`}
        className="justify-self-start font-mono-code text-blue-400 hover:text-blue-300 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-300/70 rounded-sm"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          useStore.getState().openQuestOverlay(quest.questId);
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {renderSearchHighlightText(quest.questId, searchText)}
      </a>
      <button
        type="button"
        className={`inline-flex h-5 w-5 items-center justify-center justify-self-start rounded border border-transparent text-cc-muted transition-colors hover:border-cc-border hover:bg-cc-hover hover:text-cc-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cc-primary/70 ${
          copied ? "text-emerald-300" : ""
        }`}
        aria-label={`Copy quest ID ${quest.questId}`}
        title={copied ? `Copied ${quest.questId}` : `Copy ${quest.questId}`}
        onClick={handleCopy}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
          <rect x="5" y="3" width="8" height="10" rx="1.5" />
          <path d="M3 11V5.5A2.5 2.5 0 015.5 3H9" />
        </svg>
      </button>
      {hoverRect && (
        <QuestHoverCard
          quest={quest}
          anchorRect={hoverRect}
          onMouseEnter={() => {
            if (hideHoverTimerRef.current) clearTimeout(hideHoverTimerRef.current);
          }}
          onMouseLeave={() => setHoverRect(null)}
        />
      )}
    </span>
  );
}

const CompactQuestRow = memo(function CompactQuestRow({
  quest,
  onOpenQuest,
  searchText,
  journeyContext,
}: {
  quest: QuestmasterTask;
  onOpenQuest: (quest: QuestmasterTask) => void;
  searchText: string;
  journeyContext?: QuestJourneyContext;
}) {
  const isCancelled = "cancelled" in quest && !!(quest as { cancelled?: boolean }).cancelled;
  const displayStatus = getQuestmasterDisplayStatus(quest, journeyContext);
  const questSessionId = getQuestOwnerSessionId(quest);
  const leaderSessionId = getQuestLeaderSessionId(quest);
  const hasVerification = "verificationItems" in quest && quest.verificationItems?.length > 0;
  const vProgress = hasVerification ? verificationProgress(quest.verificationItems) : null;
  const feedbackEntries = "feedback" in quest ? (quest as { feedback?: QuestFeedbackEntry[] }).feedback : undefined;
  const unaddressedFeedbackCount =
    feedbackEntries?.filter((entry) => entry.author === "human" && !entry.addressed).length ?? 0;
  const totalFeedbackCount = feedbackEntries?.filter((entry) => entry.author === "human").length ?? 0;

  return (
    <tr
      data-quest-id={quest.questId}
      role="button"
      tabIndex={0}
      onClick={() => onOpenQuest(quest)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          if (isInteractiveDescendantKeyTarget(e.target, e.currentTarget)) return;
          e.preventDefault();
          onOpenQuest(quest);
        }
      }}
      className={`group border-b border-cc-border last:border-0 hover:bg-cc-hover/30 focus-visible:bg-cc-hover/40 focus-visible:outline-none cursor-pointer ${
        isCancelled ? "opacity-60" : ""
      }`}
    >
      <td className="px-3 py-1.5 whitespace-nowrap align-middle">
        <CompactQuestIdControls quest={quest} searchText={searchText} />
      </td>
      <td className="px-3 py-1.5 align-middle">
        <div
          className={`max-w-[360px] truncate font-medium ${isCancelled ? "text-cc-muted line-through" : "text-cc-fg"}`}
        >
          {renderSearchHighlightText(quest.title, searchText)}
        </div>
        {quest.tags && quest.tags.length > 0 && (
          <div className="mt-0.5 flex items-center gap-1 overflow-hidden text-[10px] text-cc-muted/60">
            {quest.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="truncate">
                #{tag.toLowerCase()}
              </span>
            ))}
          </div>
        )}
        {quest.tldr && (
          <QuestTldrSnippet text={quest.tldr} searchText={searchText} className="mt-0.5 max-w-[360px] text-[11px]" />
        )}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap align-middle">
        {questSessionId ? (
          <SessionNumChip sessionId={questSessionId} />
        ) : (
          <span className="text-cc-muted">{"\u2014"}</span>
        )}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap align-middle">
        {leaderSessionId ? (
          <SessionNumChip sessionId={leaderSessionId} />
        ) : (
          <span className="text-cc-muted">{"\u2014"}</span>
        )}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap align-middle">
        <QuestStatusHoverTarget quest={quest}>
          <span className={`inline-flex items-center gap-1.5 ${displayStatus.textClass}`}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${displayStatus.dotClass ?? ""}`}
              style={displayStatus.dotStyle}
            />
            <span>{displayStatus.label}</span>
          </span>
        </QuestStatusHoverTarget>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap align-middle text-cc-muted tabular-nums">
        {vProgress ? `${vProgress.checked}/${vProgress.total}` : "\u2014"}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap align-middle tabular-nums">
        {totalFeedbackCount > 0 ? (
          <span className={unaddressedFeedbackCount > 0 ? "text-amber-400" : "text-emerald-400/70"}>
            {unaddressedFeedbackCount > 0
              ? `${unaddressedFeedbackCount} open / ${totalFeedbackCount}`
              : `${totalFeedbackCount} addressed`}
          </span>
        ) : (
          <span className="text-cc-muted">{"\u2014"}</span>
        )}
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap align-middle text-cc-muted/70">{timeAgo(questRecencyTs(quest))}</td>
    </tr>
  );
});
