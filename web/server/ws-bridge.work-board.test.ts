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

describe("work board", () => {
  it("getBoard returns empty array for unknown session", () => {
    expect(bridge.getBoard("nonexistent")).toEqual([]);
  });

  it("upsertBoardRow adds a row and broadcasts", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const board = bridge.upsertBoardRow("s1", {
      questId: "q-42",
      title: "Fix sidebar",
      status: "implementing",
    });

    expect(board).not.toBeNull();
    expect(board).toHaveLength(1);
    expect(board![0].questId).toBe("q-42");
    expect(board![0].title).toBe("Fix sidebar");
    expect(board![0].status).toBe("implementing");
    expect(board![0].updatedAt).toBeGreaterThan(0);

    // Verify broadcast to browser
    const sent = browser.send.mock.calls.find((call: any[]) => {
      try {
        return JSON.parse(call[0]).type === "board_updated";
      } catch {
        return false;
      }
    });
    expect(sent).toBeTruthy();
    const msg = JSON.parse(sent![0] as string);
    expect(msg.board).toHaveLength(1);
    expect(msg.board[0].questId).toBe("q-42");
  });

  it("upsertBoardRow merges with existing row", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", {
      questId: "q-42",
      title: "Fix sidebar",
      worker: "worker-1",
      workerNum: 5,
      status: "implementing",
    });

    // Update only the status -- other fields should be preserved
    const board = bridge.upsertBoardRow("s1", {
      questId: "q-42",
      status: "waiting for review",
    });

    expect(board).toHaveLength(1);
    expect(board![0].questId).toBe("q-42");
    expect(board![0].title).toBe("Fix sidebar"); // preserved
    expect(board![0].worker).toBe("worker-1"); // preserved
    expect(board![0].workerNum).toBe(5); // preserved
    expect(board![0].status).toBe("waiting for review"); // updated
  });

  it("upsertBoardRow preserves createdAt on update (stable sort key)", () => {
    // createdAt is set once on first insert and must survive subsequent upserts
    // so that board sort order remains stable across updates.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "First" });
    const originalCreatedAt = bridge.getBoard("s1")[0].createdAt;
    expect(originalCreatedAt).toBeGreaterThan(0);

    // Update the row after a brief delay to ensure Date.now() would differ
    const board = bridge.upsertBoardRow("s1", { questId: "q-1", status: "PLANNING" });
    expect(board![0].createdAt).toBe(originalCreatedAt); // preserved
    expect(board![0].updatedAt).toBeGreaterThanOrEqual(originalCreatedAt); // updated
  });

  it("removeBoardRows removes specified rows", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Quest 2" });
    bridge.upsertBoardRow("s1", { questId: "q-3", title: "Quest 3" });

    const board = bridge.removeBoardRows("s1", ["q-1", "q-3"]);

    expect(board).toHaveLength(1);
    expect(board![0].questId).toBe("q-2");
  });

  it("removeBoardRows sends a review notification when a row is completed", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = (bridge as any).sessions.get("s1");
    session.messageHistory.push({
      type: "assistant",
      message: { id: "asst-board-remove", content: [{ type: "text", text: "Quest finished" }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    browser.send.mockClear();

    bridge.removeBoardRows("s1", ["q-1"]);

    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0]).toEqual(
      expect.objectContaining({
        category: "review",
        summary: "q-1 ready for review: Quest 1",
        messageId: "asst-board-remove",
      }),
    );
    expect(session.attentionReason).toBe("review");

    const notifUpdates = browser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter((message: any) => message?.type === "notification_update");
    expect(notifUpdates).toHaveLength(1);
  });

  it("removeBoardRows keeps review notifications scoped to the completed leader session", () => {
    // q-510: leader-scoped review notifications must never leak into another
    // leader's inbox or chat stream, even when both leaders are connected.
    const leaderABrowser = makeBrowserSocket("leader-a");
    const leaderBBrowser = makeBrowserSocket("leader-b");
    bridge.handleBrowserOpen(leaderABrowser, "leader-a");
    bridge.handleBrowserOpen(leaderBBrowser, "leader-b");

    const leaderASession = (bridge as any).sessions.get("leader-a");
    const leaderBSession = (bridge as any).sessions.get("leader-b");
    leaderASession.messageHistory.push({
      type: "assistant",
      message: { id: "asst-leader-a", content: [{ type: "text", text: "Quest finished in leader A" }] },
      timestamp: Date.now(),
    });
    leaderBSession.messageHistory.push({
      type: "assistant",
      message: { id: "asst-leader-b", content: [{ type: "text", text: "Unrelated leader B work" }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow("leader-a", { questId: "q-510", title: "Fix cross-leader notification leak" });
    bridge.upsertBoardRow("leader-b", { questId: "q-999", title: "Other leader quest" });
    leaderABrowser.send.mockClear();
    leaderBBrowser.send.mockClear();

    bridge.removeBoardRows("leader-a", ["q-510"]);

    expect(leaderASession.notifications).toHaveLength(1);
    expect(leaderASession.notifications[0]).toEqual(
      expect.objectContaining({
        category: "review",
        summary: "q-510 ready for review: Fix cross-leader notification leak",
        messageId: "asst-leader-a",
      }),
    );
    expect(leaderBSession.notifications).toHaveLength(0);
    const leaderAHistoryAssistant = leaderASession.messageHistory.find(
      (message: any) => message?.type === "assistant" && message?.message?.id === "asst-leader-a",
    );
    const leaderBHistoryAssistant = leaderBSession.messageHistory.find(
      (message: any) => message?.type === "assistant" && message?.message?.id === "asst-leader-b",
    );
    expect((leaderAHistoryAssistant as any)?.notification).toEqual(
      expect.objectContaining({
        category: "review",
        summary: "q-510 ready for review: Fix cross-leader notification leak",
      }),
    );
    expect((leaderBHistoryAssistant as any)?.notification).toBeUndefined();
    expect(
      leaderBSession.messageHistory.some(
        (message: any) => message?.type === "assistant" && (message as any).notification != null,
      ),
    ).toBe(false);

    const leaderAMessages = leaderABrowser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const leaderBMessages = leaderBBrowser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    expect(leaderAMessages.some((message: any) => message?.type === "notification_update")).toBe(true);
    expect(
      leaderAMessages.some(
        (message: any) => message?.type === "notification_anchored" && message?.messageId === "asst-leader-a",
      ),
    ).toBe(true);
    expect(leaderBMessages.some((message: any) => message?.type === "notification_update")).toBe(false);
    expect(leaderBMessages.some((message: any) => message?.type === "notification_anchored")).toBe(false);
  });

  it("removeBoardRows sends one aggregated review notification for multiple completed rows", () => {
    // Batch completion should produce a single review notification so the same
    // anchored assistant message does not get conflicting notification stamps.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = (bridge as any).sessions.get("s1");
    session.messageHistory.push({
      type: "assistant",
      message: { id: "asst-board-batch", content: [{ type: "text", text: "Multiple quests finished" }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Quest 2" });
    browser.send.mockClear();

    bridge.removeBoardRows("s1", ["q-1", "q-2"]);

    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0]).toEqual(
      expect.objectContaining({
        category: "review",
        summary: "2 quests ready for review: q-1, q-2",
        messageId: "asst-board-batch",
      }),
    );
  });

  it("removeBoardRows does not send duplicate review notifications for already-completed rows", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = (bridge as any).sessions.get("s1");
    session.messageHistory.push({
      type: "assistant",
      message: { id: "asst-board-repeat", content: [{ type: "text", text: "Quest finished" }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.removeBoardRows("s1", ["q-1"]);
    expect(session.notifications).toHaveLength(1);

    browser.send.mockClear();
    bridge.removeBoardRows("s1", ["q-1"]);

    expect(session.notifications).toHaveLength(1);
    const notifUpdates = browser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter((message: any) => message?.type === "notification_update");
    expect(notifUpdates).toHaveLength(0);
  });

  it("removeBoardRows uses quest-only summary when the completed row has no title", () => {
    // Board rows do not always carry titles, so the fallback summary must stay
    // readable when completion happens without one.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = (bridge as any).sessions.get("s1");
    session.messageHistory.push({
      type: "assistant",
      message: { id: "asst-board-untitled", content: [{ type: "text", text: "Quest finished" }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow("s1", { questId: "q-9" });
    bridge.removeBoardRows("s1", ["q-9"]);

    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0]).toEqual(
      expect.objectContaining({
        category: "review",
        summary: "q-9 ready for review",
      }),
    );
  });

  it("removeBoardRowFromAll removes quest from all sessions", () => {
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s2");

    bridge.upsertBoardRow("s1", { questId: "q-42", title: "Shared quest" });
    bridge.upsertBoardRow("s2", { questId: "q-42", title: "Shared quest" });
    bridge.upsertBoardRow("s2", { questId: "q-99", title: "Other quest" });

    bridge.removeBoardRowFromAll("q-42");

    expect(bridge.getBoard("s1")).toHaveLength(0);
    const s2Board = bridge.getBoard("s2");
    expect(s2Board).toHaveLength(1);
    expect(s2Board[0].questId).toBe("q-99");
  });

  it("board survives persistence round-trip", async () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", {
      questId: "q-42",
      title: "Fix sidebar",
      worker: "w1",
      workerNum: 5,
      status: "implementing",
    });

    // Wait for debounced write
    await new Promise((r) => setTimeout(r, 200));

    // Restore from disk
    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    await restored.restoreFromDisk();

    const board = restored.getBoard("s1");
    expect(board).toHaveLength(1);
    expect(board[0].questId).toBe("q-42");
    expect(board[0].title).toBe("Fix sidebar");
    expect(board[0].worker).toBe("w1");
    expect(board[0].workerNum).toBe(5);
    expect(board[0].status).toBe("implementing");
  });

  it("upsertBoardRow returns null for unknown session", () => {
    expect(bridge.upsertBoardRow("nonexistent", { questId: "q-1" })).toBeNull();
  });

  it("removeBoardRows returns null for unknown session", () => {
    expect(bridge.removeBoardRows("nonexistent", ["q-1"])).toBeNull();
  });

  it("getBoard returns rows sorted by createdAt (stable insertion order)", () => {
    // Mock Date.now() to return distinct values so sort is deterministic,
    // independent of runtime speed or timer resolution.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    let clock = 1000;
    const originalNow = Date.now;
    Date.now = () => clock++;

    try {
      bridge.upsertBoardRow("s1", { questId: "q-1", title: "First" });
      bridge.upsertBoardRow("s1", { questId: "q-2", title: "Second" });
      bridge.upsertBoardRow("s1", { questId: "q-3", title: "Third" });

      const board = bridge.getBoard("s1");
      expect(board.map((r) => r.questId)).toEqual(["q-1", "q-2", "q-3"]);
    } finally {
      Date.now = originalNow;
    }
  });

  // ─── waitFor field ────────────────────────────────────────────────────────

  it("upsertBoardRow sets waitFor array on row", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2", "q-3"] });
    const board = bridge.getBoard("s1");
    expect(board[0].waitFor).toEqual(["q-2", "q-3"]);
  });

  it("upsertBoardRow clears waitFor when given empty array", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Set initial waitFor
    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2"] });
    expect(bridge.getBoard("s1")[0].waitFor).toEqual(["q-2"]);

    // Clear with empty array
    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: [] });
    expect(bridge.getBoard("s1")[0].waitFor).toBeUndefined();
  });

  it("upsertBoardRow preserves existing waitFor when field is omitted", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2"] });
    // Update title without touching waitFor
    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Updated" });
    const row = bridge.getBoard("s1")[0];
    expect(row.title).toBe("Updated");
    expect(row.waitFor).toEqual(["q-2"]);
  });

  it("removeBoardRows removes resolved quest waits and falls back to free-worker when needed", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2", "#5"] });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Dependency quest" });
    bridge.upsertBoardRow("s1", { questId: "q-3", waitFor: ["q-2", "q-99"] });
    bridge.upsertBoardRow("s1", { questId: "q-4", waitFor: ["q-2"] });

    bridge.removeBoardRows("s1", ["q-2"]);

    const rows = bridge.getBoard("s1");
    expect(rows.find((row) => row.questId === "q-1")?.waitFor).toEqual(["#5"]);
    expect(rows.find((row) => row.questId === "q-3")?.waitFor).toEqual(["q-99"]);
    expect(rows.find((row) => row.questId === "q-4")?.waitFor).toEqual(["free-worker"]);
  });

  it("removeBoardRowFromAll clears stale quest waitFor refs across active boards", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2", "#7"] });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Dependency quest" });

    bridge.removeBoardRowFromAll("q-2");

    expect(bridge.getBoard("s1")[0].waitFor).toEqual(["#7"]);
  });

  it("removeBoardRowFromAll normalizes fully-resolved queued waits to free-worker", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2"] });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Dependency quest" });

    bridge.removeBoardRowFromAll("q-2");

    expect(bridge.getBoard("s1")[0].waitFor).toEqual(["free-worker"]);
  });

  // ─── field clearing ──────────────────────────────────────────────────────

  it("upsertBoardRow clears worker when given empty string", () => {
    // Empty string signals "clear this field" -- should remove existing worker
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", worker: "worker-1", workerNum: 5 });
    expect(bridge.getBoard("s1")[0].worker).toBe("worker-1");

    bridge.upsertBoardRow("s1", { questId: "q-1", worker: "" });
    const row = bridge.getBoard("s1")[0];
    expect(row.worker).toBeUndefined();
    expect(row.workerNum).toBeUndefined();
  });

  it("upsertBoardRow preserves worker when field is omitted", () => {
    // Undefined means "not provided" -- should keep existing value
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", worker: "worker-1", workerNum: 5 });
    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Updated" });
    const row = bridge.getBoard("s1")[0];
    expect(row.worker).toBe("worker-1");
    expect(row.workerNum).toBe(5);
  });

  it("upsertBoardRow clears status when given empty string", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "implementing" });
    expect(bridge.getBoard("s1")[0].status).toBe("implementing");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "" });
    expect(bridge.getBoard("s1")[0].status).toBeUndefined();
  });

  it("upsertBoardRow clears title when given empty string", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Fix sidebar" });
    expect(bridge.getBoard("s1")[0].title).toBe("Fix sidebar");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "" });
    expect(bridge.getBoard("s1")[0].title).toBeUndefined();
  });

  // ─── advanceBoardRow ──────────────────────────────────────────────────────

  it("advanceBoardRow advances from QUEUED to PLANNING", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "QUEUED" });
    const result = bridge.advanceBoardRow("s1", "q-1");
    expect(result).not.toBeNull();
    expect(result!.removed).toBe(false);
    expect(result!.previousState).toBe("QUEUED");
    expect(result!.newState).toBe("PLANNING");
    expect(result!.board[0].status).toBe("PLANNING");
  });

  it("advanceBoardRow clears waitFor when moving a queued row into active work", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "QUEUED", waitFor: ["q-2", "#9"] });
    const result = bridge.advanceBoardRow("s1", "q-1");

    expect(result?.newState).toBe("PLANNING");
    expect(result?.board[0].waitFor).toBeUndefined();
  });

  it("upsertBoardRow does not send review notifications for non-completion edits", () => {
    // Ordinary board maintenance should not notify the user unless the row
    // actually transitions into the completed board.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = (bridge as any).sessions.get("s1");
    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1", status: "PLANNING" });

    expect(session.notifications).toHaveLength(0);
    const notifUpdates = browser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter((message: any) => message?.type === "notification_update");
    expect(notifUpdates).toHaveLength(0);
  });

  it("advanceBoardRow does not notify on non-final transitions", () => {
    // Intermediate Quest Journey steps should stay silent; only the final
    // board completion transition should generate a review notification.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = (bridge as any).sessions.get("s1");
    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1", status: "PLANNING" });
    browser.send.mockClear();

    const result = bridge.advanceBoardRow("s1", "q-1");

    expect(result?.removed).toBe(false);
    expect(result?.newState).toBe("IMPLEMENTING");
    expect(session.notifications).toHaveLength(0);
    const notifUpdates = browser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter((message: any) => message?.type === "notification_update");
    expect(notifUpdates).toHaveLength(0);
  });

  it("advanceBoardRow completes a zero-tracked-change Journey from its final non-port phase", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = (bridge as any).sessions.get("s1");
    session.messageHistory.push({
      type: "assistant",
      message: { id: "asst-final-phase", content: [{ type: "text", text: "Investigation finished" }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow("s1", {
      questId: "q-1",
      title: "Investigate flaky session auth",
      journey: {
        presetId: "investigation",
        phaseIds: ["planning", "explore", "outcome-review"],
        currentPhaseId: "outcome-review",
      },
      status: "OUTCOME_REVIEWING",
    });
    browser.send.mockClear();

    const result = bridge.advanceBoardRow("s1", "q-1");

    expect(result).toEqual(
      expect.objectContaining({
        removed: true,
        previousState: "OUTCOME_REVIEWING",
      }),
    );
    expect(result?.board).toHaveLength(0);
    expect(bridge.getCompletedBoard("s1")).toEqual([
      expect.objectContaining({
        questId: "q-1",
        status: "OUTCOME_REVIEWING",
      }),
    ]);
    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0]).toEqual(
      expect.objectContaining({
        category: "review",
        summary: "q-1 ready for review: Investigate flaky session auth",
        messageId: "asst-final-phase",
      }),
    );
  });

  it("advanceBoardRow ignores legacy noCode metadata when explicit phases omit port", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", {
      questId: "q-1",
      title: "Investigate board command",
      noCode: true,
      journey: {
        presetId: "investigation",
        phaseIds: ["planning", "explore", "outcome-review"],
        currentPhaseId: "outcome-review",
      },
      status: "OUTCOME_REVIEWING",
    });

    const result = bridge.advanceBoardRow("s1", "q-1");

    expect(result).toEqual(
      expect.objectContaining({
        removed: true,
        previousState: "OUTCOME_REVIEWING",
      }),
    );
    expect(bridge.getBoard("s1")).toHaveLength(0);
    expect(bridge.getCompletedBoard("s1")).toEqual([
      expect.objectContaining({
        questId: "q-1",
        status: "OUTCOME_REVIEWING",
      }),
    ]);
  });

  it("advanceBoardRow treats legacy noCode rows without explicit phases as port-free compatibility plans", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", {
      questId: "q-1",
      title: "Legacy zero-change quest",
      noCode: true,
      status: "CODE_REVIEWING",
    });

    expect(bridge.getBoard("s1")).toEqual([
      expect.objectContaining({
        questId: "q-1",
        noCode: true,
        journey: expect.objectContaining({
          phaseIds: ["planning", "implement", "code-review"],
          currentPhaseId: "code-review",
        }),
        status: "CODE_REVIEWING",
      }),
    ]);

    const result = bridge.advanceBoardRow("s1", "q-1");

    expect(result).toEqual(
      expect.objectContaining({
        removed: true,
        previousState: "CODE_REVIEWING",
      }),
    );
    expect(bridge.getBoard("s1")).toHaveLength(0);
    expect(bridge.getCompletedBoard("s1")).toEqual([
      expect.objectContaining({
        questId: "q-1",
        noCode: true,
        status: "CODE_REVIEWING",
      }),
    ]);
  });

  it("advanceBoardRowNoGroom returns migration guidance without mutating the board", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", {
      questId: "q-1",
      title: "Implement board command",
      noCode: false,
      status: "CODE_REVIEWING",
    });

    const result = bridge.advanceBoardRowNoGroom("s1", "q-1");

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.stringContaining("no-code board shortcut was removed"),
        previousState: "CODE_REVIEWING",
      }),
    );
    expect(bridge.getBoard("s1")).toEqual([
      expect.objectContaining({
        questId: "q-1",
        status: "CODE_REVIEWING",
      }),
    ]);
    expect(bridge.getCompletedBoard("s1")).toHaveLength(0);
  });

  it("advanceBoardRow keeps queued wait-for dependents on the active board", () => {
    // Regression for q-466: removing q-459 should unblock q-460 without
    // dropping q-461, and advancing q-460 later must still leave q-461 on the
    // board waiting on q-460. This mirrors the exact q-459/q-460/q-461 chain
    // reported from session #638.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-459", title: "Upstream quest", status: "PORTING" });
    bridge.upsertBoardRow("s1", { questId: "q-460", title: "Middle quest", status: "QUEUED", waitFor: ["q-459"] });
    bridge.upsertBoardRow("s1", { questId: "q-461", title: "Dependent quest", status: "QUEUED", waitFor: ["q-460"] });

    bridge.removeBoardRows("s1", ["q-459"]);
    bridge.upsertBoardRow("s1", {
      questId: "q-460",
      worker: "worker-618",
      workerNum: 618,
      status: "PLANNING",
      waitFor: [],
    });

    const result = bridge.advanceBoardRow("s1", "q-460");

    expect(result).not.toBeNull();
    expect(result?.removed).toBe(false);
    expect(result?.newState).toBe("IMPLEMENTING");
    expect(result?.board.map((row: any) => row.questId)).toEqual(["q-460", "q-461"]);
    expect(result?.board.find((row: any) => row.questId === "q-461")).toEqual(
      expect.objectContaining({
        status: "QUEUED",
        waitFor: ["q-460"],
      }),
    );
    expect(bridge.getCompletedBoardCount("s1")).toBe(1);
  });

  it("preserves full takode board previews so dependent rows stay visible to the agent", () => {
    // Regression for q-466: the bridge state was intact, but the 300-char tail
    // preview for `takode board advance` hid q-461 and made the model think the
    // row disappeared. Board commands should keep the small full table preview.
    const session = bridge.getOrCreateSession("board-preview");
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "assistant-board-preview",
        content: [
          {
            type: "tool_use",
            id: "tool-board-preview",
            name: "Bash",
            input: { command: "takode board advance q-460" },
          },
        ],
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    } as any);
    session.toolStartTimes.set("tool-board-preview", Date.now() - 1000);

    const longBoardOutput = [
      "",
      "QUEST    TITLE                WORKER / REVIEWER               STATE              WAIT-FOR         ACTION",
      "--------------------------------------------------------------------------------------------------------------",
      "q-460    Re-unroll Frank d…   #618 running / #647 idle       IMPLEMENTING       --               wait for the worker report, then choose the next review or bookkeeping phase",
      "q-461    Launch Nex AGI da…   #618 running / #647 idle       QUEUED             wait q-460       wait for q-460",
      "",
      "1 quest completed",
    ].join("\n");
    expect(longBoardOutput.length).toBeGreaterThan(300);

    const previews = (bridge as any).buildToolResultPreviews(session, [
      {
        type: "tool_result",
        tool_use_id: "tool-board-preview",
        content: longBoardOutput,
        is_error: false,
      },
    ]);

    expect(previews).toHaveLength(1);
    expect(previews[0].is_truncated).toBe(false);
    expect(previews[0].content).toContain("q-460");
    expect(previews[0].content).toContain("q-461");
    expect(previews[0].content).toContain("1 quest completed");
  });

  it("advanceBoardRow walks through all built-in Quest Journey phases", () => {
    // Validates the full state machine progression
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "QUEUED" });

    const expectedTransitions = [
      ["QUEUED", "PLANNING"],
      ["PLANNING", "IMPLEMENTING"],
      ["IMPLEMENTING", "CODE_REVIEWING"],
      ["CODE_REVIEWING", "PORTING"],
    ];

    for (const [from, to] of expectedTransitions) {
      const result = bridge.advanceBoardRow("s1", "q-1");
      expect(result!.previousState).toBe(from);
      expect(result!.newState).toBe(to);
      expect(result!.removed).toBe(false);
    }

    // Final advance removes from board
    const final = bridge.advanceBoardRow("s1", "q-1");
    expect(final!.removed).toBe(true);
    expect(final!.previousState).toBe("PORTING");
    expect(final!.board).toHaveLength(0);
  });

  it("initializes default phase bookkeeping for the built-in full-code Quest Journey", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "PLANNING" });

    expect(bridge.getBoard("s1")[0]).toEqual(
      expect.objectContaining({
        status: "PLANNING",
        journey: expect.objectContaining({
          presetId: "full-code",
          phaseIds: ["planning", "implement", "code-review", "port"],
          currentPhaseId: "planning",
          nextLeaderAction: expect.stringContaining("planning leader brief"),
        }),
      }),
    );
  });

  it("advanceBoardRow follows a custom planned phase sequence", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", {
      questId: "q-1",
      status: "PLANNING",
      journey: {
        presetId: "lightweight",
        phaseIds: ["planning", "implement", "port"],
        currentPhaseId: "planning",
      },
    });

    const implementation = bridge.advanceBoardRow("s1", "q-1");
    expect(implementation?.newState).toBe("IMPLEMENTING");
    expect(implementation?.board[0].journey).toEqual(
      expect.objectContaining({
        phaseIds: ["planning", "implement", "port"],
        currentPhaseId: "implement",
      }),
    );

    const porting = bridge.advanceBoardRow("s1", "q-1");
    expect(porting?.newState).toBe("PORTING");
    expect(porting?.board[0].journey).toEqual(
      expect.objectContaining({
        currentPhaseId: "port",
        nextLeaderAction: expect.stringContaining("sync confirmation"),
      }),
    );

    const final = bridge.advanceBoardRow("s1", "q-1");
    expect(final?.removed).toBe(true);
    expect(final?.previousState).toBe("PORTING");
  });

  it("advanceBoardRow removes row at final phase PORTING", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "PORTING" });
    const result = bridge.advanceBoardRow("s1", "q-1");
    expect(result!.removed).toBe(true);
    expect(result!.newState).toBeUndefined();
    expect(result!.board).toHaveLength(0);
  });

  it("advanceBoardRow sends a review notification when completing the final phase", () => {
    // Advancing off the final board phase is the explicit completion path for
    // Quest Journey-driven work and should notify exactly once.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = (bridge as any).sessions.get("s1");
    session.messageHistory.push({
      type: "assistant",
      message: { id: "asst-board-advance", content: [{ type: "text", text: "Quest finished" }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1", status: "PORTING" });
    browser.send.mockClear();

    const result = bridge.advanceBoardRow("s1", "q-1");

    expect(result?.removed).toBe(true);
    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0]).toEqual(
      expect.objectContaining({
        category: "review",
        summary: "q-1 ready for review: Quest 1",
        messageId: "asst-board-advance",
      }),
    );
    expect(session.attentionReason).toBe("review");
  });

  it("advanceBoardRow sets QUEUED when status is unrecognized", () => {
    // Handles rows with freeform status text from before Quest Journey
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "some-legacy-status" });
    const result = bridge.advanceBoardRow("s1", "q-1");
    expect(result!.newState).toBe("QUEUED");
    expect(result!.previousState).toBe("some-legacy-status");
  });

  it("advanceBoardRow returns null for unknown session", () => {
    expect(bridge.advanceBoardRow("nonexistent", "q-1")).toBeNull();
  });

  it("advanceBoardRow returns null for unknown questId", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    expect(bridge.advanceBoardRow("s1", "q-999")).toBeNull();
  });

  // ─── completed board (history) ───────────────────────────────────────────

  it("removeBoardRows moves items to completedBoard instead of deleting", () => {
    // removeBoardRows should archive items to completedBoard with a completedAt
    // timestamp, not delete them permanently.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Quest 2" });

    bridge.removeBoardRows("s1", ["q-1"]);

    // Active board should only have q-2
    expect(bridge.getBoard("s1")).toHaveLength(1);
    expect(bridge.getBoard("s1")[0].questId).toBe("q-2");

    // Completed board should have q-1 with completedAt timestamp
    const completed = bridge.getCompletedBoard("s1");
    expect(completed).toHaveLength(1);
    expect(completed[0].questId).toBe("q-1");
    expect(completed[0].title).toBe("Quest 1");
    expect(completed[0].completedAt).toBeGreaterThan(0);
  });

  it("advanceBoardRow at final phase moves item to completedBoard", () => {
    // Advancing past PORTING (final phase) should move the row to completed
    // history, not delete it.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Done quest", status: "PORTING" });
    const result = bridge.advanceBoardRow("s1", "q-1");

    expect(result!.removed).toBe(true);
    expect(result!.board).toHaveLength(0);

    const completed = bridge.getCompletedBoard("s1");
    expect(completed).toHaveLength(1);
    expect(completed[0].questId).toBe("q-1");
    expect(completed[0].completedAt).toBeGreaterThan(0);
  });

  it("removeBoardRowFromAll true-deletes from both active and completed boards", () => {
    // Quest deletion/cancellation should purge from everywhere -- no history kept.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Add two quests, move one to completed
    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Quest 2" });
    bridge.removeBoardRows("s1", ["q-1"]); // q-1 -> completedBoard

    expect(bridge.getCompletedBoard("s1")).toHaveLength(1);
    expect(bridge.getBoard("s1")).toHaveLength(1);

    // removeBoardRowFromAll should delete from completed
    bridge.removeBoardRowFromAll("q-1");
    expect(bridge.getCompletedBoard("s1")).toHaveLength(0);

    // removeBoardRowFromAll should delete from active
    bridge.removeBoardRowFromAll("q-2");
    expect(bridge.getBoard("s1")).toHaveLength(0);
  });

  it("getCompletedBoard returns empty for unknown session", () => {
    expect(bridge.getCompletedBoard("nonexistent")).toEqual([]);
  });

  it("getCompletedBoard returns items sorted newest-first by completedAt", () => {
    // Multiple completed items should be ordered by completedAt descending
    // so the most recently completed item appears first.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    let clock = 1000;
    const originalNow = Date.now;
    Date.now = () => clock++;

    try {
      bridge.upsertBoardRow("s1", { questId: "q-1", title: "First" });
      bridge.upsertBoardRow("s1", { questId: "q-2", title: "Second" });
      bridge.upsertBoardRow("s1", { questId: "q-3", title: "Third" });

      // Remove in order: q-1, q-2, q-3 (each gets a later completedAt)
      bridge.removeBoardRows("s1", ["q-1"]);
      bridge.removeBoardRows("s1", ["q-2"]);
      bridge.removeBoardRows("s1", ["q-3"]);

      const completed = bridge.getCompletedBoard("s1");
      expect(completed).toHaveLength(3);
      // Newest first: q-3, q-2, q-1
      expect(completed.map((r) => r.questId)).toEqual(["q-3", "q-2", "q-1"]);
    } finally {
      Date.now = originalNow;
    }
  });

  it("board_updated broadcast includes completedBoard", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.removeBoardRows("s1", ["q-1"]);

    // Find the most recent board_updated broadcast
    const boardUpdates = browser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter((msg: any) => msg?.type === "board_updated");
    const lastUpdate = boardUpdates[boardUpdates.length - 1];
    expect(lastUpdate.completedBoard).toHaveLength(1);
    expect(lastUpdate.completedBoard[0].questId).toBe("q-1");
  });

  it("board_updated broadcast removes resolved quest waits from queued rows", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2", "#9"] });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Dependency quest" });
    browser.send.mockClear();

    bridge.removeBoardRows("s1", ["q-2"]);

    const boardUpdates = browser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter((msg: any) => msg?.type === "board_updated");
    const lastUpdate = boardUpdates[boardUpdates.length - 1];
    expect(lastUpdate.board).toEqual([
      expect.objectContaining({
        questId: "q-1",
        waitFor: ["#9"],
      }),
    ]);
    expect(lastUpdate.completedBoard).toEqual([expect.objectContaining({ questId: "q-2" })]);
  });

  it("completedBoard survives persistence round-trip", async () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-42", title: "Fix sidebar", status: "PORTING" });
    bridge.advanceBoardRow("s1", "q-42"); // moves to completed

    // Wait for debounced write
    await new Promise((r) => setTimeout(r, 200));

    // Restore from disk
    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    await restored.restoreFromDisk();

    const completed = restored.getCompletedBoard("s1");
    expect(completed).toHaveLength(1);
    expect(completed[0].questId).toBe("q-42");
    expect(completed[0].title).toBe("Fix sidebar");
    expect(completed[0].completedAt).toBeGreaterThan(0);
  });

  it("restore keeps queued idea dependents so a later board advance does not drop them", async () => {
    // Real q-466 repro from session #638:
    // - q-460 stayed active with status in_progress
    // - q-461 was a queued dependent but its quest status was still idea
    // The old restore reconciliation silently pruned q-461 before the later
    // `takode board advance q-460`, producing a one-row board_updated event.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", {
      questId: "q-460",
      title: "Re-unroll Frank datasets with accurate tokenizer",
      worker: "worker-618",
      workerNum: 618,
      status: "PLANNING",
    });
    bridge.upsertBoardRow("s1", {
      questId: "q-461",
      title: "Launch Nex AGI datagen on ~100 nodes",
      worker: "worker-618",
      workerNum: 618,
      status: "QUEUED",
      waitFor: ["q-460"],
    });

    await new Promise((r) => setTimeout(r, 200));

    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    restored.resolveQuestStatus = async (questId) => {
      if (questId === "q-460") return "in_progress";
      if (questId === "q-461") return "idea";
      return null;
    };
    await restored.restoreFromDisk();

    const restoredBrowser = makeBrowserSocket("s1");
    restored.handleBrowserOpen(restoredBrowser, "s1");
    expect(restored.getBoard("s1").map((row) => row.questId)).toEqual(["q-460", "q-461"]);

    restoredBrowser.send.mockClear();
    const result = restored.advanceBoardRow("s1", "q-460");

    expect(result?.removed).toBe(false);
    expect(result?.newState).toBe("IMPLEMENTING");
    expect(result?.board.map((row: any) => row.questId)).toEqual(["q-460", "q-461"]);
    expect(result?.board.find((row: any) => row.questId === "q-461")).toEqual(
      expect.objectContaining({
        status: "QUEUED",
        waitFor: ["q-460"],
      }),
    );

    const boardUpdates = restoredBrowser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter((msg: any) => msg?.type === "board_updated");
    expect(boardUpdates.at(-1)?.board.map((row: any) => row.questId)).toEqual(["q-460", "q-461"]);
  });
});
