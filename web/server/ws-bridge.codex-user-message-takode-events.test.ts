import { vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
const mockShouldSettingsRuleApprove = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("node:child_process", () => ({ execSync: mockExecSync, exec: mockExec }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));
// Mock settings rule loading so real user ~/.claude/settings.json rules don't
// interfere with tests. Tests that need specific rules override this per-call.
vi.mock("./bridge/settings-rule-matcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./bridge/settings-rule-matcher.js")>();
  return {
    ...original,
    shouldSettingsRuleApprove: mockShouldSettingsRuleApprove,
  };
});

import { WsBridge, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { HerdEventDispatcher, isSessionIdleRuntime, renderHerdEventBatch } from "./herd-event-dispatcher.js";
import {
  advanceBoardRow as advanceBoardRowController,
  advanceBoardRowNoGroom as advanceBoardRowNoGroomController,
  getBoard as getBoardController,
  getCompletedBoard as getCompletedBoardController,
  removeBoardRows as removeBoardRowsController,
  upsertBoardRow as upsertBoardRowController,
} from "./bridge/board-watchdog-controller.js";
import {
  cleanupBranchState as cleanupBranchStateIndex,
  updateBranchIndex as updateBranchIndexState,
} from "./bridge/branch-session-index.js";
import { routeBrowserMessage as routeBrowserMessageController } from "./bridge/adapter-browser-routing-controller.js";
import {
  getVsCodeSelectionState as getVsCodeSelectionStateController,
  getVsCodeWindowStates as getVsCodeWindowStatesController,
  pollVsCodeOpenFileCommands as pollVsCodeOpenFileCommandsController,
  requestVsCodeOpenFile as requestVsCodeOpenFileController,
  resolveVsCodeOpenFileResult as resolveVsCodeOpenFileResultController,
  updateVsCodeSelectionState as updateVsCodeSelectionStateController,
  upsertVsCodeWindowState as upsertVsCodeWindowStateController,
} from "./bridge/browser-transport-controller.js";
import {
  refreshGitInfoPublic as refreshGitInfoPublicController,
  setDiffBaseBranch as setDiffBaseBranchController,
} from "./bridge/session-git-state.js";
import { trafficStats } from "./traffic-stats.js";
import {
  applyInitialSessionState as applyInitialSessionStateController,
  addTaskEntry as addTaskEntryController,
  clearAttentionAndMarkRead as clearAttentionAndMarkReadController,
  getHerdDiagnostics as getHerdDiagnosticsController,
  markNotificationDone as markNotificationDoneController,
  notifyUser as notifyUserController,
  setSessionClaimedQuest as setSessionClaimedQuestController,
} from "./bridge/session-registry-controller.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

function createMockSocket(data: SocketData) {
  return {
    data,
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as any;
}

function makeCliSocket(sessionId: string) {
  return createMockSocket({ kind: "cli", sessionId });
}

function makeBrowserSocket(sessionId: string) {
  return createMockSocket({ kind: "browser", sessionId });
}

/** Flush all pending microtasks and setTimeout(0) callbacks so async sendHistorySync and deferred traffic stats complete. */
async function flushAsync() {
  // Flush microtasks (queueMicrotask in traffic stats)
  await Promise.resolve();
  // Flush setTimeout(0) (yieldToEventLoop in sendHistorySync)
  await new Promise((r) => setTimeout(r, 0));
  // One more microtask pass for any traffic stats queued after the yield
  await Promise.resolve();
}

function makeCodexAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;
  let onTurnStartFailedCb: ((msg: any) => void) | undefined;
  let onTurnStartedCb: ((turnId: string) => void) | undefined;
  let onTurnSteeredCb: ((turnId: string, pendingInputIds: string[]) => void) | undefined;
  let onTurnSteerFailedCb: ((pendingInputIds: string[]) => void) | undefined;
  let currentTurnId: string | null = null;
  const rollbackTurns = vi.fn(async (_numTurns: number) => {});

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => {
      onBrowserMessageCb = cb;
    }),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => {
      onSessionMetaCb = cb;
    }),
    onDisconnect: vi.fn((cb: () => void) => {
      onDisconnectCb = cb;
    }),
    onInitError: vi.fn((cb: (error: string) => void) => {
      onInitErrorCb = cb;
    }),
    onTurnStartFailed: vi.fn((cb: (msg: any) => void) => {
      onTurnStartFailedCb = cb;
    }),
    onTurnStarted: vi.fn((cb: (turnId: string) => void) => {
      onTurnStartedCb = cb;
    }),
    onTurnSteered: vi.fn((cb: (turnId: string, pendingInputIds: string[]) => void) => {
      onTurnSteeredCb = cb;
    }),
    onTurnSteerFailed: vi.fn((cb: (pendingInputIds: string[]) => void) => {
      onTurnSteerFailedCb = cb;
    }),
    sendBrowserMessage: vi.fn((_msg?: any) => true),
    rollbackTurns,
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    getThreadId: vi.fn(() => "thread-ready"),
    getCurrentTurnId: vi.fn(() => currentTurnId),
    emitBrowserMessage: (msg: any) => onBrowserMessageCb?.(msg),
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: (turnId?: string | null) => {
      currentTurnId = turnId === undefined ? currentTurnId : turnId;
      onDisconnectCb?.();
    },
    emitInitError: (error: string) => onInitErrorCb?.(error),
    emitTurnStartFailed: (msg: any) => onTurnStartFailedCb?.(msg),
    emitTurnStarted: (turnId: string) => {
      currentTurnId = turnId;
      onTurnStartedCb?.(turnId);
    },
    emitTurnSteered: (turnId: string, pendingInputIds: string[]) => {
      onTurnSteeredCb?.(turnId, pendingInputIds);
    },
    emitTurnSteerFailed: (pendingInputIds: string[]) => {
      onTurnSteerFailedCb?.(pendingInputIds);
    },
  };
}

