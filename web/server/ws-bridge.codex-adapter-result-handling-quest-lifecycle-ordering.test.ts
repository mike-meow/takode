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

describe("Codex adapter result handling", () => {
  it("preserves ordering for separate claim then complete tool_results in one assistant message", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    let resolveClaimTitle: ((value: string | null) => void) | null = null;
    bridge.resolveQuestTitle = () =>
      new Promise<string | null>((resolve) => {
        resolveClaimTitle = resolve;
      });
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-complete-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-tool-claim-order",
            name: "Bash",
            input: { command: "quest claim q-74 --json | jq '{id,status}'" },
          },
          {
            type: "tool_use",
            id: "quest-tool-complete-order",
            name: "Bash",
            input: { command: 'quest complete q-74 --items "Verify" --json' },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-complete-end",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-tool-claim-order",
            content: JSON.stringify({
              id: "q-74-v2",
              status: "in_progress",
            }),
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "quest-tool-complete-order",
            content: JSON.stringify({
              questId: "q-74",
              title: "Fix Codex quest lifecycle chips",
              status: "needs_verification",
            }),
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolveClaimTitle).not.toBeNull();
    resolveClaimTitle!("Fix Codex quest lifecycle chips");
    await flushAsync();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvents = calls.filter((c: any) => c.type === "session_quest_claimed");
    expect(questEvents).toHaveLength(2);
    expect(questEvents[0].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });
    expect(questEvents[1].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "needs_verification",
    });
    expect(
      calls.find(
        (c: any) =>
          c.type === "session_name_update" && c.name === "Fix Codex quest lifecycle chips" && c.source === "quest",
      ),
    ).toBeDefined();

    const session = bridge.getSession("s1")!;
    expect(session.state.claimedQuestId).toBe("q-74");
    expect(session.state.claimedQuestTitle).toBe("Fix Codex quest lifecycle chips");
    expect(session.state.claimedQuestStatus).toBe("needs_verification");
  });

  it("preserves ordering for separate claim then done tool_results in one assistant message", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    let resolveClaimTitle: ((value: string | null) => void) | null = null;
    bridge.resolveQuestTitle = () =>
      new Promise<string | null>((resolve) => {
        resolveClaimTitle = resolve;
      });
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-done-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-tool-claim-done-order",
            name: "Bash",
            input: { command: "quest claim q-74 --json | jq '{id,status}'" },
          },
          {
            type: "tool_use",
            id: "quest-tool-done-order",
            name: "Bash",
            input: { command: 'quest done q-74 --notes "done"' },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-done-end",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-tool-claim-done-order",
            content: JSON.stringify({
              id: "q-74-v2",
              status: "in_progress",
            }),
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "quest-tool-done-order",
            content: JSON.stringify({
              questId: "q-74",
              title: "Fix Codex quest lifecycle chips",
              status: "done",
            }),
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolveClaimTitle).not.toBeNull();
    resolveClaimTitle!("Fix Codex quest lifecycle chips");
    await flushAsync();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvents = calls.filter((c: any) => c.type === "session_quest_claimed");
    expect(questEvents).toHaveLength(2);
    expect(questEvents[0].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });
    expect(questEvents[1].quest).toBeNull();

    const session = bridge.getSession("s1")!;
    expect(session.state.claimedQuestId).toBeUndefined();
    expect(session.state.claimedQuestTitle).toBeUndefined();
    expect(session.state.claimedQuestStatus).toBeUndefined();
  });

  it("preserves ordering for claim then complete across separate assistant messages", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    let resolveClaimTitle: ((value: string | null) => void) | null = null;
    bridge.resolveQuestTitle = () =>
      new Promise<string | null>((resolve) => {
        resolveClaimTitle = resolve;
      });
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-cross-claim-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-cross-claim",
            name: "Bash",
            input: { command: "quest claim q-74 --json | jq '{id,status}'" },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-cross-claim-result",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-cross-claim",
            content: JSON.stringify({ id: "q-74-v2", status: "in_progress" }),
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-cross-complete-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-cross-complete",
            name: "Bash",
            input: { command: 'quest complete q-74 --items "Verify" --json' },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-cross-complete-result",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-cross-complete",
            content: JSON.stringify({
              questId: "q-74",
              title: "Fix Codex quest lifecycle chips",
              status: "needs_verification",
            }),
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolveClaimTitle).not.toBeNull();
    resolveClaimTitle!("Fix Codex quest lifecycle chips");
    await flushAsync();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvents = calls.filter((c: any) => c.type === "session_quest_claimed");
    expect(questEvents).toHaveLength(2);
    expect(questEvents[0].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });
    expect(questEvents[1].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "needs_verification",
    });

    const session = bridge.getSession("s1")!;
    expect(session.state.claimedQuestId).toBe("q-74");
    expect(session.state.claimedQuestTitle).toBe("Fix Codex quest lifecycle chips");
    expect(session.state.claimedQuestStatus).toBe("needs_verification");
  });

  it("preserves ordering for claim then done across separate assistant messages", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    let resolveClaimTitle: ((value: string | null) => void) | null = null;
    bridge.resolveQuestTitle = () =>
      new Promise<string | null>((resolve) => {
        resolveClaimTitle = resolve;
      });
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-cross-done-claim-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-cross-done-claim",
            name: "Bash",
            input: { command: "quest claim q-74 --json | jq '{id,status}'" },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-cross-done-claim-result",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-cross-done-claim",
            content: JSON.stringify({ id: "q-74-v2", status: "in_progress" }),
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-cross-done-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-cross-done",
            name: "Bash",
            input: { command: 'quest done q-74 --notes "done"' },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-cross-done-result",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-cross-done",
            content: JSON.stringify({ questId: "q-74", title: "Fix Codex quest lifecycle chips", status: "done" }),
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolveClaimTitle).not.toBeNull();
    resolveClaimTitle!("Fix Codex quest lifecycle chips");
    await flushAsync();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvents = calls.filter((c: any) => c.type === "session_quest_claimed");
    expect(questEvents).toHaveLength(2);
    expect(questEvents[0].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });
    expect(questEvents[1].quest).toBeNull();

    const session = bridge.getSession("s1")!;
    expect(session.state.claimedQuestId).toBeUndefined();
    expect(session.state.claimedQuestTitle).toBeUndefined();
    expect(session.state.claimedQuestStatus).toBeUndefined();
  });

  it("reconciles Codex quest complete command into needs_verification quest state", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    applyClaimedQuest(bridge, "s1", {
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-complete-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-tool-2",
            name: "Bash",
            input: { command: 'quest complete q-74 --items "Verify" --json' },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-complete-end",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-tool-2",
            content: JSON.stringify({
              questId: "q-74",
              title: "Fix Codex quest lifecycle chips",
              status: "needs_verification",
            }),
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    await flushAsync();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvents = calls.filter((c: any) => c.type === "session_quest_claimed");
    expect(questEvents).toHaveLength(1);
    expect(questEvents[0].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "needs_verification",
    });
  });

  it("does not rename orchestrator sessions when a claimed quest becomes in_progress", () => {
    const browser = makeBrowserSocket("leader-1");
    bridge.handleBrowserOpen(browser, "leader-1");
    browser.send.mockClear();

    const launcherMock = {
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    };
    bridge.setLauncher(launcherMock as any);

    applyClaimedQuest(bridge, "leader-1", {
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((c: any) => c.type === "session_quest_claimed")).toBeDefined();
    expect(
      calls.find((c: any) => c.type === "session_name_update" && c.name === "Fix Codex quest lifecycle chips"),
    ).toBeUndefined();
  });

  it("ignores quest lifecycle reconciliation when tool output only contains errors", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-start-error",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-tool-err-1",
            name: "Bash",
            input: { command: "quest claim q-74 --json" },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-end-error",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-tool-err-1",
            content: "Error: sessionId is required for in_progress status",
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((c: any) => c.type === "session_quest_claimed")).toBeUndefined();
    expect(calls.find((c: any) => c.type === "session_task_history")).toBeUndefined();
  });

  it("parses quest IDs from jq id fields and prefers the last JSON object in compound output", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    applyClaimedQuest(bridge, "s1", {
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-multi-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-tool-multi-1",
            name: "Bash",
            input: {
              command:
                "quest claim q-74 --json | jq '{id,status}'; quest complete q-74 --items \"Verify\" --json | jq '{id,status}'",
            },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-multi-end",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-tool-multi-1",
            content: `{
  "id": "q-74-v2",
  "status": "in_progress"
}
{
  "id": "q-74-v3",
  "status": "needs_verification"
}`,
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    await flushAsync();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvents = calls.filter((c: any) => c.type === "session_quest_claimed");
    expect(questEvents).toHaveLength(1);
    expect(questEvents[0].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "needs_verification",
    });
    expect(calls.find((c: any) => c.type === "session_task_history")).toBeUndefined();
  });
});
