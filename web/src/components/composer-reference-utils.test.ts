import { describe, expect, it } from "vitest";
import type { ChatMessage, QuestmasterTask } from "../types.js";
import {
  buildQuestReferenceSuggestions,
  computeRecentAutocompleteBoostsFromContents,
  selectBoundedRecentAutocompleteContents,
} from "./composer-reference-utils.js";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id ?? "m",
    role: overrides.role ?? "assistant",
    content: overrides.content ?? "",
    timestamp: overrides.timestamp ?? 0,
    ...overrides,
  };
}

function quest(questId: string, title = questId): QuestmasterTask {
  return { questId, id: `${questId}-v1`, title } as QuestmasterTask;
}

describe("composer reference utilities", () => {
  it("bounds autocomplete recency to the newest turns instead of scanning the whole session", () => {
    const messages = [
      message({ id: "u1", role: "user", content: "old q-101", timestamp: 1 }),
      message({ id: "a1", role: "assistant", content: "old q-102", timestamp: 2 }),
      message({ id: "u2", role: "user", content: "recent q-201", timestamp: 3 }),
      message({ id: "a2", role: "assistant", content: "recent q-202", timestamp: 4 }),
      message({ id: "u3", role: "user", content: "newest q-301", timestamp: 5 }),
      message({ id: "a3", role: "assistant", content: "newest q-302", timestamp: 6 }),
    ];

    const contents = selectBoundedRecentAutocompleteContents(messages, { maxRecentTurns: 2 });
    const boosts = computeRecentAutocompleteBoostsFromContents(contents);

    expect(boosts.questBoosts.has("q-101")).toBe(false);
    expect(boosts.questBoosts.has("q-102")).toBe(false);
    expect(boosts.questBoosts.has("q-201")).toBe(true);
    expect(boosts.questBoosts.has("q-301")).toBe(true);
  });

  it("uses the current thread when selecting recent autocomplete context", () => {
    const messages = [
      message({ id: "m1", content: "main q-101", timestamp: 1 }),
      message({
        id: "m2",
        content: "quest thread q-909",
        timestamp: 2,
        metadata: { threadRefs: [{ threadKey: "q-909", questId: "q-909", source: "explicit" }] },
      }),
      message({ id: "m3", content: "main q-202", timestamp: 3 }),
    ];

    expect(selectBoundedRecentAutocompleteContents(messages, { threadKey: "main" }).join("\n")).toContain("q-202");
    expect(selectBoundedRecentAutocompleteContents(messages, { threadKey: "main" }).join("\n")).not.toContain("q-909");
    expect(selectBoundedRecentAutocompleteContents(messages, { threadKey: "q-909" })).toEqual(["quest thread q-909"]);
  });

  it("keeps quest suggestions limited while preserving exact, recent, and numeric ordering", () => {
    const quests = [quest("q-9"), quest("q-10"), quest("q-11"), quest("q-12"), quest("q-13")];
    const recentBoosts = new Map([
      ["q-9", 20],
      ["q-11", 10],
    ]);

    const broad = buildQuestReferenceSuggestions(quests, "", recentBoosts, 3);
    expect(broad.suggestions.map((suggestion) => suggestion.rawRef)).toEqual(["q-9", "q-11", "q-13"]);
    expect(broad.scannedQuestCount).toBe(5);
    expect(broad.candidateCount).toBe(5);

    const exact = buildQuestReferenceSuggestions(quests, "10", recentBoosts, 3);
    expect(exact.suggestions.map((suggestion) => suggestion.rawRef)).toEqual(["q-10"]);
    expect(exact.candidateCount).toBe(1);
  });
});
