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
  serverTiming?: VoiceTranscriptionServerTiming;
}

export interface VoiceTranscriptionResultPayload {
  mode?: VoiceTranscriptionMode;
  text: string;
  rawText?: string;
  instructionText?: string;
  backend: string;
  enhanced: boolean;
  timing?: VoiceTranscriptionTiming;
}

export interface VoiceTranscriptionServerTiming {
  bodyReadDurationMs?: number;
  contextBuildDurationMs?: number;
  ssePhaseWriteDurationMs?: number;
  sttCompleteWriteDurationMs?: number;
  resultReadyDurationMs?: number;
  resultWriteDurationMs?: number;
  serverTotalDurationMs?: number;
  uploadFormatMimeType?: string;
  uploadFormatExtension?: string;
}

export interface VoiceRecordingTiming {
  startedAt: number;
  recorderStartedAt?: number;
  stopRequestedAt?: number;
  firstDataAvailableAt?: number;
  lastDataAvailableAt?: number;
  stopEventAt?: number;
  blobReadyAt: number;
  recordingDurationMs?: number;
  stopToBlobReadyMs?: number;
  blobBuildDurationMs?: number;
  chunkCount: number;
  chunkBytes: number;
  blobBytes: number;
  selectedMimeType?: string | null;
  recorderMimeType?: string | null;
  blobMimeType?: string | null;
  audioBitsPerSecond?: number;
  pageVisibility?: DocumentVisibilityState;
}

export interface VoiceTranscriptionClientTiming {
  transport: "raw" | "multipart";
  requestConstructedAt: number;
  fetchStartAt: number;
  responseStartAt?: number;
  firstChunkAt?: number;
  webSocketResultAt?: number;
  resultEventAt?: number;
  resultReturnedAt?: number;
  resultDeliverySource?: "sse" | "websocket";
  responseStartDelayMs?: number;
  firstChunkDelayMs?: number;
  resultStreamDurationMs?: number;
  requestBodyBytes: number;
  audioMimeType?: string | null;
  audioFileName?: string | null;
}

export interface VoiceTranscriptionUiTiming {
  apiResolvedAt?: number;
  applyStartedAt?: number;
  applyCompletedAt?: number;
  nextPaintAt?: number;
  apiElapsedMs?: number;
  applyDurationMs?: number;
  applyToNextPaintMs?: number;
}

export interface VoiceTranscriptionProgressEvent {
  requestId: string;
  phase: VoiceTranscriptionProgressPhase;
  mode?: VoiceTranscriptionMode;
  timestamp: number;
  source: "client" | "sse" | "websocket";
  timing?: VoiceTranscriptionTiming;
  result?: VoiceTranscriptionResultPayload;
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
  serverTiming?: VoiceTranscriptionServerTiming;
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
  recordingTiming?: VoiceRecordingTiming;
  clientTiming?: VoiceTranscriptionClientTiming;
  uiTiming?: VoiceTranscriptionUiTiming;
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
