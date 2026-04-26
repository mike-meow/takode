/**
 * Quest Journey state machine constants.
 * Shared between server (session-types.ts) and CLI (takode.ts).
 */
import bookkeepingPhase from "./quest-journey-phases/bookkeeping/phase.json";
import codeReviewPhase from "./quest-journey-phases/code-review/phase.json";
import executePhase from "./quest-journey-phases/execute/phase.json";
import explorePhase from "./quest-journey-phases/explore/phase.json";
import implementPhase from "./quest-journey-phases/implement/phase.json";
import mentalSimulationPhase from "./quest-journey-phases/mental-simulation/phase.json";
import outcomeReviewPhase from "./quest-journey-phases/outcome-review/phase.json";
import planningPhase from "./quest-journey-phases/planning/phase.json";
import portPhase from "./quest-journey-phases/port/phase.json";

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
 * Quest Journey state values. `QUEUED` remains a board-only pre-phase state.
 * Active rows use canonical states derived from the active phase contract.
 */
export const QUEST_JOURNEY_STATES = [
  "QUEUED",
  "PLANNING",
  "EXPLORING",
  "IMPLEMENTING",
  "CODE_REVIEWING",
  "MENTAL_SIMULATING",
  "EXECUTING",
  "OUTCOME_REVIEWING",
  "BOOKKEEPING",
  "PORTING",
] as const;

export type QuestJourneyState = (typeof QUEST_JOURNEY_STATES)[number];

/**
 * Reusable Quest Journey phases. Phases are the user-facing units leaders
 * assemble into a Quest Journey and are backed by canonical phase.json files.
 */
export type QuestJourneyAssigneeRole = "worker" | "reviewer";

export interface QuestJourneyPhase {
  id: string;
  label: string;
  boardState: QuestJourneyState;
  assigneeRole: QuestJourneyAssigneeRole;
  contract: string;
  nextLeaderAction: string;
  aliases: string[];
}

function defineQuestJourneyPhase(phase: QuestJourneyPhase & { aliases?: string[] }): QuestJourneyPhase {
  return { ...phase, aliases: [...(phase.aliases ?? [])] };
}

export const QUEST_JOURNEY_PHASES: readonly QuestJourneyPhase[] = [
  defineQuestJourneyPhase(planningPhase as QuestJourneyPhase & { aliases?: string[] }),
  defineQuestJourneyPhase(explorePhase as QuestJourneyPhase & { aliases?: string[] }),
  defineQuestJourneyPhase(implementPhase as QuestJourneyPhase & { aliases?: string[] }),
  defineQuestJourneyPhase(codeReviewPhase as QuestJourneyPhase & { aliases?: string[] }),
  defineQuestJourneyPhase(mentalSimulationPhase as QuestJourneyPhase & { aliases?: string[] }),
  defineQuestJourneyPhase(executePhase as QuestJourneyPhase & { aliases?: string[] }),
  defineQuestJourneyPhase(outcomeReviewPhase as QuestJourneyPhase & { aliases?: string[] }),
  defineQuestJourneyPhase(bookkeepingPhase as QuestJourneyPhase & { aliases?: string[] }),
  defineQuestJourneyPhase(portPhase as QuestJourneyPhase & { aliases?: string[] }),
];

export type QuestJourneyPhaseId = (typeof QUEST_JOURNEY_PHASES)[number]["id"];

export const DEFAULT_QUEST_JOURNEY_PRESET_ID = "full-code";
export const DEFAULT_QUEST_JOURNEY_PHASE_IDS = [
  "planning",
  "implement",
  "code-review",
  "port",
] as const satisfies readonly QuestJourneyPhaseId[];

const QUEST_JOURNEY_PHASE_ALIAS_MAP: Record<string, QuestJourneyPhaseId> = Object.fromEntries(
  QUEST_JOURNEY_PHASES.flatMap((phase) => phase.aliases.map((alias) => [alias, phase.id])),
) as Record<string, QuestJourneyPhaseId>;

const QUEST_JOURNEY_STATE_ALIAS_MAP = {
  SKEPTIC_REVIEWING: "CODE_REVIEWING",
  GROOM_REVIEWING: "CODE_REVIEWING",
} as const satisfies Record<string, QuestJourneyState>;

