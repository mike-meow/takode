/**
 * Push-based event delivery for herded sessions.
 *
 * Architecture: server-internal inbox with decoupled delivery.
 *
 * 1. PRODUCTION: When a worker event fires, it's appended to the leader's
 *    inbox — pure in-memory, no socket involved, never fails.
 *
 * 2. DELIVERY: When the leader's CLI is idle and connected, inbox contents
 *    are formatted and injected as a user message. The events are marked
 *    as "in-flight" but NOT removed from the inbox yet.
 *
 * 3. CONFIRMATION: When the leader's turn completes (processes the herd
 *    message), in-flight events are confirmed consumed and trimmed.
 *
 * 4. RECOVERY: If the CLI disconnects before confirming, in-flight events
 *    are reset to "pending" and re-delivered on next idle.
 *
 * Key principle: no event is ever lost because the inbox is server-internal
 * state that survives any CLI disconnect/reconnect cycle.
 */

import type {
  TakodeEvent,
  TakodeEventDataByType,
  TakodeEventFor,
  TakodeEventSubscriber,
  TakodeEventType,
  BrowserIncomingMessage,
  TakodeHerdBatchSnapshot,
} from "./session-types.js";
import { formatActivitySummaryDetailed } from "./herd-activity-formatter.js";
import {
  inferRouteFromHistoryEntryContent,
  routeFromHistoryEntry,
  routeKey,
  threadRouteForTarget,
  type ThreadRouteMetadata,
} from "./thread-routing-metadata.js";
import { wakeIdleKilledSession as wakeIdleKilledSessionController } from "./idle-manager.js";
import {
  onSessionActivityStateChanged as onSessionActivityStateChangedController,
  updateLeaderGroupIdleState as updateLeaderGroupIdleStateController,
  type LeaderIdleStateLike,
} from "./bridge/session-registry-controller.js";

export interface BufferedTakodeEventState {
  takodeSubscribers: Set<TakodeEventSubscriber>;
  takodeEventLog: TakodeEvent[];
  takodeEventNextId: number;
  takodeEventLogLimit: number;
}

export function emitBufferedTakodeEvent<E extends TakodeEventType>(
  state: BufferedTakodeEventState,
  deps: {
    getSessionNum?: (sessionId: string) => number | undefined;
    getSessionName?: (sessionId: string) => string | undefined;
  },
  sessionId: string,
  event: E,
  data: TakodeEventDataByType[E],
  actorSessionId?: string,
): number {
  const takodeEvent = {
    id: state.takodeEventNextId++,
    event,
    sessionId,
    sessionNum: deps.getSessionNum?.(sessionId) ?? -1,
    sessionName: deps.getSessionName?.(sessionId) ?? sessionId.slice(0, 8),
    ts: Date.now(),
    data,
    ...(actorSessionId ? { actorSessionId } : {}),
  } as TakodeEventFor<E>;

  state.takodeEventLog.push(takodeEvent);
  if (state.takodeEventLog.length > state.takodeEventLogLimit) {
    state.takodeEventLog.shift();
  }

  for (const sub of state.takodeSubscribers) {
    if (!sub.sessions.has(sessionId)) continue;
    try {
      sub.callback(takodeEvent);
    } catch {
      state.takodeSubscribers.delete(sub);
    }
  }
  return state.takodeEventNextId;
}

export function subscribeBufferedTakodeEvents(
  state: BufferedTakodeEventState,
  sessions: Set<string>,
  callback: (event: TakodeEvent) => void,
  sinceEventId?: number,
): () => void {
  const sub: TakodeEventSubscriber = { sessions, callback };
  state.takodeSubscribers.add(sub);

  if (sinceEventId !== undefined) {
    for (const evt of state.takodeEventLog) {
      if (evt.id <= sinceEventId || !sessions.has(evt.sessionId)) continue;
      try {
        callback(evt);
      } catch {
        state.takodeSubscribers.delete(sub);
        return () => {};
      }
    }
  }

  return () => {
    state.takodeSubscribers.delete(sub);
  };
}

// ─── Interfaces (for testability — avoids importing full WsBridge/CliLauncher) ──

export interface WsBridgeHandle {
  subscribeTakodeEvents(sessions: Set<string>, cb: (e: TakodeEvent) => void, since?: number): () => void;
  injectUserMessage(
    sessionId: string,
    content: string,
    agentSource?: { sessionId: string; sessionLabel?: string },
    takodeHerdBatch?: TakodeHerdBatchSnapshot,
    threadRoute?: ThreadRouteMetadata,
  ): "sent" | "queued" | "dropped" | "no_session";
  isSessionIdle?(sessionId: string): boolean;
  /** Test-only escape hatch while production callers move to the shared idle helper. */
  wakeIdleKilledSession?(sessionId: string): boolean;
  wakeUnavailableOrchestratorForPendingEvents?(sessionId: string, reason: string): boolean;
  getSession(sessionId: string):
    | {
        messageHistory: BrowserIncomingMessage[];
        state?: { claimedQuestId?: string };
        backendSocket?: unknown;
        codexAdapter?: unknown;
        claudeSdkAdapter?: unknown;
        cliInitReceived?: boolean;
        isGenerating?: boolean;
      }
    | undefined;
  /** Current active board row for a leader session + quest ID, if any. */
  getBoardRow?(sessionId: string, questId: string): { status?: string } | null;
  /** Current live stall signature for a leader board row, if it is still stalled. */
  getBoardStallSignature?(sessionId: string, questId: string): string | null;
  /** Current live dispatchable signature for a queued leader board row, if it is still dispatchable. */
  getBoardDispatchableSignature?(sessionId: string, questId: string): string | null;
}

export interface LauncherHandle {
  getHerdedSessions(orchId: string): Array<{ sessionId: string }>;
  getSession?(
    sessionId: string,
  ): { state?: string; killedByIdleManager?: boolean; claimedQuestId?: string } | undefined;
}

export type RestartPrepMode = "standalone" | "restart";

export interface RestartPrepSessionSummary {
  sessionId: string;
  label: string;
}

export interface RestartPrepOperationSnapshot {
  operationId: string;
  mode: RestartPrepMode;
  startedAt: number;
  timeoutMs: number;
  suppressionTtlMs: number;
  targetedSessions: RestartPrepSessionSummary[];
  protectedLeaders: RestartPrepSessionSummary[];
  suppressedHerdEvents: number;
  heldHerdEvents: number;
  unresolvedBlockers: RestartPrepSessionSummary[];
}

