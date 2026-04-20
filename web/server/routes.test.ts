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
  isWorktreeDirty: vi.fn(() => false),
  isWorktreeDirtyAsync: vi.fn(async () => false),
  resolveDefaultBranch: vi.fn(() => "main"),
  getBranchStatus: vi.fn(() => ({ ahead: 0, behind: 0 })),
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
import { tmpdir } from "node:os";
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
    _vscodeSelectionState: null as any,
    _vscodeWindows: [] as any[],
    closeSession: vi.fn(),
    getSession: vi.fn(() => null),
    getOrCreateSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    refreshWorktreeGitStateForSnapshot: vi.fn(async () => null),
    getLastUserMessage: vi.fn(() => undefined),
    isBackendConnected: vi.fn(() => false),
    getCodexRateLimits: vi.fn(() => null),
    refreshCodexSkills: vi.fn(async () => ({ ok: true, skills: [] })),
    markContainerized: vi.fn(),
    markWorktree: vi.fn(),
    setInitialCwd: vi.fn(),
    setDiffBaseBranch: vi.fn(() => true),
    refreshGitInfoPublic: vi.fn(async () => true),
    onSessionArchived: vi.fn(),
    onSessionUnarchived: vi.fn(),
    setInitialAskPermission: vi.fn(),
    markResumedFromExternal: vi.fn(),
    broadcastSessionUpdate: vi.fn(),
    broadcastToSession: vi.fn(),
    broadcastGlobal: vi.fn(),
    broadcastNameUpdate: vi.fn(),
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
    setSessionClaimedQuest: vi.fn(),
    addTaskEntry: vi.fn(),
    updateQuestTaskEntries: vi.fn(),
    removeBoardRowFromAll: vi.fn(),
    getBoard: vi.fn(() => []),
    getBoardRow: vi.fn(() => null),
    getBoardQueueWarnings: vi.fn(() => []),
    getBoardWorkerSlotUsage: vi.fn(() => ({ used: 0, limit: 5 })),
    getCompletedBoard: vi.fn(() => []),
    getCompletedBoardCount: vi.fn(() => 0),
    upsertBoardRow: vi.fn(() => []),
    removeBoardRows: vi.fn(() => []),
    advanceBoardRow: vi.fn(() => null),
    prepareSessionForRevert: vi.fn(
      (sessionId: string, truncateIdx: number, options?: { clearCodexState?: boolean }) => {
        const session = bridge.getOrCreateSession.mock.results.at(-1)?.value;
        if (!session) return null;
        session.messageHistory = session.messageHistory.slice(0, truncateIdx);
        session.frozenCount = Math.min(session.frozenCount ?? 0, session.messageHistory.length);
        session.pendingPermissions?.clear?.();
        session.eventBuffer = [];
        session.awaitingCompactSummary = false;
        session.compactedDuringTurn = false;
        if (session.state) session.state.is_compacting = false;
        if (options?.clearCodexState) {
          session.pendingCodexTurns = [];
          session.pendingCodexInputs = [];
          session.pendingMessages = [];
          session.pendingCodexRollback = null;
          session.pendingCodexRollbackError = null;
          session.userMessageIdsThisTurn = [];
          session.queuedTurnStarts = 0;
          session.queuedTurnReasons = [];
          session.queuedTurnUserMessageIds = [];
          session.queuedTurnInterruptSources = [];
          session.interruptedDuringTurn = false;
          session.interruptSourceDuringTurn = null;
          session.isGenerating = false;
          session.generationStartedAt = null;
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
    getSessionAttentionState: vi.fn(() => null),
    getSessionTaskHistory: vi.fn(() => []),
    getSessionKeywords: vi.fn(() => []),
    getMessageHistory: vi.fn(() => []),
    getToolResult: vi.fn(() => null),
    markSessionRead: vi.fn(() => true),
    markSessionUnread: vi.fn(() => true),
    markAllSessionsRead: vi.fn(),
    injectUserMessage: vi.fn(() => "sent" as const),
    emitTakodeEvent: vi.fn(),
    subscribeTakodeEvents: vi.fn(() => () => {}),
    routeExternalPermissionResponse: vi.fn(),
    routeExternalInterrupt: vi.fn(async () => {}),
    notifyUser: vi.fn(() => ({ ok: true, anchoredMessageId: "msg-123" })),
    markNotificationDone: vi.fn(() => true),
    markAllNotificationsDone: vi.fn(() => 0),
    getNotifications: vi.fn(() => []),
    isSessionBusy: vi.fn(() => false),
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

describe("POST /api/sessions/create", () => {
  it("launches a session and returns its info", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5-20250929", cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ sessionId: "session-1", state: "starting", cwd: "/test" });
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-5-20250929", cwd: "/test" }),
    );
  });

  it("injects environment variables when envSlug is provided", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Production",
      slug: "production",
      variables: { API_KEY: "secret123", DB_HOST: "db.example.com" },
      createdAt: 1000,
      updatedAt: 1000,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "production" }),
    });

    expect(res.status).toBe(200);
    expect(envManager.getEnv).toHaveBeenCalledWith("production");
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ API_KEY: "secret123", DB_HOST: "db.example.com" }),
      }),
    );
  });

  it("fetches and pulls before create when branch matches current branch", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.getRepoInfo).not.toHaveBeenCalled();
    expect(gitUtils.gitFetch).not.toHaveBeenCalled();
    expect(gitUtils.gitPull).not.toHaveBeenCalled();
    expect(gitUtils.gitFetchAsync).toHaveBeenCalledWith("/repo");
    expect(gitUtils.checkoutBranchAsync).not.toHaveBeenCalled();
    expect(gitUtils.gitPullAsync).toHaveBeenCalledWith("/repo");
  });

  it("fetches, checks out selected branch, then pulls before create", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "develop",
      defaultBranch: "main",
      isWorktree: false,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.getRepoInfo).not.toHaveBeenCalled();
    expect(gitUtils.checkoutBranch).not.toHaveBeenCalled();
    expect(gitUtils.gitFetchAsync).toHaveBeenCalledWith("/repo");
    expect(gitUtils.checkoutBranchAsync).toHaveBeenCalledWith("/repo", "main");
    expect(gitUtils.gitPullAsync).toHaveBeenCalledWith("/repo");
    expect(vi.mocked(gitUtils.gitFetchAsync).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitUtils.checkoutBranchAsync).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(gitUtils.checkoutBranchAsync).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitUtils.gitPullAsync).mock.invocationCallOrder[0],
    );
  });

  it("proceeds with session creation when fetch fails (non-fatal, same as pull)", async () => {
    // git fetch failure should NOT block session creation — the branch may already exist locally.
    // This matches the existing non-fatal behavior for git pull (see next test).
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitFetchAsync).mockResolvedValueOnce({
      success: false,
      output: "network error",
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.gitFetchAsync).toHaveBeenCalledWith("/repo");
    // Pull is still called (fetch failure doesn't abort the pipeline)
    expect(gitUtils.gitPullAsync).toHaveBeenCalledWith("/repo");
    expect(launcher.launch).toHaveBeenCalled();
  });

  it("proceeds with session creation when pull fails (non-fatal)", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitPullAsync).mockResolvedValueOnce({
      success: false,
      output: "no tracking information",
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    // Pull failure is non-fatal — session should still be created
    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalled();
  });

  it("returns 500 when launch throws an error", async () => {
    launcher.launch.mockImplementation(() => {
      throw new Error("CLI binary not found");
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: "CLI binary not found" });
  });

  it("returns 400 for invalid backend values", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "invalid-backend" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid backend");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("injects COMPANION_PORT for resumed sessions", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        backend: "claude",
        cwd: "/test",
        resumeCliSessionId: "cli-resume-1",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeCliSessionId: "cli-resume-1",
        env: expect.objectContaining({
          COMPANION_PORT: "3456",
        }),
      }),
    );
  });

  it("sets up a worktree when useWorktree and branch are specified", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/home/.companion/worktrees/my-repo/feat-branch",
      branch: "feat-branch",
      actualBranch: "feat-branch",
      isNew: true,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "feat-branch", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.getRepoInfo).not.toHaveBeenCalled();
    expect(gitUtils.ensureWorktree).not.toHaveBeenCalled();
    // ensureWorktree should be called with forceNew: true
    expect(gitUtils.ensureWorktreeAsync).toHaveBeenCalledWith("/repo", "feat-branch", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    // launcher should receive the worktree path as cwd
    expect(launcher.launch).toHaveBeenCalled();
    const launchOpts = launcher.launch.mock.calls[0][0];
    expect(launchOpts.cwd).toBe("/home/.companion/worktrees/my-repo/feat-branch");
    // Worktree mapping should be tracked
    expect(tracker.addMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        repoRoot: "/repo",
        branch: "feat-branch",
        actualBranch: "feat-branch",
        worktreePath: "/home/.companion/worktrees/my-repo/feat-branch",
      }),
    );
  });

  it("falls back to current branch when useWorktree is enabled but branch is omitted", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/home/.companion/worktrees/my-repo/main",
      branch: "main",
      actualBranch: "main",
      isNew: true,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", useWorktree: true }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.ensureWorktreeAsync).toHaveBeenCalledWith("/repo", "main", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/home/.companion/worktrees/my-repo/main" }),
    );
  });

  it("creates worker worktrees from the main repo root when cwd is already a worktree", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce({
      repoRoot: "/repo",
      repoName: "companion",
      currentBranch: "jiayi-wt-2775",
      defaultBranch: "jiayi",
      isWorktree: true,
    });
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValueOnce({
      worktreePath: "/home/.companion/worktrees/companion/jiayi-wt-9326",
      branch: "jiayi",
      actualBranch: "jiayi-wt-9326",
      isNew: true,
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/home/.companion/worktrees/companion/jiayi-wt-2775",
        useWorktree: true,
      }),
    });

    expect(res.status).toBe(200);
    // When CWD is already a worktree, should use the base branch (jiayi),
    // not the worktree branch (jiayi-wt-2775), to avoid worktree-of-a-worktree
    expect(gitUtils.ensureWorktreeAsync).toHaveBeenCalledWith("/repo", "jiayi", {
      baseBranch: "jiayi",
      createBranch: undefined,
      forceNew: true,
    });
    expect(tracker.addMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo",
        worktreePath: "/home/.companion/worktrees/companion/jiayi-wt-9326",
      }),
    );
  });

  it("returns 400 when useWorktree is enabled without cwd", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useWorktree: true }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Worktree mode requires a cwd" });
    expect(gitUtils.ensureWorktreeAsync).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("returns 400 when useWorktree is enabled outside a git repository", async () => {
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce(null);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/not-a-repo", useWorktree: true }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Worktree mode requires a git repository" });
    expect(gitUtils.ensureWorktreeAsync).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("returns 503 when env has Docker image but container startup fails", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Companion",
      slug: "companion",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "companion-dev:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("companion-dev:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockImplementationOnce(() => {
      throw new Error("docker daemon timeout");
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "companion" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Docker is required");
    expect(json.error).toContain("container startup failed");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("returns 400 when containerized Codex session lacks auth", async () => {
    // Codex in containers needs OPENAI_API_KEY or ~/.codex/auth.json.
    // existsSync must return true for the cwd check but false for auth file checks
    vi.mocked(existsSync).mockImplementation((p) => !String(p).includes(".codex"));
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Codex Docker",
      slug: "codex-docker",
      variables: {},
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "codex-docker", backend: "codex" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Containerized Codex requires auth");
    expect(json.error).toContain("OPENAI_API_KEY");
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("allows containerized Codex when OPENAI_API_KEY is provided", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Codex Docker",
      slug: "codex-docker",
      variables: { OPENAI_API_KEY: "sk-test" },
      baseImage: "the-companion:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-codex",
      name: "companion-codex",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "codex-docker", backend: "codex" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ backendType: "codex", containerId: "cid-codex" }),
    );
  });

  it("auto-builds companion base image when missing locally", async () => {
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "Companion",
      slug: "companion",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "companion-dev:latest",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("companion-dev:latest");
    vi.mocked(existsSync).mockReturnValueOnce(true);
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(false);
    const buildSpy = vi.spyOn(containerManager, "buildImage").mockReturnValue("ok");
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-1",
      name: "companion-temp",
      image: "companion-dev:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "companion" }),
    });

    expect(res.status).toBe(200);
    expect(buildSpy).toHaveBeenCalledWith(expect.stringContaining("Dockerfile.companion-dev"), "companion-dev:latest");
    expect(launcher.launch).toHaveBeenCalled();
  });

  it("runs init script before launching CLI when env has initScript", async () => {
    // Environment with initScript and Docker image
    vi.mocked(envManager.getEnv).mockResolvedValue({
      name: "WithInit",
      slug: "with-init",
      variables: { CLAUDE_CODE_OAUTH_TOKEN: "token" },
      baseImage: "the-companion:latest",
      initScript: "bun install && pip install -r requirements.txt",
      createdAt: 1000,
      updatedAt: 1000,
    } as any);
    vi.mocked(envManager.getEffectiveImage).mockResolvedValue("the-companion:latest");
    vi.spyOn(containerManager, "imageExists").mockReturnValueOnce(true);
    vi.spyOn(containerManager, "createContainer").mockReturnValueOnce({
      containerId: "cid-init",
      name: "companion-init",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/test",
      containerCwd: "/workspace",
      state: "running",
    });
    vi.spyOn(containerManager, "retrack").mockImplementation(() => {});
    const execAsyncSpy = vi
      .spyOn(containerManager, "execInContainerAsync")
      .mockResolvedValueOnce({ exitCode: 0, output: "installed!" });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "with-init" }),
    });

    expect(res.status).toBe(200);
    // Init script should have been executed
    expect(execAsyncSpy).toHaveBeenCalledWith(
      "cid-init",
      ["sh", "-lc", "bun install && pip install -r requirements.txt"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    // CLI should have been launched after init script
    expect(launcher.launch).toHaveBeenCalled();
  });

  it("returns 503 and cleans up container when init script fails", async () => {
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
      containerId: "cid-fail",
      name: "companion-fail",
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

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "fail-init" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("Init script failed");
    // Container should be cleaned up
    expect(removeSpy).toHaveBeenCalled();
    // CLI should NOT have been launched
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("stores reviewerOf on the session when provided in request body", async () => {
    // When the CLI sends reviewerOf in the create payload, the server should
    // store it on the session object so it's visible in API responses.
    const launchedSession = {
      sessionId: "reviewer-session",
      state: "starting",
      cwd: "/test",
      createdAt: Date.now(),
    };
    launcher.launch.mockReturnValue(launchedSession);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        reviewerOf: 42,
        noAutoName: true,
        fixedName: "Reviewer of #42",
      }),
    });

    expect(res.status).toBe(200);
    // applySessionPostLaunch mutates the session object in-place,
    // so reviewerOf should be on the returned JSON
    const json = await res.json();
    expect(json.reviewerOf).toBe(42);
  });

  it("rejects creation when an active reviewer already exists for the same parent (409)", async () => {
    // Server-side enforcement of one-reviewer-per-parent prevents TOCTOU races
    // where two concurrent CLI spawn commands both pass the client-side check.
    launcher.listSessions.mockReturnValue([
      {
        sessionId: "existing-reviewer",
        state: "connected",
        cwd: "/test",
        createdAt: Date.now(),
        reviewerOf: 42,
        archived: false,
      },
    ]);
    launcher.getSessionNum.mockReturnValue(99);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        reviewerOf: 42,
        noAutoName: true,
        fixedName: "Reviewer of #42",
      }),
    });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("already has an active reviewer");
    // Session should NOT have been launched
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("allows reviewer creation when existing reviewer for same parent is archived", async () => {
    // Archived reviewers should not block new reviewer creation
    launcher.listSessions.mockReturnValue([
      {
        sessionId: "old-reviewer",
        state: "exited",
        cwd: "/test",
        createdAt: Date.now(),
        reviewerOf: 42,
        archived: true, // archived -- should not block
      },
    ]);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        reviewerOf: 42,
        noAutoName: true,
        fixedName: "Reviewer of #42",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalled();
  });
});

describe("GET /api/sessions", () => {
  it("returns the list of sessions enriched with names", async () => {
    const sessions = [
      { sessionId: "s1", state: "running", cwd: "/a" },
      { sessionId: "s2", state: "stopped", cwd: "/b" },
    ];
    launcher.listSessions.mockReturnValue(sessions);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({ s1: "Fix auth bug" });

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      {
        sessionId: "s1",
        state: "running",
        cwd: "/a",
        name: "Fix auth bug",
        sessionNum: null,
        gitBranch: "",
        gitDefaultBranch: "",
        diffBaseBranch: "",
        gitAhead: 0,
        gitBehind: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        numTurns: 0,
        contextUsedPercent: 0,
        messageHistoryBytes: 0,
        codexRetainedPayloadBytes: 0,
        lastMessagePreview: "",
        cliConnected: false,
        taskHistory: [],
        keywords: [],
        claimedQuestId: null,
        claimedQuestStatus: null,
        pendingTimerCount: 0,
      },
      {
        sessionId: "s2",
        state: "stopped",
        cwd: "/b",
        sessionNum: null,
        gitBranch: "",
        gitDefaultBranch: "",
        diffBaseBranch: "",
        gitAhead: 0,
        gitBehind: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        numTurns: 0,
        contextUsedPercent: 0,
        messageHistoryBytes: 0,
        codexRetainedPayloadBytes: 0,
        lastMessagePreview: "",
        cliConnected: false,
        taskHistory: [],
        keywords: [],
        claimedQuestId: null,
        claimedQuestStatus: null,
        pendingTimerCount: 0,
      },
    ]);
  });

  it("includes pendingTimerCount in regular session snapshots", async () => {
    // Sidebar rows for non-selected sessions rely on the polled /api/sessions
    // snapshot, so timer counts must be present even without a live session socket.
    launcher.listSessions.mockReturnValue([
      { sessionId: "s1", state: "running", cwd: "/a" },
      { sessionId: "s2", state: "connected", cwd: "/b" },
    ]);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    timerManager.listTimers.mockImplementation((sessionId: string) => (sessionId === "s2" ? [{ id: "t1" }] : []));

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0]).toMatchObject({ sessionId: "s1", pendingTimerCount: 0 });
    expect(json[1]).toMatchObject({ sessionId: "s2", pendingTimerCount: 1 });
  });

  it("preserves pendingTimerCount when regular session enrichment falls back after an error", async () => {
    // Regression: a bridge read failure must not strip the timer signal that the
    // sidebar uses to highlight idle sessions waiting on scheduled work.
    launcher.listSessions.mockReturnValue([{ sessionId: "s1", state: "connected", cwd: "/a" }]);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    timerManager.listTimers.mockImplementation((sessionId: string) => (sessionId === "s1" ? [{ id: "t7" }] : []));
    bridge.getSession.mockImplementation(() => {
      throw new Error("bridge read failed");
    });

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0]).toMatchObject({ sessionId: "s1", pendingTimerCount: 1 });
  });

  it("enriches sessions with git data from bridge state", async () => {
    const sessions = [
      { sessionId: "s1", state: "running", cwd: "/a" },
      { sessionId: "s2", state: "running", cwd: "/b" },
    ];
    launcher.listSessions.mockReturnValue(sessions);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    bridge.getAllSessions.mockReturnValue([
      {
        session_id: "s1",
        git_branch: "feature/auth",
        git_ahead: 3,
        git_behind: 1,
        total_lines_added: 42,
        total_lines_removed: 7,
      },
    ]);

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    // s1 should have bridge git data
    expect(json[0]).toMatchObject({
      sessionId: "s1",
      gitBranch: "feature/auth",
      gitAhead: 3,
      gitBehind: 1,
      totalLinesAdded: 42,
      totalLinesRemoved: 7,
    });
    // s2 has no bridge data — defaults to empty/zero
    expect(json[1]).toMatchObject({
      sessionId: "s2",
      gitBranch: "",
      gitAhead: 0,
      gitBehind: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    });
  });

  it("includes restored context usage metadata from bridge state", async () => {
    launcher.listSessions.mockReturnValue([{ sessionId: "s1", state: "connected", cwd: "/a", backendType: "codex" }]);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    bridge.getAllSessions.mockReturnValue([
      {
        session_id: "s1",
        context_used_percent: 73,
        codex_token_details: {
          inputTokens: 1200,
          outputTokens: 300,
          cachedInputTokens: 100,
          reasoningOutputTokens: 50,
          modelContextWindow: 258400,
        },
      },
    ]);

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0]).toMatchObject({
      sessionId: "s1",
      contextUsedPercent: 73,
      codexTokenDetails: {
        inputTokens: 1200,
        outputTokens: 300,
        cachedInputTokens: 100,
        reasoningOutputTokens: 50,
        modelContextWindow: 258400,
      },
    });
  });

  it("includes restored Claude token metadata from bridge state", async () => {
    launcher.listSessions.mockReturnValue([{ sessionId: "s1", state: "connected", cwd: "/a", backendType: "claude" }]);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    bridge.getAllSessions.mockReturnValue([
      {
        session_id: "s1",
        context_used_percent: 41,
        claude_token_details: {
          inputTokens: 254,
          outputTokens: 77708,
          cachedInputTokens: 22001692,
          modelContextWindow: 200000,
        },
      },
    ]);

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0]).toMatchObject({
      sessionId: "s1",
      contextUsedPercent: 41,
      claudeTokenDetails: {
        inputTokens: 254,
        outputTokens: 77708,
        cachedInputTokens: 22001692,
        modelContextWindow: 200000,
      },
    });
  });

  it("reports generating sessions as running when the bridge is active", async () => {
    launcher.listSessions.mockReturnValue([{ sessionId: "s1", state: "connected", cwd: "/a" }]);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    bridge.getAllSessions.mockReturnValue([{ session_id: "s1" }]);
    bridge.getSession.mockReturnValue({ isGenerating: true } as any);
    bridge.isBackendConnected.mockReturnValue(true);

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0]).toMatchObject({
      sessionId: "s1",
      state: "running",
      cliConnected: true,
    });
  });

  it("uses cached bridge ahead/behind counts instead of running git per-session", async () => {
    // Previously this test verified that the route ran `git rev-list` per worktree
    // session. That was removed (caused 800-1300ms latency on NFS). Now the route
    // uses cached bridge values from refreshGitInfo (updated on CLI connect).
    const sessions = [{ sessionId: "s1", state: "running", cwd: "/wt/repo", isWorktree: true, branch: "jiayi" }];
    launcher.listSessions.mockReturnValue(sessions);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    bridge.getAllSessions.mockReturnValue([
      {
        session_id: "s1",
        is_worktree: true,
        diff_base_branch: "jiayi",
        git_ahead: 3,
        git_behind: 7,
        total_lines_added: 167,
        total_lines_removed: 858,
      },
    ]);

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Should use cached bridge values, not run git commands
    expect(json[0]).toMatchObject({
      sessionId: "s1",
      gitAhead: 3,
      gitBehind: 7,
      totalLinesAdded: 167,
      totalLinesRemoved: 858,
    });
  });

  it("refreshes worktree diff totals before returning session rows", async () => {
    const sessions = [{ sessionId: "s1", state: "running", cwd: "/wt/repo", isWorktree: true, archived: false }];
    const bridgeSession = {
      state: {
        session_id: "s1",
        is_worktree: true,
        git_branch: "jiayi-wt-9869",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 777,
        total_lines_removed: 55,
      },
      isGenerating: false,
    };
    launcher.listSessions.mockReturnValue(sessions);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    bridge.getSession.mockReturnValue(bridgeSession as any);
    bridge.refreshWorktreeGitStateForSnapshot.mockImplementation(async () => {
      bridgeSession.state.total_lines_added = 0;
      bridgeSession.state.total_lines_removed = 0;
      return bridgeSession.state as any;
    });

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    expect(bridge.refreshWorktreeGitStateForSnapshot).toHaveBeenCalledWith("s1", {
      broadcastUpdate: true,
      notifyPoller: true,
    });
    const json = await res.json();
    expect(json[0]).toMatchObject({
      sessionId: "s1",
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    });
  });

  it("returns cached worktree diff totals in heavy repo mode without scheduling git refreshes", async () => {
    const defaultSettings = vi.mocked(settingsManager.getSettings).getMockImplementation()?.() as ReturnType<
      typeof settingsManager.getSettings
    >;
    vi.mocked(settingsManager.getSettings).mockReturnValueOnce({
      ...defaultSettings,
      heavyRepoModeEnabled: true,
    });
    const sessions = [{ sessionId: "s1", state: "running", cwd: "/wt/repo", isWorktree: true, archived: false }];
    const bridgeSession = {
      state: {
        session_id: "s1",
        is_worktree: true,
        git_branch: "jiayi-wt-9869",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 777,
        total_lines_removed: 55,
      },
      isGenerating: false,
    };
    launcher.listSessions.mockReturnValue(sessions);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});
    bridge.getSession.mockReturnValue(bridgeSession as any);

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Heavy repo mode keeps the list endpoint fast by returning cached values.
    expect(json[0]).toMatchObject({
      sessionId: "s1",
      totalLinesAdded: 777,
      totalLinesRemoved: 55,
    });
    await Promise.resolve();
    expect(bridge.refreshWorktreeGitStateForSnapshot).not.toHaveBeenCalled();
  });

  it("includes worktreeExists for archived worktree sessions", async () => {
    // Archived worktree session whose worktree still exists
    const sessions = [
      { sessionId: "s1", state: "exited", cwd: "/wt/repo-wt-1234", isWorktree: true, archived: true },
      { sessionId: "s2", state: "running", cwd: "/wt/repo-wt-5678", isWorktree: true, archived: false },
    ];
    launcher.listSessions.mockReturnValue(sessions);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({});

    const res = await app.request("/api/sessions", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    // s1: archived worktree — only worktreeExists (no expensive git status)
    expect(json[0]).toMatchObject({
      sessionId: "s1",
      worktreeExists: true,
    });
    // worktreeDirty is NOT included (too expensive for session list)
    expect(json[0].worktreeDirty).toBeUndefined();
    // s2: non-archived worktree — no worktree status fields
    expect(json[1].worktreeExists).toBeUndefined();
  });
});

