import { subscribeTranscriptionProgress } from "../transcription-progress.js";
import type {
  VoiceTranscriptionClientTiming,
  VoiceTranscriptionMode,
  VoiceTranscriptionPhase,
  VoiceTranscriptionProgressEvent,
  VoiceTranscriptionResultPayload,
  VoiceTranscriptionTiming,
} from "../transcription-progress.js";

const BASE = "/api";
const TRANSCRIPTION_REQUEST_BASE_TIMEOUT_MS = 45_000;
const TRANSCRIPTION_REQUEST_TIMEOUT_CAP_MS = 180_000;
const TRANSCRIPTION_REQUEST_BYTES_PER_EXTRA_SECOND = 64 * 1024;

export interface VoiceTranscriptionResult extends VoiceTranscriptionResultPayload {}

export interface VoiceTranscriptionOptions {
  backend?: "gemini" | "openai";
  mode?: VoiceTranscriptionMode;
  sessionId?: string;
  threadKey?: string;
  threadTitle?: string;
  focusedContext?: string;
  composerText?: string;
  onPhase?: (phase: VoiceTranscriptionPhase) => void;
  requestId?: string;
  onProgress?: (event: VoiceTranscriptionProgressEvent) => void;
  onClientTiming?: (timing: VoiceTranscriptionClientTiming) => void;
}

/**
 * The transcription route does not start streaming SSE until after the browser
 * finishes sending the request body and the server starts the SSE response. A
 * fixed 45s timeout is fine for short dictation, but longer mobile recordings
 * can spend most of that budget just getting audio to the server on a slow uplink.
 *
 * Scale the pre-response timeout with audio size while keeping short clips at
 * the existing baseline and capping the total wait to avoid hanging forever.
 */
export function getTranscriptionRequestTimeoutMs(audioSizeBytes: number): number {
  if (!Number.isFinite(audioSizeBytes) || audioSizeBytes <= 0) {
    return TRANSCRIPTION_REQUEST_BASE_TIMEOUT_MS;
  }
  const extraSeconds = Math.max(0, Math.ceil(audioSizeBytes / TRANSCRIPTION_REQUEST_BYTES_PER_EXTRA_SECOND) - 1);
  return Math.min(TRANSCRIPTION_REQUEST_BASE_TIMEOUT_MS + extraSeconds * 1_000, TRANSCRIPTION_REQUEST_TIMEOUT_CAP_MS);
}

export function resolveAudioUploadFilename(audioType: string): string {
  const normalizedAudioType = audioType.split(";")[0]?.trim().toLowerCase();
  switch (normalizedAudioType) {
    case "audio/mp4":
    case "video/mp4":
      return "recording.mp4";
    case "audio/ogg":
    case "video/ogg":
      return "recording.ogg";
    case "audio/wav":
    case "audio/x-wav":
      return "recording.wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "recording.mp3";
    case "audio/flac":
      return "recording.flac";
    default:
      return "recording.webm";
  }
}

function createTranscriptionRequestId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `tx-${Date.now()}-${random}`;
}

function completeClientTiming(
  timing: VoiceTranscriptionClientTiming,
  fields: Partial<VoiceTranscriptionClientTiming>,
): VoiceTranscriptionClientTiming {
  return { ...timing, ...fields };
}

type WebSocketTerminalTranscription =
  | { type: "result"; receivedAt: number; result: VoiceTranscriptionResult }
  | { type: "error"; receivedAt: number; error: Error };

