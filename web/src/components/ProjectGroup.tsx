import { type RefObject, useCallback } from "react";
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
import type { ProjectGroup as ProjectGroupType } from "../utils/project-grouping.js";

/** Restrict drag movement to vertical axis only */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
import { SessionItem } from "./SessionItem.js";
import { useStore, countUserPermissions } from "../store.js";
import { isTouchDevice } from "../utils/mobile.js";
import { api } from "../api.js";
import type { HerdGroupBadgeTheme } from "../utils/herd-group-theme.js";

interface ProjectGroupProps {
  group: ProjectGroupType;
  isCollapsed: boolean;
  onToggleCollapse: (projectKey: string) => void;
  onCreateSession: (projectKey: string) => void;
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

/** Wrapper that makes a SessionItem draggable via @dnd-kit/sortable */
function SortableSessionItem({
  id,
  children,
}: {
  id: string;
  children: (props: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: React.CSSProperties;
    listeners: Record<string, Function> | undefined;
    attributes: DraggableAttributes;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: "relative" as const,
    zIndex: isDragging ? 50 : "auto",
  };

  return <>{children({ setNodeRef, style, listeners, attributes, isDragging })}</>;
}

export function ProjectGroup({
  group,
  isCollapsed,
  onToggleCollapse,
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
}: ProjectGroupProps) {
  // Build summary counts
  const hasStatus = group.runningCount > 0 || group.permCount > 0 || group.unreadCount > 0;

  const reorderMode = useStore((s) => s.reorderMode);
  const touchDevice = isTouchDevice();

  // Drag-and-drop: always register the sensor so the useMemo dependency array
  // inside useSensors keeps a constant length across renders (React requirement).
  // On desktop, items remain drag-anywhere. On mobile, drag attaches to the
  // explicit handle shown in Edit mode.
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
  const sensors = useSensors(pointerSensor);

  const sessionIds = group.sessions.map((s) => s.id);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = sessionIds.indexOf(active.id as string);
      const newIndex = sessionIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      const newOrder = arrayMove(sessionIds, oldIndex, newIndex);
      api.updateSessionOrder(group.key, newOrder).catch((err) => {
        console.warn("[project-group] failed to update session order:", err);
      });
    },
    [sessionIds, group.key],
  );

  return (
    <div className={!isFirst ? "mt-1 pt-1 border-t border-cc-border/50" : ""}>
      {/* Group header */}
      <div
        className={`w-full px-2 py-1.5 flex items-center gap-1 rounded-md transition-colors ${groupDragging ? "bg-cc-hover/70" : "hover:bg-cc-hover"}`}
      >
        <button
          onClick={() => onToggleCollapse(group.key)}
          className="min-w-0 flex-1 flex items-center gap-1.5 cursor-pointer"
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`w-3 h-3 text-cc-muted transition-transform ${isCollapsed ? "" : "rotate-90"}`}
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
          <span className="text-[11px] font-semibold text-cc-fg/80 truncate">{group.label}</span>
          {hasStatus && (
            <span className="flex items-center gap-1 ml-auto shrink-0 text-[10px] font-medium">
              {group.runningCount > 0 && (
                <span className="text-cc-success flex items-center gap-0.5">
                  {group.runningCount}
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-success" />
                </span>
              )}
              {group.permCount > 0 && (
                <span className="text-cc-warning flex items-center gap-0.5">
                  {group.permCount}
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-warning" />
                </span>
              )}
              {group.unreadCount > 0 && (
                <span className="text-blue-500 flex items-center gap-0.5">
                  {group.unreadCount}
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" />
                </span>
              )}
            </span>
          )}
          <span className="text-[10px] text-cc-muted/60 shrink-0 ml-1">{group.sessions.length}</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCreateSession(group.key);
          }}
          className="shrink-0 w-5 h-5 inline-flex items-center justify-center rounded text-cc-muted hover:text-cc-fg hover:bg-cc-hover cursor-pointer"
          title={`Create session in ${group.label}`}
          aria-label={`Create session in ${group.label}`}
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
            aria-label={`Drag to reorder group ${group.label}`}
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

      {/* Session list — drag-sortable */}
      {!isCollapsed && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          modifiers={[restrictToVerticalAxis]}
        >
          <SortableContext items={sessionIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-2 sm:space-y-0.5 mt-1 sm:mt-0.5">
              {group.sessions.map((s) => {
                const permCount = countUserPermissions(pendingPermissions.get(s.id));
                const attention = sessionAttention?.get(s.id) ?? null;
                return (
                  <SortableSessionItem key={s.id} id={s.id}>
                    {({ setNodeRef, style, listeners, attributes, isDragging }) => (
                      <div ref={setNodeRef} style={style} {...(!touchDevice ? { ...listeners, ...attributes } : {})}>
                        <SessionItem
                          session={s}
                          isActive={currentSessionId === s.id}
                          sessionName={sessionNames.get(s.id)}
                          sessionPreview={sessionPreviews.get(s.id)}
                          permCount={permCount}
                          isRecentlyRenamed={recentlyRenamed.has(s.id)}
                          onSelect={onSelect}
                          onStartRename={onStartRename}
                          onArchive={onArchive}
                          onUnarchive={onUnarchive}
                          onDelete={onDelete}
                          onClearRecentlyRenamed={onClearRecentlyRenamed}
                          onContextMenu={onContextMenu}
                          onHoverStart={onHoverStart}
                          onHoverEnd={onHoverEnd}
                          editingSessionId={editingSessionId}
                          editingName={editingName}
                          setEditingName={setEditingName}
                          onConfirmRename={onConfirmRename}
                          onCancelRename={onCancelRename}
                          editInputRef={editInputRef}
                          confirmArchiveId={confirmArchiveId}
                          onConfirmArchive={onConfirmArchive}
                          onCancelArchive={onCancelArchive}
                          attention={attention}
                          hasUnread={!!attention}
                          herdGroupBadgeTheme={herdGroupBadgeThemes?.get(s.id)}
                          herdHoverHighlight={herdHoverHighlights?.get(s.id)}
                          reorderMode={reorderMode}
                          onMobileReorderHandleActiveChange={onMobileReorderHandleActiveChange}
                          dragHandleProps={
                            reorderMode && touchDevice
                              ? {
                                  listeners: listeners as Record<string, unknown> | undefined,
                                  attributes: attributes as unknown as Record<string, unknown>,
                                }
                              : undefined
                          }
                        />
                      </div>
                    )}
                  </SortableSessionItem>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
