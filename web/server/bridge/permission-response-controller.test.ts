import { describe, expect, it, vi } from "vitest";
import {
  handlePermissionResponse,
  routeAdapterBrowserMessage,
  type AdapterBrowserRoutingDeps,
  type AdapterBrowserRoutingSessionLike,
} from "./adapter-browser-routing-controller.js";
import type { PermissionRequest } from "../session-types.js";

function makeSession(): AdapterBrowserRoutingSessionLike {
  return {
    id: "s1",
    backendType: "claude",
    state: {
      askPermission: true,
      backend_error: null,
      backend_state: "connected",
      codex_image_send_stage: null,
      codex_reasoning_effort: undefined,
      cwd: "/tmp/session",
      is_compacting: false,
      model: "sonnet",
      permissionMode: "acceptEdits",
      session_id: "cli-s1",
      slash_commands: [],
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
    expect(deps.armCodexFreshTurnRequirement).toHaveBeenCalledWith(
      session,
      "turn-codex",
      "exit_plan_mode_denied",
    );
    expect(codexAdapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "interrupt",
        interruptSource: "user",
      }),
    );
    expect(session.messageHistory.at(-1)).toEqual(expect.objectContaining({ type: "permission_denied" }));

    const cancelOrder = (deps.sessionNotificationDeps.cancelPermissionNotification as any).mock.invocationCallOrder[0];
    const attentionBroadcastOrder = (deps.sessionNotificationDeps.broadcastToBrowsers as any).mock.invocationCallOrder[0];
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
});
