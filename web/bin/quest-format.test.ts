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
});
