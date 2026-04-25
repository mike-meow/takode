import { describe, it, expect } from "vitest";
import {
  FREE_WORKER_WAIT_FOR_TOKEN,
  formatQuestJourneyText,
  formatWaitForRefLabel,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  getWaitForRefKind,
  isValidQuestId,
  isValidWaitForRef,
  normalizeQuestJourneyPlan,
  QUEST_JOURNEY_PHASES,
  DEFAULT_QUEST_JOURNEY_PHASE_IDS,
  QUEST_JOURNEY_HINTS,
} from "./quest-journey.js";

describe("isValidQuestId", () => {
  it.each(["q-1", "q-42", "q-999", "Q-1"])("accepts valid quest ID: %j", (id) => {
    expect(isValidQuestId(id)).toBe(true);
  });

  it.each(["42", "#5", "q-", "foo", "q-abc", ""])("rejects invalid quest ID: %j", (id) => {
    expect(isValidQuestId(id)).toBe(false);
  });
});

describe("isValidWaitForRef", () => {
  // Quest refs (q-N)
  it.each(["q-1", "q-42", "q-999", "Q-1"])("accepts valid quest ref: %j", (ref) => {
    expect(isValidWaitForRef(ref)).toBe(true);
  });

  // Session refs (#N)
  it.each(["#1", "#42", "#332"])("accepts valid session ref: %j", (ref) => {
    expect(isValidWaitForRef(ref)).toBe(true);
  });

  it.each([FREE_WORKER_WAIT_FOR_TOKEN, "FREE-WORKER"])("accepts free-worker ref: %j", (ref) => {
    expect(isValidWaitForRef(ref)).toBe(true);
  });

  // Invalid refs
  it.each(["42", "foo", "q-", "#", "#abc", "session-5", "", "q-1,#5"])("rejects invalid wait-for ref: %j", (ref) => {
    expect(isValidWaitForRef(ref)).toBe(false);
  });
});

describe("getWaitForRefKind", () => {
  it.each([
    ["q-9", "quest"],
    ["#22", "session"],
    [FREE_WORKER_WAIT_FOR_TOKEN, "free-worker"],
    ["oops", "invalid"],
  ])("classifies %j as %j", (ref, expected) => {
    expect(getWaitForRefKind(ref)).toBe(expected);
  });
});

describe("formatWaitForRefLabel", () => {
  it("humanizes the free-worker token while preserving other refs", () => {
    expect(formatWaitForRefLabel(FREE_WORKER_WAIT_FOR_TOKEN)).toBe("free worker");
    expect(formatWaitForRefLabel("q-12")).toBe("q-12");
    expect(formatWaitForRefLabel("#4")).toBe("#4");
  });
});

describe("formatQuestJourneyText", () => {
  it("replaces embedded enum tokens with human-facing quest journey labels", () => {
    expect(formatQuestJourneyText("advanced q-42 to SKEPTIC_REVIEWING")).toBe("advanced q-42 to Addressing Skeptic");
    expect(formatQuestJourneyText("moved from GROOM_REVIEWING to PORTING")).toBe("moved from Grooming to Porting");
  });

  it("leaves unrelated text unchanged", () => {
    expect(formatQuestJourneyText("advanced q-42 to CUSTOM_STATUS")).toBe("advanced q-42 to CUSTOM_STATUS");
  });
});

describe("QUEST_JOURNEY_HINTS", () => {
  it("documents the explicit no-code skip-groom path at skeptic review", () => {
    expect(QUEST_JOURNEY_HINTS.SKEPTIC_REVIEWING).toContain("advance-no-groom");
    expect(QUEST_JOURNEY_HINTS.SKEPTIC_REVIEWING).toContain("explicitly marked");
  });
});

describe("Quest Journey phases", () => {
  it("represents the existing fixed journey as built-in phases without human verification", () => {
    expect(DEFAULT_QUEST_JOURNEY_PHASE_IDS).toEqual([
      "planning",
      "implementation",
      "skeptic-review",
      "reviewer-groom",
      "porting",
    ]);
    expect(QUEST_JOURNEY_PHASES.map((phase) => phase.skill)).toEqual([
      "quest-journey-planning",
      "quest-journey-implementation",
      "quest-journey-skeptic-review",
      "quest-journey-reviewer-groom",
      "quest-journey-porting",
    ]);
    expect(QUEST_JOURNEY_PHASES.map((phase) => phase.id)).not.toContain("human-verification");
  });

  it("maps board states to current phases and next leader actions", () => {
    expect(getQuestJourneyPhaseForState("IMPLEMENTING")?.id).toBe("implementation");
    expect(getQuestJourneyPhase("reviewer-groom")?.state).toBe("GROOM_REVIEWING");
    expect(normalizeQuestJourneyPlan(undefined, "PORTING")).toEqual(
      expect.objectContaining({
        phaseIds: DEFAULT_QUEST_JOURNEY_PHASE_IDS,
        currentPhaseId: "porting",
        nextLeaderAction: expect.stringContaining("port confirmation"),
      }),
    );
  });

  it("keeps custom planned phases while deriving the current phase from board state", () => {
    expect(
      normalizeQuestJourneyPlan({ presetId: "lightweight", phaseIds: ["planning", "implementation"] }, "PLANNING"),
    ).toEqual(
      expect.objectContaining({
        presetId: "lightweight",
        phaseIds: ["planning", "implementation"],
        currentPhaseId: "planning",
      }),
    );
  });
});
