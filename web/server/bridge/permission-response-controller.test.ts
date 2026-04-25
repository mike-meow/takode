import { describe, expect, it, vi } from "vitest";

// Mock settings-rule-matcher so tests don't depend on the host's ~/.claude/settings.json.
// Without this, a real Bash(*) allow rule would auto-approve permissions that the test
// expects to land in pendingPermissions.
vi.mock("./settings-rule-matcher.js", () => ({
  shouldSettingsRuleApprove: vi.fn(async () => null),
}));

import {
  handleCodexPermissionRequest,
  handleControlRequest,
  handleSetModel,
  handlePermissionResponse,
  routeBrowserMessage,
  handleSdkPermissionRequest,
  routeAdapterBrowserMessage,
  type AdapterBrowserRoutingDeps,
  type AdapterBrowserRoutingSessionLike,
} from "./adapter-browser-routing-controller.js";
import { LONG_SLEEP_REMINDER_TEXT } from "./bash-sleep-policy.js";
import type { PermissionRequest } from "../session-types.js";

function makeSession(): AdapterBrowserRoutingSessionLike {
  return {
    id: "s1",
    backendType: "claude",
    state: {
      askPermission: true,
      backend_error: null,
      backend_state: "connected",
      codex_rate_limits: undefined,
      codex_image_send_stage: null,
      codex_reasoning_effort: undefined,
      codex_token_details: undefined,
      context_used_percent: 0,
      cwd: "/tmp/session",
      is_compacting: false,
      model: "sonnet",
      num_turns: 0,
      permissionMode: "acceptEdits",
      session_id: "cli-s1",
      slash_commands: [],
      total_cost_usd: 0,
      uiMode: "agent",
    },
    messageHistory: [],
    pendingPermissions: new Map<string, PermissionRequest>(),
    evaluatingAborts: new Map(),
    pendingMessages: [],
    pendingCodexTurns: [],
    pendingCodexInputs: [],
    forceCompactPending: false,
    isGenerating: false,
    lastUserMessageDateTag: "",
    lastOutboundUserNdjson: null,
    consecutiveAdapterFailures: 0,
    codexAdapter: null,
    claudeSdkAdapter: null,
  };
}

function makeDeps(): AdapterBrowserRoutingDeps {
  return {
    sendToCLI: vi.fn(() => null),
    broadcastToBrowsers: vi.fn(),
    emitTakodeEvent: vi.fn(),
    persistSession: vi.fn(),
    sessionNotificationDeps: {
      isHerdedWorkerSession: vi.fn(() => false),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      scheduleNotification: vi.fn(),
      cancelPermissionNotification: vi.fn(),
    },
    onAgentPaused: vi.fn(),
    getCurrentTurnTriggerSource: vi.fn(() => "user" as const),
    abortAutoApproval: vi.fn(),
    preInterrupt: vi.fn(),
    touchUserMessage: vi.fn(),
    formatVsCodeSelectionPrompt: vi.fn(() => ""),
    getCliSessionId: vi.fn(() => "cli-s1"),
    nextUserMessageId: vi.fn(() => "user-1"),
    markRunningFromUserDispatch: vi.fn(() => null),
    trackUserMessageForTurn: vi.fn(),
    setGenerating: vi.fn(),
    broadcastStatusChange: vi.fn(),
    setCodexImageSendStage: vi.fn(),
    notifyImageSendFailure: vi.fn(),
    isHerdEventSource: vi.fn(() => false),
    onSessionActivityStateChanged: vi.fn(),
    markTurnInterrupted: vi.fn(),
    armCodexFreshTurnRequirement: vi.fn(),
    clearCodexFreshTurnRequirement: vi.fn(),
    addPendingCodexInput: vi.fn(),
    getCancelablePendingCodexInputs: vi.fn(() => []),
    removePendingCodexInput: vi.fn(() => null),
    clearQueuedTurnLifecycleEntries: vi.fn(),
    queueCodexPendingStartBatch: vi.fn(),
    rebuildQueuedCodexPendingStartBatch: vi.fn(),
    trySteerPendingCodexInputs: vi.fn(() => false),
    sendToBrowser: vi.fn(),
    getLauncherSessionInfo: vi.fn(() => ({})),
    requestCodexIntentionalRelaunch: vi.fn(),
    onPermissionModeChanged: vi.fn(),
    sendControlRequest: vi.fn(),
    requestCodexAutoRecovery: vi.fn(() => false),
    requestCliRelaunch: vi.fn(),
    injectUserMessage: vi.fn((): "sent" => "sent"),
    handleSetModel: vi.fn(),
    handleCodexSetModel: vi.fn(),
    handleSetPermissionMode: vi.fn(),
    handleCodexSetPermissionMode: vi.fn(),
    handleCodexSetReasoningEffort: vi.fn(),
    handleSetAskPermission: vi.fn(),
    handleInterruptFallback: vi.fn(),
  };
}

