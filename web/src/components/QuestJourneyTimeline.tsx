import type { CSSProperties } from "react";
import {
  getQuestJourneyCurrentPhaseIndex,
  getQuestJourneyPhase,
  type QuestJourneyPhase,
  type QuestJourneyPlanState,
} from "../../shared/quest-journey.js";

type JourneyVariant = "horizontal" | "compact" | "vertical";
type PhaseState = "proposed" | "completed" | "current" | "upcoming";

interface PhaseItem {
  phase: QuestJourneyPhase;
  index: number;
  state: PhaseState;
  note?: string;
}

const MUTED_DOT_CLASS = "border-cc-muted/35 bg-cc-muted/15";
const MUTED_LABEL_CLASS = "text-cc-muted/65";

function colorWithAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function phaseAccentStyle(phase: QuestJourneyPhase, alpha = 1): CSSProperties {
  return { color: alpha === 1 ? phase.color.accent : colorWithAlpha(phase.color.accent, alpha) };
}

function phaseBorderStyle(phase: QuestJourneyPhase, alpha = 1): CSSProperties {
  return { borderColor: alpha === 1 ? phase.color.accent : colorWithAlpha(phase.color.accent, alpha) };
}

function phaseLineStyle(phase: QuestJourneyPhase, alpha = 0.45): CSSProperties {
  return { backgroundColor: colorWithAlpha(phase.color.accent, alpha) };
}

function phaseCurrentDotStyle(phase: QuestJourneyPhase): CSSProperties {
  return {
    backgroundColor: phase.color.accent,
    borderColor: phase.color.accent,
    boxShadow: `0 0 0 3px ${colorWithAlpha(phase.color.accent, 0.18)}`,
  };
}

function isProposedJourney(journey: QuestJourneyPlanState, status?: string | null): boolean {
  return journey.mode === "proposed" || (status ?? "").trim().toUpperCase() === "PROPOSED";
}

function getPhaseItems(journey: QuestJourneyPlanState, status?: string | null): PhaseItem[] {
  const phaseIds = journey.phaseIds ?? [];
  const proposed = isProposedJourney(journey, status);
  const currentIndex = proposed ? -1 : (getQuestJourneyCurrentPhaseIndex(journey, status) ?? -1);

  return phaseIds.flatMap((phaseId, index) => {
    const phase = getQuestJourneyPhase(phaseId);
    if (!phase) return [];

    const note = journey.phaseNotes?.[String(index)]?.trim() || undefined;
    const state: PhaseState = proposed
      ? "proposed"
      : currentIndex < 0
        ? "upcoming"
        : index < currentIndex
          ? "completed"
          : index === currentIndex
            ? "current"
            : "upcoming";
    return [{ phase, index, state, note }];
  });
}

function phaseDotClassName(item: PhaseItem): string {
  if (item.state === "completed") return MUTED_DOT_CLASS;
  if (item.state === "current") return "border";
  return "border bg-transparent";
}

function phaseDotStyle(item: PhaseItem): CSSProperties | undefined {
  if (item.state === "completed") return undefined;
  if (item.state === "current") return phaseCurrentDotStyle(item.phase);
  return phaseBorderStyle(item.phase, item.state === "proposed" ? 0.55 : 0.75);
}

function phaseLabelClassName(item: PhaseItem, compact = false): string {
  const sizeClass = compact ? "text-[10px]" : "text-[11px]";
  if (item.state === "completed") return `${sizeClass} ${MUTED_LABEL_CLASS}`;
  if (item.state === "current") return `${sizeClass} font-semibold text-cc-fg`;
  if (item.state === "proposed") return `${sizeClass} text-cc-muted`;
  return `${sizeClass}`;
}

function phaseLabelStyle(item: PhaseItem): CSSProperties | undefined {
  if (item.state === "completed" || item.state === "current" || item.state === "proposed") return undefined;
  return phaseAccentStyle(item.phase, 0.9);
}

function noteCount(journey: QuestJourneyPlanState): number {
  return Object.values(journey.phaseNotes ?? {}).filter((note) => note.trim()).length;
}

function phasePurpose(
  item: PhaseItem,
  showPhasePurpose: boolean,
): { text: string; kind: "authored" | "default" } | null {
  if (item.note) return { text: item.note, kind: "authored" };
  if (!showPhasePurpose) return null;
  return { text: item.phase.contract, kind: "default" };
}

function phasePurposeClassName(item: PhaseItem, kind: "authored" | "default"): string {
  if (item.state === "completed") return "text-cc-muted/65";
  if (kind === "default") return "text-cc-muted/65";
  if (item.state === "proposed") return "text-cc-fg/90";
  return "text-cc-fg/85";
}

