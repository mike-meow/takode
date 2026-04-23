import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import {
  CODEX_REASONING_EFFORTS,
  resolveClaudeCliMode,
  deriveUiMode,
  resolveCodexCliMode,
  deriveCodexUiMode,
  deriveCodexAskPermission,
  formatModel,
  getModelsForBackend,
  toModelOptions,
  type ModelOption,
} from "../utils/backends.js";
import { isTouchDevice } from "../utils/mobile.js";
import { ComposerMenus } from "./ComposerMenus.js";
import { ComposerMetaToolbar } from "./ComposerMetaToolbar.js";
import { CollapseAllButton } from "./ComposerCollapseAllButton.js";
import { CollapsedComposerBar, ComposerInputSurface } from "./ComposerSurface.js";
import { ComposerStatusBlocks } from "./ComposerStatusBlocks.js";
import {
  ensureSupportedFormat,
  getImageFiles,
  getPastedImageFiles,
  hasDraggedImageFiles,
  nextPendingUploadId,
  readFileAsBase64,
  type ImageAttachment,
} from "./composer-image-utils.js";
import {
  DOLLAR_QUERY_PATTERN,
  REFERENCE_MENU_LIMIT,
  buildQuestLinkInsertText,
  buildSessionLinkInsertText,
  computeRecentReferenceBoosts,
  detectReferenceTrigger,
  getSessionSuggestionPreview,
  parseCodexModeSlashCommand,
  toAppMentionInsertText,
  toSkillMentionInsertText,
  type CommandItem,
  type ReferenceSuggestion,
  type ReferenceTriggerMatch,
} from "./composer-reference-utils.js";
import type { FailedTranscription, VoiceEditProposal } from "./composer-voice-types.js";
import { useVoiceInput } from "../hooks/useVoiceInput.js";
import { api } from "../api.js";
import { CODEX_LOCAL_SLASH_COMMANDS } from "../../shared/codex-slash-commands.js";
import {
  buildVsCodeSelectionPrompt,
  formatVsCodeSelectionAttachmentLabel,
  formatVsCodeSelectionSummary,
  getVsCodeSelectionDismissKey,
  getVsCodeSelectionSessionRoot,
  resolveVsCodeSelectionForSession,
  type VsCodeSelectionContextPayload,
} from "../utils/vscode-context.js";
import { isNarrowComposerLayout } from "../utils/layout.js";
import { injectReplyContext } from "../utils/reply-context.js";
import type {
  ChatMessage,
  CodexAppReference,
  CodexSkillReference,
  PendingUserUpload,
  QuestmasterTask,
  SdkSessionInfo,
} from "../types.js";
import {
  clearPendingUserUploadController,
  registerPendingUserUploadController,
} from "../pending-user-upload-manager.js";

export { ReplyChip } from "./ReplyChip.js";

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_SKILL_REFERENCES: CodexSkillReference[] = [];
const EMPTY_APP_REFERENCES: CodexAppReference[] = [];
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
const EMPTY_PENDING_USER_UPLOADS: PendingUserUpload[] = [];
const EMPTY_QUESTS: QuestmasterTask[] = [];
const EMPTY_SDK_SESSIONS: SdkSessionInfo[] = [];
const EMPTY_SESSION_NAMES = new Map<string, string>();