function emitCodexSessionReady(
  adapter: ReturnType<typeof makeCodexAdapterMock>,
  overrides: Record<string, unknown> = {},
) {
  adapter.emitSessionMeta({
    cliSessionId: "thread-ready",
    model: "gpt-5.3-codex",
    cwd: "/repo",
    ...overrides,
  });
}

function getPendingCodexTurn(session: { pendingCodexTurns?: unknown[] }) {
  return (session.pendingCodexTurns?.[0] ?? null) as any;
}

function getCodexStartPendingInputs(msg: any) {
  expect(msg?.type).toBe("codex_start_pending");
  expect(Array.isArray(msg?.inputs)).toBe(true);
  return msg.inputs as Array<{ content: string }>;
}

function getNotificationTestDeps(bridge: WsBridge) {
  return {
    isHerdedWorkerSession: (session: any) => !!(bridge as any).launcher?.getSession(session.id)?.herdedBy,
    broadcastToBrowsers: (session: any, msg: any) => bridge.broadcastToSession(session.id, msg),
    persistSession: (session: any) => bridge.persistSessionById(session.id),
    emitTakodeEvent: (sessionId: string, type: string, data: Record<string, unknown>) =>
      bridge.emitTakodeEvent(sessionId, type as any, data as any),
    scheduleNotification: () => undefined,
  };
}

function applyClaimedQuest(
  bridge: WsBridge,
  sessionId: string,
  quest: { id: string; title: string; status?: string } | null,
) {
  const session = bridge.getSession(sessionId);
  if (!session) return;
  setSessionClaimedQuestController(session, quest, {
    broadcastToBrowsers: (_session: any, msg: any) => bridge.broadcastToSession(sessionId, msg),
    persistSession: () => bridge.persistSessionById(sessionId),
    getLauncherSessionInfo: (targetSessionId: string) => (bridge as any).launcher?.getSession?.(targetSessionId),
    onSessionNamedByQuest: (targetSessionId: string, title: string) =>
      (bridge as any).onSessionNamedByQuest?.(targetSessionId, title),
  });
}

type TestBridge = WsBridge & {
  setStore(store: SessionStore): void;
  setRecorder(recorder: any): void;
  setTimerManager(timerManager: any): void;
  setImageStore(imageStore: any): void;
  setPushoverNotifier(notifier: any): void;
  setLauncher(launcher: any): void;
  setHerdEventDispatcher(dispatcher: any): void;
  onCLIRelaunchNeededCallback(cb: (sessionId: string) => void): void;
  onPermissionModeChangedCallback(cb: (sessionId: string, newMode: string) => void): void;
  onSessionRelaunchRequestedCallback(cb: (sessionId: string) => void): void;
  onUserMessageCallback(cb: any): void;
  onTurnCompletedCallback(cb: any): void;
  onAgentPausedCallback(cb: any): void;
  applyInitialSessionState(sessionId: string, options: any): void;
  markWorktree(
    sessionId: string,
    repoRoot: string,
    worktreeCwd: string,
    defaultBranch?: string,
    diffBaseBranch?: string,
  ): void;
  getTrafficStatsSnapshot(): any;
  resetTrafficStats(): void;
  setDiffBaseBranch(sessionId: string, branch: string): boolean;
  refreshGitInfoPublic(
    sessionId: string,
    options?: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean },
  ): Promise<boolean>;
  onSessionArchived(sessionId: string): void;
  onSessionUnarchived(sessionId: string): void;
  getBoard(sessionId: string): any[];
  upsertBoardRow(sessionId: string, row: any): any[] | null;
  removeBoardRows(sessionId: string, questIds: string[]): any[] | null;
  advanceBoardRow(sessionId: string, questId: string): any;
  advanceBoardRowNoGroom(sessionId: string, questId: string): any;
  getCompletedBoard(sessionId: string): any[];
  getCompletedBoardCount(sessionId: string): number;
  getVsCodeSelectionState(): any;
  updateVsCodeSelectionState(nextState: any): boolean;
  getVsCodeWindowStates(): any[];
  upsertVsCodeWindowState(nextState: any): any;
  pollVsCodeOpenFileCommands(sourceId: string, limit?: number): any[];
  resolveVsCodeOpenFileResult(sourceId: string, commandId: string, result: { ok: boolean; error?: string }): boolean;
  requestVsCodeOpenFile(
    target: any,
    options?: { timeoutMs?: number },
  ): Promise<{ sourceId: string; commandId: string }>;
};

