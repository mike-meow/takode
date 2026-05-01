// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockApi = vi.hoisted(() => ({
  getTranscriptionLogs: vi.fn(),
  getTranscriptionLogEntry: vi.fn(),
}));

vi.mock("../api.js", () => ({
  api: {
    getTranscriptionLogs: (...args: unknown[]) => mockApi.getTranscriptionLogs(...args),
    getTranscriptionLogEntry: (...args: unknown[]) => mockApi.getTranscriptionLogEntry(...args),
  },
}));

import { TranscriptionDebugPanel } from "./TranscriptionDebugPanel.js";

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  mockApi.getTranscriptionLogs.mockResolvedValue([
    {
      id: 42,
      timestamp: Date.now(),
      sessionId: "session-12345678",
      mode: "dictation",
      uploadDurationMs: 12,
      sttModel: "gpt-4o-mini-transcribe-alpha-tapioca-4",
      sttDurationMs: 1100,
      rawTranscript: "debug transcript",
      audioSizeBytes: 4096,
      audioMimeType: "audio/wav",
      audioFileName: "recording.wav",
      audioUrl: "/api/transcription-logs/42/audio",
      enhancement: null,
    },
  ]);
  mockApi.getTranscriptionLogEntry.mockResolvedValue({
    id: 42,
    timestamp: Date.now(),
    sessionId: "session-12345678",
    mode: "dictation",
    uploadDurationMs: 12,
    sttModel: "gpt-4o-mini-transcribe-alpha-tapioca-4",
    sttDurationMs: 1100,
    rawTranscript: "debug transcript",
    audioSizeBytes: 4096,
    audioMimeType: "audio/wav",
    audioFileName: "recording.wav",
    audioUrl: "/api/transcription-logs/42/audio",
    sttPrompt: "Prompt sent to the STT model",
    enhancement: null,
  });
});

describe("TranscriptionDebugPanel", () => {
  it("uses model-agnostic raw transcript labeling and exposes a copyable source audio link", async () => {
    // Non-Whisper STT models should not inherit legacy Whisper-specific debug copy.
    render(<TranscriptionDebugPanel />);

    fireEvent.click(screen.getByText("Show"));
    fireEvent.click(await screen.findByText("gpt-4o-mini-transcribe-alpha-tapioca-4"));

    expect(await screen.findByText("Raw Transcript (STT Output)")).toBeInTheDocument();
    expect(screen.queryByText(/Whisper Output/i)).not.toBeInTheDocument();

    const audioUrl = new URL("/api/transcription-logs/42/audio", window.location.origin).toString();
    expect(screen.getByRole("link", { name: "Open source audio" })).toHaveAttribute("href", audioUrl);

    fireEvent.click(screen.getByRole("button", { name: "Copy audio link" }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(audioUrl));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