interface RestartPrepOperation {
  operationId: string;
  mode: RestartPrepMode;
  startedAt: number;
  timeoutMs: number;
  suppressionTtlMs: number;
  targetSessionIds: Set<string>;
  protectedLeaderIds: Set<string>;
  targetSummaries: RestartPrepSessionSummary[];
  protectedLeaderSummaries: RestartPrepSessionSummary[];
  suppressedHerdEvents: number;
  heldHerdEvents: number;
  unresolvedBlockers: RestartPrepSessionSummary[];
  holdUntil: number;
  suppressUntil: number;
  releaseTimer: ReturnType<typeof setTimeout>;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

export function isSessionIdleRuntime(
  session:
    | {
        backendSocket?: unknown;
        codexAdapter?: unknown;
        claudeSdkAdapter?: unknown;
        cliInitReceived?: boolean;
        isGenerating?: boolean;
      }
    | undefined,
): boolean {
  if (!session) return false;
  return (
    !!(session.backendSocket || session.codexAdapter || session.claudeSdkAdapter) &&
    !!session.cliInitReceived &&
    !session.isGenerating
  );
}

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Events worth delivering to orchestrators.
 *  session_disconnected is included for full disconnects after the backend has
 *  actually dropped out of service. These events are distinct from transient
 *  reconnect windows because the bridge only emits them after the disconnect is
 *  considered actionable.
 *  user_message is included only for direct human messages to herded sessions;
 *  onWorkerEvent filters out injected agent/system messages before delivery. */
const ACTIONABLE_EVENTS = new Set<TakodeEventType>([
  "turn_end",
  "worker_stream",
  "user_message",
  "permission_request",
  "permission_resolved",
  "herd_reassigned",
  "session_error",
  "session_disconnected",
  "session_archived",
  "session_deleted",
  "board_stalled",
  "board_dispatchable",
  "notification_needs_input",
]);

/** Events that must survive inbox overflow — dropping these leaves workers stuck. */
const CRITICAL_EVENTS = new Set<TakodeEventType>(["permission_request", "session_error"]);

const DEBOUNCE_MS = 500;
/** Retry interval when flush finds the leader busy — longer than DEBOUNCE_MS
 *  to avoid tight polling loops, but short enough for reasonable latency. */
const RETRY_MS = 2000;
const INBOX_CAP = 200;
const HISTORY_CAP = 50;
const RECENT_EVENT_DEDUPE_CAP = 500;

/** agentSource used to tag herd event messages */
const HERD_AGENT_SOURCE = { sessionId: "herd-events", sessionLabel: "Herd Events" } as const;

function getSessionMessageSlice(
  bridge: Pick<WsBridgeHandle, "getSession">,
  sessionId: string,
  from: number,
  to: number,
): BrowserIncomingMessage[] | null {
  const history = bridge.getSession(sessionId)?.messageHistory;
  if (!history) return null;
  const clampedFrom = Math.max(0, from);
  const clampedTo = Math.min(history.length - 1, to);
  if (clampedFrom > clampedTo) return [];
  return history.slice(clampedFrom, clampedTo + 1);
}

// ─── Inbox State ────────────────────────────────────────────────────────────────

interface InboxEntry {
  event: TakodeEvent;
  /** Monotonic sequence number within this inbox */
  seq: number;
  threadRoute: ThreadRouteMetadata;
  heldByRestartPrepOperationId?: string;
}

interface DeliveryRecord {
  event: string;
  sessionName: string;
  ts: number;
  deliveredAt: number | null;
  status: "pending" | "held" | "in_flight" | "confirmed" | "redelivered" | "suppressed";
}

interface HerdInbox {
  entries: InboxEntry[];
  /** Next sequence number to assign */
  nextSeq: number;
  /** All entries with seq < confirmedUpTo have been consumed by the CLI */
  confirmedUpTo: number;
  /** Seq of the last entry included in the most recent flush (in-flight marker) */
  inFlightUpTo: number | null;
  /** Event subscription handle */
  unsubscribe: (() => void) | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  workerIds: Set<string>;
  /** Persistent delivery history for diagnostics (last N entries) */
  deliveryHistory: DeliveryRecord[];
  /** Stable identities for recently accepted events, used to suppress stale replay duplicates. */
  recentEventKeys: Map<string, number>;
  /** Per-worker: highest msgRange.to from the last delivered batch.
   *  Prevents re-injecting the same activity in consecutive turn_end events. */
  lastEmittedMsgTo: Map<string, number>;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────────

export class HerdEventDispatcher {
  private inboxes = new Map<string, HerdInbox>();
  private takodeSubscribers = new Set<TakodeEventSubscriber>();
  private takodeEventLog: TakodeEvent[] = [];
  private takodeEventNextId = 0;
  private static readonly TAKODE_EVENT_LOG_LIMIT = 1000;
  private leaderGroupIdleStates: LeaderIdleStateLike["leaderGroupIdleStates"] = new Map();
  private restartPrepOperations = new Map<string, RestartPrepOperation>();

  constructor(
    private wsBridge: WsBridgeHandle,
    private launcher: LauncherHandle,
    private runtime?: {
      requestCliRelaunch?: (sessionId: string) => void;
      getSessionNum?: (sessionId: string) => number | undefined;
      getSessionName?: (sessionId: string) => string | undefined;
      getSessions?: () => LeaderIdleStateLike["sessions"];
      getLeaderIdleDeps?: () => Parameters<typeof updateLeaderGroupIdleStateController>[3];
      markNotificationDone?: (sessionId: string, notifId: string, done: boolean) => boolean;
    },
  ) {}

  emitTakodeEvent<E extends TakodeEventType>(
    sessionId: string,
    event: E,
    data: TakodeEventDataByType[E],
    actorSessionId?: string,
  ): void {
    this.takodeEventNextId = emitBufferedTakodeEvent(
      {
        takodeSubscribers: this.takodeSubscribers,
        takodeEventLog: this.takodeEventLog,
        takodeEventNextId: this.takodeEventNextId,
        takodeEventLogLimit: HerdEventDispatcher.TAKODE_EVENT_LOG_LIMIT,
      },
      {
        getSessionNum: this.runtime?.getSessionNum,
        getSessionName: this.runtime?.getSessionName,
      },
      sessionId,
      event,
      data,
      actorSessionId,
    );
  }

  subscribeTakodeEvents(
    sessions: Set<string>,
    callback: (event: TakodeEvent) => void,
    sinceEventId?: number,
  ): () => void {
    return subscribeBufferedTakodeEvents(
      {
        takodeSubscribers: this.takodeSubscribers,
        takodeEventLog: this.takodeEventLog,
        takodeEventNextId: this.takodeEventNextId,
        takodeEventLogLimit: HerdEventDispatcher.TAKODE_EVENT_LOG_LIMIT,
      },
      sessions,
      callback,
      sinceEventId,
    );
  }

  beginRestartPrepOperation(options: {
    operationId: string;
    mode: RestartPrepMode;
    targetSessions: RestartPrepSessionSummary[];
    protectedLeaders: RestartPrepSessionSummary[];
    timeoutMs: number;
    suppressionTtlMs?: number;
  }): RestartPrepOperationSnapshot {
    const startedAt = Date.now();
    const suppressionTtlMs = options.suppressionTtlMs ?? Math.max(options.timeoutMs * 6, 60_000);
    const releaseTimer = setTimeout(() => {
      this.releaseHeldRestartPrepEvents(options.operationId);
    }, options.timeoutMs);
    const cleanupTimer = setTimeout(() => {
      this.restartPrepOperations.delete(options.operationId);
    }, suppressionTtlMs);
    const operation: RestartPrepOperation = {
      operationId: options.operationId,
      mode: options.mode,
      startedAt,
      timeoutMs: options.timeoutMs,
      suppressionTtlMs,
      targetSessionIds: new Set(options.targetSessions.map((session) => session.sessionId)),
      protectedLeaderIds: new Set(options.protectedLeaders.map((session) => session.sessionId)),
      targetSummaries: options.targetSessions,
      protectedLeaderSummaries: options.protectedLeaders,
      suppressedHerdEvents: 0,
      heldHerdEvents: 0,
      unresolvedBlockers: [],
      holdUntil: startedAt + options.timeoutMs,
      suppressUntil: startedAt + suppressionTtlMs,
      releaseTimer,
      cleanupTimer,
    };
    this.restartPrepOperations.set(operation.operationId, operation);
    return this.snapshotRestartPrepOperation(operation);
  }

  updateRestartPrepUnresolvedBlockers(operationId: string, blockers: RestartPrepSessionSummary[]): void {
    const operation = this.restartPrepOperations.get(operationId);
    if (!operation) return;
    operation.unresolvedBlockers = blockers;
  }

  getRestartPrepOperationSnapshot(operationId: string): RestartPrepOperationSnapshot | null {
    const operation = this.restartPrepOperations.get(operationId);
    return operation ? this.snapshotRestartPrepOperation(operation) : null;
  }

  onSessionActivityStateChanged(sessionId: string, reason: string): void {
    const state = this.getLeaderIdleState();
    const deps = this.runtime?.getLeaderIdleDeps?.();
    if (!state || !deps) return;
    onSessionActivityStateChangedController(state, sessionId, reason, deps);
  }

