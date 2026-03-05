import { useRef, useCallback, useState, type RefObject } from "react";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { deriveSessionStatus, type SessionVisualStatus } from "./SessionStatusDot.js";
import { useStore } from "../store.js";
import { getHighlightParts } from "../utils/highlight.js";

type SearchMatchedField =
  | "name"
  | "task"
  | "keyword"
  | "branch"
  | "path"
  | "repo"
  | "user_message";

const SEARCH_MATCH_LABELS: Record<SearchMatchedField, string> = {
  name: "name",
  task: "task",
  keyword: "keyword",
  branch: "branch",
  path: "path",
  repo: "repo",
  user_message: "message",
};

const STRIPE_COLOR_CLASS: Record<SessionVisualStatus, string> = {
  archived: "bg-cc-muted/45",
  permission: "bg-amber-400",
  disconnected: "bg-cc-muted/60",
  running: "bg-emerald-500",
  compacting: "bg-emerald-500",
  completed_unread: "bg-blue-500",
  idle: "bg-cc-muted/50",
};

function timeAgo(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface SessionItemProps {
  session: SessionItemType;
  isActive: boolean;
  isArchived?: boolean;
  sessionName: string | undefined;
  sessionPreview?: string;
  permCount: number;
  isRecentlyRenamed: boolean;
  onSelect: (id: string) => void;
  onStartRename: (id: string, currentName: string) => void;
  onArchive: (e: React.MouseEvent, id: string) => void;
  onUnarchive: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string) => void;
  onClearRecentlyRenamed: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, id: string) => void;
  onHoverStart?: (sessionId: string, rect: DOMRect) => void;
  onHoverEnd?: () => void;
  editingSessionId: string | null;
  editingName: string;
  setEditingName: (name: string) => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  editInputRef: RefObject<HTMLInputElement | null>;
  confirmArchiveId?: string | null;
  onConfirmArchive?: () => void;
  onCancelArchive?: () => void;
  attention?: "action" | "error" | "review" | null;
  hasUnread?: boolean;
  reorderMode?: boolean;
  dragHandleProps?: {
    listeners?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
  };
  /** Hover-linked herd relationship highlight in sidebar. */
  herdHoverHighlight?: "leader" | "worker";
  /** When set, shows why this session matched a search query (e.g. "keyword: zustand") */
  matchContext?: string | null;
  matchedField?: SearchMatchedField;
  matchQuery?: string;
}

