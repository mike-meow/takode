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

  it("control_request (can_use_tool): does not set attention for herded worker sessions", async () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "orch-1" })),
    } as any);

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-herded-attention",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls -la" },
        description: "List files",
        tool_use_id: "tu-herded-attention",
      },
    });

    bridge.handleCLIMessage(cli, msg);
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(1);
    expect(session.attentionReason).toBeNull();
  });

  it("control_request (can_use_tool): Tier 1 mode auto-approves Write in acceptEdits and broadcasts permission_approved", async () => {
    const session = bridge.getSession("s1")!;
    session.state.permissionMode = "acceptEdits";
    browser.send.mockClear();

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-mode-auto",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "/tmp/test.txt", content: "hello" },
        description: "Write a file",
        tool_use_id: "tu-mode-auto",
      },
    });

    bridge.handleCLIMessage(cli, msg);
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest

    // Should NOT be added to pending (auto-approved)
    expect(session.pendingPermissions.has("req-mode-auto")).toBe(false);

    // CLI should receive control_response with allow
    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const controlResp = cliCalls.find(
      (c: any) => c.type === "control_response" && c.response?.request_id === "req-mode-auto",
    );
    expect(controlResp).toBeDefined();
    expect(controlResp.response.response.behavior).toBe("allow");

    // Browser should receive permission_approved (not just permission_request)
    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const approvedMsg = browserCalls.find(
      (c: any) => c.type === "permission_approved" && c.request_id === "req-mode-auto",
    );
    expect(approvedMsg).toBeDefined();
    expect(approvedMsg.tool_name).toBe("Write");
    expect(approvedMsg.tool_use_id).toBe("tu-mode-auto");

    // Should be in message history
    const historyEntry = session.messageHistory.find(
      (m: any) => m.type === "permission_approved" && m.request_id === "req-mode-auto",
    );
    expect(historyEntry).toBeDefined();
  });

  it("control_request (can_use_tool): Tier 2 settings rule auto-approves Bash mkdir for WS sessions", async () => {
    const session = bridge.getSession("s1")!;
    // Plan mode: Tier 1 won't fire for Bash, but Tier 2 should match settings rule
    session.state.permissionMode = "plan";

    // Mock settings rule matcher to approve mkdir commands
    mockShouldSettingsRuleApprove.mockResolvedValueOnce("Bash(mkdir *)");

    browser.send.mockClear();
    cli.send.mockClear();

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-settings-rule",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "mkdir -p /tmp/test-dir" },
        description: "Create directory",
        tool_use_id: "tu-settings-rule",
      },
    });

    bridge.handleCLIMessage(cli, msg);
    // Tier 2 is async (settings rule check returns a promise), so flush promises
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Should NOT be added to pending (auto-approved via settings rule)
    expect(session.pendingPermissions.has("req-settings-rule")).toBe(false);

    // CLI should receive control_response with allow
    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const controlResp = cliCalls.find(
      (c: any) => c.type === "control_response" && c.response?.request_id === "req-settings-rule",
    );
    expect(controlResp).toBeDefined();
    expect(controlResp.response.response.behavior).toBe("allow");

    // Browser should receive permission_approved
    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const approvedMsg = browserCalls.find(
      (c: any) => c.type === "permission_approved" && c.request_id === "req-settings-rule",
    );
    expect(approvedMsg).toBeDefined();
    expect(approvedMsg.tool_name).toBe("Bash");
  });

  it("control_request (can_use_tool): hard-denies long sleep Bash commands and injects reminder", async () => {
    const session = bridge.getSession("s1")!;
    browser.send.mockClear();
    cli.send.mockClear();

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-long-sleep",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "sleep 61 && echo late" },
        description: "Wait before checking again",
        tool_use_id: "tu-long-sleep",
      },
    });

    bridge.handleCLIMessage(cli, msg);
    await new Promise((r) => setTimeout(r, 0));

    expect(session.pendingPermissions.has("req-long-sleep")).toBe(false);

    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const controlResp = cliCalls.find(
      (c: any) => c.type === "control_response" && c.response?.request_id === "req-long-sleep",
    );
    expect(controlResp).toBeDefined();
    expect(controlResp.response.response.behavior).toBe("deny");

    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      browserCalls.find((c: any) => c.type === "permission_denied" && c.request_id === "req-long-sleep"),
    ).toBeDefined();
    expect(
      browserCalls.find(
        (c: any) =>
          c.type === "user_message" &&
          typeof c.content === "string" &&
          c.content.includes("Use `takode timer` instead"),
      ),
    ).toBeDefined();
  });

  it("control_request (can_use_tool): hard-denies backgrounded long sleep Bash commands", async () => {
    const session = bridge.getSession("s1")!;
    browser.send.mockClear();
    cli.send.mockClear();

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-background-sleep",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "sleep 61 & echo hi" },
        description: "Background wait",
        tool_use_id: "tu-background-sleep",
      },
    });

    bridge.handleCLIMessage(cli, msg);
    await new Promise((r) => setTimeout(r, 0));

    expect(session.pendingPermissions.has("req-background-sleep")).toBe(false);

    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const controlResp = cliCalls.find(
      (c: any) => c.type === "control_response" && c.response?.request_id === "req-background-sleep",
    );
    expect(controlResp).toBeDefined();
    expect(controlResp.response.response.behavior).toBe("deny");

    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      browserCalls.find((c: any) => c.type === "permission_denied" && c.request_id === "req-background-sleep"),
    ).toBeDefined();
    expect(
      browserCalls.find(
        (c: any) =>
          c.type === "user_message" &&
          typeof c.content === "string" &&
          c.content.includes("Use `takode timer` instead"),
      ),
    ).toBeDefined();
  });

  it("interrupts Claude WS long sleep tool_use observed after bypassed permissions and injects reminder", async () => {
    const session = bridge.getSession("s1")!;
    browser.send.mockClear();
    cli.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "assistant-long-sleep",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "tool_use", id: "cmd-sleep", name: "Bash", input: { command: "sleep 600" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(cliCalls.find((c: any) => c.type === "control_request" && c.request?.subtype === "interrupt")).toBeDefined();

    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      browserCalls.find((c: any) => c.type === "permission_denied" && c.tool_use_id === "cmd-sleep"),
    ).toBeDefined();
    expect(
      browserCalls.find(
        (c: any) =>
          c.type === "user_message" &&
          typeof c.content === "string" &&
          c.content.includes("Use `takode timer` instead"),
      ),
    ).toBeDefined();
    expect(
      session.messageHistory.some(
        (entry: any) => entry.type === "permission_denied" && entry.tool_use_id === "cmd-sleep",
      ),
    ).toBe(true);
  });

  it("interrupts Claude WS backgrounded long sleep tool_use observed after bypassed permissions", async () => {
    const session = bridge.getSession("s1")!;
    browser.send.mockClear();
    cli.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "assistant-background-sleep",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "tool_use", id: "cmd-bg-sleep", name: "Bash", input: { command: "sleep 61 & echo hi" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(cliCalls.find((c: any) => c.type === "control_request" && c.request?.subtype === "interrupt")).toBeDefined();

    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      browserCalls.find((c: any) => c.type === "permission_denied" && c.tool_use_id === "cmd-bg-sleep"),
    ).toBeDefined();
    expect(
      browserCalls.find(
        (c: any) =>
          c.type === "user_message" &&
          typeof c.content === "string" &&
          c.content.includes("Use `takode timer` instead"),
      ),
    ).toBeDefined();
  });

  it("interrupts Claude WS wrapper-option long sleep tool_use observed after bypassed permissions", async () => {
    browser.send.mockClear();
    cli.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "assistant-wrapper-sleep",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [
            { type: "tool_use", id: "cmd-wrapper-sleep", name: "Bash", input: { command: "sudo -u root sleep 61" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(cliCalls.find((c: any) => c.type === "control_request" && c.request?.subtype === "interrupt")).toBeDefined();

    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      browserCalls.find((c: any) => c.type === "permission_denied" && c.tool_use_id === "cmd-wrapper-sleep"),
    ).toBeDefined();
  });

  it("does not interrupt Claude WS short sleep tool_use with file-descriptor redirection", async () => {
    browser.send.mockClear();
    cli.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          id: "assistant-short-sleep-redirect",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [
            { type: "tool_use", id: "cmd-short-sleep-redirect", name: "Bash", input: { command: "sleep 60 2>&1" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      cliCalls.find((c: any) => c.type === "control_request" && c.request?.subtype === "interrupt"),
    ).toBeUndefined();

    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      browserCalls.find((c: any) => c.type === "permission_denied" && c.tool_use_id === "cmd-short-sleep-redirect"),
    ).toBeUndefined();
  });

  it("tool_progress: broadcasts", () => {
    const msg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-10",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3.5,
      output_delta: "hello\n",
      uuid: "uuid-7",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsg = calls.find((c: any) => c.type === "tool_progress");
    expect(progressMsg).toBeDefined();
    expect(progressMsg.tool_use_id).toBe("tu-10");
    expect(progressMsg.tool_name).toBe("Bash");
    expect(progressMsg.elapsed_time_seconds).toBe(3.5);
    expect(progressMsg.output_delta).toBe("hello\n");
  });

  it("tool_use_summary: broadcasts", () => {
    const msg = JSON.stringify({
      type: "tool_use_summary",
      summary: "Ran bash command successfully",
      preceding_tool_use_ids: ["tu-10", "tu-11"],
      uuid: "uuid-8",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const summaryMsg = calls.find((c: any) => c.type === "tool_use_summary");
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg.summary).toBe("Ran bash command successfully");
    expect(summaryMsg.tool_use_ids).toEqual(["tu-10", "tu-11"]);
  });

  it("keep_alive: silently consumed, no broadcast", () => {
    const msg = JSON.stringify({ type: "keep_alive" });

    bridge.handleCLIMessage(cli, msg);

    expect(browser.send).not.toHaveBeenCalled();
  });

  it("keep_alive does not update lastActivityAt but real messages do", () => {
    // Idle Claude sessions send periodic keep_alive pings. These must NOT
    // refresh lastActivityAt, otherwise the idle manager treats them as
    // recently active and kills sessions with real user activity instead.
    const mockLauncher = { touchActivity: vi.fn() } as any;
    bridge.setLauncher(mockLauncher);

    bridge.handleCLIMessage(cli, JSON.stringify({ type: "keep_alive" }));
    expect(mockLauncher.touchActivity).not.toHaveBeenCalled();

    // A real message (e.g. tool_progress) should update activity
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "tool_progress",
        tool_use_id: "tu-1",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 1,
        uuid: "uuid-1",
        session_id: "s1",
      }),
    );
    expect(mockLauncher.touchActivity).toHaveBeenCalledWith("s1");
  });

  it("multi-line NDJSON: processes both lines", () => {
    const line1 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-a",
      tool_name: "Read",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-a",
      session_id: "s1",
    });
    const line2 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-b",
      tool_name: "Edit",
      parent_tool_use_id: null,
      elapsed_time_seconds: 2,
      uuid: "uuid-b",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, line1 + "\n" + line2);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsgs = calls.filter((c: any) => c.type === "tool_progress");
    expect(progressMsgs).toHaveLength(2);
    expect(progressMsgs[0].tool_use_id).toBe("tu-a");
    expect(progressMsgs[1].tool_use_id).toBe("tu-b");
  });

  it("malformed JSON: skips gracefully without crashing", () => {
    const validLine = JSON.stringify({ type: "keep_alive" });
    const raw = "not-valid-json\n" + validLine;

    // Should not throw
    expect(() => bridge.handleCLIMessage(cli, raw)).not.toThrow();
    // keep_alive is silently consumed, so no broadcast
    expect(browser.send).not.toHaveBeenCalled();
  });
});