  /** Subscribe to events from all herded workers of an orchestrator. Idempotent. */
  setupForOrchestrator(orchId: string): void {
    const workers = this.launcher.getHerdedSessions(orchId);
    const workerIds = new Set(workers.map((w) => w.sessionId));
    if (workerIds.size === 0) {
      const existing = this.inboxes.get(orchId);
      if (!existing) return;
      existing.unsubscribe?.();
      existing.unsubscribe = null;
      existing.workerIds = workerIds;
      if (this.pendingCount(existing) > 0 && this.isSessionIdle(orchId)) {
        this.scheduleDelivery(orchId);
      } else {
        this.maybeRetireInbox(orchId, existing);
      }
      return;
    }

    const existing = this.inboxes.get(orchId);
    if (existing) {
      // Check if worker set changed
      if (setsEqual(existing.workerIds, workerIds)) return;
      // Unsubscribe old, keep accumulated events
      existing.unsubscribe?.();
      existing.workerIds = workerIds;
      existing.unsubscribe = this.wsBridge.subscribeTakodeEvents(workerIds, (evt) => this.onWorkerEvent(orchId, evt));
    } else {
      const inbox: HerdInbox = {
        entries: [],
        nextSeq: 0,
        confirmedUpTo: 0,
        inFlightUpTo: null,
        unsubscribe: null,
        debounceTimer: null,
        workerIds,
        deliveryHistory: [],
        recentEventKeys: new Map(),
        lastEmittedMsgTo: new Map(),
      };
      inbox.unsubscribe = this.wsBridge.subscribeTakodeEvents(workerIds, (evt) => this.onWorkerEvent(orchId, evt));
      this.inboxes.set(orchId, inbox);
    }
  }

  /** Clean up subscriptions and timers for an orchestrator. */
  teardownForOrchestrator(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox) return;
    inbox.unsubscribe?.();
    if (inbox.debounceTimer) clearTimeout(inbox.debounceTimer);
    this.inboxes.delete(orchId);
  }

  // ─── Event Production (step 1: append-only, never fails) ─────────────────

  /** Called by the event subscription when a herded worker emits an event. */
  private onWorkerEvent(orchId: string, event: TakodeEvent): void {
    if (!ACTIONABLE_EVENTS.has(event.event)) return;

    // Dedicated user_message herd delivery is only for direct human messages.
    // Agent, leader, herd, and system injections carry agentSource and still
    // flow to the target session normally, but should not interrupt the leader
    // as human steering.
    if (event.event === "user_message" && event.data.agentSource?.sessionId) return;

    // Skip events triggered by the leader's own actions (e.g. archive, answer).
    // The leader already sees the result in the tool call response.
    if (event.actorSessionId === orchId) return;

    // Annotate user-initiated turn_end events so the leader can distinguish
    // them from leader-dispatched work, but still deliver them. The leader
    // needs visibility into ALL worker state changes to monitor the herd.
    // Previously these were silently dropped (q-16), which created a blind
    // spot: the leader never learned about user-triggered task completions.

    const inbox = this.inboxes.get(orchId);
    if (!inbox) return;

    const policy = this.getRestartPrepDeliveryPolicy(orchId, event);
    if (policy.kind === "suppress") {
      this.recordRestartPrepSuppressed(policy.operation, event);
      return;
    }

    const eventKey = getStableHerdEventKey(event);
    if (eventKey && (inbox.recentEventKeys.has(eventKey) || inboxHasEventKey(inbox, eventKey))) {
      return;
    }
    if (eventKey && this.hasCommittedHerdEventKey(orchId, eventKey)) {
      inbox.recentEventKeys.set(eventKey, Date.now());
      trimRecentEventKeys(inbox);
      return;
    }

    // Append to inbox (pure in-memory, never fails)
    const seq = inbox.nextSeq++;
    const entry: InboxEntry = { event, seq, threadRoute: this.resolveEventThreadRoute(event) };
    if (policy.kind === "hold") {
      entry.heldByRestartPrepOperationId = policy.operation.operationId;
      policy.operation.heldHerdEvents += 1;
    }
    inbox.entries.push(entry);

    // Track in delivery history
    inbox.deliveryHistory.push({
      event: event.event,
      sessionName: event.sessionName,
      ts: event.ts,
      deliveredAt: null,
      status: policy.kind === "hold" ? "held" : "pending",
    });
    if (inbox.deliveryHistory.length > HISTORY_CAP) {
      inbox.deliveryHistory.splice(0, inbox.deliveryHistory.length - HISTORY_CAP);
    }

    // Cap inbox entries to prevent unbounded growth. Prioritize critical events
    // (permission_request, session_error) over informational ones — dropping a
    // permission_request leaves a worker permanently stuck (q-205).
    if (inbox.entries.length > INBOX_CAP) {
      const excess = inbox.entries.length - INBOX_CAP;
      // Partition: try to drop non-critical entries first (oldest first)
      const nonCriticalIndices: number[] = [];
      for (let i = 0; i < inbox.entries.length && nonCriticalIndices.length < excess; i++) {
        if (!CRITICAL_EVENTS.has(inbox.entries[i].event.event)) {
          nonCriticalIndices.push(i);
        }
      }

      if (nonCriticalIndices.length >= excess) {
        // Enough non-critical entries to drop — remove them (reverse to preserve indices)
        for (let i = nonCriticalIndices.length - 1; i >= 0; i--) {
          inbox.entries.splice(nonCriticalIndices[i], 1);
        }
      } else {
        // Not enough non-critical entries — fall back to dropping oldest
        const criticalDropped = excess - nonCriticalIndices.length;
        if (criticalDropped > 0) {
          console.warn(
            `[herd-dispatcher] Inbox overflow for leader ${orchId}: dropping ${criticalDropped} critical event(s) (cap=${INBOX_CAP})`,
          );
        }
        inbox.entries.splice(0, excess);
      }
      // Update confirmedUpTo so we don't try to re-deliver trimmed entries
      if (inbox.entries.length > 0) {
        inbox.confirmedUpTo = Math.max(inbox.confirmedUpTo, inbox.entries[0].seq);
      }
    }

    if (policy.kind === "hold") return;

    // If orchestrator is idle, schedule delivery
    if (this.isSessionIdle(orchId)) {
      this.scheduleDelivery(orchId);
    } else if (this.wakeIdleKilledSession(orchId)) {
      // Leader was stopped by idle-manager — wake it up.
      // Events stay pending in the inbox; they'll be flushed once the CLI
      // reconnects and goes idle (via onOrchestratorTurnEnd or the normal
      // isSessionIdle check in scheduleDelivery).
      console.log(
        `[herd-dispatcher] Woke idle-killed leader ${orchId} to deliver ${this.pendingCount(inbox)} pending herd event(s)`,
      );
    } else if (this.wakeUnavailableOrchestratorForPendingEvents(orchId, "pending_herd_event_dead_backend")) {
      console.log(
        `[herd-dispatcher] Requested unavailable leader recovery for ${orchId} to deliver ${this.pendingCount(inbox)} pending herd event(s)`,
      );
    } else {
      // If recovery is already in flight or the leader is merely busy, keep
      // rechecking so a later cleared recovery guard cannot strand this event.
      this.scheduleRetry(orchId);
    }
    // If generating, events accumulate — delivered on next onOrchestratorTurnEnd
  }

  // ─── Event Delivery (step 2: inject when CLI is ready) ────────────────────

  /** Called from ws-bridge when an orchestrator finishes a turn. */
  onOrchestratorTurnEnd(orchId: string, reason = "result"): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox) return;

    // Confirm in-flight events only for normal completed turns. Recovery turn
    // endings clear stale local state; they do not prove the CLI consumed the
    // injected herd batch.
    if (inbox.inFlightUpTo !== null) {
      if (reason === "result") {
        const confirmedEntries = inbox.entries.filter(
          (entry) => entry.seq >= inbox.confirmedUpTo && entry.seq <= inbox.inFlightUpTo!,
        );
        for (const entry of confirmedEntries) {
          this.markDeliveryHistoryStatus(inbox, entry, "confirmed");
          this.confirmNotificationIfNeeded(entry);
        }
        inbox.confirmedUpTo = inbox.inFlightUpTo + 1;
        inbox.inFlightUpTo = null;
        // Trim confirmed entries from the inbox
        while (inbox.entries.length > 0 && inbox.entries[0].seq < inbox.confirmedUpTo) {
          inbox.entries.shift();
        }
      } else {
        for (const h of inbox.deliveryHistory) {
          if (h.status === "in_flight") h.status = "redelivered";
        }
        inbox.inFlightUpTo = null;
      }
    }

    this.confirmCommittedHerdHistory(orchId, inbox);

