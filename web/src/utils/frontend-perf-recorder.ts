const MAX_FRONTEND_PERF_ENTRIES = 1_000;

export type FrontendPerfEntry =
  | {
      kind: "ws_message";
      timestamp: number;
      sessionId: string;
      messageType: string;
      durationMs: number;
      seq?: number;
      payloadBytes?: number;
    }
  | {
      kind: "event_replay";
      timestamp: number;
      sessionId: string;
      eventCount: number;
      processedCount: number;
      bufferedCount: number;
      durationMs: number;
    }
  | {
      kind: "seq_storage_flush";
      timestamp: number;
      sessionId?: string;
      writeCount: number;
      durationMs: number;
    }
  | {
      kind: "session_ack_flush";
      timestamp: number;
      sessionId?: string;
      ackCount: number;
      maxSeq: number;
    }
  | {
      kind: "connection_cycle";
      timestamp: number;
      sessionId: string;
      phase: "connect" | "open" | "close" | "reconnect" | "subscribe";
      lastSeq?: number;
      forceFullHistory?: boolean;
    }
  | {
      kind: "feed_render";
      timestamp: number;
      sessionId: string;
      threadKey: string;
      messageCount: number;
      entryCount: number;
      turnCount: number;
    }
  | {
      kind: "long_task";
      timestamp: number;
      durationMs: number;
      name?: string;
    }
  | {
      kind: "composer_autocomplete";
      timestamp: number;
      sessionId: string;
      threadKey: string;
      phase: "input" | "recency" | "reference_suggestions";
      durationMs: number;
      inputLength?: number;
      referenceKind?: "quest" | "session";
      queryLength?: number;
      historyEntryCount?: number;
      historyCharCount?: number;
      scannedQuestCount?: number;
      candidateCount?: number;
      suggestionCount?: number;
    }
  | {
      kind: "message_history_apply";
      timestamp: number;
      sessionId: string;
      rawMessageCount: number;
      chatMessageCount: number;
      frozenCount: number;
      durationMs: number;
    }
  | {
      kind: "thread_attachment_update_apply";
      timestamp: number;
      sessionId: string;
      updateCount: number;
      markerCount: number;
      changedMessageCount: number;
      affectedThreadCount: number;
      requestedHistoryWindowCount: number;
      requestedThreadWindowCount: number;
      durationMs: number;
      ok: boolean;
      deduped?: boolean;
      recoveryReason?: string;
      applicationMode?: "patched" | "refetch_only" | "deduped";
      advisoryReason?: string;
      skippedLocalPatch?: boolean;
      replayed?: boolean;
      coldBufferedReplay?: boolean;
      updateHistoryLength?: number;
      knownAuthoritativeHistoryLength?: number;
    }
  | {
      kind: "tree_groups_update_apply";
      timestamp: number;
      sessionId: string;
      groupCount: number;
      assignmentCount: number;
      nodeOrderParentCount: number;
      nodeOrderChildCount: number;
      durationMs: number;
    }
  | {
      kind: "session_created_refresh";
      timestamp: number;
      sessionId: string;
      createdSessionId: string;
      sessionCount?: number;
      durationMs: number;
      ok: boolean;
    };

export interface FrontendPerfDebugApi {
  entries: () => FrontendPerfEntry[];
  clear: () => void;
  export: () => string;
}

declare global {
  interface Window {
    __TAKODE_FRONTEND_PERF__?: FrontendPerfDebugApi;
  }
}

const entries: FrontendPerfEntry[] = [];
const feedRenderSignatures = new Map<string, string>();

export function recordFrontendPerfEntry(entry: FrontendPerfEntry): void {
  entries.push(entry);
  if (entries.length > MAX_FRONTEND_PERF_ENTRIES) {
    entries.splice(0, entries.length - MAX_FRONTEND_PERF_ENTRIES);
  }
}

export function getFrontendPerfEntries(): FrontendPerfEntry[] {
  return [...entries];
}

export function clearFrontendPerfEntries(): void {
  entries.length = 0;
  feedRenderSignatures.clear();
}

export function exportFrontendPerfEntries(): string {
  return JSON.stringify(entries, null, 2);
}

export function recordFeedRenderSnapshot(snapshot: {
  sessionId: string;
  threadKey: string;
  messageCount: number;
  entryCount: number;
  turnCount: number;
}): void {
  const key = `${snapshot.sessionId}\0${snapshot.threadKey}`;
  const signature = `${snapshot.messageCount}:${snapshot.entryCount}:${snapshot.turnCount}`;
  if (feedRenderSignatures.get(key) === signature) return;
  feedRenderSignatures.set(key, signature);
  recordFrontendPerfEntry({ kind: "feed_render", timestamp: Date.now(), ...snapshot });
}

function installDebugApi(): void {
  if (typeof window === "undefined") return;
  window.__TAKODE_FRONTEND_PERF__ = {
    entries: getFrontendPerfEntries,
    clear: clearFrontendPerfEntries,
    export: exportFrontendPerfEntries,
  };
}

function installLongTaskObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordFrontendPerfEntry({
          kind: "long_task",
          timestamp: Date.now(),
          durationMs: entry.duration,
          name: entry.name,
        });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // Long Task API support varies by browser; tracing still works without it.
  }
}

installDebugApi();
installLongTaskObserver();
