import { randomUUID } from "node:crypto";
import { evaluatePermission, type RecentToolCall } from "../auto-approver.js";
import type { AutoApprovalConfig } from "../auto-approval-store.js";
import { deriveAttachmentPaths, formatAttachmentPathAnnotation } from "../attachment-paths.js";
import type { ImageRef } from "../image-store.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CLIControlRequestMessage,
  CodexOutboundTurn,
  McpServerConfig,
  McpServerDetail,
  PendingCodexInput,
  PermissionRequest,
  SessionState,
} from "../session-types.js";
import { sessionTag } from "../session-tag.js";
import type { BrowserTransportSessionLike, BrowserTransportSocketLike } from "./browser-transport-controller.js";
import type { UserDispatchTurnTarget } from "./generation-lifecycle.js";
import { extractAskUserAnswers } from "./compaction-recovery.js";
import { LONG_SLEEP_REMINDER_TEXT } from "./bash-sleep-policy.js";
import {
  handlePermissionRequest as handlePermissionRequestPipeline,
  type PermissionPipelineResult,
} from "./permission-pipeline.js";
import {
  clearActionAttentionIfNoPermissions as clearActionAttentionIfNoPermissionsSessionRegistryController,
  setAttention as setAttentionSessionRegistryController,
} from "./session-registry-controller.js";
import {
  buildPendingCodexImageDrafts,
  getApprovalSummary,
  getAutoApprovalSummary,
  getDenialSummary,
  NOTABLE_APPROVALS,
} from "./permission-summaries.js";
type InterruptSource = "user" | "leader" | "system";
type ControlResponseHandler = {
  subtype: string;
  resolve: (response: unknown) => void;
};
type BrowserUserMessage = Extract<BrowserOutgoingMessage, { type: "user_message" }>;
type PermissionResponseMessage = Extract<BrowserOutgoingMessage, { type: "permission_response" }>;
type IngestedUserMessage = {
  timestamp: number;
  historyEntry: Extract<BrowserIncomingMessage, { type: "user_message" }>;
  historyIndex: number;
  imageRefs?: ImageRef[];
  wasGenerating: boolean;
};
type SessionNotificationDeps = {
  isHerdedWorkerSession?: (session: AdapterBrowserRoutingSessionLike) => boolean;
  broadcastToBrowsers?: (session: AdapterBrowserRoutingSessionLike, msg: BrowserIncomingMessage) => void;
  persistSession: (session: AdapterBrowserRoutingSessionLike) => void;
  schedulePermissionNotification?: (session: AdapterBrowserRoutingSessionLike, request: PermissionRequest) => void;
  scheduleNotification?: (
    sessionId: string,
    category: "question" | "completed",
    detail: string,
    options?: { skipReadCheck?: boolean },
  ) => void;
  cancelPermissionNotification?: (sessionId: string, requestId: string) => void;
};
export interface AdapterBrowserRoutingSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  state: Pick<
    SessionState,
    | "askPermission"
    | "backend_error"
    | "backend_state"
    | "codex_image_send_stage"
    | "codex_reasoning_effort"
    | "cwd"
    | "is_compacting"
    | "model"
    | "permissionMode"
    | "session_id"
    | "slash_commands"
    | "uiMode"
  >;
  messageHistory: BrowserIncomingMessage[];
  pendingPermissions: Map<string, PermissionRequest>;
  evaluatingAborts: Map<string, AbortController>;
  pendingMessages: string[];
  pendingCodexTurns: CodexOutboundTurn[];
  pendingCodexInputs: PendingCodexInput[];
  forceCompactPending: boolean;
  isGenerating: boolean;
  lastUserMessage?: string;
  lastUserMessageDateTag: string;
  lastOutboundUserNdjson: string | null;
  consecutiveAdapterFailures: number;
  codexAdapter: {
    sendBrowserMessage(msg: unknown): boolean;
    getCurrentTurnId(): string | null;
    isConnected(): boolean;
  } | null;
  claudeSdkAdapter: {
    sendBrowserMessage(msg: unknown): boolean;
    isConnected?(): boolean;
  } | null;
}

export interface AdapterBrowserRoutingDeps {
  sendToCLI: (
    session: AdapterBrowserRoutingSessionLike,
    ndjson: string,
    opts?: {
      deferUntilCliReady?: boolean;
      skipUserDispatchLifecycle?: boolean;
    },
  ) => UserDispatchTurnTarget | null;
  broadcastToBrowsers: (session: AdapterBrowserRoutingSessionLike, msg: BrowserIncomingMessage) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>, actorSessionId?: string) => void;
  persistSession: (session: AdapterBrowserRoutingSessionLike) => void;
  sessionNotificationDeps: SessionNotificationDeps;
  onAgentPaused?: (sessionId: string, history: AdapterBrowserRoutingSessionLike["messageHistory"], cwd: string) => void;
  getCurrentTurnTriggerSource: (session: AdapterBrowserRoutingSessionLike) => "user" | "leader" | "system" | "unknown";
  abortAutoApproval: (session: AdapterBrowserRoutingSessionLike, requestId: string) => void;
  preInterrupt: (session: AdapterBrowserRoutingSessionLike, source: InterruptSource) => void;
  touchUserMessage: (sessionId: string) => void;
  formatVsCodeSelectionPrompt: (selection: NonNullable<BrowserUserMessage["vscodeSelection"]>) => string;
  getCliSessionId: (session: AdapterBrowserRoutingSessionLike) => string;
  nextUserMessageId: (ts: number) => string;
  storeImage?: (sessionId: string, data: string, mediaType: string) => Promise<ImageRef>;
  onUserMessage?: (
    sessionId: string,
    history: AdapterBrowserRoutingSessionLike["messageHistory"],
    cwd: string,
    wasGenerating: boolean,
  ) => void;
  markRunningFromUserDispatch: (
    session: AdapterBrowserRoutingSessionLike,
    reason: string,
    interruptSource?: InterruptSource | null,
  ) => UserDispatchTurnTarget | null;
  trackUserMessageForTurn: (
    session: AdapterBrowserRoutingSessionLike,
    historyIndex: number,
    turnTarget: UserDispatchTurnTarget,
  ) => void;
  setGenerating: (session: AdapterBrowserRoutingSessionLike, generating: boolean, reason: string) => void;
  broadcastStatusChange: (
    session: AdapterBrowserRoutingSessionLike,
    status: "idle" | "running" | "compacting" | "reverting" | null,
  ) => void;
  setCodexImageSendStage: (
    session: AdapterBrowserRoutingSessionLike,
    stage: SessionState["codex_image_send_stage"],
    options?: { persist?: boolean },
  ) => void;
  notifyImageSendFailure: (session: AdapterBrowserRoutingSessionLike, err?: unknown) => void;
  isHerdEventSource: (agentSource: BrowserUserMessage["agentSource"]) => boolean;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  markTurnInterrupted: (session: AdapterBrowserRoutingSessionLike, source: InterruptSource) => void;
  armCodexFreshTurnRequirement: (session: AdapterBrowserRoutingSessionLike, turnId: string, reason: string) => void;
  clearCodexFreshTurnRequirement: (session: AdapterBrowserRoutingSessionLike, reason: string) => void;
  addPendingCodexInput: (session: AdapterBrowserRoutingSessionLike, input: PendingCodexInput) => void;
  getCancelablePendingCodexInputs: (session: AdapterBrowserRoutingSessionLike) => PendingCodexInput[];
  removePendingCodexInput: (session: AdapterBrowserRoutingSessionLike, id: string) => PendingCodexInput | null;
  clearQueuedTurnLifecycleEntries: (session: AdapterBrowserRoutingSessionLike) => void;
  queueCodexPendingStartBatch: (session: AdapterBrowserRoutingSessionLike, reason: string) => void;
  rebuildQueuedCodexPendingStartBatch: (session: AdapterBrowserRoutingSessionLike) => void;
  trySteerPendingCodexInputs: (session: AdapterBrowserRoutingSessionLike, reason: string) => boolean;
  sendToBrowser: (ws: unknown, msg: BrowserIncomingMessage) => void;
  getLauncherSessionInfo: (sessionId: string) =>
    | {
        archived?: boolean;
        askPermission?: boolean;
        cliSessionId?: string;
        codexReasoningEffort?: string;
        herdedBy?: string | null;
        isOrchestrator?: boolean;
        killedByIdleManager?: boolean;
        model?: string;
        permissionMode?: string;
        state?: string;
      }
    | null
    | undefined;
  requestCodexIntentionalRelaunch: (
    session: AdapterBrowserRoutingSessionLike,
    reason: string,
    delayMs?: number,
  ) => void;
  onPermissionModeChanged?: (sessionId: string, newMode: string) => void;
  sendControlRequest: (
    session: AdapterBrowserRoutingSessionLike,
    request: Record<string, unknown>,
    onResponse?: ControlResponseHandler,
  ) => void;
  requestCodexAutoRecovery: (session: AdapterBrowserRoutingSessionLike, reason: string) => boolean;
  requestCliRelaunch?: (sessionId: string) => void;
  injectUserMessage: (
    sessionId: string,
    content: string,
    agentSource?: { sessionId: string; sessionLabel?: string },
  ) => "sent" | "queued" | "no_session";
  handleSetModel: (session: AdapterBrowserRoutingSessionLike, model: string) => void;
  handleCodexSetModel: (session: AdapterBrowserRoutingSessionLike, model: string) => void;
  handleSetPermissionMode: (session: AdapterBrowserRoutingSessionLike, mode: string) => void;
  handleCodexSetPermissionMode: (session: AdapterBrowserRoutingSessionLike, mode: string) => void;
  handleCodexSetReasoningEffort: (session: AdapterBrowserRoutingSessionLike, effort: string) => void;
  handleSetAskPermission: (session: AdapterBrowserRoutingSessionLike, askPermission: boolean) => void;
  handleInterruptFallback: (session: AdapterBrowserRoutingSessionLike, source: InterruptSource) => void;
}

