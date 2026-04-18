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
export const WAIT_FOR_REF_PATTERN = /^(q-\d+|#\d+)$/i;

/** Returns true if the string is a valid wait-for dependency reference (q-N or #N). */
export function isValidWaitForRef(ref: string): boolean {
  return WAIT_FOR_REF_PATTERN.test(ref);
}

/**
 * Quest Journey stages. Each is a present-participle verb describing
 * what is happening NOW for this quest on the board.
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

export interface QuestJourneyPresentation {
  label: string;
  textClassName: string;
}

/** Human-facing labels and text-only color treatment for quest stages in the UI. */
export const QUEST_JOURNEY_PRESENTATION: Record<QuestJourneyState, QuestJourneyPresentation> = {
  QUEUED: { label: "Queued", textClassName: "text-cc-muted" },
  PLANNING: { label: "Planning", textClassName: "text-green-400" },
  IMPLEMENTING: { label: "Implementing", textClassName: "text-green-400" },
  SKEPTIC_REVIEWING: { label: "Skeptic Review", textClassName: "text-violet-500" },
  GROOM_REVIEWING: { label: "Groom Review", textClassName: "text-violet-500" },
  PORTING: { label: "Porting", textClassName: "text-blue-400" },
};

/** Returns the UI presentation metadata for a known quest-journey state. */
export function getQuestJourneyPresentation(status?: string | null): QuestJourneyPresentation | null {
  if (!status || !(status in QUEST_JOURNEY_PRESENTATION)) return null;
  return QUEST_JOURNEY_PRESENTATION[status as QuestJourneyState];
}

/** Next-action hints for each Quest Journey stage. */
export const QUEST_JOURNEY_HINTS: Record<QuestJourneyState, string> = {
  QUEUED: "dispatch to a worker",
  PLANNING: "wait for ExitPlanMode, then review plan",
  IMPLEMENTING: "wait for turn_end, then spawn skeptic reviewer",
  SKEPTIC_REVIEWING: "wait for reviewer ACCEPT; skeptic-review dispatches must explicitly say to use /skeptic-review",
  GROOM_REVIEWING: "wait for reviewer ACCEPT on the worker response, then tell worker to port",
  PORTING: "wait for port confirmation, then remove from board",
};