describe("GET /api/sessions/search", () => {
  it("returns 400 when q is missing", async () => {
    const res = await app.request("/api/sessions/search", { method: "GET" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "q is required" });
  });

  it("searches metadata + user messages and includes archived sessions by default", async () => {
    launcher.listSessions.mockReturnValue([
      { sessionId: "s-active", state: "running", cwd: "/active", createdAt: 1, archived: false },
      { sessionId: "s-archived", state: "exited", cwd: "/archived", createdAt: 2, archived: true },
    ]);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({
      "s-active": "General session",
      "s-archived": "Old archived session",
    });
    bridge.getAllSessions.mockReturnValue([
      { session_id: "s-active", cwd: "/active", repo_root: "/repo/active", git_branch: "main" },
      { session_id: "s-archived", cwd: "/archived", repo_root: "/repo/archived", git_branch: "archive/fix" },
    ]);
    bridge.getMessageHistory.mockImplementation((id: string) => {
      if (id === "s-archived") {
        return [{ type: "user_message", content: "find me from archived history", timestamp: 1234, id: "u-1" }];
      }
      return [];
    });

    const res = await app.request("/api/sessions/search?q=archived", { method: "GET" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.totalMatches).toBeGreaterThanOrEqual(1);
    expect(json.results.some((r: any) => r.sessionId === "s-archived")).toBe(true);
  });

  it("applies ranking and includeArchived=false filter", async () => {
    launcher.listSessions.mockReturnValue([
      { sessionId: "s-meta", state: "running", cwd: "/meta", createdAt: 1, archived: false, lastActivityAt: 10 },
      { sessionId: "s-msg", state: "running", cwd: "/msg", createdAt: 2, archived: false, lastActivityAt: 999 },
      {
        sessionId: "s-archived",
        state: "exited",
        cwd: "/archived",
        createdAt: 3,
        archived: true,
        lastActivityAt: 1000,
      },
    ]);
    vi.mocked(sessionNames.getAllNames).mockReturnValue({
      "s-meta": "Needle session",
      "s-msg": "General session",
      "s-archived": "Needle archived",
    });
    bridge.getAllSessions.mockReturnValue([
      { session_id: "s-meta", cwd: "/meta", repo_root: "/repo/meta", git_branch: "main" },
      { session_id: "s-msg", cwd: "/msg", repo_root: "/repo/msg", git_branch: "main" },
      { session_id: "s-archived", cwd: "/archived", repo_root: "/repo/archived", git_branch: "main" },
    ]);
    bridge.getMessageHistory.mockImplementation((id: string) => {
      if (id === "s-msg") {
        return [{ type: "user_message", content: "contains needle in user message", timestamp: 9999, id: "u-msg" }];
      }
      if (id === "s-archived") {
        return [
          { type: "user_message", content: "contains needle in archived message", timestamp: 11111, id: "u-arch" },
        ];
      }
      return [];
    });

    const res = await app.request("/api/sessions/search?q=needle&includeArchived=false", { method: "GET" });
    expect(res.status).toBe(200);
    const json = await res.json();

    // Metadata match should outrank user-message match.
    expect(json.results[0]).toMatchObject({
      sessionId: "s-meta",
      matchedField: "name",
    });
    expect(json.results.some((r: any) => r.sessionId === "s-archived")).toBe(false);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns the session when found", async () => {
    const session = { sessionId: "s1", state: "running", cwd: "/test" };
    launcher.getSession.mockReturnValue(session);

    const res = await app.request("/api/sessions/s1", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Response includes launcher session fields + isGenerating from ws-bridge
    expect(json).toMatchObject(session);
    expect(typeof json.isGenerating).toBe("boolean");
  });

  it("returns 404 when session not found", async () => {
    launcher.getSession.mockReturnValue(undefined);

    const res = await app.request("/api/sessions/nonexistent", { method: "GET" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Session not found" });
  });
});

describe("GET /api/sessions/:id/recording/status", () => {
  it("returns recording metadata and sdk debug path when found", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "s1",
      state: "running",
      cwd: "/test",
      sdkDebugLogPath: "/logs/claude-sdk-s1.log",
    });

    const res = await app.request("/api/sessions/s1/recording/status", { method: "GET" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recording: true,
      available: true,
      recordingsDir: "/tmp/companion-recordings",
      globalEnabled: true,
      sdkDebugFile: "/logs/claude-sdk-s1.log",
      filePath: "/tmp/companion-recordings/session-1.jsonl",
    });
  });

  it("returns 404 when session not found", async () => {
    launcher.getSession.mockReturnValue(undefined);

    const res = await app.request("/api/sessions/s1/recording/status", { method: "GET" });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });
});

describe("POST /api/sessions/:id/kill", () => {
  it("returns ok when session is killed", async () => {
    launcher.kill.mockResolvedValue(true);

    const res = await app.request("/api/sessions/s1/kill", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("returns 404 when session not found", async () => {
    launcher.kill.mockResolvedValue(false);

    const res = await app.request("/api/sessions/nonexistent/kill", { method: "POST" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Session not found or already exited" });
  });
});

describe("POST /api/sessions/:id/relaunch", () => {
  it("returns ok when session is relaunched", async () => {
    launcher.getSession.mockReturnValue({ sessionId: "s1", state: "exited", cwd: "/test" });
    launcher.relaunch.mockResolvedValue({ ok: true });

    const res = await app.request("/api/sessions/s1/relaunch", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(launcher.relaunch).toHaveBeenCalledWith("s1");
  });

  it("backfills missing repoRoot from bridge state before relaunch", async () => {
    const info = { sessionId: "s1", state: "exited", cwd: "/repo/web", repoRoot: undefined };
    launcher.getSession.mockReturnValue(info);
    launcher.relaunch.mockResolvedValue({ ok: true });
    bridge.getSession.mockReturnValue({
      id: "s1",
      state: { repo_root: "/repo", cwd: "/repo/web" },
    });

    const res = await app.request("/api/sessions/s1/relaunch", { method: "POST" });

    expect(res.status).toBe(200);
    expect(info.repoRoot).toBe("/repo");
    expect(launcher.relaunch).toHaveBeenCalledWith("s1");
  });

  it("returns 503 with error when container is missing", async () => {
    launcher.getSession.mockReturnValue({ sessionId: "s1", state: "exited", cwd: "/test", containerId: "abc" });
    launcher.relaunch.mockResolvedValue({
      ok: false,
      error: 'Container "companion-gone" was removed externally. Please create a new session.',
    });

    const res = await app.request("/api/sessions/s1/relaunch", { method: "POST" });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("removed externally");
  });

  it("returns 404 when session not found via relaunch", async () => {
    launcher.getSession.mockReturnValue(undefined);

    const res = await app.request("/api/sessions/nonexistent/relaunch", { method: "POST" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Session not found");
  });

  // Regression: result.error?.includes() throws in minified builds when error is undefined.
  // Using explicit && guard prevents "undefined is not an object (evaluating H.includes)".
  it("returns 503 (not crash) when relaunch error message is undefined", async () => {
    launcher.getSession.mockReturnValue({ sessionId: "s1", state: "exited", cwd: "/test", createdAt: Date.now() });
    launcher.relaunch.mockResolvedValue({ ok: false }); // no error property
    const res = await app.request("/api/sessions/s1/relaunch", { method: "POST" });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("Relaunch failed");
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("kills, removes, and closes session", async () => {
    const res = await app.request("/api/sessions/s1", { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true });
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(launcher.removeSession).toHaveBeenCalledWith("s1");
    expect(bridge.closeSession).toHaveBeenCalledWith("s1");
  });

  it("kills, removes, cleans up worktree, and closes session", async () => {
    tracker.getBySession.mockReturnValue({
      sessionId: "s1",
      repoRoot: "/repo",
      branch: "feat",
      worktreePath: "/wt/feat",
      createdAt: 1000,
    });
    tracker.isWorktreeInUse.mockReturnValue(false);
    vi.mocked(gitUtils.isWorktreeDirty).mockReturnValue(false);
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({ removed: true });

    const res = await app.request("/api/sessions/s1", { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true });
    expect(json.worktree).toMatchObject({ cleaned: true, path: "/wt/feat" });
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(launcher.removeSession).toHaveBeenCalledWith("s1");
    expect(bridge.closeSession).toHaveBeenCalledWith("s1");
    expect(tracker.removeBySession).toHaveBeenCalledWith("s1");
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
      force: false,
      branchToDelete: undefined,
    });
  });

  it("passes branchToDelete when actualBranch differs from branch", async () => {
    tracker.getBySession.mockReturnValue({
      sessionId: "s1",
      repoRoot: "/repo",
      branch: "feat",
      actualBranch: "feat-wt-1234",
      worktreePath: "/wt/feat",
      createdAt: 1000,
    });
    tracker.isWorktreeInUse.mockReturnValue(false);
    vi.mocked(gitUtils.isWorktreeDirty).mockReturnValue(false);
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({ removed: true });

    const res = await app.request("/api/sessions/s1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", {
      force: false,
      branchToDelete: "feat-wt-1234",
    });
  });

  it("emits session_archived herd event when deleting a herded session", async () => {
    // When a herded worker is deleted, the leader should be notified via
    // session_archived (the same proven path used by explicit archiving).
    launcher.getSession.mockReturnValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/test",
      createdAt: Date.now(),
      herdedBy: "leader-1",
      archived: false,
    });

    const res = await app.request("/api/sessions/s1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(bridge.emitTakodeEvent).toHaveBeenCalledWith(
      "s1",
      "session_archived",
      { archive_source: "user" },
      undefined,
    );
  });

  it("skips herd event when deleting an already-archived session", async () => {
    // Avoid double-notifying the leader if the session was archived before deletion.
    launcher.getSession.mockReturnValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/test",
      createdAt: Date.now(),
      herdedBy: "leader-1",
      archived: true,
    });

    const res = await app.request("/api/sessions/s1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(bridge.emitTakodeEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/sessions/:id/archive", () => {
  function companionAuthHeaders(sessionId: string, token = "tok"): Record<string, string> {
    return {
      "x-companion-session-id": sessionId,
      "x-companion-auth-token": token,
      "Content-Type": "application/json",
    };
  }

  it("kills and archives the session", async () => {
    const res = await app.request("/api/sessions/s1/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true });
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(launcher.setArchived).toHaveBeenCalledWith("s1", true);
    expect(sessionStore.setArchived).toHaveBeenCalledWith("s1", true);
  });

  it("auto-stops and archives reviewer sessions when parent is archived", async () => {
    // Parent session #42 has a reviewer session linked via reviewerOf
    launcher.getSessionNum.mockReturnValue(42);
    launcher.listSessions.mockReturnValue([
      {
        sessionId: "reviewer-1",
        state: "connected",
        cwd: "/test",
        createdAt: Date.now(),
        reviewerOf: 42,
        herdedBy: "leader-1",
        archived: false,
      },
      {
        sessionId: "unrelated-worker",
        state: "connected",
        cwd: "/test",
        createdAt: Date.now(),
        archived: false,
      },
    ]);

    const res = await app.request("/api/sessions/s1/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    // Parent session should be killed and archived
    expect(launcher.kill).toHaveBeenCalledWith("s1");
    expect(launcher.setArchived).toHaveBeenCalledWith("s1", true);
    // Reviewer session should also be killed and archived
    expect(launcher.kill).toHaveBeenCalledWith("reviewer-1");
    expect(launcher.setArchived).toHaveBeenCalledWith("reviewer-1", true);
    expect(sessionStore.setArchived).toHaveBeenCalledWith("reviewer-1", true);
    // Reviewer should emit session_archived (not session_deleted) since it's herded
    expect(bridge.emitTakodeEvent).toHaveBeenCalledWith("reviewer-1", "session_archived", {
      archive_source: "cascade",
    });
    // Kill must happen BEFORE emit so the leader doesn't query a still-alive session
    const killOrder = launcher.kill.mock.invocationCallOrder.find(
      (_: number, i: number) => launcher.kill.mock.calls[i][0] === "reviewer-1",
    );
    const emitOrder = bridge.emitTakodeEvent.mock.invocationCallOrder[0];
    expect(killOrder).toBeDefined();
    expect(emitOrder).toBeDefined();
    expect(killOrder).toBeLessThan(emitOrder!);
    // Unrelated worker should NOT be touched
    expect(launcher.kill).not.toHaveBeenCalledWith("unrelated-worker");
  });

  it("skips already-archived reviewer sessions during cascade", async () => {
    // Reviewer is already archived -- should not be killed again
    launcher.getSessionNum.mockReturnValue(42);
    launcher.listSessions.mockReturnValue([
      {
        sessionId: "reviewer-1",
        state: "exited",
        cwd: "/test",
        createdAt: Date.now(),
        reviewerOf: 42,
        herdedBy: "leader-1",
        archived: true, // already archived
      },
    ]);

    const res = await app.request("/api/sessions/s1/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    // Only the parent should be killed, not the already-archived reviewer
    expect(launcher.kill).toHaveBeenCalledTimes(1);
    expect(launcher.kill).toHaveBeenCalledWith("s1");
  });

  it("marks direct archive herd events as user-initiated when no actor session exists", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/test",
      createdAt: Date.now(),
      herdedBy: "leader-1",
      archived: false,
    });

    const res = await app.request("/api/sessions/s1/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(bridge.emitTakodeEvent).toHaveBeenCalledWith(
      "s1",
      "session_archived",
      { archive_source: "user" },
      undefined,
    );
  });

  it("marks authenticated archive herd events as leader-initiated and preserves actorSessionId", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/test",
      createdAt: Date.now(),
      herdedBy: "leader-1",
      archived: false,
    });

    const res = await app.request("/api/sessions/s1/archive", {
      method: "POST",
      headers: companionAuthHeaders("leader-1"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(bridge.emitTakodeEvent).toHaveBeenCalledWith(
      "s1",
      "session_archived",
      { archive_source: "leader" },
      "leader-1",
    );
  });
});

// Archive Group: archives a leader session and all its herded workers in one
// request. Workers are archived first (avoids herd events to a dead leader),
// then the leader itself. Partial failures are tracked per-session.
describe("POST /api/sessions/:id/archive-group", () => {
  it("archives leader and all herded workers", async () => {
    // Leader session with isOrchestrator flag
    launcher.getSession.mockReturnValue({
      sessionId: "leader-1",
      state: "connected",
      cwd: "/test",
      isOrchestrator: true,
    });
    // Two herded workers
    launcher.getHerdedSessions.mockReturnValue([
      { sessionId: "worker-1", state: "connected", cwd: "/test", herdedBy: "leader-1", archived: false },
      { sessionId: "worker-2", state: "connected", cwd: "/test", herdedBy: "leader-1", archived: false },
    ]);

    const res = await app.request("/api/sessions/leader-1/archive-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, archived: 3, failed: 0 });
    // All three sessions should be killed and archived
    expect(launcher.kill).toHaveBeenCalledWith("worker-1");
    expect(launcher.kill).toHaveBeenCalledWith("worker-2");
    expect(launcher.kill).toHaveBeenCalledWith("leader-1");
    expect(launcher.setArchived).toHaveBeenCalledWith("worker-1", true);
    expect(launcher.setArchived).toHaveBeenCalledWith("worker-2", true);
    expect(launcher.setArchived).toHaveBeenCalledWith("leader-1", true);
  });

  it("skips already-archived herded workers", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "leader-1",
      state: "connected",
      cwd: "/test",
      isOrchestrator: true,
    });
    // One active worker + one already archived (filtered out by the endpoint)
    launcher.getHerdedSessions.mockReturnValue([
      { sessionId: "worker-1", state: "connected", cwd: "/test", herdedBy: "leader-1", archived: false },
      { sessionId: "worker-2", state: "exited", cwd: "/test", herdedBy: "leader-1", archived: true },
    ]);

    const res = await app.request("/api/sessions/leader-1/archive-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Only worker-1 + leader = 2 archived (worker-2 was already archived)
    expect(json).toMatchObject({ ok: true, archived: 2, failed: 0 });
    expect(launcher.kill).not.toHaveBeenCalledWith("worker-2");
  });

  // Leader with no active herded workers should still archive just itself
  it("archives leader alone when no active workers exist", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "leader-1",
      state: "connected",
      cwd: "/test",
      isOrchestrator: true,
    });
    launcher.getHerdedSessions.mockReturnValue([]);

    const res = await app.request("/api/sessions/leader-1/archive-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, archived: 1, failed: 0 });
    expect(launcher.kill).toHaveBeenCalledWith("leader-1");
    expect(launcher.setArchived).toHaveBeenCalledWith("leader-1", true);
  });

  // When archiveSingleSession throws for one worker, the endpoint should
  // continue archiving the rest and report partial failure in the response.
  it("reports partial failure when a worker archive throws", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "leader-1",
      state: "connected",
      cwd: "/test",
      isOrchestrator: true,
    });
    launcher.getHerdedSessions.mockReturnValue([
      { sessionId: "worker-1", state: "connected", cwd: "/test", herdedBy: "leader-1", archived: false },
      { sessionId: "worker-2", state: "connected", cwd: "/test", herdedBy: "leader-1", archived: false },
    ]);
    // Make kill throw only for worker-1
    launcher.kill.mockImplementation(async (id: string) => {
      if (id === "worker-1") throw new Error("kill failed");
    });

    const res = await app.request("/api/sessions/leader-1/archive-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    // worker-1 fails, worker-2 + leader succeed
    expect(json.ok).toBe(false);
    expect(json.failed).toBeGreaterThanOrEqual(1);
    expect(json.archived).toBeGreaterThanOrEqual(1);
    // worker-2 and leader should still be archived despite worker-1 failure
    expect(launcher.setArchived).toHaveBeenCalledWith("worker-2", true);
    expect(launcher.setArchived).toHaveBeenCalledWith("leader-1", true);

    // Restore default mock
    launcher.kill.mockImplementation(async () => {});
  });

  it("returns 400 when session is not an orchestrator", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "s1",
      state: "connected",
      cwd: "/test",
      isOrchestrator: false,
    });

    const res = await app.request("/api/sessions/s1/archive-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Session is not an orchestrator");
  });

  it("returns 404 when session does not exist", async () => {
    launcher.resolveSessionId.mockReturnValue(undefined);

    const res = await app.request("/api/sessions/nonexistent/archive-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    // Restore default mock
    launcher.resolveSessionId.mockImplementation((id: string) => id);
  });
});

describe("POST /api/sessions/:id/unarchive", () => {
  it("unarchives a non-worktree session and auto-relaunches", async () => {
    // Non-worktree session: no worktree recreation needed
    launcher.getSession.mockReturnValue({ sessionId: "s1", state: "exited", cwd: "/test" });

    const res = await app.request("/api/sessions/s1/unarchive", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.worktreeRecreated).toBe(false);
    expect(json.relaunch).toEqual({ ok: true });
    expect(launcher.setArchived).toHaveBeenCalledWith("s1", false);
    expect(sessionStore.setArchived).toHaveBeenCalledWith("s1", false);
    expect(launcher.relaunch).toHaveBeenCalledWith("s1");
  });

  it("returns 404 when session not found", async () => {
    launcher.getSession.mockReturnValue(undefined);

    const res = await app.request("/api/sessions/unknown/unarchive", { method: "POST" });

    expect(res.status).toBe(404);
  });
});

// ─── Environments ────────────────────────────────────────────────────────────

describe("GET /api/envs", () => {
  it("returns the list of environments", async () => {
    const envs = [{ name: "Dev", slug: "dev", variables: { A: "1" }, createdAt: 1, updatedAt: 1 }];
    vi.mocked(envManager.listEnvs).mockResolvedValue(envs);

    const res = await app.request("/api/envs", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(envs);
  });
});

describe("POST /api/envs", () => {
  it("creates an environment and returns 201", async () => {
    const created = {
      name: "Staging",
      slug: "staging",
      variables: { HOST: "staging.example.com" },
      createdAt: 1000,
      updatedAt: 1000,
    };
    vi.mocked(envManager.createEnv).mockResolvedValue(created);

    const res = await app.request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Staging", variables: { HOST: "staging.example.com" } }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual(created);
    expect(envManager.createEnv).toHaveBeenCalledWith(
      "Staging",
      { HOST: "staging.example.com" },
      {
        dockerfile: undefined,
        baseImage: undefined,
        ports: undefined,
        volumes: undefined,
      },
    );
  });

  it("returns 400 when createEnv throws", async () => {
    vi.mocked(envManager.createEnv).mockRejectedValue(new Error("Environment name is required"));

    const res = await app.request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "Environment name is required" });
  });
});

describe("PUT /api/envs/:slug", () => {
  it("updates an existing environment", async () => {
    const updated = {
      name: "Production v2",
      slug: "production-v2",
      variables: { KEY: "new-value" },
      createdAt: 1000,
      updatedAt: 2000,
    };
    vi.mocked(envManager.updateEnv).mockResolvedValue(updated);

    const res = await app.request("/api/envs/production", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Production v2", variables: { KEY: "new-value" } }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(updated);
    expect(envManager.updateEnv).toHaveBeenCalledWith("production", {
      name: "Production v2",
      variables: { KEY: "new-value" },
    });
  });
});

describe("DELETE /api/envs/:slug", () => {
  it("deletes an existing environment", async () => {
    vi.mocked(envManager.deleteEnv).mockResolvedValue(true);

    const res = await app.request("/api/envs/staging", { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(envManager.deleteEnv).toHaveBeenCalledWith("staging");
  });

  it("returns 404 when environment not found", async () => {
    vi.mocked(envManager.deleteEnv).mockResolvedValue(false);

    const res = await app.request("/api/envs/nonexistent", { method: "DELETE" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Environment not found" });
  });
});

// ─── Health ──────────────────────────────────────────────────────────────────

describe("GET /api/health", () => {
  it("returns ok with timestamp", async () => {
    const before = Date.now();
    const res = await app.request("/api/health", { method: "GET" });
    const after = Date.now();

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; timestamp: number };
    expect(json.ok).toBe(true);
    expect(json.timestamp).toBeGreaterThanOrEqual(before);
    expect(json.timestamp).toBeLessThanOrEqual(after);
  });
});

describe("GET /api/traffic/stats", () => {
  it("returns the current traffic snapshot and recorder metadata", async () => {
    const res = await app.request("/api/traffic/stats", { method: "GET" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      snapshot: {
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
      },
      recording: {
        available: true,
        recordingsDir: "/tmp/companion-recordings",
        globalEnabled: true,
        maxLines: 500000,
      },
    });
  });
});

describe("POST /api/traffic/stats/reset", () => {
  it("resets traffic counters and returns the fresh snapshot", async () => {
    const res = await app.request("/api/traffic/stats/reset", { method: "POST" });

    expect(res.status).toBe(200);
    expect(bridge.resetTrafficStats).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({
      ok: true,
      snapshot: {
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
      },
    });
  });
});

describe("GET /api/sessions/:id/tool-result/:toolUseId", () => {
  it("records bytes and repeated fetches for lazy full tool results", async () => {
    bridge.getToolResult.mockReturnValue({
      content: "full terminal output",
      is_error: false,
    });

    const first = await app.request("/api/sessions/session-1/tool-result/tu-1", { method: "GET" });
    const second = await app.request("/api/sessions/session-1/tool-result/tu-1", { method: "GET" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const snapshot = trafficStats.snapshot();
    expect(snapshot.toolResultFetches.totals).toEqual({
      requests: 2,
      repeatedRequests: 1,
      payloadBytes: Buffer.byteLength(JSON.stringify({ content: "full terminal output", is_error: false }), "utf8") * 2,
      errorRequests: 0,
    });
    expect(snapshot.toolResultFetches.sessions["session-1"]?.tools).toEqual([
      {
        sessionId: "session-1",
        toolUseId: "tu-1",
        requests: 2,
        repeatedRequests: 1,
        payloadBytes:
          Buffer.byteLength(JSON.stringify({ content: "full terminal output", is_error: false }), "utf8") * 2,
        errorRequests: 0,
        lastFetchedAt: expect.any(Number),
        maxPayloadBytes: Buffer.byteLength(
          JSON.stringify({ content: "full terminal output", is_error: false }),
          "utf8",
        ),
      },
    ]);
  });
});

describe("GET /api/vscode/selection", () => {
  it("returns the current authoritative global VSCode selection state", async () => {
    bridge._vscodeSelectionState = {
      selection: {
        absolutePath: "/repo/src/app.ts",
        startLine: 4,
        endLine: 8,
        lineCount: 5,
      },
      updatedAt: 1234,
      sourceId: "window-a",
      sourceType: "vscode-window",
      sourceLabel: "VS Code",
    };

    const res = await app.request("/api/vscode/selection", { method: "GET" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: {
        selection: {
          absolutePath: "/repo/src/app.ts",
          startLine: 4,
          endLine: 8,
          lineCount: 5,
        },
        updatedAt: 1234,
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "VS Code",
      },
    });
  });
});

describe("POST /api/vscode/selection", () => {
  it("updates the authoritative global VSCode selection state", async () => {
    const res = await app.request("/api/vscode/selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selection: {
          absolutePath: "/repo/src/app.ts",
          startLine: 10,
          endLine: 12,
          lineCount: 3,
        },
        updatedAt: 2000,
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "VS Code A",
      }),
    });

    expect(res.status).toBe(200);
    expect(bridge.updateVsCodeSelectionState).toHaveBeenCalledWith({
      selection: {
        absolutePath: "/repo/src/app.ts",
        startLine: 10,
        endLine: 12,
        lineCount: 3,
      },
      updatedAt: 2000,
      sourceId: "window-a",
      sourceType: "vscode-window",
      sourceLabel: "VS Code A",
    });
    expect(await res.json()).toEqual({
      ok: true,
      state: {
        selection: {
          absolutePath: "/repo/src/app.ts",
          startLine: 10,
          endLine: 12,
          lineCount: 3,
        },
        updatedAt: 2000,
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "VS Code A",
      },
    });
  });

  it("accepts explicit clears", async () => {
    const res = await app.request("/api/vscode/selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selection: null,
        updatedAt: 3000,
        sourceId: "window-b",
        sourceType: "vscode-window",
      }),
    });

    expect(res.status).toBe(200);
    expect(bridge.updateVsCodeSelectionState).toHaveBeenCalledWith({
      selection: null,
      updatedAt: 3000,
      sourceId: "window-b",
      sourceType: "vscode-window",
    });
  });

  it("validates the payload", async () => {
    const res = await app.request("/api/vscode/selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selection: { absolutePath: "/repo/src/app.ts" },
        updatedAt: "later",
        sourceId: "",
        sourceType: "desktop",
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "updatedAt and sourceId are required",
    });
  });
});

