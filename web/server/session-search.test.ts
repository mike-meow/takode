import { describe, expect, it } from "vitest";
import { searchSessionDocuments, type SessionSearchDocument } from "./session-search.js";

describe("searchSessionDocuments", () => {
  it("ranks metadata matches above user-message matches", () => {
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-name",
        archived: false,
        createdAt: 100,
        name: "Refactor auth middleware",
      },
      {
        sessionId: "s-message",
        archived: false,
        createdAt: 200,
        messageHistory: [{ type: "user_message", content: "Please refactor auth middleware flow", timestamp: 2000 }],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "auth" });
    expect(out.totalMatches).toBe(2);
    expect(out.results[0]).toMatchObject({
      sessionId: "s-name",
      matchedField: "name",
    });
    expect(out.results[1]).toMatchObject({
      sessionId: "s-message",
      matchedField: "user_message",
    });
  });

  it("uses recency tie-breaker for same match category", () => {
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "older",
        archived: false,
        createdAt: 10,
        lastActivityAt: 100,
        name: "Fix search ranking",
      },
      {
        sessionId: "newer",
        archived: false,
        createdAt: 10,
        lastActivityAt: 500,
        name: "Fix search ranking",
      },
    ];

    const out = searchSessionDocuments(docs, { query: "search" });
    expect(out.results.map((r) => r.sessionId)).toEqual(["newer", "older"]);
  });

  it("includes archived sessions by default and supports excluding them", () => {
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "archived",
        archived: true,
        createdAt: 1,
        messageHistory: [{ type: "user_message", content: "needle in archive", timestamp: 1 }],
      },
      {
        sessionId: "active",
        archived: false,
        createdAt: 2,
        messageHistory: [{ type: "user_message", content: "needle in active", timestamp: 2 }],
      },
    ];

    const defaultOut = searchSessionDocuments(docs, { query: "needle" });
    expect(defaultOut.results.map((r) => r.sessionId)).toEqual(["active", "archived"]);

    const activeOnly = searchSessionDocuments(docs, {
      query: "needle",
      includeArchived: false,
    });
    expect(activeOnly.results.map((r) => r.sessionId)).toEqual(["active"]);
  });

  it("excludes reviewer sessions by default and can explicitly include them", () => {
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "worker",
        archived: false,
        createdAt: 1,
        name: "Needle worker",
      },
      {
        sessionId: "reviewer",
        archived: false,
        reviewerOf: 7,
        createdAt: 2,
        name: "Needle reviewer",
      },
    ];

    // Reviewer sessions are valuable historical records, but they are noisy in
    // normal global search results unless the caller asks for them.
    const defaultOut = searchSessionDocuments(docs, { query: "needle" });
    expect(defaultOut.results.map((r) => r.sessionId)).toEqual(["worker"]);

    const withReviewers = searchSessionDocuments(docs, {
      query: "needle",
      includeReviewers: true,
    });
    expect(withReviewers.results.map((r) => r.sessionId)).toEqual(["reviewer", "worker"]);
  });

  it("matches CamelCase tokens in session names", () => {
    // "plan mode" should match "ExitPlanMode" via CamelCase boundary splitting
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-camel",
        archived: false,
        createdAt: 100,
        name: "ExitPlanMode feature",
      },
      {
        sessionId: "s-plain",
        archived: false,
        createdAt: 100,
        name: "exit plan mode feature",
      },
    ];

    const out = searchSessionDocuments(docs, { query: "plan mode" });
    expect(out.totalMatches).toBe(2);
    expect(out.results.map((r) => r.sessionId)).toContain("s-camel");
    expect(out.results.map((r) => r.sessionId)).toContain("s-plain");
  });

  it("matches CamelCase tokens in task titles", () => {
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-task",
        archived: false,
        createdAt: 100,
        taskHistory: [
          { title: "Implement BoardTable component", action: "new" as const, timestamp: 100, triggerMessageId: "m1" },
        ],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "board table" });
    expect(out.totalMatches).toBe(1);
  });

  it("matches compact_marker content when searching for compaction", () => {
    // Session with a compaction event in its history
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-compacted",
        archived: false,
        createdAt: 100,
        messageHistory: [
          { type: "user_message", content: "start task", timestamp: 1000, id: "m1" },
          { type: "compact_marker", summary: "Context compacted to 4%", timestamp: 2000, id: "compact-2000" },
          { type: "user_message", content: "continue work", timestamp: 3000, id: "m2" },
        ],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "compacted" });
    expect(out.totalMatches).toBe(1);
    expect(out.results[0]).toMatchObject({
      sessionId: "s-compacted",
      matchedField: "compact_marker",
    });
    expect(out.results[0].matchContext).toContain("compaction:");
  });

  it("scores compact_marker matches below user_message matches", () => {
    // Two sessions: one with compaction match, one with user message match
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-compact",
        archived: false,
        createdAt: 100,
        messageHistory: [{ type: "compact_marker", summary: "Context compacted", timestamp: 1000, id: "c1" }],
      },
      {
        sessionId: "s-user",
        archived: false,
        createdAt: 200,
        messageHistory: [{ type: "user_message", content: "context compacted review", timestamp: 2000, id: "m1" }],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "compacted" });
    expect(out.totalMatches).toBe(2);
    // user_message (score 500) should rank above compact_marker (score 450)
    expect(out.results[0].matchedField).toBe("user_message");
    expect(out.results[1].matchedField).toBe("compact_marker");
  });

  it("matches multi-word queries with non-consecutive words", () => {
    // "run dev" should match a session named "Run current-main dev-server E2E sanity"
    // even though "run" and "dev" aren't adjacent
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-match",
        archived: false,
        createdAt: 100,
        name: "Run current-main dev-server E2E sanity before prod restart",
      },
      {
        sessionId: "s-nomatch",
        archived: false,
        createdAt: 200,
        name: "Deploy production hotfix",
      },
    ];

    const out = searchSessionDocuments(docs, { query: "run dev" });
    expect(out.totalMatches).toBe(1);
    expect(out.results[0].sessionId).toBe("s-match");
  });

  it("searches archived sessions via searchExcerpts when messageHistory is empty", () => {
    // Simulates search-data-only archived session: no messageHistory, only excerpts
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-archived",
        archived: true,
        createdAt: 100,
        messageHistory: [],
        searchExcerpts: [
          { type: "user_message", content: "deploy the new auth service", timestamp: 1000 },
          { type: "compact_marker", content: "Session discussed auth deployment strategy", timestamp: 2000 },
        ],
      },
      {
        sessionId: "s-active",
        archived: false,
        createdAt: 200,
        messageHistory: [{ type: "user_message", content: "deploy the new auth service", timestamp: 3000 }],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "auth" });
    expect(out.totalMatches).toBe(2);
    const ids = out.results.map((r) => r.sessionId);
    expect(ids).toContain("s-archived");
    expect(ids).toContain("s-active");
  });

  it("prefers messageHistory over searchExcerpts when both are present", () => {
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-both",
        archived: false,
        createdAt: 100,
        messageHistory: [{ type: "user_message", content: "real message about deploy", timestamp: 5000 }],
        searchExcerpts: [{ type: "user_message", content: "excerpt about deploy", timestamp: 1000 }],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "deploy" });
    expect(out.totalMatches).toBe(1);
    // Should use messageHistory match (timestamp 5000), not excerpt
    expect(out.results[0].messageMatch?.timestamp).toBe(5000);
  });

  it("returns no message match when archived session has no excerpts and no history", () => {
    // Pre-existing archived session without backfilled excerpts
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-old-archived",
        archived: true,
        createdAt: 50,
        name: "old session about deploy",
        messageHistory: [],
        searchExcerpts: [],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "deploy" });
    expect(out.totalMatches).toBe(1);
    // Should match on name, not message
    expect(out.results[0].matchedField).toBe("name");
  });

  it("searches assistant text responses in full history", () => {
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-assistant",
        archived: false,
        createdAt: 100,
        messageHistory: [
          {
            type: "assistant",
            message: {
              id: "a1",
              role: "assistant",
              type: "message",
              model: "test",
              content: [{ type: "text", text: "The fibonacci sequence implementation looks correct" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
            parent_tool_use_id: null,
            timestamp: 2000,
          },
        ],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "fibonacci" });
    expect(out.totalMatches).toBe(1);
    expect(out.results[0].matchedField).toBe("assistant");
    expect(out.results[0].messageMatch?.snippet).toContain("fibonacci");
  });

  it("searches assistant text via excerpts for search-data-only sessions", () => {
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-archived-assistant",
        archived: true,
        createdAt: 100,
        messageHistory: [],
        searchExcerpts: [
          {
            type: "assistant",
            content: "The fibonacci sequence implementation looks correct",
            timestamp: 2000,
            id: "a1",
          },
          { type: "user_message", content: "check the algorithm", timestamp: 1000, id: "m1" },
        ],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "fibonacci" });
    expect(out.totalMatches).toBe(1);
    expect(out.results[0].matchedField).toBe("assistant");
  });

  it("ranks user_message above assistant above compact_marker", () => {
    const docs: SessionSearchDocument[] = [
      {
        sessionId: "s-user",
        archived: false,
        createdAt: 100,
        messageHistory: [{ type: "user_message", content: "query about deploy", timestamp: 1000 }],
      },
      {
        sessionId: "s-assistant",
        archived: false,
        createdAt: 100,
        messageHistory: [
          {
            type: "assistant",
            message: {
              id: "a1",
              role: "assistant",
              type: "message",
              model: "test",
              content: [{ type: "text", text: "deploy completed successfully" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
            parent_tool_use_id: null,
            timestamp: 1000,
          },
        ],
      },
      {
        sessionId: "s-compact",
        archived: false,
        createdAt: 100,
        messageHistory: [{ type: "compact_marker", summary: "discussed deploy strategy", timestamp: 1000 }],
      },
    ];

    const out = searchSessionDocuments(docs, { query: "deploy" });
    expect(out.totalMatches).toBe(3);
    expect(out.results[0].matchedField).toBe("user_message");
    expect(out.results[1].matchedField).toBe("assistant");
    expect(out.results[2].matchedField).toBe("compact_marker");
  });
});
