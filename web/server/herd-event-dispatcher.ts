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

import type { TakodeEvent, TakodeEventType, BrowserIncomingMessage } from "./session-types.js";
import { formatActivitySummaryDetailed } from "./herd-activity-formatter.js";

// ─── Interfaces (for testability — avoids importing full WsBridge/CliLauncher) ──

export interface WsBridgeHandle {
  subscribeTakodeEvents(sessions: Set<string>, cb: (e: TakodeEvent) => void, since?: number): () => void;
  injectUserMessage(
    sessionId: string,
    content: string,
    agentSource?: { sessionId: string; sessionLabel?: string },
  ): "sent" | "queued" | "no_session";
  isSessionIdle(sessionId: string): boolean;
  /** Wake a session that was stopped by idle-manager. Clears the killedByIdleManager
   *  flag and triggers a CLI relaunch so the session can process queued events.
   *  Returns true if a relaunch was requested, false if the session wasn't idle-killed. */
  wakeIdleKilledSession(sessionId: string): boolean;
  /** Retrieve a slice of a session's messageHistory for activity summaries.
   *  Returns null if the session doesn't exist. Indices are inclusive [from, to]. */
  getSessionMessages(sessionId: string, from: number, to: number): BrowserIncomingMessage[] | null;
  /** Current active board row for a leader session + quest ID, if any. */
  getBoardRow?(sessionId: string, questId: string): { status?: string } | null;
  /** Current live stall signature for a leader board row, if it is still stalled. */
  getBoardStallSignature?(sessionId: string, questId: string): string | null;
}

