import { describe, expect, it, vi } from "vitest";
import {
  handlePermissionResponse,
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
    setAttentionAction: vi.fn(),
    schedulePermissionNotification: vi.fn(),
    broadcastAutoApproval: vi.fn(),
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
    clearActionAttentionIfNoPermissions: vi.fn(),
    cancelPermissionNotification: vi.fn(),
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
    browserTransportDeps: {
      refreshGitInfoThenRecomputeDiff: vi.fn(),
      prefillSlashCommands: vi.fn(),
      getTreeGroupState: vi.fn(async () => ({ groups: [], assignments: {}, nodeOrder: {} })),
      getVsCodeSelectionState: vi.fn(() => null),
      getLauncherSessionInfo: vi.fn(() => null),
      backendAttached: vi.fn(() => false),
      backendConnected: vi.fn(() => false),
      requestCodexAutoRecovery: vi.fn(() => false),
      requestCliRelaunch: vi.fn(),
      getRouteChain: vi.fn(() => undefined),
      setRouteChain: vi.fn(),
      clearRouteChain: vi.fn(),
      routeBrowserMessage: vi.fn(),
      notifyImageSendFailure: vi.fn(),
      broadcastError: vi.fn(),
      queueCodexPendingStartBatch: vi.fn(),
      deriveBackendState: vi.fn(() => "connected" as const),
      getBoard: vi.fn(() => []),
      getCompletedBoard: vi.fn(() => []),
      recoverToolStartTimesFromHistory: vi.fn(),
      finalizeRecoveredDisconnectedTerminalTools: vi.fn(),
      scheduleCodexToolResultWatchdogs: vi.fn(),
      recomputeAndBroadcastHistoryBytes: vi.fn(),
      listTimers: vi.fn(() => []),
      persistSession: vi.fn(),
      recordOutgoingRaw: vi.fn(),
      eventBufferLimit: 100,
      getSessions: vi.fn(() => []),
      windowStaleMs: 1_000,
      openFileTimeoutMs: 1_000,
    },
    handleVsCodeSelectionUpdate: vi.fn(),
    idempotentMessageTypes: new Set<string>(),
    processedClientMsgIdLimit: 100,
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
});