    // If there are new pending events, flush synchronously. The orchestrator is
    // idle RIGHT NOW (isGenerating was set to false before this call). Using
    // queueMicrotask here would race with promoteNextQueuedTurn() which runs
    // synchronously after this returns and sets isGenerating back to true —
    // causing the microtask to find the leader "busy" and fall into a 2s retry
    // loop (q-205). A synchronous flush is safe because flushInbox re-checks
    // isSessionIdle, and the debounce timer cancellation prevents double-delivery.
    if (this.pendingCount(inbox) > 0) {
      if (inbox.debounceTimer) {
        clearTimeout(inbox.debounceTimer);
        inbox.debounceTimer = null;
      }
      this.flushInbox(orchId);
    } else {
      this.maybeRetireInbox(orchId, inbox);
    }
  }

  /** Called when the orchestrator's CLI disconnects. Reset in-flight state. */
  onOrchestratorDisconnect(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox) return;

    // Reset in-flight: events were injected but CLI disconnected before consuming.
    // They'll be re-delivered when the CLI reconnects and goes idle.
    if (inbox.inFlightUpTo !== null) {
      // Mark redelivered in history
      for (const h of inbox.deliveryHistory) {
        if (h.status === "in_flight") h.status = "redelivered";
      }
      inbox.inFlightUpTo = null;
    }

    // Cancel any pending delivery timer
    if (inbox.debounceTimer) {
      clearTimeout(inbox.debounceTimer);
      inbox.debounceTimer = null;
    }
  }

  /** Called when herd relationships change (workers added/removed). */
  onHerdChanged(orchId: string): void {
    this.setupForOrchestrator(orchId);
    const state = this.getLeaderIdleState();
    const deps = this.runtime?.getLeaderIdleDeps?.();
    if (!state || !deps) return;
    updateLeaderGroupIdleStateController(state, orchId, "herd_membership_changed", deps);
  }

  /** Force-deliver pending events, bypassing the isSessionIdle() gate.
   *  Called by the stuck-session watchdog when a leader has been stuck for
   *  too long — events would otherwise remain stranded indefinitely.
   *  Returns the number of events delivered (0 if nothing was pending). */
  forceFlushPendingEvents(orchId: string): number {
    const inbox = this.inboxes.get(orchId);
    if (!inbox) return 0;
    this.pruneStaleBoardStallEntries(orchId, inbox);
    const pending = this.getDeliverablePendingEntries(orchId, inbox);
    if (pending.length === 0) return 0;

    const result = this.deliverPendingEntries(orchId, inbox, pending);
    if (result.status === "dropped") {
      this.pruneStaleBoardStallEntries(orchId, inbox);
      this.maybeRetireInbox(orchId, inbox);
      return 0;
    }
    if (result.status === "retry") this.scheduleRetry(orchId);
    return result.status === "sent" ? result.deliveredCount : 0;
  }

  /** Schedule a debounced flush. Multiple calls within DEBOUNCE_MS batch together. */
  private scheduleDelivery(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox || inbox.debounceTimer) return; // already scheduled
    inbox.debounceTimer = setTimeout(() => {
      inbox.debounceTimer = null;
      this.flushInbox(orchId);
    }, DEBOUNCE_MS);
  }

  /** Schedule a retry flush at a longer interval. Called when flushInbox finds
   *  the leader busy — prevents events from being permanently stranded. */
  private scheduleRetry(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox || inbox.debounceTimer) return; // already has a pending timer
    inbox.debounceTimer = setTimeout(() => {
      inbox.debounceTimer = null;
      this.flushInbox(orchId);
    }, RETRY_MS);
  }

  /** Deliver pending events to the orchestrator's CLI. */
  private flushInbox(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox) return;
    this.pruneStaleBoardStallEntries(orchId, inbox);

    const pending = this.getDeliverablePendingEntries(orchId, inbox);
    if (pending.length === 0) {
      this.maybeRetireInbox(orchId, inbox);
      return;
    }

    // Re-check idle — orchestrator may have started generating during debounce
    if (!this.isSessionIdle(orchId)) {
      // If the leader was idle-killed during the debounce window, wake it.
      // Otherwise schedule a retry — the leader is busy and will get events
      // when its turn ends (onOrchestratorTurnEnd) or on the next retry.
      if (this.wakeIdleKilledSession(orchId)) {
        console.log(`[herd-dispatcher] Woke idle-killed leader ${orchId} during flush retry`);
      } else if (this.wakeUnavailableOrchestratorForPendingEvents(orchId, "pending_herd_event_flush_retry")) {
        console.log(`[herd-dispatcher] Requested unavailable leader recovery for ${orchId} during flush retry`);
      } else {
        this.scheduleRetry(orchId);
      }
      return;
    }

    const result = this.deliverPendingEntries(orchId, inbox, pending);
    if (result.status === "dropped") {
      this.pruneStaleBoardStallEntries(orchId, inbox);
      this.maybeRetireInbox(orchId, inbox);
      return;
    }
    if (result.status === "retry") this.scheduleRetry(orchId);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Get entries that haven't been confirmed consumed yet. */
  private getPendingEntries(inbox: HerdInbox): InboxEntry[] {
    // Pending = everything after confirmedUpTo that isn't already in-flight
    const startSeq =
      inbox.inFlightUpTo !== null
        ? inbox.inFlightUpTo + 1 // Already have in-flight batch, only get newer
        : inbox.confirmedUpTo; // Nothing in-flight, get from last confirmed
    return inbox.entries.filter((e) => e.seq >= startSeq);
  }

  private getDeliverablePendingEntries(orchId: string, inbox: HerdInbox): InboxEntry[] {
    const deliverable: InboxEntry[] = [];
    for (const entry of this.getPendingEntries(inbox)) {
      const policy = this.getRestartPrepDeliveryPolicy(orchId, entry.event);
      if (policy.kind === "deliver") {
        if (entry.heldByRestartPrepOperationId) {
          entry.heldByRestartPrepOperationId = undefined;
        }
        deliverable.push(entry);
        continue;
      }
      if (policy.kind === "hold") {
        if (!entry.heldByRestartPrepOperationId) {
          entry.heldByRestartPrepOperationId = policy.operation.operationId;
          policy.operation.heldHerdEvents += 1;
          this.markDeliveryHistoryStatus(inbox, entry, "held");
        }
        continue;
      }
      this.recordRestartPrepSuppressed(policy.operation, entry.event);
      this.markDeliveryHistoryStatus(inbox, entry, "suppressed");
      inbox.entries = inbox.entries.filter((candidate) => candidate !== entry);
    }
    return deliverable;
  }

  private deliverPendingEntries(
    orchId: string,
    inbox: HerdInbox,
    pending: InboxEntry[],
  ): { status: "sent" | "retry" | "dropped"; deliveredCount: number } {
    const groups = groupPendingEntriesByThread(pending);
    const deliveredEvents: TakodeEvent[] = [];
    for (const group of groups) {
      const events = group.entries.map((entry) => entry.event);
      const renderedBatch = renderHerdEventBatch(events, {
        getMessages: (sid, from, to) => getSessionMessageSlice(this.wsBridge, sid, from, to),
        lastEmittedMsgTo: inbox.lastEmittedMsgTo,
        leaderSessionId: orchId,
      });
      const delivery = this.wsBridge.injectUserMessage(
        orchId,
        renderedBatch.content,
        HERD_AGENT_SOURCE,
        snapshotHerdBatch(events, renderedBatch.renderedLines),
        group.route,
      );
      if (delivery === "dropped") return { status: "dropped", deliveredCount: deliveredEvents.length };
      if (delivery !== "sent") return { status: "retry", deliveredCount: deliveredEvents.length };
      deliveredEvents.push(...events);
    }

    updateLastEmittedMsgTo(inbox.lastEmittedMsgTo, deliveredEvents);
    this.rememberDeliveredEventKeys(inbox, deliveredEvents);
    inbox.inFlightUpTo = pending[pending.length - 1].seq;
    this.markPendingEntriesInFlight(inbox, pending.length);
    return { status: "sent", deliveredCount: deliveredEvents.length };
  }

  private markPendingEntriesInFlight(inbox: HerdInbox, count: number): void {
    const now = Date.now();
    let histIdx = inbox.deliveryHistory.length - count;
    if (histIdx < 0) histIdx = 0;
    for (let i = histIdx; i < inbox.deliveryHistory.length; i++) {
      if (inbox.deliveryHistory[i].status === "pending" || inbox.deliveryHistory[i].status === "redelivered") {
        inbox.deliveryHistory[i].deliveredAt = now;
        inbox.deliveryHistory[i].status = "in_flight";
      }
    }
  }

  /** Count of events waiting to be delivered. */
  private pendingCount(inbox: HerdInbox): number {
    return this.getPendingEntries(inbox).length;
  }

  private getRestartPrepDeliveryPolicy(
    orchId: string,
    event: TakodeEvent,
  ): { kind: "deliver" } | { kind: "hold" | "suppress"; operation: RestartPrepOperation } {
    const now = Date.now();
    for (const operation of this.restartPrepOperations.values()) {
      if (!operation.protectedLeaderIds.has(orchId)) continue;
      if (operation.targetSessionIds.has(event.sessionId) && now <= operation.suppressUntil) {
        return { kind: "suppress", operation };
      }
      if (now <= operation.holdUntil) {
        return { kind: "hold", operation };
      }
    }
    return { kind: "deliver" };
  }

  private resolveEventThreadRoute(event: TakodeEvent): ThreadRouteMetadata {
    const eventRoute =
      threadRouteFromEvent(event) ??
      inferActivityEventRouteFromHistory(event, this.wsBridge.getSession(event.sessionId)?.messageHistory);
    if (eventRoute && eventRoute.threadKey !== "main") return eventRoute;

    const questId =
      this.launcher.getSession?.(event.sessionId)?.claimedQuestId ??
      this.wsBridge.getSession(event.sessionId)?.state?.claimedQuestId;
    return questId && /^q-\d+$/i.test(questId)
      ? threadRouteForTarget(questId.toLowerCase(), "inferred")
      : { threadKey: "main" };
  }

  private recordRestartPrepSuppressed(operation: RestartPrepOperation, event: TakodeEvent): void {
    operation.suppressedHerdEvents += 1;
    if (event.event === "turn_end" || event.event === "session_disconnected") {
      operation.targetSessionIds.delete(event.sessionId);
    }
  }

  private markDeliveryHistoryStatus(inbox: HerdInbox, entry: InboxEntry, status: DeliveryRecord["status"]): void {
    const record = inbox.deliveryHistory.findLast(
      (item) =>
        item.event === entry.event.event && item.sessionName === entry.event.sessionName && item.ts === entry.event.ts,
    );
    if (record) record.status = status;
  }

  private rememberDeliveredEventKeys(inbox: HerdInbox, events: TakodeEvent[]): void {
    for (const event of events) {
      const key = getStableHerdEventKey(event);
      if (!key) continue;
      inbox.recentEventKeys.set(key, Date.now());
      trimRecentEventKeys(inbox);
    }
  }

  private hasCommittedHerdEventKey(orchId: string, key: string): boolean {
    return getCommittedHerdEventKeys(this.wsBridge.getSession(orchId)?.messageHistory).has(key);
  }

  private confirmCommittedHerdHistory(orchId: string, inbox: HerdInbox): void {
    if (inbox.inFlightUpTo !== null || inbox.entries.length === 0) return;
    const committedKeys = getCommittedHerdEventKeys(this.wsBridge.getSession(orchId)?.messageHistory);
    if (committedKeys.size === 0) return;

    const confirmedSeqs = new Set<number>();
    const confirmedEvents: TakodeEvent[] = [];
    const keptEntries: InboxEntry[] = [];
    for (const entry of inbox.entries) {
      const key = getStableHerdEventKey(entry.event);
      if (key && committedKeys.has(key)) {
        confirmedSeqs.add(entry.seq);
        confirmedEvents.push(entry.event);
        this.markDeliveryHistoryStatus(inbox, entry, "confirmed");
        this.confirmNotificationIfNeeded(entry);
        continue;
      }
      keptEntries.push(entry);
    }
    if (confirmedSeqs.size === 0) return;

    inbox.entries = keptEntries;
    while (confirmedSeqs.has(inbox.confirmedUpTo)) {
      inbox.confirmedUpTo += 1;
    }
    if (this.pendingCount(inbox) === 0 && inbox.debounceTimer) {
      clearTimeout(inbox.debounceTimer);
      inbox.debounceTimer = null;
    }
    this.rememberDeliveredEventKeys(inbox, confirmedEvents);
  }

  private confirmNotificationIfNeeded(entry: InboxEntry): void {
    if (entry.event.event !== "notification_needs_input") return;
    const notifId = entry.event.data.notificationId;
    if (typeof notifId !== "string" || notifId.length === 0) return;
    this.runtime?.markNotificationDone?.(entry.event.sessionId, notifId, true);
  }

  private releaseHeldRestartPrepEvents(operationId: string): void {
    const operation = this.restartPrepOperations.get(operationId);
    if (!operation) return;
    operation.holdUntil = 0;
    for (const leaderId of operation.protectedLeaderIds) {
      const inbox = this.inboxes.get(leaderId);
      if (!inbox) continue;
      for (const entry of inbox.entries) {
        if (entry.heldByRestartPrepOperationId !== operationId) continue;
        entry.heldByRestartPrepOperationId = undefined;
        this.markDeliveryHistoryStatus(inbox, entry, "pending");
      }
      if (this.pendingCount(inbox) === 0) continue;
      if (this.isSessionIdle(leaderId)) {
        this.scheduleDelivery(leaderId);
      } else if (this.wakeIdleKilledSession(leaderId)) {
        console.log(`[herd-dispatcher] Woke idle-killed leader ${leaderId} after restart-prep hold expired`);
      } else if (
        this.wakeUnavailableOrchestratorForPendingEvents(leaderId, "pending_herd_event_restart_prep_release")
      ) {
        console.log(
          `[herd-dispatcher] Requested unavailable leader recovery for ${leaderId} after restart-prep hold expired`,
        );
      } else {
        this.scheduleRetry(leaderId);
      }
    }
  }

  private snapshotRestartPrepOperation(operation: RestartPrepOperation): RestartPrepOperationSnapshot {
    return {
      operationId: operation.operationId,
      mode: operation.mode,
      startedAt: operation.startedAt,
      timeoutMs: operation.timeoutMs,
      suppressionTtlMs: operation.suppressionTtlMs,
      targetedSessions: operation.targetSummaries,
      protectedLeaders: operation.protectedLeaderSummaries,
      suppressedHerdEvents: operation.suppressedHerdEvents,
      heldHerdEvents: operation.heldHerdEvents,
      unresolvedBlockers: operation.unresolvedBlockers,
    };
  }

  private isSessionIdle(sessionId: string): boolean {
    if (typeof this.wsBridge.isSessionIdle === "function") {
      return this.wsBridge.isSessionIdle(sessionId);
    }
    return isSessionIdleRuntime(this.wsBridge.getSession(sessionId));
  }

  private wakeIdleKilledSession(sessionId: string): boolean {
    if (typeof this.wsBridge.wakeIdleKilledSession === "function") {
      return this.wsBridge.wakeIdleKilledSession(sessionId);
    }
    return this.launcher.getSession
      ? wakeIdleKilledSessionController(
          this.launcher as Pick<LauncherHandle, "getSession"> as any,
          sessionId,
          this.runtime?.requestCliRelaunch,
        )
      : false;
  }

  private wakeUnavailableOrchestratorForPendingEvents(sessionId: string, reason: string): boolean {
    return this.wsBridge.wakeUnavailableOrchestratorForPendingEvents?.(sessionId, reason) ?? false;
  }

  private getLeaderIdleState(): LeaderIdleStateLike | null {
    const sessions = this.runtime?.getSessions?.();
    if (!sessions) return null;
    return {
      leaderGroupIdleStates: this.leaderGroupIdleStates,
      sessions,
    };
  }

  /** Drop queued board_stalled/board_dispatchable events that no longer match the leader's active board. */
  private pruneStaleBoardStallEntries(orchId: string, inbox: HerdInbox): void {
    if (!this.wsBridge.getBoardRow) return;
    inbox.entries = inbox.entries.filter((entry) => {
      if (entry.event.event !== "board_stalled" && entry.event.event !== "board_dispatchable") return true;
      const current = this.wsBridge.getBoardRow!(orchId, entry.event.data.questId);
      if (!current) return false;
      if (entry.event.event === "board_stalled") {
        if (entry.event.data.stage && current.status !== entry.event.data.stage) return false;
        if (!this.wsBridge.getBoardStallSignature || !entry.event.data.signature) return true;
        return this.wsBridge.getBoardStallSignature(orchId, entry.event.data.questId) === entry.event.data.signature;
      }
      if (!this.wsBridge.getBoardDispatchableSignature || !entry.event.data.signature) return true;
      return (
        this.wsBridge.getBoardDispatchableSignature(orchId, entry.event.data.questId) === entry.event.data.signature
      );
    });
  }

  /** Retire an inbox once it has no workers and no queued/in-flight work left. */
  private maybeRetireInbox(orchId: string, inbox: HerdInbox): void {
    if (inbox.workerIds.size > 0) return;
    if (this.pendingCount(inbox) > 0) return;
    if (inbox.inFlightUpTo !== null) return;
    if (inbox.debounceTimer !== null) return;
    this.teardownForOrchestrator(orchId);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Clean up all inboxes (for server shutdown). */
  destroy(): void {
    for (const orchId of this.inboxes.keys()) {
      this.teardownForOrchestrator(orchId);
    }
    for (const idleState of this.leaderGroupIdleStates.values()) {
      if (idleState.timer) clearTimeout(idleState.timer);
    }
    this.leaderGroupIdleStates.clear();
    for (const operation of this.restartPrepOperations.values()) {
      clearTimeout(operation.releaseTimer);
      clearTimeout(operation.cleanupTimer);
    }
    this.restartPrepOperations.clear();
  }

  /** Get diagnostic info about an orchestrator's herd event state. */
  getDiagnostics(orchId: string): {
    hasInbox: boolean;
    pendingEventCount: number;
    pendingEventTypes: string[];
    inFlightCount: number;
    confirmedUpTo: number;
    workerCount: number;
    debounceActive: boolean;
    eventHistory: DeliveryRecord[];
  } {
    const inbox = this.inboxes.get(orchId);
    if (!inbox) {
      return {
        hasInbox: false,
        pendingEventCount: 0,
        pendingEventTypes: [],
        inFlightCount: 0,
        confirmedUpTo: 0,
        workerCount: 0,
        debounceActive: false,
        eventHistory: [],
      };
    }
    const pending = this.getPendingEntries(inbox);
    const inFlight =
      inbox.inFlightUpTo !== null
        ? inbox.entries.filter((e) => e.seq >= inbox.confirmedUpTo && e.seq <= inbox.inFlightUpTo!).length
        : 0;
    return {
      hasInbox: true,
      pendingEventCount: pending.length,
      pendingEventTypes: pending.map((e) => e.event.event),
      inFlightCount: inFlight,
      confirmedUpTo: inbox.confirmedUpTo,
      workerCount: inbox.workerIds.size,
      debounceActive: inbox.debounceTimer !== null,
      eventHistory: inbox.deliveryHistory,
    };
  }

  /** Expose for testing */
  _getInbox(orchId: string): HerdInbox | undefined {
    return this.inboxes.get(orchId);
  }
}

