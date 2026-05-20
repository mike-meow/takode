import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import {
  transcribeWithGemini,
  transcribeWithOpenai,
  getAvailableBackends,
  getTranscriptionStatus,
  resolveAudioUploadFormat,
  resolveOpenAIKey,
} from "../transcription.js";
import {
  enhanceTranscript,
  buildSttPrompt,
  addTranscriptionLogEntry,
  attachTranscriptionFrontendTiming,
  applyVoiceEdit,
  applyVoiceAppend,
  type TranscriptionFrontendTimingEvent,
  type TranscriptionFrontendTimingReport,
} from "../transcription-enhancer.js";
import * as sessionNames from "../session-names.js";
import { getSettings } from "../settings-manager.js";
import type { RouteContext } from "./context.js";
import type { BrowserIncomingMessage } from "../session-types.js";
import { buildThreadWindowSync } from "../../shared/thread-window.js";
import { normalizeThreadTarget } from "../../shared/thread-routing.js";

const TRANSCRIPTION_THREAD_CONTEXT_TURNS = 12;
const TRANSCRIPTION_FOCUSED_CONTEXT_MAX_CHARS = 4000;
type TranscriptionMode = "dictation" | "edit" | "append";
type TranscriptionProgressPhase =
  | "transcribing"
  | "finalizing"
  | "enhancing"
  | "editing"
  | "appending"
  | "complete"
  | "error";
type TranscriptionFrontendTimingPhase =
  | "preparing"
  | "transcribing"
  | "finalizing"
  | "enhancing"
  | "editing"
  | "appending"
  | "complete"
  | "error";

interface TranscriptionServerTiming {
  uploadDurationMs?: number;
  sttDurationMs?: number;
  enhancementDurationMs?: number;
  audioSizeBytes?: number;
  audioMimeType?: string | null;
  audioFileName?: string | null;
}

const FRONTEND_TIMING_MAX_EVENTS = 100;
const FRONTEND_TIMING_PHASES = new Set<TranscriptionFrontendTimingPhase>([
  "preparing",
  "transcribing",
  "finalizing",
  "enhancing",
  "editing",
  "appending",
  "complete",
  "error",
]);
const FRONTEND_TIMING_VISIBLE_PHASES = new Set<Exclude<TranscriptionFrontendTimingPhase, "complete" | "error">>([
  "preparing",
  "transcribing",
  "finalizing",
  "enhancing",
  "editing",
  "appending",
]);
const FRONTEND_TIMING_SOURCES = new Set(["client", "sse", "websocket"]);
const FRONTEND_TIMING_STATUSES = new Set(["success", "error"]);

function normalizeFiniteMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function normalizeFrontendTimingEvent(value: unknown): TranscriptionFrontendTimingEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const phase = event.phase;
  const source = event.source;
  const eventTimestamp = normalizeTimestampMs(event.eventTimestamp);
  const clientTimestamp = normalizeTimestampMs(event.clientTimestamp);
  const elapsedMs = normalizeFiniteMs(event.elapsedMs);
  if (
    typeof phase !== "string" ||
    !FRONTEND_TIMING_PHASES.has(phase as TranscriptionFrontendTimingPhase) ||
    typeof source !== "string" ||
    !FRONTEND_TIMING_SOURCES.has(source) ||
    eventTimestamp === undefined ||
    clientTimestamp === undefined ||
    elapsedMs === undefined
  ) {
    return null;
  }

  const normalized: TranscriptionFrontendTimingEvent = {
    phase: phase as TranscriptionFrontendTimingPhase,
    source: source as "client" | "sse" | "websocket",
    eventTimestamp,
    clientTimestamp,
    elapsedMs,
  };
  const uploadDurationMs = normalizeFiniteMs(event.uploadDurationMs);
  if (uploadDurationMs !== undefined) normalized.uploadDurationMs = uploadDurationMs;
  const sttDurationMs = normalizeFiniteMs(event.sttDurationMs);
  if (sttDurationMs !== undefined) normalized.sttDurationMs = sttDurationMs;
  const enhancementDurationMs = normalizeFiniteMs(event.enhancementDurationMs);
  if (enhancementDurationMs !== undefined) normalized.enhancementDurationMs = enhancementDurationMs;
  return normalized;
}