export function QuestJourneyCompactSummary({
  journey,
  status,
  className,
}: {
  journey: QuestJourneyPlanState;
  status?: string | null;
  className?: string;
}) {
  const items = getPhaseItems(journey, status);
  if (items.length === 0) return null;

  const proposed = isProposedJourney(journey, status);
  const currentItem = items.find((item) => item.state === "current");
  const label = proposed ? "Proposed" : (currentItem?.phase.label ?? "Journey");
  const sequence = proposed ? items.map((item) => item.phase.label).join(" -> ") : "";
  const position = proposed ? `${items.length} phases` : currentItem ? `${currentItem.index + 1}/${items.length}` : "";
  const notes = noteCount(journey);

  return (
    <div
      className={`flex min-w-0 max-w-full items-center gap-2 ${className ?? ""}`.trim()}
      data-testid="quest-journey-compact-summary"
      data-journey-mode={proposed ? "proposed" : "active"}
      title={journey.revisionReason ? `Journey revised: ${journey.revisionReason}` : undefined}
    >
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full border ${currentItem ? "" : "border-cc-muted/45 bg-transparent"}`.trim()}
        style={currentItem ? phaseCurrentDotStyle(currentItem.phase) : undefined}
        aria-hidden="true"
      />
      <span className="shrink-0 font-medium text-cc-fg">{label}</span>
      {sequence && (
        <span className="min-w-0 truncate text-cc-muted" data-testid="quest-journey-compact-sequence">
          {sequence}
        </span>
      )}
      {position && <span className="shrink-0 text-[10px] text-cc-muted">{position}</span>}
      {notes > 0 && (
        <span className="shrink-0 text-[10px] text-amber-200/90">{`${notes} note${notes === 1 ? "" : "s"}`}</span>
      )}
    </div>
  );
}

function HorizontalJourney({
  items,
  journey,
  status,
  compact,
  className,
}: {
  items: PhaseItem[];
  journey: QuestJourneyPlanState;
  status?: string | null;
  compact: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex max-w-full flex-wrap items-center gap-y-1 ${compact ? "gap-x-0.5" : "gap-x-1"} ${className ?? ""}`.trim()}
      title={journey.revisionReason ? `Journey revised: ${journey.revisionReason}` : undefined}
      data-testid="quest-journey-timeline"
      data-journey-mode={isProposedJourney(journey, status) ? "proposed" : "active"}
    >
      {items.map((item, itemIndex) => {
        const connectorPhase = items[itemIndex - 1]?.phase;
        const connectorMuted = itemIndex > 0 && items[itemIndex - 1]?.state === "completed";

        return (
          <div
            key={`${item.phase.id}-${item.index}`}
            className="inline-flex min-w-0 items-center"
            data-phase-index={item.index}
            data-phase-current={item.state === "current" ? "true" : "false"}
            data-phase-state={item.state}
            data-phase-color={item.phase.color.name}
          >
            {itemIndex > 0 && (
              <span
                className={`mx-1 h-px w-3 shrink-0 ${connectorMuted ? "bg-cc-muted/30" : ""}`}
                style={connectorMuted || !connectorPhase ? undefined : phaseLineStyle(connectorPhase)}
                aria-hidden="true"
              />
            )}
            <span className="inline-flex min-w-0 items-center gap-1">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${phaseDotClassName(item)}`}
                style={phaseDotStyle(item)}
                aria-hidden="true"
              />
              <span className={`min-w-0 truncate ${phaseLabelClassName(item, compact)}`} style={phaseLabelStyle(item)}>
                {item.phase.label}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function VerticalJourney({
  items,
  journey,
  status,
  className,
  showPhasePurpose,
}: {
  items: PhaseItem[];
  journey: QuestJourneyPlanState;
  status?: string | null;
  className?: string;
  showPhasePurpose: boolean;
}) {
  const proposed = isProposedJourney(journey, status);
  return (
    <div
      className={`rounded-md border border-cc-border bg-cc-hover/20 p-2 ${className ?? ""}`.trim()}
      title={journey.revisionReason ? `Journey revised: ${journey.revisionReason}` : undefined}
      data-testid="quest-journey-timeline"
      data-journey-mode={proposed ? "proposed" : "active"}
    >
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/70">
            {proposed ? "Proposed Journey" : "Active Journey"}
          </div>
          {journey.revisionReason && (
            <div className="mt-0.5 truncate text-[11px] text-cc-muted">{journey.revisionReason}</div>
          )}
        </div>
        <div className="shrink-0 text-[10px] text-cc-muted">{`${items.length} phase${items.length === 1 ? "" : "s"}`}</div>
      </div>
      <ol className="space-y-0" data-testid="quest-journey-detail-list">
        {items.map((item, index) => {
          const hasNext = index < items.length - 1;
          const purpose = phasePurpose(item, showPhasePurpose);
          return (
            <li
              key={`${item.phase.id}-${item.index}`}
              className="grid grid-cols-[16px_1fr] gap-x-2"
              data-phase-index={item.index}
              data-phase-current={item.state === "current" ? "true" : "false"}
              data-phase-state={item.state}
              data-phase-color={item.phase.color.name}
            >
              <div className="flex flex-col items-center">
                <span
                  className={`mt-1 h-2.5 w-2.5 rounded-full ${phaseDotClassName(item)}`}
                  style={phaseDotStyle(item)}
                  aria-hidden="true"
                />
                {hasNext && (
                  <span
                    className={`mt-0.5 w-px flex-1 ${item.state === "completed" ? "bg-cc-muted/30" : ""}`}
                    style={item.state === "completed" ? undefined : phaseLineStyle(item.phase, proposed ? 0.2 : 0.35)}
                    aria-hidden="true"
                  />
                )}
              </div>
              <div className={hasNext ? "pb-1.5" : "pb-0"}>
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                  <span className="w-4 shrink-0 text-right text-[10px] text-cc-muted">{item.index + 1}</span>
                  <span
                    className={`min-w-0 truncate text-xs ${phaseLabelClassName(item)}`}
                    style={phaseLabelStyle(item)}
                  >
                    {item.phase.label}
                  </span>
                  {item.state === "current" && (
                    <span className="shrink-0 rounded-full bg-cc-primary/15 px-1.5 py-0.5 text-[10px] text-cc-primary">
                      current
                    </span>
                  )}
                </div>
                {purpose && (
                  <div
                    className={`ml-[1.375rem] mt-0.5 text-[10px] leading-snug ${phasePurposeClassName(item, purpose.kind)}`}
                    data-purpose-kind={purpose.kind}
                    data-testid="quest-journey-phase-purpose"
                  >
                    {purpose.text}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function QuestJourneyTimeline({
  journey,
  status,
  className,
  compact = false,
  variant,
  showPhasePurpose,
}: {
  journey: QuestJourneyPlanState;
  status?: string | null;
  className?: string;
  compact?: boolean;
  variant?: JourneyVariant;
  showPhasePurpose?: boolean;
}) {
  const items = getPhaseItems(journey, status);
  if (items.length === 0) return null;

  const resolvedVariant: JourneyVariant = variant ?? (compact ? "compact" : "horizontal");
  if (resolvedVariant === "compact") {
    return <QuestJourneyCompactSummary journey={journey} status={status} className={className} />;
  }
  if (resolvedVariant === "vertical") {
    return (
      <VerticalJourney
        items={items}
        journey={journey}
        status={status}
        className={className}
        showPhasePurpose={showPhasePurpose ?? true}
      />
    );
  }
  return <HorizontalJourney items={items} journey={journey} status={status} compact={compact} className={className} />;
}

export function QuestJourneyPreviewCard({
  journey,
  status,
  quest,
  onQuestClick,
  className,
}: {
  journey: QuestJourneyPlanState;
  status?: string | null;
  quest?: { questId: string; title?: string };
  onQuestClick?: () => void;
  className?: string;
}) {
  return (
    <div className={`max-w-full ${className ?? ""}`.trim()} data-testid="quest-journey-preview-card">
      {quest && (
        <>
          {onQuestClick ? (
            <button
              type="button"
              onClick={onQuestClick}
              aria-label={`${quest.questId}${quest.title ? ` ${quest.title}` : ""}`}
              className="mb-2 flex w-full min-w-0 items-baseline gap-2 border-b border-cc-border/50 pb-1.5 text-left"
            >
              <span className="shrink-0 font-mono-code text-[11px] text-blue-400 hover:text-blue-300">
                {quest.questId}
              </span>
              {quest.title && <span className="min-w-0 truncate text-xs font-medium text-cc-fg">{quest.title}</span>}
            </button>
          ) : (
            <div className="mb-2 flex min-w-0 items-baseline gap-2 border-b border-cc-border/50 pb-1.5">
              <span className="shrink-0 font-mono-code text-[11px] text-blue-400">{quest.questId}</span>
              {quest.title && <span className="min-w-0 truncate text-xs font-medium text-cc-fg">{quest.title}</span>}
            </div>
          )}
        </>
      )}
      <QuestJourneyTimeline journey={journey} status={status} variant="vertical" showPhasePurpose />
    </div>
  );
}

export function QuestJourneyProposalReview({
  proposal,
  onQuestClick,
  className,
}: {
  proposal: {
    questId: string;
    title?: string;
    status: string;
    journey: QuestJourneyPlanState;
    presentedAt?: number;
    summary?: string;
    scheduling?: Record<string, unknown>;
  };
  onQuestClick?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`border-b border-cc-border bg-cc-bg/20 px-3 py-3 ${className ?? ""}`.trim()}
      data-testid="quest-journey-proposal-review"
    >
      <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-cc-muted/70">
            Presented Journey Proposal
          </div>
          {proposal.summary && <div className="mt-0.5 truncate text-xs text-cc-fg">{proposal.summary}</div>}
        </div>
        {proposal.presentedAt && (
          <div className="shrink-0 text-[10px] text-cc-muted">
            {new Date(proposal.presentedAt).toLocaleTimeString()}
          </div>
        )}
      </div>
      <QuestJourneyPreviewCard
        journey={proposal.journey}
        status={proposal.status}
        quest={{ questId: proposal.questId, title: proposal.title }}
        onQuestClick={onQuestClick}
      />
    </div>
  );
}
