import { useStore } from "../store.js";

export function CollapseAllButton({ sessionId }: { sessionId: string }) {
  const collapsibleTurnIds = useStore((s) => s.collapsibleTurnIds.get(sessionId));
  const overrides = useStore((s) => s.turnActivityOverrides.get(sessionId));
  const hasTurns = collapsibleTurnIds && collapsibleTurnIds.length > 0;
  const allCollapsed = hasTurns && collapsibleTurnIds.every((id) => overrides?.get(id) === false);

  function handleClick() {
    if (!hasTurns) return;
    const store = useStore.getState();
    if (allCollapsed) {
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
