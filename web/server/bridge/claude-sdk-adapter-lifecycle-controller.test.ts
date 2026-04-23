import { afterEach, describe, expect, it, vi } from "vitest";
import { attachClaudeSdkAdapterLifecycle } from "./claude-sdk-adapter-lifecycle-controller.js";

function makeAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;

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
    sendBrowserMessage: vi.fn(),
    drainPendingOutgoing: vi.fn((): any[] => []),
    disconnect: vi.fn(async () => {}),
    emitBrowserMessage: (msg: any) => onBrowserMessageCb?.(msg),
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: () => onDisconnectCb?.(),
    emitInitError: (error: string) => onInitErrorCb?.(error),
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    backendType: "claude-sdk",
    state: {
      backend_type: "claude-sdk",
      cwd: "/repo",
      is_compacting: false,
      permissionMode: "default",
    },
    claudeSdkAdapter: null,
    pendingMessages: [],
    pendingPermissions: new Map(),
    messageHistory: [],
    cliInitReceived: false,
    cliResuming: false,
    cliResumingClearTimer: null,
    forceCompactPending: false,
    awaitingCompactSummary: false,
    compactedDuringTurn: false,
    lastCliMessageAt: null,
    consecutiveAdapterFailures: 0,
    lastAdapterFailureAt: null,
    queuedTurnStarts: 0,
    queuedTurnReasons: [],
    queuedTurnUserMessageIds: [],
    queuedTurnInterruptSources: [],
    browserSockets: new Set([{}]),
    ...overrides,
  } as any;
}

function makeDeps(session: any, launcherInfo: any = null) {
  return {
    getOrCreateSession: vi.fn(() => session),
    getLauncherSessionInfo: vi.fn(() => launcherInfo),
    onOrchestratorTurnEnd: vi.fn(),
    touchActivity: vi.fn(),
    clearOptimisticRunningTimer: vi.fn(),
    hasPendingForceCompact: vi.fn(() => false),
    broadcastToBrowsers: vi.fn(),
    handleSdkBrowserMessage: vi.fn(() => true),
    refreshGitInfoThenRecomputeDiff: vi.fn(),
    persistSession: vi.fn(),
    handleSdkPermissionRequest: vi.fn(),
    setCliSessionId: vi.fn(),
    markTurnInterrupted: vi.fn(),
    setGenerating: vi.fn(),
    requestCliRelaunch: vi.fn(),
    isCurrentSession: vi.fn(() => true),
    maxAdapterRelaunchFailures: 3,
    adapterFailureResetWindowMs: 10_000,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("claude-sdk-adapter-lifecycle-controller", () => {
  it("ignores stale adapter callbacks after a replacement adapter attaches", () => {
    const session = makeSession();
    const deps = makeDeps(session);
    const adapter1 = makeAdapterMock();
    attachClaudeSdkAdapterLifecycle("s1", adapter1, deps);

    const adapter2 = makeAdapterMock();
    attachClaudeSdkAdapterLifecycle("s1", adapter2, deps);

    deps.broadcastToBrowsers.mockClear();
    deps.handleSdkBrowserMessage.mockClear();
    deps.requestCliRelaunch.mockClear();
    deps.setGenerating.mockClear();

    adapter1.emitBrowserMessage({ type: "assistant", message: { content: [] } });
    adapter1.emitDisconnect();
    adapter1.emitInitError("stale failure");
    adapter1.emitSessionMeta({ cliSessionId: "stale-cli-id", model: "stale-model" });

    expect(deps.handleSdkBrowserMessage).not.toHaveBeenCalled();
    expect(deps.requestCliRelaunch).not.toHaveBeenCalled();
    expect(deps.setGenerating).not.toHaveBeenCalled();
    expect(deps.broadcastToBrowsers).not.toHaveBeenCalled();
    expect(deps.setCliSessionId).not.toHaveBeenCalled();
    expect(session.state.model).toBeUndefined();
    expect(session.claudeSdkAdapter).toBe(adapter2);
  });

  it("does not let a stale replay timer flush through an old adapter after replacement", () => {
    vi.useFakeTimers();

    const session = makeSession({
      messageHistory: [{ type: "assistant", message: { id: "a1", content: [] } }],
      pendingMessages: [JSON.stringify({ type: "user", message: { role: "user", content: "queued" } })],
    });
    const deps = makeDeps(session, { cliSessionId: "resume-cli-id" });
    const adapter1 = makeAdapterMock();
    attachClaudeSdkAdapterLifecycle("s1", adapter1, deps);

    adapter1.emitBrowserMessage({ type: "status_change", status: "running" });
    expect(session.cliResuming).toBe(true);

    const adapter2 = makeAdapterMock();
    attachClaudeSdkAdapterLifecycle("s1", adapter2, deps);
    adapter1.sendBrowserMessage.mockClear();

    vi.advanceTimersByTime(2000);

    expect(adapter1.sendBrowserMessage).not.toHaveBeenCalled();
    expect(session.claudeSdkAdapter).toBe(adapter2);
    expect(session.cliResuming).toBe(true);
  });

  it("requests relaunch on init error for an active browser session", () => {
    const session = makeSession();
    const deps = makeDeps(session);
    const adapter = makeAdapterMock();

    attachClaudeSdkAdapterLifecycle("s1", adapter, deps);
    deps.broadcastToBrowsers.mockClear();
    deps.requestCliRelaunch.mockClear();

    adapter.emitInitError("Transport closed");

    expect(session.claudeSdkAdapter).toBeNull();
    expect(session.cliInitReceived).toBe(false);
    expect(session.consecutiveAdapterFailures).toBe(1);
    expect(session.lastAdapterFailureAt).not.toBeNull();
    expect(deps.markTurnInterrupted).toHaveBeenCalledWith(session, "system");
    expect(deps.setGenerating).toHaveBeenCalledWith(session, false, "sdk_init_error");
    expect(deps.requestCliRelaunch).toHaveBeenCalledWith("s1");
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: "backend_disconnected" }),
    );
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ type: "status_change", status: "idle" }),
    );
  });

  it("applies the same relaunch cap to init errors as disconnects", () => {
    const session = makeSession();
    const deps = makeDeps(session);

    for (let i = 0; i < 4; i++) {
      const adapter = makeAdapterMock();
      attachClaudeSdkAdapterLifecycle("s1", adapter, deps);
      adapter.emitInitError(`failure-${i + 1}`);
    }

    expect(deps.requestCliRelaunch).toHaveBeenCalledTimes(3);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(
      session,
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Session stopped after 3 consecutive launch failures"),
      }),
    );
  });

  // Verifies that stale pendingPermissions are cleared when the SDK adapter
  // disconnects, preventing takode answer from resolving the wrong request_id
  // after a reconnect.
  it("clears pending permissions and broadcasts cancellation on adapter disconnect", () => {
    const session = makeSession();
    session.pendingPermissions.set("req-stale", {
      request_id: "req-stale",
      tool_name: "ExitPlanMode",
      input: { plan: "old plan" },
      tool_use_id: "tool-1",
      timestamp: 1000,
    });
    const deps = makeDeps(session);
    const adapter = makeAdapterMock();
    attachClaudeSdkAdapterLifecycle("s1", adapter, deps);

    adapter.emitDisconnect();

    expect(session.pendingPermissions.size).toBe(0);
    expect(deps.broadcastToBrowsers).toHaveBeenCalledWith(session, {
      type: "permission_cancelled",
      request_id: "req-stale",
    });
  });
});
