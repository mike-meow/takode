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
import { Lightbox } from "./Lightbox.js";
import { CatPawAvatar } from "./CatIcons.js";
import { DiffViewer } from "./DiffViewer.js";
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
import type { ChatMessage, CodexAppReference, CodexSkillReference, QuestmasterTask, SdkSessionInfo } from "../types.js";

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_SKILL_REFERENCES: CodexSkillReference[] = [];
const EMPTY_APP_REFERENCES: CodexAppReference[] = [];
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
const EMPTY_QUESTS: QuestmasterTask[] = [];
const EMPTY_SDK_SESSIONS: SdkSessionInfo[] = [];
const EMPTY_SESSION_NAMES = new Map<string, string>();

function PaperPlaneIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M2 2.5L14 8 2 13.5 2 9.5 9 8 2 6.5Z" />
    </svg>
  );
}

interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

/** Chip shown above the composer textarea when replying to a specific assistant message. */
export function ReplyChip({ previewText, onDismiss }: { previewText: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-2 pb-1 text-[12px] text-cc-muted">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        className="w-3 h-3 shrink-0 text-cc-primary"
      >
        <path d="M6 3L2 7l4 4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 7h7a4 4 0 014 4v1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="truncate min-w-0">
        <span className="text-cc-muted">{previewText}</span>
      </span>
      <button
        onClick={onDismiss}
        className="shrink-0 p-0.5 rounded hover:bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
        aria-label="Cancel reply"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

interface VoiceEditProposal {
  originalText: string;
  editedText: string;
  instructionText: string;
}

/** Audio blob + context preserved on transcription failure, enabling retry without re-recording. */
interface FailedTranscription {
  blob: Blob;
  mode: "dictation" | "edit" | "append";
  composerText: string;
  cursorContext: { before: string; after: string };
}

function getImageFiles(files: ArrayLike<File> | Iterable<File> | null | undefined): File[] {
  if (!files) return [];
  return Array.from(files).filter((file) => file.type.startsWith("image/"));
}

function getPastedImageFiles(e: React.ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function hasDraggedImageFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    return Array.from(dataTransfer.items).some((item) => item.kind === "file" && item.type.startsWith("image/"));
  }
  return getImageFiles(dataTransfer.files).length > 0;
}

function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const API_SUPPORTED_IMAGE_FORMATS = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VOICE_BAR_THRESHOLDS = [0.03, 0.08, 0.15, 0.24, 0.36] as const;

/** Convert unsupported image formats to JPEG via Canvas (browser-native). */
async function ensureSupportedFormat(
  base64: string,
  mediaType: string,
): Promise<{ base64: string; mediaType: string }> {
  if (API_SUPPORTED_IMAGE_FORMATS.has(mediaType)) return { base64, mediaType };
  try {
    const blob = await fetch(`data:${mediaType};base64,${base64}`).then((r) => r.blob());
    const img = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    const converted = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    const arrayBuf = await converted.arrayBuffer();
    return {
      base64: btoa(String.fromCharCode(...new Uint8Array(arrayBuf))),
      mediaType: "image/jpeg",
    };
  } catch {
    // Browser can't decode this format — pass through, server will try
    return { base64, mediaType };
  }
}

interface CommandItem {
  name: string;
  type: "command" | "skill" | "app";
  trigger: "/" | "$";
  insertText: string;
  description?: string;
}

const DOLLAR_QUERY_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const REFERENCE_QUERY_PATTERN = /^\d*$/;
const REFERENCE_MENU_LIMIT = 8;

interface ReferenceSuggestion {
  key: string;
  kind: "quest" | "session";
  rawRef: string;
  preview: string;
  insertText: string;
  searchText: string;
  recentBoost: number;
  tieBreaker: number;
}

interface ReferenceTriggerMatch {
  kind: "quest" | "session";
  query: string;
  replacementStart: number;
}

function getPathTail(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? normalized;
}

function buildQuestLinkInsertText(questId: string): string {
  return `[${questId}](quest:${questId})`;
}

function buildSessionLinkInsertText(sessionNum: number): string {
  return `[#${sessionNum}](session:${sessionNum})`;
}

function getSessionSuggestionPreview(session: SdkSessionInfo, sessionName: string | undefined): string {
  const explicitName = sessionName?.trim() || session.name?.trim();
  if (explicitName) return explicitName;
  return getPathTail(session.cwd) || `Session ${session.sessionNum ?? ""}`.trim();
}

function computeRecentReferenceBoosts(messages: ChatMessage[]): {
  questBoosts: Map<string, number>;
  sessionBoosts: Map<number, number>;
} {
  const questBoosts = new Map<string, number>();
  const sessionBoosts = new Map<number, number>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = message?.content ?? "";
    if (!content) continue;

    const recencyWeight = index + 1;
    const questMatches = new Set<string>();
    const sessionMatches = new Set<number>();

    for (const match of content.matchAll(/\bquest:(q-\d+)\b/gi)) {
      questMatches.add(match[1]!.toLowerCase());
    }
    for (const match of content.matchAll(/(?:^|[^A-Za-z0-9])(q-\d+)\b/gi)) {
      questMatches.add(match[1]!.toLowerCase());
    }
    for (const match of content.matchAll(/\bsession:(?:\/\/)?(\d+)(?::\d+)?\b/gi)) {
      sessionMatches.add(Number.parseInt(match[1]!, 10));
    }
    for (const match of content.matchAll(/(?:^|[^A-Za-z0-9])#(\d+)\b/g)) {
      sessionMatches.add(Number.parseInt(match[1]!, 10));
    }

    for (const questId of questMatches) {
      if (!questBoosts.has(questId)) questBoosts.set(questId, recencyWeight);
    }
    for (const sessionNum of sessionMatches) {
      if (!Number.isFinite(sessionNum) || sessionBoosts.has(sessionNum)) continue;
      sessionBoosts.set(sessionNum, recencyWeight);
    }
  }

  return { questBoosts, sessionBoosts };
}

function detectReferenceTrigger(inputText: string, cursorPos: number): ReferenceTriggerMatch | null {
  for (let i = cursorPos - 1; i >= 0; i -= 1) {
    const ch = inputText[i];
    if (ch === " " || ch === "\n" || ch === "\t") break;

    const prevChar = inputText[i - 1] ?? "";
    const isAllowedBoundary = i === 0 || /[\s([{]/.test(prevChar);
    const replacementStart = i > 0 && /[[({]/.test(prevChar) ? i - 1 : i;

    if (ch === "#" && isAllowedBoundary) {
      const query = inputText.slice(i + 1, cursorPos);
      if (!REFERENCE_QUERY_PATTERN.test(query)) return null;
      return { kind: "session", query, replacementStart };
    }

    if (ch === "q" && inputText[i + 1] === "-" && isAllowedBoundary) {
      const query = inputText.slice(i + 2, cursorPos);
      if (!REFERENCE_QUERY_PATTERN.test(query)) return null;
      return { kind: "quest", query, replacementStart };
    }
  }

  return null;
}

function toAppMentionSlug(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "app";
}

function toSkillMentionInsertText(skill: CodexSkillReference): string {
  if (skill.path?.trim()) {
    const escapedPath = skill.path.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
    return `[$${skill.name}](${escapedPath})`;
  }
  return `$${skill.name}`;
}

function toAppMentionInsertText(app: CodexAppReference): string {
  return `[$${toAppMentionSlug(app.name)}](app://${app.id})`;
}

function parseCodexModeSlashCommand(text: string): { uiMode: "plan" | "agent"; askPermission?: boolean } | null {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, "");
  switch (normalized) {
    case "/plan":
      return { uiMode: "plan" };
    case "/suggest":
      return { uiMode: "agent", askPermission: true };
    case "/accept-edits":
    case "/acceptedits":
      return { uiMode: "agent", askPermission: true };
    case "/auto":
      return { uiMode: "agent", askPermission: false };
    default:
      return null;
  }
}

function CollapseAllButton({ sessionId }: { sessionId: string }) {
  const collapsibleTurnIds = useStore((s) => s.collapsibleTurnIds.get(sessionId));
  const overrides = useStore((s) => s.turnActivityOverrides.get(sessionId));
  const hasTurns = collapsibleTurnIds && collapsibleTurnIds.length > 0;

  // All collapsed when every collapsible turn has an explicit false override
  const allCollapsed = hasTurns && collapsibleTurnIds.every((id) => overrides?.get(id) === false);

  function handleClick() {
    if (!hasTurns) return;
    const store = useStore.getState();
    if (allCollapsed) {
      // Expand the last turn explicitly, regardless of its default collapse state.
      const lastId = collapsibleTurnIds[collapsibleTurnIds.length - 1];
      store.keepTurnExpanded(sessionId, lastId);
    } else {
      store.collapseAllTurnActivity(sessionId, collapsibleTurnIds);
    }
  }

  return (
    <button
      onClick={handleClick}
      className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors select-none ${
        !hasTurns
          ? "text-cc-muted/40 cursor-default"
          : allCollapsed
            ? "bg-cc-primary/15 text-cc-primary cursor-pointer"
            : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
      }`}
      title={allCollapsed ? "Expand last turn" : "Collapse all turns"}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
        {allCollapsed ? (
          <>
            <path d="M4 6l4-4 4 4" />
            <path d="M4 10l4 4 4-4" />
          </>
        ) : (
          <>
            <path d="M4 2l4 4 4-4" />
            <path d="M4 14l4-4 4 4" />
          </>
        )}
      </svg>
    </button>
  );
}

export function Composer({ sessionId }: { sessionId: string }) {
  const draft = useStore((s) => s.composerDrafts.get(sessionId));
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

  // @ mention file search state
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionResults, setMentionResults] = useState<
    Array<{ relativePath: string; absolutePath: string; fileName: string }>
  >([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  // Tracks the cursor position of the `@` that triggered the menu
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
  // Persisted preference for voice capture mode when composer has text (loaded from server settings)
  const preferredVoiceModeRef = useRef<"edit" | "append">("edit");
  // UI state mirror of voiceCaptureModeRef -- drives re-renders for the mode toggle
  const [voiceCaptureMode, setVoiceCaptureMode] = useState<"dictation" | "edit" | "append">("dictation");

  // Voice input -- records audio via MediaRecorder, transcribes server-side
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

  const handleMicClick = useCallback(() => {
    if (!voiceSupported) {
      setVoiceError(voiceUnsupportedMessage ?? "Voice input is unavailable.");
      return;
    }
    if (!isRecording) {
      // Clear any saved failed transcription -- new recording supersedes old
      setFailedTranscription(null);
      // Always capture cursor position for potential append mode
      const el = textareaRef.current;
      const cursorPos = el?.selectionStart ?? text.length;
      preRecordingTextRef.current = {
        before: text.slice(0, cursorPos),
        after: text.slice(cursorPos),
      };
      if (text.trim().length > 0) {
        const mode = preferredVoiceModeRef.current;
        voiceCaptureModeRef.current = mode;
        setVoiceCaptureMode(mode);
        voiceEditBaseTextRef.current = text;
        setVoiceEditProposal(null);
      } else {
        voiceCaptureModeRef.current = "dictation";
        setVoiceCaptureMode("dictation");
      }
    }
    toggleRecording();
  }, [isRecording, setVoiceError, text, toggleRecording, voiceSupported, voiceUnsupportedMessage]);

  /** Transcribe an audio blob and apply the result based on mode. Used by both initial recording and retry. */
  async function performTranscription(
    blob: Blob,
    mode: "dictation" | "edit" | "append",
    composerText: string,
    cursorContext: { before: string; after: string },
  ) {
    setIsTranscribing(true);
    setTranscriptionPhase("transcribing");
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

  // Narrow layout detection uses zoom-adjusted viewport width so VS Code side
  // panels do not switch to mobile layout too early when the app is zoomed out.
  const [isNarrowLayout, setIsNarrowLayout] = useState(() => isNarrowComposerLayout(zoomLevel));
  const usesTouchKeyboard = isTouchDevice();
  useEffect(() => {
    const updateLayout = () => setIsNarrowLayout(isNarrowComposerLayout(zoomLevel));
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, [zoomLevel]);

  // Focus the textarea when external code (e.g. SelectionContextMenu "Quote selected")
  // signals focus via the store's focusComposerTrigger counter.
  const focusTrigger = useStore((s) => s.focusComposerTrigger);
  useEffect(() => {
    if (focusTrigger > 0) {
      textareaRef.current?.focus();
    }
  }, [focusTrigger]);

  // Track whether the current text change came from user typing (handleInput).
  // When it did, handleInput already adjusted the textarea height synchronously,
  // so the effect below can skip. For programmatic changes (draft restore on
  // session switch, prefill from revert) the effect recalculates height.
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

  // Auto-clear voice errors after 4 seconds, unless a retry is available
  useEffect(() => {
    if (!voiceError || failedTranscription) return;
    const timer = setTimeout(() => setVoiceError(null), 4000);
    return () => clearTimeout(timer);
  }, [voiceError, failedTranscription, setVoiceError]);

  // Keep the textarea subscribed only to the session fields it actually renders.
  // This avoids full-composer rerenders from unrelated session poll churn.
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
  }, [isCodex]);

  useEffect(() => {
    if (isCodex) return;
    let cancelled = false;
    // Fetch dynamic models and the user's configured default in parallel
    Promise.all([
      api.getBackendModels("claude").catch(() => [] as { value: string; label: string; description: string }[]),
      api.getSettings().catch(() => null),
    ]).then(([models, settings]) => {
      if (cancelled) return;
      const options = models.length > 0 ? toModelOptions(models) : [];
      // Load persisted voice capture mode preference
      const savedVoiceMode = settings?.transcriptionConfig?.voiceCaptureMode;
      if (savedVoiceMode === "edit" || savedVoiceMode === "append") {
        preferredVoiceModeRef.current = savedVoiceMode;
      }
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
  }, [isCodex]);

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
      useStore.getState().removePermission(sessionId, pendingAskUserPerm.request_id);
      useStore.getState().clearComposerDraft(sessionId);
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
      useStore.getState().removePermission(sessionId, pendingPlanPerm.request_id);
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
        useStore.getState().clearComposerDraft(sessionId);
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

    const sent = sendToSession(sessionId, {
      type: "user_message",
      content: finalContent,
      session_id: sessionId,
      ...(vscodeSelectionPayload ? { vscodeSelection: vscodeSelectionPayload } : {}),
      images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
    });

    if (!sent) return; // WebSocket not open — keep draft so user can retry

    // User message will appear in the feed when the server broadcasts it back
    // (server-authoritative model — browsers never add user messages locally)
    useStore.getState().requestBottomAlignOnNextUserMessage(sessionId);
    useStore.getState().clearComposerDraft(sessionId);

    // Auto-mark notification as done when the user replies to a notification message.
    // Must run before clearing reply context since we need the messageId.
    if (currentReplyContext?.messageId) {
      const notifications = useStore.getState().sessionNotifications.get(sessionId);
      const notif = notifications?.find((n) => n.messageId === currentReplyContext.messageId && !n.done);
      if (notif) {
        api.markNotificationDone(sessionId, notif.id, true).catch(() => {});
      }
    }
    useStore.getState().setReplyContext(sessionId, null);

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
        setReferenceMenuIndex((i) => (i - 1 + filteredReferenceSuggestions.length) % filteredReferenceSuggestions.length);
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
  const canSend = (text.trim().length > 0 || images.length > 0) && isConnected && !voiceEditProposal;
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
    if (!usesTouchKeyboard || !isNarrowLayout || isCollapsed || isVoiceInteractionActive || hasActiveReplyContext) return;
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
  }, [usesTouchKeyboard, isNarrowLayout, isCollapsed, hasActiveReplyContext, isVoiceInteractionActive, text, images.length]);

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
        ? transcriptionPhase === "editing"
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
      {/* Collapsed bar — shown on mobile when idle */}
      {isCollapsed && (
        <div className="px-2 py-2">
          <div className="max-w-3xl mx-auto flex items-center gap-2">
            <button
              onClick={expandComposer}
              className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 bg-cc-input-bg border border-cc-border rounded-[14px] cursor-text"
            >
              {/* Mode badge */}
              <span className="flex items-center gap-1 text-[11px] font-medium text-cc-muted shrink-0">
                {isPlan ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path d="M2 3.5h12v1H2zm0 4h8v1H2zm0 4h10v1H2z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                    <path
                      d="M2.5 4l4 4-4 4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                    <path
                      d="M8.5 4l4 4-4 4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </svg>
                )}
                {isPlan ? "Plan" : "Agent"}
              </span>
              <span className="flex-1 text-sm text-cc-muted text-left truncate">Type a message...</span>
            </button>
            <button
              onPointerEnter={warmMicrophone}
              onClick={() => {
                if (!voiceSupported) {
                  toggleVoiceUnsupportedInfo(true);
                  return;
                }
                setComposerExpanded(true);
                handleMicClick();
              }}
              disabled={compactVoiceButtonDisabled}
              aria-label="Voice input"
              aria-disabled={!voiceSupported || compactVoiceButtonDisabled}
              className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors shrink-0 ${
                !voiceSupported || compactVoiceButtonDisabled
                  ? "text-cc-muted opacity-30 cursor-not-allowed"
                  : isPreparing
                    ? "text-cc-warning bg-cc-warning/10 cursor-wait"
                    : isRecording
                      ? "text-red-500 bg-red-500/10 hover:bg-red-500/20 cursor-pointer"
                      : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
              }`}
              title={voiceButtonTitle}
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`w-5 h-5 ${isRecording || isPreparing ? "animate-pulse" : ""}`}
              >
                <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
              </svg>
            </button>
            {/* Stop button — visible in compact bar while streaming */}
            {isRunning && (
              <button
                onClick={handleInterrupt}
                className="flex items-center justify-center w-10 h-10 rounded-lg bg-cc-error/10 hover:bg-cc-error/20 text-cc-error transition-colors cursor-pointer shrink-0"
                title="Stop generation"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
      {/* Full composer — always rendered so textarea stays in DOM for mobile keyboard focus */}
      <div className={isCollapsed ? "h-0 overflow-hidden" : ""}>
        <div className="max-w-3xl mx-auto">
          {/* Image thumbnails — data URLs are memoized to avoid reconstructing
             multi-MB base64 strings on every render (expensive on iOS Safari) */}
          {imageSrcs.length > 0 && (
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {imageSrcs.map(({ src, name }, i) => (
                <div key={i} className="relative group">
                  <img
                    src={src}
                    alt={name}
                    className="w-24 h-24 rounded-lg object-cover border border-cc-border cursor-zoom-in hover:opacity-80 transition-opacity"
                    onClick={() => setLightboxSrc(src)}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeImage(i);
                    }}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                      <path
                        d="M4 4l8 8M12 4l-8 8"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        fill="none"
                      />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          {lightboxSrc && <Lightbox src={lightboxSrc} alt="attachment" onClose={() => setLightboxSrc(null)} />}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Unified input card */}
          <div
            data-testid="composer-input-card"
            onDragEnter={handleComposerDragEnter}
            onDragOver={handleComposerDragOver}
            onDragLeave={handleComposerDragLeave}
            onDrop={handleComposerDrop}
            className={`relative bg-cc-input-bg border rounded-[14px] overflow-visible transition-colors ${
              isImageDragOver
                ? "border-cc-primary bg-cc-primary/5 shadow-[0_0_0_3px_rgba(255,122,26,0.12)]"
                : isPlan
                  ? "border-cc-primary/40"
                  : "border-cc-border focus-within:border-cc-primary/30"
            }`}
          >
            {isImageDragOver && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[14px] border border-dashed border-cc-primary/50 bg-cc-primary/10">
                <div className="rounded-full border border-cc-primary/25 bg-cc-card/95 px-3 py-1 text-[11px] font-medium text-cc-primary shadow-sm">
                  Drop images to attach
                </div>
              </div>
            )}
            {/* Slash command menu */}
            {slashMenuOpen && filteredCommands.length > 0 && (
              <div
                ref={menuRef}
                className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
              >
                {filteredCommands.map((cmd, i) => (
                  <button
                    key={`${cmd.type}-${cmd.name}`}
                    data-cmd-index={i}
                    onClick={() => selectCommand(cmd)}
                    className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                      i === slashMenuIndex ? "bg-cc-hover" : "hover:bg-cc-hover/50"
                    }`}
                  >
                    <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                      {cmd.type === "skill" ? (
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                          <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                        </svg>
                      ) : (
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="w-3.5 h-3.5"
                        >
                          <path d="M5 12L10 4" strokeLinecap="round" />
                        </svg>
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="text-[13px] font-medium text-cc-fg">/{cmd.name}</span>
                      <span className="ml-2 text-[11px] text-cc-muted">{cmd.type}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* `$` skill/app mention menu (Codex only) */}
            {dollarMenuOpen && !slashMenuOpen && (
              <div
                ref={dollarMenuRef}
                className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
              >
                {filteredDollarCommands.length === 0 ? (
                  <div className="px-3 py-2.5 text-[12px] text-cc-muted">No skills or apps found</div>
                ) : (
                  filteredDollarCommands.map((cmd, i) => (
                    <button
                      key={`${cmd.type}-${cmd.name}-${cmd.insertText}`}
                      data-dollar-index={i}
                      onClick={() => selectCommand(cmd)}
                      className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                        i === dollarMenuIndex ? "bg-cc-hover" : "hover:bg-cc-hover/50"
                      }`}
                    >
                      <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                        {cmd.type === "app" ? (
                          <svg
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            className="w-3.5 h-3.5"
                          >
                            <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
                            <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
                            <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
                            <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                            <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                          </svg>
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[13px] font-medium text-cc-fg truncate">${cmd.name}</span>
                          <span className="text-[11px] text-cc-muted shrink-0">{cmd.type}</span>
                        </div>
                        {cmd.description && (
                          <div className="mt-0.5 text-[11px] text-cc-muted truncate">{cmd.description}</div>
                        )}
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}

            {/* Quest/session reference menu */}
            {referenceMenuOpen && !slashMenuOpen && !dollarMenuOpen && (
              <div
                ref={referenceMenuRef}
                className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
              >
                {filteredReferenceSuggestions.length === 0 ? (
                  <div className="px-3 py-2.5 text-[12px] text-cc-muted">
                    No {referenceKind === "quest" ? "quests" : "sessions"} found for "
                    {referenceKind === "quest" ? `q-${referenceQuery}` : `#${referenceQuery}`}"
                  </div>
                ) : (
                  filteredReferenceSuggestions.map((suggestion, i) => (
                    <button
                      key={suggestion.key}
                      data-reference-index={i}
                      onClick={() => selectReference(suggestion)}
                      className={`w-full px-3 py-2 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                        i === referenceMenuIndex ? "bg-cc-hover" : "hover:bg-cc-hover/50"
                      }`}
                    >
                      <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                        {suggestion.kind === "quest" ? (
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                            <path d="M5 3.5h6" strokeLinecap="round" />
                            <path d="M5 8h6" strokeLinecap="round" />
                            <path d="M5 12.5h4" strokeLinecap="round" />
                            <rect x="2.5" y="1.75" width="11" height="12.5" rx="2" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                            <circle cx="8" cy="8" r="5.5" />
                            <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[13px] font-medium text-cc-fg">{suggestion.rawRef}</span>
                          <span className="shrink-0 text-[11px] text-cc-muted">{suggestion.kind}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-cc-muted">{suggestion.preview}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}

            {/* @ mention file search menu */}
            {mentionMenuOpen && !slashMenuOpen && !dollarMenuOpen && !referenceMenuOpen && (
              <div
                ref={mentionMenuRef}
                className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
              >
                {mentionQuery.length < 3 ? (
                  <div className="px-3 py-2.5 text-[12px] text-cc-muted flex items-center gap-2">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      className="w-3.5 h-3.5 shrink-0 opacity-50"
                    >
                      <circle cx="6.5" cy="6.5" r="4.5" />
                      <path d="M10 10l4 4" strokeLinecap="round" />
                    </svg>
                    Type at least 3 characters to search files...
                  </div>
                ) : mentionLoading && mentionResults.length === 0 ? (
                  <div className="px-3 py-2.5 text-[12px] text-cc-muted flex items-center gap-2">
                    <span className="w-3 h-3 border-2 border-cc-muted/30 border-t-cc-muted rounded-full animate-spin shrink-0" />
                    Searching...
                  </div>
                ) : mentionResults.length === 0 ? (
                  <div className="px-3 py-2.5 text-[12px] text-cc-muted">No files found for "{mentionQuery}"</div>
                ) : (
                  mentionResults.map((result, i) => (
                    <button
                      key={result.relativePath}
                      data-mention-index={i}
                      onClick={() => selectMention(result)}
                      className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                        i === mentionIndex ? "bg-cc-hover" : "hover:bg-cc-hover/50"
                      }`}
                    >
                      <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                          <path d="M3 1.5A1.5 1.5 0 014.5 0h4.586a1.5 1.5 0 011.06.44l2.415 2.414A1.5 1.5 0 0113 3.914V14.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 14.5v-13z" />
                        </svg>
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-medium text-cc-fg">{result.fileName}</span>
                        <span className="ml-2 text-[11px] text-cc-muted truncate">{result.relativePath}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}

            {/* Mic preparing indicator */}
            {isPreparing && (
              <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-warning">
                <span className="w-2 h-2 rounded-full bg-cc-warning animate-pulse shrink-0" />
                <span className="shrink-0">Preparing mic...</span>
              </div>
            )}

            {/* Voice recording / transcribing indicator */}
            {isRecording && (
              <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-red-500">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                <span className="shrink-0">Recording</span>
                {/* Volume bars */}
                <div className="flex items-center gap-[2px] h-3">
                  {VOICE_BAR_THRESHOLDS.map((threshold, i) => (
                    <div
                      key={i}
                      className="w-[3px] rounded-full transition-all duration-75"
                      style={{
                        height:
                          volumeLevel > threshold ? `${Math.min(12, 4 + (volumeLevel - threshold) * 20)}px` : "3px",
                        backgroundColor: volumeLevel > threshold ? "rgb(239 68 68)" : "rgb(239 68 68 / 0.3)",
                      }}
                    />
                  ))}
                </div>
                {/* Voice mode toggle (only shown when recording with existing text) */}
                {voiceCaptureMode !== "dictation" && (
                  <div className="ml-auto flex items-center gap-0.5 rounded-full bg-cc-bg-secondary p-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        voiceCaptureModeRef.current = "edit";
                        setVoiceCaptureMode("edit");
                        preferredVoiceModeRef.current = "edit";
                        api.updateSettings({ transcriptionConfig: { voiceCaptureMode: "edit" } }).catch(() => {});
                      }}
                      className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                        voiceCaptureMode === "edit" ? "bg-cc-primary text-white" : "text-cc-muted hover:text-cc-fg"
                      }`}
                      title="Voice will be interpreted as editing instructions for the existing text"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        voiceCaptureModeRef.current = "append";
                        setVoiceCaptureMode("append");
                        preferredVoiceModeRef.current = "append";
                        api.updateSettings({ transcriptionConfig: { voiceCaptureMode: "append" } }).catch(() => {});
                      }}
                      className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                        voiceCaptureMode === "append" ? "bg-cc-primary text-white" : "text-cc-muted hover:text-cc-fg"
                      }`}
                      title="Voice will be appended as additional text at the cursor position"
                    >
                      Append
                    </button>
                  </div>
                )}
              </div>
            )}
            {isTranscribing && !isRecording && (
              <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary">
                <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse" />
                <span>
                  {transcriptionPhase === "editing"
                    ? "Editing..."
                    : transcriptionPhase === "appending"
                      ? "Appending..."
                      : transcriptionPhase === "enhancing"
                        ? "Enhancing..."
                        : "Transcribing..."}
                </span>
              </div>
            )}
            {voiceUnsupportedInfoOpen && voiceUnsupportedMessage && !isRecording && !isTranscribing && (
              <div className="px-4 pt-2">
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-start gap-2 rounded-lg border border-cc-warning/25 bg-cc-warning/10 px-3 py-2 text-[11px] text-cc-warning"
                >
                  <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-current opacity-80" />
                  <span className="flex-1">{voiceUnsupportedMessage}</span>
                  <button
                    type="button"
                    onClick={() => setVoiceUnsupportedInfoOpen(false)}
                    className="shrink-0 text-cc-warning/70 hover:text-cc-warning transition-colors"
                    aria-label="Dismiss voice input message"
                    title="Dismiss"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
            {voiceError && !isRecording && !isTranscribing && (
              <div className="px-4 pt-2">
                {failedTranscription ? (
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-2 rounded-lg border border-cc-warning/25 bg-cc-warning/10 px-3 py-2 text-[11px] text-cc-warning"
                  >
                    <span className="shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full bg-current opacity-80" />
                    <span className="flex-1 min-w-0 truncate">{voiceError}</span>
                    <button
                      type="button"
                      onClick={retryTranscription}
                      className="shrink-0 rounded-md bg-cc-primary px-2.5 py-1 text-[10px] font-medium text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setFailedTranscription(null);
                        setVoiceError(null);
                      }}
                      className="shrink-0 text-cc-warning/70 hover:text-cc-warning transition-colors cursor-pointer"
                      aria-label="Dismiss transcription error"
                      title="Dismiss"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </div>
                ) : (
                  <div className="text-[11px] text-cc-warning">{voiceError}</div>
                )}
              </div>
            )}
            {voiceEditProposal && !isRecording && !isTranscribing && (
              <div className="px-4 pt-2">
                <div className="rounded-xl border border-cc-primary/20 bg-cc-primary/5 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-cc-primary">
                        Voice edit preview
                      </div>
                      <div className="mt-1 text-[12px] text-cc-muted">
                        Apply instruction:{" "}
                        <span className="text-cc-fg">
                          {voiceEditProposal.instructionText || "(no instruction text returned)"}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={undoVoiceEdit}
                        className="rounded-lg border border-cc-border px-3 py-1.5 text-[12px] font-medium text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                      >
                        Undo
                      </button>
                      <button
                        type="button"
                        onClick={acceptVoiceEdit}
                        className="rounded-lg bg-cc-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-cc-primary-hover transition-colors cursor-pointer"
                      >
                        Accept
                      </button>
                    </div>
                  </div>
                  <div className="mt-3">
                    <DiffViewer
                      oldText={voiceEditProposal.originalText}
                      newText={voiceEditProposal.editedText}
                      mode="compact"
                    />
                  </div>
                </div>
              </div>
            )}

            {replyContext && (
              <ReplyChip
                previewText={replyContext.previewText}
                onDismiss={() => useStore.getState().setReplyContext(sessionId, null)}
              />
            )}

            {vscodeSelectionPayload && (
              <div className="mb-2 flex">
                <div
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-cc-border/80 bg-cc-hover/70 px-2 py-1 text-[11px] text-cc-muted"
                  title={buildVsCodeSelectionPrompt(vscodeSelectionPayload)}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3 shrink-0 opacity-70">
                    <path d="M3.75 1.5A2.25 2.25 0 001.5 3.75v8.5A2.25 2.25 0 003.75 14.5h8.5a2.25 2.25 0 002.25-2.25v-5a.75.75 0 00-1.5 0v5A.75.75 0 0112.25 13h-8.5a.75.75 0 01-.75-.75v-8.5A.75.75 0 013.75 3h5a.75.75 0 000-1.5h-5z" />
                    <path d="M9.53 1.47a.75.75 0 011.06 0l3.94 3.94a.75.75 0 010 1.06l-5.5 5.5a.75.75 0 01-.33.2l-2.5.63a.75.75 0 01-.91-.91l.63-2.5a.75.75 0 01.2-.33l5.5-5.5z" />
                  </svg>
                  <span className="truncate font-mono-code">
                    {formatVsCodeSelectionAttachmentLabel(vscodeSelectionPayload)}
                  </span>
                  <span className="text-cc-muted/60">&middot;</span>
                  <span className="truncate">{formatVsCodeSelectionSummary(vscodeSelectionPayload)}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 hover:bg-cc-border/60 cursor-pointer"
                    title="Dismiss selection"
                    onClick={(e) => {
                      e.stopPropagation();
                      useStore.getState().dismissVsCodeSelection(currentVsCodeSelectionKey);
                    }}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            <div className="relative">
              <textarea
                ref={textareaRef}
                value={text}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                spellCheck={false}
                enterKeyHint={isTouchDevice() ? "enter" : undefined}
                placeholder={
                  pendingAskUserPerm
                    ? "Type your answer..."
                    : pendingPlanPerm
                      ? "Type to reject plan and send new instructions..."
                      : isCodex
                        ? "Type a message... (/ for commands, $ for skills/apps, @ for files)"
                        : "Type a message... (/ for commands, @ for files)"
                }
                rows={1}
                className={`w-full px-4 pt-3 pb-1 text-base sm:text-sm bg-transparent resize-none focus:outline-none font-sans-ui placeholder:text-cc-muted disabled:opacity-50 overflow-y-auto ${
                  isRecording && preRecordingTextRef.current.after ? "text-transparent caret-transparent" : "text-cc-fg"
                }`}
                style={{ minHeight: "36px", maxHeight: "200px" }}
              />
              {/* Inline cursor overlay — renders text with a pulsing red bar at the insertion point */}
              {isRecording && preRecordingTextRef.current.after && (
                <div className="absolute inset-0 px-4 pt-3 pb-1 text-base sm:text-sm font-sans-ui text-cc-fg pointer-events-none overflow-y-auto whitespace-pre-wrap break-words">
                  <span>{preRecordingTextRef.current.before}</span>
                  <span
                    className="inline-block w-[2px] rounded-full animate-pulse mx-px"
                    style={{ height: "1.15em", backgroundColor: "rgb(239 68 68 / 0.8)", verticalAlign: "text-bottom" }}
                  />
                  <span>{preRecordingTextRef.current.after}</span>
                </div>
              )}
            </div>

            {/* Git branch + model + lines info */}
            {(sessionView.gitBranch || sessionView.model) && (
              <div className="flex items-center gap-2 px-2 sm:px-4 pb-1 text-[11px] text-cc-muted">
                {sessionView.gitBranch && (
                  <span className="flex items-center gap-1 truncate min-w-0">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                      <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                    </svg>
                    <span className="truncate max-w-[100px] sm:max-w-[160px]">{sessionView.gitBranch}</span>
                    {sessionView.isContainerized && (
                      <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1 rounded">container</span>
                    )}
                  </span>
                )}
                {(sessionView.gitAhead > 0 || sessionView.gitBehind > 0) && (
                  <span className="flex items-center gap-0.5 text-[10px]">
                    {sessionView.gitAhead > 0 && <span className="text-green-500">{sessionView.gitAhead}&#8593;</span>}
                    {sessionView.gitBehind > 0 && (
                      <span className="text-cc-warning">{sessionView.gitBehind}&#8595;</span>
                    )}
                  </span>
                )}
                {(diffLinesAdded > 0 || diffLinesRemoved > 0) && (
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="text-green-500">+{diffLinesAdded}</span>
                    <span className="text-red-400">-{diffLinesRemoved}</span>
                  </span>
                )}
                {sessionView.model && (
                  <>
                    {sessionView.gitBranch && <span className="text-cc-muted/40">&middot;</span>}
                    {!isCodex ? (
                      <div className="relative" ref={modelDropdownRef}>
                        <button
                          onClick={() => setShowModelDropdown(!showModelDropdown)}
                          disabled={!isConnected}
                          className={`flex items-center gap-0.5 font-mono-code truncate transition-colors select-none ${
                            !isConnected ? "opacity-30 cursor-not-allowed" : "hover:text-cc-fg cursor-pointer"
                          }`}
                          title={`Model: ${sessionView.model} (click to change)`}
                        >
                          <span className="truncate">{formatModel(sessionView.model)}</span>
                          <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                            <path d="M4 6l4 4 4-4" />
                          </svg>
                        </button>
                        {showModelDropdown && (
                          <div className="absolute left-0 bottom-full mb-1 w-52 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden max-h-64 overflow-y-auto">
                            {claudeModelOptions.map((m) => (
                              <button
                                key={m.value}
                                onClick={() => {
                                  sendToSession(sessionId, { type: "set_model", model: m.value });
                                  setShowModelDropdown(false);
                                }}
                                className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                                  m.value === sessionView.model ? "text-cc-primary font-medium" : "text-cc-fg"
                                }`}
                              >
                                <span className="mr-1.5">{m.icon}</span>
                                {m.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="relative" ref={modelDropdownRef}>
                          <button
                            onClick={() => setShowModelDropdown(!showModelDropdown)}
                            disabled={!isConnected}
                            className={`flex items-center gap-0.5 font-mono-code truncate transition-colors select-none ${
                              !isConnected ? "opacity-30 cursor-not-allowed" : "hover:text-cc-fg cursor-pointer"
                            }`}
                            title={`Model: ${sessionView.model} (relaunch required)`}
                          >
                            <span className="truncate">{formatModel(sessionView.model)}</span>
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                              <path d="M4 6l4 4 4-4" />
                            </svg>
                          </button>
                          {showModelDropdown && (
                            <div className="absolute left-0 bottom-full mb-1 w-52 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden max-h-64 overflow-y-auto">
                              {codexModelOptions.map((m) => (
                                <button
                                  key={m.value}
                                  onClick={() => {
                                    sendToSession(sessionId, { type: "set_model", model: m.value });
                                    setShowModelDropdown(false);
                                  }}
                                  className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                                    m.value === sessionView.model ? "text-cc-primary font-medium" : "text-cc-fg"
                                  }`}
                                >
                                  <span className="mr-1.5">{m.icon}</span>
                                  {m.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <span className="text-cc-muted/40">&middot;</span>
                        <div className="relative" ref={codexReasoningDropdownRef}>
                          <button
                            onClick={() => setShowCodexReasoningDropdown(!showCodexReasoningDropdown)}
                            disabled={!isConnected}
                            className={`flex items-center gap-1 truncate transition-colors select-none ${
                              !isConnected ? "opacity-30 cursor-not-allowed" : "hover:text-cc-fg cursor-pointer"
                            }`}
                            title="Reasoning effort (relaunch required)"
                          >
                            <span>
                              {CODEX_REASONING_EFFORTS.find(
                                (x) => x.value === codexReasoningEffort,
                              )?.label.toLowerCase() || "default"}
                            </span>
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                              <path d="M4 6l4 4 4-4" />
                            </svg>
                          </button>
                          {showCodexReasoningDropdown && (
                            <div className="absolute left-0 bottom-full mb-1 w-40 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                              {CODEX_REASONING_EFFORTS.map((effort) => (
                                <button
                                  key={effort.value || "default"}
                                  onClick={() => {
                                    sendToSession(sessionId, {
                                      type: "set_codex_reasoning_effort",
                                      effort: effort.value,
                                    });
                                    setShowCodexReasoningDropdown(false);
                                  }}
                                  className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                                    effort.value === codexReasoningEffort ? "text-cc-primary font-medium" : "text-cc-fg"
                                  }`}
                                >
                                  {effort.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Bottom toolbar */}
            <div className="flex items-center justify-between px-2.5 pb-2.5">
              {/* Left: mode indicator */}
              <div className="flex items-center gap-1">
                {/* Plan / Agent single toggle */}
                <button
                  onClick={cycleMode}
                  disabled={!isConnected}
                  className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors select-none ${
                    !isConnected
                      ? "opacity-30 cursor-not-allowed text-cc-muted"
                      : isPlan
                        ? "bg-cc-primary/15 text-cc-primary cursor-pointer"
                        : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                  }`}
                  title={
                    isPlan
                      ? "Plan mode: agent creates a plan before executing (Shift+Tab to toggle)"
                      : "Agent mode: executes tools directly (Shift+Tab to toggle)"
                  }
                >
                  {isPlan ? (
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M2 3.5h12v1H2zm0 4h8v1H2zm0 4h10v1H2z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                      <path
                        d="M2.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                      <path
                        d="M8.5 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                  )}
                  <span>{isPlan ? "Plan" : "Agent"}</span>
                </button>

                {/* Ask Permission toggle (shield icon) + confirmation popover */}
                <div className="relative" ref={askConfirmRef}>
                  <button
                    onClick={toggleAskPermission}
                    disabled={!isConnected}
                    className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors select-none ${
                      !isConnected ? "opacity-30 cursor-not-allowed text-cc-muted" : "cursor-pointer hover:bg-cc-hover"
                    }`}
                    title={
                      askPermission
                        ? "Permissions: asking before tool use (click to change)"
                        : "Permissions: auto-approving tool use (click to change)"
                    }
                  >
                    {askPermission ? (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-primary">
                        <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                        <path
                          d="M6.5 8.5L7.5 9.5L10 7"
                          stroke="white"
                          strokeWidth="1.5"
                          fill="none"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : (
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        className="w-4 h-4 text-cc-muted"
                      >
                        <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                      </svg>
                    )}
                  </button>
                  {showAskConfirm && (
                    <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 p-3">
                      <p className="text-xs text-cc-fg mb-1 font-medium">
                        {askPermission ? "Disable permission prompts?" : "Enable permission prompts?"}
                      </p>
                      <p className="text-[11px] text-cc-muted mb-3 leading-relaxed">
                        This will restart the CLI session. Any in-progress operation will be interrupted. Your
                        conversation will be preserved.
                      </p>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setShowAskConfirm(false)}
                          className="px-2.5 py-1 text-[11px] rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={confirmAskPermissionChange}
                          className="px-2.5 py-1 text-[11px] rounded-md bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25 transition-colors cursor-pointer font-medium"
                        >
                          Restart
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Center: collapse toggle */}
              <CollapseAllButton sessionId={sessionId} />

              {/* Right: image + send/stop */}
              <div className="flex items-center gap-3 sm:gap-1">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!isConnected}
                  className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-lg transition-colors ${
                    isConnected
                      ? "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                      : "text-cc-muted opacity-30 cursor-not-allowed"
                  }`}
                  title="Upload image"
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="w-5 h-5 sm:w-4 sm:h-4"
                  >
                    <rect x="2" y="2" width="12" height="12" rx="2" />
                    <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                    <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                <button
                  onPointerEnter={warmMicrophone}
                  onClick={!voiceSupported ? () => toggleVoiceUnsupportedInfo(false) : handleMicClick}
                  disabled={voiceButtonDisabled}
                  aria-label="Voice input"
                  aria-disabled={!voiceSupported || voiceButtonDisabled}
                  className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-lg transition-colors ${
                    !voiceSupported || voiceButtonDisabled
                      ? "text-cc-muted opacity-30 cursor-not-allowed"
                      : isPreparing
                        ? "text-cc-warning bg-cc-warning/10 cursor-wait"
                        : isRecording
                          ? "text-red-500 bg-red-500/10 hover:bg-red-500/20 cursor-pointer"
                          : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                  }`}
                  title={voiceButtonTitle}
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    className={`w-5 h-5 sm:w-4 sm:h-4 ${isRecording || isPreparing ? "animate-pulse" : ""}`}
                  >
                    <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                    <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                  </svg>
                </button>

                {/* Unified send/stop button:
                   - Has text/images → Send (always, even while running)
                   - Empty + running → Stop
                   - Empty + idle → Send (disabled) */}
                {!canSend && isRunning ? (
                  <button
                    onClick={handleInterrupt}
                    className="flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-full transition-colors bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
                    title="Stop generation"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
                      <rect x="3" y="3" width="10" height="10" rx="1" />
                    </svg>
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-full transition-colors ${
                      canSend
                        ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                        : "bg-cc-hover text-cc-muted cursor-not-allowed"
                    } ${sendPressing ? "animate-[send-morph_500ms_ease-out]" : ""}`}
                    title="Send message"
                  >
                    {sendPressing ? (
                      <CatPawAvatar className="w-5 h-5 sm:w-4 sm:h-4" />
                    ) : (
                      <PaperPlaneIcon className="w-5 h-5 sm:w-4 sm:h-4" />
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
