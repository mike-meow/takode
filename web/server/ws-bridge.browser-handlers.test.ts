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

describe("Browser handlers", () => {
  it("handleBrowserOpen: adds to set and sends session_init", () => {
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");

    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.browserSockets.has(browser)).toBe(true);

    expect(browser.send).toHaveBeenCalled();
    const firstMsg = JSON.parse(browser.send.mock.calls[0][0]);
    expect(firstMsg.type).toBe("session_init");
    expect(firstMsg.session.session_id).toBe("s1");
  });

  it("handleBrowserOpen: sends the latest global VSCode selection state", () => {
    bridge.getOrCreateSession("s1");
    const seedBrowser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(seedBrowser, "s1");
    seedBrowser.send.mockClear();

    bridge.handleBrowserMessage(
      seedBrowser,
      JSON.stringify({
        type: "vscode_selection_update",
        selection: {
          absolutePath: "/repo/src/app.ts",
          startLine: 4,
          endLine: 8,
          lineCount: 5,
        },
        updatedAt: 100,
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "VS Code A",
        client_msg_id: "selection-seed",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const selectionMsg = calls.find((m: any) => m.type === "vscode_selection_state");
    expect(selectionMsg).toEqual({
      type: "vscode_selection_state",
      state: {
        selection: {
          absolutePath: "/repo/src/app.ts",
          startLine: 4,
          endLine: 8,
          lineCount: 5,
        },
        updatedAt: 100,
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "VS Code A",
      },
    });
  });

  it("handleBrowserOpen: refreshes git branch asynchronously and notifies poller", async () => {
    // resolveGitInfo is now async (fire-and-forget), so session_init sends current state
    // and the git branch is updated asynchronously after the initial snapshot.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/dynamic-branch\n";
      if (cmd.includes("rev-parse HEAD")) return "head-dynamic\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      // gitUtils.resolveDefaultBranch fallback commands
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.git_branch = "main";
    // Ensure the session has a CLI socket so refreshGitInfo doesn't skip
    (session as any).backendSocket = { send: vi.fn() };

    const gitInfoCb = vi.fn();
    bridge.onGitInfoReady = gitInfoCb;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // session_init is sent immediately with the current (stale) state
    const firstMsg = JSON.parse(browser.send.mock.calls[0][0]);
    expect(firstMsg.type).toBe("session_init");
    expect(firstMsg.session.git_branch).toBe("main"); // stale — async hasn't resolved yet

    // After the async resolveGitInfo completes, session state and poller are updated
    await vi.waitFor(() => {
      expect(session.state.git_branch).toBe("feat/dynamic-branch");
      expect(gitInfoCb).toHaveBeenCalledWith("s1", "/repo", "feat/dynamic-branch");
    });
  });

  it("handleBrowserOpen: does NOT send message_history (deferred to session_subscribe)", () => {
    // History is now delivered via handleSessionSubscribe (triggered by session_subscribe
    // from the browser) instead of handleBrowserOpen, to prevent double delivery.
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const assistantMsg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-2",
      session_id: "s1",
    });
    bridge.handleCLIMessage(cli, assistantMsg);

    // Connect a browser — handleBrowserOpen should NOT send message_history
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const sessionInit = calls.find((c: any) => c.type === "session_init");
    expect(sessionInit).toBeDefined();
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeUndefined();

    // history_sync is sent after session_subscribe
    browser.send.mockClear();
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const subscribeCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyAfterSubscribe = subscribeCalls.find((c: any) => c.type === "history_sync");
    expect(historyAfterSubscribe).toBeDefined();
    expect(historyAfterSubscribe.hot_messages).toHaveLength(1);
    expect(historyAfterSubscribe.hot_messages[0].type).toBe("assistant");
  });

  it("handleBrowserOpen: sends pending permissions via session_subscribe", async () => {
    // Pending permissions are now delivered via handleSessionSubscribe instead of
    // handleBrowserOpen, to prevent double delivery on reconnect.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Create a pending permission
    const controlReq = JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Edit",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-1",
      },
    });
    bridge.handleCLIMessage(cli, controlReq);
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest

    // Now connect a browser and send session_subscribe
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permMsg = calls.find((c: any) => c.type === "permission_request");
    expect(permMsg).toBeDefined();
    expect(permMsg.request.tool_name).toBe("Edit");
    expect(permMsg.request.request_id).toBe("req-1");
  });

  it("handleBrowserOpen: triggers relaunch callback when CLI is dead", () => {
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    expect(relaunchCb).toHaveBeenCalledWith("s1");

    // Also sends backend_disconnected
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const disconnectedMsg = calls.find((c: any) => c.type === "backend_disconnected");
    expect(disconnectedMsg).toBeDefined();
  });

  it("handleBrowserOpen: Codex dead backend enters recovering state before relaunch", () => {
    const sid = "s-codex-browser-open-dead";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "codex", state: "connected", killedByIdleManager: false })),
    } as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(bridge.getSession(sid)?.state.backend_state).toBe("recovering");
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected" }));
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ backend_state: "recovering", backend_error: null }),
      }),
    );
  });

  it("handleBrowserOpen: does NOT relaunch when Codex adapter is attached but still initializing", () => {
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const session = bridge.getOrCreateSession("s1", "codex");
    session.codexAdapter = { isConnected: () => false } as any;
    session.state.backend_state = "initializing";

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    expect(relaunchCb).not.toHaveBeenCalled();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const disconnectedMsg = calls.find((c: any) => c.type === "backend_disconnected");
    expect(disconnectedMsg).toEqual({ type: "backend_disconnected" });
  });

  it("handleBrowserClose: removes from set", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    expect(bridge.getSession("s1")!.browserSockets.has(browser)).toBe(true);

    bridge.handleBrowserClose(browser);
    expect(bridge.getSession("s1")!.browserSockets.has(browser)).toBe(false);
  });

  it("session_subscribe: replays buffered sequenced events after last_seq", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate replayable events while no browser is connected.
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "s1",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Ask for replay after seq=1 (backend_connected). Both stream events should replay.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const replay = calls.find((c: any) => c.type === "event_replay");
    expect(replay).toBeDefined();
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0].seq).toBe(2);
    expect(replay.events[0].message.type).toBe("stream_event");
  });

  it("session_subscribe: skips stale transient replay on idle cold subscribe", async () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    const session = bridge.getSession("s1")!;
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Persisted answer" }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "asst-u1",
      session_id: "s1",
    } as any);
    session.eventBuffer = [
      {
        seq: 1,
        message: {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "stale" } },
          parent_tool_use_id: null,
          uuid: "se-stale",
          session_id: "s1",
        } as any,
      },
    ];
    session.nextEventSeq = 2;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    await flushAsync();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((c: any) => c.type === "history_sync")).toBeDefined();
    expect(calls.find((c: any) => c.type === "state_snapshot")).toBeDefined();
    expect(calls.find((c: any) => c.type === "event_replay")).toBeUndefined();
  });

  it("session_subscribe: falls back to full history sync when known_frozen_count is invalid", async () => {
    // When the browser claims a frozen count larger than the server's rendered
    // count, the initial sync is refused. The fallback retries with
    // knownFrozenCount=0, delivering a full history_sync so the browser is
    // never left without history.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Populate history so fallback payload has content.
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "hist-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "from history" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "hist-u1",
        session_id: "s1",
      }),
    );

    // Generate several stream events, then trim the first one from in-memory buffer.
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "1" } },
        parent_tool_use_id: null,
        uuid: "se-u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "2" } },
        parent_tool_use_id: null,
        uuid: "se-u2",
        session_id: "s1",
      }),
    );
    const session = bridge.getSession("s1")!;
    session.eventBuffer.shift();
    session.eventBuffer.shift(); // force earliest seq high enough to create a gap for last_seq=1

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
    (browser.data as any).subscribed = true;

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
        known_frozen_count: 99,
      }),
    );
    await flushAsync(); // sendHistorySync is async

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.some((c: any) => c.type === "message_history")).toBe(false);
    // Fallback full history_sync should be delivered
    const historySync = calls.find((c: any) => c.type === "history_sync");
    expect(historySync).toBeDefined();
    expect(historySync.frozen_base_count).toBe(0);
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events.some((e: any) => e.message.type === "stream_event")).toBe(true);
    expect(calls.some((c: any) => c.type === "state_snapshot")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("session_subscribe: falls back to full history sync when known_frozen_hash mismatches", async () => {
    // When the browser sends a stale frozen hash on reconnect, the server
    // should detect the mismatch and retry with a full history delivery
    // (frozen_base_count=0) instead of leaving the browser with no history.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user_message",
        content: "hello",
        timestamp: 1000,
        session_id: "s1",
        uuid: "u1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "hist-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "from history" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "hist-u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        session_id: "s1",
        uuid: "res-1",
        stop_reason: "end_turn",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
        known_frozen_count: 2,
        known_frozen_hash: "deadbeef",
      }),
    );
    await flushAsync(); // sendHistorySync is async

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Should NOT get legacy message_history
    expect(calls.some((c: any) => c.type === "message_history")).toBe(false);
    // SHOULD get a fallback full history_sync with frozen_base_count=0
    const historySync = calls.find((c: any) => c.type === "history_sync");
    expect(historySync).toBeDefined();
    expect(historySync.frozen_base_count).toBe(0);
    // The mismatch/invalid-count warning should still be logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[history-sync]"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Falling back to full history sync"));
    expect(calls.some((c: any) => c.type === "state_snapshot")).toBe(true);
    warnSpy.mockRestore();
  });

  it("session_subscribe: falls back to full history sync on gap path with stale frozen hash", async () => {
    // Exercises the gap-recovery code path (lastAckSeq > 0, hasGap=true) with
    // a frozen hash mismatch. The fallback should deliver full history_sync
    // just like the fresh connection path.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user_message",
        content: "hello",
        timestamp: 1000,
        session_id: "s1",
        uuid: "u1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "gap-hist-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "gap test" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "gap-hist-u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        session_id: "s1",
        uuid: "gap-res-1",
        stop_reason: "end_turn",
      }),
    );

    // Force a gap by clearing eventBuffer so the browser's last_seq=1 is
    // before the earliest buffered seq.
    const session = bridge.getSession("s1")!;
    session.eventBuffer.length = 0;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // last_seq=1 + empty eventBuffer → hasGap=true → gap recovery path.
    // known_frozen_hash is stale → sendHistorySyncAttempt returns false →
    // fallback delivers full history.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
        known_frozen_count: 2,
        known_frozen_hash: "stale-gap-hash",
      }),
    );
    await flushAsync();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historySync = calls.find((c: any) => c.type === "history_sync");
    expect(historySync).toBeDefined();
    expect(historySync.frozen_base_count).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[history-sync]"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Falling back to full history sync"));
    expect(calls.some((c: any) => c.type === "state_snapshot")).toBe(true);
    warnSpy.mockRestore();
  });

  it("logs a warning when the browser reports a history_sync mismatch", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "history_sync_mismatch",
        frozen_count: 3,
        expected_frozen_hash: "expected-frozen",
        actual_frozen_hash: "actual-frozen",
        expected_full_hash: "expected-full",
        actual_full_hash: "actual-full",
      }),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[history-sync] Browser reported hash mismatch for session"),
    );
    expect(browser.send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("session_subscribe no-gap: sends history_sync when history-backed events were missed", async () => {
    // Simulates a mobile browser that disconnected while the session was generating,
    // then reconnects. The event buffer covers the gap (no gap), but the browser
    // missed assistant messages that need to be delivered via message_history.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate a stream_event (transient, seq=2) then an assistant message (history-backed, seq=3)
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "streaming" } },
        parent_tool_use_id: null,
        uuid: "se-1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "asst-missed",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "missed message" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "asst-u1",
        session_id: "s1",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Browser reconnects claiming it last saw seq=1 (backend_connected event).
    // Event buffer covers seqs 2-3 (no gap), but seq=3 is history-backed.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );
    await flushAsync(); // sendHistorySync is async

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Should send history_sync because history-backed events were missed
    const historyMsg = calls.find((c: any) => c.type === "history_sync");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.hot_messages.some((m: any) => m.type === "assistant")).toBe(true);
    // Should also replay transient events (stream_event, status_change) that were missed.
    // status_change appears because the assistant message triggers cli_initiated_turn
    // detection (the CLI started outputting without a prior user message).
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    const transientTypes = new Set(["stream_event", "status_change"]);
    expect(replayMsg.events.every((e: any) => transientTypes.has(e.message.type))).toBe(true);
  });

  it("session_subscribe no-gap: skips message_history when only transient events were missed", () => {
    // When the browser only missed transient events (stream_event, tool_progress),
    // no message_history should be sent — just event_replay.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate only transient events
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
        parent_tool_use_id: null,
        uuid: "se-t1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
        parent_tool_use_id: null,
        uuid: "se-t2",
        session_id: "s1",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Should NOT send message_history since only transient events were missed
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeUndefined();
    const syncMsg = calls.find((c: any) => c.type === "history_sync");
    expect(syncMsg).toBeUndefined();
    // Should replay the missed transient events
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events).toHaveLength(2);
  });

  it("session_subscribe: sends history_sync when event buffer is empty but browser is behind", () => {
    // Edge case: the event buffer was pruned or cleared, but the browser is behind.
    // Previously this path was skipped entirely; now it should send message_history.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate an assistant message to populate messageHistory
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "asst-empty-buf",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "should be delivered" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "asst-eb",
        session_id: "s1",
      }),
    );

    const session = bridge.getSession("s1")!;
    // Clear the event buffer to simulate pruning, but keep nextEventSeq advanced
    session.eventBuffer.length = 0;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Browser is behind (last_seq=1 but nextEventSeq > 2)
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyMsg = calls.find((c: any) => c.type === "history_sync");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.hot_messages.some((m: any) => m.type === "assistant")).toBe(true);
  });

  it("session_ack: updates lastAckSeq for the session", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_ack",
        last_seq: 42,
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.lastAckSeq).toBe(42);
  });
});