// ─── Event Formatting ───────────────────────────────────────────────────────────

export interface FormatBatchOptions {
  nowTs?: number;
  /** Callback to fetch a slice of a worker's messageHistory for activity summaries.
   *  When provided, turn_end events include peek-style activity showing what happened. */
  getMessages?: (sessionId: string, from: number, to: number) => BrowserIncomingMessage[] | null;
  /** Per-worker deduplication watermark: highest msgRange.to already delivered.
   *  Prevents re-injecting overlapping activity across consecutive batches. */
  lastEmittedMsgTo?: Map<string, number>;
  /** Current leader session id, used to compact echoed leader instructions in activity. */
  leaderSessionId?: string;
}

export interface RenderedHerdEventBatch {
  content: string;
  renderedLines: string[];
}

/** Format a batch of events into a compact, scannable summary. */
export function formatHerdEventBatch(events: TakodeEvent[], options?: FormatBatchOptions): string {
  return renderHerdEventBatch(events, options).content;
}

export function renderHerdEventBatch(events: TakodeEvent[], options?: FormatBatchOptions): RenderedHerdEventBatch {
  const nowTs = options?.nowTs ?? Date.now();
  const renderWatermarks = options?.lastEmittedMsgTo ? new Map(options.lastEmittedMsgTo) : undefined;
  const renderedLines = events.map((event) => {
    const renderOptions = renderWatermarks ? { ...options, lastEmittedMsgTo: renderWatermarks } : options;
    const rendered = formatSingleEvent(event, nowTs, renderOptions);
    if (renderWatermarks) updateLastEmittedMsgTo(renderWatermarks, [event]);
    return rendered;
  });
  return {
    content: formatRenderedHerdEventBatch(events, renderedLines),
    renderedLines,
  };
}

