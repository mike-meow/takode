import type {
  QuestFeedbackEntry,
  QuestFeedbackKind,
  QuestJourneyRun,
  QuestPhaseOccurrence,
  QuestmasterTask,
} from "./quest-types.js";
import type { BoardRow } from "./session-types.js";
import {
  canonicalizeQuestJourneyPhaseId,
  getQuestJourneyCurrentPhaseIndex,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  getQuestJourneyPhaseIndices,
  normalizeQuestJourneyPlan,
  type QuestJourneyPhaseId,
} from "../shared/quest-journey.js";

export const QUEST_PHASE_DOCUMENTATION_WARNING_HEADER = "x-quest-phase-documentation-warning";

export interface QuestFeedbackDocumentationRequest {
  kind?: unknown;
  inferPhase?: unknown;
  noPhase?: unknown;
  phase?: unknown;
  phasePosition?: unknown;
  phaseOccurrence?: unknown;
  journeyRunId?: unknown;
  phaseOccurrenceId?: unknown;
}

export interface QuestBoardRowCandidate {
  leaderSessionId: string;
  row: BoardRow;
}

export interface QuestFeedbackDocumentationResolution {
  entryPatch: Partial<QuestFeedbackEntry>;
  journeyRuns?: QuestJourneyRun[];
  warning?: string;
  error?: string;
  status?: number;
}

type ParsedDocumentationRequest = {
  kind?: QuestFeedbackKind;
  inferPhase: boolean;
  noPhase: boolean;
  phaseId?: QuestJourneyPhaseId;
  phasePosition?: number;
  phaseOccurrence?: number;
  journeyRunId?: string;
  phaseOccurrenceId?: string;
  hasExplicitScope: boolean;
};

const KIND_ALIASES: Record<string, QuestFeedbackKind> = {
  comment: "comment",
  "phase-summary": "phase_summary",
  phase_summary: "phase_summary",
  "phase-finding": "phase_finding",
  phase_finding: "phase_finding",
  review: "review",
  artifact: "artifact",
  system: "system",
};

export function resolveQuestFeedbackDocumentation(args: {
  quest: QuestmasterTask;
  authorSessionId?: string;
  request: QuestFeedbackDocumentationRequest;
  boardRows: QuestBoardRowCandidate[];
  now?: number;
}): QuestFeedbackDocumentationResolution {
  const parsed = parseDocumentationRequest(args.request);
  if ("error" in parsed) return { error: parsed.error, status: 400, entryPatch: {} };
  if (parsed.noPhase) return { entryPatch: parsed.kind ? { kind: parsed.kind } : {} };

  const baseEntryPatch: Partial<QuestFeedbackEntry> = parsed.kind ? { kind: parsed.kind } : {};
  const existingRuns = [
    ...(((args.quest as { journeyRuns?: QuestJourneyRun[] }).journeyRuns ?? []) as QuestJourneyRun[]),
  ];
  const explicitExistingRun = resolveExistingRunScope(existingRuns, parsed);
  if ("error" in explicitExistingRun) {
    return { error: explicitExistingRun.error, status: 400, entryPatch: {} };
  }
  if (explicitExistingRun.entryPatch) {
    return { entryPatch: { ...explicitExistingRun.entryPatch, ...baseEntryPatch } };
  }

  const candidate = chooseBoardRowCandidate(args.quest, args.boardRows);
  if ("error" in candidate) {
    if (parsed.hasExplicitScope) return { error: candidate.error, status: 409, entryPatch: {} };
    return { entryPatch: baseEntryPatch, warning: candidate.error };
  }

  if (candidate.row) {
    const scoped = buildBoardScopedPatch({
      quest: args.quest,
      row: candidate.row.row,
      leaderSessionId: candidate.row.leaderSessionId,
      authorSessionId: args.authorSessionId,
      parsed,
      existingRuns,
      now: args.now ?? Date.now(),
    });
    if ("error" in scoped) {
      if (parsed.hasExplicitScope) return { error: scoped.error, status: 409, entryPatch: {} };
      return { entryPatch: baseEntryPatch, warning: scoped.error };
    }
    return {
      entryPatch: { ...scoped.entryPatch, ...baseEntryPatch },
      journeyRuns: scoped.journeyRuns,
    };
  }

  if (parsed.phaseId && parsed.hasExplicitScope) {
    if (parsed.phasePosition !== undefined && parsed.phasePosition !== 1) {
      return {
        error: "Manual phase documentation without a Journey run can only use --phase-position 1.",
        status: 400,
        entryPatch: {},
      };
    }
    const manual = buildManualScopedPatch(parsed, existingRuns, args.now ?? Date.now());
    return {
      entryPatch: { ...manual.entryPatch, ...baseEntryPatch },
      journeyRuns: manual.journeyRuns,
    };
  }

  if (parsed.hasExplicitScope) {
    return {
      error: "Phase documentation flags require a matching Journey run, phase occurrence, or phase id.",
      status: 400,
      entryPatch: {},
    };
  }
  if (parsed.inferPhase) {
    return { entryPatch: baseEntryPatch, warning: "No active leader board row found; added unscoped feedback." };
  }
  return { entryPatch: baseEntryPatch };
}

