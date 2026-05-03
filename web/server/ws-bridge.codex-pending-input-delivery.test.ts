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
    setCurrentTurnIdForTest: (turnId: string | null) => {
      currentTurnId = turnId;
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

function seedStaleCodexPendingDeliveryHead(
  session: any,
  options: {
    status?: "queued" | "backend_acknowledged";
    inputs?: Array<{ id: string; content: string }>;
  } = {},
) {
  const status = options.status ?? "backend_acknowledged";
  const now = Date.now();
  const inputs = options.inputs ?? [
    { id: "old-input-1", content: "old pending instruction one" },
    { id: "old-input-2", content: "old pending instruction two" },
  ];
  const pendingInputIds = inputs.map((input) => input.id);

  session.pendingCodexInputs.push(
    ...inputs.map((input) => ({
      id: input.id,
      content: input.content,
      timestamp: now - 120_000,
      cancelable: true,
    })),
  );

  const turn = {
    adapterMsg: {
      type: "codex_start_pending",
      pendingInputIds,
      inputs: inputs.map((input) => ({ content: input.content })),
    },
    userMessageId: pendingInputIds[0],
    pendingInputIds,
    userContent: inputs.map((input) => input.content).join("\n\n"),
    historyIndex: -1,
    status,
    dispatchCount: status === "queued" ? 0 : 1,
    createdAt: now - 120_000,
    updatedAt: now - 90_000,
    acknowledgedAt: status === "backend_acknowledged" ? now - 90_000 : null,
    turnTarget: status === "backend_acknowledged" ? "queued" : null,
    lastError: null,
    turnId: null,
    disconnectedAt: status === "backend_acknowledged" ? now - 80_000 : null,
    resumeConfirmedAt: null,
  };
  session.pendingCodexTurns.push(turn);
  return turn;
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
          [
            "QUEUED",
            "PLANNING",
            "EXPLORING",
            "IMPLEMENTING",
            "CODE_REVIEWING",
            "MENTAL_SIMULATING",
            "EXECUTING",
            "OUTCOME_REVIEWING",
            "BOOKKEEPING",
            "PORTING",
          ],
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

describe("Codex pending input delivery", () => {
  it("keeps Codex user input pending until turn/start acknowledges delivery", async () => {
    const sid = "s-codex-pending";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-pending", model: "gpt-5.4", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "steer me later",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "steer me later",
    });
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "steer me later"),
    ).toBe(false);

    const pendingBroadcast = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .find((msg: any) => msg.type === "codex_pending_inputs");
    expect(pendingBroadcast?.inputs).toHaveLength(1);

    adapter.emitTurnStarted("turn-pending");

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "steer me later"),
    ).toBe(true);
  });

  it("cancels still-local pending Codex input before delivery", async () => {
    const sid = "s-codex-cancel-pending";
    const browser = makeBrowserSocket(sid);
    bridge.getOrCreateSession(sid, "codex");
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "do not deliver this",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    const pendingId = session.pendingCodexInputs[0]?.id;
    expect(pendingId).toBeTruthy();
    expect(session.pendingCodexInputs[0]?.cancelable).toBe(true);
    expect(session.pendingCodexTurns).toHaveLength(1);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: pendingId,
      }),
    );
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "do not deliver this"),
    ).toBe(false);
  });

  it("restores pending Codex inputs across restart and delivers them on reconnect", async () => {
    const sid = "s-codex-persisted-pending";
    store.saveSync({
      id: sid,
      state: bridge.getOrCreateSession(sid, "codex").state,
      messageHistory: [],
      pendingMessages: [],
      pendingCodexInputs: [
        {
          id: "pending-persisted-1",
          content: "re-deliver me after restart",
          timestamp: 1,
          cancelable: true,
          draftImages: [],
          deliveryContent: "re-deliver me after restart",
        },
      ],
      pendingPermissions: [],
    });

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back

    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    await restored.restoreFromDisk();

    const adapter = makeCodexAdapterMock();
    restored.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-restored-pending" });

    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["pending-persisted-1"],
      }),
    );
  });

  it("pokes a stale acknowledged pending-delivery head before a leader-injected follow-up", async () => {
    const sid = "s-codex-stale-leader-poke";
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-leader", model: "gpt-5.4", cwd: "/repo" });

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session);
    adapter.sendBrowserMessage.mockClear();

    const delivery = bridge.injectUserMessage(sid, "new leader instruction", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    expect(delivery).toBe("sent");
    expect(relaunchCb).not.toHaveBeenCalled();
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const retried = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retried).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-input-1", "old-input-2"],
      }),
    );
    expect(getCodexStartPendingInputs(retried).map((input) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
    ]);
    expect(staleHead.status).toBe("dispatched");
    expect(staleHead.dispatchCount).toBe(2);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
      "new leader instruction",
    ]);
    expect(session.pendingCodexInputs.map((input: any) => input.cancelable)).toEqual([false, false, true]);
    expect(session.pendingCodexTurns[1]?.adapterMsg).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: [session.pendingCodexInputs[2]?.id],
      }),
    );
    expect(session.pendingCodexTurns[1]?.status).toBe("queued");
    warnSpy.mockRestore();
  });

  it("dispatches a stale queued pending-delivery head without absorbing the leader trigger", async () => {
    const sid = "s-codex-stale-queued-leader-poke";
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-queued-leader", model: "gpt-5.4", cwd: "/repo" });

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session, { status: "queued" });
    adapter.sendBrowserMessage.mockClear();

    const delivery = bridge.injectUserMessage(sid, "new leader instruction after queued head", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    expect(delivery).toBe("sent");
    expect(relaunchCb).not.toHaveBeenCalled();
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const retried = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retried).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-input-1", "old-input-2"],
      }),
    );
    expect(getCodexStartPendingInputs(retried).map((input) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
    ]);
    expect(
      getCodexStartPendingInputs(retried).some((input) => input.content === "new leader instruction after queued head"),
    ).toBe(false);
    expect(staleHead.status).toBe("dispatched");
    expect(staleHead.dispatchCount).toBe(1);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
      "new leader instruction after queued head",
    ]);
    expect(session.pendingCodexInputs.map((input: any) => input.cancelable)).toEqual([false, false, true]);
    expect(session.pendingCodexTurns[1]?.adapterMsg).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: [session.pendingCodexInputs[2]?.id],
      }),
    );
    expect(getCodexStartPendingInputs(session.pendingCodexTurns[1]?.adapterMsg).map((input) => input.content)).toEqual([
      "new leader instruction after queued head",
    ]);
    expect(session.pendingCodexTurns[1]?.status).toBe("queued");
    warnSpy.mockRestore();
  });

  it("uses the same stale pending-delivery poke for browser/user messages", async () => {
    const sid = "s-codex-stale-browser-poke";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-browser", model: "gpt-5.4", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session, {
      inputs: [{ id: "old-browser-input", content: "old browser pending instruction" }],
    });
    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "new browser instruction",
      }),
    );
    await Promise.resolve();

    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const retried = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retried).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-browser-input"],
      }),
    );
    expect(getCodexStartPendingInputs(retried).map((input) => input.content)).toEqual([
      "old browser pending instruction",
    ]);
    expect(staleHead.status).toBe("dispatched");
    expect(staleHead.dispatchCount).toBe(2);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old browser pending instruction",
      "new browser instruction",
    ]);
    warnSpy.mockRestore();
  });

  it("dispatches a stale queued pending-delivery head without absorbing the browser trigger", async () => {
    const sid = "s-codex-stale-queued-browser-poke";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-queued-browser", model: "gpt-5.4", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session, {
      status: "queued",
      inputs: [{ id: "old-queued-browser-input", content: "old queued browser instruction" }],
    });
    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "new browser instruction after queued head",
      }),
    );
    await Promise.resolve();

    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const retried = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(retried).toEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-queued-browser-input"],
      }),
    );
    expect(getCodexStartPendingInputs(retried).map((input) => input.content)).toEqual([
      "old queued browser instruction",
    ]);
    expect(
      getCodexStartPendingInputs(retried).some(
        (input) => input.content === "new browser instruction after queued head",
      ),
    ).toBe(false);
    expect(staleHead.status).toBe("dispatched");
    expect(staleHead.dispatchCount).toBe(1);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old queued browser instruction",
      "new browser instruction after queued head",
    ]);
    expect(session.pendingCodexInputs.map((input: any) => input.cancelable)).toEqual([false, true]);
    expect(getCodexStartPendingInputs(session.pendingCodexTurns[1]?.adapterMsg).map((input) => input.content)).toEqual([
      "new browser instruction after queued head",
    ]);
    warnSpy.mockRestore();
  });

  it("does not retry stale pending delivery while Codex reports an active current turn", async () => {
    const sid = "s-codex-stale-current-turn";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-active-current", model: "gpt-5.4", cwd: "/repo" });

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session);
    adapter.setCurrentTurnIdForTest("turn-active");
    adapter.sendBrowserMessage.mockClear();

    bridge.injectUserMessage(sid, "follow-up for active turn", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    const sentMessages = adapter.sendBrowserMessage.mock.calls.map((call: any[]) => call[0]);
    expect(sentMessages).not.toContainEqual(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["old-input-1", "old-input-2"],
      }),
    );
    expect(sentMessages).toContainEqual(
      expect.objectContaining({
        type: "codex_steer_pending",
        expectedTurnId: "turn-active",
      }),
    );
    expect(staleHead.status).toBe("backend_acknowledged");
    expect(staleHead.dispatchCount).toBe(1);
  });

  it("does not retry stale pending delivery while the session is actively generating", async () => {
    const sid = "s-codex-stale-generating";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-active-generating", model: "gpt-5.4", cwd: "/repo" });

    const session = bridge.getSession(sid)!;
    const staleHead = seedStaleCodexPendingDeliveryHead(session);
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 1_000;
    adapter.sendBrowserMessage.mockClear();

    bridge.injectUserMessage(sid, "queued during active generation", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    expect(staleHead.status).toBe("backend_acknowledged");
    expect(staleHead.dispatchCount).toBe(1);
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toEqual([
      "old pending instruction one",
      "old pending instruction two",
      "queued during active generation",
    ]);
  });

  it("leaves adapter-missing pending delivery on the existing relaunch path", async () => {
    const sid = "s-codex-missing-adapter-still-recovers";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "codex", state: "connected", killedByIdleManager: false })),
    } as any);

    const session = bridge.getOrCreateSession(sid, "codex");
    session.state.backend_state = "connected";

    const delivery = bridge.injectUserMessage(sid, "wake missing adapter", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });
    await Promise.resolve();

    expect(delivery).toBe("queued");
    expect(relaunchCb).toHaveBeenCalledTimes(1);
    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(session.state.backend_state).toBe("recovering");
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("wake missing adapter");
  });
});
