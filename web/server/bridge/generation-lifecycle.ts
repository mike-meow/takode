import { sessionTag } from "../session-tag.js";
import type { ActiveTurnRoute } from "../session-types.js";

/** Reasons that indicate the turn ended due to recovery/error, not a normal result.
 *  Queued turns should be drained (not promoted) for these reasons because the CLI
 *  that would process them is either dead, stuck, or was replaced by a new process. */
export const RECOVERY_REASONS = new Set([
  "stuck_auto_recovery",
  "system_init_reset",
  "cli_disconnect",
  "user_message_timeout",
]);

export type InterruptSource = "user" | "leader" | "system";

export interface GenerationLifecycleSession {
  id: string;
  isGenerating: boolean;
  generationStartedAt: number | null;
  stuckNotifiedAt: number | null;
  questStatusAtTurnStart: string | null;
  messageCountAtTurnStart: number;
  interruptedDuringTurn: boolean;
  interruptSourceDuringTurn: InterruptSource | null;
  restartPrepInterruptOperationId?: string | null;
  restartPrepInterruptOrigin?: "restart_prep" | null;
  compactedDuringTurn: boolean;
  userMessageIdsThisTurn: number[];
  activeTurnRoute?: ActiveTurnRoute | null;
  queuedTurnStarts: number;
  queuedTurnReasons: string[];
  queuedTurnUserMessageIds: number[][];
  queuedTurnInterruptSources: (InterruptSource | null)[];
  queuedTurnActiveRoutes?: (ActiveTurnRoute | null)[];
  optimisticRunningTimer: ReturnType<typeof setTimeout> | null;
  lastUserMessage?: string;
  state: {
    claimedQuestStatus?: string;
  };
  messageHistory: unknown[];
}

export interface GenerationLifecycleDeps<S extends GenerationLifecycleSession> {
  sessions: Map<string, S>;
  userMessageRunningTimeoutMs: number;
  broadcastStatus: (session: S, status: "running" | "idle") => void;
  persistSession: (session: S) => void;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  emitTakodeEvent: (sessionId: string, type: "turn_start" | "turn_end", data: Record<string, unknown>) => void;
  buildTurnToolSummary: (session: S) => Record<string, unknown>;
  recordGenerationStarted?: (session: S, reason: string) => void;
  recordGenerationEnded?: (session: S, reason: string, elapsedMs: number) => void;
  onGenerationStopped?: (session: S, reason: string) => void;
  onOrchestratorTurnEnd?: (sessionId: string) => void;
  /** Returns who triggered the current turn on a given session. */
  getCurrentTurnTriggerSource?: (session: S) => "user" | "leader" | "system" | "unknown";
  /** Returns true if the session is a herded worker (owned by an orchestrator). */
  isHerdedWorker?: (session: S) => boolean;
}

export interface StuckWatchdogSession extends GenerationLifecycleSession {
  backendType: string;
  pendingCodexInputs: Array<{ timestamp: number }>;
  codexAdapter: unknown | null;
  toolStartTimes: Map<string, number>;
  lastCliMessageAt: number;
  lastToolProgressAt: number;
  state: GenerationLifecycleSession["state"] & {
    backend_state?: string;
    cwd: string;
  };
}

export interface StuckWatchdogDeps<S extends StuckWatchdogSession> {
  stuckPendingDeliveryMs: number;
  stuckThresholdMs: number;
  autoRecoverMs: number;
  autoRecoverOrchestratorMs: number;
  requestCodexAutoRecovery: (session: S, reason: string) => void;
  broadcastMessage: (session: S, msg: Record<string, unknown>) => void;
  recordServerEvent?: (session: S, reason: string, payload: Record<string, unknown>) => void;
  getLauncherSessionInfo?: (sessionId: string) => { isOrchestrator?: boolean } | null | undefined;
  forceFlushPendingEvents?: (sessionId: string) => number;
  backendConnected: (session: S) => boolean;
  markTurnInterrupted: (session: S, source: InterruptSource) => void;
  setGenerating: (session: S, generating: boolean, reason: string) => void;
}

export type UserDispatchTurnTarget = "current" | "queued";
export interface QueuedTurnLifecycleEntry {
  reason: string;
  userMessageIds: number[];
  interruptSource: InterruptSource | null;
  activeTurnRoute: ActiveTurnRoute | null;
}

