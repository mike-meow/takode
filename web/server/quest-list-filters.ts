import type { QuestmasterTask } from "./quest-types.js";
import { hasQuestReviewMetadata, isQuestReviewInboxUnread } from "./quest-types.js";
import { multiWordMatch, normalizeForSearch } from "../shared/search-utils.js";

export interface QuestListFilterOptions {
  status?: string;
  tags?: string;
  tag?: string;
  excludeTags?: string;
  session?: string;
  text?: string;
  verification?: string;
}

export type QuestListSortColumn =
  | "cards"
  | "quest"
  | "title"
  | "owner"
  | "leader"
  | "status"
  | "verify"
  | "feedback"
  | "updated";
export type QuestListSortDirection = "asc" | "desc";

export interface QuestListPageOptions extends QuestListFilterOptions {
  offset?: number;
  limit?: number;
  sortColumn?: QuestListSortColumn;
  sortDirection?: QuestListSortDirection;
}

export interface QuestListPageResult {
  quests: QuestmasterTask[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  previousOffset: number | null;
  counts: Record<QuestStatusOrAll, number>;
  allTags: string[];
}

type QuestStatusOrAll = QuestmasterTask["status"] | "all";
type SearchRank = [number, number, number, number];

const STATUS_DISPLAY_ORDER: Record<QuestmasterTask["status"], number> = {
  in_progress: 0,
  refined: 1,
  idea: 2,
  done: 3,
};

const STATUS_SORT_RANK: Record<QuestmasterTask["status"], number> = {
  idea: 0,
  refined: 1,
  in_progress: 2,
  done: 3,
};
const MAX_PAGE_LIMIT = 150;

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function applyQuestListFilters(quests: QuestmasterTask[], filters: QuestListFilterOptions): QuestmasterTask[] {
  return filterQuestList(quests, filters).filtered;
}

export function getQuestListPage(quests: QuestmasterTask[], options: QuestListPageOptions): QuestListPageResult {
  const { beforeStatusFilter, filtered } = filterQuestList(quests, options);
  const sorted = sortQuestList(filtered, options);
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset, sorted.length);
  const pageQuests = sorted.slice(offset, offset + limit);
  const nextOffset = offset + limit < sorted.length ? offset + limit : null;
  const previousOffset = offset > 0 ? Math.max(0, offset - limit) : null;

  return {
    quests: pageQuests,
    total: sorted.length,
    offset,
    limit,
    hasMore: nextOffset !== null,
    nextOffset,
    previousOffset,
    counts: countByStatus(beforeStatusFilter),
    allTags: listAllTags(quests),
  };
}

