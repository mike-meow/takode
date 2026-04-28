import { describe, expect, it } from "vitest";
import { grepQuests } from "./quest-grep.js";
import type { QuestmasterTask } from "./quest-types.js";

describe("grepQuests", () => {
  it("searches title, description, and feedback with explicit match locations", () => {
    const quests: QuestmasterTask[] = [
      {
        id: "q-1-v1",
        questId: "q-1",
        version: 1,
        title: "Beta title match",
        createdAt: 1,
        status: "refined",
        description: "Alpha project summary",
      },
      {
        id: "q-2-v2",
        questId: "q-2",
        version: 2,
        title: "Quest with long description",
        createdAt: 2,
        status: "in_progress",
        description:
          "This description includes the beta keyword in the middle so the snippet builder has to include context.",
        sessionId: "session-2",
        claimedAt: 2,
      },
      {
        id: "q-3-v3",
        questId: "q-3",
        version: 3,
        title: "Feedback quest",
        createdAt: 3,
        status: "done",
        description: "Needs review",
        sessionId: "session-3",
        claimedAt: 3,
        completedAt: 4,
        verificationItems: [{ text: "Visual pass", checked: false }],
        verificationInboxUnread: true,
        feedback: [
          { author: "human", text: "Please verify the beta warning copy inside the modal.", ts: 3 },
          { author: "agent", text: "Summary: updated wording", ts: 4 },
        ],
      },
    ];

    const result = grepQuests(quests, "beta");

    expect(result.totalMatches).toBe(3);
    expect(result.matches.map((match) => match.matchedField)).toEqual(["title", "description", "feedback[0]"]);
    expect(result.matches[0]).toMatchObject({ questId: "q-1", matchedField: "title" });
    expect(result.matches[1].snippet.toLowerCase()).toContain("beta");
    expect(result.matches[2]).toMatchObject({
      questId: "q-3",
      matchedField: "feedback[0]",
      feedbackIndex: 0,
      feedbackAuthor: "human",
    });
    expect(result.matches[2]).not.toHaveProperty("feedbackTs");
  });

  it("fails fast when the regex pattern is invalid", () => {
    const quests: QuestmasterTask[] = [
      {
        id: "q-9-v1",
        questId: "q-9",
        version: 1,
        title: "Literal bracket search",
        createdAt: 9,
        status: "refined",
        description: "Search for foo[bar in literal mode.",
      },
    ];

    expect(() => grepQuests(quests, "foo[bar")).toThrow('Invalid regex pattern "foo[bar"');
  });

  it("caps returned matches while preserving the full match count", () => {
    const quests: QuestmasterTask[] = [
      {
        id: "q-1-v1",
        questId: "q-1",
        version: 1,
        title: "Alpha one",
        createdAt: 1,
        status: "refined",
        description: "alpha desc",
      },
      {
        id: "q-2-v1",
        questId: "q-2",
        version: 1,
        title: "Alpha two",
        createdAt: 2,
        status: "refined",
        description: "alpha again",
      },
    ];

    const result = grepQuests(quests, "alpha", { limit: 2 });

    // Limiting the response must not hide the fact that more total matches exist.
    expect(result.totalMatches).toBe(4);
    expect(result.matches).toHaveLength(2);
  });

  it("prefers TLDR snippets when TLDR metadata matches", () => {
    const quests: QuestmasterTask[] = [
      {
        id: "q-1-v1",
        questId: "q-1",
        version: 1,
        title: "Long content",
        createdAt: 1,
        status: "refined",
        description: "The full description also mentions alpha but should not be the preview source.",
        tldr: "Alpha summary for humans.",
        feedback: [
          {
            author: "agent",
            text: "The detailed feedback also mentions beta in a much longer agent-dense note.",
            tldr: "Beta feedback summary.",
            ts: 1,
          },
        ],
      },
    ];

    const result = grepQuests(quests, "alpha|beta");

    expect(result.matches.map((match) => match.matchedField)).toEqual(["description.tldr", "feedback[0].tldr"]);
    expect(result.matches[0].snippet).toBe("Alpha summary for humans.");
    expect(result.matches[1].snippet).toBe("Beta feedback summary.");
  });
});