function interruptSourcePriority(source: InterruptSource | null): number {
  switch (source) {
    case "user":
    case "leader":
      return 2;
    case "system":
      return 1;
    default:
      return 0;
  }
}

export function markTurnInterrupted<S extends GenerationLifecycleSession>(session: S, source: InterruptSource): void {
  if (!session.isGenerating) return;
  session.interruptedDuringTurn = true;
  if (interruptSourcePriority(source) > interruptSourcePriority(session.interruptSourceDuringTurn)) {
    session.interruptSourceDuringTurn = source;
  }
}

export function clearOptimisticRunningTimer<S extends GenerationLifecycleSession>(session: S): void {
  if (!session.optimisticRunningTimer) return;
  clearTimeout(session.optimisticRunningTimer);
  session.optimisticRunningTimer = null;
}

function restartOptimisticRunningTimer<S extends GenerationLifecycleSession>(
  deps: GenerationLifecycleDeps<S>,
  session: S,
  reason: string,
): void {
  clearOptimisticRunningTimer(session);
  const timer = setTimeout(() => {
    const current = deps.sessions.get(session.id);
    if (!current) return;
    if (current.optimisticRunningTimer !== timer) return;
    current.optimisticRunningTimer = null;
    if (!current.isGenerating) return;

    console.warn(
      `[ws-bridge] Reverting optimistic running state after ${deps.userMessageRunningTimeoutMs}ms for session ${sessionTag(current.id)} (${reason})`,
    );
    markTurnInterrupted(current, "system");
    setGenerating(deps, current, false, "user_message_timeout");
    // Drain any remaining queued turns — if the CLI didn't respond to this
    // promoted turn, it won't respond to subsequent phantom turns either.
    const remainingEntries = getQueuedTurnLifecycleEntries(current);
    if (remainingEntries.length > 0) {
      console.warn(
        `[ws-bridge] Draining ${remainingEntries.length} remaining queued turn(s) for session ${sessionTag(current.id)} after timeout`,
      );
      replaceQueuedTurnLifecycleEntries(current, []);
    }
    deps.broadcastStatus(current, "idle");
    deps.persistSession(current);
  }, deps.userMessageRunningTimeoutMs);
  session.optimisticRunningTimer = timer;
}

export function markRunningFromUserDispatch<S extends GenerationLifecycleSession>(
  deps: GenerationLifecycleDeps<S>,
  session: S,
  reason: string,
  queuedInterruptSource: InterruptSource | null = null,
  userMessageHistoryIndex?: number,
  activeTurnRoute?: ActiveTurnRoute | null,
): UserDispatchTurnTarget {
  const wasGenerating = session.isGenerating;
  // Skip the optimistic 30s timeout for herded workers — their turns are
  // leader-paced and the timeout would spuriously interrupt them.
  if (!deps.isHerdedWorker?.(session)) {
    restartOptimisticRunningTimer(deps, session, reason);
  }
  if (wasGenerating) {
    const queuedTurnActiveRoutes = session.queuedTurnActiveRoutes ?? [];
    while (queuedTurnActiveRoutes.length < session.queuedTurnStarts) {
      queuedTurnActiveRoutes.push(null);
    }
    session.queuedTurnStarts += 1;
    session.queuedTurnReasons.push(reason);
    session.queuedTurnUserMessageIds.push(userMessageHistoryIndex === undefined ? [] : [userMessageHistoryIndex]);
    session.queuedTurnInterruptSources.push(queuedInterruptSource);
    queuedTurnActiveRoutes.push(activeTurnRoute ?? null);
    session.queuedTurnActiveRoutes = queuedTurnActiveRoutes;
    deps.persistSession(session);
    return "queued";
  }
  setGenerating(deps, session, true, reason);
  if (userMessageHistoryIndex !== undefined) {
    session.userMessageIdsThisTurn = [userMessageHistoryIndex];
  }
  session.activeTurnRoute = activeTurnRoute ?? null;
  if (!wasGenerating) {
    deps.broadcastStatus(session, "running");
  }
  deps.persistSession(session);
  return "current";
}

export function trackUserMessageForTurn<S extends GenerationLifecycleSession>(
  session: S,
  historyIndex: number,
  target: UserDispatchTurnTarget,
): void {
  if (target === "queued") {
    const nextIdx = session.queuedTurnUserMessageIds.length - 1;
    if (nextIdx >= 0) {
      session.queuedTurnUserMessageIds[nextIdx].push(historyIndex);
      return;
    }
  }
  session.userMessageIdsThisTurn.push(historyIndex);
}

