import type {
  BackendType,
  BrowserIncomingMessage,
  CLIAssistantMessage,
  CLIAuthStatusMessage,
  CLIControlCancelRequestMessage,
  CLIControlRequestMessage,
  CLIControlResponseMessage,
  CLIMessage,
  CLIResultMessage,
  CLIStreamEventMessage,
  CLISystemCompactBoundaryMessage,
  CLISystemInitMessage,
  CLISystemStatusMessage,
  CLISystemTaskNotificationMessage,
  CLIToolProgressMessage,
  CLIToolUseSummaryMessage,
  CLIUserMessage,
  PermissionRequest,
  SessionState,
  ContentBlock,
  ToolResultPreview,
} from "../session-types.js";
import {
  computeContextUsedPercent,
  computeResultContextUsedPercent,
  extractClaudeTokenDetails,
  inferContextWindowFromModel,
  resolveResultContextWindow,
  type TokenUsage,
} from "./context-usage.js";
import { sessionTag } from "../session-tag.js";
import type { ImageRef } from "../image-store.js";
import {
  buildThreadRoutingReminderForCompletedTurn,
  normalizeLeaderAssistantRouting,
} from "./thread-routing-reminder.js";

type BroadcastOptions = {
  skipBuffer?: boolean;
};

type SystemMessage =
  | CLISystemInitMessage
  | CLISystemStatusMessage
  | CLISystemCompactBoundaryMessage
  | CLISystemTaskNotificationMessage;

export interface SystemMessageSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  cliInitReceived: boolean;
  cliResuming: boolean;
  dropReplayHistoryAfterRevert?: boolean;
  cliResumingClearTimer: ReturnType<typeof setTimeout> | null;
  forceCompactPending: boolean;
  compactedDuringTurn: boolean;
  awaitingCompactSummary?: boolean;
  claudeCompactBoundarySeen?: boolean;
  seamlessReconnect: boolean;
  disconnectWasGenerating: boolean;
  isGenerating: boolean;
  generationStartedAt?: number | null;
  lastOutboundUserNdjson: string | null;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  state: SessionState;
}

interface SystemMessageDeps {
  onCLISessionId?: (sessionId: string, cliSessionId: string) => void;
  cacheSlashCommands: (projectKey: string, data: { slash_commands: string[]; skills: string[] }) => void;
  backfillSlashCommands: (projectKey: string, sourceSessionId: string) => void;
  refreshGitInfoThenRecomputeDiff: (
    session: SystemMessageSessionLike,
    options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
  ) => void;
  getLauncherSessionInfo: (sessionId: string) => { isOrchestrator?: boolean } | null | undefined;
  broadcastToBrowsers: (
    session: SystemMessageSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: SystemMessageSessionLike) => void;
  hasPendingForceCompact: (session: SystemMessageSessionLike) => boolean;
  flushQueuedCliMessages: (session: SystemMessageSessionLike, reason: string) => void;
  onOrchestratorTurnEnd: (sessionId: string) => void;
  isCliUserMessagePayload: (ndjson: string) => boolean;
  markTurnInterrupted: (session: SystemMessageSessionLike, source: "system") => void;
  setGenerating: (session: SystemMessageSessionLike, generating: boolean, reason: string) => void;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  injectCompactionRecovery: (session: SystemMessageSessionLike) => void;
  hasCompactBoundaryReplay: (
    session: SystemMessageSessionLike,
    cliUuid: string | undefined,
    meta: CLISystemCompactBoundaryMessage["compact_metadata"],
  ) => boolean;
  freezeHistoryThroughCurrentTail: (session: SystemMessageSessionLike) => void;
  hasTaskNotificationReplay: (session: SystemMessageSessionLike, taskId: string, toolUseId: string) => boolean;
  stuckGenerationThresholdMs: number;
}

export interface AssistantMessageSessionLike {
  id: string;
  backendType: BackendType;
  cliResuming: boolean;
  dropReplayHistoryAfterRevert?: boolean;
  isGenerating: boolean;
  messageHistory: BrowserIncomingMessage[];
  assistantAccumulator: Map<string, { contentBlockIds: Set<string> }>;
  toolStartTimes: Map<string, number>;
  toolProgressOutput: Map<string, string>;
  diffStatsDirty: boolean;
  lastActivityPreview?: string;
  state: {
    model: string;
    context_used_percent: number;
    isOrchestrator?: boolean;
  };
}

interface HandleAssistantMessageDeps {
  hasAssistantReplay: (session: AssistantMessageSessionLike, messageId: string) => boolean;
  getLauncherSessionInfo?: (sessionId: string) => { isOrchestrator?: boolean } | null | undefined;
  broadcastToBrowsers: (
    session: AssistantMessageSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: AssistantMessageSessionLike) => void;
  onToolUseObserved?: (
    session: AssistantMessageSessionLike,
    toolUse: Extract<ContentBlock, { type: "tool_use" }>,
  ) => void;
}

interface HandleAssistantRuntimeDeps extends HandleAssistantMessageDeps {
  setGenerating: (session: AssistantMessageSessionLike, generating: boolean, reason: string) => void;
  broadcastStatusRunning: (session: AssistantMessageSessionLike) => void;
}

function isLeaderSessionForAssistantRouting(
  session: AssistantMessageSessionLike,
  deps: Pick<HandleAssistantMessageDeps, "getLauncherSessionInfo">,
): boolean {
  if (session.state.isOrchestrator === true) return true;
  if (deps.getLauncherSessionInfo?.(session.id)?.isOrchestrator !== true) return false;
  session.state.isOrchestrator = true;
  return true;
}

export interface ResultMessageSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  cliResuming: boolean;
  dropReplayHistoryAfterRevert?: boolean;
  messageHistory: BrowserIncomingMessage[];
  state: Pick<SessionState, "model" | "total_cost_usd" | "num_turns" | "context_used_percent" | "claude_token_details">;
  diffStatsDirty: boolean;
  generationStartedAt?: number | null;
  interruptedDuringTurn: boolean;
  queuedTurnStarts: number;
  queuedTurnInterruptSources: Array<"user" | "leader" | "system" | null>;
  userMessageIdsThisTurn: number[];
  isGenerating: boolean;
  lastOutboundUserNdjson: string | null;
  pendingPermissions: Map<string, PermissionRequest>;
  toolStartTimes: Map<string, number>;
}

export interface CliMessageRouteSessionLike {
  id: string;
  pendingPermissions: Map<string, PermissionRequest>;
  toolProgressOutput: Map<string, string>;
  lastToolProgressAt: number;
}

export interface CliUserReplaySessionLike {
  id: string;
  cliResuming: boolean;
  dropReplayHistoryAfterRevert?: boolean;
  resumedFromExternal?: boolean;
  awaitingCompactSummary?: boolean;
  messageHistory: BrowserIncomingMessage[];
  toolStartTimes: Map<string, number>;
}

