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
  it("synthesizes missing tool result previews from terminal resumed turns", async () => {
    const sid = "s-terminal-resume";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-terminal" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run terminal command",
      }),
    );
    adapter1.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-cmd-1",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "tool_use", id: "cmd_1", name: "Bash", input: { command: "echo hi" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
    expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_1")).toBe(true);

    adapter1.emitDisconnect("turn-cmd-1");
    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    browser.send.mockClear();

    adapter2.emitSessionMeta({
      cliSessionId: "thread-terminal",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-terminal",
        turnCount: 42,
        lastTurn: {
          id: "turn-cmd-1",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "run terminal command" }] },
            { type: "commandExecution", id: "cmd_1", status: "completed", aggregatedOutput: "hi", exitCode: 0 },
          ],
        },
      },
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const preview = calls.find(
      (c: any) =>
        c.type === "tool_result_preview" &&
        Array.isArray(c.previews) &&
        c.previews.some((p: any) => p.tool_use_id === "cmd_1"),
    );
    expect(preview).toBeDefined();
    expect(preview.previews[0].content).toContain("hi");

    const session = bridge.getSession(sid)!;
    expect(session.toolStartTimes.has("cmd_1")).toBe(false);
    expect(getPendingCodexTurn(session)).toBeNull();
  });

  it("watchdog synthesizes interruption when codex stays disconnected", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-watchdog-disconnected";
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);
      emitCodexSessionReady(adapter, { cliSessionId: "thread-watchdog-disconnected" });

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run command",
        }),
      );
      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-cmd-watch",
          type: "message",
          role: "assistant",
          model: "gpt-5.3-codex",
          content: [{ type: "tool_use", id: "cmd_watch", name: "Bash", input: { command: "sleep 999" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      browser.send.mockClear();

      adapter.emitDisconnect("turn-watch");
      vi.advanceTimersByTime(120_000);

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const preview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_watch"),
      );
      expect(preview).toBeDefined();
      expect(preview.previews[0].is_error).toBe(true);
      expect(preview.previews[0].content).toContain("interrupted");
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_watch")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watchdog does not synthesize while codex is connected", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-watchdog-connected";
      const adapter1 = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter1 as any);
      emitCodexSessionReady(adapter1, { cliSessionId: "thread-watchdog-connected" });

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run long command",
        }),
      );
      adapter1.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-cmd-live",
          type: "message",
          role: "assistant",
          model: "gpt-5.3-codex",
          content: [{ type: "tool_use", id: "cmd_live", name: "Bash", input: { command: "sleep 36000" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });
      browser.send.mockClear();
      adapter1.emitDisconnect("turn-live");

      const adapter2 = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter2 as any);
      browser.send.mockClear();

      vi.advanceTimersByTime(120_000);

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const preview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_live"),
      );
      expect(preview).toBeUndefined();
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_live")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watchdog finalizes resumed in-progress bash tools after reconnect confirmation", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-watchdog-resumed-turn";
      const adapter1 = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter1 as any);
      emitCodexSessionReady(adapter1, { cliSessionId: "thread-reconnect" });

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run reconnecting command",
        }),
      );
      adapter1.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-cmd-reconnect",
          type: "message",
          role: "assistant",
          model: "gpt-5.3-codex",
          content: [{ type: "tool_use", id: "cmd_reconnect", name: "Bash", input: { command: "sleep 36000" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });
      browser.send.mockClear();

      adapter1.emitDisconnect("turn-reconnect");

      const adapter2 = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter2 as any);
      adapter2.emitSessionMeta({
        cliSessionId: "thread-reconnect",
        model: "gpt-5.3-codex",
        cwd: "/repo",
        resumeSnapshot: {
          threadId: "thread-reconnect",
          turnCount: 15,
          lastTurn: {
            id: "turn-reconnect",
            status: "inProgress",
            error: null,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "run reconnecting command" }] },
              { type: "commandExecution", id: "cmd_reconnect", status: "in_progress", command: ["sleep", "36000"] },
            ],
          },
        },
      });

      const pending = getPendingCodexTurn(bridge.getSession(sid)!);
      expect(pending?.resumeConfirmedAt).not.toBeNull();
      expect(
        browser.send.mock.calls
          .map(([arg]: [string]) => JSON.parse(arg))
          .find(
            (c: any) =>
              c.type === "error" && typeof c.message === "string" && c.message.includes("non-text tool activity"),
          ),
      ).toBeUndefined();

      browser.send.mockClear();
      vi.advanceTimersByTime(120_000);

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const preview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_reconnect"),
      );
      expect(preview).toBeDefined();
      expect(preview.previews[0].is_error).toBe(true);
      expect(preview.previews[0].content).toContain("interrupted");
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_reconnect")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not finalize older connected bash tools until a later tool actually completes", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-connected-tool-stays-open";
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run two commands",
        }),
      );

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-old-running",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_use", id: "cmd_old_running", name: "Bash", input: { command: "sleep 30" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      vi.advanceTimersByTime(1000);

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-new-running",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_use", id: "cmd_new_running", name: "Bash", input: { command: "pwd" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      const session = bridge.getSession(sid)!;
      expect(session.toolStartTimes.has("cmd_old_running")).toBe(true);
      expect(session.toolStartTimes.has("cmd_new_running")).toBe(true);

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const stalePreview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_old_running"),
      );
      expect(stalePreview).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes older connected bash tools once a later tool completes after the watchdog window", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-connected-tool-superseded";
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run two commands",
        }),
      );

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-old",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_use", id: "cmd_old", name: "Bash", input: { command: "git status --short" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      vi.advanceTimersByTime(1000);

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-new",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_use", id: "cmd_new", name: "Bash", input: { command: "pwd" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      browser.send.mockClear();
      vi.advanceTimersByTime(1000);
      // Superseded tools are only orphan-finalized after the normal recovery
      // window; fresh earlier tools may still be running or have delayed results.
      bridge.getSession(sid)!.toolStartTimes.set("cmd_old", Date.now() - 121_000);

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-new-result",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_result", tool_use_id: "cmd_new", content: "/repo\n", is_error: false }],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      let newPreview: any;
      let stalePreview: any;
      await vi.waitFor(() => {
        const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
        newPreview = calls.find(
          (c: any) =>
            c.type === "tool_result_preview" &&
            Array.isArray(c.previews) &&
            c.previews.some((p: any) => p.tool_use_id === "cmd_new"),
        );
        stalePreview = calls.find(
          (c: any) =>
            c.type === "tool_result_preview" &&
            Array.isArray(c.previews) &&
            c.previews.some((p: any) => p.tool_use_id === "cmd_old"),
        );
        expect(newPreview).toBeDefined();
        expect(stalePreview).toBeDefined();
      });
      expect(stalePreview.previews[0].is_error).toBe(false);
      expect(stalePreview.previews[0].content).toContain("later tool completed");
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_old")).toBe(false);
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_new")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("result finalizes silent bash tools so they do not stay running forever", async () => {
    const sid = "s-result-silent-terminal";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run silent command",
      }),
    );
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-cmd-silent",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "tool_use", id: "cmd_silent", name: "Bash", input: { command: "true" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    browser.send.mockClear();
    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        duration_ms: 1000,
        duration_api_ms: 1000,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "codex-result-silent",
        session_id: sid,
      },
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const preview = calls.find(
      (c: any) =>
        c.type === "tool_result_preview" &&
        Array.isArray(c.previews) &&
        c.previews.some((p: any) => p.tool_use_id === "cmd_silent"),
    );
    expect(preview).toBeDefined();
    expect(preview.previews[0].is_error).toBe(false);
    expect(preview.previews[0].content).toContain("no output was captured");
    expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_silent")).toBe(false);
  });

  it("prefers retained terminal transcript when aged superseded codex bash tool lacks a final result", async () => {
    const sid = "s-superseded-terminal-transcript";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run two commands",
      }),
    );

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-old-terminal",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [
          {
            type: "tool_use",
            id: "cmd_old",
            name: "Bash",
            input: { command: "git --no-optional-locks status --short" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now() - 1000,
      tool_start_times: { cmd_old: Date.now() - 1000 },
    });

    adapter.emitBrowserMessage({
      type: "tool_progress",
      tool_use_id: "cmd_old",
      tool_name: "Bash",
      elapsed_time_seconds: 1,
      output_delta: " M web/src/components/MessageFeed.tsx\n",
    } as any);

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-new-terminal",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "tool_use", id: "cmd_new", name: "Bash", input: { command: "echo done" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
      tool_start_times: { cmd_new: Date.now() },
    });
    // Keep the retained transcript path covered while matching production
    // recovery semantics: superseded finalization only runs after the watchdog age.
    bridge.getSession(sid)!.toolStartTimes.set("cmd_old", Date.now() - 121_000);
    bridge.getSession(sid)!.toolStartTimes.set("cmd_new", Date.now());

    browser.send.mockClear();
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-new-result",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "tool_result", tool_use_id: "cmd_new", content: "done", is_error: false }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    let stalePreview: any;
    await vi.waitFor(() => {
      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      stalePreview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_old"),
      );
      expect(stalePreview).toBeDefined();
    });
    expect(stalePreview.previews[0].content).toContain("M web/src/components/MessageFeed.tsx");
    expect(stalePreview.previews[0].content).not.toContain("later tool completed");
  });
});
