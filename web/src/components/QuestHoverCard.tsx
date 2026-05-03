import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BoardParticipantStatus, BoardRowSessionStatus, QuestmasterTask } from "../types.js";
import { getQuestStatusTheme } from "../utils/quest-status-theme.js";
import { getQuestLeaderSessionId, getQuestOwnerSessionId } from "../utils/quest-helpers.js";
import { findQuestJourneyContext, type QuestJourneyBoardRow } from "../utils/quest-journey-context.js";
import { useStore } from "../store.js";
import { getQuestJourneyPhaseForState, getQuestJourneyPresentation } from "../../shared/quest-journey.js";
import { isCompletedJourneyPresentationStatus, QuestJourneyPreviewCard } from "./QuestJourneyTimeline.js";
import { SessionInlineLink } from "./SessionInlineLink.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { useParticipantSessionStatusDotProps } from "./session-participant-status.js";
import {
  QUEST_PARTICIPANT_CHIP_CLASS,
  QUEST_PARTICIPANT_NAME_CLASS,
  QUEST_PARTICIPANT_ROLE_CLASS,
  QUEST_PARTICIPANT_SESSION_CLASS,
} from "./quest-participant-chip-style.js";
import { timeAgo } from "../utils/quest-helpers.js";
import { MarkdownContent } from "./MarkdownContent.js";

