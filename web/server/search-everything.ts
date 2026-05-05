import type { BrowserIncomingMessage, SessionTaskEntry } from "./session-types.js";
import type { SearchExcerpt } from "./session-store.js";
import type { QuestFeedbackEntry, QuestmasterTask } from "./quest-types.js";
import { normalizeForSearch } from "../shared/search-utils.js";

export type SearchEverythingCategory = "quests" | "sessions" | "messages";

export type SearchEverythingResultType = "quest" | "session";

export type SearchEverythingChildType =
  | "quest_field"
  | "quest_feedback"
  | "quest_debrief"
  | "quest_history"
  | "session_field"
  | "message";

export type SearchEverythingRoute =
  | { kind: "quest"; questId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "message"; sessionId: string; messageId?: string; timestamp?: number; threadKey?: string };

export interface SearchEverythingChildMatch {
  id: string;
  type: SearchEverythingChildType;
  title: string;
  snippet: string;
  matchedField: string;
  score: number;
  timestamp?: number;
  route?: SearchEverythingRoute;
}

export interface SearchEverythingResult {
  id: string;
  type: SearchEverythingResultType;
  title: string;
  subtitle?: string;
  score: number;
  matchedFields: string[];
  childMatches: SearchEverythingChildMatch[];
  totalChildMatches: number;
  remainingChildMatches: number;
  route: SearchEverythingRoute;
  meta: {
    questId?: string;
    status?: string;
    sessionId?: string;
    sessionNum?: number | null;
    archived?: boolean;
    reviewerOf?: number;
    lastActivityAt?: number;
    createdAt?: number;
    cwd?: string;
    gitBranch?: string;
    repoRoot?: string;
  };
}

export interface SearchEverythingSessionDocument {
  sessionId: string;
  sessionNum?: number | null;
  archived: boolean;
  reviewerOf?: number;
  createdAt: number;
  lastActivityAt?: number;
  name?: string;
  taskHistory?: SessionTaskEntry[];
  keywords?: string[];
  gitBranch?: string;
  cwd?: string;
  repoRoot?: string;
  messageHistory?: BrowserIncomingMessage[] | null;
  searchExcerpts?: SearchExcerpt[];
}

export interface SearchEverythingQuestDocument {
  quest: QuestmasterTask;
  history?: QuestmasterTask[];
}

export type SearchEverythingQuestInput = QuestmasterTask | SearchEverythingQuestDocument;

export interface SearchEverythingOptions {
  query: string;
  categories?: SearchEverythingCategory[];
  currentSessionId?: string | null;
  includeArchived?: boolean;
  includeReviewers?: boolean;
  limit?: number;
  childPreviewLimit?: number;
  messageLimitPerSession?: number;
}

export interface SearchEverythingOutput {
  query: string;
  totalMatches: number;
  results: SearchEverythingResult[];
}

interface QueryMatcher {
  raw: string;
  normalized: string;
  words: string[];
  matches: (text: string | undefined | null) => boolean;
}

interface CandidateChildMatch extends SearchEverythingChildMatch {
  parentScore: number;
}

const DEFAULT_CATEGORIES: SearchEverythingCategory[] = ["quests", "sessions", "messages"];
const QUEST_RESULT_CAP = 30;
const SESSION_RESULT_CAP = 30;

export function searchEverything(
  quests: SearchEverythingQuestInput[],
  sessions: SearchEverythingSessionDocument[],
  options: SearchEverythingOptions,
): SearchEverythingOutput {
  const matcher = buildQueryMatcher(options.query);
  if (!matcher) {
    return { query: options.query.trim(), totalMatches: 0, results: [] };
  }

  const categories = new Set(
    options.categories && options.categories.length > 0 ? options.categories : DEFAULT_CATEGORIES,
  );
  const includeArchived = options.includeArchived === true;
  const includeReviewers = options.includeReviewers === true;
  const childPreviewLimit = clampInt(Math.floor(options.childPreviewLimit ?? 3), 1, 8);
  const messageLimitPerSession = clampInt(Math.floor(options.messageLimitPerSession ?? 400), 50, 2000);
  const limit = clampInt(Math.floor(options.limit ?? 30), 1, 100);

  const results: SearchEverythingResult[] = [];
  if (categories.has("quests")) {
    results.push(...searchQuestParents(quests, matcher, childPreviewLimit).slice(0, QUEST_RESULT_CAP));
  }
  if (categories.has("sessions") || categories.has("messages")) {
    results.push(
      ...searchSessionParents(sessions, matcher, {
        includeMetadata: categories.has("sessions"),
        includeMessages: categories.has("messages"),
        includeArchived,
        includeReviewers,
        childPreviewLimit,
        messageLimitPerSession,
        currentSessionId: options.currentSessionId ?? null,
      }).slice(0, SESSION_RESULT_CAP),
    );
  }

  results.sort(compareResults);
  return {
    query: matcher.raw,
    totalMatches: results.length,
    results: results.slice(0, limit),
  };
}