function isSystemSourceTag(agentSource: BrowserUserMessage["agentSource"]): boolean {
  if (!agentSource) return false;
  return agentSource.sessionId === "system" || agentSource.sessionId.startsWith("system:");
}

function getInterruptSourceFromActorSessionId(actorSessionId: string | undefined): InterruptSource {
  if (!actorSessionId) return "user";
  return isSystemSourceTag({ sessionId: actorSessionId }) ? "system" : "leader";
}

function findPendingExitPlanPermission(session: AdapterBrowserRoutingSessionLike): PermissionRequest | undefined {
  for (const perm of session.pendingPermissions.values()) {
    if (perm.tool_name === "ExitPlanMode") return perm;
  }
  return undefined;
}

function findPendingAskUserQuestionPermission(
  session: AdapterBrowserRoutingSessionLike,
): PermissionRequest | undefined {
  for (const perm of session.pendingPermissions.values()) {
    if (perm.tool_name === "AskUserQuestion") return perm;
  }
  return undefined;
}

function buildAskUserQuestionAnswers(
  pendingInput: Record<string, unknown>,
  answerText: string,
): Record<string, string> | undefined {
  const questions = Array.isArray(pendingInput.questions) ? pendingInput.questions : [];
  const answerCount = Math.max(1, questions.length);
  if (answerCount <= 0) return undefined;

  const answers: Record<string, string> = {};
  for (let i = 0; i < answerCount; i++) {
    answers[String(i)] = answerText;
  }
  return answers;
}

function getPendingPlanRejectionMessage(msg: BrowserUserMessage): string {
  if (msg.agentSource?.sessionId && !isSystemSourceTag(msg.agentSource)) {
    return "Plan rejected — leader sent a new message";
  }
  return "Plan rejected — user sent a new message";
}

function maybeAutoRejectPendingPlanForUserMessage(
  session: AdapterBrowserRoutingSessionLike,
  msg: BrowserUserMessage,
  deps: AdapterBrowserRoutingDeps,
): void {
  const pending = findPendingExitPlanPermission(session);
  if (!pending) return;
  if (msg.agentSource?.sessionId === "herd-events") return;
  if (isSystemSourceTag(msg.agentSource)) return;

  const actorSessionId = msg.agentSource?.sessionId;
  const denial: PermissionResponseMessage = {
    type: "permission_response",
    request_id: pending.request_id,
    behavior: "deny",
    message: getPendingPlanRejectionMessage(msg),
    ...(actorSessionId ? { actorSessionId } : {}),
  };

  if (session.backendType === "claude-sdk") {
    handleSdkPermissionResponse(session, denial, deps);
    return;
  }
  if (session.backendType === "codex") {
    handleCodexPermissionResponse(session, denial, deps);
    return;
  }
  handlePermissionResponse(session, denial, deps, actorSessionId);
}

function maybeAutoAnswerPendingQuestionForUserMessage(
  session: AdapterBrowserRoutingSessionLike,
  msg: BrowserUserMessage,
  deps: AdapterBrowserRoutingDeps,
): boolean {
  const pending = findPendingAskUserQuestionPermission(session);
  if (!pending) return false;
  if (msg.agentSource?.sessionId === "herd-events") return false;
  if (isSystemSourceTag(msg.agentSource)) return false;
  if (typeof msg.content !== "string") return false;

  const answers = buildAskUserQuestionAnswers(pending.input, msg.content);
  if (!answers) return false;

  const actorSessionId = msg.agentSource?.sessionId;
  const approval: PermissionResponseMessage = {
    type: "permission_response",
    request_id: pending.request_id,
    behavior: "allow",
    updated_input: { ...pending.input, answers },
    ...(actorSessionId ? { actorSessionId } : {}),
  };

  if (session.backendType === "claude-sdk") {
    handleSdkPermissionResponse(session, approval, deps);
    return true;
  }
  if (session.backendType === "codex") {
    handleCodexPermissionResponse(session, approval, deps);
    return true;
  }
  handlePermissionResponse(session, approval, deps, actorSessionId);
  return true;
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildTimestampTag(
  session: AdapterBrowserRoutingSessionLike,
  ts: number,
  getLauncherSessionInfo: AdapterBrowserRoutingDeps["getLauncherSessionInfo"],
  agentSource?: BrowserUserMessage["agentSource"],
): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateKey = localDateKey(ts);
  const includeDate = !session.lastUserMessageDateTag || dateKey !== session.lastUserMessageDateTag;
  session.lastUserMessageDateTag = dateKey;
  const dateStr = includeDate
    ? d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " "
    : "";
  const timeWithDate = dateStr + time;
  const sessionInfo = getLauncherSessionInfo(session.id);
  if (sessionInfo?.isOrchestrator) {
    if (isSystemSourceTag(agentSource)) return `[System ${timeWithDate}] `;
    if (agentSource?.sessionId === "herd-events") return `[Herd ${timeWithDate}] `;
    if (agentSource) {
      const label = agentSource.sessionLabel || agentSource.sessionId.slice(0, 8);
      return `[Agent ${label} ${timeWithDate}] `;
    }
    return `[User ${timeWithDate}] `;
  }
  if (sessionInfo?.herdedBy && agentSource) {
    const label = agentSource.sessionLabel || agentSource.sessionId.slice(0, 8);
    return `[Leader ${label} ${timeWithDate}] `;
  }
  return `[User ${timeWithDate}] `;
}

export function buildPermissionPreview(request: PermissionRequest): Record<string, unknown> {
  if (request.tool_name === "AskUserQuestion") {
    const questions = request.input.questions as
      | Array<{ question: string; options?: Array<{ label: string }> }>
      | undefined;
    if (questions?.[0]) {
      const options = questions[0].options?.map((option) => option.label);
      return {
        question: questions[0].question,
        ...(options ? { options } : {}),
      };
    }
  }
  if (request.tool_name === "ExitPlanMode") {
    const plan = typeof request.input.plan === "string" ? request.input.plan : undefined;
    if (!plan) return {};
    const maxPlanContent = 10_000;
    return {
      planContent: plan.length > maxPlanContent ? `${plan.slice(0, maxPlanContent)}\n\n... (plan truncated)` : plan,
    };
  }
  return {};
}

