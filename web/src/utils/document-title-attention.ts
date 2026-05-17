import type { SdkSessionInfo, SessionNotification } from "../types.js";
import { getGlobalNeedsInputEntries } from "./global-needs-input.js";
import { deriveSessionStatus } from "./session-visual-status.js";

interface DocumentTitleAttentionState {
  sdkSessions: SdkSessionInfo[];
  sessionNotifications: Map<string, SessionNotification[]>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  cliConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | "recovery_suppressed" | null>;
  countUserPermissions: (permissions: Map<string, unknown> | undefined) => number;
}

export function getDocumentTitleAttentionCount(state: DocumentTitleAttentionState): number {
  const globalNeedsInputEntries = getGlobalNeedsInputEntries({
    sessionNotifications: state.sessionNotifications,
    sdkSessions: state.sdkSessions,
    sessionNames: new Map(),
  });
  const needsInputSessionIds = new Set(globalNeedsInputEntries.map((entry) => entry.sessionId));
  let count = globalNeedsInputEntries.length;

  for (const sdk of state.sdkSessions) {
    if (sdk.archived) continue;
    const permCount = state.countUserPermissions(state.pendingPermissions.get(sdk.sessionId));
    const visualStatus = deriveSessionStatus({
      permCount,
      isConnected: state.cliConnected.get(sdk.sessionId) ?? sdk.cliConnected ?? false,
      sdkState: sdk.state ?? null,
      status: state.sessionStatus.get(sdk.sessionId) ?? null,
      hasUnread: !!state.sessionAttention.get(sdk.sessionId),
      idleKilled: state.cliDisconnectReason.get(sdk.sessionId) === "idle_limit",
    });

    if (visualStatus === "permission") {
      count += 1;
      continue;
    }
    if (needsInputSessionIds.has(sdk.sessionId)) continue;
    if (visualStatus === "completed_unread") count += 1;
  }

  return count;
}
