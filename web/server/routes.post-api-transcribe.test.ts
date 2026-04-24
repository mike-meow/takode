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

  it("records pre-stream upload time separately from STT timing for raw dictation uploads", async () => {
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

    const res = await app.request("/api/transcribe?backend=openai&mode=dictation", {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Companion-Audio-Filename": "recording.wav",
      },
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(transcriptionEnhancer.getTranscriptionLogIndex()[0]).toEqual(
      expect.objectContaining({
        uploadDurationMs: expect.any(Number),
        sttDurationMs: expect.any(Number),
        rawTranscript: "timed transcript",
      }),
    );

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const outboundForm = init.body as FormData;
    const uploadedFile = outboundForm.get("file");
    expect(uploadedFile).toBeInstanceOf(File);
    expect((uploadedFile as File).type).toBe("audio/wav");
    expect((uploadedFile as File).name).toBe("recording.wav");
  });

  it("emits an early phase ack before stt_complete so the pre-STT state can end before STT finishes", async () => {
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
      new Response(JSON.stringify({ text: "phase-acked transcript" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const form = new FormData();
    form.append("audio", new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "recording.wav", { type: "audio/wav" }));
    form.append("backend", "openai");

    const res = await app.request("/api/transcribe", { method: "POST", body: form });

    expect(res.status).toBe(200);
    const body = await res.text();
    const phaseIndex = body.indexOf("event: phase");
    const resultIndex = body.indexOf("event: result");
    expect(phaseIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(phaseIndex);
    expect(body).toContain('"phase":"transcribing"');
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
    bridge.getSession.mockReturnValue({
      taskHistory: [{ title: "Fix reconnect bug" }],
      messageHistory: [{ type: "user_message", content: "Please rewrite this update" }],
    } as any);

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
    expect(body).toContain("event: phase");
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
