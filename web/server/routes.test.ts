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
  // exec mock: callback-based, delegates to execSync for consistent test behavior
  const execMock = vi.fn((...args: any[]) => {
    const cmd = args[0] as string;
    const callback = typeof args[1] === "function" ? args[1] : args[2];
    try {
      const result = execSyncMock(cmd);
      if (callback) callback(null, { stdout: result ?? "", stderr: "" });
    } catch (err) {
      if (callback) callback(err, { stdout: "", stderr: "" });
    }
  });
  return { execSync: execSyncMock, exec: execMock };
});

const mockResolveBinary = vi.hoisted(() => vi.fn((_name: string) => null as string | null));
const mockExpandTilde = vi.hoisted(() => vi.fn((p: string) => p)); // pass-through by default
vi.mock("./path-resolver.js", () => ({
  resolveBinary: mockResolveBinary,
  expandTilde: mockExpandTilde,
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
  gitFetch: vi.fn(() => ({ success: true, output: "" })),
  gitFetchAsync: vi.fn(async () => ({ success: true, output: "" })),
  gitPull: vi.fn(() => ({ success: true, output: "" })),
  gitPullAsync: vi.fn(async () => ({ success: true, output: "" })),
  checkoutBranch: vi.fn(),
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
  _resetForTest: vi.fn(),
}));

vi.mock("./session-order.js", () => ({
  getAllOrder: vi.fn(async () => ({})),
  setAllOrder: vi.fn(async () => {}),
  _resetForTest: vi.fn(),
  _flushForTest: vi.fn(async () => {}),
}));

vi.mock("./group-order.js", () => ({
  getAllOrder: vi.fn(async () => []),
  setAllOrder: vi.fn(async () => {}),
  _resetForTest: vi.fn(),
  _flushForTest: vi.fn(async () => {}),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn(() => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: "", pushoverApiToken: "", pushoverDelaySeconds: 30, pushoverEnabled: true, pushoverBaseUrl: "",
    claudeBinary: "", codexBinary: "",
    maxKeepAlive: 0,
    autoApprovalEnabled: false, autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
    namerConfig: { backend: "claude" },
    autoNamerEnabled: true,
    transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
    updatedAt: 0,
  })),
  updateSettings: vi.fn((patch) => ({
    serverName: "",
    serverId: "",
    pushoverUserKey: patch.pushoverUserKey ?? "",
    pushoverApiToken: patch.pushoverApiToken ?? "",
    pushoverDelaySeconds: patch.pushoverDelaySeconds ?? 30,
    pushoverEnabled: patch.pushoverEnabled ?? true,
    pushoverBaseUrl: patch.pushoverBaseUrl ?? "",
    claudeBinary: patch.claudeBinary ?? "",
    codexBinary: patch.codexBinary ?? "",
    maxKeepAlive: patch.maxKeepAlive ?? 0,
    autoApprovalEnabled: patch.autoApprovalEnabled ?? false,
    autoApprovalModel: patch.autoApprovalModel ?? "haiku",
    autoApprovalMaxConcurrency: patch.autoApprovalMaxConcurrency ?? 4,
    autoApprovalTimeoutSeconds: patch.autoApprovalTimeoutSeconds ?? 45,
    namerConfig: patch.namerConfig ?? { backend: "claude" },
    autoNamerEnabled: patch.autoNamerEnabled ?? true,
    transcriptionConfig: patch.transcriptionConfig ?? { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
    editorConfig: patch.editorConfig ?? { editor: "none" },
    updatedAt: Date.now(),
  })),
  getServerName: vi.fn(() => ""),
  setServerName: vi.fn(),
  getServerId: vi.fn(() => "test-server-id"),
}));

const mockGetUsageLimits = vi.hoisted(() => vi.fn());
vi.mock("./usage-limits.js", () => ({
  getUsageLimits: mockGetUsageLimits,
}));

