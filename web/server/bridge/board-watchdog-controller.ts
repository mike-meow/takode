import {
  DEFAULT_QUEST_JOURNEY_PHASE_IDS,
  FREE_WORKER_WAIT_FOR_TOKEN,
  formatWaitForRefLabel,
  getQuestJourneyPhase,
  getQuestJourneyPhaseForState,
  getWaitForRefKind,
  normalizeQuestJourneyPlan,
  normalizeQuestJourneyPhaseIds,
  type BoardQueueWarning,
  type QuestJourneyPhaseId,
} from "../../shared/quest-journey.js";
import { HERD_WORKER_SLOT_LIMIT } from "../../shared/takode-constants.js";
import type { BoardRow, TakodeEvent, TakodeHerdBatchSnapshot } from "../session-types.js";
import { formatRenderedHerdEventBatch } from "../herd-event-dispatcher.js";

type SessionLike = any;

const BOARD_STALL_THRESHOLD_MS = 3 * 60_000;

type BoardStallStatus = "running" | "idle" | "disconnected" | "missing";

interface BoardStallCandidate {
  signature: string;
  sourceSessionId: string;
  questId: string;
  title?: string;
  stage?: string;
  workerStatus: BoardStallStatus;
  reviewerStatus: BoardStallStatus;
  stalledSince: number;
  reason: string;
  action: string;
}

interface BoardDispatchableCandidate {
  signature: string;
  questId: string;
  title?: string;
  summary: string;
  action?: string;
}

export interface BoardWatchdogDeps {
  getLauncherSessionInfo: (sessionId: string) => any;
  getSession: (sessionId: string) => SessionLike | undefined;
  listSessions: () => any[];
  resolveSessionId: (ref: string) => string | undefined;
  timerCount: (sessionId: string) => number;
  backendConnected: (session: SessionLike) => boolean;
  getBoard: (sessionId: string) => BoardRow[];
  notifyUser: (
    sessionId: string,
    category: "needs-input" | "review",
    summary: string,
  ) => { ok: true; anchoredMessageId: string | null; notificationId: string } | { ok: false; error: string };
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  markNotificationDone: (sessionId: string, notifId: string, done: boolean) => boolean;
  isSessionIdle: (sessionId: string) => boolean;
}

export interface WorkBoardStateDeps {
  getBoardDispatchableSignature: (session: SessionLike, questId: string) => string | null;
  markNotificationDone: (sessionId: string, notifId: string, done: boolean) => boolean;
  broadcastBoard: (session: SessionLike, board: BoardRow[], completedBoard: BoardRow[]) => void;
  persistSession: (session: SessionLike) => void;
  notifyReview: (sessionId: string, summary: string) => void;
}

type BoardSessionsLike = Map<string, SessionLike>;

const LEGACY_NO_CODE_COMPAT_PHASE_IDS = [
  "planning",
  "implement",
  "code-review",
] as const satisfies readonly QuestJourneyPhaseId[];

export function getBoard(session: SessionLike): BoardRow[] {
  return Array.from(session.board.values() as Iterable<BoardRow>).sort((a, b) => a.createdAt - b.createdAt);
}

export function getBoardForSession(sessions: BoardSessionsLike, sessionId: string): BoardRow[] {
  const session = sessions.get(sessionId);
  if (!session) return [];
  return getBoard(session);
}

export function getBoardRowForSession(
  sessions: BoardSessionsLike,
  sessionId: string,
  questId: string,
): BoardRow | null {
  return sessions.get(sessionId)?.board.get(questId) ?? null;
}

export function getCompletedBoard(session: SessionLike): BoardRow[] {
  return Array.from(session.completedBoard.values() as Iterable<BoardRow>).sort(
    (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0),
  );
}

export function getCompletedBoardForSession(sessions: BoardSessionsLike, sessionId: string): BoardRow[] {
  const session = sessions.get(sessionId);
  if (!session) return [];
  return getCompletedBoard(session);
}

export function getCompletedBoardCountForSession(sessions: BoardSessionsLike, sessionId: string): number {
  return sessions.get(sessionId)?.completedBoard.size ?? 0;
}

export function getBoardStallSignatureForSession(
  sessions: BoardSessionsLike,
  sessionId: string,
  questId: string,
  deps: BoardWatchdogDeps,
): string | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return getBoardStallSignature(session, questId, deps);
}

