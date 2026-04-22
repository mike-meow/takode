import { deriveAttachmentPaths, formatAttachmentPathAnnotation } from "../attachment-paths.js";
import type { ImageRef } from "../image-store.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CodexOutboundTurn,
  PendingCodexInput,
  PermissionRequest,
  SessionState,
} from "../session-types.js";
import { sessionTag } from "../session-tag.js";
import type { UserDispatchTurnTarget } from "./generation-lifecycle.js";
import { extractAskUserAnswers } from "./compaction-recovery.js";
import { buildPendingCodexImageDrafts, getApprovalSummary, getDenialSummary, NOTABLE_APPROVALS } from "./permission-summaries.js";
type InterruptSource = "user" | "leader" | "system";
type BrowserUserMessage = Extract<BrowserOutgoingMessage, { type: "user_message" }>;
type PermissionResponseMessage = Extract<BrowserOutgoingMessage, { type: "permission_response" }>;
type IngestedUserMessage = {
  timestamp: number;
  historyEntry: Extract<BrowserIncomingMessage, { type: "user_message" }>;
  historyIndex: number;
  imageRefs?: ImageRef[];
  wasGenerating: boolean;
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
  pendingMessages: string[];
  pendingCodexTurns: CodexOutboundTurn[];
  pendingCodexInputs: PendingCodexInput[];
  forceCompactPending: boolean;
  isGenerating: boolean;
  lastUserMessage?: string;
  lastUserMessageDateTag: string;
  lastOutboundUserNdjson: string | null;
  consecutiveAdapterFailures: number;
  codexAdapter:
    | {
        sendBrowserMessage(msg: unknown): boolean;
        getCurrentTurnId(): string | null;
        isConnected(): boolean;
      }
    | null;
  claudeSdkAdapter:
    | {
        sendBrowserMessage(msg: unknown): boolean;
        isConnected?(): boolean;
      }
    | null;
}
export interface AdapterBrowserRoutingDeps {
  broadcastToBrowsers: (session: AdapterBrowserRoutingSessionLike, msg: BrowserIncomingMessage) => void;
  emitTakodeEvent: (
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
    actorSessionId?: string,
  ) => void;
  persistSession: (session: AdapterBrowserRoutingSessionLike) => void;
  touchUserMessage: (sessionId: string) => void;
  formatVsCodeSelectionPrompt: (selection: NonNullable<BrowserUserMessage["vscodeSelection"]>) => string;
  buildTimestampTag: (
    session: AdapterBrowserRoutingSessionLike,
    ts: number,
    agentSource?: BrowserUserMessage["agentSource"],
  ) => string;
  sendToCLI: (
    session: AdapterBrowserRoutingSessionLike,
    ndjson: string,
    opts?: {
      deferUntilCliReady?: boolean;
      skipUserDispatchLifecycle?: boolean;
    },
  ) => UserDispatchTurnTarget | null;
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
  isSystemSourceTag: (agentSource: BrowserUserMessage["agentSource"]) => boolean;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  clearActionAttentionIfNoPermissions: (session: AdapterBrowserRoutingSessionLike) => void;
  cancelPermissionNotification: (sessionId: string, requestId: string) => void;
  getInterruptSourceFromActorSessionId: (actorSessionId: string | undefined) => InterruptSource;
  markTurnInterrupted: (session: AdapterBrowserRoutingSessionLike, source: InterruptSource) => void;
  armCodexFreshTurnRequirement: (
    session: AdapterBrowserRoutingSessionLike,
    turnId: string,
    reason: string,
  ) => void;
  clearCodexFreshTurnRequirement: (session: AdapterBrowserRoutingSessionLike, reason: string) => void;
  addPendingCodexInput: (session: AdapterBrowserRoutingSessionLike, input: PendingCodexInput) => void;
  getCancelablePendingCodexInputs: (session: AdapterBrowserRoutingSessionLike) => PendingCodexInput[];
  removePendingCodexInput: (session: AdapterBrowserRoutingSessionLike, id: string) => PendingCodexInput | null;
  clearQueuedTurnLifecycleEntries: (session: AdapterBrowserRoutingSessionLike) => void;
  queueCodexPendingStartBatch: (session: AdapterBrowserRoutingSessionLike, reason: string) => void;
  rebuildQueuedCodexPendingStartBatch: (session: AdapterBrowserRoutingSessionLike) => void;
  trySteerPendingCodexInputs: (session: AdapterBrowserRoutingSessionLike, reason: string) => boolean;
  sendToBrowser: (ws: unknown, msg: BrowserIncomingMessage) => void;
  getLauncherSessionInfo: (
    sessionId: string,
  ) =>
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
  requestCodexAutoRecovery: (session: AdapterBrowserRoutingSessionLike, reason: string) => boolean;
  requestCliRelaunch?: (sessionId: string) => void;
  handleSetModel: (session: AdapterBrowserRoutingSessionLike, model: string) => void;
  handleCodexSetModel: (session: AdapterBrowserRoutingSessionLike, model: string) => void;
  handleSetPermissionMode: (session: AdapterBrowserRoutingSessionLike, mode: string) => void;
  handleCodexSetPermissionMode: (session: AdapterBrowserRoutingSessionLike, mode: string) => void;
  handleCodexSetReasoningEffort: (session: AdapterBrowserRoutingSessionLike, effort: string) => void;
  handleSetAskPermission: (session: AdapterBrowserRoutingSessionLike, askPermission: boolean) => void;
  handleInterruptFallback: (session: AdapterBrowserRoutingSessionLike, source: InterruptSource) => void;
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
      ? [{ type: "text", text: msg.deliveryContent }, { type: "text", text: selectionText }]
      : msg.deliveryContent;
  } else if (msg.images?.length && ingested.imageRefs?.length) {
    const paths = deriveAttachmentPaths(session.id, ingested.imageRefs);
    const textContent = (msg.content || "") + formatAttachmentPathAnnotation(paths);
    content = selectionText ? [{ type: "text", text: textContent }, { type: "text", text: selectionText }] : textContent;
  } else {
    content = selectionText ? [{ type: "text", text: msg.content }, { type: "text", text: selectionText }] : msg.content;
  }
  if (typeof content === "string") {
    content = deps.buildTimestampTag(session, ingested.timestamp, msg.agentSource) + content;
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
  deps.cancelPermissionNotification(session.id, msg.request_id);
  deps.clearActionAttentionIfNoPermissions(session);
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
    const interruptSource = deps.getInterruptSourceFromActorSessionId(msg.actorSessionId);
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
  if (msg.behavior === "allow" && pending && NOTABLE_APPROVALS.has(pending.tool_name)) {
    const answers =
      pending.tool_name === "AskUserQuestion"
        ? extractAskUserAnswers(pending.input, msg.updated_input)
        : undefined;
    if (pending.tool_name !== "AskUserQuestion" || answers) {
      const approvedMsg: BrowserIncomingMessage = {
        type: "permission_approved",
        id: `approval-${msg.request_id}`,
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
      tool_name: pending.tool_name,
      tool_use_id: pending.tool_use_id,
      summary: getDenialSummary(pending.tool_name, pending.input),
      timestamp: Date.now(),
    };
    session.messageHistory.push(deniedMsg);
    deps.broadcastToBrowsers(session, deniedMsg);
  }
  if (msg.behavior === "deny" && pending?.tool_name === "ExitPlanMode") {
    const interruptSource = deps.getInterruptSourceFromActorSessionId(msg.actorSessionId);
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
    deps.emitTakodeEvent(session.id, "permission_resolved", {
      tool_name: pending.tool_name,
      outcome: msg.behavior === "allow" ? "approved" : "denied",
    });
  }
  deps.persistSession(session);
}
function normalizeAdapterUserMessage(
  session: AdapterBrowserRoutingSessionLike,
  msg: BrowserUserMessage,
  userImageRefs: ImageRef[] | undefined,
  deps: AdapterBrowserRoutingDeps,
): BrowserOutgoingMessage | null {
  let adapterMsg: BrowserOutgoingMessage =
    msg.takodeHerdBatch ? (({ takodeHerdBatch: _takodeHerdBatch, ...rest }) => rest)(msg) : msg;
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
          ? deps.isSystemSourceTag(msg.agentSource)
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
        deps.addPendingCodexInput(session, {
          id: ingested.historyEntry.id,
          content: ingested.historyEntry.content,
          timestamp: ingested.timestamp,
          cancelable: true,
          ...(userImageRefs?.length ? { imageRefs: userImageRefs } : {}),
          ...(msg.draftImages?.length
            ? { draftImages: msg.draftImages }
            : msg.images?.length
              ? { draftImages: buildPendingCodexImageDrafts(msg.images) }
              : {}),
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
        const effectiveWasGenerating = preMarkedImageRunning ? wasGeneratingBeforeUserMessage : !!ingested.wasGenerating;
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
        content: deps.buildTimestampTag(session, msgTs, msg.agentSource) + typed.content,
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
