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

describe("Cross-session branch invalidation", () => {
  // Tests for the branch-to-sessions reverse index and cross-session
  // diff stats invalidation when a branch tip moves.

  function setupGitMocks(overrides: Record<string, string> = {}) {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return overrides.branch || "feature-x\n";
      if (cmd.includes("rev-parse HEAD")) return overrides.headSha || "sha-111\n";
      if (cmd.includes("--git-dir")) return overrides.gitDir || "/repo/.git/worktrees/wt\n";
      if (cmd.includes("--git-common-dir")) return overrides.commonDir || "/repo/.git\n";
      if (cmd.includes("--show-toplevel")) return overrides.toplevel || "/repo\n";
      if (cmd.includes("--left-right --count")) return overrides.leftRight || "0\t0\n";
      if (cmd.includes("merge-base")) return overrides.mergeBase || "sha-000\n";
      if (cmd.includes("diff --numstat")) return overrides.diffNumstat || "";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return overrides.branchList || "  main\n";
      if (cmd.includes("@{upstream}")) throw new Error("no upstream");
      return "";
    });
  }

  it("updateBranchIndex tracks session branch references correctly", () => {
    // Create two sessions referencing the same diff_base_branch
    setupGitMocks();
    bridge.markWorktree("s1", "/repo", "/tmp/wt1", "jiayi");
    bridge.markWorktree("s2", "/repo", "/tmp/wt2", "jiayi");

    const s1 = bridge.getSession("s1")!;
    const s2 = bridge.getSession("s2")!;
    s1.state.git_branch = "wt-1";
    s1.state.diff_base_branch = "jiayi";
    s2.state.git_branch = "wt-2";
    s2.state.diff_base_branch = "jiayi";

    // Trigger index update via setDiffBaseBranch (which calls updateBranchIndex)
    bridge.setDiffBaseBranch("s1", "jiayi");
    bridge.setDiffBaseBranch("s2", "jiayi");

    // Access the internal index via the bridge's internal state
    // The index should have "jiayi" pointing to both sessions
    // We verify this indirectly by checking that closing one session
    // doesn't break the other's index entry
    bridge.closeSession("s1");
    // s2 should still be tracked — verify by setting a new base
    expect(bridge.setDiffBaseBranch("s2", "origin/main")).toBe(true);
  });

  it("HEAD SHA change triggers cross-session invalidation", async () => {
    // Session A: working on branch "jiayi" (worktree base for session B)
    // Session B: worktree with diff_base_branch = "jiayi"
    // When session A's HEAD moves, session B should get its diff stats refreshed.

    let headSha = "sha-old";
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("rev-parse HEAD")) return `${headSha}\n`;
      if (cmd.includes("--git-dir")) return "/repo/.git\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "2\t1\n";
      if (cmd.includes("merge-base")) return "sha-old\n";
      if (cmd.includes("diff --numstat")) return "5\t3\tfile.ts\n";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      if (cmd.includes("@{upstream}")) throw new Error("no upstream");
      return "";
    });

    // Set up session A (on branch "jiayi") with CLI socket
    bridge.markWorktree("sA", "/repo", "/tmp/wtA", "main");
    const sA = bridge.getSession("sA")!;
    (sA as any).backendSocket = { send: vi.fn() };
    sA.state.git_branch = "jiayi";
    sA.state.git_head_sha = "sha-old";

    // Set up session B (worktree, base = "jiayi") with CLI socket
    bridge.markWorktree("sB", "/repo", "/tmp/wtB", "jiayi");
    const sB = bridge.getSession("sB")!;
    (sB as any).backendSocket = { send: vi.fn() };
    sB.state.git_branch = "jiayi-wt-123";
    sB.state.diff_base_branch = "jiayi";
    sB.state.git_head_sha = "sha-wt-b";

    // Index both sessions by calling setDiffBaseBranch
    bridge.setDiffBaseBranch("sA", "main");
    bridge.setDiffBaseBranch("sB", "jiayi");

    // Wait for initial async work to settle
    await vi.waitFor(() => {
      expect(sA.state.diff_base_branch).toBe("main");
      expect(sB.state.diff_base_branch).toBe("jiayi");
    });

    const browserB = makeBrowserSocket("sB");
    bridge.handleBrowserOpen(browserB, "sB");
    browserB.send.mockClear();

    // Now simulate session A's HEAD moving (e.g., a new commit on "jiayi")
    headSha = "sha-new";
    sA.state.git_head_sha = "sha-old"; // Still old before refresh

    // Trigger refreshGitInfoPublic on session A — this will detect HEAD change
    // and cross-invalidate session B
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    // Wait for cross-session invalidation to propagate to session B
    await vi.waitFor(() => {
      // Session B should have been refreshed (diffStatsDirty was set and recompute triggered)
      const calls = (browserB.send as ReturnType<typeof vi.fn>).mock.calls;
      const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      // Should have received a session_update with refreshed git info
      const gitUpdates = messages.filter(
        (m: any) =>
          m.type === "session_update" && m.session && ("git_branch" in m.session || "total_lines_added" in m.session),
      );
      expect(gitUpdates.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("archived sessions are excluded from cross-session invalidation", async () => {
    // Set up a launcher mock where session B is archived
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => {
        if (id === "sB") return { archived: true };
        return { archived: false };
      }),
    } as any);

    setupGitMocks({ headSha: "sha-old" });

    bridge.markWorktree("sA", "/repo", "/tmp/wtA", "main");
    const sA = bridge.getSession("sA")!;
    (sA as any).backendSocket = { send: vi.fn() };
    sA.state.git_branch = "jiayi";
    sA.state.git_head_sha = "sha-old";

    bridge.markWorktree("sB", "/repo", "/tmp/wtB", "jiayi");
    const sB = bridge.getSession("sB")!;
    (sB as any).backendSocket = { send: vi.fn() };
    sB.state.git_branch = "jiayi-wt-123";
    sB.state.diff_base_branch = "jiayi";
    sB.state.git_head_sha = "sha-wt-b";

    // Index sessions — session B should be excluded since it's archived
    bridge.setDiffBaseBranch("sA", "main");
    bridge.setDiffBaseBranch("sB", "jiayi");

    const browserB = makeBrowserSocket("sB");
    bridge.handleBrowserOpen(browserB, "sB");

    // Wait for all async work from setDiffBaseBranch to settle, then clear
    await new Promise((r) => setTimeout(r, 200));
    browserB.send.mockClear();

    // Simulate HEAD change on session A
    setupGitMocks({ headSha: "sha-new" });
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    // Give a moment for any async propagation
    await new Promise((r) => setTimeout(r, 200));

    // Session B (archived) should NOT have received any cross-session updates
    const calls = (browserB.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    // Should have no git info updates from cross-session invalidation
    const crossSessionUpdates = messages.filter(
      (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
    );
    expect(crossSessionUpdates.length).toBe(0);
  });

  it("per-session throttle prevents rapid cascading", async () => {
    setupGitMocks();

    bridge.markWorktree("sA", "/repo", "/tmp/wtA", "main");
    const sA = bridge.getSession("sA")!;
    (sA as any).backendSocket = { send: vi.fn() };
    sA.state.git_branch = "jiayi";
    sA.state.git_head_sha = "sha-1";

    bridge.markWorktree("sB", "/repo", "/tmp/wtB", "jiayi");
    const sB = bridge.getSession("sB")!;
    (sB as any).backendSocket = { send: vi.fn() };
    sB.state.git_branch = "jiayi-wt-123";
    sB.state.diff_base_branch = "jiayi";

    // Index sessions
    bridge.setDiffBaseBranch("sA", "main");
    bridge.setDiffBaseBranch("sB", "jiayi");

    const browserB = makeBrowserSocket("sB");
    bridge.handleBrowserOpen(browserB, "sB");

    // First refresh: HEAD changes sha-1 → sha-2
    let sha = "sha-2";
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse HEAD")) return `${sha}\n`;
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return "/repo/.git\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "sha-1\n";
      if (cmd.includes("diff --numstat")) return "";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      if (cmd.includes("@{upstream}")) throw new Error("no upstream");
      return "";
    });

    sA.state.git_head_sha = "sha-1";
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    // Wait for first cross-invalidation to propagate
    await vi.waitFor(() => {
      expect(sA.state.git_head_sha).toBe("sha-2");
    });

    // Wait for all async propagation from first invalidation to settle
    await new Promise((r) => setTimeout(r, 200));
    browserB.send.mockClear();

    // Immediately trigger another HEAD change (sha-2 → sha-3)
    // This should be throttled for session B (within 30s window)
    sha = "sha-3";
    sA.state.git_head_sha = "sha-2"; // reset to trigger change detection
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    // Give async ops time to settle
    await new Promise((r) => setTimeout(r, 200));

    // Session B should NOT have received updates from the second invalidation
    // (throttled within the 30s window)
    const calls = (browserB.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const gitInfoUpdates = messages.filter(
      (m: any) => m.type === "session_update" && m.session && "git_branch" in m.session,
    );
    expect(gitInfoUpdates.length).toBe(0);
  });

  it("closeSession removes session from branch index", () => {
    setupGitMocks();
    bridge.markWorktree("s1", "/repo", "/tmp/wt1", "jiayi");
    const s1 = bridge.getSession("s1")!;
    s1.state.git_branch = "wt-1";
    s1.state.diff_base_branch = "jiayi";
    bridge.setDiffBaseBranch("s1", "jiayi");

    // Session should exist
    expect(bridge.getSession("s1")).toBeDefined();

    // Close session
    bridge.closeSession("s1");

    // Session should be gone
    expect(bridge.getSession("s1")).toBeUndefined();

    // Creating a new session with the same branch reference should work fine
    // (no stale index entries pointing to deleted session)
    bridge.markWorktree("s2", "/repo", "/tmp/wt2", "jiayi");
    expect(bridge.setDiffBaseBranch("s2", "jiayi")).toBe(true);
  });

  it("onSessionArchived removes session from branch index", () => {
    setupGitMocks();
    bridge.markWorktree("s1", "/repo", "/tmp/wt1", "jiayi");
    const s1 = bridge.getSession("s1")!;
    s1.state.git_branch = "wt-1";
    s1.state.diff_base_branch = "jiayi";
    bridge.setDiffBaseBranch("s1", "jiayi");

    // Archive the session
    bridge.onSessionArchived("s1");

    // Session still exists in the bridge (archived just removes from branch index)
    expect(bridge.getSession("s1")).toBeDefined();

    // Unarchiving should re-add to the index
    bridge.onSessionUnarchived("s1");
    expect(bridge.setDiffBaseBranch("s1", "origin/main")).toBe(true);
  });

  it("does not invalidate sessions depending on unrelated branches", async () => {
    // Session A on "feature-x", session B with diff_base_branch = "feature-z" (unrelated)
    // Changing A's HEAD should NOT trigger a refresh on B.

    let headSha = "sha-old";
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feature-x\n";
      if (cmd.includes("rev-parse HEAD")) return `${headSha}\n`;
      if (cmd.includes("--git-dir")) return "/repo/.git\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "sha-000\n";
      if (cmd.includes("diff --numstat")) return "";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      if (cmd.includes("@{upstream}")) throw new Error("no upstream");
      return "";
    });

    bridge.markWorktree("sA", "/repo", "/tmp/wtA", "main");
    const sA = bridge.getSession("sA")!;
    (sA as any).backendSocket = { send: vi.fn() };
    sA.state.git_branch = "feature-x";
    sA.state.git_head_sha = "sha-old";

    bridge.markWorktree("sB", "/repo", "/tmp/wtB", "feature-z");
    const sB = bridge.getSession("sB")!;
    (sB as any).backendSocket = { send: vi.fn() };
    sB.state.git_branch = "feature-y";
    sB.state.diff_base_branch = "feature-z"; // unrelated to sA's git_branch

    // Index both sessions via refreshGitInfoPublic (awaited, so async settles here)
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });
    await bridge.refreshGitInfoPublic("sB", { broadcastUpdate: true, force: true });

    const browserB = makeBrowserSocket("sB");
    bridge.handleBrowserOpen(browserB, "sB");
    browserB.send.mockClear();

    // Trigger HEAD change on session A (branch "feature-x")
    headSha = "sha-new";
    sA.state.git_head_sha = "sha-old";
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    await new Promise((r) => setTimeout(r, 200));

    // Session B should NOT have received any cross-session updates
    // because its diff_base_branch "feature-z" doesn't match sA's git_branch "feature-x"
    const calls = (browserB.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const crossSessionUpdates = messages.filter(
      (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
    );
    expect(crossSessionUpdates.length).toBe(0);
  });
});
