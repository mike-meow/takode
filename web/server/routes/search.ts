import { Hono } from "hono";
import * as questStore from "../quest-store.js";
import * as sessionNames from "../session-names.js";
import {
  searchEverything,
  type SearchEverythingCategory,
  type SearchEverythingQuestDocument,
  type SearchEverythingSessionDocument,
} from "../search-everything.js";
import type { RouteContext } from "./context.js";

const ALL_CATEGORIES: SearchEverythingCategory[] = ["quests", "sessions", "messages"];
const CATEGORY_SET = new Set<SearchEverythingCategory>(ALL_CATEGORIES);

export function createSearchRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, wsBridge } = ctx;

  api.get("/search", async (c) => {
    const rawQuery = (c.req.query("q") || "").trim();
    if (!rawQuery) {
      return c.json({ error: "q is required" }, 400);
    }

    const startedAt = Date.now();
    const categories = parseCategories(c.req.query("types"));
    const limit = parseIntParam(c.req.query("limit"), 30, 1, 100);
    const childPreviewLimit = parseIntParam(c.req.query("childPreviewLimit"), 3, 1, 8);
    const messageLimitPerSession = parseIntParam(c.req.query("messageLimitPerSession"), 400, 50, 2000);
    const includeArchived = parseAffirmativeBoolean(c.req.query("includeArchived"));
    const includeReviewers = parseAffirmativeBoolean(c.req.query("includeReviewers"));
    const currentSessionId = normalizeNullableString(c.req.query("currentSessionId"));

    const questDocumentsPromise = categories.includes("quests") ? buildQuestDocuments() : Promise.resolve([]);
    const [quests, sessionDocs] = await Promise.all([questDocumentsPromise, buildSessionDocuments()]);
    const output = searchEverything(quests, sessionDocs, {
      query: rawQuery,
      categories,
      currentSessionId,
      includeArchived,
      includeReviewers,
      limit,
      childPreviewLimit,
      messageLimitPerSession,
    });

    return c.json({
      ...output,
      tookMs: Date.now() - startedAt,
    });
  });

  return api;

  async function buildQuestDocuments(): Promise<SearchEverythingQuestDocument[]> {
    const quests = await questStore.listQuests();
    return Promise.all(
      quests.map(async (quest) => {
        const historyView = await questStore.getQuestHistoryView(quest.questId);
        return {
          quest,
          history: historyView.entries,
        };
      }),
    );
  }

  async function buildSessionDocuments(): Promise<SearchEverythingSessionDocument[]> {
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    return sessions.map((session) => {
      const bridgeSession = wsBridge.getSession(session.sessionId);
      const bridge = bridgeSession?.state;
      return {
        sessionId: session.sessionId,
        sessionNum: launcher.getSessionNum(session.sessionId) ?? null,
        archived: !!session.archived,
        reviewerOf: session.reviewerOf,
        createdAt: session.createdAt || 0,
        lastActivityAt: session.lastActivityAt,
        name: names[session.sessionId] ?? session.name ?? "",
        taskHistory: bridgeSession?.taskHistory ?? [],
        keywords: bridgeSession?.keywords ?? [],
        gitBranch: bridge?.git_branch || "",
        cwd: bridge?.cwd || session.cwd || "",
        repoRoot: bridge?.repo_root || session.repoRoot || "",
        messageHistory: bridgeSession?.messageHistory || [],
        searchExcerpts: bridgeSession?.searchExcerpts ?? [],
      };
    });
  }
}

function parseCategories(rawValue: string | undefined): SearchEverythingCategory[] {
  if (!rawValue) return ALL_CATEGORIES;
  const parsed = rawValue
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is SearchEverythingCategory => CATEGORY_SET.has(part as SearchEverythingCategory));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : ALL_CATEGORIES;
}

function parseIntParam(rawValue: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(rawValue || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseAffirmativeBoolean(rawValue: string | undefined): boolean {
  if (rawValue === undefined) return false;
  return ["1", "true", "yes"].includes(rawValue.toLowerCase());
}

function normalizeNullableString(rawValue: string | undefined): string | null {
  const trimmed = rawValue?.trim();
  return trimmed ? trimmed : null;
}
