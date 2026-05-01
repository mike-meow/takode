import { describe, expect, it, vi } from "vitest";
import {
  handleUserMessage,
  routeAdapterBrowserMessage,
  type AdapterBrowserRoutingDeps,
  type AdapterBrowserRoutingSessionLike,
} from "./adapter-browser-routing-controller.js";
import { deriveActiveTurnRoute } from "./browser-transport-controller.js";
import { commitPendingCodexInputs } from "./codex-recovery-orchestrator.js";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  PermissionRequest,
  SessionNotification,
} from "../session-types.js";

function makeSession(notifications: SessionNotification[] = []): AdapterBrowserRoutingSessionLike {
  return {
    id: "leader-session",
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
      session_id: "cli-leader-session",
      slash_commands: [],
      total_cost_usd: 0,
      uiMode: "agent",
    },
    messageHistory: [],
    notifications,
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

function makeDeps(options: { isOrchestrator?: boolean } = {}): AdapterBrowserRoutingDeps {
  let nextId = 0;
  return {
    sendToCLI: vi.fn(() => "current" as const),
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
    getCliSessionId: vi.fn(() => "cli-leader-session"),
    nextUserMessageId: vi.fn(() => `user-${++nextId}`),
    markRunningFromUserDispatch: vi.fn(() => "current" as const),
    trackUserMessageForTurn: vi.fn(),
    setGenerating: vi.fn(),
    broadcastStatusChange: vi.fn(),
    setCodexImageSendStage: vi.fn(),
    notifyImageSendFailure: vi.fn(),
    isHerdEventSource: vi.fn((agentSource) => agentSource?.sessionId === "herd-events"),
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
    getLauncherSessionInfo: vi.fn(() => ({ isOrchestrator: options.isOrchestrator === true })),
    requestCodexIntentionalRelaunch: vi.fn(),
    onPermissionModeChanged: vi.fn(),
    sendControlRequest: vi.fn(),
    requestCodexAutoRecovery: vi.fn(() => false),
    requestCodexLeaderRecycle: vi.fn(async () => ({ ok: true as const })),
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

function needsInput(id: string, summary: string, timestamp: number, done = false): SessionNotification {
  return {
    id,
    category: "needs-input",
    summary,
    timestamp,
    messageId: null,
    done,
  };
}

function questNeedsInput(
  id: string,
  summary: string,
  timestamp: number,
  questId: string,
  done = false,
): SessionNotification {
  return {
    ...needsInput(id, summary, timestamp, done),
    threadKey: questId,
    questId,
    threadRefs: [{ threadKey: questId, questId, source: "explicit" }],
  };
}

function review(id: string, summary: string, timestamp: number): SessionNotification {
  return {
    id,
    category: "review",
    summary,
    timestamp,
    messageId: null,
    done: false,
  };
}

function userMessage(overrides: Partial<Extract<BrowserOutgoingMessage, { type: "user_message" }>> = {}) {
  return {
    type: "user_message" as const,
    content: "Fresh user message",
    ...overrides,
  };
}

function sentCliContent(deps: AdapterBrowserRoutingDeps): string {
  const raw = vi.mocked(deps.sendToCLI).mock.calls[0]?.[1];
  expect(raw).toBeTypeOf("string");
  return JSON.parse(raw as string).message.content;
}

function installActiveRouteStatusBroadcast(deps: AdapterBrowserRoutingDeps): void {
  deps.markRunningFromUserDispatch = vi.fn((targetSession, _reason, _interruptSource, historyIndex, activeRoute) => {
    targetSession.isGenerating = true;
    (targetSession as AdapterBrowserRoutingSessionLike & { userMessageIdsThisTurn?: number[] }).userMessageIdsThisTurn =
      typeof historyIndex === "number" ? [historyIndex] : [];
    (targetSession as AdapterBrowserRoutingSessionLike & { activeTurnRoute?: typeof activeRoute }).activeTurnRoute =
      activeRoute ?? null;
    deps.broadcastToBrowsers(targetSession, {
      type: "status_change",
      status: "running",
      activeTurnRoute: deriveActiveTurnRoute(targetSession as any),
    });
    return "current" as const;
  });
}

describe("direct user needs-input reminders", () => {
  it("delivers concise reply context while storing reply metadata separately for Claude CLI", async () => {
    const session = makeSession();
    const deps = makeDeps();

    await handleUserMessage(
      session,
      userMessage({
        content: "Continue the work",
        deliveryContent: "[reply] Original answer\n\nContinue the work",
        replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
      }),
      deps,
    );

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Continue the work",
      replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
    });
    expect(sentCliContent(deps)).toContain("[reply] Original answer\n\nContinue the work");
    expect(sentCliContent(deps)).not.toContain("<<<REPLY_TO");
    expect(sentCliContent(deps)).not.toContain("codex-agent-random-id");
  });

  it("passes concise reply delivery content to Claude SDK adapter", async () => {
    const session = makeSession();
    session.backendType = "claude-sdk";
    const sdkAdapter = { sendBrowserMessage: vi.fn(() => true), isConnected: vi.fn(() => true) };
    session.claudeSdkAdapter = sdkAdapter as any;
    const deps = makeDeps({ isOrchestrator: true });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Continue the work",
        deliveryContent: "[reply] Original answer\n\nContinue the work",
        replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
        threadKey: "q-941",
        questId: "q-941",
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(session.messageHistory[0]).toMatchObject({
      content: "Continue the work",
      replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
    });
    expect(sdkAdapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_message",
        content: expect.stringContaining("[reply] Original answer\n\nContinue the work"),
      }),
    );
    expect(sdkAdapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("[thread:q-941]"),
      }),
    );
    expect(sdkAdapter.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("<<<REPLY_TO") }),
    );
  });

  it("broadcasts the routed active turn for Claude SDK quest-thread messages while Main is selected", () => {
    const session = makeSession();
    session.backendType = "claude-sdk";
    session.claudeSdkAdapter = { sendBrowserMessage: vi.fn(() => true), isConnected: vi.fn(() => true) } as any;
    const deps = makeDeps({ isOrchestrator: true });
    installActiveRouteStatusBroadcast(deps);

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Proceed in q-968",
        threadKey: "q-968",
        questId: "q-968",
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(deps.markRunningFromUserDispatch).toHaveBeenCalledWith(session, "user_message", null, 0, {
      threadKey: "q-968",
      questId: "q-968",
    });
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "status_change",
        status: "running",
        activeTurnRoute: { threadKey: "q-968", questId: "q-968" },
      }),
    );
  });

  it("injects a reminder before direct user messages with pending same-session needs-input notifications", async () => {
    // Validates both visible browser history ordering and backend delivery text.
    const session = makeSession([
      needsInput("n-1", "Oldest pending question", 100),
      needsInput("n-2", "Resolved question", 200, true),
      needsInput("n-3", "Third newest pending question", 300),
      review("n-4", "Review-only notification", 400),
      needsInput("n-5", "Second newest pending question", 500),
      needsInput("n-6", "Newest pending question", 600),
    ]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]?.type).toBe("user_message");
    expect(
      (session.messageHistory[0] as Extract<BrowserIncomingMessage, { type: "user_message" }>).agentSource,
    ).toEqual({
      sessionId: "system:needs-input-reminder",
      sessionLabel: "Needs Input Reminder",
    });
    expect(session.messageHistory[1]).toMatchObject({ type: "user_message", content: "Fresh user message" });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining(
        "Unresolved same-session same-thread needs-input notifications (main): 4. Showing newest 3.",
      ),
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.stringContaining("6. Newest pending question") });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("5. Second newest pending question"),
    });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("3. Third newest pending question"),
    });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.not.stringContaining("1. Oldest pending question"),
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Resolved question") });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.not.stringContaining("Review-only notification"),
    });

    const cliContent = sentCliContent(deps);
    expect(cliContent.indexOf("[Needs-input reminder]")).toBeLessThan(cliContent.indexOf("Fresh user message"));
    expect(cliContent).toContain(
      "Unresolved same-session same-thread needs-input notifications (main): 4. Showing newest 3.",
    );
  });

  it("filters direct user reminders to pending needs-input notifications from the same quest thread", async () => {
    // A response in one quest thread must not be polluted by unresolved prompts
    // from Main or a different quest thread.
    const session = makeSession([
      needsInput("n-1", "Main pending question", 100),
      questNeedsInput("n-2", "Current quest question", 200, "q-941"),
      questNeedsInput("n-3", "Other quest question", 300, "q-942"),
      questNeedsInput("n-4", "Resolved current quest question", 400, "q-941", true),
    ]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(
      session,
      userMessage({
        content: "Fresh q-941 reply",
        threadKey: "q-941",
        questId: "q-941",
      }),
      deps,
    );

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("Unresolved same-session same-thread needs-input notifications (q-941): 1."),
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.stringContaining("2. Current quest question") });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Main pending question") });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Other quest question") });
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.not.stringContaining("Resolved current quest question"),
    });
    expect(session.messageHistory[1]).toMatchObject({
      type: "user_message",
      content: "Fresh q-941 reply",
      threadKey: "q-941",
      questId: "q-941",
    });

    const cliContent = sentCliContent(deps);
    expect(cliContent).toContain("Unresolved same-session same-thread needs-input notifications (q-941): 1.");
    expect(cliContent).toContain("2. Current quest question");
    expect(cliContent).not.toContain("Main pending question");
    expect(cliContent).not.toContain("Other quest question");
  });

  it("keeps Main direct user reminders scoped away from pending quest-thread needs-input notifications", async () => {
    // Legacy notifications without route metadata behave as Main-scoped; they
    // should remain visible in Main without leaking quest-thread prompts there.
    const session = makeSession([
      needsInput("n-1", "Main pending question", 100),
      questNeedsInput("n-2", "Quest pending question", 200, "q-941"),
    ]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage({ content: "Fresh Main reply" }), deps);

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("Unresolved same-session same-thread needs-input notifications (main): 1."),
      threadKey: "main",
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.stringContaining("1. Main pending question") });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Quest pending question") });

    const cliContent = sentCliContent(deps);
    expect(cliContent).toContain("1. Main pending question");
    expect(cliContent).not.toContain("Quest pending question");
  });

  it("does not inject a reminder when the current leader session has no pending needs-input notifications", async () => {
    // The helper must not inspect unrelated sessions or global state; only this session's inbox matters.
    const unrelatedSession = makeSession([needsInput("n-9", "Other session question", 900)]);
    expect(unrelatedSession.notifications).toHaveLength(1);
    const session = makeSession([]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toMatchObject({ type: "user_message", content: "Fresh user message" });
    expect(sentCliContent(deps)).not.toContain("[Needs-input reminder]");
  });

  it("annotates Main-origin leader user messages in metadata and Claude CLI delivery", async () => {
    // Main is an explicit thread source for leaders even though it is not a
    // quest projection, so the model does not infer where the user typed.
    const session = makeSession();
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage({ content: "Main reply" }), deps);

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Main reply",
      threadKey: "main",
    });
    expect(sentCliContent(deps)).toMatch(/^\[User .*?\] \[thread:main\] Main reply$/);
  });

  it("annotates quest-thread-origin leader user messages in metadata and Claude CLI delivery", async () => {
    // Quest-thread messages must remain clean in durable history while the
    // delivered prompt carries the stable source key for leader/model routing.
    const session = makeSession();
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(
      session,
      userMessage({
        content: "Quest-thread reply",
        threadKey: "q-941",
        questId: "q-941",
      }),
      deps,
    );

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Quest-thread reply",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
    expect(sentCliContent(deps)).toMatch(/^\[User .*?\] \[thread:q-941\] Quest-thread reply$/);
  });

  it("stops listing notifications after they are resolved", async () => {
    // Resolved notifications stay in the inbox for history, but reminders only surface unresolved items.
    const session = makeSession([
      needsInput("n-1", "Already resolved", 100, true),
      needsInput("n-2", "Still pending", 200),
    ]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("Unresolved same-session same-thread needs-input notifications (main): 1."),
    });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.stringContaining("2. Still pending") });
    expect(session.messageHistory[0]).toMatchObject({ content: expect.not.stringContaining("Already resolved") });
  });

  it("does not inject before herd or other programmatic messages", async () => {
    // Programmatic messages carry agentSource and must not trigger the direct-user reminder path.
    const session = makeSession([needsInput("n-1", "Pending question", 100)]);
    const deps = makeDeps({ isOrchestrator: true });

    await handleUserMessage(
      session,
      userMessage({ agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" } }),
      deps,
    );

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Fresh user message",
      agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
    });
    expect(sentCliContent(deps)).not.toContain("[Needs-input reminder]");
  });

  it("keeps the behavior scoped to orchestrator sessions", async () => {
    // A non-leader session can have notifications, but this reminder is leader-only.
    const session = makeSession([needsInput("n-1", "Pending question", 100)]);
    const deps = makeDeps({ isOrchestrator: false });

    await handleUserMessage(session, userMessage(), deps);

    expect(session.messageHistory).toHaveLength(1);
    expect(sentCliContent(deps)).not.toContain("[Needs-input reminder]");
  });

  it("carries direct-user reminders through Codex pending inputs until the user message is committed", () => {
    // Codex queues browser messages before backend acknowledgement, so the reminder travels with the pending input.
    const session = makeSession([needsInput("n-1", "Pending question", 100)]);
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(session, userMessage(), null, deps);

    expect(routed).toBe(true);
    expect(session.messageHistory).toHaveLength(0);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "Fresh user message",
      needsInputReminderText: expect.stringContaining("[Needs-input reminder]"),
      deliveryContent: expect.stringContaining("[Needs-input reminder]"),
    });
    expect(session.pendingCodexInputs[0]?.deliveryContent).toContain("\n\nFresh user message");

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining("[Needs-input reminder]"),
      agentSource: {
        sessionId: "system:needs-input-reminder",
        sessionLabel: "Needs Input Reminder",
      },
    });
    expect(session.messageHistory[1]).toMatchObject({ type: "user_message", content: "Fresh user message" });
  });

  it("queues Codex herd inputs as a fresh pending batch instead of steering into an active turn", () => {
    // Herd events are delivered when the leader is idle, or force-delivered by
    // recovery when the active turn is stale. They should wake the leader with
    // a fresh turn instead of steering into that stale active Codex turn.
    const session = makeSession();
    session.backendType = "codex";
    session.isGenerating = true;
    session.codexAdapter = {
      getCurrentTurnId: () => "turn-active",
    } as any;
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "1 event from 1 session\n\n#1380 | turn_end | ✓",
        agentSource: {
          sessionId: "herd-events",
          sessionLabel: "Herd Events",
        },
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(deps.markRunningFromUserDispatch).not.toHaveBeenCalled();
    expect(deps.trySteerPendingCodexInputs).not.toHaveBeenCalled();
    expect(deps.queueCodexPendingStartBatch).toHaveBeenCalledWith(session, "herd_event_message");
  });

  it("broadcasts the routed active turn for Codex quest-thread messages while Main is selected", () => {
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    installActiveRouteStatusBroadcast(deps);
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Proceed in q-968",
        threadKey: "q-968",
        questId: "q-968",
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(deps.markRunningFromUserDispatch).toHaveBeenCalledWith(session, "user_message", null, undefined, {
      threadKey: "q-968",
      questId: "q-968",
    });
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "status_change",
        status: "running",
        activeTurnRoute: { threadKey: "q-968", questId: "q-968" },
      }),
    );
  });

  it("queues concise reply delivery content for Codex while preserving clean committed history", () => {
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps();
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Continue the work",
        deliveryContent: "[reply] Original answer\n\nContinue the work",
        replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "Continue the work",
      deliveryContent: "[reply] Original answer\n\nContinue the work",
      replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
    });

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Continue the work",
      replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
    });
    expect(session.lastUserMessage).toBe("[reply] Continue the work");
  });

  it("preserves quest-thread metadata through queued Codex pending input commit", () => {
    // Messages composed from a selected quest thread are queued for Codex before
    // becoming durable history, so the pending input must carry projection metadata.
    const session = makeSession();
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    const routed = routeAdapterBrowserMessage(
      session,
      userMessage({
        content: "Follow up from the q-941 thread",
        threadKey: "q-941",
        questId: "q-941",
      }),
      null,
      deps,
    );

    expect(routed).toBe(true);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "Follow up from the q-941 thread",
      deliveryContent: expect.stringMatching(/^\[User .*?\] \[thread:q-941\] Follow up from the q-941 thread$/),
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory[0]).toMatchObject({
      type: "user_message",
      content: "Follow up from the q-941 thread",
      threadKey: "q-941",
      questId: "q-941",
      threadRefs: [{ threadKey: "q-941", questId: "q-941", source: "explicit" }],
    });
  });

  it("does not commit an all-resolved queued Codex reminder into chat history", () => {
    // Codex can queue a reminder while a notification is active, then commit the
    // pending input after the user has already resolved that notification. The
    // queued user message should still land, but the stale reminder card should not.
    const session = makeSession([needsInput("n-1", "Pending question", 100)]);
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    routeAdapterBrowserMessage(session, userMessage(), null, deps);
    session.notifications![0]!.done = true;

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0]).toMatchObject({ type: "user_message", content: "Fresh user message" });
  });

  it("commits truncated queued Codex reminders when an unlisted notification remains active", () => {
    // The reminder text only lists the newest three unresolved notifications.
    // If those listed IDs resolve while an older hidden notification remains
    // active, the queued reminder is still meaningful and must not be suppressed.
    const session = makeSession([
      needsInput("n-1", "Hidden older question", 100),
      needsInput("n-3", "Third newest pending question", 300),
      needsInput("n-5", "Second newest pending question", 500),
      needsInput("n-6", "Newest pending question", 600),
    ]);
    session.backendType = "codex";
    const deps = makeDeps({ isOrchestrator: true });
    deps.addPendingCodexInput = vi.fn((targetSession, input) => {
      targetSession.pendingCodexInputs.push(input);
    });

    routeAdapterBrowserMessage(session, userMessage(), null, deps);
    expect(session.pendingCodexInputs[0]?.needsInputReminderText).toContain(
      "Unresolved same-session same-thread needs-input notifications (main): 4. Showing newest 3.",
    );
    for (const notification of session.notifications ?? []) {
      if (notification.id === "n-1") continue;
      notification.done = true;
    }

    commitPendingCodexInputs(session as any, [session.pendingCodexInputs[0]!.id], {
      broadcastPendingCodexInputs: vi.fn(),
      broadcastToBrowsers: vi.fn(),
      persistSession: vi.fn(),
      touchUserMessage: vi.fn(),
      onUserMessage: vi.fn(),
    } as any);

    expect(session.messageHistory).toHaveLength(2);
    expect(session.messageHistory[0]).toMatchObject({
      content: expect.stringContaining(
        "Unresolved same-session same-thread needs-input notifications (main): 4. Showing newest 3.",
      ),
      agentSource: {
        sessionId: "system:needs-input-reminder",
        sessionLabel: "Needs Input Reminder",
      },
    });
    expect(session.messageHistory[1]).toMatchObject({ type: "user_message", content: "Fresh user message" });
  });
});