function normalizeFrontendPhaseDurations(value: unknown): TranscriptionFrontendTimingReport["phaseDurationsMs"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const durations: TranscriptionFrontendTimingReport["phaseDurationsMs"] = {};
  for (const [phase, duration] of Object.entries(value)) {
    if (!FRONTEND_TIMING_VISIBLE_PHASES.has(phase as Exclude<TranscriptionFrontendTimingPhase, "complete" | "error">)) {
      continue;
    }
    const normalizedDuration = normalizeFiniteMs(duration);
    if (normalizedDuration !== undefined) {
      durations[phase as keyof TranscriptionFrontendTimingReport["phaseDurationsMs"]] = normalizedDuration;
    }
  }
  return durations;
}

function normalizeFrontendTimingReport(value: unknown): TranscriptionFrontendTimingReport | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
  const mode = body.mode;
  const status = body.status;
  const startedAt = normalizeTimestampMs(body.startedAt);
  const completedAt = normalizeTimestampMs(body.completedAt);
  const totalElapsedMs = normalizeFiniteMs(body.totalElapsedMs);
  const phaseDurationsMs = normalizeFrontendPhaseDurations(body.phaseDurationsMs);
  const rawEvents = Array.isArray(body.events) ? body.events.slice(0, FRONTEND_TIMING_MAX_EVENTS) : null;

  if (
    !requestId ||
    requestId.length > 200 ||
    (mode !== undefined && mode !== "dictation" && mode !== "edit" && mode !== "append") ||
    typeof status !== "string" ||
    !FRONTEND_TIMING_STATUSES.has(status) ||
    startedAt === undefined ||
    completedAt === undefined ||
    totalElapsedMs === undefined ||
    !phaseDurationsMs ||
    !rawEvents
  ) {
    return null;
  }

  const events = rawEvents.map(normalizeFrontendTimingEvent);
  if (events.some((event) => event === null)) return null;

  return {
    requestId,
    sessionId,
    ...(mode === "dictation" || mode === "edit" || mode === "append" ? { mode } : {}),
    status: status as "success" | "error",
    startedAt,
    completedAt,
    totalElapsedMs,
    phaseDurationsMs,
    events: events as TranscriptionFrontendTimingEvent[],
  };
}