function filterQuestList(
  quests: QuestmasterTask[],
  filters: QuestListFilterOptions,
): { beforeStatusFilter: QuestmasterTask[]; filtered: QuestmasterTask[] } {
  const requestedStatuses = parseCsv(filters.status);
  const statuses = new Set(requestedStatuses.filter((status) => status !== "needs_verification"));
  const wantsReviewStatusAlias = requestedStatuses.includes("needs_verification");
  const tagTokens = new Set([...parseCsv(filters.tags), ...parseCsv(filters.tag)].map((tag) => tag.toLowerCase()));
  const excludedTagTokens = new Set(parseCsv(filters.excludeTags).map((tag) => tag.toLowerCase()));
  const verificationScopes = new Set(parseCsv(filters.verification).map((scope) => scope.toLowerCase()));
  const sessionId = filters.session?.trim() || "";
  const textQuery = normalizeForSearch(filters.text ?? "");

  const beforeStatusFilter = quests.filter((quest) => {
    if (verificationScopes.size > 0) {
      const isReview = hasQuestReviewMetadata(quest);
      const inInbox = isQuestReviewInboxUnread(quest);
      const wantsAnyVerification =
        verificationScopes.has("all") ||
        verificationScopes.has("verification") ||
        verificationScopes.has("needs_verification");
      const wantsInbox =
        verificationScopes.has("inbox") || verificationScopes.has("unread") || verificationScopes.has("new");
      const wantsReviewed =
        verificationScopes.has("reviewed") ||
        verificationScopes.has("non-inbox") ||
        verificationScopes.has("non_inbox") ||
        verificationScopes.has("read") ||
        verificationScopes.has("acknowledged");

      let matchesVerificationScope = false;
      if (wantsAnyVerification && isReview) matchesVerificationScope = true;
      if (wantsInbox && inInbox) matchesVerificationScope = true;
      if (wantsReviewed && isReview && !inInbox) matchesVerificationScope = true;
      if (!matchesVerificationScope) return false;
    }

    if (tagTokens.size > 0) {
      const questTags = new Set((quest.tags || []).map((tag) => tag.toLowerCase()));
      let hasAnyTag = false;
      for (const tag of tagTokens) {
        if (questTags.has(tag)) {
          hasAnyTag = true;
          break;
        }
      }
      if (!hasAnyTag) return false;
    }

    if (excludedTagTokens.size > 0) {
      const questTags = new Set((quest.tags || []).map((tag) => tag.toLowerCase()));
      for (const tag of excludedTagTokens) {
        if (questTags.has(tag)) return false;
      }
    }

    if (sessionId) {
      const owner = "sessionId" in quest ? (quest as { sessionId?: string }).sessionId : undefined;
      const previousOwners = Array.isArray(quest.previousOwnerSessionIds) ? quest.previousOwnerSessionIds : [];
      if (owner !== sessionId && !previousOwners.includes(sessionId)) return false;
    }

    if (textQuery) {
      if (!getQuestSearchRank(quest, filters.text ?? "")) return false;
    }

    return true;
  });

  const filtered =
    statuses.size > 0 || wantsReviewStatusAlias
      ? beforeStatusFilter.filter(
          (quest) => statuses.has(quest.status) || (wantsReviewStatusAlias && hasQuestReviewMetadata(quest)),
        )
      : beforeStatusFilter;

  return { beforeStatusFilter, filtered };
}

function sortQuestList(quests: QuestmasterTask[], options: QuestListPageOptions): QuestmasterTask[] {
  const textQuery = (options.text ?? "").trim();
  if (textQuery) {
    return quests
      .map((quest) => ({ quest, rank: getQuestSearchRank(quest, textQuery) }))
      .filter((entry): entry is { quest: QuestmasterTask; rank: SearchRank } => entry.rank !== null)
      .sort((left, right) => compareSearchRank(left.rank, right.rank) || compareQuestIds(left.quest, right.quest))
      .map((entry) => entry.quest);
  }

  const column = options.sortColumn ?? "cards";
  const direction = options.sortDirection ?? (column === "cards" ? "asc" : "desc");
  return [...quests].sort((left, right) => {
    const columnResult = compareSortColumn(left, right, column);
    const directed = direction === "asc" ? columnResult : -columnResult;
    if (directed !== 0) return directed;
    return questRecencyTs(right) - questRecencyTs(left) || compareQuestIds(left, right);
  });
}

