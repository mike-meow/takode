import { describe, it, expect } from "vitest";
import {
  FREE_WORKER_WAIT_FOR_TOKEN,
  canonicalizeQuestJourneyPhaseId,
  canonicalizeQuestJourneyLifecycleMode,
  canonicalizeQuestJourneyState,
  formatQuestJourneyText,
  formatWaitForRefLabel,
  getQuestJourneyCurrentPhaseId,
  getQuestJourneyCurrentPhaseIndex,
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
  rebaseQuestJourneyPhaseNotes,
  type QuestJourneyPhaseId,
} from "./quest-journey.js";

const VALID_PHASE_IDS = ["alignment", "mental-simulation", "port"] as const satisfies readonly QuestJourneyPhaseId[];
// @ts-expect-error compile-time guard: invalid phase ids must not widen to string
const INVALID_PHASE_IDS = ["planning", "not-a-phase"] as const satisfies readonly QuestJourneyPhaseId[];

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
    expect(formatQuestJourneyText("advanced q-42 to PLANNING")).toBe("advanced q-42 to Alignment");
    expect(formatQuestJourneyText("left q-42 as PROPOSED")).toBe("left q-42 as Proposed");
    expect(formatQuestJourneyText("advanced q-42 to CODE_REVIEWING")).toBe("advanced q-42 to Code Review");
    expect(formatQuestJourneyText("moved from SKEPTIC_REVIEWING to PORTING")).toBe("moved from Code Review to Port");
  });

  it("leaves unrelated text unchanged", () => {
    expect(formatQuestJourneyText("advanced q-42 to CUSTOM_STATUS")).toBe("advanced q-42 to CUSTOM_STATUS");
  });
});

