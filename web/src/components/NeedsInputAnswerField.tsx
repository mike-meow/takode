import { useCallback, useEffect, useLayoutEffect, useRef, type MouseEvent } from "react";
import { api, type VoiceTranscriptionPhase } from "../api.js";
import { useVoiceInput } from "../hooks/useVoiceInput.js";
import type { SessionNotification } from "../types.js";
import type { NeedsInputQuestionView } from "../utils/notification-questions.js";
import {
  buildNeedsInputVoiceFocusedContext,
  insertTextAtSelection,
  type TextSelectionRange,
} from "../utils/needs-input-voice-context.js";

export const NEEDS_INPUT_ANSWER_MAX_HEIGHT_PX = 132;

export function autoResizeNeedsInputAnswerTextarea(
  textarea: HTMLTextAreaElement | null,
  maxHeight = NEEDS_INPUT_ANSWER_MAX_HEIGHT_PX,
) {
  if (!textarea) return;
  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

export function NeedsInputAnswerField({
  sessionId,
  notification,
  question,
  questionCount,
  value,
  onChange,
  placeholder,
  sourceContext,
  threadKey,
  threadTitle,
  className = "",
  textareaClassName = "",
  onClickStopsPropagation = true,
}: {
  sessionId: string;
  notification: SessionNotification;
  question: NeedsInputQuestionView;
  questionCount: number;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  sourceContext?: string | null;
  threadKey?: string;
  threadTitle?: string;
  className?: string;
  textareaClassName?: string;
  onClickStopsPropagation?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  const selectionRef = useRef<TextSelectionRange | null>(null);
  const focusedContext = buildNeedsInputVoiceFocusedContext({
    notification,
    question,
    questionCount,
    sourceContext,
  });

  valueRef.current = value;

  const {
    isRecording,
    isPreparing,
    isSupported: voiceSupported,
    unsupportedMessage,
    isTranscribing,
    transcriptionPhase,
    error,
    setIsTranscribing,
    setTranscriptionPhase,
    setError,
    toggleRecording,
  } = useVoiceInput({
    onAudioReady: (blob) => {
      void transcribeAnswer(blob);
    },
  });

  useLayoutEffect(() => {
    autoResizeNeedsInputAnswerTextarea(textareaRef.current);
  }, [value]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error, setError]);

  const captureSelection = useCallback(() => {
    const textarea = textareaRef.current;
    const currentValue = valueRef.current;
    if (!textarea) {
      selectionRef.current = { value: currentValue, start: currentValue.length, end: currentValue.length };
      return;
    }
    selectionRef.current = {
      value: currentValue,
      start: textarea.selectionStart ?? currentValue.length,
      end: textarea.selectionEnd ?? textarea.selectionStart ?? currentValue.length,
    };
  }, []);

  async function transcribeAnswer(blob: Blob) {
    setIsTranscribing(true);
    setTranscriptionPhase("preparing");
    setError(null);
    try {
      const { text } = await api.transcribe(blob, {
        mode: "dictation",
        sessionId,
        threadKey,
        threadTitle,
        focusedContext,
        onPhase: (phase: VoiceTranscriptionPhase) => setTranscriptionPhase(phase),
      });
      onChange(insertTextAtSelection(valueRef.current, text, selectionRef.current));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Transcription failed");
    } finally {
      setIsTranscribing(false);
      setTranscriptionPhase(null);
    }
  }

  const handleVoiceClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (onClickStopsPropagation) event.stopPropagation();
      if (isTranscribing || isPreparing) return;
      if (!voiceSupported) {
        setError(unsupportedMessage ?? "Voice input is unavailable.");
        return;
      }
      if (!isRecording) {
        captureSelection();
      }
      toggleRecording();
    },
    [
      captureSelection,
      isPreparing,
      isRecording,
      isTranscribing,
      onClickStopsPropagation,
      setError,
      toggleRecording,
      unsupportedMessage,
      voiceSupported,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      if (onClickStopsPropagation) event.stopPropagation();
    },
    [onClickStopsPropagation],
  );

  const phaseLabel =
    isPreparing || transcriptionPhase === "preparing"
      ? "Preparing transcript..."
      : transcriptionPhase === "transcribing"
        ? "Transcribing..."
        : transcriptionPhase === "enhancing"
          ? "Enhancing transcript..."
          : isTranscribing
            ? "Transcribing..."
            : isRecording
              ? "Recording..."
              : null;
  const voiceButtonTitle = isRecording
    ? "Stop voice answer"
    : voiceSupported
      ? "Voice answer"
      : (unsupportedMessage ?? "Voice input unavailable");

  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex min-w-0 items-end gap-1">
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          spellCheck={false}
          onClick={handleTextareaClick}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            autoResizeNeedsInputAnswerTextarea(event.currentTarget);
          }}
          aria-label={`Answer for ${question.prompt}`}
          className={`min-h-[30px] min-w-0 flex-1 resize-none overflow-y-hidden rounded border bg-cc-bg/70 outline-none transition-colors placeholder:text-cc-muted/50 focus:border-cc-attention ${textareaClassName}`}
          style={{ maxHeight: NEEDS_INPUT_ANSWER_MAX_HEIGHT_PX }}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={handleVoiceClick}
          disabled={isTranscribing || isPreparing}
          aria-label={voiceButtonTitle}
          aria-pressed={isRecording}
          aria-disabled={!voiceSupported || isTranscribing || isPreparing}
          title={voiceButtonTitle}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border transition-colors ${
            isRecording
              ? "border-cc-attention-border bg-cc-attention-bg text-cc-attention"
              : isTranscribing || isPreparing
                ? "cursor-wait border-cc-border/60 text-cc-muted opacity-70"
                : voiceSupported
                  ? "cursor-pointer border-cc-border/60 text-cc-muted hover:border-cc-attention-border hover:bg-cc-attention-bg hover:text-cc-attention"
                  : "cursor-pointer border-cc-border/50 text-cc-muted opacity-55"
          }`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className={`h-3.5 w-3.5 ${isRecording ? "animate-pulse" : ""}`}>
            <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
            <path d="M3.5 7a.5.5 0 0 1 .5.5V8a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0V8a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
          </svg>
        </button>
      </div>
      {(phaseLabel || error) && (
        <div className={`mt-1 text-[10px] leading-snug ${error ? "text-cc-attention" : "text-cc-muted"}`}>
          {error ?? phaseLabel}
        </div>
      )}
    </div>
  );
}