export interface QuestJourneyPlanState {
  /** Built-in preset or custom plan identifier. */
  presetId?: string;
  /** Ordered phase IDs planned for this row's active Quest Journey. */
  phaseIds: QuestJourneyPhaseId[];
  /** Current phase ID. Omitted while the row is queued before phase execution. */
  currentPhaseId?: QuestJourneyPhaseId;
  /** Cached next leader action for board/reminder display. */
  nextLeaderAction?: string;
  /** Why the leader revised the remaining Journey, when applicable. */
  revisionReason?: string;
  /** Epoch ms when the active Journey was last revised. */
  revisedAt?: number;
  /** Number of explicit Journey revisions recorded on this row. */
  revisionCount?: number;
}

export const QUEST_JOURNEY_PHASE_BY_ID: Record<QuestJourneyPhaseId, QuestJourneyPhase> = Object.fromEntries(
  QUEST_JOURNEY_PHASES.map((phase) => [phase.id, phase]),
) as Record<QuestJourneyPhaseId, QuestJourneyPhase>;

export const QUEST_JOURNEY_PHASE_ID_BY_STATE: Record<QuestJourneyState, QuestJourneyPhaseId> = Object.fromEntries(
  QUEST_JOURNEY_PHASES.map((phase) => [phase.boardState, phase.id]),
) as Record<QuestJourneyState, QuestJourneyPhaseId>;

function dedupeAdjacentPhaseIds(phaseIds: readonly QuestJourneyPhaseId[]): QuestJourneyPhaseId[] {
  const deduped: QuestJourneyPhaseId[] = [];
  for (const phaseId of phaseIds) {
    if (deduped[deduped.length - 1] !== phaseId) deduped.push(phaseId);
  }
  return deduped;
}

export function canonicalizeQuestJourneyPhaseId(value?: string | null): QuestJourneyPhaseId | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized in QUEST_JOURNEY_PHASE_BY_ID) return normalized as QuestJourneyPhaseId;
  return QUEST_JOURNEY_PHASE_ALIAS_MAP[normalized as keyof typeof QUEST_JOURNEY_PHASE_ALIAS_MAP] ?? null;
}

export function canonicalizeQuestJourneyState(value?: string | null): QuestJourneyState | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  if ((QUEST_JOURNEY_STATES as readonly string[]).includes(normalized)) return normalized as QuestJourneyState;
  return QUEST_JOURNEY_STATE_ALIAS_MAP[normalized as keyof typeof QUEST_JOURNEY_STATE_ALIAS_MAP] ?? null;
}

export function normalizeQuestJourneyPhaseIds(values?: readonly string[] | null): QuestJourneyPhaseId[] {
  return dedupeAdjacentPhaseIds(
    (values ?? [])
      .map((value) => canonicalizeQuestJourneyPhaseId(value))
      .filter((phaseId): phaseId is QuestJourneyPhaseId => phaseId !== null),
  );
}

export function isQuestJourneyPhaseId(value: string): value is QuestJourneyPhaseId {
  return canonicalizeQuestJourneyPhaseId(value) !== null;
}

export function getInvalidQuestJourneyPhaseIds(values: readonly string[]): string[] {
  return values.filter((value) => canonicalizeQuestJourneyPhaseId(value) === null);
}

export function getQuestJourneyPhase(phaseId?: string | null): QuestJourneyPhase | null {
  const canonical = canonicalizeQuestJourneyPhaseId(phaseId);
  return canonical ? QUEST_JOURNEY_PHASE_BY_ID[canonical] : null;
}

export function getQuestJourneyPhaseForState(status?: string | null): QuestJourneyPhase | null {
  const canonical = canonicalizeQuestJourneyState(status);
  return canonical ? getQuestJourneyPhase(QUEST_JOURNEY_PHASE_ID_BY_STATE[canonical]) : null;
}

