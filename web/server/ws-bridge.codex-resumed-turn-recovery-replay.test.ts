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

describe("Codex resumed-turn recovery", () => {
  it("recovers assistant text from resumed turn instead of retrying", async () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-1" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "please recover this",
      }),
    );

    adapter1.emitDisconnect("turn-123");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-1",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-1",
        turnCount: 10,
        lastTurn: {
          id: "turn-123",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "please recover this" }] },
            { type: "reasoning", summary: ["thinking"] },
            { type: "agentMessage", id: "item-a1", text: "Recovered answer from resumed turn" },
          ],
        },
      },
    });

    const session = bridge.getSession(sid)!;
    expect(getPendingCodexTurn(session)).toBeNull();
    expect(adapter2.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "please recover this" }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const recovered = calls.find(
      (c: any) =>
        c.type === "assistant" &&
        c.message?.id === "codex-agent-item-a1" &&
        c.message?.content?.[0]?.text === "Recovered answer from resumed turn",
    );
    expect(recovered).toBeDefined();
  });

  it("deduplicates resumed assistant text when codex replays the same item after reconnect", async () => {
    const sid = "s-replay-dedup";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-2" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "recover and replay",
      }),
    );

    adapter1.emitDisconnect("turn-replay");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-replay",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-replay",
        turnCount: 11,
        lastTurn: {
          id: "turn-replay",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "recover and replay" }] },
            { type: "agentMessage", id: "item-replay", text: "Recovered once" },
          ],
        },
      },
    });

    browser.send.mockClear();
    adapter2.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-agent-item-replay",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "text", text: "Recovered once" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: Date.now() + 1000,
    });

    const session = bridge.getSession(sid)!;
    expect(
      session.messageHistory.filter(
        (msg: any) => msg.type === "assistant" && msg.message?.id === "codex-agent-item-replay",
      ),
    ).toHaveLength(1);
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("hydrates prior transcript when resuming an external codex thread", async () => {
    const sid = "s-external-resume-history";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    adapter.emitSessionMeta({
      cliSessionId: "thread-history",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-history",
        turnCount: 2,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            error: null,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "first question" }] },
              { type: "agentMessage", id: "item-a1", text: "first answer" },
            ],
          },
          {
            id: "turn-2",
            status: "completed",
            error: null,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "second question" }] },
              { type: "agentMessage", id: "item-a2", text: "second answer" },
            ],
          },
        ],
        lastTurn: {
          id: "turn-2",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "second question" }] },
            { type: "agentMessage", id: "item-a2", text: "second answer" },
          ],
        },
      },
    });

    const session = bridge.getSession(sid)!;
    expect(session.messageHistory.map((msg: any) => msg.type)).toEqual([
      "user_message",
      "assistant",
      "user_message",
      "assistant",
    ]);

    const browserMessages = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      browserMessages.find((msg: any) => msg.type === "user_message" && msg.content === "first question"),
    ).toBeDefined();
    expect(
      browserMessages.find(
        (msg: any) => msg.type === "assistant" && msg.message?.content?.[0]?.text === "second answer",
      ),
    ).toBeDefined();
  });

  it("deduplicates compaction-style resumed assistant snapshots with generic item ids", async () => {
    const sid = "s-compaction-replay-dedup";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-compaction" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "keep going after compaction",
      }),
    );

    const session = bridge.getSession(sid)!;
    session.pendingCodexTurns.push({
      adapterMsg: { type: "user_message", content: "follow-up should stay queued" },
      userMessageId: "follow-up-turn",
      userContent: "follow-up should stay queued",
      historyIndex: 1,
      status: "queued",
      dispatchCount: 0,
      createdAt: 2,
      updatedAt: 2,
      acknowledgedAt: null,
      turnTarget: null,
      lastError: null,
      turnId: null,
      disconnectedAt: null,
      resumeConfirmedAt: null,
    } as any);

    adapter1.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-agent-msg_original_a",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "text", text: "First commentary before compaction" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
    adapter1.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-agent-msg_original_b",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Second commentary before compaction" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: Date.now() + 1,
    });

    adapter1.emitTurnStarted("turn-compaction");
    adapter1.emitDisconnect("turn-compaction");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    browser.send.mockClear();

    adapter2.emitSessionMeta({
      cliSessionId: "thread-compaction",
      model: "gpt-5.4",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-compaction",
        turnCount: 14,
        lastTurn: {
          id: "turn-compaction",
          status: "inProgress",
          error: null,
          items: [
            { type: "userMessage", id: "item-25", content: [{ type: "text", text: "keep going after compaction" }] },
            { type: "agentMessage", id: "item-26", text: "First commentary before compaction" },
            { type: "agentMessage", id: "item-27", text: "Second commentary before compaction" },
          ],
        },
      },
    });

    expect(getPendingCodexTurn(session)).toMatchObject({
      userContent: "keep going after compaction",
      status: "backend_acknowledged",
      turnId: "turn-compaction",
    });
    expect(session.pendingCodexTurns[1]).toMatchObject({
      userContent: "follow-up should stay queued",
      status: "queued",
    });
    expect(adapter2.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "follow-up should stay queued" }),
    );
    expect(
      session.messageHistory.filter(
        (msg: any) =>
          msg.type === "assistant" &&
          msg.message?.content?.[0]?.type === "text" &&
          msg.message.content[0].text === "First commentary before compaction",
      ),
    ).toHaveLength(1);
    expect(
      session.messageHistory.filter(
        (msg: any) =>
          msg.type === "assistant" &&
          msg.message?.content?.[0]?.type === "text" &&
          msg.message.content[0].text === "Second commentary before compaction",
      ),
    ).toHaveLength(1);
    const assistantCalls = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((msg: any) => msg.type === "assistant");
    expect(assistantCalls).toHaveLength(0);

    adapter2.emitBrowserMessage({
      type: "result",
      data: {
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        result: "Recovered after resume",
        session_id: sid,
        stop_reason: "end_turn",
      },
    } as any);

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "follow-up should stay queued" }),
    );
  });

  it("re-arms resumed in-progress queued follow-up turns after disconnect", async () => {
    const sid = "s-rearm-resumed-followup";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-rearm-resumed-followup" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    const eventSpy = vi.spyOn(bridge, "emitTakodeEvent");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Draft the first pass",
      }),
    );
    adapter1.emitTurnStarted("turn-rearm-resumed-followup-1");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Then add the reconnect details",
      }),
    );
    await Promise.resolve();
    const steeredPendingId = bridge.getSession(sid)?.pendingCodexInputs[0]?.id;
    expect(steeredPendingId).toBeDefined();
    if (!steeredPendingId) throw new Error("missing steered pending input");
    adapter1.emitTurnSteered("turn-rearm-resumed-followup-2", [steeredPendingId]);

    adapter1.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed the first pass",
        duration_ms: 100,
        duration_api_ms: 100,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "rearm-resumed-followup-result-1",
        session_id: sid,
      },
    });
    await Promise.resolve();

    const promotedSession = bridge.getSession(sid)!;
    expect(getPendingCodexTurn(promotedSession)).toMatchObject({
      userContent: "Then add the reconnect details",
      status: "backend_acknowledged",
      turnId: "turn-rearm-resumed-followup-2",
      turnTarget: "queued",
    });
    expect(promotedSession.isGenerating).toBe(true);

    adapter1.emitDisconnect("turn-rearm-resumed-followup-2");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-rearm-resumed-followup",
      model: "gpt-5.4",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-rearm-resumed-followup",
        turnCount: 12,
        lastTurn: {
          id: "turn-rearm-resumed-followup-2",
          status: "inProgress",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "Then add the reconnect details" }] },
            { type: "agentMessage", id: "item-rearm-followup", text: "Recovering the reconnect details" },
          ],
        },
      },
    });

    const resumedSession = bridge.getSession(sid)!;
    expect(resumedSession.isGenerating).toBe(true);
    expect(getPendingCodexTurn(resumedSession)).toMatchObject({
      userContent: "Then add the reconnect details",
      status: "backend_acknowledged",
      turnId: "turn-rearm-resumed-followup-2",
      turnTarget: "current",
    });

    adapter2.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed the reconnect details",
        duration_ms: 150,
        duration_api_ms: 150,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "rearm-resumed-followup-result-2",
        session_id: sid,
      },
    });
    await Promise.resolve();

    const turnEndCalls = eventSpy.mock.calls.filter(
      ([eventSid, eventType]) => eventSid === sid && eventType === "turn_end",
    );
    // Only two real turns complete in this scenario: the initial turn and the
    // resumed follow-up turn. Re-arming the resumed in-progress follow-up
    // should not synthesize an extra turn_end during reconnect.
    expect(turnEndCalls).toHaveLength(2);
    expect(turnEndCalls[1]?.[2]).toEqual(
      expect.not.objectContaining({
        interrupted: true,
      }),
    );

    eventSpy.mockRestore();
  });
});
