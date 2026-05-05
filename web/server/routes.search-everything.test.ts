import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createSearchRoutes } from "./routes/search.js";
import type { RouteContext } from "./routes/context.js";
import type { SearchEverythingResult } from "./search-everything.js";
import type { QuestmasterTask } from "./quest-types.js";

const mocks = vi.hoisted(() => ({
  listQuests: vi.fn(),
  getQuestHistoryView: vi.fn(),
  getAllNames: vi.fn(),
}));

vi.mock("./quest-store.js", () => ({
  listQuests: () => mocks.listQuests(),
  getQuestHistoryView: (questId: string) => mocks.getQuestHistoryView(questId),
}));

vi.mock("./session-names.js", () => ({
  getAllNames: () => mocks.getAllNames(),
}));

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

function createApp({
  sessions,
  bridgeSessions,
}: {
  sessions: Array<Record<string, unknown>>;
  bridgeSessions: Record<string, Record<string, unknown>>;
}) {
  const app = new Hono();
  const ctx = {
    launcher: {
      listSessions: () => sessions,
      getSessionNum: (sessionId: string) => (sessionId === "s1" ? 12 : sessionId === "archived" ? 21 : null),
    },
    wsBridge: {
      getSession: (sessionId: string) => bridgeSessions[sessionId] ?? null,
    },
  } as unknown as RouteContext;

  app.route("/api", createSearchRoutes(ctx));
  return app;
}

describe("GET /api/search", () => {
  beforeEach(() => {
    mocks.listQuests.mockReset();
    mocks.getQuestHistoryView.mockReset();
    mocks.getQuestHistoryView.mockResolvedValue({ mode: "live", entries: [] });
    mocks.getAllNames.mockReset();
    mocks.getAllNames.mockReturnValue({});
  });

  it("returns a 400 response when the query is missing", async () => {
    const app = createApp({ sessions: [], bridgeSessions: {} });
    mocks.listQuests.mockResolvedValue([]);

    const res = await app.request("/api/search", { method: "GET" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "q is required" });
  });

  it("aggregates quests, sessions, and active cross-session message evidence through the route", async () => {
    mocks.listQuests.mockResolvedValue([
      quest({
        questId: "q-1",
        title: "Search command palette",
        feedback: [{ author: "human", text: "Include auth child snippets in grouped results.", ts: 300 }],
      }),
    ]);
    mocks.getAllNames.mockReturnValue({ s1: "Auth worker" });

    const app = createApp({
      sessions: [
        {
          sessionId: "s1",
          archived: false,
          createdAt: 100,
          lastActivityAt: 500,
          cwd: "/repo",
          repoRoot: "/repo",
        },
      ],
      bridgeSessions: {
        s1: {
          state: { git_branch: "main", cwd: "/repo", repo_root: "/repo" },
          messageHistory: [{ type: "user_message", id: "m1", content: "auth token failed in login", timestamp: 400 }],
        },
      },
    });

    const res = await app.request("/api/search?q=auth&currentSessionId=s1", { method: "GET" });
    const body = (await res.json()) as { results: SearchEverythingResult[] };

    expect(res.status).toBe(200);
    const sessionResult = body.results.find((result) => result.id === "session:s1");
    expect(sessionResult).toBeTruthy();
    expect(sessionResult?.meta).toMatchObject({ sessionId: "s1", sessionNum: 12, cwd: "/repo", gitBranch: "main" });
    expect(sessionResult?.childMatches.some((match) => match.snippet.includes("auth token failed"))).toBe(true);

    const questResult = body.results.find((result) => result.id === "quest:q-1");
    expect(questResult?.childMatches.some((match) => match.type === "quest_feedback")).toBe(true);
  });

  it("searches quest history versions through the route", async () => {
    mocks.listQuests.mockResolvedValue([
      quest({
        questId: "q-3",
        title: "Current quest title",
        version: 3,
        id: "q-3-v3",
        description: "Current text has no legacy marker.",
      }),
    ]);
    mocks.getQuestHistoryView.mockResolvedValue({
      mode: "live",
      entries: [
        quest({
          questId: "q-3",
          title: "First version",
          version: 1,
          id: "q-3-v1",
          description: "Version history contains turmeric-only evidence.",
        }),
        quest({
          questId: "q-3",
          title: "Current quest title",
          version: 3,
          id: "q-3-v3",
          description: "Current text has no legacy marker.",
        }),
      ],
    });

    const app = createApp({ sessions: [], bridgeSessions: {} });
    const res = await app.request("/api/search?q=turmeric", { method: "GET" });
    const body = (await res.json()) as { results: SearchEverythingResult[] };

    expect(res.status).toBe(200);
    expect(mocks.getQuestHistoryView).toHaveBeenCalledWith("q-3");
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ id: "quest:q-3", route: { kind: "quest", questId: "q-3" } });
    expect(body.results[0]?.childMatches).toEqual([
      expect.objectContaining({
        type: "quest_history",
        snippet: "Version history contains turmeric-only evidence.",
      }),
    ]);
  });

  it("applies category, archived-session, and child preview route parameters", async () => {
    mocks.listQuests.mockResolvedValue([quest({ questId: "q-2", title: "Archived session evidence" })]);

    const app = createApp({
      sessions: [
        {
          sessionId: "archived",
          archived: true,
          createdAt: 100,
          lastActivityAt: 600,
          cwd: "/repo",
          repoRoot: "/repo",
          name: "Archived worker",
        },
      ],
      bridgeSessions: {
        archived: {
          state: { git_branch: "main", cwd: "/repo", repo_root: "/repo" },
          messageHistory: [
            { type: "user_message", id: "m1", content: "archived auth trace one", timestamp: 400 },
            { type: "user_message", id: "m2", content: "archived auth trace two", timestamp: 500 },
          ],
        },
      },
    });

    const defaultRes = await app.request("/api/search?q=archived&types=messages", { method: "GET" });
    const defaultBody = (await defaultRes.json()) as { results: SearchEverythingResult[] };
    expect(defaultBody.results).toHaveLength(0);

    const includeArchivedRes = await app.request(
      "/api/search?q=archived&types=messages&includeArchived=true&childPreviewLimit=1",
      { method: "GET" },
    );
    const includeArchivedBody = (await includeArchivedRes.json()) as { results: SearchEverythingResult[] };

    expect(includeArchivedBody.results).toHaveLength(1);
    expect(includeArchivedBody.results[0]?.id).toBe("session:archived");
    expect(includeArchivedBody.results[0]?.childMatches).toHaveLength(1);
    expect(includeArchivedBody.results[0]?.remainingChildMatches).toBe(1);
  });
});