export function createTranscriptionRoutes(ctx: RouteContext) {
  const api = new Hono();
  const { launcher, wsBridge } = ctx;

  // ─── Audio transcription ─────────────────────────────────────────────

  /**
   * Get names of recent non-archived sessions (excluding the given session).
   * Sorted by last activity (most recent first), limited to `limit` entries.
   */
  function getRecentSessionNames(excludeSessionId: string, limit: number): string[] {
    const allSessions = launcher.listSessions();
    const allNames = sessionNames.getAllNames();
    return allSessions
      .filter((s) => s.sessionId !== excludeSessionId && !s.archived && allNames[s.sessionId])
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
      .slice(0, limit)
      .map((s) => allNames[s.sessionId]);
  }

  function normalizeTranscriptionThreadKey(rawThreadKey: string | undefined): string | undefined {
    if (!rawThreadKey) return undefined;
    const trimmed = rawThreadKey.trim().toLowerCase();
    if (trimmed === "all") return "main";
    return normalizeThreadTarget(trimmed)?.threadKey;
  }

  function normalizeTranscriptionThreadTitle(rawThreadTitle: string | undefined): string | undefined {
    const trimmed = rawThreadTitle?.trim().replace(/\s+/g, " ");
    return trimmed ? trimmed.slice(0, 300) : undefined;
  }

  function normalizeTranscriptionFocusedContext(rawFocusedContext: string | undefined): string | undefined {
    const trimmed = rawFocusedContext
      ?.trim()
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
    return trimmed ? trimmed.slice(0, TRANSCRIPTION_FOCUSED_CONTEXT_MAX_CHARS) : undefined;
  }

  function buildThreadScopedTranscriptionHistory(
    history: BrowserIncomingMessage[] | null,
    threadKey: string | undefined,
  ): BrowserIncomingMessage[] | null {
    if (!history || !threadKey) return history;

    const sync = buildThreadWindowSync({
      messageHistory: history,
      threadKey,
      fromItem: -1,
      itemCount: TRANSCRIPTION_THREAD_CONTEXT_TURNS,
      sectionItemCount: 1,
      visibleItemCount: TRANSCRIPTION_THREAD_CONTEXT_TURNS,
    });
    return sync.entries.map((entry) => entry.message);
  }

  function getTranscriptionSessionContext(
    sessionId: string | undefined,
    threadKey: string | undefined,
    threadTitle: string | undefined,
  ) {
    if (!sessionId) {
      return {
        messageHistory: null,
        taskHistory: [],
        sessionName: undefined,
        threadTitle: undefined,
        activeSessionNames: undefined,
      };
    }

    const session = wsBridge.getSession(sessionId);
    const activeSessionNames = getRecentSessionNames(sessionId, 20);
    return {
      messageHistory: buildThreadScopedTranscriptionHistory(session?.messageHistory ?? null, threadKey),
      taskHistory: session?.taskHistory ?? [],
      sessionName: sessionNames.getName(sessionId),
      threadTitle,
      activeSessionNames: activeSessionNames.length > 0 ? activeSessionNames : undefined,
    };
  }

  function emitTranscriptionProgress({
    sessionId,
    requestId,
    phase,
    mode,
    timing,
    error,
  }: {
    sessionId: string | undefined;
    requestId: string | undefined;
    phase: TranscriptionProgressPhase;
    mode?: TranscriptionMode;
    timing?: TranscriptionServerTiming;
    error?: string;
  }): void {
    if (!sessionId || !requestId) return;
    wsBridge.broadcastToSession(sessionId, {
      type: "transcription_progress",
      requestId,
      phase,
      mode,
      timestamp: Date.now(),
      ...(timing ? { timing } : {}),
      ...(error ? { error } : {}),
    });
  }

  // ─── Enhancement tester (debug tool) ───────────────────────────────

  /**
   * Run the enhancement pipeline on raw text without recording audio.
   * Used by the Settings page "Enhancement Tester" panel.
   */
  api.post("/transcription/test-enhance", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const mode = body.mode === "bullet" ? "bullet" : "default";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;

    if (!text) {
      return c.json({ error: "text is required" }, 400);
    }

    const apiKey = resolveOpenAIKey();
    if (!apiKey) {
      return c.json(
        { error: "No OpenAI API key configured. Set it in Settings → Voice Transcription, or set OPENAI_API_KEY." },
        400,
      );
    }

    const settings = getSettings();
    // Override config to force enhancement on with the requested mode
    const config = {
      ...settings.transcriptionConfig,
      enhancementEnabled: true,
      enhancementMode: mode as "default" | "bullet",
    };

    // Gather session context if available
    let history = sessionId ? (wsBridge.getSession(sessionId)?.messageHistory ?? null) : null;
    const extra: Parameters<typeof enhanceTranscript>[4] = {
      mode: "dictation",
      customVocabulary: settings.transcriptionConfig.customVocabulary || undefined,
    };
    if (sessionId) {
      const taskHistory = wsBridge.getSession(sessionId)?.taskHistory ?? [];
      extra.taskTitles = taskHistory.map((t) => t.title);
      extra.sessionName = sessionNames.getName(sessionId);
      const otherNames = getRecentSessionNames(sessionId, 20);
      if (otherNames.length > 0) extra.activeSessionNames = otherNames;
    }

    try {
      const result = await enhanceTranscript(text, history, config, apiKey, extra);
      return c.json({
        enhanced: result.text,
        wasEnhanced: result.enhanced,
        debug: result._debug
          ? {
              model: result._debug.model,
              systemPrompt: result._debug.systemPrompt,
              userMessage: result._debug.userMessage,
              durationMs: result._debug.durationMs,
              skipReason: result._debug.skipReason,
            }
          : null,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `Enhancement failed: ${msg}` }, 500);
    }
  });

  // ─── Audio transcription ─────────────────────────────────────────────

  api.get("/transcribe/status", (c) => {
    return c.json(getTranscriptionStatus());
  });

  api.post("/transcribe/frontend-timing", async (c) => {
    const report = normalizeFrontendTimingReport(await c.req.json().catch(() => null));
    if (!report) return c.json({ error: "Invalid frontend transcription timing report" }, 400);
    const result = attachTranscriptionFrontendTiming(report);
    return c.json({ ok: true, ...result });
  });

  api.post("/transcribe", async (c) => {
    const requestStart = Date.now();
    const contentType = c.req.header("content-type") || "";
    let buf: Buffer;
    let audioMimeType: string | undefined;
    let audioFileName: string | undefined;
    let sessionId: string | undefined;
    let rawMode = "dictation";
    let composerText: string | undefined;
    let requestedBackend: string | undefined;
    let rawThreadKey: string | undefined;
    let rawThreadTitle: string | undefined;
    let rawFocusedContext: string | undefined;
    let transcriptionRequestId: string | undefined;

    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const body = await c.req.parseBody();
      const audioFile = body["audio"];
      if (!audioFile || typeof audioFile === "string") {
        return c.json({ error: "audio field is required (multipart)" }, 400);
      }
      buf = Buffer.from(await audioFile.arrayBuffer());
      audioMimeType = audioFile.type;
      audioFileName = audioFile.name;
      sessionId = typeof body["sessionId"] === "string" ? body["sessionId"] : undefined;
      rawMode = typeof body["mode"] === "string" ? body["mode"] : "dictation";
      composerText = typeof body["composerText"] === "string" ? body["composerText"] : undefined;
      requestedBackend = typeof body["backend"] === "string" ? body["backend"] : undefined;
      rawThreadKey = typeof body["threadKey"] === "string" ? body["threadKey"] : undefined;
      rawThreadTitle = typeof body["threadTitle"] === "string" ? body["threadTitle"] : undefined;
      rawFocusedContext = typeof body["focusedContext"] === "string" ? body["focusedContext"] : undefined;
      transcriptionRequestId = typeof body["requestId"] === "string" ? body["requestId"] : undefined;
    } else {
      buf = Buffer.from(await c.req.arrayBuffer());
      if (buf.length === 0) {
        return c.json({ error: "audio body is required" }, 400);
      }
      audioMimeType = contentType || undefined;
      audioFileName = c.req.header("x-companion-audio-filename") || undefined;
      sessionId = c.req.query("sessionId") || undefined;
      rawMode = c.req.query("mode") || "dictation";
      composerText = c.req.query("composerText") || undefined;
      requestedBackend = c.req.query("backend") || undefined;
      rawThreadKey = c.req.query("threadKey") || undefined;
      rawThreadTitle = c.req.query("threadTitle") || undefined;
      rawFocusedContext = c.req.query("focusedContext") || undefined;
      transcriptionRequestId = c.req.query("requestId") || undefined;
    }

    const uploadDurationMs = Date.now() - requestStart;
    const mode = rawMode === "edit" ? "edit" : rawMode === "append" ? "append" : "dictation";
    const threadKey = normalizeTranscriptionThreadKey(rawThreadKey);
    const threadTitle = normalizeTranscriptionThreadTitle(rawThreadTitle);
    const focusedContext = normalizeTranscriptionFocusedContext(rawFocusedContext);
    const { default: defaultBackend } = getAvailableBackends();
    const backend = requestedBackend || defaultBackend;
    const uploadTiming = {
      uploadDurationMs,
      audioSizeBytes: buf.length,
      audioMimeType: audioMimeType ?? null,
      audioFileName: audioFileName ?? null,
    };

    if (!backend) {
      return c.json(
        {
          error:
            "No transcription backend available. Configure an OpenAI API key in Settings → Voice Transcription, or set OPENAI_API_KEY / GOOGLE_API_KEY in your environment.",
        },
        400,
      );
    }

    if (mode === "edit" && composerText === undefined) {
      return c.json({ error: "composerText is required for voice edit mode." }, 400);
    }

    if (mode === "append" && composerText === undefined) {
      return c.json({ error: "composerText is required for voice append mode." }, 400);
    }

    if ((mode === "edit" || mode === "append") && !resolveOpenAIKey()) {
      return c.json(
        {
          error:
            "Voice edit requires an OpenAI-compatible enhancement model API key in Settings → Voice Transcription, or OPENAI_API_KEY in your environment.",
        },
        400,
      );
    }

    const uploadFormat = resolveAudioUploadFormat(buf, audioMimeType, audioFileName);
    emitTranscriptionProgress({
      sessionId,
      requestId: transcriptionRequestId,
      phase: "transcribing",
      mode,
      timing: uploadTiming,
    });

    // The browser must finish sending the request body before we can open the SSE
    // response. The raw-audio dictation path skips multipart parsing overhead,
    // but the client still treats this pre-response window as distinct from STT.
    return streamSSE(c, async (stream: SSEStreamingApi) => {
      try {
        // Send an immediate body chunk so the client can leave its pre-STT
        // waiting state as soon as the SSE stream is actually flowing.
        await stream.writeSSE({
          event: "phase",
          data: JSON.stringify({ phase: "transcribing", mode }),
        });

        let rawText: string;
        const usedBackend = backend;
        let sttModel = "unknown";

        // Build context-aware STT prompt (guides vocabulary recognition)
        // Get recent non-archived session names sorted by activity (most recent first)
        const sessionContext = getTranscriptionSessionContext(sessionId, threadKey, threadTitle);
        let sttPrompt = "";
        if (sessionId) {
          sttPrompt = buildSttPrompt({
            mode,
            taskHistory: sessionContext.taskHistory,
            sessionName: sessionContext.sessionName,
            threadTitle: sessionContext.threadTitle,
            focusedContext,
            activeSessionNames: sessionContext.activeSessionNames?.slice(0, 10),
            composerText: mode === "edit" || mode === "append" ? composerText : undefined,
            messageHistory: sessionContext.messageHistory,
            customVocabulary: getSettings().transcriptionConfig.customVocabulary || undefined,
          });
        }

        const sttStart = Date.now();

        if (backend === "gemini") {
          const apiKey = process.env.GOOGLE_API_KEY;
          if (!apiKey) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ error: "GOOGLE_API_KEY not set in environment" }),
            });
            return;
          }
          rawText = await transcribeWithGemini(buf, uploadFormat.mimeType, apiKey);
          sttModel = "gemini";
        } else if (backend === "openai") {
          const apiKey = resolveOpenAIKey();
          if (!apiKey) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                error:
                  "No OpenAI API key configured. Set it in Settings → Voice Transcription, or set OPENAI_API_KEY in your environment.",
              }),
            });
            return;
          }
          const configuredSttModel = getSettings().transcriptionConfig.sttModel || "gpt-4o-mini-transcribe";
          rawText = await transcribeWithOpenai(
            buf,
            uploadFormat.mimeType,
            apiKey,
            sttPrompt || undefined,
            audioFileName,
            configuredSttModel,
          );
          sttModel = configuredSttModel;
        } else {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ error: `Unknown backend: ${backend}` }) });
          return;
        }

        const sttDurationMs = Date.now() - sttStart;

        const settings = getSettings();
        const enhancementKey = resolveOpenAIKey();
        const willEnhanceDictation = !!(
          sessionId &&
          usedBackend === "openai" &&
          settings.transcriptionConfig.enhancementEnabled &&
          enhancementKey
        );
        const willRunVoiceEdit = mode === "edit";
        const willRunVoiceAppend = mode === "append";
        const nextPhase = willRunVoiceEdit
          ? "editing"
          : willRunVoiceAppend
            ? "appending"
            : willEnhanceDictation
              ? "enhancing"
              : "finalizing";
        await stream.writeSSE({
          event: "stt_complete",
          data: JSON.stringify({
            rawText,
            backend: usedBackend,
            willEnhance: willEnhanceDictation,
            nextPhase,
            mode,
            timing: { ...uploadTiming, sttDurationMs },
          }),
        });

        if (willRunVoiceEdit) {
          const enhancementStart = Date.now();
          emitTranscriptionProgress({
            sessionId,
            requestId: transcriptionRequestId,
            phase: "editing",
            mode,
            timing: { ...uploadTiming, sttDurationMs },
          });
          const result = await applyVoiceEdit(
            rawText,
            composerText!,
            sessionContext.messageHistory,
            settings.transcriptionConfig,
            enhancementKey!,
            {
              mode,
              composerText,
              taskTitles: sessionContext.taskHistory.map((t) => t.title),
              sessionName: sessionContext.sessionName,
              threadTitle: sessionContext.threadTitle,
              focusedContext,
              activeSessionNames: sessionContext.activeSessionNames,
              customVocabulary: settings.transcriptionConfig.customVocabulary || undefined,
            },
          );
          const enhancementDurationMs = Date.now() - enhancementStart;

          addTranscriptionLogEntry({
            sessionId: sessionId ?? null,
            requestId: transcriptionRequestId ?? null,
            mode,
            uploadDurationMs,
            sttModel,
            sttDurationMs,
            sttPrompt,
            rawTranscript: rawText,
            audioSizeBytes: buf.length,
            audioMimeType: audioMimeType ?? uploadFormat.mimeType,
            audioFileName: audioFileName ?? null,
            audioBytes: Buffer.from(buf),
            enhancement: {
              model: result._debug.model,
              systemPrompt: result._debug.systemPrompt,
              userMessage: result._debug.userMessage,
              enhancedText: result._debug.enhancedText,
              durationMs: result._debug.durationMs,
              skipReason: result._debug.skipReason,
            },
          });
          emitTranscriptionProgress({
            sessionId,
            requestId: transcriptionRequestId,
            phase: "complete",
            mode,
            timing: { ...uploadTiming, sttDurationMs, enhancementDurationMs },
          });

          await stream.writeSSE({
            event: "result",
            data: JSON.stringify({
              mode,
              text: result.text,
              rawText,
              instructionText: rawText,
              backend: usedBackend,
              enhanced: true,
              timing: { ...uploadTiming, sttDurationMs, enhancementDurationMs },
            }),
          });
          return;
        }

        // Voice append: clean transcribed speech for insertion at cursor position
        if (willRunVoiceAppend) {
          const enhancementStart = Date.now();
          emitTranscriptionProgress({
            sessionId,
            requestId: transcriptionRequestId,
            phase: "appending",
            mode,
            timing: { ...uploadTiming, sttDurationMs },
          });
          const result = await applyVoiceAppend(
            rawText,
            composerText!,
            sessionContext.messageHistory,
            settings.transcriptionConfig,
            enhancementKey!,
            {
              mode,
              composerText,
              taskTitles: sessionContext.taskHistory.map((t) => t.title),
              sessionName: sessionContext.sessionName,
              threadTitle: sessionContext.threadTitle,
              focusedContext,
              activeSessionNames: sessionContext.activeSessionNames,
              customVocabulary: settings.transcriptionConfig.customVocabulary || undefined,
            },
          );
          const enhancementDurationMs = Date.now() - enhancementStart;

          addTranscriptionLogEntry({
            sessionId: sessionId ?? null,
            requestId: transcriptionRequestId ?? null,
            mode,
            uploadDurationMs,
            sttModel,
            sttDurationMs,
            sttPrompt,
            rawTranscript: rawText,
            audioSizeBytes: buf.length,
            audioMimeType: audioMimeType ?? uploadFormat.mimeType,
            audioFileName: audioFileName ?? null,
            audioBytes: Buffer.from(buf),
            enhancement: {
              model: result._debug.model,
              systemPrompt: result._debug.systemPrompt,
              userMessage: result._debug.userMessage,
              enhancedText: result._debug.enhancedText,
              durationMs: result._debug.durationMs,
              skipReason: result._debug.skipReason,
            },
          });
          emitTranscriptionProgress({
            sessionId,
            requestId: transcriptionRequestId,
            phase: "complete",
            mode,
            timing: { ...uploadTiming, sttDurationMs, enhancementDurationMs },
          });

          await stream.writeSSE({
            event: "result",
            data: JSON.stringify({
              mode,
              text: result.text,
              rawText,
              backend: usedBackend,
              enhanced: true,
              timing: { ...uploadTiming, sttDurationMs, enhancementDurationMs },
            }),
          });
          return;
        }

        // Tier 2: Context-aware enhancement (OpenAI backend only)
        if (willEnhanceDictation) {
          const enhancementStart = Date.now();
          emitTranscriptionProgress({
            sessionId,
            requestId: transcriptionRequestId,
            phase: "enhancing",
            mode,
            timing: { ...uploadTiming, sttDurationMs },
          });
          const result = await enhanceTranscript(
            rawText,
            sessionContext.messageHistory,
            settings.transcriptionConfig,
            enhancementKey!,
            {
              mode,
              taskTitles: sessionContext.taskHistory.map((t) => t.title),
              sessionName: sessionContext.sessionName,
              threadTitle: sessionContext.threadTitle,
              focusedContext,
              activeSessionNames: sessionContext.activeSessionNames,
              customVocabulary: settings.transcriptionConfig.customVocabulary || undefined,
            },
          );
          const enhancementDurationMs = Date.now() - enhancementStart;

          // Log for debug panel
          addTranscriptionLogEntry({
            sessionId: sessionId!,
            requestId: transcriptionRequestId ?? null,
            mode,
            uploadDurationMs,
            sttModel,
            sttDurationMs,
            sttPrompt,
            rawTranscript: rawText,
            audioSizeBytes: buf.length,
            audioMimeType: audioMimeType ?? uploadFormat.mimeType,
            audioFileName: audioFileName ?? null,
            audioBytes: Buffer.from(buf),
            enhancement: result._debug
              ? {
                  model: result._debug.model,
                  systemPrompt: result._debug.systemPrompt,
                  userMessage: result._debug.userMessage,
                  enhancedText: result._debug.enhancedText,
                  durationMs: result._debug.durationMs,
                  skipReason: result._debug.skipReason,
                }
              : null,
          });
          emitTranscriptionProgress({
            sessionId,
            requestId: transcriptionRequestId,
            phase: "complete",
            mode,
            timing: { ...uploadTiming, sttDurationMs, enhancementDurationMs },
          });

          await stream.writeSSE({
            event: "result",
            data: JSON.stringify({
              mode,
              text: result.text,
              rawText: result.rawText,
              backend: usedBackend,
              enhanced: result.enhanced,
              timing: { ...uploadTiming, sttDurationMs, enhancementDurationMs },
            }),
          });
          return;
        }

        // Log STT-only call (no enhancement attempted)
        emitTranscriptionProgress({
          sessionId,
          requestId: transcriptionRequestId,
          phase: "finalizing",
          mode,
          timing: { ...uploadTiming, sttDurationMs },
        });
        addTranscriptionLogEntry({
          sessionId: sessionId ?? null,
          requestId: transcriptionRequestId ?? null,
          mode,
          uploadDurationMs,
          sttModel,
          sttDurationMs,
          sttPrompt,
          rawTranscript: rawText,
          audioSizeBytes: buf.length,
          audioMimeType: audioMimeType ?? uploadFormat.mimeType,
          audioFileName: audioFileName ?? null,
          audioBytes: Buffer.from(buf),
          enhancement: null,
        });
        emitTranscriptionProgress({
          sessionId,
          requestId: transcriptionRequestId,
          phase: "complete",
          mode,
          timing: { ...uploadTiming, sttDurationMs },
        });

        await stream.writeSSE({
          event: "result",
          data: JSON.stringify({
            mode,
            text: rawText,
            backend: usedBackend,
            enhanced: false,
            timing: { ...uploadTiming, sttDurationMs },
          }),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[transcription] ${backend} failed:`, msg);
        emitTranscriptionProgress({
          sessionId,
          requestId: transcriptionRequestId,
          phase: "error",
          mode,
          timing: uploadTiming,
          error: msg,
        });
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: `Transcription failed: ${msg}` }) });
      }
    });
  });

  return api;
}
