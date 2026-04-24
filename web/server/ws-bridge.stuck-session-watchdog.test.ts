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

describe("stuck session watchdog", () => {
  it("does not flag a freshly-started generation with stale lastCliMessageAt", () => {
    vi.useFakeTimers();
    const sid = "s-stuck-false-positive";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Simulate a previous turn that ended 5 minutes ago
    session.lastCliMessageAt = Date.now() - 300_000;
    session.lastCliPingAt = Date.now() - 300_000;

    // Start a new generation (user sends a message)
    session.isGenerating = true;
    session.generationStartedAt = Date.now();
    session.stuckNotifiedAt = null;

    // Start the watchdog
    bridge.startStuckSessionWatchdog();

    // Advance past the 30s check interval
    vi.advanceTimersByTime(31_000);

    // Should NOT have sent session_stuck — generation just started
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(0);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("flags a session stuck after generating for longer than the threshold with no CLI activity", () => {
    vi.useFakeTimers();
    const sid = "s-stuck-real";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago, no CLI activity since
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    // Advance past the check interval
    vi.advanceTimersByTime(31_000);

    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(1);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("detects stuck session even when keep_alive pings are recent", () => {
    // Regression test for q-237: keep_alive pings indicate the CLI process
    // is alive (network liveness) but should NOT be treated as real activity.
    // A session with stale lastCliMessageAt but recent lastCliPingAt is stuck.
    vi.useFakeTimers();
    const sid = "s-stuck-keepalive";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago, no real CLI output since
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    // But keep_alive pings are recent (CLI process is alive)
    session.lastCliPingAt = Date.now() - 10_000;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should be flagged as stuck despite recent keep_alive pings
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(1);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("detects stuck session when toolStartTimes entries are stale (older than 5 min)", () => {
    // Regression test for q-237 follow-up: stale toolStartTimes entries from
    // missed tool_results were permanently suppressing stuck detection. Tools
    // older than AUTO_RECOVER_MS (5 min) should be treated as stale and not
    // prevent stuck detection from firing.
    vi.useFakeTimers();
    const sid = "s-stuck-stale-tools";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 6 minutes ago, no CLI activity since
    const sixMinAgo = Date.now() - 360_000;
    session.isGenerating = true;
    session.generationStartedAt = sixMinAgo;
    session.lastCliMessageAt = sixMinAgo;
    session.lastCliPingAt = sixMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    // Stale tool entry from 6 minutes ago (missed tool_result)
    session.toolStartTimes.set("tool-stale-123", sixMinAgo);

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should auto-recover despite toolStartTimes being non-empty
    expect(session.isGenerating).toBe(false);
    // Stale tools should be cleared during auto-recovery
    expect(session.toolStartTimes.size).toBe(0);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sends session_unstuck when CLI activity resumes", () => {
    vi.useFakeTimers();
    const sid = "s-stuck-recover";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Session has been generating for 3 minutes with no activity
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    // First tick: should fire session_stuck
    vi.advanceTimersByTime(31_000);
    expect(session.stuckNotifiedAt).not.toBeNull();

    // Simulate CLI activity resuming
    session.lastCliMessageAt = Date.now();

    // Second tick: should fire session_unstuck
    browser.send.mockClear();
    vi.advanceTimersByTime(30_000);

    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const unstuckMessages = sentMessages.filter((m: any) => m.type === "session_unstuck");
    expect(unstuckMessages).toHaveLength(1);
    expect(session.stuckNotifiedAt).toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not flag a session as stuck when async sub-agents have recent tool_progress", () => {
    // When the main agent spawns async sub-agents, it goes quiet while waiting
    // for them to complete. Sub-agent tool_progress updates (Agent/Task tool)
    // should prevent false "stuck" warnings even though lastCliMessageAt is stale.
    vi.useFakeTimers();
    const sid = "s-stuck-subagent";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago, no direct CLI message since
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.stuckNotifiedAt = null;

    // But a tool sent tool_progress 30 seconds ago
    session.lastToolProgressAt = Date.now() - 30_000;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should NOT be flagged as stuck — sub-agent is actively running
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(0);
    expect(session.stuckNotifiedAt).toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not flag a session as stuck when tools are actively running (block=true Bash)", () => {
    // When a CLI is executing a blocking command (e.g. `sleep 600` with block=true),
    // there are no tool_progress events or CLI messages. The session has an active
    // tool in toolStartTimes, which proves the CLI is alive and waiting for the tool.
    vi.useFakeTimers();
    const sid = "s-stuck-blocking-tool";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 5 minutes ago, no CLI activity since
    const fiveMinAgo = Date.now() - 300_000;
    session.isGenerating = true;
    session.generationStartedAt = fiveMinAgo;
    session.lastCliMessageAt = fiveMinAgo;
    session.lastCliPingAt = fiveMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    // But a tool is actively running (started recently, not stale)
    session.toolStartTimes.set("tool-bash-123", Date.now() - 60_000);

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should NOT be flagged as stuck — a tool is actively running
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(0);
    expect(session.stuckNotifiedAt).toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("clears stuck flag when a tool starts running on a previously-stuck session", () => {
    // If a session was flagged as stuck and then a tool starts (toolStartTimes
    // becomes non-empty), the next watchdog tick should send session_unstuck.
    vi.useFakeTimers();
    const sid = "s-stuck-then-tool";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Use 3 minutes (below the 5-min auto-recovery threshold) so the session
    // gets flagged as stuck without being auto-recovered on the first tick.
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    // First tick: no tools running, should fire session_stuck
    vi.advanceTimersByTime(31_000);
    expect(session.stuckNotifiedAt).not.toBeNull();

    // Now a tool starts running
    session.toolStartTimes.set("tool-bash-456", Date.now());
    browser.send.mockClear();

    // Second tick: should fire session_unstuck because tool is active
    vi.advanceTimersByTime(30_000);
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const unstuckMessages = sentMessages.filter((m: any) => m.type === "session_unstuck");
    expect(unstuckMessages).toHaveLength(1);
    expect(session.stuckNotifiedAt).toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("auto-recovers a stuck session after 5 minutes by clearing isGenerating", () => {
    // When a session has been stuck for 5+ minutes with the CLI still connected
    // (e.g., missed result message), the watchdog should force-clear isGenerating
    // to recover the session. This is the last-resort safety net, especially for
    // herded workers which skip the optimistic 30s running timer.
    vi.useFakeTimers();
    const sid = "s-stuck-auto-recover";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 6 minutes ago, no CLI activity since
    const sixMinAgo = Date.now() - 360_000;
    session.isGenerating = true;
    session.generationStartedAt = sixMinAgo;
    session.lastCliMessageAt = sixMinAgo;
    session.lastCliPingAt = sixMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();
    browser.send.mockClear();

    vi.advanceTimersByTime(31_000);

    // Should have auto-recovered: isGenerating cleared
    expect(session.isGenerating).toBe(false);
    expect(session.generationStartedAt).toBeNull();

    // Should have received both session_stuck (first detection) and status_change idle + session_unstuck (recovery)
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    const idleMessages = sentMessages.filter((m: any) => m.type === "status_change" && m.status === "idle");
    const unstuckMessages = sentMessages.filter((m: any) => m.type === "session_unstuck");
    expect(stuckMessages).toHaveLength(1);
    expect(idleMessages.length).toBeGreaterThanOrEqual(1);
    expect(unstuckMessages).toHaveLength(1);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not auto-recover a stuck session before 5 minutes", () => {
    // Sessions stuck for less than 5 minutes should only get the notification,
    // not auto-recovery. The CLI may genuinely be processing a long turn.
    vi.useFakeTimers();
    const sid = "s-stuck-no-recover";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago (below 5-min threshold)
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should have flagged as stuck but NOT auto-recovered
    expect(session.stuckNotifiedAt).not.toBeNull();
    expect(session.isGenerating).toBe(true); // still generating
    expect(session.generationStartedAt).not.toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("auto-recovers a stuck session even when CLI is disconnected after 5 minutes (q-307)", () => {
    // Before q-307, auto-recovery required CLI to be connected. Now, if the
    // session has been stuck for 5+ minutes AND the CLI is disconnected (relaunch
    // may have failed), the watchdog clears isGenerating as a safety net.
    vi.useFakeTimers();
    const sid = "s-stuck-cli-disconnected";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 6 minutes ago, no CLI activity since
    const sixMinAgo = Date.now() - 360_000;
    session.isGenerating = true;
    session.generationStartedAt = sixMinAgo;
    session.lastCliMessageAt = sixMinAgo;
    session.lastCliPingAt = sixMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    // Simulate CLI disconnect (backendSocket cleared)
    session.backendSocket = null;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should auto-recover even with CLI disconnected (q-307)
    expect(session.isGenerating).toBe(false);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("auto-recovers orchestrator sessions faster than regular sessions (q-307)", () => {
    // Orchestrator (leader) sessions gate herd event delivery via isSessionIdle(),
    // so a stuck leader blocks all workers. The watchdog recovers orchestrators at
    // 2 min (STUCK_GENERATION_THRESHOLD_MS) instead of the regular 5 min.
    vi.useFakeTimers();
    const sid = "s-stuck-orchestrator";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Set up launcher with isOrchestrator=true
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago — past the 2-min orchestrator threshold
    // but below the 5-min regular threshold
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should auto-recover because orchestrators use the faster 2-min threshold
    expect(session.isGenerating).toBe(false);

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
