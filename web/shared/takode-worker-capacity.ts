import { DEFAULT_TAKODE_WORKER_CONCURRENCY, MAX_TAKODE_WORKER_CONCURRENCY } from "./takode-constants.js";

const WORKER_OWNED_BOARD_STAGES = new Set([
  "PLANNING",
  "EXPLORING",
  "IMPLEMENTING",
  "EXECUTING",
  "USER_CHECKPOINTING",
  "PORTING",
  "MEMORY",
  "BOOKKEEPING",
]);

export interface WorkerCapacityBoardRowLike {
  status?: string | null;
  worker?: string | null;
  workerNum?: number | null;
}

export interface WorkerCapacitySessionLike {
  sessionId?: string;
  sessionNum?: number | null;
  archived?: boolean;
  state?: string | null;
  cliConnected?: boolean;
  herdedBy?: string | null;
  reviewerOf?: number | null;
}

export interface LeaderWorkerCapacity {
  rawSlotsUsed: number;
  activeWorkerDemand: number;
  limit: number;
}

export function normalizeTakodeWorkerConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TAKODE_WORKER_CONCURRENCY;
  const next = Math.floor(value);
  if (next < 1) return DEFAULT_TAKODE_WORKER_CONCURRENCY;
  return Math.min(next, MAX_TAKODE_WORKER_CONCURRENCY);
}

export function isActiveWorkerOwnedBoardRow(row: WorkerCapacityBoardRowLike): boolean {
  const stage = (row.status || "").trim().toUpperCase();
  return WORKER_OWNED_BOARD_STAGES.has(stage);
}

export function getActiveWorkerOwnedBoardDemand(
  rows: Iterable<WorkerCapacityBoardRowLike> | null | undefined,
  sessions: Iterable<WorkerCapacitySessionLike> = [],
): number {
  if (!rows) return 0;
  const sessionsById = new Map<string, WorkerCapacitySessionLike>();
  const sessionsByNum = new Map<number, WorkerCapacitySessionLike>();
  for (const session of sessions) {
    if (session.sessionId) sessionsById.set(session.sessionId, session);
    if (typeof session.sessionNum === "number") sessionsByNum.set(session.sessionNum, session);
  }

  let activeRows = 0;
  for (const row of rows) {
    if (isActiveWorkerOwnedBoardRow(row) && hasUsableWorkerCapacityAssignment(row, sessionsById, sessionsByNum)) {
      activeRows += 1;
    }
  }
  return activeRows;
}

function hasUsableWorkerCapacityAssignment(
  row: WorkerCapacityBoardRowLike,
  sessionsById: Map<string, WorkerCapacitySessionLike>,
  sessionsByNum: Map<number, WorkerCapacitySessionLike>,
): boolean {
  const workerById = row.worker ? sessionsById.get(row.worker) : undefined;
  const workerByNum = typeof row.workerNum === "number" ? sessionsByNum.get(row.workerNum) : undefined;
  const worker = workerById ?? workerByNum;
  if (!worker) return !row.worker && typeof row.workerNum !== "number";
  if (worker.archived) return false;
  if (worker.cliConnected === false) return false;
  if (worker.state === "exited" || worker.state === "disconnected") return false;
  return true;
}

export function getRawHerdWorkerSlotsUsed(
  sessions: Iterable<WorkerCapacitySessionLike>,
  leaderSessionId: string,
): number {
  let rawSlotsUsed = 0;
  for (const session of sessions) {
    if (!session.archived && session.herdedBy === leaderSessionId && session.reviewerOf == null) {
      rawSlotsUsed += 1;
    }
  }
  return rawSlotsUsed;
}

export function getLeaderWorkerCapacity(input: {
  leaderSessionId: string;
  boardRows?: Iterable<WorkerCapacityBoardRowLike> | null;
  sessions: Iterable<WorkerCapacitySessionLike>;
  limit: number;
}): LeaderWorkerCapacity {
  return {
    rawSlotsUsed: getRawHerdWorkerSlotsUsed(input.sessions, input.leaderSessionId),
    activeWorkerDemand: getActiveWorkerOwnedBoardDemand(input.boardRows, input.sessions),
    limit: normalizeTakodeWorkerConcurrency(input.limit),
  };
}