export function getQueuedTurnLifecycleEntries<S extends GenerationLifecycleSession>(
  session: S,
): QueuedTurnLifecycleEntry[] {
  const count = Math.max(
    session.queuedTurnStarts,
    session.queuedTurnReasons.length,
    session.queuedTurnUserMessageIds.length,
    session.queuedTurnInterruptSources.length,
    session.queuedTurnActiveRoutes?.length ?? 0,
  );
  return Array.from({ length: count }, (_, idx) => ({
    reason: session.queuedTurnReasons[idx] ?? "queued_user_message",
    userMessageIds: [...(session.queuedTurnUserMessageIds[idx] ?? [])],
    interruptSource: session.queuedTurnInterruptSources[idx] ?? null,
    activeTurnRoute: session.queuedTurnActiveRoutes?.[idx] ?? null,
  }));
}

export function replaceQueuedTurnLifecycleEntries<S extends GenerationLifecycleSession>(
  session: S,
  entries: QueuedTurnLifecycleEntry[],
): void {
  session.queuedTurnStarts = entries.length;
  session.queuedTurnReasons = entries.map((entry) => entry.reason);
  session.queuedTurnUserMessageIds = entries.map((entry) => [...entry.userMessageIds]);
  session.queuedTurnInterruptSources = entries.map((entry) => entry.interruptSource);
  session.queuedTurnActiveRoutes = entries.map((entry) => entry.activeTurnRoute);
}

function startQueuedTurn<S extends GenerationLifecycleSession>(
  deps: GenerationLifecycleDeps<S>,
  session: S,
  entry: QueuedTurnLifecycleEntry,
  suffix = "queued",
): void {
  const turnReason = `${entry.reason}:${suffix}`;
  session.isGenerating = true;
  session.generationStartedAt = Date.now();
  session.stuckNotifiedAt = null;
  session.questStatusAtTurnStart = session.state.claimedQuestStatus ?? null;
  session.messageCountAtTurnStart = session.messageHistory.length;
  session.interruptedDuringTurn = false;
  session.interruptSourceDuringTurn = null;
  session.restartPrepInterruptOperationId = null;
  session.restartPrepInterruptOrigin = null;
  session.compactedDuringTurn = false;
  session.userMessageIdsThisTurn = [...entry.userMessageIds];
  session.activeTurnRoute = entry.activeTurnRoute;
  console.log(`[ws-bridge] Generation started for session ${sessionTag(session.id)} (${turnReason})`);
  deps.recordGenerationStarted?.(session, turnReason);
  deps.emitTakodeEvent(session.id, "turn_start", {
    reason: turnReason,
    userMessage: session.lastUserMessage?.slice(0, 120),
  });
  deps.broadcastStatus(session, "running");
  deps.onSessionActivityStateChanged(session.id, `generating:${turnReason}`);
  // Safety net: if the CLI doesn't respond to this promoted queued turn within
  // the timeout, it was likely a phantom turn (user message lost during a
  // WebSocket token refresh). Without this, phantom queued turns leave
  // isGenerating=true forever. Skip for herded workers (leader-paced).
  if (!deps.isHerdedWorker?.(session)) {
    restartOptimisticRunningTimer(deps, session, turnReason);
  }
}

export function promoteNextQueuedTurn<S extends GenerationLifecycleSession>(
  deps: GenerationLifecycleDeps<S>,
  session: S,
  suffix = "queued",
): boolean {
  const entries = getQueuedTurnLifecycleEntries(session);
  const nextEntry = entries.shift();
  if (!nextEntry) return false;
  replaceQueuedTurnLifecycleEntries(session, entries);
  startQueuedTurn(deps, session, nextEntry, suffix);
  return true;
}

export function reconcileTerminalResultState<S extends GenerationLifecycleSession>(
  deps: GenerationLifecycleDeps<S>,
  session: S,
  reason: string,
): { endedTurn: boolean; clearedResidualState: boolean } {
  clearOptimisticRunningTimer(session);
  if (session.isGenerating) {
    setGenerating(deps, session, false, reason);
    return { endedTurn: true, clearedResidualState: true };
  }

  const hadResidualState =
    session.generationStartedAt !== null ||
    session.stuckNotifiedAt !== null ||
    session.interruptedDuringTurn ||
    session.interruptSourceDuringTurn !== null ||
    session.compactedDuringTurn ||
    session.userMessageIdsThisTurn.length > 0;
  if (!hadResidualState) {
    return { endedTurn: false, clearedResidualState: false };
  }

  session.generationStartedAt = null;
  session.stuckNotifiedAt = null;
  session.interruptedDuringTurn = false;
  session.interruptSourceDuringTurn = null;
  session.compactedDuringTurn = false;
  session.userMessageIdsThisTurn = [];
  deps.onSessionActivityStateChanged(session.id, `generating:${reason}:reconciled`);
  return { endedTurn: false, clearedResidualState: true };
}