function attachBoardFacade(bridge: WsBridge): TestBridge {
  const anyBridge = bridge as any;
  anyBridge.setStore = (store: SessionStore) => {
    bridge.store = store;
  };
  anyBridge.setRecorder = (recorder: any) => {
    bridge.recorder = recorder;
  };
  anyBridge.setTimerManager = (timerManager: any) => {
    bridge.timerManager = timerManager;
  };
  anyBridge.setImageStore = (imageStore: any) => {
    bridge.imageStore = imageStore;
  };
  anyBridge.setPushoverNotifier = (notifier: any) => {
    bridge.pushoverNotifier = notifier;
  };
  anyBridge.setLauncher = (launcher: any) => {
    bridge.launcher = launcher;
  };
  anyBridge.setHerdEventDispatcher = (dispatcher: any) => {
    bridge.herdEventDispatcher = dispatcher;
  };
  anyBridge.onCLIRelaunchNeededCallback = (cb: (sessionId: string) => void) => {
    bridge.onCLIRelaunchNeeded = cb;
  };
  anyBridge.onPermissionModeChangedCallback = (cb: (sessionId: string, newMode: string) => void) => {
    bridge.onPermissionModeChanged = cb;
  };
  anyBridge.onSessionRelaunchRequestedCallback = (cb: (sessionId: string) => void) => {
    bridge.onSessionRelaunchRequested = cb;
  };
  anyBridge.onUserMessageCallback = (cb: any) => {
    bridge.onUserMessage = cb;
  };
  anyBridge.onTurnCompletedCallback = (cb: any) => {
    bridge.onTurnCompleted = cb;
  };
  anyBridge.onAgentPausedCallback = (cb: any) => {
    bridge.onAgentPaused = cb;
  };
  bridge.herdEventDispatcher = new HerdEventDispatcher(
    {
      subscribeTakodeEvents: () => () => {},
      injectUserMessage: () => "no_session",
      getSession: (sessionId: string) => bridge.getSession(sessionId) as any,
    },
    {
      getHerdedSessions: (orchId: string) => bridge.launcher?.getHerdedSessions?.(orchId) ?? [],
      getSession: (sessionId: string) => bridge.launcher?.getSession?.(sessionId),
    },
    {
      requestCliRelaunch: (sessionId: string) => bridge.onCLIRelaunchNeeded?.(sessionId),
      getSessionNum: (sessionId: string) => bridge.launcher?.getSessionNum?.(sessionId),
      getSessionName: (sessionId: string) => bridge.sessionNameGetter?.(sessionId),
      getSessions: () => anyBridge.sessions,
      getLeaderIdleDeps: () => anyBridge.getSessionRegistryDeps(),
    },
  );
  anyBridge.applyInitialSessionState = (sessionId: string, options: any) => {
    const session = bridge.getOrCreateSession(sessionId);
    applyInitialSessionStateController(session as any, options, {
      persistSession: (targetSession) => bridge.persistSessionById((targetSession as any).id),
      prefillSlashCommands: (targetSession) => anyBridge.prefillSlashCommands.call(anyBridge, targetSession),
    });
  };
  anyBridge.markWorktree = (
    sessionId: string,
    repoRoot: string,
    worktreeCwd: string,
    defaultBranch?: string,
    diffBaseBranch?: string,
  ) => {
    anyBridge.applyInitialSessionState(sessionId, {
      cwd: worktreeCwd,
      worktree: { repoRoot, defaultBranch, diffBaseBranch },
    });
  };
  anyBridge.getTrafficStatsSnapshot = () => trafficStats.snapshot();
  anyBridge.resetTrafficStats = () => {
    trafficStats.reset();
  };
  anyBridge.setDiffBaseBranch = (sessionId: string, branch: string) => {
    const session = bridge.getSession(sessionId);
    if (!session) return false;
    setDiffBaseBranchController(session as any, branch, anyBridge.getSessionGitStateDeps());
    return true;
  };
  anyBridge.refreshGitInfoPublic = async (
    sessionId: string,
    options: { broadcastUpdate?: boolean; notifyPoller?: boolean; force?: boolean } = {},
  ) => {
    const session = bridge.getSession(sessionId);
    if (!session) return false;
    await refreshGitInfoPublicController(session as any, anyBridge.getSessionGitStateDeps(), options);
    return true;
  };
  anyBridge.onSessionArchived = (sessionId: string) => {
    cleanupBranchStateIndex(sessionId, {
      branchToSessions: anyBridge.branchToSessions,
      sessionBranches: anyBridge.sessionBranches,
      lastCrossSessionRefreshAt: anyBridge.lastCrossSessionRefreshAt,
    });
  };
  anyBridge.onSessionUnarchived = (sessionId: string) => {
    const session = bridge.getSession(sessionId);
    if (!session) return;
    updateBranchIndexState(session, {
      isArchived: bridge.launcher?.getSession(session.id)?.archived === true,
      branchToSessions: anyBridge.branchToSessions,
      sessionBranches: anyBridge.sessionBranches,
    });
  };
  const workBoardStateDeps = {
    getBoardDispatchableSignature: (session: any, questId: string) =>
      anyBridge.getBoardDispatchableSignature(session.id, questId),
    markNotificationDone: (sessionId: string, notifId: string, done: boolean) => {
      const session = bridge.getSession(sessionId);
      if (!session) return false;
      return markNotificationDoneController(session, notifId, done, {
        broadcastToBrowsers: (_session: any, msg: any) => bridge.broadcastToSession(sessionId, msg),
        persistSession: () => bridge.persistSessionById(sessionId),
      });
    },
    broadcastBoard: (session: any, board: unknown[], completedBoard: unknown[]) =>
      bridge.broadcastToSession(session.id, { type: "board_updated", board, completedBoard } as any),
    persistSession: (session: any) => bridge.persistSessionById(session.id),
    notifyReview: (sessionId: string, summary: string) => {
      const session = bridge.getSession(sessionId);
      if (session) notifyUserController(session, "review", summary, getNotificationTestDeps(bridge));
    },
  };
  anyBridge.getBoard = (sessionId: string) =>
    bridge.getSession(sessionId) ? getBoardController(bridge.getSession(sessionId)!) : [];
  anyBridge.upsertBoardRow = (sessionId: string, row: any) =>
    bridge.getSession(sessionId)
      ? upsertBoardRowController(bridge.getSession(sessionId)!, row, workBoardStateDeps)
      : null;
  anyBridge.removeBoardRows = (sessionId: string, questIds: string[]) =>
    bridge.getSession(sessionId)
      ? removeBoardRowsController(bridge.getSession(sessionId)!, questIds, workBoardStateDeps)
      : null;
  anyBridge.advanceBoardRow = (sessionId: string, questId: string) =>
    bridge.getSession(sessionId)
      ? advanceBoardRowController(
          bridge.getSession(sessionId)!,
          questId,
          ["QUEUED", "PLANNING", "IMPLEMENTING", "SKEPTIC_REVIEWING", "GROOM_REVIEWING", "PORTING"],
          workBoardStateDeps,
        )
      : null;
  anyBridge.advanceBoardRowNoGroom = (sessionId: string, questId: string) =>
    bridge.getSession(sessionId)
      ? advanceBoardRowNoGroomController(bridge.getSession(sessionId)!, questId, workBoardStateDeps)
      : null;
  anyBridge.getCompletedBoard = (sessionId: string) =>
    bridge.getSession(sessionId) ? getCompletedBoardController(bridge.getSession(sessionId)!) : [];
  anyBridge.getCompletedBoardCount = (sessionId: string) => bridge.getSession(sessionId)?.completedBoard.size ?? 0;
  anyBridge.getVsCodeSelectionState = () => getVsCodeSelectionStateController(anyBridge.browserTransportState);
  anyBridge.updateVsCodeSelectionState = (nextState: any) =>
    updateVsCodeSelectionStateController(
      anyBridge.browserTransportState,
      nextState,
      anyBridge.getBrowserTransportDeps(),
    );
  anyBridge.getVsCodeWindowStates = () =>
    getVsCodeWindowStatesController(anyBridge.browserTransportState, anyBridge.getBrowserTransportDeps());
  anyBridge.upsertVsCodeWindowState = (nextState: any) =>
    upsertVsCodeWindowStateController(anyBridge.browserTransportState, nextState);
  anyBridge.pollVsCodeOpenFileCommands = (sourceId: string, limit = 1) =>
    pollVsCodeOpenFileCommandsController(anyBridge.browserTransportState, sourceId, limit);
  anyBridge.resolveVsCodeOpenFileResult = (
    sourceId: string,
    commandId: string,
    result: { ok: boolean; error?: string },
  ) => resolveVsCodeOpenFileResultController(anyBridge.browserTransportState, sourceId, commandId, result);
  anyBridge.requestVsCodeOpenFile = (target: any, options?: { timeoutMs?: number }) =>
    requestVsCodeOpenFileController(
      anyBridge.browserTransportState,
      target,
      anyBridge.getBrowserTransportDeps(),
      options,
    );
  anyBridge.routeBrowserMessage = (session: any, msg: any, ws?: any) =>
    routeBrowserMessageController(session, msg, ws, anyBridge.getBrowserRoutingDeps());
  return bridge as TestBridge;
}

