import { describe, expect, it } from "vitest";
import type { QuestmasterTask } from "../server/quest-types.js";
import { formatQuestDetail, formatQuestLine, type SessionMetadata } from "./quest-format.js";

describe("quest formatting", () => {
  const sessionMetadata = new Map<string, SessionMetadata>([
    ["worker-1", { archived: false, sessionNum: 12, name: "Worker session" }],
    ["leader-1", { archived: false, sessionNum: 3, name: "Leader session" }],
  ]);

  const quest = {
    id: "q-1",
    questId: "q-1",
    version: 2,
    title: "Orchestrated quest",
    status: "in_progress",
    description: "Ready",
    createdAt: Date.now(),
    statusChangedAt: Date.now(),
    sessionId: "worker-1",
    claimedAt: Date.now(),
    leaderSessionId: "leader-1",
  } satisfies QuestmasterTask;

  it("shows the leader session in quest detail output", () => {
    const detail = formatQuestDetail(quest, sessionMetadata);

    expect(detail).toContain('Session:     #12 "Worker session"');
    expect(detail).toContain('Leader:      #3 "Leader session"');
  });

  it("shows compact leader attribution in quest list output", () => {
    const line = formatQuestLine(quest, sessionMetadata);

    expect(line).toContain('[leader:"Leader session"');
  });

  it("shows scoped phase TLDRs before unscoped feedback in quest detail output", () => {
    const detail = formatQuestDetail({
      ...quest,
      journeyRuns: [
        {
          runId: "run-1",
          source: "board",
          phaseIds: ["alignment", "implement"],
          status: "completed",
          createdAt: 1,
          updatedAt: 2,
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
          ],
        },
      ],
      feedback: [
        {
          author: "agent",
          kind: "phase_summary",
          text: "Full implementation detail that should stay behind the feedback-show drilldown.",
          tldr: "Implementation TLDR.",
          ts: Date.now(),
          journeyRunId: "run-1",
          phaseOccurrenceId: "run-1:p2",
          phaseId: "implement",
          phasePosition: 2,
        },
        { author: "human", text: "Flat follow-up stays visible.", ts: Date.now() },
      ],
    });

    expect(detail).toContain("Phase Documentation:");
    expect(detail).toContain("  Implement [phase 2]");
    expect(detail).toContain("TLDR: Implementation TLDR.");
    expect(detail).toContain("Full: quest feedback show q-1 0");
    expect(detail).toContain("Unscoped Feedback:");
    expect(detail).toContain("#1 [human");
    expect(detail).not.toContain("Full implementation detail that should stay behind");
  });
});
