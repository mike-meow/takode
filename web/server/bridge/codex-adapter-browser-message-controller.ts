import type {
  ActiveTurnRoute,
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CLIResultMessage,
  CodexLeaderRecycleTrigger,
  CodexOutboundTurn,
  ContentBlock,
  PermissionRequest,
  ThreadRef,
} from "../session-types.js";
import type { ParsedThreadStatusMarker } from "../../shared/thread-status-marker.js";
import { sessionTag } from "../session-tag.js";
import {
  hasLeaderVisibleTextContent,
  normalizeLeaderAssistantRouting,
  updateLeaderThreadStatusesForAssistantOutput,
} from "./thread-routing-reminder.js";
import { queueQuestThreadRemindersForCompletedTurn } from "./quest-thread-reminder.js";
import { recordCompactionFinished, recordCompactionStarted } from "./session-lifecycle-events.js";
import { shouldTrackCodexToolResultRecovery } from "./tool-result-recovery-controller.js";
import {
  appendThreadTransitionMarkerForRouteSwitch,
  normalizeThreadRoute,
  type ThreadRouteMetadata,
} from "../thread-routing-metadata.js";
import { computeSessionTurnMetrics } from "../user-message-classification.js";

const TOOL_PROGRESS_OUTPUT_LIMIT = 12_000;

type CodexBrowserMessageSessionLike = any;
type CodexBrowserMessageAdapterLike = {
  sendBrowserMessage(msg: unknown): void;
};

function isLeaderSessionForAssistantRouting(
  session: CodexBrowserMessageSessionLike,
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
): boolean {
  if (session.state?.isOrchestrator === true) return true;
  if (launcherInfo?.isOrchestrator !== true) return false;
  session.state = { ...session.state, isOrchestrator: true };
  return true;
}

function routeFromLeaderAssistantResult(routed: {
  threadKey?: string;
  questId?: string;
  threadRefs?: ThreadRef[];
}): ThreadRouteMetadata | undefined {
  if (!routed.threadKey) return undefined;
  return {
    threadKey: routed.threadKey,
    ...(routed.questId ? { questId: routed.questId } : {}),
    ...(routed.threadRefs?.length ? { threadRefs: routed.threadRefs } : {}),
  };
}

function activeTurnRouteFromThreadRoute(route: ThreadRouteMetadata): ActiveTurnRoute {
  return {
    threadKey: route.threadKey,
    ...(route.questId ? { questId: route.questId } : {}),
  };
}

function sameActiveTurnRoute(
  current: ActiveTurnRoute | null | undefined,
  next: ActiveTurnRoute | null | undefined,
): boolean {
  return (current?.threadKey ?? "main") === (next?.threadKey ?? "main") && current?.questId === next?.questId;
}

function updateActiveTurnRouteFromLeaderAssistant(
  session: CodexBrowserMessageSessionLike,
  route: ThreadRouteMetadata | undefined,
  deps: Pick<CodexAdapterBrowserMessageDeps, "broadcastToBrowsers">,
): void {
  if (!route || !session.isGenerating) return;
  const nextRoute = activeTurnRouteFromThreadRoute(route);
  if (sameActiveTurnRoute(session.activeTurnRoute, nextRoute)) return;
  session.activeTurnRoute = nextRoute;
  deps.broadcastToBrowsers(session, {
    type: "status_change",
    status: "running",
    activeTurnRoute: nextRoute,
  });
}

type CodexLeaderRecycleLauncherInfo = {
  isOrchestrator?: boolean;
  codexLeaderRecycleThresholdTokens?: number;
  codexLeaderRecycleLineage?: {
    recycleEvents?: Array<{
      trigger?: CodexLeaderRecycleTrigger;
      tokenUsage?: {
        contextTokensUsed?: number;
      };
    }>;
  };
};

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function withCodexLeaderRecycleThreshold(
  session: CodexBrowserMessageSessionLike,
  patch: Record<string, unknown>,
  deps: Pick<CodexAdapterBrowserMessageDeps, "getLauncherSessionInfo">,
): Record<string, unknown> {
  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  if (launcherInfo?.isOrchestrator !== true) return patch;
  const thresholdTokens =
    positiveInteger(launcherInfo.codexLeaderRecycleThresholdTokens) ??
    positiveInteger(patch.codex_leader_recycle_threshold_tokens) ??
    positiveInteger(session.state?.codex_leader_recycle_threshold_tokens);
  if (!thresholdTokens) return patch;
  return { ...patch, codex_leader_recycle_threshold_tokens: thresholdTokens };
}

