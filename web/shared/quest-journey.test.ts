import { describe, it, expect } from "vitest";
import {
  FREE_WORKER_WAIT_FOR_TOKEN,
  canonicalizeQuestJourneyPhaseId,
  canonicalizeQuestJourneyState,
  formatQuestJourneyText,
  formatWaitForRefLabel,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  getWaitForRefKind,
  isValidQuestId,
  isValidWaitForRef,
  normalizeQuestJourneyPhaseIds,
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
  it.each(["q-1", "q-42", "q-999", "Q-1"])("accepts valid quest ref: %j", (ref) => {
    expect(isValidWaitForRef(ref)).toBe(true);
  });

  it.each(["#1", "#42", "#332"])("accepts valid session ref: %j", (ref) => {
    expect(isValidWaitForRef(ref)).toBe(true);
  });

  it.each([FREE_WORKER_WAIT_FOR_TOKEN, "FREE-WORKER"])("accepts free-worker ref: %j", (ref) => {
    expect(isValidWaitForRef(ref)).toBe(true);
  });

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
    expect(formatQuestJourneyText("advanced q-42 to CODE_REVIEWING")).toBe("advanced q-42 to Code Review");
    expect(formatQuestJourneyText("moved from SKEPTIC_REVIEWING to PORTING")).toBe("moved from Code Review to Port");
  });

  it("leaves unrelated text unchanged", () => {
    expect(formatQuestJourneyText("advanced q-42 to CUSTOM_STATUS")).toBe("advanced q-42 to CUSTOM_STATUS");
  });
});

describe("phase alias compatibility", () => {
  it("maps legacy phase names and bookkeeping candidates to canonical ids", () => {
    expect(canonicalizeQuestJourneyPhaseId("implementation")).toBe("implement");
    expect(canonicalizeQuestJourneyPhaseId("skeptic-review")).toBe("code-review");
    expect(canonicalizeQuestJourneyPhaseId("reviewer-groom")).toBe("code-review");
    expect(canonicalizeQuestJourneyPhaseId("state-update")).toBe("bookkeeping");
    expect(canonicalizeQuestJourneyPhaseId("stream-update")).toBe("bookkeeping");
    expect(canonicalizeQuestJourneyPhaseId("porting")).toBe("port");
  });

  it("maps legacy review states to the canonical review state", () => {
    expect(canonicalizeQuestJourneyState("SKEPTIC_REVIEWING")).toBe("CODE_REVIEWING");
    expect(canonicalizeQuestJourneyState("GROOM_REVIEWING")).toBe("CODE_REVIEWING");
  });

  it("normalizes legacy phase sequences into the new library", () => {
    expect(
      normalizeQuestJourneyPhaseIds(["planning", "implementation", "skeptic-review", "reviewer-groom", "porting"]),
    ).toEqual(["planning", "implement", "code-review", "port"]);
  });
});

describe("QUEST_JOURNEY_HINTS", () => {
  it("describes the normal phase-driven review and port actions", () => {
    expect(QUEST_JOURNEY_HINTS.CODE_REVIEWING).toContain("reviewer result");
    expect(QUEST_JOURNEY_HINTS.PORTING).toContain("sync confirmation");
  });
});

describe("Quest Journey phases", () => {
  it("represents the new durable phase library without human verification", () => {
    expect(DEFAULT_QUEST_JOURNEY_PHASE_IDS).toEqual(["planning", "implement", "code-review", "port"]);
    expect(QUEST_JOURNEY_PHASES.map((phase) => phase.id)).toEqual([
      "planning",
      "explore",
      "implement",
      "code-review",
      "mental-simulation",
      "execute",
      "outcome-review",
      "bookkeeping",
      "port",
    ]);
    expect(QUEST_JOURNEY_PHASES.map((phase) => phase.boardState)).toEqual([
      "PLANNING",
      "EXPLORING",
      "IMPLEMENTING",
      "CODE_REVIEWING",
      "MENTAL_SIMULATING",
      "EXECUTING",
      "OUTCOME_REVIEWING",
      "BOOKKEEPING",
      "PORTING",
    ]);
    expect(QUEST_JOURNEY_PHASES.find((phase) => phase.id === "code-review")?.aliases).toEqual([
      "skeptic-review",
      "reviewer-groom",
    ]);
    expect(QUEST_JOURNEY_PHASES.find((phase) => phase.id === "port")?.aliases).toEqual(["porting"]);
  });

  it("maps board states to current phases and next leader actions", () => {
    expect(getQuestJourneyPhaseForState("IMPLEMENTING")?.id).toBe("implement");
    expect(getQuestJourneyPhaseForState("SKEPTIC_REVIEWING")?.id).toBe("code-review");
    expect(getQuestJourneyPhase("bookkeeping")?.boardState).toBe("BOOKKEEPING");
    expect(normalizeQuestJourneyPlan(undefined, "PORTING")).toEqual(
      expect.objectContaining({
        phaseIds: DEFAULT_QUEST_JOURNEY_PHASE_IDS,
        currentPhaseId: "port",
        nextLeaderAction: expect.stringContaining("sync confirmation"),
      }),
    );
  });

  it("keeps custom planned phases while deriving the current phase from board state", () => {
    expect(
      normalizeQuestJourneyPlan({ presetId: "ops", phaseIds: ["planning", "explore", "execute"] }, "PLANNING"),
    ).toEqual(
      expect.objectContaining({
        presetId: "ops",
        phaseIds: ["planning", "explore", "execute"],
        currentPhaseId: "planning",
      }),
    );
  });

  it("preserves revision metadata on normalized plans", () => {
    expect(
      normalizeQuestJourneyPlan(
        {
          presetId: "cli-rollout",
          phaseIds: ["implement", "outcome-review", "code-review", "port"],
          currentPhaseId: "implement",
          revisionReason: "Need outcome evidence before final review",
          revisedAt: 123,
          revisionCount: 2,
        },
        "IMPLEMENTING",
      ),
    ).toEqual(
      expect.objectContaining({
        phaseIds: ["implement", "outcome-review", "code-review", "port"],
        currentPhaseId: "implement",
        revisionReason: "Need outcome evidence before final review",
        revisedAt: 123,
        revisionCount: 2,
      }),
    );
  });
});
