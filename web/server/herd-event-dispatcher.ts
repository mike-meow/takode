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

import type { TakodeEvent, TakodeEventType } from "./session-types.js";

// ─── Interfaces (for testability — avoids importing full WsBridge/CliLauncher) ──

export interface WsBridgeHandle {
  subscribeTakodeEvents(sessions: Set<string>, cb: (e: TakodeEvent) => void, since?: number): () => void;
  injectUserMessage(sessionId: string, content: string, agentSource?: { sessionId: string; sessionLabel?: string }): void;
  isSessionIdle(sessionId: string): boolean;
}

export interface LauncherHandle {
  getHerdedSessions(orchId: string): Array<{ sessionId: string }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Events worth delivering to orchestrators.
 *  session_disconnected is excluded — disconnects are transient (CLI reconnects
 *  every 5 minutes for token refresh) and auto-relaunch handles recovery.
 *  Delivering disconnect events would flood the leader with noise.
 *  user_message is excluded — individual messages are noisy and truncated.
 *  Instead, user message count + IDs are included in the turn_end event
 *  so the leader can peek at specific messages via [msg-id] if needed. */
const ACTIONABLE_EVENTS = new Set<TakodeEventType>([
  "turn_end", "permission_request", "permission_resolved",
  "session_error",
]);

const DEBOUNCE_MS = 500;
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
    const workerIds = new Set(workers.map(w => w.sessionId));
    if (workerIds.size === 0) {
      this.teardownForOrchestrator(orchId);
      return;
    }

    const existing = this.inboxes.get(orchId);
    if (existing) {
      // Check if worker set changed
      if (setsEqual(existing.workerIds, workerIds)) return;
      // Unsubscribe old, keep accumulated events
      existing.unsubscribe?.();
      existing.workerIds = workerIds;
      existing.unsubscribe = this.wsBridge.subscribeTakodeEvents(
        workerIds,
        (evt) => this.onWorkerEvent(orchId, evt),
      );
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
      };
      inbox.unsubscribe = this.wsBridge.subscribeTakodeEvents(
        workerIds,
        (evt) => this.onWorkerEvent(orchId, evt),
      );
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

    // Cap inbox entries to prevent unbounded growth
    if (inbox.entries.length > INBOX_CAP) {
      const dropped = inbox.entries.length - INBOX_CAP;
      inbox.entries.splice(0, dropped);
      // Update confirmedUpTo so we don't try to re-deliver trimmed entries
      if (inbox.entries.length > 0) {
        inbox.confirmedUpTo = Math.max(inbox.confirmedUpTo, inbox.entries[0].seq);
      }
    }

    // If orchestrator is idle, schedule delivery
    if (this.wsBridge.isSessionIdle(orchId)) {
      this.scheduleDelivery(orchId);
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

    // If there are new pending events, schedule delivery
    if (this.pendingCount(inbox) > 0) {
      this.scheduleDelivery(orchId);
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

  /** Schedule a debounced flush. Multiple calls within DEBOUNCE_MS batch together. */
  private scheduleDelivery(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox || inbox.debounceTimer) return; // already scheduled
    inbox.debounceTimer = setTimeout(() => {
      inbox.debounceTimer = null;
      this.flushInbox(orchId);
    }, DEBOUNCE_MS);
  }

  /** Deliver pending events to the orchestrator's CLI. */
  private flushInbox(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox) return;

    const pending = this.getPendingEntries(inbox);
    if (pending.length === 0) return;

    // Re-check idle — orchestrator may have started generating during debounce
    if (!this.wsBridge.isSessionIdle(orchId)) {
      // Events stay in inbox, delivered on next onOrchestratorTurnEnd
      return;
    }

    // Format and inject
    const events = pending.map(e => e.event);
    const content = formatHerdEventBatch(events);
    this.wsBridge.injectUserMessage(orchId, content, HERD_AGENT_SOURCE);

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
    const startSeq = inbox.inFlightUpTo !== null
      ? inbox.inFlightUpTo + 1  // Already have in-flight batch, only get newer
      : inbox.confirmedUpTo;     // Nothing in-flight, get from last confirmed
    return inbox.entries.filter(e => e.seq >= startSeq);
  }

