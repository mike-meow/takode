import { describe, expect, it, vi } from "vitest";
import { handleResultMessage, type ResultMessageSessionLike } from "./claude-message-controller.js";
import type { BrowserIncomingMessage, CLIResultMessage, PermissionRequest, SessionState } from "../session-types.js";
import { THREAD_ROUTING_REMINDER_SOURCE_ID } from "../../shared/thread-routing-reminder.js";

function makeState(): ResultMessageSessionLike["state"] {
  return {
    model: "claude-sonnet-4-5-20250929",
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    claude_token_details: undefined,
  };
}

function makeSession(): ResultMessageSessionLike {
  return {
    id: "s1",
    backendType: "claude",
    cliResuming: false,
    messageHistory: [],
    state: makeState(),
    diffStatsDirty: false,
    generationStartedAt: undefined,
    interruptedDuringTurn: false,
    queuedTurnStarts: 0,
    queuedTurnInterruptSources: [],
    userMessageIdsThisTurn: [],
    isGenerating: false,
    lastOutboundUserNdjson: null,
    pendingPermissions: new Map<string, PermissionRequest>(),
    toolStartTimes: new Map(),
  };
}

function makeResult(overrides: Partial<CLIResultMessage> = {}): CLIResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 1,
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    uuid: "result-1",
    session_id: "s1",
    ...overrides,
  };
}

function makeDeps() {
  return {
    hasResultReplay: vi.fn(() => false),
    reconcileReplayState: vi.fn(() => ({ clearedResidualState: false })),
    drainInlineQueuedClaudeTurns: vi.fn(() => false),
    markTurnInterrupted: vi.fn(),
    getCurrentTurnTriggerSource: vi.fn(() => "user" as const),
    reconcileTerminalResultState: vi.fn(),
    finalizeOrphanedTerminalToolsOnResult: vi.fn(),
    refreshGitInfoThenRecomputeDiff: vi.fn(),
    broadcastToBrowsers: vi.fn(),
    persistSession: vi.fn(),
    freezeHistoryThroughCurrentTail: vi.fn(),
    cancelPermissionNotification: vi.fn(),
    onSessionActivityStateChanged: vi.fn(),
    onResultAttentionAndNotifications: vi.fn(),
    onTurnCompleted: vi.fn(),
    injectUserMessage: vi.fn(),
  };
}

describe("result-message-controller", () => {
  // Replayed terminal results after reconnect should only reconcile lifecycle drift;
  // they must not append duplicate result history or retrigger normal completion flow.
  it("reconciles replayed results without appending duplicate history", () => {
    const session = makeSession();
    const deps = makeDeps();
    deps.hasResultReplay.mockReturnValue(true);
    deps.reconcileReplayState.mockReturnValue({ clearedResidualState: true });

    handleResultMessage(session, makeResult(), deps);

    expect(session.messageHistory).toHaveLength(0);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, { type: "status_change", status: "idle" });
    expect(deps.persistSession).toHaveBeenCalledWith(session);
    expect(deps.onTurnCompleted).not.toHaveBeenCalled();
  });

  // Covers the normal result path where stale pending permissions are cancelled,
  // the result is persisted, and downstream notification hooks still fire once.
  it("appends the result, clears stale permissions, and notifies downstream handlers", () => {
    const session = makeSession();
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "assistant-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1,
    } as BrowserIncomingMessage);
    session.pendingPermissions.set("perm-1", {
      request_id: "perm-1",
      tool_name: "Bash",
      input: { command: "pwd" },
      tool_use_id: "tool-1",
      timestamp: 1,
    });
    const deps = makeDeps();

    handleResultMessage(session, makeResult({ total_cost_usd: 2 }), deps);

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({ total_cost_usd: 2 }),
      }),
    );
    expect(deps.cancelPermissionNotification).toHaveBeenCalledWith("s1", "perm-1");
    expect(deps.onSessionActivityStateChanged).toHaveBeenCalledWith("s1", "result_cleared_permissions");
    expect(deps.onResultAttentionAndNotifications).toHaveBeenCalled();
    expect(deps.onTurnCompleted).toHaveBeenCalledWith(session);
  });

  it("marks Claude user-control diagnostics as interrupted so they do not trigger error handling", () => {
    const session = makeSession();
    const deps = makeDeps();

    handleResultMessage(
      session,
      makeResult({
        subtype: "error_during_execution",
        is_error: true,
        result: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        stop_reason: "tool_use",
      }),
      deps,
    );

    expect(session.messageHistory.at(-1)).toEqual(
      expect.objectContaining({
        type: "result",
        interrupted: true,
        data: expect.objectContaining({
          is_error: true,
          stop_reason: "tool_use",
        }),
      }),
    );
    expect(deps.onResultAttentionAndNotifications).not.toHaveBeenCalled();
    expect(deps.onTurnCompleted).toHaveBeenCalledWith(session);
    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("injects a synthetic thread-routing reminder after unrouted leader output", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "u-q970",
        content: "continue in quest thread",
        timestamp: 1,
        threadKey: "q-970",
        questId: "q-970",
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-thread",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Unrouted leader response" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          rawContent: "Unrouted leader response",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("[Thread routing reminder]"),
      { sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID, sessionLabel: "Thread Routing Reminder" },
      undefined,
      {
        threadKey: "q-970",
        questId: "q-970",
        threadRefs: [{ threadKey: "q-970", questId: "q-970", source: "explicit" }],
      },
    );
    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("Missing thread marker"),
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  it("does not recursively inject thread-routing reminders for reminder-triggered turns", () => {
    const session = makeSession();
    session.messageHistory.push(
      {
        type: "user_message",
        id: "thread-routing-reminder-1",
        content: "[Thread routing reminder]\nMissing thread marker.",
        timestamp: 1,
        threadKey: "main",
        agentSource: { sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID, sessionLabel: "Thread Routing Reminder" },
      } as BrowserIncomingMessage,
      {
        type: "assistant",
        message: {
          id: "assistant-missing-thread-after-reminder",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Still unrouted" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 2,
        threadRoutingError: {
          reason: "missing",
          expected: "Start with [thread:main] or [thread:q-N].",
          rawContent: "Still unrouted",
        },
      } as BrowserIncomingMessage,
    );
    session.userMessageIdsThisTurn = [0];
    const deps = makeDeps();

    handleResultMessage(session, makeResult(), deps);

    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });
});
