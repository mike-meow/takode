import { randomUUID } from "node:crypto";
import { evaluatePermission, type RecentToolCall } from "../auto-approver.js";
import type { AutoApprovalConfig } from "../auto-approval-store.js";
import {
  handlePermissionRequest as handlePermissionRequestPipeline,
  type PermissionPipelineResult,
} from "./permission-pipeline.js";
import { getAutoApprovalSummary } from "./permission-summaries.js";
import type {
  BrowserIncomingMessage,
  CLIControlRequestMessage,
  McpServerConfig,
  McpServerDetail,
  PermissionRequest,
  SessionState,
  CodexOutboundTurn,
} from "../session-types.js";
type InterruptSource = "user" | "leader" | "system";
type ControlResponseHandler = {
  subtype: string;
  resolve: (response: unknown) => void;
};
export interface BrowserControlRoutingSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  messageHistory: Array<
    BrowserIncomingMessage & {
      message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> };
    }
  >;
  pendingPermissions: Map<string, PermissionRequest>;
  evaluatingAborts: Map<string, AbortController>;
  pendingCodexTurns: CodexOutboundTurn[];
  state: Pick<SessionState, "cwd" | "model" | "permissionMode" | "uiMode" | "askPermission" | "codex_reasoning_effort">;
  codexAdapter: ({ sendBrowserMessage(msg: unknown): boolean; getCurrentTurnId(): string | null } & {
    isConnected?(): boolean;
  }) | null;
  claudeSdkAdapter: { sendBrowserMessage(msg: unknown): boolean } | null;
}
export interface BrowserControlRoutingDeps {
  sendToCLI: (session: BrowserControlRoutingSessionLike, ndjson: string) => void;
  broadcastToBrowsers: (session: BrowserControlRoutingSessionLike, msg: BrowserIncomingMessage) => void;
  persistSession: (session: BrowserControlRoutingSessionLike) => void;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  setAttentionAction: (session: BrowserControlRoutingSessionLike) => void;
  clearActionAttentionIfNoPermissions: (session: BrowserControlRoutingSessionLike) => void;
  emitTakodePermissionRequest: (session: BrowserControlRoutingSessionLike, request: PermissionRequest) => void;
  emitTakodePermissionResolved: (
    sessionId: string,
    toolName: string,
    outcome: "approved" | "denied",
  ) => void;
  schedulePermissionNotification: (session: BrowserControlRoutingSessionLike, request: PermissionRequest) => void;
  cancelPermissionNotification: (sessionId: string, requestId: string) => void;
  broadcastAutoApproval: (session: BrowserControlRoutingSessionLike, request: PermissionRequest) => void;
  onAgentPaused?: (sessionId: string, history: BrowserControlRoutingSessionLike["messageHistory"], cwd: string) => void;
  getCurrentTurnTriggerSource: (session: BrowserControlRoutingSessionLike) => "user" | "leader" | "system" | "unknown";
  buildPermissionPreview: (request: PermissionRequest) => Record<string, unknown>;
  findLastAssistantMessageIndex: (session: BrowserControlRoutingSessionLike) => number | undefined;
  abortAutoApproval: (session: BrowserControlRoutingSessionLike, requestId: string) => void;
  getInterruptSourceFromActorSessionId: (actorSessionId: string | undefined) => InterruptSource;
  preInterrupt: (session: BrowserControlRoutingSessionLike, source: InterruptSource) => void;
  markTurnInterrupted: (session: BrowserControlRoutingSessionLike, source: InterruptSource) => void;
  setGenerating: (session: BrowserControlRoutingSessionLike, generating: boolean, reason: string) => void;
  broadcastStatusChange: (session: BrowserControlRoutingSessionLike, status: "idle" | "running" | "compacting" | "reverting" | null) => void;
  getLauncherSessionInfo: (sessionId: string) => {
    permissionMode?: string;
    askPermission?: boolean;
    model?: string;
    codexReasoningEffort?: string;
  } | null | undefined;
  requestCodexIntentionalRelaunch: (session: BrowserControlRoutingSessionLike, reason: string, delayMs?: number) => void;
  onPermissionModeChanged?: (sessionId: string, newMode: string) => void;
  sendControlRequest: (
    session: BrowserControlRoutingSessionLike,
    request: Record<string, unknown>,
    onResponse?: ControlResponseHandler,
  ) => void;
}
export function handleControlRequest(
  session: BrowserControlRoutingSessionLike,
  msg: CLIControlRequestMessage,
  deps: BrowserControlRoutingDeps,
): void {
  if (msg.request.subtype !== "can_use_tool") return;
  const toolName = msg.request.tool_name;
  const applyResult = (result: PermissionPipelineResult): void => {
    if (result.kind === "mode_auto_approved" || result.kind === "settings_rule_approved") {
      deps.sendToCLI(
        session,
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: result.request.request_id,
            response: {
              behavior: "allow",
              updatedInput: result.request.input,
            },
          },
        }),
      );
      deps.broadcastAutoApproval(session, result.request);
      return;
    }
    if (result.kind === "queued_for_llm_auto_approval") {
      void tryLlmAutoApproval(session, result.request.request_id, result.request, result.autoApprovalConfig, deps);
    }
    if (toolName === "ExitPlanMode" && deps.onAgentPaused) {
      deps.onAgentPaused(session.id, [...session.messageHistory], session.state.cwd);
    }
  };
  const resultOrPromise = handlePermissionRequestPipeline(
    session as never,
    {
      request_id: msg.request_id,
      tool_name: toolName,
      input: msg.request.input,
      permission_suggestions: msg.request.permission_suggestions,
      description: msg.request.description,
      tool_use_id: msg.request.tool_use_id,
      agent_id: msg.request.agent_id,
    },
    "claude-ws",
    {
      onSessionActivityStateChanged: deps.onSessionActivityStateChanged,
      broadcastPermissionRequest: (targetSession, request) =>
        deps.broadcastToBrowsers(targetSession as never, {
          type: "permission_request",
          request,
        }),
      persistSession: (targetSession) => deps.persistSession(targetSession as never),
      setAttentionAction: (targetSession) => deps.setAttentionAction(targetSession as never),
      emitTakodePermissionRequest: (targetSession, request) =>
        deps.emitTakodePermissionRequest(targetSession as never, request),
      schedulePermissionNotification: (targetSession, request) =>
        deps.schedulePermissionNotification(targetSession as never, request),
    },
    { activityReason: "permission_request" },
  );
  if (resultOrPromise instanceof Promise) {
    void resultOrPromise
      .then(applyResult)
      .catch((err) => {
        console.error(`[ws-bridge] Failed to process control_request for session ${session.id}:`, err);
      });
    return;
  }
  applyResult(resultOrPromise);
}
export function handleSdkPermissionRequest(
  session: BrowserControlRoutingSessionLike,
  perm: PermissionRequest,
  deps: BrowserControlRoutingDeps,
): void | Promise<void> {
  const applyResult = (result: PermissionPipelineResult): void => {
    if (result.kind === "mode_auto_approved" || result.kind === "settings_rule_approved") {
      if (session.claudeSdkAdapter) {
        session.claudeSdkAdapter.sendBrowserMessage({
          type: "permission_response",
          request_id: result.request.request_id,
          behavior: "allow",
          updated_input: result.request.input,
        });
      }
      deps.broadcastAutoApproval(session, result.request);
      return;
    }
    if (result.kind === "queued_for_llm_auto_approval") {
      void tryLlmAutoApproval(session, result.request.request_id, result.request, result.autoApprovalConfig, deps);
    }
  };
  const resultOrPromise = handlePermissionRequestPipeline(
    session as never,
    perm,
    "claude-sdk",
    {
      onSessionActivityStateChanged: deps.onSessionActivityStateChanged,
      broadcastPermissionRequest: (targetSession, request) =>
        deps.broadcastToBrowsers(targetSession as never, {
          type: "permission_request",
          request,
        }),
      persistSession: (targetSession) => deps.persistSession(targetSession as never),
      setAttentionAction: (targetSession) => deps.setAttentionAction(targetSession as never),
      emitTakodePermissionRequest: (targetSession, request) =>
        deps.emitTakodePermissionRequest(targetSession as never, request),
      schedulePermissionNotification: (targetSession, request) =>
        deps.schedulePermissionNotification(targetSession as never, request),
    },
    { activityReason: "sdk_permission_request" },
  );
  if (resultOrPromise instanceof Promise) {
    return resultOrPromise.then(applyResult);
  }
  applyResult(resultOrPromise);
}
export async function tryLlmAutoApproval(
  session: BrowserControlRoutingSessionLike,
  requestId: string,
  perm: PermissionRequest,
  config: AutoApprovalConfig,
  deps: BrowserControlRoutingDeps,
): Promise<void> {
  const abort = new AbortController();
  session.evaluatingAborts.set(requestId, abort);
  const recentToolCalls = extractRecentToolCalls(session);
  try {
    const result = await evaluatePermission(
      session.id,
      perm.tool_name,
      perm.input,
      perm.description,
      session.state.cwd,
      config,
      abort.signal,
      recentToolCalls,
      session.state.model,
      () => {
        if (!session.pendingPermissions.has(requestId)) return;
        perm.evaluating = "evaluating";
        deps.broadcastToBrowsers(session, {
          type: "permission_evaluating_status",
          request_id: requestId,
          evaluating: "evaluating",
          timestamp: Date.now(),
        });
      },
    );
    session.evaluatingAborts.delete(requestId);
    if (!session.pendingPermissions.has(requestId)) return;
    if (result?.decision === "approve") {
      session.pendingPermissions.delete(requestId);
      deps.onSessionActivityStateChanged(session.id, "auto_approved_permission");
      deps.cancelPermissionNotification(session.id, requestId);
      deps.clearActionAttentionIfNoPermissions(session);
      routeApprovalResponse(session, requestId, perm.input, deps);
      deps.broadcastToBrowsers(session, {
        type: "permission_auto_approved",
        request_id: requestId,
        tool_name: perm.tool_name,
        tool_use_id: perm.tool_use_id,
        reason: result.reason,
        summary: getAutoApprovalSummary(perm.tool_name, perm.input),
        timestamp: Date.now(),
      });
      deps.emitTakodePermissionResolved(session.id, perm.tool_name, "approved");
      deps.persistSession(session);
      return;
    }
    const deferralReason =
      result?.decision === "defer"
        ? result.reason || "Auto-approver deferred to human"
        : "Auto-approval evaluation failed or timed out";
    perm.evaluating = undefined;
    perm.deferralReason = deferralReason;
    deps.broadcastToBrowsers(session, {
      type: "permission_needs_attention",
      request_id: requestId,
      timestamp: Date.now(),
      reason: deferralReason,
    });
    deps.emitTakodePermissionRequest(session, perm);
    deps.setAttentionAction(session);
    deps.schedulePermissionNotification(session, perm);
    deps.persistSession(session);
  } catch (err) {
    session.evaluatingAborts.delete(requestId);
    if (session.pendingPermissions.has(requestId)) {
      const errorReason = "Auto-approval evaluation encountered an error";
      perm.evaluating = undefined;
      perm.deferralReason = errorReason;
      deps.broadcastToBrowsers(session, {
        type: "permission_needs_attention",
        request_id: requestId,
        timestamp: Date.now(),
        reason: errorReason,
      });
      deps.emitTakodePermissionRequest(session, perm);
      deps.setAttentionAction(session);
      deps.persistSession(session);
    }
    console.warn(`[auto-approver] Error evaluating ${perm.tool_name} for session ${session.id}:`, err);
  }
}
export function handleInterrupt(
  session: BrowserControlRoutingSessionLike,
  source: InterruptSource,
  deps: BrowserControlRoutingDeps,
): void {
  deps.preInterrupt(session, source);
  deps.markTurnInterrupted(session, source);
  deps.sendToCLI(
    session,
    JSON.stringify({
      type: "control_request",
      request_id: randomUUID(),
      request: { subtype: "interrupt" },
    }),
  );
}
export function handleSetPermissionMode(
  session: BrowserControlRoutingSessionLike,
  mode: string,
  deps: BrowserControlRoutingDeps,
): void {
  if (session.backendType === "claude-sdk" && session.claudeSdkAdapter) {
    session.claudeSdkAdapter.sendBrowserMessage({ type: "set_permission_mode", mode });
  } else {
    deps.sendToCLI(
      session,
      JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "set_permission_mode", mode },
      }),
    );
  }
  const uiMode = mode === "plan" ? "plan" : "agent";
  session.state.permissionMode = mode;
  session.state.uiMode = uiMode;
  const launchInfo = deps.getLauncherSessionInfo(session.id);
  if (launchInfo) launchInfo.permissionMode = mode;
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: { permissionMode: mode, uiMode },
  });
  deps.persistSession(session);
}
export function handleCodexSetPermissionMode(
  session: BrowserControlRoutingSessionLike,
  mode: string,
  deps: BrowserControlRoutingDeps,
): void {
  if (!mode || session.state.permissionMode === mode) return;
  if (session.pendingPermissions.size > 0) {
    const approve = mode === "bypassPermissions";
    for (const [reqId, perm] of session.pendingPermissions) {
      if (session.codexAdapter) {
        session.codexAdapter.sendBrowserMessage({
          type: "permission_response",
          request_id: reqId,
          behavior: approve ? "allow" : "deny",
        });
      }
      if (approve) {
        const approvedMsg: BrowserIncomingMessage = {
          type: "permission_approved",
          id: `approval-${reqId}`,
          request_id: reqId,
          tool_name: perm.tool_name,
          tool_use_id: perm.tool_use_id,
          summary: `${perm.tool_name}`,
          timestamp: Date.now(),
        };
        session.messageHistory.push(approvedMsg);
        deps.broadcastToBrowsers(session, approvedMsg);
      } else {
        deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      }
      deps.abortAutoApproval(session, reqId);
      deps.cancelPermissionNotification(session.id, reqId);
      deps.emitTakodePermissionResolved(session.id, perm.tool_name, approve ? "approved" : "denied");
    }
    session.pendingPermissions.clear();
    deps.clearActionAttentionIfNoPermissions(session);
  }
  const previousAsk = session.state.askPermission !== false;
  const codexUiMode = mode === "plan" ? "plan" : "agent";
  const codexAskPermission = mode === "plan" ? previousAsk : mode !== "bypassPermissions";
  session.state.permissionMode = mode;
  session.state.uiMode = codexUiMode;
  session.state.askPermission = codexAskPermission;
  const launchInfo = deps.getLauncherSessionInfo(session.id);
  if (launchInfo) {
    launchInfo.permissionMode = mode;
    launchInfo.askPermission = codexAskPermission;
  }
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: { permissionMode: mode, uiMode: codexUiMode, askPermission: codexAskPermission },
  });
  deps.persistSession(session);
  deps.requestCodexIntentionalRelaunch(session, "set_permission_mode", 100);
}
export function handleSetAskPermission(
  session: BrowserControlRoutingSessionLike,
  askPermission: boolean,
  deps: BrowserControlRoutingDeps,
): void {
  if (session.backendType === "codex") {
    const uiMode = session.state.uiMode === "plan" ? "plan" : "agent";
    const newMode = uiMode === "plan" ? "plan" : askPermission ? "suggest" : "bypassPermissions";
    if (session.state.askPermission === askPermission && session.state.permissionMode === newMode) return;
    session.state.askPermission = askPermission;
    session.state.permissionMode = newMode;
    session.state.uiMode = uiMode;
    const launchInfo = deps.getLauncherSessionInfo(session.id);
    if (launchInfo) {
      launchInfo.permissionMode = newMode;
      launchInfo.askPermission = askPermission;
    }
    deps.broadcastToBrowsers(session, {
      type: "session_update",
      session: { askPermission, permissionMode: newMode, uiMode },
    });
    deps.persistSession(session);
    deps.requestCodexIntentionalRelaunch(session, "set_ask_permission");
    return;
  }
  session.state.askPermission = askPermission;
  const uiMode = session.state.uiMode ?? "agent";
  const newMode = uiMode === "plan" ? "plan" : askPermission ? "acceptEdits" : "bypassPermissions";
  session.state.permissionMode = newMode;
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: { askPermission, permissionMode: newMode, uiMode },
  });
  deps.persistSession(session);
  if (session.backendType === "claude-sdk" && session.claudeSdkAdapter) {
    session.claudeSdkAdapter.sendBrowserMessage({ type: "set_permission_mode", mode: newMode });
    const launchInfo = deps.getLauncherSessionInfo(session.id);
    if (launchInfo) launchInfo.permissionMode = newMode;
  } else {
    deps.onPermissionModeChanged?.(session.id, newMode);
  }
}
export function handleMcpGetStatus(
  session: BrowserControlRoutingSessionLike,
  deps: BrowserControlRoutingDeps,
): void {
  deps.sendControlRequest(session, { subtype: "mcp_status" }, {
    subtype: "mcp_status",
    resolve: (response) => {
      const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
      deps.broadcastToBrowsers(session, { type: "mcp_status", servers });
    },
  });
}
export function handleMcpToggle(
  session: BrowserControlRoutingSessionLike,
  serverName: string,
  enabled: boolean,
  deps: BrowserControlRoutingDeps,
): void {
  deps.sendControlRequest(session, { subtype: "mcp_toggle", serverName, enabled });
  setTimeout(() => handleMcpGetStatus(session, deps), 500);
}
export function handleMcpReconnect(
  session: BrowserControlRoutingSessionLike,
  serverName: string,
  deps: BrowserControlRoutingDeps,
): void {
  deps.sendControlRequest(session, { subtype: "mcp_reconnect", serverName });
  setTimeout(() => handleMcpGetStatus(session, deps), 1000);
}
export function handleMcpSetServers(
  session: BrowserControlRoutingSessionLike,
  servers: Record<string, McpServerConfig>,
  deps: BrowserControlRoutingDeps,
): void {
  deps.sendControlRequest(session, { subtype: "mcp_set_servers", servers });
  setTimeout(() => handleMcpGetStatus(session, deps), 2000);
}
function extractRecentToolCalls(session: BrowserControlRoutingSessionLike, limit = 10): RecentToolCall[] {
  const calls: RecentToolCall[] = [];
  for (let i = session.messageHistory.length - 1; i >= 0 && calls.length < limit; i--) {
    const msg = session.messageHistory[i];
    if (msg.type !== "assistant" || !msg.message?.content) continue;
    const blocks = msg.message.content;
    for (let j = blocks.length - 1; j >= 0 && calls.length < limit; j--) {
      const block = blocks[j];
      if (block.type === "tool_use") {
        calls.push({ toolName: block.name, input: block.input as Record<string, unknown> });
      }
    }
  }
  return calls.reverse();
}
function routeApprovalResponse(
  session: BrowserControlRoutingSessionLike,
  requestId: string,
  updatedInput: Record<string, unknown>,
  deps: BrowserControlRoutingDeps,
): void {
  const ndjson = JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "allow",
        updatedInput,
      },
    },
  });
  if (session.backendType === "claude-sdk" && session.claudeSdkAdapter) {
    session.claudeSdkAdapter.sendBrowserMessage({
      type: "permission_response",
      request_id: requestId,
      behavior: "allow",
      updated_input: updatedInput,
    });
  } else if (session.backendType === "codex" && session.codexAdapter) {
    session.codexAdapter.sendBrowserMessage({
      type: "permission_response",
      request_id: requestId,
      behavior: "allow",
      updated_input: updatedInput,
    });
  } else {
    deps.sendToCLI(session, ndjson);
  }
}
