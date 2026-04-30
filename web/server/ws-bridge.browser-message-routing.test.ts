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

describe("Browser message routing", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();
    browser.send.mockClear();
  });

  it("user_message: sends NDJSON to CLI and stores in history", () => {
    const touchUserMessage = vi.fn();
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage,
      getSession: vi.fn(() => ({})),
    } as any);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "What is 2+2?",
      }),
    );

    // Should have sent NDJSON to CLI
    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("user");
    expect(sent.message.role).toBe("user");
    // CLI-bound content gets a [User HH:MM] timestamp prefix
    expect(sent.message.content).toMatch(/^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] What is 2\+2\?$/);

    // Should store in history (without the tag -- history preserves original content)
    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("user_message");
    if (session.messageHistory[0].type === "user_message") {
      expect(session.messageHistory[0].content).toBe("What is 2+2?");
      expect(touchUserMessage).toHaveBeenCalledWith("s1", session.messageHistory[0].timestamp);
    }
  });

  it("user_message: does not touch lastUserMessageAt for agentSource messages", () => {
    // Programmatic user-shaped messages are rendered as user messages, but they
    // must not affect sidebar last-user-message ordering.
    const touchUserMessage = vi.fn();
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage,
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "worker progress",
        agentSource: { sessionId: "worker-1", sessionLabel: "#22 Worker" },
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory.filter((m) => m.type === "user_message")).toHaveLength(1);
    expect(touchUserMessage).not.toHaveBeenCalled();
  });

  it("user_message: queues when CLI not connected", () => {
    // Close CLI
    bridge.handleCLIClose(cli);
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "queued message",
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(1);
    const queued = JSON.parse(session.pendingMessages[0]);
    expect(queued.type).toBe("user");
    // CLI-bound content gets a [User HH:MM] timestamp prefix
    expect(queued.message.content).toMatch(/^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] queued message$/);
  });

  it("user_message: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "user_message",
      content: "once only",
      client_msg_id: "client-msg-1",
    };

    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const session = bridge.getSession("s1")!;
    const userMessages = session.messageHistory.filter((m) => m.type === "user_message");
    expect(userMessages).toHaveLength(1);
  });

  it("user_message: herded worker gets [Leader <session> HH:MM] for leader-forwarded messages", () => {
    // Make the session a herded worker
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "leader-session-1" })),
    } as any);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "do the task",
        agentSource: { sessionId: "leader-session-1", sessionLabel: "#17 Orchestrator" },
      }),
    );

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.message.content).toMatch(
      /^\[Leader #17 Orchestrator (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] do the task$/,
    );
  });

  it("user_message: herded worker falls back to leader session id when label is absent", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "leader-session-1" })),
    } as any);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "do the task",
        agentSource: { sessionId: "leader-session-1" },
      }),
    );

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.message.content).toMatch(
      /^\[Leader leader-s (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] do the task$/,
    );
  });

  it("user_message: herded worker gets [User HH:MM] for direct human messages", () => {
    // Make the session a herded worker
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "leader-session-1" })),
    } as any);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "direct nudge",
        // No agentSource -- message from the human
      }),
    );

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.message.content).toMatch(/^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] direct nudge$/);
  });

  it("user_message: first message includes date, same-day follow-up omits it, different-day includes it again", () => {
    // First message of a fresh session should include the date
    // (lastUserMessageDateTag starts as "").
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "msg1" }));
    expect(cli.send).toHaveBeenCalledTimes(1);
    const firstRaw = cli.send.mock.calls[0][0] as string;
    const first = JSON.parse(firstRaw.trim());
    // Date portion: "Mon, Mar 31" (weekday, month, day) must be present
    expect(first.message.content).toMatch(/^\[User \w{3}, \w{3} \d{1,2} \d{1,2}:\d{2}\s*[AP]M\] msg1$/);

    // Second message on the SAME day should omit the date (time only).
    cli.send.mockClear();
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "msg2" }));
    expect(cli.send).toHaveBeenCalledTimes(1);
    const secondRaw = cli.send.mock.calls[0][0] as string;
    const second = JSON.parse(secondRaw.trim());
    // Must NOT contain a date prefix -- should be just [User HH:MM AM/PM]
    expect(second.message.content).toMatch(/^\[User \d{1,2}:\d{2}\s*[AP]M\] msg2$/);
    // Negative check: no weekday/month in the tag
    expect(second.message.content).not.toMatch(/\w{3}, \w{3} \d{1,2}/);

    // Third message on a DIFFERENT day should include the date again.
    // Manually set lastUserMessageDateTag to a past date to simulate a day change.
    const session = bridge.getSession("s1")!;
    session.lastUserMessageDateTag = "1999-01-01";
    cli.send.mockClear();
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "msg3" }));
    expect(cli.send).toHaveBeenCalledTimes(1);
    const thirdRaw = cli.send.mock.calls[0][0] as string;
    const third = JSON.parse(thirdRaw.trim());
    // Date must be present again since the day changed
    expect(third.message.content).toMatch(/^\[User \w{3}, \w{3} \d{1,2} \d{1,2}:\d{2}\s*[AP]M\] msg3$/);
  });

  it("vscode_selection_update: broadcasts the latest global selection to browsers across sessions", () => {
    bridge.getOrCreateSession("s2");
    const otherBrowser = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(otherBrowser, "s2");
    otherBrowser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "vscode_selection_update",
        selection: {
          absolutePath: "/repo/src/app.ts",
          startLine: 10,
          endLine: 12,
          lineCount: 3,
        },
        updatedAt: 200,
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "VS Code A",
        client_msg_id: "selection-1",
      }),
    );

    const sessionOneCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const sessionTwoCalls = otherBrowser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    for (const calls of [sessionOneCalls, sessionTwoCalls]) {
      expect(calls).toContainEqual({
        type: "vscode_selection_state",
        state: {
          selection: {
            absolutePath: "/repo/src/app.ts",
            startLine: 10,
            endLine: 12,
            lineCount: 3,
          },
          updatedAt: 200,
          sourceId: "window-a",
          sourceType: "vscode-window",
          sourceLabel: "VS Code A",
        },
      });
    }
  });

  it("broadcasts session_activity_update globally when an inactive session clears a pending plan", () => {
    bridge.getOrCreateSession("worker-1");
    const leaderBrowser = makeBrowserSocket("leader-1");
    bridge.handleBrowserOpen(leaderBrowser, "leader-1");
    leaderBrowser.send.mockClear();

    const worker = bridge.getSession("worker-1")!;
    worker.pendingPermissions.set("plan-1", {
      request_id: "plan-1",
      tool_name: "ExitPlanMode",
      input: { plan: "## Plan\n\n1. Fix the stale chip" },
      tool_use_id: "tool-plan-1",
      timestamp: Date.now(),
    });

    bridge.broadcastToSession("worker-1", {
      type: "permission_request",
      request: worker.pendingPermissions.get("plan-1"),
    } as any);

    worker.pendingPermissions.delete("plan-1");
    bridge.broadcastToSession("worker-1", {
      type: "permission_approved",
      id: "approval-plan-1",
      request_id: "plan-1",
      tool_name: "ExitPlanMode",
      tool_use_id: "tool-plan-1",
      summary: "Plan approved",
      timestamp: Date.now(),
    } as any);
    bridge.broadcastToSession("worker-1", {
      type: "status_change",
      status: "running",
    } as any);

    const globalUpdates = leaderBrowser.send.mock.calls
      .map(([raw]: [string]) => JSON.parse(raw))
      .filter((msg: any) => msg.type === "session_activity_update" && msg.session_id === "worker-1");

    expect(globalUpdates).toContainEqual(
      expect.objectContaining({
        type: "session_activity_update",
        session_id: "worker-1",
        session: expect.objectContaining({
          attentionReason: null,
          pendingPermissionCount: 1,
          pendingPermissionSummary: "pending plan",
        }),
      }),
    );
    expect(globalUpdates).toContainEqual(
      expect.objectContaining({
        type: "session_activity_update",
        session_id: "worker-1",
        session: expect.objectContaining({
          attentionReason: null,
          pendingPermissionCount: 0,
          pendingPermissionSummary: null,
        }),
      }),
    );
    expect(globalUpdates).toContainEqual(
      expect.objectContaining({
        type: "session_activity_update",
        session_id: "worker-1",
        session: expect.objectContaining({
          attentionReason: null,
          pendingPermissionCount: 0,
          pendingPermissionSummary: null,
          status: "running",
        }),
      }),
    );
  });

  it("vscode_selection_update: ignores stale updates and keeps inspectable clears", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "vscode_selection_update",
        selection: {
          absolutePath: "/repo/src/app.ts",
          startLine: 10,
          endLine: 12,
          lineCount: 3,
        },
        updatedAt: 200,
        sourceId: "window-b",
        sourceType: "vscode-window",
        sourceLabel: "VS Code B",
        client_msg_id: "selection-2",
      }),
    );
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "vscode_selection_update",
        selection: {
          absolutePath: "/repo/src/older.ts",
          startLine: 1,
          endLine: 1,
          lineCount: 1,
        },
        updatedAt: 150,
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "Older",
        client_msg_id: "selection-3",
      }),
    );
    expect(browser.send).not.toHaveBeenCalled();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "vscode_selection_update",
        selection: null,
        updatedAt: 250,
        sourceId: "window-c",
        sourceType: "vscode-window",
        sourceLabel: "VS Code C",
        client_msg_id: "selection-4",
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual({
      type: "vscode_selection_state",
      state: {
        selection: null,
        updatedAt: 250,
        sourceId: "window-c",
        sourceType: "vscode-window",
        sourceLabel: "VS Code C",
      },
    });
  });

  it("registers VSCode windows and prefers the workspace root that contains the target file", async () => {
    bridge.upsertVsCodeWindowState({
      sourceId: "window-a",
      sourceType: "vscode-window",
      sourceLabel: "Repo A",
      workspaceRoots: ["/repo-a"],
      updatedAt: 100,
      lastActivityAt: 100,
    });
    bridge.upsertVsCodeWindowState({
      sourceId: "window-b",
      sourceType: "vscode-window",
      sourceLabel: "Repo B",
      workspaceRoots: ["/repo-b", "/repo-b/packages/app"],
      updatedAt: 200,
      lastActivityAt: 200,
    });

    const requestPromise = bridge.requestVsCodeOpenFile({
      absolutePath: "/repo-b/packages/app/src/main.ts",
      line: 14,
      column: 2,
    });

    const commands = bridge.pollVsCodeOpenFileCommands("window-b");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({
      commandId: expect.any(String),
      sourceId: "window-b",
      target: {
        absolutePath: "/repo-b/packages/app/src/main.ts",
        line: 14,
        column: 2,
      },
      createdAt: expect.any(Number),
    });
    expect(bridge.pollVsCodeOpenFileCommands("window-a")).toEqual([]);

    expect(bridge.resolveVsCodeOpenFileResult("window-b", commands[0].commandId, { ok: true })).toBe(true);
    await expect(requestPromise).resolves.toEqual({
      sourceId: "window-b",
      commandId: commands[0].commandId,
    });
  });

  it("requestVsCodeOpenFile: falls back to the most recent active window when no workspace root matches", async () => {
    bridge.upsertVsCodeWindowState({
      sourceId: "window-a",
      sourceType: "vscode-window",
      workspaceRoots: ["/repo-a"],
      updatedAt: 100,
      lastActivityAt: 100,
    });
    bridge.upsertVsCodeWindowState({
      sourceId: "window-b",
      sourceType: "vscode-window",
      workspaceRoots: ["/repo-b"],
      updatedAt: 200,
      lastActivityAt: 250,
    });

    const requestPromise = bridge.requestVsCodeOpenFile({
      absolutePath: "/outside/shared/file.ts",
    });
    const commands = bridge.pollVsCodeOpenFileCommands("window-b");
    expect(commands).toHaveLength(1);
    bridge.resolveVsCodeOpenFileResult("window-b", commands[0].commandId, { ok: true });
    await expect(requestPromise).resolves.toEqual({
      sourceId: "window-b",
      commandId: commands[0].commandId,
    });
  });

  it("requestVsCodeOpenFile: returns a clear error when no active VSCode windows are registered", async () => {
    await expect(
      bridge.requestVsCodeOpenFile({
        absolutePath: "/repo/src/app.ts",
      }),
    ).rejects.toThrow("No running VS Code was detected on this machine.");
  });

  it("user_message with images: prepared imageRefs route successfully even without imageStore", async () => {
    // With the new attach-time upload flow, images arrive as pre-prepared
    // imageRefs + deliveryContent. No imageStore is needed at route time.
    browser.send.mockClear();
    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "What's in this image?",
        deliveryContent:
          "What's in this image?\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath}]`,
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.message.content).toContain(`Attachment 1: ${expectedPath}`);
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((m: any) => m.type === "error")).toBeUndefined();
  });

  it("user_message with images: non-SDK Claude sends file path annotations via deliveryContent", async () => {
    // With prepared imageRefs, the browser sends deliveryContent containing
    // path annotations. No imageStore.store() call happens at route time.
    const expectedPath1 = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    const expectedPath2 = join(homedir(), ".companion", "images", "s1", "img-2.orig.jpeg");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please compare these",
        deliveryContent:
          "Please compare these\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath1}\n` +
          `Attachment 2: ${expectedPath2}]`,
        imageRefs: [
          { imageId: "img-1", media_type: "image/png" },
          { imageId: "img-2", media_type: "image/jpeg" },
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    // Images should be sent as file path annotations (plain text), not inline base64 blocks.
    expect(typeof sent.message.content).toBe("string");
    expect(sent.message.content).toContain("Please compare these");
    expect(sent.message.content).toContain(`Attachment 1: ${expectedPath1}`);
    expect(sent.message.content).toContain(`Attachment 2: ${expectedPath2}`);
    expect(sent.message.content).toContain("read these files with the Read tool before responding");
  });

  it("user_message with images: prepared imageRefs work even when imageStore has errors (store not called)", async () => {
    // With attach-time uploads, images are pre-stored. Even if imageStore
    // would fail, routing should succeed because store() is never called.
    const mockImageStore = {
      store: vi.fn().mockRejectedValue(new Error("ENOENT: image file not found")),
    };
    bridge.setImageStore(mockImageStore as any);
    browser.send.mockClear();

    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please inspect this screenshot",
        deliveryContent:
          "Please inspect this screenshot\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath}]`,
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(mockImageStore.store).not.toHaveBeenCalled();
    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.message.content).toContain(`Attachment 1: ${expectedPath}`);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((m: any) => m.type === "error")).toBeUndefined();
  });

  it("permission_response allow: sends control_response to CLI", async () => {
    // First create a pending permission
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-allow",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo hi" },
          tool_use_id: "tu-allow",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-allow",
        behavior: "allow",
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.subtype).toBe("success");
    expect(sent.response.request_id).toBe("req-allow");
    expect(sent.response.response.behavior).toBe("allow");
    expect(sent.response.response.updatedInput).toEqual({ command: "echo hi" });

    // Should remove from pending
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("req-allow")).toBe(false);
  });

  it("permission_response deny: sends deny response to CLI", () => {
    // Create a pending permission
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-deny",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
          tool_use_id: "tu-deny",
        },
      }),
    );
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-deny",
        behavior: "deny",
        message: "Too dangerous",
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.subtype).toBe("success");
    expect(sent.response.request_id).toBe("req-deny");
    expect(sent.response.response.behavior).toBe("deny");
    expect(sent.response.response.message).toBe("Too dangerous");

    // Should remove from pending
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("req-deny")).toBe(false);
  });

  it("permission_response: deduplicates repeated client_msg_id", () => {
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-dedupe",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo hi" },
          tool_use_id: "tu-dedupe",
        },
      }),
    );
    cli.send.mockClear();

    const payload = {
      type: "permission_response",
      request_id: "req-dedupe",
      behavior: "allow",
      client_msg_id: "perm-msg-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("req-dedupe")).toBe(false);
  });

  it("interrupt: sends control_request with interrupt subtype to CLI", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "interrupt",
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("interrupt");
  });

  it("interrupt: emits turn_end with interrupt_source=user", () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "interrupt",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "user" }),
    );
    spy.mockRestore();
  });

  it("interruptSession from leader emits turn_end with interrupt_source=leader", async () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );
    const interrupted = await bridge.interruptSession("s1", "leader");
    expect(interrupted).toBe(true);
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "leader" }),
    );
    spy.mockRestore();
  });

  it("ExitPlanMode denial from browser emits turn_end with interrupt_source=user", () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );

    const session = bridge.getSession("s1")!;
    // Seed a pending ExitPlanMode request so the denial follows the same
    // interrupt path as a real in-flight plan exit.
    session.pendingPermissions.set("perm-exit-plan-user", {
      request_id: "perm-exit-plan-user",
      tool_name: "ExitPlanMode",
      input: { allowedPrompts: [] },
      description: "Exit plan mode",
      tool_use_id: "tool-exit-plan-user",
      timestamp: Date.now(),
    });

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "perm-exit-plan-user",
        behavior: "deny",
        message: "Keep planning",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "user" }),
    );
    spy.mockRestore();
  });

  it("ExitPlanMode denial from external leader emits turn_end with interrupt_source=leader", () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );

    const session = bridge.getSession("s1")!;
    session.pendingPermissions.set("perm-exit-plan-leader", {
      request_id: "perm-exit-plan-leader",
      tool_name: "ExitPlanMode",
      input: { allowedPrompts: [] },
      description: "Exit plan mode",
      tool_use_id: "tool-exit-plan-leader",
      timestamp: Date.now(),
    });

    (bridge as any).routeBrowserMessage(session, {
      type: "permission_response",
      request_id: "perm-exit-plan-leader",
      behavior: "deny",
      message: "Keep planning",
      actorSessionId: "leader-7",
    });
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "leader" }),
    );
    spy.mockRestore();
  });

  it("ExitPlanMode denial from system actor emits turn_end with interrupt_source=system", () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );

    const session = bridge.getSession("s1")!;
    session.pendingPermissions.set("perm-exit-plan-system", {
      request_id: "perm-exit-plan-system",
      tool_name: "ExitPlanMode",
      input: { allowedPrompts: [] },
      description: "Exit plan mode",
      tool_use_id: "tool-exit-plan-system",
      timestamp: Date.now(),
    });

    (bridge as any).routeBrowserMessage(session, {
      type: "permission_response",
      request_id: "perm-exit-plan-system",
      behavior: "deny",
      message: "Keep planning",
      actorSessionId: "system:auto",
    });
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "system" }),
    );
    spy.mockRestore();
  });

  it("interrupt: deduplicates repeated client_msg_id", () => {
    const payload = { type: "interrupt", client_msg_id: "ctrl-msg-1" };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("interrupt: suppresses session_error takode event for interrupted is_error result", () => {
    // When a WS session is interrupted, the CLI may send a result with
    // is_error: true and diagnostic text. This should NOT fire session_error
    // because interrupts are normal control flow.
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "interrupt" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        stop_reason: "interrupted",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    const sessionErrorCalls = spy.mock.calls.filter(([, eventType]) => eventType === "session_error");
    expect(sessionErrorCalls).toHaveLength(0);

    // turn_end should still fire with interrupted metadata
    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(expect.objectContaining({ interrupted: true }));
    spy.mockRestore();
  });

  it("interrupt: suppresses attention badge for interrupted is_error result", () => {
    // Interrupted error results should not set attention to "error"
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "interrupt" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "[ede_diagnostic] internal error",
        stop_reason: "interrupted",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    expect(bridge.getSession("s1")!.attentionReason).toBeNull();
  });

  it("interrupt: result browser message includes interrupted flag", () => {
    // The result message broadcast to browsers should carry interrupted: true
    // so the frontend can suppress error rendering.
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "interrupt" }));
    browser.send.mockClear();
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "diagnostic text",
        stop_reason: "interrupted",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    const sentMessages = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const resultMsg = sentMessages.find((m: { type: string }) => m.type === "result");
    expect(resultMsg).toBeDefined();
    expect(resultMsg.interrupted).toBe(true);
  });

  it("non-interrupted error result still emits session_error (regression)", () => {
    // Non-interrupted error results should still emit session_error and
    // set attention -- only interrupts are suppressed.
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    // No interrupt sent
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "real error: tool execution failed",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    const sessionErrorCalls = spy.mock.calls.filter(([, eventType]) => eventType === "session_error");
    expect(sessionErrorCalls).toHaveLength(1);
    expect(sessionErrorCalls[0]?.[2]).toEqual(
      expect.objectContaining({ error: expect.stringContaining("real error") }),
    );
    expect(bridge.getSession("s1")!.attentionReason).toBe("error");
    spy.mockRestore();
  });

  it("interrupt: suppresses session_error for stop_reason=cancel (alternative interrupt indicator)", () => {
    // The CLI may use stop_reason "cancel" instead of "interrupted".
    // Both should suppress error side-effects (ws-bridge.ts:5896 checks both).
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "cancelled",
        stop_reason: "cancel",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    const sessionErrorCalls = spy.mock.calls.filter(([, eventType]) => eventType === "session_error");
    expect(sessionErrorCalls).toHaveLength(0);
    expect(bridge.getSession("s1")!.attentionReason).toBeNull();
    spy.mockRestore();
  });

  it("set_model: sends control_request with set_model subtype to CLI", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_model",
        model: "claude-opus-4-5-20250929",
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("set_model");
    expect(sent.request.model).toBe("claude-opus-4-5-20250929");
  });

  it("set_permission_mode: sends control_request with set_permission_mode subtype to CLI", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_permission_mode",
        mode: "bypassPermissions",
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("set_permission_mode");
    expect(sent.request.mode).toBe("bypassPermissions");
  });

  it("set_model: updates claude_token_details.modelContextWindow for [1m] variant", () => {
    const session = bridge.getSession("s1")!;
    session.state.claude_token_details = {
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 10,
      modelContextWindow: 200_000,
    };

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "set_model", model: "claude-opus-4-6[1m]" }));

    expect(session.state.model).toBe("claude-opus-4-6[1m]");
    expect(session.state.claude_token_details!.modelContextWindow).toBe(1_000_000);
    // Existing token counts preserved
    expect(session.state.claude_token_details!.inputTokens).toBe(100);

    // Broadcast includes updated claude_token_details
    const sent = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const update = sent.find((m: any) => m.type === "session_update" && m.session?.model);
    expect(update.session.claude_token_details.modelContextWindow).toBe(1_000_000);
  });

  it("set_model: creates claude_token_details when switching to [1m] without prior details", () => {
    const session = bridge.getSession("s1")!;
    session.state.claude_token_details = undefined;

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "set_model", model: "claude-opus-4-6[1m]" }));

    expect(session.state.claude_token_details).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      modelContextWindow: 1_000_000,
    });
  });

  it("set_model: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "set_model",
      model: "claude-opus-4-5-20250929",
      client_msg_id: "set-model-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("set_permission_mode: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "set_permission_mode",
      mode: "plan",
      client_msg_id: "set-mode-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_toggle: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_toggle",
      serverName: "my-mcp",
      enabled: true,
      client_msg_id: "mcp-msg-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    // 1 send for mcp_toggle control_request + delayed status refresh timer not run in this assertion window.
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_get_status: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_get_status",
      client_msg_id: "mcp-status-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_reconnect: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_reconnect",
      serverName: "my-mcp",
      client_msg_id: "mcp-reconnect-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_set_servers: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_set_servers",
      servers: {
        "server-a": {
          type: "stdio",
          command: "node",
          args: ["server.js"],
        },
      },
      client_msg_id: "mcp-set-servers-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });
});
