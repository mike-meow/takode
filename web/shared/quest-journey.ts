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
import alignmentPhase from "./quest-journey-phases/alignment/phase.json";
import portPhase from "./quest-journey-phases/port/phase.json";
import userCheckpointPhase from "./quest-journey-phases/user-checkpoint/phase.json";

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
  "PROPOSED",
  "QUEUED",
  "PLANNING",
  "EXPLORING",
  "IMPLEMENTING",
  "CODE_REVIEWING",
  "MENTAL_SIMULATING",
  "EXECUTING",
  "OUTCOME_REVIEWING",
  "USER_CHECKPOINTING",
  "BOOKKEEPING",
  "PORTING",
] as const;

export type QuestJourneyState = (typeof QUEST_JOURNEY_STATES)[number];
export const QUEST_JOURNEY_LIFECYCLE_MODES = ["active", "proposed"] as const;
export type QuestJourneyLifecycleMode = (typeof QUEST_JOURNEY_LIFECYCLE_MODES)[number];
export type QuestJourneyPresentationState = "draft" | "presented";

/**
 * Reusable Quest Journey phases. Phases are the user-facing units leaders
 * assemble into a Quest Journey and are backed by canonical phase.json files.
 */
export type QuestJourneyAssigneeRole = "worker" | "reviewer";
const QUEST_JOURNEY_PHASE_IDS = [
  "alignment",
  "explore",
  "implement",
  "code-review",
  "mental-simulation",
  "execute",
  "outcome-review",
  "user-checkpoint",
  "bookkeeping",
  "port",
] as const;

export type QuestJourneyPhaseId = (typeof QUEST_JOURNEY_PHASE_IDS)[number];

export interface QuestJourneyPhase {
  id: QuestJourneyPhaseId;
  label: string;
  color: QuestJourneyPhaseColor;
  boardState: QuestJourneyState;
  assigneeRole: QuestJourneyAssigneeRole;
  contract: string;
  nextLeaderAction: string;
  aliases: string[];
}

export interface QuestJourneyPhaseColor {
  name: string;
  accent: string;
}

type QuestJourneyPhaseFile = {
  id: string;
  label: string;
  color?: {
    name?: string;
    accent?: string;
  };
  boardState: string;
  assigneeRole: string;
  contract: string;
  nextLeaderAction: string;
  aliases?: string[];
};

function parseQuestJourneyState(value: string): QuestJourneyState {
  if ((QUEST_JOURNEY_STATES as readonly string[]).includes(value)) {
    return value as QuestJourneyState;
  }
  throw new Error(`Quest Journey phase metadata mismatch: unknown board state ${value}`);
}

function parseQuestJourneyAssigneeRole(value: string): QuestJourneyAssigneeRole {
  if (value === "worker" || value === "reviewer") return value;
  throw new Error(`Quest Journey phase metadata mismatch: unknown assignee role ${value}`);
}

function parseQuestJourneyPhaseColor(value: QuestJourneyPhaseFile["color"]): QuestJourneyPhaseColor {
  const name = value?.name?.trim();
  const accent = value?.accent?.trim();
  if (!name || !accent || !/^#[0-9a-f]{6}$/i.test(accent)) {
    throw new Error("Quest Journey phase metadata mismatch: phase color requires name and #rrggbb accent");
  }
  return { name, accent };
}

function defineQuestJourneyPhase<Id extends QuestJourneyPhaseId>(
  expectedId: Id,
  phase: QuestJourneyPhaseFile,
): QuestJourneyPhase & { id: Id } {
  if (phase.id !== expectedId) {
    throw new Error(`Quest Journey phase metadata mismatch: expected ${expectedId}, got ${phase.id}`);
  }
  return {
    ...phase,
    id: expectedId,
    color: parseQuestJourneyPhaseColor(phase.color),
    boardState: parseQuestJourneyState(phase.boardState),
    assigneeRole: parseQuestJourneyAssigneeRole(phase.assigneeRole),
    aliases: [...(phase.aliases ?? [])],
  };
}

