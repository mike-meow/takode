import type { BrowserIncomingMessage, PermissionRequest, SessionState } from "../session-types.js";
import { NOTABLE_APPROVALS } from "./permission-summaries.js";
import { extractAskUserAnswers } from "./compaction-recovery.js";

export interface PermissionResponseSessionLike {
  id: string;
  pendingPermissions: Map<string, PermissionRequest>;
  messageHistory: BrowserIncomingMessage[];
  state: Pick<SessionState, "askPermission">;
}

interface PermissionResponseMessage {
  type: "permission_response";
  request_id: string;
  behavior: "allow" | "deny";
  updated_input?: Record<string, unknown>;
  updated_permissions?: unknown[];
  message?: string;
}

interface PermissionResponseDeps {
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  abortAutoApproval: (session: PermissionResponseSessionLike, requestId: string) => void;
  cancelPermissionNotification: (sessionId: string, requestId: string) => void;
  clearActionAttentionIfNoPermissions: (session: PermissionResponseSessionLike) => void;
  sendToCLI: (session: PermissionResponseSessionLike, ndjson: string) => void;
  handleSetPermissionMode: (session: PermissionResponseSessionLike, mode: string) => void;
  getApprovalSummary: (toolName: string, input: Record<string, unknown>) => string;
  getDenialSummary: (toolName: string, input: Record<string, unknown>) => string;
  broadcastToBrowsers: (session: PermissionResponseSessionLike, msg: BrowserIncomingMessage) => void;
  emitTakodePermissionResolved: (
    sessionId: string,
    toolName: string,
    outcome: "approved" | "denied",
    actorSessionId?: string,
  ) => void;
  setGeneratingRunningAfterExitPlanMode: (session: PermissionResponseSessionLike) => void;
  handleInterrupt: (session: PermissionResponseSessionLike, actorSessionId?: string) => void;
  persistSession: (session: PermissionResponseSessionLike) => void;
}

export function handlePermissionResponse(
  session: PermissionResponseSessionLike,
  msg: PermissionResponseMessage,
  deps: PermissionResponseDeps,
  actorSessionId?: string,
): void {
  const pending = session.pendingPermissions.get(msg.request_id);
  session.pendingPermissions.delete(msg.request_id);
  deps.onSessionActivityStateChanged(session.id, "permission_response");
  deps.abortAutoApproval(session, msg.request_id);
  deps.cancelPermissionNotification(session.id, msg.request_id);
  deps.clearActionAttentionIfNoPermissions(session);

  if (msg.behavior === "allow") {
    const response: Record<string, unknown> = {
      behavior: "allow",
      updatedInput: msg.updated_input ?? pending?.input ?? {},
    };
    if (msg.updated_permissions?.length) {
      response.updatedPermissions = msg.updated_permissions;
    }
    deps.sendToCLI(
      session,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response,
        },
      }),
    );

    if (msg.updated_permissions?.length) {
      const setMode = (msg.updated_permissions as Array<{ type: string; mode?: string }>).find(
        (entry) => entry.type === "setMode" && entry.mode,
      );
      if (setMode) {
        deps.handleSetPermissionMode(session, setMode.mode!);
      }
    }

    if (pending && NOTABLE_APPROVALS.has(pending.tool_name)) {
      const answers =
        pending.tool_name === "AskUserQuestion" ? extractAskUserAnswers(pending.input, msg.updated_input) : undefined;
      if (pending.tool_name !== "AskUserQuestion" || answers) {
        const approvedMsg: BrowserIncomingMessage = {
          type: "permission_approved",
          id: `approval-${msg.request_id}`,
          request_id: msg.request_id,
          tool_name: pending.tool_name,
          tool_use_id: pending.tool_use_id,
          summary: deps.getApprovalSummary(pending.tool_name, pending.input),
          timestamp: Date.now(),
          ...(answers ? { answers } : {}),
        };
        session.messageHistory.push(approvedMsg);
        deps.broadcastToBrowsers(session, approvedMsg);
      }
    }

    if (pending) {
      deps.emitTakodePermissionResolved(session.id, pending.tool_name, "approved", actorSessionId);
    }

    if (pending?.tool_name === "ExitPlanMode") {
      const askPerm = session.state.askPermission !== false;
      deps.handleSetPermissionMode(session, askPerm ? "acceptEdits" : "bypassPermissions");
      deps.setGeneratingRunningAfterExitPlanMode(session);
    }
    if (pending?.tool_name === "EnterPlanMode") {
      deps.handleSetPermissionMode(session, "plan");
    }
  } else {
    deps.sendToCLI(
      session,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {
            behavior: "deny",
            message: msg.message || "Denied by user",
          },
        },
      }),
    );

    if (pending?.tool_name === "ExitPlanMode") {
      deps.handleInterrupt(session, actorSessionId);
    }

    const deniedMsg: BrowserIncomingMessage = {
      type: "permission_denied",
      id: `denial-${msg.request_id}`,
      request_id: msg.request_id,
      tool_name: pending?.tool_name || "unknown",
      tool_use_id: pending?.tool_use_id || "",
      summary: deps.getDenialSummary(pending?.tool_name || "unknown", pending?.input || {}),
      timestamp: Date.now(),
    };
    session.messageHistory.push(deniedMsg);
    deps.broadcastToBrowsers(session, deniedMsg);
    deps.emitTakodePermissionResolved(session.id, pending?.tool_name || "unknown", "denied", actorSessionId);
  }

  deps.persistSession(session);
}
