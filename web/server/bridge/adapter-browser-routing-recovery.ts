import type { ActiveTurnRoute, BrowserIncomingMessage, SessionState } from "../session-types.js";
import { sessionTag } from "../session-tag.js";
import type {
  AdapterBrowserRoutingDeps,
  AdapterBrowserRoutingSessionLike,
} from "./adapter-browser-routing-controller.js";

type IngestedUserMessageRouteSource = {
  historyEntry: Pick<Extract<BrowserIncomingMessage, { type: "user_message" }>, "questId" | "threadKey">;
};

export function maybeRequestAdapterRelaunchForUserMessage(
  session: AdapterBrowserRoutingSessionLike,
  deps: AdapterBrowserRoutingDeps,
): void {
  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  if (
    session.state.backend_state === "broken" ||
    session.state.backend_state === "recovery_suppressed" ||
    !launcherInfo ||
    launcherInfo.state === "starting"
  ) {
    return;
  }
  if (launcherInfo.killedByIdleManager) {
    launcherInfo.killedByIdleManager = false;
    console.log(`[ws-bridge] Clearing idle-killed flag for session ${sessionTag(session.id)} (adapter user_message)`);
  }
  console.log(
    `[ws-bridge] User message queued while ${session.backendType} session ${sessionTag(session.id)} is not ready, requesting relaunch`,
  );
  if (session.backendType === "codex") {
    const recoveryRequested = deps.requestCodexAutoRecovery(session, "queued_user_message_adapter_missing");
    if (recoveryRequested) return;
    if ((session.state as Pick<SessionState, "backend_state">).backend_state === "recovery_suppressed") {
      deps.setGenerating(session, false, "codex_recovery_suppressed");
      deps.broadcastStatusChange(session, null);
    }
    return;
  }
  deps.requestCliRelaunch?.(session.id);
}

export function activeTurnRouteFromIngestedUserMessage(ingested: IngestedUserMessageRouteSource): ActiveTurnRoute {
  const threadKey = ingested.historyEntry.threadKey ?? "main";
  return {
    threadKey,
    ...(ingested.historyEntry.questId ? { questId: ingested.historyEntry.questId } : {}),
  };
}