export function setGenerating<S extends GenerationLifecycleSession>(
  deps: GenerationLifecycleDeps<S>,
  session: S,
  generating: boolean,
  reason: string,
): void {
  if (session.isGenerating === generating) return;
  session.isGenerating = generating;
  if (generating) {
    session.generationStartedAt = Date.now();
    session.stuckNotifiedAt = null;
    session.questStatusAtTurnStart = session.state.claimedQuestStatus ?? null;
    session.messageCountAtTurnStart = session.messageHistory.length;
    session.interruptedDuringTurn = false;
    session.interruptSourceDuringTurn = null;
    session.restartPrepInterruptOperationId = null;
    session.restartPrepInterruptOrigin = null;
    session.compactedDuringTurn = false;
    session.userMessageIdsThisTurn = [];
    session.activeTurnRoute = null;
    console.log(`[ws-bridge] Generation started for session ${sessionTag(session.id)} (${reason})`);
    deps.recordGenerationStarted?.(session, reason);

    deps.emitTakodeEvent(session.id, "turn_start", {
      reason,
      userMessage: session.lastUserMessage?.slice(0, 120),
    });
  } else {
    clearOptimisticRunningTimer(session);
    const elapsed = session.generationStartedAt ? Date.now() - session.generationStartedAt : 0;
    session.generationStartedAt = null;
    session.stuckNotifiedAt = null;
    console.log(
      `[ws-bridge] Generation ended for session ${sessionTag(session.id)} (${reason}, duration: ${elapsed}ms)`,
    );
    deps.recordGenerationEnded?.(session, reason, elapsed);

    const toolSummary = deps.buildTurnToolSummary(session);
    const interrupted = session.interruptedDuringTurn;
    const interruptSource = interrupted ? session.interruptSourceDuringTurn || "system" : null;
    const interruptOrigin = interrupted ? session.restartPrepInterruptOrigin || null : null;
    const restartPrepOperationId = interrupted ? session.restartPrepInterruptOperationId || null : null;
    const compacted = session.compactedDuringTurn;
    const turnSource = deps.getCurrentTurnTriggerSource?.(session) ?? "unknown";
    session.interruptedDuringTurn = false;
    session.interruptSourceDuringTurn = null;
    session.restartPrepInterruptOperationId = null;
    session.restartPrepInterruptOrigin = null;
    session.compactedDuringTurn = false;
    session.activeTurnRoute = null;
    deps.emitTakodeEvent(session.id, "turn_end", {
      reason,
      duration_ms: elapsed,
      ...(interrupted ? { interrupted: true, interrupt_source: interruptSource } : {}),
      ...(interruptOrigin ? { interrupt_origin: interruptOrigin } : {}),
      ...(restartPrepOperationId ? { restart_prep_operation_id: restartPrepOperationId } : {}),
      ...(compacted ? { compacted: true } : {}),
      ...toolSummary,
      turn_source: turnSource,
    });

    deps.onOrchestratorTurnEnd?.(session.id);

    // On normal result: promote the next queued turn (the CLI is ready for more).
    // On recovery/error: drain ALL queued turns -- the CLI that would process them
    // is either dead, stuck, or was replaced. Promoting them would start phantom
    // turns that never complete, leaving isGenerating=true indefinitely (q-307).
    if (reason === "result") {
      promoteNextQueuedTurn(deps, session);
    } else if (RECOVERY_REASONS.has(reason)) {
      const staleEntries = getQueuedTurnLifecycleEntries(session);
      if (staleEntries.length > 0) {
        console.warn(
          `[ws-bridge] Draining ${staleEntries.length} orphaned queued turn(s) for session ${sessionTag(session.id)} (reason: ${reason})`,
        );
        replaceQueuedTurnLifecycleEntries(session, []);
      }
    }
  }
  deps.onSessionActivityStateChanged(session.id, `generating:${reason}`);
  if (!generating) {
    deps.onGenerationStopped?.(session, reason);
  }
}