export function getBoardDispatchableSignatureForSession(
  sessions: BoardSessionsLike,
  sessionId: string,
  questId: string,
  deps: BoardWatchdogDeps,
): string | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return getBoardDispatchableSignature(session, questId, deps);
}

export function getBoardQueueWarningsForSession(
  sessions: BoardSessionsLike,
  sessionId: string,
  deps: BoardWatchdogDeps,
): BoardQueueWarning[] {
  const session = sessions.get(sessionId);
  if (!session) return [];
  return getBoardQueueWarnings(session, deps);
}

export function getBoardWorkerSlotUsage(
  sessionId: string,
  deps: Pick<BoardWatchdogDeps, "listSessions">,
): { used: number; limit: number } {
  return {
    used: deps
      .listSessions()
      .filter(
        (candidate: any) =>
          !candidate.archived && candidate.herdedBy === sessionId && candidate.reviewerOf === undefined,
      ).length,
    limit: HERD_WORKER_SLOT_LIMIT,
  };
}

export function buildBoardCompletionSummary(rows: BoardRow[]): string {
  if (rows.length === 1) {
    const [row] = rows;
    return row.title ? `${row.questId} ready for review: ${row.title}` : `${row.questId} ready for review`;
  }
  return `${rows.length} quests ready for review: ${rows.map((row) => row.questId).join(", ")}`;
}

function getBoardRowPhaseIds(row: Pick<BoardRow, "journey" | "noCode">): QuestJourneyPhaseId[] {
  const explicitPhaseIds = normalizeQuestJourneyPhaseIds(row.journey?.phaseIds);
  if (explicitPhaseIds.length > 0) return explicitPhaseIds;
  return row.noCode === true ? [...LEGACY_NO_CODE_COMPAT_PHASE_IDS] : [...DEFAULT_QUEST_JOURNEY_PHASE_IDS];
}

function normalizeBoardRowJourneyPlan(
  row: Pick<BoardRow, "journey" | "noCode">,
  status?: string,
): NonNullable<BoardRow["journey"]> {
  return normalizeQuestJourneyPlan(
    {
      ...row.journey,
      phaseIds: getBoardRowPhaseIds(row),
    },
    status,
  );
}

function completeBoardRow(
  session: SessionLike,
  questId: string,
  deps: WorkBoardStateDeps,
): { board: BoardRow[]; completed: BoardRow | null } {
  const completed = moveBoardRowToCompleted(session, questId);
  const board = commitBoard(session, deps);
  if (completed) {
    deps.notifyReview(session.id, buildBoardCompletionSummary([completed]));
  }
  return { board, completed };
}

export function moveBoardRowToCompleted(session: SessionLike, questId: string): BoardRow | null {
  const row = session.board.get(questId);
  if (!row) return null;
  session.board.delete(questId);
  row.completedAt = Date.now();
  session.completedBoard.set(questId, row);
  return row;
}

export function clearResolvedQuestWaitFor(session: SessionLike, resolvedQuestIds: string[]): void {
  const resolved = new Set(resolvedQuestIds.map((questId) => questId.toLowerCase()));
  for (const row of session.board.values()) {
    if (!row.waitFor || row.waitFor.length === 0) continue;
    const nextWaitFor = row.waitFor.filter((dep: string) => !resolved.has(dep.toLowerCase()));
    const deduped = [...new Set<string>(nextWaitFor.map((dep: string) => dep.toLowerCase()))].map((dep) =>
      dep === FREE_WORKER_WAIT_FOR_TOKEN ? FREE_WORKER_WAIT_FOR_TOKEN : dep,
    );
    row.waitFor = deduped.length > 0 ? deduped : [FREE_WORKER_WAIT_FOR_TOKEN];
    session.board.set(row.questId, row);
  }
}

export function commitBoard(session: SessionLike, deps: WorkBoardStateDeps): BoardRow[] {
  for (const [questId] of [...session.boardDispatchStates.entries()]) {
    const row = session.board.get(questId);
    const candidateSignature = row ? deps.getBoardDispatchableSignature(session, row.questId) : null;
    if (!row || !candidateSignature) {
      const state = session.boardDispatchStates.get(questId);
      if (state?.notificationId) deps.markNotificationDone(session.id, state.notificationId, true);
      session.boardDispatchStates.delete(questId);
      continue;
    }
    const state = session.boardDispatchStates.get(questId);
    if (state && candidateSignature !== state.signature) {
      if (state.notificationId) deps.markNotificationDone(session.id, state.notificationId, true);
      session.boardDispatchStates.delete(questId);
    }
  }
  const board = getBoard(session);
  const completedBoard = getCompletedBoard(session);
  deps.broadcastBoard(session, board, completedBoard);
  deps.persistSession(session);
  return board;
}

