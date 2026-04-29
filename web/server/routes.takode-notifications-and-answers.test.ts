import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock env-manager and git-utils modules before any imports
vi.mock("./env-manager.js", () => ({
  listEnvs: vi.fn(() => Promise.resolve([])),
  getEnv: vi.fn(() => Promise.resolve(null)),
  getEffectiveImage: vi.fn(() => Promise.resolve(null)),
  createEnv: vi.fn(() => Promise.resolve(undefined)),
  updateEnv: vi.fn(() => Promise.resolve(undefined)),
  deleteEnv: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("node:child_process", () => {
  const execSyncMock = vi.fn((_cmd?: string) => "" as any);
  // exec mock: callback-based, delegates to execSync for consistent test behavior.
  // Attaches stdout/stderr to the error object so promisify(exec) can find them,
  // matching Node's custom exec promisify behavior.
  const execMock = vi.fn((...args: any[]) => {
    const cmd = args[0] as string;
    const callback = typeof args[1] === "function" ? args[1] : args[2];
    try {
      const result = execSyncMock(cmd);
      if (callback) callback(null, { stdout: result ?? "", stderr: "" });
    } catch (err) {
      const e = err as any;
      if (e.stdout === undefined) e.stdout = "";
      if (e.stderr === undefined) e.stderr = "";
      if (callback) callback(err, { stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
    }
  });
  return { execSync: execSyncMock, exec: execMock };
});

const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string) => null as string | null));
const mockExpandTilde = vi.hoisted(() => vi.fn((p: string) => p)); // pass-through by default
const mockCaptureUserShellEnv = vi.hoisted(() => vi.fn((_varNames: string[]) => ({}) as Record<string, string>));
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  expandTilde: mockExpandTilde,
  captureUserShellEnv: mockCaptureUserShellEnv,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => ""),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    stat: vi.fn((...args: Parameters<typeof actual.stat>) => actual.stat(...args)),
    access: vi.fn(async () => {}), // default: file exists (no throw)
  };
});

vi.mock("./git-utils.js", () => ({
  getRepoInfo: vi.fn(() => null),
  getRepoInfoAsync: vi.fn(async () => null),
  listBranches: vi.fn(() => []),
  listBranchesAsync: vi.fn(async () => []),
  listWorktrees: vi.fn(() => []),
  listWorktreesAsync: vi.fn(async () => []),
  ensureWorktree: vi.fn(),
  ensureWorktreeAsync: vi.fn(),
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitFetchAsync: vi.fn(async () => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  gitPullAsync: vi.fn(async () => ({ success: true, output: "" })),
  checkoutBranch: vi.fn(),
  checkoutBranchAsync: vi.fn(async () => {}),
  removeWorktree: vi.fn(),
  removeWorktreeAsync: vi.fn(async () => ({ removed: true })),
  isWorktreeDirty: vi.fn(() => false),
  isWorktreeDirtyAsync: vi.fn(async () => false),
  archiveBranchAsync: vi.fn(async () => true),
  resolveDefaultBranch: vi.fn(() => "main"),
  getBranchStatus: vi.fn(() => ({ ahead: 0, behind: 0 })),
  deleteArchivedRefAsync: vi.fn(async () => {}),
}));

vi.mock("./session-names.js", () => ({
  getName: vi.fn(() => undefined),
  setName: vi.fn(),
  getAllNames: vi.fn(() => ({})),
  removeName: vi.fn(),
  getNextLeaderNumber: vi.fn(() => 1),
  _resetForTest: vi.fn(),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: "",
    pushoverApiToken: "",
    pushoverDelaySeconds: 30,
    pushoverEnabled: true,
    pushoverEventFilters: { needsInput: true, review: true, error: true },
    pushoverBaseUrl: "",
    claudeBinary: "",
    codexBinary: "",
    maxKeepAlive: 0,
    heavyRepoModeEnabled: false,
    autoApprovalEnabled: false,
    autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4,
    autoApprovalTimeoutSeconds: 45,
    namerConfig: { backend: "claude" },
    autoNamerEnabled: true,
    transcriptionConfig: {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: true,
      enhancementModel: "gpt-5-mini",
    },
    editorConfig: { editor: "none" },
    defaultClaudeBackend: "claude",
    sleepInhibitorEnabled: false,
    sleepInhibitorDurationMinutes: 5,
    questmasterViewMode: "cards",
    updatedAt: 0,
  })),
  updateSettings: vi.fn((patch) => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: patch.pushoverUserKey ?? "",
    pushoverApiToken: patch.pushoverApiToken ?? "",
    pushoverDelaySeconds: patch.pushoverDelaySeconds ?? 30,
    pushoverEnabled: patch.pushoverEnabled ?? true,
    pushoverEventFilters: patch.pushoverEventFilters ?? { needsInput: true, review: true, error: true },
    pushoverBaseUrl: patch.pushoverBaseUrl ?? "",
    claudeBinary: patch.claudeBinary ?? "",
    codexBinary: patch.codexBinary ?? "",
    maxKeepAlive: patch.maxKeepAlive ?? 0,
    heavyRepoModeEnabled: patch.heavyRepoModeEnabled ?? false,
    autoApprovalEnabled: patch.autoApprovalEnabled ?? false,
    autoApprovalModel: patch.autoApprovalModel ?? "haiku",
    autoApprovalMaxConcurrency: patch.autoApprovalMaxConcurrency ?? 4,
    autoApprovalTimeoutSeconds: patch.autoApprovalTimeoutSeconds ?? 45,
    namerConfig: patch.namerConfig ?? { backend: "claude" },
    autoNamerEnabled: patch.autoNamerEnabled ?? true,
    transcriptionConfig: patch.transcriptionConfig ?? {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: true,
      enhancementModel: "gpt-5-mini",
    },
    editorConfig: patch.editorConfig ?? { editor: "none" },
    defaultClaudeBackend: patch.defaultClaudeBackend ?? "claude",
    sleepInhibitorEnabled: patch.sleepInhibitorEnabled ?? false,
    sleepInhibitorDurationMinutes: patch.sleepInhibitorDurationMinutes ?? 5,
    questmasterViewMode: patch.questmasterViewMode ?? "cards",
    updatedAt: Date.now(),
  })),
  getServerName: vi.fn(() => ""),
  setServerName: vi.fn(),
  getServerId: vi.fn(() => "test-server-id"),
  getClaudeUserDefaultModel: vi.fn(async () => ""),
}));