export async function transcribe(audio: Blob, options?: VoiceTranscriptionOptions): Promise<VoiceTranscriptionResult> {
  const mode = options?.mode ?? "dictation";
  const requestId = options?.requestId ?? createTranscriptionRequestId();
  const audioFileName = resolveAudioUploadFilename(audio.type);
  const canUseRawAudioTransport =
    mode === "dictation" && options?.composerText === undefined && options?.focusedContext === undefined;
  const transport = canUseRawAudioTransport ? "raw" : "multipart";
  const emitProgress = (event: Omit<VoiceTranscriptionProgressEvent, "requestId" | "timestamp">) => {
    options?.onProgress?.({ requestId, timestamp: Date.now(), ...event });
  };
  let resolveWebSocketTerminal: ((terminal: WebSocketTerminalTranscription) => void) | undefined;
  const webSocketTerminal = new Promise<WebSocketTerminalTranscription>((resolve) => {
    resolveWebSocketTerminal = resolve;
  });
  const applyProgressPhase = (event: VoiceTranscriptionProgressEvent) => {
    options?.onProgress?.(event);
    if (event.phase === "complete") {
      if (event.result) {
        resolveWebSocketTerminal?.({ type: "result", receivedAt: Date.now(), result: event.result });
      }
      return;
    }
    if (event.phase === "error") {
      resolveWebSocketTerminal?.({
        type: "error",
        receivedAt: Date.now(),
        error: new Error(event.error || "Transcription failed"),
      });
      return;
    }
    options?.onPhase?.(event.phase);
  };
  const canUseWebSocketTerminal = !!(options?.sessionId && options?.requestId);
  const unsubscribeProgress = canUseWebSocketTerminal
    ? subscribeTranscriptionProgress(requestId, applyProgressPhase)
    : () => {};
  const query = new URLSearchParams();
  if (options?.backend) query.set("backend", options.backend);
  if (mode) query.set("mode", mode);
  if (options?.sessionId) query.set("sessionId", options.sessionId);
  if (options?.threadKey) query.set("threadKey", options.threadKey);
  if (options?.threadTitle) query.set("threadTitle", options.threadTitle);
  if (options?.requestId) query.set("requestId", requestId);
  const path = `${BASE}/transcribe${query.size > 0 ? `?${query.toString()}` : ""}`;
  const headers = new Headers();
  let body: BodyInit;
  if (canUseRawAudioTransport) {
    body = audio;
    headers.set("Content-Type", audio.type || "application/octet-stream");
    headers.set("X-Companion-Audio-Filename", audioFileName);
  } else {
    const form = new FormData();
    form.append("audio", audio, audioFileName);
    if (options?.backend) form.append("backend", options.backend);
    if (mode) form.append("mode", mode);
    if (options?.sessionId) form.append("sessionId", options.sessionId);
    if (options?.threadKey) form.append("threadKey", options.threadKey);
    if (options?.threadTitle) form.append("threadTitle", options.threadTitle);
    if (options?.focusedContext !== undefined) form.append("focusedContext", options.focusedContext);
    if (options?.composerText !== undefined) form.append("composerText", options.composerText);
    if (options?.requestId) form.append("requestId", requestId);
    body = form;
  }

  const requestConstructedAt = Date.now();
  let clientTiming: VoiceTranscriptionClientTiming = {
    transport,
    requestConstructedAt,
    fetchStartAt: requestConstructedAt,
    requestBodyBytes: audio.size,
    audioMimeType: audio.type || null,
    audioFileName,
  };
  const controller = new AbortController();
  const timeoutMs = getTranscriptionRequestTimeoutMs(audio.size);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let abortedAfterWebSocketTerminal = false;
  let res: Response;
  options?.onPhase?.("preparing");
  emitProgress({
    source: "client",
    phase: "preparing",
    mode,
    timing: { audioSizeBytes: audio.size, audioMimeType: audio.type || null, audioFileName },
  });

  const readSseTranscription = async (): Promise<VoiceTranscriptionResult> => {
    try {
      clientTiming = completeClientTiming(clientTiming, { fetchStartAt: Date.now() });
      res = await fetch(path, { method: "POST", body, headers, signal: controller.signal });
      const responseStartAt = Date.now();
      clientTiming = completeClientTiming(clientTiming, {
        responseStartAt,
        responseStartDelayMs: responseStartAt - clientTiming.fetchStartAt,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError" && abortedAfterWebSocketTerminal) {
        throw err;
      }
      options?.onClientTiming?.(clientTiming);
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          `Transcription timed out after ${Math.round(timeoutMs / 1000)}s — sending audio or starting transcription took too long.`,
        );
      }
      throw err;
    }
    clearTimeout(timeout);
    if (!res.ok) {
      options?.onClientTiming?.(clientTiming);
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error || res.statusText);
    }

    if (!res.body) {
      options?.onClientTiming?.(clientTiming);
      throw new Error("No response body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let phaseAcked = false;
    let streamEnded = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          streamEnded = true;
          break;
        }
        const chunkReceivedAt = Date.now();
        if (clientTiming.firstChunkAt === undefined) {
          clientTiming = completeClientTiming(clientTiming, {
            firstChunkAt: chunkReceivedAt,
            firstChunkDelayMs: chunkReceivedAt - (clientTiming.responseStartAt ?? clientTiming.fetchStartAt),
          });
        }
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
          if (!chunk.trim()) continue;
          let eventType = "";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (!data) continue;
          if (!phaseAcked && eventType !== "phase") {
            options?.onPhase?.("transcribing");
            emitProgress({ source: "sse", phase: "transcribing", mode });
            phaseAcked = true;
          }

          const parsed = JSON.parse(data);
          if (eventType === "phase") {
            const nextPhase = parsed.phase as VoiceTranscriptionPhase | null | undefined;
            if (nextPhase) {
              options?.onPhase?.(nextPhase);
              emitProgress({ source: "sse", phase: nextPhase, mode, timing: parsed.timing });
              phaseAcked = true;
            }
          } else if (eventType === "stt_complete") {
            const nextPhase = parsed.nextPhase as VoiceTranscriptionPhase | null | undefined;
            if (nextPhase) {
              options?.onPhase?.(nextPhase);
              emitProgress({ source: "sse", phase: nextPhase, mode, timing: parsed.timing });
            } else if (parsed.willEnhance) {
              options?.onPhase?.("enhancing");
              emitProgress({ source: "sse", phase: "enhancing", mode, timing: parsed.timing });
            }
          } else if (eventType === "result") {
            const resultEventAt = Date.now();
            const transcriptionResult = parsed as VoiceTranscriptionResult;
            emitProgress({ source: "sse", phase: "complete", mode, timing: transcriptionResult.timing });
            const resultReturnedAt = Date.now();
            clientTiming = completeClientTiming(clientTiming, {
              resultDeliverySource: "sse",
              resultEventAt,
              resultReturnedAt,
              resultStreamDurationMs:
                resultEventAt - (clientTiming.firstChunkAt ?? clientTiming.responseStartAt ?? resultEventAt),
            });
            options?.onClientTiming?.(clientTiming);
            return transcriptionResult;
          } else if (eventType === "error") {
            emitProgress({ source: "sse", phase: "error", mode, error: parsed.error || "Transcription failed" });
            options?.onClientTiming?.(clientTiming);
            throw new Error(parsed.error || "Transcription failed");
          }
        }
      }
    } finally {
      if (!streamEnded) {
        void reader.cancel().catch(() => undefined);
      }
    }
    options?.onClientTiming?.(clientTiming);
    throw new Error("Stream ended without transcription result");
  };

  const sseResult = readSseTranscription();
  try {
    if (!canUseWebSocketTerminal) return await sseResult;

    const terminal = await Promise.race([
      sseResult.then((result) => ({ type: "sse" as const, result })),
      webSocketTerminal.then((terminalResult) => ({ type: "websocket" as const, terminal: terminalResult })),
    ]);
    if (terminal.type === "sse") return terminal.result;
    abortedAfterWebSocketTerminal = true;
    controller.abort();
    void sseResult.catch(() => undefined);
    if (terminal.terminal.type === "error") {
      clientTiming = completeClientTiming(clientTiming, {
        webSocketResultAt: terminal.terminal.receivedAt,
        resultReturnedAt: terminal.terminal.receivedAt,
        resultDeliverySource: "websocket",
      });
      options?.onClientTiming?.(clientTiming);
      throw terminal.terminal.error;
    }
    clientTiming = completeClientTiming(clientTiming, {
      webSocketResultAt: terminal.terminal.receivedAt,
      resultEventAt: terminal.terminal.receivedAt,
      resultReturnedAt: terminal.terminal.receivedAt,
      resultDeliverySource: "websocket",
      resultStreamDurationMs:
        terminal.terminal.receivedAt -
        (clientTiming.firstChunkAt ?? clientTiming.responseStartAt ?? clientTiming.fetchStartAt),
    });
    options?.onClientTiming?.(clientTiming);
    return terminal.terminal.result;
  } finally {
    unsubscribeProgress();
  }
}