export function upsertBoardRow(
  session: SessionLike,
  row: Omit<BoardRow, "updatedAt" | "createdAt"> & { updatedAt?: number },
  deps: WorkBoardStateDeps,
): BoardRow[] {
  const existing = session.board.get(row.questId);
  const mergeStr = (incoming: string | undefined, prior: string | undefined): string | undefined =>
    incoming !== undefined ? incoming || undefined : prior;
  const clearingWorker = row.worker !== undefined && !row.worker;
  const now = Date.now();
  const status = mergeStr(row.status, existing?.status);
  const noCode = row.noCode !== undefined ? row.noCode : existing?.noCode;
  const baseJourney =
    row.journey || existing?.journey
      ? {
          ...existing?.journey,
          ...row.journey,
          ...(row.journey?.revisionReason !== undefined
            ? {
                revisedAt: row.journey.revisedAt ?? now,
                revisionCount: (existing?.journey?.revisionCount ?? 0) + 1,
              }
            : {}),
        }
      : undefined;
  const merged: BoardRow = {
    questId: row.questId,
    title: mergeStr(row.title, existing?.title),
    worker: mergeStr(row.worker, existing?.worker),
    workerNum: clearingWorker ? undefined : (row.workerNum ?? existing?.workerNum),
    noCode,
    journey: normalizeBoardRowJourneyPlan({ journey: baseJourney, noCode }, status),
    status,
    waitFor: row.waitFor !== undefined ? (row.waitFor.length > 0 ? row.waitFor : undefined) : existing?.waitFor,
    createdAt: existing?.createdAt ?? now,
    updatedAt: row.updatedAt ?? now,
  };
  if (row.status !== undefined && (merged.status || "").trim() !== "QUEUED" && row.waitFor === undefined) {
    merged.waitFor = undefined;
  }
  session.board.set(row.questId, merged);
  return commitBoard(session, deps);
}

export function upsertBoardRowForSession(
  sessions: BoardSessionsLike,
  sessionId: string,
  row: Omit<BoardRow, "updatedAt" | "createdAt"> & { updatedAt?: number },
  deps: WorkBoardStateDeps,
): BoardRow[] | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return upsertBoardRow(session, row, deps);
}

export function removeBoardRows(session: SessionLike, questIds: string[], deps: WorkBoardStateDeps): BoardRow[] {
  const completedRows: BoardRow[] = [];
  for (const questId of questIds) {
    const completed = moveBoardRowToCompleted(session, questId);
    if (completed) completedRows.push(completed);
  }
  if (completedRows.length > 0) {
    clearResolvedQuestWaitFor(
      session,
      completedRows.map((row) => row.questId),
    );
  }
  const board = commitBoard(session, deps);
  if (completedRows.length > 0) {
    deps.notifyReview(session.id, buildBoardCompletionSummary(completedRows));
  }
  return board;
}

export function removeBoardRowsForSession(
  sessions: BoardSessionsLike,
  sessionId: string,
  questIds: string[],
  deps: WorkBoardStateDeps,
): BoardRow[] | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return removeBoardRows(session, questIds, deps);
}

export function removeBoardRowFromAllSessions(
  sessions: BoardSessionsLike,
  questId: string,
  deps: Pick<WorkBoardStateDeps, "broadcastBoard" | "persistSession">,
): void {
  for (const session of sessions.values()) {
    const hadActive = session.board.has(questId);
    const hadCompleted = session.completedBoard.has(questId);
    if (hadActive) session.board.delete(questId);
    if (hadCompleted) session.completedBoard.delete(questId);
    if (hadActive || hadCompleted) {
      clearResolvedQuestWaitFor(session, [questId]);
      const board = getBoard(session);
      const completedBoard = getCompletedBoard(session);
      deps.broadcastBoard(session, board, completedBoard);
      deps.persistSession(session);
    }
  }
}