export function runStuckSessionWatchdogSweep<S extends StuckWatchdogSession>(
  sessions: Iterable<S>,
  now: number,
  deps: StuckWatchdogDeps<S>,
): void {
  for (const session of sessions) {
    if (
      session.backendType === "codex" &&
      session.pendingCodexInputs.length > 0 &&
      !session.codexAdapter &&
      session.state.backend_state !== "broken" &&
      session.state.backend_state !== "recovering"
    ) {
      const oldestPending = session.pendingCodexInputs[0];
      const pendingAge = now - oldestPending.timestamp;
      if (pendingAge > deps.stuckPendingDeliveryMs) {
        console.warn(
          `[ws-bridge] Codex session ${sessionTag(session.id)} has stuck pending delivery ` +
            `(${Math.round(pendingAge / 1000)}s, ${session.pendingCodexInputs.length} input(s), ` +
            `backend_state=${session.state.backend_state})`,
        );
        deps.requestCodexAutoRecovery(session, "stuck_pending_delivery_watchdog");
      }
    }

    if (!session.isGenerating || !session.generationStartedAt) continue;
    if (now - session.generationStartedAt < deps.stuckThresholdMs) continue;

    if (session.toolStartTimes.size > 0) {
      let allToolsStale = true;
      for (const startedAt of session.toolStartTimes.values()) {
        if (now - startedAt < deps.autoRecoverMs) {
          allToolsStale = false;
          break;
        }
      }
      if (!allToolsStale) {
        if (session.stuckNotifiedAt) {
          session.stuckNotifiedAt = null;
          deps.broadcastMessage(session, { type: "session_unstuck" });
        }
        continue;
      }
    }

    const lastActivity = Math.max(session.lastCliMessageAt, session.lastToolProgressAt);
    const sinceLastActivity = lastActivity > 0 ? now - lastActivity : now - session.generationStartedAt;
    if (sinceLastActivity < deps.stuckThresholdMs) {
      if (session.stuckNotifiedAt) {
        session.stuckNotifiedAt = null;
        deps.broadcastMessage(session, { type: "session_unstuck" });
      }
      continue;
    }

    const elapsed = now - session.generationStartedAt;
    if (!session.stuckNotifiedAt) {
      session.stuckNotifiedAt = now;
      console.warn(
        `[ws-bridge] Session ${session.id} appears stuck (${Math.round(elapsed / 1000)}s generation, ${Math.round(sinceLastActivity / 1000)}s since last CLI activity)`,
      );
      deps.recordServerEvent?.(session, "stuck_detected", { elapsed, sinceLastActivity });
      deps.broadcastMessage(session, { type: "session_stuck" });

      const launcherInfo = deps.getLauncherSessionInfo?.(session.id);
      if (launcherInfo?.isOrchestrator && deps.forceFlushPendingEvents) {
        const flushed = deps.forceFlushPendingEvents(session.id);
        if (flushed > 0) {
          console.warn(
            `[ws-bridge] Force-delivered ${flushed} pending herd event(s) to stuck orchestrator session ${session.id}`,
          );
        }
      }
    }

    const launcherInfo = deps.getLauncherSessionInfo?.(session.id);
    const isOrchestrator = !!launcherInfo?.isOrchestrator;
    const cliConnected = deps.backendConnected(session);
    const recoverThreshold = isOrchestrator ? deps.autoRecoverOrchestratorMs : deps.autoRecoverMs;
    if (elapsed < recoverThreshold || (!cliConnected && elapsed < deps.autoRecoverMs)) continue;

    console.warn(
      `[ws-bridge] Auto-recovering stuck session ${sessionTag(session.id)} ` +
        `(${Math.round(elapsed / 1000)}s stuck, CLI ${cliConnected ? "connected" : "disconnected"}` +
        `${isOrchestrator ? ", orchestrator" : ""}, force-clearing isGenerating)`,
    );
    deps.recordServerEvent?.(session, "stuck_auto_recovered", {
      elapsed,
      sinceLastActivity,
      cliConnected,
      isOrchestrator,
    });
    deps.markTurnInterrupted(session, "system");
    deps.setGenerating(session, false, "stuck_auto_recovery");
    session.toolStartTimes.clear();
    deps.broadcastMessage(session, { type: "status_change", status: "idle" });
    deps.broadcastMessage(session, { type: "session_unstuck" });
  }
}
