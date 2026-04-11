import { type RefObject, useCallback, useState, useRef, useEffect } from "react";
import {
  type DraggableAttributes,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TreeViewGroupData, TreeNode } from "../utils/tree-grouping.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { SessionItem, StatusCountDots, type StatusCounts } from "./SessionItem.js";
import { deriveSessionStatus } from "./SessionStatusDot.js";
import { useStore, countUserPermissions } from "../store.js";
import { isTouchDevice } from "../utils/mobile.js";
import { api } from "../api.js";
import type { HerdGroupBadgeTheme } from "../utils/herd-group-theme.js";

// ─── Props ───────────────────────────────────────────────────────────────────

interface TreeViewGroupProps {
  group: TreeViewGroupData;
  isGroupCollapsed: boolean;
  collapsedTreeNodes: Set<string>;
  onToggleGroupCollapse: (groupId: string) => void;
  onToggleNodeCollapse: (sessionId: string) => void;
  onCreateSession: (groupId: string) => void;
  currentSessionId: string | null;
  sessionNames: Map<string, string>;
  sessionPreviews: Map<string, string>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  recentlyRenamed: Set<string>;
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
  isFirst: boolean;
  sessionAttention?: Map<string, "action" | "error" | "review" | null>;
  herdHoverHighlights?: Map<string, "leader" | "worker">;
  herdGroupBadgeThemes?: Map<string, HerdGroupBadgeTheme>;
  groupDragHandleProps?: {
    listeners?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
  };
  groupDragging?: boolean;
  onMobileReorderHandleActiveChange?: (active: boolean) => void;
}

// ─── Sortable wrapper ────────────────────────────────────────────────────────