describe("phase alias compatibility", () => {
  it("maps legacy phase names and bookkeeping candidates to canonical ids", () => {
    expect(canonicalizeQuestJourneyPhaseId("planning")).toBe("alignment");
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

  it("normalizes legacy phase sequences into the new library while preserving repeats", () => {
    expect(
      normalizeQuestJourneyPhaseIds([
        "planning",
        "implementation",
        "skeptic-review",
        "reviewer-groom",
        "porting",
        "implementation",
      ]),
    ).toEqual(["alignment", "implement", "code-review", "code-review", "port", "implement"]);
  });
});

describe("QUEST_JOURNEY_HINTS", () => {
  it("describes the normal phase-driven review and port actions", () => {
    expect(QUEST_JOURNEY_HINTS.PROPOSED).toContain("promote");
    expect(QUEST_JOURNEY_HINTS.CODE_REVIEWING).toContain("reviewer result");
    expect(QUEST_JOURNEY_HINTS.PORTING).toContain("sync confirmation");
  });
});

describe("canonicalizeQuestJourneyLifecycleMode", () => {
  it.each([
    ["active", "active"],
    [" proposed ", "proposed"],
  ])("normalizes %j", (input, expected) => {
    expect(canonicalizeQuestJourneyLifecycleMode(input)).toBe(expected);
  });

  it("rejects unknown lifecycle modes", () => {
    expect(canonicalizeQuestJourneyLifecycleMode("queued")).toBeNull();
  });
});

describe("Quest Journey phases", () => {
  it("represents the new durable phase library without human verification", () => {
    expect(DEFAULT_QUEST_JOURNEY_PHASE_IDS).toEqual(["alignment", "implement", "code-review", "port"]);
    expect(QUEST_JOURNEY_PHASES.map((phase) => phase.id)).toEqual([
      "alignment",
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
    expect(getQuestJourneyPhaseForState("PROPOSED")).toBeNull();
    expect(getQuestJourneyPhaseForState("PLANNING")?.id).toBe("alignment");
    expect(getQuestJourneyPhaseForState("SKEPTIC_REVIEWING")?.id).toBe("code-review");
    expect(getQuestJourneyPhase("bookkeeping")?.boardState).toBe("BOOKKEEPING");
    expect(getQuestJourneyPhase("alignment")?.nextLeaderAction).toContain("leader approval");
    expect(getQuestJourneyPhase("alignment")?.nextLeaderAction).toContain("user escalation");
    expect(normalizeQuestJourneyPlan(undefined, "PORTING")).toEqual(
      expect.objectContaining({
        mode: "active",
        phaseIds: DEFAULT_QUEST_JOURNEY_PHASE_IDS,
        activePhaseIndex: 3,
        currentPhaseId: "port",
        nextLeaderAction: expect.stringContaining("sync confirmation"),
      }),
    );
  });

  it("encodes the implement, execute, and outcome-review responsibility split", () => {
    expect(getQuestJourneyPhase("implement")).toEqual(
      expect.objectContaining({
        assigneeRole: "worker",
        contract: expect.stringContaining("cheap, local, reversible evidence"),
        nextLeaderAction: expect.stringContaining("next review, execute, or bookkeeping phase"),
      }),
    );
    expect(getQuestJourneyPhase("execute")).toEqual(
      expect.objectContaining({
        assigneeRole: "worker",
        contract: expect.stringContaining("approval-gated operations"),
        nextLeaderAction: expect.stringContaining("more execute work"),
      }),
    );
    expect(getQuestJourneyPhase("outcome-review")).toEqual(
      expect.objectContaining({
        assigneeRole: "reviewer",
        contract: expect.stringContaining("Reviewer-owned acceptance judgment"),
        nextLeaderAction: expect.stringContaining("route to implement, execute, alignment"),
      }),
    );
  });

  it("defines alignment as a lightweight read-in phase and explore as the deeper investigation phase", () => {
    expect(getQuestJourneyPhase("alignment")).toEqual(
      expect.objectContaining({
        contract: expect.stringContaining("lightweight read-in"),
        nextLeaderAction: expect.stringContaining("worker read-in"),
      }),
    );
    expect(getQuestJourneyPhase("explore")).toEqual(
      expect.objectContaining({
        contract: expect.stringContaining("major findings"),
        nextLeaderAction: expect.stringContaining("findings summary"),
      }),
    );
  });

  it("keeps custom planned phases while deriving the current phase from board state", () => {
    expect(
      normalizeQuestJourneyPlan({ presetId: "ops", phaseIds: ["planning", "explore", "execute"] }, "PLANNING"),
    ).toEqual(
      expect.objectContaining({
        presetId: "ops",
        phaseIds: ["alignment", "explore", "execute"],
        activePhaseIndex: 0,
        currentPhaseId: "alignment",
      }),
    );
  });

  it("realigns custom planned phases to an explicit reset status and refreshes the next action", () => {
    expect(
      normalizeQuestJourneyPlan(
        {
          presetId: "investigation",
          phaseIds: ["planning", "explore", "outcome-review"],
          currentPhaseId: "outcome-review",
          nextLeaderAction: "stale outcome review action",
        },
        "PLANNING",
      ),
    ).toEqual(
      expect.objectContaining({
        phaseIds: ["alignment", "explore", "outcome-review"],
        activePhaseIndex: 0,
        currentPhaseId: "alignment",
        nextLeaderAction: getQuestJourneyPhase("alignment")?.nextLeaderAction,
      }),
    );
  });

  it("clears stale current phase bookkeeping when an explicit reset moves the row back to queued", () => {
    const normalized = normalizeQuestJourneyPlan(
      {
        presetId: "investigation",
        phaseIds: ["planning", "explore", "outcome-review"],
        currentPhaseId: "outcome-review",
        nextLeaderAction: "stale outcome review action",
      },
      "QUEUED",
    );

    expect(normalized).toEqual(
      expect.objectContaining({
        mode: "active",
        phaseIds: ["alignment", "explore", "outcome-review"],
      }),
    );
    expect(normalized).not.toHaveProperty("activePhaseIndex");
    expect(normalized).not.toHaveProperty("currentPhaseId");
    expect(normalized).not.toHaveProperty("nextLeaderAction");
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
        activePhaseIndex: 0,
        currentPhaseId: "implement",
        revisionReason: "Need outcome evidence before final review",
        revisedAt: 123,
        revisionCount: 2,
      }),
    );
  });

  it("keeps repeated phases and tracks progress by active phase index", () => {
    const normalized = normalizeQuestJourneyPlan(
      {
        phaseIds: ["alignment", "implement", "code-review", "implement", "code-review", "port"],
        activePhaseIndex: 3,
        currentPhaseId: "implement",
      },
      "IMPLEMENTING",
    );

    expect(normalized).toEqual(
      expect.objectContaining({
        phaseIds: ["alignment", "implement", "code-review", "implement", "code-review", "port"],
        activePhaseIndex: 3,
        currentPhaseId: "implement",
      }),
    );
    expect(getQuestJourneyCurrentPhaseIndex(normalized, "IMPLEMENTING")).toBe(3);
    expect(getQuestJourneyCurrentPhaseId(normalized, "IMPLEMENTING")).toBe("implement");
  });

  it("does not guess the active occurrence for repeated phases without an explicit index", () => {
    const normalized = normalizeQuestJourneyPlan(
      {
        phaseIds: [
          "alignment",
          "implement",
          "mental-simulation",
          "implement",
          "mental-simulation",
          "code-review",
          "port",
        ],
        currentPhaseId: "mental-simulation",
      },
      "MENTAL_SIMULATING",
    );

    expect(normalized).toEqual(
      expect.objectContaining({
        phaseIds: [
          "alignment",
          "implement",
          "mental-simulation",
          "implement",
          "mental-simulation",
          "code-review",
          "port",
        ],
      }),
    );
    expect(normalized).not.toHaveProperty("activePhaseIndex");
    expect(normalized).not.toHaveProperty("currentPhaseId");
    expect(getQuestJourneyCurrentPhaseIndex(normalized, "MENTAL_SIMULATING")).toBeUndefined();
  });

  it("normalizes proposed Journeys without active phase semantics", () => {
    expect(
      normalizeQuestJourneyPlan(
        {
          mode: "proposed",
          phaseIds: ["alignment", "implement", "code-review", "port"],
          activePhaseIndex: 1,
          currentPhaseId: "implement",
          nextLeaderAction: "stale implement action",
        },
        "PROPOSED",
      ),
    ).toEqual(
      expect.objectContaining({
        mode: "proposed",
        phaseIds: ["alignment", "implement", "code-review", "port"],
        nextLeaderAction: QUEST_JOURNEY_HINTS.PROPOSED,
      }),
    );
  });

  it("keeps only valid in-range phase notes", () => {
    expect(
      normalizeQuestJourneyPlan({
        phaseIds: ["alignment", "implement", "code-review"],
        phaseNotes: {
          "0": "Start with exact source links",
          "2": "Inspect only the follow-up diff",
          "5": "drop this",
        },
      }),
    ).toEqual(
      expect.objectContaining({
        phaseNotes: {
          "0": "Start with exact source links",
          "2": "Inspect only the follow-up diff",
        },
      }),
    );
  });

  it("rebases phase notes by phase occurrence instead of raw index", () => {
    expect(
      rebaseQuestJourneyPhaseNotes(
        {
          "4": "Replay turns 116/120/121/122-123 before dispatching this phase",
        },
        ["alignment", "implement", "code-review", "implement", "mental-simulation", "port"],
        ["alignment", "implement", "code-review", "implement", "code-review", "mental-simulation", "port"],
      ),
    ).toEqual({
      phaseNotes: {
        "5": "Replay turns 116/120/121/122-123 before dispatching this phase",
      },
      warnings: [],
    });
  });

  it("surfaces dropped phase notes when a revised Journey removes the target occurrence", () => {
    expect(
      rebaseQuestJourneyPhaseNotes(
        {
          "4": "Replay turns 116/120/121/122-123 before dispatching this phase",
        },
        ["alignment", "implement", "code-review", "implement", "mental-simulation", "port"],
        ["alignment", "implement", "code-review", "implement", "port"],
      ),
    ).toEqual({
      warnings: [
        {
          previousIndex: 4,
          previousPhaseId: "mental-simulation",
          previousOccurrence: 1,
          note: "Replay turns 116/120/121/122-123 before dispatching this phase",
        },
      ],
    });
  });

  it("keeps notes attached to the matching repeated-phase occurrence", () => {
    expect(
      rebaseQuestJourneyPhaseNotes(
        {
          "4": "Inspect only the follow-up diff",
        },
        ["alignment", "implement", "code-review", "implement", "code-review", "port"],
        ["alignment", "implement", "code-review", "implement", "mental-simulation", "code-review", "port"],
      ),
    ).toEqual({
      phaseNotes: {
        "5": "Inspect only the follow-up diff",
      },
      warnings: [],
    });
  });
});
