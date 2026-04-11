import { useRef, useCallback, useState, type RefObject } from "react";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { deriveSessionStatus, type SessionVisualStatus } from "./SessionStatusDot.js";
import { useStore } from "../store.js";
import { navigateToSession } from "../utils/routing.js";
import { getHighlightParts } from "../utils/highlight.js";
import { questLabel } from "../utils/quest-helpers.js";
import type { HerdGroupBadgeTheme } from "../utils/herd-group-theme.js";

type SearchMatchedField = "name" | "task" | "keyword" | "branch" | "path" | "repo" | "user_message";

/** Shared status count type used for worker summaries and group headers. */
export interface StatusCounts {
  running: number;
  permission: number;
  unread: number;
}

const STATUS_COUNT_STYLES = [
  { key: "running" as const, text: "text-cc-success", bg: "bg-cc-success" },
  { key: "permission" as const, text: "text-cc-warning", bg: "bg-cc-warning" },
  { key: "unread" as const, text: "text-blue-500", bg: "bg-blue-500" },
];

/** Renders colored dot+count indicators for running/permission/unread statuses. */
export function StatusCountDots({ counts }: { counts: StatusCounts }) {
  const hasAny = counts.running > 0 || counts.permission > 0 || counts.unread > 0;
  if (!hasAny) return null;
  return (
    <span className="flex items-center gap-1 shrink-0 text-[10px] font-medium">
      {STATUS_COUNT_STYLES.map(
        ({ key, text, bg }) =>
          counts[key] > 0 && (
            <span key={key} className={`${text} flex items-center gap-0.5`}>
              {counts[key]}
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${bg}`} />
            </span>
          ),
      )}
    </span>
  );
}

const SEARCH_MATCH_LABELS: Record<SearchMatchedField, string> = {
  name: "name",
  task: "task",
  keyword: "keyword",
  branch: "branch",
  path: "path",
  repo: "repo",
  user_message: "message",
};

const STATUS_DOT_CLASS: Record<SessionVisualStatus, string> = {
  archived: "bg-cc-muted/45",
  permission: "bg-amber-400",
  disconnected: "bg-cc-muted/60",
  running: "bg-emerald-500",
  compacting: "bg-emerald-500",
  completed_unread: "bg-blue-500",
  idle: "bg-cc-muted/50",
};

/** Maps reviewer session status to badge border/text/glow colors */
const REVIEWER_BADGE_THEME: Record<
  SessionVisualStatus,
  {
    border: string;
    text: string;
    glow: string; // CSS rgba for box-shadow glow (empty = no glow)
  }
> = {
  running: { border: "border-emerald-500/50", text: "text-emerald-400", glow: "rgba(34, 197, 94, 0.35)" },
  compacting: { border: "border-emerald-500/50", text: "text-emerald-400", glow: "rgba(34, 197, 94, 0.35)" },
  permission: { border: "border-amber-400/50", text: "text-amber-400", glow: "rgba(245, 158, 11, 0.35)" },
  completed_unread: { border: "border-blue-500/40", text: "text-blue-400", glow: "" },
  idle: { border: "border-cc-muted/15", text: "text-cc-muted", glow: "" },
  disconnected: { border: "border-cc-muted/15", text: "text-cc-muted", glow: "" },
  archived: { border: "border-cc-muted/15", text: "text-cc-muted", glow: "" },
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
  /** Whether drag-to-reorder is enabled (false in activity sort mode). */
  isDraggable?: boolean;
  onMobileReorderHandleActiveChange?: (active: boolean) => void;
  dragHandleProps?: {
    listeners?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
  };
  herdGroupBadgeTheme?: HerdGroupBadgeTheme;
  /** Active reviewer session for this parent -- renders an inline badge. */
  reviewerSession?: SessionItemType;
  /** Hover-linked herd relationship highlight in sidebar. */
  herdHoverHighlight?: "leader" | "worker";
  /** When set, shows why this session matched a search query (e.g. "keyword: zustand") */
  matchContext?: string | null;
  matchedField?: SearchMatchedField;
  matchQuery?: string;
  /** Indentation level for tree view (0 = root, 1 = worker under leader). */
  indentLevel?: number;
  /** When true, renders a compact chip (no preview, no herd badge, no shield). Tree view workers only. */
  compact?: boolean;
  useStatusBar?: boolean;
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
  isDraggable = true,
  onMobileReorderHandleActiveChange,
  dragHandleProps,
  herdGroupBadgeTheme,
  reviewerSession,
  herdHoverHighlight,
  matchContext,
  matchedField,
  matchQuery,
  indentLevel = 0,
  compact,
  useStatusBar,
}: SessionItemProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const touchStartedOnDragHandle = useRef(false);
  const swipeActive = useRef(false);
  const suppressTap = useRef(false);
  const [swipeOffsetPx, setSwipeOffsetPx] = useState(0);
  const shortId = s.id.slice(0, 8);
  const label = sessionName || s.model || shortId;
  const isEditing = editingSessionId === s.id;
  const isQuestNamed = useStore((st) => st.questNamedSessions.has(s.id));
  const questStatus = useStore((st) => st.sessions.get(s.id)?.claimedQuestStatus);
  const reviewerAttention = useStore((st) =>
    reviewerSession ? st.sessionAttention.get(reviewerSession.id) : undefined,
  );
  const canSwipeToArchive = !archived && !reorderMode;

  // Long-press to open context menu on touch devices
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touchTarget = e.target as HTMLElement | null;
      const startedOnDragHandle = !!touchTarget?.closest("[data-session-drag-handle='true']");
      touchStartedOnDragHandle.current = startedOnDragHandle;
      if (startedOnDragHandle) {
        suppressTap.current = true;
        cancelLongPress();
        swipeStart.current = null;
        swipeActive.current = false;
        setSwipeOffsetPx(0);
        return;
      }

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
        onCtxMenu(
          { preventDefault: () => {}, stopPropagation: () => {}, clientX: cx, clientY: cy } as React.MouseEvent,
          s.id,
        );
      }, 500);
    },
    [onCtxMenu, reorderMode, s.id],
  );

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

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (touchStartedOnDragHandle.current) {
        cancelLongPress();
        return;
      }
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
    },
    [cancelLongPress, canSwipeToArchive],
  );

  const handleTouchEnd = useCallback(() => {
    cancelLongPress();
    if (touchStartedOnDragHandle.current) {
      touchStartedOnDragHandle.current = false;
      swipeStart.current = null;
      swipeActive.current = false;
      setSwipeOffsetPx(0);
      return;
    }
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
    touchStartedOnDragHandle.current = false;
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
  const herdHighlightClass =
    herdHoverHighlight === "leader"
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
  const statusColorClass = STATUS_DOT_CLASS[visualStatus];
  const glowColor =
    visualStatus === "permission"
      ? "rgba(245, 158, 11, 0.7)"
      : visualStatus === "running" || visualStatus === "compacting"
        ? "rgba(34, 197, 94, 0.7)"
        : "";
  const glowStyle: React.CSSProperties | undefined = glowColor
    ? {
        ["--glow-color" as string]: glowColor,
        animation: "yarn-glow-breathe 2s ease-in-out infinite",
      }
    : undefined;
  const roleBadgeStyle = herdGroupBadgeTheme
    ? {
        color: herdGroupBadgeTheme.textColor,
        borderColor: herdGroupBadgeTheme.borderColor,
        backgroundColor: s.isOrchestrator ? herdGroupBadgeTheme.leaderBackground : herdGroupBadgeTheme.herdBackground,
      }
    : {
        color: s.isOrchestrator ? "#f59e0b" : "#fbbf24",
        borderColor: "rgba(245, 158, 11, 0.18)",
        backgroundColor: "rgba(245, 158, 11, 0.1)",
      };

  const renderHighlightedSnippet = (text: string): React.ReactNode => {
    const parts = getHighlightParts(text, matchQuery || "");
    if (!parts.some((part) => part.matched)) return text;
    return (
      <>
        {parts.map((part, index) =>
          part.matched ? (
            <mark key={`${part.text}-${index}`} className="bg-amber-300/25 text-amber-100 rounded-[2px] px-0.5">
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
    <div className={`relative group ${archived ? "opacity-50" : ""}`} style={indentLevel > 0 ? { paddingLeft: `${indentLevel * 16}px` } : undefined}>
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
          compact
            ? "pl-3.5 pr-12 py-1.5 sm:pl-3.5 sm:pr-3 sm:py-1"
            : archived ? "pl-3.5 pr-12 py-2.5 sm:pl-3.5 sm:pr-14 sm:py-2" : "pl-3.5 pr-12 py-2.5 sm:pl-3.5 sm:pr-3 sm:py-2"
        } transition-all duration-100 select-none ${
          isDraggable
            ? "cursor-pointer sm:cursor-grab sm:active:cursor-grabbing"
            : "cursor-pointer"
        } ${
          isActive
            ? "bg-cc-active border-cc-primary/25"
            : reorderMode
              ? "bg-cc-hover/50 border-cc-border/80"
              : "bg-cc-hover/20 border-cc-border/80 hover:bg-cc-hover/35 sm:bg-transparent sm:hover:bg-cc-hover"
        } ${herdHighlightClass}`}
      >
        {/* Left-edge status stripe (linear view only) */}
        {useStatusBar && (
          <span
            className={`absolute left-0 top-2 bottom-2 w-[3px] rounded-full block ${statusColorClass} ${
              isActive ? "opacity-100" : "opacity-60 group-hover:opacity-85"
            } transition-opacity`}
            data-testid="session-status-stripe"
            data-status={visualStatus}
            style={glowStyle}
          />
        )}

        <div className="flex items-start gap-2">
          {/* Drag handle -- mobile reorder mode only (iOS Edit pattern) */}
          {reorderMode && (
            <span
              data-session-drag-handle="true"
              data-testid={`session-drag-handle-${s.id}`}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={() => onMobileReorderHandleActiveChange?.(true)}
              onTouchStart={() => onMobileReorderHandleActiveChange?.(true)}
              className="text-cc-muted/40 sm:hidden shrink-0 pt-[1px] cursor-grab active:cursor-grabbing touch-none"
              {...(dragHandleProps?.listeners ?? {})}
              {...(dragHandleProps?.attributes ?? {})}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <circle cx="6" cy="4" r="1.2" />
                <circle cx="10" cy="4" r="1.2" />
                <circle cx="6" cy="8" r="1.2" />
                <circle cx="10" cy="8" r="1.2" />
                <circle cx="6" cy="12" r="1.2" />
                <circle cx="10" cy="12" r="1.2" />
              </svg>
            </span>
          )}

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Row 1: Leader/herd/reviewer tag (inline) + title */}
            <div className="flex items-center gap-1.5">
              {/* Status dot indicator (tree view only -- linear view uses left-edge stripe) */}
              {!useStatusBar && (
                <span
                  className={`shrink-0 w-1.5 h-1.5 rounded-full ${statusColorClass} ${
                    isActive ? "opacity-100" : "opacity-60 group-hover:opacity-85"
                  } transition-opacity`}
                  data-testid="session-status-dot"
                  data-status={visualStatus}
                  style={glowStyle}
                />
              )}
              {!isEditing && s.isOrchestrator && useStatusBar && (
                <span
                  className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 border"
                  title="Leader session"
                  data-testid="session-role-badge"
                  data-herd-group-tone={herdGroupBadgeTheme?.token}
                  style={roleBadgeStyle}
                >
                  leader
                </span>
              )}
              {!isEditing && !s.isOrchestrator && s.reviewerOf !== undefined && (
                <span
                  className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 border"
                  title={`Reviewer of #${s.reviewerOf}`}
                  data-testid="session-role-badge"
                  data-herd-group-tone={herdGroupBadgeTheme?.token}
                  style={roleBadgeStyle}
                >
                  reviewer
                </span>
              )}
              {!compact && !isEditing && !s.isOrchestrator && s.reviewerOf === undefined && !!s.herdedBy && (
                <span
                  className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 border"
                  title="Herded by a leader"
                  data-testid="session-role-badge"
                  data-herd-group-tone={herdGroupBadgeTheme?.token}
                  style={roleBadgeStyle}
                >
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
                  className={`text-[13px] truncate leading-snug text-cc-fg ${attention || (s.isOrchestrator && !useStatusBar) ? "font-semibold" : "font-medium"} ${isRecentlyRenamed ? "animate-name-appear" : ""}`}
                  onAnimationEnd={() => onClearRecentlyRenamed(s.id)}
                >
                  {questLabel(label, isQuestNamed, questStatus)}
                </span>
              )}
              {archived && s.archivedAt && (
                <span className="text-[10px] text-cc-muted/60 shrink-0 ml-auto">{timeAgo(s.archivedAt)}</span>
              )}
            </div>

            {/* Row 2: Preview -- match context during search, or active task / last message */}
            {!compact && !isEditing &&
              (displayMatch ? (
                <div className="mt-0.5 text-[10.5px] text-cc-muted/80 leading-tight truncate">
                  <span className="text-cc-primary/70 mr-1">{displayMatch.fieldLabel}</span>
                  {renderHighlightedSnippet(displayMatch.snippet)}
                </div>
              ) : (
                <SessionPreviewRow sessionId={s.id} userPreview={sessionPreview} />
              ))}

            {/* Row 3: Metadata — backend, permissions, badges, #N, wt, git stats (all compact, one line) */}
            {!isEditing && (
              <div className="flex items-center gap-1 mt-0.5 text-[10.5px] text-cc-muted leading-tight">
                {s.sessionNum != null && (
                  <span className="text-[9px] font-mono text-cc-muted/60 shrink-0">#{s.sessionNum}</span>
                )}
                <img src={backendLogo} alt={backendAlt} className="w-3 h-3 shrink-0 object-contain opacity-60" />
                {/* Shield icon: ask permission status (Claude only, hidden in compact/linear modes) */}
                {!compact && !useStatusBar && s.backendType !== "codex" && s.askPermission === true && (
                  <span title="Permissions: asking before tool use">
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 text-cc-primary">
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
                  </span>
                )}
                {!compact && !useStatusBar && s.backendType !== "codex" && s.askPermission === false && (
                  <span title="Permissions: auto-approving tool use">
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      className="w-2.5 h-2.5 shrink-0 text-cc-muted/50"
                    >
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
                          ? s.worktreeDirty
                            ? "Worktree preserved (uncommitted changes)"
                            : "Worktree preserved"
                          : "Worktree deleted"
                        : undefined
                    }
                  >
                    wt
                  </span>
                )}
                {reviewerSession &&
                  (() => {
                    const rvStatus = deriveSessionStatus({
                      archived: reviewerSession.archived,
                      permCount: reviewerSession.permCount,
                      isConnected: reviewerSession.isConnected,
                      sdkState: reviewerSession.sdkState,
                      status: reviewerSession.status,
                      hasUnread: !!reviewerAttention,
                      idleKilled: reviewerSession.idleKilled,
                    });
                    const rvTheme = REVIEWER_BADGE_THEME[rvStatus];
                    return (
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigateToSession(reviewerSession.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            e.stopPropagation();
                            navigateToSession(reviewerSession.id);
                          }
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        title={`Reviewer${reviewerSession.sessionNum != null ? ` #${reviewerSession.sessionNum}` : ""} — click to open`}
                        className={`inline-flex items-center gap-0.5 text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${rvTheme.text} bg-cc-muted/10 hover:bg-cc-muted/20 transition-colors cursor-pointer border ${rvTheme.border}`}
                        style={
                          rvTheme.glow
                            ? {
                                ["--glow-color" as string]: rvTheme.glow,
                                animation: "reviewer-badge-glow 2s ease-in-out infinite",
                              }
                            : undefined
                        }
                        data-testid="session-reviewer-badge"
                        data-reviewer-status={rvStatus}
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                          <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85a1.007 1.007 0 00-.115-.1zM12 6.5a5.5 5.5 0 11-11 0 5.5 5.5 0 0111 0z" />
                        </svg>
                        review
                      </div>
                    );
                  })()}
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
                {s.isWorktree ? (
                  <>
                    Archiving will <strong>delete the worktree</strong> and any uncommitted changes.
                  </>
                ) : (
                  <>
                    Archiving will <strong>remove the container</strong> and any uncommitted changes.
                  </>
                )}
              </p>
              <div className="flex gap-2 mt-1.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancelArchive();
                  }}
                  className="px-2 py-0.5 text-[10px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onConfirmArchive();
                  }}
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

      {/* Action attention badge (needs-input via takode notify, no pending permissions) */}
      {!archived && attention === "action" && permCount === 0 && (
        <span className="absolute right-11 sm:right-2 top-1/2 -translate-y-1/2 min-w-[8px] h-[8px] rounded-full bg-amber-400 sm:group-hover:opacity-0 transition-opacity pointer-events-none" />
      )}

      {/* Review attention badge (shown when session needs review and no higher-priority badge) */}
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
      <div className="mt-0.5 text-[10.5px] text-cc-primary/60 leading-tight truncate italic">{taskPreview.text}</div>
    );
  }

  if (userPreview) {
    return <div className="mt-0.5 text-[10.5px] text-cc-muted/60 leading-tight truncate">{userPreview}</div>;
  }

  return null;
}
