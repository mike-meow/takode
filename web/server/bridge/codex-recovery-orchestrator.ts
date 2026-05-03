import { getDefaultModelForBackend } from "../../shared/backend-defaults.js";
import { formatReplyContentForPreview } from "../../shared/reply-context.js";
import type { CodexResumeSnapshot, CodexResumeTurnSnapshot } from "../codex-adapter.js";
import type {
  BrowserIncomingMessage,
  CLIResultMessage,
  ActiveTurnRoute,
  BrowserOutgoingMessage,
  CodexOutboundTurn,
  PendingCodexInput,
  SessionNotification,
  SessionState,
} from "../session-types.js";
import { sessionTag } from "../session-tag.js";
import type { UserDispatchTurnTarget } from "./generation-lifecycle.js";
import {
  buildNeedsInputReminderHistoryEntry,
  shouldCommitNeedsInputReminderHistoryEntry,
} from "./adapter-browser-routing-needs-input-reminder.js";
import { isRecoverableCodexInitError } from "../codex-adapter-utils.js";
import { isActualHumanUserInput, isActualHumanUserMessage } from "../user-message-classification.js";
import { LEADER_COMPACTION_RECOVERY_PROMPT } from "./compaction-recovery.js";
import {
  armCodexFreshTurnRequirement as armCodexFreshTurnRequirementState,
  clearCodexFreshTurnRequirement as clearCodexFreshTurnRequirementState,
  completeCodexTurnsForResult as completeCodexTurnsForResultState,
  dispatchQueuedCodexTurns as dispatchQueuedCodexTurnsState,
} from "./codex-turn-queue.js";
import { requestCodexAutoRecovery as requestCodexAutoRecoveryController } from "./session-registry-controller.js";
const CODEX_RETRY_SAFE_RESUME_ITEM_TYPES: ReadonlySet<string> = new Set(["reasoning", "contextCompaction"]);
const CODEX_INIT_RETRY_BASE_DELAY_MS = 1_000;
type InterruptSource = "user" | "leader" | "system";
type CodexRecoveryAdapterLike = any;
export interface CodexRecoveryOrchestratorSessionLike {
  id: string;
  backendType: "codex" | "claude" | "claude-sdk";
  state: Pick<SessionState, "backend_state" | "backend_type" | "cwd" | "model" | "is_compacting">;
  messageHistory: BrowserIncomingMessage[];
  notifications?: SessionNotification[];
  pendingMessages: string[];
  pendingCodexInputs: PendingCodexInput[];
  pendingCodexTurns: CodexOutboundTurn[];
  codexFreshTurnRequiredUntilTurnId: string | null;
  isGenerating: boolean;
  cliInitReceived: boolean;
  consecutiveAdapterFailures: number;
  lastAdapterFailureAt: number | null;
  queuedTurnStarts: number;
  queuedTurnReasons: string[];
  queuedTurnUserMessageIds: number[][];
  queuedTurnInterruptSources: Array<InterruptSource | null>;
  queuedTurnActiveRoutes?: Array<ActiveTurnRoute | null>;
  lastUserMessage?: string;
  codexAdapter: {
    getCurrentTurnId(): string | null;
    isConnected(): boolean;
    sendBrowserMessage(msg: BrowserOutgoingMessage): boolean;
    disconnect(): Promise<void>;
  } | null;
}
export interface CodexRecoveryOrchestratorDeps {
  codexAssistantReplayScanLimit: number;
  formatVsCodeSelectionPrompt: (selection: NonNullable<PendingCodexInput["vscodeSelection"]>) => string;
  broadcastPendingCodexInputs: (session: CodexRecoveryOrchestratorSessionLike) => void;
  broadcastToBrowsers: (session: CodexRecoveryOrchestratorSessionLike, msg: BrowserIncomingMessage) => void;
  persistSession: (session: CodexRecoveryOrchestratorSessionLike) => void;
  touchUserMessage: (sessionId: string, timestamp?: number) => void;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  injectCompactionRecovery: (session: CodexRecoveryOrchestratorSessionLike) => void;
  onUserMessage?: (
    sessionId: string,
    history: CodexRecoveryOrchestratorSessionLike["messageHistory"],
    cwd: string,
    wasGenerating: boolean,
  ) => void;
  enqueueCodexTurn: (session: CodexRecoveryOrchestratorSessionLike, turn: CodexOutboundTurn) => CodexOutboundTurn;
  getCodexHeadTurn: (session: CodexRecoveryOrchestratorSessionLike) => CodexOutboundTurn | null;
  getCodexTurnInRecovery: (session: CodexRecoveryOrchestratorSessionLike) => CodexOutboundTurn | null;
  completeCodexTurn: (session: CodexRecoveryOrchestratorSessionLike, turn: CodexOutboundTurn | null) => boolean;
  completeCodexTurnsForResult: (
    session: CodexRecoveryOrchestratorSessionLike,
    msg: CLIResultMessage,
    updatedAt?: number,
  ) => boolean;
  clearCodexFreshTurnRequirement: (
    session: CodexRecoveryOrchestratorSessionLike,
    reason: string,
    options?: { completedTurnId?: string | null },
  ) => void;
  dispatchQueuedCodexTurns: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  maybeFlushQueuedCodexMessages: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  pruneStalePendingCodexHerdInputs: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => boolean;
  synthesizeCodexToolResultsFromResumedTurn: (
    session: CodexRecoveryOrchestratorSessionLike,
    turn: CodexResumeTurnSnapshot,
    pending: CodexOutboundTurn,
  ) => number;
  trackUserMessageForTurn: (
    session: CodexRecoveryOrchestratorSessionLike,
    historyIndex: number,
    target: UserDispatchTurnTarget,
  ) => void;
  markRunningFromUserDispatch: (
    session: CodexRecoveryOrchestratorSessionLike,
    reason: string,
    queuedInterruptSource?: InterruptSource | null,
  ) => UserDispatchTurnTarget;
  promoteNextQueuedTurn: (session: CodexRecoveryOrchestratorSessionLike) => boolean;
}

export interface CodexAdapterRecoveryLifecycleDeps extends CodexRecoveryOrchestratorDeps {
  clearCodexDisconnectGraceTimer: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  setCliSessionIdFromMeta: (sessionId: string, cliSessionId: string) => void;
  completeCodexLeaderRecycle: (sessionId: string) => void;
  hydrateCodexResumedHistory: (session: CodexRecoveryOrchestratorSessionLike, snapshot: unknown) => number;
  setBackendState: (session: CodexRecoveryOrchestratorSessionLike, state: string, error: string | null) => void;
  refreshGitInfoThenRecomputeDiff: (
    session: CodexRecoveryOrchestratorSessionLike,
    options: { notifyPoller?: boolean; broadcastUpdate?: boolean },
  ) => void;
  finalizeCodexRollback: (session: CodexRecoveryOrchestratorSessionLike) => void;
  flushQueuedMessagesToCodexAdapter: (
    session: CodexRecoveryOrchestratorSessionLike,
    adapter: CodexRecoveryAdapterLike,
    reason: string,
  ) => void;
  getCancelablePendingCodexInputs: (session: CodexRecoveryOrchestratorSessionLike) => PendingCodexInput[];
  getCodexTurnAwaitingAck: (session: CodexRecoveryOrchestratorSessionLike) => CodexOutboundTurn | null;
  getPendingCodexInputsByIds: (
    session: CodexRecoveryOrchestratorSessionLike,
    inputIds: string[],
  ) => PendingCodexInput[];
  queueCodexPendingStartBatch: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  recordSteeredCodexTurn: (
    session: CodexRecoveryOrchestratorSessionLike,
    turnId: string,
    steeredInputs: PendingCodexInput[],
    committedHistoryIndexes: number[],
  ) => void;
  setPendingCodexInputsCancelable: (
    session: CodexRecoveryOrchestratorSessionLike,
    inputIds: string[],
    cancelable: boolean,
  ) => void;
  rebuildQueuedCodexPendingStartBatch: (session: CodexRecoveryOrchestratorSessionLike) => void;
  setAttentionError: (session: CodexRecoveryOrchestratorSessionLike) => void;
  setGenerating: (session: CodexRecoveryOrchestratorSessionLike, generating: boolean, reason: string) => void;
  scheduleCodexToolResultWatchdogs: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  requestCodexAutoRecovery: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => boolean;
  emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void;
  isCurrentSession: (sessionId: string, session: CodexRecoveryOrchestratorSessionLike) => boolean;
  getLauncherSessionInfo: (sessionId: string) => any;
  logCodexProcessSnapshot: (sessionId: string, reason: string) => void;
  markTurnInterrupted: (session: CodexRecoveryOrchestratorSessionLike, source: "user" | "leader" | "system") => void;
  codexDisconnectGraceMs: number;
  adapterFailureResetWindowMs: number;
  maxAdapterRelaunchFailures: number;
  hasCliRelaunchCallback: boolean;
  injectUserMessage: (
    sessionId: string,
    content: string,
    agentSource?: { sessionId: string; sessionLabel?: string },
  ) => void;
}