import { Hono } from "hono";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createRoutes } from "./routes.js";
import * as envManager from "./env-manager.js";
import * as gitUtils from "./git-utils.js";
import * as questStore from "./quest-store.js";
import * as sessionNames from "./session-names.js";
import * as sessionOrderStore from "./session-order.js";
import * as groupOrderStore from "./group-order.js";
import * as settingsManager from "./settings-manager.js";
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
    injectOrchestratorGuardrails: vi.fn(async () => {}),
    getPort: vi.fn(() => 3456),
    verifySessionAuthToken: vi.fn(() => true),
    herdSessions: vi.fn(() => ({ herded: [], notFound: [], conflicts: [] })),
    unherdSession: vi.fn(() => false),
    getHerdedSessions: vi.fn(() => []),
    // resolveSessionId: pass-through for exact UUIDs (used by resolveId helper in routes)
    resolveSessionId: vi.fn((id: string) => id),
    getSessionNum: vi.fn(() => undefined),
  } as any;
}

function createMockBridge() {
  return {
    closeSession: vi.fn(),
    getSession: vi.fn(() => null),
    getOrCreateSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getLastUserMessage: vi.fn(() => undefined),
    isBackendConnected: vi.fn(() => false),
    getCodexRateLimits: vi.fn(() => null),
    markContainerized: vi.fn(),
    markWorktree: vi.fn(),
    setInitialCwd: vi.fn(),
    setDiffBaseBranch: vi.fn(() => true),
    setInitialAskPermission: vi.fn(),
    markResumedFromExternal: vi.fn(),
    broadcastSessionUpdate: vi.fn(),
    broadcastToSession: vi.fn(),
    broadcastGlobal: vi.fn(),
    broadcastNameUpdate: vi.fn(),
    updateSessionOrder: vi.fn((_groupKey: string, _orderedIds: string[]) => ({})),
    broadcastSessionOrderUpdate: vi.fn(),
    updateGroupOrder: vi.fn((_orderedGroupKeys: string[]) => []),
    broadcastGroupOrderUpdate: vi.fn(),
    setSessionClaimedQuest: vi.fn(),
    addTaskEntry: vi.fn(),
    updateQuestTaskEntries: vi.fn(),
    persistSessionSync: vi.fn(),
    getSessionAttentionState: vi.fn(() => null),
    getSessionTaskHistory: vi.fn(() => []),
    getSessionKeywords: vi.fn(() => []),
    getMessageHistory: vi.fn(() => []),
    markSessionRead: vi.fn(() => true),
    markSessionUnread: vi.fn(() => true),
    markAllSessionsRead: vi.fn(),
    injectUserMessage: vi.fn(() => "sent" as const),
    subscribeTakodeEvents: vi.fn(() => () => {}),
    routeExternalPermissionResponse: vi.fn(),
    routeExternalInterrupt: vi.fn(async () => {}),
    isSessionBusy: vi.fn(() => false),
  } as any;
}

