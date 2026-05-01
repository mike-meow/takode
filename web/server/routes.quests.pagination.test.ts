import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuestRoutes } from "./routes/quests.js";
import * as questStore from "./quest-store.js";
import type { QuestmasterTask, QuestStatus } from "./quest-types.js";

function makeQuest(input: {
  questId: string;
  title: string;
  status?: QuestStatus;
  createdAt?: number;
  updatedAt?: number;
  tags?: string[];
  description?: string;
  feedbackText?: string;
}): QuestmasterTask {
  return {
    id: input.questId,
    questId: input.questId,
    version: 1,
    title: input.title,
    status: input.status ?? "idea",
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt,
    description: input.description ?? "",
    tags: input.tags,
    ...(input.feedbackText
      ? {
          feedback: [
            {
              author: "human",
              text: input.feedbackText,
              ts: 2,
              addressed: false,
            },
          ],
        }
      : {}),
  } as QuestmasterTask;
}

function makeApp(quests: QuestmasterTask[]) {
  vi.spyOn(questStore, "listQuests").mockResolvedValue(quests);
  const app = new Hono();
  app.route(
    "/api",
    createQuestRoutes({
      launcher: {
        getSession: vi.fn(() => null),
        listSessions: vi.fn(() => []),
      } as any,
      wsBridge: {
        getSession: vi.fn(() => null),
        broadcastToSession: vi.fn(),
        persistSessionById: vi.fn(),
      } as any,
      imageStore: undefined,
      authenticateCompanionCallerOptional: vi.fn(() => null),
      execCaptureStdoutAsync: vi.fn(),
    } as any),
  );
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/quests/_page", () => {
  it("returns a bounded page with global counts and tag metadata", async () => {
    const app = makeApp([
      makeQuest({ questId: "q-1", title: "Active", status: "in_progress", updatedAt: 100, tags: ["work"] }),
      makeQuest({ questId: "q-2", title: "Done old", status: "done", updatedAt: 10, tags: ["archive"] }),
      makeQuest({ questId: "q-3", title: "Done new", status: "done", updatedAt: 90, tags: ["work"] }),
    ]);

    const res = await app.request("/api/quests/_page?limit=2&offset=0");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      quests: [{ questId: "q-1" }, { questId: "q-3" }],
      total: 3,
      offset: 0,
      limit: 2,
      hasMore: true,
      nextOffset: 2,
      previousOffset: null,
      counts: { all: 3, in_progress: 1, done: 2, idea: 0, refined: 0 },
      allTags: ["archive", "work"],
    });
  });

  it("applies backend text search, tag filters, status filters, and pagination", async () => {
    const app = makeApp([
      makeQuest({ questId: "q-1", title: "Match title", status: "idea", tags: ["ui"] }),
      makeQuest({ questId: "q-2", title: "Other", status: "done", tags: ["ui"], feedbackText: "match feedback" }),
      makeQuest({ questId: "q-3", title: "Match excluded", status: "idea", tags: ["skip"] }),
      makeQuest({ questId: "q-4", title: "Match excluded with included tag", status: "idea", tags: ["ui", "skip"] }),
    ]);

    const res = await app.request("/api/quests/_page?text=match&tags=ui&excludeTags=skip&status=idea,done&limit=10");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      quests: [{ questId: "q-1" }, { questId: "q-2" }],
      total: 2,
      counts: { all: 2, idea: 1, done: 1, refined: 0, in_progress: 0 },
    });
  });

  it("supports compact sort columns before slicing the page", async () => {
    const app = makeApp([
      makeQuest({ questId: "q-2", title: "Bravo", status: "done", updatedAt: 30 }),
      makeQuest({ questId: "q-1", title: "Alpha", status: "idea", updatedAt: 10 }),
      makeQuest({ questId: "q-3", title: "Charlie", status: "refined", updatedAt: 20 }),
    ]);

    const res = await app.request("/api/quests/_page?sortColumn=title&sortDirection=asc&limit=2");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      quests: [{ questId: "q-1" }, { questId: "q-2" }],
      total: 3,
      nextOffset: 2,
    });
  });
});
