import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { QUEST_JOURNEY_PHASES } from "../shared/quest-journey.js";
import {
  ensureBuiltInQuestJourneyPhaseData,
  getQuestJourneyPhaseAssigneeBriefPath,
  getQuestJourneyPhaseDataRoot,
  getQuestJourneyPhaseDisplayRoot,
  getQuestJourneyPhaseLeaderBriefPath,
  loadBuiltInQuestJourneyPhases,
} from "./quest-journey-phases.js";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SERVER_DIR, "..");
const tmpHomes: string[] = [];

afterEach(async () => {
  await Promise.all(tmpHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCompanionHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quest-journey-phases-"));
  tmpHomes.push(dir);
  return dir;
}

describe("Quest Journey phase directory loading", () => {
  it("seeds and loads built-in phase directories from server-owned data", async () => {
    const companionHome = await makeCompanionHome();
    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    const phases = await loadBuiltInQuestJourneyPhases({ companionHome });

    expect(phases.map((phase) => phase.id)).toEqual(QUEST_JOURNEY_PHASES.map((phase) => phase.id));
    expect(getQuestJourneyPhaseDisplayRoot()).toBe("~/.companion/quest-journey-phases");

    for (const phase of phases) {
      expect(phase.dirPath).toBe(join(getQuestJourneyPhaseDataRoot({ companionHome }), phase.id));
      expect(phase.phaseJsonPath).toBe(join(phase.dirPath, "phase.json"));
      expect(phase.leaderBriefPath).toBe(getQuestJourneyPhaseLeaderBriefPath(phase.id, { companionHome }));
      expect(phase.assigneeBriefPath).toBe(getQuestJourneyPhaseAssigneeBriefPath(phase.id, { companionHome }));
      expect(phase.leaderBrief).toContain("Leader Brief");
      expect(phase.assigneeBrief).toContain("Assignee Brief");
      expect(phase.contract.length).toBeGreaterThan(20);
      expect(phase.nextLeaderAction.length).toBeGreaterThan(20);
    }
  });

  it("refreshes built-in phase files from canonical repo data on reseed", async () => {
    const companionHome = await makeCompanionHome();
    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    const alignmentPath = getQuestJourneyPhaseLeaderBriefPath("alignment", { companionHome });
    await writeFile(alignmentPath, "stale", "utf-8");

    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    const refreshed = await readFile(alignmentPath, "utf-8");
    const canonical = await readFile(
      join(PACKAGE_ROOT, "shared", "quest-journey-phases", "alignment", "leader.md"),
      "utf-8",
    );

    expect(refreshed).toBe(canonical);
  });

  it("seeds phase briefs with the execute and outcome-review responsibility boundaries", async () => {
    const companionHome = await makeCompanionHome();
    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    const phases = await loadBuiltInQuestJourneyPhases({ companionHome });
    const implementPhase = phases.find((phase) => phase.id === "implement");
    const executePhase = phases.find((phase) => phase.id === "execute");
    const outcomeReviewPhase = phases.find((phase) => phase.id === "outcome-review");

    expect(implementPhase?.leaderBrief).toContain("cheap, local, reversible outcome evidence");
    expect(implementPhase?.assigneeBrief).toContain("those belong in `EXECUTING`");
    expect(executePhase?.leaderBrief).toContain("Use `EXECUTING` instead of `IMPLEMENTING`");
    expect(executePhase?.assigneeBrief).toContain(
      "Do not turn this phase into the main implementation or debugging loop",
    );
    expect(outcomeReviewPhase?.leaderBrief).toContain("reviewer-owned acceptance phase");
    expect(outcomeReviewPhase?.leaderBrief).toContain("route back to `IMPLEMENTING`");
    expect(outcomeReviewPhase?.assigneeBrief).toContain("small bounded checks or repros");
    expect(outcomeReviewPhase?.assigneeBrief).toContain("do not become the primary experiment owner");
  });

  it("seeds alignment and explore briefs with the lightweight read-in contract", async () => {
    const companionHome = await makeCompanionHome();
    await ensureBuiltInQuestJourneyPhaseData({ packageRoot: PACKAGE_ROOT, companionHome });

    const phases = await loadBuiltInQuestJourneyPhases({ companionHome });
    const alignmentPhase = phases.find((phase) => phase.id === "alignment");
    const explorePhase = phases.find((phase) => phase.id === "explore");

    expect(alignmentPhase?.leaderBrief).toContain("exact prior messages, quests, or discussions");
    expect(alignmentPhase?.assigneeBrief).toContain("Takode and quest inspection tools");
    expect(alignmentPhase?.assigneeBrief).toContain("Concrete understanding:");
    expect(alignmentPhase?.assigneeBrief).toContain("Clarification questions:");
    expect(explorePhase?.leaderBrief).toContain("major findings, newly discovered ambiguities or blockers");
    expect(explorePhase?.assigneeBrief).toContain("major findings");
    expect(explorePhase?.assigneeBrief).toContain("high-level plan for next steps");
  });
});