export function advanceBoardRow(
  session: SessionLike,
  questId: string,
  states: readonly string[],
  deps: WorkBoardStateDeps,
):
  | { board: BoardRow[]; removed: boolean; previousState?: string; newState?: string }
  | { error: string; previousState?: string }
  | null {
  const row = session.board.get(questId);
  if (!row) return null;

  const currentIdx = states.indexOf(row.status ?? "");
  const previousState = row.status;
  const plannedPhaseIds = getBoardRowPhaseIds(row);
  const statusPhaseId = getQuestJourneyPhaseForState(row.status)?.id;
  const plannedCurrentPhaseId =
    row.journey?.currentPhaseId && plannedPhaseIds.includes(row.journey.currentPhaseId)
      ? row.journey.currentPhaseId
      : undefined;
  const normalizedStatus = typeof row.status === "string" ? row.status.trim().toUpperCase() : "";
  if (
    (normalizedStatus === "QUEUED" && plannedCurrentPhaseId) ||
    (statusPhaseId && plannedCurrentPhaseId && statusPhaseId !== plannedCurrentPhaseId)
  ) {
    const phaseLabel = plannedCurrentPhaseId ?? "none";
    const statusLabel = normalizedStatus || row.status || "none";
    return {
      error: `Cannot advance ${questId}: board status ${statusLabel} disagrees with journey.currentPhaseId ${phaseLabel}. Reconcile the row with takode board set --status before advancing.`,
      previousState,
    };
  }
  const currentPhaseId = statusPhaseId ?? plannedCurrentPhaseId;
  const currentPhaseIdx = currentPhaseId ? plannedPhaseIds.indexOf(currentPhaseId) : -1;

  if (currentPhaseIdx >= 0 && currentPhaseIdx >= plannedPhaseIds.length - 1) {
    const { board } = completeBoardRow(session, questId, deps);
    return { board, removed: true, previousState, newState: undefined };
  }

  if (row.status === "QUEUED" || currentPhaseIdx >= 0) {
    const nextPhaseId = plannedPhaseIds[currentPhaseIdx + 1] ?? plannedPhaseIds[0];
    const nextPhase = getQuestJourneyPhase(nextPhaseId);
    if (nextPhase) {
      row.status = nextPhase.boardState;
      row.journey = normalizeBoardRowJourneyPlan(
        {
          noCode: row.noCode,
          journey: {
            presetId: row.journey?.presetId,
            phaseIds: plannedPhaseIds,
            currentPhaseId: nextPhase.id,
            revisionReason: row.journey?.revisionReason,
            revisedAt: row.journey?.revisedAt,
            revisionCount: row.journey?.revisionCount,
          },
        },
        nextPhase.boardState,
      );
      if (row.status !== "QUEUED") row.waitFor = undefined;
      row.updatedAt = Date.now();
      session.board.set(questId, row);
      const board = commitBoard(session, deps);
      return { board, removed: false, previousState, newState: row.status };
    }
  }

  if (currentIdx >= states.length - 1) {
    const { board } = completeBoardRow(session, questId, deps);
    return { board, removed: true, previousState, newState: undefined };
  }

  row.status = currentIdx === -1 ? states[0] : states[currentIdx + 1];
  row.journey = normalizeBoardRowJourneyPlan(row, row.status);
  if (row.status !== "QUEUED") row.waitFor = undefined;
  row.updatedAt = Date.now();
  session.board.set(questId, row);
  const board = commitBoard(session, deps);
  return { board, removed: false, previousState, newState: row.status };
}

export function advanceBoardRowNoGroom(
  session: SessionLike,
  questId: string,
  _deps: WorkBoardStateDeps,
):
  | { board: BoardRow[]; removed: boolean; previousState?: string; newState?: string; skippedStates?: string[] }
  | { error: string; previousState?: string }
  | null {
  const row = session.board.get(questId);
  if (!row) return null;

  const previousState = row.status;
  return {
    error:
      "The no-code board shortcut was removed. Model zero-tracked-change work with an explicit Quest Journey that omits `port`, then use standard board advance.",
    previousState,
  };
}

export function advanceBoardRowForSession(
  sessions: BoardSessionsLike,
  sessionId: string,
  questId: string,
  states: readonly string[],
  deps: WorkBoardStateDeps,
):
  | { board: BoardRow[]; removed: boolean; previousState?: string; newState?: string }
  | { error: string; previousState?: string }
  | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  return advanceBoardRow(session, questId, states, deps);
}

export function getBoardQueueWarnings(session: SessionLike, deps: BoardWatchdogDeps): BoardQueueWarning[] {
  return deps
    .getBoard(session.id)
    .map((row) => buildQueuedBoardWarning(session, row, deps))
    .filter((warning): warning is BoardQueueWarning => warning !== null);
}

