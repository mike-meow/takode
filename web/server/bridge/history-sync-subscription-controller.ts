import type { BufferedBrowserEvent, BrowserIncomingMessage, PermissionRequest, SessionTaskEntry } from "../session-types.js";
import { computeHistoryMessagesSyncHash, computeHistoryPrefixSyncHash } from "../../shared/history-sync-hash.js";
import { getHistoryWindowTurnCount } from "../../shared/history-window.js";
import { findTurnBoundaries } from "../takode-messages.js";
import { sessionTag } from "../session-tag.js";
import { trafficStats } from "../traffic-stats.js";
export interface HistorySyncSessionLike {
  id: string;
  messageHistory: BrowserIncomingMessage[];
  frozenCount: number;
  eventBuffer: BufferedBrowserEvent[];
  nextEventSeq: number;
  lastAckSeq: number;
  pendingPermissions: Map<string, PermissionRequest>;
  taskHistory: SessionTaskEntry[];
}
export interface SubscriptionSocketLike {
  data: {
    subscribed?: boolean;
    lastAckSeq?: number;
  };
}
export interface HistorySyncDeps {
  sendToBrowser: (ws: SubscriptionSocketLike, msg: BrowserIncomingMessage | Record<string, unknown>) => void;
  sendToBrowserRaw: (ws: SubscriptionSocketLike, json: string, messageType: string) => void;
  persistSession: (session: HistorySyncSessionLike) => void;
  recoverToolStartTimesFromHistory: (session: HistorySyncSessionLike) => void;
  finalizeRecoveredDisconnectedTerminalTools: (session: HistorySyncSessionLike, reason: string) => void;
  scheduleCodexToolResultWatchdogs: (session: HistorySyncSessionLike, reason: string) => void;
  isHistoryBackedEvent: (msg: BrowserIncomingMessage) => boolean;
  recomputeAndBroadcastHistoryBytes: (session: HistorySyncSessionLike) => void;
  sendStateSnapshot: (session: HistorySyncSessionLike, ws: SubscriptionSocketLike) => void;
  listTimers: (sessionId: string) => unknown[];
}
/** Yield to the event loop so large history hashing doesn't monopolize the server. */
async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
export function normalizeKnownFrozenCount(knownFrozenCount: number | undefined): number {
  if (!Number.isFinite(knownFrozenCount)) return 0;
  return Math.max(0, Math.floor(knownFrozenCount ?? 0));
}
export function clampFrozenCount(session: HistorySyncSessionLike): void {
  session.frozenCount = Math.max(0, Math.min(session.frozenCount, session.messageHistory.length));
}
export function freezeHistoryThroughCurrentTail(session: HistorySyncSessionLike): void {
  session.frozenCount = session.messageHistory.length;
}
export async function sendHistorySync(
  session: HistorySyncSessionLike,
  ws: SubscriptionSocketLike,
  knownFrozenCount: number,
  knownFrozenHash: string | undefined,
  deps: HistorySyncDeps,
): Promise<void> {
  const synced = await sendHistorySyncAttempt(session, ws, knownFrozenCount, knownFrozenHash, deps);
  if (!synced && knownFrozenCount > 0) {
    await sendHistorySyncAttempt(session, ws, 0, undefined, deps);
  }
}
async function sendHistorySyncAttempt(
  session: HistorySyncSessionLike,
  ws: SubscriptionSocketLike,
  knownFrozenCount: number,
  knownFrozenHash: string | undefined,
  deps: HistorySyncDeps,
): Promise<boolean> {
  const normalizedKnownFrozenCount = normalizeKnownFrozenCount(knownFrozenCount);
  clampFrozenCount(session);
  const frozenCount = session.frozenCount;
  const frozenHistory = session.messageHistory.slice(0, frozenCount);
  const frozenPrefix = computeHistoryMessagesSyncHash(frozenHistory);
  if (normalizedKnownFrozenCount > frozenPrefix.renderedCount) {
    console.warn(
      `[history-sync] Invalid known_frozen_count=${normalizedKnownFrozenCount} ` +
        `for session ${sessionTag(session.id)} authoritativeFrozen=${frozenPrefix.renderedCount}; refusing sync`,
    );
    return false;
  }
  if (session.messageHistory.length === 0) return true;
  if (normalizedKnownFrozenCount > 0 && typeof knownFrozenHash === "string") {
    const expectedPrefix = computeHistoryPrefixSyncHash(frozenHistory, normalizedKnownFrozenCount);
    if (expectedPrefix.hash !== knownFrozenHash) {
      console.warn(
        `[history-sync] Frozen prefix hash mismatch for session ${sessionTag(session.id)} ` +
          `(count=${normalizedKnownFrozenCount}) expected=${expectedPrefix.hash} actual=${knownFrozenHash}; refusing sync`,
      );
      return false;
    }
  }
  const historySnapshot = session.messageHistory.slice();
  const isLargeHistory = historySnapshot.length > 500;
  if (isLargeHistory) await yieldToEventLoop();
  const fullHistory = computeHistoryMessagesSyncHash(historySnapshot);
  const frozenDelta = historySnapshot.slice(normalizedKnownFrozenCount, frozenCount);
  const hotMessages = historySnapshot.slice(frozenCount);
  if (isLargeHistory) await yieldToEventLoop();
  const frozenDeltaJson = JSON.stringify(frozenDelta);
  const hotMessagesJson = JSON.stringify(hotMessages);
  trafficStats.recordHistorySyncBreakdown({
    sessionId: session.id,
    frozenDeltaBytes: Buffer.byteLength(frozenDeltaJson, "utf-8"),
    hotMessagesBytes: Buffer.byteLength(hotMessagesJson, "utf-8"),
    frozenDeltaMessages: frozenDelta.length,
    hotMessagesCount: hotMessages.length,
  });
  if (isLargeHistory) await yieldToEventLoop();
  const payloadJson =
    `{"type":"history_sync"` +
    `,"frozen_base_count":${normalizedKnownFrozenCount}` +
    `,"frozen_delta":${frozenDeltaJson}` +
    `,"hot_messages":${hotMessagesJson}` +
    `,"frozen_count":${frozenCount}` +
    `,"expected_frozen_hash":${JSON.stringify(frozenPrefix.hash)}` +
    `,"expected_full_hash":${JSON.stringify(fullHistory.hash)}}`;
  deps.sendToBrowserRaw(ws, payloadJson, "history_sync");
  return true;
}
export function sendHistoryWindowSync(
  session: HistorySyncSessionLike,
  ws: SubscriptionSocketLike,
  options: {
    fromTurn: number;
    turnCount: number;
    sectionTurnCount: number;
    visibleSectionCount: number;
  },
  deps: HistorySyncDeps,
): void {
  const normalizedSectionTurnCount = Math.max(1, Math.floor(options.sectionTurnCount));
  const normalizedVisibleSectionCount = Math.max(1, Math.floor(options.visibleSectionCount));
  const normalizedTurnCount = Math.max(
    1,
    Math.floor(options.turnCount || getHistoryWindowTurnCount(normalizedVisibleSectionCount, normalizedSectionTurnCount)),
  );
  const turns = findTurnBoundaries(session.messageHistory);
  const totalTurns = turns.length;
  let fromTurn = 0;
  let turnCount = 0;
  let messages: BrowserIncomingMessage[] = session.messageHistory.slice();
  if (totalTurns > 0) {
    fromTurn = Math.max(0, Math.min(Math.floor(options.fromTurn), totalTurns - 1));
    const endTurnExclusive = Math.min(totalTurns, fromTurn + normalizedTurnCount);
    turnCount = Math.max(0, endTurnExclusive - fromTurn);
    const startIdx = turns[fromTurn]?.startIdx ?? 0;
    const lastTurn = turns[endTurnExclusive - 1];
    const endIdx =
      lastTurn && lastTurn.endIdx >= 0 ? lastTurn.endIdx : Math.max(0, session.messageHistory.length - 1);
    messages = session.messageHistory.slice(startIdx, endIdx + 1);
  }
  deps.sendToBrowser(ws, {
    type: "history_window_sync",
    messages,
    window: {
      from_turn: fromTurn,
      turn_count: totalTurns === 0 ? 0 : turnCount,
      total_turns: totalTurns,
      section_turn_count: normalizedSectionTurnCount,
      visible_section_count: normalizedVisibleSectionCount,
    },
  });
}
export async function handleSessionSubscribe(
  session: HistorySyncSessionLike,
  ws: SubscriptionSocketLike | undefined,
  lastSeq: number,
  knownFrozenCount: number | undefined,
  knownFrozenHash: string | undefined,
  historyWindowSectionTurnCount: number | undefined,
  historyWindowVisibleSectionCount: number | undefined,
  deps: HistorySyncDeps,
): Promise<void> {
  if (!ws) return;
  ws.data.subscribed = true;
  const lastAckSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  ws.data.lastAckSeq = lastAckSeq;
  deps.recoverToolStartTimesFromHistory(session);
  deps.finalizeRecoveredDisconnectedTerminalTools(session, "session_subscribe");
  deps.scheduleCodexToolResultWatchdogs(session, "session_subscribe");
  const resolvedIds = new Set<string>();
  for (const msg of session.messageHistory) {
    if (msg.type !== "permission_approved" && msg.type !== "permission_denied") continue;
    const rec = msg as Record<string, unknown>;
    const rid = rec.request_id as string | undefined;
    if (rid) {
      resolvedIds.add(rid);
    } else if (typeof rec.id === "string") {
      const match = rec.id.match(/^(?:approval|denial)-(.+)$/);
      if (match) resolvedIds.add(match[1]);
    }
  }
  let cleanedStale = false;
  for (const reqId of session.pendingPermissions.keys()) {
    if (!resolvedIds.has(reqId)) continue;
    session.pendingPermissions.delete(reqId);
    cleanedStale = true;
  }
  if (cleanedStale) deps.persistSession(session);
  if (lastAckSeq === 0) {
    if (session.messageHistory.length > 0) {
      if (
        typeof historyWindowSectionTurnCount === "number" &&
        historyWindowSectionTurnCount > 0 &&
        typeof historyWindowVisibleSectionCount === "number" &&
        historyWindowVisibleSectionCount > 0
      ) {
        sendHistoryWindowSync(
          session,
          ws,
          {
            fromTurn: Math.max(
              0,
              findTurnBoundaries(session.messageHistory).length -
                getHistoryWindowTurnCount(historyWindowVisibleSectionCount, historyWindowSectionTurnCount),
            ),
            turnCount: getHistoryWindowTurnCount(historyWindowVisibleSectionCount, historyWindowSectionTurnCount),
            sectionTurnCount: historyWindowSectionTurnCount,
            visibleSectionCount: historyWindowVisibleSectionCount,
          },
          deps,
        );
      } else {
        await sendHistorySync(session, ws, knownFrozenCount ?? 0, knownFrozenHash, deps);
      }
    }
    if (session.eventBuffer.length > 0) {
      const transient = session.eventBuffer.filter((evt) => !deps.isHistoryBackedEvent(evt.message));
      if (transient.length > 0) {
        deps.sendToBrowser(ws, { type: "event_replay", events: transient });
      }
    }
  } else if (lastAckSeq < session.nextEventSeq - 1) {
    const earliest = session.eventBuffer[0]?.seq ?? session.nextEventSeq;
    const hasGap = session.eventBuffer.length === 0 || lastAckSeq < earliest - 1;
    const missedEvents = session.eventBuffer.filter((evt) => evt.seq > lastAckSeq);
    const hasMissedHistoryBacked = missedEvents.some((evt) => deps.isHistoryBackedEvent(evt.message));
    if (hasGap || hasMissedHistoryBacked) {
      if (session.messageHistory.length > 0) {
        await sendHistorySync(session, ws, knownFrozenCount ?? 0, knownFrozenHash, deps);
      }
      const transientMissed = missedEvents.filter((evt) => !deps.isHistoryBackedEvent(evt.message));
      if (transientMissed.length > 0) {
        deps.sendToBrowser(ws, { type: "event_replay", events: transientMissed });
      }
    } else if (missedEvents.length > 0) {
      deps.sendToBrowser(ws, { type: "event_replay", events: missedEvents });
    }
  }
  if (session.pendingPermissions.size > 0) {
    for (const perm of session.pendingPermissions.values()) {
      deps.sendToBrowser(ws, { type: "permission_request", request: perm });
    }
  }
  if (session.taskHistory.length > 0) {
    deps.sendToBrowser(ws, { type: "session_task_history", tasks: session.taskHistory });
  }
  const timers = deps.listTimers(session.id);
  if (timers.length > 0) {
    deps.sendToBrowser(ws, { type: "timer_update", timers });
  }
  deps.recomputeAndBroadcastHistoryBytes(session);
  deps.sendStateSnapshot(session, ws);
}
export function handleSessionAck(
  session: HistorySyncSessionLike,
  ws: SubscriptionSocketLike | undefined,
  lastSeq: number,
  deps: Pick<HistorySyncDeps, "persistSession">,
): void {
  const normalized = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
  if (ws) {
    const prior = typeof ws.data.lastAckSeq === "number" ? ws.data.lastAckSeq : 0;
    ws.data.lastAckSeq = Math.max(prior, normalized);
  }
  if (normalized > session.lastAckSeq) {
    session.lastAckSeq = normalized;
    deps.persistSession(session);
  }
}