function searchQuestParents(
  quests: SearchEverythingQuestInput[],
  matcher: QueryMatcher,
  childPreviewLimit: number,
): SearchEverythingResult[] {
  const results: SearchEverythingResult[] = [];
  for (const questInput of quests) {
    const questDocument = normalizeQuestInput(questInput);
    const quest = questDocument.quest;
    const children = collectQuestMatches(questDocument, matcher);
    if (children.length === 0) continue;

    results.push(
      buildParentResult({
        id: `quest:${quest.questId}`,
        type: "quest",
        title: `${quest.questId} ${quest.title}`,
        subtitle: quest.status,
        route: { kind: "quest", questId: quest.questId },
        children,
        childPreviewLimit,
        recencyTs: questRecencyTs(quest),
        meta: {
          questId: quest.questId,
          status: quest.status,
          createdAt: quest.createdAt,
          lastActivityAt: questRecencyTs(quest),
        },
      }),
    );
  }
  results.sort(compareResults);
  return results;
}

function searchSessionParents(
  sessions: SearchEverythingSessionDocument[],
  matcher: QueryMatcher,
  options: {
    includeMetadata: boolean;
    includeMessages: boolean;
    includeArchived: boolean;
    includeReviewers: boolean;
    childPreviewLimit: number;
    messageLimitPerSession: number;
    currentSessionId: string | null;
  },
): SearchEverythingResult[] {
  const results: SearchEverythingResult[] = [];
  for (const session of sessions) {
    if (!options.includeArchived && session.archived) continue;
    if (!options.includeReviewers && session.reviewerOf !== undefined) continue;

    const children: CandidateChildMatch[] = [];
    if (options.includeMetadata) {
      children.push(...collectSessionMetadataMatches(session, matcher));
    }
    if (options.includeMessages) {
      children.push(...collectSessionMessageMatches(session, matcher, options.messageLimitPerSession));
    }
    if (children.length === 0) continue;

    const recencyTs = session.lastActivityAt ?? session.createdAt ?? 0;
    const currentBoost = options.currentSessionId === session.sessionId ? 90 : 0;
    results.push(
      buildParentResult({
        id: `session:${session.sessionId}`,
        type: "session",
        title: formatSessionTitle(session),
        subtitle: formatSessionSubtitle(session),
        route: { kind: "session", sessionId: session.sessionId },
        children,
        childPreviewLimit: options.childPreviewLimit,
        recencyTs,
        extraScore: currentBoost,
        meta: {
          sessionId: session.sessionId,
          sessionNum: session.sessionNum ?? null,
          archived: session.archived,
          reviewerOf: session.reviewerOf,
          lastActivityAt: session.lastActivityAt,
          createdAt: session.createdAt,
          cwd: session.cwd,
          gitBranch: session.gitBranch,
          repoRoot: session.repoRoot,
        },
      }),
    );
  }
  results.sort(compareResults);
  return results;
}

function buildParentResult(input: {
  id: string;
  type: SearchEverythingResultType;
  title: string;
  subtitle?: string;
  route: SearchEverythingRoute;
  children: CandidateChildMatch[];
  childPreviewLimit: number;
  recencyTs: number;
  extraScore?: number;
  meta: SearchEverythingResult["meta"];
}): SearchEverythingResult {
  const sortedChildren = [...input.children].sort(compareChildren);
  const score = parentScore(sortedChildren, input.recencyTs, input.extraScore ?? 0);
  const childMatches = sortedChildren
    .slice(0, input.childPreviewLimit)
    .map(({ parentScore: _parentScore, ...child }) => child);
  const matchedFields = Array.from(new Set(sortedChildren.map((child) => child.matchedField)));
  return {
    id: input.id,
    type: input.type,
    title: input.title,
    subtitle: input.subtitle,
    score,
    matchedFields,
    childMatches,
    totalChildMatches: sortedChildren.length,
    remainingChildMatches: Math.max(0, sortedChildren.length - childMatches.length),
    route: chooseParentRoute(input.type, input.route, sortedChildren),
    meta: input.meta,
  };
}

