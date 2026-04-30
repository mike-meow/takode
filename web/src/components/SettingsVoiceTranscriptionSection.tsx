import type { ComponentProps, Dispatch, SetStateAction } from "react";
import { api, type TranscriptionConfig } from "../api.js";
import { CollapsibleSection } from "./CollapsibleSection.js";
import { EnhancementTester } from "./EnhancementTester.js";
import { TranscriptionDebugPanel } from "./TranscriptionDebugPanel.js";

export const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
export const CUSTOM_STT_MODEL_VALUE = "__custom__";
export const BUILT_IN_STT_MODELS = [
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe-2025-12-15",
] as const;

type SectionSearchProps = Pick<ComponentProps<typeof CollapsibleSection>, "hidden" | "searchQuery" | "matchCount">;

interface SettingsVoiceTranscriptionSectionProps {
  loading: boolean;
  sectionSearchProps: SectionSearchProps;
  transcriptionApiKey: string;
  setTranscriptionApiKey: Dispatch<SetStateAction<string>>;
  transcriptionBaseUrl: string;
  setTranscriptionBaseUrl: Dispatch<SetStateAction<string>>;
  transcriptionModel: string;
  setTranscriptionModel: Dispatch<SetStateAction<string>>;
  sttModel: string;
  setSttModel: Dispatch<SetStateAction<string>>;
  customSttModel: string;
  setCustomSttModel: Dispatch<SetStateAction<string>>;
  transcriptionEnhancement: boolean;
  setTranscriptionEnhancement: Dispatch<SetStateAction<boolean>>;
  enhancementMode: "default" | "bullet";
  setEnhancementMode: Dispatch<SetStateAction<"default" | "bullet">>;
  transcriptionVocabulary: string;
  setTranscriptionVocabulary: Dispatch<SetStateAction<string>>;
  transcriptionSaving: boolean;
  setTranscriptionSaving: Dispatch<SetStateAction<boolean>>;
  transcriptionSaved: boolean;
  setTranscriptionSaved: Dispatch<SetStateAction<boolean>>;
  transcriptionError: string;
  setTranscriptionError: Dispatch<SetStateAction<string>>;
}

