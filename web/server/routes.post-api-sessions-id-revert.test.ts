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
      backendType: sessionInfo.backendType,
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

  it("clears stale Claude replay state so reverted input cannot be resent after relaunch", async () => {
    const { mockSession } = setupRevertSession();
    mockSession.pendingMessages = [JSON.stringify({ type: "user_message", content: "stale queued follow-up" })];
    mockSession.lastOutboundUserNdjson = JSON.stringify({ type: "user_message", content: "stale in-flight prompt" });
    mockSession.assistantAccumulator = new Map([["asst-msg-2", { contentBlockIds: new Set(["tool-1"]) }]]);
    mockSession.userMessageIdsThisTurn = [2];
    mockSession.queuedTurnStarts = 1;
    mockSession.queuedTurnReasons = ["follow_up"];
    mockSession.queuedTurnUserMessageIds = [[2]];
    mockSession.queuedTurnInterruptSources = ["user"];
    mockSession.interruptedDuringTurn = true;
    mockSession.interruptSourceDuringTurn = "user";
    mockSession.isGenerating = true;
    mockSession.generationStartedAt = 123;
    mockSession.disconnectWasGenerating = true;
    mockSession.toolStartTimes = new Map([["tool-1", 123]]);
    mockSession.toolProgressOutput = new Map([["tool-1", "running"]]);

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(200);
    expect(mockSession.pendingMessages).toEqual([]);
    expect(mockSession.lastOutboundUserNdjson).toBeNull();
    expect(mockSession.assistantAccumulator.size).toBe(0);
    expect(mockSession.userMessageIdsThisTurn).toEqual([]);
    expect(mockSession.queuedTurnStarts).toBe(0);
    expect(mockSession.queuedTurnReasons).toEqual([]);
    expect(mockSession.queuedTurnUserMessageIds).toEqual([]);
    expect(mockSession.queuedTurnInterruptSources).toEqual([]);
    expect(mockSession.interruptedDuringTurn).toBe(false);
    expect(mockSession.interruptSourceDuringTurn).toBeNull();
    expect(mockSession.isGenerating).toBe(false);
    expect(mockSession.generationStartedAt).toBeNull();
    expect(mockSession.disconnectWasGenerating).toBe(false);
    expect(mockSession.toolStartTimes.size).toBe(0);
    expect(mockSession.toolProgressOutput.size).toBe(0);
    expect(mockSession.dropReplayHistoryAfterRevert).toBe(true);
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