export const QUEST_JOURNEY_PHASES: readonly QuestJourneyPhase[] = [
  defineQuestJourneyPhase("alignment", alignmentPhase),
  defineQuestJourneyPhase("explore", explorePhase),
  defineQuestJourneyPhase("implement", implementPhase),
  defineQuestJourneyPhase("code-review", codeReviewPhase),
  defineQuestJourneyPhase("mental-simulation", mentalSimulationPhase),
  defineQuestJourneyPhase("execute", executePhase),
  defineQuestJourneyPhase("outcome-review", outcomeReviewPhase),
  defineQuestJourneyPhase("user-checkpoint", userCheckpointPhase),
  defineQuestJourneyPhase("bookkeeping", bookkeepingPhase),
  defineQuestJourneyPhase("port", portPhase),
];

export const DEFAULT_QUEST_JOURNEY_PRESET_ID = "full-code";
export const DEFAULT_QUEST_JOURNEY_PHASE_IDS = [
  "alignment",
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
  /** Proposed rows are pre-dispatch drafts; active rows track execution progress. */
  mode?: QuestJourneyLifecycleMode;
  /** Current phase position within `phaseIds`, used for repeated phases. */
  activePhaseIndex?: number;
  /** Current phase ID. Omitted while the row is queued before phase execution. */
  currentPhaseId?: QuestJourneyPhaseId;
  /** Lightweight reminder text keyed by zero-based phase position. */
  phaseNotes?: Record<string, string>;
  /** Wall-clock timing keyed by zero-based phase position. */
  phaseTimings?: Record<string, QuestJourneyPhaseTiming>;
  /** Presentation metadata for proposed Journey approval reviews. */
  presentation?: QuestJourneyProposalPresentation;
  /** Cached next leader action for board/reminder display. */
  nextLeaderAction?: string;
  /** Why the leader revised the remaining Journey, when applicable. */
  revisionReason?: string;
  /** Epoch ms when the active Journey was last revised. */
  revisedAt?: number;
  /** Number of explicit Journey revisions recorded on this row. */
  revisionCount?: number;
}

export interface QuestJourneyPhaseTiming {
  /** Epoch ms when the board entered this phase occurrence. */
  startedAt?: number;
  /** Epoch ms when the board advanced away from this phase occurrence. */
  endedAt?: number;
}

export interface QuestJourneyPhaseDurationOptions {
  /** When true, an open timing uses `now` as the end point for active elapsed-so-far displays. */
  allowOpenEnded?: boolean;
}

export interface QuestJourneyProposalPresentation {
  /** Drafts may exist on the board, but only presented plans are normal approval surfaces. */
  state: QuestJourneyPresentationState;
  /** Stable signature of the Journey state that was presented. */
  signature?: string;
  /** Epoch ms when this proposal was deliberately presented to the user. */
  presentedAt?: number;
  /** Short user-facing proposal summary supplied by the leader/spec. */
  summary?: string;
  /** Lightweight scheduling metadata; intentionally free-form for v1. */
  scheduling?: Record<string, unknown>;
}

export interface QuestJourneyPhaseNoteRebaseWarning {
  previousIndex: number;
  previousPhaseId: QuestJourneyPhaseId;
  previousOccurrence: number;
  note: string;
}

export interface QuestJourneyPhaseNoteRebaseResult {
  phaseNotes?: Record<string, string>;
  warnings: QuestJourneyPhaseNoteRebaseWarning[];
}

export interface QuestJourneyCompletedPrefixResult {
  ok: boolean;
  prefixLength?: number;
  error?: string;
}

export interface QuestJourneyCompletedPrefixRevision {
  existingPlan: Partial<QuestJourneyPlanState> | undefined;
  existingStatus?: string | null;
  nextPhaseIds?: readonly QuestJourneyPhaseId[];
  phaseNoteEditIndices?: readonly number[];
  nextActivePhaseIndex?: number;
}

export const QUEST_JOURNEY_PHASE_BY_ID: Record<QuestJourneyPhaseId, QuestJourneyPhase> = Object.fromEntries(
  QUEST_JOURNEY_PHASES.map((phase) => [phase.id, phase]),
) as Record<QuestJourneyPhaseId, QuestJourneyPhase>;

export const QUEST_JOURNEY_PHASE_ID_BY_STATE = Object.fromEntries(
  QUEST_JOURNEY_PHASES.map((phase) => [phase.boardState, phase.id]),
) as Partial<Record<QuestJourneyState, QuestJourneyPhaseId>>;

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

