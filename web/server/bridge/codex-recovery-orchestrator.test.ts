import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitPendingCodexInputs,
  handleCodexAdapterInitError,
  hydrateCodexResumedHistory,
  type CodexRecoveryOrchestratorSessionLike,
  type CodexRecoveryOrchestratorDeps,
} from "./codex-recovery-orchestrator.js";
import type { PendingCodexInput, BrowserIncomingMessage, CodexOutboundTurn } from "../session-types.js";
import { injectReplyContext } from "../../shared/reply-context.js";
import type { CodexResumeSnapshot } from "../codex-adapter.js";

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

function makeRecoveryDeps(overrides: Record<string, unknown> = {}) {
  return {
    ...makeDeps(),
    clearCodexDisconnectGraceTimer: vi.fn(),
    setBackendState: vi.fn((session: any, state: string, error: string | null) => {
      session.state.backend_state = state;
      session.state.backend_error = error;
    }),
    getCodexTurnInRecovery: vi.fn((session: any) => session.pendingCodexTurns[0] ?? null),
    getLauncherSessionInfo: vi.fn(() => ({ cliSessionId: "thread-existing" })),
    rebuildQueuedCodexPendingStartBatch: vi.fn(),
    setAttentionError: vi.fn(),
    setGenerating: vi.fn(),
    hasCliRelaunchCallback: true,
    adapterFailureResetWindowMs: 120_000,
    maxAdapterRelaunchFailures: 3,
    ...overrides,
  } as any;
}

function makePendingTurn(): CodexOutboundTurn {
  return {
    adapterMsg: { type: "user_message", content: "continue" } as any,
    userMessageId: "user-1",
    pendingInputIds: ["input-1"],
    userContent: "continue",
    historyIndex: -1,
    status: "dispatched",
    dispatchCount: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    acknowledgedAt: null,
    turnTarget: null,
    lastError: null,
    turnId: null,
    disconnectedAt: null,
    resumeConfirmedAt: null,
  };
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

describe("hydrateCodexResumedHistory", () => {
  it("sanitizes legacy reply markers before storing the session preview", () => {
    // Codex external resume can hydrate historical user text that predates
    // explicit replyContext metadata. The session preview must stay user-facing
    // and never expose the raw legacy marker payload.
    const legacyReply = injectReplyContext("Original answer", "Continue the work", "codex-agent-random-id");
    const session = makeSession([]);
    const deps = makeDeps();

    const snapshot: CodexResumeSnapshot = {
      threadId: "thread-history",
      turnCount: 1,
      turns: [
        {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [{ type: "userMessage", content: [{ type: "text", text: legacyReply }] }],
        },
      ],
      lastTurn: null,
    };

    const hydrated = hydrateCodexResumedHistory(session, snapshot, deps);

    expect(hydrated).toBe(1);
    expect(session.messageHistory[0]).toMatchObject({ type: "user_message", content: legacyReply });
    expect(session.lastUserMessage).toBe("[reply] Continue the work");
    expect(session.lastUserMessage).not.toContain("<<<REPLY_TO");
    expect(session.lastUserMessage).not.toContain("codex-agent-random-id");
  });
});

describe("handleCodexAdapterInitError", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps transient auto-recovery init errors recoverable and schedules a bounded retry", () => {
    // A post-restart transport close can be transient. While auto-recovery is
    // in flight, keep the pending turn retryable instead of terminally broken.
    vi.useFakeTimers();
    const adapter = { id: "adapter-1" };
    const session = makeSession([]);
    const pending = makePendingTurn();
    session.codexAdapter = adapter as any;
    session.state.backend_state = "resuming";
    session.pendingCodexTurns = [pending];
    (session as any).codexAutoRecoveryReason = "browser_open_dead_backend";
    const deps = makeRecoveryDeps();

    const result = handleCodexAdapterInitError(
      session.id,
      session,
      adapter,
      "Codex initialization failed: Transport closed",
      deps,
    );

    expect(result).toBe("retrying");
    expect(session.state.backend_state).toBe("recovering");
    expect(session.codexAdapter).toBeNull();
    expect(pending.status).toBe("queued");
    expect(deps.setAttentionError).not.toHaveBeenCalled();
    expect(deps.setGenerating).not.toHaveBeenCalled();
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, { type: "backend_disconnected" });
    expect(deps.broadcastToBrowsers).not.toHaveBeenCalledWith(session, expect.objectContaining({ type: "error" }));

    vi.advanceTimersByTime(1_000);
    expect(deps.requestCodexAutoRecovery).toHaveBeenCalledWith(session, "init_error:browser_open_dead_backend");
  });

  it("marks broken only after transient init retry budget is exhausted", () => {
    // Once the bounded retry budget is spent, the UI should become terminally
    // broken so users see a real failure instead of an infinite respawn loop.
    const adapter = { id: "adapter-1" };
    const session = makeSession([]);
    const pending = makePendingTurn();
    session.codexAdapter = adapter as any;
    session.pendingCodexTurns = [pending];
    (session as any).codexAutoRecoveryReason = "browser_open_dead_backend";
    (session as any).codexInitRecoveryFailures = 3;
    const deps = makeRecoveryDeps({ maxAdapterRelaunchFailures: 3 });

    const result = handleCodexAdapterInitError(
      session.id,
      session,
      adapter,
      "Codex initialization failed: Transport closed",
      deps,
    );

    expect(result).toBe("broken");
    expect(session.state.backend_state).toBe("broken");
    expect(pending.status).toBe("blocked_broken_session");
    expect(deps.requestCodexAutoRecovery).not.toHaveBeenCalled();
    expect(deps.setAttentionError).toHaveBeenCalledWith(session);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "error",
      message: "Codex initialization failed: Transport closed",
    });
  });

  it("marks non-transient init errors broken immediately", () => {
    const adapter = { id: "adapter-1" };
    const session = makeSession([]);
    session.codexAdapter = adapter as any;
    (session as any).codexAutoRecoveryReason = "browser_open_dead_backend";
    const deps = makeRecoveryDeps();

    const result = handleCodexAdapterInitError(
      session.id,
      session,
      adapter,
      "Codex initialization failed: no rollout found",
      deps,
    );

    expect(result).toBe("broken");
    expect(session.state.backend_state).toBe("broken");
    expect(deps.requestCodexAutoRecovery).not.toHaveBeenCalled();
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "error",
      message: "Codex initialization failed: no rollout found",
    });
  });

  it.each([
    "Error: error loading default config after config error: No such file or directory (os error 2)",
    'MCP server "codex_apps" startup failed during initialize',
    "rmcp::transport::worker quit with fatal: Transport channel closed",
    "TokenRefreshFailed while starting MCP server",
    "OAuth refresh failed: invalid_grant",
  ])("treats actionable transport-close init stderr as terminal: %s", (stderr) => {
    // Some startup failures are reported as Transport closed but include a real
    // local configuration or auth/MCP problem in stderr. Those should stay
    // visible instead of being hidden behind transient restart recovery.
    const adapter = { id: "adapter-1" };
    const session = makeSession([]);
    session.codexAdapter = adapter as any;
    (session as any).codexAutoRecoveryReason = "browser_open_dead_backend";
    const deps = makeRecoveryDeps();
    const error = `Codex initialization failed: Transport closed. Stderr: ${stderr}`;

    const result = handleCodexAdapterInitError(session.id, session, adapter, error, deps);

    expect(result).toBe("broken");
    expect(session.state.backend_state).toBe("broken");
    expect(deps.requestCodexAutoRecovery).not.toHaveBeenCalled();
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "error",
      message: error,
    });
  });
});