describe("POST /api/vscode/windows", () => {
  it("registers a running VSCode window with workspace roots", async () => {
    const res = await app.request("/api/vscode/windows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "Repo A",
        workspaceRoots: ["/repo", "/repo/packages/app"],
        updatedAt: 5000,
        lastActivityAt: 4900,
      }),
    });

    expect(res.status).toBe(200);
    expect(bridge.upsertVsCodeWindowState).toHaveBeenCalledWith({
      sourceId: "window-a",
      sourceType: "vscode-window",
      sourceLabel: "Repo A",
      workspaceRoots: ["/repo", "/repo/packages/app"],
      updatedAt: 5000,
      lastActivityAt: 4900,
    });
    expect(await res.json()).toEqual({
      ok: true,
      window: {
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "Repo A",
        workspaceRoots: ["/repo", "/repo/packages/app"],
        updatedAt: 5000,
        lastActivityAt: 4900,
        lastSeenAt: 9999,
      },
    });
  });
});

describe("GET /api/vscode/windows", () => {
  it("lists registered VSCode windows", async () => {
    bridge._vscodeWindows = [
      {
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "Repo A",
        workspaceRoots: ["/repo"],
        updatedAt: 5000,
        lastActivityAt: 4900,
        lastSeenAt: 9999,
      },
    ];

    const res = await app.request("/api/vscode/windows", { method: "GET" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      windows: bridge._vscodeWindows,
    });
  });
});

describe("GET /api/vscode/windows/:sourceId/commands", () => {
  it("returns queued remote open-file commands for a VSCode window", async () => {
    bridge.pollVsCodeOpenFileCommands.mockReturnValue([
      {
        commandId: "cmd-1",
        sourceId: "window-a",
        target: {
          absolutePath: "/repo/src/app.ts",
          line: 12,
          column: 3,
        },
        createdAt: 6000,
      },
    ]);

    const res = await app.request("/api/vscode/windows/window-a/commands", { method: "GET" });

    expect(res.status).toBe(200);
    expect(bridge.pollVsCodeOpenFileCommands).toHaveBeenCalledWith("window-a");
    expect(await res.json()).toEqual({
      commands: [
        {
          commandId: "cmd-1",
          sourceId: "window-a",
          target: {
            absolutePath: "/repo/src/app.ts",
            line: 12,
            column: 3,
          },
          createdAt: 6000,
        },
      ],
    });
  });
});

describe("POST /api/vscode/windows/:sourceId/commands/:commandId/result", () => {
  it("accepts remote open-file results from the VSCode extension", async () => {
    const res = await app.request("/api/vscode/windows/window-a/commands/cmd-1/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });

    expect(res.status).toBe(200);
    expect(bridge.resolveVsCodeOpenFileResult).toHaveBeenCalledWith("window-a", "cmd-1", { ok: true });
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /api/vscode/open-file", () => {
  it("dispatches remote file-open requests through the authoritative VSCode channel", async () => {
    bridge.requestVsCodeOpenFile.mockResolvedValue({
      sourceId: "window-a",
      commandId: "cmd-1",
    });

    const res = await app.request("/api/vscode/open-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        absolutePath: "/repo/src/app.ts",
        line: 12,
        column: 3,
      }),
    });

    expect(res.status).toBe(200);
    expect(bridge.requestVsCodeOpenFile).toHaveBeenCalledWith({
      absolutePath: "/repo/src/app.ts",
      line: 12,
      column: 3,
    });
    expect(await res.json()).toEqual({
      ok: true,
      sourceId: "window-a",
      commandId: "cmd-1",
    });
  });

  it("accepts line-range targets for remote open-file requests", async () => {
    bridge.requestVsCodeOpenFile.mockResolvedValue({
      sourceId: "window-a",
      commandId: "cmd-range",
    });

    const res = await app.request("/api/vscode/open-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        absolutePath: "/repo/CLAUDE.md",
        line: 53,
        endLine: 54,
      }),
    });

    expect(res.status).toBe(200);
    expect(bridge.requestVsCodeOpenFile).toHaveBeenCalledWith({
      absolutePath: "/repo/CLAUDE.md",
      line: 53,
      endLine: 54,
    });
    expect(await res.json()).toEqual({
      ok: true,
      sourceId: "window-a",
      commandId: "cmd-range",
    });
  });

  it("returns a clear error when no running VSCode window is available", async () => {
    bridge.requestVsCodeOpenFile.mockRejectedValue(new Error("No running VSCode was detected on this machine."));

    const res = await app.request("/api/vscode/open-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        absolutePath: "/repo/src/app.ts",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "No running VSCode was detected on this machine.",
    });
  });
});

describe("POST /api/vscode/windows", () => {
  it("registers a running VSCode window", async () => {
    const res = await app.request("/api/vscode/windows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "Workspace A",
        updatedAt: 4000,
        lastActivityAt: 3999,
        workspaceRoots: ["/repo", "/repo/packages/pkg-a"],
      }),
    });

    expect(res.status).toBe(200);
    expect(bridge.upsertVsCodeWindowState).toHaveBeenCalledWith({
      sourceId: "window-a",
      sourceType: "vscode-window",
      sourceLabel: "Workspace A",
      updatedAt: 4000,
      lastActivityAt: 3999,
      workspaceRoots: ["/repo", "/repo/packages/pkg-a"],
    });
  });
});

describe("GET /api/vscode/windows/:sourceId/commands", () => {
  it("returns queued open-file commands for a VSCode window", async () => {
    bridge.pollVsCodeOpenFileCommands.mockReturnValue([
      {
        commandId: "cmd-1",
        sourceId: "window-a",
        createdAt: 5000,
        target: {
          absolutePath: "/repo/src/app.ts",
          line: 12,
          column: 3,
        },
      },
    ]);

    const res = await app.request("/api/vscode/windows/window-a/commands", { method: "GET" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      commands: [
        {
          commandId: "cmd-1",
          sourceId: "window-a",
          createdAt: 5000,
          target: {
            absolutePath: "/repo/src/app.ts",
            line: 12,
            column: 3,
          },
        },
      ],
    });
  });
});

describe("POST /api/vscode/windows/:sourceId/commands/:commandId/result", () => {
  it("accepts extension-host open-file command results", async () => {
    const res = await app.request("/api/vscode/windows/window-a/commands/cmd-1/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });

    expect(res.status).toBe(200);
    expect(bridge.resolveVsCodeOpenFileResult).toHaveBeenCalledWith("window-a", "cmd-1", { ok: true });
  });
});

describe("POST /api/vscode/open-file", () => {
  it("dispatches a remote open-file request through the authoritative VSCode channel", async () => {
    bridge.requestVsCodeOpenFile.mockResolvedValue({ sourceId: "window-a", commandId: "cmd-1" });

    const res = await app.request("/api/vscode/open-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        absolutePath: "/repo/src/app.ts",
        line: 12,
        column: 3,
      }),
    });

    expect(res.status).toBe(200);
    expect(bridge.requestVsCodeOpenFile).toHaveBeenCalledWith({
      absolutePath: "/repo/src/app.ts",
      line: 12,
      column: 3,
    });
    expect(await res.json()).toEqual({
      ok: true,
      sourceId: "window-a",
      commandId: "cmd-1",
    });
  });

  it("returns a clear conflict when no running VSCode window is available", async () => {
    bridge.requestVsCodeOpenFile.mockRejectedValue(new Error("No running VSCode was detected on this machine."));

    const res = await app.request("/api/vscode/open-file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        absolutePath: "/repo/src/app.ts",
      }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "No running VSCode was detected on this machine.",
    });
  });
});

// ─── Transcription ──────────────────────────────────────────────────────────

describe("POST /api/transcribe", () => {
  it("normalizes mislabeled recorder uploads before calling OpenAI", async () => {
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
        apiKey: "transcription-secret",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: false,
        enhancementModel: "gpt-5-mini",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      updatedAt: 123,
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "transcribed text" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const form = new FormData();
    form.append(
      "audio",
      new File(
        [new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20])],
        "recording.webm",
        { type: "audio/webm" },
      ),
    );
    form.append("backend", "openai");

    const res = await app.request("/api/transcribe", { method: "POST", body: form });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"text":"transcribed text"');
    expect(fetch).toHaveBeenCalledOnce();

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const outboundForm = init.body as FormData;
    const uploadedFile = outboundForm.get("file");
    expect(uploadedFile).toBeInstanceOf(File);
    expect((uploadedFile as File).type).toBe("audio/mp4");
    expect((uploadedFile as File).name).toBe("recording.mp4");
  });

  it("records pre-stream upload time separately from STT timing", async () => {
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
        apiKey: "transcription-secret",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: false,
        enhancementModel: "gpt-5-mini",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      updatedAt: 123,
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "timed transcript" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const form = new FormData();
    form.append("audio", new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "recording.wav", { type: "audio/wav" }));
    form.append("backend", "openai");

    const res = await app.request("/api/transcribe", { method: "POST", body: form });

    expect(res.status).toBe(200);
    await res.text();
    expect(transcriptionEnhancer.getTranscriptionLogIndex()[0]).toEqual(
      expect.objectContaining({
        uploadDurationMs: expect.any(Number),
        sttDurationMs: expect.any(Number),
        rawTranscript: "timed transcript",
      }),
    );
  });

  it("supports voice-edit mode by transcribing the instruction then applying it to the current draft", async () => {
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
        apiKey: "transcription-secret",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: false,
        enhancementModel: "gpt-5-mini",
        customVocabulary: "Takode, WsBridge",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      updatedAt: 123,
    });
    vi.mocked(sessionNames.getName).mockReturnValue("Voice edit session");
    bridge.getSessionTaskHistory.mockReturnValue([{ title: "Fix reconnect bug" }]);
    bridge.getMessageHistory.mockReturnValue([{ type: "user_message", content: "Please rewrite this update" }]);

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "turn this into bullet points" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "- Short bullet\n- Another bullet" } }],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const form = new FormData();
    form.append("audio", new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "recording.wav", { type: "audio/wav" }));
    form.append("backend", "openai");
    form.append("mode", "edit");
    form.append("sessionId", "session-1");
    form.append("composerText", "Please rewrite this update into two short bullets.");

    const res = await app.request("/api/transcribe", { method: "POST", body: form });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: stt_complete");
    expect(body).toContain('"nextPhase":"editing"');
    expect(body).toContain("event: result");
    expect(body).toContain('"mode":"edit"');
    expect(body).toContain('"instructionText":"turn this into bullet points"');
    expect(body).toContain("- Short bullet");

    expect(fetch).toHaveBeenCalledTimes(2);

    const [, sttInit] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const sttBody = sttInit.body as FormData;
    expect(sttBody.get("prompt")).toBeTruthy();
    expect(String(sttBody.get("prompt"))).toContain("<DRAFT>");
    expect(String(sttBody.get("prompt"))).toContain("spoken edit instruction");

    const [, enhanceInit] = vi.mocked(fetch).mock.calls[1] as [string, RequestInit];
    const enhanceBody = JSON.parse(String(enhanceInit.body));
    expect(enhanceBody.messages[0].content).toContain("VOICE EDITOR");
    expect(enhanceBody.messages[0].content).toContain("apply the instruction to the current composer text");
    expect(enhanceBody.messages[0].content).toContain("Return ONLY the fully edited composer text");
    expect(enhanceBody.messages[1].content).toContain("<CURRENT_COMPOSER_TEXT>");
    expect(enhanceBody.messages[1].content).toContain("<EDIT_INSTRUCTION>");
  });
});

