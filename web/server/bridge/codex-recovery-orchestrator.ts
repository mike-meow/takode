import { getDefaultModelForBackend } from "../../shared/backend-defaults.js";
import type { CodexResumeSnapshot, CodexResumeTurnSnapshot } from "../codex-adapter.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  CodexOutboundTurn,
  PendingCodexInput,
  SessionState,
} from "../session-types.js";
import { sessionTag } from "../session-tag.js";
import type { UserDispatchTurnTarget } from "./generation-lifecycle.js";
const CODEX_RETRY_SAFE_RESUME_ITEM_TYPES: ReadonlySet<string> = new Set(["reasoning", "contextCompaction"]);
type InterruptSource = "user" | "leader" | "system";
export interface CodexRecoveryOrchestratorSessionLike {
  id: string;
  state: Pick<SessionState, "backend_state" | "cwd" | "model">;
  messageHistory: BrowserIncomingMessage[];
  pendingCodexInputs: PendingCodexInput[];
  pendingCodexTurns: CodexOutboundTurn[];
  codexFreshTurnRequiredUntilTurnId: string | null;
  isGenerating: boolean;
  consecutiveAdapterFailures: number;
  lastAdapterFailureAt: number | null;
  queuedTurnStarts: number;
  queuedTurnReasons: string[];
  queuedTurnUserMessageIds: number[][];
  queuedTurnInterruptSources: Array<InterruptSource | null>;
  lastUserMessage?: string;
  codexAdapter:
    | {
        getCurrentTurnId(): string | null;
        isConnected(): boolean;
        sendBrowserMessage(msg: BrowserOutgoingMessage): boolean;
      }
    | null;
}
export interface CodexRecoveryOrchestratorDeps {
  codexAssistantReplayScanLimit: number;
  formatVsCodeSelectionPrompt: (selection: NonNullable<PendingCodexInput["vscodeSelection"]>) => string;
  broadcastPendingCodexInputs: (session: CodexRecoveryOrchestratorSessionLike) => void;
  broadcastToBrowsers: (session: CodexRecoveryOrchestratorSessionLike, msg: BrowserIncomingMessage) => void;
  persistSession: (session: CodexRecoveryOrchestratorSessionLike) => void;
  touchUserMessage: (sessionId: string) => void;
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
      session.state.backend_state === "broken"
        ? "Codex session needs relaunch before queued messages can run."
        : null,
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
  rebuildQueuedCodexPendingStartBatch(session, deps);
  deps.dispatchQueuedCodexTurns(session, reason);
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
  console.log(`[ws-bridge] Steered ${ids.length} pending Codex input(s) for session ${sessionTag(session.id)} (${reason})`);
  return true;
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
  const userHistoryEntry: Extract<BrowserIncomingMessage, { type: "user_message" }> = {
    type: "user_message",
    content: pending.content,
    timestamp: pending.timestamp,
    id: pending.id,
    ...(pending.imageRefs?.length ? { images: pending.imageRefs } : {}),
    ...(pending.vscodeSelection ? { vscodeSelection: pending.vscodeSelection } : {}),
    ...(pending.agentSource ? { agentSource: pending.agentSource } : {}),
  };
  session.messageHistory.push(userHistoryEntry);
  const userMsgHistoryIdx = session.messageHistory.length - 1;
  session.lastUserMessage = (pending.content || "").slice(0, 80);
  deps.touchUserMessage(session.id);
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
    if (!pending.turnId && lastTurn.status === "inProgress" && snapshot.threadStatus === "idle" && lastTurn.items.length === 0) {
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
  const completedHistoryIndexes = commitPendingCodexInputs(session, pending.pendingInputIds ?? [pending.userMessageId], deps);
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
  const rebuiltEntries: Array<{ reason: string; userMessageIds: number[]; interruptSource: InterruptSource | null }> = [];
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
      userMessageIds:
        nextEntries[nextEntryIdx]?.userMessageIds ?? (turn.historyIndex >= 0 ? [turn.historyIndex] : []),
      interruptSource: nextEntries[nextEntryIdx]?.interruptSource ?? null,
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
  deps: Pick<CodexRecoveryOrchestratorDeps, "markRunningFromUserDispatch" | "promoteNextQueuedTurn" | "trackUserMessageForTurn">,
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
};
function getQueuedTurnLifecycleEntries(session: CodexRecoveryOrchestratorSessionLike): QueuedTurnLifecycleEntry[] {
  return Array.from({ length: session.queuedTurnStarts }, (_, idx) => ({
    reason: session.queuedTurnReasons[idx] ?? "queued_user_message",
    userMessageIds: Array.isArray(session.queuedTurnUserMessageIds[idx]) ? [...session.queuedTurnUserMessageIds[idx]!] : [],
    interruptSource: session.queuedTurnInterruptSources[idx] ?? null,
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
}
