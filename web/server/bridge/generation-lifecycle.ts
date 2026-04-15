import { sessionTag } from "../session-tag.js";

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
  compactedDuringTurn: boolean;
  userMessageIdsThisTurn: number[];
  queuedTurnStarts: number;
  queuedTurnReasons: string[];
  queuedTurnUserMessageIds: number[][];
  queuedTurnInterruptSources: (InterruptSource | null)[];
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
  onOrchestratorTurnEnd?: (sessionId: string) => void;
  /** Returns who triggered the current turn on a given session. */
  getCurrentTurnTriggerSource?: (session: S) => "user" | "leader" | "system" | "unknown";
  /** Returns true if the session is a herded worker (owned by an orchestrator). */
  isHerdedWorker?: (session: S) => boolean;
}

export type UserDispatchTurnTarget = "current" | "queued";
export interface QueuedTurnLifecycleEntry {
  reason: string;
  userMessageIds: number[];
  interruptSource: InterruptSource | null;
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
): UserDispatchTurnTarget {
  const wasGenerating = session.isGenerating;
  // Skip the optimistic 30s timeout for herded workers — their turns are
  // leader-paced and the timeout would spuriously interrupt them.
  if (!deps.isHerdedWorker?.(session)) {
    restartOptimisticRunningTimer(deps, session, reason);
  }
  if (wasGenerating) {
    session.queuedTurnStarts += 1;
    session.queuedTurnReasons.push(reason);
    session.queuedTurnUserMessageIds.push([]);
    session.queuedTurnInterruptSources.push(queuedInterruptSource);
    deps.persistSession(session);
    return "queued";
  }
  setGenerating(deps, session, true, reason);
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
  );
  return Array.from({ length: count }, (_, idx) => ({
    reason: session.queuedTurnReasons[idx] ?? "queued_user_message",
    userMessageIds: [...(session.queuedTurnUserMessageIds[idx] ?? [])],
    interruptSource: session.queuedTurnInterruptSources[idx] ?? null,
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
  session.compactedDuringTurn = false;
  session.userMessageIdsThisTurn = [...entry.userMessageIds];
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
    session.compactedDuringTurn = false;
    session.userMessageIdsThisTurn = [];
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
    const compacted = session.compactedDuringTurn;
    const turnSource = deps.getCurrentTurnTriggerSource?.(session) ?? "unknown";
    session.interruptedDuringTurn = false;
    session.interruptSourceDuringTurn = null;
    session.compactedDuringTurn = false;
    deps.emitTakodeEvent(session.id, "turn_end", {
      reason,
      duration_ms: elapsed,
      ...(interrupted ? { interrupted: true, interrupt_source: interruptSource } : {}),
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
}
