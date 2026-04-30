import type {
  QuestFeedbackEntry,
  QuestJourneyRun,
  QuestPhaseOccurrence,
  QuestmasterTask,
} from "../server/quest-types.js";
import { getQuestJourneyPhase, type QuestJourneyPhaseId } from "./quest-journey.js";

export interface IndexedQuestFeedbackEntry extends QuestFeedbackEntry {
  index: number;
}

export interface QuestPhaseDocumentationGroup {
  key: string;
  phaseId?: QuestJourneyPhaseId;
  phaseLabel: string;
  displayLabel: string;
  metaLabel: string;
  journeyRunId?: string;
  journeyRunOrdinal?: number;
  phaseOccurrenceId?: string;
  phaseIndex?: number;
  phasePosition?: number;
  phaseOccurrence?: number;
  scopeMatched: boolean;
  entries: IndexedQuestFeedbackEntry[];
}

export interface QuestPhaseDocumentationSummary {
  questTldr?: string;
  hasJourneyRuns: boolean;
  hasPhaseDocumentation: boolean;
  primaryRun?: QuestJourneyRun;
  groups: QuestPhaseDocumentationGroup[];
  scopedEntries: IndexedQuestFeedbackEntry[];
  unscopedFeedback: IndexedQuestFeedbackEntry[];
}

interface OccurrenceRef {
  run: QuestJourneyRun;
  runOrdinal: number;
  occurrence: QuestPhaseOccurrence;
  order: number;
}

export function summarizeQuestPhaseDocumentation(quest: QuestmasterTask): QuestPhaseDocumentationSummary {
  const runs = sortedJourneyRuns(quest);
  const occurrences = runs.flatMap(({ run, runOrdinal }, runIndex) =>
    run.phaseOccurrences.map((occurrence) => ({
      run,
      runOrdinal,
      occurrence,
      order: runIndex * 1000 + occurrence.phaseIndex,
    })),
  );
  const groups = new Map<string, QuestPhaseDocumentationGroup>();
  for (const ref of occurrences) {
    const group = groupForOccurrence(ref, runs.length);
    groups.set(group.key, group);
  }

  const feedback = questFeedbackEntries(quest);
  const scopedEntries: IndexedQuestFeedbackEntry[] = [];
  const unscopedFeedback: IndexedQuestFeedbackEntry[] = [];
  for (const entry of feedback) {
    if (!hasPhaseScope(entry)) {
      unscopedFeedback.push(entry);
      continue;
    }
    scopedEntries.push(entry);
    const ref = resolveOccurrence(entry, occurrences);
    const group = ref
      ? groupForOccurrence(ref, runs.length)
      : groupForUnmatchedScope(entry, runs.length, groups.size + 1);
    const existing = groups.get(group.key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      group.entries.push(entry);
      groups.set(group.key, group);
    }
  }

  const sortedGroups = [...groups.values()]
    .map((group) => ({ ...group, entries: [...group.entries].sort((a, b) => a.index - b.index) }))
    .sort(compareGroups);

  return {
    questTldr: normalizeTldr(quest.tldr),
    hasJourneyRuns: runs.length > 0,
    hasPhaseDocumentation: sortedGroups.some((group) => group.entries.length > 0),
    primaryRun: runs.at(-1)?.run,
    groups: sortedGroups,
    scopedEntries,
    unscopedFeedback,
  };
}

export function phaseDocumentationPreview(entry: QuestFeedbackEntry): string {
  return normalizeTldr(entry.tldr) ?? entry.text;
}

export function compactPhaseDocumentationGroups(
  summary: QuestPhaseDocumentationSummary,
  limit: number,
): QuestPhaseDocumentationGroup[] {
  const groupsWithEntries = summary.groups.filter((group) => group.entries.length > 0);
  if (limit <= 0) return [];
  return groupsWithEntries.slice(Math.max(0, groupsWithEntries.length - limit));
}

function questFeedbackEntries(quest: QuestmasterTask): IndexedQuestFeedbackEntry[] {
  const feedback = "feedback" in quest ? (quest.feedback ?? []) : [];
  return feedback.map((entry, index) => ({ ...entry, index }));
}

function sortedJourneyRuns(quest: QuestmasterTask): Array<{ run: QuestJourneyRun; runOrdinal: number }> {
  const runs = [...(quest.journeyRuns ?? [])].sort(
    (a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId),
  );
  return runs.map((run, index) => ({ run, runOrdinal: index + 1 }));
}

function hasPhaseScope(entry: QuestFeedbackEntry): boolean {
  return !!(
    entry.phaseOccurrenceId ||
    entry.journeyRunId ||
    entry.phaseId ||
    entry.phasePosition !== undefined ||
    entry.phaseOccurrence !== undefined
  );
}

function resolveOccurrence(entry: QuestFeedbackEntry, occurrences: OccurrenceRef[]): OccurrenceRef | null {
  if (entry.phaseOccurrenceId) {
    return occurrences.find((ref) => ref.occurrence.occurrenceId === entry.phaseOccurrenceId) ?? null;
  }

  if (entry.journeyRunId && entry.phasePosition !== undefined) {
    return (
      occurrences.find(
        (ref) => ref.run.runId === entry.journeyRunId && ref.occurrence.phasePosition === entry.phasePosition,
      ) ?? null
    );
  }

  const matches = occurrences.filter((ref) => occurrenceMatchesEntry(ref, entry));
  return matches.length === 1 ? matches[0]! : null;
}

