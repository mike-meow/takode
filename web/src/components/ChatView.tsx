import { useMemo, useState, useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { MessageFeed, ElapsedTimer } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import { PermissionBanner, PlanReviewOverlay, PlanCollapsedChip, PermissionsCollapsedChip } from "./PermissionBanner.js";

export function ChatView({ sessionId }: { sessionId: string }) {
  const sessionPerms = useStore((s) => s.pendingPermissions.get(sessionId));
  const connStatus = useStore(
    (s) => s.connectionStatus.get(sessionId) ?? "disconnected"
  );
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const cliEverConnected = useStore((s) => s.cliEverConnected.get(sessionId) ?? false);
  const cliDisconnectReason = useStore((s) => s.cliDisconnectReason.get(sessionId) ?? null);

  const perms = useMemo(
    () => (sessionPerms ? Array.from(sessionPerms.values()) : []),
    [sessionPerms]
  );

  // Separate plan permission from other permissions
  const planPerm = perms.find((p) => p.tool_name === "ExitPlanMode") || null;
  const otherPerms = perms.filter((p) => p.tool_name !== "ExitPlanMode");

  // Plan collapse state — auto-expand when a new plan arrives
  const [planCollapsed, setPlanCollapsed] = useState(false);
  const planPermId = planPerm?.request_id;
  useEffect(() => {
    if (planPermId) setPlanCollapsed(false);
  }, [planPermId]);

  const showPlanOverlay = planPerm && !planCollapsed;

  // Permissions collapse state — auto-expand only when new permissions arrive
  const [permsCollapsed, setPermsCollapsed] = useState(false);
  const prevOtherPermsCount = useRef(0);
  useEffect(() => {
    if (otherPerms.length > prevOtherPermsCount.current) {
      setPermsCollapsed(false);
    }
    prevOtherPermsCount.current = otherPerms.length;
  }, [otherPerms.length]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* CLI starting banner (CLI has never connected yet — still spawning) */}
      {connStatus === "connected" && !cliConnected && !cliEverConnected && (
        <div className="px-4 py-2 bg-cc-border/30 border-b border-cc-border text-center flex items-center justify-center gap-2">
          <svg className="animate-spin h-3 w-3 text-cc-text-secondary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-xs text-cc-text-secondary font-medium">
            Starting session...
          </span>
        </div>
      )}

      {/* CLI disconnected banner (CLI was connected before but dropped) */}
      {connStatus === "connected" && !cliConnected && cliEverConnected && (
        <div className={`px-4 py-2 border-b text-center flex items-center justify-center gap-3 ${
          cliDisconnectReason === "idle_limit"
            ? "bg-cc-border/30 border-cc-border"
            : "bg-cc-warning/10 border-cc-warning/20"
        }`}>
          <span className={`text-xs font-medium ${
            cliDisconnectReason === "idle_limit" ? "text-cc-text-secondary" : "text-cc-warning"
          }`}>
            {cliDisconnectReason === "idle_limit"
              ? "Session paused to stay within keep-alive limit"
              : "CLI disconnected"}
          </span>
          <button
            onClick={() => api.relaunchSession(sessionId).catch(console.error)}
            className={`text-xs font-medium px-3 py-1 rounded-md transition-colors cursor-pointer ${
              cliDisconnectReason === "idle_limit"
                ? "bg-cc-hover hover:bg-cc-border text-cc-fg"
                : "bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-warning"
            }`}
          >
            Resume
          </button>
        </div>
      )}

      {/* WebSocket disconnected banner */}
      {connStatus === "disconnected" && (
        <div className="px-4 py-2 bg-cc-warning/10 border-b border-cc-warning/20 text-center">
          <span className="text-xs text-cc-warning font-medium">
            Reconnecting to session...
          </span>
        </div>
      )}

      {/* Plan overlay fills the chat area, OR show the normal message feed */}
      {showPlanOverlay ? (
        <PlanReviewOverlay
          permission={planPerm}
          sessionId={sessionId}
          onCollapse={() => setPlanCollapsed(true)}
        />
      ) : (
        <MessageFeed sessionId={sessionId} />
      )}

      {/* Collapsed plan chip (when plan exists but is collapsed) */}
      {planPerm && planCollapsed && (
        <div className="shrink-0 border-t border-cc-border bg-cc-card px-2 sm:px-4 py-2">
          <PlanCollapsedChip
            permission={planPerm}
            sessionId={sessionId}
            onExpand={() => setPlanCollapsed(false)}
          />
        </div>
      )}

      {/* Non-plan permission banners — collapsible */}
      {otherPerms.length > 0 && (
        permsCollapsed ? (
          <PermissionsCollapsedChip
            permissions={otherPerms}
            onExpand={() => setPermsCollapsed(false)}
          />
        ) : (
          <div className="shrink-0 max-h-[60dvh] overflow-y-auto border-t border-cc-border bg-cc-card">
            <div
              onClick={() => setPermsCollapsed(true)}
              className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-cc-card border-b border-cc-border/50 cursor-pointer hover:bg-cc-hover/50 transition-colors"
              role="button"
              title="Minimize approvals"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span className="text-[11px] font-medium text-cc-warning">
                {otherPerms.length} pending approval{otherPerms.length !== 1 ? "s" : ""}
              </span>
              <span className="ml-auto p-1.5 rounded-md text-cc-muted">
                <svg className="w-3.5 h-3.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" />
                  <path d="M4 8h4" />
                </svg>
              </span>
            </div>
            {otherPerms.map((p) => (
              <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
            ))}
          </div>
        )
      )}

      {/* Streaming status — fixed above composer */}
      <ElapsedTimer sessionId={sessionId} />

      {/* Composer */}
      <Composer sessionId={sessionId} />
    </div>
  );
}
