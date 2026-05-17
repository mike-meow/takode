import type { TimerSweepResult } from "./timer-manager.js";

export type StartupRecoveryReason =
  | "restart_continuation"
  | "pending_messages"
  | "pending_codex_inputs"
  | "pending_codex_turns"
  | "pending_codex_recovery"
  | "pending_herd_delivery"
  | "active_dead_backend"
  | "due_timer";

export interface StartupRecoveryLauncherSession {
  sessionId: string;
  archived?: boolean;
  backendType?: string;
  createdAt?: number;
  exitCode?: number | null;
  killedByIdleManager?: boolean;
  lastActivityAt?: number;
  state?: string;
}

export interface StartupRecoverySession {
  state?: { backend_state?: string };
  backendType?: string;
  pendingMessages?: string[];
  pendingCodexInputs?: Array<{
    id?: string;
    agentSource?: { sessionId?: string; sessionLabel?: string };
  }>;
  pendingCodexTurns?: Array<{
    status?: string;
    adapterMsg?: {
      type?: string;
      agentSource?: { sessionId?: string; sessionLabel?: string };
    };
    pendingInputIds?: string[];
    userMessageId?: string;
  }>;
  pendingCodexRollback?: unknown;
  pendingPermissions?: { size?: number };
}

export interface StartupRecoveryTimerManager {
  getDueTimerSessionIds: (now?: number) => string[];
  sweepDueTimersNow: (now?: number) => Promise<TimerSweepResult>;
}

export interface StartupRecoveryRelaunchRequest {
  delayMs?: number;
  reason?: StartupRecoveryReason;
}

