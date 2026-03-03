/**
 * Audio transcription service supporting Gemini and OpenAI Whisper backends.
 *
 * Both functions accept raw audio as a Buffer and return the transcription text.
 * API keys are resolved via resolveOpenAIKey() (settings → env var → namer key).
 */

import { getSettings } from "./settings-manager.js";

/**
 * Transcribe audio using Google Gemini API (inline base64 audio).
 * Uses gemini-2.0-flash for fast, cost-effective transcription.
 */
export async function transcribeWithGemini(
  audioBuffer: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<string> {
  const base64Audio = audioBuffer.toString("base64");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Audio,
                },
              },
              {
                text: "Transcribe this audio. Return only the transcription text, nothing else.",
              },
            ],
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Gemini API error (${response.status}): ${errorBody || response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned no transcription text");
  }

  return text.trim();
}

/**
 * Transcribe audio using OpenAI Whisper API (multipart form upload).
 */
export async function transcribeWithOpenai(
  audioBuffer: Buffer,
  mimeType: string,
  apiKey: string,
): Promise<string> {
  // Map MIME type to a file extension Whisper expects
  const extMap: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
  };
  const ext = extMap[mimeType] || "webm";

  const form = new FormData();
  form.append("model", "whisper-1");
  form.append(
    "file",
    new Blob([new Uint8Array(audioBuffer)], { type: mimeType }),
    `recording.${ext}`,
  );

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Whisper API error (${response.status}): ${errorBody || response.statusText}`,
    );
  }

  const data = (await response.json()) as { text?: string };
  if (!data.text) {
    throw new Error("Whisper returned no transcription text");
  }

  return data.text.trim();
}

/**
 * Resolve an OpenAI API key from multiple sources, in priority order:
 * 1. transcriptionConfig.apiKey (dedicated setting)
 * 2. OPENAI_API_KEY env var
 * 3. namerConfig.apiKey (if namer uses OpenAI — reuse existing key)
 */
export function resolveOpenAIKey(): string | null {
  const settings = getSettings();
  if (settings.transcriptionConfig.apiKey) return settings.transcriptionConfig.apiKey;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (settings.namerConfig.backend === "openai" && settings.namerConfig.apiKey) {
    return settings.namerConfig.apiKey;
  }
  return null;
}

/** Check which transcription backends are available (settings + env vars). */
export function getAvailableBackends(): {
  backends: string[];
  default: string | null;
} {
  const backends: string[] = [];
  if (process.env.GOOGLE_API_KEY) backends.push("gemini");
  if (resolveOpenAIKey()) backends.push("openai");
  return {
    backends,
    default: backends[0] ?? null,
  };
}

/** Get transcription status for the new API shape. */
export function getTranscriptionStatus(): {
  available: boolean;
  enhancementEnabled: boolean;
  backend: string | null;
} {
  const key = resolveOpenAIKey();
  const settings = getSettings();
  return {
    available: !!key || !!process.env.GOOGLE_API_KEY,
    enhancementEnabled: !!key && settings.transcriptionConfig.enhancementEnabled,
    backend: key ? "openai" : process.env.GOOGLE_API_KEY ? "gemini" : null,
  };
}