export function normalizeQuestJourneyPlan(
  plan: Partial<QuestJourneyPlanState> | undefined,
  status?: string | null,
): QuestJourneyPlanState {
  const phaseIds = normalizeQuestJourneyPhaseIds(plan?.phaseIds);
  const nonEmptyPhaseIds = phaseIds.length > 0 ? phaseIds : [...DEFAULT_QUEST_JOURNEY_PHASE_IDS];
  const statusPhase = getQuestJourneyPhaseForState(status)?.id;
  const plannedCurrentPhaseId = getQuestJourneyPhase(plan?.currentPhaseId)?.id;
  const currentPhaseId =
    plannedCurrentPhaseId && nonEmptyPhaseIds.includes(plannedCurrentPhaseId)
      ? plannedCurrentPhaseId
      : statusPhase && nonEmptyPhaseIds.includes(statusPhase)
        ? statusPhase
        : undefined;
  const currentPhase = getQuestJourneyPhase(currentPhaseId);
  return {
    presetId: plan?.presetId ?? DEFAULT_QUEST_JOURNEY_PRESET_ID,
    phaseIds: [...nonEmptyPhaseIds],
    ...(currentPhaseId ? { currentPhaseId } : {}),
    nextLeaderAction: currentPhase?.nextLeaderAction ?? plan?.nextLeaderAction,
    ...(plan?.revisionReason ? { revisionReason: plan.revisionReason } : {}),
    ...(plan?.revisedAt ? { revisedAt: plan.revisedAt } : {}),
    ...(typeof plan?.revisionCount === "number" ? { revisionCount: plan.revisionCount } : {}),
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
  EXPLORING: { label: "Explore", textClassName: "text-amber-400" },
  IMPLEMENTING: { label: "Implement", textClassName: "text-green-400" },
  CODE_REVIEWING: { label: "Code Review", textClassName: "text-violet-500" },
  MENTAL_SIMULATING: { label: "Mental Simulation", textClassName: "text-fuchsia-400" },
  EXECUTING: { label: "Execute", textClassName: "text-orange-400" },
  OUTCOME_REVIEWING: { label: "Outcome Review", textClassName: "text-cyan-400" },
  BOOKKEEPING: { label: "Bookkeeping", textClassName: "text-yellow-300" },
  PORTING: { label: "Port", textClassName: "text-blue-400" },
};

/** Returns the UI presentation metadata for a known quest-journey state. */
export function getQuestJourneyPresentation(status?: string | null): QuestJourneyPresentation | null {
  const canonical = canonicalizeQuestJourneyState(status);
  return canonical ? QUEST_JOURNEY_PRESENTATION[canonical] : null;
}

/** Replace embedded quest-journey enum tokens in freeform text with human labels. */
export function formatQuestJourneyText(text: string): string {
  return text.replace(
    /\b(QUEUED|PLANNING|EXPLORING|IMPLEMENTING|CODE_REVIEWING|MENTAL_SIMULATING|EXECUTING|OUTCOME_REVIEWING|BOOKKEEPING|PORTING|SKEPTIC_REVIEWING|GROOM_REVIEWING)\b/g,
    (match) => getQuestJourneyPresentation(match)?.label ?? match,
  );
}

/** Next-action hints for Quest Journey states, including legacy aliases. */
export const QUEST_JOURNEY_HINTS: Record<string, string> = {
  QUEUED: "dispatch to a worker",
  PLANNING: QUEST_JOURNEY_PHASE_BY_ID.planning.nextLeaderAction,
  EXPLORING: QUEST_JOURNEY_PHASE_BY_ID.explore.nextLeaderAction,
  IMPLEMENTING: QUEST_JOURNEY_PHASE_BY_ID.implement.nextLeaderAction,
  CODE_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["code-review"].nextLeaderAction,
  MENTAL_SIMULATING: QUEST_JOURNEY_PHASE_BY_ID["mental-simulation"].nextLeaderAction,
  EXECUTING: QUEST_JOURNEY_PHASE_BY_ID.execute.nextLeaderAction,
  OUTCOME_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["outcome-review"].nextLeaderAction,
  BOOKKEEPING: QUEST_JOURNEY_PHASE_BY_ID.bookkeeping.nextLeaderAction,
  PORTING: QUEST_JOURNEY_PHASE_BY_ID.port.nextLeaderAction,
  SKEPTIC_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["code-review"].nextLeaderAction,
  GROOM_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["code-review"].nextLeaderAction,
};