function chooseParentRoute(
  type: SearchEverythingResultType,
  parentRoute: SearchEverythingRoute,
  sortedChildren: CandidateChildMatch[],
): SearchEverythingRoute {
  if (type !== "session") return parentRoute;
  const childRoute = sortedChildren.find((child) => child.type === "message" && child.route?.kind === "message")?.route;
  return childRoute ?? parentRoute;
}

function normalizeQuestInput(input: SearchEverythingQuestInput): SearchEverythingQuestDocument {
  if ("quest" in input) return input;
  return { quest: input };
}

function collectQuestMatches(document: SearchEverythingQuestDocument, matcher: QueryMatcher): CandidateChildMatch[] {
  const quest = document.quest;
  const matches: CandidateChildMatch[] = [];
  const addField = (
    field: string,
    title: string,
    text: string | undefined,
    parentScore: number,
    type: SearchEverythingChildType,
  ) => {
    if (!matcher.matches(text)) return;
    matches.push({
      id: `quest:${quest.questId}:${field}`,
      type,
      title,
      snippet: buildSnippet(text ?? "", matcher.words),
      matchedField: field,
      score: parentScore,
      parentScore,
      timestamp: questRecencyTs(quest),
      route: { kind: "quest", questId: quest.questId },
    });
  };

  addField("quest_id", "Quest ID", quest.questId, exactQuestIdScore(quest.questId, matcher.raw), "quest_field");
  addField("title", "Title", quest.title, 1100, "quest_field");
  addField("tldr", "TLDR", quest.tldr, 900, "quest_field");
  addField("description", "Description", "description" in quest ? quest.description : undefined, 760, "quest_field");
  addField("relationships", "Relationships", questRelationshipSearchText(quest), 730, "quest_field");
  if (quest.status === "done" && quest.cancelled !== true) {
    addField("debrief_tldr", "Debrief TLDR", quest.debriefTldr, 710, "quest_debrief");
    addField("debrief", "Debrief", quest.debrief, 680, "quest_debrief");
  }

  for (const [index, entry] of (quest.feedback ?? []).entries()) {
    const title = formatQuestFeedbackTitle(entry, index);
    addField(`feedback_${index}_tldr`, `${title} TLDR`, entry.tldr, 640, "quest_feedback");
    addField(`feedback_${index}_text`, title, entry.text, 590, "quest_feedback");
    const metadata = [entry.kind, entry.phaseId, entry.author].filter(Boolean).join(" ");
    addField(`feedback_${index}_metadata`, `${title} metadata`, metadata, 540, "quest_feedback");
  }

  const history = dedupeQuestHistory(quest, document.history ?? []);
  for (const [index, version] of history.entries()) {
    const title = formatQuestHistoryTitle(version);
    addHistoricalQuestField(quest, version, matcher, matches, {
      field: `history_${index}_title`,
      title: `${title} title`,
      text: version.title,
      parentScore: 690,
    });
    addHistoricalQuestField(quest, version, matcher, matches, {
      field: `history_${index}_tldr`,
      title: `${title} TLDR`,
      text: version.tldr,
      parentScore: 650,
    });
    addHistoricalQuestField(quest, version, matcher, matches, {
      field: `history_${index}_description`,
      title: `${title} description`,
      text: "description" in version ? version.description : undefined,
      parentScore: 620,
    });
    addHistoricalQuestField(quest, version, matcher, matches, {
      field: `history_${index}_status`,
      title: `${title} status`,
      text: version.status,
      parentScore: 560,
    });
    if (version.status === "done" && version.cancelled !== true) {
      addHistoricalQuestField(quest, version, matcher, matches, {
        field: `history_${index}_debrief_tldr`,
        title: `${title} debrief TLDR`,
        text: version.debriefTldr,
        parentScore: 600,
      });
      addHistoricalQuestField(quest, version, matcher, matches, {
        field: `history_${index}_debrief`,
        title: `${title} debrief`,
        text: version.debrief,
        parentScore: 580,
      });
    }
    for (const [feedbackIndex, entry] of (version.feedback ?? []).entries()) {
      const feedbackTitle = `${title} ${formatQuestFeedbackTitle(entry, feedbackIndex)}`;
      addHistoricalQuestField(quest, version, matcher, matches, {
        field: `history_${index}_feedback_${feedbackIndex}_tldr`,
        title: `${feedbackTitle} TLDR`,
        text: entry.tldr,
        parentScore: 570,
      });
      addHistoricalQuestField(quest, version, matcher, matches, {
        field: `history_${index}_feedback_${feedbackIndex}_text`,
        title: feedbackTitle,
        text: entry.text,
        parentScore: 550,
      });
      const metadata = [entry.kind, entry.phaseId, entry.author].filter(Boolean).join(" ");
      addHistoricalQuestField(quest, version, matcher, matches, {
        field: `history_${index}_feedback_${feedbackIndex}_metadata`,
        title: `${feedbackTitle} metadata`,
        text: metadata,
        parentScore: 520,
      });
    }
  }
  return matches;
}

