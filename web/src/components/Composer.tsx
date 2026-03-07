import { useState, useRef, useEffect, useCallback, useMemo } from "react";
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
import { useVoiceInput } from "../hooks/useVoiceInput.js";
import { api } from "../api.js";
import {
  buildVsCodeSelectionPrompt,
  formatVsCodeSelectionSummary,
  getVsCodeSelectionSessionRoot,
  resolveVsCodeSelectionForSession,
  type VsCodeSelectionContextPayload,
} from "../utils/vscode-context.js";

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
async function ensureSupportedFormat(base64: string, mediaType: string): Promise<{ base64: string; mediaType: string }> {
  if (API_SUPPORTED_IMAGE_FORMATS.has(mediaType)) return { base64, mediaType };
  try {
    const blob = await fetch(`data:${mediaType};base64,${base64}`).then(r => r.blob());
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
  type: "command" | "skill";
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
  const text = draft?.text ?? "";
  const images = draft?.images ?? [];
  const setText = useCallback((t: string | ((prev: string) => string)) => {
    const store = useStore.getState();
    const current = store.composerDrafts.get(sessionId);
    const prevText = current?.text ?? "";
    const newText = typeof t === "function" ? t(prevText) : t;
    store.setComposerDraft(sessionId, { text: newText, images: current?.images ?? [] });
  }, [sessionId]);
  const setImages = useCallback((updater: ImageAttachment[] | ((prev: ImageAttachment[]) => ImageAttachment[])) => {
    const store = useStore.getState();
    const current = store.composerDrafts.get(sessionId);
    const prevImages = current?.images ?? [];
    const newImages = typeof updater === "function" ? updater(prevImages) : updater;
    store.setComposerDraft(sessionId, { text: current?.text ?? "", images: newImages });
  }, [sessionId]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showCodexReasoningDropdown, setShowCodexReasoningDropdown] = useState(false);
  const [showAskConfirm, setShowAskConfirm] = useState(false);
  const [dynamicCodexModels, setDynamicCodexModels] = useState<ModelOption[] | null>(null);
  const [sendPressing, setSendPressing] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);

  // @ mention file search state
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionResults, setMentionResults] = useState<Array<{ relativePath: string; absolutePath: string; fileName: string }>>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  // Tracks the cursor position of the `@` that triggered the menu
  const mentionAnchorRef = useRef<number>(-1);
  const mentionAbortRef = useRef<AbortController | null>(null);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const codexReasoningDropdownRef = useRef<HTMLDivElement>(null);
  const askConfirmRef = useRef<HTMLDivElement>(null);

  // Voice input — records audio via MediaRecorder, transcribes server-side
  const preRecordingTextRef = useRef({ before: "", after: "" });
  const {
    isRecording, isSupported: voiceSupported, unsupportedMessage: voiceUnsupportedMessage, isTranscribing,
    transcriptionPhase,
    error: voiceError, volumeLevel, setIsTranscribing, setTranscriptionPhase,
    setError: setVoiceError,
    toggleRecording,
  } = useVoiceInput({
    onAudioReady: async (blob) => {
      setIsTranscribing(true);
      setTranscriptionPhase("transcribing");
      try {
        const { before, after } = preRecordingTextRef.current;
        const { text: transcript } = await api.transcribe(blob, {
          sessionId,
          composerBefore: before || undefined,
          composerAfter: after || undefined,
          onPhase: (phase) => setTranscriptionPhase(phase),
        });
        const separator = before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
        const afterSep = after && !after.startsWith(" ") && !after.startsWith("\n") ? " " : "";
        setText(before + separator + transcript + afterSep + after);
      } catch (err) {
        setVoiceError(err instanceof Error ? err.message : "Transcription failed");
      } finally {
        setIsTranscribing(false);
        setTranscriptionPhase(null);
      }
    },
  });

  const handleMicClick = useCallback(() => {
    if (!voiceSupported) {
      setVoiceError(voiceUnsupportedMessage ?? "Voice input is unavailable.");
      return;
    }
    if (!isRecording) {
      const el = textareaRef.current;
      const cursorPos = el?.selectionStart ?? text.length;
      preRecordingTextRef.current = {
        before: text.slice(0, cursorPos),
        after: text.slice(cursorPos),
      };
    }
    toggleRecording();
  }, [isRecording, setVoiceError, text, toggleRecording, voiceSupported, voiceUnsupportedMessage]);

  // Narrow layout detection via media query (matches Tailwind's sm: breakpoint).
  // This controls layout only; keyboard behavior is tied to actual touch devices.
  const [isNarrowLayout, setIsNarrowLayout] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return !window.matchMedia("(min-width: 640px)").matches; }
    catch { return false; }
  });
  const usesTouchKeyboard = isTouchDevice();
  useEffect(() => {
    let mql: MediaQueryList;
    try { mql = window.matchMedia("(min-width: 640px)"); }
    catch { return; }
    const handler = (e: MediaQueryListEvent) => setIsNarrowLayout(!e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

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

  const cliConnected = useStore((s) => s.cliConnected);
  const sessionData = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions?.find((x) => x.sessionId === sessionId));
  const diffLinesAdded = sessionData?.total_lines_added ?? sdkSession?.totalLinesAdded ?? 0;
  const diffLinesRemoved = sessionData?.total_lines_removed ?? sdkSession?.totalLinesRemoved ?? 0;
  const vscodeSelectionContext = useStore((s) => s.vscodeSelectionContext);

  const isConnected = cliConnected.get(sessionId) ?? false;
  const currentMode = sessionData?.permissionMode || "acceptEdits";
  const isCodex = sessionData?.backend_type === "codex";
  const askPermission = useStore((s) => {
    const explicit = s.askPermission.get(sessionId);
    if (typeof explicit === "boolean") return explicit;
    return isCodex ? deriveCodexAskPermission(currentMode) : true;
  });
  // Prefer the server-provided UI mode when available. permissionMode can be
  // stale during backend transitions (e.g., SDK init/status replay) while uiMode
  // is the authoritative virtual mode for the composer toggle.
  const uiMode = sessionData?.uiMode
    ?? (isCodex ? deriveCodexUiMode(currentMode) : deriveUiMode(currentMode));
  const isPlan = uiMode === "plan";
  const codexReasoningEffort = sessionData?.codex_reasoning_effort || "";
  const codexModelOptions = dynamicCodexModels || getModelsForBackend("codex");
  const sessionSelectionRoot = getVsCodeSelectionSessionRoot(sessionData?.repo_root, sessionData?.cwd);
  const vscodeSelectionPayload: VsCodeSelectionContextPayload | null = vscodeSelectionContext
    ? resolveVsCodeSelectionForSession(vscodeSelectionContext, sessionSelectionRoot)
    : null;

  useEffect(() => {
    if (!isCodex) return;
    let cancelled = false;
    api.getBackendModels("codex").then((models) => {
      if (cancelled || models.length === 0) return;
      setDynamicCodexModels(toModelOptions(models));
    }).catch(() => {
      // Fall back to static model list silently.
    });
    return () => { cancelled = true; };
  }, [isCodex]);

  // Build command list from session data
  const allCommands = useMemo<CommandItem[]>(() => {
    const cmds: CommandItem[] = [];
    if (sessionData?.slash_commands) {
      for (const cmd of sessionData.slash_commands) {
        cmds.push({ name: cmd, type: "command" });
      }
    }
    if (sessionData?.skills) {
      for (const skill of sessionData.skills) {
        cmds.push({ name: skill, type: "skill" });
      }
    }
    return cmds;
  }, [sessionData?.slash_commands, sessionData?.skills]);

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

  // ─── @ mention file search ─────────────────────────────────────

  // Derive the search root from session state (repo_root preferred, cwd fallback)
  const mentionSearchRoot = useMemo(() => {
    const cwd = sessionData?.cwd;
    const repoRoot = sessionData?.repo_root;
    if (repoRoot && cwd?.startsWith(repoRoot + "/")) return repoRoot;
    return cwd || repoRoot || null;
  }, [sessionData?.cwd, sessionData?.repo_root]);

  // Detect `@` at cursor position and extract query for file search.
  // Called from handleInput — scans backward from cursor to find `@`.
  const detectMentionQuery = useCallback((inputText: string, cursorPos: number) => {
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
  }, [mentionMenuOpen, mentionSearchRoot]);

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

  const selectMention = useCallback((result: { relativePath: string }) => {
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
  }, [text, setText]);

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

  const selectCommand = useCallback((cmd: CommandItem) => {
    setText(`/${cmd.name} `);
    setSlashMenuOpen(false);
    textareaRef.current?.focus();
  }, []);

  async function handleSend() {
    const msg = text.trim();
    if ((!msg && images.length === 0) || !isConnected) return;

    // Auto-answer pending AskUserQuestion if user types a response.
    // The typed text becomes the "Other..." answer for each question.
    // No separate user_message is sent — the answer IS the user's message.
    if (pendingAskUserPerm) {
      const questions = Array.isArray(pendingAskUserPerm.input?.questions)
        ? pendingAskUserPerm.input.questions as Record<string, unknown>[]
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
      sendToSession(sessionId, { type: "interrupt" });
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
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        if (isTouchDevice()) textareaRef.current?.blur();
        else textareaRef.current?.focus();
        return;
      }
    }

    const sent = sendToSession(sessionId, {
      type: "user_message",
      content: msg,
      session_id: sessionId,
      ...(vscodeSelectionPayload ? { vscodeSelection: vscodeSelectionPayload } : {}),
      images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
    });

    if (!sent) return; // WebSocket not open — keep draft so user can retry

    // User message will appear in the feed when the server broadcasts it back
    // (server-authoritative model — browsers never add user messages locally)
    useStore.getState().clearComposerDraft(sessionId);
    setSlashMenuOpen(false);
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

  // Double-Shift shortcut: toggle voice recording when Shift is pressed
  // twice within 400ms (JetBrains "Search Everywhere" pattern).
  // Escape also stops an active recording.
  useEffect(() => {
    if (!voiceSupported) return;
    let lastShiftUp = 0;
    let otherKeyPressed = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Shift") otherKeyPressed = true;
      if (e.key === "Escape" && isRecording) handleMicClick();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      if (otherKeyPressed) { otherKeyPressed = false; lastShiftUp = 0; return; }
      const now = Date.now();
      if (now - lastShiftUp < 400) {
        lastShiftUp = 0;
        if (!isConnected || isTranscribing) return;
        handleMicClick();
      } else {
        lastShiftUp = now;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [voiceSupported, isRecording, isConnected, isTranscribing, handleMicClick]);

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
      if (e.key === "Enter" && !e.shiftKey) {
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
      if (e.key === "Enter" && !e.shiftKey) {
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
    if (e.key === "Enter" && !e.shiftKey && !usesTouchKeyboard) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    isUserInput.current = true;
    const newText = e.target.value;
    const cursorPos = e.target.selectionStart;
    setText(newText);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    // Trigger @ mention detection at current cursor position
    detectMentionQuery(newText, cursorPos);
  }

  function handleInterrupt() {
    sendToSession(sessionId, { type: "interrupt" });
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const newImages: ImageAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const raw = await readFileAsBase64(file);
      const { base64, mediaType } = await ensureSupportedFormat(raw.base64, raw.mediaType);
      newImages.push({ name: file.name, base64, mediaType });
    }
    setImages((prev) => [...prev, ...newImages]);
    e.target.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImages: ImageAttachment[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const raw = await readFileAsBase64(file);
      const { base64, mediaType } = await ensureSupportedFormat(raw.base64, raw.mediaType);
      newImages.push({ name: `pasted-${Date.now()}.${mediaType.split("/")[1] || "jpeg"}`, base64, mediaType });
    }
    if (newImages.length > 0) {
      e.preventDefault();
      setImages((prev) => [...prev, ...newImages]);
    }
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

  const sessionStatus = useStore((s) => s.sessionStatus);
  const isRunning = sessionStatus.get(sessionId) === "running";
  const canSend = (text.trim().length > 0 || images.length > 0) && isConnected;

  // Mobile collapsible composer — collapse when empty (no text, no images), regardless of streaming
  const isCollapsed = usesTouchKeyboard && isNarrowLayout && !composerExpanded && !text.trim() && images.length === 0;

  // Auto-collapse when composer becomes empty (after send clears text)
  useEffect(() => {
    if (!usesTouchKeyboard || !isNarrowLayout) return;
    if (!text.trim() && images.length === 0) {
      const timer = setTimeout(() => setComposerExpanded(false), 300);
      return () => clearTimeout(timer);
    }
  }, [usesTouchKeyboard, isNarrowLayout, text, images.length]);

  // Collapse on tap outside the composer when empty
  const composerRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!usesTouchKeyboard || !isNarrowLayout || isCollapsed) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (!text.trim() && images.length === 0 && composerRootRef.current && !composerRootRef.current.contains(e.target as Node)) {
        setComposerExpanded(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [usesTouchKeyboard, isNarrowLayout, isCollapsed, text, images.length]);

  const expandComposer = useCallback(() => {
    textareaRef.current?.focus(); // synchronous focus triggers mobile virtual keyboard
    setComposerExpanded(true);
  }, []);

  const imageSrcs = useMemo(
    () => images.map((img) => ({ src: `data:${img.mediaType};base64,${img.base64}`, name: img.name })),
    [images],
  );
  const voiceButtonTitle = voiceError
    || voiceUnsupportedMessage
    || (isTranscribing ? (transcriptionPhase === "enhancing" ? "Enhancing..." : "Transcribing...") : isRecording ? "Stop recording" : "Voice input");
  const voiceButtonDisabled = !voiceSupported || !isConnected || isTranscribing;
  const compactVoiceButtonDisabled = voiceButtonDisabled || isRunning;

  return (
    <div ref={composerRootRef} className={`shrink-0 border-t border-cc-border bg-cc-card ${isCollapsed ? "" : "px-2 sm:px-4 py-2 sm:py-3"}`}>
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
                    <path d="M2.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <path d="M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                )}
                {isPlan ? "Plan" : "Agent"}
              </span>
              <span className="flex-1 text-sm text-cc-muted text-left truncate">Type a message...</span>
            </button>
            <button
              onClick={() => {
                setComposerExpanded(true);
                handleMicClick();
              }}
              disabled={compactVoiceButtonDisabled}
              aria-label="Voice input"
              className={`flex items-center justify-center w-10 h-10 rounded-lg transition-colors shrink-0 ${
                compactVoiceButtonDisabled
                  ? "text-cc-muted opacity-30 cursor-not-allowed"
                  : isRecording
                  ? "text-red-500 bg-red-500/10 hover:bg-red-500/20 cursor-pointer"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
              }`}
              title={voiceButtonTitle}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className={`w-5 h-5 ${isRecording ? "animate-pulse" : ""}`}>
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
                    onClick={(e) => { e.stopPropagation(); removeImage(i); }}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                    </svg>
                  </button>
                </div>
              ))}
          </div>
        )}
        {lightboxSrc && (
          <Lightbox
            src={lightboxSrc}
            alt="attachment"
            onClose={() => setLightboxSrc(null)}
          />
        )}

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
        <div className={`relative bg-cc-input-bg border rounded-[14px] overflow-visible transition-colors ${
          isPlan
            ? "border-cc-primary/40"
            : "border-cc-border focus-within:border-cc-primary/30"
        }`}>
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
                    i === slashMenuIndex
                      ? "bg-cc-hover"
                      : "hover:bg-cc-hover/50"
                  }`}
                >
                  <span className="flex items-center justify-center w-6 h-6 rounded-md bg-cc-hover text-cc-muted shrink-0">
                    {cmd.type === "skill" ? (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                        <path d="M8 1l1.796 3.64L14 5.255l-3 2.924.708 4.126L8 10.5l-3.708 1.805L5 8.18 2 5.255l4.204-.615L8 1z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
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

          {/* @ mention file search menu */}
          {mentionMenuOpen && !slashMenuOpen && (
            <div
              ref={mentionMenuRef}
              className="absolute left-2 right-2 bottom-full mb-1 max-h-[240px] overflow-y-auto bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-20 py-1"
            >
              {mentionQuery.length < 3 ? (
                <div className="px-3 py-2.5 text-[12px] text-cc-muted flex items-center gap-2">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5 shrink-0 opacity-50">
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
                <div className="px-3 py-2.5 text-[12px] text-cc-muted">
                  No files found for "{mentionQuery}"
                </div>
              ) : (
                mentionResults.map((result, i) => (
                  <button
                    key={result.relativePath}
                    data-mention-index={i}
                    onClick={() => selectMention(result)}
                    className={`w-full px-3 py-1.5 text-left flex items-center gap-2.5 transition-colors cursor-pointer ${
                      i === mentionIndex
                        ? "bg-cc-hover"
                        : "hover:bg-cc-hover/50"
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
                      height: volumeLevel > threshold ? `${Math.min(12, 4 + (volumeLevel - threshold) * 20)}px` : "3px",
                      backgroundColor: volumeLevel > threshold ? "rgb(239 68 68)" : "rgb(239 68 68 / 0.3)",
                    }}
                  />
                ))}
              </div>
            </div>
          )}
          {isTranscribing && !isRecording && (
            <div className="flex items-center gap-2 px-4 pt-2 text-[11px] text-cc-primary">
              <span className="w-2 h-2 rounded-full bg-cc-primary animate-pulse" />
              <span>{transcriptionPhase === "enhancing" ? "Enhancing..." : "Transcribing..."}</span>
            </div>
          )}
          {(voiceError || (voiceUnsupportedMessage && isNarrowLayout)) && !isRecording && !isTranscribing && (
            <div className="px-4 pt-2 text-[11px] text-cc-warning">{voiceError || voiceUnsupportedMessage}</div>
          )}

          <div className="relative">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              enterKeyHint={isTouchDevice() ? "enter" : undefined}
              placeholder={
                pendingAskUserPerm
                  ? "Type your answer..."
                  : pendingPlanPerm
                    ? "Type to reject plan and send new instructions..."
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
          {(sessionData?.git_branch || sessionData?.model || vscodeSelectionPayload) && (
            <div className="flex items-center gap-2 px-2 sm:px-4 pb-1 text-[11px] text-cc-muted">
              {sessionData?.git_branch && (
                <span className="flex items-center gap-1 truncate min-w-0">
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                    <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                  </svg>
                  <span className="truncate max-w-[100px] sm:max-w-[160px]">{sessionData.git_branch}</span>
                  {sessionData.is_containerized && (
                    <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1 rounded">container</span>
                  )}
                </span>
              )}
              {((sessionData?.git_ahead || 0) > 0 || (sessionData?.git_behind || 0) > 0) && (
                <span className="flex items-center gap-0.5 text-[10px]">
                  {(sessionData?.git_ahead || 0) > 0 && <span className="text-green-500">{sessionData?.git_ahead}&#8593;</span>}
                  {(sessionData?.git_behind || 0) > 0 && (
                    <span className="text-cc-warning">{sessionData?.git_behind}&#8595;</span>
                  )}
                </span>
              )}
              {(diffLinesAdded > 0 || diffLinesRemoved > 0) && (
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-green-500">+{diffLinesAdded}</span>
                  <span className="text-red-400">-{diffLinesRemoved}</span>
                </span>
              )}
              {sessionData?.model && (
                <>
                  {sessionData?.git_branch && <span className="text-cc-muted/40">&middot;</span>}
                  {!isCodex ? (
                    <div className="relative" ref={modelDropdownRef}>
                      <button
                        onClick={() => setShowModelDropdown(!showModelDropdown)}
                        disabled={!isConnected}
                        className={`flex items-center gap-0.5 font-mono-code truncate transition-colors select-none ${
                          !isConnected
                            ? "opacity-30 cursor-not-allowed"
                            : "hover:text-cc-fg cursor-pointer"
                        }`}
                        title={`Model: ${sessionData.model} (click to change)`}
                      >
                        <span className="truncate">{formatModel(sessionData.model)}</span>
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                          <path d="M4 6l4 4 4-4" />
                        </svg>
                      </button>
                      {showModelDropdown && (
                        <div className="absolute left-0 bottom-full mb-1 w-52 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                          {getModelsForBackend("claude").filter((m) => m.value !== "").map((m) => (
                            <button
                              key={m.value}
                              onClick={() => {
                                sendToSession(sessionId, { type: "set_model", model: m.value });
                                setShowModelDropdown(false);
                              }}
                              className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                                m.value === sessionData.model ? "text-cc-primary font-medium" : "text-cc-fg"
                              }`}
                            >
                              <span className="mr-1.5">{m.icon}</span>{m.label}
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
                            !isConnected
                              ? "opacity-30 cursor-not-allowed"
                              : "hover:text-cc-fg cursor-pointer"
                          }`}
                          title={`Model: ${sessionData.model} (relaunch required)`}
                        >
                          <span className="truncate">{formatModel(sessionData.model)}</span>
                          <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                            <path d="M4 6l4 4 4-4" />
                          </svg>
                        </button>
                        {showModelDropdown && (
                          <div className="absolute left-0 bottom-full mb-1 w-52 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                            {codexModelOptions.map((m) => (
                              <button
                                key={m.value}
                                onClick={() => {
                                  sendToSession(sessionId, { type: "set_model", model: m.value });
                                  setShowModelDropdown(false);
                                }}
                                className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                                  m.value === sessionData.model ? "text-cc-primary font-medium" : "text-cc-fg"
                                }`}
                              >
                                <span className="mr-1.5">{m.icon}</span>{m.label}
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
                            !isConnected
                              ? "opacity-30 cursor-not-allowed"
                              : "hover:text-cc-fg cursor-pointer"
                          }`}
                          title="Reasoning effort (relaunch required)"
                        >
                          <span>{CODEX_REASONING_EFFORTS.find((x) => x.value === codexReasoningEffort)?.label.toLowerCase() || "default"}</span>
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
                                  sendToSession(sessionId, { type: "set_codex_reasoning_effort", effort: effort.value });
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
              {vscodeSelectionPayload && (
                <>
                  {(sessionData?.git_branch || sessionData?.model) && <span className="text-cc-muted/40">&middot;</span>}
                  <span
                    className="inline-flex max-w-[132px] shrink min-w-0 items-center rounded-md border border-cc-border/70 bg-cc-hover/55 px-1.5 py-0.5 text-[10px] font-medium text-cc-muted"
                    title={buildVsCodeSelectionPrompt(vscodeSelectionPayload)}
                  >
                    <span className="truncate">{formatVsCodeSelectionSummary(vscodeSelectionPayload)}</span>
                  </span>
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
                title={isPlan
                  ? "Plan mode: agent creates a plan before executing (Shift+Tab to toggle)"
                  : "Agent mode: executes tools directly (Shift+Tab to toggle)"}
              >
                {isPlan ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M2 3.5h12v1H2zm0 4h8v1H2zm0 4h10v1H2z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M2.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <path d="M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
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
                    !isConnected
                      ? "opacity-30 cursor-not-allowed text-cc-muted"
                      : "cursor-pointer hover:bg-cc-hover"
                  }`}
                  title={askPermission
                    ? "Permissions: asking before tool use (click to change)"
                    : "Permissions: auto-approving tool use (click to change)"}
                >
                  {askPermission ? (
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-primary">
                      <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                      <path d="M6.5 8.5L7.5 9.5L10 7" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-4 h-4 text-cc-muted">
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
                      This will restart the CLI session. Any in-progress operation will be interrupted. Your conversation will be preserved.
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
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5 sm:w-4 sm:h-4">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                  <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              <button
                onClick={handleMicClick}
                disabled={voiceButtonDisabled}
                aria-label="Voice input"
                className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-lg transition-colors ${
                  voiceButtonDisabled
                    ? "text-cc-muted opacity-30 cursor-not-allowed"
                    : isRecording
                    ? "text-red-500 bg-red-500/10 hover:bg-red-500/20 cursor-pointer"
                    : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                }`}
                title={voiceButtonTitle}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className={`w-5 h-5 sm:w-4 sm:h-4 ${isRecording ? "animate-pulse" : ""}`}>
                  <path d="M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1z" />
                  <path d="M3.5 7a.5.5 0 0 1 .5.5v.5a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0v.5a5 5 0 0 1-4.5 4.975V14.5h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.525A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z" />
                </svg>
              </button>

              {/* Stop button — always rendered so the voice/send buttons never shift.
                   Disabled (greyed out) when idle, active when running. */}
              <button
                onClick={handleInterrupt}
                disabled={!isRunning}
                className={`flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-lg transition-colors ${
                  isRunning
                    ? "bg-cc-error/10 hover:bg-cc-error/20 text-cc-error cursor-pointer"
                    : "text-cc-muted/30 cursor-not-allowed"
                }`}
                title="Stop generation"
                tabIndex={isRunning ? 0 : -1}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
              </button>
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
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
