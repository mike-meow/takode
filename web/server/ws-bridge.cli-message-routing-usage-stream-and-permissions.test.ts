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

describe("CLI message routing", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
  });

  it("result: refreshes git branch and broadcasts session_update when branch changes", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/new-branch\n";
      if (cmd.includes("rev-parse HEAD")) return "head-new-branch\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/test\n";
      if (cmd.includes("--left-right --count")) return "0\t1\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "";
      // gitUtils.resolveDefaultBranch fallback commands
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const session = bridge.getSession("s1")!;
    session.state.cwd = "/test";
    session.state.git_branch = "main";

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done!",
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-refresh-git",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    // refreshGitInfo is async (fire-and-forget) — wait for session_update broadcast
    await vi.waitFor(() => {
      expect(bridge.getSession("s1")!.state.git_branch).toBe("feat/new-branch");
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const updateMsg = calls.find((c: any) => c.type === "session_update" && c.session?.git_branch);
    expect(updateMsg).toBeDefined();
    expect(updateMsg.session.git_branch).toBe("feat/new-branch");
    expect(updateMsg.session.git_ahead).toBe(1);
  });

  it("result: computes context_used_percent from per-turn usage (not cumulative modelUsage)", () => {
    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 12, cache_creation_input_tokens: 19705, cache_read_input_tokens: 20959 },
      modelUsage: {
        "claude-sonnet-4-5-20250929": {
          // Cumulative totals can exceed the context window and should not be used
          // to compute per-turn context usage.
          inputTokens: 14,
          outputTokens: 1255,
          cacheReadInputTokens: 278932,
          cacheCreationInputTokens: 38934,
          contextWindow: 200000,
          maxOutputTokens: 16384,
          costUSD: 0.02,
        },
      },
      uuid: "uuid-5",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const state = bridge.getSession("s1")!.state;
    // (3 + 12 + 19705 + 20959) / 200000 * 100 = 20
    expect(state.context_used_percent).toBe(20);
  });

  it("result: stores and broadcasts Claude token details from modelUsage", () => {
    const session = bridge.getSession("s1")!;
    session.state.model = "claude-sonnet-4-5-20250929";

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {
        "claude-sonnet-4-5-20250929": {
          inputTokens: 254,
          outputTokens: 77_708,
          cacheReadInputTokens: 21_737_912,
          cacheCreationInputTokens: 263_780,
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
          costUSD: 14.46,
        },
      },
      uuid: "uuid-5-token-details",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    expect(session.state.claude_token_details).toEqual({
      inputTokens: 254,
      outputTokens: 77_708,
      cachedInputTokens: 22_001_692,
      modelContextWindow: 200_000,
    });
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const tokenUpdate = calls.find((c: any) => c.type === "session_update" && c.session?.claude_token_details);
    expect(tokenUpdate?.session?.claude_token_details).toEqual({
      inputTokens: 254,
      outputTokens: 77_708,
      cachedInputTokens: 22_001_692,
      modelContextWindow: 200_000,
    });
  });

  it("result: uses 1m context window for [1m] model variants even if modelUsage reports 200k", () => {
    const session = bridge.getSession("s1")!;
    session.state.model = "claude-opus-4-6[1m]";

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 400000,
        output_tokens: 10000,
        cache_creation_input_tokens: 15000,
        cache_read_input_tokens: 25000,
      },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 10,
          outputTokens: 50,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 200,
          contextWindow: 200000,
          maxOutputTokens: 32000,
          costUSD: 0.02,
        },
      },
      uuid: "uuid-5-1m",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const state = bridge.getSession("s1")!.state;
    // input_tokens (400000) already includes cached tokens (OpenAI/Copilot semantics).
    // 400000 / 1000000 * 100 = 40
    // output_tokens (10000) excluded — they are generated, not context occupants
    expect(state.context_used_percent).toBe(40);
  });

  it("result: keeps previous context_used_percent when usage payload is empty", () => {
    const session = bridge.getSession("s1")!;
    session.state.context_used_percent = 61;
    session.state.model = "claude-opus-4-6";

    const msg = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 10,
          outputTokens: 50,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 200,
          contextWindow: 200000,
          maxOutputTokens: 32000,
          costUSD: 0.02,
        },
      },
      uuid: "uuid-5-empty-usage",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    expect(bridge.getSession("s1")!.state.context_used_percent).toBe(61);
  });

  it("result: skips cumulative usage that exceeds context window (WS sessions)", () => {
    // WS (NDJSON) sessions send cumulative usage on result messages that can
    // far exceed the context window. When assistant messages have zero usage
    // (typical for WS sessions), the code must not fall back to this cumulative
    // data or the context percentage will be wildly inflated.
    const session = bridge.getSession("s1")!;
    session.state.model = "claude-opus-4-6[1m]";
    session.state.context_used_percent = 34;

    // Add a top-level assistant message with zero usage (typical WS behavior)
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "msg-ws-cumulative",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "test" }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    } as any);

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 70000,
      duration_api_ms: 66000,
      num_turns: 6,
      total_cost_usd: 9.64,
      stop_reason: "end_turn",
      // Cumulative usage across 6 turns — 1.9M input tokens far exceeds the 1M context window
      usage: {
        input_tokens: 1905323,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 189924,
        output_tokens: 800,
      },
      modelUsage: {
        "claude-opus-4-6[1m]": {
          inputTokens: 1905323,
          outputTokens: 800,
          cacheReadInputTokens: 189924,
          cacheCreationInputTokens: 0,
          contextWindow: 1000000,
          maxOutputTokens: 64000,
          costUSD: 9.64,
        },
      },
      uuid: "uuid-ws-cumulative",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    // context_used_percent should be preserved, not inflated to 100%+
    expect(bridge.getSession("s1")!.state.context_used_percent).toBe(34);
  });

  it("stream_event: broadcasts without storing", () => {
    const msg = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      uuid: "uuid-6",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const streamEvent = calls.find((c: any) => c.type === "stream_event");
    expect(streamEvent).toBeDefined();
    expect(streamEvent.event.delta.text).toBe("hi");
    expect(streamEvent.parent_tool_use_id).toBeNull();
  });

  it("stream_event: does not log zero-browser warnings when no browser is connected", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    bridge.handleBrowserClose(browser);

    const msg = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      uuid: "uuid-6b",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const zeroBrowserWarning = logSpy.mock.calls.find(([line]) =>
      String(line).includes("Broadcasting stream_event to 0 browsers"),
    );
    expect(zeroBrowserWarning).toBeUndefined();
    logSpy.mockRestore();
  });

  it("control_request (can_use_tool): adds to pending and broadcasts", async () => {
    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-42",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls -la" },
        description: "List files",
        tool_use_id: "tu-42",
        agent_id: "agent-1",
        permission_suggestions: [
          { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
        ],
      },
    });

    bridge.handleCLIMessage(cli, msg);
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(1);
    const perm = session.pendingPermissions.get("req-42")!;
    expect(perm.tool_name).toBe("Bash");
    expect(perm.input).toEqual({ command: "ls -la" });
    expect(perm.description).toBe("List files");
    expect(perm.tool_use_id).toBe("tu-42");
    expect(perm.agent_id).toBe("agent-1");
    expect(perm.timestamp).toBeGreaterThan(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permBroadcast = calls.find((c: any) => c.type === "permission_request");
    expect(permBroadcast).toBeDefined();
    expect(permBroadcast.request.request_id).toBe("req-42");
    expect(permBroadcast.request.tool_name).toBe("Bash");
  });
});
