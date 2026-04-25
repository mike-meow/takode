import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUEST_JOURNEY_PHASES, type QuestJourneyPhase, type QuestJourneyPhaseId } from "../shared/quest-journey.js";

export type LoadedQuestJourneyPhase = QuestJourneyPhase & {
  path: string;
  content: string;
};

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

function projectRoot(): string {
  return process.env.__COMPANION_PACKAGE_ROOT
    ? resolve(process.env.__COMPANION_PACKAGE_ROOT)
    : resolve(SERVER_DIR, "../..");
}

export function getQuestJourneyPhaseSkillPath(phaseId: QuestJourneyPhaseId): string {
  const phase = QUEST_JOURNEY_PHASES.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new Error(`Unknown Quest Journey phase: ${phaseId}`);
  return join(projectRoot(), ".claude", "skills", phase.skill, "SKILL.md");
}

export async function loadQuestJourneyPhase(phaseId: QuestJourneyPhaseId): Promise<LoadedQuestJourneyPhase> {
  const phase = QUEST_JOURNEY_PHASES.find((candidate) => candidate.id === phaseId);
  if (!phase) throw new Error(`Unknown Quest Journey phase: ${phaseId}`);
  const path = getQuestJourneyPhaseSkillPath(phaseId);
  return {
    ...phase,
    path,
    content: await readFile(path, "utf-8"),
  };
}

export async function loadBuiltInQuestJourneyPhases(): Promise<LoadedQuestJourneyPhase[]> {
  return Promise.all(QUEST_JOURNEY_PHASES.map((phase) => loadQuestJourneyPhase(phase.id)));
}