export function getBoardDispatchableSignature(
  session: SessionLike,
  questId: string,
  deps: BoardWatchdogDeps,
): string | null {
  const row = session.board.get(questId);
  if (!row) return null;
  return buildBoardDispatchableCandidate(session, row, deps)?.signature ?? null;
}

export function getBoardStallSignature(session: SessionLike, questId: string, deps: BoardWatchdogDeps): string | null {
  const row = session.board.get(questId);
  if (!row) return null;
  return buildBoardStallCandidate(session, row, deps)?.signature ?? null;
}

export function sweepBoardStallWarnings(sessions: Iterable<SessionLike>, now: number, deps: BoardWatchdogDeps): void {
  for (const session of sessions) {
    const launcherInfo = deps.getLauncherSessionInfo(session.id);
    if (!launcherInfo?.isOrchestrator) continue;

    const activeQuestIds = new Set(session.board.keys());
    for (const questId of [...session.boardStallStates.keys()]) {
      if (!activeQuestIds.has(questId)) session.boardStallStates.delete(questId);
    }

    for (const row of session.board.values()) {
      const candidate = buildBoardStallCandidate(session, row, deps);
      if (!candidate) {
        session.boardStallStates.delete(row.questId);
        continue;
      }

      const existing = session.boardStallStates.get(row.questId);
      if (!existing || existing.signature !== candidate.signature) {
        session.boardStallStates.set(row.questId, {
          signature: candidate.signature,
          stalledSince: candidate.stalledSince,
          warnedAt: null,
        });
        continue;
      }

      if (existing.warnedAt) continue;
      if (now - existing.stalledSince < BOARD_STALL_THRESHOLD_MS) continue;

      deps.emitTakodeEvent(candidate.sourceSessionId, "board_stalled", {
        questId: candidate.questId,
        ...(candidate.title ? { title: candidate.title } : {}),
        ...(candidate.stage ? { stage: candidate.stage } : {}),
        signature: candidate.signature,
        workerStatus: candidate.workerStatus,
        reviewerStatus: candidate.reviewerStatus,
        stalledForMs: now - existing.stalledSince,
        reason: candidate.reason,
        action: candidate.action,
      });
      existing.warnedAt = now;
    }
  }
}

export function sweepBoardDispatchableWarnings(
  sessions: Iterable<SessionLike>,
  now: number,
  deps: BoardWatchdogDeps,
): void {
  for (const session of sessions) {
    const launcherInfo = deps.getLauncherSessionInfo(session.id);
    if (!launcherInfo?.isOrchestrator) continue;

    const activeQuestIds = new Set(session.board.keys());
    for (const questId of [...session.boardDispatchStates.keys()]) {
      if (!activeQuestIds.has(questId)) retireBoardDispatchState(session, questId, deps);
    }

    for (const row of session.board.values()) {
      const candidate = buildBoardDispatchableCandidate(session, row, deps);
      if (!candidate) {
        retireBoardDispatchState(session, row.questId, deps);
        continue;
      }

      const existing = session.boardDispatchStates.get(row.questId);
      if (!existing || existing.signature !== candidate.signature) {
        retireBoardDispatchState(session, row.questId, deps);
        session.boardDispatchStates.set(row.questId, {
          signature: candidate.signature,
          warnedAt: null,
          notificationId: null,
        });
      }

      const current = session.boardDispatchStates.get(row.questId);
      if (!current || current.warnedAt) continue;
      const shouldNotifyLeader = (row.waitFor ?? []).some((dep: string) => getWaitForRefKind(dep) === "free-worker");
      if (shouldNotifyLeader) {
        const notifResult = deps.notifyUser(session.id, "needs-input", candidate.summary);
        if (notifResult.ok) current.notificationId = notifResult.notificationId;
      }
      const sourceSessionId = findBoardDispatchSourceSessionId(session, row, deps);
      if (sourceSessionId) {
        deps.emitTakodeEvent(sourceSessionId, "board_dispatchable", {
          questId: candidate.questId,
          ...(candidate.title ? { title: candidate.title } : {}),
          signature: candidate.signature,
          summary: candidate.summary,
          ...(candidate.action ? { action: candidate.action } : {}),
        });
      }
      current.warnedAt = now;
    }
  }
}

