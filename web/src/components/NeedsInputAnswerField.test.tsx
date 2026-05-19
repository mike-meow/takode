// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { UseVoiceInputOptions } from "../hooks/useVoiceInput.js";
import type { SessionNotification } from "../types.js";
import type { NeedsInputQuestionView } from "../utils/notification-questions.js";
import { insertTextAtSelection } from "../utils/needs-input-voice-context.js";

const mockTranscribe = vi.hoisted(() =>
  vi.fn(async (_audio: Blob, _options?: unknown) => ({
    mode: "dictation" as const,
    text: "Takode",
    backend: "openai",
    enhanced: true,
  })),
);
const mockToggleRecording = vi.hoisted(() => vi.fn());
const voiceOptions = vi.hoisted(() => ({ current: null as UseVoiceInputOptions | null }));
const voiceState = vi.hoisted(() => ({ current: { isRecording: false } }));

vi.mock("../api.js", () => ({
  api: {
    transcribe: (audio: Blob, options?: unknown) => mockTranscribe(audio, options),
  },
}));

vi.mock("../hooks/useVoiceInput.js", () => ({
  useVoiceInput: (options: UseVoiceInputOptions) => {
    voiceOptions.current = options;
    return {
      isRecording: voiceState.current.isRecording,
      isPreparing: false,
      isSupported: true,
      unsupportedReason: null,
      unsupportedMessage: null,
      isTranscribing: false,
      transcriptionPhase: null,
      error: null,
      volumeLevel: 0,
      volumeHistory: [],
      setIsTranscribing: vi.fn(),
      setTranscriptionPhase: vi.fn(),
      setError: vi.fn(),
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
      toggleRecording: mockToggleRecording,
      warmMicrophone: vi.fn(),
    };
  },
}));

import {
  autoResizeNeedsInputAnswerTextarea,
  NEEDS_INPUT_ANSWER_MAX_HEIGHT_PX,
  NeedsInputAnswerField,
} from "./NeedsInputAnswerField.js";

const notification: SessionNotification = {
  id: "n-voice",
  category: "needs-input",
  summary: "Approve deployment?",
  timestamp: Date.now(),
  messageId: "msg-voice",
  done: false,
};

const question: NeedsInputQuestionView = {
  key: "legacy",
  prompt: "Approve deployment?",
  suggestedAnswers: ["yes", "no"],
};

describe("NeedsInputAnswerField", () => {
  beforeEach(() => {
    mockTranscribe.mockClear();
    mockToggleRecording.mockClear();
    voiceOptions.current = null;
    voiceState.current.isRecording = false;
  });

  it("auto-expands textarea height up to a capped internal scroll area", () => {
    const textarea = document.createElement("textarea");
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: NEEDS_INPUT_ANSWER_MAX_HEIGHT_PX + 80,
    });

    autoResizeNeedsInputAnswerTextarea(textarea);

    expect(textarea.style.height).toBe(`${NEEDS_INPUT_ANSWER_MAX_HEIGHT_PX}px`);
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("inserts transcribed voice text at the current selection and sends focused prompt context", async () => {
    const onChange = vi.fn();
    render(
      <NeedsInputAnswerField
        sessionId="s1"
        notification={notification}
        question={question}
        questionCount={1}
        value="hello world"
        onChange={onChange}
        placeholder="Your answer"
        sourceContext="The canary is green and rollback is ready."
        threadKey="q-777"
        threadTitle="q-777: Deploy service"
      />,
    );
    const textarea = screen.getByLabelText("Answer for Approve deployment?") as HTMLTextAreaElement;
    textarea.setSelectionRange(6, 11);

    fireEvent.click(screen.getByRole("button", { name: "Voice answer" }));
    voiceOptions.current?.onAudioReady?.(new Blob(["voice"], { type: "audio/webm" }));

    expect(mockToggleRecording).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mockTranscribe).toHaveBeenCalledWith(
        expect.any(Blob),
        expect.objectContaining({
          mode: "dictation",
          sessionId: "s1",
          threadKey: "q-777",
          threadTitle: "q-777: Deploy service",
          focusedContext: expect.stringContaining("Needs-input prompt: Approve deployment?"),
        }),
      ),
    );
    const options = mockTranscribe.mock.calls[0]?.[1] as unknown as { focusedContext: string };
    expect(options.focusedContext).toContain("Notification source context:");
    expect(options.focusedContext).toContain("The canary is green and rollback is ready.");
    expect(options.focusedContext).toContain("Suggested answers: yes, no");
    expect(onChange).toHaveBeenCalledWith("hello Takode");
  });

  it("uses simple dictation insertion semantics without edit or append mode", () => {
    expect(insertTextAtSelection("ship now", "please ", { value: "ship now", start: 0, end: 0 })).toBe(
      "please ship now",
    );
    expect(insertTextAtSelection("ship later", "now", { value: "ship later", start: 5, end: 10 })).toBe("ship now");
    expect(insertTextAtSelection("changed", " later", { value: "stale", start: 5, end: 5 })).toBe("changed later");
  });

  it("preserves the start-time selection baseline when stopping recording after the answer changes", async () => {
    function ControlledAnswerField() {
      const [value, setValue] = useState("ship now");
      return (
        <NeedsInputAnswerField
          sessionId="s1"
          notification={notification}
          question={question}
          questionCount={1}
          value={value}
          onChange={setValue}
          placeholder="Your answer"
          threadKey="main"
          threadTitle="Main Thread"
        />
      );
    }

    render(<ControlledAnswerField />);
    const textarea = screen.getByLabelText("Answer for Approve deployment?") as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 0);

    fireEvent.click(screen.getByRole("button", { name: "Voice answer" }));
    expect(mockToggleRecording).toHaveBeenCalledTimes(1);

    voiceState.current.isRecording = true;
    fireEvent.change(textarea, { target: { value: "manual edit" } });

    fireEvent.click(screen.getByRole("button", { name: "Stop voice answer" }));
    expect(mockToggleRecording).toHaveBeenCalledTimes(2);
    voiceOptions.current?.onAudioReady?.(new Blob(["voice"], { type: "audio/webm" }));

    await waitFor(() => expect(textarea).toHaveValue("manual editTakode"));
  });
});
