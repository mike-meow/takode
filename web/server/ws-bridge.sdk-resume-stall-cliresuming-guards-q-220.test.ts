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

describe("SDK resume stall: cliResuming guards (q-220)", () => {
  // When an SDK session is resumed after server restart, the CLI replays
  // historical messages including stale status_change:"running" events.
  // Without cliResuming guards, these get broadcast to browsers, overriding
  // the correct "idle" state from state_snapshot and leaving the session
  // stuck showing "running" indefinitely.

  /** Set up a mock launcher with cliSessionId (simulates post-restart resume). */
  function setResumedSdkLauncher(sessionId: string) {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({
        sessionId,
        state: "connected",
        backendType: "claude-sdk",
        cliSessionId: "cli-session-for-resume",
      })),
      setCLISessionId: vi.fn(),
    } as any);
  }

  /** Helper: create a session with existing history (simulates resumed session). */
  function createResumedSdkSession(sessionId: string) {
    const session = bridge.getOrCreateSession(sessionId, "claude-sdk");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);
    setResumedSdkLauncher(sessionId);
    return session;
  }

  it("sets cliResuming=true when attaching SDK adapter to resumed session", () => {
    // A resumed SDK session has existing messageHistory and the launcher has
    // a cliSessionId. The adapter attach must set cliResuming to defer
    // message processing during replay.
    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(true);
  });

  it("does NOT set cliResuming for a fresh SDK session (no history, no cliSessionId)", () => {
    // Brand-new sessions have no replay — cliResuming should stay false.
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(false);
  });

  it("does NOT set cliResuming when adapter is replaced mid-conversation (no cliSessionId)", () => {
    // Adapter replacement during normal operation (e.g., adapter crash + relaunch)
    // should NOT trigger cliResuming, even if messageHistory has entries.
    // Without the cliSessionId check, this would false-positive.
    const session = bridge.getOrCreateSession("s1", "claude-sdk");
    session.messageHistory.push({ role: "assistant", content: "msg" } as any);
    // No launcher set — simulates adapter replacement without server restart
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    expect(session.cliResuming).toBe(false);
  });

  it("suppresses status_change broadcasts during SDK resume replay", () => {
    // Stale status_change:"running" from completed historical turns must not
    // reach browsers — they would override the correct "idle" snapshot.
    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(true);

    // Simulate replayed status_change from a completed turn
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });

    // The browser should NOT receive a status_change broadcast
    const statusChanges = browser.send.mock.calls.filter((call: any[]) => {
      try {
        const msg = JSON.parse(call[0]);
        return msg.type === "status_change";
      } catch {
        return false;
      }
    });
    expect(statusChanges).toHaveLength(0);
  });

  it("still updates is_compacting state during SDK resume replay", () => {
    // Compaction state tracking must still work during replay for correctness
    // — only the browser broadcast is suppressed.
    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(true);

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.state.is_compacting).toBe(true);
  });

  it("drops id-less assistant replay during SDK resume when revert suppression is armed", () => {
    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const session = bridge.getSession("s1")!;
    session.dropReplayHistoryAfterRevert = true;
    expect(session.cliResuming).toBe(true);

    adapter.emitBrowserMessage({
      type: "assistant",
      uuid: "sdk-replayed-no-id",
      parent_tool_use_id: null,
      message: {
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "stale replayed assistant" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });

    expect(
      session.messageHistory.find((entry: any) => entry.type === "assistant" && entry.uuid === "sdk-replayed-no-id"),
    ).toBeUndefined();
    const assistantCalls = browser.send.mock.calls.filter(([arg]: [string]) => {
      const msg = JSON.parse(arg);
      return msg.type === "assistant" && msg.uuid === "sdk-replayed-no-id";
    });
    expect(assistantCalls).toHaveLength(0);
  });

  it("clears cliResuming after 2s debounce and flushes deferred messages", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(true);

    // Queue a pending message (e.g., user message sent during reconnect)
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "hello" }));

    // Simulate replayed messages arriving from the SDK stream
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    // cliResuming should still be true before the debounce fires
    expect(session.cliResuming).toBe(true);
    expect(session.pendingMessages).toHaveLength(1);

    // Advance past the 2s debounce
    vi.advanceTimersByTime(2100);

    expect(session.cliResuming).toBe(false);
    // Deferred pending message should have been flushed via adapter.sendBrowserMessage
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "hello" }),
    );
    expect(session.pendingMessages).toHaveLength(0);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("preserves compacting state across SDK replay when /compact is queued for post-replay flush", () => {
    // Regression for q-456: SDK replay cleanup must not clear compacting when
    // the queued /compact has not been delivered yet.
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "/compact" }));
    session.state.is_compacting = true;

    browser.send.mockClear();
    adapter.sendBrowserMessage.mockClear();

    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    vi.advanceTimersByTime(2100);

    expect(session.cliResuming).toBe(false);
    expect(session.state.is_compacting).toBe(true);
    expect(session.pendingMessages).toHaveLength(0);
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "/compact" }),
    );
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "compacting" }));

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("preserves the real SDK post-compaction marker flow after replay when /compact was pending", () => {
    // Regression for q-456: keeping authoritative compacting state through
    // replay must not suppress the real SDK compact-start transition, because
    // non-leader SDK sessions rely on that transition to synthesize the chat
    // marker and capture the compact summary.
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "/compact" }));
    session.forceCompactPending = true;
    session.state.is_compacting = true;

    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });
    vi.advanceTimersByTime(2100);

    browser.send.mockClear();

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({
      type: "user",
      message: { role: "user", content: "Compaction summary after replay" },
      parent_tool_use_id: null,
      session_id: "cli-session-for-resume",
    } as any);
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).summary).toBe("Compaction summary after replay");
    expect(session.forceCompactPending).toBe(false);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.filter((m: any) => m.type === "compact_boundary")).toHaveLength(1);
    expect(calls).toContainEqual(
      expect.objectContaining({ type: "compact_summary", summary: "Compaction summary after replay" }),
    );

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("debounce resets on each incoming SDK message", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;

    // First replayed message
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    vi.advanceTimersByTime(1500);
    // Still resuming — debounce not yet elapsed
    expect(session.cliResuming).toBe(true);

    // Second replayed message resets the debounce
    adapter.emitBrowserMessage({ type: "status_change", status: null });
    vi.advanceTimersByTime(1500);
    // Still resuming — only 1.5s since last message
    expect(session.cliResuming).toBe(true);

    // Full 2s after the last message
    vi.advanceTimersByTime(600);
    expect(session.cliResuming).toBe(false);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("defers pendingMessages flush when SDK adapter attaches during resume", () => {
    // When cliResuming is true, pendingMessages should NOT be flushed
    // immediately on adapter attach — they must wait for replay to finish.
    createResumedSdkSession("s1");
    const session = bridge.getSession("s1")!;
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "queued" }));

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    // Message should NOT have been flushed yet
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    expect(session.pendingMessages).toHaveLength(1);
  });

  it("flushes pendingMessages immediately for fresh SDK sessions (no resume)", () => {
    // Non-resumed sessions should flush immediately, preserving existing behavior.
    const session = bridge.getOrCreateSession("s1", "claude-sdk");
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "queued" }));

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    // Message should be flushed immediately
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "queued" }),
    );
    expect(session.pendingMessages).toHaveLength(0);
  });

  it("broadcasts status_change after cliResuming clears", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;

    // Replayed messages during resume — suppressed
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    // Clear cliResuming via debounce
    vi.advanceTimersByTime(2100);
    expect(session.cliResuming).toBe(false);
    browser.send.mockClear();

    // Now a live status_change should be broadcast normally
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    const statusChanges = browser.send.mock.calls.filter((call: any[]) => {
      try {
        const msg = JSON.parse(call[0]);
        return msg.type === "status_change";
      } catch {
        return false;
      }
    });
    expect(statusChanges.length).toBeGreaterThan(0);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("resets is_compacting to false when debounce fires after replay", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;

    // Replay a compacting status — the flag gets set during replay
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.state.is_compacting).toBe(true);

    // After the debounce fires, stale compaction state must be reset.
    // A replayed "compacting" from a completed historical turn shouldn't
    // leave the session permanently showing a compaction indicator.
    vi.advanceTimersByTime(2100);
    expect(session.cliResuming).toBe(false);
    expect(session.state.is_compacting).toBe(false);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("defers herd event flush during resume and fires after debounce", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const session = bridge.getSession("s1")!;

    // Set up a mock herd event dispatcher
    const mockDispatcher = { onOrchestratorTurnEnd: vi.fn() } as any;
    bridge.setHerdEventDispatcher(mockDispatcher);

    // Override the launcher to also report isOrchestrator
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({
        sessionId: "s1",
        state: "connected",
        backendType: "claude-sdk",
        cliSessionId: "cli-session-for-resume",
        isOrchestrator: true,
      })),
      setCLISessionId: vi.fn(),
    } as any);

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    // Herd events should NOT have been flushed on attach (deferred)
    expect(mockDispatcher.onOrchestratorTurnEnd).not.toHaveBeenCalled();

    // Trigger the debounce via a replayed message
    adapter.emitBrowserMessage({ type: "status_change", status: null });
    vi.advanceTimersByTime(2100);

    // After debounce clears cliResuming, herd events should be flushed
    expect(session.cliResuming).toBe(false);
    expect(mockDispatcher.onOrchestratorTurnEnd).toHaveBeenCalledWith("s1");

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
