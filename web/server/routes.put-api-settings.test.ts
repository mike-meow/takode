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
  QUESTMASTER_COMPACT_SORT_COLUMNS: ["quest", "title", "owner", "status", "verify", "feedback", "updated"],
  DEFAULT_QUESTMASTER_COMPACT_SORT: { column: "updated", direction: "desc" },
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
    questmasterCompactSort: { column: "updated", direction: "desc" },
    codexLeaderContextWindowOverrideTokens: 1_000_000,
    codexLeaderRecycleThresholdTokens: 260_000,
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
    questmasterCompactSort: patch.questmasterCompactSort ?? { column: "updated", direction: "desc" },
    codexLeaderContextWindowOverrideTokens: patch.codexLeaderContextWindowOverrideTokens ?? 1_000_000,
    codexLeaderRecycleThresholdTokens: patch.codexLeaderRecycleThresholdTokens ?? 260_000,
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

describe("PUT /api/settings", () => {
  it("updates pushover settings", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "u123",
      pushoverApiToken: "t456",
      pushoverDelaySeconds: 60,
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
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: 456,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushoverUserKey: "u123", pushoverApiToken: "t456", pushoverDelaySeconds: 60 }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      pushoverUserKey: "u123",
      pushoverApiToken: "t456",
      pushoverDelaySeconds: 60,
      pushoverEnabled: undefined,
      pushoverEventFilters: undefined,
      pushoverBaseUrl: undefined,
      claudeBinary: undefined,
      codexBinary: undefined,
      maxKeepAlive: undefined,
      heavyRepoModeEnabled: undefined,
      autoApprovalEnabled: undefined,
      autoApprovalModel: undefined,
      namerConfig: undefined,
      autoNamerEnabled: undefined,
      transcriptionConfig: undefined,
      editorConfig: undefined,
      defaultClaudeBackend: undefined,
      sleepInhibitorEnabled: undefined,
      sleepInhibitorDurationMinutes: undefined,
      questmasterViewMode: undefined,
      questmasterCompactSort: undefined,
      codexLeaderContextWindowOverrideTokens: undefined,
      codexLeaderRecycleThresholdTokens: undefined,
    });
    const json = await res.json();
    expect(json).toEqual({
      serverName: "",
      serverId: "test-server-id",
      pushoverConfigured: true,
      pushoverEnabled: true,
      pushoverEventFilters: { needsInput: true, review: true, error: true },
      pushoverDelaySeconds: 60,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      heavyRepoModeEnabled: false,
      autoApprovalEnabled: false,
      autoApprovalModel: "haiku",
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
      questmasterCompactSort: { column: "updated", direction: "desc" },
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      codexLeaderRecycleThresholdTokensByModel: {},
    });
  });

  it("updates pushover event filters", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverEventFilters: { needsInput: true, review: false, error: true },
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
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: 456,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushoverEventFilters: { review: false } }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      pushoverUserKey: undefined,
      pushoverApiToken: undefined,
      pushoverDelaySeconds: undefined,
      pushoverEnabled: undefined,
      pushoverEventFilters: { needsInput: true, review: false, error: true },
      pushoverBaseUrl: undefined,
      claudeBinary: undefined,
      codexBinary: undefined,
      maxKeepAlive: undefined,
      heavyRepoModeEnabled: undefined,
      autoApprovalEnabled: undefined,
      autoApprovalModel: undefined,
      namerConfig: undefined,
      autoNamerEnabled: undefined,
      transcriptionConfig: undefined,
      editorConfig: undefined,
      defaultClaudeBackend: undefined,
      sleepInhibitorEnabled: undefined,
      sleepInhibitorDurationMinutes: undefined,
      questmasterViewMode: undefined,
      questmasterCompactSort: undefined,
      codexLeaderContextWindowOverrideTokens: undefined,
      codexLeaderRecycleThresholdTokens: undefined,
      herdLeaderFirstEnabled: undefined,
    });
  });

  it("trims pushover keys", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "trimmed",
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
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: 789,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushoverUserKey: "  trimmed  " }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      pushoverUserKey: "trimmed",
      pushoverApiToken: undefined,
      pushoverDelaySeconds: undefined,
      pushoverEnabled: undefined,
      pushoverEventFilters: undefined,
      pushoverBaseUrl: undefined,
      claudeBinary: undefined,
      codexBinary: undefined,
      maxKeepAlive: undefined,
      heavyRepoModeEnabled: undefined,
      autoApprovalEnabled: undefined,
      autoApprovalModel: undefined,
      namerConfig: undefined,
      autoNamerEnabled: undefined,
      transcriptionConfig: undefined,
      editorConfig: undefined,
      defaultClaudeBackend: undefined,
      sleepInhibitorEnabled: undefined,
      sleepInhibitorDurationMinutes: undefined,
      questmasterViewMode: undefined,
      questmasterCompactSort: undefined,
      codexLeaderContextWindowOverrideTokens: undefined,
      codexLeaderRecycleThresholdTokens: undefined,
    });
  });

  it("persists serverName via setServerName when provided", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "My Backend",
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
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: Date.now(),
    });
    vi.mocked(settingsManager.getServerName).mockReturnValue("My Backend");

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverName: "My Backend" }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.setServerName).toHaveBeenCalledWith("My Backend");
    const json = await res.json();
    expect(json.serverName).toBe("My Backend");

    vi.mocked(settingsManager.getServerName).mockReturnValue("");
  });

  it("returns 400 for non-string serverName", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverName: 123 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "serverName must be a string" });
  });

  it("returns 400 for non-string pushoverUserKey", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushoverUserKey: 123 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "pushoverUserKey must be a string" });
  });

  it("returns 400 for invalid pushoverDelaySeconds", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushoverDelaySeconds: 2 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "pushoverDelaySeconds must be a number between 5 and 300" });
  });

  it("returns 400 for invalid pushoverEventFilters value", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pushoverEventFilters: { review: "nope" } }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "pushoverEventFilters.review must be a boolean" });
  });

  it("returns 400 when no settings fields are provided", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "At least one settings field is required" });
  });

  it("ignores unknown fields like openrouterApiKey", async () => {
    // OpenRouter fields were removed — they should not cause errors but are ignored
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openrouterApiKey: "some-key", pushoverEnabled: false }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith({
      pushoverUserKey: undefined,
      pushoverApiToken: undefined,
      pushoverDelaySeconds: undefined,
      pushoverEnabled: false,
      pushoverBaseUrl: undefined,
      claudeBinary: undefined,
      codexBinary: undefined,
      maxKeepAlive: undefined,
      heavyRepoModeEnabled: undefined,
      autoApprovalEnabled: undefined,
      autoApprovalModel: undefined,
      namerConfig: undefined,
      autoNamerEnabled: undefined,
      transcriptionConfig: undefined,
      editorConfig: undefined,
      defaultClaudeBackend: undefined,
      sleepInhibitorEnabled: undefined,
      sleepInhibitorDurationMinutes: undefined,
      questmasterViewMode: undefined,
      questmasterCompactSort: undefined,
      codexLeaderContextWindowOverrideTokens: undefined,
      codexLeaderRecycleThresholdTokens: undefined,
    });
  });

  it("updates claudeBinary setting", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverBaseUrl: "",
      claudeBinary: "/usr/local/bin/claude",
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
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: Date.now(),
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claudeBinary: "/usr/local/bin/claude" }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ claudeBinary: "/usr/local/bin/claude" }),
    );
    const json = await res.json();
    expect(json.claudeBinary).toBe("/usr/local/bin/claude");
  });

  it("returns 400 for non-string claudeBinary", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claudeBinary: 123 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "claudeBinary must be a string" });
  });

  it("returns 400 for non-string codexBinary", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codexBinary: true }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "codexBinary must be a string" });
  });

  it("returns 400 for negative maxKeepAlive", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxKeepAlive: -1 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "maxKeepAlive must be a non-negative integer" });
  });

  it("returns 400 for non-integer maxKeepAlive", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxKeepAlive: 3.5 }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "maxKeepAlive must be a non-negative integer" });
  });

  it("returns 400 for non-boolean heavyRepoModeEnabled", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heavyRepoModeEnabled: "true" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "heavyRepoModeEnabled must be a boolean" });
  });

  it("updates maxKeepAlive setting", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 5,
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
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: Date.now(),
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxKeepAlive: 5 }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ maxKeepAlive: 5 }));
    const json = await res.json();
    expect(json.maxKeepAlive).toBe(5);
  });

  it("updates heavyRepoModeEnabled setting", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      heavyRepoModeEnabled: true,
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
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: Date.now(),
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heavyRepoModeEnabled: true }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ heavyRepoModeEnabled: true }),
    );
    const json = await res.json();
    expect(json.heavyRepoModeEnabled).toBe(true);
  });

  it("updates Questmaster view mode setting", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      ...settingsManager.getSettings(),
      questmasterViewMode: "compact",
      updatedAt: Date.now(),
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questmasterViewMode: "compact" }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ questmasterViewMode: "compact" }),
    );
    const json = await res.json();
    expect(json.questmasterViewMode).toBe("compact");
  });

  it("returns 400 for invalid Questmaster view mode", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questmasterViewMode: "grid" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'questmasterViewMode must be "cards" or "compact"' });
  });

  it("updates Questmaster compact sort setting", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      ...settingsManager.getSettings(),
      questmasterCompactSort: { column: "feedback", direction: "desc" },
      updatedAt: Date.now(),
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questmasterCompactSort: { column: "feedback", direction: "desc" } }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ questmasterCompactSort: { column: "feedback", direction: "desc" } }),
    );
    const json = await res.json();
    expect(json.questmasterCompactSort).toEqual({ column: "feedback", direction: "desc" });
  });

  it("returns 400 for invalid Questmaster compact sort", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questmasterCompactSort: { column: "bogus", direction: "desc" } }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "questmasterCompactSort.column is invalid" });
  });

  it("preserves custom transcription vocabulary when saving settings", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
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
        apiKey: "persisted-transcription-secret",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: true,
        enhancementModel: "gpt-5-mini",
        customVocabulary: "Takode, WsBridge",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: 123,
    });
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
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
        apiKey: "persisted-transcription-secret",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: false,
        enhancementModel: "gpt-4.1-mini",
        customVocabulary: "Takode, WsBridge, Questmaster",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: 456,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcriptionConfig: {
          apiKey: "***",
          baseUrl: "https://api.openai.com/v1",
          enhancementEnabled: false,
          enhancementModel: "gpt-4.1-mini",
          customVocabulary: "Takode, WsBridge, Questmaster",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionConfig: {
          apiKey: "persisted-transcription-secret",
          baseUrl: "https://api.openai.com/v1",
          enhancementEnabled: false,
          enhancementModel: "gpt-4.1-mini",
          customVocabulary: "Takode, WsBridge, Questmaster",
        },
      }),
    );

    const json = await res.json();
    expect(json.transcriptionConfig).toEqual({
      apiKey: "***",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: false,
      enhancementModel: "gpt-4.1-mini",
      customVocabulary: "Takode, WsBridge, Questmaster",
    });
    expect(JSON.stringify(json)).not.toContain("persisted-transcription-secret");
  });

  it("updates per-model Codex leader recycle thresholds", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
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
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      codexLeaderRecycleThresholdTokensByModel: {
        "gpt-5.4": 430_000,
        "gpt-5.5": 320_000,
      },
      updatedAt: 456,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codexLeaderRecycleThresholdTokens: 260_000,
        codexLeaderRecycleThresholdTokensByModel: {
          " gpt-5.4 ": 430_000,
          "gpt-5.5": 320_000,
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        codexLeaderRecycleThresholdTokens: 260_000,
        codexLeaderRecycleThresholdTokensByModel: {
          "gpt-5.4": 430_000,
          "gpt-5.5": 320_000,
        },
      }),
    );

    const json = await res.json();
    expect(json.codexLeaderRecycleThresholdTokensByModel).toEqual({
      "gpt-5.4": 430_000,
      "gpt-5.5": 320_000,
    });
  });

  it("updates the non-leader Codex auto-compact threshold percent", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
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
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexNonLeaderAutoCompactThresholdPercent: 88,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: 456,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codexNonLeaderAutoCompactThresholdPercent: 88,
      }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        codexNonLeaderAutoCompactThresholdPercent: 88,
      }),
    );

    const json = await res.json();
    expect(json.codexNonLeaderAutoCompactThresholdPercent).toBe(88);
  });

  it("rejects invalid per-model Codex leader recycle thresholds", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codexLeaderRecycleThresholdTokensByModel: {
          "gpt-5.4": "430000",
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "codexLeaderRecycleThresholdTokensByModel.gpt-5.4 must be a positive integer",
    });
  });

  it("rejects invalid non-leader Codex auto-compact threshold percent", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codexNonLeaderAutoCompactThresholdPercent: 101,
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "codexNonLeaderAutoCompactThresholdPercent must be an integer between 1 and 100",
    });
  });

  it("updates editorConfig setting", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
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
      editorConfig: { editor: "cursor" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: Date.now(),
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editorConfig: { editor: "cursor" } }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ editorConfig: { editor: "cursor" } }),
    );
    const json = await res.json();
    expect(json.editorConfig).toEqual({ editor: "cursor" });
  });

  it("preserves stored masked API keys without returning plaintext", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      heavyRepoModeEnabled: false,
      autoApprovalEnabled: false,
      autoApprovalModel: "haiku",
      autoApprovalMaxConcurrency: 4,
      autoApprovalTimeoutSeconds: 45,
      namerConfig: {
        backend: "openai",
        apiKey: "persisted-namer-secret",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      autoNamerEnabled: true,
      transcriptionConfig: {
        apiKey: "persisted-transcription-secret",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: false,
        enhancementModel: "gpt-4.1-mini",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: 123,
    });
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "",
      pushoverApiToken: "",
      pushoverDelaySeconds: 30,
      pushoverEnabled: true,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      heavyRepoModeEnabled: false,
      autoApprovalEnabled: false,
      autoApprovalModel: "haiku",
      autoApprovalMaxConcurrency: 4,
      autoApprovalTimeoutSeconds: 45,
      namerConfig: {
        backend: "openai",
        apiKey: "persisted-namer-secret",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      autoNamerEnabled: true,
      transcriptionConfig: {
        apiKey: "persisted-transcription-secret",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: false,
        enhancementModel: "gpt-4.1-mini",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      codexLeaderContextWindowOverrideTokens: 1_000_000,
      codexLeaderRecycleThresholdTokens: 260_000,
      updatedAt: 456,
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namerConfig: {
          backend: "openai",
          apiKey: "***",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        },
        transcriptionConfig: {
          apiKey: "***",
          baseUrl: "https://api.openai.com/v1",
          enhancementEnabled: false,
          enhancementModel: "gpt-4.1-mini",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        namerConfig: {
          backend: "openai",
          apiKey: "persisted-namer-secret",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
        },
        transcriptionConfig: {
          apiKey: "persisted-transcription-secret",
          baseUrl: "https://api.openai.com/v1",
          enhancementEnabled: false,
          enhancementModel: "gpt-4.1-mini",
          customVocabulary: "",
        },
      }),
    );

    const json = await res.json();
    expect(json.namerConfig.apiKey).toBe("***");
    expect(json.transcriptionConfig.apiKey).toBe("***");
    expect(JSON.stringify(json)).not.toContain("persisted-namer-secret");
    expect(JSON.stringify(json)).not.toContain("persisted-transcription-secret");
  });

  it("returns 400 for invalid editorConfig.editor", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editorConfig: { editor: "vim" } }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'editorConfig.editor must be "vscode-local", "vscode-remote", "cursor", or "none"' });
  });
});