describe("GET /api/logs", () => {
  it("returns structured log entries filtered by component and level", async () => {
    // Loopback browser access should be allowed, and the query filters should narrow the result set.
    const logDir = await mkdtemp(join(tmpdir(), "takode-route-logs-"));
    try {
      initServerLogger(3456, { logDir, captureConsole: false });
      const logger = createLogger("ws-bridge");
      logger.info("connected", { sessionId: "s-1" });
      logger.error("failed", { sessionId: "s-2" });

      const res = await app.request("/api/logs?component=ws-bridge&level=error", {
        headers: { "x-companion-client-ip": "127.0.0.1" },
      });
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        entries: Array<{
          level: string;
          component: string;
          message: string;
          sessionId?: string;
          ts: number;
          isoTime: string;
        }>;
        availableComponents: string[];
        logFile: string | null;
      };

      expect(json.availableComponents).toEqual(["ws-bridge"]);
      expect(json.logFile).toContain("server-3456.jsonl");
      expect(json.entries).toHaveLength(1);
      expect(json.entries[0]).toMatchObject({
        level: "error",
        component: "ws-bridge",
        message: "failed",
        sessionId: "s-2",
      });
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated non-loopback log access", async () => {
    // Structured logs are sensitive, so network clients must authenticate unless they are local loopback requests.
    const res = await app.request("/api/logs");
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid regex filters", async () => {
    // Invalid regex should fail fast instead of pretending the query returned zero matches.
    const res = await app.request("/api/logs?pattern=%28&regex=1", {
      headers: { "x-companion-client-ip": "127.0.0.1" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid log regex: (" });
  });

  it("streams snapshot and live entries without dropping the handoff window", async () => {
    // This regression guards the old snapshot→subscribe gap by emitting an error during
    // the initial query. The stream must still deliver the snapshot entry and the handoff entry,
    // while continuing to filter out non-matching live logs after subscription is active.
    const logDir = await mkdtemp(join(tmpdir(), "takode-stream-logs-"));
    let querySpy: ReturnType<typeof vi.spyOn> | null = null;
    try {
      initServerLogger(3456, { logDir, captureConsole: false });
      const logger = createLogger("server");
      logger.info("boot complete");
      logger.error("snapshot error");

      const originalQueryServerLogs = serverLoggerModule.queryServerLogs;
      let injectedHandoffEntry = false;
      querySpy = vi.spyOn(serverLoggerModule, "queryServerLogs").mockImplementation(async (query) => {
        if (!injectedHandoffEntry) {
          injectedHandoffEntry = true;
          logger.error("handoff error");
        }
        return originalQueryServerLogs(query);
      });

      setTimeout(() => {
        logger.info("ignored live info");
        logger.error("live error");
      }, 5);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      const res = await app.request("/api/logs/stream?tail=2&level=error", {
        headers: { "x-companion-client-ip": "127.0.0.1" },
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const body = await res.text();
      expect(body).toContain("event: entry");
      expect(body).toContain("snapshot error");
      expect(body).toContain("handoff error");
      expect(body).toContain("live error");
      expect(body).not.toContain("ignored live info");
      expect(body).toContain("event: ready");
    } finally {
      querySpy?.mockRestore();
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it("does not drop handoff entries for live-only consumers without a snapshot tail", async () => {
    // Live-only consumers should still receive entries emitted during the subscribe→query handoff
    // even when the stream does not preload a historical snapshot.
    const logDir = await mkdtemp(join(tmpdir(), "takode-live-only-logs-"));
    let querySpy: ReturnType<typeof vi.spyOn> | null = null;
    try {
      initServerLogger(3456, { logDir, captureConsole: false });
      const logger = createLogger("server");
      logger.error("historical error");

      const originalQueryServerLogs = serverLoggerModule.queryServerLogs;
      let injectedHandoffEntry = false;
      querySpy = vi.spyOn(serverLoggerModule, "queryServerLogs").mockImplementation(async (query) => {
        if (!injectedHandoffEntry) {
          injectedHandoffEntry = true;
          logger.error("live-only handoff error");
        }
        return originalQueryServerLogs(query);
      });

      setTimeout(() => {
        logger.error("live-only trailing error");
      }, 5);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      const res = await app.request("/api/logs/stream?level=error", {
        headers: { "x-companion-client-ip": "127.0.0.1" },
        signal: controller.signal,
      });

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("live-only handoff error");
      expect(body).toContain("live-only trailing error");
      expect(body).not.toContain("historical error");
      expect(body).toContain("event: ready");
    } finally {
      querySpy?.mockRestore();
      await rm(logDir, { recursive: true, force: true });
    }
  });
});

// ─── Settings ────────────────────────────────────────────────────────────────

describe("GET /api/settings", () => {
  it("returns settings with pushover status", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "u123",
      pushoverApiToken: "t456",
      pushoverDelaySeconds: 60,
      pushoverEnabled: true,
      pushoverEventFilters: { needsInput: true, review: true, error: true },
      pushoverBaseUrl: "http://localhost:3456",
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
      updatedAt: 123,
    });

    const res = await app.request("/api/settings", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      serverName: "",
      serverId: "test-server-id",
      pushoverConfigured: true,
      pushoverEnabled: true,
      pushoverEventFilters: { needsInput: true, review: true, error: true },
      pushoverDelaySeconds: 60,
      pushoverBaseUrl: "http://localhost:3456",
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
      restartSupported: expect.any(Boolean),
      logFile: expect.any(Object), // null or string depending on logger init
      claudeDefaultModel: expect.any(String),
    });
  });

  it("reports pushover as not configured when keys are empty", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
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
      updatedAt: 123,
    });

    const res = await app.request("/api/settings", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      serverName: "",
      serverId: "test-server-id",
      pushoverConfigured: false,
      pushoverEnabled: true,
      pushoverEventFilters: { needsInput: true, review: true, error: true },
      pushoverDelaySeconds: 30,
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
      restartSupported: expect.any(Boolean),
      logFile: expect.any(Object), // null or string depending on logger init
      claudeDefaultModel: expect.any(String),
    });
  });

  it("includes serverName when configured", async () => {
    vi.mocked(settingsManager.getServerName).mockReturnValue("My Frontend");
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      serverName: "My Frontend",
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
      updatedAt: 0,
    });

    const res = await app.request("/api/settings", { method: "GET" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.serverName).toBe("My Frontend");

    vi.mocked(settingsManager.getServerName).mockReturnValue("");
  });

  it("masks OpenAI API keys in the settings response", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
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
      namerConfig: {
        backend: "openai",
        apiKey: "server-only-secret",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      },
      autoNamerEnabled: true,
      transcriptionConfig: {
        apiKey: "transcription-secret",
        baseUrl: "https://api.openai.com/v1",
        enhancementEnabled: true,
        enhancementModel: "gpt-5-mini",
      },
      editorConfig: { editor: "none" },
      defaultClaudeBackend: "claude",
      sleepInhibitorEnabled: false,
      sleepInhibitorDurationMinutes: 5,
      updatedAt: 123,
    });

    const res = await app.request("/api/settings", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.namerConfig).toEqual({
      backend: "openai",
      apiKey: "***",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
    expect(json.transcriptionConfig).toEqual({
      apiKey: "***",
      baseUrl: "https://api.openai.com/v1",
      enhancementEnabled: true,
      enhancementModel: "gpt-5-mini",
    });
    expect(JSON.stringify(json)).not.toContain("server-only-secret");
    expect(JSON.stringify(json)).not.toContain("transcription-secret");
  });
});

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

describe("GET /api/images/:sessionId/:imageId/thumb", () => {
  it("serves the real thumbnail with immutable caching when it exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "routes-thumb-"));
    const thumbPath = join(tempRoot, "thumb.jpeg");
    const origPath = join(tempRoot, "orig.png");
    try {
      await Bun.write(thumbPath, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      await Bun.write(origPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

      const imageStore = {
        getThumbnailPath: vi.fn(async () => thumbPath),
        getOriginalPath: vi.fn(async () => origPath),
      } as any;

      const imageApp = new Hono();
      imageApp.route(
        "/api",
        createRoutes(
          launcher,
          bridge,
          sessionStore,
          tracker,
          { getInfo: () => null, spawn: () => "", kill: () => {} } as any,
          undefined,
          recorder,
          undefined,
          timerManager,
          imageStore,
        ),
      );

      const res = await imageApp.request("/api/images/sess-1/img-1/thumb");

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves the original without immutable caching when the thumbnail is still missing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "routes-thumb-fallback-"));
    const origPath = join(tempRoot, "orig.png");
    try {
      await Bun.write(origPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

      const imageStore = {
        getThumbnailPath: vi.fn(async () => null),
        getOriginalPath: vi.fn(async () => origPath),
      } as any;

      const imageApp = new Hono();
      imageApp.route(
        "/api",
        createRoutes(
          launcher,
          bridge,
          sessionStore,
          tracker,
          { getInfo: () => null, spawn: () => "", kill: () => {} } as any,
          undefined,
          recorder,
          undefined,
          timerManager,
          imageStore,
        ),
      );

      const res = await imageApp.request("/api/images/sess-1/img-1/thumb");

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Content-Type")).toBe("image/png");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

// ─── Git ─────────────────────────────────────────────────────────────────────

describe("GET /api/git/repo-info", () => {
  it("returns repo info for a valid path", async () => {
    const info = {
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    };
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValueOnce(info);

    const res = await app.request("/api/git/repo-info?path=/repo", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(info);
    expect(gitUtils.getRepoInfoAsync).toHaveBeenCalledWith("/repo");
  });

  it("returns 400 when path query parameter is missing", async () => {
    const res = await app.request("/api/git/repo-info", { method: "GET" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "path required" });
  });
});

describe("GET /api/git/branches", () => {
  it("returns branches for a repo", async () => {
    const branches = [
      { name: "main", isCurrent: true, isRemote: false, worktreePath: null, ahead: 0, behind: 0 },
      { name: "dev", isCurrent: false, isRemote: false, worktreePath: null, ahead: 2, behind: 0 },
    ];
    vi.mocked(gitUtils.listBranchesAsync).mockResolvedValue(branches);

    const res = await app.request("/api/git/branches?repoRoot=/repo", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(branches);
    expect(gitUtils.listBranchesAsync).toHaveBeenCalledWith("/repo", { localOnly: false });
  });
});

describe("POST /api/git/worktree", () => {
  it("creates a worktree", async () => {
    const result = {
      worktreePath: "/home/.companion/worktrees/repo/feat",
      branch: "feat",
      actualBranch: "feat",
      isNew: true,
    };
    vi.mocked(gitUtils.ensureWorktreeAsync).mockResolvedValue(result);
    const res = await app.request("/api/git/worktree", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: "/repo", branch: "feat", baseBranch: "main" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(result);
    expect(gitUtils.ensureWorktreeAsync).toHaveBeenCalledWith("/repo", "feat", {
      baseBranch: "main",
    });
  });
});

describe("DELETE /api/git/worktree", () => {
  it("removes a worktree", async () => {
    vi.mocked(gitUtils.removeWorktree).mockReturnValue({ removed: true });
    const res = await app.request("/api/git/worktree", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: "/repo", worktreePath: "/wt/feat", force: true }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ removed: true });
    expect(gitUtils.removeWorktree).toHaveBeenCalledWith("/repo", "/wt/feat", { force: true });
  });
});

// ─── Session Naming ─────────────────────────────────────────────────────────

describe("PATCH /api/sessions/:id/name", () => {
  it("updates session name and returns ok", async () => {
    launcher.getSession.mockReturnValue({ sessionId: "s1", state: "running", cwd: "/test" });

    const res = await app.request("/api/sessions/s1/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Fix auth bug" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, name: "Fix auth bug" });
    expect(sessionNames.setName).toHaveBeenCalledWith("s1", "Fix auth bug");
  });

  it("trims whitespace from name", async () => {
    launcher.getSession.mockReturnValue({ sessionId: "s1", state: "running", cwd: "/test" });

    const res = await app.request("/api/sessions/s1/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  My Session  " }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, name: "My Session" });
    expect(sessionNames.setName).toHaveBeenCalledWith("s1", "My Session");
  });

  it("returns 404 when session not found", async () => {
    launcher.getSession.mockReturnValue(undefined);

    const res = await app.request("/api/sessions/nonexistent/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Some name" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Session not found" });
  });

  it("returns 400 when name is empty", async () => {
    const res = await app.request("/api/sessions/s1/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "name is required" });
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.request("/api/sessions/s1/name", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

// ─── Diff Base Branch ────────────────────────────────────────────────────────

describe("PATCH /api/sessions/:id/diff-base", () => {
  it("sets the diff base branch and returns ok", async () => {
    const res = await app.request("/api/sessions/s1/diff-base", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feature-branch" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, diff_base_branch: "feature-branch" });
    expect(bridge.setDiffBaseBranch).toHaveBeenCalledWith("s1", "feature-branch");
  });

  it("clears the diff base branch when empty string", async () => {
    const res = await app.request("/api/sessions/s1/diff-base", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, diff_base_branch: "" });
    expect(bridge.setDiffBaseBranch).toHaveBeenCalledWith("s1", "");
  });

  it("returns 404 when session not found", async () => {
    bridge.setDiffBaseBranch.mockReturnValue(false);

    const res = await app.request("/api/sessions/nonexistent/diff-base", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "main" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json).toEqual({ error: "Session not found" });

    // Reset mock
    bridge.setDiffBaseBranch.mockReturnValue(true);
  });

  it("defaults to empty string when branch is not a string", async () => {
    const res = await app.request("/api/sessions/s1/diff-base", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(bridge.setDiffBaseBranch).toHaveBeenCalledWith("s1", "");
  });
});

// ─── Filesystem ──────────────────────────────────────────────────────────────

describe("GET /api/fs/home", () => {
  it("returns home directory and cwd", async () => {
    const res = await app.request("/api/fs/home", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("home");
    expect(json).toHaveProperty("cwd");
    expect(typeof json.home).toBe("string");
    expect(typeof json.cwd).toBe("string");
  });

  it("returns home as cwd when process.cwd() is the package root", async () => {
    const origCwd = process.cwd;
    const origEnv = process.env.__COMPANION_PACKAGE_ROOT;
    try {
      process.env.__COMPANION_PACKAGE_ROOT = "/opt/companion";
      process.cwd = () => "/opt/companion";
      const res = await app.request("/api/fs/home", { method: "GET" });
      const json = await res.json();
      expect(json.cwd).toBe(json.home);
    } finally {
      process.cwd = origCwd;
      process.env.__COMPANION_PACKAGE_ROOT = origEnv;
    }
  });

  it("returns home as cwd when process.cwd() is inside the package root", async () => {
    const origCwd = process.cwd;
    const origEnv = process.env.__COMPANION_PACKAGE_ROOT;
    try {
      process.env.__COMPANION_PACKAGE_ROOT = "/opt/companion";
      process.cwd = () => "/opt/companion/node_modules/.bin";
      const res = await app.request("/api/fs/home", { method: "GET" });
      const json = await res.json();
      expect(json.cwd).toBe(json.home);
    } finally {
      process.cwd = origCwd;
      process.env.__COMPANION_PACKAGE_ROOT = origEnv;
    }
  });

  it("returns actual cwd when launched from a project directory", async () => {
    const origCwd = process.cwd;
    const origEnv = process.env.__COMPANION_PACKAGE_ROOT;
    try {
      process.env.__COMPANION_PACKAGE_ROOT = "/opt/companion";
      process.cwd = () => "/Users/testuser/my-project";
      const res = await app.request("/api/fs/home", { method: "GET" });
      const json = await res.json();
      expect(json.cwd).toBe("/Users/testuser/my-project");
    } finally {
      process.cwd = origCwd;
      process.env.__COMPANION_PACKAGE_ROOT = origEnv;
    }
  });

  it("returns home as cwd when process.cwd() equals home directory", async () => {
    const { homedir } = await import("node:os");
    const origCwd = process.cwd;
    const origEnv = process.env.__COMPANION_PACKAGE_ROOT;
    try {
      delete process.env.__COMPANION_PACKAGE_ROOT;
      process.cwd = () => homedir();
      const res = await app.request("/api/fs/home", { method: "GET" });
      const json = await res.json();
      expect(json.cwd).toBe(json.home);
    } finally {
      process.cwd = origCwd;
      process.env.__COMPANION_PACKAGE_ROOT = origEnv;
    }
  });
});

describe("GET /api/fs/diff", () => {
  it("returns 400 when path is missing", async () => {
    const res = await app.request("/api/fs/diff", { method: "GET" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "path required" });
  });

  it("returns 400 when base branch is missing", async () => {
    // base param is now required (always provided by frontend from session.diff_base_branch)
    const res = await app.request("/api/fs/diff?path=/repo/file.ts", { method: "GET" });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: "base branch required" });
  });

  it("returns unified diff for a file against base branch tip", async () => {
    // Validate direct base-vs-HEAD comparison so cherry-picked commits do not
    // appear as unsynced local changes.
    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
line1
-old line
+new line
line3`;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo\n";
      if (cmd.includes("ls-files --full-name")) return "file.ts\n";
      if (cmd.includes("merge-base")) throw new Error("should not call merge-base");
      // Source quotes the base ref: git diff "main" -- "file.ts"
      if (cmd.includes('diff "main"')) return diffOutput;
      throw new Error(`Unmocked: ${cmd}`);
    });

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=main", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(json.path).toContain("file.ts");
    expect(json.baseBranch).toBe("main");
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff "main"'));
  });

  it("uses the worktree anchor for file diffs when sessionId is provided", async () => {
    bridge.getSession.mockReturnValue({
      state: {
        is_worktree: true,
        diff_base_start_sha: "anchor-sha",
        git_head_sha: "head-sha",
      },
    });

    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-before
+after`;

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo\n";
      if (cmd.includes("ls-files --full-name")) return "file.ts\n";
      if (cmd.includes('diff "anchor-sha"')) return diffOutput;
      if (cmd.includes('diff "main"')) throw new Error("should not diff against moving base tip");
      return "";
    });

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=main&sessionId=s1", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff "anchor-sha"'));
  });

  it("falls back to the requested base ref when a worktree anchor is missing", async () => {
    bridge.getSession.mockReturnValue({
      state: {
        is_worktree: true,
        diff_base_start_sha: "",
        git_head_sha: "head-sha",
      },
    });

    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-before
+after`;

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo\n";
      if (cmd.includes("ls-files --full-name")) return "file.ts\n";
      if (cmd.includes('diff "main"')) return diffOutput;
      if (cmd.includes('diff "head-sha"')) throw new Error("missing anchor should not collapse to HEAD");
      return "";
    });

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=main&sessionId=s1", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff "main"'));
  });

  it("keeps direct-base diff behavior for non-worktree sessions", async () => {
    bridge.getSession.mockReturnValue({
      state: {
        is_worktree: false,
        diff_base_start_sha: "anchor-sha",
        git_head_sha: "head-sha",
      },
    });

    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-before
+after`;

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo\n";
      if (cmd.includes("ls-files --full-name")) return "file.ts\n";
      if (cmd.includes('diff "main"')) return diffOutput;
      if (cmd.includes('diff "anchor-sha"')) throw new Error("non-worktree path should stay on base tip");
      return "";
    });

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=main&sessionId=s1", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff "main"'));
  });

  it("preserves explicit commit-mode diffs for worktree sessions", async () => {
    bridge.getSession.mockReturnValue({
      state: {
        is_worktree: true,
        diff_base_start_sha: "anchor-sha",
        git_head_sha: "head-sha",
      },
    });

    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-before
+after`;

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo\n";
      if (cmd.includes("ls-files --full-name")) return "file.ts\n";
      if (cmd.includes('diff "abcdef1234567"')) return diffOutput;
      if (cmd.includes('diff "anchor-sha"')) throw new Error("commit-mode should stay on explicit SHA");
      return "";
    });

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=abcdef1234567&sessionId=s1", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff "abcdef1234567"'));
  });

  it("returns no-index diff for untracked files", async () => {
    // Untracked files have no base-branch diff content, so API must fallback to a full-file no-index diff.
    const untrackedDiff = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello`;

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo\n";
      if (cmd.includes("ls-files --full-name")) return "new.txt\n";
      if (cmd.includes("merge-base")) throw new Error("should not call merge-base");
      // Source quotes the base ref: git diff "main" -- "new.txt"
      if (cmd.includes('diff "main"')) return "";
      if (cmd.includes("ls-files --others --exclude-standard")) return "new.txt\n";
      if (cmd.includes("diff --no-index")) {
        const err = new Error("diff exits with 1 for differences") as Error & { stdout: string };
        err.stdout = untrackedDiff;
        throw err;
      }
      throw new Error(`Unmocked: ${cmd}`);
    });

    const res = await app.request("/api/fs/diff?path=/repo/new.txt&base=main", { method: "GET" });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.diff).toContain("new file mode");
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining("diff --no-index -- /dev/null"));
  });

  it("returns old/new file contents when includeContents=1", async () => {
    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;`;

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo\n";
      if (cmd.includes("ls-files --full-name")) return "file.ts\n";
      // Source quotes the base ref: git diff "main" -- "file.ts"
      if (cmd.includes('diff "main"')) return diffOutput;
      // Source quotes: git show "main":"file.ts"
      if (cmd.includes('show "main":"file.ts"')) return "const value = 1;\n";
      throw new Error(`Unmocked: ${cmd}`);
    });

    vi.mocked(stat).mockResolvedValueOnce({ size: 100 } as any);
    vi.mocked(readFile).mockResolvedValueOnce("const value = 2;\n" as any);

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=main&includeContents=1", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.oldText).toContain("const value = 1;");
    expect(json.newText).toContain("const value = 2;");
  });

  it("uses user-specified base branch for diff comparison", async () => {
    // The ?base= query param specifies the base branch for diff comparison.
    const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1 +1,2 @@
 line1
+added from develop`;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo\n";
      if (cmd.includes("ls-files --full-name")) return "file.ts\n";
      if (cmd.includes("merge-base")) throw new Error("should not call merge-base");
      // Source quotes the base ref: git diff "develop" -- "file.ts"
      if (cmd.includes('diff "develop"')) return diffOutput;
      throw new Error(`Unmocked: ${cmd}`);
    });

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=develop", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(json.baseBranch).toBe("develop");
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff "develop"'));
  });

  it("returns empty diff when git command fails", async () => {
    vi.mocked(execSync).mockImplementationOnce(() => {
      throw new Error("not a git repository");
    });

    const res = await app.request("/api/fs/diff?path=/not-a-repo/file.ts&base=main", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe("");
    expect(json.path).toContain("file.ts");
  });
});

describe("POST /api/fs/diff-stats", () => {
  it("computes stats against the selected base branch tip", async () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes("merge-base")) throw new Error("should not call merge-base");
      // Source quotes the base ref: git diff --numstat "jiayi" -- ...
      if (cmd.includes('diff --numstat "jiayi"')) {
        return "10\t3\tsrc/a.ts\n1\t0\tsrc/b.ts\n";
      }
      throw new Error(`Unmocked: ${cmd}`);
    });

    const res = await app.request("/api/fs/diff-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoRoot: "/repo",
        base: "jiayi",
        files: ["/repo/src/a.ts", "/repo/src/b.ts"],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.baseBranch).toBe("jiayi");
    expect(json.stats).toEqual({
      "/repo/src/a.ts": { additions: 10, deletions: 3 },
      "/repo/src/b.ts": { additions: 1, deletions: 0 },
    });
  });

  it("uses the worktree anchor for diff stats when sessionId is provided", async () => {
    bridge.getSession.mockReturnValue({
      state: {
        is_worktree: true,
        diff_base_start_sha: "anchor-sha",
        git_head_sha: "head-sha",
      },
    });

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes('diff --numstat "anchor-sha"')) return "7\t2\tsrc/a.ts\n";
      if (cmd.includes('diff --numstat "jiayi"')) throw new Error("should not diff against moving base tip");
      return "";
    });

    const res = await app.request("/api/fs/diff-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoRoot: "/repo",
        base: "jiayi",
        sessionId: "s1",
        files: ["/repo/src/a.ts"],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stats).toEqual({
      "/repo/src/a.ts": { additions: 7, deletions: 2 },
    });
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff --numstat "anchor-sha"'));
  });

  it("falls back to the requested base ref for diff stats when a worktree anchor is missing", async () => {
    bridge.getSession.mockReturnValue({
      state: {
        is_worktree: true,
        diff_base_start_sha: "",
        git_head_sha: "head-sha",
      },
    });

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes('diff --numstat "jiayi"')) return "7\t2\tsrc/a.ts\n";
      if (cmd.includes('diff --numstat "head-sha"')) throw new Error("missing anchor should not collapse to HEAD");
      return "";
    });

    const res = await app.request("/api/fs/diff-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoRoot: "/repo",
        base: "jiayi",
        sessionId: "s1",
        files: ["/repo/src/a.ts"],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.stats).toEqual({
      "/repo/src/a.ts": { additions: 7, deletions: 2 },
    });
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff --numstat "jiayi"'));
  });
});

