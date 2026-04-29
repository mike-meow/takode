import { useMemo } from "react";
import { useStore } from "../store.js";
import type { QuestFeedbackEntry, QuestmasterTask, QuestVerificationItem } from "../types.js";
import { getQuestStatusTheme } from "../utils/quest-status-theme.js";
import { isQuestUnderReview, isVerificationInboxUnread } from "../utils/quest-editor-helpers.js";
import { getQuestLeaderSessionId } from "../utils/quest-helpers.js";
import { formatWaitForRefLabel } from "../../shared/quest-journey.js";
import { orderBoardRows, type BoardRowData } from "./BoardTable.js";
import { QuestJourneyCompactSummary } from "./QuestJourneyTimeline.js";
import { SessionInlineLink } from "./SessionInlineLink.js";

type QuestStatusContextSource = "selected-session" | "board-attention" | "board-active" | "board-proposed";

interface QuestStatusContext {
  questId: string;
  title: string;
  status: string;
  quest?: QuestmasterTask;
  row?: BoardRowData;
  source: QuestStatusContextSource;
}

interface QuestCounts {
  verification?: {
    checked: number;
    total: number;
  };
  inboxUnread: boolean;
  unaddressedFeedback: number;
  addressedFeedback: number;
  commits: number;
}

function humanFeedback(quest?: QuestmasterTask): QuestFeedbackEntry[] {
  return (quest?.feedback ?? []).filter((entry) => entry.author === "human");
}

function verificationProgress(items?: QuestVerificationItem[]): QuestCounts["verification"] {
  if (!items || items.length === 0) return undefined;
  return {
    checked: items.filter((item) => item.checked).length,
    total: items.length,
  };
}

function questVerificationItems(quest?: QuestmasterTask): QuestVerificationItem[] | undefined {
  if (!quest || !("verificationItems" in quest)) return undefined;
  return quest.verificationItems;
}

function questCounts(quest?: QuestmasterTask): QuestCounts {
  const feedback = humanFeedback(quest);
  return {
    verification: verificationProgress(questVerificationItems(quest)),
    inboxUnread: quest ? isVerificationInboxUnread(quest) : false,
    unaddressedFeedback: feedback.filter((entry) => !entry.addressed).length,
    addressedFeedback: feedback.filter((entry) => entry.addressed).length,
    commits: quest?.commitShas?.length ?? 0,
  };
}

function isProposedRow(row: BoardRowData): boolean {
  return row.journey?.mode === "proposed" || (row.status ?? "").trim().toUpperCase() === "PROPOSED";
}

function hasBoardWaitState(row?: BoardRowData): boolean {
  return !!row && ((row.waitForInput?.length ?? 0) > 0 || (row.waitFor?.length ?? 0) > 0);
}

function hasReviewState(row?: BoardRowData): boolean {
  return (row?.status ?? "").trim().toUpperCase().includes("REVIEW");
}

function boardRowAttentionScore(row: BoardRowData, quest?: QuestmasterTask): number {
  const counts = questCounts(quest);
  if ((row.waitForInput?.length ?? 0) > 0) return 0;
  if (counts.unaddressedFeedback > 0) return 1;
  if (counts.inboxUnread) return 2;
  if (quest && isQuestUnderReview(quest)) return 3;
  if (hasReviewState(row)) return 4;
  if ((row.waitFor?.length ?? 0) > 0) return 5;
  if (!isProposedRow(row)) return 6;
  return 7;
}

function sourceForBoardRow(row: BoardRowData, quest?: QuestmasterTask): QuestStatusContextSource {
  const score = boardRowAttentionScore(row, quest);
  if (score <= 5) return "board-attention";
  return isProposedRow(row) ? "board-proposed" : "board-active";
}

function sourceLabel(source: QuestStatusContextSource): string {
  switch (source) {
    case "selected-session":
      return "Selected session quest";
    case "board-attention":
      return "Board attention row";
    case "board-active":
      return "Board active row";
    case "board-proposed":
      return "Board proposed row";
  }
}

function findQuest(quests: QuestmasterTask[], questId?: string): QuestmasterTask | undefined {
  if (!questId) return undefined;
  const normalized = questId.toLowerCase();
  return quests.find((quest) => quest.questId.toLowerCase() === normalized);
}

