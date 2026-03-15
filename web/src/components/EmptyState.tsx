import { useEffect } from "react";
import { useStore } from "../store.js";
import { navigateToMostRecentSession } from "../utils/routing.js";
import { SleepingCat } from "./CatIcons.js";

export function EmptyState() {
  const serverName = useStore((s) => s.serverName);
  const sdkSessions = useStore((s) => s.sdkSessions);

  // Auto-navigate once sessions load (handles cold-start race where
  // sdkSessions is empty on mount but gets populated by Sidebar poll)
  useEffect(() => {
    if (sdkSessions.some((s) => !s.archived && !s.cronJobId)) {
      navigateToMostRecentSession({ replace: true });
    }
  }, [sdkSessions]);

  return (
    <div className="flex-1 h-full flex flex-col items-center justify-center px-4">
      <SleepingCat className="w-32 h-24 mb-4" />
      <h1 className="text-lg font-semibold text-cc-fg mb-1">{serverName || "Takode"}</h1>
      <p className="text-sm text-cc-muted mb-6">No active sessions</p>
      <button
        onClick={() => useStore.getState().openNewSessionModal()}
        className="px-4 py-2.5 text-sm font-medium rounded-xl bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer flex items-center gap-2"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
          <path d="M8 3v10M3 8h10" />
        </svg>
        New Session
      </button>
    </div>
  );
}
