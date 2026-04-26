import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getQuestJourneyPhase,
  QUEST_JOURNEY_PHASES,
  type QuestJourneyPhase,
  type QuestJourneyPhaseId,
} from "../shared/quest-journey.js";

export type LoadedQuestJourneyPhase = QuestJourneyPhase & {
  dirPath: string;
  phaseJsonPath: string;
  leaderBriefPath: string;
  assigneeBriefPath: string;
  leaderBrief: string;
  assigneeBrief: string;
};

export interface QuestJourneyPhasePathOptions {
  packageRoot?: string;
  companionHome?: string;
}

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const QUEST_JOURNEY_PHASE_DIRNAME = "quest-journey-phases";
const QUEST_JOURNEY_PHASE_DISPLAY_ROOT = "~/.companion/quest-journey-phases";

function resolvePackageRoot(options?: QuestJourneyPhasePathOptions): string {
  return options?.packageRoot
    ? resolve(options.packageRoot)
    : process.env.__COMPANION_PACKAGE_ROOT
      ? resolve(process.env.__COMPANION_PACKAGE_ROOT)
      : resolve(SERVER_DIR, "..");
}

function resolveCompanionHome(options?: QuestJourneyPhasePathOptions): string {
  return options?.companionHome ? resolve(options.companionHome) : join(homedir(), ".companion");
}

export function getQuestJourneyPhaseCanonicalRoot(options?: QuestJourneyPhasePathOptions): string {
  return join(resolvePackageRoot(options), "shared", QUEST_JOURNEY_PHASE_DIRNAME);
}

export function getQuestJourneyPhaseDataRoot(options?: QuestJourneyPhasePathOptions): string {
  return join(resolveCompanionHome(options), QUEST_JOURNEY_PHASE_DIRNAME);
}

export function getQuestJourneyPhaseDisplayRoot(): string {
  return QUEST_JOURNEY_PHASE_DISPLAY_ROOT;
}

export function getQuestJourneyPhaseDataDir(
  phaseId: QuestJourneyPhaseId,
  options?: QuestJourneyPhasePathOptions,
): string {
  return join(getQuestJourneyPhaseDataRoot(options), phaseId);
}

export function getQuestJourneyPhaseLeaderBriefPath(
  phaseId: QuestJourneyPhaseId,
  options?: QuestJourneyPhasePathOptions,
): string {
  return join(getQuestJourneyPhaseDataDir(phaseId, options), "leader.md");
}

export function getQuestJourneyPhaseAssigneeBriefPath(
  phaseId: QuestJourneyPhaseId,
  options?: QuestJourneyPhasePathOptions,
): string {
  return join(getQuestJourneyPhaseDataDir(phaseId, options), "assignee.md");
}

export function getQuestJourneyPhaseLeaderBriefDisplayPath(phaseId: QuestJourneyPhaseId): string {
  return `${QUEST_JOURNEY_PHASE_DISPLAY_ROOT}/${phaseId}/leader.md`;
}

export function getQuestJourneyPhaseAssigneeBriefDisplayPath(phaseId: QuestJourneyPhaseId): string {
  return `${QUEST_JOURNEY_PHASE_DISPLAY_ROOT}/${phaseId}/assignee.md`;
}

export async function ensureBuiltInQuestJourneyPhaseData(options?: QuestJourneyPhasePathOptions): Promise<void> {
  const canonicalRoot = getQuestJourneyPhaseCanonicalRoot(options);
  const dataRoot = getQuestJourneyPhaseDataRoot(options);
  await mkdir(dataRoot, { recursive: true });

  for (const phase of QUEST_JOURNEY_PHASES) {
    const canonicalDir = join(canonicalRoot, phase.id);
    const dataDir = getQuestJourneyPhaseDataDir(phase.id, options);
    await mkdir(dataDir, { recursive: true });

    const [phaseJson, leaderBrief, assigneeBrief] = await Promise.all([
      readFile(join(canonicalDir, "phase.json"), "utf-8"),
      readFile(join(canonicalDir, "leader.md"), "utf-8"),
      readFile(join(canonicalDir, "assignee.md"), "utf-8"),
    ]);

    await Promise.all([
      writeFile(join(dataDir, "phase.json"), phaseJson, "utf-8"),
      writeFile(join(dataDir, "leader.md"), leaderBrief, "utf-8"),
      writeFile(join(dataDir, "assignee.md"), assigneeBrief, "utf-8"),
    ]);
  }
}

export async function loadQuestJourneyPhase(
  phaseId: QuestJourneyPhaseId,
  options?: QuestJourneyPhasePathOptions,
): Promise<LoadedQuestJourneyPhase> {
  const canonical = getQuestJourneyPhase(phaseId);
  if (!canonical) throw new Error(`Unknown Quest Journey phase: ${phaseId}`);

  const dirPath = getQuestJourneyPhaseDataDir(phaseId, options);
  const phaseJsonPath = join(dirPath, "phase.json");
  const leaderBriefPath = getQuestJourneyPhaseLeaderBriefPath(phaseId, options);
  const assigneeBriefPath = getQuestJourneyPhaseAssigneeBriefPath(phaseId, options);

  const [phaseJsonRaw, leaderBrief, assigneeBrief] = await Promise.all([
    readFile(phaseJsonPath, "utf-8"),
    readFile(leaderBriefPath, "utf-8"),
    readFile(assigneeBriefPath, "utf-8"),
  ]);

  const loaded = JSON.parse(phaseJsonRaw) as QuestJourneyPhase;
  if (loaded.id !== phaseId) {
    throw new Error(`Quest Journey phase metadata mismatch in ${phaseJsonPath}: expected ${phaseId}, got ${loaded.id}`);
  }

  return {
    ...canonical,
    ...loaded,
    dirPath,
    phaseJsonPath,
    leaderBriefPath,
    assigneeBriefPath,
    leaderBrief,
    assigneeBrief,
  };
}

export async function loadBuiltInQuestJourneyPhases(
  options?: QuestJourneyPhasePathOptions,
): Promise<LoadedQuestJourneyPhase[]> {
  return Promise.all(
    QUEST_JOURNEY_PHASES.map((phase) => loadQuestJourneyPhase(phase.id as QuestJourneyPhaseId, options)),
  );
}