const mockGetUsageLimits = vi.hoisted(() => vi.fn());
vi.mock("./usage-limits.js", () => ({
  getUsageLimits: mockGetUsageLimits,
}));

import { Hono } from "hono";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildOrchestratorSystemPrompt, createRoutes } from "./routes.js";
import { _resetModelCache } from "./routes/system.js";
import { trafficStats } from "./traffic-stats.js";
import { _resetServerLoggerForTest, createLogger, initServerLogger } from "./server-logger.js";
import * as serverLoggerModule from "./server-logger.js";
import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import * as questStore from "./quest-store.js";
import * as sessionNames from "./session-names.js";
import * as settingsManager from "./settings-manager.js";
import * as transcriptionEnhancer from "./transcription-enhancer.js";
import { containerManager } from "./container-manager.js";

// ─── Mock factories ──────────────────────────────────────────────────────────

function createMockLauncher() {
  return {
    launch: vi.fn(() => ({
      sessionId: "session-1",
      state: "starting",
      cwd: "/test",
      createdAt: Date.now(),
    })),
    kill: vi.fn(async () => true),
    isAlive: vi.fn(() => true),
    relaunch: vi.fn(async () => ({ ok: true })),
    relaunchWithResumeAt: vi.fn(async () => ({ ok: true })),
    listSessions: vi.fn(() => []),
    getSession: vi.fn(),
    setArchived: vi.fn(),
    setWorktreeCleanupState: vi.fn(),
    updateWorktree: vi.fn(),
    removeSession: vi.fn(),
    getOrchestratorGuardrails: vi.fn(() => "# Takode — Cross-Session Orchestration\n..."),
    getPort: vi.fn(() => 3456),
    verifySessionAuthToken: vi.fn(() => true),
    herdSessions: vi.fn(() => ({ herded: [], notFound: [], conflicts: [], reassigned: [], leaders: [] })),
    unherdSession: vi.fn(() => false),
    getHerdedSessions: vi.fn(() => []),
    // resolveSessionId: pass-through for exact UUIDs (used by resolveId helper in routes)
    resolveSessionId: vi.fn((id: string) => id),
    getSessionNum: vi.fn(() => undefined),
  } as any;
}