function withHistoryTurnMetrics(
  session: CodexBrowserMessageSessionLike,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const history = Array.isArray(session.messageHistory) ? session.messageHistory : [];
  if (history.length === 0) {
    return preserveExistingTurnMetrics(session, patch);
  }
  const turnMetrics = computeSessionTurnMetrics(history);
  return {
    ...patch,
    user_turn_count: turnMetrics.userTurnCount,
    agent_turn_count: turnMetrics.agentTurnCount,
    num_turns: turnMetrics.userTurnCount,
  };
}

function preserveExistingTurnMetrics(
  session: CodexBrowserMessageSessionLike,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const existingUserTurns = session.state?.user_turn_count;
  const existingAgentTurns = session.state?.agent_turn_count;
  const existingNumTurns = session.state?.num_turns;
  const next = { ...patch };
  if (typeof existingUserTurns === "number" && existingUserTurns > 0 && next.user_turn_count === 0) {
    next.user_turn_count = existingUserTurns;
  }
  if (typeof existingAgentTurns === "number" && existingAgentTurns > 0 && next.agent_turn_count === 0) {
    next.agent_turn_count = existingAgentTurns;
  }
  if (typeof existingNumTurns === "number" && existingNumTurns > 0 && next.num_turns === 0) {
    next.num_turns = existingNumTurns;
  }
  return next;
}

function getLatestThresholdRecycleWatermark(
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
): number | null {
  const recycleEvents = launcherInfo?.codexLeaderRecycleLineage?.recycleEvents;
  if (!Array.isArray(recycleEvents) || recycleEvents.length === 0) return null;
  for (let index = recycleEvents.length - 1; index >= 0; index -= 1) {
    const recycleEvent = recycleEvents[index];
    const watermark = recycleEvent?.tokenUsage?.contextTokensUsed;
    if (recycleEvent?.trigger !== "threshold" || typeof watermark !== "number") continue;
    return watermark;
  }
  return null;
}

function shouldTriggerCodexLeaderThresholdRecycle(
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
  contextTokensUsed: number | undefined,
  recycleThresholdTokens: number,
): boolean {
  if (!launcherInfo?.isOrchestrator) return false;
  if (typeof contextTokensUsed !== "number") return false;
  if (recycleThresholdTokens <= 0 || contextTokensUsed < recycleThresholdTokens) return false;
  const latestThresholdWatermark = getLatestThresholdRecycleWatermark(launcherInfo);
  if (latestThresholdWatermark !== null && contextTokensUsed <= latestThresholdWatermark) return false;
  return true;
}