export function formatRenderedHerdEventBatch(events: TakodeEvent[], renderedLines: string[]): string {
  const sessionIds = new Set(events.map((e) => e.sessionId));
  const header = `${events.length} event${events.length === 1 ? "" : "s"} from ${sessionIds.size} session${sessionIds.size === 1 ? "" : "s"}`;
  return `${header}\n\n${renderedLines.join("\n")}`;
}

function formatSingleEvent(evt: TakodeEvent, nowTs: number, options?: FormatBatchOptions): string {
  const label = `#${evt.sessionNum}`;
  const age = formatRelativeAge(evt.ts, nowTs);
  const ageSuffix = age ? ` | ${age}` : "";
  switch (evt.event) {
    case "turn_end": {
      const duration = formatDuration(evt.data.duration_ms);
      const tools = formatToolCounts(evt.data.tools);
      const resultPreview =
        typeof evt.data.resultPreview === "string" ? ` | "${truncate(evt.data.resultPreview, 60)}"` : "";
      const compacted = evt.data.compacted ? " (compacted)" : "";
      // Annotate user-initiated turns so the leader knows this wasn't its work
      const userInitiated = evt.data.turn_source === "user" ? " (user-initiated)" : "";
      const interruptSource = evt.data.interrupt_source ?? null;
      const success = evt.data.interrupted
        ? `interrupted${interruptSource ? ` (by ${interruptSource})` : ""}`
        : evt.data.is_error
          ? "✗"
          : "✓";
      // Message ID range for quick peek navigation
      const range = evt.data.msgRange;
      const rangeStr = range ? ` | [${range.from}]-[${range.to}]` : "";
      // User messages received during this turn (deferred from individual delivery)
      const um = evt.data.userMsgs;
      const userMsgStr = um ? ` | ${um.count} user msg${um.count === 1 ? "" : "s"} [${um.ids.join(", ")}]` : "";
      // Quest status change during this turn
      const qc = evt.data.questChange;
      const questStr = qc ? ` | ${qc.questId}: ${qc.from} → ${qc.to}` : "";

      const statusLine = `${label} | turn_end | ${success} ${duration}${compacted}${userInitiated}${tools}${rangeStr}${userMsgStr}${questStr}${resultPreview}${ageSuffix}`;

      // Auto-inject peek-style activity summary between events
      const activity = buildActivityForEvent(evt, options);
      if (activity) {
        return `${statusLine}\n${activity}`;
      }
      return statusLine;
    }
    case "worker_stream": {
      const duration = formatDuration(evt.data.duration_ms);
      const tools = formatToolCounts(evt.data.tools);
      const resultPreview =
        typeof evt.data.resultPreview === "string" ? ` | "${truncate(evt.data.resultPreview, 60)}"` : "";
      const userInitiated = evt.data.turn_source === "user" ? " (user-initiated)" : "";
      const range = evt.data.msgRange;
      const rangeStr = range ? ` | [${range.from}]-[${range.to}]` : "";
      const um = evt.data.userMsgs;
      const userMsgStr = um ? ` | ${um.count} user msg${um.count === 1 ? "" : "s"} [${um.ids.join(", ")}]` : "";
      const qc = evt.data.questChange;
      const questStr = qc ? ` | ${qc.questId}: ${qc.from} → ${qc.to}` : "";
      const statusLine = `${label} | worker_stream | checkpoint ${duration}${userInitiated}${tools}${rangeStr}${userMsgStr}${questStr}${resultPreview}${ageSuffix}`;
      const activity = buildActivityForEvent(evt, options);
      if (activity) {
        return `${statusLine}\n${activity}`;
      }
      return statusLine;
    }
    case "compaction_started": {
      const pct =
        typeof evt.data.context_used_percent === "number"
          ? ` | context ${Math.round(evt.data.context_used_percent)}% full`
          : "";
      return `${label} | compaction_started${pct}${ageSuffix}`;
    }
    case "permission_request": {
      const tool = evt.data.tool_name || "unknown";
      const summary = typeof evt.data.summary === "string" ? `: ${truncate(evt.data.summary, 60)}` : "";
      // Annotate user-initiated permission requests so the leader knows to leave them for the user
      const userInitiated = evt.data.turn_source === "user" ? " (user-initiated)" : "";
      // Include message index so the leader can run `takode read <session> <msg_index>`
      const msgRef = typeof evt.data.msg_index === "number" ? ` | msg [${evt.data.msg_index}]` : "";
      const header = `${label} | permission_request${userInitiated} | ${tool}${summary}${msgRef}${ageSuffix}`;
      const answerTarget =
        typeof evt.data.msg_index === "number"
          ? ` --message ${evt.data.msg_index}`
          : typeof evt.data.request_id === "string" && evt.data.request_id
            ? ` --target ${evt.data.request_id}`
            : "";
      if (tool === "AskUserQuestion") {
        const details: string[] = [];
        if (typeof evt.data.question === "string" && evt.data.question.trim()) {
          details.push(`Question: ${evt.data.question}`);
        }
        if (Array.isArray(evt.data.options)) {
          for (let i = 0; i < evt.data.options.length; i++) {
            details.push(`${i + 1}. ${evt.data.options[i]}`);
          }
        }
        if (typeof evt.sessionNum === "number") {
          details.push(`Answer: takode answer ${evt.sessionNum}${answerTarget} <option-number-or-text>`);
          if (typeof evt.data.msg_index === "number") {
            details.push(`Read: takode read ${evt.sessionNum} ${evt.data.msg_index}`);
          }
        }
        if (details.length > 0) {
          return `${header}\n${details.map((line) => `  ${line}`).join("\n")}`;
        }
      }
      // Include full plan content so leaders can review inline without extra tool calls
      if (typeof evt.data.planContent === "string" && evt.data.planContent.length > 0) {
        const actions =
          typeof evt.sessionNum === "number"
            ? [
                `Approve: takode answer ${evt.sessionNum}${answerTarget} approve`,
                `Reject: takode answer ${evt.sessionNum}${answerTarget} reject "feedback here"`,
              ]
            : [];
        return `${header}\n\n<plan>\n${evt.data.planContent}\n</plan>${actions.length > 0 ? `\n${actions.map((line) => `  ${line}`).join("\n")}` : ""}`;
      }
      return header;
    }
    case "herd_reassigned": {
      const reviewerSuffix =
        typeof evt.data.reviewerCount === "number" && evt.data.reviewerCount > 0
          ? ` | +${evt.data.reviewerCount} reviewer${evt.data.reviewerCount === 1 ? "" : "s"}`
          : "";
      return `${label} | herd_reassigned | ${evt.data.fromLeaderLabel} -> ${evt.data.toLeaderLabel}${reviewerSuffix}${ageSuffix}`;
    }
    case "session_error": {
      const error = typeof evt.data.error === "string" ? truncate(evt.data.error, 80) : "unknown error";
      return `${label} | session_error | ${error}${ageSuffix}`;
    }
    case "session_disconnected": {
      const reason = evt.data.reason;
      return `${label} | session_disconnected | ${reason}${ageSuffix}`;
    }
    case "session_archived": {
      const userInitiated = evt.data.archive_source === "user" ? " (user-initiated)" : "";
      return `${label} | session_archived${userInitiated}${ageSuffix}`;
    }
    case "user_message": {
      const content = truncate(evt.data.content, 5000);
      // Show who sent the message: [User], [Agent #N name], or [Herd]
      const agentSource = evt.data.agentSource;
      let sender = "User";
      if (agentSource?.sessionId === "herd-events") {
        sender = "Herd";
      } else if (agentSource?.sessionId) {
        sender = agentSource.sessionLabel ? `Agent ${agentSource.sessionLabel}` : "Agent";
      }
      const msgRef = typeof evt.data.msg_index === "number" ? ` | msg [${evt.data.msg_index}]` : "";
      const messageId = typeof evt.data.message_id === "string" ? ` | id ${evt.data.message_id}` : "";
      const turnTarget =
        evt.data.turn_target === "current" || evt.data.turn_target === "queued"
          ? ` | turn ${evt.data.turn_target}`
          : "";
      const turnId = typeof evt.data.turn_id === "string" && evt.data.turn_id ? ` ${evt.data.turn_id}` : "";
      if (!agentSource?.sessionId) {
        return `${label} | user_message | user sent to ${formatSessionLink(evt)}${msgRef}${messageId}${turnTarget}${turnId}: "${content}"${ageSuffix}\n---\nThe worker should be reacting to this user message now.`;
      }
      return `${label} | user_message [${sender}]${msgRef}${messageId}${turnTarget}${turnId} | "${content}"${ageSuffix}`;
    }
    case "notification_needs_input": {
      const summary = typeof evt.data.summary === "string" ? ` | "${truncate(evt.data.summary, 80)}"` : "";
      const msgRef = typeof evt.data.msg_index === "number" ? ` | msg [${evt.data.msg_index}]` : "";
      const header = `${label} | notification_needs_input${summary}${msgRef}${ageSuffix}`;
      if (typeof evt.sessionNum !== "number") return header;
      const answerTarget =
        typeof evt.data.msg_index === "number"
          ? ` --message ${evt.data.msg_index}`
          : typeof evt.data.notificationId === "string" && evt.data.notificationId
            ? ` --target ${evt.data.notificationId}`
            : "";
      const actions =
        Array.isArray(evt.data.suggestedAnswers) && evt.data.suggestedAnswers.length > 0
          ? [`Suggestions: ${evt.data.suggestedAnswers.map((answer) => truncate(answer, 32)).join(", ")}`]
          : [];
      actions.push(`Answer: takode answer ${evt.sessionNum}${answerTarget} <response>`);
      if (typeof evt.data.msg_index === "number") {
        actions.push(`Read: takode read ${evt.sessionNum} ${evt.data.msg_index}`);
      }
      return `${header}\n${actions.map((line) => `  ${line}`).join("\n")}`;
    }
    case "board_stalled": {
      const quest = evt.data.title ? `${evt.data.questId} ${truncate(evt.data.title, 40)}` : evt.data.questId;
      const stage = evt.data.stage ? ` | ${evt.data.stage}` : "";
      const stalledForMins = Math.max(1, Math.round(evt.data.stalledForMs / 60_000));
      const action = typeof evt.data.action === "string" ? ` | next: ${truncate(evt.data.action, 80)}` : "";
      return `${label} | board_stalled | ${quest}${stage} | ${evt.data.reason} | stalled ${stalledForMins}m${action}${ageSuffix}`;
    }
    case "board_dispatchable": {
      const quest = evt.data.title ? `${evt.data.questId} ${truncate(evt.data.title, 40)}` : evt.data.questId;
      const action = typeof evt.data.action === "string" ? ` | next: ${truncate(evt.data.action, 80)}` : "";
      return `${label} | board_dispatchable | ${quest} | ${truncate(evt.data.summary, 120)}${action}${ageSuffix}`;
    }
    default:
      return `${label} | ${evt.event}${ageSuffix}`;
  }
}