describe("GET /api/fs/diff-files", () => {
  it("uses the worktree anchor for changed-file listing when sessionId is provided", async () => {
    bridge.getSession.mockReturnValue({
      state: {
        is_worktree: true,
        diff_base_start_sha: "anchor-sha",
        git_head_sha: "head-sha",
      },
    });

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes('diff --name-status "anchor-sha"')) return "M\tsrc/a.ts\nD\tsrc/b.ts\n";
      if (cmd.includes('diff --name-status "jiayi"')) throw new Error("should not diff against moving base tip");
      return "";
    });

    const res = await app.request("/api/fs/diff-files?cwd=/repo&base=jiayi&sessionId=s1", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.files).toEqual([
      { path: "/repo/src/a.ts", status: "M" },
      { path: "/repo/src/b.ts", status: "D" },
    ]);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff --name-status "anchor-sha"'));
  });

  it("falls back to the requested base ref for diff-files when a worktree anchor is missing", async () => {
    bridge.getSession.mockReturnValue({
      state: {
        is_worktree: true,
        diff_base_start_sha: "",
        git_head_sha: "head-sha",
      },
    });

    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes('diff --name-status "jiayi"')) return "M\tsrc/a.ts\nD\tsrc/b.ts\n";
      if (cmd.includes('diff --name-status "head-sha"')) throw new Error("missing anchor should not collapse to HEAD");
      return "";
    });

    const res = await app.request("/api/fs/diff-files?cwd=/repo&base=jiayi&sessionId=s1", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.files).toEqual([
      { path: "/repo/src/a.ts", status: "M" },
      { path: "/repo/src/b.ts", status: "D" },
    ]);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('diff --name-status "jiayi"'));
  });
});

// ─── Backends ─────────────────────────────────────────────────────────────────

describe("GET /api/backends", () => {
  it("returns both backends with availability status", async () => {
    // resolveBinary returns a path for all binaries
    mockResolveBinary
      .mockReturnValueOnce("/usr/bin/claude") // claude
      .mockReturnValueOnce("/usr/bin/codex"); // codex

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      { id: "claude", name: "Claude", available: true },
      { id: "codex", name: "Codex", available: true },
    ]);
  });

  it("marks backends as unavailable when binary is not found", async () => {
    // resolveBinary returns null for all
    mockResolveBinary.mockReturnValueOnce(null).mockReturnValueOnce(null);

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      { id: "claude", name: "Claude", available: false },
      { id: "codex", name: "Codex", available: false },
    ]);
  });

  it("handles mixed availability", async () => {
    mockResolveBinary
      .mockReturnValueOnce("/usr/bin/claude") // claude found
      .mockReturnValueOnce(null); // codex not found

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].available).toBe(true); // claude
    expect(json[1].available).toBe(false); // codex
  });
});

describe("GET /api/backends/:id/models", () => {
  it("filters old codex models and sorts current models by version descending", async () => {
    const cacheContent = JSON.stringify({
      models: [
        {
          slug: "gpt-5.3-codex-spark",
          display_name: "gpt-5.3-codex-spark",
          description: "Fast model",
          visibility: "list",
          priority: 0,
        },
        {
          slug: "gpt-5.3-codex",
          display_name: "gpt-5.3-codex",
          description: "Main codex model",
          visibility: "list",
          priority: 50,
        },
        { slug: "gpt-5.4", display_name: "gpt-5.4", description: "Frontier model", visibility: "list", priority: 0 },
        {
          slug: "gpt-5.2-codex",
          display_name: "gpt-5.2-codex",
          description: "Old model",
          visibility: "list",
          priority: 0,
        },
        {
          slug: "gpt-5.1-codex-mini",
          display_name: "gpt-5.1-codex-mini",
          description: "Older model",
          visibility: "list",
          priority: 0,
        },
        { slug: "gpt-5-codex", display_name: "gpt-5-codex", description: "Old model", visibility: "hide", priority: 8 },
      ],
    });
    vi.mocked(access).mockResolvedValue(undefined);
    // Reset readFile to clear any stale mockResolvedValueOnce from prior tests
    vi.mocked(readFile).mockReset();
    vi.mocked(readFile).mockResolvedValue(cacheContent);

    const res = await app.request("/api/backends/codex/models", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Should only include visible 5.3+ models, ordered by version then variant.
    expect(json).toEqual([
      { value: "gpt-5.4", label: "gpt-5.4", description: "Frontier model" },
      { value: "gpt-5.3-codex", label: "gpt-5.3-codex", description: "Main codex model" },
      { value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark", description: "Fast model" },
    ]);
  });

  it("returns 404 when codex cache file does not exist", async () => {
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const res = await app.request("/api/backends/codex/models", { method: "GET" });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Codex models cache not found");
  });

  it("returns 500 when cache file is malformed", async () => {
    vi.mocked(access).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue("not valid json{{{");

    const res = await app.request("/api/backends/codex/models", { method: "GET" });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("Failed to parse");
  });

  it("returns 404 for claude backend (uses frontend defaults)", async () => {
    const res = await app.request("/api/backends/claude/models", { method: "GET" });

    expect(res.status).toBe(404);
  });
});

// ─── Session creation with backend type ──────────────────────────────────────

describe("POST /api/sessions/create with backend", () => {
  it("passes backendType codex to launcher", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", cwd: "/test", backend: "codex" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.4", backendType: "codex" }));
  });

  it("uses the shared codex default model when none is provided", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "codex" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.4", backendType: "codex" }));
  });

  it("injects orchestrator env vars for codex leader sessions", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "codex", role: "orchestrator" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        env: expect.objectContaining({
          COMPANION_PORT: "3456",
          TAKODE_ROLE: "orchestrator",
          TAKODE_API_PORT: "3456",
        }),
      }),
    );
    expect(launcher.getOrchestratorGuardrails).toHaveBeenCalledWith("codex");
  });

  it("assigns 'Leader N' name and disables autonamer for orchestrator sessions", async () => {
    // Verify the integration: orchestrator sessions get "Leader N" naming
    // and noAutoName is set to suppress the autonamer.
    vi.mocked(sessionNames.getNextLeaderNumber).mockReturnValue(42);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "claude", role: "orchestrator" }),
    });

    expect(res.status).toBe(200);
    expect(sessionNames.setName).toHaveBeenCalledWith("session-1", "Leader 42");
    expect(sessionNames.getNextLeaderNumber).toHaveBeenCalled();
    // Verify noAutoName is set on the session object
    const launched = launcher.launch.mock.results[0]?.value;
    expect(launched?.noAutoName).toBe(true);
  });

  it("defaults to claude backend when not specified", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ backendType: "claude" }));
  });
});

describe("buildOrchestratorSystemPrompt", () => {
  it("keeps the Codex leader startup prompt free of Claude/sub-agent wording", () => {
    const prompt = buildOrchestratorSystemPrompt("codex");
    expect(prompt).toContain("leader session");
    expect(prompt).toContain(
      "Delegate non-trivial implementation, investigation, and verification to worker sessions.",
    );
    expect(prompt).toContain("Archiving a worktree worker deletes its worktree and any uncommitted changes.");
    expect(prompt).toContain("new source of truth");
    expect(prompt).toContain("stale review/port completions from the older scope");
    // Link syntax instructions moved to system prompt (cli-launcher.ts) -- no longer in user message
    expect(prompt).not.toContain("CLAUDE.md");
    expect(prompt).not.toContain("sub-agent");
    expect(prompt).not.toContain("[Agent]");
  });

  it("is minimal -- heavy orchestration instructions live in system prompt", () => {
    // The user message should be short: identity + role + startup instruction.
    // Detailed orchestration rules (delegation, quest lifecycle, permissions, etc.)
    // live in the system prompt built by cli-launcher.ts.
    const prompt = buildOrchestratorSystemPrompt("claude");
    expect(prompt).toContain("[System] You are a leader session");
    expect(prompt).toContain("takode-orchestration");
    expect(prompt).toContain("quest");
    expect(prompt).toContain("wait for the user's instructions");
    expect(prompt).toContain("Use the orchestration instructions already loaded in this session as your source of truth");
    expect(prompt).toContain("repo-local docs still mention deprecated leader reply tags");
    // These were moved to system prompt and should NOT appear in user message
    expect(prompt).not.toContain("Delegation principle");
    expect(prompt).not.toContain("Quest refinement");
    expect(prompt).not.toContain("Quest lifecycle");
    expect(prompt).not.toContain("Permission requests");
    expect(prompt).not.toContain("Read your project's instruction files");
  });

  it("injects the Codex-specific startup prompt for connected leader sessions", async () => {
    launcher.getSession.mockReturnValue({ state: "connected" });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "codex", role: "orchestrator" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.injectUserMessage).toHaveBeenCalledWith("session-1", buildOrchestratorSystemPrompt("codex"));
  });
});

// ─── Permission mode resolution from askPermission ───────────────────────────

describe("POST /api/sessions/create permission mode resolution", () => {
  it("launches Claude session with 'plan' permission mode when askPermission is true", async () => {
    // When Ask=True, Claude sessions should launch with permissionMode "plan"
    // so CLI starts in a guarded mode from the beginning (no race window).
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", askPermission: true }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "plan" }));
    expect(bridge.setInitialAskPermission).toHaveBeenCalledWith("session-1", true, "plan");
  });

  it("launches Claude session with 'bypassPermissions' when askPermission is false", async () => {
    // When Ask=False, Claude sessions should launch with permissionMode "bypassPermissions"
    // for full auto-approval from CLI startup.
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", askPermission: false }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "bypassPermissions" }));
    expect(bridge.setInitialAskPermission).toHaveBeenCalledWith("session-1", false, "agent");
  });

  it("defaults to 'plan' permission mode when askPermission is omitted", async () => {
    // When askPermission is not provided, default to secure (plan mode).
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "plan" }));
  });

  it("uses 'suggest' permission mode for codex sessions when askPermission is true", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "codex", askPermission: true }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "suggest" }));
    expect(bridge.setInitialAskPermission).toHaveBeenCalledWith("session-1", true, "agent");
  });

  it("uses 'bypassPermissions' permission mode for codex sessions when askPermission is false", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "codex", askPermission: false }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "bypassPermissions" }));
    expect(bridge.setInitialAskPermission).toHaveBeenCalledWith("session-1", false, "agent");
  });

  it("forwards explicit codex permissionMode to launcher", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: "/test",
        backend: "codex",
        permissionMode: "bypassPermissions",
      }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        permissionMode: "bypassPermissions",
      }),
    );
    expect(bridge.setInitialAskPermission).toHaveBeenCalledWith("session-1", false, "agent");
  });

  it("keeps codex plan mode when askPermission is false", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "codex", permissionMode: "plan", askPermission: false }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        backendType: "codex",
        permissionMode: "plan",
      }),
    );
    expect(bridge.setInitialAskPermission).toHaveBeenCalledWith("session-1", false, "plan");
  });
});

// ─── Per-session usage limits ─────────────────────────────────────────────────

describe("GET /api/sessions/:id/usage-limits", () => {
  it("returns Claude usage limits for a claude session", async () => {
    bridge.getSession.mockReturnValue({ backendType: "claude" });
    mockGetUsageLimits.mockResolvedValue({
      five_hour: { utilization: 42, resets_at: "2025-01-01T12:00:00Z" },
      seven_day: { utilization: 15, resets_at: null },
      extra_usage: null,
    });

    const res = await app.request("/api/sessions/s1/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      five_hour: { utilization: 42, resets_at: "2025-01-01T12:00:00Z" },
      seven_day: { utilization: 15, resets_at: null },
      extra_usage: null,
    });
    expect(mockGetUsageLimits).toHaveBeenCalled();
  });

  it("returns mapped Codex rate limits for a codex session", async () => {
    bridge.getSession.mockReturnValue({ backendType: "codex" });
    bridge.getCodexRateLimits.mockReturnValue({
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1731552000 },
    });

    const res = await app.request("/api/sessions/s1/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.five_hour).toEqual({
      utilization: 25,
      resets_at: new Date(1730947200 * 1000).toISOString(),
    });
    expect(json.seven_day).toEqual({
      utilization: 10,
      resets_at: new Date(1731552000 * 1000).toISOString(),
    });
    expect(json.extra_usage).toBeNull();
    expect(mockGetUsageLimits).not.toHaveBeenCalled();
  });

  it("returns empty limits when codex session has no rate limits yet", async () => {
    bridge.getSession.mockReturnValue({ backendType: "codex" });
    bridge.getCodexRateLimits.mockReturnValue(null);

    const res = await app.request("/api/sessions/s1/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ five_hour: null, seven_day: null, extra_usage: null });
  });

  it("handles codex rate limits with null secondary", async () => {
    bridge.getSession.mockReturnValue({ backendType: "codex" });
    bridge.getCodexRateLimits.mockReturnValue({
      primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 0 },
      secondary: null,
    });

    const res = await app.request("/api/sessions/s1/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.five_hour).toEqual({ utilization: 50, resets_at: null });
    expect(json.seven_day).toBeNull();
  });

  it("accepts codex reset timestamps in milliseconds", async () => {
    const resetMs = 1730947200 * 1000;
    bridge.getSession.mockReturnValue({ backendType: "codex" });
    bridge.getCodexRateLimits.mockReturnValue({
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: resetMs },
      secondary: null,
    });

    const res = await app.request("/api/sessions/s1/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.five_hour).toEqual({
      utilization: 25,
      resets_at: new Date(resetMs).toISOString(),
    });
  });

  it("falls back to Claude limits when session is not found", async () => {
    bridge.getSession.mockReturnValue(null);
    mockGetUsageLimits.mockResolvedValue({
      five_hour: null,
      seven_day: null,
      extra_usage: null,
    });

    const res = await app.request("/api/sessions/unknown/usage-limits", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ five_hour: null, seven_day: null, extra_usage: null });
    expect(mockGetUsageLimits).toHaveBeenCalled();
  });
});