function createMockStore() {
  return {
    setArchived: vi.fn(async () => true),
    flushAll: vi.fn(async () => {}),
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

beforeEach(() => {
  vi.clearAllMocks();
  launcher = createMockLauncher();
  bridge = createMockBridge();
  sessionStore = createMockStore();
  tracker = createMockTracker();
  app = new Hono();
  const terminalManager = { getInfo: () => null, spawn: () => "", kill: () => {} } as any;
  app.route("/api", createRoutes(launcher, bridge, sessionStore, tracker, terminalManager));

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
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
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
    expect(gitUtils.gitFetch).toHaveBeenCalledWith("/repo");
    expect(gitUtils.checkoutBranch).not.toHaveBeenCalled();
    expect(gitUtils.gitPull).toHaveBeenCalledWith("/repo");
  });

  it("fetches, checks out selected branch, then pulls before create", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
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
    expect(gitUtils.gitFetch).toHaveBeenCalledWith("/repo");
    expect(gitUtils.checkoutBranch).toHaveBeenCalledWith("/repo", "main");
    expect(gitUtils.gitPull).toHaveBeenCalledWith("/repo");
    expect(vi.mocked(gitUtils.gitFetch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitUtils.checkoutBranch).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(gitUtils.checkoutBranch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gitUtils.gitPull).mock.invocationCallOrder[0],
    );
  });

  it("proceeds with session creation when fetch fails (non-fatal, same as pull)", async () => {
    // git fetch failure should NOT block session creation — the branch may already exist locally.
    // This matches the existing non-fatal behavior for git pull (see next test).
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitFetch).mockReturnValueOnce({
      success: false,
      output: "network error",
    });

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/repo", branch: "main" }),
    });

    expect(res.status).toBe(200);
    expect(gitUtils.gitFetch).toHaveBeenCalledWith("/repo");
    // Pull is still called (fetch failure doesn't abort the pipeline)
    expect(gitUtils.gitPull).toHaveBeenCalledWith("/repo");
    expect(launcher.launch).toHaveBeenCalled();
  });

  it("proceeds with session creation when pull fails (non-fatal)", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.gitPull).mockReturnValueOnce({
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
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.ensureWorktree).mockReturnValue({
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
    // ensureWorktree should be called with forceNew: true
    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/repo", "feat-branch", {
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
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue({
      repoRoot: "/repo",
      repoName: "my-repo",
      currentBranch: "main",
      defaultBranch: "main",
      isWorktree: false,
    });
    vi.mocked(gitUtils.ensureWorktree).mockReturnValue({
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
    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/repo", "main", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/home/.companion/worktrees/my-repo/main" }),
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
    expect(gitUtils.ensureWorktree).not.toHaveBeenCalled();
    expect(launcher.launch).not.toHaveBeenCalled();
  });

  it("returns 400 when useWorktree is enabled outside a git repository", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValue(null);

    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/not-a-repo", useWorktree: true }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Worktree mode requires a git repository" });
    expect(gitUtils.ensureWorktree).not.toHaveBeenCalled();
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
    expect(buildSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dockerfile.companion-dev"),
      "companion-dev:latest",
    );
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
    const execAsyncSpy = vi.spyOn(containerManager, "execInContainerAsync")
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
    vi.spyOn(containerManager, "execInContainerAsync")
      .mockResolvedValueOnce({ exitCode: 1, output: "npm ERR! missing script" });

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
        sessionId: "s1", state: "running", cwd: "/a", name: "Fix auth bug", sessionNum: null,
        gitBranch: "", gitAhead: 0, gitBehind: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
        lastMessagePreview: "", cliConnected: false, taskHistory: [], keywords: [],
        claimedQuestId: null, claimedQuestStatus: null,
      },
      {
        sessionId: "s2", state: "stopped", cwd: "/b", sessionNum: null,
        gitBranch: "", gitAhead: 0, gitBehind: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
        lastMessagePreview: "", cliConnected: false, taskHistory: [], keywords: [],
        claimedQuestId: null, claimedQuestStatus: null,
      },
    ]);
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

  it("uses cached bridge ahead/behind counts instead of running git per-session", async () => {
    // Previously this test verified that the route ran `git rev-list` per worktree
    // session. That was removed (caused 800-1300ms latency on NFS). Now the route
    // uses cached bridge values from refreshGitInfo (updated on CLI connect).
    const sessions = [
      { sessionId: "s1", state: "running", cwd: "/wt/repo", isWorktree: true, branch: "jiayi" },
    ];
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
        return [
          { type: "user_message", content: "find me from archived history", timestamp: 1234, id: "u-1" },
        ];
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
      { sessionId: "s-archived", state: "exited", cwd: "/archived", createdAt: 3, archived: true, lastActivityAt: 1000 },
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
        return [{ type: "user_message", content: "contains needle in archived message", timestamp: 11111, id: "u-arch" }];
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
});

describe("POST /api/sessions/:id/archive", () => {
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
    const envs = [
      { name: "Dev", slug: "dev", variables: { A: "1" }, createdAt: 1, updatedAt: 1 },
    ];
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
    const json = await res.json() as { ok: boolean; timestamp: number };
    expect(json.ok).toBe(true);
    expect(json.timestamp).toBeGreaterThanOrEqual(before);
    expect(json.timestamp).toBeLessThanOrEqual(after);
  });
});

// ─── Settings ────────────────────────────────────────────────────────────────