export interface LauncherHandle {
  getHerdedSessions(orchId: string): Array<{ sessionId: string }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Events worth delivering to orchestrators.
 *  session_disconnected is included for full disconnects after the backend has
 *  actually dropped out of service. These events are distinct from transient
 *  reconnect windows because the bridge only emits them after the disconnect is
 *  considered actionable.
 *  user_message is excluded — individual messages are noisy and truncated.
 *  Instead, user message count + IDs are included in the turn_end event
 *  so the leader can peek at specific messages via [msg-id] if needed. */
const ACTIONABLE_EVENTS = new Set<TakodeEventType>([
  "turn_end",
  "permission_request",
  "permission_resolved",
  "herd_reassigned",
  "session_error",
  "session_disconnected",
  "session_archived",
  "session_deleted",
  "board_stalled",
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

/** agentSource used to tag herd event messages */
const HERD_AGENT_SOURCE = { sessionId: "herd-events", sessionLabel: "Herd Events" } as const;

// ─── Inbox State ────────────────────────────────────────────────────────────────

interface InboxEntry {
  event: TakodeEvent;
  /** Monotonic sequence number within this inbox */
  seq: number;
}

interface DeliveryRecord {
  event: string;
  sessionName: string;
  ts: number;
  deliveredAt: number | null;
  status: "pending" | "in_flight" | "confirmed" | "redelivered";
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
  /** Per-worker: highest msgRange.to from the last delivered batch.
   *  Prevents re-injecting the same activity in consecutive turn_end events. */
  lastEmittedMsgTo: Map<string, number>;
  /** Per-worker: user message indices that were actually surfaced in prior activity output. */
  seenUserMsgIdxs: Map<string, Set<number>>;
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────────

export class HerdEventDispatcher {
  private inboxes = new Map<string, HerdInbox>();

  constructor(
    private wsBridge: WsBridgeHandle,
    private launcher: LauncherHandle,
  ) {}

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
      if (this.pendingCount(existing) > 0 && this.wsBridge.isSessionIdle(orchId)) {
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
        lastEmittedMsgTo: new Map(),
        seenUserMsgIdxs: new Map(),
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

    // Append to inbox (pure in-memory, never fails)
    const seq = inbox.nextSeq++;
    inbox.entries.push({ event, seq });

    // Track in delivery history
    inbox.deliveryHistory.push({
      event: event.event,
      sessionName: event.sessionName,
      ts: event.ts,
      deliveredAt: null,
      status: "pending",
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

    // If orchestrator is idle, schedule delivery
    if (this.wsBridge.isSessionIdle(orchId)) {
      this.scheduleDelivery(orchId);
    } else if (this.wsBridge.wakeIdleKilledSession(orchId)) {
      // Leader was stopped by idle-manager — wake it up.
      // Events stay pending in the inbox; they'll be flushed once the CLI
      // reconnects and goes idle (via onOrchestratorTurnEnd or the normal
      // isSessionIdle check in scheduleDelivery).
      console.log(
        `[herd-dispatcher] Woke idle-killed leader ${orchId} to deliver ${this.pendingCount(inbox)} pending herd event(s)`,
      );
    }
    // If generating, events accumulate — delivered on next onOrchestratorTurnEnd
  }

  // ─── Event Delivery (step 2: inject when CLI is ready) ────────────────────

  /** Called from ws-bridge when an orchestrator finishes a turn. */
  onOrchestratorTurnEnd(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox) return;

    // Confirm in-flight events: the turn completed, so the CLI consumed them
    if (inbox.inFlightUpTo !== null) {
      inbox.confirmedUpTo = inbox.inFlightUpTo + 1;
      inbox.inFlightUpTo = null;
      // Trim confirmed entries from the inbox
      while (inbox.entries.length > 0 && inbox.entries[0].seq < inbox.confirmedUpTo) {
        inbox.entries.shift();
      }
    }

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
  }

  /** Force-deliver pending events, bypassing the isSessionIdle() gate.
   *  Called by the stuck-session watchdog when a leader has been stuck for
   *  too long — events would otherwise remain stranded indefinitely.
   *  Returns the number of events delivered (0 if nothing was pending). */
  forceFlushPendingEvents(orchId: string): number {
    const inbox = this.inboxes.get(orchId);
    if (!inbox) return 0;
    this.pruneStaleBoardStallEntries(orchId, inbox);
    const pending = this.getPendingEntries(inbox);
    if (pending.length === 0) return 0;

    const events = pending.map((e) => e.event);
    const surfacedUserMsgIdxs = new Map<string, Set<number>>();
    const content = formatHerdEventBatch(events, {
      getMessages: (sid, from, to) => this.wsBridge.getSessionMessages(sid, from, to),
      lastEmittedMsgTo: inbox.lastEmittedMsgTo,
      seenUserMsgIdxs: inbox.seenUserMsgIdxs,
      surfacedUserMsgIdxs,
    });
    const delivery = this.wsBridge.injectUserMessage(orchId, content, HERD_AGENT_SOURCE);
    if (delivery !== "sent") {
      if (delivery === "queued") {
        this.scheduleRetry(orchId);
      }
      return 0;
    }

    // Update deduplication watermarks from the events we just delivered
    updateLastEmittedMsgTo(inbox.lastEmittedMsgTo, events);
    mergeSurfacedUserMsgIdxs(inbox.seenUserMsgIdxs, surfacedUserMsgIdxs);

    const lastSeq = pending[pending.length - 1].seq;
    inbox.inFlightUpTo = lastSeq;

    const now = Date.now();
    let histIdx = inbox.deliveryHistory.length - pending.length;
    if (histIdx < 0) histIdx = 0;
    for (let i = histIdx; i < inbox.deliveryHistory.length; i++) {
      if (inbox.deliveryHistory[i].status === "pending" || inbox.deliveryHistory[i].status === "redelivered") {
        inbox.deliveryHistory[i].deliveredAt = now;
        inbox.deliveryHistory[i].status = "in_flight";
      }
    }

    return events.length;
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

    const pending = this.getPendingEntries(inbox);
    if (pending.length === 0) {
      this.maybeRetireInbox(orchId, inbox);
      return;
    }

    // Re-check idle — orchestrator may have started generating during debounce
    if (!this.wsBridge.isSessionIdle(orchId)) {
      // If the leader was idle-killed during the debounce window, wake it.
      // Otherwise schedule a retry — the leader is busy and will get events
      // when its turn ends (onOrchestratorTurnEnd) or on the next retry.
      if (this.wsBridge.wakeIdleKilledSession(orchId)) {
        console.log(`[herd-dispatcher] Woke idle-killed leader ${orchId} during flush retry`);
      } else {
        this.scheduleRetry(orchId);
      }
      return;
    }

    // Format and inject
    const events = pending.map((e) => e.event);
    const surfacedUserMsgIdxs = new Map<string, Set<number>>();
    const content = formatHerdEventBatch(events, {
      getMessages: (sid, from, to) => this.wsBridge.getSessionMessages(sid, from, to),
      lastEmittedMsgTo: inbox.lastEmittedMsgTo,
      seenUserMsgIdxs: inbox.seenUserMsgIdxs,
      surfacedUserMsgIdxs,
    });
    const delivery = this.wsBridge.injectUserMessage(orchId, content, HERD_AGENT_SOURCE);
    if (delivery !== "sent") {
      if (delivery === "queued") {
        this.scheduleRetry(orchId);
      }
      return;
    }

    // Update deduplication watermarks from the events we just delivered
    updateLastEmittedMsgTo(inbox.lastEmittedMsgTo, events);
    mergeSurfacedUserMsgIdxs(inbox.seenUserMsgIdxs, surfacedUserMsgIdxs);

    // Mark as in-flight (NOT confirmed yet — that happens on turn end)
    const lastSeq = pending[pending.length - 1].seq;
    inbox.inFlightUpTo = lastSeq;

    // Update delivery history
    const now = Date.now();
    let histIdx = inbox.deliveryHistory.length - pending.length;
    if (histIdx < 0) histIdx = 0;
    for (let i = histIdx; i < inbox.deliveryHistory.length; i++) {
      if (inbox.deliveryHistory[i].status === "pending" || inbox.deliveryHistory[i].status === "redelivered") {
        inbox.deliveryHistory[i].deliveredAt = now;
        inbox.deliveryHistory[i].status = "in_flight";
      }
    }
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

  /** Count of events waiting to be delivered. */
  private pendingCount(inbox: HerdInbox): number {
    return this.getPendingEntries(inbox).length;
  }

  /** Drop queued board_stalled events that no longer match the leader's active board. */
  private pruneStaleBoardStallEntries(orchId: string, inbox: HerdInbox): void {
    if (!this.wsBridge.getBoardRow) return;
    inbox.entries = inbox.entries.filter((entry) => {
      if (entry.event.event !== "board_stalled") return true;
      const current = this.wsBridge.getBoardRow!(orchId, entry.event.data.questId);
      if (!current) return false;
      if (entry.event.data.stage && current.status !== entry.event.data.stage) return false;
      if (!this.wsBridge.getBoardStallSignature || !entry.event.data.signature) return true;
      return this.wsBridge.getBoardStallSignature(orchId, entry.event.data.questId) === entry.event.data.signature;
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
  /** Per-worker set of user message indices already surfaced in prior deliveries. */
  seenUserMsgIdxs?: Map<string, Set<number>>;
  /** Collector populated with the user message indices actually surfaced by this batch. */
  surfacedUserMsgIdxs?: Map<string, Set<number>>;
}

/** Format a batch of events into a compact, scannable summary. */
export function formatHerdEventBatch(events: TakodeEvent[], options?: FormatBatchOptions): string {
  const nowTs = options?.nowTs ?? Date.now();
  // Count unique sessions
  const sessionIds = new Set(events.map((e) => e.sessionId));
  const header = `${events.length} event${events.length === 1 ? "" : "s"} from ${sessionIds.size} session${sessionIds.size === 1 ? "" : "s"}`;

  const lines = events.map((event) => formatSingleEvent(event, nowTs, options));
  return `${header}\n\n${lines.join("\n")}`;
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
      const content = truncate(evt.data.content, 80);
      // Show who sent the message: [User], [Agent #N name], or [Herd]
      const agentSource = evt.data.agentSource;
      let sender = "User";
      if (agentSource?.sessionId === "herd-events") {
        sender = "Herd";
      } else if (agentSource?.sessionId) {
        sender = agentSource.sessionLabel ? `Agent ${agentSource.sessionLabel}` : "Agent";
      }
      return `${label} | user_message [${sender}] | "${content}"${ageSuffix}`;
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
      const actions = [`Answer: takode answer ${evt.sessionNum}${answerTarget} <response>`];
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
    default:
      return `${label} | ${evt.event}${ageSuffix}`;
  }
}

// ─── Activity Injection ──────────────────────────────────────────────────────────

/** Build a peek-style activity summary for a turn_end event.
 *  Uses the event's msgRange to fetch the relevant message history slice,
 *  with deduplication to avoid re-injecting overlapping content. */
function buildActivityForEvent(evt: TakodeEvent, options?: FormatBatchOptions): string | null {
  if (evt.event !== "turn_end") return null;
  if (!options?.getMessages) return null;

  const range = evt.data.msgRange;
  if (!range) return null;

  // Deduplication: start after the last-emitted message for this worker
  const lastEmitted = options.lastEmittedMsgTo?.get(evt.sessionId) ?? -1;
  const deduplicatedFrom = Math.max(range.from, lastEmitted + 1);
  const messages = options.getMessages(evt.sessionId, range.from, range.to);
  if (!messages || messages.length === 0) return null;

  const seenUserMsgIdxs = options.seenUserMsgIdxs?.get(evt.sessionId);
  const activity = formatActivitySummaryDetailed(messages, {
    startIdx: range.from,
    deduplicatedFrom,
    seenUserMsgIdxs,
  });
  if (activity.surfacedUserMsgIdxs.length > 0) {
    const collected = options.surfacedUserMsgIdxs?.get(evt.sessionId) ?? new Set<number>();
    for (const idx of activity.surfacedUserMsgIdxs) collected.add(idx);
    options.surfacedUserMsgIdxs?.set(evt.sessionId, collected);
  }
  return activity.text || null;
}

/** Update per-worker deduplication watermarks after delivering a batch. */
function updateLastEmittedMsgTo(watermarks: Map<string, number>, events: TakodeEvent[]): void {
  for (const evt of events) {
    if (evt.event !== "turn_end") continue;
    const range = evt.data.msgRange;
    if (!range) continue;
    const current = watermarks.get(evt.sessionId) ?? -1;
    if (range.to > current) {
      watermarks.set(evt.sessionId, range.to);
    }
  }
}

function mergeSurfacedUserMsgIdxs(target: Map<string, Set<number>>, surfaced: Map<string, Set<number>>): void {
  for (const [sessionId, idxs] of surfaced) {
    const existing = target.get(sessionId) ?? new Set<number>();
    for (const idx of idxs) existing.add(idx);
    target.set(sessionId, existing);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
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
