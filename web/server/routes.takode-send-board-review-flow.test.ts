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
  vi.spyOn(questStore, "getQuest").mockResolvedValue(null);
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

  it("blocks spoofed sender identity and accepts authenticated send", async () => {
    setupTakodeSessions();
    launcher.isAlive.mockReturnValue(true);

    const deniedByToken = await app.request("/api/sessions/worker-1/message", {
      method: "POST",
      headers: authHeaders("orch-1", "spoofed"),
      body: JSON.stringify({ content: "hi" }),
    });
    expect(deniedByToken.status).toBe(403);

    const deniedByBodySpoof = await app.request("/api/sessions/worker-1/message", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        content: "hi",
        agentSource: { sessionId: "worker-2" },
      }),
    });
    expect(deniedByBodySpoof.status).toBe(403);

    const allowed = await app.request("/api/sessions/worker-1/message", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ content: "ship it" }),
    });
    expect(allowed.status).toBe(200);
    expect(bridge.injectUserMessage).toHaveBeenCalledWith("worker-1", "ship it", { sessionId: "orch-1" });
  });

  it("rejects archived takode message targets before routing", async () => {
    const sessions = setupTakodeSessions();
    sessions["worker-1"].archived = true;

    const res = await app.request("/api/sessions/worker-1/message", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ content: "ship it" }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Cannot send to archived session" });
    expect(bridge.injectUserMessage).not.toHaveBeenCalled();
  });

  it("includes worker and reviewer session statuses in takode board responses", async () => {
    const sessions = setupTakodeSessions();
    sessions["worker-1"].sessionNum = 11;
    sessions["worker-1"].state = "running";
    sessions["reviewer-1"] = {
      sessionId: "reviewer-1",
      sessionNum: 12,
      state: "running",
      cwd: "/repo/r1",
      createdAt: Date.now(),
      herdedBy: "orch-1",
      reviewerOf: 11,
      archived: false,
    };
    sessions["worker-2"].sessionNum = 22;
    sessions["worker-2"].state = "exited";
    launcher.listSessions.mockReturnValue(Object.values(sessions));
    launcher.getSession.mockImplementation((id: string) => sessions[id]);
    launcher.getSessionNum.mockImplementation((id: string) => sessions[id]?.sessionNum);
    bridge.isBackendConnected.mockImplementation((id: string) => id === "worker-1" || id === "reviewer-1");
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-1",
        { questId: "q-1", worker: "worker-1", workerNum: 11, status: "IMPLEMENTING", createdAt: 1, updatedAt: 1 },
      ],
      ["q-2", { questId: "q-2", worker: "worker-2", workerNum: 22, status: "PLANNING", createdAt: 2, updatedAt: 2 }],
    ]);

    const res = await app.request("/api/sessions/orch-1/board?resolve=true", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        { questId: "q-1", worker: "worker-1", workerNum: 11, status: "IMPLEMENTING" },
        { questId: "q-2", worker: "worker-2", workerNum: 22, status: "PLANNING" },
      ],
      queueWarnings: [],
      workerSlotUsage: { used: 1, limit: 5 },
      rowSessionStatuses: {
        "q-1": {
          worker: { sessionId: "worker-1", sessionNum: 11, status: "running" },
          reviewer: { sessionId: "reviewer-1", sessionNum: 12, status: "running" },
        },
        "q-2": {
          worker: { sessionId: "worker-2", sessionNum: 22, status: "disconnected" },
          reviewer: null,
        },
      },
    });
  });

  it("rejects queued board rows without an explicit wait-for reason", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ questId: "q-9", status: "QUEUED" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("Queued rows require an explicit wait-for reason"),
    });
  });

  it("stores deduped wait-for-input links on active rows", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      {
        id: "n-7",
        category: "needs-input",
        summary: "Need product answer",
        timestamp: 1000,
        messageId: null,
        done: false,
      },
      {
        id: "n-2",
        category: "needs-input",
        summary: "Need rollout answer",
        timestamp: 1001,
        messageId: null,
        done: false,
      },
    ];

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        status: "IMPLEMENTING",
        waitForInput: ["7", "n-2", "n-7"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          status: "IMPLEMENTING",
          waitForInput: ["n-2", "n-7"],
        },
      ],
    });
  });

  it("rejects wait-for-input links on queued rows", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-3", category: "needs-input", summary: "Need answer", timestamp: 1000, messageId: null, done: false },
    ];

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        status: "QUEUED",
        waitFor: ["q-1"],
        waitForInput: ["3"],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("wait-for-input is only valid on active board rows"),
    });
  });

  it("stores proposed Journey rows with approval holds and no active phase semantics", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-3", category: "needs-input", summary: "Need approval", timestamp: 1000, messageId: null, done: false },
    ];

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        journeyMode: "proposed",
        phases: ["alignment", "implement", "code-review", "port"],
        presetId: "full-code",
        waitForInput: ["3"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          status: "PROPOSED",
          waitForInput: ["n-3"],
          journey: {
            mode: "proposed",
            phaseIds: ["alignment", "implement", "code-review", "port"],
          },
        },
      ],
    });
    expect(bridge._sessions["orch-1"].board.get("q-9")?.journey).not.toHaveProperty("currentPhaseId");
  });

  it("rejects wait-for dependencies on explicit active rows", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        status: "IMPLEMENTING",
        waitFor: ["q-1"],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("wait-for is only valid on QUEUED board rows"),
    });
  });

  it("resolves removed wait-for-input notifications when a row is updated", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-1", category: "needs-input", summary: "Need answer one", timestamp: 1000, messageId: null, done: false },
      { id: "n-2", category: "needs-input", summary: "Need answer two", timestamp: 1001, messageId: null, done: false },
    ];
    bridge._sessions["orch-1"].notificationCounter = 2;
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Implement board lifecycle",
          status: "IMPLEMENTING",
          waitForInput: ["n-1", "n-2"],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        waitForInput: ["2"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          waitForInput: ["n-2"],
        },
      ],
    });
    expect(bridge._sessions["orch-1"].notifications).toMatchObject([
      { id: "n-1", done: true },
      { id: "n-2", done: false },
    ]);
  });

  it("includes row session statuses in live board_updated broadcasts after board mutations", async () => {
    const sessions = setupTakodeSessions();
    sessions["worker-1"].sessionNum = 11;
    sessions["worker-1"].state = "running";
    sessions["reviewer-1"] = {
      sessionId: "reviewer-1",
      sessionNum: 12,
      state: "running",
      cwd: "/repo/r1",
      createdAt: Date.now(),
      herdedBy: "orch-1",
      reviewerOf: 11,
      archived: false,
    };
    launcher.listSessions.mockReturnValue(Object.values(sessions));
    launcher.getSession.mockImplementation((id: string) => sessions[id]);
    launcher.getSessionNum.mockImplementation((id: string) => sessions[id]?.sessionNum);
    bridge.isBackendConnected.mockImplementation((id: string) => id === "worker-1" || id === "reviewer-1");

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        title: "Implement board lifecycle",
        worker: "worker-1",
        workerNum: 11,
        status: "IMPLEMENTING",
      }),
    });

    expect(res.status).toBe(200);
    expect(bridge.broadcastToSession).toHaveBeenCalledWith(
      "orch-1",
      expect.objectContaining({
        type: "board_updated",
        rowSessionStatuses: {
          "q-9": {
            worker: { sessionId: "worker-1", sessionNum: 11, status: "running" },
            reviewer: { sessionId: "reviewer-1", sessionNum: 12, status: "running" },
          },
        },
      }),
    );
  });

  it("clears stale queue wait-for metadata when an active row is updated with wait-for-input", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-2", category: "needs-input", summary: "Need answer two", timestamp: 1001, messageId: null, done: false },
    ];
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Implement board lifecycle",
          status: "IMPLEMENTING",
          waitFor: ["q-1"],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        waitForInput: ["2"],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          status: "IMPLEMENTING",
          waitForInput: ["n-2"],
        },
      ],
    });
    expect(bridge._sessions["orch-1"].board.get("q-9")?.waitFor).toBeUndefined();
  });

  it("resolves linked wait-for-input notifications when board rows are removed", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].notifications = [
      { id: "n-1", category: "needs-input", summary: "Need answer one", timestamp: 1000, messageId: null, done: false },
      { id: "n-2", category: "needs-input", summary: "Need answer two", timestamp: 1001, messageId: null, done: false },
    ];
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Implement board lifecycle",
          status: "IMPLEMENTING",
          waitForInput: ["n-1", "n-2"],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board/q-9", {
      method: "DELETE",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [],
      completedCount: 1,
    });
    expect(bridge._sessions["orch-1"].notifications.find((notification: any) => notification.id === "n-1")?.done).toBe(
      true,
    );
    expect(bridge._sessions["orch-1"].notifications.find((notification: any) => notification.id === "n-2")?.done).toBe(
      true,
    );
  });

  it("stores lightweight planned phases on board rows", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        status: "PLANNING",
        phases: ["planning", "implement", "port"],
        presetId: "lightweight",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          status: "PLANNING",
          journey: {
            presetId: "lightweight",
            phaseIds: ["alignment", "implement", "port"],
            currentPhaseId: "alignment",
            nextLeaderAction: expect.stringContaining("alignment leader brief"),
          },
        },
      ],
    });
  });

  it("initializes a phase-planned active board row to the first planned phase when status is omitted", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        worker: "worker-1",
        workerNum: 11,
        phases: ["planning", "implement", "code-review"],
        presetId: "lightweight-code",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          worker: "worker-1",
          workerNum: 11,
          status: "PLANNING",
          journey: {
            presetId: "lightweight-code",
            phaseIds: ["alignment", "implement", "code-review"],
            currentPhaseId: "alignment",
          },
        },
      ],
    });
  });

  it("preserves the active phase and records a revision reason when revising remaining phases", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Implement board lifecycle",
          status: "IMPLEMENTING",
          createdAt: 1,
          updatedAt: 1,
          journey: {
            presetId: "full-code",
            phaseIds: ["alignment", "implement", "code-review", "port"],
            currentPhaseId: "implement",
          },
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        phases: ["implement", "outcome-review", "code-review", "port"],
        presetId: "cli-rollout",
        revisionReason: "Need real outcome evidence before final review",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          status: "IMPLEMENTING",
          journey: {
            presetId: "cli-rollout",
            phaseIds: ["implement", "outcome-review", "code-review", "port"],
            currentPhaseId: "implement",
            revisionReason: "Need real outcome evidence before final review",
            revisionCount: 1,
          },
        },
      ],
    });
  });

  it("preserves repeated active phase occurrences by index when revising a Journey", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Implement board lifecycle",
          status: "IMPLEMENTING",
          createdAt: 1,
          updatedAt: 1,
          journey: {
            presetId: "rework-loop",
            mode: "active",
            phaseIds: ["alignment", "implement", "code-review", "implement", "code-review", "port"],
            activePhaseIndex: 3,
            currentPhaseId: "implement",
          },
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        phases: ["alignment", "implement", "code-review", "implement", "code-review", "mental-simulation", "port"],
        presetId: "rework-loop",
        revisionReason: "Add scenario replay before port",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          status: "IMPLEMENTING",
          journey: {
            activePhaseIndex: 3,
            currentPhaseId: "implement",
            phaseIds: [
              "alignment",
              "implement",
              "code-review",
              "implement",
              "code-review",
              "mental-simulation",
              "port",
            ],
          },
        },
      ],
    });
  });

  it("stores per-phase Journey notes keyed by phase occurrence", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Implement board lifecycle",
          status: "PROPOSED",
          createdAt: 1,
          updatedAt: 1,
          journey: {
            presetId: "rework-loop",
            mode: "proposed",
            phaseIds: ["alignment", "implement", "code-review", "implement", "code-review", "port"],
          },
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        phaseNoteEdits: [
          { index: 2, note: "focus on stream migration behavior" },
          { index: 4, note: "inspect only the follow-up diff" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          journey: {
            phaseNotes: {
              "2": "focus on stream migration behavior",
              "4": "inspect only the follow-up diff",
            },
          },
        },
      ],
    });
  });

  it("promotes a proposed Journey into active execution without redefining phases", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Implement board lifecycle",
          status: "PROPOSED",
          waitForInput: ["n-3"],
          createdAt: 1,
          updatedAt: 1,
          journey: {
            presetId: "full-code",
            mode: "proposed",
            phaseIds: ["alignment", "implement", "code-review", "port"],
          },
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({
        questId: "q-9",
        journeyMode: "active",
        clearWaitForInput: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          status: "PLANNING",
          journey: {
            mode: "active",
            phaseIds: ["alignment", "implement", "code-review", "port"],
            activePhaseIndex: 0,
            currentPhaseId: "alignment",
          },
        },
      ],
    });
  });

  it("realigns the current custom Journey phase when board set applies an explicit reset status", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Investigate board lifecycle",
          status: "OUTCOME_REVIEWING",
          createdAt: 1,
          updatedAt: 1,
          journey: {
            presetId: "investigation",
            phaseIds: ["alignment", "explore", "outcome-review"],
            currentPhaseId: "outcome-review",
            nextLeaderAction: "stale outcome review action",
          },
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ questId: "q-9", status: "PLANNING" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      board: [
        {
          questId: "q-9",
          status: "PLANNING",
          journey: {
            presetId: "investigation",
            phaseIds: ["alignment", "explore", "outcome-review"],
            currentPhaseId: "alignment",
            nextLeaderAction: expect.stringContaining("alignment leader brief"),
          },
        },
      ],
    });
  });

  it("rejects unknown planned phase IDs", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ questId: "q-9", status: "PLANNING", phases: ["planning", "human-verification"] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("human-verification"),
    });
  });

  it("rejects empty planned phase lists instead of falling back to the full-code sequence", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ questId: "q-9", status: "PLANNING", phases: [" ", ""] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("at least one phase ID"),
    });
  });

  it("completes a zero-tracked-change Journey via standard advance from its final planned phase", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Investigate board lifecycle",
          journey: {
            presetId: "investigation",
            phaseIds: ["alignment", "explore", "outcome-review"],
            currentPhaseId: "outcome-review",
          },
          status: "OUTCOME_REVIEWING",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board/q-9/advance", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      removed: true,
      previousState: "OUTCOME_REVIEWING",
      board: [],
      completedCount: 1,
    });
  });

  it("fails closed when board advance sees a status/currentPhase mismatch on a custom Journey", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Investigate board lifecycle",
          journey: {
            presetId: "investigation",
            phaseIds: ["alignment", "explore", "outcome-review"],
            currentPhaseId: "outcome-review",
            nextLeaderAction: "stale outcome review action",
          },
          status: "PLANNING",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board/q-9/advance", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("disagrees with journey.currentPhaseId"),
    });
    expect(bridge._sessions["orch-1"].board.get("q-9")).toMatchObject({
      status: "PLANNING",
      journey: {
        currentPhaseId: "outcome-review",
      },
    });
  });

  it("returns 404 for the removed advance-no-groom route", async () => {
    setupTakodeSessions();
    bridge._sessions["orch-1"].board = new Map([
      [
        "q-9",
        {
          questId: "q-9",
          title: "Implement board lifecycle",
          status: "IMPLEMENTING",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);

    const res = await app.request("/api/sessions/orch-1/board/q-9/advance-no-groom", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(404);
  });

  it("rejects removed noCode markers on board updates", async () => {
    setupTakodeSessions();
    const res = await app.request("/api/sessions/orch-1/board", {
      method: "POST",
      headers: {
        ...authHeaders("orch-1", "tok-1"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        questId: "q-9",
        noCode: true,
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("Board no-code markers were removed"),
    });
  });
});