export function sameQuestFeedbackDocumentationScope(a: QuestFeedbackEntry, b: QuestFeedbackEntry): boolean {
  const aScoped = !!(a.journeyRunId || a.phaseOccurrenceId || a.phaseId);
  const bScoped = !!(b.journeyRunId || b.phaseOccurrenceId || b.phaseId);
  if (!aScoped && !bScoped) return true;
  return (
    a.journeyRunId === b.journeyRunId &&
    a.phaseOccurrenceId === b.phaseOccurrenceId &&
    a.phaseId === b.phaseId &&
    a.phasePosition === b.phasePosition &&
    a.phaseOccurrence === b.phaseOccurrence
  );
}

function parseDocumentationRequest(
  request: QuestFeedbackDocumentationRequest,
): ParsedDocumentationRequest | { error: string } {
  const kind = parseKind(request.kind);
  if (kind === null)
    return { error: "Invalid feedback kind. Use comment, phase-summary, phase-finding, review, artifact, or system." };
  const phaseId = typeof request.phase === "string" ? canonicalizeQuestJourneyPhaseId(request.phase) : null;
  if (typeof request.phase === "string" && request.phase.trim() && !phaseId) {
    return { error: `Invalid Quest Journey phase: ${request.phase}` };
  }
  const phasePosition = parsePositiveInteger(request.phasePosition, "phasePosition");
  if (phasePosition === null) return { error: "phasePosition must be a positive integer." };
  const phaseOccurrence = parsePositiveInteger(request.phaseOccurrence, "phaseOccurrence");
  if (phaseOccurrence === null) return { error: "phaseOccurrence must be a positive integer." };
  const journeyRunId = trimmedString(request.journeyRunId);
  const phaseOccurrenceId = trimmedString(request.phaseOccurrenceId);
  const noPhase = request.noPhase === true;
  const inferPhase = request.inferPhase !== false;
  const hasExplicitScope = !!(phaseId || phasePosition || phaseOccurrence || journeyRunId || phaseOccurrenceId);
  if (noPhase && hasExplicitScope) return { error: "--no-phase cannot be combined with phase documentation flags." };
  return {
    ...(kind ? { kind } : {}),
    inferPhase,
    noPhase,
    ...(phaseId ? { phaseId } : {}),
    ...(phasePosition !== undefined ? { phasePosition } : {}),
    ...(phaseOccurrence !== undefined ? { phaseOccurrence } : {}),
    ...(journeyRunId ? { journeyRunId } : {}),
    ...(phaseOccurrenceId ? { phaseOccurrenceId } : {}),
    hasExplicitScope,
  };
}