export function findLastAssistantMessageIndex(session: AdapterBrowserRoutingSessionLike): number | undefined {
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    if (session.messageHistory[i].type === "assistant") return i;
  }
  return undefined;
}

function emitTakodePermissionRequest(
  session: AdapterBrowserRoutingSessionLike,
  request: PermissionRequest,
  deps: AdapterBrowserRoutingDeps,
): void {
  deps.emitTakodeEvent(session.id, "permission_request", {
    tool_name: request.tool_name,
    request_id: request.request_id,
    summary: request.description || request.tool_name,
    ...buildPermissionPreview(request),
    turn_source: deps.getCurrentTurnTriggerSource(session),
    msg_index: findLastAssistantMessageIndex(session),
  });
}

function emitTakodePermissionResolved(
  sessionId: string,
  toolName: string,
  outcome: "approved" | "denied",
  deps: AdapterBrowserRoutingDeps,
  actorSessionId?: string,
): void {
  deps.emitTakodeEvent(sessionId, "permission_resolved", { tool_name: toolName, outcome }, actorSessionId);
}

function setActionAttention(
  session: AdapterBrowserRoutingSessionLike,
  deps: Pick<AdapterBrowserRoutingDeps, "sessionNotificationDeps">,
): void {
  setAttentionSessionRegistryController(session, "action", deps.sessionNotificationDeps);
}

function schedulePermissionNotification(
  session: AdapterBrowserRoutingSessionLike,
  request: PermissionRequest,
  deps: Pick<AdapterBrowserRoutingDeps, "sessionNotificationDeps">,
): void {
  deps.sessionNotificationDeps.schedulePermissionNotification?.(session, request);
}

function routeImmediateDenyToBackend(
  session: AdapterBrowserRoutingSessionLike,
  requestId: string,
  message: string,
  deps: Pick<AdapterBrowserRoutingDeps, "sendToCLI">,
): void {
  if (session.backendType === "claude-sdk" && session.claudeSdkAdapter) {
    session.claudeSdkAdapter.sendBrowserMessage({
      type: "permission_response",
      request_id: requestId,
      behavior: "deny",
      message,
    });
    return;
  }
  if (session.backendType === "codex" && session.codexAdapter) {
    session.codexAdapter.sendBrowserMessage({
      type: "permission_response",
      request_id: requestId,
      behavior: "deny",
      message,
    });
    return;
  }
  deps.sendToCLI(
    session,
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "deny",
          message,
        },
      },
    }),
  );
}

function appendImmediateDeniedHistory(
  session: AdapterBrowserRoutingSessionLike,
  request: PermissionRequest,
  deps: Pick<AdapterBrowserRoutingDeps, "broadcastToBrowsers">,
): void {
  const deniedMsg: BrowserIncomingMessage = {
    type: "permission_denied",
    id: `denial-${request.request_id}`,
    request_id: request.request_id,
    tool_name: request.tool_name,
    tool_use_id: request.tool_use_id,
    summary: getDenialSummary(request.tool_name, request.input),
    timestamp: Date.now(),
  };
  session.messageHistory.push(deniedMsg);
  deps.broadcastToBrowsers(session, deniedMsg);
}

function injectLongSleepReminder(
  session: AdapterBrowserRoutingSessionLike,
  deps: Pick<AdapterBrowserRoutingDeps, "injectUserMessage">,
  reminder = LONG_SLEEP_REMINDER_TEXT,
): void {
  deps.injectUserMessage(session.id, reminder, {
    sessionId: "system:long-sleep-guard",
    sessionLabel: "System",
  });
}

function applyHardDeniedPermission(
  session: AdapterBrowserRoutingSessionLike,
  result: Extract<PermissionPipelineResult, { kind: "hard_denied" }>,
  deps: AdapterBrowserRoutingDeps,
): void {
  deps.onSessionActivityStateChanged(session.id, "permission_hard_denied");
  routeImmediateDenyToBackend(session, result.request.request_id, result.message, deps);
  appendImmediateDeniedHistory(session, result.request, deps);
  emitTakodePermissionResolved(session.id, result.request.tool_name, "denied", deps);
  injectLongSleepReminder(session, deps, result.reminder);
  deps.persistSession(session);
}

function broadcastAutoApproval(
  session: AdapterBrowserRoutingSessionLike,
  request: PermissionRequest,
  deps: Pick<AdapterBrowserRoutingDeps, "handleSetPermissionMode" | "sessionNotificationDeps">,
): void {
  const approvedMsg: BrowserIncomingMessage = {
    type: "permission_approved",
    id: `approval-${request.request_id}`,
    request_id: request.request_id,
    tool_name: request.tool_name,
    tool_use_id: request.tool_use_id,
    summary: getApprovalSummary(request.tool_name, request.input),
    timestamp: Date.now(),
  };
  session.messageHistory.push(approvedMsg);
  deps.sessionNotificationDeps.broadcastToBrowsers?.(session, approvedMsg);

  if (request.tool_name === "EnterPlanMode") {
    deps.handleSetPermissionMode(session, "plan");
  }

  deps.sessionNotificationDeps.persistSession(session);
}

export async function routeBrowserMessage(
  session: AdapterBrowserRoutingSessionLike & BrowserTransportSessionLike,
  msg: BrowserOutgoingMessage,
  ws: BrowserTransportSocketLike | undefined,
  deps: AdapterBrowserRoutingDeps,
): Promise<void> {
  if (msg.type === "user_message" && msg.images?.length && !deps.storeImage) {
    deps.notifyImageSendFailure(session, new Error("image store unavailable"));
    return;
  }

  if (msg.type === "user_message") {
    if (maybeAutoAnswerPendingQuestionForUserMessage(session, msg, deps)) return;
    maybeAutoRejectPendingPlanForUserMessage(session, msg, deps);
  }

  if (
    msg.type === "user_message" &&
    typeof msg.content === "string" &&
    msg.content.trim().toLowerCase() === "/compact" &&
    !msg.images?.length &&
    session.backendType !== "codex"
  ) {
    handleForceCompact(session, deps);
    return;
  }

  if (
    msg.type === "user_message" &&
    typeof msg.content === "string" &&
    !msg.images?.length &&
    session.backendType !== "codex" &&
    isCliSlashCommand(session, msg.content.trim())
  ) {
    handleCliSlashCommand(session, msg.content.trim(), deps);
    return;
  }

  const maybeAdapterRouted = routeAdapterBrowserMessage(session, msg, ws, deps);
  const adapterRouted = maybeAdapterRouted instanceof Promise ? await maybeAdapterRouted : maybeAdapterRouted;
  if (adapterRouted) return;

  switch (msg.type) {
    case "user_message":
      try {
        await handleUserMessage(session, msg, deps);
      } catch (err) {
        if (msg.images?.length) {
          deps.notifyImageSendFailure(session, err);
          break;
        }
        throw err;
      }
      break;

    case "permission_response":
      handlePermissionResponse(session, msg, deps, msg.actorSessionId);
      break;

    case "interrupt":
      handleInterrupt(session, msg.interruptSource ?? "user", deps);
      break;

    case "set_model":
      deps.handleSetModel(session, msg.model);
      break;

    case "set_codex_reasoning_effort":
      break;

    case "set_permission_mode":
      handleSetPermissionMode(session, msg.mode, deps);
      break;

    case "mcp_get_status":
      handleMcpGetStatus(session, deps);
      break;

    case "mcp_toggle":
      handleMcpToggle(session, msg.serverName, msg.enabled, deps);
      break;

    case "mcp_reconnect":
      handleMcpReconnect(session, msg.serverName, deps);
      break;

    case "mcp_set_servers":
      handleMcpSetServers(session, msg.servers, deps);
      break;

    case "set_ask_permission":
      handleSetAskPermission(session, msg.askPermission, deps);
      break;
  }
}
export function handleControlRequest(
  session: AdapterBrowserRoutingSessionLike,
  msg: CLIControlRequestMessage,
  deps: AdapterBrowserRoutingDeps,
): void {
  if (msg.request.subtype !== "can_use_tool") return;
  const toolName = msg.request.tool_name;
  const applyResult = (result: PermissionPipelineResult): void => {
    if (result.kind === "hard_denied") {
      applyHardDeniedPermission(session, result, deps);
      return;
    }
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
      broadcastAutoApproval(session, result.request, deps);
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
      setAttentionAction: (targetSession) => setActionAttention(targetSession as never, deps),
      emitTakodePermissionRequest: (targetSession, request) =>
        emitTakodePermissionRequest(targetSession as never, request, deps),
      schedulePermissionNotification: (targetSession, request) =>
        schedulePermissionNotification(targetSession as never, request, deps),
    },
    { activityReason: "permission_request" },
  );
  if (resultOrPromise instanceof Promise) {
    void resultOrPromise.then(applyResult).catch((err) => {
      console.error(`[ws-bridge] Failed to process control_request for session ${session.id}:`, err);
    });
    return;
  }
  applyResult(resultOrPromise);
}