describe("GET /api/settings", () => {
  it("returns settings with pushover status", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "u123", pushoverApiToken: "t456", pushoverDelaySeconds: 60, pushoverEnabled: true, pushoverBaseUrl: "http://localhost:3456",
      claudeBinary: "", codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false, autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
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
      pushoverDelaySeconds: 60,
      pushoverBaseUrl: "http://localhost:3456",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false,
      autoApprovalModel: "haiku",
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
      restartSupported: expect.any(Boolean),
      logFile: expect.any(Object), // null or string depending on logger init
    });
  });

  it("reports pushover as not configured when keys are empty", async () => {
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "", pushoverApiToken: "", pushoverDelaySeconds: 30, pushoverEnabled: true, pushoverBaseUrl: "",
      claudeBinary: "", codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false, autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
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
      pushoverDelaySeconds: 30,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false,
      autoApprovalModel: "haiku",
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
      restartSupported: expect.any(Boolean),
      logFile: expect.any(Object), // null or string depending on logger init
    });
  });

  it("includes serverName when configured", async () => {
    vi.mocked(settingsManager.getServerName).mockReturnValue("My Frontend");
    vi.mocked(settingsManager.getSettings).mockReturnValue({
      serverName: "My Frontend",
      serverId: "",
      pushoverUserKey: "", pushoverApiToken: "", pushoverDelaySeconds: 30, pushoverEnabled: true, pushoverBaseUrl: "",
      claudeBinary: "", codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false, autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
      updatedAt: 0,
    });

    const res = await app.request("/api/settings", { method: "GET" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.serverName).toBe("My Frontend");

    vi.mocked(settingsManager.getServerName).mockReturnValue("");
  });
});

