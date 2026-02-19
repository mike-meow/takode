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
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProjectGroup as ProjectGroupType } from "../utils/project-grouping.js";

/** Restrict drag movement to vertical axis only */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
import { SessionItem } from "./SessionItem.js";
import { useStore } from "../store.js";

interface ProjectGroupProps {
  group: ProjectGroupType;
  isCollapsed: boolean;
  onToggleCollapse: (projectKey: string) => void;
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
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

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
}: ProjectGroupProps) {
  // Build summary badges
  const summaryParts: string[] = [];
  if (group.runningCount > 0) summaryParts.push(`${group.runningCount} running`);
  if (group.permCount > 0) summaryParts.push(`${group.permCount} waiting`);
  if (group.unreadCount > 0) summaryParts.push(`${group.unreadCount} unread`);

  // Drag-and-drop: require a minimum distance before starting a drag to avoid
  // interfering with clicks
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const sessionIds = group.sessions.map((s) => s.id);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = sessionIds.indexOf(active.id as string);
      const newIndex = sessionIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      const newOrder = arrayMove(sessionIds, oldIndex, newIndex);
      useStore.getState().setSessionOrder(group.key, newOrder);
    },
    [sessionIds, group.key],
  );

  return (
    <div className={!isFirst ? "mt-1 pt-1 border-t border-cc-border/50" : ""}>
      {/* Group header */}
      <button
        onClick={() => onToggleCollapse(group.key)}
        className="w-full px-2 py-1.5 flex items-center gap-1.5 hover:bg-cc-hover rounded-md transition-colors cursor-pointer"
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-cc-muted transition-transform ${isCollapsed ? "" : "rotate-90"}`}
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="text-[11px] font-semibold text-cc-fg/80 truncate">
          {group.label}
        </span>
        {summaryParts.length > 0 && (
          <span className="text-[10px] text-cc-muted ml-auto shrink-0">
            {summaryParts.map((part, i) => (
              <span key={i}>
                {i > 0 && ", "}
                <span className={
                  part.includes("running") ? "text-cc-success"
                  : part.includes("unread") ? "text-blue-500"
                  : "text-cc-warning"
                }>
                  {part}
                </span>
              </span>
            ))}
          </span>
        )}
        <span className="text-[10px] text-cc-muted/60 shrink-0 ml-1">
          {group.sessions.length}
        </span>
      </button>

      {/* Session list — drag-sortable */}
      {!isCollapsed && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
          modifiers={[restrictToVerticalAxis]}
        >
          <SortableContext items={sessionIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-0.5 mt-0.5">
              {group.sessions.map((s) => {
                const permCount = pendingPermissions.get(s.id)?.size ?? 0;
                const attention = sessionAttention?.get(s.id) ?? null;
                return (
                  <SortableSessionItem key={s.id} id={s.id}>
                    {({ setNodeRef, style, listeners, attributes, isDragging }) => (
                      <div
                        ref={setNodeRef}
                        style={style}
                      >
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
                          dragHandleProps={{ ...listeners, ...attributes }}
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
