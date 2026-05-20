export type VoiceTranscriptionMode = "dictation" | "edit" | "append";
export type VoiceTranscriptionPhase =
  | "preparing"
  | "transcribing"
  | "finalizing"
  | "enhancing"
  | "editing"
  | "appending";
export type VoiceTranscriptionProgressPhase = VoiceTranscriptionPhase | "complete" | "error";

export interface VoiceTranscriptionTiming {
  uploadDurationMs?: number;
  sttDurationMs?: number;
  enhancementDurationMs?: number;
  audioSizeBytes?: number;
  audioMimeType?: string | null;
  audioFileName?: string | null;
}

export interface VoiceTranscriptionProgressEvent {
  requestId: string;
  phase: VoiceTranscriptionProgressPhase;
  mode?: VoiceTranscriptionMode;
  timestamp: number;
  source: "client" | "sse" | "websocket";
  timing?: VoiceTranscriptionTiming;
  error?: string;
}

export interface VoiceTranscriptionFrontendTimingEvent {
  phase: VoiceTranscriptionProgressPhase;
  source: "client" | "sse" | "websocket";
  /** Timestamp supplied by the progress source. WebSocket values are server-side; client/SSE values are client-side. */
  eventTimestamp: number;
  /** Browser receipt timestamp for correlating visible UI latency with backend records. */
  clientTimestamp: number;
  elapsedMs: number;
  uploadDurationMs?: number;
  sttDurationMs?: number;
  enhancementDurationMs?: number;
}

export interface VoiceTranscriptionFrontendTimingReport {
  requestId: string;
  sessionId: string;
  mode: VoiceTranscriptionMode;
  status: "success" | "error";
  startedAt: number;
  completedAt: number;
  totalElapsedMs: number;
  phaseDurationsMs: Partial<Record<VoiceTranscriptionPhase, number>>;
  events: VoiceTranscriptionFrontendTimingEvent[];
}

type TranscriptionProgressHandler = (event: VoiceTranscriptionProgressEvent) => void;

const transcriptionProgressHandlers = new Map<string, Set<TranscriptionProgressHandler>>();

export function subscribeTranscriptionProgress(requestId: string, handler: TranscriptionProgressHandler): () => void {
  const handlers = transcriptionProgressHandlers.get(requestId) ?? new Set<TranscriptionProgressHandler>();
  handlers.add(handler);
  transcriptionProgressHandlers.set(requestId, handlers);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) transcriptionProgressHandlers.delete(requestId);
  };
}

export function handleTranscriptionProgressMessage(event: Omit<VoiceTranscriptionProgressEvent, "source">): void {
  const handlers = transcriptionProgressHandlers.get(event.requestId);
  if (!handlers) return;
  const progress = { ...event, source: "websocket" as const };
  for (const handler of handlers) {
    handler(progress);
  }
}

export function _clearTranscriptionProgressHandlersForTest(): void {
  transcriptionProgressHandlers.clear();
}
