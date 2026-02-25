import type { QuestmasterTask } from "./quest-types.js";

export interface QuestListFilterOptions {
  status?: string;
  tags?: string;
  tag?: string;
  session?: string;
  text?: string;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function applyQuestListFilters(
  quests: QuestmasterTask[],
  filters: QuestListFilterOptions,
): QuestmasterTask[] {
  const statuses = new Set(parseCsv(filters.status));
  const tagTokens = new Set(
    [...parseCsv(filters.tags), ...parseCsv(filters.tag)].map((tag) => tag.toLowerCase()),
  );
  const sessionId = filters.session?.trim() || "";
  const textQuery = filters.text?.trim().toLowerCase() || "";

  return quests.filter((quest) => {
    if (statuses.size > 0 && !statuses.has(quest.status)) return false;

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
      if (owner !== sessionId) return false;
    }

    if (textQuery) {
      const haystack = `${quest.title}\n${"description" in quest ? quest.description || "" : ""}`.toLowerCase();
      if (!haystack.includes(textQuery)) return false;
    }

    return true;
  });
}