function occurrenceMatchesEntry(ref: OccurrenceRef, entry: QuestFeedbackEntry): boolean {
  if (entry.journeyRunId && ref.run.runId !== entry.journeyRunId) return false;
  if (entry.phaseId && ref.occurrence.phaseId !== entry.phaseId) return false;
  if (entry.phasePosition !== undefined && ref.occurrence.phasePosition !== entry.phasePosition) return false;
  if (entry.phaseOccurrence !== undefined && ref.occurrence.phaseOccurrence !== entry.phaseOccurrence) return false;
  return true;
}

function groupForOccurrence(ref: OccurrenceRef, runCount: number): QuestPhaseDocumentationGroup {
  const { run, runOrdinal, occurrence } = ref;
  return {
    key: `occurrence:${occurrence.occurrenceId}`,
    phaseId: occurrence.phaseId,
    phaseLabel: phaseLabel(occurrence.phaseId),
    displayLabel: phaseDisplayLabel(occurrence.phaseId, occurrence.phaseOccurrence),
    metaLabel: metaLabel({
      runOrdinal,
      runCount,
      phasePosition: occurrence.phasePosition,
      scopeMatched: true,
    }),
    journeyRunId: run.runId,
    journeyRunOrdinal: runOrdinal,
    phaseOccurrenceId: occurrence.occurrenceId,
    phaseIndex: occurrence.phaseIndex,
    phasePosition: occurrence.phasePosition,
    phaseOccurrence: occurrence.phaseOccurrence,
    scopeMatched: true,
    entries: [],
  };
}

function groupForUnmatchedScope(
  entry: QuestFeedbackEntry,
  runCount: number,
  fallbackOrder: number,
): QuestPhaseDocumentationGroup {
  const phaseId = normalizePhaseId(entry.phaseId);
  const phasePosition = entry.phasePosition;
  const phaseOccurrence = entry.phaseOccurrence;
  const key = [
    "unmatched",
    entry.phaseOccurrenceId ?? "",
    entry.journeyRunId ?? "",
    phaseId ?? "",
    phasePosition ?? "",
    phaseOccurrence ?? "",
    fallbackOrder,
  ].join(":");
  return {
    key,
    ...(phaseId ? { phaseId } : {}),
    phaseLabel: phaseId ? phaseLabel(phaseId) : "Phase documentation",
    displayLabel: phaseId ? phaseDisplayLabel(phaseId, phaseOccurrence) : "Phase documentation",
    metaLabel: metaLabel({
      runCount,
      phasePosition,
      scopeMatched: false,
    }),
    ...(entry.journeyRunId ? { journeyRunId: entry.journeyRunId } : {}),
    ...(entry.phaseOccurrenceId ? { phaseOccurrenceId: entry.phaseOccurrenceId } : {}),
    ...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
    ...(phasePosition !== undefined ? { phasePosition } : {}),
    ...(phaseOccurrence !== undefined ? { phaseOccurrence } : {}),
    scopeMatched: false,
    entries: [],
  };
}

function compareGroups(a: QuestPhaseDocumentationGroup, b: QuestPhaseDocumentationGroup): number {
  const aRun = a.journeyRunOrdinal ?? Number.MAX_SAFE_INTEGER;
  const bRun = b.journeyRunOrdinal ?? Number.MAX_SAFE_INTEGER;
  if (aRun !== bRun) return aRun - bRun;
  const aPosition = a.phasePosition ?? Number.MAX_SAFE_INTEGER;
  const bPosition = b.phasePosition ?? Number.MAX_SAFE_INTEGER;
  if (aPosition !== bPosition) return aPosition - bPosition;
  return a.key.localeCompare(b.key);
}

function phaseLabel(phaseId: QuestJourneyPhaseId): string {
  return getQuestJourneyPhase(phaseId)?.label ?? phaseId;
}

function phaseDisplayLabel(phaseId: QuestJourneyPhaseId, occurrence?: number): string {
  const label = phaseLabel(phaseId);
  return occurrence && occurrence > 1 ? `${label} #${occurrence}` : label;
}

function metaLabel(args: {
  runOrdinal?: number;
  runCount: number;
  phasePosition?: number;
  scopeMatched: boolean;
}): string {
  const parts: string[] = [];
  if (args.runOrdinal && args.runCount > 1) parts.push(`run ${args.runOrdinal}`);
  if (args.phasePosition !== undefined) parts.push(`phase ${args.phasePosition}`);
  if (!args.scopeMatched) parts.push("scope unmatched");
  return parts.join(" / ");
}

function normalizePhaseId(value: unknown): QuestJourneyPhaseId | undefined {
  return typeof value === "string" && getQuestJourneyPhase(value) ? (value as QuestJourneyPhaseId) : undefined;
}

function normalizeTldr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
