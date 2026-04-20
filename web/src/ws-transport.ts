import type { BrowserIncomingMessage, BrowserOutgoingMessage, SdkSessionInfo } from "./types.js";
import { scopedGetItem, scopedSetItem } from "./utils/scoped-storage.js";

/** Heartbeat interval — send a ping every 30s to keep the connection alive */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Max reconnect delay — exponential backoff caps at 30s */
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Base reconnect delay */
const BASE_RECONNECT_DELAY_MS = 2_000;

const IDEMPOTENT_OUTGOING_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "user_message",
  "vscode_selection_update",
  "permission_response",
  "interrupt",
  "cancel_pending_codex_input",
  "set_model",
  "set_codex_reasoning_effort",
  "set_permission_mode",
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
  const intentionalCloseSockets = new WeakSet<WebSocket>();

  let clientMsgCounter = 0;
  let suppressCloseHandling = false;

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
    try {
      scopedSetItem(getLastSeqStorageKey(sessionId), String(normalized));
    } catch {
      // ignore storage errors
    }
  }

  function ackSeq(sessionId: string, seq: number): void {
    const ws = sockets.get(sessionId);
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "session_ack", last_seq: seq }));
    }
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
            }
          : {}),
      }),
    );
    return true;
  }

  function nextClientMsgId(): string {
    return `cmsg-${Date.now()}-${++clientMsgCounter}`;
  }

  function handleParsedMessage(sessionId: string, message: SequencedIncomingMessage): void {
    if (message.type === "event_replay" && Array.isArray(message.events)) {
      let latestProcessed: number | undefined;
      for (const evt of message.events) {
        if (typeof evt.seq !== "number") continue;
        const previous = getLastSeq(sessionId);
        if (evt.seq <= previous) continue;
        setLastSeq(sessionId, evt.seq);
        latestProcessed = evt.seq;
        callbacks.onMessage(sessionId, evt.message);
      }
      if (typeof latestProcessed === "number") {
        ackSeq(sessionId, latestProcessed);
      }
      return;
    }

    if (typeof message.seq === "number") {
      const previous = getLastSeq(sessionId);
      if (message.seq <= previous) return;
      setLastSeq(sessionId, message.seq);
      ackSeq(sessionId, message.seq);
    }

    if (message.type === "session_init" && typeof message.nextEventSeq === "number") {
      const browserSeq = getLastSeq(sessionId);
      if (browserSeq >= message.nextEventSeq) {
        setLastSeq(sessionId, 0);
      }
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
    lastSeqBySession.delete(sessionId);

    callbacks.onConnecting?.(sessionId);

    const ws = new WebSocket(getWsUrl(sessionId));
    sockets.set(sessionId, ws);

    ws.onopen = () => {
      callbacks.onConnected?.(sessionId);
      reconnectAttempts.delete(sessionId);

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
        const data = JSON.parse(event.data) as SequencedIncomingMessage;
        handleParsedMessage(sessionId, data);
      } catch {
        // ignore non-JSON messages
      }
    };

    ws.onclose = () => {
      clearSocketState(sessionId, ws);
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
    const ws = clearSocketState(sessionId);
    if (ws) {
      intentionalCloseSockets.add(ws);
      ws.close();
    }
    connectSession(sessionId);
  }

  function disconnectSession(sessionId: string): void {
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
    for (const [sessionId, ws] of sockets) {
      clearSocketState(sessionId);
      ws.close();
    }
    sockets.clear();
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