function expectCodexStartPendingTurnLike(
  turn: any,
  expected: {
    firstContent?: string;
    firstContentContaining?: string;
    forbidNativeImageTransport?: boolean;
    status?: string;
    dispatchCount?: number;
    userContent?: string;
    turnId?: string | null;
    turnTarget?: string | null;
  } = {},
) {
  expect(turn).toBeTruthy();
  expect(turn.adapterMsg?.type).toBe("codex_start_pending");
  const inputs = getCodexStartPendingInputs(turn.adapterMsg);
  expect(inputs.length).toBeGreaterThan(0);
  if (expected.firstContent !== undefined) {
    expect(inputs[0]?.content).toBe(expected.firstContent);
  }
  if (expected.firstContentContaining !== undefined) {
    expect(inputs[0]?.content).toContain(expected.firstContentContaining);
  }
  if (expected.forbidNativeImageTransport) {
    expect((inputs[0] as any)?.local_images).toBeUndefined();
  }
  if (expected.status !== undefined) {
    expect(turn.status).toBe(expected.status);
  }
  if (expected.dispatchCount !== undefined) {
    expect(turn.dispatchCount).toBe(expected.dispatchCount);
  }
  if (expected.userContent !== undefined) {
    expect(turn.userContent).toBe(expected.userContent);
  }
  if ("turnId" in expected) {
    expect(turn.turnId).toBe(expected.turnId);
  }
  if ("turnTarget" in expected) {
    expect(turn.turnTarget).toBe(expected.turnTarget);
  }
}

function makeClaudeSdkAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;
  let onCompactRequestedCb: (() => void) | undefined;

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => {
      onBrowserMessageCb = cb;
    }),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => {
      onSessionMetaCb = cb;
    }),
    onDisconnect: vi.fn((cb: () => void) => {
      onDisconnectCb = cb;
    }),
    onInitError: vi.fn((cb: (error: string) => void) => {
      onInitErrorCb = cb;
    }),
    onCompactRequested: vi.fn((cb: () => void) => {
      onCompactRequestedCb = cb;
    }),
    sendBrowserMessage: vi.fn(),
    drainPendingOutgoing: vi.fn((): any[] => []),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    emitBrowserMessage: (msg: any) => onBrowserMessageCb?.(msg),
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: () => onDisconnectCb?.(),
    emitInitError: (error: string) => onInitErrorCb?.(error),
    emitCompactRequested: () => onCompactRequestedCb?.(),
  };
}

let bridge: TestBridge;
let tempDir: string;
let store: SessionStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bridge-test-"));
  store = new SessionStore(tempDir);
  bridge = attachBoardFacade(new WsBridge());
  bridge.setStore(store);
  bridge.resetTrafficStats();
  mockExecSync.mockReset();
  mockExec.mockReset();
  mockShouldSettingsRuleApprove.mockReset().mockResolvedValue(null);
  // Default: mockExec delegates to mockExecSync so tests that set up
  // mockExecSync automatically work for async computeDiffStatsAsync too.
  mockExec.mockImplementation((cmd: string, opts: any, cb?: Function) => {
    const callback = typeof opts === "function" ? opts : cb;
    try {
      const result = mockExecSync(cmd);
      if (callback) callback(null, { stdout: result ?? "", stderr: "" });
    } catch (err) {
      if (callback) callback(err, { stdout: "", stderr: "" });
    }
  });
});

// localDateKey is a private static — access via `any` cast for testing.
// ─── Helper: build a system.init NDJSON string ────────────────────────────────

function makeInitMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cli-123",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    output_style: "normal",
    uuid: "uuid-1",
    apiKeySource: "env",
    ...overrides,
  });
}

