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

describe("compact_boundary handling", () => {
  it("appends compact_marker to messageHistory (preserving old messages) when compact_boundary is received", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Send init + an assistant message so history is non-empty
    bridge.handleCLIMessage(cli, makeInitMsg());
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hello" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );

    // Verify history has the assistant message
    const sessionBefore = bridge.getOrCreateSession("s1");
    const historyLenBefore = sessionBefore.messageHistory.length;
    expect(historyLenBefore).toBeGreaterThan(0);

    // Send compact_boundary with metadata
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 50000 },
        uuid: "u3",
        session_id: "cli-123",
      }),
    );

    // History should have old messages PLUS the new compact_marker appended
    const sessionAfter = bridge.getOrCreateSession("s1");
    expect(sessionAfter.messageHistory.length).toBe(historyLenBefore + 1);
    const lastEntry = sessionAfter.messageHistory[sessionAfter.messageHistory.length - 1];
    expect(lastEntry.type).toBe("compact_marker");
    const marker = lastEntry as any;
    expect(marker.trigger).toBe("manual");
    expect(marker.preTokens).toBe(50000);
    expect(marker.id).toMatch(/^compact-boundary-/);
  });

  // Validates that compact_boundary does NOT update context_used_percent.
  // pre_tokens is a diagnostic snapshot of context BEFORE compaction -- using
  // it as the displayed percentage would show a stale high value that may
  // never be overwritten (the post-compaction result message may not produce
  // a valid percentage for SDK/WebSocket sessions).
  it("does not update context_used_percent from compact_boundary pre_tokens", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ model: "claude-opus-4-6" }));
    browser.send.mockClear();

    const session = bridge.getOrCreateSession("s1");
    session.state.context_used_percent = 68;

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 167048 },
        uuid: "u-ctx-compact",
        session_id: "cli-123",
      }),
    );

    // context_used_percent should remain at 68 (unchanged by compact_boundary)
    expect(bridge.getOrCreateSession("s1").state.context_used_percent).toBe(68);
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    // No session_update with context_used_percent should be broadcast
    const contextUpdate = calls.find(
      (m: any) => m.type === "session_update" && m.session?.context_used_percent != null,
    );
    expect(contextUpdate).toBeUndefined();
  });

  it("supports multiple compactions creating multiple compact_markers in history", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send an assistant message
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-a",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "first response" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "ua",
        session_id: "cli-123",
      }),
    );

    // First compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 30000 },
        uuid: "uc1",
        session_id: "cli-123",
      }),
    );

    // Another assistant message after compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-b",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "second response" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "ub",
        session_id: "cli-123",
      }),
    );

    // Second compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 60000 },
        uuid: "uc2",
        session_id: "cli-123",
      }),
    );

    // History should contain: [assistant(first), compact_marker(1), assistant(second), compact_marker(2)]
    const session = bridge.getOrCreateSession("s1");
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers.length).toBe(2);
    expect((markers[0] as any).preTokens).toBe(30000);
    expect((markers[1] as any).preTokens).toBe(60000);
  });

  it("deduplicates replayed compact_boundary without uuid when marker is equivalent", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const payload = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 42000 },
      session_id: "cli-123",
    };

    bridge.handleCLIMessage(cli, JSON.stringify(payload));
    bridge.handleCLIMessage(cli, JSON.stringify(payload));

    const session = bridge.getOrCreateSession("s1");
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).trigger).toBe("manual");
    expect((markers[0] as any).preTokens).toBe(42000);
  });

  it("deduplicates equivalent replayed compact_boundary even when uuid changes", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 64000 },
        uuid: "compact-uuid-1",
        session_id: "cli-123",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 64000 },
        uuid: "compact-uuid-2",
        session_id: "cli-123",
      }),
    );

    const session = bridge.getOrCreateSession("s1");
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).trigger).toBe("auto");
    expect((markers[0] as any).preTokens).toBe(64000);
  });

  it("broadcasts compact_boundary event with metadata to browsers", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Subscribe browser so it receives sequenced broadcasts
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );

    bridge.handleCLIMessage(cli, makeInitMsg());
    browser.send.mockClear();

    // Send compact_boundary
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 80000 },
        uuid: "u4",
        session_id: "cli-123",
      }),
    );

    // Browser should have received a compact_boundary message with metadata
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const compactMsg = calls.find((m: any) => m.type === "compact_boundary");
    expect(compactMsg).toBeTruthy();
    expect(compactMsg.id).toMatch(/^compact-boundary-\d+$/);
    expect(typeof compactMsg.timestamp).toBe("number");
    expect(compactMsg.trigger).toBe("auto");
    expect(compactMsg.preTokens).toBe(80000);
  });

  it("captures compaction summary from next CLI user message and broadcasts compact_summary", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Subscribe browser
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );

    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send compact_boundary (sets awaitingCompactSummary)
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto" },
        uuid: "u5",
        session_id: "cli-123",
      }),
    );

    browser.send.mockClear();

    // Send a CLI "user" message with a text block (this is the compaction summary)
    const summaryText =
      "This session is being continued from a previous conversation. Key context: the user is building a web app.";
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: summaryText }] },
        parent_tool_use_id: null,
        uuid: "u6",
        session_id: "cli-123",
      }),
    );

    // compact_marker in history should now have the summary
    const session = bridge.getOrCreateSession("s1");
    const marker = session.messageHistory.find((m) => m.type === "compact_marker") as any;
    expect(marker).toBeTruthy();
    expect(marker.summary).toBe(summaryText);

    // Browser should have received a compact_summary event
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const summaryMsg = calls.find((m: any) => m.type === "compact_summary");
    expect(summaryMsg).toBeTruthy();
    expect(summaryMsg.summary).toBe(summaryText);

    // awaitingCompactSummary should be cleared
    expect(session.awaitingCompactSummary).toBe(false);
  });

  it("captures compaction summary from a plain string content (CLI actual format)", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );

    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send compact_boundary
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 60000 },
        uuid: "u-str-1",
        session_id: "cli-123",
      }),
    );

    browser.send.mockClear();

    // CLI sends the summary as a plain string (not an array of content blocks)
    const summaryText = "This session is being continued from a previous conversation. The user is building a web UI.";
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: summaryText },
        parent_tool_use_id: null,
        uuid: "u-str-2",
        session_id: "cli-123",
      }),
    );

    // compact_marker in history should have the summary
    const session = bridge.getOrCreateSession("s1");
    const marker = session.messageHistory.find((m) => m.type === "compact_marker") as any;
    expect(marker).toBeTruthy();
    expect(marker.summary).toBe(summaryText);

    // Browser should have received compact_summary
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const summaryMsg = calls.find((m: any) => m.type === "compact_summary");
    expect(summaryMsg).toBeTruthy();
    expect(summaryMsg.summary).toBe(summaryText);

    // awaitingCompactSummary should be cleared
    expect(session.awaitingCompactSummary).toBe(false);
  });

  it("attaches summary to the LAST compact_marker when multiple compactions occurred (findLast)", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // First compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 30000 },
        uuid: "uf1",
        session_id: "cli-123",
      }),
    );

    // Provide summary for first compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "First compaction summary" },
        parent_tool_use_id: null,
        uuid: "uf2",
        session_id: "cli-123",
      }),
    );

    // Some more messages between compactions
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-mid",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "middle" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "uf3",
        session_id: "cli-123",
      }),
    );

    // Second compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 60000 },
        uuid: "uf4",
        session_id: "cli-123",
      }),
    );

    // Provide summary for second compaction — should attach to the LAST marker
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Second compaction summary" },
        parent_tool_use_id: null,
        uuid: "uf5",
        session_id: "cli-123",
      }),
    );

    const session = bridge.getOrCreateSession("s1");
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers.length).toBe(2);
    // First marker should have its own summary
    expect((markers[0] as any).summary).toBe("First compaction summary");
    // Second marker should have the second summary (findLast ensures this)
    expect((markers[1] as any).summary).toBe("Second compaction summary");
  });

  it("processes normal tool_result user messages after summary is captured", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send compact_boundary
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual" },
        uuid: "u7",
        session_id: "cli-123",
      }),
    );

    // Send summary (consumes awaitingCompactSummary)
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Summary text" }] },
        parent_tool_use_id: null,
        uuid: "u8",
        session_id: "cli-123",
      }),
    );

    // Now send a normal tool_result user message — should be handled normally
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "result data" }] },
        parent_tool_use_id: null,
        uuid: "u9",
        session_id: "cli-123",
      }),
    );

    // The tool_result_preview should be in history (not silently dropped)
    const session = bridge.getOrCreateSession("s1");
    const previewMsg = session.messageHistory.find((m) => m.type === "tool_result_preview");
    expect(previewMsg).toBeTruthy();
  });
});
