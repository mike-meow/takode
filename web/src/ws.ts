import { useStore } from "./store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, McpServerConfig, SdkSessionInfo } from "./types.js";
import { createWsTransport } from "./ws-transport.js";
import { createWsMessageHandler, resolveSessionFilePath } from "./ws-handlers.js";
import { HISTORY_WINDOW_SECTION_TURN_COUNT, HISTORY_WINDOW_VISIBLE_SECTION_COUNT } from "../shared/history-window.js";
import type { WsIncomingMessageContext } from "./ws-message-context.js";

let handleIncomingMessage:
  | ((sessionId: string, data: BrowserIncomingMessage, context: WsIncomingMessageContext) => void)
  | null = null;
let pendingVsCodeSelectionUpdate: Extract<BrowserOutgoingMessage, { type: "vscode_selection_update" }> | null = null;

const transport = createWsTransport({
  hasLocalMessages: (sessionId) => {
    const store = useStore.getState();
    const messages = store.messages.get(sessionId);
    const historyWindow = store.historyWindows.get(sessionId);
    return Boolean(messages && messages.length > 0 && !historyWindow);
  },
  getKnownFrozenCount: (sessionId) => {
    return useStore.getState().messageFrozenCounts.get(sessionId) ?? 0;
  },
  getKnownFrozenHash: (sessionId) => {
    return useStore.getState().messageFrozenHashes.get(sessionId);
  },
  getFreshHistoryWindow: (sessionId) => {
    const store = useStore.getState();
    if (store.pendingScrollToMessageIndex.get(sessionId) != null) return null;
    if (store.scrollToTurnId.get(sessionId)) return null;
    if (store.pendingScrollToMessageId.get(sessionId)) return null;
    return {
      sectionTurnCount: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visibleSectionCount: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
    };
  },
  onConnecting: (sessionId) => {
    useStore.getState().setConnectionStatus(sessionId, "connecting");
  },
  onConnected: (sessionId) => {
    useStore.getState().setConnectionStatus(sessionId, "connected");
    if (pendingVsCodeSelectionUpdate) {
      const delivered = transport.sendGlobalMessage(pendingVsCodeSelectionUpdate, sessionId);
      if (delivered) {
        pendingVsCodeSelectionUpdate = null;
      }
    }
  },
  onDisconnected: (sessionId) => {
    useStore.getState().setConnectionStatus(sessionId, "disconnected");
  },
  shouldReconnect: (sessionId) => {
    const store = useStore.getState();
    const sdkSession = store.sdkSessions.find((s) => s.sessionId === sessionId);
    return Boolean(sdkSession && !sdkSession.archived);
  },
  onMessage: (sessionId, data, context) => {
    handleIncomingMessage?.(sessionId, data, context);
  },
});

handleIncomingMessage = createWsMessageHandler({
  disconnectSession: (sessionId) => {
    transport.disconnectSession(sessionId);
  },
  sendToSession: (sessionId, msg) => transport.sendToSession(sessionId, msg),
});

export { resolveSessionFilePath };

export function connectSession(sessionId: string) {
  const store = useStore.getState();
  const existingMessages = store.messages.get(sessionId);
  if (!existingMessages || existingMessages.length === 0) {
    store.setHistoryLoading(sessionId, true);
  }
  transport.connectSession(sessionId);
}

export function disconnectSession(sessionId: string) {
  transport.disconnectSession(sessionId);
}

export function disconnectAll() {
  transport.disconnectAll();
}

export function connectAllSessions(sessions: SdkSessionInfo[]) {
  transport.connectAllSessions(sessions);
}

export function waitForConnection(sessionId: string): Promise<void> {
  return transport.waitForConnection(sessionId);
}

export function sendToSession(sessionId: string, msg: BrowserOutgoingMessage): boolean {
  return transport.sendToSession(sessionId, msg);
}

export function sendVsCodeSelectionUpdate(
  update: Extract<BrowserOutgoingMessage, { type: "vscode_selection_update" }>,
): boolean {
  const preferredSessionId = useStore.getState().currentSessionId;
  const delivered = transport.sendGlobalMessage(update, preferredSessionId);
  if (!delivered) {
    pendingVsCodeSelectionUpdate = update;
  }
  return delivered;
}

export function sendMcpGetStatus(sessionId: string) {
  sendToSession(sessionId, { type: "mcp_get_status" });
}

export function sendMcpToggle(sessionId: string, serverName: string, enabled: boolean) {
  sendToSession(sessionId, { type: "mcp_toggle", serverName, enabled });
}

export function sendMcpReconnect(sessionId: string, serverName: string) {
  sendToSession(sessionId, { type: "mcp_reconnect", serverName });
}

export function sendMcpSetServers(sessionId: string, servers: Record<string, McpServerConfig>) {
  sendToSession(sessionId, { type: "mcp_set_servers", servers });
}

const FORCE_RECONNECT_AFTER_HIDDEN_MS = 60_000;

function ensureActiveSessionConnection(options?: { forceReconnect?: boolean }) {
  const store = useStore.getState();
  const currentSessionId = store.currentSessionId;
  if (!currentSessionId) return;

  const sdkSession = store.sdkSessions.find((s) => s.sessionId === currentSessionId);
  if (!sdkSession || sdkSession.archived) return;

  const socketState = transport.getSocketState(currentSessionId);
  if (options?.forceReconnect) {
    transport.reconnectSession(currentSessionId);
    return;
  }

  if (socketState === WebSocket.OPEN || socketState === WebSocket.CONNECTING) {
    return;
  }

  connectSession(currentSessionId);
}

// ── Page visibility/mobile resume: recover from background-stale sockets ──
if (typeof document !== "undefined" && typeof window !== "undefined") {
  let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }

    const hiddenDuration = hiddenAt == null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    ensureActiveSessionConnection({
      forceReconnect: hiddenDuration >= FORCE_RECONNECT_AFTER_HIDDEN_MS,
    });
  });

  window.addEventListener("pageshow", (event) => {
    const persisted = "persisted" in event && event.persisted === true;
    ensureActiveSessionConnection({ forceReconnect: persisted });
  });

  window.addEventListener("online", () => {
    ensureActiveSessionConnection({ forceReconnect: true });
  });
}

// ── Page unload: close all WebSockets so the browser tears down TCP connections ──
// Without this, Safari reuses stale keep-alive connections after a dev server
// restart, causing the reloaded page to hang indefinitely. Closing WebSockets
// on beforeunload forces Safari to open fresh TCP connections on the next load.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    transport.closeAllForUnload();
  });
}