describe("POST /api/sessions/:id/skills/refresh", () => {
  it("refreshes Codex skills for a codex session", async () => {
    bridge.getSession.mockReturnValue({ backendType: "codex" });
    bridge.refreshCodexSkills.mockResolvedValue({ ok: true, skills: ["review", "fix"] });

    const res = await app.request("/api/sessions/s1/skills/refresh", { method: "POST" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, skills: ["review", "fix"] });
    expect(bridge.refreshCodexSkills).toHaveBeenCalledWith("s1", true);
  });

  it("rejects skill refresh for non-codex sessions", async () => {
    bridge.getSession.mockReturnValue({ backendType: "claude" });

    const res = await app.request("/api/sessions/s1/skills/refresh", { method: "POST" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Skill refresh is only supported for Codex sessions" });
  });
});

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

// ─── Revert ───────────────────────────────────────────────────────────────

describe("POST /api/sessions/:id/revert", () => {
  // Helper to create a mock session with message history for revert tests.
  // Simulates a session with 2 turns: user→assistant→user→assistant.
  function setupRevertSession(overrides?: Partial<{ state: string; backendType: string; cliSessionId: string }>) {
    const sessionInfo = {
      sessionId: "session-1",
      state: "exited",
      cwd: "/test",
      createdAt: Date.now(),
      cliSessionId: "cli-sess-1",
      backendType: "claude",
      ...overrides,
    };
    launcher.getSession.mockReturnValue(sessionInfo);

    const mockSession: any = {
      messageHistory: [
        { type: "user_message", id: "user-msg-1", content: "Hello" },
        {
          type: "assistant",
          message: { id: "asst-msg-1", content: [{ type: "text", text: "Hi" }], model: "claude" },
          uuid: "cli-uuid-1",
          parent_tool_use_id: null,
        },
        { type: "user_message", id: "user-msg-2", content: "Do something" },
        {
          type: "assistant",
          message: { id: "asst-msg-2", content: [{ type: "text", text: "Done" }], model: "claude" },
          uuid: "cli-uuid-2",
          parent_tool_use_id: null,
        },
      ],
      pendingPermissions: new Map(),
      pendingMessages: [],
      pendingCodexTurns: [],
      pendingCodexInputs: [],
      pendingCodexRollback: null,
      pendingCodexRollbackError: null,
      eventBuffer: [
        { seq: 1, message: { type: "assistant", message: { id: "asst-msg-1" } } },
        { seq: 2, message: { type: "status_change", status: "idle" } },
        { seq: 3, message: { type: "assistant", message: { id: "asst-msg-2" } } },
        { seq: 4, message: { type: "status_change", status: "idle" } },
      ],
      nextEventSeq: 5,
      frozenCount: 4,
      lastUserMessage: "Do something",
    };
    bridge.getOrCreateSession.mockReturnValue(mockSession);

    return { sessionInfo, mockSession };
  }

  // Reverting to the second user message should truncate history to before
  // that message and call relaunchWithResumeAt with the preceding assistant UUID.
  it("reverts to a user message with preceding assistant UUID", async () => {
    const { mockSession } = setupRevertSession();

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });

    // History should be truncated to before user-msg-2 (first 2 messages)
    expect(mockSession.messageHistory).toHaveLength(2);
    expect(mockSession.messageHistory[0].type).toBe("user_message");
    expect(mockSession.messageHistory[1].type).toBe("assistant");

    // Should clear permissions and broadcast status
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", { type: "permissions_cleared" });
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", { type: "status_change", status: "reverting" });

    // Should persist immediately
    expect(bridge.persistSessionSync).toHaveBeenCalledWith("session-1");

    // Should relaunch with the preceding assistant's UUID
    expect(launcher.relaunchWithResumeAt).toHaveBeenCalledWith("session-1", "cli-uuid-1");
    expect(launcher.relaunch).not.toHaveBeenCalled();

    // Should broadcast truncated history
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", {
      type: "message_history",
      messages: mockSession.messageHistory,
    });
  });

  // Reverting to the first user message (no preceding assistant) should
  // clear cliSessionId and relaunch fresh.
  it("reverts to first user message (fresh relaunch)", async () => {
    const { sessionInfo, mockSession } = setupRevertSession();

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-1" }),
    });

    expect(res.status).toBe(200);

    // History should be empty (truncated to index 0)
    expect(mockSession.messageHistory).toHaveLength(0);

    // cliSessionId should be cleared for fresh start
    expect(sessionInfo.cliSessionId).toBeUndefined();

    // Should use regular relaunch (not relaunchWithResumeAt)
    expect(launcher.relaunch).toHaveBeenCalledWith("session-1");
    expect(launcher.relaunchWithResumeAt).not.toHaveBeenCalled();
  });

  // Returns 404 when the session doesn't exist in the launcher.
  it("returns 404 for unknown session", async () => {
    launcher.getSession.mockReturnValue(null);

    const res = await app.request("/api/sessions/nonexistent/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "msg-1" }),
    });

    expect(res.status).toBe(404);
  });

  // Codex revert uses thread/rollback and clears Codex-only pending state so
  // browser chips and replay queues do not resurrect reverted inputs.
  it("reverts Codex sessions via thread rollback and clears pending Codex state", async () => {
    const { mockSession } = setupRevertSession({ backendType: "codex" });
    mockSession.messageHistory = [
      { type: "user_message", id: "user-msg-1", content: "Hello" },
      {
        type: "assistant",
        message: { id: "asst-msg-1", content: [{ type: "text", text: "Hi" }], model: "gpt-5.4" },
        parent_tool_use_id: null,
      },
      {
        type: "result",
        data: { uuid: "result-1", codex_turn_id: "turn-1", is_error: false, subtype: "success", type: "result" },
      },
      { type: "user_message", id: "user-msg-2", content: "Do something" },
      {
        type: "assistant",
        message: { id: "asst-msg-2", content: [{ type: "text", text: "Done" }], model: "gpt-5.4" },
        parent_tool_use_id: null,
      },
      {
        type: "result",
        data: { uuid: "result-2", codex_turn_id: "turn-2", is_error: false, subtype: "success", type: "result" },
      },
    ];
    mockSession.frozenCount = 6;
    const rollbackTurns = vi.fn(async () => {});
    mockSession.codexAdapter = {
      isConnected: () => true,
      getThreadId: () => "cli-sess-1",
      rollbackTurns,
    };
    mockSession.pendingCodexInputs = [{ id: "pending-1", content: "queued", timestamp: 1, cancelable: true }];
    mockSession.pendingCodexTurns = [
      {
        adapterMsg: { type: "codex_start_pending", pendingInputIds: ["pending-1"], inputs: [{ content: "queued" }] },
        userMessageId: "pending-1",
        pendingInputIds: ["pending-1"],
        userContent: "queued",
        historyIndex: 0,
        status: "queued",
        dispatchCount: 0,
        createdAt: 1,
        updatedAt: 1,
        acknowledgedAt: null,
        turnTarget: null,
        lastError: null,
        turnId: null,
        disconnectedAt: null,
        resumeConfirmedAt: null,
      },
    ];
    mockSession.pendingMessages = ['{"type":"permission_response","request_id":"req-1","behavior":"allow"}'];
    mockSession.userMessageIdsThisTurn = [2];
    mockSession.queuedTurnStarts = 1;
    mockSession.queuedTurnReasons = ["follow_up"];
    mockSession.queuedTurnUserMessageIds = [[2]];
    mockSession.queuedTurnInterruptSources = ["user"];
    mockSession.interruptedDuringTurn = true;
    mockSession.interruptSourceDuringTurn = "user";
    mockSession.isGenerating = true;
    mockSession.generationStartedAt = 123;

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(200);
    expect(rollbackTurns).toHaveBeenCalledWith(1);
    expect(mockSession.messageHistory).toHaveLength(3);
    expect(mockSession.pendingCodexInputs).toEqual([]);
    expect(mockSession.pendingCodexTurns).toEqual([]);
    expect(mockSession.pendingMessages).toEqual([]);
    expect(mockSession.userMessageIdsThisTurn).toEqual([]);
    expect(mockSession.queuedTurnStarts).toBe(0);
    expect(mockSession.isGenerating).toBe(false);
    expect(mockSession.generationStartedAt).toBeNull();
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", {
      type: "codex_pending_inputs",
      inputs: [],
    });
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", { type: "status_change", status: "idle" });
  });

  // Codex rollback is turn-based upstream, so Takode refuses follow-up user
  // messages that were steered into an existing Codex turn. Users must revert
  // from the first user message in that turn to avoid hidden extra deletions.
  it("rejects Codex revert for a later user message inside the same Codex turn", async () => {
    const { mockSession } = setupRevertSession({ backendType: "codex" });
    mockSession.messageHistory = [
      { type: "user_message", id: "user-msg-1", content: "Hello" },
      { type: "assistant", message: { id: "asst-msg-1", content: [{ type: "text", text: "Hi" }], model: "gpt-5.4" } },
      {
        type: "result",
        data: { uuid: "result-1", codex_turn_id: "turn-1", is_error: false, subtype: "success", type: "result" },
      },
      { type: "user_message", id: "user-msg-2", content: "First input in turn 2" },
      { type: "user_message", id: "user-msg-3", content: "Steered follow-up in turn 2" },
      { type: "assistant", message: { id: "asst-msg-2", content: [{ type: "text", text: "Done" }], model: "gpt-5.4" } },
      {
        type: "result",
        data: { uuid: "result-2", codex_turn_id: "turn-2", is_error: false, subtype: "success", type: "result" },
      },
    ];
    mockSession.frozenCount = 6;
    const rollbackTurns = vi.fn(async () => {});
    mockSession.codexAdapter = {
      isConnected: () => true,
      getThreadId: () => "cli-sess-1",
      rollbackTurns,
    };

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-3" }),
    });

    expect(res.status).toBe(409);
    expect(rollbackTurns).not.toHaveBeenCalled();
    expect(mockSession.messageHistory).toHaveLength(7);
    expect(bridge.broadcastToSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("first user message in a Codex turn"),
      }),
    );
  });

  it("reverts Codex to before the first user turn", async () => {
    const { mockSession } = setupRevertSession({ backendType: "codex" });
    mockSession.messageHistory = [
      { type: "user_message", id: "user-msg-1", content: "Hello" },
      { type: "assistant", message: { id: "asst-msg-1", content: [{ type: "text", text: "Hi" }], model: "gpt-5.4" } },
      {
        type: "result",
        data: { uuid: "result-1", codex_turn_id: "turn-1", is_error: false, subtype: "success", type: "result" },
      },
      { type: "user_message", id: "user-msg-2", content: "Do something" },
      { type: "assistant", message: { id: "asst-msg-2", content: [{ type: "text", text: "Done" }], model: "gpt-5.4" } },
      {
        type: "result",
        data: { uuid: "result-2", codex_turn_id: "turn-2", is_error: false, subtype: "success", type: "result" },
      },
    ];
    mockSession.frozenCount = 6;
    const rollbackTurns = vi.fn(async () => {});
    mockSession.codexAdapter = {
      isConnected: () => true,
      getThreadId: () => "cli-sess-1",
      rollbackTurns,
    };

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-1" }),
    });

    expect(res.status).toBe(200);
    expect(rollbackTurns).toHaveBeenCalledWith(2);
    expect(mockSession.messageHistory).toEqual([]);
  });

  // Returns 400 when the session has no CLI session ID to resume.
  it("returns 400 when no cliSessionId", async () => {
    setupRevertSession({ cliSessionId: undefined as any });

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(400);
  });

  // Returns 404 when the target message ID doesn't exist in history.
  it("returns 404 when messageId not found in history", async () => {
    setupRevertSession();

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "nonexistent-msg" }),
    });

    expect(res.status).toBe(404);
  });

  // Returns 503 when relaunch fails (e.g. CLI binary not found).
  it("returns 503 when relaunch fails", async () => {
    setupRevertSession();
    launcher.relaunchWithResumeAt.mockResolvedValue({ ok: false, error: "CLI not found" });

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("CLI not found");
  });

  it("returns 503 when Codex rollback fails", async () => {
    const { mockSession } = setupRevertSession({ backendType: "codex" });
    mockSession.messageHistory = [
      { type: "user_message", id: "user-msg-1", content: "Hello" },
      { type: "assistant", message: { id: "asst-msg-1", content: [{ type: "text", text: "Hi" }], model: "gpt-5.4" } },
      {
        type: "result",
        data: { uuid: "result-1", codex_turn_id: "turn-1", is_error: false, subtype: "success", type: "result" },
      },
      { type: "user_message", id: "user-msg-2", content: "Do something" },
      { type: "assistant", message: { id: "asst-msg-2", content: [{ type: "text", text: "Done" }], model: "gpt-5.4" } },
      {
        type: "result",
        data: { uuid: "result-2", codex_turn_id: "turn-2", is_error: false, subtype: "success", type: "result" },
      },
    ];
    mockSession.pendingPermissions = new Map([["perm-1", { tool_name: "Bash" }]]);
    mockSession.pendingCodexInputs = [{ id: "pending-1", content: "queued", timestamp: 1, cancelable: true }];
    mockSession.pendingCodexTurns = [
      {
        adapterMsg: { type: "codex_start_pending", pendingInputIds: ["pending-1"], inputs: [{ content: "queued" }] },
        userMessageId: "pending-1",
        pendingInputIds: ["pending-1"],
        userContent: "queued",
        historyIndex: 0,
        status: "queued",
        dispatchCount: 0,
        createdAt: 1,
        updatedAt: 1,
        acknowledgedAt: null,
        turnTarget: null,
        lastError: null,
        turnId: null,
        disconnectedAt: null,
        resumeConfirmedAt: null,
      },
    ];
    mockSession.pendingMessages = ['{"type":"permission_response","request_id":"req-1","behavior":"allow"}'];
    mockSession.codexAdapter = {
      isConnected: () => true,
      getThreadId: () => "cli-sess-1",
      rollbackTurns: vi.fn(async () => {
        throw new Error("rollback failed");
      }),
    };

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("rollback failed");
    expect(mockSession.messageHistory).toHaveLength(6);
    expect(mockSession.pendingPermissions.size).toBe(1);
    expect(mockSession.pendingCodexInputs).toHaveLength(1);
    expect(mockSession.pendingCodexTurns).toHaveLength(1);
    expect(mockSession.pendingMessages).toHaveLength(1);
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", { type: "status_change", status: "idle" });
    expect(bridge.broadcastToSession).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "error", message: expect.stringContaining("rollback failed") }),
    );
  });

  it("reverts Codex via route when rollback requires relaunch and later succeeds", async () => {
    const { mockSession, sessionInfo } = setupRevertSession({ backendType: "codex" });
    mockSession.messageHistory = [
      { type: "user_message", id: "user-msg-1", content: "Hello" },
      { type: "assistant", message: { id: "asst-msg-1", content: [{ type: "text", text: "Hi" }], model: "gpt-5.4" } },
      {
        type: "result",
        data: { uuid: "result-1", codex_turn_id: "turn-1", is_error: false, subtype: "success", type: "result" },
      },
      { type: "user_message", id: "user-msg-2", content: "Do something" },
      { type: "assistant", message: { id: "asst-msg-2", content: [{ type: "text", text: "Done" }], model: "gpt-5.4" } },
      {
        type: "result",
        data: { uuid: "result-2", codex_turn_id: "turn-2", is_error: false, subtype: "success", type: "result" },
      },
    ];
    mockSession.frozenCount = 6;

    let resolveRollback!: () => void;
    const rollbackPromise = new Promise<void>((resolve) => {
      resolveRollback = resolve;
    });
    bridge.beginCodexRollback.mockReturnValue({ promise: rollbackPromise, requiresRelaunch: true });
    launcher.relaunch.mockImplementation(async () => {
      sessionInfo.state = "starting";
      queueMicrotask(() => {
        const reverted = bridge.prepareSessionForRevert("session-1", 3, { clearCodexState: true });
        bridge.persistSessionSync("session-1");
        bridge.broadcastToSession("session-1", { type: "message_history", messages: reverted.messageHistory });
        bridge.broadcastToSession("session-1", { type: "status_change", status: "idle" });
        resolveRollback();
      });
      return { ok: true };
    });

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.beginCodexRollback).toHaveBeenCalledWith("session-1", {
      numTurns: 1,
      truncateIdx: 3,
      clearCodexState: true,
    });
    expect(launcher.relaunch).toHaveBeenCalledWith("session-1");
    expect(mockSession.messageHistory).toHaveLength(3);
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", {
      type: "message_history",
      messages: mockSession.messageHistory,
    });
    expect(bridge.broadcastToSession).toHaveBeenCalledWith("session-1", { type: "status_change", status: "idle" });
  });

  // Revert must clear stale eventBuffer entries so browsers don't replay
  // events from the reverted turn after server restart. nextEventSeq is
  // preserved (not reset) so subsequent broadcasts use seq numbers beyond
  // browsers' lastAckSeq. Also clamps frozenCount to the truncated history.
  it("clears eventBuffer and clamps frozenCount on revert", async () => {
    const { mockSession } = setupRevertSession();

    // Precondition: session has stale eventBuffer and high frozenCount
    expect(mockSession.eventBuffer).toHaveLength(4);
    expect(mockSession.frozenCount).toBe(4);
    const seqBefore = mockSession.nextEventSeq;

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(200);

    // eventBuffer should be cleared
    expect(mockSession.eventBuffer).toHaveLength(0);

    // nextEventSeq must NOT be reset -- subsequent broadcasts need seq
    // numbers beyond browsers' lastAckSeq to avoid being skipped.
    expect(mockSession.nextEventSeq).toBeGreaterThanOrEqual(seqBefore);

    // frozenCount should be clamped to truncated history length (2 messages survive)
    expect(mockSession.frozenCount).toBeLessThanOrEqual(mockSession.messageHistory.length);
    expect(mockSession.frozenCount).toBe(2);
  });

  // Revert must clear stale compaction state left by a reverted /compact turn.
  // Without this, the next /compact after revert produces duplicate markers (q-227).
  it("clears stale compaction state on revert (q-227)", async () => {
    const { mockSession } = setupRevertSession();
    const session = mockSession as any;

    // Simulate stale compaction state from a reverted /compact turn
    session.awaitingCompactSummary = true;
    session.compactedDuringTurn = true;
    session.state = { is_compacting: true };

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(200);

    // All compaction flags should be cleared
    expect(session.awaitingCompactSummary).toBe(false);
    expect(session.compactedDuringTurn).toBe(false);
    expect(session.state.is_compacting).toBe(false);
  });
});

// ─── Quests ────────────────────────────────────────────────────────────────

describe("PATCH /api/quests/:questId", () => {
  it("syncs claimed session name when in-progress quest title is updated", async () => {
    vi.spyOn(questStore, "patchQuest").mockReturnValueOnce({
      id: "q-1-v2",
      questId: "q-1",
      title: "Updated quest title",
      status: "in_progress",
      sessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const res = await app.request("/api/quests/q-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated quest title" }),
    });

    expect(res.status).toBe(200);
    // setSessionClaimedQuest now handles broadcastNameUpdate source:quest and
    // persisting the name via its onSessionNamedByQuest callback internally,
    // so we only verify it was called with the right args.
    expect(bridge.setSessionClaimedQuest).toHaveBeenCalledWith("session-1", {
      id: "q-1",
      title: "Updated quest title",
      status: "in_progress",
    });
    expect(bridge.updateQuestTaskEntries).toHaveBeenCalledWith("session-1", "q-1", "Updated quest title");
    expect(bridge.broadcastGlobal).toHaveBeenCalledWith(expect.objectContaining({ type: "quest_list_updated" }));
  });
});

describe("POST /api/quests/:questId/transition", () => {
  it("clears claimed quest from the pre-transition active owner when moved to done", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v2",
      questId: "q-1",
      title: "Quest",
      status: "needs_verification",
      sessionId: "session-1",
      createdAt: Date.now(),
      claimedAt: Date.now(),
      description: "Ready",
      verificationItems: [{ text: "verify", checked: false }],
    } as any);
    vi.spyOn(questStore, "transitionQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      title: "Quest",
      status: "done",
      createdAt: Date.now(),
      description: "Ready",
      verificationItems: [{ text: "verify", checked: true }],
      completedAt: Date.now(),
      previousOwnerSessionIds: ["session-1"],
    } as any);

    const res = await app.request("/api/quests/q-1/transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.setSessionClaimedQuest).toHaveBeenCalledWith("session-1", null);
  });

  it("broadcasts claimed quest to the target active session for in_progress transitions", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v1",
      questId: "q-1",
      title: "Quest",
      status: "refined",
      createdAt: Date.now(),
      description: "Ready",
    } as any);
    vi.spyOn(questStore, "transitionQuest").mockResolvedValueOnce({
      id: "q-1-v2",
      questId: "q-1",
      title: "Quest",
      status: "in_progress",
      createdAt: Date.now(),
      claimedAt: Date.now(),
      description: "Ready",
      sessionId: "session-2",
    } as any);

    const res = await app.request("/api/quests/q-1/transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress", sessionId: "session-2", description: "Ready" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.setSessionClaimedQuest).toHaveBeenCalledWith("session-2", {
      id: "q-1",
      title: "Quest",
      status: "in_progress",
    });
  });
});

describe("GET /api/quests/:questId/commits/:sha", () => {
  it("returns git-backed commit details for a SHA attached to the quest", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "needs_verification",
      createdAt: Date.now(),
      description: "Ready",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [{ text: "verify", checked: false }],
      commitShas: ["abc1234"],
    } as any);
    launcher.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/repo/worktree",
      repoRoot: "/repo",
    } as any);
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd !== "string") throw new Error("non-string cmd");
      if (cmd.includes('rev-parse --verify "abc1234^')) return "abc1234567890abcdef\n";
      if (cmd.includes('show -s --format="%H%x00%h%x00%s%x00%ct"')) {
        return ["abc1234567890abcdef", "abc1234", "Attach commits to quests", "1713292534"].join("\0") + "\n";
      }
      if (cmd.includes('show --format= --numstat --no-renames "abc1234567890abcdef"')) {
        return (
          ["12\t4\tweb/server/routes/quests.ts", "3\t0\tweb/src/components/QuestDetailPanel.tsx"].join("\n") + "\n"
        );
      }
      if (cmd.includes('show --format= --patch --no-color "abc1234567890abcdef"')) {
        return `diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n`;
      }
      throw new Error(`Unmocked: ${cmd}`);
    });

    const res = await app.request("/api/quests/q-1/commits/abc1234", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      sha: "abc1234567890abcdef",
      shortSha: "abc1234",
      message: "Attach commits to quests",
      additions: 15,
      deletions: 4,
      available: true,
    });
    expect(json.diff).toContain("diff --git");
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(expect.stringContaining('rev-parse --verify "abc1234^'));
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining('show --format= --numstat --no-renames "abc1234567890abcdef"'),
    );
  });

  it("returns an unavailable state when the commit cannot be found locally", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "needs_verification",
      createdAt: Date.now(),
      description: "Ready",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [{ text: "verify", checked: false }],
      commitShas: ["deadbee"],
    } as any);
    launcher.getSession.mockReturnValue({
      sessionId: "session-1",
      cwd: "/repo/worktree",
      repoRoot: "/repo",
    } as any);
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("unknown revision");
    });

    const res = await app.request("/api/quests/q-1/commits/deadbee", { method: "GET" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      sha: "deadbee",
      available: false,
      reason: "commit_not_available",
    });
  });
});