interface CliMessageRouteDeps {
  handleSystemMessage: (session: CliMessageRouteSessionLike, msg: SystemMessage) => void;
  handleAssistantMessage: (session: CliMessageRouteSessionLike, msg: CLIAssistantMessage) => void;
  handleResultMessage: (session: CliMessageRouteSessionLike, msg: CLIResultMessage) => void;
  handleControlRequest: (session: CliMessageRouteSessionLike, msg: CLIControlRequestMessage) => void;
  handleUserMessage: (session: CliMessageRouteSessionLike, msg: CLIUserMessage) => void;
  handleControlResponse: (session: CliMessageRouteSessionLike, msg: CLIControlResponseMessage) => void;
  abortAutoApproval: (session: CliMessageRouteSessionLike, requestId: string) => void;
  broadcastToBrowsers: (
    session: CliMessageRouteSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  cancelPermissionNotification: (sessionId: string, requestId: string) => void;
  clearActionAttentionIfNoPermissions: (session: CliMessageRouteSessionLike) => void;
  persistSession: (session: CliMessageRouteSessionLike) => void;
  toolProgressOutputLimit: number;
}

interface CliUserReplayDeps {
  hasUserPromptReplay: (session: CliUserReplaySessionLike, cliUuid: string) => boolean;
  hasToolResultPreviewReplay: (session: CliUserReplaySessionLike, toolUseId: string) => boolean;
  broadcastToBrowsers: (
    session: CliUserReplaySessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: CliUserReplaySessionLike) => void;
  nextUserMessageId: (timestamp: number) => string;
  storeImage?: (sessionId: string, data: string, mediaType: string) => Promise<ImageRef>;
  clearCodexToolResultWatchdog: (session: CliUserReplaySessionLike, toolUseId: string) => void;
  buildToolResultPreviews: (
    session: CliUserReplaySessionLike,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ) => ToolResultPreview[];
  collectCompletedToolStartTimes: (
    session: CliUserReplaySessionLike,
    toolResults: Array<Extract<ContentBlock, { type: "tool_result" }>>,
  ) => number[];
  finalizeSupersededCodexTerminalTools: (session: CliUserReplaySessionLike, completedToolStartTimes: number[]) => void;
}

interface ClaudeCliUserMessageDeps extends CliUserReplayDeps {
  broadcastCompactSummary: (session: CliUserReplaySessionLike, summary: string) => void;
  updateLatestCompactMarkerSummary: (session: CliUserReplaySessionLike, summary: string) => void;
}

interface DrainInlineQueuedClaudeTurnsSessionLike {
  id: string;
  backendType: BackendType;
  pendingMessages: string[];
}

function shouldDropReplayHistoryAfterRevert(session: {
  cliResuming: boolean;
  dropReplayHistoryAfterRevert?: boolean;
}): boolean {
  return session.cliResuming && session.dropReplayHistoryAfterRevert === true;
}

interface DrainInlineQueuedClaudeTurnsDeps {
  getQueuedTurnLifecycleEntries: (session: DrainInlineQueuedClaudeTurnsSessionLike) => unknown[];
  replaceQueuedTurnLifecycleEntries: (session: DrainInlineQueuedClaudeTurnsSessionLike, entries: unknown[]) => void;
  isCliUserMessagePayload: (ndjson: string) => boolean;
}

interface ResultMessageDeps {
  hasResultReplay: (session: ResultMessageSessionLike, resultUuid: string) => boolean;
  reconcileReplayState: (session: ResultMessageSessionLike) => { clearedResidualState: boolean };
  drainInlineQueuedClaudeTurns: (session: ResultMessageSessionLike, reason: string) => boolean;
  markTurnInterrupted: (session: ResultMessageSessionLike, source: "user" | "leader" | "system") => void;
  getCurrentTurnTriggerSource: (session: ResultMessageSessionLike) => "user" | "leader" | "system" | "unknown";
  reconcileTerminalResultState: (session: ResultMessageSessionLike) => void;
  finalizeOrphanedTerminalToolsOnResult: (session: ResultMessageSessionLike, msg: CLIResultMessage) => void;
  refreshGitInfoThenRecomputeDiff: (
    session: ResultMessageSessionLike,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean },
  ) => void;
  broadcastToBrowsers: (
    session: ResultMessageSessionLike,
    msg: BrowserIncomingMessage,
    options?: BroadcastOptions,
  ) => void;
  persistSession: (session: ResultMessageSessionLike) => void;
  freezeHistoryThroughCurrentTail: (session: ResultMessageSessionLike) => void;
  cancelPermissionNotification: (sessionId: string, requestId: string) => void;
  onSessionActivityStateChanged: (sessionId: string, reason: string) => void;
  onResultAttentionAndNotifications: (
    session: ResultMessageSessionLike,
    msg: CLIResultMessage,
    turnTriggerSource: "user" | "leader" | "system" | "unknown",
  ) => void;
  onTurnCompleted: (session: ResultMessageSessionLike) => void;
  injectUserMessage: (
    sessionId: string,
    content: string,
    agentSource: { sessionId: string; sessionLabel?: string },
    takodeHerdBatch: undefined,
    threadRoute: import("../thread-routing-metadata.js").ThreadRouteMetadata,
  ) => void;
}

interface ClaudeSdkBrowserMessageSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  cliInitReceived: boolean;
  cliResuming: boolean;
  cliResumingClearTimer: ReturnType<typeof setTimeout> | null;
  forceCompactPending: boolean;
  compactedDuringTurn: boolean;
  awaitingCompactSummary?: boolean;
  claudeCompactBoundarySeen?: boolean;
  seamlessReconnect: boolean;
  disconnectWasGenerating: boolean;
  isGenerating: boolean;
  generationStartedAt?: number | null;
  lastOutboundUserNdjson: string | null;
  resumedFromExternal?: boolean;
  messageHistory: BrowserIncomingMessage[];
  pendingMessages: string[];
  assistantAccumulator: Map<string, { contentBlockIds: Set<string> }>;
  toolStartTimes: Map<string, number>;
  toolProgressOutput: Map<string, string>;
  diffStatsDirty: boolean;
  lastActivityPreview?: string;
  pendingPermissions: Map<string, PermissionRequest>;
  interruptedDuringTurn: boolean;
  queuedTurnStarts: number;
  queuedTurnReasons: string[];
  queuedTurnUserMessageIds: number[][];
  queuedTurnInterruptSources: Array<"user" | "leader" | "system" | null>;
  userMessageIdsThisTurn: number[];
  state: SessionState;
}

export function handleSystemMessage(
  session: SystemMessageSessionLike,
  msg: SystemMessage,
  deps: SystemMessageDeps,
): void {
  if (msg.subtype === "init") {
    handleSystemInit(session, msg, deps);
    return;
  }
  if (msg.subtype === "status") {
    handleSystemStatus(session, msg, deps);
    return;
  }
  if (msg.subtype === "compact_boundary") {
    handleCompactBoundary(session, msg, deps);
    return;
  }
  if (msg.subtype === "task_notification") {
    handleTaskNotification(session, msg, deps);
  }
}