function createMockBridge() {
  return {
    _sessions: {} as Record<string, any>,
    _vscodeSelectionState: null as any,
    _vscodeWindows: [] as any[],
    closeSession: vi.fn(),
    getSession: vi.fn(function (this: any, sessionId: string) {
      if (sessionId in this._sessions) return this._sessions[sessionId];
      const stateEntries = this.getAllSessions();
      const stateEntry = Array.isArray(stateEntries)
        ? stateEntries.find((entry: any) => entry?.session_id === sessionId || entry?.sessionId === sessionId)
        : null;
      const messageHistory = this.getMessageHistory(sessionId) ?? [];
      if (!stateEntry && messageHistory.length === 0) {
        return null;
      }
      return {
        id: sessionId,
        state: stateEntry?.state ?? stateEntry ?? {},
        messageHistory,
        notifications: [],
        pendingPermissions: new Map(),
        taskHistory: [],
        keywords: [],
        lastReadAt: 0,
        attentionReason: null,
        isGenerating: false,
      };
    }),
    getOrCreateSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    refreshWorktreeGitStateForSnapshot: vi.fn(async () => null),
    getLastUserMessage: vi.fn(() => undefined),
    isBackendConnected: vi.fn(() => false),
    markWorktree: vi.fn(),
    applyInitialSessionState: vi.fn(),
    setDiffBaseBranch: vi.fn(() => true),
    refreshGitInfoPublic: vi.fn(async () => true),
    onSessionArchived: vi.fn(),
    onSessionUnarchived: vi.fn(),
    persistSessionById: vi.fn(),
    broadcastToSession: vi.fn(),
    broadcastGlobal: vi.fn(),
    getVsCodeSelectionState: vi.fn(function (this: any) {
      return this._vscodeSelectionState;
    }),
    updateVsCodeSelectionState: vi.fn(function (this: any, state: any) {
      this._vscodeSelectionState = state;
      return true;
    }),
    getVsCodeWindowStates: vi.fn(function (this: any) {
      return this._vscodeWindows;
    }),
    upsertVsCodeWindowState: vi.fn(function (this: any, state: any) {
      const next = {
        ...state,
        workspaceRoots: [...(state.workspaceRoots ?? [])],
        lastSeenAt: 9999,
      };
      this._vscodeWindows = [...this._vscodeWindows.filter((window: any) => window.sourceId !== state.sourceId), next];
      return next;
    }),
    pollVsCodeOpenFileCommands: vi.fn(() => []),
    resolveVsCodeOpenFileResult: vi.fn(() => true),
    requestVsCodeOpenFile: vi.fn(async () => ({ sourceId: "window-a", commandId: "cmd-1" })),
    addTaskEntry: vi.fn(),
    updateQuestTaskEntries: vi.fn(),
    removeBoardRowFromAll: vi.fn(),
    prepareSessionForRevert: vi.fn(
      (sessionId: string, truncateIdx: number, options?: { clearCodexState?: boolean }) => {
        const session = bridge.getOrCreateSession.mock.results.at(-1)?.value;
        if (!session) return null;
        session.messageHistory = session.messageHistory.slice(0, truncateIdx);
        session.frozenCount = Math.min(session.frozenCount ?? 0, session.messageHistory.length);
        session.assistantAccumulator?.clear?.();
        session.pendingMessages = [];
        session.lastOutboundUserNdjson = null;
        session.userMessageIdsThisTurn = [];
        session.queuedTurnStarts = 0;
        session.queuedTurnReasons = [];
        session.queuedTurnUserMessageIds = [];
        session.queuedTurnInterruptSources = [];
        session.interruptedDuringTurn = false;
        session.interruptSourceDuringTurn = null;
        session.isGenerating = false;
        session.generationStartedAt = null;
        session.disconnectWasGenerating = false;
        session.seamlessReconnect = false;
        session.toolStartTimes?.clear?.();
        session.toolProgressOutput?.clear?.();
        session.dropReplayHistoryAfterRevert = session.backendType === "claude" || session.backendType === "claude-sdk";
        session.pendingPermissions?.clear?.();
        session.eventBuffer = [];
        session.awaitingCompactSummary = false;
        session.claudeCompactBoundarySeen = false;
        session.compactedDuringTurn = false;
        session.forceCompactPending = false;
        if (session.state) session.state.is_compacting = false;
        if (options?.clearCodexState) {
          session.pendingCodexTurns = [];
          session.pendingCodexInputs = [];
          session.pendingCodexRollback = null;
          session.pendingCodexRollbackError = null;
          if (session.optimisticRunningTimer) session.optimisticRunningTimer = null;
          bridge.broadcastToSession(sessionId, { type: "codex_pending_inputs", inputs: [] });
        }
        bridge.broadcastToSession(sessionId, { type: "permissions_cleared" });
        return session;
      },
    ),
    beginCodexRollback: vi.fn(
      (sessionId: string, plan: { numTurns: number; truncateIdx: number; clearCodexState: boolean }) => {
        const session = bridge.getOrCreateSession.mock.results.at(-1)?.value;
        const adapter = session?.codexAdapter;
        if (adapter?.isConnected?.() && adapter.rollbackTurns) {
          return {
            promise: adapter.rollbackTurns(plan.numTurns).then(() => {
              const reverted = bridge.prepareSessionForRevert(sessionId, plan.truncateIdx, {
                clearCodexState: plan.clearCodexState,
              });
              bridge.persistSessionSync(sessionId);
              bridge.broadcastToSession(sessionId, { type: "message_history", messages: reverted.messageHistory });
              bridge.broadcastToSession(sessionId, { type: "status_change", status: "idle" });
            }),
            requiresRelaunch: false,
          };
        }
        return { promise: Promise.resolve(), requiresRelaunch: true };
      },
    ),
    persistSessionSync: vi.fn(),
    getMessageHistory: vi.fn(() => []),
    getToolResult: vi.fn(() => null),
    injectUserMessage: vi.fn(() => "sent" as const),
    emitTakodeEvent: vi.fn(),
    subscribeTakodeEvents: vi.fn(() => () => {}),
    routeExternalPermissionResponse: vi.fn(),
    routeExternalInterrupt: vi.fn(async () => {}),
    routeBrowserMessage: vi.fn(function (this: any, session: any, msg: any) {
      if (msg?.type === "permission_response") {
        return this.routeExternalPermissionResponse(
          session,
          {
            type: "permission_response",
            request_id: msg.request_id,
            behavior: msg.behavior,
            ...(msg.updated_input ? { updated_input: msg.updated_input } : {}),
            ...(msg.message ? { message: msg.message } : {}),
          },
          msg.actorSessionId,
        );
      }
      if (msg?.type === "interrupt") {
        return this.routeExternalInterrupt(session, msg.interruptSource);
      }
      return undefined;
    }),
    getTrafficStatsSnapshot: vi.fn(() => ({
      windowStartedAt: 1000,
      capturedAt: 2000,
      totals: { messages: 1, payloadBytes: 10, wireBytes: 10 },
      buckets: [],
      sessions: {},
      historySyncBreakdown: {
        totals: {
          requests: 0,
          frozenDeltaBytes: 0,
          hotMessagesBytes: 0,
          frozenDeltaMessages: 0,
          hotMessagesCount: 0,
        },
        sessions: {},
      },
      toolResultFetches: {
        totals: { requests: 0, repeatedRequests: 0, payloadBytes: 0, errorRequests: 0 },
        sessions: {},
        topRepeated: [],
      },
    })),
    resetTrafficStats: vi.fn(),
  } as any;
}