function pickBoardRow(board: BoardRowData[], quests: QuestmasterTask[]): BoardRowData | undefined {
  return orderBoardRows(board)
    .map((row) => ({ row, quest: findQuest(quests, row.questId) }))
    .sort((a, b) => {
      const byAttention = boardRowAttentionScore(a.row, a.quest) - boardRowAttentionScore(b.row, b.quest);
      if (byAttention !== 0) return byAttention;
      return b.row.updatedAt - a.row.updatedAt || a.row.questId.localeCompare(b.row.questId);
    })[0]?.row;
}

function deriveQuestStatusContext({
  session,
  board,
  quests,
}: {
  session?: { claimedQuestId?: string; claimedQuestTitle?: string; claimedQuestStatus?: string };
  board?: BoardRowData[];
  quests: QuestmasterTask[];
}): QuestStatusContext | null {
  if (session?.claimedQuestId) {
    const quest = findQuest(quests, session.claimedQuestId);
    return {
      questId: session.claimedQuestId,
      title: quest?.title ?? session.claimedQuestTitle ?? session.claimedQuestId,
      status: quest?.status ?? session.claimedQuestStatus ?? "in_progress",
      quest,
      row: board?.find((row) => row.questId.toLowerCase() === session.claimedQuestId?.toLowerCase()),
      source: "selected-session",
    };
  }

  const row = board && board.length > 0 ? pickBoardRow(board, quests) : undefined;
  if (!row) return null;
  const quest = findQuest(quests, row.questId);
  return {
    questId: row.questId,
    title: quest?.title ?? row.title ?? row.questId,
    status: quest?.status ?? row.status ?? "in_progress",
    quest,
    row,
    source: sourceForBoardRow(row, quest),
  };
}

function attentionLine(context: QuestStatusContext, counts: QuestCounts): string | null {
  const row = context.row;
  if ((row?.waitForInput?.length ?? 0) > 0) {
    return `Waiting for input: ${row!.waitForInput!.join(", ")}`;
  }
  if ((row?.waitFor?.length ?? 0) > 0) {
    return `Waiting for: ${row!.waitFor!.map(formatWaitForRefLabel).join(", ")}`;
  }
  if (counts.unaddressedFeedback > 0) {
    return `${counts.unaddressedFeedback} unaddressed human feedback`;
  }
  if (counts.inboxUnread) {
    return "Review inbox needs attention";
  }
  if (context.quest && isQuestUnderReview(context.quest)) {
    return "Under review";
  }
  if (hasReviewState(row)) {
    return `Review phase: ${row!.status}`;
  }
  return null;
}

function OwnerChip({ context }: { context: QuestStatusContext }) {
  const ownerSessionId = context.quest && "sessionId" in context.quest ? context.quest.sessionId : context.row?.worker;
  const resolvedSessionNum = useStore((state) =>
    ownerSessionId
      ? (state.sdkSessions.find((session) => session.sessionId === ownerSessionId)?.sessionNum ?? null)
      : null,
  );
  const ownerSessionNum = context.row?.worker === ownerSessionId ? context.row?.workerNum : resolvedSessionNum;
  if (!ownerSessionId) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-cc-muted">
      <span className="shrink-0">Owner</span>
      <SessionInlineLink
        sessionId={ownerSessionId}
        sessionNum={ownerSessionNum}
        className="min-w-0 truncate font-mono-code text-amber-400 hover:text-amber-300 hover:underline decoration-dotted underline-offset-2"
      >
        {ownerSessionNum != null ? `#${ownerSessionNum}` : ownerSessionId.slice(0, 8)}
      </SessionInlineLink>
    </div>
  );
}

function LeaderChip({ quest }: { quest?: QuestmasterTask }) {
  const leaderSessionId = quest ? getQuestLeaderSessionId(quest) : null;
  const leaderSessionNum = useStore((state) =>
    leaderSessionId
      ? (state.sdkSessions.find((session) => session.sessionId === leaderSessionId)?.sessionNum ?? null)
      : null,
  );
  if (!leaderSessionId) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-cc-muted">
      <span className="shrink-0">Leader</span>
      <SessionInlineLink
        sessionId={leaderSessionId}
        sessionNum={leaderSessionNum}
        className="min-w-0 truncate font-mono-code text-blue-400 hover:text-blue-300 hover:underline decoration-dotted underline-offset-2"
      >
        {leaderSessionNum != null ? `#${leaderSessionNum}` : leaderSessionId.slice(0, 8)}
      </SessionInlineLink>
    </div>
  );
}