export function handleAssistantMessage(
  session: AssistantMessageSessionLike,
  msg: CLIAssistantMessage,
  deps: HandleAssistantMessageDeps,
): void {
  const msgId = msg.message?.id;
  const isLeaderSession = isLeaderSessionForAssistantRouting(session, deps);

  if (!msgId) {
    if (shouldDropReplayHistoryAfterRevert(session)) {
      console.log(
        `[revert] Replay assistant DROPPED (msgId=NONE, uuid=${msg.uuid ?? "NONE"}, historyLen=${session.messageHistory.length})`,
      );
      return;
    }
    const routed = normalizeLeaderAssistantRouting(isLeaderSession, msg.message.content, msg.parent_tool_use_id);
    const browserMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: { ...msg.message, content: routed.content },
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
      uuid: msg.uuid,
      ...(routed.threadKey ? { threadKey: routed.threadKey } : {}),
      ...(routed.questId ? { questId: routed.questId } : {}),
      ...(routed.threadRefs ? { threadRefs: routed.threadRefs } : {}),
      ...(routed.threadRoutingError ? { threadRoutingError: routed.threadRoutingError } : {}),
    };
    session.messageHistory.push(browserMsg);
    deps.broadcastToBrowsers(session, browserMsg);
    maybeUpdateContextUsedPercentFromAssistantUsage(
      session,
      msg.message.usage,
      msg.message.model,
      deps.broadcastToBrowsers,
    );
    deps.persistSession(session);
    return;
  }

  const acc = session.assistantAccumulator.get(msgId);
  const newlyObservedToolUses: Array<Extract<ContentBlock, { type: "tool_use" }>> = [];
  if (!acc) {
    const hasReplay = !!msgId && deps.hasAssistantReplay(session, msgId);
    if (hasReplay) return;
    if (shouldDropReplayHistoryAfterRevert(session)) {
      console.log(
        `[revert] Replay assistant DROPPED (msgId=${msgId ?? "NONE"}, uuid=${msg.uuid ?? "NONE"}, historyLen=${session.messageHistory.length})`,
      );
      return;
    }

    const routed = normalizeLeaderAssistantRouting(isLeaderSession, msg.message.content, msg.parent_tool_use_id);
    const routedMessage = { ...msg.message, content: routed.content };
    const contentBlockIds = new Set<string>();
    const now = Date.now();
    const toolStartTimesMap: Record<string, number> = {};
    for (const block of routedMessage.content) {
      if (block.type === "tool_use" && block.id) {
        contentBlockIds.add(block.id);
        if (!session.toolStartTimes.has(block.id)) {
          session.toolStartTimes.set(block.id, now);
        }
        session.toolProgressOutput.delete(block.id);
        toolStartTimesMap[block.id] = session.toolStartTimes.get(block.id)!;
        newlyObservedToolUses.push(block);
      }
    }

    const browserMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: { ...routedMessage, content: [...routedMessage.content] },
      parent_tool_use_id: msg.parent_tool_use_id,
      timestamp: Date.now(),
      uuid: msg.uuid,
      ...(Object.keys(toolStartTimesMap).length > 0 ? { tool_start_times: toolStartTimesMap } : {}),
      ...(routed.threadKey ? { threadKey: routed.threadKey } : {}),
      ...(routed.questId ? { questId: routed.questId } : {}),
      ...(routed.threadRefs ? { threadRefs: routed.threadRefs } : {}),
      ...(routed.threadRoutingError ? { threadRoutingError: routed.threadRoutingError } : {}),
    };
    session.assistantAccumulator.set(msgId, { contentBlockIds });
    session.messageHistory.push(browserMsg);
    deps.broadcastToBrowsers(session, browserMsg);
  } else {
    const historyEntry = session.messageHistory.findLast(
      (entry) => entry.type === "assistant" && (entry as { message?: { id?: string } }).message?.id === msgId,
    ) as
      | {
          type: "assistant";
          message: CLIAssistantMessage["message"];
          timestamp?: number;
        }
      | undefined;
    if (!historyEntry) return;

    const newBlocks = getAssistantContentAppendBlocks(
      historyEntry.message.content,
      msg.message.content,
      acc.contentBlockIds,
    );
    if (newBlocks.length > 0) {
      for (const block of newBlocks) {
        if (block.type === "tool_use" && block.id) {
          if (!session.toolStartTimes.has(block.id)) {
            session.toolStartTimes.set(block.id, Date.now());
          }
          session.toolProgressOutput.delete(block.id);
          newlyObservedToolUses.push(block);
        }
      }
      historyEntry.message.content = [...historyEntry.message.content, ...newBlocks];
    }

    if (msg.message.stop_reason) {
      historyEntry.message.stop_reason = msg.message.stop_reason;
    }
    if (msg.message.usage) {
      historyEntry.message.usage = msg.message.usage;
    }

    const allToolStartTimes: Record<string, number> = {};
    for (const block of historyEntry.message.content) {
      if (block.type === "tool_use" && block.id && session.toolStartTimes.has(block.id)) {
        allToolStartTimes[block.id] = session.toolStartTimes.get(block.id)!;
      }
    }

    historyEntry.timestamp = Date.now();
    deps.broadcastToBrowsers(
      session,
      {
        ...(historyEntry as BrowserIncomingMessage),
        ...(Object.keys(allToolStartTimes).length > 0 ? { tool_start_times: allToolStartTimes } : {}),
      },
      { skipBuffer: true },
    );
  }

  extractActivityPreview(session, msg.message.content);
  if (Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type !== "tool_use") continue;
      const name = (block as { name?: string }).name ?? "";
      if (!READ_ONLY_TOOLS.has(name)) {
        session.diffStatsDirty = true;
        break;
      }
    }
  }
  maybeUpdateContextUsedPercentFromAssistantUsage(
    session,
    msg.message.usage,
    msg.message.model,
    deps.broadcastToBrowsers,
  );
  for (const toolUse of newlyObservedToolUses) {
    deps.onToolUseObserved?.(session, toolUse);
  }
  deps.persistSession(session);
}

export function handleAssistantMessageWithRuntime(
  session: AssistantMessageSessionLike,
  msg: CLIAssistantMessage,
  deps: HandleAssistantRuntimeDeps,
): void {
  const msgId = msg.message?.id;
  if (
    !session.isGenerating &&
    !session.cliResuming &&
    !msg.parent_tool_use_id &&
    !(msgId && deps.hasAssistantReplay(session, msgId))
  ) {
    deps.setGenerating(session, true, "cli_initiated_turn");
    deps.broadcastStatusRunning(session);
  }
  handleAssistantMessage(session, msg, deps);
}