function ensureBridgeSession(
  bridge: ReturnType<typeof createMockBridge>,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  return (bridge._sessions[sessionId] = {
    id: sessionId,
    state: {},
    browserSockets: new Set(),
    messageHistory: [],
    notifications: [],
    pendingPermissions: new Map(),
    taskHistory: [],
    keywords: [],
    lastReadAt: 0,
    attentionReason: null,
    isGenerating: false,
    ...overrides,
  });
}

function createMockStore() {
  return {
    setArchived: vi.fn(async () => true),
    flushAll: vi.fn(async () => {}),
  } as any;
}

function createMockRecorder() {
  return {
    getRecordingsDir: vi.fn(() => "/tmp/companion-recordings"),
    isGloballyEnabled: vi.fn(() => true),
    getMaxLines: vi.fn(() => 500000),
    isRecording: vi.fn(() => true),
    getRecordingStatus: vi.fn(() => ({ filePath: "/tmp/companion-recordings/session-1.jsonl" })),
    enableForSession: vi.fn(),
    disableForSession: vi.fn(),
    listRecordings: vi.fn(async () => []),
  } as any;
}

function createMockTimerManager() {
  return {
    createTimer: vi.fn(),
    listTimers: vi.fn(() => []),
    cancelTimer: vi.fn(async () => true),
    cancelAllTimers: vi.fn(async () => {}),
  } as any;
}

