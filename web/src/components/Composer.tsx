import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useStore } from "../store.js";
import { sendToSession } from "../ws.js";
import { CLAUDE_MODES, CODEX_MODES, getNextMode, resolveClaudeCliMode, deriveUiMode } from "../utils/backends.js";
import { isTouchDevice } from "../utils/mobile.js";
import type { ModeOption } from "../utils/backends.js";
import { Lightbox } from "./Lightbox.js";
import { CatPawAvatar } from "./CatIcons.js";

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
      // Expand the last turn by toggling it (removes the false override)
      const lastId = collapsibleTurnIds[collapsibleTurnIds.length - 1];
      store.toggleTurnActivity(sessionId, lastId, true);
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
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showAskConfirm, setShowAskConfirm] = useState(false);
  const [sendPressing, setSendPressing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const askConfirmRef = useRef<HTMLDivElement>(null);

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
  // Total diff lines from per-file stats (same source as the diff view)
  const diffLinesAdded = useStore((s) => {
    const stats = s.diffFileStats.get(sessionId);
    if (!stats || stats.size === 0) return 0;
    let t = 0;
    for (const st of stats.values()) t += st.additions;
    return t;
  });
  const diffLinesRemoved = useStore((s) => {
    const stats = s.diffFileStats.get(sessionId);
    if (!stats || stats.size === 0) return 0;
    let t = 0;
    for (const st of stats.values()) t += st.deletions;
    return t;
  });

  const isConnected = cliConnected.get(sessionId) ?? false;
  const currentMode = sessionData?.permissionMode || "acceptEdits";
  const isCodex = sessionData?.backend_type === "codex";
  const askPermission = useStore((s) => s.askPermission.get(sessionId) ?? true);

  // For Claude Code: derive UI mode from the CLI mode
  const uiMode = isCodex ? currentMode : deriveUiMode(currentMode);
  const isPlan = uiMode === "plan";

  // Codex uses its own modes; Claude uses the new plan/agent modes
  const modes: ModeOption[] = isCodex ? CODEX_MODES : CLAUDE_MODES;
  const modeLabel = isCodex
    ? (modes.find((m) => m.value === currentMode)?.label?.toLowerCase() || currentMode)
    : uiMode;

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

  // Close mode dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setShowModeDropdown(false);
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

  function handleSend() {
    const msg = text.trim();
    if (!msg || !isConnected) return;

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

    const sent = sendToSession(sessionId, {
      type: "user_message",
      content: msg,
      session_id: sessionId,
      images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
    });

    if (!sent) return; // WebSocket not open — keep draft so user can retry

    // User message will appear in the feed when the server broadcasts it back
    // (server-authoritative model — browsers never add user messages locally)
    useStore.getState().clearComposerDraft(sessionId);
    setSlashMenuOpen(false);

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

    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    isUserInput.current = true;
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
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
      // Server will broadcast the updated permissionMode to all browsers
      sendToSession(sessionId, { type: "set_permission_mode", mode });
      return;
    }
    // Claude Code: resolve the UI mode + askPermission to the actual CLI mode
    const cliMode = resolveClaudeCliMode(mode, askPermission);
    // Server will broadcast the updated permissionMode and uiMode to all browsers
    sendToSession(sessionId, { type: "set_permission_mode", mode: cliMode });
  }

  function toggleAskPermission() {
    if (!isConnected || isCodex) return;
    setShowAskConfirm(true);
  }

  function confirmAskPermissionChange() {
    const newValue = !askPermission;
    sendToSession(sessionId, { type: "set_ask_permission", askPermission: newValue });
    setShowAskConfirm(false);
  }

  function cycleMode() {
    if (isCodex) {
      selectMode(getNextMode(currentMode, modes));
    } else {
      // Claude: toggle between plan and agent
      selectMode(uiMode === "plan" ? "agent" : "plan");
    }
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
  const canSend = text.trim().length > 0 && isConnected;

  const imageSrcs = useMemo(
    () => images.map((img) => ({ src: `data:${img.mediaType};base64,${img.base64}`, name: img.name })),
    [images],
  );

  return (
    <div className="shrink-0 border-t border-cc-border bg-cc-card px-2 sm:px-4 py-2 sm:py-3">
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

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            enterKeyHint={isTouchDevice() ? "send" : undefined}
            placeholder={
              pendingAskUserPerm
                ? "Type your answer..."
                : pendingPlanPerm
                  ? "Type to reject plan and send new instructions..."
                  : "Type a message... (/ for commands)"
            }
            rows={1}
            className="w-full px-4 pt-3 pb-1 text-base sm:text-sm bg-transparent resize-none focus:outline-none text-cc-fg font-sans-ui placeholder:text-cc-muted disabled:opacity-50 overflow-y-auto"
            style={{ minHeight: "36px", maxHeight: "200px" }}
          />

          {/* Git branch + lines info */}
          {sessionData?.git_branch && (
            <div className="hidden sm:flex items-center gap-2 px-2 sm:px-4 pb-1 text-[11px] text-cc-muted overflow-hidden">
              <span className="flex items-center gap-1 truncate min-w-0">
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0 opacity-60">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                </svg>
                <span className="truncate max-w-[100px] sm:max-w-[160px]">{sessionData.git_branch}</span>
                {sessionData.is_containerized && (
                  <span className="text-[10px] bg-blue-500/10 text-blue-400 px-1 rounded">container</span>
                )}
              </span>
              {((sessionData.git_ahead || 0) > 0 || (sessionData.git_behind || 0) > 0) && (
                <span className="flex items-center gap-0.5 text-[10px]">
                  {(sessionData.git_ahead || 0) > 0 && <span className="text-green-500">{sessionData.git_ahead}&#8593;</span>}
                  {(sessionData.git_behind || 0) > 0 && (
                    <span className="text-cc-warning">{sessionData.git_behind}&#8595;</span>
                  )}
                </span>
              )}
              {(diffLinesAdded > 0 || diffLinesRemoved > 0) && (
                <span className="flex items-center gap-1 shrink-0">
                  <span className="text-green-500">+{diffLinesAdded}</span>
                  <span className="text-red-400">-{diffLinesRemoved}</span>
                </span>
              )}
            </div>
          )}

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-2.5 pb-2.5">
            {/* Left: mode indicator */}
            {isCodex ? (
              /* Codex sessions: keep the existing dropdown unchanged */
              <div className="relative" ref={modeDropdownRef}>
                <button
                  onClick={() => setShowModeDropdown(!showModeDropdown)}
                  disabled={!isConnected}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium transition-all select-none ${
                    !isConnected
                      ? "opacity-30 cursor-not-allowed text-cc-muted"
                      : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
                  }`}
                  title="Change mode"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M2.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    <path d="M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                  <span>{modeLabel}</span>
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                {showModeDropdown && (
                  <div className="absolute left-0 bottom-full mb-1 w-40 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                    {modes.map((m) => (
                      <button
                        key={m.value}
                        onClick={() => { selectMode(m.value); setShowModeDropdown(false); }}
                        className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                          m.value === currentMode ? "text-cc-primary font-medium" : "text-cc-fg"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              /* Claude Code sessions: Plan/Agent toggle + Ask Permission switch */
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
                    ? "Plan mode: Claude creates a plan before executing (Shift+Tab to toggle)"
                    : "Agent mode: Claude executes tools directly (Shift+Tab to toggle)"}
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
            )}

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
                onClick={() => {
                  if (!textareaRef.current) return;
                  const ta = textareaRef.current;
                  const start = ta.selectionStart;
                  const end = ta.selectionEnd;
                  const val = ta.value;
                  const setter = Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, "value"
                  )?.set;
                  setter?.call(ta, val.substring(0, start) + "\n" + val.substring(end));
                  ta.dispatchEvent(new Event("input", { bubbles: true }));
                  requestAnimationFrame(() => {
                    ta.selectionStart = ta.selectionEnd = start + 1;
                    ta.style.height = "auto";
                    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
                  });
                  ta.focus();
                }}
                className={`${isRunning ? "hidden" : "flex"} sm:hidden items-center justify-center w-11 h-11 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer`}
                title="Insert newline"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                  <path d="M12 3v6a2 2 0 0 1-2 2H4" />
                  <path d="M6 9L3.5 11.5 6 14" />
                </svg>
              </button>

              {isRunning && (
                <button
                  onClick={handleInterrupt}
                  className="flex items-center justify-center w-11 h-11 sm:w-8 sm:h-8 rounded-lg bg-cc-error/10 hover:bg-cc-error/20 text-cc-error transition-colors cursor-pointer"
                  title="Stop generation"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 sm:w-3.5 sm:h-3.5">
                    <rect x="3" y="3" width="10" height="10" rx="1" />
                  </svg>
                </button>
              )}
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
  );
}