export function pruneStalePendingCodexHerdInputs(
  session: SessionLike,
  reason: string,
  deps: Pick<BoardWatchdogDeps, "emitTakodeEvent">,
  helpers: {
    broadcastPendingCodexInputs: (session: SessionLike) => void;
    rebuildQueuedCodexPendingStartBatch: (session: SessionLike) => void;
    persistSession: (session: SessionLike) => void;
  },
): boolean {
  let changed = false;
  const nextInputs: any[] = [];

  for (const input of session.pendingCodexInputs) {
    const pruned = pruneStaleBoardStalledHerdBatch(session, input.takodeHerdBatch, { ...deps, ...helpers } as any);
    if (!pruned.changed) {
      nextInputs.push(input);
      continue;
    }

    changed = true;
    if (!pruned.batch || !pruned.content) continue;

    input.content = pruned.content;
    if (input.deliveryContent) input.deliveryContent = pruned.content;
    input.takodeHerdBatch = pruned.batch;
    nextInputs.push(input);
  }

  if (!changed) return false;

  session.pendingCodexInputs = nextInputs;
  helpers.broadcastPendingCodexInputs(session);
  helpers.rebuildQueuedCodexPendingStartBatch(session);
  helpers.persistSession(session);
  console.log(`[ws-bridge] Pruned stale queued board_stalled herd input(s) for session ${session.id} (${reason})`);
  return true;
}

export function pruneStaleBoardStalledHerdBatch(
  session: SessionLike,
  batch: TakodeHerdBatchSnapshot | undefined,
  deps: BoardWatchdogDeps,
): { batch?: TakodeHerdBatchSnapshot; content?: string; changed: boolean } {
  if (!batch || batch.events.length === 0) return { batch, changed: false };

  const keptEvents: TakodeEvent[] = [];
  const keptRenderedLines: string[] = [];
  let changed = false;

  for (let i = 0; i < batch.events.length; i++) {
    const event = batch.events[i];
    const renderedLine = batch.renderedLines[i] ?? "";
    if (!isLiveBoardStalledEvent(session, event, deps)) {
      changed = true;
      continue;
    }
    keptEvents.push(event);
    keptRenderedLines.push(renderedLine);
  }

  if (!changed) return { batch, changed: false };
  if (keptEvents.length === 0) return { changed: true };

  return {
    changed: true,
    batch: { events: keptEvents, renderedLines: keptRenderedLines },
    content: formatRenderedHerdEventBatch(keptEvents, keptRenderedLines),
  };
}

function retireBoardDispatchState(session: SessionLike, questId: string, deps: BoardWatchdogDeps): void {
  const state = session.boardDispatchStates.get(questId);
  if (!state) return;
  if (state.notificationId) deps.markNotificationDone(session.id, state.notificationId, true);
  session.boardDispatchStates.delete(questId);
}

function getBlockedBoardDeps(session: SessionLike, row: BoardRow, deps: BoardWatchdogDeps): string[] {
  const activeQuestIds = new Set(session.board.keys());
  const blocked: string[] = [];
  const workerSlotsUsed = getLeaderWorkerSlotUsage(session.id, deps);
  for (const dep of row.waitFor ?? []) {
    switch (getWaitForRefKind(dep)) {
      case "session": {
        const sessionId = deps.resolveSessionId(dep.slice(1));
        if (!sessionId || !deps.isSessionIdle(sessionId)) blocked.push(dep);
        break;
      }
      case "quest":
        if (activeQuestIds.has(dep)) blocked.push(dep);
        break;
      case "free-worker":
        if (workerSlotsUsed >= HERD_WORKER_SLOT_LIMIT) blocked.push(dep);
        break;
      default:
        blocked.push(dep);
        break;
    }
  }
  return blocked;
}

function buildQueuedBoardWarning(
  session: SessionLike,
  row: BoardRow,
  deps: BoardWatchdogDeps,
): BoardQueueWarning | null {
  if ((row.status || "").trim() !== "QUEUED") return null;
  const waitFor = row.waitFor ?? [];
  const title = row.title?.trim() || undefined;

  if (waitFor.length === 0) {
    return {
      questId: row.questId,
      title,
      kind: "missing_wait_for",
      summary: `${row.questId} is QUEUED without an explicit wait-for reason.`,
      action: `Set --wait-for q-N, #N, or ${FREE_WORKER_WAIT_FOR_TOKEN}.`,
    };
  }

  const blockedDeps = getBlockedBoardDeps(session, row, deps);
  if (blockedDeps.length > 0) return null;

  const labels = waitFor.map((dep) => formatWaitForRefLabel(dep));
  const workerSlotsUsed = getLeaderWorkerSlotUsage(session.id, deps);
  const hasFreeWorkerWait = waitFor.some((dep) => getWaitForRefKind(dep) === "free-worker");
  const summary = hasFreeWorkerWait
    ? `${row.questId} can be dispatched now: worker slots are available (${workerSlotsUsed}/${HERD_WORKER_SLOT_LIMIT} used).`
    : `${row.questId} can be dispatched now: wait-for resolved (${labels.join(", ")}).`;
  return {
    questId: row.questId,
    title,
    kind: "dispatchable",
    summary,
    action: "Dispatch it now or replace QUEUED with the next active Quest Journey phase.",
  };
}

