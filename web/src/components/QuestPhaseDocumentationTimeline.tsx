import { getQuestJourneyPhase } from "../../shared/quest-journey.js";
import {
  phaseDocumentationPreview,
  type QuestPhaseDocumentationSummary,
} from "../../shared/quest-phase-documentation-summary.js";
import { timeAgo } from "../utils/quest-helpers.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { SessionNumChip } from "./SessionNumChip.js";

interface QuestPhaseDocumentationTimelineProps {
  summary: QuestPhaseDocumentationSummary;
  searchHighlight?: string | null;
}

export function QuestPhaseDocumentationTimeline({ summary, searchHighlight }: QuestPhaseDocumentationTimelineProps) {
  const groups = summary.groups.filter((group) => group.entries.length > 0);
  if (groups.length === 0) return null;

  return (
    <section
      className="rounded-md border border-cc-border bg-cc-hover/20 p-2"
      data-testid="quest-phase-documentation-timeline"
    >
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/70">
            Phase Documentation
          </div>
        </div>
        <div className="shrink-0 text-[10px] text-cc-muted">
          {groups.length} documented phase{groups.length === 1 ? "" : "s"}
        </div>
      </div>
      <ol className="space-y-0">
        {groups.map((group, groupIndex) => {
          const phase = group.phaseId ? getQuestJourneyPhase(group.phaseId) : null;
          const hasNext = groupIndex < groups.length - 1;
          return (
            <li
              key={group.key}
              className="grid grid-cols-[16px_1fr] gap-x-2"
              data-testid="quest-phase-documentation-group"
              data-phase-id={group.phaseId ?? ""}
              data-phase-position={group.phasePosition ?? ""}
              data-scope-matched={group.scopeMatched ? "true" : "false"}
            >
              <div className="flex flex-col items-center">
                <span
                  className="mt-1 h-2.5 w-2.5 rounded-full border"
                  style={
                    phase ? { borderColor: phase.color.accent, backgroundColor: `${phase.color.accent}22` } : undefined
                  }
                  aria-hidden="true"
                />
                {hasNext && <span className="mt-0.5 w-px flex-1 bg-cc-muted/25" aria-hidden="true" />}
              </div>
              <div className={hasNext ? "pb-2" : "pb-0"}>
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span className="w-4 shrink-0 text-right text-[10px] text-cc-muted">
                    {group.phasePosition ?? groupIndex + 1}
                  </span>
                  <span className="min-w-0 truncate text-xs font-semibold text-cc-fg">{group.displayLabel}</span>
                  {group.metaLabel && <span className="shrink-0 text-[10px] text-cc-muted">{group.metaLabel}</span>}
                </div>
                <div className="ml-[1.375rem] mt-1 space-y-1.5">
                  {group.entries.map((entry) => {
                    const preview = entry.tldr?.trim() || compactText(phaseDocumentationPreview(entry));
                    return (
                      <div
                        key={entry.index}
                        className="rounded-md border border-cc-border/70 bg-cc-input-bg/70 px-2 py-1.5"
                        data-testid="quest-phase-documentation-entry"
                      >
                        <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="shrink-0 font-mono-code text-[10px] text-cc-muted">#{entry.index}</span>
                          {entry.authorSessionId ? (
                            <SessionNumChip
                              sessionId={entry.authorSessionId}
                              className="text-[10px] font-medium font-mono text-cc-primary hover:text-cc-primary-hover"
                            />
                          ) : (
                            <span className="text-[10px] font-medium text-cc-muted">{entry.author}</span>
                          )}
                          {entry.kind && <span className="text-[10px] text-cc-muted">{entry.kind}</span>}
                          <span className="text-[10px] text-cc-muted/60">{timeAgo(entry.ts)}</span>
                        </div>
                        <div className="text-xs text-cc-fg">
                          <MarkdownContent
                            text={preview}
                            size="sm"
                            searchHighlight={
                              searchHighlight ? { query: searchHighlight, mode: "fuzzy", isCurrent: false } : null
                            }
                          />
                        </div>
                        <details className="mt-1 text-xs text-cc-muted">
                          <summary className="cursor-pointer select-none">Full phase detail</summary>
                          <div className="mt-1 text-cc-fg">
                            <MarkdownContent
                              text={entry.text}
                              size="sm"
                              searchHighlight={
                                searchHighlight ? { query: searchHighlight, mode: "fuzzy", isCurrent: false } : null
                              }
                            />
                          </div>
                        </details>
                      </div>
                    );
                  })}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function compactText(text: string, max = 180): string {
  const compact = text.trim().replace(/\s+/g, " ");
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 3).trimEnd()}...`;
}
