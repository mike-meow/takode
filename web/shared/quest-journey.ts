/**
 * Quest Journey state machine constants.
 * Shared between server (session-types.ts) and CLI (takode.ts).
 */

/** Quest Journey states. Each represents a leader action that just happened. */
export const QUEST_JOURNEY_STATES = [
  "PLANNED",
  "DISPATCHED",
  "PLAN_APPROVED",
  "SKEPTIC_REVIEWED",
  "GROOM_SENT",
  "GROOMED",
  "PORT_REQUESTED",
] as const;

export type QuestJourneyState = (typeof QUEST_JOURNEY_STATES)[number];

/** Next-action hints for each Quest Journey state. */
export const QUEST_JOURNEY_HINTS: Record<QuestJourneyState, string> = {
  PLANNED: "dispatch to a worker",
  DISPATCHED: "wait for ExitPlanMode, then review plan",
  PLAN_APPROVED: "wait for turn_end, then spawn skeptic reviewer",
  SKEPTIC_REVIEWED: "tell worker to run /groom",
  GROOM_SENT: "wait for report, then send findings to reviewer",
  GROOMED: "tell worker to port",
  PORT_REQUESTED: "wait for port confirmation, then remove from board",
};
