import { useStore } from "./store.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage, McpServerConfig, SdkSessionInfo } from "./types.js";
import { createWsTransport } from "./ws-transport.js";
import { createWsMessageHandler, resolveSessionFilePath } from "./ws-handlers.js";
import { computeChatMessagesSyncHash } from "../shared/history-sync-hash.js";

let handleIncomingMessage: ((sessionId: string, data: BrowserIncomingMessage) => void) | null = null;

const transport = createWsTransport({
  hasLocalMessages: (sessionId) => {
    const messages = useStore.getState().messages.get(sessionId);
    return Boolean(messages && messages.length > 0);
  },
  getKnownFrozenCount: (sessionId) => {
    return useStore.getState().messageFrozenCounts.get(sessionId) ?? 0;
  },
  getKnownFrozenHash: (sessionId) => {
    const store = useStore.getState();
    const messages = store.messages.get(sessionId) ?? [];
    const frozenCount = Math.max(0, Math.min(store.messageFrozenCounts.get(sessionId) ?? 0, messages.length));
    if (frozenCount <= 0) return undefined;
    return computeChatMessagesSyncHash(messages.slice(0, frozenCount));
  },
  onConnecting: (sessionId) => {
    useStore.getState().setConnectionStatus(sessionId, "connecting");
  },
  onConnected: (sessionId) => {
    useStore.getState().setConnectionStatus(sessionId, "connected");
  },
  onDisconnected: (sessionId) => {
    useStore.getState().setConnectionStatus(sessionId, "disconnected");
  },
  shouldReconnect: (sessionId) => {
    const store = useStore.getState();
    const sdkSession = store.sdkSessions.find((s) => s.sessionId === sessionId);
    return Boolean(sdkSession && !sdkSession.archived);
  },
  onMessage: (sessionId, data) => {
    handleIncomingMessage?.(sessionId, data);
  },
});

handleIncomingMessage = createWsMessageHandler({
  disconnectSession: (sessionId) => {
    transport.disconnectSession(sessionId);
  },
  reportHistorySyncMismatch: (sessionId, details) => {
    transport.sendToSession(sessionId, {
      type: "history_sync_mismatch",
      frozen_count: details.frozenCount,
      expected_frozen_hash: details.expectedFrozenHash,
      actual_frozen_hash: details.actualFrozenHash,
      expected_full_hash: details.expectedFullHash,
      actual_full_hash: details.actualFullHash,
    });
  },
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
  return transport.sendGlobalMessage(update, preferredSessionId);
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

// ── Page visibility: reconnect disconnected sessions when tab becomes visible ──
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const store = useStore.getState();
      const currentSessionId = store.currentSessionId;
      if (!currentSessionId) return;
      const sdkSession = store.sdkSessions.find((s) => s.sessionId === currentSessionId);
      if (sdkSession && !sdkSession.archived && !transport.hasSocket(currentSessionId)) {
        connectSession(currentSessionId);
      }
    }
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
