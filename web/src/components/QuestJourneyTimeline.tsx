import {
  getQuestJourneyCurrentPhaseIndex,
  getQuestJourneyPhase,
  type QuestJourneyPlanState,
} from "../../shared/quest-journey.js";

type PhaseTone = {
  lineClassName: string;
  dotClassName: string;
  currentDotClassName: string;
  labelClassName: string;
  currentLabelClassName: string;
};

const COMPLETED_TONE: PhaseTone = {
  lineClassName: "bg-cc-muted/30",
  dotClassName: "border-cc-muted/35 bg-cc-muted/15",
  currentDotClassName: "border-cc-muted/35 bg-cc-muted/15",
  labelClassName: "text-cc-muted/65",
  currentLabelClassName: "text-cc-muted/80",
};

const PHASE_TONES: Record<string, PhaseTone> = {
  PLANNING: {
    lineClassName: "bg-green-400/45",
    dotClassName: "border-green-400/70 bg-transparent",
    currentDotClassName: "border-green-400 bg-green-400/25 ring-2 ring-green-400/25",
    labelClassName: "text-green-400/85",
    currentLabelClassName: "text-green-300",
  },
  EXPLORING: {
    lineClassName: "bg-amber-400/45",
    dotClassName: "border-amber-400/70 bg-transparent",
    currentDotClassName: "border-amber-400 bg-amber-400/20 ring-2 ring-amber-400/25",
    labelClassName: "text-amber-400/85",
    currentLabelClassName: "text-amber-300",
  },
  IMPLEMENTING: {
    lineClassName: "bg-green-400/45",
    dotClassName: "border-green-400/70 bg-transparent",
    currentDotClassName: "border-green-400 bg-green-400/25 ring-2 ring-green-400/25",
    labelClassName: "text-green-400/85",
    currentLabelClassName: "text-green-300",
  },
  CODE_REVIEWING: {
    lineClassName: "bg-violet-500/45",
    dotClassName: "border-violet-500/70 bg-transparent",
    currentDotClassName: "border-violet-500 bg-violet-500/20 ring-2 ring-violet-500/25",
    labelClassName: "text-violet-400/90",
    currentLabelClassName: "text-violet-300",
  },
  MENTAL_SIMULATING: {
    lineClassName: "bg-fuchsia-400/45",
    dotClassName: "border-fuchsia-400/70 bg-transparent",
    currentDotClassName: "border-fuchsia-400 bg-fuchsia-400/20 ring-2 ring-fuchsia-400/25",
    labelClassName: "text-fuchsia-400/90",
    currentLabelClassName: "text-fuchsia-300",
  },
  EXECUTING: {
    lineClassName: "bg-orange-400/45",
    dotClassName: "border-orange-400/70 bg-transparent",
    currentDotClassName: "border-orange-400 bg-orange-400/20 ring-2 ring-orange-400/25",
    labelClassName: "text-orange-400/90",
    currentLabelClassName: "text-orange-300",
  },
  OUTCOME_REVIEWING: {
    lineClassName: "bg-cyan-400/45",
    dotClassName: "border-cyan-400/70 bg-transparent",
    currentDotClassName: "border-cyan-400 bg-cyan-400/20 ring-2 ring-cyan-400/25",
    labelClassName: "text-cyan-400/90",
    currentLabelClassName: "text-cyan-300",
  },
  BOOKKEEPING: {
    lineClassName: "bg-yellow-300/45",
    dotClassName: "border-yellow-300/70 bg-transparent",
    currentDotClassName: "border-yellow-300 bg-yellow-300/20 ring-2 ring-yellow-300/25",
    labelClassName: "text-yellow-300/90",
    currentLabelClassName: "text-yellow-200",
  },
  PORTING: {
    lineClassName: "bg-blue-400/45",
    dotClassName: "border-blue-400/70 bg-transparent",
    currentDotClassName: "border-blue-400 bg-blue-400/20 ring-2 ring-blue-400/25",
    labelClassName: "text-blue-400/90",
    currentLabelClassName: "text-blue-300",
  },
};

function toneForPhase(phaseId: string): PhaseTone {
  const boardState = getQuestJourneyPhase(phaseId)?.boardState;
  return (boardState && PHASE_TONES[boardState]) || COMPLETED_TONE;
}

export function QuestJourneyTimeline({
  journey,
  status,
  className,
  compact = false,
}: {
  journey: QuestJourneyPlanState;
  status?: string | null;
  className?: string;
  compact?: boolean;
}) {
  const phaseIds = journey.phaseIds ?? [];
  if (phaseIds.length === 0) return null;

  const currentIndex = getQuestJourneyCurrentPhaseIndex(journey, status) ?? -1;
  const rootTitle = journey.revisionReason ? `Journey revised: ${journey.revisionReason}` : undefined;

  return (
    <div
      className={`flex max-w-full flex-wrap items-center gap-y-1 ${compact ? "gap-x-0.5" : "gap-x-1"} ${className ?? ""}`.trim()}
      title={rootTitle}
      data-testid="quest-journey-timeline"
    >
      {phaseIds.map((phaseId, index) => {
        const phase = getQuestJourneyPhase(phaseId);
        if (!phase) return null;

        const isCompleted = currentIndex >= 0 && index < currentIndex;
        const isCurrent = currentIndex >= 0 && index === currentIndex;
        const tone = isCompleted ? COMPLETED_TONE : toneForPhase(phaseId);
        const previousCompleted = currentIndex >= 0 && index - 1 < currentIndex;
        const connectorTone =
          index === 0 ? null : previousCompleted ? COMPLETED_TONE : toneForPhase(phaseIds[index - 1]);

        return (
          <div
            key={`${phase.id}-${index}`}
            className="inline-flex min-w-0 items-center"
            data-phase-index={index}
            data-phase-current={isCurrent ? "true" : "false"}
          >
            {connectorTone && (
              <span className={`mx-1 h-px w-3 shrink-0 ${connectorTone.lineClassName}`} aria-hidden="true" />
            )}
            <span className="inline-flex min-w-0 items-center gap-1">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full border ${isCurrent ? tone.currentDotClassName : tone.dotClassName}`}
                aria-hidden="true"
              />
              <span
                className={`min-w-0 truncate ${compact ? "text-[10px]" : "text-[11px]"} ${isCurrent ? `${tone.currentLabelClassName} font-semibold` : tone.labelClassName}`}
              >
                {phase.label}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