function createMockTracker() {
  return {
    addMapping: vi.fn(),
    getBySession: vi.fn(() => null),
    removeBySession: vi.fn(),
    isWorktreeInUse: vi.fn(() => false),
  } as any;
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let app: Hono;
let launcher: ReturnType<typeof createMockLauncher>;
let bridge: ReturnType<typeof createMockBridge>;
let sessionStore: ReturnType<typeof createMockStore>;
let tracker: ReturnType<typeof createMockTracker>;
let recorder: ReturnType<typeof createMockRecorder>;
let timerManager: ReturnType<typeof createMockTimerManager>;

beforeEach(() => {
  vi.clearAllMocks();
  trafficStats.reset();
  _resetServerLoggerForTest();
  // Reset the LiteLLM model cache so each test starts clean.
  _resetModelCache();
  // Stub global fetch to prevent LiteLLM proxy calls in tests.
  // Model endpoint tests exercise the fallback path (models_cache.json).
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no proxy in tests"))),
  );
  launcher = createMockLauncher();
  bridge = createMockBridge();
  sessionStore = createMockStore();
  tracker = createMockTracker();
  recorder = createMockRecorder();
  timerManager = createMockTimerManager();
  app = new Hono();
  const terminalManager = { getInfo: () => null, spawn: () => "", kill: () => {} } as any;
  app.route(
    "/api",
    createRoutes(
      launcher,
      bridge,
      sessionStore,
      tracker,
      terminalManager,
      undefined,
      recorder,
      undefined,
      timerManager,
    ),
  );

  // Default no-op mocks for container workspace isolation (called during container session creation)
  vi.spyOn(containerManager, "copyWorkspaceToContainer").mockResolvedValue(undefined);
  vi.spyOn(containerManager, "reseedGitAuth").mockImplementation(() => {});
});

// ─── Sessions ────────────────────────────────────────────────────────────────

// ─── SSE Session Creation Streaming ──────────────────────────────────────────
/** Parse an SSE response body into an array of {event, data} objects */
async function parseSSE(res: Response): Promise<{ event: string; data: string }[]> {
  const text = await res.text();
  const events: { event: string; data: string }[] = [];
  // SSE frames are separated by double newlines
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = "message";
    let data = "";
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data) events.push({ event, data });
  }
  return events;
}