export function handleSdkPermissionRequest(
  session: AdapterBrowserRoutingSessionLike,
  perm: PermissionRequest,
  deps: AdapterBrowserRoutingDeps,
): void | Promise<void> {
  const applyResult = (result: PermissionPipelineResult): void => {
    if (result.kind === "hard_denied") {
      applyHardDeniedPermission(session, result, deps);
      return;
    }
    if (result.kind === "mode_auto_approved" || result.kind === "settings_rule_approved") {
      if (session.claudeSdkAdapter) {
        session.claudeSdkAdapter.sendBrowserMessage({
          type: "permission_response",
          request_id: result.request.request_id,
          behavior: "allow",
          updated_input: result.request.input,
        });
      }
      broadcastAutoApproval(session, result.request, deps);
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
      setAttentionAction: (targetSession) => setActionAttention(targetSession as never, deps),
      emitTakodePermissionRequest: (targetSession, request) =>
        emitTakodePermissionRequest(targetSession as never, request, deps),
      schedulePermissionNotification: (targetSession, request) =>
        schedulePermissionNotification(targetSession as never, request, deps),
    },
    { activityReason: "sdk_permission_request" },
  );
  if (resultOrPromise instanceof Promise) {
    return resultOrPromise.then(applyResult);
  }
  applyResult(resultOrPromise);
}

export function handleCodexPermissionRequest(
  session: AdapterBrowserRoutingSessionLike,
  perm: PermissionRequest,
  deps: AdapterBrowserRoutingDeps,
): void | Promise<void> {
  const applyResult = (result: PermissionPipelineResult): void => {
    if (result.kind === "hard_denied") {
      applyHardDeniedPermission(session, result, deps);
      return;
    }
    if (result.kind === "mode_auto_approved" || result.kind === "settings_rule_approved") {
      if (session.codexAdapter) {
        session.codexAdapter.sendBrowserMessage({
          type: "permission_response",
          request_id: result.request.request_id,
          behavior: "allow",
          updated_input: result.request.input,
        });
      }
      broadcastAutoApproval(session, result.request, deps);
      return;
    }

    if (result.kind === "queued_for_llm_auto_approval") {
      void tryLlmAutoApproval(session, result.request.request_id, result.request, result.autoApprovalConfig, deps);
    }
  };

  const resultOrPromise = handlePermissionRequestPipeline(
    session as never,
    perm,
    "codex",
    {
      onSessionActivityStateChanged: deps.onSessionActivityStateChanged,
      broadcastPermissionRequest: (targetSession, request) =>
        deps.broadcastToBrowsers(targetSession as never, {
          type: "permission_request",
          request,
        }),
      persistSession: (targetSession) => deps.persistSession(targetSession as never),
      setAttentionAction: (targetSession) => setActionAttention(targetSession as never, deps),
      emitTakodePermissionRequest: (targetSession, request) =>
        emitTakodePermissionRequest(targetSession as never, request, deps),
      schedulePermissionNotification: (targetSession, request) =>
        schedulePermissionNotification(targetSession as never, request, deps),
    },
    { activityReason: "codex_permission_request" },
  );

  if (resultOrPromise instanceof Promise) {
    return resultOrPromise.then(applyResult).catch((err) => {
      console.error(
        `[ws-bridge] Failed to process Codex permission_request for session ${sessionTag(session.id)}:`,
        err,
      );
    });
  }

  applyResult(resultOrPromise);
}

export async function tryLlmAutoApproval(
  session: AdapterBrowserRoutingSessionLike,
  requestId: string,
  perm: PermissionRequest,
  config: AutoApprovalConfig,
  deps: AdapterBrowserRoutingDeps,
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
      deps.sessionNotificationDeps.cancelPermissionNotification?.(session.id, requestId);
      clearActionAttentionIfNoPermissionsSessionRegistryController(session, deps.sessionNotificationDeps);
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
      emitTakodePermissionResolved(session.id, perm.tool_name, "approved", deps);
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
    emitTakodePermissionRequest(session, perm, deps);
    setActionAttention(session, deps);
    schedulePermissionNotification(session, perm, deps);
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
      emitTakodePermissionRequest(session, perm, deps);
      setActionAttention(session, deps);
      schedulePermissionNotification(session, perm, deps);
      deps.persistSession(session);
    }
    console.warn(`[auto-approver] Error evaluating ${perm.tool_name} for session ${session.id}:`, err);
  }
}

export function handleInterrupt(
  session: AdapterBrowserRoutingSessionLike,
  source: InterruptSource,
  deps: AdapterBrowserRoutingDeps,
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

export function handleSetModel(
  session: AdapterBrowserRoutingSessionLike,
  model: string,
  deps: Pick<AdapterBrowserRoutingDeps, "sendToCLI" | "broadcastToBrowsers" | "persistSession">,
): void {
  if (session.backendType === "claude-sdk" && session.claudeSdkAdapter) {
    session.claudeSdkAdapter.sendBrowserMessage({ type: "set_model", model } as any);
  } else {
    deps.sendToCLI(
      session,
      JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "set_model", model },
      }),
    );
  }
  session.state.model = model;
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: { model },
  });
  deps.persistSession(session);
}

export function handleSetPermissionMode(
  session: AdapterBrowserRoutingSessionLike,
  mode: string,
  deps: AdapterBrowserRoutingDeps,
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
  session: AdapterBrowserRoutingSessionLike,
  mode: string,
  deps: AdapterBrowserRoutingDeps,
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
      deps.sessionNotificationDeps.cancelPermissionNotification?.(session.id, reqId);
      emitTakodePermissionResolved(session.id, perm.tool_name, approve ? "approved" : "denied", deps);
    }
    session.pendingPermissions.clear();
    clearActionAttentionIfNoPermissionsSessionRegistryController(session, deps.sessionNotificationDeps);
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

export function handleCodexSetModel(
  session: AdapterBrowserRoutingSessionLike,
  model: string,
  deps: Pick<
    AdapterBrowserRoutingDeps,
    "getLauncherSessionInfo" | "broadcastToBrowsers" | "persistSession" | "requestCodexIntentionalRelaunch"
  >,
): void {
  const nextModel = model.trim();
  if (!nextModel || session.state.model === nextModel) return;
  session.state.model = nextModel;
  const launchInfo = deps.getLauncherSessionInfo(session.id);
  if (launchInfo) launchInfo.model = nextModel;
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: { model: nextModel },
  });
  deps.persistSession(session);
  deps.requestCodexIntentionalRelaunch(session, "set_model");
}

export function handleCodexSetReasoningEffort(
  session: AdapterBrowserRoutingSessionLike,
  effort: string,
  deps: Pick<
    AdapterBrowserRoutingDeps,
    "getLauncherSessionInfo" | "broadcastToBrowsers" | "persistSession" | "requestCodexIntentionalRelaunch"
  >,
): void {
  const normalized = effort.trim();
  const next = normalized || undefined;
  if (session.state.codex_reasoning_effort === next) return;
  session.state.codex_reasoning_effort = next;
  const launchInfo = deps.getLauncherSessionInfo(session.id);
  if (launchInfo) launchInfo.codexReasoningEffort = next;
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: { codex_reasoning_effort: next },
  });
  deps.persistSession(session);
  deps.requestCodexIntentionalRelaunch(session, "set_codex_reasoning_effort");
}