function dedupeQuestHistory(currentQuest: QuestmasterTask, history: QuestmasterTask[]): QuestmasterTask[] {
  const currentVersionKey = `${currentQuest.id}:${currentQuest.version}`;
  return history.filter((entry) => {
    if (entry.questId !== currentQuest.questId) return false;
    if (`${entry.id}:${entry.version}` === currentVersionKey) return false;
    return !(entry.id === currentQuest.id || entry.version === currentQuest.version);
  });
}

function addHistoricalQuestField(
  currentQuest: QuestmasterTask,
  version: QuestmasterTask,
  matcher: QueryMatcher,
  matches: CandidateChildMatch[],
  input: {
    field: string;
    title: string;
    text: string | undefined;
    parentScore: number;
  },
) {
  if (!matcher.matches(input.text)) return;
  matches.push({
    id: `quest:${currentQuest.questId}:${input.field}`,
    type: "quest_history",
    title: input.title,
    snippet: buildSnippet(input.text ?? "", matcher.words),
    matchedField: input.field,
    score: input.parentScore,
    parentScore: input.parentScore,
    timestamp: questRecencyTs(version),
    route: { kind: "quest", questId: currentQuest.questId },
  });
}

function collectSessionMetadataMatches(
  session: SearchEverythingSessionDocument,
  matcher: QueryMatcher,
): CandidateChildMatch[] {
  const matches: CandidateChildMatch[] = [];
  const addField = (
    field: string,
    title: string,
    text: string | undefined,
    parentScore: number,
    timestamp?: number,
  ) => {
    if (!matcher.matches(text)) return;
    matches.push({
      id: `session:${session.sessionId}:${field}`,
      type: "session_field",
      title,
      snippet: buildSnippet(text ?? "", matcher.words),
      matchedField: field,
      score: parentScore,
      parentScore,
      timestamp: timestamp ?? session.lastActivityAt ?? session.createdAt,
      route: { kind: "session", sessionId: session.sessionId },
    });
  };

  const sessionNumText = session.sessionNum == null ? undefined : `#${session.sessionNum}`;
  addField(
    "session_number",
    "Session number",
    sessionNumText,
    exactSessionNumberScore(session.sessionNum, matcher.raw),
  );
  addField("name", "Session name", session.name, 1060);
  for (const [index, task] of (session.taskHistory ?? []).entries()) {
    addField(`task_${index}`, "Task", task.title, 940, task.timestamp);
  }
  for (const [index, keyword] of (session.keywords ?? []).entries()) {
    addField(`keyword_${index}`, "Keyword", keyword, 890);
  }
  addField("branch", "Branch", session.gitBranch, 800);
  addField("cwd", "Directory", session.cwd, 770);
  addField("repo", "Repository", session.repoRoot, 760);
  return matches;
}