function compareSortColumn(left: QuestmasterTask, right: QuestmasterTask, column: QuestListSortColumn): number {
  switch (column) {
    case "cards": {
      const statusResult = STATUS_DISPLAY_ORDER[left.status] - STATUS_DISPLAY_ORDER[right.status];
      if (statusResult !== 0) return statusResult;
      return questRecencyTs(right) - questRecencyTs(left);
    }
    case "quest":
      return compareQuestIds(left, right);
    case "title":
      return compareText(left.title, right.title);
    case "owner":
      return compareText(getQuestOwnerSessionId(left) ?? "", getQuestOwnerSessionId(right) ?? "");
    case "leader":
      return compareText(left.leaderSessionId ?? "", right.leaderSessionId ?? "");
    case "status":
      return STATUS_SORT_RANK[left.status] - STATUS_SORT_RANK[right.status];
    case "verify":
      return compareNumberTuple(verificationSortTuple(left), verificationSortTuple(right));
    case "feedback":
      return compareNumberTuple(feedbackSortTuple(left), feedbackSortTuple(right));
    case "updated":
      return questRecencyTs(left) - questRecencyTs(right);
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}

function normalizeOffset(offset: number | undefined, total: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const normalized = Math.max(0, Math.trunc(offset));
  return Math.min(normalized, Math.max(0, total));
}

function countByStatus(quests: QuestmasterTask[]): Record<QuestStatusOrAll, number> {
  const counts: Record<QuestStatusOrAll, number> = { all: quests.length, idea: 0, refined: 0, in_progress: 0, done: 0 };
  for (const quest of quests) counts[quest.status] += 1;
  return counts;
}

function listAllTags(quests: QuestmasterTask[]): string[] {
  const tags = new Set<string>();
  for (const quest of quests) {
    for (const tag of quest.tags ?? []) tags.add(tag.toLowerCase());
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

function getQuestSearchRank(quest: QuestmasterTask, query: string): SearchRank | null {
  const words = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const fields = [
    { rank: 0, text: quest.questId },
    { rank: 1, text: quest.title },
    { rank: 2, text: quest.tldr },
    { rank: 3, text: "description" in quest ? quest.description : undefined },
    { rank: 4, text: quest.status === "done" && quest.cancelled !== true ? quest.debriefTldr : undefined },
    { rank: 5, text: quest.status === "done" && quest.cancelled !== true ? quest.debrief : undefined },
    ...("feedback" in quest
      ? (quest.feedback ?? []).flatMap((entry) => [
          { rank: 6, text: entry.tldr },
          { rank: 7, text: entry.text },
        ])
      : []),
  ];

  let best: SearchRank | null = null;
  for (const field of fields) {
    const rank = getFieldSearchRank(field.text, field.rank, query, words);
    if (!rank) continue;
    if (!best || compareSearchRank(rank, best) < 0) best = rank;
  }
  return best;
}

function getFieldSearchRank(
  fieldText: string | undefined,
  fieldRank: number,
  query: string,
  words: string[],
): SearchRank | null {
  if (!fieldText || !multiWordMatch(fieldText, query)) return null;
  const normalized = normalizeForSearch(fieldText);
  const phraseIndex = normalized.indexOf(normalizeForSearch(query));
  const positions = words.map((word) => normalized.indexOf(word)).filter((index) => index >= 0);
  const firstIndex = Math.min(...positions);
  const lastIndex = Math.max(...positions);
  const span = lastIndex - firstIndex;
  return [fieldRank, phraseIndex >= 0 ? phraseIndex : normalized.length + span, firstIndex, normalized.length];
}

function compareSearchRank(left: SearchRank, right: SearchRank): number {
  for (const index of [0, 1, 2, 3]) {
    const diff = left[index] - right[index];
    if (diff !== 0) return diff;
  }
  return 0;
}

function compareQuestIds(left: QuestmasterTask, right: QuestmasterTask): number {
  return left.questId.localeCompare(right.questId, undefined, { numeric: true, sensitivity: "base" });
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function questRecencyTs(quest: QuestmasterTask): number {
  return Math.max(quest.createdAt, quest.updatedAt ?? 0, quest.statusChangedAt ?? 0);
}

function getQuestOwnerSessionId(quest: QuestmasterTask): string | undefined {
  return "sessionId" in quest ? quest.sessionId : undefined;
}

function verificationSortTuple(quest: QuestmasterTask): [number, number, number] {
  if (!("verificationItems" in quest) || quest.verificationItems.length === 0) return [0, 0, 0];
  const total = quest.verificationItems.length;
  const checked = quest.verificationItems.filter((item) => item.checked).length;
  return [1, checked, total];
}

function feedbackSortTuple(quest: QuestmasterTask): [number, number] {
  const feedback = "feedback" in quest ? (quest.feedback ?? []).filter((entry) => entry.author === "human") : [];
  const open = feedback.filter((entry) => !entry.addressed).length;
  return [open, feedback.length];
}

function compareNumberTuple(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