export function handleResultMessage(
  session: ResultMessageSessionLike,
  msg: CLIResultMessage,
  deps: ResultMessageDeps,
): void {
  const hasReplay = !!msg.uuid && deps.hasResultReplay(session, msg.uuid);
  if (hasReplay) {
    const reconciled = deps.reconcileReplayState(session);
    const drainedQueuedTurns = deps.drainInlineQueuedClaudeTurns(session, "result_replay");
    if (drainedQueuedTurns || reconciled.clearedResidualState) {
      deps.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
      deps.persistSession(session);
    }
    return;
  }
  if (shouldDropReplayHistoryAfterRevert(session)) {
    console.log(
      `[revert] Replay result DROPPED (uuid=${msg.uuid ?? "NONE"}, historyLen=${session.messageHistory.length})`,
    );
    return;
  }

  session.state.total_cost_usd = msg.total_cost_usd;
  session.state.num_turns = msg.num_turns;

  const lastAssistant = session.messageHistory.findLast(
    (entry) =>
      entry.type === "assistant" && (entry as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
  ) as { message?: { usage?: TokenUsage } } | undefined;
  const nextContextPct = computeResultContextUsedPercent(session.state.model, msg, lastAssistant?.message?.usage);
  if (typeof nextContextPct === "number") {
    session.state.context_used_percent = nextContextPct;
  }
  const nextClaudeTokenDetails = extractClaudeTokenDetails(msg.modelUsage, session.state.model);
  if (nextClaudeTokenDetails) {
    session.state.claude_token_details = nextClaudeTokenDetails;
  }

  session.diffStatsDirty = true;
  deps.refreshGitInfoThenRecomputeDiff(session, { broadcastUpdate: true, notifyPoller: true });
  deps.broadcastToBrowsers(session, {
    type: "session_update",
    session: {
      total_cost_usd: session.state.total_cost_usd,
      num_turns: session.state.num_turns,
      context_used_percent: session.state.context_used_percent,
      ...(nextClaudeTokenDetails ? { claude_token_details: nextClaudeTokenDetails } : {}),
    },
  });

  const turnDurationMs =
    typeof session.generationStartedAt === "number" ? Math.max(0, Date.now() - session.generationStartedAt) : undefined;
  const stopReason = typeof msg.stop_reason === "string" ? msg.stop_reason.toLowerCase() : "";
  const resultInterrupted = stopReason.includes("interrupt") || stopReason.includes("cancel");
  const resultIsUserControlDiagnostic =
    msg.is_error &&
    typeof msg.result === "string" &&
    msg.result.includes("[ede_diagnostic]") &&
    msg.result.includes("result_type=user");
  if (resultInterrupted && !session.interruptedDuringTurn && session.queuedTurnStarts > 0) {
    deps.markTurnInterrupted(session, session.queuedTurnInterruptSources[0] ?? "user");
  }
  const turnWasInterrupted = session.interruptedDuringTurn || resultInterrupted || resultIsUserControlDiagnostic;
  const threadRoutingReminder = turnWasInterrupted ? null : buildThreadRoutingReminderForCompletedTurn(session);
  deps.drainInlineQueuedClaudeTurns(session, "result");

  const turnTriggerSource = deps.getCurrentTurnTriggerSource(session);
  deps.reconcileTerminalResultState(session);
  deps.finalizeOrphanedTerminalToolsOnResult(session, msg);
  session.toolStartTimes.clear();
  if (!session.isGenerating) {
    deps.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
  }
  session.lastOutboundUserNdjson = null;

  if (typeof turnDurationMs === "number") {
    const latestAssistant = session.messageHistory.findLast(
      (entry) =>
        entry.type === "assistant" && (entry as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
    ) as (BrowserIncomingMessage & { type: "assistant"; turn_duration_ms?: number }) | undefined;
    if (latestAssistant) {
      latestAssistant.turn_duration_ms = turnDurationMs;
      deps.broadcastToBrowsers(session, latestAssistant, { skipBuffer: true });
    }
  }

  if (session.pendingPermissions.size > 0) {
    for (const [requestId] of session.pendingPermissions) {
      deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: requestId });
      deps.cancelPermissionNotification(session.id, requestId);
    }
    session.pendingPermissions.clear();
    deps.onSessionActivityStateChanged(session.id, "result_cleared_permissions");
  }

  const resultBrowserMsg: BrowserIncomingMessage = {
    type: "result",
    data: msg,
    ...(turnWasInterrupted ? { interrupted: true } : {}),
  };
  session.messageHistory.push(resultBrowserMsg);
  deps.freezeHistoryThroughCurrentTail(session);
  deps.broadcastToBrowsers(session, resultBrowserMsg);
  deps.persistSession(session);

  if (!turnWasInterrupted) {
    deps.onResultAttentionAndNotifications(session, msg, turnTriggerSource);
  }
  deps.onTurnCompleted(session);
  if (threadRoutingReminder) {
    deps.injectUserMessage(
      session.id,
      threadRoutingReminder.content,
      threadRoutingReminder.agentSource,
      undefined,
      threadRoutingReminder.route,
    );
  }
}

export function routeCLIMessage(session: CliMessageRouteSessionLike, msg: CLIMessage, deps: CliMessageRouteDeps): void {
  switch (msg.type) {
    case "system":
      deps.handleSystemMessage(session, msg);
      break;
    case "assistant":
      deps.handleAssistantMessage(session, msg);
      break;
    case "result":
      deps.handleResultMessage(session, msg);
      break;
    case "stream_event":
      handleStreamEventMessage(session, msg, deps);
      break;
    case "control_request":
      deps.handleControlRequest(session, msg);
      break;
    case "tool_progress":
      handleToolProgressMessage(session, msg, deps);
      break;
    case "tool_use_summary":
      handleToolUseSummaryMessage(session, msg, deps);
      break;
    case "auth_status":
      handleAuthStatusMessage(session, msg, deps);
      break;
    case "control_response":
      deps.handleControlResponse(session, msg);
      break;
    case "control_cancel_request":
      handleControlCancelRequestMessage(session, msg, deps);
      break;
    case "user":
      deps.handleUserMessage(session, msg);
      break;
    case "keep_alive":
      break;
    default:
      break;
  }
}

export function extractUserPromptFromCLI(
  session: CliUserReplaySessionLike,
  msg: CLIUserMessage,
  deps: CliUserReplayDeps,
): void {
  if (msg.parent_tool_use_id !== null) return;

  const content = msg.message?.content;
  if (!Array.isArray(content)) return;

  const hasToolResult = content.some((block) => (block as Record<string, unknown>).type === "tool_result");
  if (hasToolResult) return;

  const textParts: string[] = [];
  const imageBlocks: { media_type: string; data: string }[] = [];
  for (const block of content) {
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      textParts.push(candidate.text);
    } else if (candidate.type === "image" && (candidate.source as Record<string, unknown>)?.type === "base64") {
      const source = candidate.source as Record<string, string>;
      imageBlocks.push({ media_type: source.media_type, data: source.data });
    }
  }

  if (textParts.length === 0 && imageBlocks.length === 0) return;

  const cliUuid = msg.uuid;
  const hasReplay = !!cliUuid && deps.hasUserPromptReplay(session, cliUuid);
  if (hasReplay) {
    if (session.cliResuming) {
      console.log(`[revert] Replay user msg DEDUPED (cliUuid=${cliUuid}, historyLen=${session.messageHistory.length})`);
    }
    return;
  }
  if (shouldDropReplayHistoryAfterRevert(session)) {
    console.log(
      `[revert] Replay user msg DROPPED (cliUuid=${cliUuid ?? "NONE"}, text=${textParts[0]?.slice(0, 60) ?? ""}, historyLen=${session.messageHistory.length})`,
    );
    return;
  }

  if (session.cliResuming) {
    console.log(
      `[revert] Replay user msg APPENDING (new, cliUuid=${cliUuid ?? "NONE"}, text=${textParts[0]?.slice(0, 60) ?? ""}, historyLen=${session.messageHistory.length})`,
    );
  }

  const ts = Date.now();
  const text = textParts.join("\n");
  const storeEntry = (refs?: ImageRef[]) => {
    const entry: BrowserIncomingMessage = {
      type: "user_message",
      content: text,
      timestamp: ts,
      id: deps.nextUserMessageId(ts),
      cliUuid,
      ...(refs?.length ? { images: refs } : {}),
    };
    session.messageHistory.push(entry);
    deps.broadcastToBrowsers(session, entry);
    deps.persistSession(session);
  };

  if (imageBlocks.length > 0 && deps.storeImage) {
    Promise.all(imageBlocks.map((image) => deps.storeImage!(session.id, image.data, image.media_type)))
      .then(storeEntry)
      .catch(() => storeEntry());
    return;
  }

  storeEntry();
}

