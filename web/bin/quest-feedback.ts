import type { QuestFeedbackEntry, QuestVerificationItem, QuestmasterTask } from "../server/quest-types.js";

export type FeedbackAuthorFilter = "human" | "agent" | "all";

export type IndexedFeedbackEntry = QuestFeedbackEntry & {
  index: number;
};

export type FeedbackFilterOptions = {
  author?: FeedbackAuthorFilter;
  unaddressed?: boolean;
  last?: number;
};

const SUMMARY_FEEDBACK_PREFIXES = ["summary:", "refreshed summary:"];
const COMMIT_SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const SELF_VERIFIABLE_RE = new RegExp(
  [
    "\\btypecheck\\b",
    "\\bvitest\\b",
    "\\bformat:check\\b",
    "\\bformat check\\b",
    "\\blint\\b",
    "\\bbiome\\b",
    "\\btsc\\b",
    "\\b(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:test|typecheck|format:check|lint|build)\\b",
    "\\b(?:automated|unit|integration|e2e|test suite)\\s+tests?\\s+pass(?:es|ed)?\\b",
    "\\btests?\\s+pass(?:es|ed)?\\b",
    "\\bbuild\\s+pass(?:es|ed)?\\b",
  ].join("|"),
  "i",
);

export function questFeedbackEntries(quest: QuestmasterTask): IndexedFeedbackEntry[] {
  const entries = "feedback" in quest ? (quest.feedback ?? []) : [];
  return entries.map((entry, index) => ({ ...entry, index }));
}

export function filterFeedbackEntries(
  quest: QuestmasterTask,
  options: FeedbackFilterOptions = {},
): IndexedFeedbackEntry[] {
  const author = options.author ?? "all";
  let entries = questFeedbackEntries(quest);
  if (author !== "all") {
    entries = entries.filter((entry) => entry.author === author);
  }
  if (options.unaddressed) {
    entries = entries.filter((entry) => entry.author === "human" && !entry.addressed);
  }
  if (options.last !== undefined) {
    entries = entries.slice(Math.max(0, entries.length - options.last));
  }
  return entries;
}

export function latestFeedbackEntry(
  quest: QuestmasterTask,
  options: Omit<FeedbackFilterOptions, "last"> = {},
): IndexedFeedbackEntry | null {
  const entries = filterFeedbackEntries(quest, options);
  return entries.at(-1) ?? null;
}

export function unaddressedHumanFeedbackEntries(quest: QuestmasterTask): IndexedFeedbackEntry[] {
  return filterFeedbackEntries(quest, { author: "human", unaddressed: true });
}

export function isAgentSummaryFeedback(text: string): boolean {
  const normalized = text.trimStart().toLowerCase();
  return SUMMARY_FEEDBACK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function latestAgentSummaryFeedback(quest: QuestmasterTask): IndexedFeedbackEntry | null {
  const entries = questFeedbackEntries(quest);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.author === "agent" && isAgentSummaryFeedback(entry.text)) return entry;
  }
  return null;
}

export function latestHumanFeedback(quest: QuestmasterTask): IndexedFeedbackEntry | null {
  const entries = questFeedbackEntries(quest);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.author === "human") return entry;
  }
  return null;
}

export function hasAgentSummaryAfterLatestHumanFeedback(quest: QuestmasterTask): boolean {
  const latestHuman = latestHumanFeedback(quest);
  if (!latestHuman) return true;
  const latestSummary = latestAgentSummaryFeedback(quest);
  return !!latestSummary && latestSummary.ts > latestHuman.ts;
}

export function completionHygieneWarnings(
  quest: QuestmasterTask,
  items: QuestVerificationItem[],
  commitShas: string[],
): string[] {
  const warnings: string[] = [];
  const unaddressed = unaddressedHumanFeedbackEntries(quest);
  if (unaddressed.length > 0) {
    warnings.push(
      `unaddressed human feedback remains at ${formatFeedbackIndices(unaddressed)}; address it with quest address ${quest.questId} <index>.`,
    );
  }
  if (!hasAgentSummaryAfterLatestHumanFeedback(quest)) {
    warnings.push(
      `latest human feedback is newer than the latest agent summary; refresh the consolidated Summary: feedback comment before handoff.`,
    );
  }
  if (commitShas.length === 0 && !quest.commitShas?.length && questContainsCommitLikeText(quest)) {
    warnings.push(
      `commit-like SHA text exists in quest comments/description, but no structured --commit/--commits metadata was provided.`,
    );
  }
  const selfVerifiableItems = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => SELF_VERIFIABLE_RE.test(item.text));
  if (selfVerifiableItems.length > 0) {
    warnings.push(
      `verification item(s) ${selfVerifiableItems.map(({ index }) => index).join(", ")} look self-verifiable; run automated checks yourself and reserve quest verification items for human judgment.`,
    );
  }
  return warnings;
}

export function feedbackAddWarnings(args: {
  before: QuestmasterTask | null;
  after: QuestmasterTask;
  author: "human" | "agent";
  text: string;
}): string[] {
  const { before, after, author, text } = args;
  if (author !== "agent") return [];
  const warnings: string[] = [];
  const isSummary = isAgentSummaryFeedback(text);
  const beforeSummary = before ? latestAgentSummaryFeedback(before) : null;
  const afterSummary = latestAgentSummaryFeedback(after);
  if (isSummary && beforeSummary && afterSummary?.index === beforeSummary.index) {
    warnings.push(
      `refreshed existing summary feedback #${beforeSummary.index} instead of appending a new summary comment.`,
    );
  } else if (isSummary) {
    warnings.push(
      `added a consolidated summary comment; future Summary: feedback will refresh it instead of appending.`,
    );
  } else if (beforeSummary && looksLikeSummaryText(text)) {
    warnings.push(
      `this looks like another summary but does not start with Summary: or Refreshed summary:, so it was appended instead of refreshing summary feedback #${beforeSummary.index}.`,
    );
  }
  return warnings;
}

export function formatFeedbackIndices(entries: IndexedFeedbackEntry[]): string {
  return entries.map((entry) => `#${entry.index}`).join(", ");
}

function questContainsCommitLikeText(quest: QuestmasterTask): boolean {
  const chunks = [
    "description" in quest ? quest.description : "",
    ...questFeedbackEntries(quest).map((entry) => entry.text),
  ].filter(Boolean);
  return chunks.some((chunk) => COMMIT_SHA_RE.test(chunk));
}

function looksLikeSummaryText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith("summary")) return true;
  return normalized.includes("what changed") && normalized.includes("verification");
}