export interface CodexAdapterBrowserMessageDeps {
  getLauncherSessionInfo: (sessionId: string) => CodexLeaderRecycleLauncherInfo | null | undefined;
  touchActivity: (sessionId: string) => void;
  clearOptimisticRunningTimer: (session: CodexBrowserMessageSessionLike, reason: string) => void;
  setCodexImageSendStage: (
    session: CodexBrowserMessageSessionLike,
    stage: string,
    options?: { persist?: boolean },
  ) => void;
  sanitizeCodexSessionPatch: (patch: Record<string, unknown>) => Record<string, unknown>;
  cacheSlashCommandState: (session: CodexBrowserMessageSessionLike, sanitized: Record<string, unknown>) => void;
  refreshGitInfoThenRecomputeDiff: (
    session: CodexBrowserMessageSessionLike,
    options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
  ) => void;
  persistSession: (session: CodexBrowserMessageSessionLike) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  freezeHistoryThroughCurrentTail: (session: CodexBrowserMessageSessionLike) => void;
  injectCompactionRecovery: (session: CodexBrowserMessageSessionLike) => void;
  trackCodexQuestCommands: (session: CodexBrowserMessageSessionLike, content: ContentBlock[]) => void;
  reconcileCodexQuestToolResult: (
    session: CodexBrowserMessageSessionLike,
    toolResult: Extract<ContentBlock, { type: "tool_result" }>,
  ) => Promise<void>;
  collectCompletedToolStartTimes: (
    session: CodexBrowserMessageSessionLike,
    toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
  ) => number[];
  buildToolResultPreviews: (
    session: CodexBrowserMessageSessionLike,
    toolResults: Extract<ContentBlock, { type: "tool_result" }>[],
  ) => unknown[];
  broadcastToBrowsers: (session: CodexBrowserMessageSessionLike, msg: BrowserIncomingMessage) => void;
  finalizeSupersededCodexTerminalTools: (
    session: CodexBrowserMessageSessionLike,
    completedToolStartTimes: number[],
  ) => void;
  isDuplicateCodexAssistantReplay: (
    session: CodexBrowserMessageSessionLike,
    assistant: Extract<BrowserIncomingMessage, { type: "assistant" }>,
  ) => boolean;
  completeCodexTurnsForResult: (
    session: CodexBrowserMessageSessionLike,
    msg: CLIResultMessage,
    updatedAt?: number,
  ) => boolean;
  clearCodexFreshTurnRequirement: (
    session: CodexBrowserMessageSessionLike,
    reason: string,
    options?: { completedTurnId?: string | null },
  ) => void;
  handleResultMessage: (session: CodexBrowserMessageSessionLike, msg: CLIResultMessage) => void;
  queueCodexPendingStartBatch: (session: CodexBrowserMessageSessionLike, reason: string) => void;
  dispatchQueuedCodexTurns: (session: CodexBrowserMessageSessionLike, reason: string) => void;
  maybeFlushQueuedCodexMessages: (session: CodexBrowserMessageSessionLike, reason: string) => void;
  handleCodexPermissionRequest: (
    session: CodexBrowserMessageSessionLike,
    permission: PermissionRequest,
  ) => Promise<void> | void;
  requestCodexLeaderRecycle: (
    session: CodexBrowserMessageSessionLike,
    trigger: CodexLeaderRecycleTrigger,
  ) => Promise<{ ok: boolean; error?: string }>;
  handleCodexResultErrorAutoPause: (
    session: CodexBrowserMessageSessionLike,
    msg: CLIResultMessage,
    completedTurn: CodexOutboundTurn | null,
  ) => Promise<void> | void;
  syncSlackThreadParent?: (session: CodexBrowserMessageSessionLike) => void;
}

export function isCodexContextWindowExhaustionMessage(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return (
    /\bcodex\b/i.test(message) &&
    /\bran out of room in the model'?s context window\b/i.test(message) &&
    /\b(?:start a new thread|clear earlier history)\b/i.test(message)
  );
}

function getCodexContextWindowExhaustionMessage(msg: BrowserIncomingMessage): string | null {
  if (msg.type === "error") {
    return isCodexContextWindowExhaustionMessage(msg.message) ? msg.message : null;
  }
  if (msg.type !== "result" || !msg.data?.is_error) return null;
  if (isCodexContextWindowExhaustionMessage(msg.data.result)) return msg.data.result || null;
  const matchingError = msg.data.errors?.find(isCodexContextWindowExhaustionMessage);
  return matchingError || null;
}

function isCodexLeaderSession(
  session: CodexBrowserMessageSessionLike,
  launcherInfo: CodexLeaderRecycleLauncherInfo | null | undefined,
): boolean {
  return session.state?.isOrchestrator === true || launcherInfo?.isOrchestrator === true;
}

async function maybeRecycleCodexLeaderForContextWindowExhaustion(
  session: CodexBrowserMessageSessionLike,
  outgoing: BrowserIncomingMessage | null,
  deps: CodexAdapterBrowserMessageDeps,
): Promise<boolean> {
  if (!outgoing) return false;
  const errorMessage = getCodexContextWindowExhaustionMessage(outgoing);
  if (!errorMessage) return false;
  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  if (!isCodexLeaderSession(session, launcherInfo)) return false;

  const recycle = await deps.requestCodexLeaderRecycle(session, "context_window_exhausted");
  if (!recycle.ok) {
    deps.broadcastToBrowsers(session, {
      type: "error",
      message: recycle.error || "Failed to recycle Codex leader session after context-window exhaustion",
    });
  }
  return true;
}