export function handleToolResultMessage(
  session: CliUserReplaySessionLike,
  msg: CLIUserMessage,
  deps: CliUserReplayDeps,
): void {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;

  const toolResults = content.filter(
    (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result",
  );
  let droppedAfterRevert = 0;
  const newToolResults = toolResults.filter((block) => {
    if (!deps.hasToolResultPreviewReplay(session, block.tool_use_id)) return true;
    deps.clearCodexToolResultWatchdog(session, block.tool_use_id);
    session.toolStartTimes.delete(block.tool_use_id);
    return false;
  });
  const filteredToolResults = shouldDropReplayHistoryAfterRevert(session)
    ? newToolResults.filter((block) => {
        droppedAfterRevert++;
        deps.clearCodexToolResultWatchdog(session, block.tool_use_id);
        session.toolStartTimes.delete(block.tool_use_id);
        return false;
      })
    : newToolResults;
  if (droppedAfterRevert > 0) {
    console.log(
      `[revert] Replay tool_result_preview DROPPED (${droppedAfterRevert} block(s), historyLen=${session.messageHistory.length})`,
    );
  }
  const completedToolStartTimes = deps.collectCompletedToolStartTimes(session, filteredToolResults);
  const previews = deps.buildToolResultPreviews(session, filteredToolResults);
  if (previews.length === 0) return;

  const browserMsg: BrowserIncomingMessage = {
    type: "tool_result_preview",
    previews,
  };
  session.messageHistory.push(browserMsg);
  deps.broadcastToBrowsers(session, browserMsg);
  deps.persistSession(session);
  deps.finalizeSupersededCodexTerminalTools(session, completedToolStartTimes);
}

export function handleClaudeCliUserMessage(
  session: CliUserReplaySessionLike,
  msg: CLIUserMessage,
  deps: ClaudeCliUserMessageDeps,
): void {
  if (session.awaitingCompactSummary && !session.cliResuming) {
    const content = msg.message?.content;
    let summaryText: string | undefined;
    if (typeof content === "string" && content.length > 0) {
      summaryText = content;
    } else if (Array.isArray(content)) {
      const textBlock = content.find((block) => block.type === "text") as { type: "text"; text: string } | undefined;
      summaryText = textBlock?.text;
    }
    if (summaryText) {
      session.awaitingCompactSummary = false;
      deps.updateLatestCompactMarkerSummary(session, summaryText);
      deps.broadcastCompactSummary(session, summaryText);
      deps.persistSession(session);
      return;
    }
    session.awaitingCompactSummary = false;
  }
  if (session.resumedFromExternal) {
    extractUserPromptFromCLI(session, msg, deps);
  }
  handleToolResultMessage(session, msg, deps);
}

export function createClaudeMessageHandlers(
  deps: SystemMessageDeps &
    Pick<
      HandleAssistantRuntimeDeps,
      "hasAssistantReplay" | "broadcastToBrowsers" | "persistSession" | "setGenerating" | "onToolUseObserved"
    > &
    ResultMessageDeps &
    ClaudeCliUserMessageDeps,
): {
  handleSystemMessage: (session: CliMessageRouteSessionLike, msg: SystemMessage) => void;
  handleAssistantMessage: (session: CliMessageRouteSessionLike, msg: CLIAssistantMessage) => void;
  handleResultMessage: (session: CliMessageRouteSessionLike, msg: CLIResultMessage) => void;
  handleToolResultMessage: (session: CliUserReplaySessionLike, msg: CLIUserMessage) => void;
  handleClaudeCliUserMessage: (session: CliMessageRouteSessionLike, msg: CLIUserMessage) => void;
  handleSdkBrowserMessage: (session: ClaudeSdkBrowserMessageSessionLike, msg: any) => boolean;
} {
  const systemMessageDeps: SystemMessageDeps = {
    onCLISessionId: deps.onCLISessionId,
    cacheSlashCommands: deps.cacheSlashCommands,
    backfillSlashCommands: deps.backfillSlashCommands,
    refreshGitInfoThenRecomputeDiff: deps.refreshGitInfoThenRecomputeDiff,
    getLauncherSessionInfo: deps.getLauncherSessionInfo,
    broadcastToBrowsers: deps.broadcastToBrowsers,
    persistSession: deps.persistSession,
    hasPendingForceCompact: deps.hasPendingForceCompact,
    flushQueuedCliMessages: deps.flushQueuedCliMessages,
    onOrchestratorTurnEnd: deps.onOrchestratorTurnEnd,
    isCliUserMessagePayload: deps.isCliUserMessagePayload,
    markTurnInterrupted: deps.markTurnInterrupted,
    setGenerating: deps.setGenerating,
    onSessionActivityStateChanged: deps.onSessionActivityStateChanged,
    emitTakodeEvent: deps.emitTakodeEvent,
    injectCompactionRecovery: deps.injectCompactionRecovery,
    hasCompactBoundaryReplay: deps.hasCompactBoundaryReplay,
    freezeHistoryThroughCurrentTail: deps.freezeHistoryThroughCurrentTail,
    hasTaskNotificationReplay: deps.hasTaskNotificationReplay,
    stuckGenerationThresholdMs: deps.stuckGenerationThresholdMs,
  };
  const assistantMessageDeps: HandleAssistantRuntimeDeps = {
    hasAssistantReplay: deps.hasAssistantReplay,
    getLauncherSessionInfo: deps.getLauncherSessionInfo,
    broadcastToBrowsers: deps.broadcastToBrowsers,
    persistSession: deps.persistSession,
    setGenerating: deps.setGenerating,
    onToolUseObserved: deps.onToolUseObserved,
    broadcastStatusRunning: (session) =>
      deps.broadcastToBrowsers(session, { type: "status_change", status: "running" }),
  };
  const resultMessageDeps: ResultMessageDeps = {
    hasResultReplay: deps.hasResultReplay,
    reconcileReplayState: deps.reconcileReplayState,
    drainInlineQueuedClaudeTurns: deps.drainInlineQueuedClaudeTurns,
    markTurnInterrupted: deps.markTurnInterrupted,
    getCurrentTurnTriggerSource: deps.getCurrentTurnTriggerSource,
    reconcileTerminalResultState: deps.reconcileTerminalResultState,
    finalizeOrphanedTerminalToolsOnResult: deps.finalizeOrphanedTerminalToolsOnResult,
    refreshGitInfoThenRecomputeDiff: deps.refreshGitInfoThenRecomputeDiff,
    broadcastToBrowsers: deps.broadcastToBrowsers,
    persistSession: deps.persistSession,
    freezeHistoryThroughCurrentTail: deps.freezeHistoryThroughCurrentTail,
    cancelPermissionNotification: deps.cancelPermissionNotification,
    onSessionActivityStateChanged: deps.onSessionActivityStateChanged,
    onResultAttentionAndNotifications: deps.onResultAttentionAndNotifications,
    onTurnCompleted: deps.onTurnCompleted,
    injectUserMessage: deps.injectUserMessage,
  };
  const cliUserMessageDeps: ClaudeCliUserMessageDeps = {
    hasUserPromptReplay: deps.hasUserPromptReplay,
    hasToolResultPreviewReplay: deps.hasToolResultPreviewReplay,
    broadcastToBrowsers: deps.broadcastToBrowsers,
    persistSession: deps.persistSession,
    nextUserMessageId: deps.nextUserMessageId,
    storeImage: deps.storeImage,
    clearCodexToolResultWatchdog: deps.clearCodexToolResultWatchdog,
    buildToolResultPreviews: deps.buildToolResultPreviews,
    collectCompletedToolStartTimes: deps.collectCompletedToolStartTimes,
    finalizeSupersededCodexTerminalTools: deps.finalizeSupersededCodexTerminalTools,
    broadcastCompactSummary: deps.broadcastCompactSummary,
    updateLatestCompactMarkerSummary: deps.updateLatestCompactMarkerSummary,
  };

  return {
    handleSystemMessage: (session: CliMessageRouteSessionLike, msg: SystemMessage) =>
      handleSystemMessage(session as unknown as SystemMessageSessionLike, msg, systemMessageDeps),
    handleAssistantMessage: (session: CliMessageRouteSessionLike, msg: CLIAssistantMessage) =>
      handleAssistantMessageWithRuntime(session as unknown as AssistantMessageSessionLike, msg, assistantMessageDeps),
    handleResultMessage: (session: CliMessageRouteSessionLike, msg: CLIResultMessage) =>
      handleResultMessage(session as unknown as ResultMessageSessionLike, msg, resultMessageDeps),
    handleToolResultMessage: (session: CliUserReplaySessionLike, msg: CLIUserMessage) =>
      handleToolResultMessage(session, msg, cliUserMessageDeps),
    handleClaudeCliUserMessage: (session: CliMessageRouteSessionLike, msg: CLIUserMessage) =>
      handleClaudeCliUserMessage(session as unknown as CliUserReplaySessionLike, msg, cliUserMessageDeps),
    handleSdkBrowserMessage: (session: ClaudeSdkBrowserMessageSessionLike, msg: any) =>
      handleSdkBrowserMessage(
        session,
        msg,
        systemMessageDeps,
        assistantMessageDeps,
        resultMessageDeps,
        cliUserMessageDeps,
      ),
  };
}

function handleSdkBrowserMessage(
  session: ClaudeSdkBrowserMessageSessionLike,
  msg: any,
  systemMessageDeps: SystemMessageDeps,
  assistantMessageDeps: HandleAssistantRuntimeDeps,
  resultMessageDeps: ResultMessageDeps,
  cliUserMessageDeps: ClaudeCliUserMessageDeps,
): boolean {
  if (msg.type === "assistant") {
    handleAssistantMessageWithRuntime(session, msg, assistantMessageDeps);
    return true;
  }

  if (msg.type === "result") {
    if (session.queuedTurnStarts > 0) {
      console.log(
        `[ws-bridge] Draining ${session.queuedTurnStarts} queued turn(s) for SDK session ${sessionTag(session.id)} — CLI already processed them inline`,
      );
      session.queuedTurnStarts = 0;
      session.queuedTurnReasons = [];
      session.queuedTurnUserMessageIds = [];
      session.queuedTurnInterruptSources = [];
    }
    handleResultMessage(session, (msg as any).data ?? msg, resultMessageDeps);
    return true;
  }

  if (msg.type === "task_notification") {
    handleTaskNotification(
      session,
      {
        type: "system",
        subtype: "task_notification",
        task_id: msg.task_id,
        tool_use_id: msg.tool_use_id,
        status: msg.status,
        output_file: msg.output_file,
        summary: msg.summary,
      } as CLISystemTaskNotificationMessage,
      systemMessageDeps,
    );
    return true;
  }

  if (msg.type === "status_change") {
    handleSdkStatusChange(session, msg, systemMessageDeps);
    return true;
  }

  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    handleSdkCompactBoundary(session, msg as CLISystemCompactBoundaryMessage, systemMessageDeps);
    return true;
  }

  if (msg.type === "user") {
    handleClaudeCliUserMessage(session, msg as CLIUserMessage, cliUserMessageDeps);
    return true;
  }

  return false;
}