function resolveExistingRunScope(
  runs: QuestJourneyRun[],
  parsed: ParsedDocumentationRequest,
): { entryPatch?: Partial<QuestFeedbackEntry> } | { error: string } {
  if (!parsed.journeyRunId && !parsed.phaseOccurrenceId) return {};
  const runMatches = parsed.journeyRunId ? runs.filter((run) => run.runId === parsed.journeyRunId) : runs;
  if (parsed.journeyRunId && runMatches.length === 0) return { error: `Unknown Journey run: ${parsed.journeyRunId}` };
  const occurrenceMatches = runMatches.flatMap((run) =>
    run.phaseOccurrences
      .filter((occurrence) => occurrenceMatchesRequest(occurrence, parsed))
      .map((occurrence) => ({ run, occurrence })),
  );
  if (occurrenceMatches.length === 0) {
    if (parsed.phaseOccurrenceId) return { error: `Unknown phase occurrence: ${parsed.phaseOccurrenceId}` };
    return {};
  }
  if (occurrenceMatches.length > 1)
    return { error: "Phase occurrence is ambiguous; provide --journey-run or --phase-position." };
  return { entryPatch: patchForOccurrence(occurrenceMatches[0]!.run, occurrenceMatches[0]!.occurrence) };
}

function chooseBoardRowCandidate(
  quest: QuestmasterTask,
  candidates: QuestBoardRowCandidate[],
): { row?: QuestBoardRowCandidate } | { error: string } {
  const matching = candidates.filter((candidate) => candidate.row.questId === quest.questId);
  if (matching.length === 0) return {};
  const leaderSessionId = (quest as { leaderSessionId?: string }).leaderSessionId;
  const leaderMatches = leaderSessionId
    ? matching.filter((candidate) => candidate.leaderSessionId === leaderSessionId)
    : [];
  if (leaderMatches.length === 1) return { row: leaderMatches[0] };
  if (leaderMatches.length > 1) return { error: `Multiple active board rows found for leader ${leaderSessionId}.` };
  if (matching.length === 1) return { row: matching[0] };
  return {
    error: `Multiple active leader board rows found for ${quest.questId}; provide --journey-run or reconcile the board.`,
  };
}

function buildBoardScopedPatch(args: {
  quest: QuestmasterTask;
  row: BoardRow;
  leaderSessionId: string;
  authorSessionId?: string;
  parsed: ParsedDocumentationRequest;
  existingRuns: QuestJourneyRun[];
  now: number;
}): { entryPatch: Partial<QuestFeedbackEntry>; journeyRuns: QuestJourneyRun[] } | { error: string } {
  const statusPhaseId = getQuestJourneyPhaseForState(args.row.status)?.id;
  const rawJourneyCurrentPhaseId = getQuestJourneyPhase(args.row.journey?.currentPhaseId)?.id;
  if (statusPhaseId && rawJourneyCurrentPhaseId && statusPhaseId !== rawJourneyCurrentPhaseId) {
    return {
      error: `Board status ${args.row.status} disagrees with journey.currentPhaseId ${rawJourneyCurrentPhaseId}.`,
    };
  }
  const rawPlan = normalizeQuestJourneyPlan(args.row.journey, undefined);
  const rawActiveIndex = args.row.journey?.activePhaseIndex;
  const rawActivePosition =
    typeof rawActiveIndex === "number" && Number.isInteger(rawActiveIndex) ? rawActiveIndex + 1 : undefined;
  const rawActivePhaseId = rawActivePosition !== undefined ? rawPlan.phaseIds[rawActivePosition - 1] : undefined;
  if (statusPhaseId && rawActivePhaseId && statusPhaseId !== rawActivePhaseId) {
    return {
      error: `Board status ${args.row.status} disagrees with journey.activePhaseIndex ${rawActivePosition} (${rawActivePhaseId}).`,
    };
  }
  const normalized = normalizeQuestJourneyPlan(args.row.journey, args.row.status);
  const activeIndex = getQuestJourneyCurrentPhaseIndex(args.row.journey, args.row.status);
  if (activeIndex === undefined) return { error: "Active board row does not identify a current phase occurrence." };
  const phaseIndex = resolvePhaseIndex(normalized.phaseIds, args.parsed, activeIndex);
  if ("error" in phaseIndex) return phaseIndex;
  const run = buildRunSnapshot({
    quest: args.quest,
    row: args.row,
    leaderSessionId: args.leaderSessionId,
    authorSessionId: args.authorSessionId,
    phaseIds: normalized.phaseIds,
    activeIndex,
    now: args.now,
    existingRuns: args.existingRuns,
  });
  const occurrence = run.phaseOccurrences[phaseIndex.index];
  if (!occurrence) return { error: `Phase position ${phaseIndex.index + 1} is out of range for the active Journey.` };
  const nextRuns = [...args.existingRuns.filter((existing) => existing.runId !== run.runId), run];
  return { entryPatch: patchForOccurrence(run, occurrence), journeyRuns: nextRuns };
}