function resolveCompletedQuestWorkerSessionId(
  session: SessionLike,
  questId: string,
  deps: BoardWatchdogDeps,
): string | undefined {
  const completedRow = session.completedBoard.get(questId);
  return resolveBoardSessionId(completedRow?.worker, completedRow?.workerNum, deps);
}

function findBoardDispatchSourceSessionId(
  session: SessionLike,
  row: BoardRow,
  deps: BoardWatchdogDeps,
): string | undefined {
  return (row.waitFor ?? [])
    .map((dep) => {
      const kind = getWaitForRefKind(dep);
      if (kind === "session") return deps.resolveSessionId(dep.slice(1)) ?? undefined;
      if (kind === "quest") return resolveCompletedQuestWorkerSessionId(session, dep, deps);
      return undefined;
    })
    .find((sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0);
}

function buildBoardDispatchableCandidate(
  session: SessionLike,
  row: BoardRow,
  deps: BoardWatchdogDeps,
): BoardDispatchableCandidate | null {
  const warning = buildQueuedBoardWarning(session, row, deps);
  if (!warning || warning.kind !== "dispatchable") return null;
  const waitFor = row.waitFor ?? [];
  if (waitFor.length === 0) return null;

  return {
    signature: `${row.questId}|dispatchable|${waitFor
      .map((dep) => dep.toLowerCase())
      .sort()
      .join(",")}`,
    questId: row.questId,
    title: row.title?.trim() || undefined,
    summary: warning.summary,
    action: warning.action,
  };
}

function buildBoardStallCandidate(
  session: SessionLike,
  row: BoardRow,
  deps: BoardWatchdogDeps,
): BoardStallCandidate | null {
  const stage = (row.status || "").trim();
  if (!stage || stage === "QUEUED") return null;
  if (getBlockedBoardDeps(session, row, deps).length > 0) return null;

  const workerSessionId = resolveBoardSessionId(row.worker, row.workerNum, deps);
  const workerRuntime = getBoardParticipantRuntime(workerSessionId, deps, session);
  const reviewerSessionId = resolveBoardReviewerSessionId(row.workerNum, deps);
  const reviewerRuntime = getBoardParticipantRuntime(reviewerSessionId, deps, session);

  const stalledSinceFrom = (...times: number[]) => Math.max(row.updatedAt, ...times, 0);
  const title = row.title?.trim() || undefined;

  if (
    stage === "PLANNING" ||
    stage === "EXPLORING" ||
    stage === "IMPLEMENTING" ||
    stage === "EXECUTING" ||
    stage === "BOOKKEEPING" ||
    stage === "PORTING"
  ) {
    if (!workerSessionId || workerRuntime.hasActiveTimer || workerRuntime.status === "running") return null;
    return {
      signature: `${row.questId}|${stage}|${workerRuntime.status}`,
      sourceSessionId: workerSessionId,
      questId: row.questId,
      title,
      stage,
      workerStatus: workerRuntime.status,
      reviewerStatus: reviewerRuntime.status,
      stalledSince: stalledSinceFrom(workerRuntime.lastActivityAt),
      reason: `worker ${workerRuntime.status}`,
      action:
        stage === "PLANNING"
          ? "inspect worker; review plan or re-dispatch"
          : stage === "EXPLORING"
            ? "inspect worker; review findings or revise the Journey"
            : stage === "IMPLEMENTING"
              ? "inspect worker; resume or re-dispatch before review"
              : stage === "EXECUTING"
                ? "inspect worker; review monitor state or stop conditions"
                : stage === "BOOKKEEPING"
                  ? "inspect worker; refresh shared state or re-dispatch"
                  : "inspect worker; resume port or remove if already synced",
    };
  }

  if (stage === "CODE_REVIEWING" || stage === "MENTAL_SIMULATING" || stage === "OUTCOME_REVIEWING") {
    if (reviewerSessionId) {
      if (reviewerRuntime.hasActiveTimer || reviewerRuntime.status === "running") return null;
      return {
        signature: `${row.questId}|${stage}|reviewer|${reviewerRuntime.status}`,
        sourceSessionId: workerSessionId || reviewerSessionId,
        questId: row.questId,
        title,
        stage,
        workerStatus: workerRuntime.status,
        reviewerStatus: reviewerRuntime.status,
        stalledSince: stalledSinceFrom(workerRuntime.lastActivityAt, reviewerRuntime.lastActivityAt),
        reason: `reviewer ${reviewerRuntime.status}`,
        action:
          stage === "CODE_REVIEWING"
            ? "inspect reviewer; re-dispatch code review if needed"
            : stage === "MENTAL_SIMULATING"
              ? "inspect reviewer; re-dispatch mental simulation if needed"
              : "inspect reviewer; re-dispatch outcome review if needed",
      };
    }
    if (!workerSessionId || workerRuntime.hasActiveTimer || workerRuntime.status === "running") return null;
    return {
      signature: `${row.questId}|${stage}|reviewer-missing|${workerRuntime.status}`,
      sourceSessionId: workerSessionId,
      questId: row.questId,
      title,
      stage,
      workerStatus: workerRuntime.status,
      reviewerStatus: "missing",
      stalledSince: stalledSinceFrom(workerRuntime.lastActivityAt),
      reason: "reviewer missing",
      action:
        stage === "CODE_REVIEWING"
          ? "attach code reviewer"
          : stage === "MENTAL_SIMULATING"
            ? "attach mental-simulation reviewer"
            : "attach outcome reviewer",
    };
  }

  return null;
}

function resolveBoardSessionId(
  sessionId: string | undefined,
  sessionNum: number | undefined,
  deps: BoardWatchdogDeps,
): string | undefined {
  if (sessionId) return sessionId;
  if (sessionNum === undefined) return undefined;
  const byRef = deps.resolveSessionId(String(sessionNum));
  if (byRef) return byRef;
  return deps.listSessions().find((candidate: any) => candidate.sessionNum === sessionNum && !candidate.archived)
    ?.sessionId;
}

function resolveBoardReviewerSessionId(workerNum: number | undefined, deps: BoardWatchdogDeps): string | undefined {
  if (workerNum === undefined) return undefined;
  return deps.listSessions().find((candidate: any) => candidate.reviewerOf === workerNum && !candidate.archived)
    ?.sessionId;
}

function getLeaderWorkerSlotUsage(sessionId: string, deps: BoardWatchdogDeps): number {
  return deps
    .listSessions()
    .filter(
      (candidate: any) => !candidate.archived && candidate.herdedBy === sessionId && candidate.reviewerOf === undefined,
    ).length;
}

function getBoardParticipantRuntime(
  sessionId: string | undefined,
  deps: BoardWatchdogDeps,
  currentSession: SessionLike,
): { status: BoardStallStatus; lastActivityAt: number; hasActiveTimer: boolean } {
  if (!sessionId) return { status: "missing", lastActivityAt: 0, hasActiveTimer: false };
  const launcherInfo = deps.getLauncherSessionInfo(sessionId);
  if (launcherInfo?.archived) {
    return { status: "missing", lastActivityAt: launcherInfo.lastActivityAt ?? 0, hasActiveTimer: false };
  }

  const session = sessionId === currentSession.id ? currentSession : deps.getSession(sessionId);
  const hasActiveTimer = deps.timerCount(sessionId) > 0;
  if (!session || !deps.backendConnected(session)) {
    return {
      status: launcherInfo ? "disconnected" : "missing",
      lastActivityAt: launcherInfo?.lastActivityAt ?? 0,
      hasActiveTimer,
    };
  }
  if (session.isGenerating || (session.pendingPermissions?.size ?? 0) > 0) {
    return { status: "running", lastActivityAt: launcherInfo?.lastActivityAt ?? 0, hasActiveTimer };
  }
  return { status: "idle", lastActivityAt: launcherInfo?.lastActivityAt ?? 0, hasActiveTimer };
}

function isLiveBoardStalledEvent(session: SessionLike, event: TakodeEvent, deps: BoardWatchdogDeps): boolean {
  if (event.event !== "board_stalled") return true;
  const row = session.board.get(event.data.questId);
  if (!row) return false;
  if (event.data.stage && row.status !== event.data.stage) return false;
  if (!event.data.signature) return true;
  return buildBoardStallCandidate(session, row, deps)?.signature === event.data.signature;
}
