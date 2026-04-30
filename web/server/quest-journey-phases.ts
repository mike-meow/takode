import { homedir } from "node:os";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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

export type QuestJourneyPhaseSourceType = "built-in" | "custom";

export interface QuestJourneyPhaseCatalogEntry {
  id: string;
  label: string;
  color?: QuestJourneyPhase["color"];
  boardState: string;
  assigneeRole: string;
  contract: string;
  nextLeaderAction: string;
  aliases: string[];
  sourceType: QuestJourneyPhaseSourceType;
  sourcePath: string;
  dirPath: string;
  phaseJsonPath: string;
  leaderBriefPath: string;
  assigneeBriefPath: string;
  dirDisplayPath: string;
  phaseJsonDisplayPath: string;
  leaderBriefDisplayPath: string;
  assigneeBriefDisplayPath: string;
}

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
  if (options?.companionHome) return resolve(options.companionHome);
  const envHome = process.env.HOME?.trim();
  return join(envHome || homedir(), ".companion");
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

export function getQuestJourneyPhaseDirDisplayPath(phaseId: string): string {
  return `${QUEST_JOURNEY_PHASE_DISPLAY_ROOT}/${phaseId}`;
}

export function getQuestJourneyPhaseJsonDisplayPath(phaseId: string): string {
  return `${getQuestJourneyPhaseDirDisplayPath(phaseId)}/phase.json`;
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

export function getQuestJourneyPhaseLeaderBriefDisplayPath(phaseId: string): string {
  return `${getQuestJourneyPhaseDirDisplayPath(phaseId)}/leader.md`;
}

export function getQuestJourneyPhaseAssigneeBriefDisplayPath(phaseId: string): string {
  return `${getQuestJourneyPhaseDirDisplayPath(phaseId)}/assignee.md`;
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

export async function ensureQuestJourneyPhaseDataForCwd(
  cwd: string,
  options?: Pick<QuestJourneyPhasePathOptions, "companionHome">,
): Promise<boolean> {
  const packageRoot = await findQuestJourneyPackageRootForCwd(cwd);
  if (!packageRoot) return false;

  await ensureBuiltInQuestJourneyPhaseData({ ...options, packageRoot });
  return true;
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
  return Promise.all(QUEST_JOURNEY_PHASES.map((phase) => loadQuestJourneyPhase(phase.id, options)));
}

export async function loadQuestJourneyPhaseCatalog(
  options?: QuestJourneyPhasePathOptions,
): Promise<QuestJourneyPhaseCatalogEntry[]> {
  const phases = await loadBuiltInQuestJourneyPhases(options);
  return phases.map((phase) => ({
    id: phase.id,
    label: phase.label,
    color: phase.color,
    boardState: phase.boardState,
    assigneeRole: phase.assigneeRole,
    contract: phase.contract,
    nextLeaderAction: phase.nextLeaderAction,
    aliases: [...phase.aliases],
    sourceType: "built-in",
    sourcePath: join(getQuestJourneyPhaseCanonicalRoot(options), phase.id),
    dirPath: phase.dirPath,
    phaseJsonPath: phase.phaseJsonPath,
    leaderBriefPath: phase.leaderBriefPath,
    assigneeBriefPath: phase.assigneeBriefPath,
    dirDisplayPath: getQuestJourneyPhaseDirDisplayPath(phase.id),
    phaseJsonDisplayPath: getQuestJourneyPhaseJsonDisplayPath(phase.id),
    leaderBriefDisplayPath: getQuestJourneyPhaseLeaderBriefDisplayPath(phase.id),
    assigneeBriefDisplayPath: getQuestJourneyPhaseAssigneeBriefDisplayPath(phase.id),
  }));
}

async function findQuestJourneyPackageRootForCwd(cwd: string): Promise<string | null> {
  let current = resolve(cwd);

  while (true) {
    const directPackageRoot = await maybeQuestJourneyPackageRoot(current);
    if (directPackageRoot) return directPackageRoot;

    const webPackageRoot = await maybeQuestJourneyPackageRoot(join(current, "web"));
    if (webPackageRoot) return webPackageRoot;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function maybeQuestJourneyPackageRoot(candidate: string): Promise<string | null> {
  const phaseRoot = join(candidate, "shared", QUEST_JOURNEY_PHASE_DIRNAME);
  try {
    await Promise.all([access(join(candidate, "package.json")), access(phaseRoot)]);
    return candidate;
  } catch {
    return null;
  }
}