export interface CodexAttachLifecycleDeps {
  clearCodexDisconnectGraceTimer: (session: CodexRecoveryOrchestratorSessionLike, reason: string) => void;
  setBackendState: (session: CodexRecoveryOrchestratorSessionLike, state: string, error: string | null) => void;
  persistSession: (session: CodexRecoveryOrchestratorSessionLike) => void;
  getLauncherSessionInfo: (sessionId: string) => any;
  onOrchestratorTurnEnd?: (sessionId: string) => void;
  handleCodexAdapterBrowserMessage: (session: CodexRecoveryOrchestratorSessionLike, msg: unknown) => Promise<void>;
  registerRecoveryLifecycle: (
    sessionId: string,
    session: CodexRecoveryOrchestratorSessionLike,
    adapter: CodexRecoveryAdapterLike,
  ) => void;
}

export function requestCodexAutoRecovery(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: {
    requestCliRelaunch?: (sessionId: string) => void;
    persistSession: (session: CodexRecoveryOrchestratorSessionLike) => void;
    emitTakodeEvent?: (sessionId: string, type: string, data: Record<string, unknown>) => void;
    attached?: (session: CodexRecoveryOrchestratorSessionLike) => boolean;
    getLauncherSessionInfo?: (sessionId: string) => any;
    broadcastSessionUpdate?: (session: CodexRecoveryOrchestratorSessionLike, update: Record<string, unknown>) => void;
    recoveryTimeoutMs?: number;
  },
): boolean {
  return requestCodexAutoRecoveryController(session, reason, deps);
}

export function attachCodexAdapterLifecycle(
  sessionId: string,
  session: CodexRecoveryOrchestratorSessionLike,
  adapter: CodexRecoveryAdapterLike,
  deps: CodexAttachLifecycleDeps,
): void {
  session.backendType = "codex" as any;
  session.state.backend_type = "codex" as any;
  deps.clearCodexDisconnectGraceTimer(session, "adapter_attach");
  if (session.codexAdapter && session.codexAdapter !== adapter) {
    session.codexAdapter.disconnect().catch(() => {});
  }
  session.codexAdapter = adapter;
  const launcherInfo = deps.getLauncherSessionInfo(session.id);
  const backendState =
    launcherInfo?.cliSessionId || session.pendingCodexTurns.length > 0 || (session as any).pendingMessages.length > 0
      ? "resuming"
      : "initializing";
  deps.setBackendState(session, backendState, null);
  deps.persistSession(session);

  session.cliInitReceived = true as any;
  if (launcherInfo?.isOrchestrator) {
    deps.onOrchestratorTurnEnd?.(session.id);
  }

  adapter.onBrowserMessage(async (msg: unknown) => {
    if (session.codexAdapter !== adapter) return;
    await deps.handleCodexAdapterBrowserMessage(session, msg);
  });

  deps.registerRecoveryLifecycle(sessionId, session, adapter);
  console.log(`[ws-bridge] Codex adapter attached for session ${sessionTag(sessionId)}`);
}

export function addPendingCodexInput(
  session: CodexRecoveryOrchestratorSessionLike,
  input: PendingCodexInput,
  deps: Pick<CodexRecoveryOrchestratorDeps, "touchUserMessage" | "broadcastPendingCodexInputs">,
): void {
  session.pendingCodexInputs.push(input);
  session.lastUserMessage = formatReplyContentForPreview(input.content || "", input.replyContext).slice(0, 80);
  if (isActualHumanUserInput(input)) {
    deps.touchUserMessage(session.id, input.timestamp);
  }
  deps.broadcastPendingCodexInputs(session);
}

export function hydrateCodexResumedHistory(
  session: CodexRecoveryOrchestratorSessionLike,
  snapshot: CodexResumeSnapshot,
  deps: Pick<CodexRecoveryOrchestratorDeps, "broadcastToBrowsers" | "persistSession">,
): number {
  if (session.messageHistory.length > 0 || session.pendingCodexTurns.length > 0) return 0;
  if (!Array.isArray(snapshot.turns) || snapshot.turns.length === 0) return 0;

  const totalEntries = snapshot.turns.reduce((count, turn) => {
    let turnCount = 0;
    for (const item of turn.items) {
      if (item.type === "userMessage" || item.type === "agentMessage") turnCount += 1;
    }
    return count + turnCount;
  }, 0);
  if (totalEntries === 0) return 0;

  let hydrated = 0;
  let syntheticTimestamp = Math.max(1, Date.now() - totalEntries - 1);
  for (const turn of snapshot.turns) {
    for (let i = 0; i < turn.items.length; i++) {
      const item = turn.items[i];
      if (item.type === "userMessage") {
        const text = extractUserTextFromResumedTurn({ ...turn, items: [item] });
        if (!text.trim()) continue;
        const userMessage: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
          type: "user_message",
          content: text,
          timestamp: ++syntheticTimestamp,
          id: `codex-resume-user-${turn.id || "turn"}-${i}`,
        };
        session.messageHistory.push(userMessage);
        session.lastUserMessage = formatReplyContentForPreview(text).slice(0, 80);
        deps.broadcastToBrowsers(session, userMessage);
        hydrated += 1;
        continue;
      }

      if (item.type !== "agentMessage") continue;
      const text = typeof item.text === "string" ? item.text : "";
      if (!text.trim()) continue;
      const itemId = typeof item.id === "string" ? item.id : `${turn.id || "turn"}-${i}`;
      const assistantId = `codex-agent-${itemId}`;
      const alreadyExists = session.messageHistory.some(
        (msg) => msg.type === "assistant" && msg.message?.id === assistantId,
      );
      if (alreadyExists) continue;

      const assistant: Extract<BrowserIncomingMessage, { type: "assistant" }> = {
        type: "assistant",
        message: {
          id: assistantId,
          type: "message",
          role: "assistant",
          model: session.state.model || getDefaultModelForBackend("codex"),
          content: [{ type: "text", text }],
          stop_reason: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        parent_tool_use_id: null,
        timestamp: ++syntheticTimestamp,
      };
      session.messageHistory.push(assistant);
      deps.broadcastToBrowsers(session, assistant);
      hydrated += 1;
    }
  }

  if (hydrated > 0) {
    console.log(
      `[ws-bridge] Hydrated ${hydrated} resumed Codex history message(s) for session ${sessionTag(session.id)} from thread ${snapshot.threadId}`,
    );
    deps.persistSession(session);
  }
  return hydrated;
}

export function completeCodexTurnsForResult(
  session: CodexRecoveryOrchestratorSessionLike,
  msg: CLIResultMessage,
  deps: Pick<CodexRecoveryOrchestratorDeps, "getCodexHeadTurn">,
  updatedAt = Date.now(),
): boolean {
  const outcome = completeCodexTurnsForResultState(session, msg, updatedAt);
  if (outcome.codexTurnId) {
    if (outcome.matched) {
      reconcileRecoveredQueuedTurnLifecycle(session, "codex_result_turn_id_completed", deps);
      return true;
    }
    console.warn(
      `[ws-bridge] Ignoring Codex result for untracked turn ${outcome.codexTurnId} in session ${sessionTag(session.id)}`,
    );
    return false;
  }
  return outcome.matched;
}

export function armCodexFreshTurnRequirement(
  session: CodexRecoveryOrchestratorSessionLike,
  turnId: string,
  reason: string,
  deps: Pick<CodexRecoveryOrchestratorDeps, "persistSession">,
): void {
  if (!armCodexFreshTurnRequirementState(session, turnId)) return;
  console.log(
    `[ws-bridge] Blocking Codex steering until turn ${turnId} ends for session ${sessionTag(session.id)} (${reason})`,
  );
  deps.persistSession(session);
}

export function clearCodexFreshTurnRequirement(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: Pick<CodexRecoveryOrchestratorDeps, "persistSession">,
  options?: { completedTurnId?: string | null },
): void {
  const { cleared, blockedTurnId } = clearCodexFreshTurnRequirementState(session, options);
  if (!cleared || !blockedTurnId) return;
  console.log(
    `[ws-bridge] Codex fresh-turn requirement cleared for session ${sessionTag(session.id)} (${reason}${options?.completedTurnId ? `: ${options.completedTurnId}` : ""})`,
  );
  deps.persistSession(session);
}

