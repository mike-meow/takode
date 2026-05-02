import {
  getQuestDescription,
  getQuestDebrief,
  getQuestDebriefTldr,
  getQuestTldr,
} from "../utils/quest-editor-helpers.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { QuestJourneyTimeline } from "./QuestJourneyTimeline.js";
import { QuestPhaseDocumentationTimeline } from "./QuestPhaseDocumentationTimeline.js";
import { QuestRelationshipLinks } from "./QuestRelationshipLinks.js";
import type { ReactNode } from "react";
import type { QuestmasterTask } from "../types.js";
import type { QuestPhaseDocumentationSummary } from "../../shared/quest-phase-documentation-summary.js";
import type { QuestJourneyPlanState } from "../../shared/quest-journey.js";

interface QuestDetailTextSectionsProps {
  quest: QuestmasterTask;
  phaseDocumentationSummary: QuestPhaseDocumentationSummary;
  journey?: QuestJourneyPlanState;
  journeyStatus?: string | null;
  searchHighlight?: string | null;
  sessionId?: string;
}

export function QuestDetailTextSections({
  quest,
  phaseDocumentationSummary,
  journey,
  journeyStatus,
  searchHighlight,
  sessionId,
}: QuestDetailTextSectionsProps) {
  const description = getQuestDescription(quest);
  const questTldr = getQuestTldr(quest);
  const questDebrief = getQuestDebrief(quest);
  const questDebriefTldr = getQuestDebriefTldr(quest);
  const hasFinalDebrief = Boolean(questDebrief);
  const detailSearchHighlight = searchHighlight
    ? { query: searchHighlight, mode: "fuzzy" as const, isCurrent: false }
    : null;

  if (
    !questTldr &&
    !description &&
    !questDebrief &&
    !questDebriefTldr &&
    !quest.relatedQuests?.length &&
    !phaseDocumentationSummary.hasPhaseDocumentation &&
    !(quest.status === "done" && journey)
  ) {
    return null;
  }

  return (
    <div className="min-w-0 max-w-full space-y-2 overflow-x-hidden">
      <QuestRelationshipLinks quest={quest} />
      {hasFinalDebrief ? (
        <>
          {(questTldr || questDebriefTldr) && (
            <div className="min-w-0 max-w-full space-y-2">
              <QuestDetailSectionLabel>TLDR</QuestDetailSectionLabel>
              {questTldr && (
                <QuestDetailTldrCard label="Description TLDR">
                  <MarkdownContent
                    text={questTldr}
                    size="sm"
                    sessionId={sessionId}
                    searchHighlight={detailSearchHighlight}
                    wrapLongContent
                  />
                </QuestDetailTldrCard>
              )}
              {questDebriefTldr && (
                <QuestDetailTldrCard label="Debrief TLDR">
                  <MarkdownContent
                    text={questDebriefTldr}
                    size="sm"
                    sessionId={sessionId}
                    searchHighlight={detailSearchHighlight}
                    wrapLongContent
                  />
                </QuestDetailTldrCard>
              )}
            </div>
          )}
          {description && (
            <div className="min-w-0 max-w-full space-y-2">
              <QuestDetailSectionLabel>Full Description</QuestDetailSectionLabel>
              <MarkdownContent
                text={description}
                size="sm"
                sessionId={sessionId}
                searchHighlight={detailSearchHighlight}
                wrapLongContent
              />
            </div>
          )}
          <div className="min-w-0 max-w-full space-y-2">
            <QuestDetailSectionLabel>Full Final Debrief</QuestDetailSectionLabel>
            <MarkdownContent
              text={questDebrief ?? ""}
              size="sm"
              sessionId={sessionId}
              searchHighlight={detailSearchHighlight}
              wrapLongContent
            />
          </div>
        </>
      ) : (
        <>
          {(questTldr || description) && (
            <div className="min-w-0 max-w-full space-y-2">
              <QuestDetailSectionLabel>Description</QuestDetailSectionLabel>
              {questTldr && (
                <QuestDetailTldrCard label="TLDR">
                  <MarkdownContent
                    text={questTldr}
                    size="sm"
                    sessionId={sessionId}
                    searchHighlight={detailSearchHighlight}
                    wrapLongContent
                  />
                </QuestDetailTldrCard>
              )}
              {description && (
                <MarkdownContent
                  text={description}
                  size="sm"
                  sessionId={sessionId}
                  searchHighlight={detailSearchHighlight}
                  wrapLongContent
                />
              )}
            </div>
          )}
          {questDebriefTldr && (
            <div className="min-w-0 max-w-full space-y-2">
              <QuestDetailSectionLabel>Final Debrief</QuestDetailSectionLabel>
              <QuestDetailTldrCard label="Debrief TLDR">
                <MarkdownContent
                  text={questDebriefTldr}
                  size="sm"
                  sessionId={sessionId}
                  searchHighlight={detailSearchHighlight}
                  wrapLongContent
                />
              </QuestDetailTldrCard>
            </div>
          )}
        </>
      )}
      {phaseDocumentationSummary.hasPhaseDocumentation && (
        <div className="min-w-0 max-w-full space-y-2 overflow-x-hidden">
          <QuestDetailSectionLabel>Journey Details</QuestDetailSectionLabel>
          <QuestPhaseDocumentationTimeline
            summary={phaseDocumentationSummary}
            searchHighlight={searchHighlight}
            sessionId={sessionId}
          />
        </div>
      )}
      {quest.status === "done" && !phaseDocumentationSummary.hasPhaseDocumentation && journey && (
        <div className="min-w-0 max-w-full space-y-2 overflow-x-hidden" data-testid="quest-detail-journey-section">
          <QuestDetailSectionLabel>Journey Details</QuestDetailSectionLabel>
          <QuestJourneyTimeline journey={journey} status={journeyStatus} variant="vertical" />
        </div>
      )}
    </div>
  );
}

function QuestDetailSectionLabel({ children }: { children: string }) {
  return <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/60">{children}</div>;
}

function QuestDetailTldrCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-cc-border bg-cc-input-bg px-3 py-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/60">{label}</div>
      {children}
    </div>
  );
}