function handleSdkStatusChange(
  session: SystemMessageSessionLike,
  msg: { status?: string | null; permissionMode?: string },
  deps: SystemMessageDeps,
): void {
  const wasCompacting = session.state.is_compacting;
  const forceCompactPending = session.forceCompactPending;
  const enteringCompacting = msg.status === "compacting" && (!wasCompacting || forceCompactPending);
  if (enteringCompacting && !session.cliResuming) {
    const ts = Date.now();
    const markerId = `compact-boundary-${ts}`;
    session.messageHistory.push({
      type: "compact_marker",
      timestamp: ts,
      id: markerId,
    });
    deps.freezeHistoryThroughCurrentTail(session);
    session.awaitingCompactSummary = true;
    deps.broadcastToBrowsers(session, {
      type: "compact_boundary",
      id: markerId,
      timestamp: ts,
    });
  }
  handleSystemStatus(
    session,
    {
      type: "system",
      subtype: "status",
      status: msg.status ?? null,
      ...(msg.permissionMode ? { permissionMode: msg.permissionMode } : {}),
    } as CLISystemStatusMessage,
    deps,
  );
  deps.persistSession(session);
}

function handleSdkCompactBoundary(
  session: SystemMessageSessionLike,
  msg: CLISystemCompactBoundaryMessage,
  deps: SystemMessageDeps,
): void {
  if (session.cliResuming) return;

  const cliUuid = msg.uuid;
  const meta = msg.compact_metadata;
  if (deps.hasCompactBoundaryReplay(session, cliUuid, meta)) return;

  const existingMarker = session.messageHistory.findLast((message) => message.type === "compact_marker");
  if (existingMarker && existingMarker.type === "compact_marker" && !existingMarker.cliUuid) {
    existingMarker.cliUuid = cliUuid;
    existingMarker.trigger = meta?.trigger;
    existingMarker.preTokens = meta?.pre_tokens;
    if (session.backendType === "claude") {
      session.claudeCompactBoundarySeen = true;
    }
    deps.persistSession(session);
    return;
  }

  session.compactedDuringTurn = true;
  handleCompactBoundary(session, msg, deps);
}

export function drainInlineQueuedClaudeTurns(
  session: DrainInlineQueuedClaudeTurnsSessionLike,
  reason: string,
  deps: DrainInlineQueuedClaudeTurnsDeps,
): boolean {
  if (session.backendType !== "claude") return false;
  const queuedEntries = deps.getQueuedTurnLifecycleEntries(session);
  if (queuedEntries.length === 0) return false;

  const pendingUserMessageCount = session.pendingMessages.reduce((count, raw) => {
    return count + (deps.isCliUserMessagePayload(raw) ? 1 : 0);
  }, 0);
  if (queuedEntries.length <= pendingUserMessageCount) return false;

  const retainedEntries = pendingUserMessageCount > 0 ? queuedEntries.slice(-pendingUserMessageCount) : [];
  const drainedCount = queuedEntries.length - retainedEntries.length;
  console.log(
    `[ws-bridge] Draining ${drainedCount} inline queued Claude turn(s) on ${reason} for session ${sessionTag(session.id)} ` +
      `(pending_cli_user_messages=${pendingUserMessageCount})`,
  );
  deps.replaceQueuedTurnLifecycleEntries(session, retainedEntries);
  return true;
}

