import { describe, expect, it, vi } from "vitest";
import {
  createClaudeMessageHandlers,
  handleSystemMessage,
  type SystemMessageSessionLike,
} from "./claude-message-controller.js";
import type {
  BrowserIncomingMessage,
  CLISystemStatusMessage,
  CLISystemTaskNotificationMessage,
  PermissionRequest,
  SessionState,
} from "../session-types.js";

function makeState(): SessionState {
  return {
    session_id: "s1",
    model: "",
    cwd: "",
    tools: [],
    permissionMode: "acceptEdits",
    claude_code_version: "",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    total_cost_usd: 0,
    num_turns: 0,
    context_used_percent: 0,
    is_compacting: false,
    git_branch: "",
    is_worktree: false,
    is_containerized: false,
    repo_root: "",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function makeSession(): SystemMessageSessionLike {
  return {
    id: "s1",
    backendType: "claude",
    cliInitReceived: false,
    cliResuming: false,
    cliResumingClearTimer: null,
    forceCompactPending: false,
    compactedDuringTurn: false,
    awaitingCompactSummary: false,
    claudeCompactBoundarySeen: false,
    seamlessReconnect: false,
    disconnectWasGenerating: false,
    isGenerating: false,
    generationStartedAt: undefined,
    lastOutboundUserNdjson: null,
    messageHistory: [],
    pendingMessages: [],
    state: makeState(),
  };
}

function makeDeps() {
  return {
    onCLISessionId: vi.fn(),
    cacheSlashCommands: vi.fn(),
    backfillSlashCommands: vi.fn(),
    refreshGitInfoThenRecomputeDiff: vi.fn(),
    getLauncherSessionInfo: vi.fn(() => ({ isOrchestrator: false })),
    broadcastToBrowsers: vi.fn(),
    persistSession: vi.fn(),
    hasPendingForceCompact: vi.fn(() => false),
    flushQueuedCliMessages: vi.fn(),
    onOrchestratorTurnEnd: vi.fn(),
    isCliUserMessagePayload: vi.fn(() => false),
    markTurnInterrupted: vi.fn(),
    setGenerating: vi.fn(),
    onSessionActivityStateChanged: vi.fn(),
    emitTakodeEvent: vi.fn(),
    injectCompactionRecovery: vi.fn(),
    hasCompactBoundaryReplay: vi.fn(() => false),
    freezeHistoryThroughCurrentTail: vi.fn(),
    hasTaskNotificationReplay: vi.fn(() => false),
    stuckGenerationThresholdMs: 120_000,
  };
}

function makeSdkSession() {
  return {
    id: "s1",
    backendType: "claude" as const,
    cliInitReceived: true,
    cliResuming: false,
    cliResumingClearTimer: null,
    forceCompactPending: false,
    compactedDuringTurn: false,
    awaitingCompactSummary: false,
    claudeCompactBoundarySeen: false,
    seamlessReconnect: false,
    disconnectWasGenerating: false,
    isGenerating: false,
    generationStartedAt: undefined as number | null | undefined,
    lastOutboundUserNdjson: null as string | null,
    messageHistory: [] as BrowserIncomingMessage[],
    pendingMessages: [] as string[],
    assistantAccumulator: new Map<string, { contentBlockIds: Set<string> }>(),
    toolStartTimes: new Map<string, number>(),
    toolProgressOutput: new Map<string, string>(),
    diffStatsDirty: false,
    lastActivityPreview: undefined as string | undefined,
    pendingPermissions: new Map<string, PermissionRequest>(),
    interruptedDuringTurn: false,
    queuedTurnStarts: 0,
    queuedTurnReasons: [] as string[],
    queuedTurnUserMessageIds: [] as number[][],
    queuedTurnInterruptSources: [] as Array<"user" | "leader" | "system" | null>,
    userMessageIdsThisTurn: [] as number[],
    state: makeState(),
  };
}

function makeSdkDeps() {
  return {
    ...makeDeps(),
    hasAssistantReplay: vi.fn(() => false),
    onToolUseObserved: vi.fn(),
    hasResultReplay: vi.fn(() => false),
    reconcileReplayState: vi.fn(() => ({ clearedResidualState: false })),
    drainInlineQueuedClaudeTurns: vi.fn(() => false),
    getCurrentTurnTriggerSource: vi.fn(() => "user" as const),
    reconcileTerminalResultState: vi.fn(),
    finalizeOrphanedTerminalToolsOnResult: vi.fn(),
    cancelPermissionNotification: vi.fn(),
    onResultAttentionAndNotifications: vi.fn(),
    onTurnCompleted: vi.fn(),
    injectUserMessage: vi.fn(),
    hasUserPromptReplay: vi.fn(() => false),
    hasToolResultPreviewReplay: vi.fn(() => false),
    nextUserMessageId: vi.fn(() => "msg-1"),
    clearCodexToolResultWatchdog: vi.fn(),
    buildToolResultPreviews: vi.fn(() => []),
    collectCompletedToolStartTimes: vi.fn(() => []),
    finalizeSupersededCodexTerminalTools: vi.fn(),
    broadcastCompactSummary: vi.fn(),
    updateLatestCompactMarkerSummary: vi.fn(),
  };
}

describe("system-message-controller", () => {
  // Verifies the live system.status path updates both permissionMode and the derived
  // uiMode, while still emitting the current backend status to subscribed browsers.
  it("broadcasts uiMode and status changes for live system.status updates", () => {
    const session = makeSession();
    const deps = makeDeps();
    const msg: CLISystemStatusMessage = {
      type: "system",
      subtype: "status",
      status: "compacting",
      permissionMode: "plan",
      uuid: "status-1",
      session_id: "s1",
    };

    handleSystemMessage(session, msg, deps);

    expect(session.state.permissionMode).toBe("plan");
    expect(session.state.uiMode).toBe("plan");
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "session_update",
        session: { permissionMode: "plan", uiMode: "plan" },
      }),
    );
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: "status_change", status: "compacting" }),
    );
    expect(deps.onSessionActivityStateChanged).toHaveBeenCalledWith("s1", "system_status");
  });

  // Exercises the SDK path (handleSdkCompactBoundary) where compact_boundary
  // enriches an existing compact_marker. The enrichment early-return must still
  // set claudeCompactBoundarySeen so the post-compaction recovery injection fires.
  it("injects compaction recovery after SDK compact_boundary enrichment", () => {
    const session = makeSdkSession();
    const allDeps = makeSdkDeps();
    const handlers = createClaudeMessageHandlers(allDeps);

    // 1. SDK status_change "compacting" — creates compact_marker, resets flag
    handlers.handleSdkBrowserMessage(session, {
      type: "status_change",
      status: "compacting",
    });
    expect(session.state.is_compacting).toBe(true);
    expect(session.claudeCompactBoundarySeen).toBe(false);
    const marker = session.messageHistory.find((m) => m.type === "compact_marker");
    expect(marker).toBeDefined();

    // 2. SDK compact_boundary — enriches existing marker via early-return path
    handlers.handleSdkBrowserMessage(session, {
      type: "system",
      subtype: "compact_boundary",
      uuid: "cb-1",
      session_id: "s1",
    });
    expect(session.claudeCompactBoundarySeen).toBe(true);

    // 3. SDK status_change non-compacting — should trigger injection
    handlers.handleSdkBrowserMessage(session, {
      type: "status_change",
      status: null,
    });
    expect(session.state.is_compacting).toBe(false);
    expect(allDeps.injectCompactionRecovery).toHaveBeenCalledWith(session);
  });

  // Verifies that when no compact_boundary arrives between compacting start and end,
  // the recovery injection is skipped for Claude backend sessions.
  it("skips compaction recovery when SDK compact boundary was never seen", () => {
    const session = makeSdkSession();
    const allDeps = makeSdkDeps();
    const handlers = createClaudeMessageHandlers(allDeps);

    handlers.handleSdkBrowserMessage(session, {
      type: "status_change",
      status: "compacting",
    });

    // Transition out without compact_boundary
    handlers.handleSdkBrowserMessage(session, {
      type: "status_change",
      status: null,
    });
    expect(allDeps.injectCompactionRecovery).not.toHaveBeenCalled();
  });

  // Resume replay can resend old task notifications; this confirms the controller
  // drops those duplicates instead of re-adding completion cards to history.
  it("deduplicates replayed task notifications", () => {
    const session = makeSession();
    const deps = makeDeps();
    deps.hasTaskNotificationReplay.mockReturnValue(true);
    const msg: CLISystemTaskNotificationMessage = {
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      tool_use_id: "tool-1",
      status: "completed",
      summary: "done",
      output_file: undefined,
      session_id: "s1",
    };

    handleSystemMessage(session, msg, deps);

    expect(session.messageHistory).toHaveLength(0);
    expect(deps.broadcastToBrowsers).not.toHaveBeenCalled();
    expect(deps.persistSession).not.toHaveBeenCalled();
  });
});