describe("PUT /api/settings", () => {
  it("updates pushover settings", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "u123", pushoverApiToken: "t456", pushoverDelaySeconds: 60, pushoverEnabled: true, pushoverBaseUrl: "",
      claudeBinary: "", codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false, autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
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
      pushoverBaseUrl: undefined,
      claudeBinary: undefined,
      codexBinary: undefined,
      maxKeepAlive: undefined,
      autoApprovalEnabled: undefined,
      autoApprovalModel: undefined,
      namerConfig: undefined,
      autoNamerEnabled: undefined,
      transcriptionConfig: undefined,
      editorConfig: undefined,
    });
    const json = await res.json();
    expect(json).toEqual({
      serverName: "",
      serverId: "test-server-id",
      pushoverConfigured: true,
      pushoverEnabled: true,
      pushoverDelaySeconds: 60,
      pushoverBaseUrl: "",
      claudeBinary: "",
      codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false,
      autoApprovalModel: "haiku",
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
    });
  });

  it("trims pushover keys", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "",
      serverId: "",
      pushoverUserKey: "trimmed", pushoverApiToken: "", pushoverDelaySeconds: 30, pushoverEnabled: true, pushoverBaseUrl: "",
      claudeBinary: "", codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false, autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
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
      pushoverBaseUrl: undefined,
      claudeBinary: undefined,
      codexBinary: undefined,
      maxKeepAlive: undefined,
      autoApprovalEnabled: undefined,
      autoApprovalModel: undefined,
      namerConfig: undefined,
      autoNamerEnabled: undefined,
      transcriptionConfig: undefined,
      editorConfig: undefined,
    });
  });

  it("persists serverName via setServerName when provided", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "My Backend",
      serverId: "",
      pushoverUserKey: "", pushoverApiToken: "", pushoverDelaySeconds: 30, pushoverEnabled: true, pushoverBaseUrl: "",
      claudeBinary: "", codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false, autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
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
      autoApprovalEnabled: undefined,
      autoApprovalModel: undefined,
      namerConfig: undefined,
      autoNamerEnabled: undefined,
      transcriptionConfig: undefined,
      editorConfig: undefined,
    });
  });

  it("updates claudeBinary setting", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "", serverId: "",
      pushoverUserKey: "", pushoverApiToken: "", pushoverDelaySeconds: 30, pushoverEnabled: true, pushoverBaseUrl: "",
      claudeBinary: "/usr/local/bin/claude", codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false, autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
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

  it("updates maxKeepAlive setting", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "", serverId: "",
      pushoverUserKey: "", pushoverApiToken: "", pushoverDelaySeconds: 30, pushoverEnabled: true, pushoverBaseUrl: "",
      claudeBinary: "", codexBinary: "",
      maxKeepAlive: 5,
      autoApprovalEnabled: false, autoApprovalModel: "haiku",
    autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "none" },
      updatedAt: Date.now(),
    });

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxKeepAlive: 5 }),
    });

    expect(res.status).toBe(200);
    expect(settingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ maxKeepAlive: 5 }),
    );
    const json = await res.json();
    expect(json.maxKeepAlive).toBe(5);
  });

  it("updates editorConfig setting", async () => {
    vi.mocked(settingsManager.updateSettings).mockReturnValue({
      serverName: "", serverId: "",
      pushoverUserKey: "", pushoverApiToken: "", pushoverDelaySeconds: 30, pushoverEnabled: true, pushoverBaseUrl: "",
      claudeBinary: "", codexBinary: "",
      maxKeepAlive: 0,
      autoApprovalEnabled: false, autoApprovalModel: "haiku",
      autoApprovalMaxConcurrency: 4, autoApprovalTimeoutSeconds: 45,
      namerConfig: { backend: "claude" },
      autoNamerEnabled: true,
      transcriptionConfig: { apiKey: "", baseUrl: "https://api.openai.com/v1", enhancementEnabled: true, enhancementModel: "gpt-5-mini" },
      editorConfig: { editor: "cursor" },
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

  it("returns 400 for invalid editorConfig.editor", async () => {
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ editorConfig: { editor: "vim" } }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'editorConfig.editor must be "vscode", "cursor", or "none"' });
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
    vi.mocked(gitUtils.getRepoInfoAsync).mockResolvedValue(info);

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
    vi.mocked(gitUtils.ensureWorktree).mockReturnValue(result);
    const res = await app.request("/api/git/worktree", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoRoot: "/repo", branch: "feat", baseBranch: "main" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(result);
    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/repo", "feat", {
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

describe("PATCH /api/sessions/order", () => {
  it("updates session order, persists it, and broadcasts to browsers", async () => {
    vi.mocked(bridge.updateSessionOrder).mockReturnValueOnce({
      "/repo-a": ["s2", "s1"],
    });

    const res = await app.request("/api/sessions/order", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupKey: "/repo-a", orderedIds: ["s2", "s1"] }),
    });

    expect(res.status).toBe(200);
    expect(bridge.updateSessionOrder).toHaveBeenCalledWith("/repo-a", ["s2", "s1"]);
    expect(sessionOrderStore.setAllOrder).toHaveBeenCalledWith({ "/repo-a": ["s2", "s1"] });
    expect(bridge.broadcastSessionOrderUpdate).toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      ok: true,
      sessionOrder: { "/repo-a": ["s2", "s1"] },
    });
  });

  it("returns 400 when groupKey is missing", async () => {
    const res = await app.request("/api/sessions/order", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds: ["s1"] }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "groupKey is required" });
  });

  it("returns 400 when orderedIds is not an array", async () => {
    const res = await app.request("/api/sessions/order", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupKey: "/repo-a", orderedIds: "s1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "orderedIds must be an array" });
  });
});

