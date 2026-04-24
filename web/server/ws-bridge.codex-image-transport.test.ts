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

describe("Codex image transport", () => {
  // Codex image sends should rely on the same attachment-path text context as
  // Claude sessions, with no native backend image transport.
  //
  // NOTE: handleBrowserMessage does NOT await routeBrowserMessage (fire-and-forget),
  // so tests need a microtask flush after the call for async image operations.

  /** Flush microtask queue so async routeBrowserMessage completes. */
  const flush = () => new Promise((r) => setTimeout(r, 20));

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("sends prepared image refs to Codex without raw-image storage", async () => {
    const adapter = makeCodexAdapterMock();

    const mockImageStore = {
      store: vi.fn(),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-local-paths" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "describe this image",
        deliveryContent:
          "describe this image\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${join(homedir(), ".companion", "images", "s1", "img-1.orig.png")}]`,
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
        client_msg_id: "prepared-client-1",
      }),
    );
    await flush();

    expect(mockImageStore.store).not.toHaveBeenCalled();
    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const firstImageCall = adapter.sendBrowserMessage.mock.calls[0];
    expect(firstImageCall).toBeDefined();
    const sentMsg = (firstImageCall as unknown as [any])[0] as any;
    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    expect(sentMsg.type).toBe("codex_start_pending");
    expect(sentMsg.inputs[0]?.content).toContain(`Attachment 1: ${expectedPath}`);
    expect(sentMsg.inputs[0]?.local_images).toBeUndefined();
    expect(sentMsg.images).toBeUndefined();

    const session = bridge.getSession("s1");
    expect(session?.pendingCodexInputs[0]).toMatchObject({
      clientMsgId: "prepared-client-1",
      content: "describe this image",
      deliveryContent: expect.stringContaining(`Attachment 1: ${expectedPath}`),
      imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
    });
    expect(session?.pendingCodexInputs[0]?.draftImages).toBeUndefined();
    expect((session?.pendingCodexInputs[0] as any)?.localImagePaths).toBeUndefined();
  });

  it("treats pre-uploaded image refs as a normal text-only user message path", async () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-preuploaded-image-paths" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "describe this screenshot",
        deliveryContent:
          "describe this screenshot\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${join(homedir(), ".companion", "images", "s1", "img-1.orig.png")}]`,
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
        client_msg_id: "upload-client-1",
      }),
    );
    await flush();

    const sentMsg = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(sentMsg.type).toBe("codex_start_pending");
    expect(sentMsg.inputs[0]?.content).toContain(
      `Attachment 1: ${join(homedir(), ".companion", "images", "s1", "img-1.orig.png")}`,
    );
    expect(sentMsg.images).toBeUndefined();

    const session = bridge.getSession("s1")!;
    expect(session.pendingCodexInputs[0]).toMatchObject({
      clientMsgId: "upload-client-1",
      content: "describe this screenshot",
      deliveryContent: expect.stringContaining("Attachment 1:"),
      imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
    });
    expect(
      session.messageHistory.some(
        (msg: any) => msg.type === "user_message" && msg.content === "describe this screenshot",
      ),
    ).toBe(false);
  });

  it("preserves browser send order for prepared image messages", async () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-order" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "look at this screenshot",
        deliveryContent:
          "look at this screenshot\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${join(homedir(), ".companion", "images", "s1", "img-queued.orig.png")}]`,
        imageRefs: [{ imageId: "img-queued", media_type: "image/png" }],
      }),
    );
    await flush();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "follow-up text should stay behind the image",
      }),
    );
    await flush();

    const session = bridge.getSession("s1")!;
    expect(session.pendingCodexInputs).toHaveLength(2);
    expect(session.pendingCodexInputs[0]?.content).toBe("look at this screenshot");
    expect(session.pendingCodexInputs[1]?.content).toBe("follow-up text should stay behind the image");
    expect(adapter.sendBrowserMessage).toHaveBeenCalled();

    const firstDispatch = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(firstDispatch?.type).toBe("codex_start_pending");
    expect(firstDispatch.inputs[0]?.content).toContain("look at this screenshot");
    expect(firstDispatch.inputs[0]?.content).toContain(
      `Attachment 1: ${join(homedir(), ".companion", "images", "s1", "img-queued.orig.png")}`,
    );
    expect(firstDispatch.inputs[0]?.local_images).toBeUndefined();

    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "dispatched",
      userContent: expect.stringContaining("look at this screenshot"),
    });

    adapter.emitBrowserMessage({
      type: "stream_event",
      event: {
        type: "message_start",
      },
      parent_tool_use_id: null,
    } as any);

    expect(bridge.getSession("s1")!.state.codex_image_send_stage).toBe("responding");
  });

  it("routes prepared imageRefs successfully even when imageStore would fail (no store call)", async () => {
    // With attach-time uploads, route-time imageStore.store() is never called.
    // Prepared imageRefs bypass the old ingest path entirely.
    const adapter = makeCodexAdapterMock();
    const mockImageStore = {
      store: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-fail-running" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "this image should route successfully with prepared refs",
        deliveryContent:
          "this image should route successfully with prepared refs\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath}]`,
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
      }),
    );
    await flush();

    expect(mockImageStore.store).not.toHaveBeenCalled();
    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const sentMsg = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(sentMsg.type).toBe("codex_start_pending");
    expect(sentMsg.inputs[0]?.content).toContain(`Attachment 1: ${expectedPath}`);
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(calls.find((m: any) => m.type === "error")).toBeUndefined();
  });

  it("dispatches multiple prepared image attachments in a single Codex turn without async storage", async () => {
    // With attach-time uploads, multiple imageRefs are dispatched immediately
    // without any async imageStore operations.
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-concurrency" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const expectedPath1 = join(homedir(), ".companion", "images", "s1", "img-a.orig.png");
    const expectedPath2 = join(homedir(), ".companion", "images", "s1", "img-b.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "inspect both attachments",
        deliveryContent:
          "inspect both attachments\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath1}\n` +
          `Attachment 2: ${expectedPath2}]`,
        imageRefs: [
          { imageId: "img-a", media_type: "image/png" },
          { imageId: "img-b", media_type: "image/png" },
        ],
      }),
    );
    await flush();

    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(1);
    const firstDispatch = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(firstDispatch?.type).toBe("codex_start_pending");
    expect(firstDispatch.inputs[0]?.content).toContain("Attachment 1:");
    expect(firstDispatch.inputs[0]?.content).toContain("Attachment 2:");
  });

  it("dispatches a prepared image-bearing follow-up as a steer while the current Codex turn is active", async () => {
    // With attach-time uploads, image messages are dispatched immediately.
    // When a turn is already active, the follow-up is sent as a codex_steer_pending.
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-overlap" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "finish the current answer",
      }),
    );
    await Promise.resolve();
    adapter.emitTurnStarted("turn-current");

    adapter.sendBrowserMessage.mockClear();
    browser.send.mockClear();

    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-overlap.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "inspect this screenshot after the current sentence",
        deliveryContent:
          "inspect this screenshot after the current sentence\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath}]`,
        imageRefs: [{ imageId: "img-overlap", media_type: "image/png" }],
      }),
    );
    await flush();

    // The follow-up is dispatched immediately as a steer (or queued as a pending turn)
    const session = bridge.getSession("s1")!;
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.content).toBe("inspect this screenshot after the current sentence");

    // Verify the adapter received the message (as steer or start_pending)
    if (adapter.sendBrowserMessage.mock.calls.length > 0) {
      const sentMsg = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
      const content = sentMsg.inputs?.[0]?.content ?? sentMsg.content;
      expect(content).toContain("inspect this screenshot after the current sentence");
      expect(content).toContain(`Attachment 1: ${expectedPath}`);
    }
  });

  it("dispatches a prepared image-bearing follow-up as steer while active streaming continues", async () => {
    // With attach-time uploads, the image follow-up is dispatched immediately
    // as a steer to the active turn (or queued as a pending input).
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-lost-turn-id" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "keep streaming the current turn",
      }),
    );
    await Promise.resolve();
    adapter.emitTurnStarted("turn-current");

    adapter.sendBrowserMessage.mockClear();

    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-lost-turn-id.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "inspect this screenshot once you're done",
        deliveryContent:
          "inspect this screenshot once you're done\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath}]`,
        imageRefs: [{ imageId: "img-lost-turn-id", media_type: "image/png" }],
      }),
    );
    await flush();

    const sessionWhileStreaming = bridge.getSession("s1")!;
    expect(sessionWhileStreaming.isGenerating).toBe(true);
    expect(sessionWhileStreaming.pendingCodexInputs).toHaveLength(1);
    expect(sessionWhileStreaming.pendingCodexInputs[0]?.content).toBe("inspect this screenshot once you're done");

    // The follow-up should have been sent as a steer or queued as a turn
    if (adapter.sendBrowserMessage.mock.calls.length > 0) {
      const sentMsg = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
      const content = sentMsg.inputs?.[0]?.content ?? sentMsg.content;
      expect(content).toContain("inspect this screenshot once you're done");
      expect(content).toContain(`Attachment 1: ${expectedPath}`);
    }
  });

  it("does not go idle when an image-bearing follow-up is still queued behind the current Codex turn", async () => {
    const sid = "codex-image-no-idle-gap";
    const adapter = makeCodexAdapterMock();
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      if (msg.type === "codex_steer_pending") return false;
      return true;
    });
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-no-idle-gap" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start the current response",
      }),
    );
    await Promise.resolve();
    adapter.emitTurnStarted("turn-current");

    browser.send.mockClear();
    adapter.sendBrowserMessage.mockClear();

    const expectedPath = join(homedir(), ".companion", "images", sid, "img-no-idle-gap.orig.png");
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "then inspect this screenshot before you finish",
        deliveryContent:
          "then inspect this screenshot before you finish\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath}]`,
        imageRefs: [{ imageId: "img-no-idle-gap", media_type: "image/png" }],
      }),
    );
    await flush();

    const sessionBeforeResult = bridge.getSession(sid)!;
    expect(sessionBeforeResult.pendingCodexTurns).toHaveLength(2);
    expect(sessionBeforeResult.pendingCodexTurns[1]).toMatchObject({
      status: "queued",
      turnId: null,
      turnTarget: null,
      userContent: expect.stringContaining("then inspect this screenshot before you finish"),
    });

    adapter.sendBrowserMessage.mockClear();
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed current turn body",
        duration_ms: 200,
        duration_api_ms: 200,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "codex-image-no-idle-gap-result",
        session_id: sid,
        codex_turn_id: "turn-current",
      },
    } as any);
    await flush();

    const sessionAfterResult = bridge.getSession(sid)!;
    expect(sessionAfterResult.isGenerating).toBe(true);
    expect(sessionAfterResult.pendingCodexTurns).toHaveLength(1);
    expect(getPendingCodexTurn(sessionAfterResult)).toMatchObject({
      status: "dispatched",
      turnId: null,
      userContent: expect.stringContaining("then inspect this screenshot before you finish"),
    });

    const resultPhaseCalls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(resultPhaseCalls.find((m: any) => m.type === "status_change" && m.status === "idle")).toBeUndefined();
    expect(resultPhaseCalls.find((m: any) => m.type === "status_change" && m.status === "running")).toBeDefined();
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: [
          expect.objectContaining({
            content: expect.stringContaining(
              `Attachment 1: ${join(homedir(), ".companion", "images", sid, "img-no-idle-gap.orig.png")}`,
            ),
          }),
        ],
      }),
    );
  });

  it("queues injected herd events behind an active prepared image turn", async () => {
    // With attach-time uploads, the image turn is dispatched immediately.
    // Herd events injected while the image turn is active are queued as pending inputs.
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-herd-order" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-herd.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "inspect this image before the herd event",
        deliveryContent:
          "inspect this image before the herd event\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath}]`,
        imageRefs: [{ imageId: "img-herd", media_type: "image/png" }],
      }),
    );
    await flush();

    // The image turn should have been dispatched immediately
    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const firstDispatch = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(firstDispatch.inputs[0]?.content).toContain("inspect this image before the herd event");
    expect(firstDispatch.inputs[0]?.content).toContain(`Attachment 1: ${expectedPath}`);

    adapter.emitTurnStarted("turn-image-herd");
    adapter.sendBrowserMessage.mockClear();

    const herdDelivery = bridge.injectUserMessage("s1", "1 event from 1 session\n\n#490 | turn_end | ✓ 5s", {
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });
    expect(herdDelivery).toBe("sent");
    await flush();

    const session = bridge.getSession("s1")!;
    // The herd event should be in pending inputs
    const herdInput = session.pendingCodexInputs.find((i: any) => i.agentSource?.sessionId === "herd-events");
    expect(herdInput).toBeDefined();
    expect(herdInput?.content).toContain("#490 | turn_end");
  });

  it("preserves queued herd delivery behind an active image turn across reconnect", async () => {
    const sid = "codex-image-herd-reconnect";
    const herdContent = "1 event from 1 session\n\n#491 | turn_end | ✓ 9s";
    const expectedPath = join(homedir(), ".companion", "images", sid, "img-reconnect.orig.png");
    const adapter1 = makeCodexAdapterMock();
    adapter1.sendBrowserMessage.mockImplementation((msg: any) => {
      if (msg.type === "codex_steer_pending") return false;
      return true;
    });
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-image-herd-reconnect" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "inspect this screenshot before reconnect",
        deliveryContent: `inspect this screenshot before reconnect\n[📎 Image attachments -- read these files with the Read tool before responding:\nAttachment 1: ${expectedPath}]`,
        imageRefs: [{ imageId: "img-reconnect", media_type: "image/png" }],
      }),
    );
    await flush();
    adapter1.emitTurnStarted("turn-image-reconnect");

    bridge.injectUserMessage(sid, herdContent, {
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });
    await flush();

    const sessionBeforeReconnect = bridge.getSession(sid)!;
    expect(sessionBeforeReconnect.pendingCodexInputs).toHaveLength(1);
    expect(sessionBeforeReconnect.pendingCodexInputs[0]?.content).toBe(herdContent);
    expect(sessionBeforeReconnect.pendingCodexTurns).toHaveLength(2);
    expect(getPendingCodexTurn(sessionBeforeReconnect)).toMatchObject({
      userContent: expect.stringContaining("inspect this screenshot before reconnect"),
      status: "backend_acknowledged",
      turnId: "turn-image-reconnect",
    });
    expect(sessionBeforeReconnect.pendingCodexTurns[1]).toMatchObject({
      status: "queued",
      userContent: herdContent,
      turnId: null,
    });

    adapter1.emitDisconnect("turn-image-reconnect");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    const reconnectImageTurnText = getPendingCodexTurn(bridge.getSession(sid)!)?.userContent;
    adapter2.emitSessionMeta({
      cliSessionId: "thread-image-herd-reconnect",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-image-herd-reconnect",
        turnCount: 4,
        lastTurn: {
          id: "turn-image-reconnect",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              content: [{ type: "text", text: reconnectImageTurnText }],
            },
            {
              type: "agentMessage",
              text: "I inspected the screenshot and recovered the turn.",
            },
          ],
        },
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: [expect.objectContaining({ content: herdContent })],
      }),
    );
    const sessionAfterReconnect = bridge.getSession(sid)!;
    expect(sessionAfterReconnect.pendingCodexTurns).toHaveLength(1);
    expect(getPendingCodexTurn(sessionAfterReconnect)).toMatchObject({
      status: "dispatched",
      userContent: herdContent,
    });
  });

  it("keeps later herd retries queued when cancelling another pending herd input behind an active image turn", async () => {
    const sid = "codex-image-herd-cancel";
    const herdOne = "1 event from 1 session\n\n#492 | turn_end | ✓ 6s";
    const herdTwo = "1 event from 1 session\n\n#493 | turn_end | ✓ 4s";
    const adapter = makeCodexAdapterMock();
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      if (msg.type === "codex_steer_pending") return false;
      return true;
    });
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-herd-cancel" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    const imgPath = join(homedir(), ".companion", "images", sid, "img-cancel.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hold this screenshot turn open",
        deliveryContent: `hold this screenshot turn open\n[📎 Image attachments -- read these files with the Read tool before responding:\nAttachment 1: ${imgPath}]`,
        imageRefs: [{ imageId: "img-cancel", media_type: "image/png" }],
      }),
    );
    await flush();
    adapter.emitTurnStarted("turn-image-cancel");

    bridge.injectUserMessage(sid, herdOne, {
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });
    await flush();
    bridge.injectUserMessage(sid, herdTwo, {
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });
    await flush();

    const session = bridge.getSession(sid)!;
    expect(session.pendingCodexInputs).toHaveLength(2);
    expect(session.pendingCodexTurns).toHaveLength(2);
    expect(session.pendingCodexTurns[1]).toMatchObject({
      status: "queued",
      userContent: `${herdOne}\n\n${herdTwo}`,
    });

    const herdTwoId = session.pendingCodexInputs.find((input: any) => input.content === herdTwo)?.id;
    expect(herdTwoId).toBeTruthy();
    if (!herdTwoId) throw new Error("missing second herd pending id");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: herdTwoId,
      }),
    );
    await flush();

    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.content).toBe(herdOne);
    expect(session.pendingCodexTurns).toHaveLength(2);
    expect(session.pendingCodexTurns[1]).toMatchObject({
      status: "queued",
      userContent: herdOne,
      turnId: null,
    });
  });

  it("cancels a prepared Codex image input without keeping raw image bytes", async () => {
    const mockImageStore = {
      store: vi.fn(),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.getOrCreateSession("s1", "codex");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "restore this image",
        deliveryContent:
          "restore this image\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${join(homedir(), ".companion", "images", "s1", "img-1.orig.png")}]`,
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
        client_msg_id: "prepared-client-cancel",
      }),
    );
    await flush();

    expect(mockImageStore.store).not.toHaveBeenCalled();
    const session = bridge.getSession("s1")!;
    const pendingId = session.pendingCodexInputs[0]?.id;
    expect(pendingId).toBeTruthy();
    expect(session.pendingCodexInputs[0]?.cancelable).toBe(true);
    expect(session.pendingCodexInputs[0]?.draftImages).toBeUndefined();
    expect(session.pendingCodexInputs[0]?.deliveryContent).toContain("Attachment 1:");
    expect(session.pendingCodexInputs[0]?.imageRefs).toEqual([{ imageId: "img-1", media_type: "image/png" }]);
    expect(session.pendingCodexTurns).toHaveLength(1);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: pendingId,
      }),
    );
    await flush();

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "restore this image"),
    ).toBe(false);
  });

  it("advances delivery to the next pending input when the current head is cancelled", async () => {
    // The q-326 fix has two halves: canceling a newer pending item must not
    // dispatch an older item, but canceling the current head should still let
    // the next pending input advance through the queue.
    const adapter = makeCodexAdapterMock();
    let startPendingAttempts = 0;
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      if (msg.type === "codex_start_pending") {
        startPendingAttempts += 1;
        return startPendingAttempts > 1;
      }
      return true;
    });
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-q326-cancel-head-advance" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "first pending item",
      }),
    );
    await Promise.resolve();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "second pending item",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession("s1")!;
    expect(session.pendingCodexInputs).toHaveLength(2);
    const firstPendingId = session.pendingCodexInputs[0]?.id;
    expect(firstPendingId).toBeTruthy();
    if (!firstPendingId) throw new Error("missing first pending id");

    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: firstPendingId,
      }),
    );
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.content).toBe("second pending item");
    expect(startPendingAttempts).toBe(2);
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: [expect.objectContaining({ content: "second pending item" })],
      }),
    );
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "dispatched",
      userContent: "second pending item",
    });
  });

  it("does not dispatch an older pending image when cancelling a newer herd-event pending input", async () => {
    // q-326 incident guard: a later pending herd event should be cancelable
    // without that cancel action silently delivering an older stuck image turn.
    const adapter = makeCodexAdapterMock();
    let startPendingAttempts = 0;
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      if (msg.type === "codex_start_pending") {
        startPendingAttempts += 1;
        return false;
      }
      return true;
    });
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-q326-cancel-mixup" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const imgPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please inspect this screenshot",
        deliveryContent: `Please inspect this screenshot\n[📎 Image attachments -- read these files with the Read tool before responding:\nAttachment 1: ${imgPath}]`,
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
      }),
    );
    await flush();

    const herdContent = "1 event from 1 session\n\n#472 | turn_end | ✓ 6m 41s";
    bridge.injectUserMessage("s1", herdContent, {
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });
    await flush();

    const session = bridge.getSession("s1")!;
    expect(session.pendingCodexInputs).toHaveLength(2);
    const imagePendingId = session.pendingCodexInputs[0]?.id;
    const herdPendingId = session.pendingCodexInputs[1]?.id;
    expect(imagePendingId).toBeTruthy();
    expect(herdPendingId).toBeTruthy();
    if (!imagePendingId || !herdPendingId) throw new Error("missing pending ids");

    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: herdPendingId,
      }),
    );
    await flush();

    expect(startPendingAttempts).toBe(1);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.id).toBe(imagePendingId);
    expect(session.pendingCodexInputs[0]?.content).toContain("Please inspect this screenshot");
    expect(session.pendingCodexTurns).toHaveLength(1);
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "queued",
      userContent: expect.stringContaining("Please inspect this screenshot"),
    });
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: [expect.objectContaining({ content: expect.stringContaining("Please inspect this screenshot") })],
      }),
    );
    expect(
      session.messageHistory.some(
        (msg: any) => msg.type === "user_message" && msg.content === "Please inspect this screenshot",
      ),
    ).toBe(false);
  });

  it("does not require original path lookups for Codex image turns", async () => {
    // With attach-time uploads, no imageStore interaction needed at route time.
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-text-only" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "what is this?",
        deliveryContent:
          "what is this?\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath}]`,
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
      }),
    );
    await flush();

    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const sentMsg = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(sentMsg.type).toBe("codex_start_pending");
    expect(sentMsg.inputs[0]?.content).toContain(`Attachment 1: ${expectedPath}`);
    expect(sentMsg.inputs[0]?.local_images).toBeUndefined();
  });

  it("sends all Codex image attachments as ordered path annotations without native image transport", async () => {
    // With attach-time uploads, multiple imageRefs are delivered via
    // deliveryContent path annotations, no imageStore needed.
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-multi" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const expectedPath1 = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    const expectedPath2 = join(homedir(), ".companion", "images", "s1", "img-2.orig.png");
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "compare these images",
        deliveryContent:
          "compare these images\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${expectedPath1}\n` +
          `Attachment 2: ${expectedPath2}]`,
        imageRefs: [
          { imageId: "img-1", media_type: "image/png" },
          { imageId: "img-2", media_type: "image/png" },
        ],
      }),
    );
    await flush();

    const firstMultiImageCall = adapter.sendBrowserMessage.mock.calls[0];
    expect(firstMultiImageCall).toBeDefined();
    const sentMsg = (firstMultiImageCall as unknown as [any])[0] as any;
    expect(sentMsg.type).toBe("codex_start_pending");
    expect(sentMsg.inputs[0]?.content).toContain(`Attachment 1: ${expectedPath1}`);
    expect(sentMsg.inputs[0]?.content).toContain(`Attachment 2: ${expectedPath2}`);
    expect(sentMsg.inputs[0]?.local_images).toBeUndefined();
    expect(sentMsg.images).toBeUndefined();
  });

  it("does not require imageStore for prepared Codex image turns", async () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-no-store-prepared" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "no store",
        deliveryContent:
          "no store\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${join(homedir(), ".companion", "images", "s1", "img-prepared.orig.png")}]`,
        imageRefs: [{ imageId: "img-prepared", media_type: "image/png" }],
        client_msg_id: "prepared-client-no-store",
      }),
    );
    await flush();

    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const sentMsg = adapter.sendBrowserMessage.mock.calls[0]?.[0] as any;
    expect(sentMsg.type).toBe("codex_start_pending");
    expect(sentMsg.inputs[0]?.content).toContain(
      `Attachment 1: ${join(homedir(), ".companion", "images", "s1", "img-prepared.orig.png")}`,
    );
    expect(sentMsg.inputs[0]?.local_images).toBeUndefined();
    expect(sentMsg.images).toBeUndefined();
    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(browserCalls.find((msg: any) => msg.type === "error")).toBeUndefined();
  });

  it("requests Codex recovery when a prepared image send lands before the restarted adapter reconnects", async () => {
    const sid = "codex-image-reconnect-window";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({
        backendType: "codex",
        state: "connected",
        cliSessionId: "thread-reconnect-window",
        killedByIdleManager: false,
      })),
    } as any);

    const adapter = makeCodexAdapterMock();
    adapter.isConnected.mockReturnValue(true);
    const mockImageStore = {
      store: vi.fn(),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter(sid, adapter as any);

    const session = bridge.getSession(sid)!;
    session.messageHistory.push({
      type: "user_message",
      content: "previous restored turn",
      timestamp: Date.now() - 1000,
      id: "user-restored-1",
    } as any);
    session.state.backend_state = "connected";

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();
    relaunchCb.mockClear();

    adapter.isConnected.mockReturnValue(false);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "describe this image after restart",
        deliveryContent:
          "describe this image after restart\n[📎 Image attachments -- read these files with the Read tool before responding:\n" +
          `Attachment 1: ${join(homedir(), ".companion", "images", sid, "img-reconnect.orig.png")}]`,
        imageRefs: [{ imageId: "img-reconnect", media_type: "image/png" }],
        client_msg_id: "upload-client-reconnect",
      }),
    );
    await flush();

    expect(mockImageStore.store).not.toHaveBeenCalled();
    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(bridge.getSession(sid)!.state.backend_state).toBe("recovering");
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ backend_state: "recovering", backend_error: null }),
      }),
    );
  });
});
