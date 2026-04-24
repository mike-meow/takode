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

describe("injectUserMessage triggers relaunch for exited sessions (q-15)", () => {
  // injectUserMessage is called by the takode send REST endpoint. Before q-15,
  // the endpoint rejected exited sessions outright. Now it lets the message
  // queue and relies on injectUserMessage to trigger a relaunch — matching the
  // browser chat UI behavior.

  it("requests relaunch when injecting a message into an exited Claude session", () => {
    const sid = "s-inject-claude";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ state: "exited", killedByIdleManager: false })),
    } as any);

    // Create a Claude session with no backend socket (exited)
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    relaunchCb.mockClear();

    const delivery = bridge.injectUserMessage(sid, "hello from takode send");

    // Message should be queued (not sent) and relaunch requested
    expect(delivery).toBe("queued");
    expect(relaunchCb).toHaveBeenCalledWith(sid);
  });

  it("routes pre-attach injected Codex messages through the authoritative Codex turn queue", () => {
    const sid = "s-inject-codex-starting";
    const relaunchCb = vi.fn();
    const launcherInfo = { backendType: "codex", state: "starting", killedByIdleManager: false };
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    } as any);

    // A browser/opened placeholder can exist before the Codex adapter attaches.
    // It must be corrected from launcher metadata before injected dispatch
    // routing, otherwise q44 startup turns fall into raw pendingMessages.
    const session = bridge.getOrCreateSession(sid);
    expect(session.backendType).toBe("claude");

    const delivery = bridge.injectUserMessage(sid, "startup dispatch from takode send", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });

    expect(delivery).toBe("queued");
    expect(relaunchCb).not.toHaveBeenCalled();
    expect(session.backendType).toBe("codex");
    expect(session.pendingMessages).toHaveLength(0);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "queued",
      userContent: "startup dispatch from takode send",
    });

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-startup-dispatch" });

    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: [expect.objectContaining({ content: "startup dispatch from takode send" })],
      }),
    );
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "dispatched",
      dispatchCount: 1,
    });
  });

  it("wakes an idle-killed session by clearing flag and requesting relaunch", () => {
    // When a leader sends a message to an idle-killed worker, the intent is
    // clear: wake the session. The killedByIdleManager flag should be cleared
    // and relaunch triggered — matching how wakeIdleKilledSession() works.
    const sid = "s-inject-idle-killed";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    const launcherInfo = { state: "exited", killedByIdleManager: true };
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    } as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    relaunchCb.mockClear();

    const delivery = bridge.injectUserMessage(sid, "wake up, worker");

    expect(delivery).toBe("queued");
    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(launcherInfo.killedByIdleManager).toBe(false);
  });

  it("returns 'sent' and does not relaunch when backend is connected", () => {
    const sid = "s-inject-connected";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ state: "connected" })),
    } as any);

    const cliWs = makeCliSocket(sid);
    bridge.handleCLIOpen(cliWs, sid);

    const delivery = bridge.injectUserMessage(sid, "hello live session");

    expect(delivery).toBe("sent");
    expect(relaunchCb).not.toHaveBeenCalled();
  });

  it("drops stale board_stalled herd batches at injectUserMessage before they reach the conversation", () => {
    const sid = "s-inject-stale-board-stall";
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) =>
        id === sid
          ? { sessionId: sid, sessionNum: 1, isOrchestrator: true, backendType: "claude", state: "connected" }
          : undefined,
      ),
      listSessions: vi.fn(() => [{ sessionId: sid, sessionNum: 1, isOrchestrator: true, backendType: "claude" }]),
      resolveSessionId: vi.fn(() => undefined),
    } as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    const cliWs = makeCliSocket(sid);
    bridge.handleCLIOpen(cliWs, sid);
    bridge.handleCLIMessage(cliWs, makeInitMsg({ session_id: "cli-s-inject-stale-board-stall" }));

    bridge.upsertBoardRow(sid, {
      questId: "q-1",
      title: "Investigate delayed stall drop",
      status: "PORTING",
      updatedAt: Date.now(),
    });

    const delivery = bridge.injectUserMessage(
      sid,
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
    expect(delivery).toBe("dropped");
    expect(browser.send).not.toHaveBeenCalledWith(
      expect.stringContaining("board_stalled | q-1 Investigate delayed stall drop"),
    );
  });

  it("reformats partially stale board_stalled herd batches with the standard batch wrapper", async () => {
    const sid = "s-inject-partial-stale-board-stall";
    const now = Date.now();
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => {
        if (id === sid) {
          return { sessionId: sid, sessionNum: 1, isOrchestrator: true, backendType: "codex", state: "starting" };
        }
        if (id === "worker-live") {
          return {
            sessionId: "worker-live",
            sessionNum: 22,
            herdedBy: sid,
            backendType: "claude",
            state: "connected",
            lastActivityAt: now - 5 * 60_000,
          };
        }
        return undefined;
      }),
      listSessions: vi.fn(() => [
        { sessionId: sid, sessionNum: 1, isOrchestrator: true, backendType: "codex" },
        {
          sessionId: "worker-live",
          sessionNum: 22,
          herdedBy: sid,
          backendType: "claude",
          lastActivityAt: now - 5 * 60_000,
        },
      ]),
      resolveSessionId: vi.fn((ref: string) => (ref === "22" ? "worker-live" : undefined)),
    } as any);

    const session = bridge.getOrCreateSession(sid);
    bridge.upsertBoardRow(sid, {
      questId: "q-1",
      title: "Stale stall row",
      status: "PORTING",
      updatedAt: now,
    });
    bridge.upsertBoardRow(sid, {
      questId: "q-2",
      title: "Live stall row",
      worker: "worker-live",
      workerNum: 22,
      status: "IMPLEMENTING",
      updatedAt: now - 5 * 60_000,
    });

    const staleEvent = {
      id: 1,
      event: "board_stalled",
      sessionId: "worker-stale",
      sessionNum: 12,
      sessionName: "worker-stale",
      ts: now,
      data: {
        questId: "q-1",
        title: "Stale stall row",
        stage: "IMPLEMENTING",
        signature: "q-1|IMPLEMENTING|disconnected",
        workerStatus: "disconnected",
        reviewerStatus: "missing",
        stalledForMs: 240_000,
        reason: "worker disconnected",
        action: "inspect worker; resume or re-dispatch before review",
      },
    } as any;
    const liveEvent = {
      id: 2,
      event: "board_stalled",
      sessionId: "worker-live",
      sessionNum: 22,
      sessionName: "worker-live",
      ts: now,
      data: {
        questId: "q-2",
        title: "Live stall row",
        stage: "IMPLEMENTING",
        signature: "q-2|IMPLEMENTING|disconnected",
        workerStatus: "disconnected",
        reviewerStatus: "missing",
        stalledForMs: 240_000,
        reason: "worker disconnected",
        action: "inspect worker; resume or re-dispatch before review",
      },
    } as any;
    const expectedRendered = renderHerdEventBatch([liveEvent]);

    const delivery = bridge.injectUserMessage(
      sid,
      "2 events from 1 session\n\n#12 stale\n#22 live",
      {
        sessionId: "herd-events",
        sessionLabel: "Herd Events",
      },
      {
        events: [staleEvent, liveEvent],
        renderedLines: ["#12 stale", expectedRendered.renderedLines[0]],
      },
    );
    await Promise.resolve();

    expect(delivery).toBe("queued");
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.content).toBe(expectedRendered.content);
    expect(session.pendingCodexInputs[0]?.content).toContain("1 event from 1 session\n\n");
  });

  it("requests Codex auto-recovery only once when injectUserMessage targets an adapter-missing connected session", async () => {
    const sid = "s-inject-codex-missing-adapter";
    const relaunchCb = vi.fn();
    const recoverySpy = vi.spyOn(bridge as any, "requestCodexAutoRecovery");
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "codex", state: "connected", killedByIdleManager: false })),
    } as any);

    const session = bridge.getOrCreateSession(sid);
    session.backendType = "codex";
    session.state.backend_type = "codex";

    const delivery = bridge.injectUserMessage(sid, "inject wake missing adapter");
    await Promise.resolve();

    expect(delivery).toBe("queued");
    expect(recoverySpy).toHaveBeenCalledTimes(1);
    expect(recoverySpy).toHaveBeenCalledWith(session, "queued_user_message_adapter_missing");
    expect(relaunchCb).toHaveBeenCalledTimes(1);
    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(session.state.backend_state).toBe("recovering");
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("inject wake missing adapter");
    recoverySpy.mockRestore();
  });

  it("wakes idle-killed SDK session when browser sends user_message (adapter path)", async () => {
    // SDK sessions use the adapter code path in routeBrowserMessage.
    // When the adapter is missing (post-restart, idle-killed), a browser
    // user_message should clear killedByIdleManager and trigger relaunch.
    const sid = "s-sdk-idle-wake";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    const launcherInfo = { backendType: "claude-sdk", state: "exited", killedByIdleManager: true };
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    } as any);

    // Create an SDK session with no adapter (simulates post-restart idle-killed state)
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    const session = bridge.getSession(sid)!;
    session.backendType = "claude-sdk";
    relaunchCb.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "wake up from idle",
      }),
    );

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(launcherInfo.killedByIdleManager).toBe(false);
  });
});
