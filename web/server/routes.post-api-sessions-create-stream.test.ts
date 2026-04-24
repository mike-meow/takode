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

describe("POST /api/sessions/create-stream", () => {
  it("emits progress events and done event for a basic session", async () => {
    // Simple session creation with no containers or worktrees
    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await parseSSE(res);

    // Should have resolving_env (in_progress + done) and launching_cli (in_progress + done)
    const progressEvents = events.filter((e) => e.event === "progress");
    expect(progressEvents.length).toBeGreaterThanOrEqual(4);

    // First progress should be resolving_env in_progress
    const first = JSON.parse(progressEvents[0].data);
    expect(first.step).toBe("resolving_env");
    expect(first.status).toBe("in_progress");

    // Last event should be "done" with sessionId
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    const doneData = JSON.parse(doneEvent!.data);
    expect(doneData.sessionId).toBe("session-1");
    expect(doneData.cwd).toBe("/test");
  });

  it("injects COMPANION_PORT when resuming via create-stream", async () => {
    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "claude",
        cwd: "/test",
        resumeCliSessionId: "cli-resume-2",
      }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeCliSessionId: "cli-resume-2",
        env: expect.objectContaining({
          COMPANION_PORT: "3456",
        }),
      }),
    );
  });

  it("emits git progress events when branch is specified", async () => {
    // When branch is specified without useWorktree, should emit fetch/checkout/pull events
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/test",
      currentBranch: "main",
      defaultBranch: "main",
    } as any);

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", branch: "feat/new" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events.filter((e) => e.event === "progress").map((e) => JSON.parse(e.data).step);

    // Should include git operations
    expect(steps).toContain("fetching_git");
    expect(steps).toContain("checkout_branch");
    expect(steps).toContain("pulling_git");
    expect(steps).toContain("launching_cli");
  });

  it("emits worktree progress events when useWorktree is set", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/test",
      currentBranch: "main",
      defaultBranch: "main",
    } as any);
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/test-wt-123",
      actualBranch: "feat/auth",
      created: true,
    } as any);

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", branch: "feat/auth", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events.filter((e) => e.event === "progress").map((e) => JSON.parse(e.data).step);

    expect(steps).toContain("creating_worktree");
    expect(steps).toContain("launching_cli");
    // Should NOT have fetch/checkout/pull since it uses worktree
    expect(steps).not.toContain("fetching_git");
  });

  it("keeps create-stream progress alive during slow worktree setup", async () => {
    // Protects the original q-362 failure mode: very large repos can make
    // worktree creation stall long enough that the UI looks dead or failed.
    vi.useFakeTimers();
    try {
      vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
        repoRoot: "/test",
        currentBranch: "main",
        defaultBranch: "main",
      } as any);

      let resolveWorktree = (_value: { worktreePath: string; actualBranch: string; created?: boolean }) => {};
      vi.mocked(gitUtils.ensureWorktreeAsync).mockImplementationOnce(
        () =>
          new Promise<any>((resolve) => {
            resolveWorktree = resolve;
          }) as Promise<any>,
      );

      const response = await app.request("/api/sessions/create-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/test", branch: "feat/auth", useWorktree: true }),
      });
      const eventsPromise = parseSSE(response);

      await vi.advanceTimersByTimeAsync(10_500);
      resolveWorktree({ worktreePath: "/test-wt-keepalive", actualBranch: "feat/auth" });
      await vi.runAllTimersAsync();

      const events = await eventsPromise;
      const launchProgress = events
        .filter((e) => e.event === "progress")
        .map((e) => JSON.parse(e.data))
        .filter((event) => event.step === "creating_worktree");
      const creatingWorktreeEvents = launchProgress.filter((event) => event.status === "in_progress");

      expect(creatingWorktreeEvents.length).toBeGreaterThan(1);
      expect(creatingWorktreeEvents.at(-1)?.detail).toContain("Still preparing feat/auth");
      expect(launchProgress.at(-1)?.status).toBe("done");
      expect(events.find((e) => e.event === "done")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps create-stream progress alive during slow launch and does not regress launching_cli back to in-progress", async () => {
    // Protects the second long-running path added in the fix: launch can also
    // be slow, and a late heartbeat must not overwrite the final done state.
    vi.useFakeTimers();
    try {
      let resolveLaunch = (_session: { sessionId: string; state: string; cwd: string; createdAt: number }) => {};
      launcher.launch.mockImplementationOnce(
        () =>
          new Promise<any>((resolve) => {
            resolveLaunch = resolve;
          }),
      );

      const response = await app.request("/api/sessions/create-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/test" }),
      });
      const eventsPromise = parseSSE(response);

      await vi.advanceTimersByTimeAsync(10_500);
      resolveLaunch({
        sessionId: "session-1",
        state: "starting",
        cwd: "/test",
        createdAt: Date.now(),
      });
      await vi.runAllTimersAsync();

      const events = await eventsPromise;
      const launchingCliProgress = events
        .filter((e) => e.event === "progress")
        .map((e) => JSON.parse(e.data))
        .filter((event) => event.step === "launching_cli");

      expect(launchingCliProgress.filter((event) => event.status === "in_progress").length).toBeGreaterThan(1);
      expect(launchingCliProgress.at(-2)?.detail).toContain("Still launching CLI");
      expect(launchingCliProgress.at(-1)?.status).toBe("done");
      expect(
        launchingCliProgress.slice(launchingCliProgress.findIndex((event) => event.status === "done") + 1),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses current branch for worktree create-stream when branch is omitted", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/test",
      currentBranch: "main",
      defaultBranch: "main",
    } as any);
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/test-wt-main",
      actualBranch: "main",
      created: true,
    } as any);

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect(gitUtils.ensureWorktreeAsync).toHaveBeenCalledWith("/test", "main", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/test-wt-main" }));
  });

  it("emits creating_worktree error when useWorktree is enabled without cwd", async () => {
    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useWorktree: true }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(JSON.parse(errorEvent!.data)).toEqual({
      error: "Worktree mode requires a cwd",
      step: "creating_worktree",
    });
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("emits creating_worktree error when useWorktree is enabled outside git repo", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce(null);

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/tmp/non-repo", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(JSON.parse(errorEvent!.data)).toEqual({
      error: "Worktree mode requires a git repository",
      step: "creating_worktree",
    });
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("emits error event for invalid branch name", async () => {
    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", branch: "bad branch name!" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    const errorData = JSON.parse(errorEvent!.data);
    expect(errorData.error).toContain("Invalid branch name");

    // No done event should be emitted
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeUndefined();

    // CLI should NOT be launched
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("emits error event for invalid backend", async () => {
    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "invalid" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(JSON.parse(errorEvent!.data).error).toContain("Invalid backend");
  });

  it("emits container progress events for containerized session", async () => {
    // Env with Docker image — image already exists
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Docker",
      slug: "docker",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-stream",
      name: "companion-stream",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "docker" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events.filter((e) => e.event === "progress").map((e) => JSON.parse(e.data).step);

    expect(steps).toContain("creating_container");
    expect(steps).toContain("launching_cli");

    // Done event should include sessionId
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect(JSON.parse(doneEvent!.data).sessionId).toBe("session-1");
  });

  it("tries pull then falls back to build when image is missing", async () => {
    // Env with missing default Docker image — pull succeeds
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Docker",
      slug: "docker",
      variables: { ANTHROPIC_API_KEY: "key" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    // First call: the-companion:latest not found; second call: companion-dev:latest not found either
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(false).mockReturnValueOnce(false);
    const pullSpy = vi.spyOn(containerManager, "pullImage").mockResolvedValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-pulled",
      name: "companion-pulled",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "docker" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events.filter((e) => e.event === "progress").map((e) => JSON.parse(e.data).step);

    // Should have pulling_image step
    expect(steps).toContain("pulling_image");
    expect(pullSpy).toHaveBeenCalledWith(expect.stringContaining("docker.io"), "the-companion:latest");

    // Should NOT have building_image (pull succeeded)
    expect(steps).not.toContain("building_image");
  });

  it("falls back to build when pull fails", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Docker",
      slug: "docker",
      variables: { ANTHROPIC_API_KEY: "key" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    // First call: the-companion:latest not found; second call: companion-dev:latest not found either
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(false).mockReturnValueOnce(false);
    vi.spyOn(containerManager, "pullImage").mockResolvedValueOnce(false);
    vi.mocked(existsSync).mockReturnValueOnce(true); // Dockerfile exists
    const buildSpy = vi.spyOn(containerManager, "buildImage").mockReturnValue("ok");
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-built",
      name: "companion-built",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "docker" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events.filter((e) => e.event === "progress").map((e) => JSON.parse(e.data).step);

    // Should have both pulling_image and building_image steps
    expect(steps).toContain("pulling_image");
    expect(steps).toContain("building_image");
    expect(buildSpy).toHaveBeenCalledWith(expect.stringContaining("Dockerfile.the-companion"), "the-companion:latest");
  });

  it("emits init script progress events when env has initScript", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "WithInit",
      slug: "with-init",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      initScript: "npm install",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-init-stream",
      name: "companion-init-stream",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});
    vi.spyOn(containerManager, "execInContainerAsync").mockResolvedValueOnce({ exitCode: 0, output: "ok" });

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "with-init" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events.filter((e) => e.event === "progress").map((e) => JSON.parse(e.data).step);

    expect(steps).toContain("running_init_script");
    expect(steps).toContain("launching_cli");

    // Done event should be present
    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
  });

  it("emits error and cleans up when init script fails", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "FailInit",
      slug: "fail-init",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      initScript: "exit 1",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-fail-stream",
      name: "companion-fail-stream",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    const removeSpy = vi.spyOn(containerManager, "removeContainer").mockImplementation(() => {});
    vi.spyOn(containerManager, "execInContainerAsync").mockResolvedValueOnce({
      exitCode: 1,
      output: "npm ERR! missing script",
    });

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "fail-init" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);

    // Should have an error event for init script failure
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    const errorData = JSON.parse(errorEvent!.data);
    expect(errorData.error).toContain("Init script failed");
    expect(errorData.step).toBe("running_init_script");

    // Container should be cleaned up
    expect(removeSpy).toHaveBeenCalled();

    // No done event
    expect(events.find((e) => e.event === "done")).toBeUndefined();

    // CLI should NOT be launched
    expect(launcher.launch).not.toHaveBeenCalled();
  });
});