function collectSessionMessageMatches(
  session: SearchEverythingSessionDocument,
  matcher: QueryMatcher,
  messageLimitPerSession: number,
): CandidateChildMatch[] {
  const history = session.messageHistory;
  if ((!history || history.length === 0) && session.searchExcerpts && session.searchExcerpts.length > 0) {
    return collectSessionExcerptMatches(session, matcher, messageLimitPerSession);
  }
  if (!history || history.length === 0) return [];

  const matches: CandidateChildMatch[] = [];
  let scanned = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    if (scanned >= messageLimitPerSession) break;
    scanned++;
    const msg = history[index];
    const candidate = messageTextCandidate(session, msg, matcher);
    if (candidate) matches.push(candidate);
  }
  return matches;
}

function collectSessionExcerptMatches(
  session: SearchEverythingSessionDocument,
  matcher: QueryMatcher,
  messageLimitPerSession: number,
): CandidateChildMatch[] {
  const matches: CandidateChildMatch[] = [];
  const excerpts = session.searchExcerpts ?? [];
  let scanned = 0;
  for (let index = excerpts.length - 1; index >= 0; index--) {
    if (scanned >= messageLimitPerSession) break;
    scanned++;
    const excerpt = excerpts[index];
    if (!matcher.matches(excerpt.content)) continue;
    const timestamp = excerpt.timestamp || session.lastActivityAt || session.createdAt;
    const field =
      excerpt.type === "user_message" ? "user_message" : excerpt.type === "assistant" ? "assistant" : "compact_marker";
    const title =
      excerpt.type === "user_message" ? "Message" : excerpt.type === "assistant" ? "Assistant" : "Compaction";
    matches.push({
      id: `message:${session.sessionId}:${excerpt.id ?? `excerpt-${index}`}`,
      type: "message",
      title,
      snippet: buildSnippet(excerpt.content, matcher.words),
      matchedField: field,
      score: messageScore(field),
      parentScore: messageScore(field),
      timestamp,
      route: { kind: "message", sessionId: session.sessionId, messageId: excerpt.id, timestamp },
    });
  }
  return matches;
}

function messageTextCandidate(
  session: SearchEverythingSessionDocument,
  msg: BrowserIncomingMessage,
  matcher: QueryMatcher,
): CandidateChildMatch | null {
  if (msg.type === "user_message" || msg.type === "leader_user_message") {
    return buildMessageCandidate(
      session,
      msg.content,
      matcher,
      "user_message",
      "Message",
      msg.timestamp,
      msg.id,
      msg.threadKey,
    );
  }
  if (msg.type === "assistant") {
    const text = extractAssistantText(msg);
    return buildMessageCandidate(session, text, matcher, "assistant", "Assistant", msg.timestamp, msg.message?.id);
  }
  if (msg.type === "compact_marker") {
    return buildMessageCandidate(
      session,
      msg.summary ?? "[Context compacted]",
      matcher,
      "compact_marker",
      "Compaction",
      msg.timestamp,
      msg.id,
    );
  }
  return null;
}

function buildMessageCandidate(
  session: SearchEverythingSessionDocument,
  text: string,
  matcher: QueryMatcher,
  field: "user_message" | "assistant" | "compact_marker",
  title: string,
  timestamp?: number,
  messageId?: string,
  threadKey?: string,
): CandidateChildMatch | null {
  if (!matcher.matches(text)) return null;
  const matchedAt = timestamp ?? session.lastActivityAt ?? session.createdAt;
  const score = messageScore(field);
  return {
    id: `message:${session.sessionId}:${messageId ?? matchedAt}`,
    type: "message",
    title,
    snippet: buildSnippet(text, matcher.words),
    matchedField: field,
    score,
    parentScore: score,
    timestamp: matchedAt,
    route: { kind: "message", sessionId: session.sessionId, messageId, timestamp: matchedAt, threadKey },
  };
}

function buildQueryMatcher(query: string): QueryMatcher | null {
  const raw = query.trim();
  const normalized = normalizeForSearch(raw);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return {
    raw,
    normalized,
    words,
    matches: (text) => {
      if (!text) return false;
      const haystack = normalizeForSearch(text);
      return words.every((word) => haystack.includes(word));
    },
  };
}

