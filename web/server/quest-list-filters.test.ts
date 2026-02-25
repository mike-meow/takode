import { describe, it, expect } from "vitest";
import { applyQuestListFilters } from "./quest-list-filters.js";
import type { QuestmasterTask } from "./quest-types.js";

function makeQuest(input: Partial<QuestmasterTask> & { questId: string; title: string; status: QuestmasterTask["status"] }): QuestmasterTask {
  return {
    id: `${input.questId}-v1`,
    questId: input.questId,
    version: 1,
    title: input.title,
    createdAt: 1,
    status: input.status,
    description: "desc",
    ...(input.tags ? { tags: input.tags } : {}),
    ...("sessionId" in input ? { sessionId: (input as { sessionId?: string }).sessionId, claimedAt: 1 } : {}),
  } as QuestmasterTask;
}

describe("applyQuestListFilters", () => {
  const quests: QuestmasterTask[] = [
    makeQuest({ questId: "q-1", title: "Fix chat lag", status: "in_progress", tags: ["ui", "bugfix"], sessionId: "s1" }),
    makeQuest({ questId: "q-2", title: "Improve quest CLI", status: "idea", tags: ["questmaster", "feature"] }),
    makeQuest({ questId: "q-3", title: "Done performance cleanup", status: "done", tags: ["performance"], sessionId: "s2" }),
  ];

  it("filters by multiple statuses from comma-separated input", () => {
    // Supports common shell-friendly usage like --status "idea,in_progress".
    const result = applyQuestListFilters(quests, { status: "idea,in_progress" });
    expect(result.map((q) => q.questId)).toEqual(["q-1", "q-2"]);
  });

  it("filters by tags (case-insensitive, any tag match)", () => {
    // Tag filter should match if at least one requested tag is present.
    const result = applyQuestListFilters(quests, { tags: "PERFORMANCE,missing" });
    expect(result.map((q) => q.questId)).toEqual(["q-3"]);
  });

  it("filters by owning session ID", () => {
    // Session filter is useful for quickly narrowing to claimed work.
    const result = applyQuestListFilters(quests, { session: "s1" });
    expect(result.map((q) => q.questId)).toEqual(["q-1"]);
  });

  it("filters by free-text search in title and description", () => {
    // Text search should be case-insensitive and include title/description.
    const result = applyQuestListFilters(quests, { text: "cli" });
    expect(result.map((q) => q.questId)).toEqual(["q-2"]);
  });

  it("combines multiple filters with AND semantics", () => {
    // Combined filters should allow precise narrowing without a custom DSL.
    const result = applyQuestListFilters(quests, {
      status: "done,in_progress",
      tags: "performance,bugfix",
      session: "s2",
    });
    expect(result.map((q) => q.questId)).toEqual(["q-3"]);
  });
});

