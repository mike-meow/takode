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
import { QUEST_TLDR_WARNING_HEADER } from "./quest-tldr.js";
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

function companionJsonAuthHeaders(sessionId: string, token: string): Record<string, string> {
  return {
    "x-companion-session-id": sessionId,
    "x-companion-auth-token": token,
    "Content-Type": "application/json",
  };
}

function mockValidCompanionAuth(): void {
  launcher.getSession.mockImplementation((sid: string) =>
    sid === "session-1" ? { sessionId: "session-1", state: "running", cwd: "/test", archived: false } : undefined,
  );
  launcher.verifySessionAuthToken.mockImplementation(
    (sid: string, token: string) => sid === "session-1" && token === "tok-1",
  );
}

describe("REST quest description TLDR warnings", () => {
  it("sets warning headers for authenticated long description create, patch, and transition writes", async () => {
    mockValidCompanionAuth();
    const longDescription = "Long quest description. ".repeat(80).trim();
    vi.spyOn(questStore, "createQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      status: "idea",
      description: longDescription,
      createdAt: Date.now(),
    } as any);

    const createRes = await app.request("/api/quests", {
      method: "POST",
      headers: companionJsonAuthHeaders("session-1", "tok-1"),
      body: JSON.stringify({ title: "Quest", description: longDescription }),
    });

    expect(createRes.status).toBe(201);
    expect(createRes.headers.get(QUEST_TLDR_WARNING_HEADER)).toContain("quest description is 1200+ characters");

    vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      status: "refined",
      description: longDescription,
      createdAt: Date.now(),
    } as any);

    const patchRes = await app.request("/api/quests/q-1", {
      method: "PATCH",
      headers: companionJsonAuthHeaders("session-1", "tok-1"),
      body: JSON.stringify({ description: longDescription }),
    });

    expect(patchRes.status).toBe(200);
    expect(patchRes.headers.get(QUEST_TLDR_WARNING_HEADER)).toContain("quest description is 1200+ characters");

    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      status: "idea",
      createdAt: Date.now(),
    } as any);
    vi.spyOn(questStore, "transitionQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 2,
      title: "Quest",
      status: "refined",
      description: longDescription,
      createdAt: Date.now(),
      statusChangedAt: Date.now(),
    } as any);

    const transitionRes = await app.request("/api/quests/q-1/transition", {
      method: "POST",
      headers: companionJsonAuthHeaders("session-1", "tok-1"),
      body: JSON.stringify({ status: "refined", description: longDescription }),
    });

    expect(transitionRes.status).toBe(200);
    expect(transitionRes.headers.get(QUEST_TLDR_WARNING_HEADER)).toContain("quest description is 1200+ characters");
  });

  it("keeps unauthenticated browser-style description writes quiet", async () => {
    const longDescription = "Long quest description. ".repeat(80).trim();
    vi.spyOn(questStore, "createQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      status: "idea",
      description: longDescription,
      createdAt: Date.now(),
    } as any);

    const res = await app.request("/api/quests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Quest", description: longDescription }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get(QUEST_TLDR_WARNING_HEADER)).toBeNull();
  });

  it("does not warn when authenticated description writes include TLDR metadata", async () => {
    mockValidCompanionAuth();
    const longDescription = "Long quest description. ".repeat(80).trim();
    vi.spyOn(questStore, "createQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      status: "idea",
      description: longDescription,
      tldr: "Short quest summary",
      createdAt: Date.now(),
    } as any);

    const res = await app.request("/api/quests", {
      method: "POST",
      headers: companionJsonAuthHeaders("session-1", "tok-1"),
      body: JSON.stringify({ title: "Quest", description: longDescription, tldr: "Short quest summary" }),
    });

    expect(res.status).toBe(201);
    expect(res.headers.get(QUEST_TLDR_WARNING_HEADER)).toBeNull();
  });

  it("warns for authenticated patch and transition description rewrites even when the quest already has TLDR", async () => {
    mockValidCompanionAuth();
    const longDescription = "Replacement quest description. ".repeat(80).trim();
    vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 3,
      title: "Quest",
      status: "refined",
      description: longDescription,
      tldr: "Existing stale TLDR",
      createdAt: Date.now(),
    } as any);

    const patchRes = await app.request("/api/quests/q-1", {
      method: "PATCH",
      headers: companionJsonAuthHeaders("session-1", "tok-1"),
      body: JSON.stringify({ description: longDescription }),
    });

    expect(patchRes.status).toBe(200);
    expect(patchRes.headers.get(QUEST_TLDR_WARNING_HEADER)).toContain("quest description is 1200+ characters");

    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 3,
      title: "Quest",
      status: "refined",
      description: "Previous description",
      tldr: "Existing stale TLDR",
      createdAt: Date.now(),
    } as any);
    vi.spyOn(questStore, "transitionQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 4,
      title: "Quest",
      status: "refined",
      description: longDescription,
      tldr: "Existing stale TLDR",
      createdAt: Date.now(),
      statusChangedAt: Date.now(),
    } as any);

    const transitionRes = await app.request("/api/quests/q-1/transition", {
      method: "POST",
      headers: companionJsonAuthHeaders("session-1", "tok-1"),
      body: JSON.stringify({ status: "refined", description: longDescription }),
    });

    expect(transitionRes.status).toBe(200);
    expect(transitionRes.headers.get(QUEST_TLDR_WARNING_HEADER)).toContain("quest description is 1200+ characters");
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

  it("stores feedback TLDR metadata and warns non-blockingly for long agent feedback without TLDR", async () => {
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
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockImplementationOnce(
      async (_id, patch) =>
        ({
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
          feedback: (patch as any).feedback,
        }) as any,
    );

    const longText = "Long agent handoff. ".repeat(80).trim();
    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: longText, author: "agent", sessionId: "session-1" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(QUEST_TLDR_WARNING_HEADER)).toContain("quest feedback is 1200+ characters");
    const feedback = (patchSpy.mock.calls[0]?.[1] as { feedback: Array<{ text: string; tldr?: string }> }).feedback;
    expect(feedback[0]).toMatchObject({ text: longText });
    expect(feedback[0].tldr).toBeUndefined();

    vi.mocked(questStore.getQuest).mockResolvedValueOnce({
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
    patchSpy.mockImplementationOnce(
      async (_id, patch) =>
        ({
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
          feedback: (patch as any).feedback,
        }) as any,
    );

    const withTldr = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: longText, tldr: "Short handoff summary", author: "agent", sessionId: "session-1" }),
    });

    expect(withTldr.status).toBe(200);
    expect(withTldr.headers.get(QUEST_TLDR_WARNING_HEADER)).toBeNull();
    const feedbackWithTldr = (patchSpy.mock.calls.at(-1)?.[1] as { feedback: Array<{ text: string; tldr?: string }> })
      .feedback;
    expect(feedbackWithTldr[0]).toMatchObject({ text: longText, tldr: "Short handoff summary" });
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
      status: "done",
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
      status: "done",
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
      status: "done",
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
      status: "done",
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

  it("infers phase documentation scope from the quest leader board row", async () => {
    launcher.getSession.mockImplementation((sid: string) =>
      sid === "worker-1" || sid === "leader-1"
        ? { sessionId: sid, state: "running", cwd: "/test", archived: false, isOrchestrator: sid === "leader-1" }
        : undefined,
    );
    launcher.listSessions.mockReturnValue([{ sessionId: "leader-1", isOrchestrator: true }]);
    ensureBridgeSession(bridge, "leader-1", {
      board: new Map([
        [
          "q-1",
          {
            questId: "q-1",
            worker: "worker-1",
            workerNum: 12,
            status: "IMPLEMENTING",
            createdAt: 10,
            updatedAt: 20,
            journey: {
              phaseIds: ["alignment", "explore", "implement", "code-review"],
              activePhaseIndex: 2,
              currentPhaseId: "implement",
            },
          },
        ],
      ]),
      completedBoard: new Map(),
    });
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      createdAt: 1,
      status: "in_progress",
      description: "Ready",
      sessionId: "worker-1",
      claimedAt: 2,
      leaderSessionId: "leader-1",
      feedback: [],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockImplementationOnce(
      async (_id, patch) =>
        ({
          id: "q-1",
          questId: "q-1",
          version: 1,
          title: "Quest",
          createdAt: 1,
          status: "in_progress",
          description: "Ready",
          sessionId: "worker-1",
          claimedAt: 2,
          leaderSessionId: "leader-1",
          feedback: (patch as any).feedback,
          journeyRuns: (patch as any).journeyRuns,
        }) as any,
    );

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Summary: implemented phase docs",
        tldr: "Implemented phase docs",
        author: "agent",
        sessionId: "worker-1",
      }),
    });

    expect(res.status).toBe(200);
    const patch = patchSpy.mock.calls[0]?.[1] as {
      feedback: Array<{ phaseId?: string; phasePosition?: number; tldr?: string; kind?: string }>;
      journeyRuns?: Array<{ runId: string; phaseOccurrences: Array<{ occurrenceId: string }> }>;
    };
    expect(patch.feedback[0]).toMatchObject({
      kind: "phase_summary",
      phaseId: "implement",
      phasePosition: 3,
      tldr: "Implemented phase docs",
    });
    expect(patch.journeyRuns?.[0]?.runId).toBe("board-leader-1-10");
    expect(patch.journeyRuns?.[0]?.phaseOccurrences[2]?.occurrenceId).toBe("board-leader-1-10:p3");
  });

  it("falls back to flat feedback with a warning when inferred board context is missing", async () => {
    launcher.getSession.mockImplementation((sid: string) =>
      sid === "worker-1" ? { sessionId: "worker-1", state: "running", cwd: "/test", archived: false } : undefined,
    );
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      createdAt: 1,
      status: "in_progress",
      description: "Ready",
      sessionId: "worker-1",
      claimedAt: 2,
      leaderSessionId: "leader-1",
      feedback: [],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      createdAt: 1,
      status: "in_progress",
      description: "Ready",
      sessionId: "worker-1",
      claimedAt: 2,
      feedback: [{ author: "agent", text: "Flat fallback", ts: Date.now(), authorSessionId: "worker-1" }],
    } as any);

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Flat fallback", author: "agent", sessionId: "worker-1" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-quest-phase-documentation-warning")).toContain("No active leader board row");
    const feedback = (patchSpy.mock.calls[0]?.[1] as { feedback: Array<{ phaseId?: string }> }).feedback;
    expect(feedback[0]?.phaseId).toBeUndefined();
  });

  it("ignores archived leader board rows during phase inference", async () => {
    launcher.getSession.mockImplementation((sid: string) => {
      if (sid === "worker-1") return { sessionId: "worker-1", state: "running", cwd: "/test", archived: false };
      if (sid === "leader-1")
        return {
          sessionId: "leader-1",
          state: "exited",
          cwd: "/test",
          archived: true,
          isOrchestrator: true,
        };
      return undefined;
    });
    launcher.listSessions.mockReturnValue([{ sessionId: "leader-1", isOrchestrator: true, archived: true }]);
    ensureBridgeSession(bridge, "leader-1", {
      board: new Map([
        [
          "q-1",
          {
            questId: "q-1",
            worker: "worker-1",
            status: "IMPLEMENTING",
            createdAt: 10,
            updatedAt: 20,
            journey: {
              phaseIds: ["alignment", "implement", "code-review"],
              activePhaseIndex: 1,
              currentPhaseId: "implement",
            },
          },
        ],
      ]),
      completedBoard: new Map(),
    });
    vi.spyOn(questStore, "getQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      createdAt: 1,
      status: "in_progress",
      description: "Ready",
      sessionId: "worker-1",
      claimedAt: 2,
      leaderSessionId: "leader-1",
      feedback: [],
    } as any);
    const patchSpy = vi.spyOn(questStore, "patchQuest").mockResolvedValueOnce({
      id: "q-1",
      questId: "q-1",
      version: 1,
      title: "Quest",
      createdAt: 1,
      status: "in_progress",
      description: "Ready",
      sessionId: "worker-1",
      claimedAt: 2,
      feedback: [{ author: "agent", text: "Archived fallback", ts: Date.now(), authorSessionId: "worker-1" }],
    } as any);

    const res = await app.request("/api/quests/q-1/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Archived fallback", author: "agent", sessionId: "worker-1" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-quest-phase-documentation-warning")).toContain("No active leader board row");
    const patch = patchSpy.mock.calls[0]?.[1] as {
      feedback: Array<{ phaseId?: string }>;
      journeyRuns?: unknown[];
    };
    expect(patch.feedback[0]?.phaseId).toBeUndefined();
    expect(patch.journeyRuns).toBeUndefined();
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
      status: "done",
      description: "Needs verification",
      sessionId: "session-1",
      claimedAt: Date.now(),
      verificationItems: [],
      feedback: [
        { author: "human", text: "Please verify spacing", ts: Date.now() - 2000, addressed: false },
        { author: "agent", text: "Addressed: tightened spacing", ts: Date.now() - 1500, authorSessionId: "session-1" },
        {
          author: "agent",
          text: "Summary: initial summary",
          tldr: "Initial summary TLDR",
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
      status: "done",
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
    const [questId, patchArg, optionsArg] = patchSpy.mock.calls[0] ?? [];
    expect(questId).toBe("q-1");
    expect(patchArg).toEqual(
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
    expect(optionsArg).toEqual(
      expect.objectContaining({
        current: expect.objectContaining({ questId: "q-1", id: "q-1-v3" }),
      }),
    );
    const feedback = (patchSpy.mock.calls[0]?.[1] as { feedback: Array<{ text: string; tldr?: string }> }).feedback;
    expect(feedback).toHaveLength(3);
    expect(feedback[2]?.tldr).toBeUndefined();
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
      status: "done",
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
      status: "done",
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
