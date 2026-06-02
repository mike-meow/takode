import type { Hono } from "hono";
import type { CliLauncher } from "../cli-launcher.js";
import * as sessionNames from "../session-names.js";
import { searchSessionDocuments, type SessionSearchDocument } from "../session-search.js";
import type { WsBridge } from "../ws-bridge.js";
import { buildLeaderActivePhaseSummaryForSnapshot } from "./session-list-snapshot.js";

export interface SessionSearchRouteDeps {
  launcher: CliLauncher;
  wsBridge: WsBridge;
}

export function parseIncludeArchived(rawValue: string | undefined): boolean {
  if (rawValue === undefined) return true;
  return !["0", "false", "no"].includes(rawValue.trim().toLowerCase());
}

export function registerSessionSearchRoute(api: Hono, deps: SessionSearchRouteDeps): void {
  const { launcher, wsBridge } = deps;
  api.get("/sessions/search", (c) => {
    const rawQuery = (c.req.query("q") || "").trim();
    if (!rawQuery) {
      return c.json({ error: "q is required" }, 400);
    }

    const limitParam = Number.parseInt(c.req.query("limit") || "50", 10);
    const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 200)) : 50;

    const msgLimitParam = Number.parseInt(c.req.query("messageLimitPerSession") || "400", 10);
    const messageLimitPerSession = Number.isFinite(msgLimitParam) ? Math.max(50, Math.min(msgLimitParam, 2000)) : 400;
    const includeArchived = parseIncludeArchived(c.req.query("includeArchived"));
    const includeReviewers = parseAffirmativeBoolean(c.req.query("includeReviewers"));
    const leaderOnly = parseAffirmativeBoolean(c.req.query("leaderOnly"));

    const startedAt = Date.now();
    const sessions = launcher.listSessions();
    const names = sessionNames.getAllNames();
    const docs: SessionSearchDocument[] = sessions.flatMap((s) => {
      const bridgeSession = wsBridge.getSession(s.sessionId);
      const bridge = bridgeSession?.state;
      if (s.hidden === true || bridge?.hidden === true || bridge?.slackThreadChild) return [];
      return [
        {
          sessionId: s.sessionId,
          sessionNum: launcher.getSessionNum(s.sessionId) ?? null,
          state: s.state,
          model: bridge?.model || s.model,
          backendType: s.backendType,
          archived: !!s.archived,
          archivedAt: s.archivedAt,
          isOrchestrator: s.isOrchestrator === true || bridge?.isOrchestrator === true,
          reviewerOf: s.reviewerOf,
          createdAt: s.createdAt || 0,
          lastActivityAt: s.lastActivityAt,
          lastUserMessageAt: s.lastUserMessageAt,
          name: names[s.sessionId] ?? s.name ?? "",
          taskHistory: bridgeSession?.taskHistory ?? [],
          keywords: bridgeSession?.keywords ?? [],
          gitBranch: bridge?.git_branch || "",
          cwd: bridge?.cwd || s.cwd || "",
          repoRoot: bridge?.repo_root || s.repoRoot || "",
          leaderActivePhaseSummary: buildLeaderActivePhaseSummaryForSnapshot(
            s.isOrchestrator === true || bridge?.isOrchestrator === true,
            bridgeSession,
          ),
          messageHistory: bridgeSession?.messageHistory || [],
          searchExcerpts: bridgeSession?.searchExcerpts ?? [],
        },
      ];
    });

    const { results, totalMatches } = searchSessionDocuments(docs, {
      query: rawQuery,
      limit,
      includeArchived,
      includeReviewers,
      leaderOnly,
      messageLimitPerSession,
    });

    return c.json({
      query: rawQuery,
      tookMs: Date.now() - startedAt,
      totalMatches,
      results,
    });
  });
}

function parseAffirmativeBoolean(rawValue: string | undefined): boolean {
  if (rawValue === undefined) return false;
  return ["1", "true", "yes"].includes(rawValue.toLowerCase());
}