describe("permission response handling in browser routing", () => {
  // ExitPlanMode approval is special: besides recording the approval message,
  // it must transition the session back into execution mode and resume running state.
  it("records a notable approval and triggers ExitPlanMode follow-up", () => {
    const session = makeSession();
    session.pendingPermissions.set("req-1", {
      request_id: "req-1",
      tool_name: "ExitPlanMode",
      input: {},
      tool_use_id: "tool-1",
      timestamp: 1,
    });
    const deps = makeDeps();

    handlePermissionResponse(
      session,
      {
        type: "permission_response",
        request_id: "req-1",
        behavior: "allow",
      },
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_approved" }));
    expect(deps.handleSetPermissionMode).toHaveBeenCalledWith(session, "acceptEdits");
    expect(deps.setGenerating).toHaveBeenCalledWith(session, true, "exit_plan_mode");
    expect(deps.broadcastStatusChange).toHaveBeenCalledWith(session, "running");
  });

  // ExitPlanMode denial should keep an explicit denial artifact and route the
  // fallback interrupt with the actor-derived source through the merged controller.
  it("records a denial and routes ExitPlanMode interrupt fallback", () => {
    const session = makeSession();
    session.pendingPermissions.set("req-2", {
      request_id: "req-2",
      tool_name: "ExitPlanMode",
      input: {},
      tool_use_id: "tool-2",
      timestamp: 1,
    });
    const deps = makeDeps();

    handlePermissionResponse(
      session,
      {
        type: "permission_response",
        request_id: "req-2",
        behavior: "deny",
      },
      deps,
      "actor-1",
    );

    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));
    expect(deps.handleInterruptFallback).toHaveBeenCalledWith(session, "leader");
    expect(deps.emitTakodeEvent).toHaveBeenCalledWith(
      "s1",
      "permission_resolved",
      { tool_name: "ExitPlanMode", outcome: "denied" },
      "actor-1",
    );
  });

  it("injects a follow-up user message when ExitPlanMode denial includes extra feedback", () => {
    const session = makeSession();
    session.pendingPermissions.set("req-2b", {
      request_id: "req-2b",
      tool_name: "ExitPlanMode",
      input: {},
      tool_use_id: "tool-2b",
      timestamp: 1,
    });
    const deps = makeDeps();

    handlePermissionResponse(
      session,
      {
        type: "permission_response",
        request_id: "req-2b",
        behavior: "deny",
        message: "Keep planning around the websocket error path",
      },
      deps,
    );

    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));
    expect(deps.injectUserMessage).toHaveBeenCalledWith(
      "s1",
      "Keep planning around the websocket error path",
      undefined,
    );
  });

  it("updates launcher session model when Claude model changes", () => {
    const session = makeSession();
    const launcherInfo = { model: "claude-sonnet-4-5-20250929" };
    const deps = makeDeps();
    deps.getLauncherSessionInfo = vi.fn(() => launcherInfo);

    handleSetModel(session, "claude-opus-4-5-20250929", deps);

    expect(session.state.model).toBe("claude-opus-4-5-20250929");
    expect(launcherInfo.model).toBe("claude-opus-4-5-20250929");
    expect(deps.sendToCLI).toHaveBeenCalledWith(session, expect.stringContaining('"subtype":"set_model"'));
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ model: "claude-opus-4-5-20250929" }),
      }),
    );
  });

  it("does not inject a follow-up user message for the default ExitPlanMode denial text", () => {
    const session = makeSession();
    session.pendingPermissions.set("req-2c", {
      request_id: "req-2c",
      tool_name: "ExitPlanMode",
      input: {},
      tool_use_id: "tool-2c",
      timestamp: 1,
    });
    const deps = makeDeps();

    handlePermissionResponse(
      session,
      {
        type: "permission_response",
        request_id: "req-2c",
        behavior: "deny",
        message: "Denied by user",
      },
      deps,
    );

    expect(deps.injectUserMessage).not.toHaveBeenCalled();
  });

  it("auto-rejects pending ExitPlanMode before /compact interception returns early", async () => {
    const session = makeSession();
    session.pendingPermissions.set("req-compact", {
      request_id: "req-compact",
      tool_name: "ExitPlanMode",
      input: { plan: "## Plan\n\n1. Compact later" },
      tool_use_id: "tool-compact",
      timestamp: 1,
    });
    const deps = makeDeps();

    await routeBrowserMessage(
      session as any,
      {
        type: "user_message",
        content: "/compact",
      },
      undefined,
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.slice(-2).map((entry) => entry.type)).toEqual(["permission_denied", "user_message"]);
    expect(deps.handleInterruptFallback).toHaveBeenCalledWith(session, "user");
    expect(deps.broadcastToBrowsers).toHaveBeenNthCalledWith(
      1,
      session,
      expect.objectContaining({
        type: "permission_denied",
        request_id: "req-compact",
      }),
    );
    expect(deps.broadcastToBrowsers).toHaveBeenNthCalledWith(
      2,
      session,
      expect.objectContaining({
        type: "user_message",
        content: "/compact",
      }),
    );
    expect(deps.broadcastStatusChange).toHaveBeenCalledWith(session, "compacting");
    expect(deps.requestCliRelaunch).toHaveBeenCalledWith("s1");
  });

  it("auto-rejects pending ExitPlanMode before delivering a fresh leader message", async () => {
    const session = makeSession();
    session.pendingPermissions.set("req-leader-message", {
      request_id: "req-leader-message",
      tool_name: "ExitPlanMode",
      input: { plan: "## Plan\n\n1. Implement later" },
      tool_use_id: "tool-leader-message",
      timestamp: 1,
    });
    const deps = makeDeps();

    await routeBrowserMessage(
      session as any,
      {
        type: "user_message",
        content: "Implement now",
        agentSource: { sessionId: "leader-7", sessionLabel: "#7 Leader" },
      },
      undefined,
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.slice(-2).map((entry) => entry.type)).toEqual(["permission_denied", "user_message"]);
    expect(deps.handleInterruptFallback).toHaveBeenCalledWith(session, "leader");
    expect(deps.emitTakodeEvent).toHaveBeenCalledWith(
      "s1",
      "permission_resolved",
      { tool_name: "ExitPlanMode", outcome: "denied" },
      "leader-7",
    );

    const sendCalls = (deps.sendToCLI as any).mock.calls.map(([targetSession, payload]: [unknown, string]) => [
      targetSession,
      JSON.parse(payload),
    ]);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]).toEqual([
      session,
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "req-leader-message",
          response: expect.objectContaining({
            behavior: "deny",
            message: "Plan rejected — leader sent a new message",
          }),
        }),
      }),
    ]);
    expect(sendCalls[1]).toEqual([
      session,
      expect.objectContaining({
        type: "user",
        message: expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Implement now"),
        }),
      }),
    ]);
  });

  it("auto-answers pending AskUserQuestion from a fresh leader message instead of sending a new turn", async () => {
    const session = makeSession();
    session.pendingPermissions.set("req-leader-question", {
      request_id: "req-leader-question",
      tool_name: "AskUserQuestion",
      input: {
        questions: [{ question: "Which rollout?", options: [{ label: "Staged" }, { label: "Immediate" }] }],
      },
      tool_use_id: "tool-leader-question",
      timestamp: 1,
    });
    const deps = makeDeps();

    await routeBrowserMessage(
      session as any,
      {
        type: "user_message",
        content: "Use staged rollout",
        agentSource: { sessionId: "leader-7", sessionLabel: "#7 Leader" },
      },
      undefined,
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toEqual(
      expect.objectContaining({
        type: "permission_approved",
        request_id: "req-leader-question",
        tool_name: "AskUserQuestion",
        answers: [{ question: "Which rollout?", answer: "Use staged rollout" }],
      }),
    );
    expect(deps.emitTakodeEvent).toHaveBeenCalledWith(
      "s1",
      "permission_resolved",
      { tool_name: "AskUserQuestion", outcome: "approved" },
      "leader-7",
    );

    const sendCalls = (deps.sendToCLI as any).mock.calls.map(([targetSession, payload]: [unknown, string]) => [
      targetSession,
      JSON.parse(payload),
    ]);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]).toEqual([
      session,
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "req-leader-question",
          response: expect.objectContaining({
            behavior: "allow",
            updatedInput: {
              questions: [{ question: "Which rollout?", options: [{ label: "Staged" }, { label: "Immediate" }] }],
              answers: { "0": "Use staged rollout" },
            },
          }),
        }),
      }),
    ]);
  });

  it("clears Codex permission notifications and action attention before denial side effects", () => {
    const session = makeSession();
    session.backendType = "codex";
    (session as any).attentionReason = "action";
    const codexAdapter = {
      sendBrowserMessage: vi.fn(),
      getCurrentTurnId: vi.fn(() => "turn-codex"),
      isConnected: vi.fn(() => true),
    };
    session.codexAdapter = codexAdapter as any;
    session.pendingPermissions.set("req-codex", {
      request_id: "req-codex",
      tool_name: "ExitPlanMode",
      input: {},
      tool_use_id: "tool-codex",
      timestamp: 1,
    });
    const deps = makeDeps();

    routeAdapterBrowserMessage(
      session,
      {
        type: "permission_response",
        request_id: "req-codex",
        behavior: "deny",
      },
      null,
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect((session as any).attentionReason).toBeNull();
    expect(deps.sessionNotificationDeps.cancelPermissionNotification).toHaveBeenCalledWith("s1", "req-codex");
    expect(deps.sessionNotificationDeps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "session_update",
        session: { attentionReason: null },
      }),
    );
    expect(deps.markTurnInterrupted).toHaveBeenCalledWith(session, "user");
    expect(deps.armCodexFreshTurnRequirement).toHaveBeenCalledWith(session, "turn-codex", "exit_plan_mode_denied");
    expect(codexAdapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "interrupt",
        interruptSource: "user",
      }),
    );
    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));

    const cancelOrder = (deps.sessionNotificationDeps.cancelPermissionNotification as any).mock.invocationCallOrder[0];
    const attentionBroadcastOrder = (deps.sessionNotificationDeps.broadcastToBrowsers as any).mock
      .invocationCallOrder[0];
    const interruptOrder = (codexAdapter.sendBrowserMessage as any).mock.invocationCallOrder[0];
    const takodeOrder = (deps.emitTakodeEvent as any).mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(interruptOrder);
    expect(attentionBroadcastOrder).toBeLessThan(interruptOrder);
    expect(cancelOrder).toBeLessThan(takodeOrder);
    expect(attentionBroadcastOrder).toBeLessThan(takodeOrder);
  });

  it("preserves request_id on Codex permission history artifacts so pending UI can clear", () => {
    const session = makeSession();
    session.backendType = "codex";
    session.pendingPermissions.set("req-codex-allow", {
      request_id: "req-codex-allow",
      tool_name: "ExitPlanMode",
      input: {},
      tool_use_id: "tool-codex-allow",
      timestamp: 1,
    });
    const deps = makeDeps();

    routeAdapterBrowserMessage(
      session,
      {
        type: "permission_response",
        request_id: "req-codex-allow",
        behavior: "allow",
      },
      null,
      deps,
    );

    expect(session.messageHistory.at(-1)).toEqual(
      expect.objectContaining({
        type: "permission_approved",
        request_id: "req-codex-allow",
      }),
    );
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "permission_approved",
        request_id: "req-codex-allow",
      }),
    );
  });

  it("preserves actorSessionId on Codex permission_resolved events", () => {
    const session = makeSession();
    session.backendType = "codex";
    session.pendingPermissions.set("req-codex-actor", {
      request_id: "req-codex-actor",
      tool_name: "Bash",
      input: { command: "pwd" },
      tool_use_id: "tool-codex-actor",
      timestamp: 1,
    });
    const deps = makeDeps();

    routeAdapterBrowserMessage(
      session,
      {
        type: "permission_response",
        request_id: "req-codex-actor",
        behavior: "deny",
        actorSessionId: "leader-9",
      },
      null,
      deps,
    );

    expect(deps.emitTakodeEvent).toHaveBeenCalledWith(
      "s1",
      "permission_resolved",
      { tool_name: "Bash", outcome: "denied" },
      "leader-9",
    );
  });

  // SDK ExitPlanMode approval: verifies that handleSdkPermissionResponse
  // clears the bridge-level pendingPermissions, resolves the adapter promise,
  // broadcasts the approval to browsers, and transitions into execution mode.
  it("approves ExitPlanMode for claude-sdk sessions via the adapter path", () => {
    const session = makeSession();
    session.backendType = "claude-sdk";
    session.state.askPermission = true;
    const sdkAdapter = {
      sendBrowserMessage: vi.fn(() => true),
      isConnected: vi.fn(() => true),
    };
    session.claudeSdkAdapter = sdkAdapter as any;
    session.pendingPermissions.set("req-sdk-plan", {
      request_id: "req-sdk-plan",
      tool_name: "ExitPlanMode",
      input: { plan: "my plan" },
      tool_use_id: "tool-sdk-plan",
      timestamp: 1,
    });
    const deps = makeDeps();

    routeAdapterBrowserMessage(
      session,
      {
        type: "permission_response",
        request_id: "req-sdk-plan",
        behavior: "allow",
        updated_input: { plan: "my plan" },
        actorSessionId: "leader-10",
      },
      null,
      deps,
    );

    // Bridge-level permission cleared
    expect(session.pendingPermissions.size).toBe(0);
    // Adapter received the permission_response
    expect(sdkAdapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission_response",
        request_id: "req-sdk-plan",
        behavior: "allow",
      }),
    );
    // Approval broadcast to browsers
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "permission_approved",
        request_id: "req-sdk-plan",
        tool_name: "ExitPlanMode",
      }),
    );
    // Transitions into execution mode
    expect(deps.handleSetPermissionMode).toHaveBeenCalledWith(session, "acceptEdits");
    expect(deps.setGenerating).toHaveBeenCalledWith(session, true, "exit_plan_mode");
    expect(deps.broadcastStatusChange).toHaveBeenCalledWith(session, "running");
    // Persisted
    expect(deps.persistSession).toHaveBeenCalledWith(session);
  });

  it("immediately denies long sleep can_use_tool requests and injects the timer reminder", () => {
    const session = makeSession();
    const deps = makeDeps();

    handleControlRequest(
      session,
      {
        type: "control_request",
        request_id: "req-sleep",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo hi && sleep 61" },
          tool_use_id: "tool-sleep",
        },
      } as any,
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));
    expect(deps.sendToCLI).toHaveBeenCalledWith(session, expect.stringContaining('"behavior":"deny"'));
    expect(deps.injectUserMessage).toHaveBeenCalledWith("s1", LONG_SLEEP_REMINDER_TEXT, {
      sessionId: "system:long-sleep-guard",
      sessionLabel: "System",
    });
  });

  it("immediately denies backgrounded long sleep can_use_tool requests", () => {
    const session = makeSession();
    const deps = makeDeps();

    handleControlRequest(
      session,
      {
        type: "control_request",
        request_id: "req-sleep-background",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "sleep 61 & echo hi" },
          tool_use_id: "tool-sleep-background",
        },
      } as any,
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));
    expect(deps.sendToCLI).toHaveBeenCalledWith(session, expect.stringContaining('"behavior":"deny"'));
    expect(deps.injectUserMessage).toHaveBeenCalledWith("s1", LONG_SLEEP_REMINDER_TEXT, {
      sessionId: "system:long-sleep-guard",
      sessionLabel: "System",
    });
  });

  it("immediately denies long sleep SDK permission requests", () => {
    const session = makeSession();
    session.backendType = "claude-sdk";
    session.claudeSdkAdapter = {
      sendBrowserMessage: vi.fn(() => true),
      isConnected: vi.fn(() => true),
    };
    const deps = makeDeps();

    handleSdkPermissionRequest(
      session,
      {
        request_id: "req-sdk-sleep",
        tool_name: "Bash",
        input: { command: "sleep 61" },
        tool_use_id: "tool-sdk-sleep",
        timestamp: Date.now(),
      },
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));
    expect(session.claudeSdkAdapter?.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission_response",
        request_id: "req-sdk-sleep",
        behavior: "deny",
      }),
    );
    expect(deps.injectUserMessage).toHaveBeenCalledWith("s1", LONG_SLEEP_REMINDER_TEXT, {
      sessionId: "system:long-sleep-guard",
      sessionLabel: "System",
    });
  });

  it("immediately denies wrapper-option long sleep SDK permission requests", () => {
    const session = makeSession();
    session.backendType = "claude-sdk";
    session.claudeSdkAdapter = {
      sendBrowserMessage: vi.fn(() => true),
      isConnected: vi.fn(() => true),
    };
    const deps = makeDeps();

    handleSdkPermissionRequest(
      session,
      {
        request_id: "req-sdk-sleep-wrapper",
        tool_name: "Bash",
        input: { command: "time -p sleep 61" },
        tool_use_id: "tool-sdk-sleep-wrapper",
        timestamp: Date.now(),
      },
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));
    expect(session.claudeSdkAdapter?.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission_response",
        request_id: "req-sdk-sleep-wrapper",
        behavior: "deny",
      }),
    );
  });

  it("does not deny short sleep SDK permission requests with file-descriptor redirections", async () => {
    const session = makeSession();
    session.backendType = "claude-sdk";
    session.claudeSdkAdapter = {
      sendBrowserMessage: vi.fn(() => true),
      isConnected: vi.fn(() => true),
    };
    const deps = makeDeps();

    await handleSdkPermissionRequest(
      session,
      {
        request_id: "req-sdk-sleep-redirect",
        tool_name: "Bash",
        input: { command: "sleep 60 2>/tmp/err" },
        tool_use_id: "tool-sdk-sleep-redirect",
        timestamp: Date.now(),
      },
      deps,
    );

    expect(session.pendingPermissions.has("req-sdk-sleep-redirect")).toBe(true);
    expect(session.messageHistory.some((entry) => entry.type === "permission_denied")).toBe(false);
    expect(session.claudeSdkAdapter?.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission_response",
        request_id: "req-sdk-sleep-redirect",
        behavior: "deny",
      }),
    );
  });

  it("immediately denies long sleep Codex permission requests", () => {
    const session = makeSession();
    session.backendType = "codex";
    session.codexAdapter = {
      sendBrowserMessage: vi.fn(() => true),
      getCurrentTurnId: vi.fn(() => "turn-codex"),
      isConnected: vi.fn(() => true),
    };
    const deps = makeDeps();

    handleCodexPermissionRequest(
      session,
      {
        request_id: "req-codex-sleep",
        tool_name: "Bash",
        input: { command: "sleep 1m 1s" },
        tool_use_id: "tool-codex-sleep",
        timestamp: Date.now(),
      },
      deps,
    );

    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));
    expect(session.codexAdapter?.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission_response",
        request_id: "req-codex-sleep",
        behavior: "deny",
      }),
    );
    expect(deps.injectUserMessage).toHaveBeenCalledWith("s1", LONG_SLEEP_REMINDER_TEXT, {
      sessionId: "system:long-sleep-guard",
      sessionLabel: "System",
    });
  });

  it("answers Codex /status from server state without queueing a Codex turn", async () => {
    const session = makeSession();
    session.backendType = "codex";
    session.state.model = "gpt-5.5";
    session.state.cwd = "/repo/project";
    session.state.context_used_percent = 41;
    session.state.codex_reasoning_effort = "high";
    session.state.num_turns = 7;
    session.state.total_cost_usd = 1.25;
    session.state.codex_token_details = {
      inputTokens: 1_150_000,
      outputTokens: 50_000,
      cachedInputTokens: 930_000,
      reasoningOutputTokens: 2_000,
      modelContextWindow: 258_400,
    };
    session.state.codex_rate_limits = {
      primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: 1_700_000_000_000 },
      secondary: null,
    };
    session.codexAdapter = {
      sendBrowserMessage: vi.fn(() => true),
      getCurrentTurnId: vi.fn(() => null),
      isConnected: vi.fn(() => true),
    };
    const deps = makeDeps();

    await routeBrowserMessage(
      session as any,
      {
        type: "user_message",
        content: "/status",
      },
      undefined,
      deps,
    );

    expect(session.messageHistory.map((entry) => entry.type)).toEqual(["user_message", "assistant", "result"]);
    expect(deps.broadcastToBrowsers).toHaveBeenNthCalledWith(
      1,
      session,
      expect.objectContaining({
        type: "user_message",
        content: "/status",
      }),
    );
    expect(deps.broadcastToBrowsers).toHaveBeenNthCalledWith(
      2,
      session,
      expect.objectContaining({
        type: "assistant",
        message: expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("Codex status"),
            }),
          ],
        }),
      }),
    );
    const statusText = ((session.messageHistory[1] as any).message.content[0].text ?? "") as string;
    expect(statusText).toContain("Context: 41% used (258.4k window)");
    expect(statusText).toContain("Tokens: 1.1M input, 930.0k cached, 50.0k output, 2.0k reasoning");
    expect(statusText).toContain("Rate limits: primary 62% of 5h window");
    expect(statusText).toContain("Reasoning effort: high");
    expect(session.messageHistory[2]).toEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          subtype: "success",
          is_error: false,
          num_turns: 7,
          total_cost_usd: 1.25,
        }),
      }),
    );
    expect(deps.queueCodexPendingStartBatch).not.toHaveBeenCalled();
    expect(session.codexAdapter.sendBrowserMessage).not.toHaveBeenCalled();
  });

  it("does not emit a synthetic terminal result for Codex /status during an active turn", async () => {
    const session = makeSession();
    session.backendType = "codex";
    session.isGenerating = true;
    session.state.model = "gpt-5.5";
    session.state.cwd = "/repo/project";
    session.state.context_used_percent = 41;
    session.codexAdapter = {
      sendBrowserMessage: vi.fn(() => true),
      getCurrentTurnId: vi.fn(() => "turn-live"),
      isConnected: vi.fn(() => true),
    };
    const deps = makeDeps();

    await routeBrowserMessage(
      session as any,
      {
        type: "user_message",
        content: "/status",
      },
      undefined,
      deps,
    );

    expect(session.messageHistory.map((entry) => entry.type)).toEqual(["user_message", "assistant"]);
    expect(deps.broadcastToBrowsers).toHaveBeenNthCalledWith(
      1,
      session,
      expect.objectContaining({
        type: "user_message",
        content: "/status",
      }),
    );
    expect(deps.broadcastToBrowsers).toHaveBeenNthCalledWith(
      2,
      session,
      expect.objectContaining({
        type: "assistant",
      }),
    );
    expect(deps.broadcastToBrowsers).not.toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "result",
      }),
    );
    expect(deps.setGenerating).not.toHaveBeenCalled();
    expect(session.codexAdapter.sendBrowserMessage).not.toHaveBeenCalled();
  });
});