function SortableTreeNode({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled?: boolean;
  children: (props: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: React.CSSProperties;
    listeners: Record<string, Function> | undefined;
    attributes: DraggableAttributes;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative" as const,
    zIndex: isDragging ? 50 : "auto",
  };
  return <>{children({ setNodeRef, style, listeners, attributes, isDragging })}</>;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TreeViewGroup({
  group,
  isGroupCollapsed,
  collapsedTreeNodes,
  onToggleGroupCollapse,
  onToggleNodeCollapse,
  onCreateSession,
  currentSessionId,
  sessionNames,
  sessionPreviews,
  pendingPermissions,
  recentlyRenamed,
  onSelect,
  onStartRename,
  onArchive,
  onUnarchive,
  onDelete,
  onClearRecentlyRenamed,
  onContextMenu,
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
  isFirst,
  sessionAttention,
  herdHoverHighlights,
  herdGroupBadgeThemes,
  groupDragHandleProps,
  groupDragging,
  onMobileReorderHandleActiveChange,
}: TreeViewGroupProps) {
  const reorderMode = useStore((s) => s.reorderMode);
  const sessionSortMode = useStore((s) => s.sessionSortMode);
  const expandedHerdNodes = useStore((s) => s.expandedHerdNodes);
  const toggleHerdNodeExpand = useStore((s) => s.toggleHerdNodeExpand);
  const touchDevice = isTouchDevice();
  const isDraggable = sessionSortMode !== "activity";

  const [editingGroupName, setEditingGroupName] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const groupNameInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const startGroupRename = useCallback(() => {
    if (group.id === "default") return;
    setGroupNameDraft(group.name);
    setEditingGroupName(true);
  }, [group.id, group.name]);

  const confirmGroupRename = useCallback(() => {
    setEditingGroupName(false);
    const trimmed = groupNameDraft.trim();
    if (trimmed && trimmed !== group.name) {
      api.renameTreeGroup(group.id, trimmed).catch(console.error);
    }
  }, [group.id, group.name, groupNameDraft]);

  useEffect(() => {
    if (editingGroupName && groupNameInputRef.current) {
      groupNameInputRef.current.focus();
      groupNameInputRef.current.select();
    }
  }, [editingGroupName]);

  // Dismiss context menu on click outside or ESC key
  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  const handleDeleteGroup = useCallback(() => {
    setContextMenu(null);
    if (group.id === "default") return;
    api.deleteTreeGroup(group.id).catch((err) => {
      console.warn("[tree-view-group] failed to delete group:", err);
    });
  }, [group.id]);

  const hasStatus = group.runningCount > 0 || group.permCount > 0 || group.unreadCount > 0;

  // Total session count across all nodes
  const totalSessions = group.nodes.reduce((sum, n) => sum + 1 + n.workers.length, 0);

  // Root node IDs for drag-and-drop (leaders and standalone sessions)
  const rootNodeIds = group.nodes.map((n) => n.leader.id);

  // Shared session item props
  const sessionItemProps = {
    onSelect,
    onStartRename,
    onArchive,
    onUnarchive,
    onDelete,
    onClearRecentlyRenamed,
    onContextMenu,
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
    reorderMode,
    isDraggable,
    onMobileReorderHandleActiveChange,
  };

  function renderSessionItem(
    s: SessionItemType,
    opts?: { compact?: boolean; reviewerSession?: SessionItemType },
  ) {
    const permCount = countUserPermissions(pendingPermissions.get(s.id));
    const attention = sessionAttention?.get(s.id) ?? null;
    return (
      <SessionItem
        key={s.id}
        session={s}
        isActive={currentSessionId === s.id}
        sessionName={sessionNames.get(s.id)}
        sessionPreview={sessionPreviews.get(s.id)}
        permCount={permCount}
        isRecentlyRenamed={recentlyRenamed.has(s.id)}
        attention={attention}
        hasUnread={!!attention}
        herdGroupBadgeTheme={herdGroupBadgeThemes?.get(s.id)}
        herdHoverHighlight={herdHoverHighlights?.get(s.id)}
        compact={opts?.compact}
        reviewerSession={opts?.reviewerSession}
        {...sessionItemProps}
      />
    );
  }

  /** Count worker sessions by visual status for the herd summary bar. */
  function computeWorkerSummary(workers: SessionItemType[]): StatusCounts {
    let running = 0;
    let permission = 0;
    let unread = 0;
    const countSession = (s: SessionItemType) => {
      const sPermCount = countUserPermissions(pendingPermissions.get(s.id));
      const sAttention = sessionAttention?.get(s.id) ?? null;
      const status = deriveSessionStatus({
        archived: s.archived,
        permCount: sPermCount,
        isConnected: s.isConnected,
        sdkState: s.sdkState,
        status: s.status,
        hasUnread: !!sAttention,
        idleKilled: s.idleKilled,
      });
      if (status === "running" || status === "compacting") running++;
      else if (status === "permission") permission++;
      else if (status === "completed_unread") unread++;
    };
    for (const w of workers) countSession(w);
    return { running, permission, unread };
  }

  function renderTreeNode(node: TreeNode) {
    const hasWorkers = node.workers.length > 0;
    const hasReviewersOnly = !hasWorkers && node.reviewers.length > 0;
    const workerSummary = hasWorkers ? computeWorkerSummary(node.workers) : undefined;

    // Herded nodes (leader with workers): collapsible container pattern
    if (hasWorkers) {
      const isExpanded = expandedHerdNodes.has(node.leader.id);
      const totalMembers = node.workers.length;
      const idleCount = totalMembers - (workerSummary!.running + workerSummary!.permission + workerSummary!.unread);
      const leaderReviewer = node.reviewers.find(
        (r) => r.reviewerOf === node.leader.sessionNum,
      );

      return (
        <div key={node.leader.id} className="border border-cc-border/40 rounded-lg overflow-hidden bg-cc-card/20">
          {/* Leader chip -- full width, no chevron, no indent */}
          {renderSessionItem(node.leader, { reviewerSession: leaderReviewer })}

          {/* Herd summary bar -- always visible, toggles expand/collapse */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleHerdNodeExpand(node.leader.id);
            }}
            className="w-full flex items-center gap-1.5 px-3 py-1 border-t border-cc-border/30 text-[10px] text-cc-muted hover:bg-cc-hover/50 transition-colors cursor-pointer"
            title={isExpanded ? "Collapse workers" : "Expand workers"}
          >
            <StatusCountDots counts={workerSummary!} />
            {idleCount > 0 && (
              <span className="flex items-center gap-0.5 text-cc-muted/50">
                {idleCount}
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-muted/30" />
              </span>
            )}
            <span className="ml-auto text-cc-muted/50 shrink-0">
              {node.workers.length} worker{node.workers.length !== 1 ? "s" : ""}
            </span>
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`w-3 h-3 text-cc-muted/40 transition-transform shrink-0 ${isExpanded ? "rotate-180" : ""}`}
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>

          {/* Workers container -- only when expanded, with left accent rail */}
          {isExpanded && (
            <div className="border-t border-cc-border/30 border-l-[3px] border-l-cc-primary/30 ml-0.5 pl-3">
              {node.workers.map((w) => {
                const workerReviewer = node.reviewers.find(
                  (r) => r.reviewerOf === w.sessionNum,
                );
                return (
                  <div key={w.id}>
                    {renderSessionItem(w, { compact: true, reviewerSession: workerReviewer })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    // Standalone node with only reviewers (no workers): show reviewer as inline chip
    if (hasReviewersOnly) {
      const leaderReviewer = node.reviewers.find(
        (r) => r.reviewerOf === node.leader.sessionNum,
      );
      return (
        <div key={node.leader.id}>
          {renderSessionItem(node.leader, { reviewerSession: leaderReviewer })}
        </div>
      );
    }

    // Standalone node (no workers, no reviewers): plain session chip
    return (
      <div key={node.leader.id}>
        {renderSessionItem(node.leader)}
      </div>
    );
  }

  return (
    <div className={!isFirst ? "mt-1 pt-1 border-t border-cc-border/50" : ""}>
      {/* Group header */}
      <div
        className={`w-full px-2 py-1.5 flex items-center gap-1 rounded-md transition-colors ${groupDragging ? "bg-cc-hover/70" : "hover:bg-cc-hover"}`}
      >
        <button
          onClick={() => onToggleGroupCollapse(group.id)}
          onContextMenu={(e) => {
            if (group.id === "default") return;
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY });
          }}
          className="min-w-0 flex-1 flex items-center gap-1.5 cursor-pointer"
          onDoubleClick={(e) => {
            if (group.id === "default") return;
            e.preventDefault();
            e.stopPropagation();
            startGroupRename();
          }}
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-3 h-3 text-cc-muted transition-transform ${isGroupCollapsed ? "" : "rotate-90"}`}
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          {editingGroupName ? (
            <input
              ref={groupNameInputRef}
              type="text"
              value={groupNameDraft}
              onChange={(e) => setGroupNameDraft(e.target.value)}
              onBlur={confirmGroupRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmGroupRename();
                if (e.key === "Escape") setEditingGroupName(false);
              }}
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] font-semibold text-cc-fg bg-cc-input-bg border border-cc-primary/60 rounded px-1 py-0 outline-none min-w-0 flex-1"
            />
          ) : (
            <span className="text-[11px] font-semibold text-cc-fg/80 truncate">{group.name}</span>
          )}
          {hasStatus && (
            <span className="ml-auto">
              <StatusCountDots counts={{ running: group.runningCount, permission: group.permCount, unread: group.unreadCount }} />
            </span>
          )}
          <span className="text-[10px] text-cc-muted/60 shrink-0 ml-1">{totalSessions}</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCreateSession(group.id);
          }}
          className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
          title={`Create session in ${group.name}`}
          aria-label={`Create session in ${group.name}`}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3 h-3">
            <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
          </svg>
        </button>
        {groupDragHandleProps && (
          <button
            type="button"
            className="shrink-0 w-5 h-5 inline-flex items-center justify-center text-cc-muted hover:text-cc-fg cursor-grab active:cursor-grabbing touch-none"
            title="Drag to reorder groups"
            aria-label={`Drag to reorder group ${group.name}`}
            onClick={(e) => e.stopPropagation()}
            {...(groupDragHandleProps.listeners || {})}
            {...(groupDragHandleProps.attributes || {})}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-80">
              <path d="M5 3.5a1 1 0 11-2 0 1 1 0 012 0zm4 0a1 1 0 11-2 0 1 1 0 012 0zm4 0a1 1 0 11-2 0 1 1 0 012 0zM5 8a1 1 0 11-2 0 1 1 0 012 0zm4 0a1 1 0 11-2 0 1 1 0 012 0zm4 0a1 1 0 11-2 0 1 1 0 012 0zM5 12.5a1 1 0 11-2 0 1 1 0 012 0zm4 0a1 1 0 11-2 0 1 1 0 012 0zm4 0a1 1 0 11-2 0 1 1 0 012 0z" />
            </svg>
          </button>
        )}
      </div>

      {/* Tree node list -- DndContext lives in Sidebar for cross-group support */}
      {!isGroupCollapsed && group.nodes.length > 0 && (
        <SortableContext items={rootNodeIds} strategy={verticalListSortingStrategy}>
          <div className="space-y-0.5 mt-0.5">
            {group.nodes.map((node) => (
              <SortableTreeNode key={node.leader.id} id={node.leader.id} disabled={!isDraggable}>
                {({ setNodeRef, style, listeners, attributes }) => (
                    <div ref={setNodeRef} style={style} {...(!touchDevice && isDraggable ? { ...listeners, ...attributes } : {})}>
                      {renderTreeNode(node)}
                    </div>
                )}
              </SortableTreeNode>
            ))}
          </div>
        </SortableContext>
      )}
      {!isGroupCollapsed && group.nodes.length === 0 && (
        <div className="px-4 py-2 text-[11px] text-cc-muted/50 italic">
          No sessions -- use + to create one
        </div>
      )}

      {/* Context menu for non-default groups */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          role="menu"
          className="fixed z-[100] bg-cc-card border border-cc-border rounded-lg shadow-lg py-1 min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            role="menuitem"
            className="w-full px-3 py-1.5 text-left text-[11px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            onClick={() => {
              setContextMenu(null);
              startGroupRename();
            }}
          >
            Rename
          </button>
          <button
            role="menuitem"
            className="w-full px-3 py-1.5 text-left text-[11px] text-red-400 hover:bg-cc-hover transition-colors cursor-pointer"
            onClick={handleDeleteGroup}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