describe("POST /api/quests/:questId/claim", () => {
  function companionAuthHeaders(sessionId: string, token: string): Record<string, string> {
    return {
      "x-companion-session-id": sessionId,
      "x-companion-auth-token": token,
      "Content-Type": "application/json",
    };
  }

  it("returns 400 when sessionId does not belong to a known companion session", async () => {
    const claimSpy = vi.spyOn(questStore, "claimQuest");

    const res = await app.request("/api/quests/q-1/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "cli-standalone" }),
    });

    expect(res.status).toBe(400);
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("accepts authenticated caller identity when sessionId is omitted", async () => {
    vi.spyOn(questStore, "claimQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      title: "Quest",
      status: "in_progress",
      sessionId: "session-2",
      createdAt: Date.now(),
      claimedAt: Date.now(),
      description: "Ready",
    } as any);
    launcher.getSession.mockImplementation((sid: string) =>
      sid === "session-2" ? { sessionId: "session-2", state: "running", cwd: "/test", archived: false } : undefined,
    );
    launcher.verifySessionAuthToken.mockImplementation(
      (sid: string, token: string) => sid === "session-2" && token === "tok-2",
    );

    const res = await app.request("/api/quests/q-1/claim", {
      method: "POST",
      headers: companionAuthHeaders("session-2", "tok-2"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(questStore.claimQuest).toHaveBeenCalledWith("q-1", "session-2", expect.any(Object));
  });

  it("returns 403 when body sessionId mismatches authenticated caller", async () => {
    launcher.getSession.mockImplementation((sid: string) =>
      sid === "session-2" ? { sessionId: "session-2", state: "running", cwd: "/test", archived: false } : undefined,
    );
    launcher.verifySessionAuthToken.mockImplementation(
      (sid: string, token: string) => sid === "session-2" && token === "tok-2",
    );

    const res = await app.request("/api/quests/q-1/claim", {
      method: "POST",
      headers: companionAuthHeaders("session-2", "tok-2"),
      body: JSON.stringify({ sessionId: "session-3" }),
    });

    expect(res.status).toBe(403);
    expect(questStore.claimQuest).not.toHaveBeenCalled();
  });

  it("returns 403 when the claiming session is an orchestrator (q-87)", async () => {
    // Orchestrator/leader sessions must never claim quests -- they dispatch to workers.
    // The server enforces this even if the CLI-side TAKODE_ROLE check is bypassed.
    launcher.getSession.mockReturnValue({
      sessionId: "session-1",
      state: "running",
      cwd: "/test",
      archived: false,
      isOrchestrator: true,
    } as any);
    const claimSpy = vi.spyOn(questStore, "claimQuest");

    const res = await app.request("/api/quests/q-1/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Leader sessions cannot claim quests");
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("passes archived-owner takeover policy to questStore.claimQuest", async () => {
    vi.spyOn(questStore, "claimQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      title: "Quest",
      status: "in_progress",
      sessionId: "session-2",
      createdAt: Date.now(),
      claimedAt: Date.now(),
      description: "Ready",
    } as any);

    launcher.getSession.mockImplementation((sid: string) =>
      sid === "session-1"
        ? { sessionId: "session-1", state: "exited", cwd: "/test", archived: true }
        : { sessionId: sid, state: "running", cwd: "/test", archived: false },
    );

    const res = await app.request("/api/quests/q-1/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-2" }),
    });

    expect(res.status).toBe(200);
    expect(questStore.claimQuest).toHaveBeenCalledWith(
      "q-1",
      "session-2",
      expect.objectContaining({
        allowArchivedOwnerTakeover: true,
        isSessionArchived: expect.any(Function),
      }),
    );
    const opts = vi.mocked(questStore.claimQuest).mock.calls[0][2] as { isSessionArchived: (sid: string) => boolean };
    expect(opts.isSessionArchived("session-1")).toBe(true);
    expect(opts.isSessionArchived("session-2")).toBe(false);
  });

  it("adds a quest-sourced task history entry with questId for deep-linking", async () => {
    vi.spyOn(questStore, "claimQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      title: "Quest",
      status: "in_progress",
      sessionId: "session-2",
      createdAt: Date.now(),
      claimedAt: Date.now(),
      description: "Ready",
    } as any);

    launcher.getSession.mockReturnValue({
      sessionId: "session-2",
      state: "running",
      cwd: "/test",
      archived: false,
    } as any);

    bridge.getSession.mockReturnValue({
      messageHistory: [{ type: "user_message", id: "u-1", content: "claim", timestamp: Date.now() }],
    } as any);

    const res = await app.request("/api/quests/q-1/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-2" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.addTaskEntry).toHaveBeenCalledWith(
      "session-2",
      expect.objectContaining({
        title: "Quest",
        source: "quest",
        questId: "q-1",
        triggerMessageId: "u-1",
      }),
    );
  });
});

describe("POST /api/quests/:questId/feedback", () => {
  function companionAuthHeaders(sessionId: string, token: string): Record<string, string> {
    return {
      "x-companion-session-id": sessionId,
      "x-companion-auth-token": token,
      "Content-Type": "application/json",
    };
  }

  it("returns 400 when agent feedback omits sessionId", async () => {
    const getQuestSpy = vi.spyOn(questStore, "getQuest");
    const patchSpy = vi.spyOn(questStore, "patchQuest");

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Addressed", author: "agent" }),
    });

    expect(res.status).toBe(400);
    expect(getQuestSpy).not.toHaveBeenCalled();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("accepts authenticated caller identity for agent feedback when sessionId is omitted", async () => {
    launcher.getSession.mockImplementation((sid: string) =>
      sid === "session-1" ? { sessionId: "session-1", state: "running", cwd: "/test", archived: false } : undefined,
    );
    launcher.verifySessionAuthToken.mockImplementation(
      (sid: string, token: string) => sid === "session-1" && token === "tok-1",
    );
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [{ author: "agent", authorSessionId: "session-1", text: "Addressed", ts: Date.now() }],
    } as any);

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: companionAuthHeaders("session-1", "tok-1"),
      body: JSON.stringify({ text: "Addressed", author: "agent" }),
    });

    expect(res.status).toBe(200);
    const feedback = (patchSpy.mock.calls[0][1] as { feedback: Array<{ authorSessionId?: string }> }).feedback;
    expect(feedback[feedback.length - 1]?.authorSessionId).toBe("session-1");
  });

  it("returns 403 when feedback sessionId mismatches authenticated caller", async () => {
    launcher.getSession.mockImplementation((sid: string) =>
      sid === "session-1" ? { sessionId: "session-1", state: "running", cwd: "/test", archived: false } : undefined,
    );
    launcher.verifySessionAuthToken.mockImplementation(
      (sid: string, token: string) => sid === "session-1" && token === "tok-1",
    );

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: companionAuthHeaders("session-1", "tok-1"),
      body: JSON.stringify({ text: "Addressed", author: "agent", sessionId: "session-2" }),
    });

    expect(res.status).toBe(403);
    expect(questStore.patchQuest).not.toHaveBeenCalled();
  });

  it("returns 400 when agent feedback sessionId does not belong to a known companion session", async () => {
    const getQuestSpy = vi.spyOn(questStore, "getQuest");
    const patchSpy = vi.spyOn(questStore, "patchQuest");
    launcher.getSession.mockReturnValue(undefined);

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Addressed", author: "agent", sessionId: "cli-standalone" }),
    });

    expect(res.status).toBe(400);
    expect(getQuestSpy).not.toHaveBeenCalled();
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("records authorSessionId for agent feedback when sessionId is valid", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "session-1",
      state: "running",
      cwd: "/test",
      archived: false,
    });
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [{ author: "agent", authorSessionId: "session-1", text: "Addressed", ts: Date.now() }],
    } as any);

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Addressed", author: "agent", sessionId: "session-1" }),
    });

    expect(res.status).toBe(200);
    const feedback = (
      patchSpy.mock.calls[0][1] as { feedback: Array<{ author: string; authorSessionId?: string; text: string }> }
    ).feedback;
    expect(feedback[feedback.length - 1]).toMatchObject({
      author: "agent",
      authorSessionId: "session-1",
      text: "Addressed",
    });
  });

  it("upserts the latest agent summary comment instead of appending a near-duplicate summary entry", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "session-1",
      state: "running",
      cwd: "/test",
      archived: false,
    });
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 2000, addressed: false },
        { author: "agent", text: "Addressed: tightened spacing", ts: Date.now() - 1500, authorSessionId: "session-1" },
        { author: "agent", text: "Summary: initial summary", ts: Date.now() - 1000, authorSessionId: "session-1" },
      ],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 2000, addressed: false },
        { author: "agent", text: "Addressed: tightened spacing", ts: Date.now() - 1500, authorSessionId: "session-1" },
        { author: "agent", text: "Summary: revised summary", ts: Date.now(), authorSessionId: "session-1" },
      ],
    } as any);

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Summary: revised summary", author: "agent", sessionId: "session-1" }),
    });

    expect(res.status).toBe(200);
    expect(patchSpy).toHaveBeenCalledWith(
      "q-1",
      expect.objectContaining({
        feedback: [
          expect.objectContaining({ author: "human", text: "Please verify spacing" }),
          expect.objectContaining({ author: "agent", text: "Addressed: tightened spacing" }),
          expect.objectContaining({
            author: "agent",
            authorSessionId: "session-1",
            text: "Summary: revised summary",
          }),
        ],
      }),
    );
    const feedback = (patchSpy.mock.calls[0]?.[1] as { feedback: Array<{ text: string }> }).feedback;
    expect(feedback).toHaveLength(3);
  });

  it("upserts the latest refreshed summary comment instead of appending a duplicate refreshed summary entry", async () => {
    launcher.getSession.mockReturnValue({
      sessionId: "session-1",
      state: "running",
      cwd: "/test",
      archived: false,
    });
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 2000, addressed: false },
        {
          author: "agent",
          text: "Refreshed summary: initial refreshed summary",
          ts: Date.now() - 1000,
          authorSessionId: "session-1",
        },
      ],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 2000, addressed: false },
        {
          author: "agent",
          text: "Refreshed summary: updated refreshed summary",
          ts: Date.now(),
          authorSessionId: "session-1",
        },
      ],
    } as any);

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Refreshed summary: updated refreshed summary",
        author: "agent",
        sessionId: "session-1",
      }),
    });

    expect(res.status).toBe(200);
    const feedback = (patchSpy.mock.calls[0]?.[1] as { feedback: Array<{ text: string }> }).feedback;
    expect(feedback).toHaveLength(2);
    expect(feedback[1]?.text).toBe("Refreshed summary: updated refreshed summary");
  });
});

describe("PATCH /api/quests/:questId/feedback/:index", () => {
  it("edits an agent feedback entry by index", async () => {
    // Editing should only rewrite the targeted agent comment and preserve the rest of the thread metadata.
    const editedAt = Date.now();
    const image = { id: "img-1", filename: "proof.png", mimeType: "image/png", path: "/tmp/proof.png" };
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 1000, addressed: false },
        { author: "agent", text: "Initial response", ts: editedAt, authorSessionId: "session-1", images: [image] },
      ],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 1000, addressed: false },
        { author: "agent", text: "Updated response", ts: editedAt, authorSessionId: "session-1", images: [image] },
      ],
    } as any);

    const res = await app.request("/api/quests/q-1/feedback/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Updated response" }),
    });

    expect(res.status).toBe(200);
    expect(patchSpy).toHaveBeenCalledWith(
      "q-1",
      expect.objectContaining({
        feedback: [
          expect.objectContaining({ author: "human", text: "Please verify spacing" }),
          expect.objectContaining({
            author: "agent",
            text: "Updated response",
            ts: editedAt,
            authorSessionId: "session-1",
            images: [expect.objectContaining({ id: "img-1", filename: "proof.png" })],
          }),
        ],
      }),
    );
  });

  it("clears agent feedback images when edit explicitly sends an empty image list", async () => {
    // Attachment removal must survive the route layer so clearing the final image does not preserve stale attachments.
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 1000, addressed: false },
        {
          author: "agent",
          text: "Initial response",
          ts: Date.now(),
          authorSessionId: "session-1",
          images: [{ id: "img-1", filename: "proof.png", mimeType: "image/png", path: "/tmp/proof.png" }],
        },
      ],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 1000, addressed: false },
        { author: "agent", text: "Initial response", ts: Date.now(), authorSessionId: "session-1" },
      ],
    } as any);

    const res = await app.request("/api/quests/q-1/feedback/1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: [] }),
    });

    expect(res.status).toBe(200);
    expect(patchSpy).toHaveBeenCalledWith(
      "q-1",
      expect.objectContaining({
        feedback: [
          expect.objectContaining({ author: "human", text: "Please verify spacing" }),
          expect.objectContaining({ author: "agent", images: undefined }),
        ],
      }),
    );
  });

  it("rejects edits to human feedback entries", async () => {
    // Human review comments should remain immutable from the agent-feedback edit endpoint.
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [{ author: "human", text: "Please verify spacing", ts: Date.now(), addressed: false }],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest");

    const res = await app.request("/api/quests/q-1/feedback/0", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Overwritten" }),
    });

    expect(res.status).toBe(400);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 for an out-of-range feedback index", async () => {
    // Invalid indexes should fail before the thread is rewritten.
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [{ author: "agent", text: "Initial response", ts: Date.now(), authorSessionId: "session-1" }],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest");

    const res = await app.request("/api/quests/q-1/feedback/3", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Updated response" }),
    });

    expect(res.status).toBe(400);
    expect(patchSpy).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/quests/:questId/feedback/:index", () => {
  it("deletes an agent feedback entry by index", async () => {
    // Deletion should remove only the targeted agent comment and leave human feedback intact.
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 1000, addressed: false },
        { author: "agent", text: "Initial response", ts: Date.now(), authorSessionId: "session-1" },
      ],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [{ author: "human", text: "Please verify spacing", ts: Date.now() - 1000, addressed: false }],
    } as any);

    const res = await app.request("/api/quests/q-1/feedback/1", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(patchSpy).toHaveBeenCalledWith(
      "q-1",
      expect.objectContaining({
        feedback: [expect.objectContaining({ author: "human", text: "Please verify spacing" })],
      }),
    );
  });

  it("rejects deletes for human feedback entries", async () => {
    // Human review comments should not be removable through the agent-feedback delete path.
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [{ author: "human", text: "Please verify spacing", ts: Date.now(), addressed: false }],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest");

    const res = await app.request("/api/quests/q-1/feedback/0", {
      method: "DELETE",
    });

    expect(res.status).toBe(400);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("returns 400 for an out-of-range delete index", async () => {
    // Invalid indexes should fail before the feedback array is rewritten.
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      version: 3,
      title: "Quest",
      createdAt: Date.now(),
      status: "needs_verification",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [{ author: "agent", text: "Initial response", ts: Date.now(), authorSessionId: "session-1" }],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest");

    const res = await app.request("/api/quests/q-1/feedback/3", {
      method: "DELETE",
    });

    expect(res.status).toBe(400);
    expect(patchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/quests/:questId/done", () => {
  it("clears claimed quest from the pre-transition active owner", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v2",
      questId: "q-1",
      title: "Quest",
      status: "needs_verification",
      sessionId: "session-1",
      createdAt: Date.now(),
      claimedAt: Date.now(),
      description: "Ready",
      verificationItems: [{ text: "verify", checked: false }],
    } as any);
    vi.spyOn(questStore, "transitionQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      title: "Quest",
      status: "done",
      createdAt: Date.now(),
      description: "Ready",
      verificationItems: [{ text: "verify", checked: true }],
      completedAt: Date.now(),
      previousOwnerSessionIds: ["session-1"],
    } as any);

    const res = await app.request("/api/quests/q-1/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(questStore.transitionQuest).toHaveBeenCalledWith("q-1", expect.objectContaining({ status: "done" }));
    expect(bridge.setSessionClaimedQuest).toHaveBeenCalledWith("session-1", null);
  });
});

describe("POST /api/quests/:questId/cancel", () => {
  it("clears claimed quest from the pre-transition active owner", async () => {
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1-v2",
      questId: "q-1",
      title: "Quest",
      status: "in_progress",
      sessionId: "session-1",
      createdAt: Date.now(),
      claimedAt: Date.now(),
      description: "Ready",
    } as any);
    vi.spyOn(questStore, "cancelQuest").mockResolvedValueOnce({
      id: "q-1-v3",
      questId: "q-1",
      title: "Quest",
      status: "done",
      createdAt: Date.now(),
      description: "Ready",
      verificationItems: [],
      completedAt: Date.now(),
      cancelled: true,
      previousOwnerSessionIds: ["session-1"],
    } as any);

    const res = await app.request("/api/quests/q-1/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(bridge.setSessionClaimedQuest).toHaveBeenCalledWith("session-1", null);
  });
});

describe("POST /api/quests/:questId/verification/read", () => {
  it("marks verification quest as read and broadcasts quest_list_updated", async () => {
    // Endpoint contract: mark as read in store and notify all browsers so inbox
    // sections update in real time.
    vi.spyOn(questStore, "markQuestVerificationRead").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "needs_verification",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: "session-1",
      claimedAt: Date.now(),
      description: "Ready",
      verificationItems: [{ text: "verify", checked: false }],
      verificationInboxUnread: false,
    } as any);

    const res = await app.request("/api/quests/q-1/verification/read", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(questStore.markQuestVerificationRead).toHaveBeenCalledWith("q-1");
    expect(bridge.broadcastGlobal).toHaveBeenCalledWith(expect.objectContaining({ type: "quest_list_updated" }));
  });
});