function buildManualScopedPatch(
  parsed: ParsedDocumentationRequest,
  existingRuns: QuestJourneyRun[],
  now: number,
): { entryPatch: Partial<QuestFeedbackEntry>; journeyRuns: QuestJourneyRun[] } {
  const phaseId = parsed.phaseId!;
  const runId = `manual-${phaseId}-${now}`;
  const occurrence: QuestPhaseOccurrence = {
    occurrenceId: `${runId}:p1`,
    phaseId,
    phaseIndex: 0,
    phasePosition: 1,
    phaseOccurrence: parsed.phaseOccurrence ?? 1,
    status: "manual",
    boardState: getQuestJourneyPhase(phaseId)?.boardState,
  };
  const run: QuestJourneyRun = {
    runId,
    source: "manual",
    phaseIds: [phaseId],
    status: "manual",
    createdAt: now,
    updatedAt: now,
    phaseOccurrences: [occurrence],
  };
  return { entryPatch: patchForOccurrence(run, occurrence), journeyRuns: [...existingRuns, run] };
}

function buildRunSnapshot(args: {
  quest: QuestmasterTask;
  row: BoardRow;
  leaderSessionId: string;
  authorSessionId?: string;
  phaseIds: QuestJourneyPhaseId[];
  activeIndex: number;
  now: number;
  existingRuns: QuestJourneyRun[];
}): QuestJourneyRun {
  const sourceBoardCreatedAt = args.row.createdAt;
  const runId = `board-${args.leaderSessionId.slice(0, 8)}-${sourceBoardCreatedAt}`;
  const existing = args.existingRuns.find((run) => run.runId === runId);
  const phaseOccurrences = args.phaseIds.map((phaseId, phaseIndex) => {
    const phasePosition = phaseIndex + 1;
    const previousSamePhase = args.phaseIds.slice(0, phaseIndex + 1).filter((candidate) => candidate === phaseId);
    const existingOccurrence = existing?.phaseOccurrences.find((occurrence) => occurrence.phaseIndex === phaseIndex);
    const timing = phaseOccurrenceTiming(args.row, phaseIndex);
    const startedAt = timing.startedAt ?? existingOccurrence?.startedAt;
    const completedAt = timing.completedAt ?? existingOccurrence?.completedAt;
    return {
      occurrenceId: existingOccurrence?.occurrenceId ?? `${runId}:p${phasePosition}`,
      phaseId,
      phaseIndex,
      phasePosition,
      phaseOccurrence: previousSamePhase.length,
      status: phaseIndex < args.activeIndex ? "completed" : phaseIndex === args.activeIndex ? "active" : "pending",
      boardState: getQuestJourneyPhase(phaseId)?.boardState,
      ...(phaseIndex === args.activeIndex && args.authorSessionId ? { assigneeSessionId: args.authorSessionId } : {}),
      ...(typeof args.row.workerNum === "number" ? { assigneeSessionNum: args.row.workerNum } : {}),
      ...(phaseIndex <= args.activeIndex && startedAt ? { startedAt } : {}),
      ...(phaseIndex < args.activeIndex && completedAt ? { completedAt } : {}),
    } satisfies QuestPhaseOccurrence;
  });
  return {
    runId,
    leaderSessionId: args.leaderSessionId,
    workerSessionId: args.row.worker ?? ("sessionId" in args.quest ? args.quest.sessionId : undefined),
    ...(typeof args.row.workerNum === "number" ? { workerSessionNum: args.row.workerNum } : {}),
    source: "board",
    sourceBoardSessionId: args.leaderSessionId,
    sourceBoardCreatedAt,
    phaseIds: args.phaseIds,
    status: args.row.completedAt ? "completed" : "active",
    createdAt: existing?.createdAt ?? args.row.createdAt,
    updatedAt: args.now,
    ...(args.row.completedAt ? { completedAt: args.row.completedAt } : {}),
    phaseOccurrences,
  };
}

