import { describe, expect, it } from "vitest";
import { resolveQuestFeedbackDocumentation } from "./quest-phase-docs.js";
import type { QuestmasterTask } from "./quest-types.js";

function quest(overrides: Partial<QuestmasterTask> = {}): QuestmasterTask {
  return {
    id: "q-1",
    questId: "q-1",
    version: 1,
    title: "Phase docs",
    createdAt: 1,
    status: "in_progress",
    description: "Ready",
    sessionId: "worker-1",
    claimedAt: 2,
    leaderSessionId: "leader-1",
    ...overrides,
  } as QuestmasterTask;
}

describe("quest phase documentation resolution", () => {
  it("creates a durable board-backed run snapshot for inferred current phase documentation", () => {
    // Inferred phase docs should attach to the leader's active board row, not to
    // the worker's local board, and should create stable run/occurrence ids.
    const result = resolveQuestFeedbackDocumentation({
      quest: quest(),
      authorSessionId: "worker-1",
      request: {},
      now: 100,
      boardRows: [
        {
          leaderSessionId: "leader-1",
          row: {
            questId: "q-1",
            worker: "worker-1",
            workerNum: 42,
            status: "IMPLEMENTING",
            createdAt: 10,
            updatedAt: 90,
            journey: {
              phaseIds: ["alignment", "explore", "implement", "code-review"],
              activePhaseIndex: 2,
              currentPhaseId: "implement",
            },
          },
        },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.entryPatch).toMatchObject({
      kind: "phase_summary",
      journeyRunId: "board-leader-1-10",
      phaseOccurrenceId: "board-leader-1-10:p3",
      phaseId: "implement",
      phaseIndex: 2,
      phasePosition: 3,
      phaseOccurrence: 1,
    });
    expect(result.journeyRuns?.[0]).toMatchObject({
      runId: "board-leader-1-10",
      source: "board",
      phaseIds: ["alignment", "explore", "implement", "code-review"],
    });
  });

  it("rejects explicit scoped writes when a repeated phase is ambiguous", () => {
    // Repeated phase IDs need a stable occurrence position so documentation
    // does not accidentally attach to the wrong implementation/review cycle.
    const result = resolveQuestFeedbackDocumentation({
      quest: quest(),
      authorSessionId: "worker-1",
      request: { phase: "implement" },
      boardRows: [
        {
          leaderSessionId: "leader-1",
          row: {
            questId: "q-1",
            status: "IMPLEMENTING",
            createdAt: 10,
            updatedAt: 90,
            journey: {
              phaseIds: ["alignment", "implement", "code-review", "implement"],
              currentPhaseId: "implement",
            },
          },
        },
      ],
    });

    expect(result.error).toContain("current phase occurrence");
  });

  it("attaches repeated phase documentation by explicit occurrence", () => {
    // A repeated phase can be selected by occurrence count even when the active
    // board position points at a different occurrence of the same phase.
    const result = resolveQuestFeedbackDocumentation({
      quest: quest(),
      authorSessionId: "worker-1",
      request: { phase: "implement", phaseOccurrence: 2 },
      now: 100,
      boardRows: [
        {
          leaderSessionId: "leader-1",
          row: {
            questId: "q-1",
            status: "IMPLEMENTING",
            createdAt: 10,
            updatedAt: 90,
            journey: {
              phaseIds: ["alignment", "implement", "code-review", "implement"],
              activePhaseIndex: 1,
              currentPhaseId: "implement",
            },
          },
        },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.entryPatch).toMatchObject({
      journeyRunId: "board-leader-1-10",
      phaseOccurrenceId: "board-leader-1-10:p4",
      phaseId: "implement",
      phaseIndex: 3,
      phasePosition: 4,
      phaseOccurrence: 2,
    });
  });

  it("falls back to flat feedback with a warning when active board rows conflict", () => {
    // Inference is intentionally non-blocking for legacy feedback, but an
    // ambiguous active board must not silently choose the wrong phase scope.
    const result = resolveQuestFeedbackDocumentation({
      quest: quest({ leaderSessionId: undefined }),
      authorSessionId: "worker-1",
      request: {},
      boardRows: [
        {
          leaderSessionId: "leader-1",
          row: { questId: "q-1", status: "IMPLEMENTING", createdAt: 10, updatedAt: 90 },
        },
        {
          leaderSessionId: "leader-2",
          row: { questId: "q-1", status: "CODE_REVIEWING", createdAt: 20, updatedAt: 95 },
        },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.entryPatch).toEqual({});
    expect(result.warning).toContain("Multiple active leader board rows");
  });

  it("falls back to flat feedback with a warning when inference has no board row", () => {
    // Legacy flat feedback stays valid when no Journey context is available.
    const result = resolveQuestFeedbackDocumentation({
      quest: quest(),
      authorSessionId: "worker-1",
      request: {},
      boardRows: [],
    });

    expect(result.error).toBeUndefined();
    expect(result.entryPatch).toEqual({});
    expect(result.warning).toContain("No active leader board row");
  });
});
