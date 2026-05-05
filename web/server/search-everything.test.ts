import { describe, expect, it } from "vitest";
import {
  searchEverything,
  type SearchEverythingQuestDocument,
  type SearchEverythingSessionDocument,
} from "./search-everything.js";
import type { QuestmasterTask } from "./quest-types.js";

function quest(overrides: Partial<QuestmasterTask> & { questId: string; title: string }): QuestmasterTask {
  const { questId, title, ...rest } = overrides;
  return {
    id: `${questId}-v1`,
    questId,
    version: 1,
    title,
    status: "refined",
    description: "",
    createdAt: 100,
    statusChangedAt: 100,
    ...rest,
  } as QuestmasterTask;
}

function session(
  overrides: Partial<SearchEverythingSessionDocument> & { sessionId: string },
): SearchEverythingSessionDocument {
  const { sessionId, ...rest } = overrides;
  return {
    sessionId,
    archived: false,
    createdAt: 100,
    ...rest,
  };
}

describe("searchEverything", () => {
  it("groups multiple matching messages under one session parent", () => {
    const output = searchEverything(
      [],
      [
        session({
          sessionId: "s1",
          sessionNum: 12,
          name: "Auth worker",
          lastActivityAt: 500,
          messageHistory: [
            { type: "user_message", content: "auth token failed during login", timestamp: 100, id: "m1" },
            {
              type: "assistant",
              message: {
                id: "m2",
                role: "assistant",
                content: [{ type: "text", text: "auth middleware logs updated" }],
              },
              parent_tool_use_id: null,
              timestamp: 200,
            } as never,
            { type: "user_message", content: "auth redirect still fails", timestamp: 300, id: "m3" },
            { type: "compact_marker", summary: "auth investigation compacted", timestamp: 400, id: "m4" },
          ],
        }),
      ],
      { query: "auth", categories: ["messages"], childPreviewLimit: 3 },
    );

    expect(output.results).toHaveLength(1);
    const result = output.results[0];
    expect(result.type).toBe("session");
    expect(result.title).toContain("#12");
    expect(result.totalChildMatches).toBe(4);
    expect(result.childMatches).toHaveLength(3);
    expect(result.remainingChildMatches).toBe(1);
    expect(result.childMatches.map((match) => match.type)).toEqual(["message", "message", "message"]);
  });

  it("uses the best grouped message child as the session parent default route", () => {
    const output = searchEverything(
      [],
      [
        session({
          sessionId: "s1",
          sessionNum: 12,
          name: "Auth worker",
          messageHistory: [
            { type: "user_message", content: "needle older thread note", timestamp: 100, id: "m1", threadKey: "q-1" },
            { type: "user_message", content: "needle newest thread note", timestamp: 300, id: "m3", threadKey: "q-3" },
          ],
        }),
      ],
      { query: "needle", categories: ["messages"], childPreviewLimit: 3 },
    );

    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({
      type: "session",
      route: { kind: "message", sessionId: "s1", messageId: "m3", threadKey: "q-3" },
    });
  });

  it("groups quest feedback and debrief matches under one quest parent", () => {
    const output = searchEverything(
      [
        quest({
          questId: "q-10",
          title: "Search overlay",
          status: "done",
          completedAt: 600,
          verificationItems: [],
          debrief: "Grouped ranking shipped for alpha search.",
          feedback: [
            { author: "human", text: "Please include grouped child snippets.", ts: 300, kind: "comment" },
            {
              author: "agent",
              text: "Implemented grouped quest feedback ranking.",
              tldr: "Grouped quest feedback ranking.",
              ts: 400,
              kind: "phase_summary",
              phaseId: "implement",
            },
          ],
        } as Partial<QuestmasterTask> & { questId: string; title: string }),
      ],
      [],
      { query: "grouped", childPreviewLimit: 3 },
    );

    expect(output.results).toHaveLength(1);
    const result = output.results[0];
    expect(result.type).toBe("quest");
    expect(result.id).toBe("quest:q-10");
    expect(result.totalChildMatches).toBeGreaterThanOrEqual(3);
    expect(result.childMatches.some((match) => match.type === "quest_feedback")).toBe(true);
    expect(result.childMatches.some((match) => match.type === "quest_debrief")).toBe(true);
  });

  it("searches quest history content that is not present on the current quest record", () => {
    const current = quest({
      questId: "q-20",
      title: "Search overlay",
      version: 3,
      id: "q-20-v3",
      description: "Current implementation scope",
    });
    const doc: SearchEverythingQuestDocument = {
      quest: current,
      history: [
        quest({
          questId: "q-20",
          title: "Old route investigation",
          version: 1,
          id: "q-20-v1",
          description: "Legacy-only paprika detail lives in version history.",
        }),
        current,
      ],
    };

    const output = searchEverything([doc], [], { query: "paprika", childPreviewLimit: 3 });

    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({
      id: "quest:q-20",
      type: "quest",
      route: { kind: "quest", questId: "q-20" },
    });
    expect(output.results[0]?.childMatches).toEqual([
      expect.objectContaining({
        type: "quest_history",
        title: "History v1 description",
        snippet: "Legacy-only paprika detail lives in version history.",
      }),
    ]);
  });

  it("uses child match count to boost a parent without flooding results", () => {
    const output = searchEverything(
      [
        quest({ questId: "q-1", title: "Needle title" }),
        quest({
          questId: "q-2",
          title: "Related work",
          feedback: [
            { author: "human", text: "needle in first comment", ts: 1 },
            { author: "human", text: "needle in second comment", ts: 2 },
            { author: "agent", text: "needle in implementation note", ts: 3 },
            { author: "agent", text: "needle in verification note", ts: 4 },
          ],
        }),
      ],
      [],
      { query: "needle", childPreviewLimit: 2 },
    );

    expect(output.results.map((result) => result.id)).toEqual(["quest:q-1", "quest:q-2"]);
    const grouped = output.results[1];
    expect(grouped.totalChildMatches).toBe(4);
    expect(grouped.childMatches).toHaveLength(2);
    expect(grouped.remainingChildMatches).toBe(2);
  });

  it("honors category, archived, and reviewer filters", () => {
    const docs = [
      session({
        sessionId: "active",
        name: "Needle session",
        messageHistory: [{ type: "user_message", content: "message needle", timestamp: 10 }],
      }),
      session({
        sessionId: "archived",
        archived: true,
        name: "Needle archive",
      }),
      session({
        sessionId: "reviewer",
        reviewerOf: 3,
        name: "Needle reviewer",
      }),
    ];

    const defaultOutput = searchEverything([], docs, { query: "needle", categories: ["sessions"] });
    expect(defaultOutput.results.map((result) => result.id)).toEqual(["session:active"]);

    const withArchivedAndReviewers = searchEverything([], docs, {
      query: "needle",
      categories: ["sessions"],
      includeArchived: true,
      includeReviewers: true,
    });
    expect(withArchivedAndReviewers.results.map((result) => result.id)).toContain("session:archived");
    expect(withArchivedAndReviewers.results.map((result) => result.id)).toContain("session:reviewer");

    const messagesOnly = searchEverything([], docs, { query: "needle", categories: ["messages"] });
    expect(messagesOnly.results.map((result) => result.id)).toEqual(["session:active"]);
    expect(messagesOnly.results[0].matchedFields).toEqual(["user_message"]);
  });

  it("boosts exact IDs and the current session", () => {
    const exactQuest = quest({ questId: "q-1177", title: "Unrelated" });
    const namedQuest = quest({ questId: "q-2", title: "q-1177 follow-up note" });
    const sessions = [
      session({ sessionId: "s-old", sessionNum: 5, name: "Search overlay", lastActivityAt: 200 }),
      session({ sessionId: "s-current", sessionNum: 6, name: "Search overlay", lastActivityAt: 100 }),
    ];

    const questOutput = searchEverything([namedQuest, exactQuest], [], { query: "q-1177" });
    expect(questOutput.results[0].id).toBe("quest:q-1177");

    const sessionOutput = searchEverything([], sessions, {
      query: "search",
      categories: ["sessions"],
      currentSessionId: "s-current",
    });
    expect(sessionOutput.results[0].id).toBe("session:s-current");
  });
});