function phaseOccurrenceTiming(row: BoardRow, phaseIndex: number): { startedAt?: number; completedAt?: number } {
  const timing = row.journey?.phaseTimings?.[String(phaseIndex)];
  const startedAt =
    typeof timing?.startedAt === "number" && Number.isFinite(timing.startedAt) && timing.startedAt > 0
      ? timing.startedAt
      : undefined;
  const completedAt =
    startedAt !== undefined &&
    typeof timing?.endedAt === "number" &&
    Number.isFinite(timing.endedAt) &&
    timing.endedAt >= startedAt
      ? timing.endedAt
      : undefined;
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

function resolvePhaseIndex(
  phaseIds: QuestJourneyPhaseId[],
  parsed: ParsedDocumentationRequest,
  activeIndex: number,
): { index: number } | { error: string } {
  if (parsed.phasePosition !== undefined) {
    const index = parsed.phasePosition - 1;
    if (index < 0 || index >= phaseIds.length)
      return { error: `Phase position ${parsed.phasePosition} is out of range.` };
    if (parsed.phaseId && phaseIds[index] !== parsed.phaseId) {
      return { error: `Phase position ${parsed.phasePosition} is ${phaseIds[index]}, not ${parsed.phaseId}.` };
    }
    return { index };
  }
  if (!parsed.phaseId) return { index: activeIndex };
  if (parsed.phaseOccurrence !== undefined) {
    const matches = getQuestJourneyPhaseIndices(phaseIds, parsed.phaseId);
    const index = matches[parsed.phaseOccurrence - 1];
    if (index === undefined) return { error: `${parsed.phaseId} occurrence ${parsed.phaseOccurrence} does not exist.` };
    return { index };
  }
  if (phaseIds[activeIndex] === parsed.phaseId) return { index: activeIndex };
  const matches = getQuestJourneyPhaseIndices(phaseIds, parsed.phaseId);
  if (matches.length === 1) return { index: matches[0]! };
  return { error: `Phase ${parsed.phaseId} is repeated; provide --phase-position or --phase-occurrence.` };
}

function patchForOccurrence(run: QuestJourneyRun, occurrence: QuestPhaseOccurrence): Partial<QuestFeedbackEntry> {
  return {
    kind: "phase_summary",
    journeyRunId: run.runId,
    phaseOccurrenceId: occurrence.occurrenceId,
    phaseId: occurrence.phaseId,
    phaseIndex: occurrence.phaseIndex,
    phasePosition: occurrence.phasePosition,
    phaseOccurrence: occurrence.phaseOccurrence,
  };
}

function occurrenceMatchesRequest(occurrence: QuestPhaseOccurrence, parsed: ParsedDocumentationRequest): boolean {
  if (parsed.phaseOccurrenceId && occurrence.occurrenceId !== parsed.phaseOccurrenceId) return false;
  if (parsed.phaseId && occurrence.phaseId !== parsed.phaseId) return false;
  if (parsed.phasePosition !== undefined && occurrence.phasePosition !== parsed.phasePosition) return false;
  if (parsed.phaseOccurrence !== undefined && occurrence.phaseOccurrence !== parsed.phaseOccurrence) return false;
  return true;
}

function parseKind(value: unknown): QuestFeedbackKind | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  return KIND_ALIASES[value.trim().toLowerCase()] ?? null;
}

function parsePositiveInteger(value: unknown, _label: string): number | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