export interface StartupRecoveryDeps {
  listLauncherSessions: () => StartupRecoveryLauncherSession[];
  getSession: (sessionId: string) => StartupRecoverySession | undefined;
  isBackendConnected: (sessionId: string) => boolean;
  isBackendAttached?: (sessionId: string) => boolean;
  isSessionPaused?: (sessionId: string) => boolean;
  requestCliRelaunch?: (sessionId: string, request?: StartupRecoveryRelaunchRequest) => void;
  timerManager?: StartupRecoveryTimerManager;
  restartContinuationSessionIds?: string[];
  alreadyRequestedRelaunchSessionIds?: Iterable<string>;
  activeRecoveryLimit?: number;
  activeRecoverySpacingMs?: number;
  now?: number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface StartupRecoverySessionResult {
  sessionId: string;
  reasons: StartupRecoveryReason[];
  requestedRelaunch: boolean;
  requestedRelaunchDelayMs?: number;
  clearedIdleKilled: boolean;
  skippedReason?:
    | "active_recovery_limit"
    | "already_connected"
    | "idle_killed"
    | "no_relaunch_callback"
    | "relaunch_already_requested"
    | "recovery_suppressed"
    | "session_paused";
}

export interface StartupRecoveryResult {
  recovered: StartupRecoverySessionResult[];
  timerSweep: TimerSweepResult | null;
}

type ActiveDeadBackendEligibilityDeps = Pick<
  StartupRecoveryDeps,
  "getSession" | "isBackendAttached" | "isBackendConnected" | "isSessionPaused"
>;

export interface StartupRecoveryRelaunchExecutionDeps {
  getLauncherSession: (sessionId: string) => StartupRecoveryLauncherSession | undefined;
  getSession: (sessionId: string) => StartupRecoverySession | undefined;
  isBackendConnected: (sessionId: string) => boolean;
  isBackendAttached?: (sessionId: string) => boolean;
  isSessionPaused?: (sessionId: string) => boolean;
  requestCliRelaunch?: (sessionId: string) => void;
  requestCodexAutoRecovery?: (session: StartupRecoverySession, reason: string) => boolean;
}

export function requestStartupRecoveryRelaunch(
  sessionId: string,
  request: StartupRecoveryRelaunchRequest | undefined,
  deps: StartupRecoveryRelaunchExecutionDeps,
): void {
  const requestRecovery = () => {
    if (request?.reason === "active_dead_backend") {
      const launcherSession = deps.getLauncherSession(sessionId);
      if (!launcherSession || !isActiveDeadBackendCandidate(launcherSession, deps)) return;
      const session = deps.getSession(sessionId);
      if (session?.backendType === "codex") {
        if (deps.requestCodexAutoRecovery) {
          deps.requestCodexAutoRecovery(session, "startup_active_dead_backend");
          return;
        }
      }
    }
    deps.requestCliRelaunch?.(sessionId);
  };

  if (request?.delayMs && request.delayMs > 0) {
    setTimeout(requestRecovery, request.delayMs);
    return;
  }
  requestRecovery();
}

export async function runStartupRecovery(deps: StartupRecoveryDeps): Promise<StartupRecoveryResult> {
  const now = deps.now ?? Date.now();
  const dueTimerSessionIds = new Set(deps.timerManager?.getDueTimerSessionIds(now) ?? []);
  const timerSweep = deps.timerManager ? await deps.timerManager.sweepDueTimersNow(now) : null;
  const restartContinuationSessionIds = new Set(deps.restartContinuationSessionIds ?? []);
  const alreadyRequestedRelaunchSessionIds = new Set(deps.alreadyRequestedRelaunchSessionIds ?? []);
  const activeDeadBackendSessionIds = selectActiveDeadBackendSessionIds(deps);
  let activeDeadBackendRequestIndex = 0;

  const recovered: StartupRecoverySessionResult[] = [];
  for (const launcherSession of deps.listLauncherSessions()) {
    if (launcherSession.archived) continue;

    const session = deps.getSession(launcherSession.sessionId);
    if (!session) continue;

    const reasons = collectStartupRecoveryReasons(session, {
      hasDueTimer: dueTimerSessionIds.has(launcherSession.sessionId),
      hasRestartContinuation: restartContinuationSessionIds.has(launcherSession.sessionId),
      hasActiveDeadBackend: activeDeadBackendSessionIds.has(launcherSession.sessionId),
    });
    if (reasons.length === 0) continue;

    const result: StartupRecoverySessionResult = {
      sessionId: launcherSession.sessionId,
      reasons,
      requestedRelaunch: false,
      clearedIdleKilled: false,
    };

    if (deps.isBackendConnected(launcherSession.sessionId)) {
      result.skippedReason = "already_connected";
      recovered.push(result);
      continue;
    }

    if (deps.isSessionPaused?.(launcherSession.sessionId)) {
      result.skippedReason = "session_paused";
      recovered.push(result);
      continue;
    }

    if (session.state?.backend_state === "recovery_suppressed" || session.state?.backend_state === "broken") {
      result.skippedReason = "recovery_suppressed";
      recovered.push(result);
      continue;
    }

    if (alreadyRequestedRelaunchSessionIds.has(launcherSession.sessionId)) {
      result.skippedReason = "relaunch_already_requested";
      recovered.push(result);
      continue;
    }

    if (!deps.requestCliRelaunch) {
      result.skippedReason = "no_relaunch_callback";
      recovered.push(result);
      continue;
    }

    if (launcherSession.killedByIdleManager) {
      if (reasons.length === 1 && reasons[0] === "active_dead_backend") {
        result.skippedReason = "idle_killed";
        recovered.push(result);
        continue;
      }
      launcherSession.killedByIdleManager = false;
      result.clearedIdleKilled = true;
    }

    const activeDeadOnly = reasons.length === 1 && reasons[0] === "active_dead_backend";
    const delayMs = activeDeadOnly ? activeDeadBackendRequestIndex * (deps.activeRecoverySpacingMs ?? 1500) : 0;
    if (activeDeadOnly) {
      deps.requestCliRelaunch(launcherSession.sessionId, { delayMs, reason: "active_dead_backend" });
    } else {
      deps.requestCliRelaunch(launcherSession.sessionId);
    }
    if (delayMs > 0) result.requestedRelaunchDelayMs = delayMs;
    if (activeDeadOnly) activeDeadBackendRequestIndex++;
    result.requestedRelaunch = true;
    recovered.push(result);
  }

  if (recovered.length > 0 || (timerSweep && (timerSweep.fired.length > 0 || timerSweep.skipped.length > 0))) {
    deps.log?.("Startup recovery scanned restored server-owned work", {
      recovered: recovered.length,
      timerFired: timerSweep?.fired.length ?? 0,
      timerSkipped: timerSweep?.skipped.length ?? 0,
    });
  }

  return { recovered, timerSweep };
}

export function collectStartupRecoveryReasons(
  session: StartupRecoverySession,
  options: { hasActiveDeadBackend?: boolean; hasDueTimer?: boolean; hasRestartContinuation?: boolean } = {},
): StartupRecoveryReason[] {
  const reasons = new Set<StartupRecoveryReason>();

  if (options.hasRestartContinuation) reasons.add("restart_continuation");
  if (options.hasDueTimer) reasons.add("due_timer");
  if (options.hasActiveDeadBackend) reasons.add("active_dead_backend");

  const pendingMessages = session.pendingMessages ?? [];
  if (pendingMessages.length > 0) reasons.add("pending_messages");

  const pendingCodexInputs = session.pendingCodexInputs ?? [];
  if (pendingCodexInputs.length > 0) reasons.add("pending_codex_inputs");

  const pendingCodexTurns = (session.pendingCodexTurns ?? []).filter((turn) => turn.status !== "completed");
  if (pendingCodexTurns.length > 0) reasons.add("pending_codex_turns");

  if (session.pendingCodexRollback) reasons.add("pending_codex_recovery");

  if (hasDurablePendingHerdDelivery(session)) reasons.add("pending_herd_delivery");

  return [...reasons];
}

function selectActiveDeadBackendSessionIds(deps: StartupRecoveryDeps): Set<string> {
  const limit = deps.activeRecoveryLimit ?? 0;
  if (limit <= 0) return new Set();

  const candidates = deps
    .listLauncherSessions()
    .filter((launcherSession) => isActiveDeadBackendCandidate(launcherSession, deps))
    .sort(
      (left, right) => (right.lastActivityAt ?? right.createdAt ?? 0) - (left.lastActivityAt ?? left.createdAt ?? 0),
    )
    .slice(0, limit)
    .map((launcherSession) => launcherSession.sessionId);

  return new Set(candidates);
}

function isActiveDeadBackendCandidate(
  launcherSession: StartupRecoveryLauncherSession,
  deps: ActiveDeadBackendEligibilityDeps,
): boolean {
  if (launcherSession.archived || launcherSession.killedByIdleManager) return false;
  if (launcherSession.backendType !== "codex") return false;
  if (launcherSession.state !== "exited" || launcherSession.exitCode !== -1) return false;
  if (deps.isBackendConnected(launcherSession.sessionId)) return false;
  if (deps.isBackendAttached?.(launcherSession.sessionId)) return false;
  if (deps.isSessionPaused?.(launcherSession.sessionId)) return false;
  const session = deps.getSession(launcherSession.sessionId);
  if (!session) return false;
  if (session.state?.backend_state === "broken" || session.state?.backend_state === "recovery_suppressed") {
    return false;
  }
  return true;
}

function hasDurablePendingHerdDelivery(session: StartupRecoverySession): boolean {
  const pendingInputIdsByHerdSource = new Set(
    (session.pendingCodexInputs ?? [])
      .filter((input) => input.agentSource?.sessionId === "herd-events" && input.id)
      .map((input) => input.id as string),
  );

  if (pendingInputIdsByHerdSource.size > 0) return true;

  for (const raw of session.pendingMessages ?? []) {
    const message = parseQueuedMessage(raw);
    if (message?.type === "user_message" && message.agentSource?.sessionId === "herd-events") return true;
  }

  for (const turn of session.pendingCodexTurns ?? []) {
    if (turn.status === "completed") continue;
    if (turn.adapterMsg?.agentSource?.sessionId === "herd-events") return true;

    const inputIds = turn.pendingInputIds ?? (turn.userMessageId ? [turn.userMessageId] : []);
    if (inputIds.some((id) => pendingInputIdsByHerdSource.has(id))) return true;
  }

  return false;
}

function parseQueuedMessage(raw: string): { type?: string; agentSource?: { sessionId?: string } } | null {
  try {
    const parsed = JSON.parse(raw) as { type?: string; agentSource?: { sessionId?: string } };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