export function canonicalizeQuestJourneyLifecycleMode(value?: string | null): QuestJourneyLifecycleMode | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "active" || normalized === "proposed" ? (normalized as QuestJourneyLifecycleMode) : null;
}

export function normalizeQuestJourneyPhaseIds(values?: readonly string[] | null): QuestJourneyPhaseId[] {
  return (values ?? [])
    .map((value) => canonicalizeQuestJourneyPhaseId(value))
    .filter((phaseId): phaseId is QuestJourneyPhaseId => phaseId !== null);
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
  return canonical ? getQuestJourneyPhase(QUEST_JOURNEY_PHASE_ID_BY_STATE[canonical] ?? null) : null;
}

export function getQuestJourneyPhaseIndices(
  phaseIds: readonly QuestJourneyPhaseId[],
  targetPhaseId: QuestJourneyPhaseId,
): number[] {
  return phaseIds.flatMap((phaseId, index) => (phaseId === targetPhaseId ? [index] : []));
}

function getUniqueQuestJourneyPhaseIndex(
  phaseIds: readonly QuestJourneyPhaseId[],
  targetPhaseId: QuestJourneyPhaseId | undefined,
): number | undefined {
  if (!targetPhaseId) return undefined;
  const matches = getQuestJourneyPhaseIndices(phaseIds, targetPhaseId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function rebaseQuestJourneyPhaseNotes(
  existingNotes: Record<string, string> | undefined,
  previousPhaseIds: readonly QuestJourneyPhaseId[],
  nextPhaseIds: readonly QuestJourneyPhaseId[],
): QuestJourneyPhaseNoteRebaseResult {
  if (!existingNotes) return { warnings: [] };

  const nextPhaseOccurrenceIndices = new Map<QuestJourneyPhaseId, number[]>();
  for (const [index, phaseId] of nextPhaseIds.entries()) {
    const indices = nextPhaseOccurrenceIndices.get(phaseId) ?? [];
    indices.push(index);
    nextPhaseOccurrenceIndices.set(phaseId, indices);
  }

  const previousPhaseOccurrencesByIndex = new Map<number, number>();
  const previousOccurrenceCounts = new Map<QuestJourneyPhaseId, number>();
  for (const [index, phaseId] of previousPhaseIds.entries()) {
    const occurrence = (previousOccurrenceCounts.get(phaseId) ?? 0) + 1;
    previousOccurrenceCounts.set(phaseId, occurrence);
    previousPhaseOccurrencesByIndex.set(index, occurrence);
  }

  const nextEntries: Array<readonly [string, string]> = [];
  const warnings: QuestJourneyPhaseNoteRebaseWarning[] = [];

  for (const [rawIndex, rawNote] of Object.entries(existingNotes).sort(
    (a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10),
  )) {
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isInteger(index) || index < 0 || index >= previousPhaseIds.length) continue;
    const trimmedNote = rawNote.trim();
    if (!trimmedNote) continue;

    const phaseId = previousPhaseIds[index];
    const occurrence = previousPhaseOccurrencesByIndex.get(index);
    if (occurrence === undefined) continue;

    const targetIndex = nextPhaseOccurrenceIndices.get(phaseId)?.[occurrence - 1];
    if (targetIndex === undefined) {
      warnings.push({
        previousIndex: index,
        previousPhaseId: phaseId,
        previousOccurrence: occurrence,
        note: trimmedNote,
      });
      continue;
    }

    nextEntries.push([String(targetIndex), trimmedNote]);
  }

  return {
    ...(nextEntries.length > 0
      ? {
          phaseNotes: Object.fromEntries(
            nextEntries.sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10)),
          ),
        }
      : {}),
    warnings,
  };
}