export function getAssistantContentAppendBlocks(
  existing: CLIAssistantMessage["message"]["content"],
  incoming: CLIAssistantMessage["message"]["content"],
  seenToolUseIds: Set<string>,
): CLIAssistantMessage["message"]["content"] {
  if (incoming.length === 0) return [];
  const existingSignatures = existing.map((block) => JSON.stringify(block));
  const incomingSignatures = incoming.map((block) => JSON.stringify(block));
  if (hasAssistantContentSequence(existingSignatures, incomingSignatures)) return [];

  const overlap = getAssistantContentOverlapLength(existingSignatures, incomingSignatures);
  const append: CLIAssistantMessage["message"]["content"] = [];
  for (let index = overlap; index < incoming.length; index++) {
    const block = incoming[index]!;
    if (block.type === "tool_use" && block.id) {
      if (seenToolUseIds.has(block.id)) continue;
      seenToolUseIds.add(block.id);
    }
    append.push(block);
  }
  return append;
}

export function extractActivityPreview(session: AssistantMessageSessionLike, content: unknown[]): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    const candidate = block as { type?: string; name?: string; input?: Record<string, unknown> };
    if (candidate.type !== "tool_use") continue;
    if (candidate.name === "TodoWrite") {
      const todos = candidate.input?.todos as { status?: string; activeForm?: string; content?: string }[] | undefined;
      if (Array.isArray(todos)) {
        const active = todos.find((todo) => todo.status === "in_progress");
        session.lastActivityPreview = active ? (active.activeForm || active.content || "").slice(0, 80) : undefined;
      }
    } else if (candidate.name === "TaskUpdate") {
      const status = candidate.input?.status as string | undefined;
      const activeForm = candidate.input?.activeForm as string | undefined;
      if (status === "in_progress" && activeForm) {
        session.lastActivityPreview = activeForm.slice(0, 80);
      }
    }
  }
}

function handleSystemInit(session: SystemMessageSessionLike, msg: CLISystemInitMessage, deps: SystemMessageDeps): void {
  session.cliInitReceived = true;
  if (msg.session_id && deps.onCLISessionId) {
    deps.onCLISessionId(session.id, msg.session_id);
  }
  session.state.model = msg.model;
  const inferredContextWindow = inferContextWindowFromModel(msg.model);
  if (inferredContextWindow) {
    if (session.state.claude_token_details) {
      session.state.claude_token_details.modelContextWindow = Math.max(
        session.state.claude_token_details.modelContextWindow,
        inferredContextWindow,
      );
    } else {
      session.state.claude_token_details = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        modelContextWindow: inferredContextWindow,
      };
    }
  }
  if (!session.state.is_containerized) {
    session.state.cwd = msg.cwd;
  }
  session.state.tools = msg.tools;
  if (session.messageHistory.length === 0) {
    session.state.permissionMode = msg.permissionMode;
  }
  session.state.claude_code_version = msg.claude_code_version;

  if (session.cliResuming) {
    if (session.cliResumingClearTimer) clearTimeout(session.cliResumingClearTimer);
    session.cliResumingClearTimer = setTimeout(() => {
      session.cliResumingClearTimer = null;
      session.cliResuming = false;
      session.dropReplayHistoryAfterRevert = false;
      const compactPending = deps.hasPendingForceCompact(session);
      session.forceCompactPending = compactPending;
      session.state.is_compacting = compactPending;
      session.awaitingCompactSummary = false;
      session.claudeCompactBoundarySeen = false;
      if (compactPending) {
        deps.broadcastToBrowsers(session, { type: "status_change", status: "compacting" });
      }
      if (session.pendingMessages.length > 0) {
        deps.flushQueuedCliMessages(session, "after replay done");
      }
      if (deps.getLauncherSessionInfo(session.id)?.isOrchestrator) {
        deps.onOrchestratorTurnEnd(session.id);
      }
    }, 2000);
  } else {
    session.state.is_compacting = false;
  }

  session.state.mcp_servers = msg.mcp_servers;
  session.state.agents = msg.agents ?? [];
  session.state.slash_commands = msg.slash_commands ?? [];
  session.state.skills = msg.skills ?? [];
  session.state.skill_metadata = [];
  session.state.apps = [];
  const projectKey = session.state.repo_root || session.state.cwd;
  if (projectKey && (msg.slash_commands?.length || msg.skills?.length)) {
    deps.cacheSlashCommands(projectKey, { slash_commands: msg.slash_commands ?? [], skills: msg.skills ?? [] });
    deps.backfillSlashCommands(projectKey, session.id);
  }

  deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  deps.broadcastToBrowsers(session, {
    type: "session_init",
    session: {
      ...session.state,
      isOrchestrator: launcherInfo?.isOrchestrator === true,
    },
  });
  deps.persistSession(session);

  const generationAge = session.generationStartedAt ? Date.now() - session.generationStartedAt : 0;
  const seamlessButStuck = session.seamlessReconnect && generationAge >= deps.stuckGenerationThresholdMs;
  if (seamlessButStuck) {
    console.warn(
      `[ws-bridge] Seamless reconnect with stale generation (${Math.round(generationAge / 1000)}s) for session ${sessionTag(session.id)} — treating as relaunch`,
    );
  }
  if (session.isGenerating && (!session.seamlessReconnect || seamlessButStuck)) {
    const hasInFlightUserDispatch =
      typeof session.lastOutboundUserNdjson === "string" &&
      deps.isCliUserMessagePayload(session.lastOutboundUserNdjson);
    if (!hasInFlightUserDispatch) {
      deps.markTurnInterrupted(session, "system");
      deps.setGenerating(session, false, "system_init_reset");
      deps.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
    }
  }
  session.seamlessReconnect = false;
  session.disconnectWasGenerating = false;

  if (!session.cliResuming) {
    if (session.pendingMessages.length > 0) {
      deps.flushQueuedCliMessages(session, "after init");
    }
    if (launcherInfo?.isOrchestrator) {
      deps.onOrchestratorTurnEnd(session.id);
    }
  }
  deps.onSessionActivityStateChanged(session.id, "system_init");
}

