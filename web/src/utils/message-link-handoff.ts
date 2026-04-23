const STORAGE_EVENT_KEY_PREFIX = "takode:message-link-handoff";
const CHANNEL_NAME_PREFIX = "takode-message-link-handoff";

type HandoffRequest = {
  type: "request";
  requestId: string;
  sourceTabId: string;
  hash: string;
  nonce: string;
};

type HandoffAck = {
  type: "ack";
  requestId: string;
  sourceTabId: string;
  responderTabId: string;
  nonce: string;
};

type HandoffClaim = {
  type: "claim";
  requestId: string;
  sourceTabId: string;
  responderTabId: string;
  nonce: string;
};

type HandoffGrant = {
  type: "grant";
  requestId: string;
  sourceTabId: string;
  responderTabId: string;
  hash: string;
  nonce: string;
};

type HandoffMessage = HandoffRequest | HandoffClaim | HandoffGrant | HandoffAck;

type PendingRequest = {
  resolve: (handled: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  grantedResponderId?: string;
  hash: string;
};

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseMessage(raw: string | null): HandoffMessage | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
    return parsed as HandoffMessage;
  } catch {
    return null;
  }
}

export function createMessageLinkHandoff({
  serverId,
  onNavigateHash,
  timeoutMs = 350,
}: {
  serverId: string;
  onNavigateHash: (hash: string) => void;
  timeoutMs?: number;
}) {
  const tabId = makeId();
  const storageEventKey = `${STORAGE_EVENT_KEY_PREFIX}:${serverId}`;
  const pending = new Map<string, PendingRequest>();
  const sentClaims = new Set<string>();
  const handledGrants = new Set<string>();
  const channelName = `${CHANNEL_NAME_PREFIX}:${serverId}`;
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;

  const emit = (message: HandoffMessage) => {
    channel?.postMessage(message);
    try {
      localStorage.setItem(storageEventKey, JSON.stringify(message));
      localStorage.removeItem(storageEventKey);
    } catch {
      // Ignore storage write failures so BroadcastChannel can still carry the handoff.
    }
  };

  const handleMessage = (message: HandoffMessage | null) => {
    if (!message) return;

    if (message.type === "request") {
      if (message.sourceTabId === tabId) return;
      if (sentClaims.has(message.requestId)) return;
      sentClaims.add(message.requestId);
      emit({
        type: "claim",
        requestId: message.requestId,
        sourceTabId: message.sourceTabId,
        responderTabId: tabId,
        nonce: makeId(),
      });
      return;
    }

    if (message.type === "claim") {
      if (message.sourceTabId !== tabId) return;
      const pendingRequest = pending.get(message.requestId);
      if (!pendingRequest || pendingRequest.grantedResponderId) return;
      pendingRequest.grantedResponderId = message.responderTabId;
      emit({
        type: "grant",
        requestId: message.requestId,
        sourceTabId: tabId,
        responderTabId: message.responderTabId,
        hash: pendingRequest.hash,
        nonce: makeId(),
      });
      return;
    }

    if (message.type === "grant") {
      if (message.sourceTabId === tabId) return;
      if (message.responderTabId !== tabId) return;
      if (handledGrants.has(message.requestId)) return;
      handledGrants.add(message.requestId);
      onNavigateHash(message.hash);
      try {
        window.focus();
      } catch {
        // Browsers may reject focus attempts outside trusted input. Best effort only.
      }
      emit({
        type: "ack",
        requestId: message.requestId,
        sourceTabId: message.sourceTabId,
        responderTabId: tabId,
        nonce: makeId(),
      });
      return;
    }

    if (message.sourceTabId !== tabId) return;
    const pendingRequest = pending.get(message.requestId);
    if (!pendingRequest) return;
    clearTimeout(pendingRequest.timer);
    pending.delete(message.requestId);
    pendingRequest.resolve(true);
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== storageEventKey) return;
    handleMessage(parseMessage(event.newValue));
  };

  const handleChannelMessage = (event: MessageEvent<HandoffMessage>) => {
    handleMessage(event.data ?? null);
  };

  window.addEventListener("storage", handleStorage);
  channel?.addEventListener("message", handleChannelMessage);

  return {
    requestReuse(hash: string): Promise<boolean> {
      return new Promise((resolve) => {
        const requestId = makeId();
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve(false);
        }, timeoutMs);
        pending.set(requestId, { resolve, timer, hash });
        emit({
          type: "request",
          requestId,
          sourceTabId: tabId,
          hash,
          nonce: makeId(),
        });
      });
    },

    cleanup() {
      window.removeEventListener("storage", handleStorage);
      channel?.removeEventListener("message", handleChannelMessage);
      channel?.close();
      for (const pendingRequest of pending.values()) {
        clearTimeout(pendingRequest.timer);
        pendingRequest.resolve(false);
      }
      pending.clear();
    },
  };
}