describe("Codex user_message takode events", () => {
  it("emits takode user_message for direct human worker messages", async () => {
    const sid = "worker-codex-1";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please prioritize fixing auth bug first",
      }),
    );
    await Promise.resolve();

    expect(spy).toHaveBeenCalledWith(
      sid,
      "user_message",
      expect.objectContaining({
        content: "Please prioritize fixing auth bug first",
        message_id: expect.any(String),
        turn_target: "current",
      }),
    );

    spy.mockRestore();
  });

  it("marks turn_end as interrupted when a new user_message arrives during a running codex turn", async () => {
    const sid = "worker-codex-2";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-worker-codex-2" });
    bridge.handleBrowserOpen(browser, sid);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Start an active turn.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Run full test suite",
      }),
    );
    adapter.emitTurnStarted("turn-running-1");

    // Mid-turn follow-up message causes Codex to interrupt the active turn first.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Actually run only server tests",
      }),
    );

    // Adapter reports completion of the interrupted turn.
    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "interrupted by new user message",
        duration_ms: 320,
        duration_api_ms: 320,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "interrupted",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "codex-result-interrupted-1",
        session_id: sid,
      },
    });

    await Promise.resolve();

    const turnEndCalls = spy.mock.calls.filter(([eventSid, eventType]) => eventSid === sid && eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    const lastTurnEnd = turnEndCalls[turnEndCalls.length - 1];
    expect(lastTurnEnd[2]).toEqual(expect.objectContaining({ interrupted: true, interrupt_source: "user" }));

    spy.mockRestore();
  });

  it("does not mark turn_end as interrupted when a queued follow-up arrives but the current codex result completes normally", async () => {
    const sid = "worker-codex-2b";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-worker-codex-2b" });
    bridge.handleBrowserOpen(browser, sid);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Run the full test suite",
      }),
    );
    adapter.emitTurnStarted("turn-running-2");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Then summarize only the failures",
      }),
    );

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed original turn before follow-up started",
        duration_ms: 320,
        duration_api_ms: 320,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "codex-result-completed-1",
        session_id: sid,
      },
    });

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed follow-up turn",
        duration_ms: 180,
        duration_api_ms: 180,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "codex-result-completed-2",
        session_id: sid,
      },
    });

    await Promise.resolve();

    const turnEndCalls = spy.mock.calls.filter(([eventSid, eventType]) => eventSid === sid && eventType === "turn_end");
    expect(turnEndCalls).toHaveLength(2);
    expect(turnEndCalls[0]?.[2]).toEqual(
      expect.not.objectContaining({
        interrupted: true,
      }),
    );
    expect(turnEndCalls[1]?.[2]).toEqual(
      expect.not.objectContaining({
        interrupted: true,
      }),
    );

    spy.mockRestore();
  });

  it("emits both interrupted and resumed turn_end events after correction, with herd delivery for each", async () => {
    vi.useFakeTimers();
    const leaderId = "orch-correction";
    const workerId = "worker-correction";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "codex", cwd: "/test" }],
    ]);

    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 1 : 2)),
    };
    bridge.setLauncher(launcherMock as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const leaderCli = makeCliSocket(leaderId);
    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-correction" }));

    const workerBrowser = makeBrowserSocket(workerId);
    const workerAdapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(workerId, workerAdapter as any);
    emitCodexSessionReady(workerAdapter, { cliSessionId: "thread-worker-correction" });
    bridge.handleBrowserOpen(workerBrowser, workerId);

    const eventSpy = vi.spyOn(bridge, "emitTakodeEvent");
    const herdInjectSpy = vi.spyOn(bridge, "injectUserMessage");

    // Initial worker task turn.
    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Implement the first version",
      }),
    );
    await Promise.resolve();
    workerAdapter.emitTurnStarted("turn-worker-correction-1");

    // Mid-turn correction from leader.
    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Correction: include edge-case handling",
        agentSource: { sessionId: leaderId, sessionLabel: "#1 leader" },
      }),
    );
    await Promise.resolve();

    // First result ends interrupted turn.
    workerAdapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "interrupted by correction",
        duration_ms: 200,
        duration_api_ms: 200,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "interrupted",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-result-1",
        session_id: workerId,
      },
    });
    await Promise.resolve();

    // Deliver first herd event batch.
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    // Leader processes injected herd event message and returns idle.
    bridge.handleCLIMessage(
      leaderCli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ack",
        duration_ms: 100,
        duration_api_ms: 100,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "leader-herd-ack-1",
        session_id: leaderId,
      }),
    );
    await Promise.resolve();

    // Second result ends the resumed follow-up turn.
    workerAdapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed after correction",
        duration_ms: 450,
        duration_api_ms: 450,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-result-2",
        session_id: workerId,
      },
    });
    await Promise.resolve();
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    try {
      const workerTurnEndCalls = eventSpy.mock.calls.filter(
        ([sid, eventType]) => sid === workerId && eventType === "turn_end",
      );
      expect(workerTurnEndCalls).toHaveLength(2);
      expect(workerTurnEndCalls[0]?.[2]).toEqual(
        expect.objectContaining({
          interrupted: true,
          interrupt_source: "leader",
        }),
      );
      expect(workerTurnEndCalls[1]?.[2]).toEqual(
        expect.not.objectContaining({
          interrupted: true,
        }),
      );

      const herdDeliveries = herdInjectSpy.mock.calls.filter(
        ([sid, _content, source]) => sid === leaderId && source?.sessionId === "herd-events",
      );
      // Both turn_end events are still delivered to the leader so reconnect
      // recovery remains visible even though the interrupted turn is system-attributed.
      expect(herdDeliveries).toHaveLength(2);
    } finally {
      dispatcher.destroy();
      eventSpy.mockRestore();
      herdInjectSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("suppresses the spurious system-interrupted turn_end when reconnect resumes queued correction work", async () => {
    vi.useFakeTimers();
    const leaderId = "orch-correction-reconnect";
    const workerId = "worker-correction-reconnect";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "codex", cwd: "/test" }],
    ]);

    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 1 : 2)),
    };
    bridge.setLauncher(launcherMock as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const leaderCli = makeCliSocket(leaderId);
    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-correction-reconnect" }));

    const workerBrowser = makeBrowserSocket(workerId);
    const workerAdapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(workerId, workerAdapter1 as any);
    emitCodexSessionReady(workerAdapter1, { cliSessionId: "thread-worker-correction-reconnect" });
    bridge.handleBrowserOpen(workerBrowser, workerId);

    const eventSpy = vi.spyOn(bridge, "emitTakodeEvent");
    const herdInjectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Implement the first version",
      }),
    );
    await Promise.resolve();
    workerAdapter1.emitTurnStarted("turn-worker-correction-reconnect-1");

    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Correction: include edge-case handling",
        agentSource: { sessionId: leaderId, sessionLabel: "#1 leader" },
      }),
    );
    await Promise.resolve();

    workerAdapter1.emitDisconnect("turn-worker-correction-reconnect-1");
    await Promise.resolve();

    vi.advanceTimersByTime(600);
    await Promise.resolve();

    bridge.handleCLIMessage(
      leaderCli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ack",
        duration_ms: 100,
        duration_api_ms: 100,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "leader-herd-ack-reconnect-1",
        session_id: leaderId,
      }),
    );
    await Promise.resolve();

    const workerAdapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(workerId, workerAdapter2 as any);
    workerAdapter2.emitSessionMeta({
      cliSessionId: "thread-worker-correction-reconnect",
      model: "gpt-5.4",
      cwd: "/test",
      resumeSnapshot: {
        threadId: "thread-worker-correction-reconnect",
        turnCount: 9,
        lastTurn: {
          id: "turn-worker-correction-reconnect-1",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "Implement the first version" }] },
            { type: "agentMessage", id: "item-reconnect-recovered", text: "Recovered interrupted work" },
          ],
        },
      },
    });

    const resumedSession = bridge.getSession(workerId)!;
    expect(getPendingCodexTurn(resumedSession)).toMatchObject({
      userContent: "Correction: include edge-case handling",
      status: "dispatched",
      turnTarget: null,
    });
    expect(resumedSession.queuedTurnStarts).toBe(0);
    expect(resumedSession.queuedTurnReasons).toEqual([]);
    expect(resumedSession.queuedTurnUserMessageIds).toEqual([]);
    expect(resumedSession.queuedTurnInterruptSources).toEqual([]);

    workerAdapter2.emitTurnStarted("turn-worker-correction-reconnect-2");
    workerAdapter2.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed after reconnect",
        duration_ms: 450,
        duration_api_ms: 450,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-reconnect-result-2",
        session_id: workerId,
      },
    });
    await Promise.resolve();
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    try {
      const workerTurnEndCalls = eventSpy.mock.calls.filter(
        ([sid, eventType]) => sid === workerId && eventType === "turn_end",
      );
      expect(workerTurnEndCalls).toHaveLength(1);
      expect(workerTurnEndCalls[0]?.[2]).toEqual(
        expect.not.objectContaining({
          interrupted: true,
        }),
      );

      const turnEndHerdDeliveries = herdInjectSpy.mock.calls.filter(
        ([sid, content, source]) =>
          sid === leaderId &&
          source?.sessionId === "herd-events" &&
          typeof content === "string" &&
          content.includes("turn_end"),
      );
      expect(turnEndHerdDeliveries).toHaveLength(1);
    } finally {
      dispatcher.destroy();
      eventSpy.mockRestore();
      herdInjectSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps a recoverable Codex planning turn resumable while auto-recovery is still in flight", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-codex-disconnect-grace-expiry";
      const relaunchCb = vi.fn();
      bridge.onCLIRelaunchNeededCallback(relaunchCb);
      bridge.setLauncher({
        touchActivity: vi.fn(),
        touchUserMessage: vi.fn(),
        getSession: vi.fn(() => ({ state: "exited", killedByIdleManager: false })),
      } as any);
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);
      emitCodexSessionReady(adapter, { cliSessionId: "thread-grace-expiry" });

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);

      const spy = vi.spyOn(bridge, "emitTakodeEvent");

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run and recover if possible",
        }),
      );
      await Promise.resolve();
      adapter.emitTurnStarted("turn-grace-expiry");

      adapter.emitDisconnect("turn-grace-expiry");
      await Promise.resolve();

      expect(bridge.getSession(sid)!.isGenerating).toBe(true);
      expect(bridge.getSession(sid)!.state.backend_state).toBe("recovering");

      vi.advanceTimersByTime(16_000);
      await Promise.resolve();

      const turnEndCalls = spy.mock.calls.filter(
        ([eventSid, eventType]) => eventSid === sid && eventType === "turn_end",
      );
      expect(turnEndCalls).toHaveLength(0);
      expect(bridge.getSession(sid)!.isGenerating).toBe(true);

      (bridge as any).markCodexAutoRecoveryFailed(sid);

      const turnEndCallsAfterFailure = spy.mock.calls.filter(
        ([eventSid, eventType]) => eventSid === sid && eventType === "turn_end",
      );
      expect(turnEndCallsAfterFailure).toHaveLength(1);
      expect(turnEndCallsAfterFailure[0]?.[2]).toEqual(
        expect.objectContaining({
          interrupted: true,
          interrupt_source: "system",
        }),
      );
      expect(bridge.getSession(sid)!.isGenerating).toBe(false);

      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mark leader correction turn_end as interrupted when the current codex turn completes before the queued follow-up begins", async () => {
    vi.useFakeTimers();
    const leaderId = "orch-correction-no-interrupt";
    const workerId = "worker-correction-no-interrupt";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "codex", cwd: "/test" }],
    ]);

    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 1 : 2)),
    };
    bridge.setLauncher(launcherMock as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const leaderCli = makeCliSocket(leaderId);
    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-correction-no-interrupt" }));

    const workerBrowser = makeBrowserSocket(workerId);
    const workerAdapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(workerId, workerAdapter as any);
    emitCodexSessionReady(workerAdapter, { cliSessionId: "thread-worker-correction-no-interrupt" });
    bridge.handleBrowserOpen(workerBrowser, workerId);

    const eventSpy = vi.spyOn(bridge, "emitTakodeEvent");
    const herdInjectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Implement the baseline version",
      }),
    );
    await Promise.resolve();
    workerAdapter.emitTurnStarted("turn-worker-correction-no-interrupt-1");

    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Correction: also include validation",
        agentSource: { sessionId: leaderId, sessionLabel: "#1 leader" },
      }),
    );
    await Promise.resolve();

    workerAdapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed original turn before correction follow-up started",
        duration_ms: 220,
        duration_api_ms: 220,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-no-interrupt-result-1",
        session_id: workerId,
      },
    });
    await Promise.resolve();

    vi.advanceTimersByTime(600);
    await Promise.resolve();

    bridge.handleCLIMessage(
      leaderCli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ack",
        duration_ms: 100,
        duration_api_ms: 100,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "leader-herd-ack-no-interrupt-1",
        session_id: leaderId,
      }),
    );
    await Promise.resolve();

    workerAdapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed correction follow-up turn",
        duration_ms: 410,
        duration_api_ms: 410,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-no-interrupt-result-2",
        session_id: workerId,
      },
    });
    await Promise.resolve();
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    try {
      const workerTurnEndCalls = eventSpy.mock.calls.filter(
        ([sid, eventType]) => sid === workerId && eventType === "turn_end",
      );
      expect(workerTurnEndCalls).toHaveLength(2);
      expect(workerTurnEndCalls[0]?.[2]).toEqual(
        expect.not.objectContaining({
          interrupted: true,
        }),
      );
      expect(workerTurnEndCalls[1]?.[2]).toEqual(
        expect.not.objectContaining({
          interrupted: true,
        }),
      );

      const herdDeliveries = herdInjectSpy.mock.calls.filter(
        ([sid, _content, source]) => sid === leaderId && source?.sessionId === "herd-events",
      );
      // Both turn_end events are delivered to the leader: user-initiated
      // ones are annotated with "(user-initiated)" so the leader has full
      // visibility into all worker state changes.
      expect(herdDeliveries).toHaveLength(2);
    } finally {
      dispatcher.destroy();
      eventSpy.mockRestore();
      herdInjectSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
