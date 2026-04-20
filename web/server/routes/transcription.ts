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
  applyVoiceEdit,
  applyVoiceAppend,
} from "../transcription-enhancer.js";
import * as sessionNames from "../session-names.js";
import { getSettings } from "../settings-manager.js";
import type { RouteContext } from "./context.js";

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
    let history = sessionId ? wsBridge.getMessageHistory(sessionId) : null;
    const extra: Parameters<typeof enhanceTranscript>[4] = { mode: "dictation" };
    if (sessionId) {
      const taskHistory = wsBridge.getSessionTaskHistory(sessionId);
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

  api.post("/transcribe", async (c) => {
    const requestStart = Date.now();
    const body = await c.req.parseBody();
    const uploadDurationMs = Date.now() - requestStart;
    const audioFile = body["audio"];
    if (!audioFile || typeof audioFile === "string") {
      return c.json({ error: "audio field is required (multipart)" }, 400);
    }

    const sessionId = typeof body["sessionId"] === "string" ? body["sessionId"] : undefined;
    const rawMode = typeof body["mode"] === "string" ? body["mode"] : "dictation";
    const mode = rawMode === "edit" ? "edit" : rawMode === "append" ? "append" : "dictation";
    const composerText = typeof body["composerText"] === "string" ? body["composerText"] : undefined;
    const requestedBackend = typeof body["backend"] === "string" ? body["backend"] : undefined;
    const { default: defaultBackend } = getAvailableBackends();
    const backend = requestedBackend || defaultBackend;

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

    const buf = Buffer.from(await audioFile.arrayBuffer());
    const uploadFormat = resolveAudioUploadFormat(buf, audioFile.type, audioFile.name);

    // Multipart upload + parse must finish before we can open the SSE stream, so
    // the client treats this pre-response window as a distinct "uploading" phase.
    return streamSSE(c, async (stream: SSEStreamingApi) => {
      try {
        let rawText: string;
        const usedBackend = backend;
        let sttModel = "unknown";

        // Build context-aware STT prompt (guides vocabulary recognition)
        // Get recent non-archived session names sorted by activity (most recent first)
        let sttPrompt = "";
        if (sessionId) {
          const recentOtherNames = getRecentSessionNames(sessionId, 10);
          sttPrompt = buildSttPrompt({
            mode,
            taskHistory: wsBridge.getSessionTaskHistory(sessionId),
            sessionName: sessionNames.getName(sessionId),
            activeSessionNames: recentOtherNames.length > 0 ? recentOtherNames : undefined,
            composerText: mode === "edit" || mode === "append" ? composerText : undefined,
            messageHistory: wsBridge.getMessageHistory(sessionId),
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
            audioFile.name,
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
        await stream.writeSSE({
          event: "stt_complete",
          data: JSON.stringify({
            rawText,
            backend: usedBackend,
            willEnhance: willEnhanceDictation,
            nextPhase: willRunVoiceEdit
              ? "editing"
              : willRunVoiceAppend
                ? "appending"
                : willEnhanceDictation
                  ? "enhancing"
                  : null,
            mode,
          }),
        });

        if (willRunVoiceEdit) {
          const history = sessionId ? wsBridge.getMessageHistory(sessionId) : null;
          const taskHistory = sessionId ? wsBridge.getSessionTaskHistory(sessionId) : [];
          const enhOtherNames = sessionId ? getRecentSessionNames(sessionId, 20) : [];
          const result = await applyVoiceEdit(
            rawText,
            composerText!,
            history,
            settings.transcriptionConfig,
            enhancementKey!,
            {
              mode,
              composerText,
              taskTitles: taskHistory.map((t) => t.title),
              sessionName: sessionId ? sessionNames.getName(sessionId) : undefined,
              activeSessionNames: enhOtherNames.length > 0 ? enhOtherNames : undefined,
            },
          );

          addTranscriptionLogEntry({
            sessionId: sessionId ?? null,
            mode,
            uploadDurationMs,
            sttModel,
            sttDurationMs,
            sttPrompt,
            rawTranscript: rawText,
            audioSizeBytes: buf.length,
            enhancement: {
              model: result._debug.model,
              systemPrompt: result._debug.systemPrompt,
              userMessage: result._debug.userMessage,
              enhancedText: result._debug.enhancedText,
              durationMs: result._debug.durationMs,
              skipReason: result._debug.skipReason,
            },
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
            }),
          });
          return;
        }

        // Voice append: clean transcribed speech for insertion at cursor position
        if (willRunVoiceAppend) {
          const history = sessionId ? wsBridge.getMessageHistory(sessionId) : null;
          const taskHistory = sessionId ? wsBridge.getSessionTaskHistory(sessionId) : [];
          const enhOtherNames = sessionId ? getRecentSessionNames(sessionId, 20) : [];
          const result = await applyVoiceAppend(
            rawText,
            composerText!,
            history,
            settings.transcriptionConfig,
            enhancementKey!,
            {
              mode,
              composerText,
              taskTitles: taskHistory.map((t) => t.title),
              sessionName: sessionId ? sessionNames.getName(sessionId) : undefined,
              activeSessionNames: enhOtherNames.length > 0 ? enhOtherNames : undefined,
            },
          );

          addTranscriptionLogEntry({
            sessionId: sessionId ?? null,
            mode,
            uploadDurationMs,
            sttModel,
            sttDurationMs,
            sttPrompt,
            rawTranscript: rawText,
            audioSizeBytes: buf.length,
            enhancement: {
              model: result._debug.model,
              systemPrompt: result._debug.systemPrompt,
              userMessage: result._debug.userMessage,
              enhancedText: result._debug.enhancedText,
              durationMs: result._debug.durationMs,
              skipReason: result._debug.skipReason,
            },
          });

          await stream.writeSSE({
            event: "result",
            data: JSON.stringify({
              mode,
              text: result.text,
              rawText,
              backend: usedBackend,
              enhanced: true,
            }),
          });
          return;
        }

        // Tier 2: Context-aware enhancement (OpenAI backend only)
        if (willEnhanceDictation) {
          const history = wsBridge.getMessageHistory(sessionId!);

          // Build enriched context for enhancement
          const taskHistory = wsBridge.getSessionTaskHistory(sessionId!);
          const enhOtherNames = getRecentSessionNames(sessionId!, 20);

          const result = await enhanceTranscript(rawText, history, settings.transcriptionConfig, enhancementKey!, {
            mode,
            taskTitles: taskHistory.map((t) => t.title),
            sessionName: sessionNames.getName(sessionId!),
            activeSessionNames: enhOtherNames.length > 0 ? enhOtherNames : undefined,
          });

          // Log for debug panel
          addTranscriptionLogEntry({
            sessionId: sessionId!,
            mode,
            uploadDurationMs,
            sttModel,
            sttDurationMs,
            sttPrompt,
            rawTranscript: rawText,
            audioSizeBytes: buf.length,
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

          await stream.writeSSE({
            event: "result",
            data: JSON.stringify({
              mode,
              text: result.text,
              rawText: result.rawText,
              backend: usedBackend,
              enhanced: result.enhanced,
            }),
          });
          return;
        }

        // Log STT-only call (no enhancement attempted)
        addTranscriptionLogEntry({
          sessionId: sessionId ?? null,
          mode,
          uploadDurationMs,
          sttModel,
          sttDurationMs,
          sttPrompt,
          rawTranscript: rawText,
          audioSizeBytes: buf.length,
          enhancement: null,
        });

        await stream.writeSSE({
          event: "result",
          data: JSON.stringify({ mode, text: rawText, backend: usedBackend, enhanced: false }),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[transcription] ${backend} failed:`, msg);
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: `Transcription failed: ${msg}` }) });
      }
    });
  });

  return api;
}