export function markCodexIntentionalRelaunch(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  guardMs: number,
): void {
  (session as any).intentionalCodexRelaunchUntil = Date.now() + guardMs;
  (session as any).intentionalCodexRelaunchReason = reason;
}

export function markSessionRelaunchPending(session: CodexRecoveryOrchestratorSessionLike): void {
  (session as any).relaunchPending = true;
}

export function dispatchQueuedCodexTurns(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: Pick<
    CodexAdapterRecoveryLifecycleDeps,
    "pruneStalePendingCodexHerdInputs" | "setPendingCodexInputsCancelable" | "persistSession"
  >,
): void {
  const outcome = dispatchQueuedCodexTurnsState(session, reason, {
    pruneStalePendingCodexHerdInputs: (dispatchReason) =>
      deps.pruneStalePendingCodexHerdInputs(session, dispatchReason),
    setPendingCodexInputsCancelable: (ids) => deps.setPendingCodexInputsCancelable(session, ids, false),
    persistSession: () => deps.persistSession(session),
  });
  if (outcome.status !== "dispatched" || !outcome.head) return;
  console.log(
    `[ws-bridge] Dispatched queued Codex turn for session ${sessionTag(session.id)} (${reason}, attempt ${outcome.head.dispatchCount})`,
  );
}

export function maybeFlushQueuedCodexMessages(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: Pick<CodexAdapterRecoveryLifecycleDeps, "flushQueuedMessagesToCodexAdapter">,
): void {
  const adapter = session.codexAdapter;
  if (!adapter) return;
  deps.flushQueuedMessagesToCodexAdapter(session, adapter, reason);
}

