import type { BrowserIncomingMessage, CLIResultMessage, PermissionRequest, SessionState } from "../session-types.js";
import { computeResultContextUsedPercent, extractClaudeTokenDetails, type TokenUsage } from "./context-usage.js";

export interface ResultMessageSessionLike {
  id: string;
  backendType: "claude" | "codex" | "claude-sdk";
  cliResuming: boolean;
  messageHistory: BrowserIncomingMessage[];
  state: Pick<SessionState, "model" | "total_cost_usd" | "num_turns" | "context_used_percent" | "claude_token_details">;
  diffStatsDirty: boolean;
  generationStartedAt?: number | null;
  interruptedDuringTurn: boolean;
  queuedTurnStarts: number;
  queuedTurnInterruptSources: Array<"user" | "leader" | "system" | null>;
  isGenerating: boolean;
  lastOutboundUserNdjson: string | null;
  pendingPermissions: Map<string, PermissionRequest>;
  toolStartTimes: Map<string, number>;
}

interface BroadcastOptions {
  skipBuffer?: boolean;
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
}

export function handleResultMessage(
  session: ResultMessageSessionLike,
  msg: CLIResultMessage,
  deps: ResultMessageDeps,
): void {
  if (msg.uuid && deps.hasResultReplay(session, msg.uuid)) {
    const reconciled = deps.reconcileReplayState(session);
    const drainedQueuedTurns = deps.drainInlineQueuedClaudeTurns(session, "result_replay");
    if (drainedQueuedTurns || reconciled.clearedResidualState) {
      deps.broadcastToBrowsers(session, { type: "status_change", status: "idle" });
      deps.persistSession(session);
    }
    return;
  }

  session.state.total_cost_usd = msg.total_cost_usd;
  session.state.num_turns = msg.num_turns;

  const lastAssistant = session.messageHistory.findLast(
    (entry) => entry.type === "assistant" && (entry as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
  ) as { message?: { usage?: TokenUsage } } | undefined;
  const lastAssistantUsage = lastAssistant?.message?.usage;

  const nextContextPct = computeResultContextUsedPercent(session.state.model, msg, lastAssistantUsage);
  if (typeof nextContextPct === "number") {
    session.state.context_used_percent = nextContextPct;
  }
  const nextClaudeTokenDetails = extractClaudeTokenDetails(msg.modelUsage);
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
  if (resultInterrupted && !session.interruptedDuringTurn && session.queuedTurnStarts > 0) {
    deps.markTurnInterrupted(session, session.queuedTurnInterruptSources[0] ?? "user");
  }
  const turnWasInterrupted = session.interruptedDuringTurn || resultInterrupted;
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
      (entry) => entry.type === "assistant" && (entry as { parent_tool_use_id?: string | null }).parent_tool_use_id == null,
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
}