export async function handleCodexAdapterBrowserMessage(
  session: CodexBrowserMessageSessionLike,
  msg: BrowserIncomingMessage,
  deps: CodexAdapterBrowserMessageDeps,
): Promise<void> {
  deps.touchActivity(session.id);
  session.lastCliMessageAt = Date.now();
  deps.clearOptimisticRunningTimer(session, `codex_output:${msg.type}`);
  if (session.state.codex_image_send_stage && (msg.type === "stream_event" || msg.type === "assistant")) {
    deps.setCodexImageSendStage(session, "responding", { persist: false });
  }

  let outgoing: BrowserIncomingMessage | null = msg;
  let activeRouteFromAssistant: ThreadRouteMetadata | undefined;
  let pendingThreadStatusMarkers: ParsedThreadStatusMarker[] | undefined;
  let leaderThreadStatusesChanged = false;

  if (msg.type === "session_init") {
    const sanitized = deps.sanitizeCodexSessionPatch(msg.session as unknown as Record<string, unknown>);
    const enriched = withHistoryTurnMetrics(
      session,
      withCodexLeaderRecycleThreshold(session, { ...sanitized, backend_type: "codex" }, deps),
    );
    session.state = { ...session.state, ...enriched };
    session.cliInitReceived = true;
    deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
    deps.persistSession(session);
    outgoing = { ...msg, session: enriched as unknown as typeof msg.session } as BrowserIncomingMessage;
  } else if (msg.type === "session_update") {
    const sanitized = deps.sanitizeCodexSessionPatch(msg.session as unknown as Record<string, unknown>);
    const enriched = withHistoryTurnMetrics(
      session,
      withCodexLeaderRecycleThreshold(session, { ...sanitized, backend_type: "codex" }, deps),
    );
    session.state = { ...session.state, ...enriched };
    outgoing = { ...msg, session: enriched as unknown as typeof msg.session } as BrowserIncomingMessage;
    deps.cacheSlashCommandState(session, enriched);
    deps.refreshGitInfoThenRecomputeDiff(session, { notifyPoller: true });
    const launcherInfo = deps.getLauncherSessionInfo(session.id);
    const recycleThresholdTokens =
      positiveInteger(session.state.codex_leader_recycle_threshold_tokens) ??
      positiveInteger(launcherInfo?.codexLeaderRecycleThresholdTokens) ??
      0;
    const contextTokensUsed = session.state.codex_token_details?.contextTokensUsed;
    if (shouldTriggerCodexLeaderThresholdRecycle(launcherInfo, contextTokensUsed, recycleThresholdTokens)) {
      const recycle = await deps.requestCodexLeaderRecycle(session, "threshold");
      if (!recycle.ok) {
        deps.broadcastToBrowsers(session, {
          type: "error",
          message: recycle.error || "Failed to recycle Codex leader session",
        });
      }
    }
    deps.persistSession(session);
  } else if (msg.type === "status_change") {
    const wasCompacting = session.state.is_compacting;
    session.state.is_compacting = msg.status === "compacting";
    if (msg.status === "compacting" && !wasCompacting) {
      session.compactedDuringTurn = true;
      deps.emitTakodeEvent(session.id, "compaction_started", {
        ...(typeof session.state.context_used_percent === "number"
          ? { context_used_percent: session.state.context_used_percent }
          : {}),
      });
      const ts = Date.now();
      const markerId = `compact-boundary-${ts}`;
      session.messageHistory.push({
        type: "compact_marker",
        timestamp: ts,
        id: markerId,
      });
      recordCompactionStarted(session, { id: markerId, timestamp: ts });
      deps.freezeHistoryThroughCurrentTail(session);
      deps.broadcastToBrowsers(session, {
        type: "compact_boundary",
        id: markerId,
        timestamp: ts,
      } as BrowserIncomingMessage);
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { lifecycle_events: session.state.lifecycle_events },
      } as BrowserIncomingMessage);
    }
    if (wasCompacting && msg.status !== "compacting") {
      recordCompactionFinished(session);
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { lifecycle_events: session.state.lifecycle_events },
      } as BrowserIncomingMessage);
      deps.emitTakodeEvent(session.id, "compaction_finished", {
        ...(typeof session.state.context_used_percent === "number"
          ? { context_used_percent: session.state.context_used_percent }
          : {}),
      });
      deps.injectCompactionRecovery(session);
    }
    deps.persistSession(session);
  } else if (msg.type === "assistant") {
    const launcherInfo = deps.getLauncherSessionInfo(session.id);
    const isLeaderSession = isLeaderSessionForAssistantRouting(session, launcherInfo);
    const routed = normalizeLeaderAssistantRouting(isLeaderSession, msg.message.content || [], msg.parent_tool_use_id);
    activeRouteFromAssistant = routeFromLeaderAssistantResult(routed);
    if (routed.questThreadReminders?.length) {
      queueQuestThreadRemindersForCompletedTurn(session, routed.questThreadReminders, activeRouteFromAssistant);
    }
    const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
    const resolvedMessageId = msg.message.id ?? msg.uuid ?? `assistant-${timestamp}-${session.messageHistory.length}`;
    pendingThreadStatusMarkers = routed.threadStatusMarkers;
    const routedMsg = {
      ...msg,
      message: { ...msg.message, id: resolvedMessageId, content: routed.content },
      timestamp,
      ...(routed.threadKey ? { threadKey: routed.threadKey } : {}),
      ...(routed.questId ? { questId: routed.questId } : {}),
      ...(routed.threadRefs ? { threadRefs: routed.threadRefs } : {}),
      ...(routed.threadRoutingError ? { threadRoutingError: routed.threadRoutingError } : {}),
    };
    msg = routedMsg;
    outgoing = routedMsg;
    const content: ContentBlock[] = routedMsg.message.content || [];
    const now = Date.now();
    for (const block of content) {
      if (
        block.type === "tool_use" &&
        block.id &&
        shouldTrackCodexToolResultRecovery(block) &&
        !session.toolStartTimes.has(block.id)
      ) {
        session.toolStartTimes.set(block.id, now);
        session.toolProgressOutput.delete(block.id);
      }
    }
    deps.trackCodexQuestCommands(session, content);
    const toolResults = content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> => block.type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        await deps.reconcileCodexQuestToolResult(session, block);
      }
      const completedToolStartTimes = deps.collectCompletedToolStartTimes(session, toolResults);
      const previews = deps.buildToolResultPreviews(session, toolResults);
      if (previews.length > 0) {
        const previewMsg: BrowserIncomingMessage = {
          type: "tool_result_preview",
          previews,
        } as BrowserIncomingMessage;
        session.messageHistory.push(previewMsg);
        deps.broadcastToBrowsers(session, previewMsg);
        deps.persistSession(session);
        deps.finalizeSupersededCodexTerminalTools(session, completedToolStartTimes);
      }

      const nonResult = content.filter((block: ContentBlock) => block.type !== "tool_result");
      if (nonResult.length === 0) {
        outgoing = null;
      } else {
        outgoing = {
          ...routedMsg,
          message: { ...routedMsg.message, content: nonResult },
        } as BrowserIncomingMessage;
      }
    }
  } else if (msg.type === "tool_progress") {
    if (typeof msg.output_delta === "string" && msg.output_delta.length > 0) {
      const prev = session.toolProgressOutput.get(msg.tool_use_id) || "";
      const merged = prev + msg.output_delta;
      session.toolProgressOutput.set(
        msg.tool_use_id,
        merged.length > TOOL_PROGRESS_OUTPUT_LIMIT ? merged.slice(-TOOL_PROGRESS_OUTPUT_LIMIT) : merged,
      );
    }
  }

  if (outgoing?.type === "assistant") {
    const assistantTimestamp = outgoing.timestamp || Date.now();
    let normalizedAssistant: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
      ...outgoing,
      timestamp: assistantTimestamp,
    };
    if (deps.isDuplicateCodexAssistantReplay(session, normalizedAssistant)) {
      deps.syncSlackThreadParent?.(session);
      return;
    }
    const statusUpdate = updateLeaderThreadStatusesForAssistantOutput(
      session,
      pendingThreadStatusMarkers,
      {
        messageId: normalizedAssistant.message.id,
        timestamp: assistantTimestamp,
      },
      hasLeaderVisibleTextContent(normalizedAssistant.message.content) ? activeRouteFromAssistant : undefined,
    );
    const threadStatusRecords = statusUpdate.records;
    if (threadStatusRecords.length > 0) {
      normalizedAssistant = { ...normalizedAssistant, threadStatusMarkers: threadStatusRecords };
    }
    leaderThreadStatusesChanged = statusUpdate.changed;
    outgoing = normalizedAssistant;
  }

  if (outgoing?.type === "assistant") {
    const transitionMarker = appendThreadTransitionMarkerForRouteSwitch(
      session.messageHistory,
      normalizeThreadRoute(outgoing.threadKey, outgoing.questId),
    );
    if (transitionMarker) deps.broadcastToBrowsers(session, transitionMarker);
    session.messageHistory.push(outgoing);
    deps.persistSession(session);
    deps.syncSlackThreadParent?.(session);
    if (leaderThreadStatusesChanged) {
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { leaderThreadStatuses: session.state.leaderThreadStatuses },
      } as BrowserIncomingMessage);
    }
  } else if (outgoing?.type === "result") {
    if (await maybeRecycleCodexLeaderForContextWindowExhaustion(session, outgoing, deps)) {
      return;
    }
    const codexTurnId = typeof outgoing.data.codex_turn_id === "string" ? outgoing.data.codex_turn_id : null;
    const completedTurn =
      codexTurnId && Array.isArray(session.pendingCodexTurns)
        ? ((session.pendingCodexTurns.find((turn: CodexOutboundTurn) => turn.turnId === codexTurnId) ??
            null) as CodexOutboundTurn | null)
        : ((session.pendingCodexTurns?.[0] ?? null) as CodexOutboundTurn | null);
    session.consecutiveAdapterFailures = 0;
    session.lastAdapterFailureAt = null;
    if (!deps.completeCodexTurnsForResult(session, outgoing.data, Date.now())) {
      deps.syncSlackThreadParent?.(session);
      return;
    }
    deps.clearCodexFreshTurnRequirement(session, "codex_turn_completed", {
      completedTurnId: typeof outgoing.data.codex_turn_id === "string" ? outgoing.data.codex_turn_id : null,
    });
    deps.handleResultMessage(session, outgoing.data as CLIResultMessage);
    deps.syncSlackThreadParent?.(session);
    const maybeAutoPause = deps.handleCodexResultErrorAutoPause(
      session,
      outgoing.data as CLIResultMessage,
      completedTurn,
    );
    if (maybeAutoPause instanceof Promise) {
      await maybeAutoPause;
    }
    if (!session.isGenerating) {
      deps.queueCodexPendingStartBatch(session, "codex_turn_completed");
    }
    deps.dispatchQueuedCodexTurns(session, "codex_turn_completed");
    deps.maybeFlushQueuedCodexMessages(session, "codex_turn_completed_non_user");
    return;
  }

  if (outgoing?.type === "permission_request") {
    const maybe = deps.handleCodexPermissionRequest(session, outgoing.request);
    if (maybe instanceof Promise) {
      await maybe;
    }
    outgoing = null;
  }

  if (await maybeRecycleCodexLeaderForContextWindowExhaustion(session, outgoing, deps)) {
    return;
  }

  if (outgoing) {
    deps.broadcastToBrowsers(session, outgoing);
    if (outgoing.type === "assistant") {
      updateActiveTurnRouteFromLeaderAssistant(session, activeRouteFromAssistant, deps);
    }
  }
}