export function Composer({ sessionId }: { sessionId: string }) {
  const draft = useStore((s) => s.composerDrafts.get(sessionId));
  const pendingUserUploads = useStore((s) => s.pendingUserUploads.get(sessionId)) ?? EMPTY_PENDING_USER_UPLOADS;
  const replyContext = useStore((s) => s.replyContexts.get(sessionId));
  const text = draft?.text ?? "";
  const images = draft?.images ?? [];
  const setText = useCallback(
    (t: string | ((prev: string) => string)) => {
      const store = useStore.getState();
      const current = store.composerDrafts.get(sessionId);
      const prevText = current?.text ?? "";
      const newText = typeof t === "function" ? t(prevText) : t;
      store.setComposerDraft(sessionId, { text: newText, images: current?.images ?? [] });
    },
    [sessionId],
  );
  const setImages = useCallback(
    (updater: ImageAttachment[] | ((prev: ImageAttachment[]) => ImageAttachment[])) => {
      const store = useStore.getState();
      const current = store.composerDrafts.get(sessionId);
      const prevImages = current?.images ?? [];
      const newImages = typeof updater === "function" ? updater(prevImages) : updater;
      store.setComposerDraft(sessionId, { text: current?.text ?? "", images: newImages });
    },
    [sessionId],
  );
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [dollarMenuOpen, setDollarMenuOpen] = useState(false);
  const [dollarMenuIndex, setDollarMenuIndex] = useState(0);
  const [dollarQuery, setDollarQuery] = useState("");
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  const [referenceMenuIndex, setReferenceMenuIndex] = useState(0);
  const [referenceQuery, setReferenceQuery] = useState("");
  const [referenceKind, setReferenceKind] = useState<"quest" | "session" | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showCodexReasoningDropdown, setShowCodexReasoningDropdown] = useState(false);
  const [showAskConfirm, setShowAskConfirm] = useState(false);
  const [dynamicCodexModels, setDynamicCodexModels] = useState<ModelOption[] | null>(null);
  const [dynamicClaudeModels, setDynamicClaudeModels] = useState<ModelOption[] | null>(null);
  const [sendPressing, setSendPressing] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [isImageDragOver, setIsImageDragOver] = useState(false);
  const [voiceEditProposal, setVoiceEditProposal] = useState<VoiceEditProposal | null>(null);
  const zoomLevel = useStore((s) => s.zoomLevel);

  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionResults, setMentionResults] = useState<
    Array<{ relativePath: string; absolutePath: string; fileName: string }>
  >([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const mentionAnchorRef = useRef<number>(-1);
  const mentionAbortRef = useRef<AbortController | null>(null);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageDragDepthRef = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const dollarMenuRef = useRef<HTMLDivElement>(null);
  const referenceMenuRef = useRef<HTMLDivElement>(null);
  const dollarAnchorRef = useRef<number>(-1);
  const referenceAnchorRef = useRef<number>(-1);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const codexReasoningDropdownRef = useRef<HTMLDivElement>(null);
  const askConfirmRef = useRef<HTMLDivElement>(null);
  const requestedCodexSkillRefreshSessionRef = useRef<string | null>(null);
  const voiceCaptureModeRef = useRef<"dictation" | "edit" | "append">("dictation");
  const voiceEditBaseTextRef = useRef("");
  const preferredVoiceModeRef = useRef<"edit" | "append">("edit");
  const persistedSettingsRef = useRef<Awaited<ReturnType<typeof api.getSettings>> | null>(null);
  const persistedSettingsLoadedRef = useRef(false);
  const persistedSettingsRequestRef = useRef<Promise<Awaited<ReturnType<typeof api.getSettings>> | null> | null>(null);
  const voiceStartPendingRef = useRef(false);
  const voiceStartPendingReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [voiceCaptureMode, setVoiceCaptureMode] = useState<"dictation" | "edit" | "append">("dictation");
  const [failedTranscription, setFailedTranscription] = useState<FailedTranscription | null>(null);
  const preRecordingTextRef = useRef({ before: "", after: "" });
  const {
    isRecording,
    isPreparing,
    isSupported: voiceSupported,
    unsupportedReason: voiceUnsupportedReason,
    unsupportedMessage: voiceUnsupportedMessage,
    isTranscribing,
    transcriptionPhase,
    error: voiceError,
    volumeLevel,
    setIsTranscribing,
    setTranscriptionPhase,
    setError: setVoiceError,
    toggleRecording,
    cancelRecording,
    warmMicrophone,
  } = useVoiceInput({
    onAudioReady: (blob) => {
      performTranscription(blob, voiceCaptureModeRef.current, voiceEditBaseTextRef.current, {
        ...preRecordingTextRef.current,
      });
    },
  });
  const [voiceUnsupportedInfoOpen, setVoiceUnsupportedInfoOpen] = useState(false);
  const isRecordingRef = useRef(isRecording);
  const isPreparingRef = useRef(isPreparing);

  const clearPendingVoiceStart = useCallback(() => {
    if (voiceStartPendingReleaseTimerRef.current) {
      clearTimeout(voiceStartPendingReleaseTimerRef.current);
      voiceStartPendingReleaseTimerRef.current = null;
    }
    voiceStartPendingRef.current = false;
  }, []);

  const deferPendingVoiceStartRelease = useCallback(() => {
    if (voiceStartPendingReleaseTimerRef.current) {
      clearTimeout(voiceStartPendingReleaseTimerRef.current);
    }
    voiceStartPendingReleaseTimerRef.current = setTimeout(() => {
      voiceStartPendingReleaseTimerRef.current = null;
      voiceStartPendingRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    isRecordingRef.current = isRecording;
    isPreparingRef.current = isPreparing;
    if (isRecording || isPreparing) {
      clearPendingVoiceStart();
    }
  }, [clearPendingVoiceStart, isPreparing, isRecording]);

  useEffect(() => clearPendingVoiceStart, [clearPendingVoiceStart]);

  const applyPersistedVoicePreference = useCallback((settings: Awaited<ReturnType<typeof api.getSettings>> | null) => {
    persistedSettingsRef.current = settings;
    persistedSettingsLoadedRef.current = true;
    const savedVoiceMode = settings?.transcriptionConfig?.voiceCaptureMode;
    preferredVoiceModeRef.current = savedVoiceMode === "edit" || savedVoiceMode === "append" ? savedVoiceMode : "edit";
    return settings;
  }, []);

  const loadPersistedSettings = useCallback(() => {
    if (persistedSettingsLoadedRef.current) {
      return Promise.resolve(persistedSettingsRef.current);
    }
    if (persistedSettingsRequestRef.current) {
      return persistedSettingsRequestRef.current;
    }
    const request = api
      .getSettings()
      .catch(() => null)
      .then((settings) => applyPersistedVoicePreference(settings))
      .finally(() => {
        persistedSettingsRequestRef.current = null;
      });
    persistedSettingsRequestRef.current = request;
    return request;
  }, [applyPersistedVoicePreference]);

  const persistPreferredVoiceMode = useCallback((mode: "edit" | "append") => {
    preferredVoiceModeRef.current = mode;
    if (persistedSettingsRef.current) {
      persistedSettingsRef.current = {
        ...persistedSettingsRef.current,
        transcriptionConfig: {
          ...persistedSettingsRef.current.transcriptionConfig,
          voiceCaptureMode: mode,
        },
      };
    }
    api.updateSettings({ transcriptionConfig: { voiceCaptureMode: mode } }).catch(() => {});
  }, []);

  const handleMicClick = useCallback(async () => {
    if (!voiceSupported) {
      setVoiceError(voiceUnsupportedMessage ?? "Voice input is unavailable.");
      return;
    }
    if (isRecordingRef.current) {
      clearPendingVoiceStart();
      toggleRecording();
      return;
    }
    if (isPreparingRef.current || voiceStartPendingRef.current) {
      return;
    }

    voiceStartPendingRef.current = true;
    try {
      setFailedTranscription(null);
      const el = textareaRef.current;
      const cursorPos = el?.selectionStart ?? text.length;
      preRecordingTextRef.current = {
        before: text.slice(0, cursorPos),
        after: text.slice(cursorPos),
      };
      if (text.trim().length > 0) {
        if (!persistedSettingsLoadedRef.current) {
          await loadPersistedSettings();
        }
        if (isRecordingRef.current || isPreparingRef.current) {
          clearPendingVoiceStart();
          return;
        }
        const mode = preferredVoiceModeRef.current;
        voiceCaptureModeRef.current = mode;
        setVoiceCaptureMode(mode);
        voiceEditBaseTextRef.current = text;
        setVoiceEditProposal(null);
      } else {
        voiceCaptureModeRef.current = "dictation";
        setVoiceCaptureMode("dictation");
      }
      toggleRecording();
      deferPendingVoiceStartRelease();
    } catch (error) {
      clearPendingVoiceStart();
      throw error;
    }
  }, [
    clearPendingVoiceStart,
    deferPendingVoiceStartRelease,
    loadPersistedSettings,
    setVoiceError,
    text,
    toggleRecording,
    voiceSupported,
    voiceUnsupportedMessage,
  ]);

  /** Transcribe an audio blob and apply the result based on mode. Used by both initial recording and retry. */
  async function performTranscription(
    blob: Blob,
    mode: "dictation" | "edit" | "append",
    composerText: string,
    cursorContext: { before: string; after: string },
  ) {
    setIsTranscribing(true);
    setTranscriptionPhase("uploading");
    try {
      if (mode === "edit") {
        const {
          text: editedText,
          instructionText,
          rawText,
        } = await api.transcribe(blob, {
          mode: "edit",
          sessionId,
          composerText,
          onPhase: (phase) => setTranscriptionPhase(phase),
        });
        setVoiceEditProposal({
          originalText: composerText,
          editedText,
          instructionText: instructionText || rawText || "",
        });
      } else if (mode === "append") {
        const { text: appendText } = await api.transcribe(blob, {
          mode: "append",
          sessionId,
          composerText,
          onPhase: (phase) => setTranscriptionPhase(phase),
        });
        const { before, after } = cursorContext;
        const needsSpace = before.length > 0 && !/\s$/.test(before);
        const separator = needsSpace ? " " : "";
        setText(before + separator + appendText + after);
        setVoiceEditProposal(null);
      } else {
        const { text: transcript } = await api.transcribe(blob, {
          mode: "dictation",
          sessionId,
          onPhase: (phase) => setTranscriptionPhase(phase),
        });
        setText(transcript);
        setVoiceEditProposal(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Transcription failed";
      setVoiceError(message);
      setFailedTranscription({ blob, mode, composerText, cursorContext });
    } finally {
      setIsTranscribing(false);
      setTranscriptionPhase(null);
    }
  }

  const retryTranscription = useCallback(async () => {
    if (!failedTranscription) return;
    const { blob, mode, composerText, cursorContext } = failedTranscription;
    setFailedTranscription(null);
    setVoiceError(null);
    await performTranscription(blob, mode, composerText, cursorContext);
  }, [failedTranscription, sessionId, setVoiceError]);

  const toggleVoiceUnsupportedInfo = useCallback(
    (expandComposerOnReveal = false) => {
      if (!voiceUnsupportedMessage) return;
      if (expandComposerOnReveal) setComposerExpanded(true);
      setVoiceUnsupportedInfoOpen((open) => !open);
    },
    [voiceUnsupportedMessage],
  );

  const [isNarrowLayout, setIsNarrowLayout] = useState(() => isNarrowComposerLayout(zoomLevel));
  const usesTouchKeyboard = isTouchDevice();
  useEffect(() => {
    const updateLayout = () => setIsNarrowLayout(isNarrowComposerLayout(zoomLevel));
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, [zoomLevel]);

  const focusTrigger = useStore((s) => s.focusComposerTrigger);
  useEffect(() => {
    if (focusTrigger > 0) {
      textareaRef.current?.focus();
    }
  }, [focusTrigger]);

  const isUserInput = useRef(false);

  useEffect(() => {
    if (isUserInput.current) {
      isUserInput.current = false;
      return;
    }
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [text]);

  useEffect(() => {
    setVoiceEditProposal(null);
    setFailedTranscription(null);
    setVoiceError(null);
    voiceCaptureModeRef.current = "dictation";
    setVoiceCaptureMode("dictation");
    voiceEditBaseTextRef.current = "";
  }, [sessionId, setVoiceError]);

  useEffect(() => {
    if (!voiceError || failedTranscription) return;
    const timer = setTimeout(() => setVoiceError(null), 4000);
    return () => clearTimeout(timer);
  }, [voiceError, failedTranscription, setVoiceError]);

  const sessionView = useStore(
    useShallow((s) => {
      const sessionData = s.sessions.get(sessionId);
      return {
        isConnected: s.cliConnected.get(sessionId) ?? false,
        explicitAskPermission: s.askPermission.get(sessionId),
        backendType: sessionData?.backend_type,
        permissionMode: sessionData?.permissionMode || "acceptEdits",
        serverUiMode: sessionData?.uiMode,
        codexReasoningEffort: sessionData?.codex_reasoning_effort || "",
        slashCommands: sessionData?.slash_commands ?? EMPTY_STRING_ARRAY,
        skills: sessionData?.skills ?? EMPTY_STRING_ARRAY,
        skillMetadata: sessionData?.skill_metadata ?? EMPTY_SKILL_REFERENCES,
        apps: sessionData?.apps ?? EMPTY_APP_REFERENCES,
        cwd: sessionData?.cwd,
        repoRoot: sessionData?.repo_root,
        gitBranch: sessionData?.git_branch,
        isContainerized: sessionData?.is_containerized === true,
        gitAhead: sessionData?.git_ahead || 0,
        gitBehind: sessionData?.git_behind || 0,
        model: sessionData?.model,
        totalLinesAdded: sessionData?.total_lines_added,
        totalLinesRemoved: sessionData?.total_lines_removed,
      };
    }),
  );
  const sdkDiffTotals = useStore(
    useShallow((s) => {
      const sdkSession = s.sdkSessions?.find((x) => x.sessionId === sessionId);
      return {
        totalLinesAdded: sdkSession?.totalLinesAdded ?? 0,
        totalLinesRemoved: sdkSession?.totalLinesRemoved ?? 0,
      };
    }),
  );
  const vscodeSelectionState = useStore((s) => s.vscodeSelectionContext);
  const quests = useStore((s) =>
    referenceMenuOpen && referenceKind === "quest" ? (s.quests ?? EMPTY_QUESTS) : EMPTY_QUESTS,
  );
  const sessionReferenceData = useStore(
    useShallow((s) => {
      if (!referenceMenuOpen || referenceKind !== "session") {
        return {
          sdkSessions: EMPTY_SDK_SESSIONS,
          sessionNames: EMPTY_SESSION_NAMES,
        };
      }
      return {
        sdkSessions: s.sdkSessions ?? EMPTY_SDK_SESSIONS,
        sessionNames: s.sessionNames,
      };
    }),
  );
  const sessionMessages = useStore((s) =>
    referenceMenuOpen ? (s.messages.get(sessionId) ?? EMPTY_CHAT_MESSAGES) : EMPTY_CHAT_MESSAGES,
  );

  const isConnected = sessionView.isConnected;
  const currentMode = sessionView.permissionMode;
  const isCodex = sessionView.backendType === "codex";
  const askPermission =
    typeof sessionView.explicitAskPermission === "boolean"
      ? sessionView.explicitAskPermission
      : isCodex
        ? deriveCodexAskPermission(currentMode)
        : true;
  const diffLinesAdded = sessionView.totalLinesAdded ?? sdkDiffTotals.totalLinesAdded;
  const diffLinesRemoved = sessionView.totalLinesRemoved ?? sdkDiffTotals.totalLinesRemoved;
  // Prefer the server-provided UI mode when available. permissionMode can be
  // stale during backend transitions (e.g., SDK init/status replay) while uiMode
  // is the authoritative virtual mode for the composer toggle.
  const uiMode = sessionView.serverUiMode ?? (isCodex ? deriveCodexUiMode(currentMode) : deriveUiMode(currentMode));
  const isPlan = uiMode === "plan";
  const codexReasoningEffort = sessionView.codexReasoningEffort;
  const codexModelOptions = dynamicCodexModels || getModelsForBackend("codex");
  // Resolve the "Default" option: replace the empty-value placeholder with
  // the user's actual configured model from ~/.claude/settings.json so we
  // never send an empty string to set_model (which would make the model
  // selector disappear since sessionData.model becomes falsy).
  const claudeModelOptions = useMemo(() => {
    const raw = dynamicClaudeModels || getModelsForBackend("claude");
    return raw.filter((m) => m.value !== "");
  }, [dynamicClaudeModels]);
  const sessionSelectionRoot = getVsCodeSelectionSessionRoot(sessionView.repoRoot, sessionView.cwd);
  const dismissedVsCodeSelectionKey = useStore((s) => s.dismissedVsCodeSelectionKey);
  const currentVsCodeSelectionKey = useMemo(
    () => getVsCodeSelectionDismissKey(vscodeSelectionState),
    [vscodeSelectionState],
  );
  const vscodeSelectionPayload: VsCodeSelectionContextPayload | null =
    vscodeSelectionState?.selection && currentVsCodeSelectionKey !== dismissedVsCodeSelectionKey
      ? resolveVsCodeSelectionForSession(vscodeSelectionState.selection, sessionSelectionRoot)
      : null;
  const sdkSessions = sessionReferenceData.sdkSessions;
  const sessionNames = sessionReferenceData.sessionNames;
  const recentReferenceBoosts = useMemo(() => computeRecentReferenceBoosts(sessionMessages), [sessionMessages]);

  useEffect(() => {
    if (!isCodex) return;
    let cancelled = false;
    void loadPersistedSettings();
    api
      .getBackendModels("codex")
      .then((models) => {
        if (cancelled || models.length === 0) return;
        setDynamicCodexModels(toModelOptions(models));
      })
      .catch(() => {
        // Fall back to static model list silently.
      });
    return () => {
      cancelled = true;
    };
  }, [isCodex, loadPersistedSettings]);

  useEffect(() => {
    if (isCodex) return;
    let cancelled = false;
    // Fetch dynamic models and the user's configured default in parallel
    Promise.all([
      api.getBackendModels("claude").catch(() => [] as { value: string; label: string; description: string }[]),
      loadPersistedSettings(),
    ]).then(([models, settings]) => {
      if (cancelled) return;
      const options = models.length > 0 ? toModelOptions(models) : [];
      // If the user has a default model configured in ~/.claude/settings.json,
      // prepend a "Default (model)" option that sends the actual model ID
      // instead of an empty string (which would hide the model selector).
      const defaultModel = settings?.claudeDefaultModel;
      if (defaultModel) {
        const defaultOption: ModelOption = {
          value: defaultModel,
          label: `Default (${defaultModel})`,
          icon: "\u25C6",
        };
        // Use dynamic models if available, otherwise fall back to static list
        // (filtered to remove the empty-value "Default" placeholder).
        const baseOptions = options.length > 0 ? options : getModelsForBackend("claude").filter((m) => m.value !== "");
        setDynamicClaudeModels([defaultOption, ...baseOptions]);
      } else if (options.length > 0) {
        setDynamicClaudeModels(options);
      }
      // If neither dynamic models nor default model are available,
      // dynamicClaudeModels stays null and the static fallback is used.
    });
    return () => {
      cancelled = true;
    };
  }, [isCodex, loadPersistedSettings]);

  // Build slash-command menu items from session data
  const allCommands = useMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [];
    const seen = new Set<string>();
    const pushCommand = (name: string, type: "command" | "skill") => {
      const normalized = name.trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      cmds.push({
        name: normalized,
        type,
        trigger: "/",
        insertText: `/${normalized}`,
      });
    };
    if (isCodex) {
      for (const cmd of CODEX_LOCAL_SLASH_COMMANDS) {
        pushCommand(cmd, "command");
      }
    }
    for (const cmd of sessionView.slashCommands) {
      pushCommand(cmd, "command");
    }
    for (const skill of sessionView.skills) {
      pushCommand(skill, "skill");
    }
    return cmds;
  }, [isCodex, sessionView.skills, sessionView.slashCommands]);

  const dollarCommands = useMemo<CommandItem[]>(() => {
    if (!isCodex) return [];
    const cmds: CommandItem[] = [];
    const seen = new Set<string>();
    const skillMetadataByName = new Map<string, CodexSkillReference>();
    for (const skill of sessionView.skillMetadata) {
      const name = skill.name.trim();
      if (name && !skillMetadataByName.has(name)) skillMetadataByName.set(name, skill);
    }

    const pushSkill = (name: string, skill?: CodexSkillReference) => {
      const normalized = name.trim();
      if (!normalized || seen.has(`skill:${normalized}`)) return;
      seen.add(`skill:${normalized}`);
      cmds.push({
        name: normalized,
        type: "skill",
        trigger: "$",
        insertText: toSkillMentionInsertText(
          skill ?? {
            name: normalized,
            path: "",
          },
        ),
        ...(skill?.description ? { description: skill.description } : {}),
      });
    };

    const pushApp = (app: CodexAppReference) => {
      const id = app.id.trim();
      const name = app.name.trim();
      if (!id || !name || seen.has(`app:${id}`)) return;
      seen.add(`app:${id}`);
      cmds.push({
        name,
        type: "app",
        trigger: "$",
        insertText: toAppMentionInsertText(app),
        ...(app.description ? { description: app.description } : {}),
      });
    };

    for (const skill of sessionView.skills) {
      pushSkill(skill, skillMetadataByName.get(skill.trim()));
    }
    for (const skill of skillMetadataByName.values()) {
      pushSkill(skill.name, skill);
    }
    for (const app of sessionView.apps) {
      pushApp(app);
    }
    return cmds;
  }, [isCodex, sessionView.apps, sessionView.skillMetadata, sessionView.skills]);

  useEffect(() => {
    if (!isCodex || !isConnected) return;
    if (sessionView.skillMetadata.length > 0 || sessionView.apps.length > 0) return;
    if (requestedCodexSkillRefreshSessionRef.current === sessionId) return;
    requestedCodexSkillRefreshSessionRef.current = sessionId;
    api.refreshSessionSkills(sessionId).catch(() => {});
  }, [isCodex, isConnected, sessionId, sessionView.apps, sessionView.skillMetadata]);

  // Filter commands based on what the user typed after /
  const filteredCommands = useMemo(() => {
    if (!slashMenuOpen) return [];
    // Extract the slash query: text starts with / and we match the part after /
    const match = text.match(/^\/(\S*)$/);
    if (!match) return [];
    const query = match[1].toLowerCase();
    if (query === "") return allCommands;
    return allCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
  }, [text, slashMenuOpen, allCommands]);

  // Open/close menu based on text
  useEffect(() => {
    const shouldOpen = text.startsWith("/") && /^\/\S*$/.test(text) && allCommands.length > 0;
    if (shouldOpen && !slashMenuOpen) {
      setSlashMenuOpen(true);
      setSlashMenuIndex(0);
    } else if (!shouldOpen && slashMenuOpen) {
      setSlashMenuOpen(false);
    }
  }, [text, allCommands.length, slashMenuOpen]);

  // Keep selected index in bounds
  useEffect(() => {
    if (slashMenuIndex >= filteredCommands.length) {
      setSlashMenuIndex(Math.max(0, filteredCommands.length - 1));
    }
  }, [filteredCommands.length, slashMenuIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!menuRef.current || !slashMenuOpen) return;
    const items = menuRef.current.querySelectorAll("[data-cmd-index]");
    const selected = items[slashMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [slashMenuIndex, slashMenuOpen]);

  const filteredDollarCommands = useMemo(() => {
    if (!dollarMenuOpen) return [];
    const query = dollarQuery.toLowerCase();
    if (query === "") return dollarCommands;
    return dollarCommands.filter((cmd) => cmd.name.toLowerCase().includes(query));
  }, [dollarCommands, dollarMenuOpen, dollarQuery]);

  const detectDollarQuery = useCallback(
    (inputText: string, cursorPos: number) => {
      if (!isCodex || dollarCommands.length === 0) {
        setDollarMenuOpen(false);
        setDollarQuery("");
        dollarAnchorRef.current = -1;
        return;
      }

      let dollarPos = -1;
      for (let i = cursorPos - 1; i >= 0; i--) {
        const ch = inputText[i];
        if (ch === " " || ch === "\n" || ch === "\t") break;
        if (ch === "$") {
          if (i === 0 || /[\s({]/.test(inputText[i - 1])) {
            dollarPos = i;
          }
          break;
        }
      }

      const query = dollarPos === -1 ? "" : inputText.slice(dollarPos + 1, cursorPos);
      const shouldOpen = dollarPos !== -1 && (query === "" || DOLLAR_QUERY_PATTERN.test(query));
      if (!shouldOpen) {
        setDollarMenuOpen(false);
        dollarAnchorRef.current = -1;
        setDollarQuery("");
        return;
      }

      dollarAnchorRef.current = dollarPos;
      setDollarMenuIndex(0);
      setDollarQuery(query);
      setDollarMenuOpen(true);
    },
    [dollarCommands.length, isCodex],
  );

  useEffect(() => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    detectDollarQuery(text, cursorPos);
  }, [detectDollarQuery, text]);

  useEffect(() => {
    if (dollarMenuIndex >= filteredDollarCommands.length) {
      setDollarMenuIndex(Math.max(0, filteredDollarCommands.length - 1));
    }
  }, [dollarMenuIndex, filteredDollarCommands.length]);

  useEffect(() => {
    if (!dollarMenuRef.current || !dollarMenuOpen) return;
    const items = dollarMenuRef.current.querySelectorAll("[data-dollar-index]");
    const selected = items[dollarMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [dollarMenuIndex, dollarMenuOpen]);

  useEffect(() => {
    if (!dollarMenuOpen) return;
    function handlePointerDown(e: PointerEvent) {
      if (dollarMenuRef.current && !dollarMenuRef.current.contains(e.target as Node)) {
        setDollarMenuOpen(false);
        setDollarQuery("");
        dollarAnchorRef.current = -1;
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [dollarMenuOpen]);

  const filteredReferenceSuggestions = useMemo<ReferenceSuggestion[]>(() => {
    if (!referenceMenuOpen || referenceKind == null) return [];

    if (referenceKind === "quest") {
      const fullQuery = `q-${referenceQuery}`.toLowerCase();
      return quests
        .filter((quest) => referenceQuery === "" || quest.questId.toLowerCase().startsWith(fullQuery))
        .map((quest) => ({
          key: quest.questId,
          kind: "quest" as const,
          rawRef: quest.questId,
          preview: quest.title,
          insertText: buildQuestLinkInsertText(quest.questId),
          searchText: `${quest.questId} ${quest.title}`.toLowerCase(),
          recentBoost: recentReferenceBoosts.questBoosts.get(quest.questId.toLowerCase()) ?? 0,
          tieBreaker: Number.parseInt(quest.questId.replace(/^q-/, ""), 10) || 0,
        }))
        .sort((left, right) => {
          const leftExact = Number(left.rawRef.toLowerCase() === fullQuery);
          const rightExact = Number(right.rawRef.toLowerCase() === fullQuery);
          if (leftExact !== rightExact) return rightExact - leftExact;
          if (left.recentBoost !== right.recentBoost) return right.recentBoost - left.recentBoost;
          return right.tieBreaker - left.tieBreaker;
        })
        .slice(0, REFERENCE_MENU_LIMIT);
    }

    const seenSessionNums = new Set<number>();
    const normalizedQuery = referenceQuery.toLowerCase();
    return sdkSessions
      .filter((session) => session.sessionNum != null)
      .filter((session) => {
        const sessionNum = session.sessionNum!;
        if (seenSessionNums.has(sessionNum)) return false;
        seenSessionNums.add(sessionNum);
        return true;
      })
      .map((session) => {
        const sessionNum = session.sessionNum!;
        const rawRef = `#${sessionNum}`;
        const preview = getSessionSuggestionPreview(session, sessionNames.get(session.sessionId));
        return {
          key: session.sessionId,
          kind: "session" as const,
          rawRef,
          preview,
          insertText: buildSessionLinkInsertText(sessionNum),
          searchText: `${rawRef} ${preview}`.toLowerCase(),
          recentBoost: recentReferenceBoosts.sessionBoosts.get(sessionNum) ?? 0,
          tieBreaker: session.lastActivityAt ?? session.createdAt ?? sessionNum,
        };
      })
      .filter((session) => normalizedQuery === "" || session.rawRef.slice(1).startsWith(normalizedQuery))
      .sort((left, right) => {
        const leftExact = Number(left.rawRef.slice(1).toLowerCase() === normalizedQuery);
        const rightExact = Number(right.rawRef.slice(1).toLowerCase() === normalizedQuery);
        if (leftExact !== rightExact) return rightExact - leftExact;
        if (left.recentBoost !== right.recentBoost) return right.recentBoost - left.recentBoost;
        return right.tieBreaker - left.tieBreaker;
      })
      .slice(0, REFERENCE_MENU_LIMIT);
  }, [quests, recentReferenceBoosts, referenceKind, referenceMenuOpen, referenceQuery, sdkSessions, sessionNames]);

  const detectReferenceQuery = useCallback((inputText: string, cursorPos: number) => {
    const match = detectReferenceTrigger(inputText, cursorPos);
    if (!match) {
      setReferenceMenuOpen(false);
      setReferenceKind(null);
      setReferenceQuery("");
      referenceAnchorRef.current = -1;
      return;
    }

    referenceAnchorRef.current = match.replacementStart;
    setReferenceKind(match.kind);
    setReferenceQuery(match.query);
    setReferenceMenuIndex(0);
    setReferenceMenuOpen(true);
  }, []);

  useEffect(() => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    detectReferenceQuery(text, cursorPos);
  }, [detectReferenceQuery, text]);

  useEffect(() => {
    if (referenceMenuIndex >= filteredReferenceSuggestions.length) {
      setReferenceMenuIndex(Math.max(0, filteredReferenceSuggestions.length - 1));
    }
  }, [filteredReferenceSuggestions.length, referenceMenuIndex]);

  useEffect(() => {
    if (!referenceMenuRef.current || !referenceMenuOpen) return;
    const items = referenceMenuRef.current.querySelectorAll("[data-reference-index]");
    const selected = items[referenceMenuIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [referenceMenuIndex, referenceMenuOpen]);

  useEffect(() => {
    if (!referenceMenuOpen) return;
    function handlePointerDown(e: PointerEvent) {
      if (referenceMenuRef.current && !referenceMenuRef.current.contains(e.target as Node)) {
        setReferenceMenuOpen(false);
        setReferenceKind(null);
        setReferenceQuery("");
        referenceAnchorRef.current = -1;
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [referenceMenuOpen]);

  // ─── @ mention file search ─────────────────────────────────────

  // Derive the search root from session state (repo_root preferred, cwd fallback)
  const mentionSearchRoot = useMemo(() => {
    const cwd = sessionView.cwd;
    const repoRoot = sessionView.repoRoot;
    if (repoRoot && cwd?.startsWith(repoRoot + "/")) return repoRoot;
    return cwd || repoRoot || null;
  }, [sessionView.cwd, sessionView.repoRoot]);

  // Detect `@` at cursor position and extract query for file search.
  // Called from handleInput — scans backward from cursor to find `@`.
  const detectMentionQuery = useCallback(
    (inputText: string, cursorPos: number) => {
      // Scan backward from cursor to find an unescaped `@` that starts a mention
      let atPos = -1;
      for (let i = cursorPos - 1; i >= 0; i--) {
        const ch = inputText[i];
        // Stop at whitespace, newline — the `@` must be at word boundary or start
        if (ch === " " || ch === "\n" || ch === "\t") break;
        if (ch === "@") {
          // Must be at start of text or preceded by whitespace
          if (i === 0 || /\s/.test(inputText[i - 1])) {
            atPos = i;
          }
          break;
        }
      }

      if (atPos === -1) {
        if (mentionMenuOpen) {
          setMentionMenuOpen(false);
          setMentionResults([]);
        }
        return;
      }

      const query = inputText.slice(atPos + 1, cursorPos);
      mentionAnchorRef.current = atPos;
      setMentionQuery(query);

      // Show menu immediately (with hint), but only search after 3+ chars
      if (!mentionMenuOpen) {
        setMentionMenuOpen(true);
        setMentionIndex(0);
      }

      if (query.length < 3) {
        // Cancel any in-flight search
        mentionAbortRef.current?.abort();
        if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
        setMentionResults([]);
        setMentionLoading(false);
        return;
      }

      // Debounced search — 150ms
      if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
      mentionAbortRef.current?.abort();

      setMentionLoading(true);
      mentionDebounceRef.current = setTimeout(async () => {
        if (!mentionSearchRoot) {
          setMentionLoading(false);
          return;
        }
        const controller = new AbortController();
        mentionAbortRef.current = controller;
        try {
          const { results } = await api.searchFiles(mentionSearchRoot, query, controller.signal);
          if (!controller.signal.aborted) {
            setMentionResults(results);
            setMentionIndex(0);
            setMentionLoading(false);
          }
        } catch (e: unknown) {
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (!controller.signal.aborted) {
            setMentionResults([]);
            setMentionLoading(false);
          }
        }
      }, 150);
    },
    [mentionMenuOpen, mentionSearchRoot],
  );

  // Close mention menu on outside click
  useEffect(() => {
    if (!mentionMenuOpen) return;
    function handlePointerDown(e: PointerEvent) {
      if (mentionMenuRef.current && !mentionMenuRef.current.contains(e.target as Node)) {
        setMentionMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [mentionMenuOpen]);

  // Keep mention index in bounds
  useEffect(() => {
    if (mentionIndex >= mentionResults.length) {
      setMentionIndex(Math.max(0, mentionResults.length - 1));
    }
  }, [mentionResults.length, mentionIndex]);

  // Scroll selected mention item into view
  useEffect(() => {
    if (!mentionMenuRef.current || !mentionMenuOpen) return;
    const items = mentionMenuRef.current.querySelectorAll("[data-mention-index]");
    const selected = items[mentionIndex];
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [mentionIndex, mentionMenuOpen]);

  // Clean up debounce/abort on unmount
  useEffect(() => {
    return () => {
      if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
      mentionAbortRef.current?.abort();
    };
  }, []);

  const selectMention = useCallback(
    (result: { relativePath: string }) => {
      const anchor = mentionAnchorRef.current;
      if (anchor === -1) return;
      const cursorPos = textareaRef.current?.selectionStart ?? text.length;
      // Replace @query with @relativePath
      const before = text.slice(0, anchor);
      const after = text.slice(cursorPos);
      const inserted = `@${result.relativePath} `;
      setText(before + inserted + after);
      setMentionMenuOpen(false);
      setMentionResults([]);
      mentionAnchorRef.current = -1;
      // Restore cursor position after the inserted path
      requestAnimationFrame(() => {
        const newPos = anchor + inserted.length;
        textareaRef.current?.setSelectionRange(newPos, newPos);
        textareaRef.current?.focus();
      });
    },
    [text, setText],
  );

  // Close mode dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (codexReasoningDropdownRef.current && !codexReasoningDropdownRef.current.contains(e.target as Node)) {
        setShowCodexReasoningDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, []);

  // Close ask-permission confirm popover on outside click
  useEffect(() => {
    if (!showAskConfirm) return;
    function handlePointerDown(e: PointerEvent) {
      if (askConfirmRef.current && !askConfirmRef.current.contains(e.target as Node)) {
        setShowAskConfirm(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [showAskConfirm]);

  const selectReference = useCallback(
    (suggestion: ReferenceSuggestion) => {
      const anchor = referenceAnchorRef.current;
      if (anchor === -1) return;
      const cursorPos = textareaRef.current?.selectionStart ?? text.length;
      const before = text.slice(0, anchor);
      const after = text.slice(cursorPos);
      const inserted = `${suggestion.insertText} `;
      setText(before + inserted + after);
      setReferenceMenuOpen(false);
      setReferenceKind(null);
      setReferenceQuery("");
      referenceAnchorRef.current = -1;
      requestAnimationFrame(() => {
        const newPos = before.length + inserted.length;
        textareaRef.current?.setSelectionRange(newPos, newPos);
        textareaRef.current?.focus();
      });
    },
    [setText, text],
  );

  const selectCommand = useCallback(
    (cmd: CommandItem) => {
      if (cmd.trigger === "$") {
        const anchor = dollarAnchorRef.current;
        if (anchor === -1) return;
        const cursorPos = textareaRef.current?.selectionStart ?? text.length;
        const before = text.slice(0, anchor);
        const after = text.slice(cursorPos);
        const inserted = `${cmd.insertText} `;
        setText(before + inserted + after);
        setDollarMenuOpen(false);
        setDollarQuery("");
        dollarAnchorRef.current = -1;
        requestAnimationFrame(() => {
          const newPos = before.length + inserted.length;
          textareaRef.current?.setSelectionRange(newPos, newPos);
          textareaRef.current?.focus();
        });
        return;
      }

      setText(`${cmd.insertText} `);
      setSlashMenuOpen(false);
      textareaRef.current?.focus();
    },
    [setText, text],
  );

  const acceptVoiceEdit = useCallback(() => {
    if (!voiceEditProposal) return;
    setText(voiceEditProposal.editedText);
    setVoiceEditProposal(null);
    textareaRef.current?.focus();
  }, [setText, voiceEditProposal]);

  const undoVoiceEdit = useCallback(() => {
    if (!voiceEditProposal) return;
    setText(voiceEditProposal.originalText);
    setVoiceEditProposal(null);
    textareaRef.current?.focus();
  }, [setText, voiceEditProposal]);

  async function handleSend() {
    const store = useStore.getState();
    const msg = text.trim();
    if ((!msg && images.length === 0) || !isConnected || voiceEditProposal) return;

    // Auto-answer pending AskUserQuestion if user types a response.
    // The typed text becomes the "Other..." answer for each question.
    // No separate user_message is sent — the answer IS the user's message.
    if (pendingAskUserPerm) {
      const questions = Array.isArray(pendingAskUserPerm.input?.questions)
        ? (pendingAskUserPerm.input.questions as Record<string, unknown>[])
        : [];
      const answers: Record<string, string> = {};
      for (let i = 0; i < Math.max(1, questions.length); i++) {
        answers[String(i)] = msg;
      }
      sendToSession(sessionId, {
        type: "permission_response",
        request_id: pendingAskUserPerm.request_id,
        behavior: "allow",
        updated_input: { ...pendingAskUserPerm.input, answers },
      });
      store.removePermission(sessionId, pendingAskUserPerm.request_id);
      store.clearComposerDraft(sessionId);
      setSlashMenuOpen(false);
      setDollarMenuOpen(false);
      setDollarQuery("");
      dollarAnchorRef.current = -1;
      setReferenceMenuOpen(false);
      setReferenceKind(null);
      setReferenceQuery("");
      referenceAnchorRef.current = -1;
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      if (isTouchDevice()) textareaRef.current?.blur();
      else textareaRef.current?.focus();
      return;
    }

    // Auto-reject pending plan if user sends a message while plan is pending.
    // This matches Claude Code vanilla behavior: typing a new message rejects
    // the plan and sends the new instructions as a fresh turn.
    if (pendingPlanPerm) {
      sendToSession(sessionId, {
        type: "permission_response",
        request_id: pendingPlanPerm.request_id,
        behavior: "deny",
        message: "Plan rejected — user sent a new message",
      });
      store.removePermission(sessionId, pendingPlanPerm.request_id);
    }

    // Codex local slash shortcuts for mode switching.
    // These must not be sent as normal user turns.
    if (isCodex) {
      const targetMode = parseCodexModeSlashCommand(msg);
      if (targetMode) {
        const targetAsk = targetMode.askPermission ?? askPermission;
        const cliMode = resolveCodexCliMode(targetMode.uiMode, targetAsk);
        const switched = sendToSession(sessionId, { type: "set_permission_mode", mode: cliMode });
        if (!switched) return;
        store.clearComposerDraft(sessionId);
        setSlashMenuOpen(false);
        setDollarMenuOpen(false);
        setDollarQuery("");
        dollarAnchorRef.current = -1;
        setReferenceMenuOpen(false);
        setReferenceKind(null);
        setReferenceQuery("");
        referenceAnchorRef.current = -1;
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        if (isTouchDevice()) textareaRef.current?.blur();
        else textareaRef.current?.focus();
        return;
      }
    }

    // Prepend reply context if the user is replying to a specific message
    const currentReplyContext = useStore.getState().replyContexts.get(sessionId);
    const finalContent = currentReplyContext
      ? injectReplyContext(currentReplyContext.previewText, msg, currentReplyContext.messageId)
      : msg;

    const clearComposerUi = () => {
      setSlashMenuOpen(false);
      setDollarMenuOpen(false);
      setDollarQuery("");
      dollarAnchorRef.current = -1;
      setReferenceMenuOpen(false);
      setReferenceKind(null);
      setReferenceQuery("");
      referenceAnchorRef.current = -1;
      setMentionMenuOpen(false);
      setMentionResults([]);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      if (isTouchDevice()) {
        textareaRef.current?.blur();
      } else {
        textareaRef.current?.focus();
      }

      setSendPressing(true);
      setTimeout(() => setSendPressing(false), 500);
    };

    const finalizeReplyNotification = () => {
      if (!currentReplyContext?.messageId) return;
      const notifications = useStore.getState().sessionNotifications.get(sessionId);
      const notif = notifications?.find((n) => n.messageId === currentReplyContext.messageId && !n.done);
      if (notif) {
        api.markNotificationDone(sessionId, notif.id, true).catch(() => {});
      }
    };

    if (images.length > 0) {
      const pendingId = nextPendingUploadId();
      const uploadController = new AbortController();
      registerPendingUserUploadController(pendingId, uploadController);
      store.addPendingUserUpload(sessionId, {
        id: pendingId,
        content: finalContent,
        images,
        timestamp: Date.now(),
        stage: "uploading",
        ...(vscodeSelectionPayload ? { vscodeSelection: vscodeSelectionPayload } : {}),
      });
      store.clearComposerDraft(sessionId);
      store.setReplyContext(sessionId, null);
      clearComposerUi();

      try {
        const prepared = await api.prepareUserMessageImages(
          sessionId,
          images.map((img) => ({ mediaType: img.mediaType, data: img.base64 })),
          uploadController.signal,
        );
        clearPendingUserUploadController(pendingId);
        const deliveryContent = `${finalContent}${prepared.attachmentAnnotation}`;
        const sent = sendToSession(sessionId, {
          type: "user_message",
          content: finalContent,
          deliveryContent,
          imageRefs: prepared.imageRefs,
          session_id: sessionId,
          client_msg_id: pendingId,
          ...(vscodeSelectionPayload ? { vscodeSelection: vscodeSelectionPayload } : {}),
        });

        store.requestBottomAlignOnNextUserMessage(sessionId);
        finalizeReplyNotification();
        store.updatePendingUserUpload(sessionId, pendingId, (upload) => ({
          ...upload,
          stage: sent ? "delivering" : "failed",
          error: sent ? undefined : "Connection lost before delivery.",
          prepared: {
            deliveryContent,
            imageRefs: prepared.imageRefs,
          },
        }));
        return;
      } catch (err) {
        clearPendingUserUploadController(pendingId);
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        const message = err instanceof Error ? err.message : "Image upload failed";
        store.updatePendingUserUpload(sessionId, pendingId, (upload) => ({
          ...upload,
          stage: "failed",
          error: message,
        }));
        return;
      }
    }

    const sent = sendToSession(sessionId, {
      type: "user_message",
      content: finalContent,
      session_id: sessionId,
      ...(vscodeSelectionPayload ? { vscodeSelection: vscodeSelectionPayload } : {}),
    });

    if (!sent) return; // WebSocket not open — keep draft so user can retry

    // User message will appear in the feed when the server broadcasts it back
    // (server-authoritative model — browsers never add user messages locally)
    store.requestBottomAlignOnNextUserMessage(sessionId);
    store.clearComposerDraft(sessionId);
    finalizeReplyNotification();
    store.setReplyContext(sessionId, null);

    clearComposerUi();
  }

  // Voice recording keyboard shortcuts:
  // - Double-Shift (within 400ms): start recording
  // - Single Shift tap (while recording): finish recording & transcribe
  // - Escape (while recording): cancel recording & discard audio
  useEffect(() => {
    if (!voiceSupported) return;
    let lastShiftUp = 0;
    let shiftGestureCandidate = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        // Start a fresh candidate only for a non-repeating standalone Shift press.
        if (!e.repeat) shiftGestureCandidate = true;
      } else if (shiftGestureCandidate) {
        // Any non-Shift key while Shift is down means this was regular typing or a shortcut.
        shiftGestureCandidate = false;
        lastShiftUp = 0;
      } else if (lastShiftUp !== 0) {
        // Any intervening non-Shift typing between taps invalidates the armed first tap.
        lastShiftUp = 0;
      }
      if (e.key === "Escape" && (isRecording || isPreparing)) {
        e.preventDefault();
        cancelRecording();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      if (!shiftGestureCandidate) {
        lastShiftUp = 0;
        return;
      }
      shiftGestureCandidate = false;
      const now = Date.now();

      if (isRecording) {
        // While recording, any clean Shift tap finishes recording
        lastShiftUp = 0;
        handleMicClick();
        return;
      }

      // Not recording: require double-tap to start
      if (now - lastShiftUp < 400) {
        lastShiftUp = 0;
        if (!isConnected || isTranscribing || isPreparing || voiceEditProposal) return;
        handleMicClick();
      } else {
        lastShiftUp = now;
        warmMicrophone(); // Pre-warm mic on first tap so it's ready for the second
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [
    voiceSupported,
    isRecording,
    isPreparing,
    isConnected,
    isTranscribing,
    handleMicClick,
    cancelRecording,
    warmMicrophone,
    voiceEditProposal,
  ]);

  function handleKeyDown(e: React.KeyboardEvent) {
    // Slash menu navigation
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashMenuIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
        e.preventDefault();
        selectCommand(filteredCommands[slashMenuIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
    }

    // `$` skill/app mention menu navigation
    if (dollarMenuOpen && filteredDollarCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setDollarMenuIndex((i) => (i + 1) % filteredDollarCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setDollarMenuIndex((i) => (i - 1 + filteredDollarCommands.length) % filteredDollarCommands.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredDollarCommands[dollarMenuIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectCommand(filteredDollarCommands[dollarMenuIndex]);
        return;
      }
    }
    if (dollarMenuOpen && e.key === "Escape") {
      e.preventDefault();
      setDollarMenuOpen(false);
      setDollarQuery("");
      dollarAnchorRef.current = -1;
      return;
    }

    // Quest/session reference menu navigation
    if (referenceMenuOpen && filteredReferenceSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setReferenceMenuIndex((i) => (i + 1) % filteredReferenceSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setReferenceMenuIndex(
          (i) => (i - 1 + filteredReferenceSuggestions.length) % filteredReferenceSuggestions.length,
        );
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectReference(filteredReferenceSuggestions[referenceMenuIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
        e.preventDefault();
        selectReference(filteredReferenceSuggestions[referenceMenuIndex]);
        return;
      }
    }
    if (referenceMenuOpen && e.key === "Escape") {
      e.preventDefault();
      setReferenceMenuOpen(false);
      setReferenceKind(null);
      setReferenceQuery("");
      referenceAnchorRef.current = -1;
      return;
    }

    // @ mention menu navigation
    if (mentionMenuOpen && mentionResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionResults.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionResults.length) % mentionResults.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        selectMention(mentionResults[mentionIndex]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
        e.preventDefault();
        selectMention(mentionResults[mentionIndex]);
        return;
      }
    }
    if (mentionMenuOpen && e.key === "Escape") {
      e.preventDefault();
      setMentionMenuOpen(false);
      setMentionResults([]);
      return;
    }

    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      cycleMode();
      return;
    }
    // Desktop: Enter sends, Shift+Enter inserts newline.
    // Mobile: Enter always inserts newline (users tap the Send button).
    // Skip during IME composition (e.g. CJK input) -- Enter confirms the
    // candidate character, not a send intent. keyCode 229 covers older browsers.
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !usesTouchKeyboard &&
      !e.nativeEvent.isComposing &&
      e.nativeEvent.keyCode !== 229
    ) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    isUserInput.current = true;
    const newText = e.target.value;
    const cursorPos = e.target.selectionStart;
    if (voiceEditProposal) {
      setVoiceEditProposal(null);
    }
    setText(newText);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    // Trigger @ mention detection at current cursor position
    detectMentionQuery(newText, cursorPos);
    detectDollarQuery(newText, cursorPos);
    detectReferenceQuery(newText, cursorPos);
  }

  function handleInterrupt() {
    sendToSession(sessionId, { type: "interrupt" });
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    await appendImages(getImageFiles(e.target.files));
    e.target.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function appendImages(files: File[], buildName?: (file: File, index: number) => string) {
    if (files.length === 0) return;
    const newImages: ImageAttachment[] = [];
    for (const [index, file] of files.entries()) {
      const raw = await readFileAsBase64(file);
      const { base64, mediaType } = await ensureSupportedFormat(raw.base64, raw.mediaType);
      newImages.push({
        name: buildName?.(file, index) ?? file.name,
        base64,
        mediaType,
      });
    }
    setImages((prev) => [...prev, ...newImages]);
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const files = getPastedImageFiles(e);
    if (files.length === 0) return;
    e.preventDefault();
    const pasteTs = Date.now();
    await appendImages(
      files,
      (_file, index) => `pasted-${pasteTs}-${index}.${files[index].type.split("/")[1] || "jpeg"}`,
    );
  }

  function resetImageDragState() {
    imageDragDepthRef.current = 0;
    setIsImageDragOver(false);
  }

  function handleComposerDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    imageDragDepthRef.current += 1;
    setIsImageDragOver(true);
  }

  function handleComposerDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!hasDraggedImageFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (!isImageDragOver) setIsImageDragOver(true);
  }

  function handleComposerDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (!isImageDragOver) return;
    e.preventDefault();
    e.stopPropagation();
    imageDragDepthRef.current = Math.max(0, imageDragDepthRef.current - 1);
    if (imageDragDepthRef.current === 0) {
      setIsImageDragOver(false);
    }
  }

  async function handleComposerDrop(e: React.DragEvent<HTMLDivElement>) {
    const files = getImageFiles(e.dataTransfer?.files);
    if (files.length === 0) {
      resetImageDragState();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    resetImageDragState();
    await appendImages(files);
    textareaRef.current?.focus();
  }

  function selectMode(mode: string) {
    if (!isConnected) return;
    if (isCodex) {
      const cliMode = resolveCodexCliMode(mode, askPermission);
      sendToSession(sessionId, { type: "set_permission_mode", mode: cliMode });
      return;
    }
    // Claude Code: resolve the UI mode + askPermission to the actual CLI mode
    const cliMode = resolveClaudeCliMode(mode, askPermission);
    // Server will broadcast the updated permissionMode and uiMode to all browsers
    sendToSession(sessionId, { type: "set_permission_mode", mode: cliMode });
  }

  function toggleAskPermission() {
    if (!isConnected) return;
    setShowAskConfirm(true);
  }

  function confirmAskPermissionChange() {
    const newValue = !askPermission;
    sendToSession(sessionId, { type: "set_ask_permission", askPermission: newValue });
    setShowAskConfirm(false);
  }

  function cycleMode() {
    selectMode(uiMode === "plan" ? "agent" : "plan");
  }

  // Detect pending ExitPlanMode permission for auto-reject and ghost text
  const pendingPlanPerm = useStore((s) => {
    const permsMap = s.pendingPermissions.get(sessionId);
    if (!permsMap) return null;
    for (const perm of permsMap.values()) {
      if (perm.tool_name === "ExitPlanMode") return perm;
    }
    return null;
  });

  // Detect pending AskUserQuestion permission — typing a message answers it
  const pendingAskUserPerm = useStore((s) => {
    const permsMap = s.pendingPermissions.get(sessionId);
    if (!permsMap) return null;
    for (const perm of permsMap.values()) {
      if (perm.tool_name === "AskUserQuestion") return perm;
    }
    return null;
  });

  const isRunning = useStore((s) => s.sessionStatus.get(sessionId) === "running");
  const activePendingUserUpload = pendingUserUploads.find(
    (upload) => upload.stage === "uploading" || upload.stage === "delivering",
  );
  const canSend =
    (text.trim().length > 0 || images.length > 0) && isConnected && !voiceEditProposal && !activePendingUserUpload;
  const isVoiceInteractionActive = isPreparing || isRecording || isTranscribing;
  const hasActiveReplyContext = !!replyContext;

  // Mobile collapsible composer — keep voice capture visible even when the draft is empty.
  const isCollapsed =
    usesTouchKeyboard &&
    isNarrowLayout &&
    !composerExpanded &&
    !hasActiveReplyContext &&
    !isVoiceInteractionActive &&
    !text.trim() &&
    images.length === 0;

  // Replying should immediately reveal the full composer on mobile so the
  // reply target context stays visible instead of falling back to the compact bar.
  useEffect(() => {
    if (!usesTouchKeyboard || !isNarrowLayout || !hasActiveReplyContext) return;
    setComposerExpanded(true);
  }, [usesTouchKeyboard, isNarrowLayout, hasActiveReplyContext]);

  // Auto-collapse when composer becomes empty (after send clears text), but
  // never hide the voice UI while the capture/transcription flow is active or
  // while a reply target is still active.
  useEffect(() => {
    if (!usesTouchKeyboard || !isNarrowLayout) return;
    if (hasActiveReplyContext) return;
    if (isVoiceInteractionActive) return;
    if (!text.trim() && images.length === 0) {
      const timer = setTimeout(() => setComposerExpanded(false), 300);
      return () => clearTimeout(timer);
    }
  }, [usesTouchKeyboard, isNarrowLayout, hasActiveReplyContext, isVoiceInteractionActive, text, images.length]);

  // Collapse on tap outside the composer when empty
  const composerRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!usesTouchKeyboard || !isNarrowLayout || isCollapsed || isVoiceInteractionActive || hasActiveReplyContext)
      return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (
        !hasActiveReplyContext &&
        !isVoiceInteractionActive &&
        !text.trim() &&
        images.length === 0 &&
        composerRootRef.current &&
        !composerRootRef.current.contains(e.target as Node)
      ) {
        setComposerExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [
    usesTouchKeyboard,
    isNarrowLayout,
    isCollapsed,
    hasActiveReplyContext,
    isVoiceInteractionActive,
    text,
    images.length,
  ]);

  const expandComposer = useCallback(() => {
    textareaRef.current?.focus(); // synchronous focus triggers mobile virtual keyboard
    setComposerExpanded(true);
  }, []);

  const imageSrcs = useMemo(
    () => images.map((img) => ({ src: `data:${img.mediaType};base64,${img.base64}`, name: img.name })),
    [images],
  );
  const voiceUnsupportedTooltip =
    voiceUnsupportedReason === "insecure-context" ? "Voice needs HTTPS" : "Voice unavailable";
  const voiceIdleTitle = text.trim().length > 0 ? "Voice edit" : "Voice input";
  const voiceButtonTitle =
    (!voiceSupported ? voiceUnsupportedTooltip : voiceError) ||
    (isPreparing
      ? "Preparing microphone..."
      : isTranscribing
        ? transcriptionPhase === "uploading"
          ? "Uploading..."
          : transcriptionPhase === "editing"
            ? "Editing..."
            : transcriptionPhase === "appending"
              ? "Appending..."
              : transcriptionPhase === "enhancing"
                ? "Enhancing..."
                : "Transcribing..."
        : isRecording
          ? "Stop recording"
          : voiceEditProposal
            ? "Accept or undo the voice edit first"
            : voiceIdleTitle);
  const voiceButtonDisabled = !isConnected || isTranscribing || isPreparing || !!voiceEditProposal;
  const compactVoiceButtonDisabled = voiceButtonDisabled;

  useEffect(() => {
    if (voiceSupported || isRecording || isTranscribing) {
      setVoiceUnsupportedInfoOpen(false);
    }
  }, [voiceSupported, isRecording, isTranscribing]);

  return (
    <div
      ref={composerRootRef}
      className={`shrink-0 border-t border-cc-border bg-cc-card ${isCollapsed ? "" : "px-2 sm:px-4 py-2 sm:py-3"}`}
    >
      <CollapsedComposerBar
        isCollapsed={isCollapsed}
        expandComposer={expandComposer}
        isPlan={isPlan}
        onVoiceButton={() => {
          if (!voiceSupported) {
            toggleVoiceUnsupportedInfo(true);
            return;
          }
          setComposerExpanded(true);
          handleMicClick();
        }}
        compactVoiceButtonDisabled={compactVoiceButtonDisabled}
        voiceSupported={voiceSupported}
        isPreparing={isPreparing}
        isRecording={isRecording}
        voiceButtonTitle={voiceButtonTitle}
        isRunning={isRunning}
        onStop={handleInterrupt}
      />
      <div className={isCollapsed ? "h-0 overflow-hidden" : ""}>
        <ComposerInputSurface
          imageSrcs={imageSrcs}
          lightboxSrc={lightboxSrc}
          setLightboxSrc={setLightboxSrc}
          removeImage={removeImage}
          fileInputRef={fileInputRef}
          handleFileSelect={handleFileSelect}
          handleComposerDragEnter={handleComposerDragEnter}
          handleComposerDragOver={handleComposerDragOver}
          handleComposerDragLeave={handleComposerDragLeave}
          handleComposerDrop={handleComposerDrop}
          isImageDragOver={isImageDragOver}
          isPlan={isPlan}
          textareaRef={textareaRef}
          text={text}
          handleInput={handleInput}
          handleKeyDown={handleKeyDown}
          handlePaste={handlePaste}
          placeholder={
            pendingAskUserPerm
              ? "Type your answer..."
              : pendingPlanPerm
                ? "Type to reject plan and send new instructions..."
                : isCodex
                  ? "Type a message... (/ for commands, $ for skills/apps, @ for files)"
                  : "Type a message... (/ for commands, @ for files)"
          }
          isRecording={isRecording}
          recordingCursorBefore={preRecordingTextRef.current.before}
          recordingCursorAfter={preRecordingTextRef.current.after}
          topChildren={
            <>
              <ComposerMenus
                slashMenuOpen={slashMenuOpen}
                filteredCommands={filteredCommands}
                menuRef={menuRef}
                slashMenuIndex={slashMenuIndex}
                selectCommand={selectCommand}
                dollarMenuOpen={dollarMenuOpen}
                filteredDollarCommands={filteredDollarCommands}
                dollarMenuRef={dollarMenuRef}
                dollarMenuIndex={dollarMenuIndex}
                referenceMenuOpen={referenceMenuOpen}
                filteredReferenceSuggestions={filteredReferenceSuggestions}
                referenceMenuRef={referenceMenuRef}
                referenceMenuIndex={referenceMenuIndex}
                referenceKind={referenceKind}
                referenceQuery={referenceQuery}
                selectReference={selectReference}
                mentionMenuOpen={mentionMenuOpen}
                mentionResults={mentionResults}
                mentionMenuRef={mentionMenuRef}
                mentionIndex={mentionIndex}
                mentionQuery={mentionQuery}
                mentionLoading={mentionLoading}
                selectMention={selectMention}
              />

              <ComposerStatusBlocks
                isPreparing={isPreparing}
                isRecording={isRecording}
                isTranscribing={isTranscribing}
                transcriptionPhase={transcriptionPhase}
                volumeLevel={volumeLevel}
                voiceCaptureMode={voiceCaptureMode}
                voiceUnsupportedInfoOpen={voiceUnsupportedInfoOpen}
                voiceUnsupportedMessage={voiceUnsupportedMessage}
                voiceError={voiceError}
                failedTranscription={failedTranscription}
                voiceEditProposal={voiceEditProposal}
                replyContext={replyContext ?? null}
                vscodeSelectionLabel={
                  vscodeSelectionPayload ? formatVsCodeSelectionAttachmentLabel(vscodeSelectionPayload) : null
                }
                vscodeSelectionSummary={
                  vscodeSelectionPayload ? formatVsCodeSelectionSummary(vscodeSelectionPayload) : null
                }
                vscodeSelectionTitle={
                  vscodeSelectionPayload ? buildVsCodeSelectionPrompt(vscodeSelectionPayload) : null
                }
                onRetryTranscription={retryTranscription}
                onDismissVoiceError={() => {
                  setFailedTranscription(null);
                  setVoiceError(null);
                }}
                onAcceptVoiceEdit={acceptVoiceEdit}
                onUndoVoiceEdit={undoVoiceEdit}
                onDismissUnsupportedInfo={() => setVoiceUnsupportedInfoOpen(false)}
                onDismissReply={() => useStore.getState().setReplyContext(sessionId, null)}
                onDismissVsCodeSelection={() => useStore.getState().dismissVsCodeSelection(currentVsCodeSelectionKey)}
                onSetVoiceModeEdit={() => {
                  voiceCaptureModeRef.current = "edit";
                  setVoiceCaptureMode("edit");
                  persistPreferredVoiceMode("edit");
                }}
                onSetVoiceModeAppend={() => {
                  voiceCaptureModeRef.current = "append";
                  setVoiceCaptureMode("append");
                  persistPreferredVoiceMode("append");
                }}
              />
            </>
          }
          bottomChildren={
            <ComposerMetaToolbar
              sessionId={sessionId}
              sessionView={sessionView}
              diffLinesAdded={diffLinesAdded}
              diffLinesRemoved={diffLinesRemoved}
              isCodex={isCodex}
              isConnected={isConnected}
              showModelDropdown={showModelDropdown}
              setShowModelDropdown={setShowModelDropdown}
              modelDropdownRef={modelDropdownRef}
              claudeModelOptions={claudeModelOptions}
              codexModelOptions={codexModelOptions}
              onSelectModel={(model) => sendToSession(sessionId, { type: "set_model", model })}
              showCodexReasoningDropdown={showCodexReasoningDropdown}
              setShowCodexReasoningDropdown={setShowCodexReasoningDropdown}
              codexReasoningDropdownRef={codexReasoningDropdownRef}
              codexReasoningEffort={codexReasoningEffort}
              onSelectCodexReasoning={(effort) =>
                sendToSession(sessionId, { type: "set_codex_reasoning_effort", effort })
              }
              isPlan={isPlan}
              cycleMode={cycleMode}
              askConfirmRef={askConfirmRef}
              toggleAskPermission={toggleAskPermission}
              askPermission={askPermission}
              showAskConfirm={showAskConfirm}
              setShowAskConfirm={setShowAskConfirm}
              confirmAskPermissionChange={confirmAskPermissionChange}
              collapseAllButton={<CollapseAllButton sessionId={sessionId} />}
              onOpenFilePicker={() => fileInputRef.current?.click()}
              warmMicrophone={warmMicrophone}
              voiceSupported={voiceSupported}
              toggleVoiceUnsupportedInfo={toggleVoiceUnsupportedInfo}
              handleMicClick={handleMicClick}
              voiceButtonDisabled={voiceButtonDisabled}
              isPreparing={isPreparing}
              isRecording={isRecording}
              voiceButtonTitle={voiceButtonTitle}
              canSend={canSend}
              isRunning={isRunning}
              handleInterrupt={handleInterrupt}
              handleSend={handleSend}
              activePendingUploadStage={activePendingUserUpload?.stage}
              sendPressing={sendPressing}
            />
          }
        />
      </div>
    </div>
  );
}
