import { useRef, type RefObject } from "react";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { SessionStatusDot } from "./SessionStatusDot.js";

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
  dragHandleProps?: Record<string, unknown>;
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
  dragHandleProps,
}: SessionItemProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const shortId = s.id.slice(0, 8);
  const label = sessionName || s.model || shortId;
  const isEditing = editingSessionId === s.id;

  // Backend icon source
  const backendLogo = s.backendType === "codex" ? "/logo-codex.svg" : "/logo.svg";
  const backendAlt = s.backendType === "codex" ? "Codex" : "Claude";

  return (
    <div className={`relative group ${archived ? "opacity-50" : ""}`}>
      <button
        ref={buttonRef}
        onClick={() => onSelect(s.id)}
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
        className={`w-full pl-3.5 pr-8 py-2 ${archived ? "pr-14" : ""} text-left rounded-lg transition-all duration-100 cursor-pointer ${
          isActive
            ? "bg-cc-active"
            : "hover:bg-cc-hover"
        }`}
      >
        {/* Left accent border */}
        <span
          className={`absolute left-0 top-2 bottom-2 w-[2px] rounded-full ${
            s.backendType === "codex"
              ? "bg-blue-500"
              : "bg-[#D97757]"
          } ${isActive ? "opacity-100" : "opacity-40 group-hover:opacity-70"} transition-opacity`}
        />

        <div className="flex items-start gap-2">
          {/* Drag handle — desktop only, hover-to-show */}
          {dragHandleProps && (
            <div
              {...dragHandleProps}
              className="hidden sm:flex items-center justify-center shrink-0 w-3 -ml-1 self-stretch opacity-0 group-hover:opacity-40 hover:!opacity-70 cursor-grab active:cursor-grabbing touch-none select-none"
              title="Drag to reorder"
              onClick={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                <circle cx="5.5" cy="3.5" r="1.2"/><circle cx="10.5" cy="3.5" r="1.2"/>
                <circle cx="5.5" cy="8" r="1.2"/><circle cx="10.5" cy="8" r="1.2"/>
                <circle cx="5.5" cy="12.5" r="1.2"/><circle cx="10.5" cy="12.5" r="1.2"/>
              </svg>
            </div>
          )}

          {/* Status indicator dot */}
          <SessionStatusDot
            archived={!!archived}
            permCount={permCount}
            isConnected={s.isConnected}
            sdkState={s.sdkState}
            status={s.status}
            hasUnread={hasUnread}
          />

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Row 1: Name + Backend pill */}
            <div className="flex items-center gap-1.5">
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
                <>
                  <span
                    className={`text-[13px] truncate text-cc-fg leading-snug ${
                      attention ? "font-semibold" : "font-medium"
                    } ${isRecentlyRenamed ? "animate-name-appear" : ""}`}
                    onAnimationEnd={() => onClearRecentlyRenamed(s.id)}
                  >
                    {label}
                  </span>
                  <img
                    src={backendLogo}
                    alt={backendAlt}
                    className="w-3.5 h-3.5 shrink-0 object-contain"
                  />
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
                </>
              )}
            </div>

            {/* Row 2: Last user message preview */}
            {sessionPreview && !isEditing && (
              <div className="mt-0.5 text-[10.5px] text-cc-muted/60 leading-tight truncate">
                {sessionPreview}
              </div>
            )}

            {/* Row 3: Branch (directory already shown in group header) */}
            {s.gitBranch && (
              <div className="flex items-center gap-1 mt-0.5 text-[10.5px] text-cc-muted leading-tight truncate">
                {s.isWorktree ? (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                    <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 shrink-0 opacity-50">
                    <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.116.862a2.25 2.25 0 10-.862.862A4.48 4.48 0 007.25 7.5h-1.5A2.25 2.25 0 003.5 9.75v.318a2.25 2.25 0 101.5 0V9.75a.75.75 0 01.75-.75h1.5a5.98 5.98 0 003.884-1.435A2.25 2.25 0 109.634 3.362zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                  </svg>
                )}
                <span className="truncate">{s.gitBranch}</span>
                {s.isWorktree && (
                  <span className="text-[9px] bg-cc-primary/10 text-cc-primary px-1 rounded shrink-0">wt</span>
                )}
              </div>
            )}

            {/* Row 3: Git stats (conditional) */}
            {(s.gitAhead > 0 || s.gitBehind > 0 || s.linesAdded > 0 || s.linesRemoved > 0) && (
              <div className="flex items-center gap-1.5 mt-px text-[10px] text-cc-muted">
                {(s.gitAhead > 0 || s.gitBehind > 0) && (
                  <span className="flex items-center gap-0.5">
                    {s.gitAhead > 0 && <span className="text-green-500">{s.gitAhead}&#8593;</span>}
                    {s.gitBehind > 0 && <span className="text-cc-warning">{s.gitBehind}&#8595;</span>}
                  </span>
                )}
                {(s.linesAdded > 0 || s.linesRemoved > 0) && (
                  <span className="flex items-center gap-1 shrink-0">
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

      {/* Permission badge — shifted further right on mobile to make room for overflow button */}
      {!archived && permCount > 0 && (
        <span className="absolute right-14 sm:right-2 top-1/2 -translate-y-1/2 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-cc-warning text-white text-[10px] font-bold leading-none px-1 sm:group-hover:opacity-0 transition-opacity pointer-events-none">
          {permCount}
        </span>
      )}

      {/* Attention badge (shown when session needs review and no permission badge is displayed) */}
      {!archived && attention === "review" && permCount === 0 && (
        <span className="absolute right-14 sm:right-2 top-1/2 -translate-y-1/2 min-w-[6px] h-[6px] rounded-full bg-blue-500 sm:group-hover:opacity-0 transition-opacity pointer-events-none" />
      )}

      {/* Mobile overflow menu button */}
      {!archived && onCtxMenu && (
        <button
          onClick={(e) => { e.stopPropagation(); onCtxMenu(e, s.id); }}
          className="absolute right-8 top-1/2 -translate-y-1/2 p-1 rounded-md sm:hidden text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-all cursor-pointer"
          title="More actions"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
            <circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/>
          </svg>
        </button>
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
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-red-400 transition-all cursor-pointer"
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
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-100 sm:opacity-0 sm:group-hover:opacity-100 hover:bg-cc-border text-cc-muted hover:text-cc-fg transition-all cursor-pointer"
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