// ─── Activity Injection ──────────────────────────────────────────────────────────

/** Build a peek-style activity summary for a turn_end event.
 *  Uses the event's msgRange to fetch the relevant message history slice,
 *  with deduplication to avoid re-injecting overlapping content. */
function buildActivityForEvent(evt: TakodeEvent, options?: FormatBatchOptions): string | null {
  const range = getActivityEventRange(evt);
  if (!range) return null;
  if (!options?.getMessages) return null;

  // Deduplication: start after the last-emitted message for this worker
  const lastEmitted = options.lastEmittedMsgTo?.get(evt.sessionId) ?? -1;
  const deduplicatedFrom = Math.max(range.from, lastEmitted + 1);
  const messages = options.getMessages(evt.sessionId, range.from, range.to);
  if (!messages || messages.length === 0) return null;

  const activity = formatActivitySummaryDetailed(messages, {
    startIdx: range.from,
    deduplicatedFrom,
    leaderSessionId: options.leaderSessionId,
  });
  return activity.text || null;
}

/** Update per-worker deduplication watermarks after delivering a batch. */
function updateLastEmittedMsgTo(watermarks: Map<string, number>, events: TakodeEvent[]): void {
  for (const evt of events) {
    const range = getActivityEventRange(evt);
    if (!range) continue;
    const current = watermarks.get(evt.sessionId) ?? -1;
    if (range.to > current) {
      watermarks.set(evt.sessionId, range.to);
    }
  }
}

