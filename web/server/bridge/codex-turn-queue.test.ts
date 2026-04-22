import { describe, expect, it, vi } from "vitest";
import type { BrowserOutgoingMessage, CLIResultMessage, CodexOutboundTurn } from "../session-types.js";
import {
  armCodexFreshTurnRequirement,
  clearCodexFreshTurnRequirement,
  completeCodexTurnsForResult,
  dispatchQueuedCodexTurns,
  enqueueCodexTurn,
  getCodexHeadTurn,
  getCodexTurnAwaitingAck,
  getCodexTurnInRecovery,
  type CodexTurnQueueSessionLike,
} from "./codex-turn-queue.js";

function makeTurn(overrides: Partial<CodexOutboundTurn> = {}): CodexOutboundTurn {
  return {
    adapterMsg: { type: "user_message", content: "hi" } satisfies BrowserOutgoingMessage,
    userMessageId: "user-1",
    userContent: "hi",
    historyIndex: 0,
    status: "queued",
    dispatchCount: 0,
    createdAt: 1,
    updatedAt: 1,
    acknowledgedAt: null,
    turnTarget: null,
    lastError: null,
    turnId: null,
    disconnectedAt: null,
    resumeConfirmedAt: null,
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<CodexTurnQueueSessionLike> = {},
): CodexTurnQueueSessionLike & { pendingCodexTurns: CodexOutboundTurn[] } {
  return {
    pendingCodexTurns: [],
    codexAdapter: null,
    codexFreshTurnRequiredUntilTurnId: null,
    state: { backend_state: "connected" },
    ...overrides,
  };
}

describe("codex-turn-queue", () => {
  // The queue helpers intentionally reason only about the head turn; later queued
  // entries must not affect awaiting-ack or recovery classification until promoted.
  it("tracks head, awaiting-ack, and recovery turns from the queue head only", () => {
    const session = makeSession();
    const queued = enqueueCodexTurn(session, makeTurn({ userMessageId: "queued" }));
    enqueueCodexTurn(session, makeTurn({ userMessageId: "later", status: "dispatched" }));

    expect(getCodexHeadTurn(session)).toBe(queued);
    expect(getCodexTurnAwaitingAck(session)).toBeNull();
    expect(getCodexTurnInRecovery(session)).toBe(queued);

    queued.status = "dispatched";
    expect(getCodexTurnAwaitingAck(session)).toBe(queued);
  });

  // Validates the turn-id completion path that trims only finished heads, preserving
  // any later queued work that should continue after the acknowledged turn completes.
  it("completes tracked turns by codex_turn_id and trims completed heads", () => {
    const session = makeSession({
      pendingCodexTurns: [
        makeTurn({ userMessageId: "done", turnId: "turn-1", status: "backend_acknowledged" }),
        makeTurn({ userMessageId: "next", turnId: "turn-2", status: "queued" }),
      ],
    });
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: undefined,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "res-1",
      session_id: "s1",
      codex_turn_id: "turn-1",
    } satisfies CLIResultMessage;

    const outcome = completeCodexTurnsForResult(session, result, 50);

    expect(outcome).toEqual({ matched: true, codexTurnId: "turn-1" });
    expect(session.pendingCodexTurns).toHaveLength(1);
    expect(session.pendingCodexTurns[0].userMessageId).toBe("next");
  });

  // Covers the guard that blocks steering until a specific active turn finishes,
  // including the edge case where an unrelated completed turn must not clear the latch.
  it("manages the fresh-turn requirement with completed turn gating", () => {
    const session = makeSession();

    expect(armCodexFreshTurnRequirement(session, "turn-1")).toBe(true);
    expect(session.codexFreshTurnRequiredUntilTurnId).toBe("turn-1");
    expect(armCodexFreshTurnRequirement(session, "turn-1")).toBe(false);

    expect(clearCodexFreshTurnRequirement(session, { completedTurnId: "other" })).toEqual({
      cleared: false,
      blockedTurnId: "turn-1",
    });
    expect(clearCodexFreshTurnRequirement(session, { completedTurnId: "turn-1" })).toEqual({
      cleared: true,
      blockedTurnId: "turn-1",
    });
    expect(session.codexFreshTurnRequiredUntilTurnId).toBeNull();
  });

  // Ensures dispatch rewrites a broken-session head back to a normal queued turn and
  // marks its pending inputs non-cancelable once the adapter accepts delivery.
  it("dispatches the queued head turn and marks pending inputs non-cancelable", () => {
    const sendBrowserMessage = vi.fn(() => true);
    const pruneStalePendingCodexHerdInputs = vi.fn();
    const setPendingCodexInputsCancelable = vi.fn();
    const persistSession = vi.fn();
    const session = makeSession({
      codexAdapter: {
        isConnected: () => true,
        sendBrowserMessage,
      },
      pendingCodexTurns: [
        makeTurn({
          userMessageId: "user-1",
          pendingInputIds: ["pending-1", "pending-2"],
          status: "blocked_broken_session",
        }),
      ],
    });

    const outcome = dispatchQueuedCodexTurns(session, "recovery", {
      pruneStalePendingCodexHerdInputs,
      setPendingCodexInputsCancelable,
      persistSession,
    });

    expect(outcome.status).toBe("dispatched");
    expect(session.pendingCodexTurns[0].status).toBe("dispatched");
    expect(session.pendingCodexTurns[0].dispatchCount).toBe(1);
    expect(sendBrowserMessage).toHaveBeenCalledWith(session.pendingCodexTurns[0].adapterMsg);
    expect(pruneStalePendingCodexHerdInputs).toHaveBeenCalledWith("recovery_before_dispatch");
    expect(setPendingCodexInputsCancelable).toHaveBeenCalledWith(["pending-1", "pending-2"]);
    expect(persistSession).toHaveBeenCalledTimes(1);
  });
});