export function setPendingCodexInputCancelable(
  session: CodexRecoveryOrchestratorSessionLike,
  id: string,
  cancelable: boolean,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  const pending = session.pendingCodexInputs.find((item) => item.id === id);
  if (!pending || pending.cancelable === cancelable) return;
  pending.cancelable = cancelable;
  deps.broadcastPendingCodexInputs(session);
  deps.persistSession(session);
}
export function setPendingCodexInputsCancelable(
  session: CodexRecoveryOrchestratorSessionLike,
  ids: string[],
  cancelable: boolean,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  let changed = false;
  const idSet = new Set(ids);
  for (const pending of session.pendingCodexInputs) {
    if (!idSet.has(pending.id) || pending.cancelable === cancelable) continue;
    pending.cancelable = cancelable;
    changed = true;
  }
  if (!changed) return;
  deps.broadcastPendingCodexInputs(session);
  deps.persistSession(session);
}
export function getCancelablePendingCodexInputs(
  session: Pick<CodexRecoveryOrchestratorSessionLike, "pendingCodexInputs">,
): PendingCodexInput[] {
  return session.pendingCodexInputs.filter((item) => item.cancelable);
}
export function commitPendingCodexInputs(
  session: CodexRecoveryOrchestratorSessionLike,
  ids: string[],
  deps: CodexRecoveryOrchestratorDeps,
): number[] {
  const indexes: number[] = [];
  for (const id of ids) {
    const idx = commitPendingCodexInput(session, id, deps);
    if (typeof idx === "number" && idx >= 0) indexes.push(idx);
  }
  return indexes;
}
export function getPendingCodexInputsByIds(
  session: Pick<CodexRecoveryOrchestratorSessionLike, "pendingCodexInputs">,
  ids: string[],
): PendingCodexInput[] {
  const idSet = new Set(ids);
  return session.pendingCodexInputs.filter((input) => idSet.has(input.id));
}
export function recordSteeredCodexTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  turnId: string,
  inputs: PendingCodexInput[],
  committedHistoryIndexes: number[],
  deps: CodexRecoveryOrchestratorDeps,
): void {
  if (inputs.length === 0) return;
  const now = Date.now();
  const pendingInputIds = inputs.map((input) => input.id);
  deps.enqueueCodexTurn(session, {
    adapterMsg: {
      type: "codex_start_pending",
      pendingInputIds,
      inputs: buildCodexBatchMessageInputs(inputs),
    },
    userMessageId: pendingInputIds[0]!,
    pendingInputIds,
    userContent: buildCodexPendingBatchRecoveryText(inputs, deps),
    historyIndex: committedHistoryIndexes[0] ?? -1,
    status: "backend_acknowledged",
    dispatchCount: 1,
    createdAt: now,
    updatedAt: now,
    acknowledgedAt: now,
    turnTarget: "queued",
    lastError: null,
    turnId,
    disconnectedAt: null,
    resumeConfirmedAt: null,
  });
  for (const idx of committedHistoryIndexes) {
    deps.trackUserMessageForTurn(session, idx, "queued");
  }
}
export function buildCodexBatchMessageInputs(
  inputs: PendingCodexInput[],
): import("../session-types.js").CodexPendingBatchInput[] {
  return inputs.map((input) => ({
    content: input.deliveryContent || input.content,
    ...(input.vscodeSelection ? { vscodeSelection: input.vscodeSelection } : {}),
  }));
}
export function buildCodexPendingBatchRecoveryText(
  inputs: PendingCodexInput[],
  deps: Pick<CodexRecoveryOrchestratorDeps, "formatVsCodeSelectionPrompt">,
): string {
  return inputs
    .map((input) => {
      const parts = [input.deliveryContent || input.content];
      if (input.vscodeSelection) {
        parts.push(deps.formatVsCodeSelectionPrompt(input.vscodeSelection));
      }
      return parts.filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}
function findQueuedCodexPendingStartBatchTurn(session: CodexRecoveryOrchestratorSessionLike): CodexOutboundTurn | null {
  return (
    session.pendingCodexTurns.find(
      (turn) => turn.status === "queued" && turn.turnId == null && turn.adapterMsg.type === "codex_start_pending",
    ) ?? null
  );
}
function getQueuedCodexPendingBatchInputs(
  session: CodexRecoveryOrchestratorSessionLike,
  deps: Pick<CodexRecoveryOrchestratorDeps, "getCodexHeadTurn">,
): PendingCodexInput[] {
  const head = deps.getCodexHeadTurn(session);
  const coveredIds = new Set<string>();
  if (head && !(head.status === "queued" && head.turnId == null && head.adapterMsg.type === "codex_start_pending")) {
    for (const id of head.pendingInputIds ?? [head.userMessageId]) {
      coveredIds.add(id);
    }
  }
  return getCancelablePendingCodexInputs(session).filter((input) => !coveredIds.has(input.id));
}
export function rebuildQueuedCodexPendingStartBatch(
  session: CodexRecoveryOrchestratorSessionLike,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  const head = deps.getCodexHeadTurn(session);
  const headBlocksQueuedFollowUps = !!head && head.status === "blocked_broken_session";
  const deliverable = getQueuedCodexPendingBatchInputs(session, deps);
  const existingQueuedTurn = findQueuedCodexPendingStartBatchTurn(session);
  if (headBlocksQueuedFollowUps || deliverable.length === 0) {
    if (!existingQueuedTurn) return;
    const idx = session.pendingCodexTurns.indexOf(existingQueuedTurn);
    if (idx >= 0) {
      session.pendingCodexTurns.splice(idx, 1);
    }
    deps.persistSession(session);
    return;
  }
  if (existingQueuedTurn) {
    existingQueuedTurn.adapterMsg = {
      type: "codex_start_pending",
      pendingInputIds: deliverable.map((input) => input.id),
      inputs: buildCodexBatchMessageInputs(deliverable),
    };
    existingQueuedTurn.userMessageId = deliverable[0].id;
    existingQueuedTurn.pendingInputIds = deliverable.map((input) => input.id);
    existingQueuedTurn.userContent = buildCodexPendingBatchRecoveryText(deliverable, deps);
    existingQueuedTurn.updatedAt = Date.now();
    existingQueuedTurn.lastError = null;
    deps.persistSession(session);
    return;
  }
  const now = Date.now();
  session.pendingCodexTurns.push({
    adapterMsg: {
      type: "codex_start_pending",
      pendingInputIds: deliverable.map((input) => input.id),
      inputs: buildCodexBatchMessageInputs(deliverable),
    },
    userMessageId: deliverable[0].id,
    pendingInputIds: deliverable.map((input) => input.id),
    userContent: buildCodexPendingBatchRecoveryText(deliverable, deps),
    historyIndex: -1,
    status: session.state.backend_state === "broken" ? "blocked_broken_session" : "queued",
    dispatchCount: 0,
    createdAt: now,
    updatedAt: now,
    acknowledgedAt: null,
    turnTarget: null,
    lastError:
      session.state.backend_state === "broken" ? "Codex session needs relaunch before queued messages can run." : null,
    turnId: null,
    disconnectedAt: null,
    resumeConfirmedAt: null,
  });
  deps.persistSession(session);
}
export function queueCodexPendingStartBatch(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  retryNonDrainableCodexHeadTurn(session, `${reason}_stale_ack_head`, deps);
  clearStaleCodexCompactionState(session, `${reason}_stale_compaction`, deps);
  rebuildQueuedCodexPendingStartBatch(session, deps);
  deps.dispatchQueuedCodexTurns(session, reason);
}

export function pokeStaleCodexPendingDelivery(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
  options: { triggeringInputId?: string } = {},
): boolean {
  const adapter = session.codexAdapter;
  if (session.backendType !== "codex") return false;
  if (session.pendingCodexInputs.length === 0) return false;
  if (session.isGenerating) return false;
  if (!adapter || session.state.backend_state !== "connected" || !adapter.isConnected()) return false;
  if (adapter.getCurrentTurnId()) return false;

  const head = deps.getCodexHeadTurn(session);
  if (!isStaleCodexPendingDeliveryHead(head, options.triggeringInputId)) return false;

  const beforeDispatchCount = head.dispatchCount;
  const beforeStatus = head.status;
  queueCodexPendingStartBatch(session, reason, deps);

  const currentHead = deps.getCodexHeadTurn(session);
  const dispatchedStaleHead =
    currentHead === head &&
    head.status === "dispatched" &&
    (beforeStatus !== "dispatched" || head.dispatchCount > beforeDispatchCount);
  if (dispatchedStaleHead && !session.isGenerating) {
    deps.markRunningFromUserDispatch(session, `${reason}_stale_head_dispatched`, null);
  }

  console.warn(
    `[ws-bridge] Poked stale Codex pending delivery for session ${sessionTag(session.id)} ` +
      `(${reason}, head_status=${beforeStatus}, dispatched=${dispatchedStaleHead})`,
  );
  return true;
}

function isStaleCodexPendingDeliveryHead(
  head: CodexOutboundTurn | null,
  triggeringInputId: string | undefined,
): head is CodexOutboundTurn {
  if (!head) return false;
  if (head.adapterMsg.type !== "codex_start_pending") return false;
  const headInputIds = head.pendingInputIds ?? [head.userMessageId];
  if (triggeringInputId && headInputIds.includes(triggeringInputId)) return false;
  return head.status === "queued" || head.status === "backend_acknowledged";
}
export function trySteerPendingCodexInputs(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  const adapter = session.codexAdapter;
  const expectedTurnId = adapter?.getCurrentTurnId() ?? null;
  if (!adapter || !expectedTurnId || session.state.backend_state !== "connected" || !adapter.isConnected()) {
    if (!expectedTurnId) {
      deps.clearCodexFreshTurnRequirement(session, `${reason}_no_active_turn`);
    }
    return false;
  }
  if (session.codexFreshTurnRequiredUntilTurnId === expectedTurnId) {
    console.log(
      `[ws-bridge] Skipping Codex steer for session ${sessionTag(session.id)} while turn ${expectedTurnId} still owes a fresh turn (${reason})`,
    );
    return false;
  }
  if (session.codexFreshTurnRequiredUntilTurnId) {
    deps.clearCodexFreshTurnRequirement(session, `${reason}_active_turn_changed`);
  }
  deps.pruneStalePendingCodexHerdInputs(session, `${reason}_before_steer`);
  const deliverable = getCancelablePendingCodexInputs(session);
  if (deliverable.length === 0) return false;
  const ids = deliverable.map((input) => input.id);
  setPendingCodexInputsCancelable(session, ids, false, deps);
  const accepted = adapter.sendBrowserMessage({
    type: "codex_steer_pending",
    pendingInputIds: ids,
    expectedTurnId,
    inputs: buildCodexBatchMessageInputs(deliverable),
  });
  if (!accepted) {
    setPendingCodexInputsCancelable(session, ids, true, deps);
    return false;
  }
  console.log(
    `[ws-bridge] Steered ${ids.length} pending Codex input(s) for session ${sessionTag(session.id)} (${reason})`,
  );
  return true;
}

function clearCodexInitRecoveryState(session: CodexRecoveryOrchestratorSessionLike): void {
  const retryTimer = (session as any).codexInitRetryTimer as ReturnType<typeof setTimeout> | null | undefined;
  if (retryTimer) clearTimeout(retryTimer);
  (session as any).codexInitRetryTimer = null;
  (session as any).codexInitRecoveryFailures = 0;
  (session as any).codexAutoRecoveryReason = null;
}

export function handleCodexAdapterInitError(
  sessionId: string,
  session: CodexRecoveryOrchestratorSessionLike,
  adapter: CodexRecoveryAdapterLike,
  error: string,
  deps: CodexAdapterRecoveryLifecycleDeps,
): "ignored" | "retrying" | "broken" {
  if (session.codexAdapter !== adapter) return "ignored";
  deps.clearCodexDisconnectGraceTimer(session, "init_error");
  console.error(`[ws-bridge] Codex adapter init failed for session ${sessionTag(sessionId)}: ${error}`);
  session.codexAdapter = null;
  const pending = deps.getCodexTurnInRecovery(session);
  const autoRecoveryReason = (session as any).codexAutoRecoveryReason as string | null | undefined;
  const launcherInfo = deps.getLauncherSessionInfo(sessionId);
  const canRetryTransientInit =
    !!autoRecoveryReason &&
    !!launcherInfo?.cliSessionId &&
    isRecoverableCodexInitError(error) &&
    deps.hasCliRelaunchCallback;

  if (canRetryTransientInit) {
    const now = Date.now();
    if (
      session.lastAdapterFailureAt !== null &&
      now - session.lastAdapterFailureAt > deps.adapterFailureResetWindowMs
    ) {
      (session as any).codexInitRecoveryFailures = 0;
    }
    const failures = ((session as any).codexInitRecoveryFailures ?? 0) + 1;
    (session as any).codexInitRecoveryFailures = failures;
    session.lastAdapterFailureAt = now;
    session.consecutiveAdapterFailures = failures;
    if (failures <= deps.maxAdapterRelaunchFailures) {
      if (pending) {
        pending.status = "queued";
        pending.turnId = null;
        pending.acknowledgedAt = null;
        pending.lastError = error;
        pending.updatedAt = now;
        deps.setPendingCodexInputsCancelable(session, pending.pendingInputIds ?? [pending.userMessageId], true);
      }
      deps.rebuildQueuedCodexPendingStartBatch(session);
      deps.setBackendState(session, "recovering", null);
      deps.broadcastToBrowsers(session, { type: "backend_disconnected" });
      const delayMs = Math.min(CODEX_INIT_RETRY_BASE_DELAY_MS * failures, 10_000);
      (session as any).codexInitRetryTimer = setTimeout(() => {
        (session as any).codexInitRetryTimer = null;
        if (session.codexAdapter) return;
        deps.requestCodexAutoRecovery(session, `init_error:${autoRecoveryReason}`);
      }, delayMs);
      deps.persistSession(session);
      return "retrying";
    }
  }

  clearCodexInitRecoveryState(session);
  if ((session as any).pendingCodexRollback) {
    (session as any).pendingCodexRollbackError = error;
    (session as any).pendingCodexRollbackWaiter?.reject(new Error(error));
    (session as any).pendingCodexRollbackWaiter = null;
  }
  if (pending) {
    pending.status = "blocked_broken_session";
    pending.lastError = error;
    pending.updatedAt = Date.now();
    deps.setPendingCodexInputsCancelable(session, pending.pendingInputIds ?? [pending.userMessageId], true);
  }
  deps.setBackendState(session, "broken", error);
  deps.setAttentionError(session);
  deps.setGenerating(session, false, "codex_init_error");
  deps.broadcastToBrowsers(session, { type: "backend_disconnected", reason: "broken" });
  deps.broadcastToBrowsers(session, { type: "error", message: error });
  deps.broadcastToBrowsers(session, { type: "status_change", status: null });
  deps.persistSession(session);
  return "broken";
}

export function registerCodexAdapterRecoveryLifecycle(
  sessionId: string,
  session: CodexRecoveryOrchestratorSessionLike,
  adapter: CodexRecoveryAdapterLike,
  deps: CodexAdapterRecoveryLifecycleDeps,
): void {
  adapter.onSessionMeta((meta: any) => {
    if (session.codexAdapter !== adapter) return;
    deps.clearCodexDisconnectGraceTimer(session, "session_meta");
    if (meta.cliSessionId) {
      deps.setCliSessionIdFromMeta(session.id, meta.cliSessionId);
    }
    const recyclePending = deps.getLauncherSessionInfo(session.id)?.codexLeaderRecyclePending;
    const pendingRollback = (session as any).pendingCodexRollback;
    if (meta.resumeSnapshot && !pendingRollback) {
      deps.hydrateCodexResumedHistory(session, meta.resumeSnapshot);
      reconcileCodexResumedTurn(session, meta.resumeSnapshot, deps);
    }
    deps.setBackendState(session, "connected", null);
    clearCodexInitRecoveryState(session);
    retryNonDrainableCodexHeadTurn(session, "session_meta_stale_ack_head", deps);
    clearStaleCodexCompactionState(session, "session_meta_stale_compaction", deps);
    if (meta.model) {
      session.state.model = meta.model;
      deps.broadcastToBrowsers(session, {
        type: "session_update",
        session: { model: meta.model },
      });
    }
    if (meta.cwd) session.state.cwd = meta.cwd;
    (session.state as any).backend_type = "codex";
    if (recyclePending) {
      deps.injectUserMessage(session.id, LEADER_COMPACTION_RECOVERY_PROMPT, {
        sessionId: "system",
        sessionLabel: "System",
      });
      deps.completeCodexLeaderRecycle(session.id);
    }
    if (pendingRollback) {
      (session as any).pendingCodexRollbackError = null;
      void adapter
        .rollbackTurns(pendingRollback.numTurns)
        .then(() => {
          if (session.codexAdapter !== adapter) return;
          deps.finalizeCodexRollback(session);
        })
        .catch((err: unknown) => {
          if (session.codexAdapter !== adapter) return;
          const message = err instanceof Error ? err.message : String(err);
          (session as any).pendingCodexRollback = null;
          (session as any).pendingCodexRollbackError = message;
          (session as any).pendingCodexRollbackWaiter?.reject(new Error(message));
          (session as any).pendingCodexRollbackWaiter = null;
          console.error(`[ws-bridge] Pending Codex rollback failed for session ${sessionTag(session.id)}: ${message}`);
          deps.persistSession(session);
        });
      deps.broadcastToBrowsers(session, { type: "backend_connected" });
      deps.refreshGitInfoThenRecomputeDiff(session, { broadcastUpdate: true, notifyPoller: true });
      deps.persistSession(session);
      return;
    }
    const steeredPending = trySteerPendingCodexInputs(session, "session_meta", deps);
    if (!steeredPending) {
      const headWasBlockedRecovery = deps.getCodexHeadTurn(session)?.status === "blocked_broken_session";
      deps.dispatchQueuedCodexTurns(session, "session_meta");
      reconcileRecoveredQueuedTurnLifecycle(session, "session_meta_dispatch", deps);
      const currentTurnId = adapter.getCurrentTurnId?.() ?? null;
      const hasPendingLocalInputs = deps.getCancelablePendingCodexInputs(session).length > 0;
      if (!headWasBlockedRecovery && (!session.isGenerating || (!currentTurnId && hasPendingLocalInputs))) {
        deps.queueCodexPendingStartBatch(session, "session_meta");
        reconcileRecoveredQueuedTurnLifecycle(session, "session_meta_pending_batch", deps);
      }
    }
    deps.flushQueuedMessagesToCodexAdapter(session, adapter, "session_meta");
    deps.broadcastToBrowsers(session, { type: "backend_connected" });
    deps.refreshGitInfoThenRecomputeDiff(session, { broadcastUpdate: true, notifyPoller: true });
    deps.persistSession(session);
  });

  adapter.onTurnStarted((turnId: string) => {
    if (session.codexAdapter !== adapter) return;
    const pending = deps.getCodexTurnAwaitingAck(session);
    if (!pending) return;
    const committedHistoryIndexes = commitPendingCodexInputs(
      session,
      pending.pendingInputIds ?? [pending.userMessageId],
      deps,
    );
    if (committedHistoryIndexes.length > 0) {
      pending.historyIndex = committedHistoryIndexes[0];
    }
    const trackedHistoryIndexes =
      committedHistoryIndexes.length > 0
        ? committedHistoryIndexes
        : pending.historyIndex >= 0
          ? [pending.historyIndex]
          : [];
    pending.turnId = turnId;
    pending.status = "backend_acknowledged";
    pending.acknowledgedAt = Date.now();
    pending.updatedAt = pending.acknowledgedAt;
    if (pending.turnTarget === "queued" && !session.isGenerating) {
      rearmRecoveredQueuedHeadTurn(session, pending, "codex_turn_started_recovered", deps);
    }
    if (pending.turnTarget === null) {
      const target = session.isGenerating ? "current" : deps.markRunningFromUserDispatch(session, "codex_turn_started");
      pending.turnTarget = target;
      for (const idx of trackedHistoryIndexes) {
        deps.trackUserMessageForTurn(session, idx, target);
      }
    } else if (trackedHistoryIndexes.length > 0) {
      for (const idx of trackedHistoryIndexes) {
        deps.trackUserMessageForTurn(session, idx, pending.turnTarget);
      }
    }
    deps.persistSession(session);
    trySteerPendingCodexInputs(session, "codex_turn_started", deps);
  });

  adapter.onTurnSteered((turnId: string, pendingInputIds: string[]) => {
    if (session.codexAdapter !== adapter) return;
    const steeredInputs = deps.getPendingCodexInputsByIds(session, pendingInputIds);
    const committedHistoryIndexes = commitPendingCodexInputs(session, pendingInputIds, deps);
    deps.recordSteeredCodexTurn(session, turnId, steeredInputs, committedHistoryIndexes);
    deps.persistSession(session);
    trySteerPendingCodexInputs(session, "codex_turn_steered", deps);
  });

  adapter.onTurnSteerFailed((pendingInputIds: string[]) => {
    if (session.codexAdapter !== adapter) return;
    deps.setPendingCodexInputsCancelable(session, pendingInputIds, true);
    deps.rebuildQueuedCodexPendingStartBatch(session);
    deps.dispatchQueuedCodexTurns(session, "codex_turn_steer_failed");
  });

  adapter.onInitError((error: string) => {
    handleCodexAdapterInitError(sessionId, session, adapter, error, deps);
  });

  adapter.onDisconnect(() => {
    if (session.codexAdapter !== adapter) return;
    const wasGenerating = session.isGenerating;
    const disconnectedTurnId = adapter.getCurrentTurnId ? adapter.getCurrentTurnId() : null;
    const pending = deps.getCodexTurnInRecovery(session);
    if (pending) {
      pending.turnId = disconnectedTurnId;
      pending.disconnectedAt = Date.now();
      pending.resumeConfirmedAt = null;
      pending.updatedAt = pending.disconnectedAt;
    }
    const now = Date.now();
    const intentionalRelaunch =
      (session as any).intentionalCodexRelaunchUntil !== null && now <= (session as any).intentionalCodexRelaunchUntil;
    const intentionalReason = intentionalRelaunch ? (session as any).intentionalCodexRelaunchReason || "unknown" : null;
    if ((session as any).intentionalCodexRelaunchUntil !== null) {
      (session as any).intentionalCodexRelaunchUntil = null;
      (session as any).intentionalCodexRelaunchReason = null;
    }
    for (const [reqId] of (session as any).pendingPermissions) {
      deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
    }
    (session as any).pendingPermissions.clear();
    (session as any).pendingQuestCommands.clear();
    session.codexAdapter = null;
    deps.setPendingCodexInputsCancelable(
      session,
      session.pendingCodexInputs.map((input: { id: string }) => input.id),
      true,
    );
    deps.rebuildQueuedCodexPendingStartBatch(session);
    deps.setBackendState(session, "disconnected", null);
    if (!intentionalRelaunch) {
      if (
        session.lastAdapterFailureAt !== null &&
        now - session.lastAdapterFailureAt > deps.adapterFailureResetWindowMs
      ) {
        session.consecutiveAdapterFailures = 0;
      }
      session.lastAdapterFailureAt = now;
      session.consecutiveAdapterFailures++;
    }
    const idleKilled = deps.getLauncherSessionInfo(sessionId)?.killedByIdleManager;
    const shouldDeferDisconnectInterruption = wasGenerating && pending !== null && !intentionalRelaunch && !idleKilled;
    if (shouldDeferDisconnectInterruption) {
      deps.clearCodexDisconnectGraceTimer(session, "codex_disconnect_rearm");
      (session as any).codexDisconnectGraceTimer = setTimeout(() => {
        (session as any).codexDisconnectGraceTimer = null;
        if (session.codexAdapter || !session.isGenerating) return;
        if (session.state.backend_state === "recovering") {
          console.log(
            `[ws-bridge] Codex disconnect grace expired for session ${sessionTag(session.id)} ` +
              `while recovery is still in flight; keeping the turn resumable`,
          );
          deps.persistSession(session);
          return;
        }
        deps.markTurnInterrupted(session, "system");
        deps.setGenerating(session, false, "codex_disconnect");
        deps.persistSession(session);
        console.log(
          `[ws-bridge] Codex disconnect grace expired for session ${sessionTag(session.id)} — emitting deferred system interruption`,
        );
      }, deps.codexDisconnectGraceMs);
      console.log(
        `[ws-bridge] Deferring Codex disconnect interruption for session ${sessionTag(session.id)} ` +
          `(${deps.codexDisconnectGraceMs}ms grace, recoverable pending turn)`,
      );
    } else {
      deps.markTurnInterrupted(session, "system");
      deps.setGenerating(session, false, "codex_disconnect");
    }
    deps.broadcastToBrowsers(session, { type: "status_change", status: null });
    deps.scheduleCodexToolResultWatchdogs(session, "codex_disconnect");
    deps.persistSession(session);
    console.log(
      `[ws-bridge] Codex adapter disconnected for session ${sessionTag(sessionId)}${idleKilled ? " (idle limit)" : ""}` +
        `${intentionalReason ? ` (intentional relaunch: ${intentionalReason})` : ""}` +
        ` (consecutive failures: ${session.consecutiveAdapterFailures})`,
    );
    deps.logCodexProcessSnapshot(sessionId, "adapter_disconnect");
    deps.broadcastToBrowsers(session, {
      type: "backend_disconnected",
      ...(idleKilled ? { reason: "idle_limit" } : {}),
    });
    if (wasGenerating && !idleKilled && !intentionalRelaunch) {
      deps.setAttentionError(session);
    }

    if (
      !intentionalRelaunch &&
      !idleKilled &&
      deps.isCurrentSession(sessionId, session) &&
      session.consecutiveAdapterFailures <= deps.maxAdapterRelaunchFailures
    ) {
      const browserQualifier = (session as any).browserSockets?.size > 0 ? "active browser" : "detached session";
      console.log(
        `[ws-bridge] Codex adapter disconnected for ${browserQualifier}; requesting relaunch for session ${sessionTag(sessionId)} (attempt ${session.consecutiveAdapterFailures}/${deps.maxAdapterRelaunchFailures})`,
      );
      deps.requestCodexAutoRecovery(session, "adapter_disconnect");
    } else if (!intentionalRelaunch && idleKilled) {
      deps.emitTakodeEvent(sessionId, "session_disconnected", {
        wasGenerating,
        reason: "idle_limit",
      });
    } else if (!intentionalRelaunch && session.consecutiveAdapterFailures > deps.maxAdapterRelaunchFailures) {
      console.error(
        `[ws-bridge] Codex adapter for session ${sessionTag(sessionId)} exceeded ${deps.maxAdapterRelaunchFailures} consecutive failures — stopping auto-relaunch`,
      );
      deps.emitTakodeEvent(sessionId, "session_disconnected", {
        wasGenerating,
        reason: "adapter_disconnect",
      });
      deps.broadcastToBrowsers(session, {
        type: "error",
        message: `Session stopped after ${deps.maxAdapterRelaunchFailures} consecutive launch failures. Use the relaunch button to try again.`,
      });
    } else if (!intentionalRelaunch && !deps.hasCliRelaunchCallback) {
      deps.emitTakodeEvent(sessionId, "session_disconnected", {
        wasGenerating,
        reason: "adapter_disconnect",
      });
    }
  });

  adapter.onTurnStartFailed((msg: any) => {
    console.log(`[ws-bridge] Turn start failed for session ${sessionTag(sessionId)}, re-queuing ${msg.type}`);
    if (msg.type === "user_message" || msg.type === "codex_start_pending") {
      const pending =
        deps.getCodexTurnAwaitingAck(session) ??
        session.pendingCodexTurns.find(
          (turn: any) =>
            turn.adapterMsg.type === msg.type &&
            JSON.stringify(turn.adapterMsg) === JSON.stringify(msg) &&
            turn.status !== "completed",
        );
      if (pending) {
        pending.status = "queued";
        pending.turnId = null;
        pending.updatedAt = Date.now();
        pending.lastError = "turn/start failed before acknowledgement";
        deps.setPendingCodexInputsCancelable(session, pending.pendingInputIds ?? [pending.userMessageId], true);
      }
      deps.dispatchQueuedCodexTurns(session, "turn_start_failed");
    } else {
      const raw = JSON.stringify(msg);
      const alreadyQueued = (session as any).pendingMessages.some((queued: string) => queued === raw);
      if (!alreadyQueued) {
        (session as any).pendingMessages.push(raw);
      }
    }

    const activeAdapter = session.codexAdapter;
    if (activeAdapter && activeAdapter !== adapter) {
      deps.dispatchQueuedCodexTurns(session, "stale_adapter_turn_start_failed");
      deps.flushQueuedMessagesToCodexAdapter(session, activeAdapter, "stale_adapter_turn_start_failed");
    }
  });
}
function commitPendingCodexInput(
  session: CodexRecoveryOrchestratorSessionLike,
  id: string,
  deps: CodexRecoveryOrchestratorDeps,
): number | null {
  const idx = session.pendingCodexInputs.findIndex((item) => item.id === id);
  if (idx < 0) return null;
  const pending = session.pendingCodexInputs[idx];
  session.pendingCodexInputs.splice(idx, 1);
  if (
    pending.needsInputReminderText &&
    shouldCommitNeedsInputReminderHistoryEntry(pending.needsInputReminderText, session.notifications)
  ) {
    const reminderHistoryEntry = buildNeedsInputReminderHistoryEntry(
      pending.needsInputReminderText,
      pending.timestamp,
      pending.id,
    );
    session.messageHistory.push(reminderHistoryEntry);
    deps.broadcastToBrowsers(session, reminderHistoryEntry);
  }
  const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
    type: "user_message",
    content: pending.content,
    timestamp: pending.timestamp,
    id: pending.id,
    ...(pending.imageRefs?.length ? { images: pending.imageRefs } : {}),
    ...(pending.replyContext ? { replyContext: pending.replyContext } : {}),
    ...(pending.clientMsgId ? { client_msg_id: pending.clientMsgId } : {}),
    ...(pending.vscodeSelection ? { vscodeSelection: pending.vscodeSelection } : {}),
    ...(pending.agentSource ? { agentSource: pending.agentSource } : {}),
    ...(pending.threadKey ? { threadKey: pending.threadKey } : {}),
    ...(pending.questId ? { questId: pending.questId } : {}),
    ...(pending.threadRefs ? { threadRefs: pending.threadRefs } : {}),
    ...(pending.takodeHerdBatch?.eventKeys?.length ? { takodeHerdEventKeys: pending.takodeHerdBatch.eventKeys } : {}),
  };
  session.messageHistory.push(userHistoryEntry);
  const userMsgHistoryIdx = session.messageHistory.length - 1;
  session.lastUserMessage = formatReplyContentForPreview(pending.content || "", pending.replyContext).slice(0, 80);
  if (isActualHumanUserMessage(userHistoryEntry)) {
    deps.touchUserMessage(session.id, pending.timestamp);
  }
  deps.broadcastToBrowsers(session, userHistoryEntry);
  deps.broadcastPendingCodexInputs(session);
  deps.onUserMessage?.(session.id, [...session.messageHistory], session.state.cwd, session.isGenerating);
  deps.persistSession(session);
  return userMsgHistoryIdx;
}
export function removePendingCodexInput(
  session: CodexRecoveryOrchestratorSessionLike,
  id: string,
  deps: Pick<CodexRecoveryOrchestratorDeps, "broadcastPendingCodexInputs" | "persistSession">,
): PendingCodexInput | null {
  const idx = session.pendingCodexInputs.findIndex((item) => item.id === id);
  if (idx < 0) return null;
  const [removed] = session.pendingCodexInputs.splice(idx, 1);
  deps.broadcastPendingCodexInputs(session);
  deps.persistSession(session);
  return removed;
}
export function reconcileCodexResumedTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  snapshot: CodexResumeSnapshot,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  const pending = deps.getCodexTurnInRecovery(session);
  const lastTurn = snapshot.lastTurn;
  if (!pending) return;
  if (!lastTurn) {
    if (pending.turnId) {
      console.log(
        `[ws-bridge] Resumed Codex snapshot for session ${sessionTag(session.id)} has no lastTurn while pending turn ${pending.turnId} is in flight; retrying message`,
      );
      retryPendingCodexTurn(session, pending, deps);
    }
    return;
  }
  const pendingText = normalizeResumedUserText(pending.userContent);
  const resumedUserText = normalizeResumedUserText(extractUserTextFromResumedTurn(lastTurn));
  const matchesTurnId = !!pending.turnId && pending.turnId === lastTurn.id;
  const matchesText = !!pendingText && pendingText === resumedUserText;
  if (!matchesTurnId && !matchesText) {
    if (
      !pending.turnId &&
      lastTurn.status === "inProgress" &&
      snapshot.threadStatus === "idle" &&
      lastTurn.items.length === 0
    ) {
      console.log(
        `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} ` +
          "lost local turn identity after turn/start; thread is idle and turn has no items, retrying user message",
      );
      retryPendingCodexTurn(session, pending, deps);
      return;
    }
    if (pending.turnId && pending.turnId !== lastTurn.id) {
      console.log(
        `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} does not match pending turn ${pending.turnId}; retrying message`,
      );
      retryPendingCodexTurn(session, pending, deps);
    }
    return;
  }
  const completedHistoryIndexes = commitPendingCodexInputs(
    session,
    pending.pendingInputIds ?? [pending.userMessageId],
    deps,
  );
  if (completedHistoryIndexes.length > 0 && pending.historyIndex < 0) {
    pending.historyIndex = completedHistoryIndexes[0];
  }
  const nonUserItems = lastTurn.items.filter((item) => item.type !== "userMessage");
  if (nonUserItems.length === 0) {
    console.log(
      `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} has only user input; retrying message`,
    );
    retryPendingCodexTurn(session, pending, deps);
    return;
  }
  if (lastTurn.status === "inProgress" && snapshot.threadStatus === "idle") {
    console.log(
      `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} reports inProgress but thread is idle; retrying user message`,
    );
    retryPendingCodexTurn(session, pending, deps);
    return;
  }
  const recoveredAgents = recoverAgentMessagesFromResumedTurn(session, lastTurn, pending, deps);
  const synthesizedResults = deps.synthesizeCodexToolResultsFromResumedTurn(session, lastTurn, pending);
  if (lastTurn.status === "inProgress") {
    if (recoveredAgents > 0 || synthesizedResults > 0) {
      session.consecutiveAdapterFailures = 0;
      session.lastAdapterFailureAt = null;
    }
    pending.status = "backend_acknowledged";
    pending.turnId = lastTurn.id;
    pending.resumeConfirmedAt = Date.now();
    pending.updatedAt = pending.resumeConfirmedAt;
    if (pending.turnTarget === "queued" && session.isGenerating) {
      pending.turnTarget = "current";
    }
    if (pending.turnTarget !== "queued" && !session.isGenerating) {
      const target = deps.markRunningFromUserDispatch(session, "codex_resume_in_progress");
      pending.turnTarget = target;
      if (pending.historyIndex >= 0) {
        deps.trackUserMessageForTurn(session, pending.historyIndex, target);
      }
    }
    rearmRecoveredQueuedHeadTurn(session, pending, "codex_resume_in_progress", deps);
    deps.persistSession(session);
    return;
  }
  if (recoveredAgents > 0) {
    session.consecutiveAdapterFailures = 0;
    session.lastAdapterFailureAt = null;
    deps.completeCodexTurn(session, pending);
    reconcileRecoveredQueuedTurnLifecycle(session, "codex_resume_recovered_messages", deps);
    deps.dispatchQueuedCodexTurns(session, "codex_resume_recovered_messages");
    reconcileRecoveredQueuedTurnLifecycle(session, "codex_resume_recovered_messages_dispatched", deps);
    deps.maybeFlushQueuedCodexMessages(session, "codex_resume_recovered_messages");
    deps.persistSession(session);
    return;
  }
  if (synthesizedResults > 0) {
    session.consecutiveAdapterFailures = 0;
    session.lastAdapterFailureAt = null;
    deps.completeCodexTurn(session, pending);
    reconcileRecoveredQueuedTurnLifecycle(session, "codex_resume_synthesized_results", deps);
    deps.dispatchQueuedCodexTurns(session, "codex_resume_synthesized_results");
    reconcileRecoveredQueuedTurnLifecycle(session, "codex_resume_synthesized_results_dispatched", deps);
    deps.maybeFlushQueuedCodexMessages(session, "codex_resume_synthesized_results");
    deps.persistSession(session);
    return;
  }
  if (hasOnlyRetrySafeCodexResumedItems(nonUserItems)) {
    console.log(
      `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} contains reasoning-only items; retrying pending user message`,
    );
    retryPendingCodexTurn(session, pending, deps);
    return;
  }
  deps.completeCodexTurn(session, pending);
  reconcileRecoveredQueuedTurnLifecycle(session, "codex_resume_non_retryable", deps);
  deps.dispatchQueuedCodexTurns(session, "codex_resume_non_retryable");
  reconcileRecoveredQueuedTurnLifecycle(session, "codex_resume_non_retryable_dispatched", deps);
  deps.maybeFlushQueuedCodexMessages(session, "codex_resume_non_retryable");
  console.warn(
    `[ws-bridge] Resumed Codex turn ${lastTurn.id} for session ${sessionTag(session.id)} has non-user items but no recoverable agentMessage text; skipping auto-retry to avoid duplicate side effects`,
  );
  deps.broadcastToBrowsers(session, {
    type: "error",
    message:
      "Codex disconnected mid-turn and resumed with non-text tool activity. Automatic retry was skipped to avoid duplicate side effects.",
  });
  deps.persistSession(session);
}
export function extractUserTextFromResumedTurn(turn: CodexResumeTurnSnapshot): string {
  for (const item of turn.items) {
    if (item.type !== "userMessage") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    const textParts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const rec = part as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") {
        textParts.push(rec.text);
      }
    }
    if (textParts.length > 0) return textParts.join("\n");
  }
  return "";
}
export function normalizeResumedUserText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
function normalizeCodexRecoveredAssistantText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
function recoverAgentMessagesFromResumedTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  turn: CodexResumeTurnSnapshot,
  pending: CodexOutboundTurn,
  deps: CodexRecoveryOrchestratorDeps,
): number {
  let matchedOrRecovered = 0;
  const baseTs = pending.disconnectedAt ?? Date.now();
  for (let i = 0; i < turn.items.length; i++) {
    const item = turn.items[i];
    if (item.type !== "agentMessage") continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (!text.trim()) continue;
    const itemId = typeof item.id === "string" ? item.id : `${turn.id}-${i}`;
    const assistantId = `codex-agent-${itemId}`;
    const alreadyExists = session.messageHistory.some((m) => m.type === "assistant" && m.message?.id === assistantId);
    if (alreadyExists) {
      matchedOrRecovered++;
      continue;
    }
    if (
      /^item-\d+$/.test(itemId) &&
      findMatchingRecoveredCodexAssistant(session, text, deps.codexAssistantReplayScanLimit)
    ) {
      matchedOrRecovered++;
      continue;
    }
    const assistant: BrowserIncomingMessage = {
      type: "assistant",
      message: {
        id: assistantId,
        type: "message",
        role: "assistant",
        model: session.state.model || getDefaultModelForBackend("codex"),
        content: [{ type: "text", text }],
        stop_reason: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: baseTs + i + 1,
    };
    session.messageHistory.push(assistant);
    deps.broadcastToBrowsers(session, assistant);
    matchedOrRecovered++;
  }
  return matchedOrRecovered;
}
export function reconcileRecoveredQueuedTurnLifecycle(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: Pick<CodexRecoveryOrchestratorDeps, "getCodexHeadTurn">,
  options: { releasedHeadQueuedTurn?: boolean } = {},
): boolean {
  const previousEntries = getQueuedTurnLifecycleEntries(session);
  const nextEntries = previousEntries.map((entry) => ({
    reason: entry.reason,
    userMessageIds: [...entry.userMessageIds],
    interruptSource: entry.interruptSource,
    activeTurnRoute: entry.activeTurnRoute,
  }));
  let clearedQueuedHead = false;
  if (options.releasedHeadQueuedTurn && nextEntries.length > 0) {
    nextEntries.shift();
  }
  const liveTurns = session.pendingCodexTurns.filter((turn) => turn.status !== "completed");
  if (!session.isGenerating && liveTurns[0]?.turnTarget === "queued") {
    liveTurns[0].turnTarget = null;
    clearedQueuedHead = true;
    if (nextEntries.length > 0) {
      nextEntries.shift();
    }
  }
  const rebuiltEntries: Array<{
    reason: string;
    userMessageIds: number[];
    interruptSource: InterruptSource | null;
    activeTurnRoute: ActiveTurnRoute | null;
  }> = [];
  let nextEntryIdx = 0;
  for (const turn of liveTurns) {
    const isExplicitQueuedTurn = turn.turnTarget === "queued";
    const isQueuedPendingBatchWithoutTarget =
      turn.status !== "dispatched" &&
      turn.status !== "backend_acknowledged" &&
      turn.turnTarget == null &&
      turn.adapterMsg.type === "codex_start_pending" &&
      turn.turnId == null;
    if (!isExplicitQueuedTurn && !(isQueuedPendingBatchWithoutTarget && nextEntryIdx < nextEntries.length)) {
      continue;
    }
    rebuiltEntries.push({
      reason: nextEntries[nextEntryIdx]?.reason ?? "queued_user_message",
      userMessageIds: nextEntries[nextEntryIdx]?.userMessageIds ?? (turn.historyIndex >= 0 ? [turn.historyIndex] : []),
      interruptSource: nextEntries[nextEntryIdx]?.interruptSource ?? null,
      activeTurnRoute: nextEntries[nextEntryIdx]?.activeTurnRoute ?? null,
    });
    nextEntryIdx += 1;
  }
  const lifecycleChanged =
    JSON.stringify(previousEntries) !== JSON.stringify(rebuiltEntries) ||
    clearedQueuedHead ||
    options.releasedHeadQueuedTurn === true;
  if (!lifecycleChanged) return false;
  replaceQueuedTurnLifecycleEntries(session, rebuiltEntries);
  console.log(
    `[ws-bridge] Reconciled queued-turn lifecycle for session ${sessionTag(session.id)} ` +
      `(${reason}, queued=${rebuiltEntries.length}${clearedQueuedHead ? ", cleared_head" : ""})`,
  );
  return true;
}
export function rearmRecoveredQueuedHeadTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  pending: CodexOutboundTurn,
  reason: string,
  deps: Pick<
    CodexRecoveryOrchestratorDeps,
    "markRunningFromUserDispatch" | "promoteNextQueuedTurn" | "trackUserMessageForTurn"
  >,
): void {
  if (pending.turnTarget !== "queued" || session.isGenerating) return;
  if (deps.promoteNextQueuedTurn(session)) {
    pending.turnTarget = "current";
    console.log(
      `[ws-bridge] Re-armed recovered queued Codex turn for session ${sessionTag(session.id)} ` +
        `(${reason}, via_lifecycle_promotion)`,
    );
    return;
  }
  const target = deps.markRunningFromUserDispatch(session, reason);
  pending.turnTarget = target;
  if (pending.historyIndex >= 0) {
    deps.trackUserMessageForTurn(session, pending.historyIndex, target);
  }
  console.log(
    `[ws-bridge] Re-armed recovered queued Codex turn for session ${sessionTag(session.id)} ` +
      `(${reason}, via_running_guard)`,
  );
}
export function retryPendingCodexTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  pending: CodexOutboundTurn,
  deps: CodexRecoveryOrchestratorDeps,
): void {
  const releasedHeadQueuedTurn = pending.turnTarget === "queued";
  pending.status = session.state.backend_state === "broken" ? "blocked_broken_session" : "queued";
  pending.updatedAt = Date.now();
  pending.acknowledgedAt = null;
  pending.lastError = null;
  pending.turnTarget = null;
  pending.turnId = null;
  pending.disconnectedAt = null;
  pending.resumeConfirmedAt = null;
  reconcileRecoveredQueuedTurnLifecycle(session, "codex_retry_pending_turn", deps, { releasedHeadQueuedTurn });
  deps.dispatchQueuedCodexTurns(session, "codex_retry_pending_turn");
  deps.persistSession(session);
}
export function retryNonDrainableCodexHeadTurn(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  const head = deps.getCodexHeadTurn(session);
  const adapter = session.codexAdapter;
  if (!head || head.status !== "backend_acknowledged") return false;
  if (session.isGenerating) return false;
  if (!adapter || session.state.backend_state !== "connected" || !adapter.isConnected()) return false;
  if (adapter.getCurrentTurnId()) return false;
  console.warn(
    `[ws-bridge] Retrying non-drainable Codex turn ${head.turnId ?? "<untracked>"} ` +
      `for session ${sessionTag(session.id)} (${reason})`,
  );
  retryPendingCodexTurn(session, head, deps);
  return true;
}
export function clearStaleCodexCompactionState(
  session: CodexRecoveryOrchestratorSessionLike,
  reason: string,
  deps: CodexRecoveryOrchestratorDeps,
): boolean {
  const adapter = session.codexAdapter;
  if (!session.state.is_compacting) return false;
  if (session.isGenerating) return false;
  if (!adapter || session.state.backend_state !== "connected" || !adapter.isConnected()) return false;
  if (adapter.getCurrentTurnId()) return false;

  session.state.is_compacting = false;
  deps.broadcastToBrowsers(session, { type: "status_change", status: null });
  deps.emitTakodeEvent(session.id, "compaction_finished", {});
  if (session.messageHistory.some((entry) => entry.type === "compact_marker")) {
    deps.injectCompactionRecovery(session);
  }
  deps.persistSession(session);
  console.warn(`[ws-bridge] Cleared stale Codex compaction state for session ${sessionTag(session.id)} (${reason})`);
  return true;
}
function hasOnlyRetrySafeCodexResumedItems(items: Array<Record<string, unknown>>): boolean {
  if (items.length === 0) return false;
  return items.every((item) => {
    const itemType = typeof item.type === "string" ? item.type : "";
    return CODEX_RETRY_SAFE_RESUME_ITEM_TYPES.has(itemType);
  });
}
function findMatchingRecoveredCodexAssistant(
  session: Pick<CodexRecoveryOrchestratorSessionLike, "messageHistory">,
  text: string,
  limit: number,
): Extract<BrowserIncomingMessage, { type: "assistant" }> | null {
  const normalizedText = normalizeCodexRecoveredAssistantText(text);
  if (!normalizedText) return null;
  let scannedAssistants = 0;
  for (let i = session.messageHistory.length - 1; i >= 0; i--) {
    const entry = session.messageHistory[i];
    if (entry.type !== "assistant") continue;
    scannedAssistants += 1;
    if (scannedAssistants > limit) break;
    const existing = entry as Extract<BrowserIncomingMessage, { type: "assistant" }>;
    if (existing.parent_tool_use_id !== null) continue;
    const textBlocks = existing.message.content.filter((block) => block.type === "text");
    if (textBlocks.length !== 1) continue;
    const existingText = normalizeCodexRecoveredAssistantText(textBlocks[0].text || "");
    if (!existingText) continue;
    if (existingText === normalizedText) return existing;
  }
  return null;
}
type QueuedTurnLifecycleEntry = {
  reason: string;
  userMessageIds: number[];
  interruptSource: InterruptSource | null;
  activeTurnRoute: ActiveTurnRoute | null;
};
function getQueuedTurnLifecycleEntries(session: CodexRecoveryOrchestratorSessionLike): QueuedTurnLifecycleEntry[] {
  return Array.from({ length: session.queuedTurnStarts }, (_, idx) => ({
    reason: session.queuedTurnReasons[idx] ?? "queued_user_message",
    userMessageIds: Array.isArray(session.queuedTurnUserMessageIds[idx])
      ? [...session.queuedTurnUserMessageIds[idx]!]
      : [],
    interruptSource: session.queuedTurnInterruptSources[idx] ?? null,
    activeTurnRoute: session.queuedTurnActiveRoutes?.[idx] ?? null,
  }));
}
function replaceQueuedTurnLifecycleEntries(
  session: CodexRecoveryOrchestratorSessionLike,
  entries: QueuedTurnLifecycleEntry[],
): void {
  session.queuedTurnStarts = entries.length;
  session.queuedTurnReasons = entries.map((entry) => entry.reason);
  session.queuedTurnUserMessageIds = entries.map((entry) => [...entry.userMessageIds]);
  session.queuedTurnInterruptSources = entries.map((entry) => entry.interruptSource);
  session.queuedTurnActiveRoutes = entries.map((entry) => entry.activeTurnRoute);
}