export function flushQueuedMessagesToCodexAdapter(
  session: CodexBrowserMessageSessionLike,
  adapter: CodexBrowserMessageAdapterLike,
  reason: string,
  deps: Pick<CodexAdapterBrowserMessageDeps, "dispatchQueuedCodexTurns">,
): void {
  if (session.pendingMessages.length === 0) return;
  if (session.codexAdapter !== adapter) return;
  if (session.state.backend_state !== "connected") {
    console.log(
      `[ws-bridge] Deferring flush of ${session.pendingMessages.length} queued message(s) for session ${sessionTag(session.id)} until Codex session is connected (${reason})`,
    );
    return;
  }
  const queued = session.pendingMessages.splice(0);
  const stillQueued: string[] = [];
  const sendNow: BrowserOutgoingMessage[] = [];
  for (const raw of queued) {
    try {
      const msg = JSON.parse(raw) as BrowserOutgoingMessage;
      if (msg.type === "user_message") {
        console.warn(
          `[ws-bridge] Unexpected raw queued Codex user_message for session ${sessionTag(session.id)}; ` +
            "Codex user turns should only exist in pendingCodexTurns.",
        );
        stillQueued.push(raw);
        continue;
      }
      sendNow.push(msg);
    } catch {
      console.warn(`[ws-bridge] Failed to parse queued message for Codex: ${raw.substring(0, 100)}`);
      stillQueued.push(raw);
    }
  }
  session.pendingMessages = stillQueued;
  if (sendNow.length === 0) {
    if (stillQueued.length > 0) {
      console.log(
        `[ws-bridge] Deferring ${stillQueued.length} queued non-user message(s) for session ${sessionTag(session.id)} (${reason})`,
      );
    }
    deps.dispatchQueuedCodexTurns(session, `${reason}_after_pending_message_scan`);
    return;
  }
  console.log(
    `[ws-bridge] Flushing ${sendNow.length} queued message(s) to Codex adapter for session ${sessionTag(session.id)} (${reason})`,
  );
  for (const msg of sendNow) {
    try {
      adapter.sendBrowserMessage(msg);
    } catch {
      console.warn(`[ws-bridge] Failed to flush queued message for Codex session ${sessionTag(session.id)}`);
    }
  }
  deps.dispatchQueuedCodexTurns(session, `${reason}_after_non_user_flush`);
}
