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
import { GIT_STATUS_AUTO_REFRESH_STALE_MS } from "../shared/git-status-freshness.js";
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

describe("Diff stats computation", () => {
  it("computeDiffStats: uses merge-base anchor for worktree branch refs", async () => {
    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    (session as any).backendSocket = { send: vi.fn() };

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat-wt-1234\n";
      if (cmd.includes("rev-parse HEAD")) return "head-sha-1\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/feat-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t2\n";
      if (cmd.includes("merge-base jiayi HEAD")) return "wt-anchor-sha\n";
      if (cmd.includes("diff --numstat wt-anchor-sha")) return "7\t2\tsrc/file.ts\n";
      return "";
    });

    bridge.setDiffBaseBranch("s1", "jiayi");

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(7);
      expect(session.state.total_lines_removed).toBe(2);
    });
  });

  it("computeDiffStats: compares directly to selected commit SHA in worktree mode", async () => {
    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.diff_base_branch = "abcdef1234567";
    session.diffStatsDirty = true;
    (session as any).backendSocket = { send: vi.fn() };

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("diff --numstat abcdef1234567")) return "9\t4\tsrc/file.ts\n";
      if (cmd.includes("merge-base --is-ancestor")) return "";
      if (cmd.includes("merge-base abcdef1234567 HEAD")) throw new Error("should not use merge-base for commit refs");
      return "";
    });

    bridge.recomputeDiffIfDirty(session);

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(9);
      expect(session.state.total_lines_removed).toBe(4);
    });
  });

  it("computeDiffStats: uses diff_base_start_sha for worktree sessions", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("diff --numstat base-start-sha")) return "4\t1\tsrc/app.ts\n2\t0\tsrc/util.ts\n";
      if (cmd.includes("merge-base")) throw new Error("should not call merge-base for anchored worktree diff");
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.diff_base_start_sha = "base-start-sha";
    session.state.git_ahead = 2;
    session.diffStatsDirty = true;
    (session as any).backendSocket = { send: vi.fn() };

    bridge.recomputeDiffIfDirty(session);

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(6);
      expect(session.state.total_lines_removed).toBe(1);
    });
  });

  it("re-anchors worktree diff base to merge-base after base ref changes", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/rebased\n";
      if (cmd.includes("rev-parse HEAD")) return "new-head-sha\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/feat-rebased\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t1\n";
      if (cmd.includes("merge-base jiayi HEAD")) return "rebased-anchor-sha\n";
      if (cmd.includes("diff --numstat rebased-anchor-sha")) return "3\t1\tsrc/rebased.ts\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.git_head_sha = "old-head-sha";
    session.state.diff_base_start_sha = "old-anchor-sha";
    session.diffStatsDirty = true;
    (session as any).backendSocket = { send: vi.fn() };

    bridge.setDiffBaseBranch("s1", "jiayi");

    await vi.waitFor(() => {
      expect(session.state.diff_base_start_sha).toBe("rebased-anchor-sha");
      expect(session.state.total_lines_added).toBe(3);
      expect(session.state.total_lines_removed).toBe(1);
    });
  });

  it("computeDiffStats: parses git diff --numstat output correctly", async () => {
    // Set up a session with diff_base_branch and tracked files
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "10\t3\tfile1.ts\n5\t2\tfile2.ts\n-\t-\timage.png\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;

    // Set cwd so computeDiffStats can run
    session.state.cwd = "/tmp/wt";
    // Ensure the session has a CLI socket so recomputeDiffIfDirty doesn't skip
    (session as any).backendSocket = { send: vi.fn() };

    // Use setDiffBaseBranch which triggers computeDiff
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/feat-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t2\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "10\t3\tfile1.ts\n5\t2\tfile2.ts\n-\t-\timage.png\n";
      return "";
    });

    bridge.setDiffBaseBranch("s1", "develop");

    // Async diff computation needs a tick to resolve
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(15);
      expect(session.state.total_lines_removed).toBe(5);
    });
  });

  it("computeDiffStats: handles empty diff gracefully", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";

    bridge.setDiffBaseBranch("s1", "main");

    expect(session.state.total_lines_added).toBe(0);
    expect(session.state.total_lines_removed).toBe(0);
  });

  it("computeDiffStats: uses merge-base for non-worktree sessions to exclude remote changes", async () => {
    // Validates the core fix: non-worktree sessions should diff against merge-base,
    // not the raw branch ref. Without merge-base anchoring, `git diff main` includes
    // changes the session is BEHIND on (remote commits), inflating the stats.
    const mergeBaseCalls: string[] = [];
    const diffCalls: string[] = [];
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("diff --numstat")) {
        diffCalls.push(cmd);
        // Only return stats when diffing against the merge-base SHA (not raw branch ref)
        if (cmd.includes("abc999def")) return "5\t2\tchanged.ts\n";
        // If the raw branch ref slips through, return inflated stats (the bug)
        return "100\t50\tremote-changes.ts\n5\t2\tchanged.ts\n";
      }
      if (cmd.includes("merge-base")) {
        mergeBaseCalls.push(cmd);
        return "abc999def\n";
      }
      return "";
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "origin/main";
    session.state.is_worktree = false;
    session.diffStatsDirty = true;
    (session as any).backendSocket = { send: vi.fn() };

    bridge.recomputeDiffIfDirty(session);

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(5);
      expect(session.state.total_lines_removed).toBe(2);
    });

    // Verify merge-base was called with the branch ref
    expect(mergeBaseCalls).toHaveLength(1);
    expect(mergeBaseCalls[0]).toContain("origin/main");
    // Verify diff was called with the merge-base SHA, not the raw branch ref
    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0]).toContain("abc999def");
    expect(diffCalls[0]).not.toContain("origin/main");
  });

  it("recomputeDiffIfDirty: skips when flag is clean, recomputes when dirty", async () => {
    // Session with diff base set up so computeDiffStatsAsync can run
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main-wt-1\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/main-wt-1\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t1\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "10\t3\tfile.ts\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.git_ahead = 1;
    // Ensure the session has a CLI socket so refreshGitInfo/recomputeDiffIfDirty don't skip
    (session as any).backendSocket = { send: vi.fn() };
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");

    // Dirty by default — recompute should run
    expect(session.diffStatsDirty).toBe(true);
    bridge.recomputeDiffIfDirty(session);
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(10);
      expect(session.state.total_lines_removed).toBe(3);
    });
    // Flag cleared after successful computation
    expect(session.diffStatsDirty).toBe(false);

    // Change mock — but flag is clean, so recompute should be skipped
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "99\t88\tfile.ts\n";
      return "";
    });

    bridge.recomputeDiffIfDirty(session);
    // Give it a tick — values should NOT change since flag is clean
    await new Promise((r) => setTimeout(r, 50));
    expect(session.state.total_lines_added).toBe(10); // unchanged

    // Mark dirty again — recompute should pick up new values
    session.diffStatsDirty = true;
    bridge.recomputeDiffIfDirty(session);
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(99);
      expect(session.state.total_lines_removed).toBe(88);
    });
    expect(session.diffStatsDirty).toBe(false);
  });

  it("recomputes dirty diff stats when CLI reconnects after browser-open skip", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/reconnect\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t3\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "6\t2\tsrc/app.ts\n";
      return "";
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "main";
    session.state.total_lines_added = 0;
    session.state.total_lines_removed = 0;
    session.diffStatsDirty = true;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // No backend yet, so the browser-open recompute path is skipped.
    expect(session.state.total_lines_added).toBe(0);
    expect(session.diffStatsDirty).toBe(true);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(6);
      expect(session.state.total_lines_removed).toBe(2);
    });
    expect(session.diffStatsDirty).toBe(false);
  });

  it("recomputes diff stats on browser open for disconnected worktree sessions", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/jiayi-wt-1\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("rev-parse HEAD")) return "new-head-sha\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "new-head-sha\n";
      if (cmd.includes("diff --numstat")) return "\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.diff_base_start_sha = "old-anchor-sha";
    session.state.git_head_sha = "old-head-sha";
    session.diffStatsDirty = true;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await vi.waitFor(() => {
      expect(session.state.diff_base_start_sha).toBe("new-head-sha");
      expect(session.state.total_lines_added).toBe(0);
      expect(session.state.total_lines_removed).toBe(0);
    });
    expect(session.diffStatsDirty).toBe(false);
  });

  it("refreshWorktreeGitStateForSnapshot forces a clean diff recompute after external reset", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/jiayi-wt-1\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("rev-parse HEAD")) return "same-head-sha\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "same-head-sha\n";
      if (cmd.includes("diff --numstat")) return "\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.git_head_sha = "same-head-sha";
    session.state.diff_base_start_sha = "same-head-sha";
    session.state.total_lines_added = 777;
    session.state.total_lines_removed = 55;
    session.diffStatsDirty = false;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    (browser.send as any).mockClear();

    await bridge.refreshWorktreeGitStateForSnapshot("s1", { broadcastUpdate: true });

    expect(session.state.total_lines_added).toBe(0);
    expect(session.state.total_lines_removed).toBe(0);
    expect(session.diffStatsDirty).toBe(false);
    expect(
      (browser.send as any).mock.calls.some(([raw]: [string]) => {
        const msg = JSON.parse(raw);
        return (
          msg.type === "session_update" &&
          msg.session?.total_lines_added === 0 &&
          msg.session?.total_lines_removed === 0
        );
      }),
    ).toBe(true);
  });

  it("refreshWorktreeGitStateForSnapshot clears worktree diff totals when the session is not ahead", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/jiayi-wt-1\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("rev-parse HEAD")) return "same-head-sha\n";
      if (cmd.includes("--left-right --count")) return "2\t0\n";
      if (cmd.includes("merge-base")) return "same-head-sha\n";
      if (cmd.includes("diff --numstat")) return "37\t2\ttracked.py\n6\t0\tother.py\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.git_head_sha = "same-head-sha";
    session.state.diff_base_start_sha = "same-head-sha";
    session.state.total_lines_added = 43;
    session.state.total_lines_removed = 2;
    session.diffStatsDirty = false;

    await bridge.refreshWorktreeGitStateForSnapshot("s1", { broadcastUpdate: true });

    expect(session.state.git_ahead).toBe(0);
    expect(session.state.git_behind).toBe(2);
    expect(session.state.total_lines_added).toBe(0);
    expect(session.state.total_lines_removed).toBe(0);
  });

  it("refreshWorktreeGitStateForSnapshot skips git work when the worktree fingerprint is unchanged", async () => {
    const worktreeCwd = join(tempDir, "wt");
    const worktreeGitDir = join(tempDir, "repo.git", "worktrees", "wt-1");
    mkdirSync(worktreeCwd, { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeCwd, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/jiayi-wt-1\n");
    writeFileSync(join(worktreeGitDir, "index"), "index");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1\n";
      if (cmd.includes("--git-dir")) return `${worktreeGitDir}\n`;
      if (cmd.includes("--git-common-dir")) return `${join(tempDir, "repo.git")}\n`;
      if (cmd.includes("rev-parse HEAD")) return "same-head-sha\n";
      if (cmd.includes("--left-right --count")) return "0\t1\n";
      if (cmd.includes("merge-base")) return "same-head-sha\n";
      if (cmd.includes("diff --numstat")) return "10\t3\tfile.ts\n";
      return "";
    });

    bridge.markWorktree("s1", join(tempDir, "repo"), worktreeCwd, "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = worktreeCwd;

    await bridge.refreshWorktreeGitStateForSnapshot("s1");
    expect(session.state.total_lines_added).toBe(10);
    expect(session.state.total_lines_removed).toBe(3);
    session.state.git_status_refreshed_at = Date.now();

    mockExecSync.mockClear();
    await bridge.refreshWorktreeGitStateForSnapshot("s1");

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(session.state.total_lines_added).toBe(10);
    expect(session.state.total_lines_removed).toBe(3);
  });

  it("refreshWorktreeGitStateForSnapshot rechecks stale worktree git status even when the fingerprint is unchanged", async () => {
    const worktreeCwd = join(tempDir, "wt");
    const worktreeGitDir = join(tempDir, "repo.git", "worktrees", "wt-1");
    mkdirSync(worktreeCwd, { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeCwd, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/jiayi-wt-1\n");
    writeFileSync(join(worktreeGitDir, "index"), "index");

    let ahead = 1;
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1\n";
      if (cmd.includes("--git-dir")) return `${worktreeGitDir}\n`;
      if (cmd.includes("--git-common-dir")) return `${join(tempDir, "repo.git")}\n`;
      if (cmd.includes("rev-parse HEAD")) return "same-head-sha\n";
      if (cmd.includes("--left-right --count")) return `0\t${ahead}\n`;
      if (cmd.includes("merge-base")) return "same-head-sha\n";
      if (cmd.includes("diff --numstat")) return "10\t3\tfile.ts\n";
      return "";
    });

    bridge.markWorktree("s1", join(tempDir, "repo"), worktreeCwd, "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = worktreeCwd;

    await bridge.refreshWorktreeGitStateForSnapshot("s1");
    expect(session.state.git_ahead).toBe(1);
    expect(session.state.total_lines_added).toBe(10);

    ahead = 0;
    session.state.git_status_refreshed_at = Date.now() - GIT_STATUS_AUTO_REFRESH_STALE_MS - 1;
    mockExecSync.mockClear();
    await bridge.refreshWorktreeGitStateForSnapshot("s1");

    expect(session.state.git_ahead).toBe(0);
    expect(session.state.total_lines_added).toBe(0);
    expect(session.state.total_lines_removed).toBe(0);
    expect(
      mockExecSync.mock.calls.some((call: unknown[]) => String(call[0]).includes("rev-list --left-right --count")),
    ).toBe(true);
  });

  it("refreshWorktreeGitStateForSnapshot coalesces concurrent refreshes for the same session", async () => {
    const worktreeCwd = join(tempDir, "wt");
    const worktreeGitDir = join(tempDir, "repo.git", "worktrees", "wt-1");
    mkdirSync(worktreeCwd, { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeCwd, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/jiayi-wt-1\n");
    writeFileSync(join(worktreeGitDir, "index"), "index");

    const diffCallbacks: Array<(err: Error | null, result: { stdout: string; stderr: string }) => void> = [];
    const commands: string[] = [];
    mockExec.mockImplementation((cmd: string, opts: any, cb?: Function) => {
      commands.push(cmd);
      const callback = typeof opts === "function" ? opts : cb;
      if (cmd.includes("diff --numstat")) {
        if (callback) diffCallbacks.push(callback);
        return;
      }
      let stdout = "";
      if (cmd.includes("--abbrev-ref HEAD")) stdout = "jiayi-wt-1\n";
      else if (cmd.includes("--git-dir")) stdout = `${worktreeGitDir}\n`;
      else if (cmd.includes("--git-common-dir")) stdout = `${join(tempDir, "repo.git")}\n`;
      else if (cmd.includes("rev-parse HEAD")) stdout = "same-head-sha\n";
      else if (cmd.includes("--left-right --count")) stdout = "0\t1\n";
      else if (cmd.includes("merge-base")) stdout = "same-head-sha\n";
      callback?.(null, { stdout, stderr: "" });
    });

    bridge.markWorktree("s1", join(tempDir, "repo"), worktreeCwd, "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = worktreeCwd;

    const first = bridge.refreshWorktreeGitStateForSnapshot("s1");
    const second = bridge.refreshWorktreeGitStateForSnapshot("s1");

    await vi.waitFor(() => expect(diffCallbacks).toHaveLength(1));
    diffCallbacks[0]!(null, { stdout: "10\t3\tfile.ts\n", stderr: "" });
    await Promise.all([first, second]);

    expect(commands.filter((cmd) => cmd.includes("diff --numstat"))).toHaveLength(1);
    expect(session.state.total_lines_added).toBe(10);
    expect(session.state.total_lines_removed).toBe(3);
  });

  it("non-read-only tool marks diffStatsDirty; read-only tool does not", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      return "";
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    const session = bridge.getSession("s1")!;
    // Clear dirty flag from initialization
    session.diffStatsDirty = false;

    // Read-only tool (e.g. Read) should NOT mark dirty
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-read",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [
            {
              type: "tool_use",
              id: "tool-read",
              name: "Read",
              input: { file_path: "/repo/file.ts" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u-read",
        session_id: "s1",
      }),
    );
    expect(session.diffStatsDirty).toBe(false);

    // Non-read-only tool (Edit) should mark dirty and track the file
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-edit",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [
            {
              type: "tool_use",
              id: "tool-edit",
              name: "Edit",
              input: { file_path: "/repo/file.ts", old_string: "a", new_string: "b" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u-edit",
        session_id: "s1",
      }),
    );
    expect(session.diffStatsDirty).toBe(true);

    // Bash tool (not in READ_ONLY_TOOLS) should also mark dirty
    session.diffStatsDirty = false;
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-bash",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [
            {
              type: "tool_use",
              id: "tool-bash",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u-bash",
        session_id: "s1",
      }),
    );
    expect(session.diffStatsDirty).toBe(true);
  });

  it("resolveGitInfo: uses diff_base_branch directly for ahead/behind (no @{upstream} fallback)", async () => {
    // Session with diff_base_branch pre-set — resolveGitInfo should use it directly
    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      // Verify the ref used is "jiayi" (from diff_base_branch), not "@{upstream}"
      if (cmd.includes("--left-right --count") && cmd.includes("jiayi...HEAD")) return "2\t3\n";
      if (cmd.includes("--left-right --count")) throw new Error("wrong ref used");
      return "";
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/tmp/wt" }));

    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    await vi.waitFor(() => {
      expect(session.state.git_ahead).toBe(3);
      expect(session.state.git_behind).toBe(2);
      expect(session.state.diff_base_branch).toBe("jiayi");
    });
  });
});
