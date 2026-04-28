import type { QuestFeedbackEntry, QuestmasterTask } from "./quest-types.js";

export const TLDR_WARNING_THRESHOLD_CHARS = 1200;
export const QUEST_TLDR_WARNING_HEADER = "X-Quest-TLDR-Warning";

export type QuestTldrContentKind = "description" | "feedback";

export function normalizeTldr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function hasLongContentWithoutTldr(text: unknown, tldr: unknown): boolean {
  if (typeof text !== "string") return false;
  if (normalizeTldr(tldr)) return false;
  return text.trim().length >= TLDR_WARNING_THRESHOLD_CHARS;
}

export function tldrWarningMessage(kind: QuestTldrContentKind): string {
  const label = kind === "description" ? "quest description" : "quest feedback";
  return `${label} is ${TLDR_WARNING_THRESHOLD_CHARS}+ characters; add separate tldr metadata for human scanning.`;
}

export function tldrWarningForContent(kind: QuestTldrContentKind, text: unknown, tldr: unknown): string | null {
  return hasLongContentWithoutTldr(text, tldr) ? tldrWarningMessage(kind) : null;
}

export function preferredQuestDescriptionPreview(quest: QuestmasterTask): string {
  return normalizeTldr((quest as { tldr?: unknown }).tldr) ?? ("description" in quest ? quest.description || "" : "");
}

export function preferredFeedbackPreview(entry: QuestFeedbackEntry): string {
  return normalizeTldr(entry.tldr) ?? entry.text;
}