describe("PATCH /api/sessions/groups/order", () => {
  it("updates group order, persists it, and broadcasts to browsers", async () => {
    vi.mocked(bridge.updateGroupOrder).mockReturnValueOnce(["/repo-b", "/repo-a"]);

    const res = await app.request("/api/sessions/groups/order", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedGroupKeys: ["/repo-b", "/repo-a"] }),
    });

    expect(res.status).toBe(200);
    expect(bridge.updateGroupOrder).toHaveBeenCalledWith(["/repo-b", "/repo-a"]);
    expect(groupOrderStore.setAllOrder).toHaveBeenCalledWith(["/repo-b", "/repo-a"]);
    expect(bridge.broadcastGroupOrderUpdate).toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      ok: true,
      groupOrder: ["/repo-b", "/repo-a"],
    });
  });

  it("returns 400 when orderedGroupKeys is not an array", async () => {
    const res = await app.request("/api/sessions/groups/order", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedGroupKeys: "/repo-a" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "orderedGroupKeys must be an array" });
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
      if (cmd.includes("git diff main")) return diffOutput;
      throw new Error(`Unmocked: ${cmd}`);
    });

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=main", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(json.path).toContain("file.ts");
    expect(json.baseBranch).toBe("main");
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining("git diff main"),
    );
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
      if (cmd.includes("git diff main")) return "";
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
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining("git diff --no-index -- /dev/null"),
    );
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
      if (cmd.includes("git diff main")) return diffOutput;
      if (cmd.includes("git show main:\"file.ts\"")) return "const value = 1;\n";
      throw new Error(`Unmocked: ${cmd}`);
    });

    vi.mocked(stat).mockResolvedValueOnce({ size: 100 } as any);
    vi.mocked(readFile).mockResolvedValueOnce("const value = 2;\n" as any);

    const res = await app.request(
      "/api/fs/diff?path=/repo/file.ts&base=main&includeContents=1",
      { method: "GET" },
    );

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
      if (cmd.includes("git diff develop")) return diffOutput;
      throw new Error(`Unmocked: ${cmd}`);
    });

    const res = await app.request("/api/fs/diff?path=/repo/file.ts&base=develop", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.diff).toBe(diffOutput);
    expect(json.baseBranch).toBe("develop");
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining("git diff develop"),
    );
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
      if (cmd.includes("git diff --numstat jiayi --")) {
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
});

// ─── Backends ─────────────────────────────────────────────────────────────────

describe("GET /api/backends", () => {
  it("returns both backends with availability status", async () => {
    // resolveBinary returns a path for all binaries
    mockResolveBinary
      .mockReturnValueOnce("/usr/bin/claude")   // claude
      .mockReturnValueOnce("/usr/bin/claude")   // claude-sdk (same binary)
      .mockReturnValueOnce("/usr/bin/codex");   // codex

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      { id: "claude", name: "Claude Code", available: true },
      { id: "claude-sdk", name: "Claude SDK", available: true },
      { id: "codex", name: "Codex", available: true },
    ]);
  });

  it("marks backends as unavailable when binary is not found", async () => {
    // resolveBinary returns null for all
    mockResolveBinary
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null);

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      { id: "claude", name: "Claude Code", available: false },
      { id: "claude-sdk", name: "Claude SDK", available: false },
      { id: "codex", name: "Codex", available: false },
    ]);
  });

  it("handles mixed availability", async () => {
    mockResolveBinary
      .mockReturnValueOnce("/usr/bin/claude") // claude found
      .mockReturnValueOnce("/usr/bin/claude") // claude-sdk found (same binary)
      .mockReturnValueOnce(null); // codex not found

    const res = await app.request("/api/backends", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].available).toBe(true);   // claude
    expect(json[1].available).toBe(true);   // claude-sdk
    expect(json[2].available).toBe(false);  // codex
  });
});