export function handleSetAskPermission(
  session: AdapterBrowserRoutingSessionLike,
  askPermission: boolean,
  deps: AdapterBrowserRoutingDeps,
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

export function handlePermissionResponse(
  session: AdapterBrowserRoutingSessionLike,
  msg: PermissionResponseMessage,
  deps: AdapterBrowserRoutingDeps,
  actorSessionId?: string,
): void {
  const pending = session.pendingPermissions.get(msg.request_id);
  session.pendingPermissions.delete(msg.request_id);
  deps.onSessionActivityStateChanged(session.id, "permission_response");
  deps.abortAutoApproval(session, msg.request_id);
  deps.sessionNotificationDeps.cancelPermissionNotification?.(session.id, msg.request_id);
  clearActionAttentionIfNoPermissionsSessionRegistryController(session, deps.sessionNotificationDeps);

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
          summary: getApprovalSummary(pending.tool_name, pending.input),
          timestamp: Date.now(),
          ...(answers ? { answers } : {}),
        };
        session.messageHistory.push(approvedMsg);
        deps.broadcastToBrowsers(session, approvedMsg);
      }
    }

    if (pending) {
      emitTakodePermissionResolved(session.id, pending.tool_name, "approved", deps, actorSessionId);
    }

    if (pending?.tool_name === "ExitPlanMode") {
      const askPerm = session.state.askPermission !== false;
      deps.handleSetPermissionMode(session, askPerm ? "acceptEdits" : "bypassPermissions");
      deps.setGenerating(session, true, "exit_plan_mode");
      deps.broadcastStatusChange(session, "running");
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
      const interruptSource = getInterruptSourceFromActorSessionId(actorSessionId);
      deps.handleInterruptFallback(session, interruptSource);
    }

    const deniedMsg: BrowserIncomingMessage = {
      type: "permission_denied",
      id: `denial-${msg.request_id}`,
      request_id: msg.request_id,
      tool_name: pending?.tool_name || "unknown",
      tool_use_id: pending?.tool_use_id || "",
      summary: getDenialSummary(pending?.tool_name || "unknown", pending?.input || {}),
      timestamp: Date.now(),
    };
    session.messageHistory.push(deniedMsg);
    deps.broadcastToBrowsers(session, deniedMsg);
    emitTakodePermissionResolved(session.id, pending?.tool_name || "unknown", "denied", deps, actorSessionId);
  }

  deps.persistSession(session);
}

export function handleMcpGetStatus(session: AdapterBrowserRoutingSessionLike, deps: AdapterBrowserRoutingDeps): void {
  deps.sendControlRequest(
    session,
    { subtype: "mcp_status" },
    {
      subtype: "mcp_status",
      resolve: (response) => {
        const servers = (response as { mcpServers?: McpServerDetail[] }).mcpServers ?? [];
        deps.broadcastToBrowsers(session, { type: "mcp_status", servers });
      },
    },
  );
}

export function handleMcpToggle(
  session: AdapterBrowserRoutingSessionLike,
  serverName: string,
  enabled: boolean,
  deps: AdapterBrowserRoutingDeps,
): void {
  deps.sendControlRequest(session, { subtype: "mcp_toggle", serverName, enabled });
  setTimeout(() => handleMcpGetStatus(session, deps), 500);
}

export function handleMcpReconnect(
  session: AdapterBrowserRoutingSessionLike,
  serverName: string,
  deps: AdapterBrowserRoutingDeps,
): void {
  deps.sendControlRequest(session, { subtype: "mcp_reconnect", serverName });
  setTimeout(() => handleMcpGetStatus(session, deps), 1000);
}

export function handleMcpSetServers(
  session: AdapterBrowserRoutingSessionLike,
  servers: Record<string, McpServerConfig>,
  deps: AdapterBrowserRoutingDeps,
): void {
  deps.sendControlRequest(session, { subtype: "mcp_set_servers", servers });
  setTimeout(() => handleMcpGetStatus(session, deps), 2000);
}

