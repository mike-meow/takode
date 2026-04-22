import type { BrowserOutgoingMessage, CLIResultMessage, CodexOutboundTurn } from "../session-types.js";

type CodexQueueAdapter = {
  isConnected: () => boolean;
  sendBrowserMessage: (msg: BrowserOutgoingMessage) => boolean;
};

export interface CodexTurnQueueSessionLike {
  pendingCodexTurns: CodexOutboundTurn[];
  codexAdapter: CodexQueueAdapter | null;
  codexFreshTurnRequiredUntilTurnId: string | null | undefined;
  state: { backend_state?: string };
}

export function getCodexHeadTurn(session: CodexTurnQueueSessionLike): CodexOutboundTurn | null {
  return session.pendingCodexTurns[0] ?? null;
}

export function getCodexTurnAwaitingAck(session: CodexTurnQueueSessionLike): CodexOutboundTurn | null {
  const head = getCodexHeadTurn(session);
  return head?.status === "dispatched" ? head : null;
}

export function getCodexTurnInRecovery(session: CodexTurnQueueSessionLike): CodexOutboundTurn | null {
  const head = getCodexHeadTurn(session);
  if (!head) return null;
  if (
    head.status === "queued" ||
    head.status === "dispatched" ||
    head.status === "backend_acknowledged" ||
    head.status === "blocked_broken_session"
  ) {
    return head;
  }
  return null;
}

export function enqueueCodexTurn(
  session: CodexTurnQueueSessionLike,
  turn: CodexOutboundTurn,
): CodexOutboundTurn {
  session.pendingCodexTurns.push(turn);
  return turn;
}

export function removeCompletedCodexTurns(session: CodexTurnQueueSessionLike): boolean {
  let removed = 0;
  while (session.pendingCodexTurns[0]?.status === "completed") {
    session.pendingCodexTurns.shift();
    removed++;
  }
  return removed > 0;
}

export function completeCodexTurn(
  session: CodexTurnQueueSessionLike,
  turn: CodexOutboundTurn | null,
  updatedAt = Date.now(),
): boolean {
  if (!turn) return false;
  turn.status = "completed";
  turn.updatedAt = updatedAt;
  return removeCompletedCodexTurns(session);
}

export function completeCodexTurnsForResult(
  session: CodexTurnQueueSessionLike,
  msg: CLIResultMessage,
  updatedAt = Date.now(),
): { matched: boolean; codexTurnId: string | null } {
  const codexTurnId = typeof msg.codex_turn_id === "string" ? msg.codex_turn_id : null;
  if (codexTurnId) {
    let matched = false;
    for (const turn of session.pendingCodexTurns) {
      if (turn.turnId !== codexTurnId) continue;
      turn.status = "completed";
      turn.updatedAt = updatedAt;
      matched = true;
    }
    if (matched) {
      removeCompletedCodexTurns(session);
    }
    return { matched, codexTurnId };
  }

  completeCodexTurn(session, getCodexHeadTurn(session), updatedAt);
  return { matched: true, codexTurnId: null };
}

export function armCodexFreshTurnRequirement(
  session: CodexTurnQueueSessionLike,
  turnId: string,
): boolean {
  if (session.codexFreshTurnRequiredUntilTurnId === turnId) return false;
  session.codexFreshTurnRequiredUntilTurnId = turnId;
  return true;
}

export function clearCodexFreshTurnRequirement(
  session: CodexTurnQueueSessionLike,
  options?: { completedTurnId?: string | null },
): { cleared: boolean; blockedTurnId: string | null } {
  const blockedTurnId = session.codexFreshTurnRequiredUntilTurnId ?? null;
  if (!blockedTurnId) return { cleared: false, blockedTurnId: null };
  const completedTurnId = options?.completedTurnId;
  if (completedTurnId && blockedTurnId !== completedTurnId) {
    return { cleared: false, blockedTurnId };
  }
  session.codexFreshTurnRequiredUntilTurnId = null;
  return { cleared: true, blockedTurnId };
}

export function dispatchQueuedCodexTurns(
  session: CodexTurnQueueSessionLike,
  reason: string,
  deps: {
    pruneStalePendingCodexHerdInputs: (reason: string) => void;
    setPendingCodexInputsCancelable: (ids: string[]) => void;
    persistSession: () => void;
  },
): { status: "noop" | "adapter_rejected" | "dispatched"; head: CodexOutboundTurn | null } {
  const adapter = session.codexAdapter;
  if (!adapter) return { status: "noop", head: null };
  if (session.state.backend_state !== "connected" || !adapter.isConnected()) {
    return { status: "noop", head: null };
  }
  deps.pruneStalePendingCodexHerdInputs(`${reason}_before_dispatch`);

  const head = getCodexHeadTurn(session);
  if (!head) return { status: "noop", head: null };

  if (head.status === "blocked_broken_session") {
    head.status = "queued";
    head.updatedAt = Date.now();
    head.lastError = null;
    head.turnId = null;
    head.acknowledgedAt = null;
    head.disconnectedAt = null;
    head.resumeConfirmedAt = null;
  }
  if (head.status === "backend_acknowledged" || head.status === "dispatched") {
    return { status: "noop", head };
  }

  const now = Date.now();
  const accepted = adapter.sendBrowserMessage(head.adapterMsg);
  if (!accepted) {
    head.status = "queued";
    head.updatedAt = now;
    head.lastError = `Codex adapter rejected outbound turn during ${reason}.`;
    deps.persistSession();
    return { status: "adapter_rejected", head };
  }

  head.status = "dispatched";
  head.dispatchCount += 1;
  head.updatedAt = now;
  head.lastError = null;
  deps.setPendingCodexInputsCancelable(head.pendingInputIds ?? [head.userMessageId]);
  deps.persistSession();
  return { status: "dispatched", head };
}