describe("POST /api/quests/:questId/verification/inbox", () => {
  it("moves a verification quest back into inbox and broadcasts quest_list_updated", async () => {
    // Endpoint contract: mark as inbox-unread and notify all browsers so inbox
    // sections update in real time.
    vi.spyOn(questStore, "markQuestVerificationInboxUnread").mockResolvedValueOnce({
      id: "q-1-v4",
      questId: "q-1",
      title: "Quest",
      status: "needs_verification",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: "session-1",
      claimedAt: Date.now(),
      description: "Ready",
      verificationItems: [{ text: "verify", checked: false }],
      verificationInboxUnread: true,
    } as any);

    const res = await app.request("/api/quests/q-1/verification/inbox", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(questStore.markQuestVerificationInboxUnread).toHaveBeenCalledWith("q-1");
    expect(bridge.broadcastGlobal).toHaveBeenCalledWith(expect.objectContaining({ type: "quest_list_updated" }));
  });
});

// ─── Questmaster Notify ─────────────────────────────────────────────────────

describe("POST /api/quests/_notify", () => {
  it("broadcasts quest_list_updated and returns ok", async () => {
    const res = await app.request("/api/quests/_notify", { method: "POST" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    // Verify it called broadcastGlobal to notify browsers
    expect(bridge.broadcastGlobal).toHaveBeenCalledWith(expect.objectContaining({ type: "quest_list_updated" }));
  });
});

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
    return sessions;
  }

  it("denies spoofed token and allows authenticated takode list scope for workers and orchestrators", async () => {
    setupTakodeSessions();
    launcher.verifySessionAuthToken.mockImplementation(
      (id: string, token: string) => (id === "orch-1" && token === "tok-1") || (id === "worker-2" && token === "tok-2"),
    );

    const denied = await app.request("/api/takode/sessions", {
      method: "GET",
      headers: authHeaders("orch-1", "spoofed"),
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request("/api/takode/sessions", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });
    expect(allowed.status).toBe(200);
    const json = await allowed.json();
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(3);

    const workerAllowed = await app.request("/api/takode/sessions", {
      method: "GET",
      headers: authHeaders("worker-2", "tok-2"),
    });
    expect(workerAllowed.status).toBe(200);
    const workerJson = await workerAllowed.json();
    expect(Array.isArray(workerJson)).toBe(true);
    expect(workerJson).toHaveLength(3);
  });

  it("returns cached takode worktree rows in heavy repo mode without scheduling git refreshes", async () => {
    const defaultSettings = vi.mocked(settingsManager.getSettings).getMockImplementation()?.() as ReturnType<
      typeof settingsManager.getSettings
    >;
    vi.mocked(settingsManager.getSettings).mockReturnValueOnce({
      ...defaultSettings,
      heavyRepoModeEnabled: true,
    });
    const sessions = setupTakodeSessions();
    sessions["worker-1"].isWorktree = true;
    sessions["worker-1"].archived = false;
    const bridgeSession = {
      state: {
        session_id: "worker-1",
        is_worktree: true,
        git_branch: "jiayi-wt-9869",
        total_lines_added: 777,
        total_lines_removed: 55,
      },
      isGenerating: false,
    };
    bridge.getSession.mockImplementation((id: string) => (id === "worker-1" ? bridgeSession : null));

    const res = await app.request("/api/takode/sessions", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.find((s: any) => s.sessionId === "worker-1")).toMatchObject({
      sessionId: "worker-1",
      totalLinesAdded: 777,
      totalLinesRemoved: 55,
    });
    await Promise.resolve();
    expect(bridge.refreshWorktreeGitStateForSnapshot).not.toHaveBeenCalled();
  });

  it("refreshes takode worktree rows before returning when heavy repo mode is disabled", async () => {
    const sessions = setupTakodeSessions();
    sessions["worker-1"].isWorktree = true;
    sessions["worker-1"].archived = false;
    const bridgeSession = {
      state: {
        session_id: "worker-1",
        is_worktree: true,
        git_branch: "jiayi-wt-9869",
        total_lines_added: 777,
        total_lines_removed: 55,
      },
      isGenerating: false,
    };
    bridge.getSession.mockImplementation((id: string) => (id === "worker-1" ? bridgeSession : null));
    bridge.refreshWorktreeGitStateForSnapshot.mockImplementation(async () => {
      bridgeSession.state.total_lines_added = 0;
      bridgeSession.state.total_lines_removed = 0;
      return bridgeSession.state as any;
    });

    const res = await app.request("/api/takode/sessions", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.find((s: any) => s.sessionId === "worker-1")).toMatchObject({
      sessionId: "worker-1",
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    });
    expect(bridge.refreshWorktreeGitStateForSnapshot).toHaveBeenCalledWith("worker-1", {
      broadcastUpdate: true,
      notifyPoller: true,
    });
  });

  it("includes pendingTimerCount in takode session snapshots", async () => {
    // Verifies the list snapshot carries timer counts from the timer manager so
    // takode list can render state without extra per-session requests.
    setupTakodeSessions();
    timerManager.listTimers.mockImplementation((sessionId: string) =>
      sessionId === "worker-1" ? [{ id: "t1" }, { id: "t2" }] : [],
    );

    const res = await app.request("/api/takode/sessions", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.find((s: any) => s.sessionId === "worker-1")).toMatchObject({
      sessionId: "worker-1",
      pendingTimerCount: 2,
    });
    expect(json.find((s: any) => s.sessionId === "worker-2")).toMatchObject({
      sessionId: "worker-2",
      pendingTimerCount: 0,
    });
  });

  it("enforces authenticated orchestrator identity for herd and unherd", async () => {
    setupTakodeSessions();
    launcher.herdSessions.mockReturnValue({ herded: ["worker-1"], notFound: [], conflicts: [], leaders: [] });
    launcher.unherdSession.mockReturnValue(true);

    const denied = await app.request("/api/sessions/orch-1/herd", {
      method: "POST",
      headers: authHeaders("orch-1", "spoofed"),
      body: JSON.stringify({ workerIds: ["worker-1"] }),
    });
    expect(denied.status).toBe(403);
    expect(launcher.herdSessions).not.toHaveBeenCalled();

    const herdOk = await app.request("/api/sessions/orch-1/herd", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ workerIds: ["worker-1"] }),
    });
    expect(herdOk.status).toBe(200);
    expect(launcher.herdSessions).toHaveBeenCalledWith("orch-1", ["worker-1"]);

    const unherdOk = await app.request("/api/sessions/orch-1/herd/worker-1", {
      method: "DELETE",
      headers: authHeaders("orch-1", "tok-1"),
    });
    expect(unherdOk.status).toBe(200);
    expect(launcher.unherdSession).toHaveBeenCalledWith("orch-1", "worker-1");
  });

  it("passes force through herd requests and returns reassignment details", async () => {
    // Takode herd should return a stable response shape and preserve the
    // explicit force signal instead of silently upgrading ordinary herd requests.
    setupTakodeSessions();
    launcher.herdSessions.mockReturnValue({
      herded: ["worker-1"],
      notFound: [],
      conflicts: [],
      reassigned: [{ id: "worker-1", fromLeader: "orch-9" }],
      leaders: [],
    });

    const res = await app.request("/api/sessions/orch-1/herd", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ workerIds: ["worker-1"], force: true }),
    });

    expect(res.status).toBe(200);
    expect(launcher.herdSessions).toHaveBeenCalledWith("orch-1", ["worker-1"], { force: true });
    await expect(res.json()).resolves.toMatchObject({
      herded: ["worker-1"],
      reassigned: [{ id: "worker-1", fromLeader: "orch-9" }],
    });
  });

  it("allows the browser UI to herd a worker through the local herd-to route", async () => {
    // The web UI cannot call Takode-authenticated routes, so it uses a local
    // browser-safe herd endpoint that still preserves herd semantics.
    setupTakodeSessions();
    launcher.herdSessions.mockReturnValue({
      herded: ["worker-2"],
      notFound: [],
      conflicts: [],
      reassigned: [],
      leaders: [],
    });

    const res = await app.request("/api/sessions/worker-2/herd-to", {
      method: "POST",
      body: JSON.stringify({ leaderSessionId: "orch-1" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.herdSessions).toHaveBeenCalledWith("orch-1", ["worker-2"], undefined);
    await expect(res.json()).resolves.toMatchObject({
      herded: ["worker-2"],
      conflicts: [],
      reassigned: [],
      leaders: [],
    });
  });

  it("preserves repoRoot metadata when interrupting a herded session", async () => {
    const sessions = setupTakodeSessions();
    sessions["worker-1"].cwd = "/repo/web";
    sessions["worker-1"].repoRoot = undefined;
    bridge.getSession.mockReturnValue({
      id: "worker-1",
      state: { repo_root: "/repo", cwd: "/repo/web" },
      messageHistory: [],
    });

    const res = await app.request("/api/sessions/worker-1/interrupt", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ callerSessionId: "orch-1" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.routeExternalInterrupt).toHaveBeenCalledWith(expect.objectContaining({ id: "worker-1" }), "leader");
    expect(launcher.kill).not.toHaveBeenCalled();
    expect(sessions["worker-1"].repoRoot).toBe("/repo");
  });

  it("creates bridge session and interrupts when worker session is not loaded", async () => {
    const sessions = setupTakodeSessions();
    sessions["worker-1"].backendType = "codex";
    sessions["worker-1"].repoRoot = "/repo";
    bridge.getSession.mockReturnValue(null);
    bridge.getOrCreateSession.mockReturnValue({
      id: "worker-1",
      backendType: "codex",
      messageHistory: [],
      state: { cwd: "/repo/w1" },
    });

    const res = await app.request("/api/sessions/worker-1/interrupt", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ callerSessionId: "orch-1" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.getOrCreateSession).toHaveBeenCalledWith("worker-1", "codex");
    expect(bridge.routeExternalInterrupt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "worker-1", backendType: "codex" }),
      "leader",
    );
    expect(launcher.kill).not.toHaveBeenCalled();
  });

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
    // notifyUser should not be called when summary is missing
    expect(bridge.notifyUser).not.toHaveBeenCalled();
  });

  it("passes summary string through to notifyUser", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/notify", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ category: "needs-input", summary: "Need decision on auth approach" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.notifyUser).toHaveBeenCalledWith("orch-1", "needs-input", "Need decision on auth approach");
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
    expect(bridge.notifyUser).not.toHaveBeenCalled();
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

  // ── Notification Inbox ────────────────────────────────────────────

  // Tests that GET /sessions/:id/notifications returns the notification list
  it("returns notification list via GET /sessions/:id/notifications", async () => {
    setupTakodeSessions();
    const mockNotifs = [{ id: "n-1", category: "review", timestamp: 1000, messageId: "mock-msg-5", done: false }];
    bridge.getNotifications.mockReturnValue(mockNotifs);

    const res = await app.request("/api/sessions/orch-1/notifications");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(mockNotifs);
    expect(bridge.getNotifications).toHaveBeenCalledWith("orch-1");
  });

  // Tests that POST .../notifications/:notifId/done toggles done state
  it("marks notification as done via POST", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/notifications/n-1/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });

    expect(res.status).toBe(200);
    expect(bridge.markNotificationDone).toHaveBeenCalledWith("orch-1", "n-1", true);
  });

  // Tests that mark-done defaults to true when body.done is omitted
  it("mark-done defaults to true when done field is omitted", async () => {
    setupTakodeSessions();

    const res = await app.request("/api/sessions/orch-1/notifications/n-1/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(bridge.markNotificationDone).toHaveBeenCalledWith("orch-1", "n-1", true);
  });

  // Tests that mark-done returns 404 for unknown notification
  it("returns 404 for unknown notification ID", async () => {
    setupTakodeSessions();
    bridge.markNotificationDone.mockReturnValue(false);

    const res = await app.request("/api/sessions/orch-1/notifications/n-999/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });

    expect(res.status).toBe(404);
  });

  it("marks all notifications done via POST", async () => {
    setupTakodeSessions();
    bridge.markAllNotificationsDone.mockReturnValue(3);

    const res = await app.request("/api/sessions/orch-1/notifications/done-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 3 });
    expect(bridge.markAllNotificationsDone).toHaveBeenCalledWith("orch-1", true);
  });

  it("includes active needs-input notifications in takode pending output", async () => {
    setupTakodeSessions();
    bridge.getSession.mockReturnValue({
      pendingPermissions: new Map(),
      notifications: [
        { id: "n-1", category: "needs-input", summary: "Need decision on rollout", timestamp: 1000, messageId: "asst-1", done: false },
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
          msg_index: 0,
          messageId: "asst-1",
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
        { id: "n-1", category: "needs-input", summary: "Need decision on rollout", timestamp: 1000, messageId: "asst-1", done: false },
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
    expect(bridge.injectUserMessage).toHaveBeenCalledWith("worker-1", "Use the staged rollout.", {
      sessionId: "orch-1",
      sessionLabel: "#7",
    });
    expect(bridge.markNotificationDone).toHaveBeenCalledWith("worker-1", "n-1", true);
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
            input: { questions: [{ question: "Which rollout?", options: [{ label: "Staged" }, { label: "Immediate" }] }] },
          },
        ],
      ]),
      notifications: [
        { id: "n-1", category: "needs-input", summary: "Need decision on logging", timestamp: 1100, messageId: "asst-2", done: false },
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
            input: { questions: [{ question: "Which rollout?", options: [{ label: "Staged" }, { label: "Immediate" }] }] },
          },
        ],
        [
          "req-target",
          {
            request_id: "req-target",
            tool_name: "AskUserQuestion",
            timestamp: 1100,
            input: { questions: [{ question: "Which logger?", options: [{ label: "Structured" }, { label: "Plain" }] }] },
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
    bridge.getBoard.mockReturnValue([
      { questId: "q-1", worker: "worker-1", workerNum: 11, status: "IMPLEMENTING", createdAt: 1, updatedAt: 1 },
      { questId: "q-2", worker: "worker-2", workerNum: 22, status: "PLANNING", createdAt: 2, updatedAt: 2 },
    ]);
    bridge.getBoardQueueWarnings.mockReturnValue([]);
    bridge.getBoardWorkerSlotUsage.mockReturnValue({ used: 2, limit: 5 });

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
      workerSlotUsage: { used: 2, limit: 5 },
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

  it("prefers launcher permissionMode over bridge default in takode info", async () => {
    const sessions = setupTakodeSessions();
    sessions["worker-1"].backendType = "codex";
    sessions["worker-1"].permissionMode = "bypassPermissions";
    sessions["worker-1"].askPermission = false;
    bridge.getAllSessions.mockReturnValue([
      {
        session_id: "worker-1",
        permissionMode: "default",
        uiMode: "agent",
        git_default_branch: "main",
      },
    ]);
    bridge.isBackendConnected.mockReturnValue(false);
    bridge.isSessionBusy.mockReturnValue(false);

    const res = await app.request("/api/sessions/worker-1/info", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.permissionMode).toBe("bypassPermissions");
    expect(json.askPermission).toBe(false);
  });

  it("includes pendingTimerCount in takode info", async () => {
    // Verifies the detailed info endpoint exposes the pending timer count used
    // by takode info alongside other session metadata.
    setupTakodeSessions();
    timerManager.listTimers.mockImplementation((sessionId: string) => (sessionId === "worker-1" ? [{ id: "t9" }] : []));

    const res = await app.request("/api/sessions/worker-1/info", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pendingTimerCount).toBe(1);
  });

  it("includes pendingTimerCount in takode message views", async () => {
    // Verifies the shared message-view payload carries timer counts for the
    // default peek path, which both CLI state surfaces and tests rely on.
    setupTakodeSessions();
    timerManager.listTimers.mockImplementation((sessionId: string) => (sessionId === "worker-1" ? [{ id: "t2" }] : []));
    bridge.getMessageHistory.mockReturnValue([]);

    const res = await app.request("/api/sessions/worker-1/messages", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pendingTimerCount).toBe(1);
  });

  it("includes pendingTimerCount in takode scan message views", async () => {
    // Verifies the scan=turns branch preserves timer counts too, so takode scan
    // cannot regress independently from the default message-view path.
    setupTakodeSessions();
    timerManager.listTimers.mockImplementation((sessionId: string) => (sessionId === "worker-1" ? [{ id: "t4" }] : []));
    bridge.getMessageHistory.mockReturnValue([]);

    const res = await app.request("/api/sessions/worker-1/messages?scan=turns&fromTurn=0&turnCount=1", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pendingTimerCount).toBe(1);
  });

  it("supports takode scan zero-count metadata probes without crashing", async () => {
    // The CLI probes scan=turns with turnCount=0 to learn totalTurns before it
    // requests the real page. That metadata-only request must return cleanly.
    setupTakodeSessions();
    bridge.getMessageHistory.mockReturnValue([
      {
        type: "user_message",
        content: "first turn",
        timestamp: 1_000,
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "working" }] },
        timestamp: 1_100,
      },
      {
        type: "result",
        duration_ms: 250,
        is_error: false,
        timestamp: 1_350,
      },
    ]);

    const res = await app.request("/api/sessions/worker-1/messages?scan=turns&fromTurn=0&turnCount=0", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mode: "turn_scan",
      totalTurns: 1,
      totalMessages: 3,
      from: 0,
      count: 0,
      turns: [],
    });
  });

  it("returns all active timers for the browser timers view", async () => {
    // Verifies the scheduled page can load every live timer in one request,
    // grouped with enough session metadata to navigate back into each session.
    launcher.listSessions.mockReturnValue([
      { sessionId: "worker-1", state: "connected", cwd: "/repo/a", backendType: "claude", name: "Build Fixer" },
      { sessionId: "worker-2", state: "starting", cwd: "/repo/b", backendType: "codex", name: "Docs Pass" },
      { sessionId: "worker-3", state: "connected", cwd: "/repo/c", backendType: "claude", name: "No Timers" },
    ]);
    launcher.getSessionNum.mockImplementation((sessionId: string) =>
      sessionId === "worker-1" ? 12 : sessionId === "worker-2" ? 18 : undefined,
    );
    bridge.getAllSessions.mockReturnValue([
      { session_id: "worker-1", git_branch: "fix/build", backend_type: "claude" },
      { session_id: "worker-2", git_branch: "docs/timers", backend_type: "codex" },
    ]);
    bridge.getSession.mockImplementation((sessionId: string) =>
      sessionId === "worker-1" ? ({ isGenerating: true } as any) : null,
    );
    bridge.isBackendConnected.mockImplementation((sessionId: string) => sessionId !== "worker-2");
    timerManager.listTimers.mockImplementation((sessionId: string) => {
      if (sessionId === "worker-1") {
        return [
          {
            id: "t2",
            sessionId,
            title: "Second timer",
            description: "later",
            type: "delay",
            originalSpec: "30m",
            nextFireAt: 1_700_000_300_000,
            createdAt: 1_700_000_000_000,
            fireCount: 0,
          },
          {
            id: "t1",
            sessionId,
            title: "First timer",
            description: "soonest in worker-1",
            type: "delay",
            originalSpec: "5m",
            nextFireAt: 1_700_000_100_000,
            createdAt: 1_700_000_000_000,
            fireCount: 0,
          },
        ];
      }
      if (sessionId === "worker-2") {
        return [
          {
            id: "t9",
            sessionId,
            title: "Disconnected timer",
            description: "still visible",
            type: "recurring",
            originalSpec: "10m",
            nextFireAt: 1_700_000_200_000,
            intervalMs: 600_000,
            createdAt: 1_700_000_000_000,
            fireCount: 4,
          },
        ];
      }
      return [];
    });
    vi.mocked(sessionNames.getAllNames).mockReturnValue({
      "worker-1": "Build Fixer",
      "worker-2": "Docs Pass",
      "worker-3": "No Timers",
    });

    const res = await app.request("/api/timers/active", { method: "GET" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        sessionId: "worker-1",
        sessionNum: 12,
        name: "Build Fixer",
        backendType: "claude",
        state: "running",
        cliConnected: true,
        cwd: "/repo/a",
        gitBranch: "fix/build",
        timers: [
          expect.objectContaining({ id: "t1", nextFireAt: 1_700_000_100_000 }),
          expect.objectContaining({ id: "t2", nextFireAt: 1_700_000_300_000 }),
        ],
      },
      {
        sessionId: "worker-2",
        sessionNum: 18,
        name: "Docs Pass",
        backendType: "codex",
        state: "starting",
        cliConnected: false,
        cwd: "/repo/b",
        gitBranch: "docs/timers",
        timers: [expect.objectContaining({ id: "t9", nextFireAt: 1_700_000_200_000 })],
      },
    ]);
  });

  it("returns session timers via takode auth", async () => {
    // Verifies the dedicated timer inspection endpoint stays protected by Takode
    // auth while returning the raw timer details needed by takode timers.
    setupTakodeSessions();
    timerManager.listTimers.mockReturnValue([
      {
        id: "t1",
        sessionId: "worker-1",
        title: "Check build health",
        description: "Inspect the latest failing shard if the build is red.",
        type: "delay",
        originalSpec: "30m",
        nextFireAt: 1_700_000_000_000,
        createdAt: 1_699_999_900_000,
        fireCount: 0,
      },
    ]);

    const res = await app.request("/api/sessions/worker-1/timers", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      timers: [
        {
          id: "t1",
          sessionId: "worker-1",
          title: "Check build health",
          description: "Inspect the latest failing shard if the build is red.",
          type: "delay",
          originalSpec: "30m",
          nextFireAt: 1_700_000_000_000,
          createdAt: 1_699_999_900_000,
          fireCount: 0,
        },
      ],
    });
  });

  it("creates session timers via takode auth with title and description", async () => {
    // Verifies the timer creation route forwards the new title/description payload
    // shape and returns the server-created timer object.
    setupTakodeSessions();
    timerManager.createTimer.mockResolvedValue({
      id: "t7",
      sessionId: "worker-1",
      title: "Refresh context",
      description: "Summarize blockers added since the last run.",
      type: "recurring",
      originalSpec: "10m",
      nextFireAt: 1_700_000_000_000,
      intervalMs: 600_000,
      createdAt: 1_699_999_900_000,
      fireCount: 0,
    });

    const res = await app.request("/api/sessions/worker-1/timers", {
      method: "POST",
      headers: { ...authHeaders("orch-1", "tok-1"), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Refresh context",
        description: "Summarize blockers added since the last run.",
        every: "10m",
      }),
    });

    expect(res.status).toBe(201);
    expect(timerManager.createTimer).toHaveBeenCalledWith("worker-1", {
      title: "Refresh context",
      description: "Summarize blockers added since the last run.",
      every: "10m",
    });
    expect(await res.json()).toEqual({
      timer: {
        id: "t7",
        sessionId: "worker-1",
        title: "Refresh context",
        description: "Summarize blockers added since the last run.",
        type: "recurring",
        originalSpec: "10m",
        nextFireAt: 1_700_000_000_000,
        intervalMs: 600_000,
        createdAt: 1_699_999_900_000,
        fireCount: 0,
      },
    });
  });

  it("preserves pendingTimerCount when session enrichment falls back after an error", async () => {
    // Regression: an unrelated enrichment failure should not zero out the timer
    // indicator in takode list for that session.
    setupTakodeSessions();
    timerManager.listTimers.mockImplementation((sessionId: string) => (sessionId === "worker-1" ? [{ id: "t7" }] : []));
    bridge.getSession.mockImplementation((sessionId: string) => {
      if (sessionId === "worker-1") {
        throw new Error("bridge read failed");
      }
      return null;
    });

    const res = await app.request("/api/takode/sessions", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.find((s: any) => s.sessionId === "worker-1")).toMatchObject({
      sessionId: "worker-1",
      pendingTimerCount: 1,
    });
  });

  it("removes deprecated takode watch endpoint", async () => {
    setupTakodeSessions();
    const res = await app.request("/api/events/stream?sessions=worker-1&timeout=1", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });
    expect(res.status).toBe(404);
    expect(bridge.subscribeTakodeEvents).not.toHaveBeenCalled();
  });

  // ─── Branch management via Takode routes ────────────────────────────

  it("PATCH /api/sessions/:id/diff-base sets the diff base via takode auth", async () => {
    setupTakodeSessions();
    bridge.setDiffBaseBranch.mockReturnValue(true);

    const res = await app.request("/api/sessions/worker-1/diff-base", {
      method: "PATCH",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ branch: "origin/main" }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Uses the browser sessions route (mounted first), which returns snake_case
    expect(json).toEqual({ ok: true, diff_base_branch: "origin/main" });
    expect(bridge.setDiffBaseBranch).toHaveBeenCalledWith("worker-1", "origin/main");
  });

  it("PATCH /api/sessions/:id/diff-base returns 404 for unknown session", async () => {
    setupTakodeSessions();
    bridge.setDiffBaseBranch.mockReturnValue(false);

    const res = await app.request("/api/sessions/nonexistent/diff-base", {
      method: "PATCH",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ branch: "main" }),
    });

    expect(res.status).toBe(404);
  });

  it("POST /api/sessions/:id/refresh-branch triggers git refresh and returns branch info", async () => {
    setupTakodeSessions();
    // Mock the bridge session with git state
    bridge.getSession.mockReturnValue({
      state: {
        git_branch: "feature/auth",
        git_default_branch: "origin/jiayi",
        diff_base_branch: "origin/jiayi",
        git_ahead: 2,
        git_behind: 0,
      },
    });
    bridge.refreshGitInfoPublic.mockResolvedValue(true);

    const res = await app.request("/api/sessions/worker-1/refresh-branch", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      gitBranch: "feature/auth",
      gitDefaultBranch: "origin/jiayi",
      diffBaseBranch: "origin/jiayi",
      gitAhead: 2,
      gitBehind: 0,
    });
    expect(bridge.refreshGitInfoPublic).toHaveBeenCalledWith("worker-1", {
      broadcastUpdate: true,
      notifyPoller: true,
      force: true,
    });
  });

  it("POST /api/sessions/:id/refresh-branch returns 404 for unknown session", async () => {
    setupTakodeSessions();
    bridge.getSession.mockReturnValue(null);

    const res = await app.request("/api/sessions/nonexistent/refresh-branch", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(404);
  });

  it("takode info endpoint includes diffBaseBranch in response", async () => {
    const sessions = setupTakodeSessions();
    bridge.getAllSessions.mockReturnValue([
      {
        session_id: "worker-1",
        git_branch: "feature/x",
        git_default_branch: "origin/jiayi",
        diff_base_branch: "origin/main",
      },
    ]);
    bridge.isBackendConnected.mockReturnValue(true);
    bridge.isSessionBusy.mockReturnValue(false);

    const res = await app.request("/api/sessions/worker-1/info", {
      method: "GET",
      headers: authHeaders("orch-1", "tok-1"),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.gitBranch).toBe("feature/x");
    expect(json.gitDefaultBranch).toBe("origin/jiayi");
    expect(json.diffBaseBranch).toBe("origin/main");
  });
});