function getActivityEventRange(evt: TakodeEvent): { from: number; to: number } | undefined {
  if (evt.event === "turn_end" || evt.event === "worker_stream") return evt.data.msgRange;
  return undefined;
}

function threadRouteFromEvent(event: TakodeEvent): ThreadRouteMetadata | null {
  const questId = questIdFromEvent(event);
  if (questId && /^q-\d+$/i.test(questId)) return threadRouteForTarget(questId.toLowerCase(), "inferred");
  if (
    (event.event === "turn_end" || event.event === "worker_stream") &&
    event.data.threadKey &&
    /^q-\d+$/i.test(event.data.threadKey)
  ) {
    return threadRouteForTarget(event.data.threadKey.toLowerCase(), "inferred");
  }
  return null;
}

function questIdFromEvent(event: TakodeEvent): string | undefined {
  switch (event.event) {
    case "turn_end":
    case "worker_stream":
      return event.data.questId ?? event.data.questChange?.questId;
    case "board_stalled":
    case "board_dispatchable":
      return event.data.questId;
    case "permission_request":
    case "notification_needs_input":
    case "user_message":
      return event.data.questId;
    default:
      return undefined;
  }
}

function inferActivityEventRouteFromHistory(
  event: TakodeEvent,
  history: BrowserIncomingMessage[] | undefined,
): ThreadRouteMetadata | null {
  if ((event.event !== "turn_end" && event.event !== "worker_stream") || !history?.length) return null;
  const candidates = new Set<number>();
  for (const index of event.data.userMsgs?.ids ?? []) {
    if (Number.isInteger(index)) candidates.add(index);
  }
  const range = event.data.msgRange;
  if (range) {
    for (let index = range.to; index >= range.from; index--) {
      candidates.add(index);
    }
  }

  for (const index of candidates) {
    const entry = history[index];
    const route = routeFromHistoryEntry(entry);
    if (route && route.threadKey !== "main") return threadRouteForTarget(route.threadKey, "inferred");
    if (entry?.type === "user_message" && entry.agentSource?.sessionId) {
      const inferredRoute = inferRouteFromHistoryEntryContent(entry);
      if (inferredRoute && inferredRoute.threadKey !== "main") return inferredRoute;
    }
  }
  return null;
}

function getStableHerdEventKey(event: TakodeEvent): string | null {
  if (event.event === "turn_end") {
    const range = event.data.msgRange;
    if (!range) return null;
    return [
      "turn_end",
      event.sessionId,
      event.data.reason,
      event.data.duration_ms,
      event.data.is_error,
      event.data.interrupted,
      event.data.interrupt_source,
      event.data.interrupt_origin,
      event.data.restart_prep_operation_id,
      event.data.compacted,
      event.data.threadKey,
      event.data.questId,
      stableToolCountsPart(event.data.tools),
      truncate(typeof event.data.resultPreview === "string" ? event.data.resultPreview : "", 60),
      range.from,
      range.to,
      event.data.questChange?.questId,
      event.data.questChange?.from,
      event.data.questChange?.to,
      event.data.userMsgs?.count,
      stableNumberListPart(event.data.userMsgs?.ids),
      event.data.turn_source,
    ]
      .map(stableKeyPart)
      .join("|");
  }
  if (event.event === "worker_stream") {
    const range = event.data.msgRange;
    if (!range) return null;
    return [
      "worker_stream",
      event.sessionId,
      event.data.reason,
      event.data.duration_ms,
      event.data.threadKey,
      event.data.questId,
      stableToolCountsPart(event.data.tools),
      truncate(typeof event.data.resultPreview === "string" ? event.data.resultPreview : "", 60),
      range.from,
      range.to,
      event.data.questChange?.questId,
      event.data.questChange?.from,
      event.data.questChange?.to,
      event.data.userMsgs?.count,
      stableNumberListPart(event.data.userMsgs?.ids),
      event.data.turn_source,
    ]
      .map(stableKeyPart)
      .join("|");
  }
  if (event.event === "board_stalled") {
    return [
      "board_stalled",
      event.sessionId,
      event.data.questId,
      event.data.stage,
      event.data.signature,
      event.data.workerStatus,
      event.data.reviewerStatus,
      event.data.reason,
      event.data.action,
    ]
      .map(stableKeyPart)
      .join("|");
  }
  if (event.event === "board_dispatchable") {
    return [
      "board_dispatchable",
      event.sessionId,
      event.data.questId,
      event.data.signature,
      event.data.summary,
      event.data.action,
    ]
      .map(stableKeyPart)
      .join("|");
  }
  return null;
}

function inboxHasEventKey(inbox: HerdInbox, key: string): boolean {
  return inbox.entries.some((entry) => getStableHerdEventKey(entry.event) === key);
}

function getCommittedHerdEventKeys(history: BrowserIncomingMessage[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const msg of history ?? []) {
    if (msg.type !== "user_message" || msg.agentSource?.sessionId !== HERD_AGENT_SOURCE.sessionId) continue;
    for (const key of msg.takodeHerdEventKeys ?? []) {
      if (typeof key === "string" && key.length > 0) keys.add(key);
    }
  }
  return keys;
}

function trimRecentEventKeys(inbox: HerdInbox): void {
  if (inbox.recentEventKeys.size <= RECENT_EVENT_DEDUPE_CAP) return;
  const excess = inbox.recentEventKeys.size - RECENT_EVENT_DEDUPE_CAP;
  let removed = 0;
  for (const oldKey of inbox.recentEventKeys.keys()) {
    inbox.recentEventKeys.delete(oldKey);
    removed += 1;
    if (removed >= excess) break;
  }
}

function stableToolCountsPart(tools: Record<string, number> | undefined): string {
  if (!tools) return "";
  return Object.entries(tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tool, count]) => `${tool}:${count}`)
    .join(",");
}

function stableNumberListPart(values: number[] | undefined): string {
  return values?.join(",") ?? "";
}

function stableKeyPart(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function snapshotHerdBatch(events: TakodeEvent[], renderedLines: string[]): TakodeHerdBatchSnapshot | undefined {
  const eventKeys = events.map((event) => getStableHerdEventKey(event) ?? "");
  const hasBoardStalledEvent = events.some((event) => event.event === "board_stalled");
  if (!hasBoardStalledEvent && !eventKeys.some(Boolean)) return undefined;
  return { events, renderedLines, ...(eventKeys.some(Boolean) ? { eventKeys } : {}) };
}

function groupPendingEntriesByThread(
  entries: InboxEntry[],
): Array<{ route: ThreadRouteMetadata; entries: InboxEntry[] }> {
  const groups = new Map<string, { route: ThreadRouteMetadata; entries: InboxEntry[] }>();
  for (const entry of entries) {
    const key = routeKey(entry.threadRoute);
    let group = groups.get(key);
    if (!group) {
      group = { route: entry.threadRoute, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function formatSessionLink(evt: TakodeEvent): string {
  return typeof evt.sessionNum === "number" && evt.sessionNum > 0
    ? `[#${evt.sessionNum}](session:${evt.sessionNum})`
    : evt.sessionName;
}

function formatToolCounts(tools: Record<string, number> | undefined): string {
  if (!tools || Object.keys(tools).length === 0) return "";
  const total = Object.values(tools).reduce((sum, count) => sum + count, 0);
  return ` | tools: ${total}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatRelativeAge(ts: number, nowTs: number): string {
  const deltaMs = Math.max(0, nowTs - ts);
  const deltaSec = Math.floor(deltaMs / 1000);
  // Skip "0s ago" — it provides no useful information and clutters the output.
  // Events delivered within 1 second of emission are effectively "just now".
  if (deltaSec < 1) return "";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHour = Math.floor(deltaMin / 60);
  if (deltaHour < 24) return `${deltaHour}h ago`;
  const deltaDay = Math.floor(deltaHour / 24);
  return `${deltaDay}d ago`;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
