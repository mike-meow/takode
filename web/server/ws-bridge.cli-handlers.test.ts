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

describe("CLI handlers", () => {
  it("handleCLIOpen: sets backendSocket and broadcasts backend_connected", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    // Clear session_init send calls
    browser.send.mockClear();

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.backendSocket).toBe(cli);
    expect(bridge.isBackendConnected("s1")).toBe(true);

    // Should have broadcast backend_connected
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_connected" }));
  });

  it("handleCLIOpen: flushes pending messages immediately", () => {
    // Per the SDK protocol, the first user message triggers system.init,
    // so queued messages must be flushed as soon as the CLI WebSocket connects
    // (not deferred until system.init, which would create a deadlock for
    // slow-starting sessions like Docker containers).
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello queued",
      }),
    );

    // CLI not yet connected, message should be queued
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages.length).toBe(1);

    // Now connect CLI — messages should be flushed immediately
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Pending should have been flushed
    expect(session.pendingMessages).toEqual([]);
    // The CLI socket should have received the queued message
    expect(cli.send).toHaveBeenCalled();
    const sentCalls = cli.send.mock.calls.map(([arg]: [string]) => arg);
    const userMsg = sentCalls.find((s: string) => s.includes('"type":"user"'));
    expect(userMsg).toBeDefined();
    const parsed = JSON.parse(userMsg!.trim());
    expect(parsed.type).toBe("user");
    // CLI-bound content gets a [User HH:MM] timestamp prefix
    expect(parsed.message.content).toMatch(/^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] hello queued$/);
  });

  // ── WebSocket system prompt injection via initialize control_request ──

  /** Parse CLI socket send calls and find the initialize control_request, if any. */
  function findInitializeMsg(cli: ReturnType<typeof makeCliSocket>) {
    const sent = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg.trim()));
    return sent.find((m: any) => m.type === "control_request" && m.request?.subtype === "initialize") as
      | { type: string; request_id: string; request: { subtype: string; appendSystemPrompt?: string } }
      | undefined;
  }

  /** Set up a mock launcher returning a session with the given backendType and optional instructions. */
  function setLauncherSession(backendType: string, instructions?: string) {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({
        sessionId: "s1",
        state: "connected",
        backendType,
        ...(instructions !== undefined ? { injectedSystemPrompt: instructions } : {}),
      })),
    } as any);
  }

  it("handleCLIOpen: sends initialize control_request with appendSystemPrompt for WebSocket sessions", () => {
    // The --append-system-prompt CLI flag is not honored in --sdk-url mode.
    // Instead, we send a control_request {subtype: "initialize", appendSystemPrompt}
    // over the WebSocket before the first user message.
    const instructions =
      "## Session Timers\n\nUse `takode timer` to create timers.\n\n## Link Syntax\n\nTest instructions";
    setLauncherSession("claude", instructions);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const initMsg = findInitializeMsg(cli);
    expect(initMsg).toBeDefined();
    expect(initMsg!.request.appendSystemPrompt).toBe(instructions);
    expect(initMsg!.request_id).toBeDefined();

    const session = bridge.getSession("s1")!;
    expect(session.cliInitializeSent).toBe(true);
  });

  it("handleCLIOpen: does NOT send initialize for SDK sessions", () => {
    // SDK sessions inject system prompts via V4.prototype.initialize patching,
    // not via WebSocket control_request.
    setLauncherSession("claude-sdk", "some instructions");

    const session = bridge.getOrCreateSession("s1", "claude-sdk");
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    expect(findInitializeMsg(cli)).toBeUndefined();
    expect(session.cliInitializeSent).toBe(false);
  });

  it("handleCLIOpen: does NOT send initialize for Codex sessions", () => {
    // Codex uses JSON-RPC initialize, not the NDJSON control_request.
    setLauncherSession("codex", "some instructions");

    const session = bridge.getOrCreateSession("s1", "codex");
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    expect(findInitializeMsg(cli)).toBeUndefined();
    expect(session.cliInitializeSent).toBe(false);
  });

  it("handleCLIOpen: does NOT send initialize when no injectedSystemPrompt", () => {
    // If the launcher has no instructions, skip the initialize request.
    setLauncherSession("claude");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    expect(findInitializeMsg(cli)).toBeUndefined();

    const session = bridge.getSession("s1")!;
    expect(session.cliInitializeSent).toBe(false);
  });

  it("handleCLIOpen: does NOT send initialize when injectedSystemPrompt is empty string", () => {
    // Empty string is falsy -- should not trigger an initialize request.
    setLauncherSession("claude", "");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    expect(findInitializeMsg(cli)).toBeUndefined();
    expect(bridge.getSession("s1")!.cliInitializeSent).toBe(false);
  });

  it("handleCLIOpen: seamless reconnect does NOT re-send initialize", () => {
    // When CLI disconnects for token refresh and reconnects within the grace
    // period, we should NOT re-send initialize (same process, already initialized).
    setLauncherSession("claude", "## Timers\nTest");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // First connect -- should send initialize
    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    const session = bridge.getSession("s1")!;
    expect(session.cliInitializeSent).toBe(true);

    // Simulate disconnect (triggers grace timer)
    bridge.handleCLIClose(cli1, 1006, "token refresh");

    // Reconnect within grace period (seamless)
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");

    // cliInitializeSent should still be true (not reset)
    expect(session.cliInitializeSent).toBe(true);
    expect(findInitializeMsg(cli2)).toBeUndefined();
  });

  it("handleCLIOpen: relaunch resets cliInitializeSent and re-sends initialize", () => {
    // When a CLI process is killed and relaunched, the new process needs
    // a fresh initialize control_request.
    const instructions = "## Timers\nTest";
    setLauncherSession("claude", instructions);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // First connect
    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    const session = bridge.getSession("s1")!;
    expect(session.cliInitializeSent).toBe(true);

    // Simulate disconnect
    bridge.handleCLIClose(cli1, 1006, "relaunch");

    // Mark relaunch pending (as cli-launcher does via onBeforeRelaunch callback)
    session.relaunchPending = true;

    // New CLI process connects
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");

    // cliInitializeSent should be true again (reset then re-sent)
    expect(session.cliInitializeSent).toBe(true);

    const initMsg2 = findInitializeMsg(cli2);
    expect(initMsg2).toBeDefined();
    expect(initMsg2!.request.appendSystemPrompt).toBe(instructions);
  });

  it("handleCLIOpen: clears stale pendingPermissions on relaunch reconnect", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    const session = bridge.getSession("s1")!;

    // Simulate a pending ExitPlanMode permission
    session.pendingPermissions.set("stale-plan-1", {
      request_id: "stale-plan-1",
      tool_name: "ExitPlanMode",
      input: { plan: "## Plan\n\nDo stuff" },
      tool_use_id: "tool-1",
      timestamp: Date.now(),
    });

    // Disconnect
    bridge.handleCLIClose(cli1, 1006, "relaunch");
    // handleCLIClose clears them, but simulate server-restart scenario where
    // they were restored from disk before close handler ran
    session.pendingPermissions.set("stale-plan-1", {
      request_id: "stale-plan-1",
      tool_name: "ExitPlanMode",
      input: { plan: "## Plan\n\nDo stuff" },
      tool_use_id: "tool-1",
      timestamp: Date.now(),
    });

    session.relaunchPending = true;
    browser.send.mockClear();

    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");

    expect(session.pendingPermissions.size).toBe(0);
    const cancelled = browser.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .filter((msg: any) => msg.type === "permission_cancelled");
    expect(cancelled).toEqual([expect.objectContaining({ type: "permission_cancelled", request_id: "stale-plan-1" })]);
  });

  it("handleCLIOpen: clears stale pendingPermissions restored from disk on server restart", () => {
    // Simulate server restart: session is restored from disk with stale permissions,
    // then CLI connects fresh (no disconnectGraceTimer set).
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    const session = bridge.getSession("s1")!;

    // Inject stale permission as if restored from disk
    session.pendingPermissions.set("stale-ask-1", {
      request_id: "stale-ask-1",
      tool_name: "AskUserQuestion",
      input: { questions: [{ question: "Which?", options: [] }] },
      tool_use_id: "tool-ask-1",
      timestamp: Date.now(),
    });

    browser.send.mockClear();

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    expect(session.pendingPermissions.size).toBe(0);
    const cancelled = browser.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .filter((msg: any) => msg.type === "permission_cancelled");
    expect(cancelled).toEqual([expect.objectContaining({ type: "permission_cancelled", request_id: "stale-ask-1" })]);
  });

  it("handleCLIOpen: preserves pendingPermissions on seamless reconnect", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    const session = bridge.getSession("s1")!;

    session.pendingPermissions.set("valid-perm-1", {
      request_id: "valid-perm-1",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "tool-bash-1",
      timestamp: Date.now(),
    });

    // Simulate disconnect with grace period (seamless reconnect path)
    bridge.handleCLIClose(cli1, 1006, "transient");
    // Re-add permission since handleCLIClose cleared it -- in a true seamless
    // reconnect the CLI process stays alive and the permission is still valid.
    // We test the handleCLIOpen logic by setting seamlessReconnect directly.
    session.pendingPermissions.set("valid-perm-1", {
      request_id: "valid-perm-1",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "tool-bash-1",
      timestamp: Date.now(),
    });
    session.seamlessReconnect = true;

    browser.send.mockClear();
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");

    // Permission should still be there
    expect(session.pendingPermissions.size).toBe(1);
    expect(session.pendingPermissions.has("valid-perm-1")).toBe(true);
    const cancelled = browser.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .filter((msg: any) => msg.type === "permission_cancelled");
    expect(cancelled).toHaveLength(0);
  });

  it("handleCLIClose ignores a stale socket after a newer CLI socket is attached", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");

    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.backendSocket).toBe(cli2);

    browser.send.mockClear();
    bridge.handleCLIClose(cli1, 1006, "stale close");

    expect(session.backendSocket).toBe(cli2);
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("handleCLIOpen: initialize is sent BEFORE queued user messages", () => {
    // The NDJSON protocol requires initialize to be sent before the first user
    // message. Verify ordering when there are pending messages.
    setLauncherSession("claude", "## Timers\nTest");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Queue a user message before CLI connects
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "hello" }));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Check ordering: initialize should come before the user message
    const sent = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg.trim()));
    const initIdx = sent.findIndex((m: any) => m.type === "control_request" && m.request?.subtype === "initialize");
    const userIdx = sent.findIndex((m: any) => m.type === "user");
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeLessThan(userIdx);
  });

  it("handleCLIMessage: system.init does not re-flush already-sent messages", () => {
    // Messages are flushed on CLI connect, so by the time system.init
    // arrives the queue should already be empty.
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello queued",
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages.length).toBe(1);

    // Connect CLI — messages flushed immediately
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    expect(session.pendingMessages).toEqual([]);
    const sendCountAfterOpen = cli.send.mock.calls.length;

    // Send system.init — no additional flush should happen
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Verify no additional user messages were sent after system.init
    const newCalls = cli.send.mock.calls.slice(sendCountAfterOpen);
    const userMsgAfterInit = newCalls.find(([arg]: [string]) => arg.includes('"type":"user"'));
    expect(userMsgAfterInit).toBeUndefined();
  });

  it("defers injected herd events during Claude WebSocket replay without creating a phantom queued turn", async () => {
    // q-467 regression: the unsafe window is after reconnect init when the
    // leader already passes `isSessionIdle()` but is still in cliResuming
    // replay. The herd preview reaches browser history immediately, while the
    // synthetic wakeup must stay queued until replay completes.
    vi.useFakeTimers();
    const leaderId = "orch-ws-herd-replay";
    const workerId = "worker-ws-herd-replay";
    const launcherSessions = new Map<string, any>([
      [
        leaderId,
        { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test", cliSessionId: "cli-prev" },
      ],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "claude", cwd: "/test" }],
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

    const session = bridge.getOrCreateSession(leaderId);
    session.messageHistory.push({
      type: "assistant",
      message: { id: "prev-msg", role: "assistant", content: [] },
    } as any);

    const leaderCli = makeCliSocket(leaderId);
    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-ws-herd-replay" }));
    expect(session.cliInitReceived).toBe(true);
    expect(session.cliResuming).toBe(true);
    leaderCli.send.mockClear();

    bridge.emitTakodeEvent(workerId, "turn_end", { duration_ms: 1000 });
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    expect(bridge.getSession(leaderId)?.lastUserMessage).toContain("1 event from 1 session");
    const outboundDuringReplay = leaderCli.send.mock.calls
      .map(([arg]: [string]) => arg as string)
      .find((line: string) => line.includes('"type":"user"'));
    expect(outboundDuringReplay).toBeUndefined();
    expect(session.pendingMessages).toHaveLength(1);
    expect(session.isGenerating).toBe(true);
    expect(session.queuedTurnStarts).toBe(0);
    expect(JSON.parse(session.pendingMessages[0]!)).toMatchObject({
      type: "user",
      message: expect.objectContaining({
        role: "user",
      }),
    });

    vi.advanceTimersByTime(2100);
    await Promise.resolve();

    expect(session.cliResuming).toBe(false);
    expect(session.isGenerating).toBe(true);
    expect(session.queuedTurnStarts).toBe(0);
    const outboundAfterReplay = leaderCli.send.mock.calls
      .map(([arg]: [string]) => arg as string)
      .filter((line: string) => line.includes('"type":"user"'));
    expect(outboundAfterReplay).toHaveLength(1);
    expect(outboundAfterReplay[0]).toContain("1 event from 1 session");
    expect(session.pendingMessages).toHaveLength(0);

    bridge.handleCLIMessage(
      leaderCli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "processed herd wakeup",
        duration_ms: 400,
        duration_api_ms: 350,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "uuid-herd-replay-result",
        session_id: "cli-orch-ws-herd-replay",
      }),
    );

    expect(session.isGenerating).toBe(false);
    expect(session.queuedTurnStarts).toBe(0);
    expect(session.queuedTurnReasons).toEqual([]);
    expect(session.queuedTurnUserMessageIds).toEqual([]);
    expect(session.queuedTurnInterruptSources).toEqual([]);

    dispatcher.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("handleCLIMessage: system.init does not emit turn_end for an in-flight user dispatch", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    browser.send.mockClear();

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // User message marks the session running immediately.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello",
      }),
    );
    expect(bridge.getSession("s1")!.isGenerating).toBe(true);

    // Regression: when system.init arrives before assistant/result output,
    // we should preserve the in-flight turn instead of emitting a fake turn_end.
    bridge.handleCLIMessage(cli, makeInitMsg());

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls).toHaveLength(0);
    expect(bridge.getSession("s1")!.isGenerating).toBe(true);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const idleStatus = calls.find((m: any) => m.type === "status_change" && m.status === "idle");
    expect(idleStatus).toBeUndefined();

    spy.mockRestore();
  });

  it("handleCLIMessage: parses NDJSON and routes system.init", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession("s1")!;
    expect(session.state.model).toBe("claude-sonnet-4-5-20250929");
    expect(session.state.cwd).toBe("/test");

    // Should broadcast session_init to browser
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const initCall = calls.find((c: any) => c.type === "session_init");
    expect(initCall).toBeDefined();
    expect(initCall.session.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("handleCLIMessage: system.init fires onCLISessionIdReceived callback", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const callback = vi.fn();
    bridge.onCLISessionId = callback;

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ session_id: "cli-internal-id" }));

    expect(callback).toHaveBeenCalledWith("s1", "cli-internal-id");
  });

  it("handleCLIMessage: updates state from init (model, cwd, tools, permissionMode)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    bridge.handleCLIMessage(
      cli,
      makeInitMsg({
        model: "claude-opus-4-5-20250929",
        cwd: "/workspace",
        tools: ["Bash", "Read", "Edit"],
        permissionMode: "bypassPermissions",
        claude_code_version: "2.0",
        mcp_servers: [{ name: "test-mcp", status: "connected" }],
        agents: ["agent1"],
        slash_commands: ["/commit"],
        skills: ["pdf"],
      }),
    );

    const state = bridge.getSession("s1")!.state;
    expect(state.model).toBe("claude-opus-4-5-20250929");
    expect(state.cwd).toBe("/workspace");
    expect(state.tools).toEqual(["Bash", "Read", "Edit"]);
    expect(state.permissionMode).toBe("bypassPermissions");
    expect(state.claude_code_version).toBe("2.0");
    expect(state.mcp_servers).toEqual([{ name: "test-mcp", status: "connected" }]);
    expect(state.agents).toEqual(["agent1"]);
    expect(state.slash_commands).toEqual(["/commit"]);
    expect(state.skills).toEqual(["pdf"]);
  });

  it("handleCLIMessage: system.init preserves host cwd for containerized sessions", async () => {
    // applyInitialSessionState pre-populates container host cwd before CLI connects
    bridge.applyInitialSessionState("s1", { containerizedHostCwd: "/Users/stan/Dev/myproject" });

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("rev-parse HEAD")) return "head-main\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/Users/stan/Dev/myproject\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // CLI inside the container reports /workspace — should be ignored
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.cwd).toBe("/Users/stan/Dev/myproject");
    expect(state.is_containerized).toBe(true);
    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    await vi.waitFor(() => {
      expect(state.git_branch).toBe("main");
      expect(state.repo_root).toBe("/Users/stan/Dev/myproject");
    });
  });

  it("handleCLIMessage: markWorktree pre-populates repo_root, git_default_branch, and diff_base_branch", async () => {
    // markWorktree sets is_worktree, repo_root, cwd, git_default_branch, and diff_base_branch before CLI connects
    bridge.markWorktree(
      "s1",
      "/home/user/companion",
      "/home/user/.companion/worktrees/companion/jiayi-wt-1234",
      "jiayi",
    );

    const state = bridge.getSession("s1")!.state;
    expect(state.is_worktree).toBe(true);
    expect(state.repo_root).toBe("/home/user/companion");
    expect(state.cwd).toBe("/home/user/.companion/worktrees/companion/jiayi-wt-1234");
    expect(state.git_default_branch).toBe("jiayi");
    // diff_base_branch should be set from defaultBranch at creation
    expect(state.diff_base_branch).toBe("jiayi");

    // After CLI connects, resolveGitInfo runs (fire-and-forget) and should preserve the worktree info
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("rev-parse HEAD")) return "wt-head-1\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      throw new Error("unknown git cmd");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/home/user/.companion/worktrees/companion/jiayi-wt-1234" }));

    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    const stateAfter = bridge.getSession("s1")!.state;
    await vi.waitFor(() => {
      // repo_root should still point to the parent repo, not the worktree
      expect(stateAfter.repo_root).toBe("/home/user/companion");
      expect(stateAfter.is_worktree).toBe(true);
      expect(stateAfter.git_branch).toBe("jiayi-wt-1234");
    });
  });

  it("markWorktree: diffBaseBranch overrides defaultBranch for diff_base_branch", () => {
    // When both defaultBranch and diffBaseBranch are provided,
    // git_default_branch should use defaultBranch while diff_base_branch uses diffBaseBranch
    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main", "jiayi");

    const state = bridge.getSession("s1")!.state;
    expect(state.git_default_branch).toBe("main");
    expect(state.diff_base_branch).toBe("jiayi");
  });

  it("markWorktree: preserves an explicit default diff base selection", () => {
    // Restart path: an explicit "use default" selection persists as empty-string
    // plus the explicit flag, and worktree prepopulation must not overwrite it.
    const session = bridge.getOrCreateSession("s1");
    session.state.diff_base_branch = "";
    session.state.diff_base_branch_explicit = true;

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");

    const state = bridge.getSession("s1")!.state;
    expect(state.git_default_branch).toBe("jiayi");
    expect(state.diff_base_branch).toBe("");
    expect(state.diff_base_branch_explicit).toBe(true);
  });

  it("setDiffBaseBranch updates session state, triggers recomputation, and broadcasts", async () => {
    // Mock git commands for the refreshGitInfo + computeDiffStats calls
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("--left-right --count")) return "1\t3\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "10\t5\tfile.ts\n";
      return "";
    });

    // Create a session with a browser connected and a tracked changed file
    bridge.markWorktree("s1", "/home/user/companion", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    // Ensure the session has a CLI socket so refreshGitInfo/recomputeDiffIfDirty don't skip
    (session as any).backendSocket = { send: vi.fn() };
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    browserWs.send.mockClear();

    // Set diff base branch — triggers immediate recomputation
    const result = bridge.setDiffBaseBranch("s1", "feature-branch");
    expect(result).toBe(true);

    // Wait for async diff computation
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(10);
    });

    const state = bridge.getSession("s1")!.state;
    expect(state.diff_base_branch).toBe("feature-branch");
    expect(state.diff_base_branch_explicit).toBe(true);
    // Should have recomputed diff stats
    expect(state.total_lines_added).toBe(10);
    expect(state.total_lines_removed).toBe(5);
    // Should have recomputed ahead/behind
    expect(state.git_ahead).toBe(3);
    expect(state.git_behind).toBe(1);

    // Verify broadcasts were sent to the browser
    const calls = (browserWs.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    // Should have a session_update with diff_base_branch
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ diff_base_branch: "feature-branch" }),
      }),
    );

    // Non-existent session returns false
    expect(bridge.setDiffBaseBranch("nonexistent", "main")).toBe(false);
  });

  it("setDiffBaseBranch recomputes diff stats even without a CLI connection", async () => {
    // Regression: changing diff base from the UI left stale line stats when
    // no CLI was connected, because recomputeDiffIfDirty's guard skipped idle sessions.
    // Current worktree semantics intentionally zero the session badge when
    // there are no ahead commits relative to the selected base.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "42\t17\tfile.ts\n";
      return "";
    });

    bridge.markWorktree("s1", "/home/user/companion", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    // Intentionally NO backendSocket -- simulates a session without active CLI
    // Seed stale stats that should be overwritten
    session.state.total_lines_added = 219;
    session.state.total_lines_removed = 126;

    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    browserWs.send.mockClear();

    bridge.setDiffBaseBranch("s1", "jiayi");

    // Wait for async diff computation to complete
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(0);
    });
    expect(session.state.total_lines_removed).toBe(0);

    // Verify the updated stats were broadcast to the browser
    const calls = (browserWs.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({
          total_lines_added: 0,
          total_lines_removed: 0,
        }),
      }),
    );
  });

  it("setDiffBaseBranch: marks an explicit default selection and persists the empty branch", async () => {
    // The real UI setter path sends empty-string when the user explicitly chooses
    // the repo default branch. That selection must become authoritative state.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "0\t0\tfile.ts\n";
      return "";
    });

    bridge.markWorktree("s1", "/home/user/companion", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    (session as any).backendSocket = { send: vi.fn() };
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    const saveSpy = vi.spyOn(store, "save");
    browserWs.send.mockClear();

    const result = bridge.setDiffBaseBranch("s1", "");
    expect(result).toBe(true);

    await vi.waitFor(() => {
      expect(saveSpy).toHaveBeenCalled();
    });

    const state = bridge.getSession("s1")!.state;
    expect(state.diff_base_branch).toBe("");
    expect(state.diff_base_branch_explicit).toBe(true);

    const saved = saveSpy.mock.calls.at(-1)?.[0];
    expect(saved?.state.diff_base_branch).toBe("");
    expect(saved?.state.diff_base_branch_explicit).toBe(true);

    const messages = browserWs.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ diff_base_branch: "" }),
      }),
    );
  });

  it("handleCLIMessage: system.init resolves git info and sets diff_base_branch via async exec", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/test-branch\n";
      if (cmd.includes("rev-parse HEAD")) return "head-feat-test\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "2\t5\n";
      // gitUtils.resolveDefaultBranch fallback commands
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    const state = bridge.getSession("s1")!.state;
    await vi.waitFor(() => {
      expect(state.git_branch).toBe("feat/test-branch");
      expect(state.repo_root).toBe("/repo");
      expect(state.git_ahead).toBe(5);
      expect(state.git_behind).toBe(2);
      // diff_base_branch should be auto-resolved since not pre-set
      expect(state.diff_base_branch).toBe("main");
      expect(state.git_default_branch).toBe("main");
    });
  });

  it("handleCLIMessage: system.init defaults non-worktree base to upstream tracking ref", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("jiayi@{upstream}")) return "origin/jiayi\n";
      if (cmd.includes("--left-right --count") && cmd.includes("origin/jiayi...HEAD")) return "1\t2\n";
      if (cmd.includes("diff --numstat")) return "";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    const state = bridge.getSession("s1")!.state;
    await vi.waitFor(() => {
      expect(state.git_default_branch).toBe("origin/jiayi");
      expect(state.diff_base_branch).toBe("origin/jiayi");
      expect(state.git_ahead).toBe(2);
      expect(state.git_behind).toBe(1);
    });
    const gitCommands = mockExec.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((cmd) => cmd.includes("rev-parse"));
    expect(gitCommands).toContainEqual(
      expect.stringContaining(
        "git --no-optional-locks -c core.fsmonitor=false rev-parse --abbrev-ref --symbolic-full-name jiayi@{upstream}",
      ),
    );
    for (const cmd of gitCommands) {
      expect(cmd).toContain("-c core.fsmonitor=false");
    }
  });

  it("handleCLIMessage: system.init migrates legacy non-worktree default base from repo default to upstream", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("jiayi@{upstream}")) return "origin/jiayi\n";
      if (cmd.includes("for-each-ref")) return "jiayi\n";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main\n";
      if (cmd.includes("--left-right --count") && cmd.includes("origin/jiayi...HEAD")) return "0\t3\n";
      if (cmd.includes("diff --numstat")) return "";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "main";
    (session as any).backendSocket = { send: vi.fn() };

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    await vi.waitFor(() => {
      expect(session.state.git_default_branch).toBe("origin/jiayi");
      expect(session.state.diff_base_branch).toBe("origin/jiayi");
      expect(session.state.git_ahead).toBe(3);
      expect(session.state.git_behind).toBe(0);
    });
  });

  it("handleCLIMessage: system.init preserves an explicit non-worktree diff base branch", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("jiayi@{upstream}")) return "origin/jiayi\n";
      if (cmd.includes("--left-right --count") && cmd.includes("main...HEAD")) return "0\t3\n";
      if (cmd.includes("for-each-ref")) return "jiayi\n";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main\n";
      if (cmd.includes("--left-right --count") && cmd.includes("origin/jiayi...HEAD")) return "0\t0\n";
      if (cmd.includes("diff --numstat")) return "";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "main";
    session.state.diff_base_branch_explicit = true;
    (session as any).backendSocket = { send: vi.fn() };

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    await vi.waitFor(() => {
      expect(session.state.git_default_branch).toBe("origin/jiayi");
      expect(session.state.diff_base_branch).toBe("main");
      expect(session.state.diff_base_branch_explicit).toBe(true);
      expect(session.state.git_ahead).toBe(3);
      expect(session.state.git_behind).toBe(0);
    });
  });

  it("handleCLIMessage: transient git failure does not erase an explicit diff base branch", async () => {
    // A transient refresh failure should not rewrite explicit branch selections.
    mockExecSync.mockImplementation(() => {
      throw new Error("git unavailable");
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "main";
    session.state.diff_base_branch_explicit = true;
    (session as any).backendSocket = { send: vi.fn() };

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    await vi.waitFor(() => {
      expect(session.state.git_branch).toBe("");
      expect(session.state.diff_base_branch).toBe("main");
      expect(session.state.diff_base_branch_explicit).toBe(true);
    });

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("jiayi@{upstream}")) return "origin/jiayi\n";
      if (cmd.includes("--left-right --count") && cmd.includes("main...HEAD")) return "0\t3\n";
      if (cmd.includes("for-each-ref")) return "jiayi\n";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main\n";
      if (cmd.includes("--left-right --count") && cmd.includes("origin/jiayi...HEAD")) return "0\t0\n";
      if (cmd.includes("diff --numstat")) return "";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    await vi.waitFor(() => {
      expect(session.state.git_default_branch).toBe("origin/jiayi");
      expect(session.state.diff_base_branch).toBe("main");
      expect(session.state.diff_base_branch_explicit).toBe(true);
      expect(session.state.git_ahead).toBe(3);
      expect(session.state.git_behind).toBe(0);
    });
  });

  it("handleCLIMessage: system.init resolves repo_root via --show-toplevel for standard repo", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("rev-parse HEAD")) return "head-main\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/home/user/myproject\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      // gitUtils.resolveDefaultBranch fallback commands
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/home/user/myproject" }));

    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    const state = bridge.getSession("s1")!.state;
    await vi.waitFor(() => {
      expect(state.repo_root).toBe("/home/user/myproject");
    });
  });

  it("handleCLIMessage: system.status updates compacting and permissionMode", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const statusMsg = JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
      permissionMode: "plan",
      uuid: "uuid-2",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, statusMsg);

    const state = bridge.getSession("s1")!.state;
    expect(state.is_compacting).toBe(true);
    expect(state.permissionMode).toBe("plan");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "compacting" }));
  });

  it("handleCLIClose: nulls backendSocket and broadcasts backend_disconnected", () => {
    vi.useFakeTimers();
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    const session = bridge.getSession("s1")!;
    expect(session.backendSocket).toBeNull();
    expect(bridge.isBackendConnected("s1")).toBe(false);

    // Side-effects are deferred by 15s grace period (CLI token refresh cycle)
    vi.advanceTimersByTime(16_000);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected" }));
    vi.useRealTimers();
  });

  it("handleCLIClose: cancels pending permissions", async () => {
    vi.useFakeTimers();
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Simulate a pending permission request
    const controlReq = JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /" },
        tool_use_id: "tu-1",
      },
    });
    bridge.handleCLIMessage(cli, controlReq);
    await vi.advanceTimersByTimeAsync(0); // flush async handleControlRequest
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    // Side-effects are deferred by 15s grace period
    vi.advanceTimersByTime(16_000);

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const cancelMsg = calls.find((c: any) => c.type === "permission_cancelled");
    expect(cancelMsg).toBeDefined();
    expect(cancelMsg.request_id).toBe("req-1");
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