interface QuestHoverCardProps {
  quest: QuestmasterTask;
  anchorRect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

export function QuestHoverCard({ quest, anchorRect, onMouseEnter, onMouseLeave }: QuestHoverCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const statusTheme = getQuestStatusTheme(quest.status);
  const zoomLevel = useStore((state) => state.zoomLevel ?? 1);
  const openQuestOverlay = useStore((state) => state.openQuestOverlay);
  const ownerSessionId = getQuestOwnerSessionId(quest);
  const leaderSessionId = useStore((state) => {
    const recordedLeader = getQuestLeaderSessionId(quest);
    if (recordedLeader) return recordedLeader;
    if (!ownerSessionId) return null;
    return state.sdkSessions.find((session) => session.sessionId === ownerSessionId)?.herdedBy ?? null;
  });
  const ownerSessionName = useStore((state) => (ownerSessionId ? state.sessionNames.get(ownerSessionId) : undefined));
  const ownerSessionNum = useStore((state) =>
    ownerSessionId
      ? (state.sdkSessions.find((session) => session.sessionId === ownerSessionId)?.sessionNum ?? null)
      : null,
  );
  const leaderSessionName = useStore((state) =>
    leaderSessionId ? state.sessionNames.get(leaderSessionId) : undefined,
  );
  const leaderSessionNum = useStore((state) =>
    leaderSessionId
      ? (state.sdkSessions.find((session) => session.sessionId === leaderSessionId)?.sessionNum ?? null)
      : null,
  );
  const sessionBoards = useStore((state) => state.sessionBoards);
  const sessionCompletedBoards = useStore((state) => state.sessionCompletedBoards);
  const sessionBoardRowStatuses = useStore((state) => state.sessionBoardRowStatuses);
  const journeyContext = useMemo(
    () => findQuestJourneyContext(quest, sessionBoards, sessionCompletedBoards, sessionBoardRowStatuses),
    [quest, sessionBoards, sessionCompletedBoards, sessionBoardRowStatuses],
  );
  const journeyBoardRow = journeyContext?.row;
  const workerParticipant = resolveWorkerParticipant(journeyBoardRow, journeyContext?.rowStatus);
  const reviewerParticipant = journeyContext?.rowStatus?.reviewer ?? null;

  const cardWidth = getResponsiveCardWidth();
  const gap = 6;
  const left = anchorRect.left;
  const top = anchorRect.bottom + gap;
  const isTerminalQuest = isCompletedJourneyPresentationStatus(quest.status);
  const journeyStatus = isTerminalQuest || journeyContext?.completed ? "done" : journeyBoardRow?.status;
  const canUseJourneyStatusLabel = !isTerminalQuest && !journeyContext?.completed;
  const journeyPhase = canUseJourneyStatusLabel ? getQuestJourneyPhaseForState(journeyBoardRow?.status) : null;
  const journeyPresentation = canUseJourneyStatusLabel ? getQuestJourneyPresentation(journeyBoardRow?.status) : null;
  const terminalStatusLabel = quest.status === "done" ? "Completed" : statusTheme.label;
  const statusLabel = journeyPresentation?.label ?? journeyPhase?.label ?? terminalStatusLabel;
  const statusDotStyle = journeyPhase?.color.accent ? { backgroundColor: journeyPhase.color.accent } : undefined;
  const showOwnerSession = !!ownerSessionId && workerParticipant?.sessionId !== ownerSessionId;
  const completedAt = quest.status === "done" ? quest.completedAt : null;

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
  }, [anchorRect, cardWidth]);

  return createPortal(
    <div
      ref={cardRef}
      className="fixed z-50 pointer-events-auto hidden-on-touch"
      style={{ left, top, width: cardWidth, transform: `scale(${zoomLevel})`, transformOrigin: "top left" }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-testid="quest-hover-card"
    >
      <div className="max-h-[min(32rem,calc(100vh-1rem))] overflow-y-auto rounded-xl border border-cc-border bg-cc-card px-3 py-2.5 shadow-xl">
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-cc-muted">{quest.questId}</div>
            <div
              data-testid="quest-hover-title"
              className="mt-0.5 text-sm font-semibold text-cc-fg leading-snug break-words"
            >
              {quest.title}
            </div>
          </div>
          <button
            type="button"
            data-testid="quest-hover-open-button"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-cc-border/70 bg-cc-hover/20 px-2 text-[11px] font-medium text-cc-muted transition-colors hover:border-cc-primary/45 hover:bg-cc-hover/55 hover:text-cc-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cc-primary/50 active:bg-cc-hover/70"
            aria-label={`Open ${quest.questId} quest details`}
            onClick={() => {
              openQuestOverlay(quest.questId);
              onMouseLeave();
            }}
          >
            <span>Open quest</span>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
              <path d="M6 4h6v6" />
              <path d="M12 4 5 11" />
              <path d="M4 6v6h6" />
            </svg>
          </button>
        </div>
        <div data-testid="quest-hover-status-row" className="mt-2 flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-cc-muted/60">Status</span>
          <span
            className={`shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${statusTheme.bg} ${statusTheme.text} ${statusTheme.border}`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${statusDotStyle ? "" : statusTheme.dot}`}
              style={statusDotStyle}
            />
            {statusLabel}
          </span>
          {completedAt != null && (
            <span data-testid="quest-hover-completed-at" className="min-w-0 truncate text-[10px] text-cc-muted/70">
              Finished {timeAgo(completedAt)}
            </span>
          )}
        </div>
        {quest.tags && quest.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {quest.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-cc-hover text-cc-muted border border-cc-border"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        {quest.tldr && (
          <div data-testid="quest-hover-tldr" className="mt-2 pt-2 border-t border-cc-border/50">
            <div className="text-[10px] uppercase tracking-wider text-cc-muted/60">Summary</div>
            <MarkdownContent
              text={quest.tldr}
              size="sm"
              variant="conservative"
              wrapLongContent
              className="mt-1 text-[11px] leading-snug text-cc-muted [&_p]:mb-1.5 [&_p:last-child]:mb-0 [&_p]:text-cc-muted [&_li]:text-cc-muted [&_ul]:mb-1.5 [&_ol]:mb-1.5"
            />
          </div>
        )}
        {journeyBoardRow?.journey && (
          <div data-testid="quest-hover-journey" className="mt-2 pt-2 border-t border-cc-border/50">
            <QuestJourneyPreviewCard journey={journeyBoardRow.journey} status={journeyStatus} />
          </div>
        )}
        <QuestHoverParticipants
          workerParticipant={workerParticipant}
          reviewerParticipant={reviewerParticipant}
          ownerSessionId={showOwnerSession ? ownerSessionId : null}
          ownerSessionNum={ownerSessionNum}
          ownerSessionName={ownerSessionName}
          leaderSessionId={leaderSessionId !== ownerSessionId ? leaderSessionId : null}
          leaderSessionNum={leaderSessionNum}
          leaderSessionName={leaderSessionName}
        />
      </div>
    </div>,
    document.body,
  );
}

function getResponsiveCardWidth(): number {
  const preferredWidth = 560;
  if (typeof window === "undefined") return preferredWidth;
  return Math.max(240, Math.min(preferredWidth, window.innerWidth - 16));
}

function resolveWorkerParticipant(
  row: QuestJourneyBoardRow | undefined,
  rowStatus: BoardRowSessionStatus | undefined,
): BoardParticipantStatus | null {
  if (rowStatus?.worker) return rowStatus.worker;
  if (!row?.worker) return null;
  return { sessionId: row.worker, sessionNum: row.workerNum ?? null, status: "idle" };
}

function QuestHoverParticipants({
  workerParticipant,
  reviewerParticipant,
  ownerSessionId,
  ownerSessionNum,
  ownerSessionName,
  leaderSessionId,
  leaderSessionNum,
  leaderSessionName,
}: {
  workerParticipant: BoardParticipantStatus | null;
  reviewerParticipant: BoardParticipantStatus | null;
  ownerSessionId: string | null;
  ownerSessionNum: number | null;
  ownerSessionName?: string;
  leaderSessionId: string | null;
  leaderSessionNum: number | null;
  leaderSessionName?: string;
}) {
  if (!workerParticipant && !reviewerParticipant && !ownerSessionId && !leaderSessionId) return null;

  return (
    <div
      data-testid="quest-hover-participants"
      className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-cc-border/50 pt-2"
      aria-label="Quest participant sessions"
    >
      {workerParticipant && (
        <QuestHoverParticipantSlot testId="quest-hover-worker-session">
          <QuestHoverSessionChip
            role="Worker"
            sessionId={workerParticipant.sessionId}
            sessionNum={workerParticipant.sessionNum}
            sessionName={workerParticipant.name}
            status={workerParticipant.status}
          />
        </QuestHoverParticipantSlot>
      )}
      {reviewerParticipant && (
        <QuestHoverParticipantSlot testId="quest-hover-reviewer-session">
          <QuestHoverSessionChip
            role="Reviewer"
            sessionId={reviewerParticipant.sessionId}
            sessionNum={reviewerParticipant.sessionNum}
            sessionName={reviewerParticipant.name}
            status={reviewerParticipant.status}
          />
        </QuestHoverParticipantSlot>
      )}
      {ownerSessionId && (
        <QuestHoverParticipantSlot testId="quest-hover-owner-session">
          <QuestHoverSessionChip
            role="Owner session"
            sessionId={ownerSessionId}
            sessionNum={ownerSessionNum}
            sessionName={ownerSessionName}
          />
        </QuestHoverParticipantSlot>
      )}
      {leaderSessionId && (
        <QuestHoverParticipantSlot testId="quest-hover-leader-session">
          <QuestHoverSessionChip
            role="Leader"
            sessionId={leaderSessionId}
            sessionNum={leaderSessionNum}
            sessionName={leaderSessionName}
          />
        </QuestHoverParticipantSlot>
      )}
    </div>
  );
}

function QuestHoverParticipantSlot({ testId, children }: { testId: string; children: ReactNode }) {
  return <span data-testid={testId}>{children}</span>;
}

function QuestHoverSessionChip({
  role,
  sessionId,
  sessionNum,
  sessionName,
  status,
}: {
  role: string;
  sessionId: string;
  sessionNum: number | null | undefined;
  sessionName?: string;
  status?: BoardParticipantStatus["status"];
}) {
  const dotProps = useParticipantSessionStatusDotProps(sessionId, status);
  const displaySession = sessionNum != null ? `#${sessionNum}` : sessionId.slice(0, 8);
  const titleSession = sessionNum != null ? `#${sessionNum}` : sessionId;
  const ariaLabel = [role, titleSession, sessionName].filter(Boolean).join(" ");

  return (
    <SessionInlineLink
      sessionId={sessionId}
      sessionNum={sessionNum}
      className={QUEST_PARTICIPANT_CHIP_CLASS}
      dataTestId="quest-hover-session-chip"
      ariaLabel={ariaLabel}
      title={`Open ${role.toLowerCase()} ${titleSession}`}
    >
      {dotProps && <SessionStatusDot className="mt-0" {...dotProps} />}
      <span className={QUEST_PARTICIPANT_ROLE_CLASS}>{role}</span>
      <span className={QUEST_PARTICIPANT_SESSION_CLASS}>{displaySession}</span>
      {sessionName && <span className={QUEST_PARTICIPANT_NAME_CLASS}>{sessionName}</span>}
    </SessionInlineLink>
  );
}
