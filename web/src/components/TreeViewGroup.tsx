import { type RefObject, useCallback, useState, useRef, useEffect } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
  type DraggableAttributes,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TreeViewGroupData, TreeNode } from "../utils/tree-grouping.js";
import type { SessionItem as SessionItemType } from "../utils/project-grouping.js";
import { SessionItem, StatusCountDots, type StatusCounts } from "./SessionItem.js";
import { deriveSessionStatus } from "./SessionStatusDot.js";
import { useStore, countUserPermissions } from "../store.js";
import { isTouchDevice } from "../utils/mobile.js";
import { api } from "../api.js";
import type { HerdGroupBadgeTheme } from "../utils/herd-group-theme.js";

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});

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
  const touchDevice = isTouchDevice();

  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
  const sensors = useSensors(pointerSensor);
  const isDraggable = sessionSortMode !== "activity";

  const [editingGroupName, setEditingGroupName] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const groupNameInputRef = useRef<HTMLInputElement>(null);

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

  const hasStatus = group.runningCount > 0 || group.permCount > 0 || group.unreadCount > 0;

  // Total session count across all nodes
  const totalSessions = group.nodes.reduce((sum, n) => sum + 1 + n.workers.length, 0);

  // Root node IDs for drag-and-drop (leaders and standalone sessions)
  const rootNodeIds = group.nodes.map((n) => n.leader.id);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = rootNodeIds.indexOf(active.id as string);
      const newIndex = rootNodeIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;
      const newOrder = arrayMove(rootNodeIds, oldIndex, newIndex);
      api.updateTreeNodeOrder(group.id, newOrder).catch((err) => {
        console.warn("[tree-view-group] failed to update node order:", err);
      });
    },
    [rootNodeIds, group.id],
  );

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
    opts?: { compact?: boolean; workerStatusSummary?: StatusCounts },
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
        workerStatusSummary={opts?.workerStatusSummary}
        {...sessionItemProps}
      />
    );
  }

  /** Count worker sessions by visual status for the leader chip's status summary. */
  function computeWorkerSummary(workers: SessionItemType[]): StatusCounts {
    let running = 0;
    let permission = 0;
    let unread = 0;
    for (const w of workers) {
      const wPermCount = countUserPermissions(pendingPermissions.get(w.id));
      const wAttention = sessionAttention?.get(w.id) ?? null;
      const status = deriveSessionStatus({
        archived: w.archived,
        permCount: wPermCount,
        isConnected: w.isConnected,
        sdkState: w.sdkState,
        status: w.status,
        hasUnread: !!wAttention,
        idleKilled: w.idleKilled,
      });
      if (status === "running" || status === "compacting") running++;
      else if (status === "permission") permission++;
      else if (status === "completed_unread") unread++;
    }
    return { running, permission, unread };
  }

  function renderTreeNode(node: TreeNode) {
    const hasWorkers = node.workers.length > 0;
    const isNodeCollapsed = collapsedTreeNodes.has(node.leader.id);
    const workerSummary = hasWorkers ? computeWorkerSummary(node.workers) : undefined;

    return (
      <div key={node.leader.id}>
        {/* Leader / standalone row */}
        <div className="flex items-start">
          {hasWorkers && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleNodeCollapse(node.leader.id);
              }}
              className="shrink-0 w-4 h-7 flex items-center justify-center text-cc-muted hover:text-cc-fg cursor-pointer"
              title={isNodeCollapsed ? "Expand workers" : "Collapse workers"}
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`w-2.5 h-2.5 transition-transform ${isNodeCollapsed ? "" : "rotate-90"}`}
              >
                <path d="M6 4l4 4-4 4" />
              </svg>
            </button>
          )}
          <div className={`flex-1 min-w-0 ${!hasWorkers ? "pl-4" : ""}`}>
            {renderSessionItem(node.leader, { workerStatusSummary: workerSummary })}
          </div>
        </div>

        {/* Workers -- indented under leader with VSCode-style indent guide */}
        {hasWorkers && !isNodeCollapsed && (
          <div className="ml-[7px] pl-[9px] border-l border-cc-border/20">
            {node.workers.map((w) => renderSessionItem(w, { compact: true }))}
          </div>
        )}
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
            if (group.id !== "default") {
              e.preventDefault();
              startGroupRename();
            }
          }}
          className="min-w-0 flex-1 flex items-center gap-1.5 cursor-pointer"
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

      {/* Tree node list */}
      {!isGroupCollapsed && (
        <DndContext
          sensors={isDraggable ? sensors : []}
          collisionDetection={closestCenter}
          onDragEnd={isDraggable ? handleDragEnd : undefined}
          modifiers={[restrictToVerticalAxis]}
        >
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
        </DndContext>
      )}
    </div>
  );
}