export function SettingsVoiceTranscriptionSection({
  loading,
  sectionSearchProps,
  transcriptionApiKey,
  setTranscriptionApiKey,
  transcriptionBaseUrl,
  setTranscriptionBaseUrl,
  transcriptionModel,
  setTranscriptionModel,
  sttModel,
  setSttModel,
  customSttModel,
  setCustomSttModel,
  transcriptionEnhancement,
  setTranscriptionEnhancement,
  enhancementMode,
  setEnhancementMode,
  transcriptionVocabulary,
  setTranscriptionVocabulary,
  transcriptionSaving,
  setTranscriptionSaving,
  transcriptionSaved,
  setTranscriptionSaved,
  transcriptionError,
  setTranscriptionError,
}: SettingsVoiceTranscriptionSectionProps) {
  async function saveTranscriptionSettings() {
    setTranscriptionError("");
    setTranscriptionSaved(false);
    const resolvedSttModel = sttModel === CUSTOM_STT_MODEL_VALUE ? customSttModel.trim() : sttModel.trim();
    if (!resolvedSttModel) {
      setTranscriptionError("Custom STT model is required.");
      return;
    }
    setTranscriptionSaving(true);
    try {
      const config: TranscriptionConfig = {
        apiKey: transcriptionApiKey === "***" ? "***" : transcriptionApiKey,
        baseUrl: transcriptionBaseUrl,
        enhancementEnabled: transcriptionEnhancement,
        enhancementModel: transcriptionModel,
        customVocabulary: transcriptionVocabulary,
        enhancementMode,
        sttModel: resolvedSttModel,
      };
      await api.updateSettings({ transcriptionConfig: config });
      if (sttModel === CUSTOM_STT_MODEL_VALUE) setCustomSttModel(resolvedSttModel);
      setTranscriptionSaved(true);
      setTimeout(() => setTranscriptionSaved(false), 3000);
    } catch (err: unknown) {
      setTranscriptionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTranscriptionSaving(false);
    }
  }

  return (
    <CollapsibleSection
      id="voice-transcription"
      title="Voice Transcription"
      description="Configure the OpenAI-compatible Whisper API for voice-to-text input. Optionally enable LLM enhancement to clean up transcribed text before sending."
      {...sectionSearchProps}
    >
      <div className="space-y-3 pl-3 border-l-2 border-cc-border">
        <div>
          <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="transcription-api-key">
            API Key
          </label>
          <input
            id="transcription-api-key"
            type="password"
            value={transcriptionApiKey}
            onChange={(e) => setTranscriptionApiKey(e.target.value)}
            onFocus={() => {
              if (transcriptionApiKey === "***") setTranscriptionApiKey("");
            }}
            placeholder="sk-..."
            className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="transcription-base-url">
            Base URL
          </label>
          <input
            id="transcription-base-url"
            type="text"
            value={transcriptionBaseUrl}
            onChange={(e) => setTranscriptionBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 font-mono"
          />
          <p className="mt-1 text-xs text-cc-muted">
            Leave empty for OpenAI. Use a custom URL for Groq, local Whisper, etc.
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="stt-model">
            STT Model
          </label>
          <select
            id="stt-model"
            value={sttModel}
            onChange={(e) => setSttModel(e.target.value)}
            className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 font-mono"
          >
            {BUILT_IN_STT_MODELS.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            <option value={CUSTOM_STT_MODEL_VALUE}>Custom Model</option>
          </select>
        </div>
        {sttModel === CUSTOM_STT_MODEL_VALUE && (
          <div>
            <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="custom-stt-model">
              Custom STT Model
            </label>
            <input
              id="custom-stt-model"
              type="text"
              value={customSttModel}
              onChange={(e) => setCustomSttModel(e.target.value)}
              placeholder="whisper-large-v3"
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 font-mono"
            />
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="transcription-model">
            Enhancement Model
          </label>
          <input
            id="transcription-model"
            type="text"
            value={transcriptionModel}
            onChange={(e) => setTranscriptionModel(e.target.value)}
            placeholder="gpt-5-mini"
            className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 font-mono"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-cc-fg cursor-pointer">
          <input
            type="checkbox"
            checked={transcriptionEnhancement}
            onChange={(e) => setTranscriptionEnhancement(e.target.checked)}
            className="accent-cc-primary"
          />
          Enable Enhancement
        </label>
        {transcriptionEnhancement && (
          <div>
            <label className="block text-xs font-medium text-cc-muted mb-1.5">Enhancement Style</label>
            <select
              value={enhancementMode}
              onChange={(e) => setEnhancementMode(e.target.value as "default" | "bullet")}
              className="w-full bg-cc-input-bg text-cc-fg border border-cc-border rounded-lg px-3 py-2 text-xs"
            >
              <option value="default">Prose</option>
              <option value="bullet">Bullet Points</option>
            </select>
            <p className="mt-1 text-xs text-cc-muted">
              Prose outputs clean paragraphs. Bullet Points structures dictation as organized lists.
            </p>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-cc-muted mb-1.5" htmlFor="transcription-vocabulary">
            Custom Vocabulary
          </label>
          <input
            id="transcription-vocabulary"
            type="text"
            value={transcriptionVocabulary}
            onChange={(e) => setTranscriptionVocabulary(e.target.value)}
            placeholder="Takode, LiteLLM, worktree, mai-agents"
            className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60 font-mono"
          />
          <p className="mt-1 text-xs text-cc-muted">
            Comma-separated terms the STT model frequently mishears. Injected as vocabulary hints.
          </p>
        </div>
      </div>

      {transcriptionError && (
        <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
          {transcriptionError}
        </div>
      )}
      {transcriptionSaved && (
        <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
          Voice transcription settings saved.
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          disabled={transcriptionSaving || loading}
          onClick={saveTranscriptionSettings}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            transcriptionSaving || loading
              ? "bg-cc-hover text-cc-muted cursor-not-allowed"
              : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
          }`}
        >
          {transcriptionSaving ? "Saving..." : "Save"}
        </button>
      </div>

      <TranscriptionDebugPanel />
      <EnhancementTester />
    </CollapsibleSection>
  );
}