describe("GET /api/backends/:id/models", () => {
  it("returns codex models from cache file sorted by priority", async () => {
    const cacheContent = JSON.stringify({
      models: [
        { slug: "gpt-5.3-codex-spark", display_name: "gpt-5.3-codex-spark", description: "Fast model", visibility: "list", priority: 10 },
        { slug: "gpt-5.4", display_name: "gpt-5.4", description: "Frontier model", visibility: "list", priority: 0 },
        { slug: "gpt-5-codex", display_name: "gpt-5-codex", description: "Old model", visibility: "hide", priority: 8 },
      ],
    });
    vi.mocked(access).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue(cacheContent);

    const res = await app.request("/api/backends/codex/models", { method: "GET" });

    expect(res.status).toBe(200);
    const json = await res.json();
    // Should only include visible models, sorted by priority
    expect(json).toEqual([
      { value: "gpt-5.4", label: "gpt-5.4", description: "Frontier model" },
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
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.4", backendType: "codex" }),
    );
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
  });

  it("defaults to claude backend when not specified", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test" }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ backendType: "claude" }),
    );
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
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "plan" }),
    );
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
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "bypassPermissions" }),
    );
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
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "plan" }),
    );
  });

  it("uses 'suggest' permission mode for codex sessions when askPermission is true", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "codex", askPermission: true }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "suggest" }),
    );
    expect(bridge.setInitialAskPermission).toHaveBeenCalledWith("session-1", true, "agent");
  });

  it("uses 'bypassPermissions' permission mode for codex sessions when askPermission is false", async () => {
    const res = await app.request("/api/sessions/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", backend: "codex", askPermission: false }),
    });

    expect(res.status).toBe(200);
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "bypassPermissions" }),
    );
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
    vi.mocked(gitUtils.getRepoInfo).mockReturnValueOnce({
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
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

    // Should include git operations
    expect(steps).toContain("fetching_git");
    expect(steps).toContain("checkout_branch");
    expect(steps).toContain("pulling_git");
    expect(steps).toContain("launching_cli");
  });

  it("emits worktree progress events when useWorktree is set", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValueOnce({
      repoRoot: "/test",
      currentBranch: "main",
      defaultBranch: "main",
    } as any);
    vi.mocked(gitUtils.ensureWorktree).mockReturnValueOnce({
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
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

    expect(steps).toContain("creating_worktree");
    expect(steps).toContain("launching_cli");
    // Should NOT have fetch/checkout/pull since it uses worktree
    expect(steps).not.toContain("fetching_git");
  });

  it("uses current branch for worktree create-stream when branch is omitted", async () => {
    vi.mocked(gitUtils.getRepoInfo).mockReturnValueOnce({
      repoRoot: "/test",
      currentBranch: "main",
      defaultBranch: "main",
    } as any);
    vi.mocked(gitUtils.ensureWorktree).mockReturnValueOnce({
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
    expect(gitUtils.ensureWorktree).toHaveBeenCalledWith("/test", "main", {
      baseBranch: "main",
      createBranch: undefined,
      forceNew: true,
    });
    expect(launcher.launch).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/test-wt-main" }),
    );
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
    vi.mocked(gitUtils.getRepoInfo).mockReturnValueOnce(null);

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
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

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
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

    // Should have pulling_image step
    expect(steps).toContain("pulling_image");
    expect(pullSpy).toHaveBeenCalledWith(
      expect.stringContaining("docker.io"),
      "the-companion:latest",
    );

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
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

    // Should have both pulling_image and building_image steps
    expect(steps).toContain("pulling_image");
    expect(steps).toContain("building_image");
    expect(buildSpy).toHaveBeenCalledWith(
      expect.stringContaining("Dockerfile.the-companion"),
      "the-companion:latest",
    );
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
    vi.spyOn(containerManager, "execInContainerAsync")
      .mockResolvedValueOnce({ exitCode: 0, output: "ok" });

    const res = await app.request("/api/sessions/create-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/test", envSlug: "with-init" }),
    });

    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    const steps = events
      .filter((e) => e.event === "progress")
      .map((e) => JSON.parse(e.data).step);

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
    vi.spyOn(containerManager, "execInContainerAsync")
      .mockResolvedValueOnce({ exitCode: 1, output: "npm ERR! missing script" });

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

    const mockSession = {
      messageHistory: [
        { type: "user_message", id: "user-msg-1", content: "Hello" },
        { type: "assistant", message: { id: "asst-msg-1", content: [{ type: "text", text: "Hi" }], model: "claude" }, uuid: "cli-uuid-1", parent_tool_use_id: null },
        { type: "user_message", id: "user-msg-2", content: "Do something" },
        { type: "assistant", message: { id: "asst-msg-2", content: [{ type: "text", text: "Done" }], model: "claude" }, uuid: "cli-uuid-2", parent_tool_use_id: null },
      ],
      pendingPermissions: new Map(),
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

  // Returns 400 for Codex sessions since revert relies on Claude CLI --resume-session-at.
  it("returns 400 for Codex sessions", async () => {
    setupRevertSession({ backendType: "codex" });

    const res = await app.request("/api/sessions/session-1/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: "user-msg-2" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Codex");
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
    expect(bridge.broadcastGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "quest_list_updated" }),
    );
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
    launcher.getSession.mockImplementation((sid: string) => (
      sid === "session-2"
        ? { sessionId: "session-2", state: "running", cwd: "/test", archived: false }
        : undefined
    ));
    launcher.verifySessionAuthToken.mockImplementation((sid: string, token: string) => sid === "session-2" && token === "tok-2");

    const res = await app.request("/api/quests/q-1/claim", {
      method: "POST",
      headers: companionAuthHeaders("session-2", "tok-2"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(questStore.claimQuest).toHaveBeenCalledWith(
      "q-1",
      "session-2",
      expect.any(Object),
    );
  });

  it("returns 403 when body sessionId mismatches authenticated caller", async () => {
    launcher.getSession.mockImplementation((sid: string) => (
      sid === "session-2"
        ? { sessionId: "session-2", state: "running", cwd: "/test", archived: false }
        : undefined
    ));
    launcher.verifySessionAuthToken.mockImplementation((sid: string, token: string) => sid === "session-2" && token === "tok-2");

    const res = await app.request("/api/quests/q-1/claim", {
      method: "POST",
      headers: companionAuthHeaders("session-2", "tok-2"),
      body: JSON.stringify({ sessionId: "session-3" }),
    });

    expect(res.status).toBe(403);
    expect(questStore.claimQuest).not.toHaveBeenCalled();
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
    launcher.getSession.mockImplementation((sid: string) => (
      sid === "session-1"
        ? { sessionId: "session-1", state: "running", cwd: "/test", archived: false }
        : undefined
    ));
    launcher.verifySessionAuthToken.mockImplementation((sid: string, token: string) => sid === "session-1" && token === "tok-1");
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
    launcher.getSession.mockImplementation((sid: string) => (
      sid === "session-1"
        ? { sessionId: "session-1", state: "running", cwd: "/test", archived: false }
        : undefined
    ));
    launcher.verifySessionAuthToken.mockImplementation((sid: string, token: string) => sid === "session-1" && token === "tok-1");

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
    const feedback = (patchSpy.mock.calls[0][1] as { feedback: Array<{ author: string; authorSessionId?: string; text: string }> }).feedback;
    expect(feedback[feedback.length - 1]).toMatchObject({
      author: "agent",
      authorSessionId: "session-1",
      text: "Addressed",
    });
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
    expect(questStore.transitionQuest).toHaveBeenCalledWith(
      "q-1",
      expect.objectContaining({ status: "done" }),
    );
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
    expect(bridge.broadcastGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "quest_list_updated" }),
    );
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
    expect(bridge.broadcastGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "quest_list_updated" }),
    );
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
    expect(bridge.broadcastGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "quest_list_updated" }),
    );
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
    launcher.verifySessionAuthToken.mockImplementation((id: string, token: string) => id === "orch-1" && token === "tok-1");
    return sessions;
  }

  it("denies spoofed token and allows authenticated orchestrator list scope", async () => {
    setupTakodeSessions();

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

  it("preserves repoRoot metadata when stopping a herded session", async () => {
    const sessions = setupTakodeSessions();
    sessions["worker-1"].cwd = "/repo/web";
    sessions["worker-1"].repoRoot = undefined;
    bridge.getSession.mockReturnValue({
      id: "worker-1",
      state: { repo_root: "/repo", cwd: "/repo/web" },
      messageHistory: [],
    });

    const res = await app.request("/api/sessions/worker-1/stop", {
      method: "POST",
      headers: authHeaders("orch-1", "tok-1"),
      body: JSON.stringify({ callerSessionId: "orch-1" }),
    });

    expect(res.status).toBe(200);
    expect(bridge.routeExternalInterrupt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "worker-1" }),
      "leader",
    );
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

    const res = await app.request("/api/sessions/worker-1/stop", {
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
    expect(bridge.injectUserMessage).toHaveBeenCalledWith(
      "worker-1",
      "ship it",
      { sessionId: "orch-1" },
    );
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
});
