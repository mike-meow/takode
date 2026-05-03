import type { BrowserIncomingMessage, BrowserOutgoingMessage, SdkSessionInfo } from "./types.js";
import { FEED_WINDOW_SYNC_VERSION } from "../shared/feed-window-sync.js";
import { scopedGetItem, scopedSetItem } from "./utils/scoped-storage.js";
import { recordFrontendPerfEntry } from "./utils/frontend-perf-recorder.js";

/** Heartbeat interval — send a ping every 30s to keep the connection alive */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Max reconnect delay — exponential backoff caps at 30s */
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Base reconnect delay */
const BASE_RECONNECT_DELAY_MS = 2_000;
const SEQ_STATE_FLUSH_DELAY_MS = 50;

const IDEMPOTENT_OUTGOING_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "user_message",
  "vscode_selection_update",
  "permission_response",
  "interrupt",
  "cancel_pending_codex_input",
  "set_model",
  "set_codex_reasoning_effort",
  "set_permission_mode",
  "leader_thread_tabs_update",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "mcp_set_servers",
  "set_ask_permission",
]);

interface ReplayEventEnvelope {
  seq: number;
  message: BrowserIncomingMessage;
}

type SequencedIncomingMessage = BrowserIncomingMessage & {
  seq?: number;
  nextEventSeq?: number;
  events?: ReplayEventEnvelope[];
};

export interface WsTransportCallbacks {
  hasLocalMessages: (sessionId: string) => boolean;
  getKnownFrozenCount: (sessionId: string) => number;
  getKnownFrozenHash: (sessionId: string) => string | undefined;
  getFreshHistoryWindow?: (
    sessionId: string,
  ) => { sectionTurnCount: number; visibleSectionCount: number } | null | undefined;
  onMessage: (sessionId: string, data: BrowserIncomingMessage) => void;
  onConnecting?: (sessionId: string) => void;
  onConnected?: (sessionId: string) => void;
  onDisconnected?: (sessionId: string) => void;
  shouldReconnect?: (sessionId: string) => boolean;
}

export interface WsTransport {
  connectSession: (sessionId: string) => void;
  reconnectSession: (sessionId: string) => void;
  disconnectSession: (sessionId: string) => void;
  disconnectAll: () => void;
  connectAllSessions: (sessions: SdkSessionInfo[]) => void;
  waitForConnection: (sessionId: string) => Promise<void>;
  sendToSession: (sessionId: string, msg: BrowserOutgoingMessage) => boolean;
  sendGlobalMessage: (msg: BrowserOutgoingMessage, preferredSessionId?: string | null) => boolean;
  requestFullHistorySync: (sessionId: string) => boolean;
  hasSocket: (sessionId: string) => boolean;
  getSocketState: (sessionId: string) => number | null;
  closeAllForUnload: () => void;
}

function getWsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/browser/${sessionId}`;
}

function getLastSeqStorageKey(sessionId: string): string {
  return `companion:last-seq:${sessionId}`;
}

export function createWsTransport(callbacks: WsTransportCallbacks): WsTransport {
  const sockets = new Map<string, WebSocket>();
  const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reconnectAttempts = new Map<string, number>();
  const heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const heartbeatOwners = new Map<string, WebSocket>();
  const lastSeqBySession = new Map<string, number>();
  const pendingSeqStorage = new Map<string, number>();
  const pendingAcks = new Map<string, number>();
  const coldSubscribeAwaitingSnapshot = new Set<string>();
  const coldSubscribeReceivedHistory = new Set<string>();
  const coldSubscribeBufferedReplay = new Map<string, BrowserIncomingMessage[]>();
  const intentionalCloseSockets = new WeakSet<WebSocket>();

  let clientMsgCounter = 0;
  let suppressCloseHandling = false;
  let seqStorageFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let ackFlushTimer: ReturnType<typeof setTimeout> | null = null;

  function getLastSeq(sessionId: string): number {
    const cached = lastSeqBySession.get(sessionId);
    if (typeof cached === "number") return cached;
    try {
      const raw = scopedGetItem(getLastSeqStorageKey(sessionId));
      const parsed = raw ? Number(raw) : 0;
      const normalized = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
      lastSeqBySession.set(sessionId, normalized);
      return normalized;
    } catch {
      return 0;
    }
  }

  function setLastSeq(sessionId: string, seq: number): void {
    const normalized = Math.max(0, Math.floor(seq));
    lastSeqBySession.set(sessionId, normalized);
    pendingSeqStorage.set(sessionId, normalized);
    scheduleSeqStorageFlush();
  }

  function perfNow(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  }

  function scheduleSeqStorageFlush(): void {
    if (seqStorageFlushTimer) return;
    seqStorageFlushTimer = setTimeout(() => {
      seqStorageFlushTimer = null;
      flushPendingSeqStorage();
    }, SEQ_STATE_FLUSH_DELAY_MS);
  }

  function flushPendingSeqStorage(sessionId?: string): void {
    const entries =
      typeof sessionId === "string"
        ? pendingSeqStorage.has(sessionId)
          ? ([[sessionId, pendingSeqStorage.get(sessionId)!]] as Array<[string, number]>)
          : []
        : [...pendingSeqStorage.entries()];
    if (entries.length === 0) return;

    const startedAt = perfNow();
    let writeCount = 0;
    for (const [targetSessionId, seq] of entries) {
      pendingSeqStorage.delete(targetSessionId);
      try {
        scopedSetItem(getLastSeqStorageKey(targetSessionId), String(seq));
        writeCount++;
      } catch {
        // ignore storage errors
      }
    }
    recordFrontendPerfEntry({
      kind: "seq_storage_flush",
      timestamp: Date.now(),
      ...(sessionId ? { sessionId } : {}),
      writeCount,
      durationMs: perfNow() - startedAt,
    });
    if (typeof sessionId === "string" && pendingSeqStorage.size === 0 && seqStorageFlushTimer) {
      clearTimeout(seqStorageFlushTimer);
      seqStorageFlushTimer = null;
    }
  }

  function queueAckSeq(sessionId: string, seq: number): void {
    const normalized = Math.max(0, Math.floor(seq));
    pendingAcks.set(sessionId, Math.max(pendingAcks.get(sessionId) ?? 0, normalized));
    scheduleAckFlush();
  }

  function scheduleAckFlush(): void {
    if (ackFlushTimer) return;
    ackFlushTimer = setTimeout(() => {
      ackFlushTimer = null;
      flushPendingAcks();
    }, SEQ_STATE_FLUSH_DELAY_MS);
  }

  function flushPendingAcks(sessionId?: string): void {
    const entries =
      typeof sessionId === "string"
        ? pendingAcks.has(sessionId)
          ? ([[sessionId, pendingAcks.get(sessionId)!]] as Array<[string, number]>)
          : []
        : [...pendingAcks.entries()];
    if (entries.length === 0) return;

    let ackCount = 0;
    let maxSeq = 0;
    for (const [targetSessionId, seq] of entries) {
      pendingAcks.delete(targetSessionId);
      maxSeq = Math.max(maxSeq, seq);
      const ws = sockets.get(targetSessionId);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "session_ack", last_seq: seq }));
        ackCount++;
      }
    }
    recordFrontendPerfEntry({
      kind: "session_ack_flush",
      timestamp: Date.now(),
      ...(sessionId ? { sessionId } : {}),
      ackCount,
      maxSeq,
    });
    if (typeof sessionId === "string" && pendingAcks.size === 0 && ackFlushTimer) {
      clearTimeout(ackFlushTimer);
      ackFlushTimer = null;
    }
  }

  function flushPendingSeqState(sessionId?: string): void {
    flushPendingSeqStorage(sessionId);
    flushPendingAcks(sessionId);
  }

  function recordConnectionCycle(
    sessionId: string,
    phase: "connect" | "open" | "close" | "reconnect" | "subscribe",
    extra?: { lastSeq?: number; forceFullHistory?: boolean },
  ): void {
    recordFrontendPerfEntry({ kind: "connection_cycle", timestamp: Date.now(), sessionId, phase, ...extra });
  }

  function clearColdSubscribeState(sessionId: string): void {
    coldSubscribeAwaitingSnapshot.delete(sessionId);
    coldSubscribeReceivedHistory.delete(sessionId);
    coldSubscribeBufferedReplay.delete(sessionId);
  }

  function sendSessionSubscribe(sessionId: string, forceFullHistory = false): boolean {
    const ws = sockets.get(sessionId);
    if (ws?.readyState !== WebSocket.OPEN) return false;
    const hasLocalMessages = !forceFullHistory && callbacks.hasLocalMessages(sessionId);
    const lastSeq = hasLocalMessages ? getLastSeq(sessionId) : 0;
    const knownFrozenCount = hasLocalMessages ? callbacks.getKnownFrozenCount(sessionId) : 0;
    const knownFrozenHash = hasLocalMessages ? callbacks.getKnownFrozenHash(sessionId) : undefined;
    const freshWindow = !hasLocalMessages && !forceFullHistory ? callbacks.getFreshHistoryWindow?.(sessionId) : null;
    ws.send(
      JSON.stringify({
        type: "session_subscribe",
        last_seq: lastSeq,
        known_frozen_count: Math.max(0, Math.floor(knownFrozenCount)),
        ...(knownFrozenHash ? { known_frozen_hash: knownFrozenHash } : {}),
        ...(freshWindow
          ? {
              history_window_section_turn_count: Math.max(1, Math.floor(freshWindow.sectionTurnCount)),
              history_window_visible_section_count: Math.max(1, Math.floor(freshWindow.visibleSectionCount)),
              feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
            }
          : {}),
      }),
    );
    recordConnectionCycle(sessionId, "subscribe", { lastSeq, forceFullHistory });
    if (lastSeq === 0 && !forceFullHistory) {
      coldSubscribeAwaitingSnapshot.add(sessionId);
      coldSubscribeReceivedHistory.delete(sessionId);
      coldSubscribeBufferedReplay.delete(sessionId);
    } else {
      clearColdSubscribeState(sessionId);
    }
    return true;
  }

  function nextClientMsgId(): string {
    return `cmsg-${Date.now()}-${++clientMsgCounter}`;
  }

  function handleParsedMessage(sessionId: string, message: SequencedIncomingMessage): void {
    if (
      coldSubscribeAwaitingSnapshot.has(sessionId) &&
      (message.type === "message_history" || message.type === "history_sync" || message.type === "history_window_sync")
    ) {
      coldSubscribeReceivedHistory.add(sessionId);
    }

    if (message.type === "event_replay" && Array.isArray(message.events)) {
      const replayStartedAt = perfNow();
      let latestProcessed: number | undefined;
      let processedCount = 0;
      const bufferColdReplay =
        coldSubscribeAwaitingSnapshot.has(sessionId) && coldSubscribeReceivedHistory.has(sessionId);
      const bufferedMessages: BrowserIncomingMessage[] = [];
      for (const evt of message.events) {
        if (typeof evt.seq !== "number") continue;
        const previous = getLastSeq(sessionId);
        if (evt.seq <= previous) continue;
        setLastSeq(sessionId, evt.seq);
        latestProcessed = evt.seq;
        processedCount++;
        if (bufferColdReplay) {
          bufferedMessages.push(evt.message);
          continue;
        }
        callbacks.onMessage(sessionId, evt.message);
      }
      if (bufferedMessages.length > 0) {
        const previous = coldSubscribeBufferedReplay.get(sessionId) ?? [];
        coldSubscribeBufferedReplay.set(sessionId, [...previous, ...bufferedMessages]);
      }
      if (typeof latestProcessed === "number") {
        queueAckSeq(sessionId, latestProcessed);
      }
      recordFrontendPerfEntry({
        kind: "event_replay",
        timestamp: Date.now(),
        sessionId,
        eventCount: message.events.length,
        processedCount,
        bufferedCount: bufferedMessages.length,
        durationMs: perfNow() - replayStartedAt,
      });
      return;
    }

    if (typeof message.seq === "number") {
      const previous = getLastSeq(sessionId);
      if (message.seq <= previous) return;
      setLastSeq(sessionId, message.seq);
      queueAckSeq(sessionId, message.seq);
    }

    if (message.type === "session_init" && typeof message.nextEventSeq === "number") {
      const browserSeq = getLastSeq(sessionId);
      if (browserSeq >= message.nextEventSeq) {
        setLastSeq(sessionId, 0);
      }
    }

    if (message.type === "state_snapshot") {
      const bufferedReplay = coldSubscribeBufferedReplay.get(sessionId) ?? [];
      if (message.sessionStatus === "running") {
        for (const replayedMessage of bufferedReplay) {
          callbacks.onMessage(sessionId, replayedMessage);
        }
      }
      clearColdSubscribeState(sessionId);
    }
    callbacks.onMessage(sessionId, message);
  }

  function scheduleReconnect(sessionId: string): void {
    if (reconnectTimers.has(sessionId)) return;
    const attempts = reconnectAttempts.get(sessionId) || 0;
    const delay = Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, attempts), MAX_RECONNECT_DELAY_MS);
    reconnectAttempts.set(sessionId, attempts + 1);
    const timer = setTimeout(() => {
      reconnectTimers.delete(sessionId);
      if (callbacks.shouldReconnect && !callbacks.shouldReconnect(sessionId)) {
        return;
      }
      connectSession(sessionId);
    }, delay);
    reconnectTimers.set(sessionId, timer);
  }

  function clearSocketState(sessionId: string, targetWs?: WebSocket): WebSocket | undefined {
    const currentWs = sockets.get(sessionId);
    const ws = targetWs ?? currentWs;

    if (!targetWs) {
      const timer = reconnectTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(sessionId);
      }
    }

    const hb = heartbeatIntervals.get(sessionId);
    const hbOwner = heartbeatOwners.get(sessionId);
    if (hb && (!targetWs || hbOwner === ws)) {
      clearInterval(hb);
      heartbeatIntervals.delete(sessionId);
      heartbeatOwners.delete(sessionId);
    }

    if (ws && currentWs === ws) {
      sockets.delete(sessionId);
    }
    if (!targetWs || currentWs === ws) {
      clearColdSubscribeState(sessionId);
    }
    return ws;
  }

  function connectSession(sessionId: string): void {
    const existing = sockets.get(sessionId);
    if (existing) {
      if (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING) {
        return;
      }
      clearSocketState(sessionId);
    }

    // Clear in-memory seq cache so we use localStorage as source of truth on reconnect
    flushPendingSeqStorage(sessionId);
    lastSeqBySession.delete(sessionId);

    callbacks.onConnecting?.(sessionId);
    recordConnectionCycle(sessionId, "connect");

    const ws = new WebSocket(getWsUrl(sessionId));
    sockets.set(sessionId, ws);

    ws.onopen = () => {
      callbacks.onConnected?.(sessionId);
      reconnectAttempts.delete(sessionId);
      recordConnectionCycle(sessionId, "open");

      sendSessionSubscribe(sessionId);

      const timer = reconnectTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(sessionId);
      }

      const hb = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatIntervals.set(sessionId, hb);
      heartbeatOwners.set(sessionId, ws);
    };

    ws.onmessage = (event) => {
      try {
        const rawData = typeof event.data === "string" ? event.data : "";
        const data = JSON.parse(event.data) as SequencedIncomingMessage;
        const startedAt = perfNow();
        handleParsedMessage(sessionId, data);
        recordFrontendPerfEntry({
          kind: "ws_message",
          timestamp: Date.now(),
          sessionId,
          messageType: data.type,
          durationMs: perfNow() - startedAt,
          ...(typeof data.seq === "number" ? { seq: data.seq } : {}),
          ...(rawData ? { payloadBytes: rawData.length } : {}),
        });
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      flushPendingSeqStorage(sessionId);
      clearSocketState(sessionId, ws);
      recordConnectionCycle(sessionId, "close");
      if (suppressCloseHandling) return;
      if (intentionalCloseSockets.has(ws)) return;
      callbacks.onDisconnected?.(sessionId);
      scheduleReconnect(sessionId);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function reconnectSession(sessionId: string): void {
    flushPendingSeqState(sessionId);
    recordConnectionCycle(sessionId, "reconnect");
    const ws = clearSocketState(sessionId);
    if (ws) {
      intentionalCloseSockets.add(ws);
      ws.close();
    }
    connectSession(sessionId);
  }

  function disconnectSession(sessionId: string): void {
    flushPendingSeqState(sessionId);
    reconnectAttempts.delete(sessionId);
    const ws = clearSocketState(sessionId);
    if (ws) {
      intentionalCloseSockets.add(ws);
      ws.close();
    }
  }

  function disconnectAll(): void {
    for (const [sessionId] of sockets) {
      disconnectSession(sessionId);
    }
  }

  function connectAllSessions(sessions: SdkSessionInfo[]): void {
    for (const session of sessions) {
      if (!session.archived) {
        connectSession(session.sessionId);
      }
    }
  }

  function requestFullHistorySync(sessionId: string): boolean {
    return sendSessionSubscribe(sessionId, true);
  }

  function waitForConnection(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        const ws = sockets.get(sessionId);
        if (ws?.readyState === WebSocket.OPEN) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error("Connection timeout"));
      }, 10000);
    });
  }

  function sendToSession(sessionId: string, msg: BrowserOutgoingMessage): boolean {
    const ws = sockets.get(sessionId);
    let outgoing: BrowserOutgoingMessage = msg;

    if (IDEMPOTENT_OUTGOING_TYPES.has(msg.type)) {
      switch (msg.type) {
        case "user_message":
        case "vscode_selection_update":
        case "permission_response":
        case "interrupt":
        case "set_model":
        case "set_codex_reasoning_effort":
        case "set_permission_mode":
        case "leader_thread_tabs_update":
        case "mcp_get_status":
        case "mcp_toggle":
        case "mcp_reconnect":
        case "mcp_set_servers":
        case "set_ask_permission":
          if (!msg.client_msg_id) {
            outgoing = { ...msg, client_msg_id: nextClientMsgId() };
          }
          break;
      }
    }

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(outgoing));
      return true;
    }

    return false;
  }

  function sendGlobalMessage(msg: BrowserOutgoingMessage, preferredSessionId?: string | null): boolean {
    if (preferredSessionId && sendToSession(preferredSessionId, msg)) {
      return true;
    }

    for (const [sessionId] of sockets) {
      if (preferredSessionId && sessionId === preferredSessionId) continue;
      if (sendToSession(sessionId, msg)) {
        return true;
      }
    }

    return false;
  }

  function hasSocket(sessionId: string): boolean {
    return sockets.has(sessionId);
  }

  function getSocketState(sessionId: string): number | null {
    return sockets.get(sessionId)?.readyState ?? null;
  }

  function closeAllForUnload(): void {
    suppressCloseHandling = true;
    flushPendingSeqState();
    for (const [sessionId, ws] of sockets) {
      clearSocketState(sessionId);
      ws.close();
    }
    sockets.clear();
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => flushPendingSeqState());
    window.addEventListener("beforeunload", () => flushPendingSeqState());
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushPendingSeqState();
      }
    });
  }

  return {
    connectSession,
    reconnectSession,
    disconnectSession,
    disconnectAll,
    connectAllSessions,
    waitForConnection,
    sendToSession,
    sendGlobalMessage,
    requestFullHistorySync,
    hasSocket,
    getSocketState,
    closeAllForUnload,
  };
}
