import type { BrowserIncomingMessage, SessionTaskEntry } from "./session-types.js";

export type SessionSearchMatchedField =
  | "name"
  | "task"
  | "keyword"
  | "branch"
  | "path"
  | "repo"
  | "user_message";

export interface SessionSearchDocument {
  sessionId: string;
  archived: boolean;
  createdAt: number;
  lastActivityAt?: number;
  name?: string;
  taskHistory?: SessionTaskEntry[];
  keywords?: string[];
  gitBranch?: string;
  cwd?: string;
  repoRoot?: string;
  messageHistory?: BrowserIncomingMessage[] | null;
}

export interface SessionSearchResult {
  sessionId: string;
  score: number;
  matchedField: SessionSearchMatchedField;
  matchContext: string | null;
  matchedAt: number;
  messageMatch?: {
    id?: string;
    timestamp: number;
    snippet: string;
  };
}

export interface SearchSessionDocumentsOptions {
  query: string;
  limit?: number;
  includeArchived?: boolean;
  messageLimitPerSession?: number;
}

export interface SearchSessionDocumentsOutput {
  totalMatches: number;
  results: SessionSearchResult[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildSnippet(content: string, q: string, maxLen = 120): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;

  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text.slice(0, maxLen).trimEnd();

  const contextRadius = Math.floor((maxLen - q.length) / 2);
  const start = Math.max(0, idx - contextRadius);
  const end = Math.min(text.length, start + maxLen);
  return text.slice(start, end).trim();
}

function compareCandidates(a: SessionSearchResult, b: SessionSearchResult): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.matchedAt !== b.matchedAt) return b.matchedAt - a.matchedAt;
  return a.sessionId.localeCompare(b.sessionId);
}

function pushIfBetter(
  current: SessionSearchResult | null,
  next: SessionSearchResult,
): SessionSearchResult {
  if (!current) return next;
  return compareCandidates(current, next) <= 0 ? current : next;
}

function messageMatchCandidate(
  doc: SessionSearchDocument,
  q: string,
  maxMessagesToScan: number,
): SessionSearchResult | null {
  const history = doc.messageHistory;
  if (!history || history.length === 0) return null;

  let scanned = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (scanned >= maxMessagesToScan) break;
    scanned++;
    const msg = history[i];
    if (msg.type !== "user_message") continue;
    const content = (msg.content || "").trim();
    if (!content) continue;
    if (!content.toLowerCase().includes(q)) continue;

    const timestamp = typeof msg.timestamp === "number"
      ? msg.timestamp
      : (doc.lastActivityAt ?? doc.createdAt);

    return {
      sessionId: doc.sessionId,
      score: 500,
      matchedField: "user_message",
      matchContext: `message: ${buildSnippet(content, q)}`,
      matchedAt: timestamp,
      messageMatch: {
        id: msg.id,
        timestamp,
        snippet: buildSnippet(content, q),
      },
    };
  }
  return null;
}

export function searchSessionDocuments(
  docs: SessionSearchDocument[],
  options: SearchSessionDocumentsOptions,
): SearchSessionDocumentsOutput {
  const q = normalize(options.query);
  if (!q) return { totalMatches: 0, results: [] };

  const includeArchived = options.includeArchived !== false;
  const limit = clampInt(Math.floor(options.limit ?? 50), 1, 200);
  const messageLimitPerSession = clampInt(
    Math.floor(options.messageLimitPerSession ?? 400),
    50,
    2000,
  );

  const matches: SessionSearchResult[] = [];

  for (const doc of docs) {
    if (!includeArchived && doc.archived) continue;

    const recencyTs = doc.lastActivityAt ?? doc.createdAt ?? 0;
    let best: SessionSearchResult | null = null;

    const name = (doc.name || "").trim();
    if (name && name.toLowerCase().includes(q)) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 1000,
        matchedField: "name",
        matchContext: null,
        matchedAt: recencyTs,
      });
    }

    const task = (doc.taskHistory || []).find((t) => t.title.toLowerCase().includes(q));
    if (task) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 920,
        matchedField: "task",
        matchContext: `task: ${task.title}`,
        matchedAt: task.timestamp || recencyTs,
      });
    }

    const kw = (doc.keywords || []).find((k) => k.toLowerCase().includes(q));
    if (kw) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 880,
        matchedField: "keyword",
        matchContext: `keyword: ${kw}`,
        matchedAt: recencyTs,
      });
    }

    const branch = (doc.gitBranch || "").trim();
    if (branch && branch.toLowerCase().includes(q)) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 840,
        matchedField: "branch",
        matchContext: `branch: ${branch}`,
        matchedAt: recencyTs,
      });
    }

    const cwd = (doc.cwd || "").trim();
    if (cwd && cwd.toLowerCase().includes(q)) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 810,
        matchedField: "path",
        matchContext: `path: ${cwd}`,
        matchedAt: recencyTs,
      });
    }

    const repoRoot = (doc.repoRoot || "").trim();
    if (repoRoot && repoRoot.toLowerCase().includes(q)) {
      best = pushIfBetter(best, {
        sessionId: doc.sessionId,
        score: 800,
        matchedField: "repo",
        matchContext: `repo: ${repoRoot}`,
        matchedAt: recencyTs,
      });
    }

    const msgCandidate = messageMatchCandidate(doc, q, messageLimitPerSession);
    if (msgCandidate) {
      best = pushIfBetter(best, msgCandidate);
    }

    if (best) matches.push(best);
  }

  matches.sort(compareCandidates);
  return {
    totalMatches: matches.length,
    results: matches.slice(0, limit),
  };
}
