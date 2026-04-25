import { describe, expect, it } from "vitest";
import { DEFAULT_QUEST_JOURNEY_PHASE_IDS } from "../shared/quest-journey.js";
import { getQuestJourneyPhaseSkillPath, loadBuiltInQuestJourneyPhases } from "./quest-journey-phases.js";

describe("Quest Journey phase skill loading", () => {
  it("loads concise built-in phase skill files for the default Quest Journey", async () => {
    const phases = await loadBuiltInQuestJourneyPhases();

    expect(phases.map((phase) => phase.id)).toEqual(DEFAULT_QUEST_JOURNEY_PHASE_IDS);
    for (const phase of phases) {
      expect(phase.path).toBe(getQuestJourneyPhaseSkillPath(phase.id));
      expect(phase.content).toContain("Quest Journey Phase:");
      expect(phase.content).not.toContain("Human Verification");
      expect(phase.content.length).toBeLessThan(2000);
    }
  });
});