function handleSystemStatus(
  session: SystemMessageSessionLike,
  msg: CLISystemStatusMessage,
  deps: SystemMessageDeps,
): void {
  const wasCompacting = session.state.is_compacting;
  const forceCompactPending = session.forceCompactPending;
  session.state.is_compacting = msg.status === "compacting";
  const enteringCompacting = msg.status === "compacting" && (!wasCompacting || forceCompactPending);
  if (msg.status === "compacting") {
    session.forceCompactPending = false;
  }
  if (enteringCompacting && session.backendType === "claude") {
    session.claudeCompactBoundarySeen = false;
  }
  if (enteringCompacting && !session.cliResuming) {
    session.compactedDuringTurn = true;
    deps.emitTakodeEvent(session.id, "compaction_started", {
      ...(typeof session.state.context_used_percent === "number"
        ? { context_used_percent: session.state.context_used_percent }
        : {}),
    });
  }
  if (wasCompacting && msg.status !== "compacting" && !session.cliResuming) {
    deps.emitTakodeEvent(session.id, "compaction_finished", {
      ...(typeof session.state.context_used_percent === "number"
        ? { context_used_percent: session.state.context_used_percent }
        : {}),
    });
    if (session.backendType !== "claude" || session.claudeCompactBoundarySeen) {
      deps.injectCompactionRecovery(session);
    }
  }
  if (wasCompacting && msg.status !== "compacting" && session.backendType === "claude") {
    session.claudeCompactBoundarySeen = false;
  }

  if (msg.permissionMode) {
    session.state.permissionMode = msg.permissionMode;
    if (!session.cliResuming) {
      const uiMode = msg.permissionMode === "plan" ? "plan" : "agent";
      session.state.uiMode = uiMode;
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { permissionMode: msg.permissionMode, uiMode },
      });
    } else {
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { permissionMode: msg.permissionMode },
      });
    }
  }

  if (!session.cliResuming) {
    deps.broadcastToBrowsers(session, { type: "status_change", status: msg.status ?? null });
    deps.onSessionActivityStateChanged(session.id, "system_status");
  }
}

function handleCompactBoundary(
  session: SystemMessageSessionLike,
  msg: CLISystemCompactBoundaryMessage,
  deps: SystemMessageDeps,
): void {
  if (session.cliResuming) return;
  const cliUuid = msg.uuid;
  const meta = msg.compact_metadata;
  if (session.backendType === "claude") {
    session.claudeCompactBoundarySeen = true;
  }
  if (deps.hasCompactBoundaryReplay(session, cliUuid, meta)) return;

  const ts = Date.now();
  const markerId = `compact-boundary-${ts}`;
  session.messageHistory.push({
    type: "compact_marker",
    timestamp: ts,
    id: markerId,
    cliUuid,
    trigger: meta?.trigger,
    preTokens: meta?.pre_tokens,
  });
  deps.freezeHistoryThroughCurrentTail(session);
  session.awaitingCompactSummary = true;
  deps.broadcastToBrowsers(session, {
    type: "compact_boundary",
    id: markerId,
    timestamp: ts,
    trigger: meta?.trigger,
    preTokens: meta?.pre_tokens,
  });
  deps.persistSession(session);
}

function handleTaskNotification(
  session: SystemMessageSessionLike,
  msg: CLISystemTaskNotificationMessage,
  deps: SystemMessageDeps,
): void {
  const browserMsg = {
    type: "task_notification" as const,
    task_id: msg.task_id,
    tool_use_id: msg.tool_use_id,
    status: msg.status,
    output_file: msg.output_file,
    summary: msg.summary,
  };
  if (msg.task_id && msg.tool_use_id && deps.hasTaskNotificationReplay(session, msg.task_id, msg.tool_use_id)) {
    return;
  }
  session.messageHistory.push(browserMsg);
  deps.broadcastToBrowsers(session, browserMsg);
  deps.persistSession(session);
}

function handleStreamEventMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIStreamEventMessage,
  deps: Pick<CliMessageRouteDeps, "broadcastToBrowsers">,
): void {
  deps.broadcastToBrowsers(session, {
    type: "stream_event",
    event: msg.event,
    parent_tool_use_id: msg.parent_tool_use_id,
  });
}

function handleControlCancelRequestMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIControlCancelRequestMessage,
  deps: Pick<
    CliMessageRouteDeps,
    | "abortAutoApproval"
    | "broadcastToBrowsers"
    | "cancelPermissionNotification"
    | "clearActionAttentionIfNoPermissions"
    | "persistSession"
  >,
): void {
  const reqId = msg.request_id;
  const pending = session.pendingPermissions.get(reqId);
  if (!pending) return;
  deps.abortAutoApproval(session, reqId);
  session.pendingPermissions.delete(reqId);
  deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
  deps.cancelPermissionNotification(session.id, reqId);
  deps.clearActionAttentionIfNoPermissions(session);
  deps.persistSession(session);
  console.log(
    `[ws-bridge] CLI cancelled pending permission ${reqId} (${pending.tool_name}) for session ${sessionTag(session.id)}`,
  );
}

function handleToolProgressMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIToolProgressMessage,
  deps: Pick<CliMessageRouteDeps, "broadcastToBrowsers" | "toolProgressOutputLimit">,
): void {
  if (typeof msg.output_delta === "string" && msg.output_delta.length > 0) {
    const prev = session.toolProgressOutput.get(msg.tool_use_id) || "";
    const merged = prev + msg.output_delta;
    session.toolProgressOutput.set(
      msg.tool_use_id,
      merged.length > deps.toolProgressOutputLimit ? merged.slice(-deps.toolProgressOutputLimit) : merged,
    );
  }
  session.lastToolProgressAt = Date.now();
  deps.broadcastToBrowsers(session, {
    type: "tool_progress",
    tool_use_id: msg.tool_use_id,
    tool_name: msg.tool_name,
    elapsed_time_seconds: msg.elapsed_time_seconds,
    ...(typeof msg.output_delta === "string" ? { output_delta: msg.output_delta } : {}),
  });
}

function handleToolUseSummaryMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIToolUseSummaryMessage,
  deps: Pick<CliMessageRouteDeps, "broadcastToBrowsers">,
): void {
  deps.broadcastToBrowsers(session, {
    type: "tool_use_summary",
    summary: msg.summary,
    tool_use_ids: msg.preceding_tool_use_ids,
  });
}

function handleAuthStatusMessage(
  session: CliMessageRouteSessionLike,
  msg: CLIAuthStatusMessage,
  deps: Pick<CliMessageRouteDeps, "broadcastToBrowsers">,
): void {
  deps.broadcastToBrowsers(session, {
    type: "auth_status",
    isAuthenticating: msg.isAuthenticating,
    output: msg.output,
    error: msg.error,
  });
}

function maybeUpdateContextUsedPercentFromAssistantUsage(
  session: AssistantMessageSessionLike,
  usage: TokenUsage | undefined,
  modelHint: string | undefined,
  broadcastToBrowsers: HandleAssistantMessageDeps["broadcastToBrowsers"],
): void {
  if (!usage) return;
  const model = session.state.model || modelHint;
  const contextWindow = resolveResultContextWindow(model, undefined);
  if (!contextWindow) return;
  const nextContextPct = computeContextUsedPercent(usage, contextWindow);
  if (typeof nextContextPct !== "number" || session.state.context_used_percent === nextContextPct) return;
  session.state.context_used_percent = nextContextPct;
  broadcastToBrowsers(session, {
    type: "session_update",
    session: { context_used_percent: nextContextPct },
  });
}

function hasAssistantContentSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function getAssistantContentOverlapLength(existing: string[], incoming: string[]): number {
  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let size = maxOverlap; size > 0; size--) {
    let matches = true;
    for (let offset = 0; offset < size; offset++) {
      if (existing[existing.length - size + offset] !== incoming[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskOutput",
  "TaskStop",
]);
