import {
  classifyCliStreamLogLevel,
  isCodexRefreshTokenReusedNoise,
  maybeFormatCodexTokenRefreshLogLine,
  type CodexTokenRefreshNoiseState,
} from "./cli-stream-log-classifier.js";

export function appendStreamTail(lines: string[], chunk: string, maxLines = 20): void {
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    lines.push(line);
    if (lines.length > maxLines) lines.shift();
  }
}

export function formatStreamTailForError(lines: string[]): string | null {
  if (lines.length === 0) return null;
  const summary = lines.slice(-4).join(" | ");
  if (!summary) return null;
  return summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;
}

export async function pipeLauncherStream(args: {
  sessionId: string;
  stream: ReadableStream<Uint8Array> | null;
  label: "stdout" | "stderr";
  tailLines?: string[];
  onText?: (text: string) => void;
  getSessionNum: (sessionId: string) => number | undefined;
  codexTokenRefreshNoiseBySession: Map<string, CodexTokenRefreshNoiseState>;
}): Promise<void> {
  const { sessionId, stream, label, tailLines, onText, getSessionNum, codexTokenRefreshNoiseBySession } = args;
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (tailLines) appendStreamTail(tailLines, text);
      onText?.(text);
      if (!text.trim()) continue;

      const sessionNum = getSessionNum(sessionId);
      const sessionLabel = sessionNum !== undefined ? `#${sessionNum}` : sessionId.slice(0, 8);
      const line = `[session:${sessionLabel}:${label}] ${text.trimEnd()}`;
      const level = classifyCliStreamLogLevel(label, text);
      const suppressedLine =
        label === "stderr" && isCodexRefreshTokenReusedNoise(text)
          ? maybeFormatCodexTokenRefreshLogLine(codexTokenRefreshNoiseBySession, sessionId, line)
          : line;
      if (suppressedLine) logCliStreamLine(level, suppressedLine);
    }
  } catch (err) {
    console.warn("[cli-launcher] CLI stream reader closed with error:", err);
  }
}

function logCliStreamLine(level: "info" | "warn" | "error", line: string): void {
  if (level === "info") {
    console.log(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.error(line);
}