describe("Takode server-authoritative auth", () => {
  function authHeaders(sessionId: string, token: string): Record<string, string> {
    return {
      "x-companion-session-id": sessionId,
      "x-companion-auth-token": token,
      "Content-Type": "application/json",
    };
  }

  function setupTakodeSessions() {
    const sessions: Record<string, any> = {
      "orch-1": {
        sessionId: "orch-1",
        state: "running",
        cwd: "/repo",
        createdAt: Date.now(),
        isOrchestrator: true,
      },
      "worker-1": {
        sessionId: "worker-1",
        state: "running",
        cwd: "/repo/w1",
        createdAt: Date.now(),
        herdedBy: "orch-1",
      },
      "worker-2": {
        sessionId: "worker-2",
        state: "running",
        cwd: "/repo/w2",
        createdAt: Date.now(),
      },
    };
    launcher.getSession.mockImplementation((id: string) => sessions[id]);
    launcher.listSessions.mockReturnValue(Object.values(sessions));
    launcher.resolveSessionId.mockImplementation((id: string) => (sessions[id] ? id : null));
    launcher.verifySessionAuthToken.mockImplementation(
      (id: string, token: string) => id === "orch-1" && token === "tok-1",
    );
    bridge._sessions = Object.fromEntries(
      Object.keys(sessions).map((sessionId) => [
        sessionId,
        {
          id: sessionId,
          state: {},
          board: new Map(),
          completedBoard: new Map(),
          boardDispatchStates: new Map(),
          messageHistory: [],
          notifications: [],
          pendingPermissions: new Map(),
          taskHistory: [],
          keywords: [],
          lastReadAt: 0,
          attentionReason: null,
          isGenerating: false,
        },
      ]),
    );
    bridge.getSession.mockImplementation((sessionId: string) => bridge._sessions[sessionId] ?? null);
    return sessions;
  }

  // ── Notify endpoint ──────────────────────────────────────────────────────

  it("rejects notification without summary", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ category: "review" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("summary is required");
    expect(bridge._sessions["orch-1"].notifications).toEqual([]);
  });

  it("passes summary string through to notifyUser", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ category: "needs-input", summary: "Need decision on auth approach" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      category: "needs-input",
      notificationId: 1,
      rawNotificationId: "n-1",
    });
    expect(bridge._sessions["orch-1"].notifications).toMatchObject([
      { category: "needs-input", summary: "Need decision on auth approach", done: false },
    ]);
  });

  it("stores normalized suggested answers for needs-input notifications", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].messageHistory.push({
      type: "assistant",
      message: { id: "asst-1", content: [{ type: "text", text: "Need approval" }] },
      timestamp: 1000,
    });

    const res = await app.request("/api/sessions/orch-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        category: "needs-input",
        summary: "Need deployment approval",
        suggestedAnswers: ["  yes  ", "not  yet"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      suggestedAnswers: ["yes", "not yet"],
    });
    expect(bridge._sessions["orch-1"].notifications).toMatchObject([
      {
        category: "needs-input",
        summary: "Need deployment approval",
        suggestedAnswers: ["yes", "not yet"],
        done: false,
      },
    ]);
    expect(bridge._sessions["orch-1"].messageHistory[0].notification).toMatchObject({
      id: "n-1",
      category: "needs-input",
      summary: "Need deployment approval",
      suggestedAnswers: ["yes", "not yet"],
    });
    expect(bridge.broadcastToSession).toHaveBeenCalledWith(
      "orch-1",
      expect.objectContaining({
        type: "notification_anchored",
        messageId: "asst-1",
        notification: expect.objectContaining({
          id: "n-1",
          suggestedAnswers: ["yes", "not yet"],
        }),
      }),
    );
  });

  it("rejects suggested answers outside needs-input notifications", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ category: "review", summary: "Ready", suggestedAnswers: ["ok"] }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("suggestedAnswers are only supported for needs-input notifications");
    expect(bridge._sessions["orch-1"].notifications).toEqual([]);
  });

  it("rejects invalid suggested answer sets", async () => {
    setupTakodeSessions();

    const tooMany = await app.request("/api/sessions/orch-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        category: "needs-input",
        summary: "Need approval",
        suggestedAnswers: ["one", "two", "three", "four"],
      }),
    });
    expect(tooMany.status).toBe(400);

    const duplicate = await app.request("/api/sessions/orch-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        category: "needs-input",
        summary: "Need approval",
        suggestedAnswers: ["yes", "YES"],
      }),
    });
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json()).error).toBe("suggestedAnswers entries must be unique");
    expect(bridge._sessions["orch-1"].notifications).toEqual([]);
  });

  it("rejects whitespace-only summary", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ category: "review", summary: "   " }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("summary is required");
    expect(bridge._sessions["orch-1"].notifications).toEqual([]);
  });

  it("rejects notify with invalid category", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ category: "invalid" }),
    });

    expect(res.status).toBe(400);
  });

  it("rejects cross-session notify calls", async () => {
    setupTakodeSessions();

    // orch-1 tries to notify as worker-1
    const res = await app.request("/api/sessions/worker-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ category: "review" }),
    });

    expect(res.status).toBe(403);
  });

  it("returns notification list via GET /sessions/:id/notifications", async () => {
    setupTakodeSessions();
    const mockNotifs = [{ id: "n-1", category: "review", timestamp: 1000, messageId: "mock-msg-5", done: false }];
    bridge._sessions["orch-1"].notifications = mockNotifs;

    const res = await app.request("/api/sessions/orch-1/notifications");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(mockNotifs);
  });

  it("lists only unresolved same-session needs-input notifications with resolved count", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      {
        id: "n-1",
        category: "needs-input",
        summary: "Still open",
        suggestedAnswers: ["yes", "no"],
        timestamp: 1000,
        messageId: "m-1",
        done: false,
      },
      { id: "n-2", category: "needs-input", summary: "Already handled", timestamp: 1001, messageId: "m-2", done: true },
      { id: "n-3", category: "review", summary: "Ignore review", timestamp: 1002, messageId: "m-3", done: false },
    ];

    const res = await app.request("/api/sessions/orch-1/notifications/needs-input/self", {
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      notifications: [
        {
          notificationId: 1,
          rawNotificationId: "n-1",
          summary: "Still open",
          suggestedAnswers: ["yes", "no"],
          timestamp: 1000,
          messageId: "m-1",
        },
      ],
      resolvedCount: 1,
    });
  });

  it("rejects inspecting another session's self notifications", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/worker-1/notifications/needs-input/self", {
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(403);
  });

  it("resolves a same-session needs-input notification by numeric id", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-4", category: "needs-input", summary: "Resolve me", timestamp: 1000, messageId: null, done: false },
    ];

    const res = await app.request("/api/sessions/orch-1/notifications/needs-input/4/resolve", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      notificationId: 4,
      rawNotificationId: "n-4",
      changed: true,
    });
    expect(bridge._sessions["orch-1"].notifications[0].done).toBe(true);
  });

  it("clears linked board wait-for-input state when a needs-input notification is resolved", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-4", category: "needs-input", summary: "Resolve me", timestamp: 1000, messageId: null, done: false },
      { id: "n-5", category: "needs-input", summary: "Keep me", timestamp: 1001, messageId: null, done: false },
    ];
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Implement board lifecycle",
          status: "IMPLEMENTING",
          waitForInput: ["n-4", "n-5"],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/notifications/needs-input/4/resolve", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(bridge._sessions["orch-1"].board.get("q-9")).toMatchObject({
      waitForInput: ["n-5"],
    });
  });

  it("treats resolving an already-resolved notification as a no-op", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-5", category: "needs-input", summary: "Already done", timestamp: 1000, messageId: null, done: true },
    ];

    const res = await app.request("/api/sessions/orch-1/notifications/needs-input/5/resolve", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      notificationId: 5,
      rawNotificationId: "n-5",
      changed: false,
    });
    expect(bridge._sessions["orch-1"].notifications[0].done).toBe(true);
  });

  it("marks notification as done via POST", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-1", category: "review", summary: "Done", timestamp: 1000, messageId: null, done: false },
    ];

    const res = await app.request("/api/sessions/orch-1/notifications/n-1/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });

    expect(res.status).toBe(200);
    expect(bridge._sessions["orch-1"].notifications[0].done).toBe(true);
  });

  it("mark-done defaults to true when done field is omitted", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-1", category: "review", summary: "Done", timestamp: 1000, messageId: null, done: false },
    ];

    const res = await app.request("/api/sessions/orch-1/notifications/n-1/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(bridge._sessions["orch-1"].notifications[0].done).toBe(true);
  });

  it("returns 404 for unknown notification ID", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-1", category: "review", summary: "Done", timestamp: 1000, messageId: null, done: false },
    ];

    const res = await app.request("/api/sessions/orch-1/notifications/n-999/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });

    expect(res.status).toBe(404);
  });

  it("marks all notifications done via POST", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-1", category: "review", summary: "One", timestamp: 1000, messageId: null, done: false },
      { id: "n-2", category: "review", summary: "Two", timestamp: 1001, messageId: null, done: false },
      { id: "n-3", category: "needs-input", summary: "Three", timestamp: 1002, messageId: null, done: false },
    ];

    const res = await app.request("/api/sessions/orch-1/notifications/done-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 3 });
    expect(bridge._sessions["orch-1"].notifications.every((notif: any) => notif.done)).toBe(true);
  });

  it("includes active needs-input notifications in takode pending output", async () => {
    setupTakodeSessions();
    bridge.getSession.mockReturnValue({
      pendingPermissions: new Map(),
      notifications: [
        {
          id: "n-1",
          category: "needs-input",
          summary: "Need decision on rollout",
          suggestedAnswers: ["ship", "hold"],
          timestamp: 1000,
          messageId: "asst-1",
          done: false,
        },
      ],
      messageHistory: [{ type: "assistant", message: { id: "asst-1" } }],
    });

    const res = await app.request("/api/sessions/worker-1/pending", {
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pending: [
        {
          kind: "notification",
          notification_id: "n-1",
          tool_name: "takode.notify",
          timestamp: 1000,
          summary: "Need decision on rollout",
          suggestedAnswers: ["ship", "hold"],
          msg_index: 0,
          messageId: "asst-1",
          threadKey: "main",
        },
      ],
    });
  });

  it("takode answer replies to needs-input notifications and marks them done", async () => {
    const sessions = setupTakodeSessions();
    sessions["orch-1"].sessionNum = 7;
    bridge.getSession.mockReturnValue({
      pendingPermissions: new Map(),
      notifications: [
        {
          id: "n-1",
          category: "needs-input",
          summary: "Need decision on rollout",
          timestamp: 1000,
          messageId: "asst-1",
          done: false,
        },
      ],
      messageHistory: [{ type: "assistant", message: { id: "asst-1" } }],
    });

    const res = await app.request("/api/sessions/worker-1/answer", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ response: "Use the staged rollout." }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      kind: "notification",
      tool_name: "takode.notify",
      action: "answered",
      answer: "Use the staged rollout.",
      delivery: "sent",
    });
    expect(bridge.injectUserMessage).toHaveBeenCalledWith(
      "worker-1",
      "Use the staged rollout.",
      {
        sessionId: "orch-1",
        sessionLabel: "#7",
      },
      undefined,
      { threadKey: "main" },
    );
    expect(bridge.getSession("worker-1")?.notifications[0]?.done).toBe(true);
  });

  it("requires an explicit selector when multiple pending prompts exist", async () => {
    setupTakodeSessions();
    bridge.getSession.mockReturnValue({
      pendingPermissions: new Map([
        [
          "req-1",
          {
            request_id: "req-1",
            tool_name: "AskUserQuestion",
            timestamp: 1000,
            input: {
              questions: [{ question: "Which rollout?", options: [{ label: "Staged" }, { label: "Immediate" }] }],
            },
          },
        ],
      ]),
      notifications: [
        {
          id: "n-1",
          category: "needs-input",
          summary: "Need decision on logging",
          timestamp: 1100,
          messageId: "asst-2",
          done: false,
        },
      ],
      messageHistory: [
        { type: "permission_request", request: { request_id: "req-1" } },
        { type: "assistant", message: { id: "asst-2" } },
      ],
    });

    const res = await app.request("/api/sessions/worker-1/answer", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ response: "Staged" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Multiple pending prompts; choose one with msgIndex/--message or targetId/--target",
    });
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();
    expect(bridge.routeExternalPermissionResponse).not.toHaveBeenCalled();
  });

  it("targets the selected pending permission by msgIndex when multiple prompts exist", async () => {
    setupTakodeSessions();
    bridge.getSession.mockReturnValue({
      pendingPermissions: new Map([
        [
          "req-older",
          {
            request_id: "req-older",
            tool_name: "AskUserQuestion",
            timestamp: 1000,
            input: {
              questions: [{ question: "Which rollout?", options: [{ label: "Staged" }, { label: "Immediate" }] }],
            },
          },
        ],
        [
          "req-target",
          {
            request_id: "req-target",
            tool_name: "AskUserQuestion",
            timestamp: 1100,
            input: {
              questions: [{ question: "Which logger?", options: [{ label: "Structured" }, { label: "Plain" }] }],
            },
          },
        ],
      ]),
      notifications: [],
      messageHistory: [
        { type: "permission_request", request: { request_id: "req-older" } },
        { type: "permission_request", request: { request_id: "req-target" } },
      ],
    });

    const res = await app.request("/api/sessions/worker-1/answer", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ response: "2", msgIndex: 1 }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      kind: "permission",
      tool_name: "AskUserQuestion",
      answer: "Plain",
    });
    expect(bridge.routeExternalPermissionResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pendingPermissions: expect.any(Map) }),
      {
        type: "permission_response",
        request_id: "req-target",
        behavior: "allow",
        updated_input: {
          questions: [{ question: "Which logger?", options: [{ label: "Structured" }, { label: "Plain" }] }],
          answers: { "0": "Plain" },
        },
      },
      "orch-1",
    );
  });

  it("takode answer fills every AskUserQuestion answer slot when the leader replies with free text", async () => {
    setupTakodeSessions();
    bridge.getSession.mockReturnValue({
      pendingPermissions: new Map([
        [
          "req-multi-question",
          {
            request_id: "req-multi-question",
            tool_name: "AskUserQuestion",
            timestamp: 1000,
            input: {
              questions: [{ question: "Which rollout?" }, { question: "Which logger?" }],
            },
          },
        ],
      ]),
      notifications: [],
      messageHistory: [{ type: "permission_request", request: { request_id: "req-multi-question" } }],
    });

    const res = await app.request("/api/sessions/worker-1/answer", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ response: "Use staged rollout with structured logs." }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      kind: "permission",
      tool_name: "AskUserQuestion",
      answer: "Use staged rollout with structured logs.",
    });
    expect(bridge.routeExternalPermissionResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pendingPermissions: expect.any(Map) }),
      {
        type: "permission_response",
        request_id: "req-multi-question",
        behavior: "allow",
        updated_input: {
          questions: [{ question: "Which rollout?" }, { question: "Which logger?" }],
          answers: {
            "0": "Use staged rollout with structured logs.",
            "1": "Use staged rollout with structured logs.",
          },
        },
      },
      "orch-1",
    );
  });

  // Verifies the takode answer route correctly routes an ExitPlanMode approval
  // through routeBrowserMessage for claude-sdk sessions. This covers the bug
  // where stale pendingPermissions entries from adapter disconnects caused
  // takode answer to resolve the wrong request_id.
  it("takode answer approves ExitPlanMode and routes the permission response", async () => {
    setupTakodeSessions();
    bridge.getSession.mockReturnValue({
      pendingPermissions: new Map([
        [
          "req-exit-plan",
          {
            request_id: "req-exit-plan",
            tool_name: "ExitPlanMode",
            timestamp: 2000,
            input: { plan: "Step 1: do X\nStep 2: do Y", allowedPrompts: [] },
          },
        ],
      ]),
      notifications: [],
      messageHistory: [{ type: "permission_request", request: { request_id: "req-exit-plan" } }],
    });

    const res = await app.request("/api/sessions/worker-1/answer", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ response: "approve" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      kind: "permission",
      tool_name: "ExitPlanMode",
      action: "approved",
    });
    expect(bridge.routeExternalPermissionResponse).toHaveBeenCalledWith(
      expect.objectContaining({ pendingPermissions: expect.any(Map) }),
      {
        type: "permission_response",
        request_id: "req-exit-plan",
        behavior: "allow",
        updated_input: { plan: "Step 1: do X\nStep 2: do Y", allowedPrompts: [] },
      },
      "orch-1",
    );
  });
});
