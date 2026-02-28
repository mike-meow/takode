/**
 * Push-based event delivery for herded sessions.
 *
 * When workers in an orchestrator's herd have noteworthy events (turn completed,
 * permission needed, error), the events accumulate in a per-orchestrator inbox.
 * When the orchestrator goes idle, the inbox is flushed as a single injected
 * user message. If the orchestrator is already idle, events are delivered after
 * a short debounce to batch near-simultaneous events.
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

/** Events worth delivering to orchestrators (skip turn_start, quest_update) */
const ACTIONABLE_EVENTS = new Set<TakodeEventType>([
  "turn_end", "permission_request", "permission_resolved",
  "session_disconnected", "session_error", "user_message",
]);

const DEBOUNCE_MS = 500;
const INBOX_CAP = 100;

/** agentSource used to tag herd event messages */
const HERD_AGENT_SOURCE = { sessionId: "herd-events", sessionLabel: "Herd Events" } as const;

// ─── Inbox State ────────────────────────────────────────────────────────────────

interface HerdInbox {
  events: TakodeEvent[];
  unsubscribe: (() => void) | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  workerIds: Set<string>;
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
        events: [],
        unsubscribe: null,
        debounceTimer: null,
        workerIds,
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

  /** Called by the event subscription when a herded worker emits an event. */
  private onWorkerEvent(orchId: string, event: TakodeEvent): void {
    if (!ACTIONABLE_EVENTS.has(event.event)) return;

    const inbox = this.inboxes.get(orchId);
    if (!inbox) return;

    inbox.events.push(event);
    // Cap inbox to prevent unbounded growth
    if (inbox.events.length > INBOX_CAP) {
      inbox.events.splice(0, inbox.events.length - INBOX_CAP);
    }

    // If orchestrator is idle, schedule delivery
    if (this.wsBridge.isSessionIdle(orchId)) {
      this.scheduleDelivery(orchId);
    }
    // If generating, events accumulate — delivered on next onOrchestratorTurnEnd
  }

  /** Called from ws-bridge when an orchestrator finishes a turn. */
  onOrchestratorTurnEnd(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox || inbox.events.length === 0) return;
    this.scheduleDelivery(orchId);
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

  /** Deliver accumulated events as a single user message. */
  private flushInbox(orchId: string): void {
    const inbox = this.inboxes.get(orchId);
    if (!inbox || inbox.events.length === 0) return;

    // Swap events to local, clear inbox
    const events = inbox.events.splice(0);
    const content = formatHerdEventBatch(events);

    this.wsBridge.injectUserMessage(orchId, content, HERD_AGENT_SOURCE);
  }

  /** Clean up all inboxes (for server shutdown). */
  destroy(): void {
    for (const orchId of this.inboxes.keys()) {
      this.teardownForOrchestrator(orchId);
    }
  }

  /** Expose for testing */
  _getInbox(orchId: string): HerdInbox | undefined {
    return this.inboxes.get(orchId);
  }
}

// ─── Event Formatting ───────────────────────────────────────────────────────────

/** Format a batch of events into a compact, scannable summary. */
export function formatHerdEventBatch(events: TakodeEvent[]): string {
  // Count unique sessions
  const sessionIds = new Set(events.map(e => e.sessionId));
  const header = `${events.length} event${events.length === 1 ? "" : "s"} from ${sessionIds.size} session${sessionIds.size === 1 ? "" : "s"}`;

  const lines = events.map(formatSingleEvent);
  return `${header}\n\n${lines.join("\n")}`;
}

function formatSingleEvent(evt: TakodeEvent): string {
  const label = `#${evt.sessionNum} ${evt.sessionName}`;
  switch (evt.event) {
    case "turn_end": {
      const duration = typeof evt.data.duration_ms === "number"
        ? formatDuration(evt.data.duration_ms)
        : "?";
      const tools = formatToolCounts(evt.data.tools as Record<string, number> | undefined);
      const resultPreview = typeof evt.data.resultPreview === "string"
        ? ` | "${truncate(evt.data.resultPreview, 60)}"`
        : "";
      const success = evt.data.is_error ? "✗" : "✓";
      return `${label} | turn_end | ${success} ${duration}${tools}${resultPreview}`;
    }
    case "permission_request": {
      const tool = evt.data.tool_name || "unknown";
      const summary = typeof evt.data.summary === "string" ? `: ${truncate(evt.data.summary, 60)}` : "";
      return `${label} | permission_request | ${tool}${summary}`;
    }
    case "session_error": {
      const error = typeof evt.data.error === "string" ? truncate(evt.data.error, 80) : "unknown error";
      return `${label} | session_error | ${error}`;
    }
    case "session_disconnected": {
      const reason = typeof evt.data.reason === "string" ? evt.data.reason : "unknown";
      return `${label} | session_disconnected | ${reason}`;
    }
    case "user_message": {
      const content = typeof evt.data.content === "string" ? truncate(evt.data.content, 80) : "";
      return `${label} | user_message | "${content}"`;
    }
    default:
      return `${label} | ${evt.event}`;
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

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