function extractRecentToolCalls(session: AdapterBrowserRoutingSessionLike, limit = 10): RecentToolCall[] {
  const calls: RecentToolCall[] = [];
  for (let i = session.messageHistory.length - 1; i >= 0 && calls.length < limit; i--) {
    const msg = session.messageHistory[i] as
      | (BrowserIncomingMessage & {
          message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> };
        })
      | undefined;
    if (msg?.type !== "assistant" || !msg.message?.content) continue;
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
  session: AdapterBrowserRoutingSessionLike,
  requestId: string,
  updatedInput: Record<string, unknown>,
  deps: AdapterBrowserRoutingDeps,
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

export function ingestUserMessage(
  session: AdapterBrowserRoutingSessionLike,
  msg: BrowserUserMessage,
  deps: AdapterBrowserRoutingDeps,
  options?: { commit?: boolean },
): IngestedUserMessage | Promise<IngestedUserMessage> {
  const ts = Date.now();
  const commit = options?.commit !== false;
  const finalize = (imageRefs?: ImageRef[]): IngestedUserMessage => {
    const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
      type: "user_message",
      content: msg.content,
      timestamp: ts,
      id: deps.nextUserMessageId(ts),
      ...(imageRefs?.length ? { images: imageRefs } : {}),
      ...(msg.client_msg_id ? { client_msg_id: msg.client_msg_id } : {}),
      ...(msg.vscodeSelection ? { vscodeSelection: msg.vscodeSelection } : {}),
      ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
    };
    let userMsgHistoryIdx = -1;
    if (commit) {
      session.messageHistory.push(userHistoryEntry);
      userMsgHistoryIdx = session.messageHistory.length - 1;
      session.lastUserMessage = (msg.content || "").slice(0, 80);
      deps.touchUserMessage(session.id);
      deps.broadcastToBrowsers(session, userHistoryEntry);
      deps.emitTakodeEvent(session.id, "user_message", {
        content: (msg.content || "").slice(0, 120),
        ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
      });
    }
    return {
      timestamp: ts,
      historyEntry: userHistoryEntry,
      historyIndex: userMsgHistoryIdx,
      imageRefs,
      wasGenerating: session.isGenerating,
    };
  };
  if (msg.imageRefs?.length) {
    return finalize(msg.imageRefs);
  }
  if (msg.images?.length) {
    if (!deps.storeImage) {
      throw new Error("image store unavailable");
    }
    const images = msg.images;
    return (async () => {
      const imageRefs = await Promise.all(images.map((img) => deps.storeImage!(session.id, img.data, img.media_type)));
      return finalize(imageRefs);
    })();
  }
  return finalize();
}
export async function handleUserMessage(
  session: AdapterBrowserRoutingSessionLike,
  msg: BrowserUserMessage,
  deps: AdapterBrowserRoutingDeps,
): Promise<void> {
  const maybeIngested = ingestUserMessage(session, msg, deps);
  const ingested = maybeIngested instanceof Promise ? await maybeIngested : maybeIngested;
  const selectionText = msg.vscodeSelection ? deps.formatVsCodeSelectionPrompt(msg.vscodeSelection) : null;
  let content: string | unknown[];
  if (typeof msg.deliveryContent === "string" && msg.deliveryContent.length > 0) {
    content = selectionText
      ? [
          { type: "text", text: msg.deliveryContent },
          { type: "text", text: selectionText },
        ]
      : msg.deliveryContent;
  } else if (msg.images?.length && ingested.imageRefs?.length) {
    const paths = deriveAttachmentPaths(session.id, ingested.imageRefs);
    const textContent = (msg.content || "") + formatAttachmentPathAnnotation(paths);
    content = selectionText
      ? [
          { type: "text", text: textContent },
          { type: "text", text: selectionText },
        ]
      : textContent;
  } else {
    content = selectionText
      ? [
          { type: "text", text: msg.content },
          { type: "text", text: selectionText },
        ]
      : msg.content;
  }
  if (typeof content === "string") {
    content = buildTimestampTag(session, ingested.timestamp, deps.getLauncherSessionInfo, msg.agentSource) + content;
  }
  const ndjson = JSON.stringify({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: msg.session_id || session.state.session_id || "",
  });
  const turnTarget = deps.sendToCLI(session, ndjson, {
    deferUntilCliReady: deps.isHerdEventSource(msg.agentSource),
  });
  deps.trackUserMessageForTurn(session, ingested.historyIndex, turnTarget ?? "current");
  session.lastOutboundUserNdjson = ndjson;
  deps.onUserMessage?.(session.id, [...session.messageHistory], session.state.cwd, ingested.wasGenerating);
}
export function isCliSlashCommand(session: AdapterBrowserRoutingSessionLike, trimmed: string): boolean {
  if (!trimmed.startsWith("/")) return false;
  const commandWord = trimmed.slice(1).split(/\s/)[0].toLowerCase();
  if (!commandWord || commandWord === "compact") return false;
  const knownCommands = session.state.slash_commands;
  if (!knownCommands?.length) return false;
  return knownCommands.some((cmd) => cmd.toLowerCase() === commandWord);
}
export function hasQueuedCompactRequest(session: AdapterBrowserRoutingSessionLike): boolean {
  return session.pendingMessages.some((raw) => {
    try {
      const parsed = JSON.parse(raw) as
        | { type?: string; content?: unknown; message?: { role?: string; content?: unknown } }
        | undefined;
      if (parsed?.type === "user_message") {
        return typeof parsed.content === "string" && parsed.content.trim().toLowerCase() === "/compact";
      }
      if (parsed?.type === "user") {
        return (
          parsed.message?.role === "user" &&
          typeof parsed.message.content === "string" &&
          parsed.message.content.trim().toLowerCase() === "/compact"
        );
      }
    } catch {
      return false;
    }
    return false;
  });
}
export function hasPendingForceCompact(session: AdapterBrowserRoutingSessionLike): boolean {
  return session.forceCompactPending || hasQueuedCompactRequest(session);
}
function markForceCompactPending(session: AdapterBrowserRoutingSessionLike, deps: AdapterBrowserRoutingDeps): void {
  session.forceCompactPending = true;
  session.state.is_compacting = true;
  deps.broadcastStatusChange(session, "compacting");
  deps.persistSession(session);
}
export function queueForceCompactPendingMessage(
  session: AdapterBrowserRoutingSessionLike,
  deps: AdapterBrowserRoutingDeps,
): void {
  if (session.backendType === "claude-sdk") {
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "/compact" }));
  } else {
    session.pendingMessages.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "/compact" },
        parent_tool_use_id: null,
        session_id: deps.getCliSessionId(session),
      }),
    );
  }
  markForceCompactPending(session, deps);
}
export function handleCliSlashCommand(
  session: AdapterBrowserRoutingSessionLike,
  command: string,
  deps: AdapterBrowserRoutingDeps,
): void {
  console.log(`[ws-bridge] CLI slash command intercepted for session ${sessionTag(session.id)}: ${command}`);
  const ts = Date.now();
  const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
    type: "user_message",
    content: command,
    timestamp: ts,
    id: deps.nextUserMessageId(ts),
  };
  session.messageHistory.push(userHistoryEntry);
  session.lastUserMessage = command;
  deps.touchUserMessage(session.id);
  deps.broadcastToBrowsers(session, userHistoryEntry);
  if (session.claudeSdkAdapter) {
    const accepted = session.claudeSdkAdapter.sendBrowserMessage({
      type: "user_message",
      content: command,
    } satisfies BrowserUserMessage);
    if (!accepted) {
      session.pendingMessages.push(JSON.stringify({ type: "user_message", content: command }));
    }
  } else {
    deps.sendToCLI(
      session,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: command },
        parent_tool_use_id: null,
        session_id: deps.getCliSessionId(session),
      }),
    );
  }
  deps.setGenerating(session, true, "cli_slash_command");
  deps.broadcastStatusChange(session, "running");
  deps.persistSession(session);
}
export function handleForceCompact(session: AdapterBrowserRoutingSessionLike, deps: AdapterBrowserRoutingDeps): void {
  console.log(`[ws-bridge] /compact intercepted for session ${sessionTag(session.id)}, triggering force-compact`);
  const ts = Date.now();
  const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
    type: "user_message",
    content: "/compact",
    timestamp: ts,
    id: deps.nextUserMessageId(ts),
  };
  session.messageHistory.push(userHistoryEntry);
  session.lastUserMessage = "/compact";
  deps.touchUserMessage(session.id);
  deps.broadcastToBrowsers(session, userHistoryEntry);
  queueForceCompactPendingMessage(session, deps);
  deps.requestCliRelaunch?.(session.id);
}
function handleSdkPermissionResponse(
  session: AdapterBrowserRoutingSessionLike,
  msg: PermissionResponseMessage,
  deps: AdapterBrowserRoutingDeps,
): void {
  const pending = session.pendingPermissions.get(msg.request_id);
  if (!pending) return;
  session.pendingPermissions.delete(msg.request_id);
  deps.onSessionActivityStateChanged(session.id, "sdk_permission_response");
  deps.sessionNotificationDeps.cancelPermissionNotification?.(session.id, msg.request_id);
  clearActionAttentionIfNoPermissionsSessionRegistryController(session, deps.sessionNotificationDeps);
  if (session.claudeSdkAdapter) {
    session.claudeSdkAdapter.sendBrowserMessage({
      type: "permission_response",
      request_id: msg.request_id,
      behavior: msg.behavior,
      updated_input: msg.behavior === "allow" ? msg.updated_input || pending.input : undefined,
      message: msg.behavior !== "allow" ? msg.message || "Denied by user" : undefined,
    });
  }
  deps.emitTakodeEvent(
    session.id,
    "permission_resolved",
    {
      tool_name: pending.tool_name,
      outcome: msg.behavior === "allow" ? "approved" : "denied",
    },
    msg.actorSessionId,
  );
  if (msg.behavior === "allow") {
    const approvedMsg: BrowserIncomingMessage = {
      type: "permission_approved",
      id: `approval-${msg.request_id}`,
      request_id: msg.request_id,
      tool_name: pending.tool_name,
      tool_use_id: pending.tool_use_id,
      summary: `Approved: ${pending.tool_name}${pending.description ? ` — ${pending.description}` : ""}`,
      timestamp: Date.now(),
    };
    session.messageHistory.push(approvedMsg);
    deps.broadcastToBrowsers(session, approvedMsg);
  } else {
    const deniedMsg: BrowserIncomingMessage = {
      type: "permission_denied",
      id: `denial-${msg.request_id}`,
      request_id: msg.request_id,
      tool_name: pending.tool_name,
      tool_use_id: pending.tool_use_id,
      summary: `Denied: ${pending.tool_name}${pending.description ? ` — ${pending.description}` : ""}`,
      timestamp: Date.now(),
    };
    session.messageHistory.push(deniedMsg);
    deps.broadcastToBrowsers(session, deniedMsg);
  }
  if (msg.behavior === "allow" && pending.tool_name === "ExitPlanMode") {
    const askPerm = session.state.askPermission !== false;
    deps.handleSetPermissionMode(session, askPerm ? "acceptEdits" : "bypassPermissions");
    deps.setGenerating(session, true, "exit_plan_mode");
    deps.broadcastStatusChange(session, "running");
  }
  if (msg.behavior === "allow" && pending.tool_name === "EnterPlanMode") {
    deps.handleSetPermissionMode(session, "plan");
  }
  if (msg.behavior === "deny" && pending.tool_name === "ExitPlanMode") {
    const interruptSource = getInterruptSourceFromActorSessionId(msg.actorSessionId);
    deps.markTurnInterrupted(session, interruptSource);
    if (session.claudeSdkAdapter) {
      session.claudeSdkAdapter.sendBrowserMessage({ type: "interrupt", interruptSource });
    } else {
      deps.handleInterruptFallback(session, interruptSource);
    }
  }
  deps.persistSession(session);
}
function handleCodexPermissionResponse(
  session: AdapterBrowserRoutingSessionLike,
  msg: PermissionResponseMessage,
  deps: AdapterBrowserRoutingDeps,
): void {
  const pending = session.pendingPermissions.get(msg.request_id);
  session.pendingPermissions.delete(msg.request_id);
  deps.onSessionActivityStateChanged(session.id, "codex_permission_response");
  deps.sessionNotificationDeps.cancelPermissionNotification?.(session.id, msg.request_id);
  clearActionAttentionIfNoPermissionsSessionRegistryController(session, deps.sessionNotificationDeps);
  if (msg.behavior === "allow" && pending && NOTABLE_APPROVALS.has(pending.tool_name)) {
    const answers =
      pending.tool_name === "AskUserQuestion" ? extractAskUserAnswers(pending.input, msg.updated_input) : undefined;
    if (pending.tool_name !== "AskUserQuestion" || answers) {
      const approvedMsg: BrowserIncomingMessage = {
        type: "permission_approved",
        id: `approval-${msg.request_id}`,
        request_id: msg.request_id,
        tool_name: pending.tool_name,
        tool_use_id: pending.tool_use_id,
        summary: getApprovalSummary(pending.tool_name, pending.input),
        timestamp: Date.now(),
        ...(answers ? { answers } : {}),
      };
      session.messageHistory.push(approvedMsg);
      deps.broadcastToBrowsers(session, approvedMsg);
    }
  }
  if (msg.behavior === "deny" && pending) {
    const deniedMsg: BrowserIncomingMessage = {
      type: "permission_denied",
      id: `denial-${msg.request_id}`,
      request_id: msg.request_id,
      tool_name: pending.tool_name,
      tool_use_id: pending.tool_use_id,
      summary: getDenialSummary(pending.tool_name, pending.input),
      timestamp: Date.now(),
    };
    session.messageHistory.push(deniedMsg);
    deps.broadcastToBrowsers(session, deniedMsg);
  }
  if (msg.behavior === "deny" && pending?.tool_name === "ExitPlanMode") {
    const interruptSource = getInterruptSourceFromActorSessionId(msg.actorSessionId);
    deps.markTurnInterrupted(session, interruptSource);
    const activeTurnId = session.codexAdapter?.getCurrentTurnId() ?? null;
    if (activeTurnId) {
      deps.armCodexFreshTurnRequirement(session, activeTurnId, "exit_plan_mode_denied");
    } else {
      deps.clearCodexFreshTurnRequirement(session, "exit_plan_mode_denied_without_active_turn");
    }
    session.codexAdapter?.sendBrowserMessage({ type: "interrupt", interruptSource });
  }
  if (pending) {
    emitTakodePermissionResolved(
      session.id,
      pending.tool_name,
      msg.behavior === "allow" ? "approved" : "denied",
      deps,
      msg.actorSessionId,
    );
  }
  deps.persistSession(session);
}
function normalizeAdapterUserMessage(
  session: AdapterBrowserRoutingSessionLike,
  msg: BrowserUserMessage,
  userImageRefs: ImageRef[] | undefined,
  deps: AdapterBrowserRoutingDeps,
): BrowserOutgoingMessage | null {
  let adapterMsg: BrowserOutgoingMessage = msg.takodeHerdBatch
    ? (({ takodeHerdBatch: _takodeHerdBatch, ...rest }) => rest)(msg)
    : msg;
  if (typeof msg.deliveryContent === "string") {
    const delivered = { ...adapterMsg, content: msg.deliveryContent } as BrowserOutgoingMessage;
    delete (delivered as { deliveryContent?: unknown }).deliveryContent;
    delete (delivered as { draftImages?: unknown }).draftImages;
    delete (delivered as { imageRefs?: unknown }).imageRefs;
    delete (delivered as { images?: unknown }).images;
    return delivered;
  }
  if (!msg.images?.length) {
    return adapterMsg;
  }
  if (userImageRefs?.length !== msg.images.length) {
    deps.notifyImageSendFailure(session, new Error("uploaded images missing from image store"));
    return null;
  }
  let annotatedContent = msg.content || "";
  const resolvedPaths = deriveAttachmentPaths(session.id, userImageRefs);
  if (resolvedPaths.length > 0) {
    annotatedContent += formatAttachmentPathAnnotation(resolvedPaths);
  }
  adapterMsg = { ...msg, content: annotatedContent } as BrowserOutgoingMessage;
  const stripped = { ...adapterMsg, content: annotatedContent } as BrowserOutgoingMessage;
  delete (stripped as { deliveryContent?: unknown }).deliveryContent;
  delete (stripped as { draftImages?: unknown }).draftImages;
  delete (stripped as { imageRefs?: unknown }).imageRefs;
  delete (stripped as { images?: unknown }).images;
  return stripped;
}
function queueAdapterMessage(session: AdapterBrowserRoutingSessionLike, raw: string): void {
  const alreadyQueued = session.pendingMessages.some((queued) => queued === raw);
  if (!alreadyQueued) {
    session.pendingMessages.push(raw);
  }
}
function maybeRequestAdapterRelaunchForUserMessage(
  session: AdapterBrowserRoutingSessionLike,
  deps: AdapterBrowserRoutingDeps,
): void {
  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  if (session.state.backend_state === "broken" || !launcherInfo || launcherInfo.state === "starting") {
    return;
  }
  if (launcherInfo.killedByIdleManager) {
    launcherInfo.killedByIdleManager = false;
    console.log(`[ws-bridge] Clearing idle-killed flag for session ${sessionTag(session.id)} (adapter user_message)`);
  }
  session.consecutiveAdapterFailures = 0;
  console.log(
    `[ws-bridge] User message queued for adapter-missing ${session.backendType} session ${sessionTag(session.id)}, requesting relaunch`,
  );
  if (session.backendType === "codex") {
    deps.requestCodexAutoRecovery(session, "queued_user_message_adapter_missing");
  } else {
    deps.requestCliRelaunch?.(session.id);
  }
}
export function routeAdapterBrowserMessage(
  session: AdapterBrowserRoutingSessionLike,
  msg: BrowserOutgoingMessage,
  ws: unknown,
  deps: AdapterBrowserRoutingDeps,
): boolean | Promise<boolean> {
  if (session.backendType !== "codex" && session.backendType !== "claude-sdk") {
    return false;
  }
  if (msg.type === "permission_response" && session.backendType === "claude-sdk") {
    handleSdkPermissionResponse(session, msg, deps);
  }
  let userImageRefs: ImageRef[] | undefined;
  let preMarkedImageRunning = false;
  let wasGeneratingBeforeUserMessage = session.isGenerating;
  const finishRouting = (ingested?: IngestedUserMessage): boolean => {
    userImageRefs = ingested?.imageRefs;
    if (session.backendType === "codex" && msg.type === "user_message" && msg.images?.length) {
      deps.setCodexImageSendStage(session, "processing", { persist: false });
    }
    if (ingested && deps.onUserMessage && session.backendType !== "codex") {
      deps.onUserMessage(session.id, [...session.messageHistory], session.state.cwd, ingested.wasGenerating);
    }
    if (msg.type === "permission_response" && session.backendType === "claude-sdk") {
      return true;
    }
    if (msg.type === "permission_response" && session.backendType === "codex") {
      handleCodexPermissionResponse(session, msg, deps);
    }
    if (session.backendType === "codex" && msg.type === "cancel_pending_codex_input") {
      const pendingInput = session.pendingCodexInputs.find((input) => input.id === msg.id);
      if (!pendingInput?.cancelable) return true;
      const cancelableHeadId = deps.getCancelablePendingCodexInputs(session)[0]?.id ?? null;
      const cancelledHeadPendingInput = cancelableHeadId === msg.id;
      const activeTurnId = session.codexAdapter?.getCurrentTurnId() ?? null;
      session.pendingCodexTurns = activeTurnId
        ? session.pendingCodexTurns.filter((turn) => turn.turnId === activeTurnId)
        : session.pendingCodexTurns.filter((turn) => turn.status === "queued" && turn.turnId == null).slice(0, 1);
      deps.clearQueuedTurnLifecycleEntries(session);
      const removed = deps.removePendingCodexInput(session, msg.id);
      const remainingCancelableInputs = deps.getCancelablePendingCodexInputs(session);
      if (!activeTurnId && remainingCancelableInputs.length === 0) {
        session.pendingCodexTurns = [];
      } else if (remainingCancelableInputs.length > 0) {
        if (!activeTurnId && cancelledHeadPendingInput) {
          deps.queueCodexPendingStartBatch(session, "cancel_pending_codex_input");
        } else {
          deps.rebuildQueuedCodexPendingStartBatch(session);
        }
      }
      if (removed && ws) {
        deps.sendToBrowser(ws, { type: "codex_pending_input_cancelled", input: removed });
      }
      deps.persistSession(session);
      return true;
    }
    if (msg.type === "set_model") {
      if (session.backendType === "claude-sdk") {
        deps.handleSetModel(session, msg.model);
      } else {
        deps.handleCodexSetModel(session, msg.model);
      }
      return true;
    }
    if (msg.type === "set_permission_mode") {
      if (session.backendType === "claude-sdk") {
        deps.handleSetPermissionMode(session, msg.mode);
      } else {
        deps.handleCodexSetPermissionMode(session, msg.mode);
      }
      return true;
    }
    if (msg.type === "set_codex_reasoning_effort") {
      deps.handleCodexSetReasoningEffort(session, msg.effort);
      return true;
    }
    if (msg.type === "set_ask_permission") {
      deps.handleSetAskPermission(session, msg.askPermission);
      return true;
    }
    let adapterMsg: BrowserOutgoingMessage = msg;
    if (msg.type === "user_message") {
      const normalized = normalizeAdapterUserMessage(session, msg, userImageRefs, deps);
      if (!normalized) return true;
      adapterMsg = normalized;
    }
    let pendingTurnTarget: UserDispatchTurnTarget | null = null;
    if (
      msg.type === "user_message" &&
      ingested &&
      session.state.backend_state !== "broken" &&
      !(session.backendType === "codex" && deps.isHerdEventSource(msg.agentSource))
    ) {
      const effectiveWasGenerating = preMarkedImageRunning ? wasGeneratingBeforeUserMessage : ingested.wasGenerating;
      const interruptSource = effectiveWasGenerating
        ? msg.agentSource
          ? isSystemSourceTag(msg.agentSource)
            ? "system"
            : "leader"
          : "user"
        : undefined;
      pendingTurnTarget = preMarkedImageRunning
        ? "current"
        : deps.markRunningFromUserDispatch(session, "user_message", interruptSource ?? null);
      if (ingested.historyIndex >= 0) {
        deps.trackUserMessageForTurn(session, ingested.historyIndex, pendingTurnTarget ?? "current");
      }
    }
    if (session.backendType === "codex" && msg.type === "user_message" && ingested) {
      if (ingested.historyEntry.id) {
        const draftImages = buildPendingCodexImageDrafts(msg.images);
        deps.addPendingCodexInput(session, {
          id: ingested.historyEntry.id,
          ...(msg.client_msg_id ? { clientMsgId: msg.client_msg_id } : {}),
          content: ingested.historyEntry.content,
          timestamp: ingested.timestamp,
          cancelable: true,
          ...(userImageRefs?.length ? { imageRefs: userImageRefs } : {}),
          ...(draftImages?.length ? { draftImages } : {}),
          ...(adapterMsg.type === "user_message" ? { deliveryContent: adapterMsg.content } : {}),
          ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
          ...(msg.takodeHerdBatch ? { takodeHerdBatch: msg.takodeHerdBatch } : {}),
          ...(msg.vscodeSelection ? { vscodeSelection: msg.vscodeSelection } : {}),
        });
        deps.emitTakodeEvent(session.id, "user_message", {
          content: (ingested.historyEntry.content || "").slice(0, 120),
          ...(msg.agentSource ? { agentSource: msg.agentSource } : {}),
        });
      }
      const currentTurnId = session.codexAdapter?.getCurrentTurnId() ?? null;
      if (currentTurnId) {
        const steeredPending = deps.trySteerPendingCodexInputs(session, "browser_user_message");
        if (!steeredPending) {
          deps.rebuildQueuedCodexPendingStartBatch(session);
        }
      } else {
        const effectiveWasGenerating = preMarkedImageRunning
          ? wasGeneratingBeforeUserMessage
          : !!ingested.wasGenerating;
        if (session.codexAdapter && effectiveWasGenerating && session.isGenerating) {
          deps.rebuildQueuedCodexPendingStartBatch(session);
          deps.persistSession(session);
        } else {
          deps.queueCodexPendingStartBatch(session, "browser_user_message");
        }
      }
      if (session.state.backend_state === "broken") {
        deps.broadcastToBrowsers(session, {
          type: "error",
          message: "Codex session is broken. Your message was queued and will run after relaunch.",
        });
      }
      if (!session.codexAdapter) {
        console.log(
          `[ws-bridge] Codex adapter not yet attached for session ${sessionTag(session.id)}, queued user_message`,
        );
        maybeRequestAdapterRelaunchForUserMessage(session, deps);
      }
      return true;
    }
    if (msg.type === "interrupt") {
      deps.markTurnInterrupted(session, msg.interruptSource ?? "user");
    }
    if (msg.type === "user_message" && typeof (adapterMsg as { content?: unknown }).content === "string") {
      const msgTs = ingested?.timestamp ?? Date.now();
      const typed = adapterMsg as { content: string };
      adapterMsg = {
        ...adapterMsg,
        content: buildTimestampTag(session, msgTs, deps.getLauncherSessionInfo, msg.agentSource) + typed.content,
      } as BrowserOutgoingMessage;
    }
    const adapter = session.codexAdapter || session.claudeSdkAdapter;
    const raw = JSON.stringify(adapterMsg);
    if (adapter) {
      const accepted = adapter.sendBrowserMessage(adapterMsg);
      if (!accepted) {
        const sdkQueuedInternally = session.claudeSdkAdapter === adapter && !adapter.isConnected?.();
        if (!sdkQueuedInternally) {
          queueAdapterMessage(session, raw);
        }
      }
      deps.persistSession(session);
      return true;
    }
    console.log(`[ws-bridge] Adapter not yet attached for session ${sessionTag(session.id)}, queuing ${msg.type}`);
    queueAdapterMessage(session, raw);
    if (msg.type === "user_message") {
      maybeRequestAdapterRelaunchForUserMessage(session, deps);
    }
    deps.persistSession(session);
    return true;
  };
  if (msg.type !== "user_message") {
    return finishRouting(undefined);
  }
  wasGeneratingBeforeUserMessage = session.isGenerating;
  if (
    session.backendType === "codex" &&
    msg.images?.length &&
    !session.isGenerating &&
    session.state.backend_state !== "broken" &&
    !deps.isHerdEventSource(msg.agentSource)
  ) {
    session.lastUserMessage = (msg.content || "").slice(0, 80);
    deps.setCodexImageSendStage(session, "uploading", { persist: false });
    deps.markRunningFromUserDispatch(session, "user_message");
    preMarkedImageRunning = true;
  }
  const handleImageSendFailure = (err: unknown): true => {
    if (msg.images?.length) {
      if (preMarkedImageRunning) {
        deps.setCodexImageSendStage(session, null, { persist: false });
        deps.setGenerating(session, false, "image_send_failed");
        deps.broadcastStatusChange(session, "idle");
        deps.persistSession(session);
      }
      deps.notifyImageSendFailure(session, err);
      return true;
    }
    throw err;
  };
  try {
    const maybeIngested = ingestUserMessage(session, msg, deps, {
      commit: session.backendType !== "codex",
    });
    if (maybeIngested instanceof Promise) {
      return maybeIngested.then((resolved) => finishRouting(resolved)).catch((err) => handleImageSendFailure(err));
    }
    return finishRouting(maybeIngested);
  } catch (err) {
    return handleImageSendFailure(err);
  }
}