export function getQuestJourneyCompletedPrefixLength(
  plan: Partial<QuestJourneyPlanState> | undefined,
  status?: string | null,
): QuestJourneyCompletedPrefixResult {
  const phaseIds = normalizeQuestJourneyPhaseIds(plan?.phaseIds);
  const mode = canonicalizeQuestJourneyLifecycleMode(plan?.mode);
  const normalizedStatus = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (
    mode === "proposed" ||
    normalizedStatus === "PROPOSED" ||
    normalizedStatus === "QUEUED" ||
    phaseIds.length === 0
  ) {
    return { ok: true, prefixLength: 0 };
  }

  const activePhaseIndex = getQuestJourneyCurrentPhaseIndex(plan, status);
  if (activePhaseIndex === undefined) {
    return {
      ok: false,
      error:
        "Cannot revise this active Journey because the completed phase boundary cannot be inferred for this legacy row. Re-run with --active-phase-position / activePhaseIndex to pin the current phase occurrence before revising phases, notes, or status.",
    };
  }

  return { ok: true, prefixLength: activePhaseIndex };
}

export function validateQuestJourneyCompletedPrefixRevision(
  revision: QuestJourneyCompletedPrefixRevision,
): string | undefined {
  const prefixResult = getQuestJourneyCompletedPrefixLength(revision.existingPlan, revision.existingStatus);
  const explicitPrefixLength = getExplicitQuestJourneyCompletedPrefixLength(revision);
  if (!prefixResult.ok && explicitPrefixLength === undefined) return prefixResult.error;

  const completedPrefixLength = prefixResult.ok ? (prefixResult.prefixLength ?? 0) : (explicitPrefixLength ?? 0);
  if (completedPrefixLength <= 0) return undefined;

  const existingPhaseIds = normalizeQuestJourneyPhaseIds(revision.existingPlan?.phaseIds);
  if (revision.nextPhaseIds) {
    const nextPhaseIds = normalizeQuestJourneyPhaseIds(revision.nextPhaseIds);
    const changedCompletedPrefix =
      nextPhaseIds.length < completedPrefixLength ||
      existingPhaseIds.slice(0, completedPrefixLength).some((phaseId, index) => nextPhaseIds[index] !== phaseId);
    if (changedCompletedPrefix) {
      return `Completed Journey phase occurrences cannot be revised in place. Keep phase positions 1-${completedPrefixLength} unchanged and append a new later occurrence for changed requirements.`;
    }
  }

  const completedNoteIndex = revision.phaseNoteEditIndices?.find((index) => index < completedPrefixLength);
  if (completedNoteIndex !== undefined) {
    return `Completed Journey phase notes cannot be revised in place. Phase note position ${completedNoteIndex + 1} belongs to a completed phase occurrence; append a new later occurrence instead.`;
  }

  if (revision.nextActivePhaseIndex !== undefined && revision.nextActivePhaseIndex < completedPrefixLength) {
    return `activePhaseIndex ${revision.nextActivePhaseIndex} points to completed phase position ${revision.nextActivePhaseIndex + 1}; completed phase occurrences cannot become current again. Append a new later occurrence instead.`;
  }

  return undefined;
}

function getExplicitQuestJourneyCompletedPrefixLength(
  revision: QuestJourneyCompletedPrefixRevision,
): number | undefined {
  if (
    typeof revision.nextActivePhaseIndex !== "number" ||
    !Number.isInteger(revision.nextActivePhaseIndex) ||
    revision.nextActivePhaseIndex < 0
  ) {
    return undefined;
  }

  const existingPhaseIds = normalizeQuestJourneyPhaseIds(revision.existingPlan?.phaseIds);
  if (existingPhaseIds.length === 0) return undefined;
  const nextPhaseIds = revision.nextPhaseIds ? normalizeQuestJourneyPhaseIds(revision.nextPhaseIds) : existingPhaseIds;
  if (revision.nextActivePhaseIndex >= nextPhaseIds.length) return undefined;
  return Math.min(revision.nextActivePhaseIndex, existingPhaseIds.length);
}

