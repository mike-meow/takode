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

describe("Persistence", () => {
  it("restoreFromDisk: loads persisted Codex outbound turns from store", async () => {
    // Save a session directly to the store
    store.saveSync({
      id: "persisted-1",
      state: {
        session_id: "persisted-1",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/saved",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0.1,
        num_turns: 5,
        context_used_percent: 15,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/saved",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [{ type: "user_message", content: "Hello", timestamp: 1000 }],
      pendingMessages: [],
      pendingCodexTurns: [
        {
          adapterMsg: { type: "user_message", content: "Hello" },
          userMessageId: "restored-user-1",
          userContent: "Hello",
          historyIndex: -1,
          status: "queued",
          dispatchCount: 0,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          acknowledgedAt: null,
          turnTarget: null,
          lastError: null,
          turnId: "turn-restored-1",
          disconnectedAt: 1700000000000,
          resumeConfirmedAt: null,
        },
      ],
      pendingPermissions: [],
      processedClientMessageIds: ["restored-client-1"],
    } as any);

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("persisted-1");
    expect(session).toBeDefined();
    expect(session!.state.model).toBe("claude-sonnet-4-5-20250929");
    expect(session!.state.cwd).toBe("/saved");
    expect(session!.state.total_cost_usd).toBe(0.1);
    expect(session!.messageHistory).toHaveLength(1);
    expect(session!.backendSocket).toBeNull();
    expect(session!.browserSockets.size).toBe(0);
    expect(getPendingCodexTurn(session!)).toMatchObject({
      adapterMsg: { type: "user_message", content: "Hello" },
      userMessageId: "restored-user-1",
      userContent: "Hello",
      status: "queued",
      dispatchCount: 0,
      turnId: "turn-restored-1",
      disconnectedAt: 1700000000000,
      resumeConfirmedAt: null,
      turnTarget: null,
      lastError: null,
    });
    expect(session!.processedClientMessageIdSet.has("restored-client-1")).toBe(true);
  });

  it("restoreFromDisk: loads persisted pending Codex rollback state", async () => {
    store.saveSync({
      id: "persisted-rollback",
      state: {
        session_id: "persisted-rollback",
        backend_type: "codex",
        model: "gpt-5.4",
        cwd: "/saved",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/saved",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingCodexTurns: [],
      pendingCodexInputs: [],
      pendingCodexRollback: { numTurns: 2, truncateIdx: 0, clearCodexState: true },
      pendingCodexRollbackError: "stale error",
      pendingPermissions: [],
    } as any);

    await store.flushAll();
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("persisted-rollback");
    expect(session).toBeDefined();
    expect(session!.pendingCodexRollback).toEqual({ numTurns: 2, truncateIdx: 0, clearCodexState: true });
    expect(session!.pendingCodexRollbackError).toBe("stale error");
  });

  it("restoreFromDisk: loads persisted Codex fresh-turn guard state", async () => {
    store.saveSync({
      id: "persisted-codex-fresh-turn-guard",
      state: {
        session_id: "persisted-codex-fresh-turn-guard",
        backend_type: "codex",
        model: "gpt-5.4",
        cwd: "/saved",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/saved",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingCodexTurns: [],
      pendingCodexInputs: [],
      pendingPermissions: [],
      codexFreshTurnRequiredUntilTurnId: "turn-plan-restored",
    } as any);

    await store.flushAll();
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("persisted-codex-fresh-turn-guard");
    expect(session).toBeDefined();
    expect(session!.codexFreshTurnRequiredUntilTurnId).toBe("turn-plan-restored");
  });

  it("restoreFromDisk: does not overwrite live sessions", async () => {
    // Create a live session first
    const liveSession = bridge.getOrCreateSession("live-1");
    liveSession.state.model = "live-model";

    // Save a different version to disk
    store.saveSync({
      id: "live-1",
      state: {
        session_id: "live-1",
        model: "disk-model",
        cwd: "/disk",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: [],
    });

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(0);

    // Should still have the live model
    const session = bridge.getSession("live-1")!;
    expect(session.state.model).toBe("live-model");
  });

  it("restoreFromDisk: finalizes stale disconnected bash tools recovered from history", async () => {
    const startedAt = Date.now() - 180_000;
    store.saveSync({
      id: "persisted-codex-tool",
      state: {
        session_id: "persisted-codex-tool",
        backend_type: "codex",
        model: "gpt-5-codex",
        cwd: "/saved",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 1,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/saved",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [
        {
          type: "assistant",
          message: {
            id: "assistant-persisted-tool",
            type: "message",
            role: "assistant",
            model: "gpt-5-codex",
            content: [{ type: "tool_use", id: "cmd_restore", name: "Bash", input: { command: "git status --short" } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: startedAt,
          tool_start_times: { cmd_restore: startedAt },
        } as any,
      ],
      pendingMessages: [],
      pendingPermissions: [],
      toolResults: [],
    });

    await store.flushAll();
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("persisted-codex-tool")!;
    expect(session.toolStartTimes.has("cmd_restore")).toBe(false);
    const previewMsg = session.messageHistory.findLast((m) => m.type === "tool_result_preview") as any;
    expect(previewMsg).toBeDefined();
    expect(previewMsg.previews[0].tool_use_id).toBe("cmd_restore");
    expect(previewMsg.previews[0].is_error).toBe(true);
    expect(previewMsg.previews[0].content).toContain("backend was disconnected");
  });

  it("restoreFromDisk: preserves an explicit default diff base selection across worktree refresh", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("rev-parse HEAD")) return "head-worktree\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("rev-parse --verify refs/heads/jiayi")) return "jiayi-head\n";
      if (cmd.includes("merge-base")) return "merge-base-sha\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("diff --numstat")) return "3\t1\tweb/src/app.ts\n";
      return "";
    });

    store.saveSync({
      id: "persisted-diff-base",
      state: {
        session_id: "persisted-diff-base",
        backend_type: "claude",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/wt",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "jiayi-wt-1234",
        git_default_branch: "jiayi",
        diff_base_branch: "",
        diff_base_branch_explicit: true,
        diff_base_start_sha: "",
        is_worktree: true,
        is_containerized: false,
        repo_root: "/home/user/companion",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: [],
    } as any);

    await store.flushAll();
    await bridge.restoreFromDisk();

    const restoredState = await bridge.refreshWorktreeGitStateForSnapshot("persisted-diff-base");
    expect(restoredState).toBeTruthy();
    expect(restoredState!.git_default_branch).toBe("jiayi");
    expect(restoredState!.diff_base_branch).toBe("");
    expect(restoredState!.diff_base_branch_explicit).toBe(true);
  });

  it("persistSession: called after state changes (via store.save)", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const saveSpy = vi.spyOn(store, "save");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // system.init should trigger persist
    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(saveSpy).toHaveBeenCalled();

    const lastCall = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][0];
    expect(lastCall.id).toBe("s1");
    expect(lastCall.state.model).toBe("claude-sonnet-4-5-20250929");

    saveSpy.mockClear();

    // assistant message should trigger persist
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Test" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "uuid-p1",
        session_id: "s1",
      }),
    );
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // result message should trigger persist
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "uuid-p2",
        session_id: "s1",
      }),
    );
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // control_request (can_use_tool) should trigger persist
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-persist",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo test" },
          tool_use_id: "tu-persist",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // user message from browser should trigger persist
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    bridge.handleBrowserMessage(
      browserWs,
      JSON.stringify({
        type: "user_message",
        content: "test persist",
      }),
    );
    expect(saveSpy).toHaveBeenCalled();
  });

  it("persistSession: includes pending Codex turn recovery after user dispatch", async () => {
    const saveSpy = vi.spyOn(store, "save");
    const sid = "persist-codex-recovery";
    const adapter = makeCodexAdapterMock();
    adapter.sendBrowserMessage.mockReturnValue(true);
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "persist this retry context",
      }),
    );

    // This guards the restart path: a user turn that disconnects immediately
    // after dispatch still needs its recovery state on disk.
    const persistedWithRecovery = saveSpy.mock.calls
      .map(([arg]) => arg)
      .find((call) => call.id === sid && Array.isArray(call.pendingCodexTurns) && call.pendingCodexTurns.length > 0);

    expectCodexStartPendingTurnLike(persistedWithRecovery?.pendingCodexTurns?.[0], {
      firstContent: "persist this retry context",
      userContent: "persist this retry context",
      status: "dispatched",
      dispatchCount: 1,
      turnId: null,
      turnTarget: null,
    });
    expect(persistedWithRecovery?.pendingCodexTurns?.[0]?.lastError).toBeNull();
  });

  it("restoreFromDisk: preserves unexpected raw Codex pendingMessages without auto-migrating them", async () => {
    const sid = "restore-codex-legacy-pending-message";
    store.saveSync({
      id: sid,
      state: {
        session_id: sid,
        backend_type: "codex",
        model: "gpt-5.3-codex",
        cwd: "/saved",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/saved",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [
        JSON.stringify({ type: "user_message", content: "legacy raw codex turn", client_msg_id: "legacy-raw-1" }),
        JSON.stringify({ type: "set_model", model: "gpt-5.4" }),
      ],
      pendingCodexTurns: [],
      pendingPermissions: [],
    });

    await store.flushAll();
    await bridge.restoreFromDisk();

    const session = bridge.getSession(sid)!;
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.pendingMessages).toHaveLength(2);
    expect(JSON.parse(session.pendingMessages[0])).toMatchObject({
      type: "user_message",
      content: "legacy raw codex turn",
      client_msg_id: "legacy-raw-1",
    });
    expect(JSON.parse(session.pendingMessages[1])).toMatchObject({ type: "set_model", model: "gpt-5.4" });
  });
});
