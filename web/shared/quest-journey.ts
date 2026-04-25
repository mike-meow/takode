/**
 * Quest Journey state machine constants.
 * Shared between server (session-types.ts) and CLI (takode.ts).
 */

/** Regex pattern for valid quest IDs: q-NNN (case-insensitive). */
export const QUEST_ID_PATTERN = /^q-\d+$/i;

/** Returns true if the string is a valid quest ID (q-NNN format). */
export function isValidQuestId(id: string): boolean {
  return QUEST_ID_PATTERN.test(id);
}

/** Regex pattern for valid wait-for references: q-NNN (quest) or #NNN (session). */
export const FREE_WORKER_WAIT_FOR_TOKEN = "free-worker";

/** Regex pattern for valid wait-for references: q-NNN (quest), #NNN (session), or free-worker. */
export const WAIT_FOR_REF_PATTERN = /^(q-\d+|#\d+|free-worker)$/i;

/** Returns true if the string is a valid wait-for dependency reference (q-N or #N). */
export function isValidWaitForRef(ref: string): boolean {
  return WAIT_FOR_REF_PATTERN.test(ref);
}

export type WaitForRefKind = "quest" | "session" | "free-worker" | "invalid";

/** Classify a wait-for dependency reference for CLI/server/UI handling. */
export function getWaitForRefKind(ref: string): WaitForRefKind {
  if (/^q-\d+$/i.test(ref)) return "quest";
  if (/^#\d+$/i.test(ref)) return "session";
  if (ref.toLowerCase() === FREE_WORKER_WAIT_FOR_TOKEN) return "free-worker";
  return "invalid";
}

/** Human-facing label for a wait-for dependency reference. */
export function formatWaitForRefLabel(ref: string): string {
  return getWaitForRefKind(ref) === "free-worker" ? "free worker" : ref;
}

export interface BoardQueueWarning {
  questId: string;
  title?: string;
  kind: "dispatchable" | "missing_wait_for";
  summary: string;
  action?: string;
}

/**
 * Quest Journey state values. These legacy board values still describe
 * what is happening now while phase metadata carries the assembled plan.
 */
export const QUEST_JOURNEY_STATES = [
  "QUEUED",
  "PLANNING",
  "IMPLEMENTING",
  "SKEPTIC_REVIEWING",
  "GROOM_REVIEWING",
  "PORTING",
] as const;

export type QuestJourneyState = (typeof QUEST_JOURNEY_STATES)[number];

/**
 * Reusable Quest Journey phases. Phases are the user-facing units leaders
 * assemble into a Quest Journey; each built-in phase has a matching skill.
 */
export const QUEST_JOURNEY_PHASES = [
  {
    id: "planning",
    state: "PLANNING",
    label: "Planning",
    skill: "quest-journey-planning",
    nextAction: "invoke the planning phase skill; wait for the worker plan, then approve or redirect",
  },
  {
    id: "implementation",
    state: "IMPLEMENTING",
    label: "Implementation",
    skill: "quest-journey-implementation",
    nextAction: "invoke the implementation phase skill; wait for turn_end, then spawn skeptic reviewer",
  },
  {
    id: "skeptic-review",
    state: "SKEPTIC_REVIEWING",
    label: "Skeptic Review",
    skill: "quest-journey-skeptic-review",
    nextAction:
      "invoke the skeptic-review phase skill; wait for reviewer ACCEPT, or use advance-no-groom for explicitly marked true zero-code work",
  },
  {
    id: "reviewer-groom",
    state: "GROOM_REVIEWING",
    label: "Reviewer-Groom",
    skill: "quest-journey-reviewer-groom",
    nextAction: "invoke the reviewer-groom phase skill; wait for reviewer ACCEPT, then send separate port instruction",
  },
  {
    id: "porting",
    state: "PORTING",
    label: "Porting",
    skill: "quest-journey-porting",
    nextAction: "invoke the porting phase skill; wait for port confirmation, then remove from board",
  },
] as const;

export type QuestJourneyPhase = (typeof QUEST_JOURNEY_PHASES)[number];
export type QuestJourneyPhaseId = QuestJourneyPhase["id"];

export const DEFAULT_QUEST_JOURNEY_PRESET_ID = "full-code";
export const DEFAULT_QUEST_JOURNEY_PHASE_IDS = QUEST_JOURNEY_PHASES.map((phase) => phase.id) as QuestJourneyPhaseId[];

export interface QuestJourneyPlanState {
  /** Built-in preset or custom plan identifier. */
  presetId?: string;
  /** Ordered phase IDs planned for this row's active Quest Journey. */
  phaseIds: QuestJourneyPhaseId[];
  /** Current phase ID. Omitted while the row is queued before phase execution. */
  currentPhaseId?: QuestJourneyPhaseId;
  /** Cached next leader action for board/reminder display. */
  nextLeaderAction?: string;
}

export const QUEST_JOURNEY_PHASE_BY_ID: Record<QuestJourneyPhaseId, QuestJourneyPhase> = Object.fromEntries(
  QUEST_JOURNEY_PHASES.map((phase) => [phase.id, phase]),
) as Record<QuestJourneyPhaseId, QuestJourneyPhase>;

export const QUEST_JOURNEY_PHASE_ID_BY_STATE: Partial<Record<QuestJourneyState, QuestJourneyPhaseId>> =
  Object.fromEntries(QUEST_JOURNEY_PHASES.map((phase) => [phase.state, phase.id])) as Partial<
    Record<QuestJourneyState, QuestJourneyPhaseId>
  >;

export function isQuestJourneyPhaseId(value: string): value is QuestJourneyPhaseId {
  return value in QUEST_JOURNEY_PHASE_BY_ID;
}

export function getInvalidQuestJourneyPhaseIds(values: readonly string[]): string[] {
  return values.filter((value) => !isQuestJourneyPhaseId(value));
}

export function getQuestJourneyPhase(phaseId?: string | null): QuestJourneyPhase | null {
  if (!phaseId || !isQuestJourneyPhaseId(phaseId)) return null;
  return QUEST_JOURNEY_PHASE_BY_ID[phaseId];
}

export function getQuestJourneyPhaseForState(status?: string | null): QuestJourneyPhase | null {
  if (!status || !(status in QUEST_JOURNEY_PHASE_ID_BY_STATE)) return null;
  return getQuestJourneyPhase(QUEST_JOURNEY_PHASE_ID_BY_STATE[status as QuestJourneyState]);
}

export function normalizeQuestJourneyPlan(
  plan: Partial<QuestJourneyPlanState> | undefined,
  status?: string | null,
): QuestJourneyPlanState {
  const phaseIds =
    plan?.phaseIds?.filter((phaseId): phaseId is QuestJourneyPhaseId => isQuestJourneyPhaseId(phaseId)) ??
    DEFAULT_QUEST_JOURNEY_PHASE_IDS;
  const nonEmptyPhaseIds = phaseIds.length > 0 ? phaseIds : DEFAULT_QUEST_JOURNEY_PHASE_IDS;
  const statusPhase = getQuestJourneyPhaseForState(status)?.id;
  const currentPhaseId =
    plan?.currentPhaseId && nonEmptyPhaseIds.includes(plan.currentPhaseId)
      ? plan.currentPhaseId
      : statusPhase && nonEmptyPhaseIds.includes(statusPhase)
        ? statusPhase
        : undefined;
  const currentPhase = getQuestJourneyPhase(currentPhaseId);
  return {
    presetId: plan?.presetId ?? DEFAULT_QUEST_JOURNEY_PRESET_ID,
    phaseIds: [...nonEmptyPhaseIds],
    ...(currentPhaseId ? { currentPhaseId } : {}),
    nextLeaderAction: currentPhase?.nextAction ?? plan?.nextLeaderAction,
  };
}

export interface QuestJourneyPresentation {
  label: string;
  textClassName: string;
}

/** Human-facing labels and text-only color treatment for quest phases in the UI. */
export const QUEST_JOURNEY_PRESENTATION: Record<QuestJourneyState, QuestJourneyPresentation> = {
  QUEUED: { label: "Queued", textClassName: "text-cc-muted" },
  PLANNING: { label: "Planning", textClassName: "text-green-400" },
  IMPLEMENTING: { label: "Executing Plan", textClassName: "text-green-400" },
  SKEPTIC_REVIEWING: { label: "Addressing Skeptic", textClassName: "text-violet-500" },
  GROOM_REVIEWING: { label: "Grooming", textClassName: "text-violet-500" },
  PORTING: { label: "Porting", textClassName: "text-blue-400" },
};

/** Returns the UI presentation metadata for a known quest-journey state. */
export function getQuestJourneyPresentation(status?: string | null): QuestJourneyPresentation | null {
  if (!status || !(status in QUEST_JOURNEY_PRESENTATION)) return null;
  return QUEST_JOURNEY_PRESENTATION[status as QuestJourneyState];
}

/** Replace embedded quest-journey enum tokens in freeform text with human labels. */
export function formatQuestJourneyText(text: string): string {
  return text.replace(/\b(QUEUED|PLANNING|IMPLEMENTING|SKEPTIC_REVIEWING|GROOM_REVIEWING|PORTING)\b/g, (match) => {
    return getQuestJourneyPresentation(match)?.label ?? match;
  });
}

/** Next-action hints for each Quest Journey phase. */
export const QUEST_JOURNEY_HINTS: Record<QuestJourneyState, string> = {
  QUEUED: "dispatch to a worker",
  PLANNING: QUEST_JOURNEY_PHASE_BY_ID.planning.nextAction,
  IMPLEMENTING: QUEST_JOURNEY_PHASE_BY_ID.implementation.nextAction,
  SKEPTIC_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["skeptic-review"].nextAction,
  GROOM_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["reviewer-groom"].nextAction,
  PORTING: QUEST_JOURNEY_PHASE_BY_ID.porting.nextAction,
};