function buildSnippet(content: string, qWords: string[], maxLen = 150): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;

  const lower = text.toLowerCase();
  let idx = -1;
  let matchLen = 1;
  for (const word of qWords) {
    const i = lower.indexOf(word);
    if (i >= 0) {
      idx = i;
      matchLen = word.length;
      break;
    }
  }
  if (idx < 0) return `${text.slice(0, maxLen).trimEnd()}...`;

  const contextRadius = Math.floor((maxLen - matchLen) / 2);
  const start = Math.max(0, idx - contextRadius);
  const end = Math.min(text.length, start + maxLen);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function extractAssistantText(msg: Extract<BrowserIncomingMessage, { type: "assistant" }>): string {
  const blocks = msg.message?.content;
  if (!Array.isArray(blocks)) return "";
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join(" ").trim();
}

function parentScore(children: CandidateChildMatch[], recencyTs: number, extraScore: number): number {
  const best = children[0]?.parentScore ?? 0;
  const childBoost = Math.min(220, Math.max(0, children.length - 1) * 35);
  const recencyBoost = Math.min(40, Math.max(0, recencyTs) / 1_000_000_000_000);
  return best + childBoost + recencyBoost + extraScore;
}

function compareResults(left: SearchEverythingResult, right: SearchEverythingResult): number {
  if (left.score !== right.score) return right.score - left.score;
  const leftTs = left.meta.lastActivityAt ?? left.meta.createdAt ?? 0;
  const rightTs = right.meta.lastActivityAt ?? right.meta.createdAt ?? 0;
  if (leftTs !== rightTs) return rightTs - leftTs;
  return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" });
}

function compareChildren(left: CandidateChildMatch, right: CandidateChildMatch): number {
  if (left.parentScore !== right.parentScore) return right.parentScore - left.parentScore;
  const leftTs = left.timestamp ?? 0;
  const rightTs = right.timestamp ?? 0;
  if (leftTs !== rightTs) return rightTs - leftTs;
  return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" });
}

function exactQuestIdScore(questId: string, query: string): number {
  return questId.toLowerCase() === query.trim().toLowerCase() ? 1400 : 1150;
}

function exactSessionNumberScore(sessionNum: number | null | undefined, query: string): number {
  const match = query.trim().match(/^#(\d+)$/);
  if (!match || sessionNum == null) return 900;
  return Number.parseInt(match[1], 10) === sessionNum ? 1400 : 900;
}

function messageScore(field: "user_message" | "assistant" | "compact_marker"): number {
  if (field === "user_message") return 660;
  if (field === "assistant") return 620;
  return 570;
}

function questRecencyTs(quest: QuestmasterTask): number {
  return Math.max(quest.createdAt, quest.updatedAt ?? 0, quest.statusChangedAt ?? 0);
}

function questRelationshipSearchText(quest: QuestmasterTask): string | undefined {
  const explicit = quest.relationships?.followUpOf ?? [];
  const derived = quest.relatedQuests?.map((related) => `${related.kind} ${related.questId}`) ?? [];
  const combined = [...explicit, ...derived];
  return combined.length > 0 ? combined.join(" ") : undefined;
}

function formatQuestFeedbackTitle(entry: QuestFeedbackEntry, index: number): string {
  const label = entry.kind ? entry.kind.replace(/_/g, " ") : "comment";
  const phase = entry.phaseId ? `, ${entry.phaseId}` : "";
  return `Feedback ${index + 1} (${entry.author}, ${label}${phase})`;
}

function formatQuestHistoryTitle(version: QuestmasterTask): string {
  return `History v${version.version}`;
}

function formatSessionTitle(session: SearchEverythingSessionDocument): string {
  const prefix = session.sessionNum == null ? "Session" : `#${session.sessionNum}`;
  const name = session.name?.trim();
  return name ? `${prefix} ${name}` : prefix;
}

function formatSessionSubtitle(session: SearchEverythingSessionDocument): string {
  const parts: string[] = [];
  if (session.lastActivityAt) parts.push(`last active ${formatRelativeTime(session.lastActivityAt)}`);
  if (session.gitBranch) parts.push(session.gitBranch);
  if (session.cwd) parts.push(session.cwd);
  if (session.archived) parts.push("archived");
  if (session.reviewerOf !== undefined) parts.push(`reviewer of #${session.reviewerOf}`);
  return parts.join(" · ");
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const absMs = Math.abs(diffMs);
  if (absMs < 60_000) return "just now";
  const minutes = Math.round(absMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