function normalizeQuestJourneyPhaseNotes(
  phaseNotes: Record<string, unknown> | undefined,
  phaseCount: number,
): Record<string, string> | undefined {
  if (!phaseNotes || typeof phaseNotes !== "object") return undefined;
  const entries = Object.entries(phaseNotes)
    .map(([rawIndex, rawNote]) => {
      const index = Number.parseInt(rawIndex, 10);
      if (!Number.isInteger(index) || index < 0 || index >= phaseCount) return null;
      if (typeof rawNote !== "string") return null;
      const note = rawNote.trim();
      if (!note) return null;
      return [String(index), note] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null)
    .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeQuestJourneyTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeQuestJourneyPhaseTimings(
  phaseTimings: Record<string, unknown> | undefined,
  phaseCount: number,
): Record<string, QuestJourneyPhaseTiming> | undefined {
  if (!phaseTimings || typeof phaseTimings !== "object") return undefined;
  const entries = Object.entries(phaseTimings)
    .map(([rawIndex, rawTiming]): readonly [string, QuestJourneyPhaseTiming] | null => {
      const index = Number.parseInt(rawIndex, 10);
      if (!Number.isInteger(index) || index < 0 || index >= phaseCount) return null;
      if (!rawTiming || typeof rawTiming !== "object" || Array.isArray(rawTiming)) return null;
      const timing = rawTiming as Record<string, unknown>;
      const startedAt = normalizeQuestJourneyTimestamp(timing.startedAt);
      const endedAt = normalizeQuestJourneyTimestamp(timing.endedAt);
      if (startedAt === undefined) return null;
      const normalizedTiming: QuestJourneyPhaseTiming = {
        startedAt,
        ...(endedAt !== undefined && endedAt >= startedAt ? { endedAt } : {}),
      };
      return [String(index), normalizedTiming] as const;
    })
    .filter((entry): entry is readonly [string, QuestJourneyPhaseTiming] => entry !== null)
    .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function getQuestJourneyPhaseDurationMs(
  plan: Partial<QuestJourneyPlanState> | undefined,
  phaseIndex: number,
  now = Date.now(),
  options: QuestJourneyPhaseDurationOptions = {},
): number | undefined {
  if (!Number.isInteger(phaseIndex) || phaseIndex < 0) return undefined;
  const timing = plan?.phaseTimings?.[String(phaseIndex)];
  if (!timing?.startedAt) return undefined;
  const endedAt = timing.endedAt ?? (options.allowOpenEnded === false ? undefined : now);
  if (endedAt === undefined) return undefined;
  if (!Number.isFinite(endedAt) || endedAt < timing.startedAt) return undefined;
  return endedAt - timing.startedAt;
}

export function getQuestJourneyTotalElapsedMs(
  plan: Partial<QuestJourneyPlanState> | undefined,
  now = Date.now(),
): number | undefined {
  const phaseIds = normalizeQuestJourneyPhaseIds(plan?.phaseIds);
  if (phaseIds.length === 0) return undefined;
  let total = 0;
  let hasTiming = false;
  for (let index = 0; index < phaseIds.length; index += 1) {
    const durationMs = getQuestJourneyPhaseDurationMs(plan, index, now);
    if (durationMs === undefined) continue;
    total += durationMs;
    hasTiming = true;
  }
  return hasTiming ? total : undefined;
}

export function formatQuestJourneyDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

function normalizeQuestJourneyProposalPresentation(
  presentation: QuestJourneyPlanState["presentation"] | undefined,
): QuestJourneyPlanState["presentation"] | undefined {
  if (!presentation || typeof presentation !== "object") return undefined;
  const state = presentation.state === "presented" ? "presented" : "draft";
  const signature =
    typeof presentation.signature === "string" && presentation.signature.trim()
      ? presentation.signature.trim()
      : undefined;
  const summary =
    typeof presentation.summary === "string" && presentation.summary.trim() ? presentation.summary.trim() : undefined;
  const scheduling =
    presentation.scheduling && typeof presentation.scheduling === "object" && !Array.isArray(presentation.scheduling)
      ? { ...presentation.scheduling }
      : undefined;
  const presentedAt =
    typeof presentation.presentedAt === "number" && Number.isFinite(presentation.presentedAt)
      ? presentation.presentedAt
      : undefined;

  return {
    state,
    ...(signature ? { signature } : {}),
    ...(presentedAt ? { presentedAt } : {}),
    ...(summary ? { summary } : {}),
    ...(scheduling ? { scheduling } : {}),
  };
}

export function getQuestJourneyProposalSignature(plan: Partial<QuestJourneyPlanState> | undefined): string {
  const phaseIds = normalizeQuestJourneyPhaseIds(plan?.phaseIds);
  const phaseNotes = normalizeQuestJourneyPhaseNotes(plan?.phaseNotes, phaseIds.length);
  return JSON.stringify({
    presetId: typeof plan?.presetId === "string" && plan.presetId.trim() ? plan.presetId.trim() : undefined,
    phaseIds,
    phaseNotes: phaseNotes ?? {},
  });
}

function normalizeQuestJourneyActivePhaseIndex(
  plan: Partial<QuestJourneyPlanState> | undefined,
  phaseIds: readonly QuestJourneyPhaseId[],
  status?: string | null,
): number | undefined {
  const explicitIndex =
    typeof plan?.activePhaseIndex === "number" &&
    Number.isInteger(plan.activePhaseIndex) &&
    plan.activePhaseIndex >= 0 &&
    plan.activePhaseIndex < phaseIds.length
      ? plan.activePhaseIndex
      : undefined;
  const statusPhaseId = getQuestJourneyPhaseForState(status)?.id;
  const plannedCurrentPhaseId = getQuestJourneyPhase(plan?.currentPhaseId)?.id;
  const normalizedStatus = typeof status === "string" ? status.trim().toUpperCase() : "";

  if (statusPhaseId) {
    if (explicitIndex !== undefined && phaseIds[explicitIndex] === statusPhaseId) return explicitIndex;
    if (plannedCurrentPhaseId === statusPhaseId)
      return getUniqueQuestJourneyPhaseIndex(phaseIds, plannedCurrentPhaseId);
    return getUniqueQuestJourneyPhaseIndex(phaseIds, statusPhaseId);
  }
  if (normalizedStatus === "QUEUED" || normalizedStatus === "PROPOSED") return undefined;
  if (explicitIndex !== undefined) return explicitIndex;
  return getUniqueQuestJourneyPhaseIndex(phaseIds, plannedCurrentPhaseId);
}

export function getQuestJourneyCurrentPhaseIndex(
  plan: Partial<QuestJourneyPlanState> | undefined,
  status?: string | null,
): number | undefined {
  const normalized = normalizeQuestJourneyPlan(plan, status);
  return normalized.activePhaseIndex;
}

export function getQuestJourneyCurrentPhaseId(
  plan: Partial<QuestJourneyPlanState> | undefined,
  status?: string | null,
): QuestJourneyPhaseId | undefined {
  const normalized = normalizeQuestJourneyPlan(plan, status);
  return normalized.currentPhaseId;
}

export function normalizeQuestJourneyPlan(
  plan: Partial<QuestJourneyPlanState> | undefined,
  status?: string | null,
): QuestJourneyPlanState {
  const phaseIds = normalizeQuestJourneyPhaseIds(plan?.phaseIds);
  const nonEmptyPhaseIds = phaseIds.length > 0 ? phaseIds : [...DEFAULT_QUEST_JOURNEY_PHASE_IDS];
  const mode = canonicalizeQuestJourneyLifecycleMode(plan?.mode) ?? "active";
  const normalizedStatus = typeof status === "string" ? status.trim().toUpperCase() : "";
  const phaseNotes = normalizeQuestJourneyPhaseNotes(plan?.phaseNotes, nonEmptyPhaseIds.length);
  const phaseTimings = normalizeQuestJourneyPhaseTimings(
    plan?.phaseTimings as Record<string, unknown> | undefined,
    nonEmptyPhaseIds.length,
  );
  const presentation = normalizeQuestJourneyProposalPresentation(plan?.presentation);
  const activePhaseIndex =
    mode === "proposed" ? undefined : normalizeQuestJourneyActivePhaseIndex(plan, nonEmptyPhaseIds, status);
  const currentPhaseId =
    activePhaseIndex !== undefined && activePhaseIndex >= 0 && activePhaseIndex < nonEmptyPhaseIds.length
      ? nonEmptyPhaseIds[activePhaseIndex]
      : undefined;
  const currentPhase = getQuestJourneyPhase(currentPhaseId);
  const nextLeaderAction =
    mode === "proposed"
      ? QUEST_JOURNEY_HINTS.PROPOSED
      : (currentPhase?.nextLeaderAction ?? (normalizedStatus === "QUEUED" ? undefined : plan?.nextLeaderAction));
  return {
    presetId: plan?.presetId ?? DEFAULT_QUEST_JOURNEY_PRESET_ID,
    phaseIds: [...nonEmptyPhaseIds],
    mode,
    ...(activePhaseIndex !== undefined ? { activePhaseIndex } : {}),
    ...(currentPhaseId ? { currentPhaseId } : {}),
    ...(phaseNotes ? { phaseNotes } : {}),
    ...(phaseTimings ? { phaseTimings } : {}),
    ...(presentation ? { presentation } : {}),
    ...(nextLeaderAction ? { nextLeaderAction } : {}),
    ...(plan?.revisionReason ? { revisionReason: plan.revisionReason } : {}),
    ...(plan?.revisedAt ? { revisedAt: plan.revisedAt } : {}),
    ...(typeof plan?.revisionCount === "number" ? { revisionCount: plan.revisionCount } : {}),
  };
}

export interface QuestJourneyPresentation {
  label: string;
}

/** Human-facing labels for quest phases in the UI. Color lives on phase metadata. */
export const QUEST_JOURNEY_PRESENTATION: Record<QuestJourneyState, QuestJourneyPresentation> = {
  PROPOSED: { label: "Proposed" },
  QUEUED: { label: "Queued" },
  PLANNING: { label: "Alignment" },
  EXPLORING: { label: "Explore" },
  IMPLEMENTING: { label: "Implement" },
  CODE_REVIEWING: { label: "Code Review" },
  MENTAL_SIMULATING: { label: "Mental Simulation" },
  EXECUTING: { label: "Execute" },
  OUTCOME_REVIEWING: { label: "Outcome Review" },
  USER_CHECKPOINTING: { label: "User Checkpoint" },
  BOOKKEEPING: { label: "Bookkeeping" },
  PORTING: { label: "Port" },
};

/** Returns the UI presentation metadata for a known quest-journey state. */
export function getQuestJourneyPresentation(status?: string | null): QuestJourneyPresentation | null {
  const canonical = canonicalizeQuestJourneyState(status);
  return canonical ? QUEST_JOURNEY_PRESENTATION[canonical] : null;
}

/** Replace embedded quest-journey enum tokens in freeform text with human labels. */
export function formatQuestJourneyText(text: string): string {
  return text.replace(
    /\b(PROPOSED|QUEUED|PLANNING|EXPLORING|IMPLEMENTING|CODE_REVIEWING|MENTAL_SIMULATING|EXECUTING|OUTCOME_REVIEWING|USER_CHECKPOINTING|BOOKKEEPING|PORTING|SKEPTIC_REVIEWING|GROOM_REVIEWING)\b/g,
    (match) => getQuestJourneyPresentation(match)?.label ?? match,
  );
}

/** Next-action hints for Quest Journey states, including legacy aliases. */
export const QUEST_JOURNEY_HINTS: Record<string, string> = {
  PROPOSED: "present or revise the proposed Journey, then promote it after approval",
  QUEUED: "dispatch to a worker",
  PLANNING: QUEST_JOURNEY_PHASE_BY_ID.alignment.nextLeaderAction,
  EXPLORING: QUEST_JOURNEY_PHASE_BY_ID.explore.nextLeaderAction,
  IMPLEMENTING: QUEST_JOURNEY_PHASE_BY_ID.implement.nextLeaderAction,
  CODE_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["code-review"].nextLeaderAction,
  MENTAL_SIMULATING: QUEST_JOURNEY_PHASE_BY_ID["mental-simulation"].nextLeaderAction,
  EXECUTING: QUEST_JOURNEY_PHASE_BY_ID.execute.nextLeaderAction,
  OUTCOME_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["outcome-review"].nextLeaderAction,
  USER_CHECKPOINTING: QUEST_JOURNEY_PHASE_BY_ID["user-checkpoint"].nextLeaderAction,
  BOOKKEEPING: QUEST_JOURNEY_PHASE_BY_ID.bookkeeping.nextLeaderAction,
  PORTING: QUEST_JOURNEY_PHASE_BY_ID.port.nextLeaderAction,
  SKEPTIC_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["code-review"].nextLeaderAction,
  GROOM_REVIEWING: QUEST_JOURNEY_PHASE_BY_ID["code-review"].nextLeaderAction,
};
