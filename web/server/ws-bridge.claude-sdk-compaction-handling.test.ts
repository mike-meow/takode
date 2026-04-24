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

describe("Claude SDK compaction handling", () => {
  // The SDK status_change handler synthesizes a compact_marker immediately
  // (the Agent SDK may not emit compact_boundary through stream()). If
  // compact_boundary does arrive, the handler enriches the existing marker
  // with metadata (trigger, preTokens, cliUuid) instead of creating a
  // duplicate. This mirrors the Codex pattern for resilient UI rendering.

  /** Helper: create an SDK adapter mock, attach it, and emit session_init. */
  function initSdkSession(sessionId: string) {
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sessionId, adapter as any);
    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        session_id: `cli-${sessionId}`,
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/test",
        tools: [],
        permissionMode: "default",
      },
    });
    return adapter;
  }

  it("updates is_compacting state when SDK status_change reports compacting", () => {
    // is_compacting drives deriveSessionStatus() which populates state_snapshot
    // on browser reconnect. Without this, reconnecting browsers see "idle"
    // instead of "compacting" during active compaction.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.state.is_compacting).toBe(false);

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.state.is_compacting).toBe(true);

    adapter.emitBrowserMessage({ type: "status_change", status: null });
    expect(session.state.is_compacting).toBe(false);
  });

  it("sets compactedDuringTurn when SDK enters compacting state", () => {
    // compactedDuringTurn is consumed by the herd event system to annotate
    // turn_end events with "(compacted)" so the orchestrator knows the worker
    // was busy compacting rather than doing useful work.
    const adapter = initSdkSession("s1");

    const session = bridge.getSession("s1")!;
    expect(session.compactedDuringTurn).toBe(false);

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.compactedDuringTurn).toBe(true);
  });

  it("emits compaction_started and compaction_finished takode events for SDK sessions", () => {
    // Takode orchestrators use these events to track herded worker compaction
    // state. Without them, the leader has no visibility into SDK workers
    // spending time on compaction vs. actual work.
    const adapter = initSdkSession("s1");

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    const startedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_started");
    const finishedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_finished");
    expect(startedCalls).toHaveLength(1);
    expect(finishedCalls).toHaveLength(1);
  });

  it("synthesizes compact_marker from status_change even without compact_boundary", () => {
    // The Agent SDK may not yield compact_boundary through stream() — the
    // status_change handler creates a compact_marker so the chat UI always
    // shows the "Conversation compacted" divider.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const session = bridge.getSession("s1")!;
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).id).toMatch(/^compact-boundary-/);

    // Browser receives compact_boundary broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const compactMsg = calls.find((m: any) => m.type === "compact_boundary");
    expect(compactMsg).toBeTruthy();
    expect(typeof compactMsg.timestamp).toBe("number");

    // awaitingCompactSummary is set so summary capture works
    expect(session.awaitingCompactSummary).toBe(true);
  });

  it("compact_boundary enriches existing synthesized marker with metadata", () => {
    // When compact_boundary arrives after status_change, it should enrich
    // the already-synthesized marker with trigger/preTokens/cliUuid rather
    // than creating a duplicate marker.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // status_change creates the initial marker
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    // compact_boundary enriches it
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "sdk-compact-uuid-1",
      session_id: "cli-s1",
    });

    const session = bridge.getSession("s1")!;
    // Still only one marker (no duplicate)
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    const marker = markers[0] as any;
    expect(marker.trigger).toBe("auto");
    expect(marker.preTokens).toBe(80000);
    expect(marker.cliUuid).toBe("sdk-compact-uuid-1");
    expect(marker.id).toMatch(/^compact-boundary-/);
  });

  it("handles compact_boundary that arrives without prior status_change", () => {
    // Edge case: the SDK might deliver compact_boundary independently of
    // status_change, or the messages could arrive out of order. The compact
    // marker must still be created correctly, and the browser broadcast must
    // include the trigger and preTokens metadata fields.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // compact_boundary WITHOUT any prior status_change(compacting)
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 60000 },
      uuid: "sdk-standalone-boundary",
      session_id: "cli-s1",
    });

    const session = bridge.getSession("s1")!;
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).trigger).toBe("manual");

    // Browser broadcast includes trigger and preTokens metadata
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const boundaryMsg = calls.find((m: any) => m.type === "compact_boundary");
    expect(boundaryMsg).toBeTruthy();
    expect(boundaryMsg.trigger).toBe("manual");
    expect(boundaryMsg.preTokens).toBe(60000);
  });

  it("deduplicates replayed compact_boundary by uuid on SDK resume", () => {
    // On --resume, the SDK replays historical compact_boundary messages.
    // The bridge must deduplicate by uuid so replay doesn't create duplicate
    // markers in messageHistory (same logic as the WebSocket path).
    const adapter = initSdkSession("s1");

    // First: status_change creates synthesized marker, compact_boundary enriches it
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "sdk-dedup-uuid",
      session_id: "cli-s1",
    });

    // Replay (same uuid) — should be deduplicated
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "sdk-dedup-uuid",
      session_id: "cli-s1",
    });

    const session = bridge.getSession("s1")!;
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
  });

  it("captures compaction summary from user message after status_change synthesis", () => {
    // After compacting, the CLI sends a "user" message containing the
    // compaction summary text. The bridge stores this on the compact_marker
    // and broadcasts compact_summary so the browser can update the marker
    // content from "Conversation compacted" to the full summary. This must
    // work even without compact_boundary (status_change-only path).
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // status_change synthesizes the marker and sets awaitingCompactSummary
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const session = bridge.getSession("s1")!;
    expect(session.awaitingCompactSummary).toBe(true);

    adapter.emitBrowserMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "Here is a summary of the conversation so far..." }],
      },
      parent_tool_use_id: null,
      uuid: "sdk-summary-msg-1",
      session_id: "cli-s1",
    });

    expect(session.awaitingCompactSummary).toBe(false);

    const marker = session.messageHistory.findLast((m) => m.type === "compact_marker") as any;
    expect(marker?.summary).toBe("Here is a summary of the conversation so far...");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const summaryMsg = calls.find((m: any) => m.type === "compact_summary");
    expect(summaryMsg).toBeTruthy();
    expect(summaryMsg.summary).toBe("Here is a summary of the conversation so far...");
  });

  it("does not duplicate state or markers on re-notification of same compacting status", () => {
    // The SDK or adapter may re-notify the same compacting status. The bridge
    // must be idempotent: is_compacting stays true, compactedDuringTurn stays
    // true, no duplicate takode events are emitted, and only one compact_marker
    // is created.
    const adapter = initSdkSession("s1");
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const session = bridge.getSession("s1")!;
    expect(session.state.is_compacting).toBe(true);
    expect(session.compactedDuringTurn).toBe(true);

    // Only one compaction_started event (transition guard prevents duplicate)
    const startedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_started");
    expect(startedCalls).toHaveLength(1);

    // Only one compact_marker (second status_change was not a transition)
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
  });

  it("broadcasts both status_change and compact_boundary to browser on SDK compaction", () => {
    // The browser uses status_change to update the session status indicator
    // (showing "compacting" spinner) AND receives compact_boundary to render
    // the chat divider. Both must be broadcast from the status_change handler.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "compacting" }));
    expect(calls.find((m: any) => m.type === "compact_boundary")).toBeTruthy();
  });

  it("preserves isGenerating during SDK compaction mid-turn", async () => {
    // Compaction is NOT a turn boundary -- the CLI continues its turn after
    // compacting. isGenerating must stay true throughout so the session
    // doesn't appear idle while still working.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "implement feature" }));

    const session = bridge.getSession("s1")!;
    // isGenerating is set by the user message dispatch
    // (SDK adapter mock returns true for sendBrowserMessage by default)

    // SDK enters compaction mid-turn
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.state.is_compacting).toBe(true);
    // isGenerating must NOT be cleared by compaction
    expect(session.isGenerating).toBe(true);

    // SDK exits compaction, continues turn
    adapter.emitBrowserMessage({ type: "status_change", status: null });
    expect(session.state.is_compacting).toBe(false);
    expect(session.isGenerating).toBe(true);
  });

  it("handles full auto-compaction lifecycle: status_change → compact_boundary → summary → idle", () => {
    // Simulates the exact message sequence the CLI emits during automatic
    // compaction (hitting context limits). Verifies every side-effect fires:
    // state transitions, marker creation, enrichment, summary capture,
    // and all browser broadcasts arrive in the expected order.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const spy = vi.spyOn(bridge, "emitTakodeEvent");
    const session = bridge.getSession("s1")!;

    // Phase 1: CLI signals compaction start
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    expect(session.state.is_compacting).toBe(true);
    // compactedDuringTurn stays true until turn ends (reset in setGenerating),
    // not at compaction end -- tested in "preserves isGenerating" test above.
    expect(session.compactedDuringTurn).toBe(true);
    expect(session.awaitingCompactSummary).toBe(true);
    const markers1 = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers1).toHaveLength(1);
    // Marker synthesized without metadata (no compact_boundary yet)
    expect((markers1[0] as any).trigger).toBeUndefined();

    // Phase 2: CLI sends compact_boundary with auto-compaction metadata
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 95000 },
      uuid: "auto-compact-uuid-1",
      session_id: "cli-s1",
    });

    // Marker enriched (still just one)
    const markers2 = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers2).toHaveLength(1);
    const enriched = markers2[0] as any;
    expect(enriched.trigger).toBe("auto");
    expect(enriched.preTokens).toBe(95000);
    expect(enriched.cliUuid).toBe("auto-compact-uuid-1");

    // Phase 3: CLI sends the compaction summary as a user message
    const summaryText =
      "This session continues from a previous conversation. " +
      "The user is building a real-time dashboard with WebSocket support.";
    adapter.emitBrowserMessage({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: summaryText }] },
      parent_tool_use_id: null,
      uuid: "auto-compact-summary-1",
      session_id: "cli-s1",
    });

    expect(session.awaitingCompactSummary).toBe(false);
    const finalMarker = session.messageHistory.findLast((m) => m.type === "compact_marker") as any;
    expect(finalMarker?.summary).toBe(summaryText);

    // Phase 4: CLI signals compaction complete
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    expect(session.state.is_compacting).toBe(false);

    // Verify takode events
    const startedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_started");
    const finishedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_finished");
    expect(startedCalls).toHaveLength(1);
    expect(finishedCalls).toHaveLength(1);

    // Verify browser received all expected messages in order
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const types = calls.map((m: any) => m.type);
    // compact_boundary comes before status_change(compacting) because the bridge
    // synthesizes the marker first, then falls through to broadcastToBrowsers
    expect(types).toContain("compact_boundary");
    expect(types).toContain("status_change");
    expect(types).toContain("compact_summary");
    // Verify final status_change(null) was broadcast
    const finalStatusMsg = calls.filter((m: any) => m.type === "status_change" && m.status === null);
    expect(finalStatusMsg.length).toBeGreaterThanOrEqual(1);
  });

  // Validates that compact_boundary enrichment does NOT update
  // context_used_percent. pre_tokens is a pre-compaction diagnostic
  // snapshot that would show a stale high value.
  it("does not update context_used_percent from compact_boundary enrichment", () => {
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    session.state.model = "claude-sonnet-4-5-20250929";
    session.state.context_used_percent = 42;
    browser.send.mockClear();

    // status_change creates the synthesized marker
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    // compact_boundary enriches it with pre_tokens
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 180000 },
      uuid: "ctx-pct-uuid",
      session_id: "cli-s1",
    });

    // context_used_percent should remain unchanged (not set from pre_tokens)
    expect(session.state.context_used_percent).toBe(42);

    // No session_update with context_used_percent should be broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const contextUpdate = calls.find(
      (m: any) => m.type === "session_update" && m.session?.context_used_percent != null,
    );
    expect(contextUpdate).toBeUndefined();
  });

  it("does not synthesize compact_marker during cliResuming replay (q-227)", () => {
    // During --resume replay, replayed status_change(compacting) must NOT
    // create a compact_marker in history. Without this guard, a revert +
    // /compact sequence produces duplicate markers: one from the replayed
    // compaction and one from the real compaction after resume ends.
    const adapter = initSdkSession("s1");
    const session = bridge.getSession("s1")!;
    // Simulate resume state (session has history + CLI is replaying)
    session.cliResuming = true;

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Replayed status_change(compacting) — should NOT create marker
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    // is_compacting is still tracked (needed for cleanup when cliResuming clears)
    expect(session.state.is_compacting).toBe(true);
    // But no marker should have been synthesized
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(0);
    // awaitingCompactSummary should NOT be set during replay
    expect(session.awaitingCompactSummary).toBeFalsy();
    // compactedDuringTurn should NOT be set during replay
    expect(session.compactedDuringTurn).toBe(false);
    // No takode event emitted
    expect(spy.mock.calls.filter(([, e]) => e === "compaction_started")).toHaveLength(0);

    spy.mockRestore();
  });

  it("skips replayed compact_boundary during cliResuming (q-227)", () => {
    // Replayed compact_boundary during --resume must be completely ignored,
    // not just deduped. After a revert, old markers are removed from history,
    // so UUID-based dedup fails and would create a ghost marker.
    const adapter = initSdkSession("s1");
    const session = bridge.getSession("s1")!;
    session.cliResuming = true;

    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "replayed-boundary-uuid",
      session_id: "cli-s1",
    });

    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(0);
    expect(session.awaitingCompactSummary).toBeFalsy();
  });

  it("skips compact summary capture from replayed user messages during cliResuming (q-227)", () => {
    // If awaitingCompactSummary is stale from before a revert, replayed
    // user messages during --resume must not be consumed as summaries.
    const adapter = initSdkSession("s1");
    const session = bridge.getSession("s1")!;
    session.cliResuming = true;
    // Simulate stale flag from a pre-revert compaction
    session.awaitingCompactSummary = true;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "This is a replayed summary" }] },
      parent_tool_use_id: null,
      uuid: "replayed-user-msg",
      session_id: "cli-s1",
    });

    // awaitingCompactSummary should NOT have been consumed (still true)
    expect(session.awaitingCompactSummary).toBe(true);
    // No compact_summary broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((m: any) => m.type === "compact_summary")).toBeUndefined();
  });

  it("replayed compaction during resume is ignored, real compaction after resume produces exactly one marker (q-227)", () => {
    // Regression test for the resume replay path. Simulates:
    // 1. cliResuming=true: replayed compaction events arrive (all ignored)
    // 2. cliResuming clears: resume replay is done
    // 3. Real /compact produces compaction events
    // Verifies exactly one marker from the real compaction, none from replay.
    // Note: the revert handler's state clearing is tested separately in routes.test.ts.
    vi.useFakeTimers();

    const adapter = initSdkSession("s1");
    const session = bridge.getSession("s1")!;
    session.cliResuming = true;

    // Phase 1: Replayed compaction events during resume (all ignored)
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "old-compact-uuid",
      session_id: "cli-s1",
    });
    adapter.emitBrowserMessage({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Old compaction summary" }] },
      parent_tool_use_id: null,
      uuid: "old-summary-msg",
      session_id: "cli-s1",
    });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    expect(session.messageHistory.filter((m) => m.type === "compact_marker")).toHaveLength(0);

    // Phase 2: Resume ends
    session.cliResuming = false;

    // Phase 3: Real compaction from the new /compact
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 60000 },
      uuid: "new-compact-uuid",
      session_id: "cli-s1",
    });
    adapter.emitBrowserMessage({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "New compaction summary" }] },
      parent_tool_use_id: null,
      uuid: "new-summary-msg",
      session_id: "cli-s1",
    });

    // Exactly one marker with the real summary
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    const marker = markers[0] as any;
    expect(marker.summary).toBe("New compaction summary");
    expect(marker.cliUuid).toBe("new-compact-uuid");
    expect(marker.trigger).toBe("manual");

    vi.useRealTimers();
  });
});
