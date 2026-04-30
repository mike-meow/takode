import { describe, expect, it } from "vitest";
import { summarizeQuestPhaseDocumentation } from "./quest-phase-documentation-summary.js";
import type { QuestJourneyRun, QuestmasterTask } from "../server/quest-types.js";

const baseQuest = {
  id: "q-1-v1",
  questId: "q-1",
  version: 1,
  title: "Document phases",
  createdAt: 1,
  status: "refined",
  description: "Make phase documentation easy to scan.",
} satisfies QuestmasterTask;

function run(overrides: Partial<QuestJourneyRun> = {}): QuestJourneyRun {
  return {
    runId: "run-1",
    source: "board",
    phaseIds: ["alignment", "implement", "code-review", "implement"],
    status: "completed",
    createdAt: 10,
    updatedAt: 20,
    phaseOccurrences: [
      {
        occurrenceId: "run-1:p1",
        phaseId: "alignment",
        phaseIndex: 0,
        phasePosition: 1,
        phaseOccurrence: 1,
        status: "completed",
      },
      {
        occurrenceId: "run-1:p2",
        phaseId: "implement",
        phaseIndex: 1,
        phasePosition: 2,
        phaseOccurrence: 1,
        status: "completed",
      },
      {
        occurrenceId: "run-1:p3",
        phaseId: "code-review",
        phaseIndex: 2,
        phasePosition: 3,
        phaseOccurrence: 1,
        status: "completed",
      },
      {
        occurrenceId: "run-1:p4",
        phaseId: "implement",
        phaseIndex: 3,
        phasePosition: 4,
        phaseOccurrence: 2,
        status: "completed",
      },
    ],
    ...overrides,
  };
}

describe("summarizeQuestPhaseDocumentation", () => {
  it("preserves legacy flat feedback as unscoped feedback", () => {
    const summary = summarizeQuestPhaseDocumentation({
      ...baseQuest,
      feedback: [{ author: "agent", text: "Explore findings without phase metadata.", ts: 30 }],
    });

    expect(summary.hasJourneyRuns).toBe(false);
    expect(summary.hasPhaseDocumentation).toBe(false);
    expect(summary.groups).toHaveLength(0);
    expect(summary.unscopedFeedback).toHaveLength(1);
    expect(summary.unscopedFeedback[0]).toMatchObject({ index: 0, text: "Explore findings without phase metadata." });
  });

  it("groups scoped documentation by durable phase occurrence and preserves TLDR plus full detail", () => {
    const summary = summarizeQuestPhaseDocumentation({
      ...baseQuest,
      tldr: "Quest scan summary.",
      journeyRuns: [run()],
      feedback: [
        {
          author: "agent",
          kind: "phase_summary",
          text: "Full implementation detail.",
          tldr: "Implementation TLDR.",
          ts: 30,
          phaseOccurrenceId: "run-1:p2",
          journeyRunId: "run-1",
          phaseId: "implement",
          phasePosition: 2,
          phaseOccurrence: 1,
        },
      ],
    });

    const implementGroup = summary.groups.find((group) => group.phaseOccurrenceId === "run-1:p2");
    expect(summary.questTldr).toBe("Quest scan summary.");
    expect(summary.hasPhaseDocumentation).toBe(true);
    expect(implementGroup).toMatchObject({
      displayLabel: "Implement",
      metaLabel: "phase 2",
      scopeMatched: true,
    });
    expect(implementGroup?.entries[0]).toMatchObject({
      index: 0,
      tldr: "Implementation TLDR.",
      text: "Full implementation detail.",
    });
  });

  it("labels repeated phases distinctly", () => {
    const summary = summarizeQuestPhaseDocumentation({
      ...baseQuest,
      journeyRuns: [run()],
      feedback: [
        {
          author: "agent",
          text: "Second implementation pass.",
          tldr: "Second implement TLDR.",
          ts: 30,
          journeyRunId: "run-1",
          phaseId: "implement",
          phasePosition: 4,
          phaseOccurrence: 2,
        },
      ],
    });

    const repeatedGroup = summary.groups.find((group) => group.phasePosition === 4);
    expect(repeatedGroup).toMatchObject({
      displayLabel: "Implement #2",
      phaseOccurrence: 2,
      phaseOccurrenceId: "run-1:p4",
    });
    expect(repeatedGroup?.entries).toHaveLength(1);
  });

  it("keeps stale or ambiguous scoped entries visible without attaching them to a run occurrence", () => {
    const summary = summarizeQuestPhaseDocumentation({
      ...baseQuest,
      journeyRuns: [run()],
      feedback: [
        {
          author: "agent",
          text: "Could belong to either implement occurrence.",
          tldr: "Ambiguous implement TLDR.",
          ts: 30,
          phaseId: "implement",
        },
        {
          author: "agent",
          text: "References a removed occurrence.",
          tldr: "Stale occurrence TLDR.",
          ts: 40,
          phaseOccurrenceId: "run-1:p99",
          journeyRunId: "run-1",
          phaseId: "code-review",
          phasePosition: 99,
        },
      ],
    });

    const unmatchedGroups = summary.groups.filter((group) => !group.scopeMatched);
    expect(unmatchedGroups).toHaveLength(2);
    expect(unmatchedGroups.map((group) => group.displayLabel)).toEqual(
      expect.arrayContaining(["Implement", "Code Review"]),
    );
    expect(unmatchedGroups.map((group) => group.metaLabel)).toEqual(
      expect.arrayContaining(["scope unmatched", "phase 99 / scope unmatched"]),
    );
  });
});