export function SessionItem({
  session: s,
  isActive,
  isArchived: archived,
  sessionName,
  sessionPreview,
  permCount,
  isRecentlyRenamed,
  onSelect,
  onStartRename,
  onArchive,
  onUnarchive,
  onDelete,
  onClearRecentlyRenamed,
  onContextMenu: onCtxMenu,
  onHoverStart,
  onHoverEnd,
  editingSessionId,
  editingName,
  setEditingName,
  onConfirmRename,
  onCancelRename,
  editInputRef,
  confirmArchiveId,
  onConfirmArchive,
  onCancelArchive,
  attention,
  hasUnread,
  reorderMode,
  dragHandleProps,
  herdHoverHighlight,
  matchContext,
  matchedField,
  matchQuery,
}: SessionItemProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swipeActive = useRef(false);
  const suppressTap = useRef(false);
  const [swipeOffsetPx, setSwipeOffsetPx] = useState(0);
  const shortId = s.id.slice(0, 8);
  const label = sessionName || s.model || shortId;
  const isEditing = editingSessionId === s.id;
  const isQuestNamed = useStore((st) => st.questNamedSessions.has(s.id));
  const questStatus = useStore((st) => st.sessions.get(s.id)?.claimedQuestStatus);
  const canSwipeToArchive = !archived && !reorderMode;

  // Long-press to open context menu on touch devices
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    swipeStart.current = { x: touch.clientX, y: touch.clientY };
    swipeActive.current = false;
    setSwipeOffsetPx(0);
    if (!onCtxMenu || reorderMode) return;
    const cx = touch.clientX;
    const cy = touch.clientY;
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      suppressTap.current = true;
      onCtxMenu({ preventDefault: () => {}, stopPropagation: () => {}, clientX: cx, clientY: cy } as React.MouseEvent, s.id);
    }, 500);
  }, [onCtxMenu, reorderMode, s.id]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const triggerArchiveFromSwipe = useCallback(() => {
    const synthetic = { preventDefault: () => {}, stopPropagation: () => {} } as React.MouseEvent;
    onArchive(synthetic, s.id);
  }, [onArchive, s.id]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const start = swipeStart.current;
    if (!start) {
      cancelLongPress();
      return;
    }
    const touch = e.touches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!swipeActive.current) {
      const isHorizontalSwipe = Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) + 4;
      if (isHorizontalSwipe && canSwipeToArchive) {
        swipeActive.current = true;
        suppressTap.current = true;
      }
      if (isHorizontalSwipe || Math.abs(dy) > 8) {
        cancelLongPress();
      }
    }
    if (swipeActive.current) {
      const clampedDx = Math.max(-120, Math.min(120, dx));
      setSwipeOffsetPx(clampedDx);
      e.preventDefault();
    }
  }, [cancelLongPress, canSwipeToArchive]);

  const handleTouchEnd = useCallback(() => {
    cancelLongPress();
    if (swipeActive.current) {
      const shouldArchive = Math.abs(swipeOffsetPx) >= 72 && canSwipeToArchive;
      swipeActive.current = false;
      setSwipeOffsetPx(0);
      if (shouldArchive) {
        triggerArchiveFromSwipe();
      }
    }
    swipeStart.current = null;
  }, [cancelLongPress, canSwipeToArchive, swipeOffsetPx, triggerArchiveFromSwipe]);

  const handleTouchCancel = useCallback(() => {
    cancelLongPress();
    swipeStart.current = null;
    swipeActive.current = false;
    setSwipeOffsetPx(0);
  }, [cancelLongPress]);

  const handleSelect = useCallback(() => {
    if (suppressTap.current) {
      suppressTap.current = false;
      return;
    }
    onSelect(s.id);
  }, [onSelect, s.id]);

  // Backend icon source
  const backendLogo = s.backendType === "codex" ? "/logo-codex.svg" : "/logo.png";
  const backendAlt = s.backendType === "codex" ? "Codex" : s.backendType === "claude-sdk" ? "Claude SDK" : "Claude";
  const hasBranchDivergence = s.gitAhead > 0 || s.gitBehind > 0;
  const hasLineDiff = s.linesAdded > 0 || s.linesRemoved > 0;
  const showingSwipeBackdrop = canSwipeToArchive && Math.abs(swipeOffsetPx) > 0;
  const herdHighlightClass = herdHoverHighlight === "leader"
    ? "ring-1 ring-amber-400/70"
    : herdHoverHighlight === "worker"
      ? "ring-1 ring-amber-400/45"
      : "";
  const displayMatch = !isEditing
    ? (() => {
      const raw = (matchContext || "").trim();
      const prefixMatch = raw.match(/^([a-z_]+):\s*(.*)$/i);
      const snippet = (prefixMatch?.[2] ?? raw).trim();
      const fieldLabel = matchedField ? SEARCH_MATCH_LABELS[matchedField] : null;
      const finalFieldLabel = fieldLabel || (prefixMatch?.[1] ? prefixMatch[1].toLowerCase() : null);
      const fallbackSnippet = matchedField === "name" ? label : "";
      const finalSnippet = snippet || fallbackSnippet;
      if (!finalFieldLabel || !finalSnippet) return null;
      return { fieldLabel: `${finalFieldLabel}:`, snippet: finalSnippet };
    })()
    : null;
  const visualStatus = deriveSessionStatus({
    archived: !!archived,
    permCount,
    isConnected: s.isConnected,
    sdkState: s.sdkState,
    status: s.status,
    hasUnread,
    idleKilled: s.idleKilled,
  });
  const stripeClass = STRIPE_COLOR_CLASS[visualStatus];
  const stripeGlowColor = visualStatus === "permission"
    ? "rgba(245, 158, 11, 0.7)"
    : visualStatus === "running" || visualStatus === "compacting"
      ? "rgba(34, 197, 94, 0.7)"
      : "";
  const stripeGlowStyle: React.CSSProperties | undefined = stripeGlowColor
    ? {
        ["--glow-color" as string]: stripeGlowColor,
        animation: "yarn-glow-breathe 2s ease-in-out infinite",
      }
    : undefined;

  const renderHighlightedSnippet = (text: string): React.ReactNode => {
    const parts = getHighlightParts(text, matchQuery || "");
    if (!parts.some((part) => part.matched)) return text;
    return (
      <>
        {parts.map((part, index) =>
          part.matched ? (
            <mark
              key={`${part.text}-${index}`}
              className="bg-amber-300/25 text-amber-100 rounded-[2px] px-0.5"
            >
              {part.text}
            </mark>
          ) : (
            <span key={`${part.text}-${index}`}>{part.text}</span>
          ),
        )}
      </>
    );
  };

  return (
    <div className={`relative group ${archived ? "opacity-50" : ""}`}>
      {canSwipeToArchive && (
        <div
          className={`absolute inset-0 sm:hidden rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300 pointer-events-none transition-opacity ${
            showingSwipeBackdrop ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="h-full px-3.5 flex items-center justify-between text-[11px] font-medium">
            <span>Archive</span>
            <span>Archive</span>
          </div>
        </div>
      )}
      <button
        ref={buttonRef}
        onClick={handleSelect}
        onDoubleClick={(e) => {
          e.preventDefault();
          onStartRename(s.id, label);
        }}
        onContextMenu={(e) => {
          if (onCtxMenu) {
            e.preventDefault();
            onCtxMenu(e, s.id);
          }
        }}
        onMouseEnter={() => {
          if (onHoverStart && buttonRef.current) {
            onHoverStart(s.id, buttonRef.current.getBoundingClientRect());
          }
        }}
        onMouseLeave={() => {
          if (onHoverEnd) onHoverEnd();
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        style={{
          transform: swipeOffsetPx !== 0 ? `translateX(${swipeOffsetPx}px)` : undefined,
          transition: swipeActive.current ? "none" : "transform 180ms ease-out",
        }}
        className={`w-full text-left rounded-xl sm:rounded-lg border sm:border-transparent ${
          archived ? "pl-3.5 pr-12 py-2.5 sm:pl-3.5 sm:pr-14 sm:py-2" : "pl-3.5 pr-12 py-2.5 sm:pl-3.5 sm:pr-3 sm:py-2"
        } transition-all duration-100 select-none ${
          reorderMode ? "cursor-grab active:cursor-grabbing" : "cursor-pointer sm:cursor-grab sm:active:cursor-grabbing"
        } ${
          isActive
            ? "bg-cc-active border-cc-primary/25"
            : reorderMode
              ? "bg-cc-hover/50 border-cc-border/80"
              : "bg-cc-hover/20 border-cc-border/80 hover:bg-cc-hover/35 sm:bg-transparent sm:hover:bg-cc-hover"
        } ${herdHighlightClass}`}
      >
        {/* Left accent border */}
        <span
          className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full block ${stripeClass} ${
            isActive ? "opacity-100" : "opacity-60 group-hover:opacity-85"
          } transition-opacity`}
          data-testid="session-status-stripe"
          data-status={visualStatus}
          style={stripeGlowStyle}
        />

        <div className="flex items-start gap-2">
          {/* Drag handle — mobile reorder mode only (iOS Edit pattern) */}
          {reorderMode && (
            <span
              className="text-cc-muted/40 sm:hidden shrink-0 pt-[1px] cursor-grab active:cursor-grabbing"
              {...(dragHandleProps?.listeners ?? {})}
              {...(dragHandleProps?.attributes ?? {})}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <circle cx="6" cy="4" r="1.2" /><circle cx="10" cy="4" r="1.2" />
                <circle cx="6" cy="8" r="1.2" /><circle cx="10" cy="8" r="1.2" />
                <circle cx="6" cy="12" r="1.2" /><circle cx="10" cy="12" r="1.2" />
              </svg>
            </span>
          )}

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Row 1: Leader/herd tag (inline) + title */}
            <div className="flex items-center gap-1.5">
              {!isEditing && s.isOrchestrator && (
                <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-amber-500 bg-amber-500/10" title="Orchestrator session">
                  leader
                </span>
              )}
              {!isEditing && !s.isOrchestrator && !!s.herdedBy && (
                <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-amber-400 bg-amber-500/10" title="Herded by an orchestrator">
                  herd
                </span>
              )}
              {isEditing ? (
                <input
                  ref={editInputRef}
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onConfirmRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      onCancelRename();
                    }
                    e.stopPropagation();
                  }}
                  onBlur={onConfirmRename}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="text-[13px] font-medium flex-1 min-w-0 text-cc-fg bg-transparent border border-cc-border rounded px-1 py-0 outline-none focus:border-cc-primary/50"
                />
              ) : (
                <span
                  className={`text-[13px] truncate leading-snug ${
                    isQuestNamed && questStatus !== "needs_verification" ? "text-amber-400" : "text-cc-fg"
                  } ${
                    attention ? "font-semibold" : "font-medium"
                  } ${isRecentlyRenamed ? "animate-name-appear" : ""}`}
                  onAnimationEnd={() => onClearRecentlyRenamed(s.id)}
                >
                  {isQuestNamed && questStatus === "needs_verification" ? `☑ ${label}` : label}
                </span>
              )}
              {archived && s.archivedAt && (
                <span className="text-[10px] text-cc-muted/60 shrink-0 ml-auto">{timeAgo(s.archivedAt)}</span>
              )}
            </div>

            {/* Row 2: Preview — match context during search, or active task / last message */}
            {!isEditing && (displayMatch
              ? (
                <div className="mt-0.5 text-[10.5px] text-cc-muted/80 leading-tight truncate">
                  <span className="text-cc-primary/70 mr-1">{displayMatch.fieldLabel}</span>
                  {renderHighlightedSnippet(displayMatch.snippet)}
                </div>
              )
              : <SessionPreviewRow sessionId={s.id} userPreview={sessionPreview} />
            )}

            {/* Row 3: Metadata — backend, permissions, badges, #N, wt, git stats (all compact, one line) */}
            {!isEditing && (
              <div className="flex items-center gap-1 mt-0.5 text-[10.5px] text-cc-muted leading-tight">
                {s.sessionNum != null && (
                  <span className="text-[9px] font-mono text-cc-muted/60 shrink-0">#{s.sessionNum}</span>
                )}
                <img
                  src={backendLogo}
                  alt={backendAlt}
                  className="w-3 h-3 shrink-0 object-contain opacity-60"
                />
                {/* Shield icon: ask permission status (Claude only) */}
                {s.backendType !== "codex" && s.askPermission === true && (
                  <span title="Permissions: asking before tool use">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 text-cc-primary">
                      <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                      <path d="M6.5 8.5L7.5 9.5L10 7" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
                {s.backendType !== "codex" && s.askPermission === false && (
                  <span title="Permissions: auto-approving tool use">
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-2.5 h-2.5 shrink-0 text-cc-muted/50">
                      <path d="M8 1L2 4v4c0 3.5 2.6 6.4 6 7 3.4-.6 6-3.5 6-7V4L8 1z" />
                    </svg>
                  </span>
                )}
                {s.isContainerized && (
                  <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-blue-400 bg-blue-500/10">
                    Docker
                  </span>
                )}
                {s.cronJobId && (
                  <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-violet-500 bg-violet-500/10">
                    Cron
                  </span>
                )}
                {s.isWorktree && (
                  <span
                    className={`text-[9px] px-1 rounded shrink-0 ${
                      archived && s.worktreeExists === false
                        ? "bg-cc-muted/10 text-cc-muted"
                        : "bg-cc-primary/10 text-cc-primary"
                    }`}
                    title={
                      archived && s.worktreeExists !== undefined
                        ? s.worktreeExists
                          ? s.worktreeDirty ? "Worktree preserved (uncommitted changes)" : "Worktree preserved"
                          : "Worktree deleted"
                        : undefined
                    }
                  >wt</span>
                )}
                {hasBranchDivergence && (
                  <span className="flex items-center gap-0.5 text-[10px] shrink-0">
                    {s.gitAhead > 0 && <span className="text-green-500">{s.gitAhead}&#8593;</span>}
                    {s.gitBehind > 0 && <span className="text-cc-warning">{s.gitBehind}&#8595;</span>}
                  </span>
                )}
                {hasLineDiff && (
                  <span className="flex items-center gap-0.5 text-[10px] shrink-0">
                    <span className="text-green-500">+{s.linesAdded}</span>
                    <span className="text-red-400">-{s.linesRemoved}</span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </button>

      {/* Inline archive confirmation */}
      {confirmArchiveId === s.id && onConfirmArchive && onCancelArchive && (
        <div className="mx-1 mt-1 mb-0.5 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <div className="flex items-start gap-2">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5">
              <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-cc-fg leading-snug">
                {s.isWorktree
                  ? <>Archiving will <strong>delete the worktree</strong> and any uncommitted changes.</>
                  : <>Archiving will <strong>remove the container</strong> and any uncommitted changes.</>
                }
              </p>
              <div className="flex gap-2 mt-1.5">
                <button
                  onClick={(e) => { e.stopPropagation(); onCancelArchive(); }}
                  className="px-2 py-0.5 text-[10px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onConfirmArchive(); }}
                  className="px-2 py-0.5 text-[10px] font-medium rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors cursor-pointer"
                >
                  Archive
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Permission badge */}
      {!archived && permCount > 0 && (
        <span className="absolute right-11 sm:right-2 top-1/2 -translate-y-1/2 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-cc-warning text-white text-[10px] font-bold leading-none px-1 sm:group-hover:opacity-0 transition-opacity pointer-events-none">
          {permCount}
        </span>
      )}

      {/* Attention badge (shown when session needs review and no permission badge is displayed) */}
      {!archived && attention === "review" && permCount === 0 && (
        <span className="absolute right-11 sm:right-2 top-1/2 -translate-y-1/2 min-w-[6px] h-[6px] rounded-full bg-blue-500 sm:group-hover:opacity-0 transition-opacity pointer-events-none" />
      )}

      {/* Action buttons */}
      {archived ? (
        <>
          <button
            onClick={(e) => onUnarchive(e, s.id)}
            className="absolute right-8 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
            title="Restore session"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M8 10V3M5 5l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 13h10" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={(e) => onDelete(e, s.id)}
            className="hidden sm:block absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-red-400 transition-all cursor-pointer"
            title="Delete permanently"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </>
      ) : (
        <button
          onClick={(e) => onArchive(e, s.id)}
          className="absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer z-10"
          title="Archive session"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <path d="M3 3h10v2H3zM4 5v7a1 1 0 001 1h6a1 1 0 001-1V5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6.5 8h3" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Show active task preview (accent+italic) if newer than user message, else user message */
function SessionPreviewRow({ sessionId, userPreview }: { sessionId: string; userPreview?: string }) {
  const taskPreview = useStore((s) => s.sessionTaskPreview.get(sessionId));
  const userUpdatedAt = useStore((s) => s.sessionPreviewUpdatedAt.get(sessionId) ?? 0);

  const showTask = taskPreview && taskPreview.updatedAt > userUpdatedAt;

  if (showTask) {
    return (
      <div className="mt-0.5 text-[10.5px] text-cc-primary/60 leading-tight truncate italic">
        {taskPreview.text}
      </div>
    );
  }

  if (userPreview) {
    return (
      <div className="mt-0.5 text-[10.5px] text-cc-muted/60 leading-tight truncate">
        {userPreview}
      </div>
    );
  }

  return null;
}