function MetricPill({ label, value, tone = "muted" }: { label: string; value: string; tone?: "muted" | "attention" }) {
  const toneClass =
    tone === "attention"
      ? "border-amber-400/20 bg-amber-400/10 text-amber-200"
      : "border-cc-border bg-cc-hover/60 text-cc-muted";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${toneClass}`}>
      <span className="text-cc-muted/75">{label}</span>
      <span className="font-medium text-cc-fg">{value}</span>
    </span>
  );
}

export function QuestStatusPanel({ sessionId }: { sessionId: string }) {
  const session = useStore((state) => state.sessions.get(sessionId));
  const board = useStore((state) => state.sessionBoards.get(sessionId));
  const quests = useStore((state) => state.quests);
  const openQuestOverlay = useStore((state) => state.openQuestOverlay);

  const context = useMemo(() => deriveQuestStatusContext({ session, board, quests }), [board, quests, session]);
  const counts = useMemo(() => questCounts(context?.quest), [context?.quest]);
  if (!context) return null;

  const statusTheme = getQuestStatusTheme(context.status);
  const attention = attentionLine(context, counts);
  const hasMetrics =
    !!counts.verification ||
    counts.inboxUnread ||
    counts.unaddressedFeedback > 0 ||
    counts.addressedFeedback > 0 ||
    counts.commits > 0;

  return (
    <section className="shrink-0 border-b border-cc-border px-3 py-3" aria-label="Quest status">
      <div className="rounded-lg border border-cc-border bg-cc-bg/40 p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/70">
            {sourceLabel(context.source)}
          </span>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] ${statusTheme.bg} ${statusTheme.text} ${statusTheme.border}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${statusTheme.dot}`} />
            {statusTheme.label}
          </span>
        </div>

        <button
          type="button"
          onClick={() => openQuestOverlay(context.questId)}
          className="block w-full min-w-0 text-left cursor-pointer group"
          aria-label={`Open details for ${context.questId}`}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono-code text-[11px] text-blue-400 group-hover:text-blue-300">
              {context.questId}
            </span>
            <span className="min-w-0 truncate text-[13px] font-semibold leading-snug text-cc-fg group-hover:text-cc-primary">
              {context.title}
            </span>
          </div>
        </button>

        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <OwnerChip context={context} />
          <LeaderChip quest={context.quest} />
          {context.row?.worker &&
            context.quest &&
            "sessionId" in context.quest &&
            context.row.worker !== context.quest.sessionId && (
              <SessionInlineLink
                sessionId={context.row.worker}
                sessionNum={context.row.workerNum}
                className="font-mono-code text-[11px] text-amber-400 hover:text-amber-300 hover:underline decoration-dotted underline-offset-2"
              >
                {context.row.workerNum != null ? `#${context.row.workerNum}` : context.row.worker.slice(0, 8)}
              </SessionInlineLink>
            )}
        </div>

        {hasMetrics && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {counts.verification && (
              <MetricPill
                label="Verify"
                value={`${counts.verification.checked}/${counts.verification.total}`}
                tone={context.quest && isQuestUnderReview(context.quest) ? "attention" : "muted"}
              />
            )}
            {counts.inboxUnread && <MetricPill label="Inbox" value="unread" tone="attention" />}
            {counts.unaddressedFeedback > 0 && (
              <MetricPill label="Feedback" value={`${counts.unaddressedFeedback} open`} tone="attention" />
            )}
            {counts.addressedFeedback > 0 && <MetricPill label="Feedback" value={`${counts.addressedFeedback} done`} />}
            {counts.commits > 0 && <MetricPill label="Commits" value={String(counts.commits)} />}
          </div>
        )}

        {attention && (
          <div className="mt-2 rounded-md border border-amber-400/20 bg-amber-400/10 px-2 py-1.5 text-[11px] leading-snug text-amber-100">
            {attention}
          </div>
        )}

        {context.row?.journey?.phaseIds?.length ? (
          <div className="mt-2 max-w-full rounded-md border border-cc-border/70 bg-cc-hover/25 px-2 py-1.5">
            <QuestJourneyCompactSummary journey={context.row.journey} status={context.row.status} />
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => openQuestOverlay(context.questId)}
          className="mt-2 text-[11px] font-medium text-cc-primary hover:text-cc-primary-hover cursor-pointer"
        >
          Open details
        </button>
      </div>
    </section>
  );
}
