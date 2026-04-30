import type { QuestFeedbackEntry, QuestmasterTask } from "./quest-types.js";
import { normalizeTldr } from "./quest-tldr.js";

export interface QuestGrepMatch {
  questId: string;
  title: string;
  status: QuestmasterTask["status"];
  matchedField: string;
  snippet: string;
  feedbackIndex?: number;
  feedbackAuthor?: QuestFeedbackEntry["author"];
  feedbackKind?: QuestFeedbackEntry["kind"];
  journeyRunId?: string;
  phaseOccurrenceId?: string;
  phaseId?: string;
  phasePosition?: number;
  phaseOccurrence?: number;
}

export interface QuestGrepResponse {
  query: string;
  totalMatches: number;
  matches: QuestGrepMatch[];
  warning?: string;
}

function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern "${pattern}": ${message}`);
  }
}

function buildSnippet(text: string, re: RegExp, maxLen = 120): string {
  if (!text.trim()) return "";
  const match = re.exec(text);
  if (!match || match.index == null) {
    return text.length <= maxLen ? text.trim() : `${text.slice(0, maxLen).trim()}...`;
  }

  const matchLength = match[0].length || 1;
  const contextRadius = Math.max(0, Math.floor((maxLen - matchLength) / 2));
  const start = Math.max(0, match.index - contextRadius);
  const end = Math.min(text.length, start + maxLen);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function pushContentMatch(args: {
  re: RegExp;
  pushMatch: (match: QuestGrepMatch, text: string) => void;
  match: Omit<QuestGrepMatch, "snippet">;
  text: string;
  tldr?: string;
}): void {
  const tldr = normalizeTldr(args.tldr);
  if (tldr && args.re.test(tldr)) {
    args.pushMatch({ ...args.match, matchedField: `${args.match.matchedField}.tldr`, snippet: "" }, tldr);
    return;
  }
  args.pushMatch({ ...args.match, snippet: "" }, args.text);
}

export function grepQuests(
  quests: QuestmasterTask[],
  query: string,
  options: { limit?: number } = {},
): QuestGrepResponse {
  const trimmed = query.trim();
  if (!trimmed) return { query, totalMatches: 0, matches: [] };

  const re = compileRegex(trimmed);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const matches: QuestGrepMatch[] = [];
  let totalMatches = 0;

  const pushMatch = (match: QuestGrepMatch, text: string) => {
    if (!re.test(text)) return;
    totalMatches += 1;
    if (matches.length >= limit) return;
    matches.push({
      ...match,
      snippet: buildSnippet(text, re),
    });
  };

  for (const quest of quests) {
    pushMatch(
      {
        questId: quest.questId,
        title: quest.title,
        status: quest.status,
        matchedField: "questId",
        snippet: "",
      },
      quest.questId,
    );
    pushMatch(
      {
        questId: quest.questId,
        title: quest.title,
        status: quest.status,
        matchedField: "title",
        snippet: "",
      },
      quest.title,
    );

    const description = "description" in quest ? quest.description || "" : "";
    if (description) {
      pushContentMatch({
        re,
        pushMatch,
        match: {
          questId: quest.questId,
          title: quest.title,
          status: quest.status,
          matchedField: "description",
        },
        text: description,
        tldr: quest.tldr,
      });
    }

    const feedback = "feedback" in quest ? quest.feedback || [] : [];
    feedback.forEach((entry, index) => {
      if (!entry.text) return;
      pushContentMatch({
        re,
        pushMatch,
        match: {
          questId: quest.questId,
          title: quest.title,
          status: quest.status,
          matchedField: `feedback[${index}]`,
          feedbackIndex: index,
          feedbackAuthor: entry.author,
          ...(entry.kind ? { feedbackKind: entry.kind } : {}),
          ...(entry.journeyRunId ? { journeyRunId: entry.journeyRunId } : {}),
          ...(entry.phaseOccurrenceId ? { phaseOccurrenceId: entry.phaseOccurrenceId } : {}),
          ...(entry.phaseId ? { phaseId: entry.phaseId } : {}),
          ...(entry.phasePosition !== undefined ? { phasePosition: entry.phasePosition } : {}),
          ...(entry.phaseOccurrence !== undefined ? { phaseOccurrence: entry.phaseOccurrence } : {}),
        },
        text: entry.text,
        tldr: entry.tldr,
      });
    });
  }

  const result: QuestGrepResponse = { query, totalMatches, matches };
  if (totalMatches === 0 && trimmed.includes("\\|")) {
    result.warning =
      'Pattern contains "\\|" which matches a literal pipe in JS regex. For alternation, use "|" instead.';
  }
  return result;
}
