import { describe, expect, it, vi } from "vitest";
import {
  commitPendingCodexInputs,
  type CodexRecoveryOrchestratorSessionLike,
  type CodexRecoveryOrchestratorDeps,
} from "./codex-recovery-orchestrator.js";
import type { PendingCodexInput, BrowserIncomingMessage } from "../session-types.js";

function makeSession(pendingInputs: PendingCodexInput[]): CodexRecoveryOrchestratorSessionLike {
  return {
    id: "test-session",
    backendType: "codex",
    state: { backend_state: "connected", backend_type: "codex", cwd: "/tmp", model: "gpt-5.4", is_compacting: false },
    messageHistory: [] as BrowserIncomingMessage[],
    pendingMessages: [],
    pendingCodexInputs: pendingInputs,
    pendingCodexTurns: [],
    codexFreshTurnRequiredUntilTurnId: null,
    isGenerating: false,
    cliInitReceived: true,
    consecutiveAdapterFailures: 0,
    lastAdapterFailureAt: null,
    queuedTurnStarts: 0,
    queuedTurnReasons: [],
    queuedTurnUserMessageIds: [],
    queuedTurnInterruptSources: [],
    codexAdapter: null,
  };
}

function makeDeps(): CodexRecoveryOrchestratorDeps {
  return {
    codexAssistantReplayScanLimit: 0,
    formatVsCodeSelectionPrompt: () => "",
    broadcastPendingCodexInputs: vi.fn(),
    broadcastToBrowsers: vi.fn(),
    persistSession: vi.fn(),
    touchUserMessage: vi.fn(),
    onUserMessage: vi.fn(),
    enqueueCodexTurn: vi.fn(),
    getCodexHeadTurn: vi.fn(() => null),
    getCodexTurnInRecovery: vi.fn(() => null),
    completeCodexTurn: vi.fn(() => false),
    completeCodexTurnsForResult: vi.fn(() => false),
    clearCodexFreshTurnRequirement: vi.fn(),
    dispatchQueuedCodexTurns: vi.fn(),
    maybeFlushQueuedCodexMessages: vi.fn(),
    pruneStalePendingCodexHerdInputs: vi.fn(() => false),
    synthesizeCodexToolResultsFromResumedTurn: vi.fn(() => 0),
    trackUserMessageForTurn: vi.fn(),
    setPendingCodexInputCancelable: vi.fn(),
    setPendingCodexInputsCancelable: vi.fn(),
    getCodexTurnAwaitingAck: vi.fn(() => null),
    armCodexFreshTurnRequirement: vi.fn(),
    flushQueuedMessagesToCodexAdapter: vi.fn(),
    emitTakodeEvent: vi.fn(),
    requestCliRelaunch: vi.fn(),
    requestCodexAutoRecovery: vi.fn(),
    setGenerating: vi.fn(),
    broadcastStatusChange: vi.fn(),
    markRunningFromUserDispatch: vi.fn(() => "current" as const),
  } as unknown as CodexRecoveryOrchestratorDeps;
}

describe("commitPendingCodexInputs", () => {
  it("includes client_msg_id in the broadcast when pending input has clientMsgId", () => {
    // This test verifies the fix for q-578: ghost pending-upload messages.
    // When a Codex pending input carries a clientMsgId (set during the
    // browser's pending-upload flow), commitPendingCodexInput must include
    // client_msg_id in the user_message broadcast so the browser can call
    // consumePendingUserUpload and clear the "PENDING UPLOAD" ghost.
    const input: PendingCodexInput = {
      id: "user-msg-1",
      clientMsgId: "pending-upload-abc123",
      content: "Tell me what you see",
      timestamp: Date.now(),
      cancelable: false,
    };
    const session = makeSession([input]);
    const deps = makeDeps();

    const indexes = commitPendingCodexInputs(session, ["user-msg-1"], deps);

    expect(indexes).toEqual([0]);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledTimes(1);
    const broadcastedMsg = (deps.broadcastToBrowsers as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(broadcastedMsg.type).toBe("user_message");
    expect(broadcastedMsg.client_msg_id).toBe("pending-upload-abc123");
  });

  it("omits client_msg_id when pending input has no clientMsgId", () => {
    // Non-image messages (e.g. plain text from agent sources) don't set
    // clientMsgId, so the broadcast should not include client_msg_id.
    const input: PendingCodexInput = {
      id: "user-msg-2",
      content: "Hello",
      timestamp: Date.now(),
      cancelable: false,
    };
    const session = makeSession([input]);
    const deps = makeDeps();

    commitPendingCodexInputs(session, ["user-msg-2"], deps);

    const broadcastedMsg = (deps.broadcastToBrowsers as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(broadcastedMsg.type).toBe("user_message");
    expect(broadcastedMsg.client_msg_id).toBeUndefined();
  });
});
