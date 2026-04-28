import type { QuestmasterTask } from "./quest-types.js";
import { hasQuestReviewMetadata, isQuestReviewInboxUnread } from "./quest-types.js";
import { normalizeForSearch } from "../shared/search-utils.js";

export interface QuestListFilterOptions {
  status?: string;
  tags?: string;
  tag?: string;
  session?: string;
  text?: string;
  verification?: string;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function applyQuestListFilters(quests: QuestmasterTask[], filters: QuestListFilterOptions): QuestmasterTask[] {
  const requestedStatuses = parseCsv(filters.status);
  const statuses = new Set(requestedStatuses.filter((status) => status !== "needs_verification"));
  const wantsReviewStatusAlias = requestedStatuses.includes("needs_verification");
  const tagTokens = new Set([...parseCsv(filters.tags), ...parseCsv(filters.tag)].map((tag) => tag.toLowerCase()));
  const verificationScopes = new Set(parseCsv(filters.verification).map((scope) => scope.toLowerCase()));
  const sessionId = filters.session?.trim() || "";
  const textQuery = normalizeForSearch(filters.text ?? "");

  return quests.filter((quest) => {
    if (statuses.size > 0 || wantsReviewStatusAlias) {
      const statusMatches = statuses.has(quest.status) || (wantsReviewStatusAlias && hasQuestReviewMetadata(quest));
      if (!statusMatches) return false;
    }

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

    if (sessionId) {
      const owner = "sessionId" in quest ? (quest as { sessionId?: string }).sessionId : undefined;
      const previousOwners = Array.isArray(quest.previousOwnerSessionIds) ? quest.previousOwnerSessionIds : [];
      if (owner !== sessionId && !previousOwners.includes(sessionId)) return false;
    }

    if (textQuery) {
      const feedbackText =
        "feedback" in quest ? (quest.feedback ?? []).flatMap((entry) => [entry.tldr ?? "", entry.text]) : [];
      const haystack = normalizeForSearch(
        `${quest.questId}\n${quest.title}\n${quest.tldr ?? ""}\n${"description" in quest ? quest.description || "" : ""}\n${feedbackText.join("\n")}`,
      );
      if (!haystack.includes(textQuery)) return false;
    }

    return true;
  });
}
