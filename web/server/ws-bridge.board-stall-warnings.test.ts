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

describe("board stall warnings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupBoardStallHarness(opts?: {
    reviewer?: boolean;
    reviewStage?: "CODE_REVIEWING" | "MENTAL_SIMULATING" | "OUTCOME_REVIEWING";
    workerHasTimer?: boolean;
    blocked?: boolean;
    workerLiveState?: "idle" | "running";
    reviewerLiveState?: "idle" | "running";
  }) {
    const leaderId = "orch-board-stall";
    const workerId = "worker-board-stall";
    const reviewerId = "reviewer-board-stall";
    const now = Date.now();
    const launcherSessions = new Map<string, any>([
      [
        leaderId,
        {
          sessionId: leaderId,
          sessionNum: 1,
          isOrchestrator: true,
          backendType: "claude",
          cwd: "/repo",
          lastActivityAt: now,
        },
      ],
      [
        workerId,
        {
          sessionId: workerId,
          sessionNum: 2,
          herdedBy: leaderId,
          backendType: "claude",
          cwd: "/repo",
          lastActivityAt: now - 5 * 60_000,
        },
      ],
    ]);
    if (opts?.reviewer) {
      launcherSessions.set(reviewerId, {
        sessionId: reviewerId,
        sessionNum: 3,
        reviewerOf: 2,
        herdedBy: leaderId,
        backendType: "claude",
        cwd: "/repo",
        lastActivityAt: now - 5 * 60_000,
      });
    }

    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) =>
        id === leaderId
          ? Array.from(launcherSessions.values())
              .filter((session: any) => session.herdedBy === leaderId)
              .map((session: any) => ({ sessionId: session.sessionId }))
          : [],
      ),
      getSessionNum: vi.fn((id: string) => launcherSessions.get(id)?.sessionNum),
      listSessions: vi.fn(() => Array.from(launcherSessions.values())),
      resolveSessionId: vi.fn((ref: string) => {
        if (ref === "2") return workerId;
        if (ref === "3") return reviewerId;
        return null;
      }),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.setTimerManager({
      listTimers: vi.fn((sessionId: string) => (opts?.workerHasTimer && sessionId === workerId ? [{ id: "t1" }] : [])),
    } as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const leaderCli = makeCliSocket(leaderId);
    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-board-stall" }));

    bridge.getOrCreateSession(workerId);
    if (opts?.reviewer) bridge.getOrCreateSession(reviewerId);
    const connectLiveParticipant = (sessionId: string, liveState: "idle" | "running" | undefined) => {
      if (!liveState) return;
      const cli = makeCliSocket(sessionId);
      bridge.handleCLIOpen(cli, sessionId);
      bridge.handleCLIMessage(cli, makeInitMsg({ session_id: `cli-${sessionId}` }));
      const session = bridge.getSession(sessionId)!;
      session.isGenerating = liveState === "running";
    };
    connectLiveParticipant(workerId, opts?.workerLiveState);
    connectLiveParticipant(reviewerId, opts?.reviewerLiveState);
    bridge.upsertBoardRow(leaderId, {
      questId: "q-1",
      title: "Investigate stall warning",
      worker: workerId,
      workerNum: 2,
      status: opts?.blocked ? "QUEUED" : opts?.reviewer ? (opts.reviewStage ?? "CODE_REVIEWING") : "IMPLEMENTING",
      ...(opts?.blocked ? { waitFor: ["#9"] } : {}),
      updatedAt: now - 5 * 60_000,
    });
    return { leaderId, workerId, reviewerId, dispatcher, launcherSessions, leaderCli };
  }

  function setupCodexLeaderBoardStallHarness() {
    const leaderId = "orch-board-stall-codex";
    const workerId = "worker-board-stall-codex";
    const now = Date.now();
    const launcherSessions = new Map<string, any>([
      [
        leaderId,
        {
          sessionId: leaderId,
          sessionNum: 11,
          isOrchestrator: true,
          backendType: "codex",
          cwd: "/repo",
          lastActivityAt: now,
        },
      ],
      [
        workerId,
        {
          sessionId: workerId,
          sessionNum: 12,
          herdedBy: leaderId,
          backendType: "codex",
          cwd: "/repo",
          lastActivityAt: now - 5 * 60_000,
        },
      ],
    ]);

    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => launcherSessions.get(id)?.sessionNum),
      listSessions: vi.fn(() => Array.from(launcherSessions.values())),
      resolveSessionId: vi.fn((ref: string) => (ref === "12" ? workerId : null)),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.setTimerManager({ listTimers: vi.fn(() => []) } as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const adapter = makeCodexAdapterMock();
    vi.mocked(adapter.isConnected).mockReturnValue(false);
    bridge.attachCodexAdapter(leaderId, adapter as any);

    bridge.getOrCreateSession(workerId);
    bridge.upsertBoardRow(leaderId, {
      questId: "q-1",
      title: "Investigate delayed stall drop",
      worker: workerId,
      workerNum: 12,
      status: "IMPLEMENTING",
      updatedAt: now - 5 * 60_000,
    });

    return { leaderId, dispatcher, adapter };
  }

  it("emits a one-shot herd warning for a stalled implementing row", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness();
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(61_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(1);
    expect(herdCalls[0][1]).toContain("board_stalled");
    expect(herdCalls[0][1]).toContain("q-1");
    expect(herdCalls[0][1]).toContain("worker disconnected");

    vi.advanceTimersByTime(120_000);
    await Promise.resolve();
    const repeated = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(repeated).toHaveLength(1);

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("suppresses stalled-row warnings when the worker has an active timer", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness({ workerHasTimer: true });
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(181_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(0);

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("does not warn when an implementing worker is still connected and generating", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness({ workerLiveState: "running" });
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(181_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(0);

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("drops queued board_stalled herd inputs for Codex leaders once the board has already moved on", async () => {
    const { leaderId, dispatcher, adapter } = setupCodexLeaderBoardStallHarness();

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(61_000);
    await Promise.resolve();

    const queuedBeforeReconnect = bridge.getSession(leaderId)!;
    expect(queuedBeforeReconnect.pendingCodexInputs).toHaveLength(1);
    expect(queuedBeforeReconnect.pendingCodexInputs[0]?.content).toContain("board_stalled");

    bridge.upsertBoardRow(leaderId, {
      questId: "q-1",
      status: "PORTING",
      updatedAt: Date.now(),
    });

    vi.mocked(adapter.isConnected).mockReturnValue(true);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-board-stall-codex-drop" });
    await Promise.resolve();

    expect(
      adapter.sendBrowserMessage.mock.calls.some(
        ([msg]) => msg?.type === "codex_start_pending" && msg.inputs?.[0]?.content?.includes("board_stalled"),
      ),
    ).toBe(false);

    const sessionAfterReconnect = bridge.getSession(leaderId)!;
    expect(sessionAfterReconnect.pendingCodexInputs).toHaveLength(0);
    expect(sessionAfterReconnect.pendingCodexTurns).toHaveLength(0);

    dispatcher.destroy();
  });

  it("delivers queued board_stalled herd inputs for Codex leaders when the row is still stalled", async () => {
    const { leaderId, dispatcher, adapter } = setupCodexLeaderBoardStallHarness();

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(61_000);
    await Promise.resolve();

    vi.mocked(adapter.isConnected).mockReturnValue(true);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-board-stall-codex-deliver" });
    await Promise.resolve();

    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: [expect.objectContaining({ content: expect.stringContaining("board_stalled") })],
      }),
    );

    const sessionAfterReconnect = bridge.getSession(leaderId)!;
    expect(sessionAfterReconnect.pendingCodexInputs).toHaveLength(1);
    expect(sessionAfterReconnect.pendingCodexTurns[0]).toMatchObject({
      status: "dispatched",
      userContent: expect.stringContaining("board_stalled"),
    });

    dispatcher.destroy();
  });

  it("drops stale board_stalled herd batches before codex_steer_pending when a Codex leader already has an active turn", async () => {
    const { leaderId, dispatcher, adapter } = setupCodexLeaderBoardStallHarness();
    const browser = makeBrowserSocket(leaderId);

    vi.mocked(adapter.isConnected).mockReturnValue(true);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-board-stall-codex-steer-drop" });
    bridge.handleBrowserOpen(browser, leaderId);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "leader is already handling the next step",
      }),
    );
    await Promise.resolve();
    adapter.emitTurnStarted("turn-board-stall-active");
    await Promise.resolve();
    adapter.sendBrowserMessage.mockClear();

    bridge.upsertBoardRow(leaderId, {
      questId: "q-1",
      status: "PORTING",
      updatedAt: Date.now(),
    });

    bridge.injectUserMessage(
      leaderId,
      "1 event from 1 session\n\n#12 | board_stalled | q-1 Investigate delayed stall drop | IMPLEMENTING | worker disconnected | stalled 4m",
      {
        sessionId: "herd-events",
        sessionLabel: "Herd Events",
      },
      {
        events: [
          {
            id: 1,
            event: "board_stalled",
            sessionId: "worker-board-stall-codex",
            sessionNum: 12,
            sessionName: "worker-board-stall-codex",
            ts: Date.now(),
            data: {
              questId: "q-1",
              title: "Investigate delayed stall drop",
              stage: "IMPLEMENTING",
              signature: "q-1|IMPLEMENTING|disconnected",
              workerStatus: "disconnected",
              reviewerStatus: "missing",
              stalledForMs: 240_000,
              reason: "worker disconnected",
              action: "inspect worker; resume or re-dispatch before review",
            },
          } as any,
        ],
        renderedLines: [
          "#12 | board_stalled | q-1 Investigate delayed stall drop | IMPLEMENTING | worker disconnected | stalled 4m",
        ],
      },
    );
    await Promise.resolve();

    expect(adapter.sendBrowserMessage.mock.calls.some(([msg]) => msg?.type === "codex_steer_pending")).toBe(false);

    const sessionAfterInject = bridge.getSession(leaderId)!;
    expect(sessionAfterInject.pendingCodexInputs).toHaveLength(0);
    expect(sessionAfterInject.pendingCodexTurns).toHaveLength(1);
    expect(sessionAfterInject.pendingCodexTurns[0]).toMatchObject({
      turnId: "turn-board-stall-active",
    });

    dispatcher.destroy();
  });

  it("drops same-batch worker board_stalled events when turn_end supersedes them", async () => {
    const { leaderId, dispatcher } = setupCodexLeaderBoardStallHarness();
    const now = Date.now();
    const boardStalled = {
      id: 1,
      event: "board_stalled",
      sessionId: "worker-board-stall-codex",
      sessionNum: 12,
      sessionName: "worker-board-stall-codex",
      ts: now,
      data: {
        questId: "q-1",
        title: "Investigate delayed stall drop",
        stage: "IMPLEMENTING",
        signature: "q-1|IMPLEMENTING|disconnected",
        workerStatus: "disconnected",
        reviewerStatus: "missing",
        stalledForMs: 240_000,
        reason: "worker disconnected",
        action: "inspect worker; resume or re-dispatch before review",
      },
    } as any;
    const turnEnd = {
      id: 2,
      event: "turn_end",
      sessionId: "worker-board-stall-codex",
      sessionNum: 12,
      sessionName: "worker-board-stall-codex",
      ts: now + 1,
      data: { duration_ms: 1000, reason: "result" },
    } as any;
    const rendered = renderHerdEventBatch([boardStalled, turnEnd]);
    const expected = renderHerdEventBatch([turnEnd]);

    const delivery = bridge.injectUserMessage(
      leaderId,
      rendered.content,
      {
        sessionId: "herd-events",
        sessionLabel: "Herd Events",
      },
      {
        events: [boardStalled, turnEnd],
        renderedLines: rendered.renderedLines,
      },
    );
    await Promise.resolve();

    expect(delivery).toBe("queued");
    const sessionAfterInject = bridge.getSession(leaderId)!;
    expect(sessionAfterInject.pendingCodexInputs).toHaveLength(1);
    expect(sessionAfterInject.pendingCodexInputs[0]?.content).toBe(expected.content);
    expect(sessionAfterInject.pendingCodexInputs[0]?.content).toContain("1 event from 1 session\n\n");
    expect(sessionAfterInject.pendingCodexInputs[0]?.content).toContain("turn_end");
    expect(sessionAfterInject.pendingCodexInputs[0]?.content).not.toContain("board_stalled");

    dispatcher.destroy();
  });

  it("drops same-batch reviewer board_stalled events even when attributed to the worker", async () => {
    const { leaderId, workerId, reviewerId, dispatcher, leaderCli } = setupBoardStallHarness({ reviewer: true });
    const now = Date.now();
    leaderCli.send.mockClear();
    const boardStalled = {
      id: 1,
      event: "board_stalled",
      sessionId: workerId,
      sessionNum: 2,
      sessionName: workerId,
      ts: now,
      data: {
        questId: "q-1",
        title: "Investigate stall warning",
        stage: "CODE_REVIEWING",
        signature: "q-1|CODE_REVIEWING|reviewer|disconnected",
        workerStatus: "disconnected",
        reviewerStatus: "disconnected",
        stalledForMs: 240_000,
        reason: "reviewer disconnected",
        action: "inspect reviewer; re-dispatch code review if needed",
      },
    } as any;
    const turnEnd = {
      id: 2,
      event: "turn_end",
      sessionId: reviewerId,
      sessionNum: 3,
      sessionName: reviewerId,
      ts: now + 1,
      data: { duration_ms: 1000, reason: "result" },
    } as any;
    const rendered = renderHerdEventBatch([boardStalled, turnEnd]);

    const delivery = bridge.injectUserMessage(
      leaderId,
      rendered.content,
      {
        sessionId: "herd-events",
        sessionLabel: "Herd Events",
      },
      {
        events: [boardStalled, turnEnd],
        renderedLines: rendered.renderedLines,
      },
    );

    expect(delivery).toBe("sent");
    const sentPayload = leaderCli.send.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(sentPayload).toContain("1 event from 1 session");
    expect(sentPayload).toContain("turn_end");
    expect(sentPayload).not.toContain("board_stalled");

    dispatcher.destroy();
  });

  it("keeps same-batch board_stalled events when turn_end is older than the stall event", async () => {
    const { leaderId, dispatcher } = setupCodexLeaderBoardStallHarness();
    const now = Date.now();
    const turnEnd = {
      id: 1,
      event: "turn_end",
      sessionId: "worker-board-stall-codex",
      sessionNum: 12,
      sessionName: "worker-board-stall-codex",
      ts: now - 1,
      data: { duration_ms: 1000, reason: "result" },
    } as any;
    const boardStalled = {
      id: 2,
      event: "board_stalled",
      sessionId: "worker-board-stall-codex",
      sessionNum: 12,
      sessionName: "worker-board-stall-codex",
      ts: now,
      data: {
        questId: "q-1",
        title: "Investigate delayed stall drop",
        stage: "IMPLEMENTING",
        signature: "q-1|IMPLEMENTING|disconnected",
        workerStatus: "disconnected",
        reviewerStatus: "missing",
        stalledForMs: 240_000,
        reason: "worker disconnected",
        action: "inspect worker; resume or re-dispatch before review",
      },
    } as any;
    const rendered = renderHerdEventBatch([turnEnd, boardStalled]);

    const delivery = bridge.injectUserMessage(
      leaderId,
      rendered.content,
      {
        sessionId: "herd-events",
        sessionLabel: "Herd Events",
      },
      {
        events: [turnEnd, boardStalled],
        renderedLines: rendered.renderedLines,
      },
    );
    await Promise.resolve();

    expect(delivery).toBe("queued");
    const sessionAfterInject = bridge.getSession(leaderId)!;
    expect(sessionAfterInject.pendingCodexInputs).toHaveLength(1);
    expect(sessionAfterInject.pendingCodexInputs[0]?.content).toContain("2 events from 1 session");
    expect(sessionAfterInject.pendingCodexInputs[0]?.content).toContain("turn_end");
    expect(sessionAfterInject.pendingCodexInputs[0]?.content).toContain("board_stalled");

    dispatcher.destroy();
  });

  it("does not warn for queued rows with unresolved wait-for dependencies", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness({ blocked: true });
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(181_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(0);

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("does not warn for rows intentionally waiting on linked user input", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness();
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");
    const leaderSession = (bridge as any).sessions.get(leaderId);

    leaderSession.notifications.push({
      id: "n-1",
      category: "needs-input",
      summary: "Need human answer",
      timestamp: Date.now(),
      messageId: null,
      done: false,
    });
    bridge.upsertBoardRow(leaderId, {
      questId: "q-1",
      waitForInput: ["n-1"],
      status: "IMPLEMENTING",
      updatedAt: Date.now() - 5 * 60_000,
    });

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(181_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(0);

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("emits a one-shot leader nudge when a completed quest normalizes a queued row to free-worker", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness();
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");
    const leaderSession = (bridge as any).sessions.get(leaderId);

    leaderSession.messageHistory.push({
      type: "assistant",
      message: { id: "leader-board-note", content: [{ type: "text", text: "Queued follow-up noted." }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow(leaderId, {
      questId: "q-2",
      title: "Follow-up quest",
      status: "QUEUED",
      waitFor: ["q-1"],
      updatedAt: Date.now() - 60_000,
    });
    bridge.removeBoardRows(leaderId, ["q-1"]); // q-1 -> completed board

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(0);
    expect(leaderSession.board.get("q-2")?.waitFor).toEqual(["free-worker"]);
    expect(leaderSession.attentionReason).toBe("action");
    expect(leaderSession.notifications.at(-1)?.summary).toContain("worker slots are available");

    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    const repeated = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(repeated).toHaveLength(0);

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("keeps dispatchable reminders out of the leader notification inbox once the queued row is dispatched", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness();
    const leaderSession = (bridge as any).sessions.get(leaderId);

    leaderSession.messageHistory.push({
      type: "assistant",
      message: { id: "leader-board-note-2", content: [{ type: "text", text: "Queued follow-up noted." }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow(leaderId, {
      questId: "q-2",
      title: "Follow-up quest",
      status: "QUEUED",
      waitFor: ["q-1"],
      updatedAt: Date.now() - 60_000,
    });
    bridge.removeBoardRows(leaderId, ["q-1"]);

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    const dispatchNotif = leaderSession.notifications.find((notif: any) =>
      notif.summary.includes("worker slots are available"),
    );
    expect(dispatchNotif?.done).toBe(false);
    expect(leaderSession.attentionReason).toBe("action");

    bridge.upsertBoardRow(leaderId, {
      questId: "q-2",
      worker: "worker-board-stall",
      workerNum: 2,
      status: "PLANNING",
    });

    expect(leaderSession.notifications.find((notif: any) => notif.id === dispatchNotif.id)?.done).toBe(true);
    expect(leaderSession.attentionReason).toBeNull();

    dispatcher.destroy();
  });

  it("still creates a leader notification when a resolved quest dependency has no source session to attribute", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness();
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");
    const leaderSession = (bridge as any).sessions.get(leaderId);

    leaderSession.messageHistory.push({
      type: "assistant",
      message: { id: "leader-board-note-3", content: [{ type: "text", text: "Queued follow-up noted." }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow(leaderId, {
      questId: "q-3",
      title: "Quest without source worker",
      status: "QUEUED",
      waitFor: ["q-99"],
      updatedAt: Date.now() - 60_000,
    });
    bridge.upsertBoardRow(leaderId, {
      questId: "q-99",
      title: "Completed dependency without worker",
      status: "PORTING",
      updatedAt: Date.now() - 120_000,
    });
    bridge.removeBoardRows(leaderId, ["q-99"]);

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    expect(leaderSession.notifications.some((notif: any) => notif.summary.includes("worker slots are available"))).toBe(
      true,
    );
    expect(leaderSession.attentionReason).toBe("action");
    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, content, source]) =>
        sessionId === leaderId && source?.sessionId === "herd-events" && String(content).includes("q-3"),
    );
    expect(herdCalls).toHaveLength(0);

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("retains no leader notification when watchdog re-evaluation finds the row blocked again", async () => {
    const { leaderId, dispatcher, launcherSessions } = setupBoardStallHarness();
    const leaderSession = (bridge as any).sessions.get(leaderId);
    const workerCli = makeCliSocket("worker-board-stall");

    bridge.handleCLIOpen(workerCli, "worker-board-stall");
    bridge.handleCLIMessage(workerCli, makeInitMsg({ session_id: "cli-worker-board-stall" }));

    leaderSession.messageHistory.push({
      type: "assistant",
      message: { id: "leader-board-note-4", content: [{ type: "text", text: "Queued follow-up noted." }] },
      timestamp: Date.now(),
    });

    bridge.upsertBoardRow(leaderId, {
      questId: "q-4",
      title: "Capacity-sensitive follow-up",
      status: "QUEUED",
      waitFor: ["#2"],
      updatedAt: Date.now() - 60_000,
    });

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    expect(leaderSession.notifications.some((notif: any) => notif.summary.includes("q-4 can be dispatched now"))).toBe(
      false,
    );
    expect(leaderSession.attentionReason).toBeNull();

    const workerSession = bridge.getSession("worker-board-stall")!;
    workerSession.isGenerating = true;
    launcherSessions.get("worker-board-stall").lastActivityAt = Date.now();

    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    expect(leaderSession.notifications.some((notif: any) => notif.summary.includes("q-4 can be dispatched now"))).toBe(
      false,
    );
    expect(leaderSession.attentionReason).toBeNull();

    dispatcher.destroy();
  });

  it("creates a leader nudge for free-worker rows once capacity becomes available", async () => {
    const { leaderId, dispatcher, launcherSessions } = setupBoardStallHarness();
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");
    const leaderSession = (bridge as any).sessions.get(leaderId);

    leaderSession.messageHistory.push({
      type: "assistant",
      message: { id: "leader-board-note-5", content: [{ type: "text", text: "Queued free-worker follow-up noted." }] },
      timestamp: Date.now(),
    });

    launcherSessions.set("worker-extra-1", {
      sessionId: "worker-extra-1",
      sessionNum: 4,
      herdedBy: leaderId,
      backendType: "codex",
      cwd: "/repo",
      lastActivityAt: Date.now(),
    });
    launcherSessions.set("worker-extra-2", {
      sessionId: "worker-extra-2",
      sessionNum: 5,
      herdedBy: leaderId,
      backendType: "codex",
      cwd: "/repo",
      lastActivityAt: Date.now(),
    });
    launcherSessions.set("worker-extra-3", {
      sessionId: "worker-extra-3",
      sessionNum: 6,
      herdedBy: leaderId,
      backendType: "codex",
      cwd: "/repo",
      lastActivityAt: Date.now(),
    });
    launcherSessions.set("worker-extra-4", {
      sessionId: "worker-extra-4",
      sessionNum: 7,
      herdedBy: leaderId,
      backendType: "codex",
      cwd: "/repo",
      lastActivityAt: Date.now(),
    });

    bridge.upsertBoardRow(leaderId, {
      questId: "q-5",
      title: "Free-worker-only row",
      status: "QUEUED",
      waitFor: ["free-worker"],
      updatedAt: Date.now() - 60_000,
    });

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    expect(leaderSession.notifications.some((notif: any) => notif.summary.includes("q-5 can be dispatched now"))).toBe(
      false,
    );

    launcherSessions.delete("worker-extra-4"); // 4/5 used now, so board output would read as dispatchable
    vi.advanceTimersByTime(31_000);
    await Promise.resolve();

    expect(leaderSession.notifications.some((notif: any) => notif.summary.includes("q-5 can be dispatched now"))).toBe(
      true,
    );
    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, content, source]) =>
        sessionId === leaderId && source?.sessionId === "herd-events" && String(content).includes("q-5"),
    );
    expect(herdCalls).toHaveLength(0);

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("warns when a review-stage row has a stalled reviewer", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness({ reviewer: true });
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(61_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(1);
    expect(herdCalls[0][1]).toContain("reviewer disconnected");
    expect(herdCalls[0][1]).toContain("re-dispatch code review");

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("classifies a live outcome reviewer as idle instead of disconnected", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness({
      reviewer: true,
      reviewStage: "OUTCOME_REVIEWING",
      reviewerLiveState: "idle",
    });
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(181_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(1);
    expect(herdCalls[0][1]).toContain("reviewer idle");
    expect(herdCalls[0][1]).not.toContain("reviewer disconnected");

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("warns when a review-stage row has no attached reviewer", async () => {
    const { leaderId, dispatcher } = setupBoardStallHarness({ reviewer: false });
    const injectSpy = vi.spyOn(bridge, "injectUserMessage");

    const leaderSession = bridge.getSession(leaderId)!;
    const row = leaderSession.board.get("q-1")!;
    row.status = "CODE_REVIEWING";
    row.updatedAt = Date.now() - 5 * 60_000;
    leaderSession.board.set("q-1", row);

    bridge.startStuckSessionWatchdog();
    vi.advanceTimersByTime(61_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(1);
    expect(herdCalls[0][1]).toContain("reviewer missing");
    expect(herdCalls[0][1]).toContain("attach code reviewer");

    injectSpy.mockRestore();
    dispatcher.destroy();
  });

  it("does not emit stalled warnings for stale active board rows restored after restart", async () => {
    const leaderId = "orch-board-stall-restore";
    const workerId = "worker-board-stall-restore";
    const now = Date.now();

    bridge.getOrCreateSession(leaderId);
    bridge.upsertBoardRow(leaderId, {
      questId: "q-1",
      title: "Already finished quest",
      worker: workerId,
      workerNum: 2,
      status: "IMPLEMENTING",
      updatedAt: now - 5 * 60_000,
    });
    bridge.persistSessionSync(leaderId);

    const restored = attachBoardFacade(new WsBridge());
    restored.setStore(store);
    restored.resolveQuestStatus = async (questId) => (questId === "q-1" ? "done" : null);

    const launcherSessions = new Map<string, any>([
      [
        leaderId,
        {
          sessionId: leaderId,
          sessionNum: 1,
          isOrchestrator: true,
          backendType: "claude",
          cwd: "/repo",
          lastActivityAt: now,
        },
      ],
      [
        workerId,
        {
          sessionId: workerId,
          sessionNum: 2,
          herdedBy: leaderId,
          backendType: "codex",
          cwd: "/repo",
          lastActivityAt: now - 5 * 60_000,
        },
      ],
    ]);
    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => launcherSessions.get(id)?.sessionNum),
      listSessions: vi.fn(() => Array.from(launcherSessions.values())),
      resolveSessionId: vi.fn((ref: string) => (ref === "2" ? workerId : null)),
    };
    restored.setLauncher(launcherMock as any);
    restored.setTimerManager({ listTimers: vi.fn(() => []) } as any);
    const dispatcher = new HerdEventDispatcher(restored as any, launcherMock as any);
    restored.setHerdEventDispatcher(dispatcher);

    await restored.restoreFromDisk();
    expect(restored.getBoard(leaderId)).toHaveLength(0);

    const injectSpy = vi.spyOn(restored, "injectUserMessage");
    dispatcher.setupForOrchestrator(leaderId);
    const leaderCli = makeCliSocket(leaderId);
    restored.handleCLIOpen(leaderCli, leaderId);
    restored.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-board-stall-restore" }));

    restored.startStuckSessionWatchdog();
    vi.advanceTimersByTime(181_000);
    await Promise.resolve();

    const herdCalls = injectSpy.mock.calls.filter(
      ([sessionId, _content, source]) => sessionId === leaderId && source?.sessionId === "herd-events",
    );
    expect(herdCalls).toHaveLength(0);

    injectSpy.mockRestore();
    dispatcher.destroy();
  });
});