  /** Count of events waiting to be delivered. */
  private pendingCount(inbox: HerdInbox): number {
    return this.getPendingEntries(inbox).length;
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
        hasInbox: false, pendingEventCount: 0, pendingEventTypes: [],
        inFlightCount: 0, confirmedUpTo: 0,
        workerCount: 0, debounceActive: false, eventHistory: [],
      };
    }
    const pending = this.getPendingEntries(inbox);
    const inFlight = inbox.inFlightUpTo !== null
      ? inbox.entries.filter(e => e.seq >= inbox.confirmedUpTo && e.seq <= inbox.inFlightUpTo!).length
      : 0;
    return {
      hasInbox: true,
      pendingEventCount: pending.length,
      pendingEventTypes: pending.map(e => e.event.event),
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

/** Format a batch of events into a compact, scannable summary. */
export function formatHerdEventBatch(events: TakodeEvent[], nowTs: number = Date.now()): string {
  // Count unique sessions
  const sessionIds = new Set(events.map(e => e.sessionId));
  const header = `${events.length} event${events.length === 1 ? "" : "s"} from ${sessionIds.size} session${sessionIds.size === 1 ? "" : "s"}`;

  const lines = events.map((event) => formatSingleEvent(event, nowTs));
  return `${header}\n\n${lines.join("\n")}`;
}

function formatSingleEvent(evt: TakodeEvent, nowTs: number): string {
  const label = `#${evt.sessionNum} ${evt.sessionName}`;
  const age = formatRelativeAge(evt.ts, nowTs);
  switch (evt.event) {
    case "turn_end": {
      const duration = typeof evt.data.duration_ms === "number"
        ? formatDuration(evt.data.duration_ms)
        : "?";
      const tools = formatToolCounts(evt.data.tools as Record<string, number> | undefined);
      const resultPreview = typeof evt.data.resultPreview === "string"
        ? ` | "${truncate(evt.data.resultPreview, 60)}"`
        : "";
      const success = evt.data.interrupted ? "⊘ interrupted" : evt.data.is_error ? "✗" : "✓";
      // Message ID range for quick peek navigation
      const range = evt.data.msgRange as { from: number; to: number } | undefined;
      const rangeStr = range ? ` | [${range.from}]-[${range.to}]` : "";
      // User messages received during this turn (deferred from individual delivery)
      const um = evt.data.userMsgs as { count: number; ids: number[] } | undefined;
      const userMsgStr = um ? ` | ${um.count} user msg${um.count === 1 ? "" : "s"} [${um.ids.join(", ")}]` : "";
      // Quest status change during this turn
      const qc = evt.data.questChange as { questId: string; from: string; to: string } | undefined;
      const questStr = qc ? ` | ${qc.questId}: ${qc.from} → ${qc.to}` : "";
      return `${label} | turn_end | ${success} ${duration}${tools}${rangeStr}${userMsgStr}${questStr}${resultPreview} | ${age}`;
    }
    case "permission_request": {
      const tool = evt.data.tool_name || "unknown";
      const summary = typeof evt.data.summary === "string" ? `: ${truncate(evt.data.summary, 60)}` : "";
      return `${label} | permission_request | ${tool}${summary} | ${age}`;
    }
    case "session_error": {
      const error = typeof evt.data.error === "string" ? truncate(evt.data.error, 80) : "unknown error";
      return `${label} | session_error | ${error} | ${age}`;
    }
    case "session_disconnected": {
      const reason = typeof evt.data.reason === "string" ? evt.data.reason : "unknown";
      return `${label} | session_disconnected | ${reason} | ${age}`;
    }
    case "user_message": {
      const content = typeof evt.data.content === "string" ? truncate(evt.data.content, 80) : "";
      // Show who sent the message: [User], [Agent #N name], or [Herd]
      const agentSource = evt.data.agentSource as { sessionId?: string; sessionLabel?: string } | undefined;
      let sender = "User";
      if (agentSource?.sessionId === "herd-events") {
        sender = "Herd";
      } else if (agentSource?.sessionId) {
        sender = agentSource.sessionLabel ? `Agent ${agentSource.sessionLabel}` : "Agent";
      }
      return `${label} | user_message [${sender}] | "${content}" | ${age}`;
    }
    default:
      return `${label} | ${evt.event} | ${age}`;
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
  const parts = Object.entries(tools).map(([name, count]) => `${name}(${count})`);
  return ` | tools: ${parts.join(", ")}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function formatRelativeAge(ts: number, nowTs: number): string {
  const deltaMs = Math.max(0, nowTs - ts);
  const deltaSec = Math.floor(deltaMs / 1000);
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
