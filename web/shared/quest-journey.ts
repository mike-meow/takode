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

/** Next-action hints for each Quest Journey stage. */
export const QUEST_JOURNEY_HINTS: Record<QuestJourneyState, string> = {
  QUEUED: "dispatch to a worker",
  PLANNING: "wait for ExitPlanMode, then review plan",
  IMPLEMENTING: "wait for turn_end, then spawn skeptic reviewer",
  SKEPTIC_REVIEWING: "wait for reviewer ACCEPT, then tell worker to run /groom",
  GROOM_REVIEWING: "wait for reviewer ACCEPT, then tell worker to port",
  PORTING: "wait for port confirmation, then remove from board",
};
