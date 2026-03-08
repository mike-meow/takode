import { vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: mockExecSync, exec: mockExec }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { WsBridge, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { HerdEventDispatcher } from "./herd-event-dispatcher.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

function createMockSocket(data: SocketData) {
  return {
    data,
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as any;
}

function makeCliSocket(sessionId: string) {
  return createMockSocket({ kind: "cli", sessionId });
}

function makeBrowserSocket(sessionId: string) {
  return createMockSocket({ kind: "browser", sessionId });
}

function makeCodexAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;
  let onTurnStartFailedCb: ((msg: any) => void) | undefined;
  let onTurnStartedCb: ((turnId: string) => void) | undefined;
  let currentTurnId: string | null = null;

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => { onBrowserMessageCb = cb; }),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => { onSessionMetaCb = cb; }),
    onDisconnect: vi.fn((cb: () => void) => { onDisconnectCb = cb; }),
    onInitError: vi.fn((cb: (error: string) => void) => { onInitErrorCb = cb; }),
    onTurnStartFailed: vi.fn((cb: (msg: any) => void) => { onTurnStartFailedCb = cb; }),
    onTurnStarted: vi.fn((cb: (turnId: string) => void) => { onTurnStartedCb = cb; }),
    sendBrowserMessage: vi.fn(() => true),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    getCurrentTurnId: vi.fn(() => currentTurnId),
    emitBrowserMessage: (msg: any) => onBrowserMessageCb?.(msg),
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: (turnId?: string | null) => {
      currentTurnId = turnId === undefined ? currentTurnId : turnId;
      onDisconnectCb?.();
    },
    emitInitError: (error: string) => onInitErrorCb?.(error),
    emitTurnStartFailed: (msg: any) => onTurnStartFailedCb?.(msg),
    emitTurnStarted: (turnId: string) => {
      currentTurnId = turnId;
      onTurnStartedCb?.(turnId);
    },
  };
}

function emitCodexSessionReady(
  adapter: ReturnType<typeof makeCodexAdapterMock>,
  overrides: Record<string, unknown> = {},
) {
  adapter.emitSessionMeta({
    cliSessionId: "thread-ready",
    model: "gpt-5.3-codex",
    cwd: "/repo",
    ...overrides,
  });
}

function getPendingCodexTurn(session: { pendingCodexTurns?: unknown[] }) {
  return (session.pendingCodexTurns?.[0] ?? null) as any;
}

function makeClaudeSdkAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => { onBrowserMessageCb = cb; }),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => { onSessionMetaCb = cb; }),
    onDisconnect: vi.fn((cb: () => void) => { onDisconnectCb = cb; }),
    onInitError: vi.fn((cb: (error: string) => void) => { onInitErrorCb = cb; }),
    sendBrowserMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    emitBrowserMessage: (msg: any) => onBrowserMessageCb?.(msg),
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: () => onDisconnectCb?.(),
    emitInitError: (error: string) => onInitErrorCb?.(error),
  };
}

let bridge: WsBridge;
let tempDir: string;
let store: SessionStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "bridge-test-"));
  store = new SessionStore(tempDir);
  bridge = new WsBridge();
  bridge.setStore(store);
  bridge.resetTrafficStats();
  mockExecSync.mockReset();
  mockExec.mockReset();
  // Default: mockExec delegates to mockExecSync so tests that set up
  // mockExecSync automatically work for async computeDiffStatsAsync too.
  mockExec.mockImplementation((cmd: string, opts: any, cb?: Function) => {
    const callback = typeof opts === "function" ? opts : cb;
    try {
      const result = mockExecSync(cmd);
      if (callback) callback(null, { stdout: result ?? "", stderr: "" });
    } catch (err) {
      if (callback) callback(err, { stdout: "", stderr: "" });
    }
  });
});

describe("traffic accounting", () => {
  it("tracks browser fanout using successful sends only", () => {
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");

    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.resetTrafficStats();

    browser2.send.mockImplementation(() => {
      throw new Error("socket failed");
    });

    bridge.broadcastSessionUpdate("s1", { cwd: "/repo" });

    const snapshot = bridge.getTrafficStatsSnapshot();
    const bucket = snapshot.buckets.find(
      (entry) =>
        entry.channel === "browser"
        && entry.direction === "out"
        && entry.messageType === "session_update",
    );

    expect(bucket).toBeDefined();
    expect(bucket?.messages).toBe(1);
    expect(bucket?.fanoutSum).toBe(1);
    expect(bucket?.maxFanout).toBe(1);
    expect(bucket?.wireBytes).toBe(bucket?.payloadBytes);
  });

  it("tracks browser inbound messages by type", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.resetTrafficStats();

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const snapshot = bridge.getTrafficStatsSnapshot();
    const bucket = snapshot.buckets.find(
      (entry) =>
        entry.channel === "browser"
        && entry.direction === "in"
        && entry.messageType === "session_subscribe",
    );

    expect(bucket).toMatchObject({
      messages: 1,
      fanoutSum: 1,
      maxFanout: 1,
    });
    expect(snapshot.sessions.s1?.totals.messages).toBeGreaterThan(0);
  });

  it("tracks CLI inbound NDJSON and outbound sends", async () => {
    const browser = makeBrowserSocket("s1");
    const cli = makeCliSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.resetTrafficStats();

    bridge.handleCLIMessage(cli, `${JSON.stringify({ type: "keep_alive" })}\n`);
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "hi" }));
    await Promise.resolve();

    const snapshot = bridge.getTrafficStatsSnapshot();
    const cliIn = snapshot.buckets.find(
      (entry) =>
        entry.channel === "cli"
        && entry.direction === "in"
        && entry.messageType === "keep_alive",
    );
    const cliOut = snapshot.buckets.find(
      (entry) =>
        entry.channel === "cli"
        && entry.direction === "out"
        && entry.messageType === "user",
    );

    expect(cliIn?.messages).toBe(1);
    expect(cliOut?.messages).toBe(1);
    expect(cliOut?.wireBytes).toBe(cliOut?.payloadBytes);
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Helper: build a system.init NDJSON string ────────────────────────────────

function makeInitMsg(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "cli-123",
    model: "claude-sonnet-4-5-20250929",
    cwd: "/test",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "1.0",
    mcp_servers: [],
    agents: [],
    slash_commands: [],
    skills: [],
    output_style: "normal",
    uuid: "uuid-1",
    apiKeySource: "env",
    ...overrides,
  });
}

// ─── Session management ──────────────────────────────────────────────────────

describe("Session management", () => {
  it("getOrCreateSession: creates new session with default state", () => {
    const session = bridge.getOrCreateSession("s1");
    expect(session.id).toBe("s1");
    expect(session.state.session_id).toBe("s1");
    expect(session.state.model).toBe("");
    expect(session.state.cwd).toBe("");
    expect(session.state.tools).toEqual([]);
    expect(session.state.permissionMode).toBe("default");
    expect(session.state.total_cost_usd).toBe(0);
    expect(session.state.num_turns).toBe(0);
    expect(session.state.context_used_percent).toBe(0);
    expect(session.state.is_compacting).toBe(false);
    expect(session.state.git_branch).toBe("");
    expect(session.state.is_worktree).toBe(false);
    expect(session.state.is_containerized).toBe(false);
    expect(session.state.repo_root).toBe("");
    expect(session.state.git_ahead).toBe(0);
    expect(session.state.git_behind).toBe(0);
    expect(session.backendSocket).toBeNull();
    expect(session.browserSockets.size).toBe(0);
    expect(session.pendingPermissions.size).toBe(0);
    expect(session.messageHistory).toEqual([]);
    expect(session.pendingMessages).toEqual([]);
  });

  it("getOrCreateSession: returns existing session on second call", () => {
    const first = bridge.getOrCreateSession("s1");
    first.state.model = "modified";
    const second = bridge.getOrCreateSession("s1");
    expect(second).toBe(first);
    expect(second.state.model).toBe("modified");
  });

  it("getOrCreateSession: sets backendType when creating a new session", () => {
    const session = bridge.getOrCreateSession("s1", "codex");
    expect(session.backendType).toBe("codex");
    expect(session.state.backend_type).toBe("codex");
  });

  it("getOrCreateSession: does NOT overwrite backendType when called without explicit type", () => {
    // Simulate: attachCodexAdapter creates session as "codex"
    const session = bridge.getOrCreateSession("s1", "codex");
    expect(session.backendType).toBe("codex");
    expect(session.state.backend_type).toBe("codex");

    // Simulate: handleBrowserOpen calls getOrCreateSession without backendType
    const same = bridge.getOrCreateSession("s1");
    expect(same.backendType).toBe("codex");
    expect(same.state.backend_type).toBe("codex");
  });

  it("getOrCreateSession: overwrites backendType when explicitly provided on existing session", () => {
    const session = bridge.getOrCreateSession("s1");
    expect(session.backendType).toBe("claude");

    // Explicit override (e.g. attachCodexAdapter)
    bridge.getOrCreateSession("s1", "codex");
    expect(session.backendType).toBe("codex");
    expect(session.state.backend_type).toBe("codex");
  });

  it("getSession: returns undefined for unknown session", () => {
    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });

  it("getAllSessions: returns all session states", () => {
    bridge.getOrCreateSession("s1");
    bridge.getOrCreateSession("s2");
    bridge.getOrCreateSession("s3");
    const all = bridge.getAllSessions();
    expect(all).toHaveLength(3);
    const ids = all.map((s) => s.session_id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).toContain("s3");
  });

  it("isBackendConnected: returns false without CLI socket", () => {
    bridge.getOrCreateSession("s1");
    expect(bridge.isBackendConnected("s1")).toBe(false);
    expect(bridge.isBackendConnected("nonexistent")).toBe(false);
  });

  it("removeSession: deletes from map and store", () => {
    bridge.getOrCreateSession("s1");
    const removeSpy = vi.spyOn(store, "remove");
    bridge.removeSession("s1");
    expect(bridge.getSession("s1")).toBeUndefined();
    expect(removeSpy).toHaveBeenCalledWith("s1");
  });

  it("setSessionClaimedQuest: does not rebroadcast unchanged quest state", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.setSessionClaimedQuest("s1", { id: "q-1", title: "Quest One", status: "in_progress" });
    bridge.setSessionClaimedQuest("s1", { id: "q-1", title: "Quest One", status: "in_progress" });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvents = calls.filter((c: any) => c.type === "session_quest_claimed");
    expect(questEvents).toHaveLength(1);
  });

  it("closeSession: closes all sockets and removes session", () => {
    const cli = makeCliSocket("s1");
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");

    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");

    bridge.closeSession("s1");

    expect(cli.close).toHaveBeenCalled();
    expect(browser1.close).toHaveBeenCalled();
    expect(browser2.close).toHaveBeenCalled();
    expect(bridge.getSession("s1")).toBeUndefined();
  });
});

// ─── CLI handlers ────────────────────────────────────────────────────────────

describe("CLI handlers", () => {
  it("handleCLIOpen: sets backendSocket and broadcasts backend_connected", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    // Clear session_init send calls
    browser.send.mockClear();

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.backendSocket).toBe(cli);
    expect(bridge.isBackendConnected("s1")).toBe(true);

    // Should have broadcast backend_connected
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_connected" }));
  });

  it("handleCLIOpen: flushes pending messages immediately", () => {
    // Per the SDK protocol, the first user message triggers system.init,
    // so queued messages must be flushed as soon as the CLI WebSocket connects
    // (not deferred until system.init, which would create a deadlock for
    // slow-starting sessions like Docker containers).
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "hello queued",
    }));

    // CLI not yet connected, message should be queued
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages.length).toBe(1);

    // Now connect CLI — messages should be flushed immediately
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Pending should have been flushed
    expect(session.pendingMessages).toEqual([]);
    // The CLI socket should have received the queued message
    expect(cli.send).toHaveBeenCalled();
    const sentCalls = cli.send.mock.calls.map(([arg]: [string]) => arg);
    const userMsg = sentCalls.find((s: string) => s.includes('"type":"user"'));
    expect(userMsg).toBeDefined();
    const parsed = JSON.parse(userMsg!.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message.content).toBe("hello queued");
  });

  it("handleCLIMessage: system.init does not re-flush already-sent messages", () => {
    // Messages are flushed on CLI connect, so by the time system.init
    // arrives the queue should already be empty.
    mockExecSync.mockImplementation(() => { throw new Error("not a git repo"); });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "hello queued",
    }));

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages.length).toBe(1);

    // Connect CLI — messages flushed immediately
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    expect(session.pendingMessages).toEqual([]);
    const sendCountAfterOpen = cli.send.mock.calls.length;

    // Send system.init — no additional flush should happen
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Verify no additional user messages were sent after system.init
    const newCalls = cli.send.mock.calls.slice(sendCountAfterOpen);
    const userMsgAfterInit = newCalls.find(([arg]: [string]) => arg.includes('"type":"user"'));
    expect(userMsgAfterInit).toBeUndefined();
  });

  it("handleCLIMessage: system.init does not emit turn_end for an in-flight user dispatch", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    browser.send.mockClear();

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // User message marks the session running immediately.
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "hello",
    }));
    expect(bridge.getSession("s1")!.isGenerating).toBe(true);

    // Regression: when system.init arrives before assistant/result output,
    // we should preserve the in-flight turn instead of emitting a fake turn_end.
    bridge.handleCLIMessage(cli, makeInitMsg());

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls).toHaveLength(0);
    expect(bridge.getSession("s1")!.isGenerating).toBe(true);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const idleStatus = calls.find((m: any) => m.type === "status_change" && m.status === "idle");
    expect(idleStatus).toBeUndefined();

    spy.mockRestore();
  });

  it("handleCLIMessage: parses NDJSON and routes system.init", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession("s1")!;
    expect(session.state.model).toBe("claude-sonnet-4-5-20250929");
    expect(session.state.cwd).toBe("/test");

    // Should broadcast session_init to browser
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const initCall = calls.find((c: any) => c.type === "session_init");
    expect(initCall).toBeDefined();
    expect(initCall.session.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("handleCLIMessage: system.init fires onCLISessionIdReceived callback", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const callback = vi.fn();
    bridge.onCLISessionIdReceived(callback);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ session_id: "cli-internal-id" }));

    expect(callback).toHaveBeenCalledWith("s1", "cli-internal-id");
  });

  it("handleCLIMessage: updates state from init (model, cwd, tools, permissionMode)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    bridge.handleCLIMessage(cli, makeInitMsg({
      model: "claude-opus-4-5-20250929",
      cwd: "/workspace",
      tools: ["Bash", "Read", "Edit"],
      permissionMode: "bypassPermissions",
      claude_code_version: "2.0",
      mcp_servers: [{ name: "test-mcp", status: "connected" }],
      agents: ["agent1"],
      slash_commands: ["/commit"],
      skills: ["pdf"],
    }));

    const state = bridge.getSession("s1")!.state;
    expect(state.model).toBe("claude-opus-4-5-20250929");
    expect(state.cwd).toBe("/workspace");
    expect(state.tools).toEqual(["Bash", "Read", "Edit"]);
    expect(state.permissionMode).toBe("bypassPermissions");
    expect(state.claude_code_version).toBe("2.0");
    expect(state.mcp_servers).toEqual([{ name: "test-mcp", status: "connected" }]);
    expect(state.agents).toEqual(["agent1"]);
    expect(state.slash_commands).toEqual(["/commit"]);
    expect(state.skills).toEqual(["pdf"]);
  });

  it("handleCLIMessage: system.init preserves host cwd for containerized sessions", async () => {
    // markContainerized sets the host cwd and is_containerized before CLI connects
    bridge.markContainerized("s1", "/Users/stan/Dev/myproject");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("rev-parse HEAD")) return "head-main\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/Users/stan/Dev/myproject\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // CLI inside the container reports /workspace — should be ignored
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/workspace" }));

    const state = bridge.getSession("s1")!.state;
    expect(state.cwd).toBe("/Users/stan/Dev/myproject");
    expect(state.is_containerized).toBe(true);
    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    await vi.waitFor(() => {
      expect(state.git_branch).toBe("main");
      expect(state.repo_root).toBe("/Users/stan/Dev/myproject");
    });
  });

  it("handleCLIMessage: markWorktree pre-populates repo_root, git_default_branch, and diff_base_branch", async () => {
    // markWorktree sets is_worktree, repo_root, cwd, git_default_branch, and diff_base_branch before CLI connects
    bridge.markWorktree("s1", "/home/user/companion", "/home/user/.companion/worktrees/companion/jiayi-wt-1234", "jiayi");

    const state = bridge.getSession("s1")!.state;
    expect(state.is_worktree).toBe(true);
    expect(state.repo_root).toBe("/home/user/companion");
    expect(state.cwd).toBe("/home/user/.companion/worktrees/companion/jiayi-wt-1234");
    expect(state.git_default_branch).toBe("jiayi");
    // diff_base_branch should be set from defaultBranch at creation
    expect(state.diff_base_branch).toBe("jiayi");

    // After CLI connects, resolveGitInfo runs (fire-and-forget) and should preserve the worktree info
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("rev-parse HEAD")) return "wt-head-1\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      throw new Error("unknown git cmd");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/home/user/.companion/worktrees/companion/jiayi-wt-1234" }));

    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    const stateAfter = bridge.getSession("s1")!.state;
    await vi.waitFor(() => {
      // repo_root should still point to the parent repo, not the worktree
      expect(stateAfter.repo_root).toBe("/home/user/companion");
      expect(stateAfter.is_worktree).toBe(true);
      expect(stateAfter.git_branch).toBe("jiayi-wt-1234");
    });
  });

  it("markWorktree: diffBaseBranch overrides defaultBranch for diff_base_branch", () => {
    // When both defaultBranch and diffBaseBranch are provided,
    // git_default_branch should use defaultBranch while diff_base_branch uses diffBaseBranch
    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main", "jiayi");

    const state = bridge.getSession("s1")!.state;
    expect(state.git_default_branch).toBe("main");
    expect(state.diff_base_branch).toBe("jiayi");
  });

  it("setDiffBaseBranch updates session state, triggers recomputation, and broadcasts", async () => {
    // Mock git commands for the refreshGitInfo + computeDiffStats calls
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("--left-right --count")) return "1\t3\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "10\t5\tfile.ts\n";
      return "";
    });

    // Create a session with a browser connected and a tracked changed file
    bridge.markWorktree("s1", "/home/user/companion", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    // Ensure the session has a CLI socket so refreshGitInfo/recomputeDiffIfDirty don't skip
    (session as any).backendSocket = { send: vi.fn() };
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    browserWs.send.mockClear();

    // Set diff base branch — triggers immediate recomputation
    const result = bridge.setDiffBaseBranch("s1", "feature-branch");
    expect(result).toBe(true);

    // Wait for async diff computation
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(10);
    });

    const state = bridge.getSession("s1")!.state;
    expect(state.diff_base_branch).toBe("feature-branch");
    // Should have recomputed diff stats
    expect(state.total_lines_added).toBe(10);
    expect(state.total_lines_removed).toBe(5);
    // Should have recomputed ahead/behind
    expect(state.git_ahead).toBe(3);
    expect(state.git_behind).toBe(1);

    // Verify broadcasts were sent to the browser
    const calls = (browserWs.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    // Should have a session_update with diff_base_branch
    expect(messages).toContainEqual(expect.objectContaining({
      type: "session_update",
      session: expect.objectContaining({ diff_base_branch: "feature-branch" }),
    }));

    // Non-existent session returns false
    expect(bridge.setDiffBaseBranch("nonexistent", "main")).toBe(false);
  });

  it("handleCLIMessage: system.init resolves git info and sets diff_base_branch via async exec", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/test-branch\n";
      if (cmd.includes("rev-parse HEAD")) return "head-feat-test\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "2\t5\n";
      // gitUtils.resolveDefaultBranch fallback commands
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    const state = bridge.getSession("s1")!.state;
    await vi.waitFor(() => {
      expect(state.git_branch).toBe("feat/test-branch");
      expect(state.repo_root).toBe("/repo");
      expect(state.git_ahead).toBe(5);
      expect(state.git_behind).toBe(2);
      // diff_base_branch should be auto-resolved since not pre-set
      expect(state.diff_base_branch).toBe("main");
      expect(state.git_default_branch).toBe("main");
    });
  });

  it("handleCLIMessage: system.init defaults non-worktree base to upstream tracking ref", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("jiayi@{upstream}")) return "origin/jiayi\n";
      if (cmd.includes("--left-right --count") && cmd.includes("origin/jiayi...HEAD")) return "1\t2\n";
      if (cmd.includes("diff --numstat")) return "";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    const state = bridge.getSession("s1")!.state;
    await vi.waitFor(() => {
      expect(state.git_default_branch).toBe("origin/jiayi");
      expect(state.diff_base_branch).toBe("origin/jiayi");
      expect(state.git_ahead).toBe(2);
      expect(state.git_behind).toBe(1);
    });
  });

  it("handleCLIMessage: system.init migrates legacy non-worktree default base from repo default to upstream", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("jiayi@{upstream}")) return "origin/jiayi\n";
      if (cmd.includes("for-each-ref")) return "jiayi\n";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main\n";
      if (cmd.includes("--left-right --count") && cmd.includes("origin/jiayi...HEAD")) return "0\t3\n";
      if (cmd.includes("diff --numstat")) return "";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "main";
    (session as any).backendSocket = { send: vi.fn() };

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    await vi.waitFor(() => {
      expect(session.state.git_default_branch).toBe("origin/jiayi");
      expect(session.state.diff_base_branch).toBe("origin/jiayi");
      expect(session.state.git_ahead).toBe(3);
      expect(session.state.git_behind).toBe(0);
    });
  });

  it("handleCLIMessage: system.init resolves repo_root via --show-toplevel for standard repo", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("rev-parse HEAD")) return "head-main\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/home/user/myproject\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      // gitUtils.resolveDefaultBranch fallback commands
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/home/user/myproject" }));

    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    const state = bridge.getSession("s1")!.state;
    await vi.waitFor(() => {
      expect(state.repo_root).toBe("/home/user/myproject");
    });
  });

  it("handleCLIMessage: system.status updates compacting and permissionMode", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const statusMsg = JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
      permissionMode: "plan",
      uuid: "uuid-2",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, statusMsg);

    const state = bridge.getSession("s1")!.state;
    expect(state.is_compacting).toBe(true);
    expect(state.permissionMode).toBe("plan");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "compacting" }));
  });

  it("handleCLIClose: nulls backendSocket and broadcasts backend_disconnected", () => {
    vi.useFakeTimers();
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    const session = bridge.getSession("s1")!;
    expect(session.backendSocket).toBeNull();
    expect(bridge.isBackendConnected("s1")).toBe(false);

    // Side-effects are deferred by 15s grace period (CLI token refresh cycle)
    vi.advanceTimersByTime(16_000);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected" }));
    vi.useRealTimers();
  });

  it("handleCLIClose: cancels pending permissions", async () => {
    vi.useFakeTimers();
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Simulate a pending permission request
    const controlReq = JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /" },
        tool_use_id: "tu-1",
      },
    });
    bridge.handleCLIMessage(cli, controlReq);
    await vi.advanceTimersByTimeAsync(0); // flush async handleControlRequest
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    // Side-effects are deferred by 15s grace period
    vi.advanceTimersByTime(16_000);

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const cancelMsg = calls.find((c: any) => c.type === "permission_cancelled");
    expect(cancelMsg).toBeDefined();
    expect(cancelMsg.request_id).toBe("req-1");
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

// ─── Seamless reconnect (5-minute token refresh) ────────────────────────────

describe("Seamless CLI reconnect preserves isGenerating", () => {
  // The CLI disconnects every ~5 minutes for token refresh and reconnects in ~13s.
  // During this cycle, if the CLI was mid-generation, isGenerating must be preserved —
  // clearing it emits a false turn_end takode event while the agent is still working.

  it("preserves isGenerating on seamless reconnect and skips system.init force-clear", () => {
    vi.useFakeTimers();
    const cli1 = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Send system.init to initialize, then send user message to start generation
    bridge.handleCLIMessage(cli1, makeInitMsg());
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Do something",
    }));
    const session = bridge.getSession("s1")!;
    expect(session.isGenerating).toBe(true);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // CLI disconnects (token refresh) — isGenerating preserved (not cleared)
    bridge.handleCLIClose(cli1);
    expect(session.isGenerating).toBe(true); // NOT cleared during grace period
    expect(session.disconnectGraceTimer).not.toBeNull();

    // CLI reconnects within grace period (seamless)
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");
    expect(session.isGenerating).toBe(true); // preserved
    expect(session.seamlessReconnect).toBe(true);
    expect(session.disconnectGraceTimer).toBeNull(); // grace timer cancelled

    // system.init arrives — should NOT force-clear isGenerating
    bridge.handleCLIMessage(cli2, makeInitMsg());
    expect(session.isGenerating).toBe(true); // still generating
    expect(session.seamlessReconnect).toBe(false); // consumed

    // No turn_end should have been emitted during the entire reconnect cycle
    const turnEndCalls = spy.mock.calls.filter(([, event]) => event === "turn_end");
    expect(turnEndCalls).toHaveLength(0);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it("force-clears isGenerating after grace period expires (relaunch)", () => {
    vi.useFakeTimers();
    const cli1 = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Start generation
    bridge.handleCLIMessage(cli1, makeInitMsg());
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Do something",
    }));
    const session = bridge.getSession("s1")!;
    expect(session.isGenerating).toBe(true);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // CLI disconnects and grace period expires (relaunch scenario)
    bridge.handleCLIClose(cli1);
    vi.advanceTimersByTime(16_000); // past 15s grace period

    // runFullDisconnect should have emitted turn_end
    const turnEndCalls = spy.mock.calls.filter(([, event]) => event === "turn_end");
    expect(turnEndCalls).toHaveLength(1);
    expect(turnEndCalls[0]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "system" }),
    );
    expect(session.isGenerating).toBe(false);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it("does not set seamlessReconnect when no grace timer was active", () => {
    vi.useFakeTimers();
    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    bridge.handleCLIMessage(cli1, makeInitMsg());

    const session = bridge.getSession("s1")!;
    expect(session.isGenerating).toBe(false);

    // CLI disconnects while idle, grace period expires
    bridge.handleCLIClose(cli1);
    vi.advanceTimersByTime(16_000);

    // New CLI connects — no grace timer was active
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");
    expect(session.seamlessReconnect).toBe(false); // NOT a seamless reconnect

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

// ─── Browser handlers ────────────────────────────────────────────────────────

describe("Browser handlers", () => {
  it("handleBrowserOpen: adds to set and sends session_init", () => {
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");

    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.browserSockets.has(browser)).toBe(true);

    expect(browser.send).toHaveBeenCalled();
    const firstMsg = JSON.parse(browser.send.mock.calls[0][0]);
    expect(firstMsg.type).toBe("session_init");
    expect(firstMsg.session.session_id).toBe("s1");
  });

  it("handleBrowserOpen: sends server-authoritative session order snapshot", () => {
    bridge.setSessionOrderState({
      "/repo-a": ["s2", "s1"],
      "/repo-b": ["s3"],
    });
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");

    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const orderMsg = calls.find((m: any) => m.type === "session_order_update");
    expect(orderMsg).toEqual({
      type: "session_order_update",
      sessionOrder: {
        "/repo-a": ["s2", "s1"],
        "/repo-b": ["s3"],
      },
    });
  });

  it("handleBrowserOpen: sends server-authoritative group order snapshot", () => {
    bridge.setGroupOrderState(["/repo-b", "/repo-a"]);
    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");

    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const orderMsg = calls.find((m: any) => m.type === "group_order_update");
    expect(orderMsg).toEqual({
      type: "group_order_update",
      groupOrder: ["/repo-b", "/repo-a"],
    });
  });

  it("handleBrowserOpen: sends the latest global VSCode selection state", () => {
    bridge.getOrCreateSession("s1");
    const seedBrowser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(seedBrowser, "s1");
    seedBrowser.send.mockClear();

    bridge.handleBrowserMessage(seedBrowser, JSON.stringify({
      type: "vscode_selection_update",
      selection: {
        absolutePath: "/repo/src/app.ts",
        startLine: 4,
        endLine: 8,
        lineCount: 5,
      },
      updatedAt: 100,
      sourceId: "window-a",
      sourceType: "vscode-window",
      sourceLabel: "VS Code A",
      client_msg_id: "selection-seed",
    }));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const selectionMsg = calls.find((m: any) => m.type === "vscode_selection_state");
    expect(selectionMsg).toEqual({
      type: "vscode_selection_state",
      state: {
        selection: {
          absolutePath: "/repo/src/app.ts",
          startLine: 4,
          endLine: 8,
          lineCount: 5,
        },
        updatedAt: 100,
        sourceId: "window-a",
        sourceType: "vscode-window",
        sourceLabel: "VS Code A",
      },
    });
  });

  it("handleBrowserOpen: refreshes git branch asynchronously and notifies poller", async () => {
    // resolveGitInfo is now async (fire-and-forget), so session_init sends current state
    // and the git branch is updated asynchronously after the initial snapshot.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/dynamic-branch\n";
      if (cmd.includes("rev-parse HEAD")) return "head-dynamic\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      // gitUtils.resolveDefaultBranch fallback commands
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.git_branch = "main";
    // Ensure the session has a CLI socket so refreshGitInfo doesn't skip
    (session as any).backendSocket = { send: vi.fn() };

    const gitInfoCb = vi.fn();
    bridge.onSessionGitInfoReadyCallback(gitInfoCb);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // session_init is sent immediately with the current (stale) state
    const firstMsg = JSON.parse(browser.send.mock.calls[0][0]);
    expect(firstMsg.type).toBe("session_init");
    expect(firstMsg.session.git_branch).toBe("main"); // stale — async hasn't resolved yet

    // After the async resolveGitInfo completes, session state and poller are updated
    await vi.waitFor(() => {
      expect(session.state.git_branch).toBe("feat/dynamic-branch");
      expect(gitInfoCb).toHaveBeenCalledWith("s1", "/repo", "feat/dynamic-branch");
    });
  });

  it("handleBrowserOpen: does NOT send message_history (deferred to session_subscribe)", () => {
    // History is now delivered via handleSessionSubscribe (triggered by session_subscribe
    // from the browser) instead of handleBrowserOpen, to prevent double delivery.
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const assistantMsg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-2",
      session_id: "s1",
    });
    bridge.handleCLIMessage(cli, assistantMsg);

    // Connect a browser — handleBrowserOpen should NOT send message_history
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const sessionInit = calls.find((c: any) => c.type === "session_init");
    expect(sessionInit).toBeDefined();
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeUndefined();

    // history_sync is sent after session_subscribe
    browser.send.mockClear();
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const subscribeCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyAfterSubscribe = subscribeCalls.find((c: any) => c.type === "history_sync");
    expect(historyAfterSubscribe).toBeDefined();
    expect(historyAfterSubscribe.hot_messages).toHaveLength(1);
    expect(historyAfterSubscribe.hot_messages[0].type).toBe("assistant");
  });

  it("handleBrowserOpen: sends pending permissions via session_subscribe", async () => {
    // Pending permissions are now delivered via handleSessionSubscribe instead of
    // handleBrowserOpen, to prevent double delivery on reconnect.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Create a pending permission
    const controlReq = JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Edit",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-1",
      },
    });
    bridge.handleCLIMessage(cli, controlReq);
    await new Promise(r => setTimeout(r, 0)); // flush async handleControlRequest

    // Now connect a browser and send session_subscribe
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permMsg = calls.find((c: any) => c.type === "permission_request");
    expect(permMsg).toBeDefined();
    expect(permMsg.request.tool_name).toBe("Edit");
    expect(permMsg.request.request_id).toBe("req-1");
  });

  it("handleBrowserOpen: triggers relaunch callback when CLI is dead", () => {
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    bridge.getOrCreateSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    expect(relaunchCb).toHaveBeenCalledWith("s1");

    // Also sends backend_disconnected
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const disconnectedMsg = calls.find((c: any) => c.type === "backend_disconnected");
    expect(disconnectedMsg).toBeDefined();
  });

  it("handleBrowserOpen: does NOT relaunch when Codex adapter is attached but still initializing", () => {
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const session = bridge.getOrCreateSession("s1", "codex");
    session.codexAdapter = { isConnected: () => false } as any;
    session.state.backend_state = "initializing";

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    expect(relaunchCb).not.toHaveBeenCalled();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const disconnectedMsg = calls.find((c: any) => c.type === "backend_disconnected");
    expect(disconnectedMsg).toEqual({ type: "backend_disconnected" });
  });

  it("handleBrowserClose: removes from set", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    expect(bridge.getSession("s1")!.browserSockets.has(browser)).toBe(true);

    bridge.handleBrowserClose(browser);
    expect(bridge.getSession("s1")!.browserSockets.has(browser)).toBe(false);
  });

  it("session_subscribe: replays buffered sequenced events after last_seq", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate replayable events while no browser is connected.
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
      parent_tool_use_id: null,
      uuid: "u1",
      session_id: "s1",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "s1",
    }));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Ask for replay after seq=1 (backend_connected). Both stream events should replay.
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 1,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const replay = calls.find((c: any) => c.type === "event_replay");
    expect(replay).toBeDefined();
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0].seq).toBe(2);
    expect(replay.events[0].message.type).toBe("stream_event");
  });

  it("session_subscribe: falls back to message_history when known_frozen_count is invalid", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Populate history so fallback payload has content.
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "hist-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "from history" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "hist-u1",
      session_id: "s1",
    }));

    // Generate several stream events, then trim the first one from in-memory buffer.
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "1" } },
      parent_tool_use_id: null,
      uuid: "se-u1",
      session_id: "s1",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "2" } },
      parent_tool_use_id: null,
      uuid: "se-u2",
      session_id: "s1",
    }));
    const session = bridge.getSession("s1")!;
    session.eventBuffer.shift();
    session.eventBuffer.shift(); // force earliest seq high enough to create a gap for last_seq=1

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 1,
      known_frozen_count: 99,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages.some((m: any) => m.type === "assistant")).toBe(true);
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events.some((e: any) => e.message.type === "stream_event")).toBe(true);
  });

  it("session_subscribe: falls back to message_history when known_frozen_hash mismatches", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user_message",
      content: "hello",
      timestamp: 1000,
      session_id: "s1",
      uuid: "u1",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "hist-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "from history" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "hist-u1",
      session_id: "s1",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      session_id: "s1",
      uuid: "res-1",
      stop_reason: "end_turn",
    }));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
      known_frozen_count: 2,
      known_frozen_hash: "deadbeef",
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.some((c: any) => c.type === "message_history")).toBe(true);
    expect(calls.some((c: any) => c.type === "history_sync")).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("logs a warning when the browser reports a history_sync mismatch", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "history_sync_mismatch",
      frozen_count: 3,
      expected_frozen_hash: "expected-frozen",
      actual_frozen_hash: "actual-frozen",
      expected_full_hash: "expected-full",
      actual_full_hash: "actual-full",
    }));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[history-sync] Browser reported hash mismatch for session"),
    );
    expect(browser.send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("session_subscribe no-gap: sends history_sync when history-backed events were missed", () => {
    // Simulates a mobile browser that disconnected while the session was generating,
    // then reconnects. The event buffer covers the gap (no gap), but the browser
    // missed assistant messages that need to be delivered via message_history.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate a stream_event (transient, seq=2) then an assistant message (history-backed, seq=3)
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "streaming" } },
      parent_tool_use_id: null,
      uuid: "se-1",
      session_id: "s1",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "asst-missed",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "missed message" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "asst-u1",
      session_id: "s1",
    }));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Browser reconnects claiming it last saw seq=1 (backend_connected event).
    // Event buffer covers seqs 2-3 (no gap), but seq=3 is history-backed.
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 1,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Should send history_sync because history-backed events were missed
    const historyMsg = calls.find((c: any) => c.type === "history_sync");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.hot_messages.some((m: any) => m.type === "assistant")).toBe(true);
    // Should also replay transient events (stream_event) that were missed
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events.every((e: any) => e.message.type === "stream_event")).toBe(true);
  });

  it("session_subscribe no-gap: skips message_history when only transient events were missed", () => {
    // When the browser only missed transient events (stream_event, tool_progress),
    // no message_history should be sent — just event_replay.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate only transient events
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
      parent_tool_use_id: null,
      uuid: "se-t1",
      session_id: "s1",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
      parent_tool_use_id: null,
      uuid: "se-t2",
      session_id: "s1",
    }));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 1,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Should NOT send message_history since only transient events were missed
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeUndefined();
    const syncMsg = calls.find((c: any) => c.type === "history_sync");
    expect(syncMsg).toBeUndefined();
    // Should replay the missed transient events
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events).toHaveLength(2);
  });

  it("session_subscribe: sends history_sync when event buffer is empty but browser is behind", () => {
    // Edge case: the event buffer was pruned or cleared, but the browser is behind.
    // Previously this path was skipped entirely; now it should send message_history.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate an assistant message to populate messageHistory
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "asst-empty-buf",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "should be delivered" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "asst-eb",
      session_id: "s1",
    }));

    const session = bridge.getSession("s1")!;
    // Clear the event buffer to simulate pruning, but keep nextEventSeq advanced
    session.eventBuffer.length = 0;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Browser is behind (last_seq=1 but nextEventSeq > 2)
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 1,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyMsg = calls.find((c: any) => c.type === "history_sync");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.hot_messages.some((m: any) => m.type === "assistant")).toBe(true);
  });

  it("session_ack: updates lastAckSeq for the session", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_ack",
      last_seq: 42,
    }));

    const session = bridge.getSession("s1")!;
    expect(session.lastAckSeq).toBe(42);
  });
});

// ─── CLI message routing ─────────────────────────────────────────────────────

describe("CLI message routing", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
  });

  it("assistant: stores in history and broadcasts", () => {
    const msg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Hello world!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-3",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("assistant");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const assistantBroadcast = calls.find((c: any) => c.type === "assistant");
    expect(assistantBroadcast).toBeDefined();
    expect(assistantBroadcast.message.content[0].text).toBe("Hello world!");
    expect(assistantBroadcast.parent_tool_use_id).toBeNull();
  });

  it("assistant: updates context_used_percent mid-turn from assistant usage", () => {
    const session = bridge.getSession("s1")!;
    session.state.model = "claude-opus-4-6";
    session.state.context_used_percent = 12;

    const msg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-context-mid-turn",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "Working..." }],
        stop_reason: "tool_use",
        usage: { input_tokens: 4000, output_tokens: 2000, cache_creation_input_tokens: 5000, cache_read_input_tokens: 30000 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-context-mid-turn",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    // (4000 + 2000 + 5000 + 30000) / 200000 * 100 = 21
    expect(bridge.getSession("s1")!.state.context_used_percent).toBe(21);
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const contextUpdate = calls.find((c: any) => c.type === "session_update" && c.session?.context_used_percent === 21);
    expect(contextUpdate).toBeDefined();
  });

  it("assistant: tags leader @to(user) messages as leader_user_addressed", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    const msg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-user-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Please review q-126 output. @to(user)" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-user-1",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    const histAssistant = session.messageHistory.find((m: any) => m.type === "assistant") as any;
    expect(histAssistant?.leader_user_addressed).toBe(true);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const assistantBroadcast = calls.find((c: any) => c.type === "assistant");
    expect(assistantBroadcast?.leader_user_addressed).toBe(true);
  });

  it("assistant: marks as user-addressed if ANY text block ends with @to(user)", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    const msg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-user-2",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [
          { type: "text", text: "Internal notes for workers. @to(user)" },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo progress" } },
          { type: "text", text: "Queueing follow-up worker checks. @to(self)" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-user-2",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    const histAssistant = session.messageHistory.find((m: any) => m.type === "assistant") as any;
    // @to(user) in any text block makes the entire message user-addressed
    expect(histAssistant?.leader_user_addressed).toBe(true);
  });

  it("assistant: injects a reminder when leader text message is missing suffix", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-missing-tag",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Forgot to add addressing tag this turn." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: "s1",
    }));

    // Reminder is NOT injected on the assistant message itself — it is
    // deferred to handleResultMessage (turn end) to avoid false nudges
    // during intermediate tool-call gaps.
    let reminderSend = cli.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(String(payload).trim()))
      .find((payload: any) => payload.type === "user" && String(payload.message?.content).includes("As a leader session"));
    expect(reminderSend).toBeUndefined();

    // Now send the result message to end the turn — this triggers enforcement.
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      result: "",
      is_error: false,
      total_cost_usd: 0.01,
      num_turns: 1,
      session_id: "s1",
    }));

    reminderSend = cli.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(String(payload).trim()))
      .find((payload: any) => payload.type === "user" && String(payload.message?.content).includes("As a leader session"));
    expect(reminderSend).toBeDefined();
    expect(String(reminderSend.message?.content)).toMatch(/^\[System \d{2}:\d{2}(?:\s?[AP]M)?\]/i);
    expect(String(reminderSend.message?.content)).toContain("must end with @to(user) (if addressing the human) or @to(self)");

    const session = bridge.getSession("s1")!;
    const injectedUser = session.messageHistory.findLast((m: any) => m.type === "user_message") as any;
    expect(injectedUser?.agentSource?.sessionId).toBe("system:leader-tag-enforcer");
    expect(injectedUser?.agentSource?.sessionLabel).toBe("System");
  });

  it("assistant: does not recursively re-inject reminder on system-triggered turns", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    // Simulate a prior system reminder being injected (turn trigger source = system).
    bridge.injectUserMessage("s1", "[System] prior reminder", {
      sessionId: "system:leader-tag-enforcer",
      sessionLabel: "System",
    });

    const reminderCountBefore = cli.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(String(payload).trim()))
      .filter((payload: any) => payload.type === "user" && String(payload.message?.content).includes("As a leader session"))
      .length;

    // Assistant still forgets the suffix on this reminder-triggered turn.
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-missing-tag-system-turn",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Still missing suffix on a system-triggered turn." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: "s1",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      result: "",
      is_error: false,
      total_cost_usd: 0.01,
      num_turns: 1,
      session_id: "s1",
    }));

    const reminderCountAfter = cli.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(String(payload).trim()))
      .filter((payload: any) => payload.type === "user" && String(payload.message?.content).includes("As a leader session"))
      .length;

    expect(reminderCountAfter).toBe(reminderCountBefore);
  });

  it("assistant: treats tool-only leader messages as internal without reminder", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-tool-only",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [
          { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "git status" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: "s1",
    }));

    const session = bridge.getSession("s1")!;
    const histAssistant = session.messageHistory.find((m: any) => m.type === "assistant") as any;
    expect(histAssistant?.leader_user_addressed).not.toBe(true);

    const reminderSend = cli.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(String(payload).trim()))
      .find((payload: any) => payload.type === "user" && String(payload.message?.content).includes("As a leader session"));
    expect(reminderSend).toBeUndefined();
  });

  it("result: updates cost/turns/context% and computes diff stats from git", async () => {
    // Set up session with a diff_base_branch and tracked files so computeDiffStats runs
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/test";
    session.state.diff_base_branch = "main";

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/branch\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/test\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "42\t10\tfile.ts\n";
      return "";
    });

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done!",
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 3,
      total_cost_usd: 0.05,
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      // CLI-reported line counts should be ignored — server computes from git
      total_lines_added: 999,
      total_lines_removed: 888,
      uuid: "uuid-4",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const state = bridge.getSession("s1")!.state;
    expect(state.total_cost_usd).toBe(0.05);
    expect(state.num_turns).toBe(3);

    // Async diff computation needs a tick to resolve
    await vi.waitFor(() => {
      expect(state.total_lines_added).toBe(42);
      expect(state.total_lines_removed).toBe(10);
    });

    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("result");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const resultBroadcast = calls.find((c: any) => c.type === "result");
    expect(resultBroadcast).toBeDefined();
    expect(resultBroadcast.data.total_cost_usd).toBe(0.05);
  });

  it("result: annotates latest top-level assistant message with turn duration and re-broadcasts it", () => {
    const assistantMsg = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-turn-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Completed turn" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-turn-1",
      session_id: "s1",
    });
    bridge.handleCLIMessage(cli, assistantMsg);

    const session = bridge.getSession("s1")!;
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 2500;

    const resultMsg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done!",
      duration_ms: 2500,
      duration_api_ms: 2000,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-turn-result",
      session_id: "s1",
    });
    bridge.handleCLIMessage(cli, resultMsg);

    const latestAssistant = session.messageHistory.findLast((m: any) => m.type === "assistant") as any;
    expect(typeof latestAssistant.turn_duration_ms).toBe("number");
    expect(latestAssistant.turn_duration_ms).toBeGreaterThanOrEqual(2000);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const assistantRebroadcast = [...calls].reverse().find((c: any) => c.type === "assistant" && c.message?.id === "msg-turn-1");
    expect(assistantRebroadcast).toBeDefined();
    expect(typeof assistantRebroadcast.turn_duration_ms).toBe("number");
  });

  it("result: reconciles stale running state when a replayed duplicate result arrives", () => {
    const session = bridge.getSession("s1")!;
    session.messageHistory.push({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done!",
        duration_ms: 2500,
        duration_api_ms: 2000,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "uuid-replayed-result",
        session_id: "s1",
      },
    } as any);
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 180_000;
    session.stuckNotifiedAt = Date.now() - 30_000;
    browser.send.mockClear();

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done!",
      duration_ms: 2500,
      duration_api_ms: 2000,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-replayed-result",
      session_id: "s1",
    }));

    expect(session.isGenerating).toBe(false);
    expect(session.generationStartedAt).toBeNull();
    expect(session.stuckNotifiedAt).toBeNull();
    expect(session.messageHistory.filter((m: any) => m.type === "result")).toHaveLength(1);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "idle" }));
  });

  it("result: suppresses review attention for leader turns without @to(user) response", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-internal",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Internal herd coordination completed. @to(self)" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    }));

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      duration_ms: 1000,
      duration_api_ms: 900,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-internal-result",
      session_id: "s1",
    }));

    expect(bridge.getSession("s1")!.attentionReason).toBeNull();
  });

  it("result: marks review attention for leader turns with @to(user) response", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-user-facing",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Finished q-126. Please verify. @to(user)" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    }));

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      duration_ms: 1000,
      duration_api_ms: 900,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-user-result",
      session_id: "s1",
    }));

    expect(bridge.getSession("s1")!.attentionReason).toBe("review");
  });

  it("result: suppresses review attention for herded worker turns triggered by leader messages", async () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "orch-1" })),
    } as any);

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Please fix this quickly",
      agentSource: { sessionId: "orch-1", sessionLabel: "#1 leader" },
    }));

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-worker",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Worker turn complete." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    }));

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      duration_ms: 1000,
      duration_api_ms: 900,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-worker-result",
      session_id: "s1",
    }));

    expect(bridge.getSession("s1")!.attentionReason).toBeNull();
  });

  it("result: keeps user-triggered herded turns unread even with leader follow-up messages", async () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "orch-1" })),
    } as any);

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Human request: investigate failing test",
    }));

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Leader follow-up: include stack traces",
      agentSource: { sessionId: "orch-1", sessionLabel: "#1 leader" },
    }));

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-worker-user-turn",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Initial user-triggered turn complete." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    }));

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done-user-turn",
      duration_ms: 1000,
      duration_api_ms: 900,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-worker-result-user-trigger",
      session_id: "s1",
    }));

    expect(bridge.getSession("s1")!.attentionReason).toBe("review");
    expect(bridge.getSession("s1")!.isGenerating).toBe(true);

    bridge.markSessionRead("s1");

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done-leader-turn",
      duration_ms: 900,
      duration_api_ms: 850,
      num_turns: 2,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-worker-result-leader-trigger",
      session_id: "s1",
    }));

    expect(bridge.getSession("s1")!.attentionReason).toBeNull();
  });

  it("notifies leader browser when the entire herd group stays idle for 10s", () => {
    vi.useFakeTimers();
    const leaderId = "orch-1";
    const workerId = "worker-1";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "claude", cwd: "/test" }],
    ]);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 7 : undefined)),
    } as any);
    const scheduleNotification = vi.fn();
    bridge.setPushoverNotifier({ scheduleNotification } as any);

    const leaderCli = makeCliSocket(leaderId);
    const workerCli = makeCliSocket(workerId);
    const leaderBrowser = makeBrowserSocket(leaderId);
    const workerBrowser = makeBrowserSocket(workerId);

    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIOpen(workerCli, workerId);
    bridge.handleBrowserOpen(leaderBrowser, leaderId);
    bridge.handleBrowserOpen(workerBrowser, workerId);
    leaderBrowser.send.mockClear();
    workerBrowser.send.mockClear();

    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch" }));
    bridge.handleCLIMessage(workerCli, makeInitMsg({ session_id: "cli-worker" }));

    vi.advanceTimersByTime(9_000);
    let leaderIdleEvents = leaderBrowser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((msg: any) => msg.type === "leader_group_idle");
    expect(leaderIdleEvents).toHaveLength(0);

    vi.advanceTimersByTime(1_500);
    leaderIdleEvents = leaderBrowser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((msg: any) => msg.type === "leader_group_idle");
    expect(leaderIdleEvents).toHaveLength(1);
    expect(leaderIdleEvents[0]).toEqual(expect.objectContaining({
      leader_session_id: leaderId,
      member_count: 2,
      leader_label: expect.stringContaining("#7"),
    }));
    expect(bridge.getSession(leaderId)!.attentionReason).toBe("review");
    expect(bridge.getSession(workerId)!.attentionReason).toBeNull();
    expect(scheduleNotification).toHaveBeenCalledWith(
      leaderId,
      "completed",
      expect.stringContaining("idle and waiting for attention"),
    );

    const workerIdleEvents = workerBrowser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((msg: any) => msg.type === "leader_group_idle");
    expect(workerIdleEvents).toHaveLength(0);
    vi.useRealTimers();
  });

  it("clears leader unread badge when any group member becomes active after idle notification", () => {
    vi.useFakeTimers();
    const leaderId = "orch-1a";
    const workerId = "worker-1a";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "claude", cwd: "/test" }],
    ]);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 17 : undefined)),
    } as any);

    const leaderCli = makeCliSocket(leaderId);
    const workerCli = makeCliSocket(workerId);
    const leaderBrowser = makeBrowserSocket(leaderId);

    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIOpen(workerCli, workerId);
    bridge.handleBrowserOpen(leaderBrowser, leaderId);

    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-1a" }));
    bridge.handleCLIMessage(workerCli, makeInitMsg({ session_id: "cli-worker-1a" }));

    vi.advanceTimersByTime(10_500);
    expect(bridge.getSession(leaderId)!.attentionReason).toBe("review");

    bridge.injectUserMessage(workerId, "Continue with validation");
    expect(bridge.getSession(leaderId)!.attentionReason).toBeNull();
    expect(bridge.getSession(workerId)!.attentionReason).toBeNull();

    vi.useRealTimers();
  });

  it("cancels leader idle timer when a group member becomes active before threshold", () => {
    vi.useFakeTimers();
    const leaderId = "orch-2";
    const workerId = "worker-2";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "claude", cwd: "/test" }],
    ]);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 8 : undefined)),
    } as any);

    const leaderCli = makeCliSocket(leaderId);
    const workerCli = makeCliSocket(workerId);
    const leaderBrowser = makeBrowserSocket(leaderId);

    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIOpen(workerCli, workerId);
    bridge.handleBrowserOpen(leaderBrowser, leaderId);
    leaderBrowser.send.mockClear();

    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-2" }));
    bridge.handleCLIMessage(workerCli, makeInitMsg({ session_id: "cli-worker-2" }));

    vi.advanceTimersByTime(5_000);
    bridge.injectUserMessage(workerId, "Continue with validation");

    vi.advanceTimersByTime(6_000);
    let leaderIdleEvents = leaderBrowser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((msg: any) => msg.type === "leader_group_idle");
    expect(leaderIdleEvents).toHaveLength(0);

    bridge.handleCLIMessage(workerCli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      duration_ms: 1000,
      duration_api_ms: 900,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-worker-2-result",
      session_id: workerId,
    }));

    vi.advanceTimersByTime(10_500);
    leaderIdleEvents = leaderBrowser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((msg: any) => msg.type === "leader_group_idle");
    expect(leaderIdleEvents).toHaveLength(1);
    vi.useRealTimers();
  });

  it("result: refreshes git branch and broadcasts session_update when branch changes", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/new-branch\n";
      if (cmd.includes("rev-parse HEAD")) return "head-new-branch\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/test\n";
      if (cmd.includes("--left-right --count")) return "0\t1\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "";
      // gitUtils.resolveDefaultBranch fallback commands
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const session = bridge.getSession("s1")!;
    session.state.cwd = "/test";
    session.state.git_branch = "main";

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done!",
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-refresh-git",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    // refreshGitInfo is async (fire-and-forget) — wait for session_update broadcast
    await vi.waitFor(() => {
      expect(bridge.getSession("s1")!.state.git_branch).toBe("feat/new-branch");
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const updateMsg = calls.find((c: any) => c.type === "session_update" && c.session?.git_branch);
    expect(updateMsg).toBeDefined();
    expect(updateMsg.session.git_branch).toBe("feat/new-branch");
    expect(updateMsg.session.git_ahead).toBe(1);
  });

  it("result: computes context_used_percent from per-turn usage (not cumulative modelUsage)", () => {
    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 12, cache_creation_input_tokens: 19705, cache_read_input_tokens: 20959 },
      modelUsage: {
        "claude-sonnet-4-5-20250929": {
          // Cumulative totals can exceed the context window and should not be used
          // to compute per-turn context usage.
          inputTokens: 14,
          outputTokens: 1255,
          cacheReadInputTokens: 278932,
          cacheCreationInputTokens: 38934,
          contextWindow: 200000,
          maxOutputTokens: 16384,
          costUSD: 0.02,
        },
      },
      uuid: "uuid-5",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const state = bridge.getSession("s1")!.state;
    // (3 + 12 + 19705 + 20959) / 200000 * 100 = 20
    expect(state.context_used_percent).toBe(20);
  });

  it("result: uses 1m context window for [1m] model variants even if modelUsage reports 200k", () => {
    const session = bridge.getSession("s1")!;
    session.state.model = "claude-opus-4-6[1m]";

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 400000, output_tokens: 10000, cache_creation_input_tokens: 15000, cache_read_input_tokens: 25000 },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 10,
          outputTokens: 50,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 200,
          contextWindow: 200000,
          maxOutputTokens: 32000,
          costUSD: 0.02,
        },
      },
      uuid: "uuid-5-1m",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const state = bridge.getSession("s1")!.state;
    // (400000 + 10000 + 15000 + 25000) / 1000000 * 100 = 45
    expect(state.context_used_percent).toBe(45);
  });

  it("result: keeps previous context_used_percent when usage payload is empty", () => {
    const session = bridge.getSession("s1")!;
    session.state.context_used_percent = 61;
    session.state.model = "claude-opus-4-6";

    const msg = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 10,
          outputTokens: 50,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 200,
          contextWindow: 200000,
          maxOutputTokens: 32000,
          costUSD: 0.02,
        },
      },
      uuid: "uuid-5-empty-usage",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    expect(bridge.getSession("s1")!.state.context_used_percent).toBe(61);
  });

  it("stream_event: broadcasts without storing", () => {
    const msg = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      uuid: "uuid-6",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const streamEvent = calls.find((c: any) => c.type === "stream_event");
    expect(streamEvent).toBeDefined();
    expect(streamEvent.event.delta.text).toBe("hi");
    expect(streamEvent.parent_tool_use_id).toBeNull();
  });

  it("control_request (can_use_tool): adds to pending and broadcasts", async () => {
    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-42",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls -la" },
        description: "List files",
        tool_use_id: "tu-42",
        agent_id: "agent-1",
        permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }],
      },
    });

    bridge.handleCLIMessage(cli, msg);
    await new Promise(r => setTimeout(r, 0)); // flush async handleControlRequest

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(1);
    const perm = session.pendingPermissions.get("req-42")!;
    expect(perm.tool_name).toBe("Bash");
    expect(perm.input).toEqual({ command: "ls -la" });
    expect(perm.description).toBe("List files");
    expect(perm.tool_use_id).toBe("tu-42");
    expect(perm.agent_id).toBe("agent-1");
    expect(perm.timestamp).toBeGreaterThan(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permBroadcast = calls.find((c: any) => c.type === "permission_request");
    expect(permBroadcast).toBeDefined();
    expect(permBroadcast.request.request_id).toBe("req-42");
    expect(permBroadcast.request.tool_name).toBe("Bash");
  });

  it("control_request (can_use_tool): does not set attention for herded worker sessions", async () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "orch-1" })),
    } as any);

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-herded-attention",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls -la" },
        description: "List files",
        tool_use_id: "tu-herded-attention",
      },
    });

    bridge.handleCLIMessage(cli, msg);
    await new Promise(r => setTimeout(r, 0)); // flush async handleControlRequest

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(1);
    expect(session.attentionReason).toBeNull();
  });

  it("tool_progress: broadcasts", () => {
    const msg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-10",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3.5,
      uuid: "uuid-7",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsg = calls.find((c: any) => c.type === "tool_progress");
    expect(progressMsg).toBeDefined();
    expect(progressMsg.tool_use_id).toBe("tu-10");
    expect(progressMsg.tool_name).toBe("Bash");
    expect(progressMsg.elapsed_time_seconds).toBe(3.5);
  });

  it("tool_use_summary: broadcasts", () => {
    const msg = JSON.stringify({
      type: "tool_use_summary",
      summary: "Ran bash command successfully",
      preceding_tool_use_ids: ["tu-10", "tu-11"],
      uuid: "uuid-8",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const summaryMsg = calls.find((c: any) => c.type === "tool_use_summary");
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg.summary).toBe("Ran bash command successfully");
    expect(summaryMsg.tool_use_ids).toEqual(["tu-10", "tu-11"]);
  });

  it("keep_alive: silently consumed, no broadcast", () => {
    const msg = JSON.stringify({ type: "keep_alive" });

    bridge.handleCLIMessage(cli, msg);

    expect(browser.send).not.toHaveBeenCalled();
  });

  it("keep_alive does not update lastActivityAt but real messages do", () => {
    // Idle Claude sessions send periodic keep_alive pings. These must NOT
    // refresh lastActivityAt, otherwise the idle manager treats them as
    // recently active and kills sessions with real user activity instead.
    const mockLauncher = { touchActivity: vi.fn() } as any;
    bridge.setLauncher(mockLauncher);

    bridge.handleCLIMessage(cli, JSON.stringify({ type: "keep_alive" }));
    expect(mockLauncher.touchActivity).not.toHaveBeenCalled();

    // A real message (e.g. tool_progress) should update activity
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-1",
      session_id: "s1",
    }));
    expect(mockLauncher.touchActivity).toHaveBeenCalledWith("s1");
  });

  it("multi-line NDJSON: processes both lines", () => {
    const line1 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-a",
      tool_name: "Read",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-a",
      session_id: "s1",
    });
    const line2 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-b",
      tool_name: "Edit",
      parent_tool_use_id: null,
      elapsed_time_seconds: 2,
      uuid: "uuid-b",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, line1 + "\n" + line2);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsgs = calls.filter((c: any) => c.type === "tool_progress");
    expect(progressMsgs).toHaveLength(2);
    expect(progressMsgs[0].tool_use_id).toBe("tu-a");
    expect(progressMsgs[1].tool_use_id).toBe("tu-b");
  });

  it("malformed JSON: skips gracefully without crashing", () => {
    const validLine = JSON.stringify({ type: "keep_alive" });
    const raw = "not-valid-json\n" + validLine;

    // Should not throw
    expect(() => bridge.handleCLIMessage(cli, raw)).not.toThrow();
    // keep_alive is silently consumed, so no broadcast
    expect(browser.send).not.toHaveBeenCalled();
  });
});

// ─── Browser message routing ─────────────────────────────────────────────────

describe("Browser message routing", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();
    browser.send.mockClear();
  });

  it("user_message: sends NDJSON to CLI and stores in history", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "What is 2+2?",
    }));

    // Should have sent NDJSON to CLI
    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("user");
    expect(sent.message.role).toBe("user");
    expect(sent.message.content).toBe("What is 2+2?");

    // Should store in history
    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(1);
    expect(session.messageHistory[0].type).toBe("user_message");
    if (session.messageHistory[0].type === "user_message") {
      expect(session.messageHistory[0].content).toBe("What is 2+2?");
    }
  });

  it("user_message: queues when CLI not connected", () => {
    // Close CLI
    bridge.handleCLIClose(cli);
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "queued message",
    }));

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(1);
    const queued = JSON.parse(session.pendingMessages[0]);
    expect(queued.type).toBe("user");
    expect(queued.message.content).toBe("queued message");
  });

  it("user_message: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "user_message",
      content: "once only",
      client_msg_id: "client-msg-1",
    };

    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const session = bridge.getSession("s1")!;
    const userMessages = session.messageHistory.filter((m) => m.type === "user_message");
    expect(userMessages).toHaveLength(1);
  });

  it("vscode_selection_update: broadcasts the latest global selection to browsers across sessions", () => {
    bridge.getOrCreateSession("s2");
    const otherBrowser = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(otherBrowser, "s2");
    otherBrowser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "vscode_selection_update",
      selection: {
        absolutePath: "/repo/src/app.ts",
        startLine: 10,
        endLine: 12,
        lineCount: 3,
      },
      updatedAt: 200,
      sourceId: "window-a",
      sourceType: "vscode-window",
      sourceLabel: "VS Code A",
      client_msg_id: "selection-1",
    }));

    const sessionOneCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const sessionTwoCalls = otherBrowser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    for (const calls of [sessionOneCalls, sessionTwoCalls]) {
      expect(calls).toContainEqual({
        type: "vscode_selection_state",
        state: {
          selection: {
            absolutePath: "/repo/src/app.ts",
            startLine: 10,
            endLine: 12,
            lineCount: 3,
          },
          updatedAt: 200,
          sourceId: "window-a",
          sourceType: "vscode-window",
          sourceLabel: "VS Code A",
        },
      });
    }
  });

  it("vscode_selection_update: ignores stale updates and keeps inspectable clears", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "vscode_selection_update",
      selection: {
        absolutePath: "/repo/src/app.ts",
        startLine: 10,
        endLine: 12,
        lineCount: 3,
      },
      updatedAt: 200,
      sourceId: "window-b",
      sourceType: "vscode-window",
      sourceLabel: "VS Code B",
      client_msg_id: "selection-2",
    }));
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "vscode_selection_update",
      selection: {
        absolutePath: "/repo/src/older.ts",
        startLine: 1,
        endLine: 1,
        lineCount: 1,
      },
      updatedAt: 150,
      sourceId: "window-a",
      sourceType: "vscode-window",
      sourceLabel: "Older",
      client_msg_id: "selection-3",
    }));
    expect(browser.send).not.toHaveBeenCalled();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "vscode_selection_update",
      selection: null,
      updatedAt: 250,
      sourceId: "window-c",
      sourceType: "vscode-window",
      sourceLabel: "VS Code C",
      client_msg_id: "selection-4",
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual({
      type: "vscode_selection_state",
      state: {
        selection: null,
        updatedAt: 250,
        sourceId: "window-c",
        sourceType: "vscode-window",
        sourceLabel: "VS Code C",
      },
    });
  });

  it("registers VSCode windows and prefers the workspace root that contains the target file", async () => {
    bridge.upsertVsCodeWindowState({
      sourceId: "window-a",
      sourceType: "vscode-window",
      sourceLabel: "Repo A",
      workspaceRoots: ["/repo-a"],
      updatedAt: 100,
      lastActivityAt: 100,
    });
    bridge.upsertVsCodeWindowState({
      sourceId: "window-b",
      sourceType: "vscode-window",
      sourceLabel: "Repo B",
      workspaceRoots: ["/repo-b", "/repo-b/packages/app"],
      updatedAt: 200,
      lastActivityAt: 200,
    });

    const requestPromise = bridge.requestVsCodeOpenFile({
      absolutePath: "/repo-b/packages/app/src/main.ts",
      line: 14,
      column: 2,
    });

    const commands = bridge.pollVsCodeOpenFileCommands("window-b");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual({
      commandId: expect.any(String),
      sourceId: "window-b",
      target: {
        absolutePath: "/repo-b/packages/app/src/main.ts",
        line: 14,
        column: 2,
      },
      createdAt: expect.any(Number),
    });
    expect(bridge.pollVsCodeOpenFileCommands("window-a")).toEqual([]);

    expect(bridge.resolveVsCodeOpenFileResult("window-b", commands[0].commandId, { ok: true })).toBe(true);
    await expect(requestPromise).resolves.toEqual({
      sourceId: "window-b",
      commandId: commands[0].commandId,
    });
  });

  it("requestVsCodeOpenFile: falls back to the most recent active window when no workspace root matches", async () => {
    bridge.upsertVsCodeWindowState({
      sourceId: "window-a",
      sourceType: "vscode-window",
      workspaceRoots: ["/repo-a"],
      updatedAt: 100,
      lastActivityAt: 100,
    });
    bridge.upsertVsCodeWindowState({
      sourceId: "window-b",
      sourceType: "vscode-window",
      workspaceRoots: ["/repo-b"],
      updatedAt: 200,
      lastActivityAt: 250,
    });

    const requestPromise = bridge.requestVsCodeOpenFile({
      absolutePath: "/outside/shared/file.ts",
    });
    const commands = bridge.pollVsCodeOpenFileCommands("window-b");
    expect(commands).toHaveLength(1);
    bridge.resolveVsCodeOpenFileResult("window-b", commands[0].commandId, { ok: true });
    await expect(requestPromise).resolves.toEqual({
      sourceId: "window-b",
      commandId: commands[0].commandId,
    });
  });

  it("requestVsCodeOpenFile: returns a clear error when no active VSCode windows are registered", async () => {
    await expect(bridge.requestVsCodeOpenFile({
      absolutePath: "/repo/src/app.ts",
    })).rejects.toThrow("No running VS Code was detected on this machine.");
  });

  it("user_message with images: emits error and does not send when imageStore is not set", () => {
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "What's in this image?",
      images: [
        { media_type: "image/png", data: "base64data==" },
      ],
    }));

    expect(cli.send).not.toHaveBeenCalled();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("Image failed to send"),
    }));
  });

  it("user_message with images: non-SDK Claude keeps inline image blocks when imageStore is enabled", async () => {
    const mockImageStore = {
      store: vi.fn()
        .mockResolvedValueOnce({ imageId: "img-1", media_type: "image/png" })
        .mockResolvedValueOnce({ imageId: "img-2", media_type: "image/jpeg" }),
      convertForApi: vi.fn((data: string, mediaType: string) => Promise.resolve({
        base64: `${data}-converted`,
        mediaType,
      })),
    };
    bridge.setImageStore(mockImageStore as any);

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Please compare these",
      images: [
        { media_type: "image/png", data: "img1-base64" },
        { media_type: "image/jpeg", data: "img2-base64" },
      ],
    }));
    await new Promise((r) => setTimeout(r, 20));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(Array.isArray(sent.message.content)).toBe(true);
    expect(sent.message.content).toHaveLength(3);
    expect(sent.message.content[0].type).toBe("image");
    expect(sent.message.content[1].type).toBe("image");
    expect(sent.message.content[2].type).toBe("text");
    expect(sent.message.content[0].source.data).toBe("img1-base64-converted");
    expect(sent.message.content[1].source.data).toBe("img2-base64-converted");

    const expectedPath1 = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    const expectedPath2 = join(homedir(), ".companion", "images", "s1", "img-2.orig.jpeg");
    expect(sent.message.content[2].text).toContain(`Attachment 1: ${expectedPath1}`);
    expect(sent.message.content[2].text).toContain(`Attachment 2: ${expectedPath2}`);

    expect(mockImageStore.store).toHaveBeenCalledTimes(2);
    expect(mockImageStore.convertForApi).toHaveBeenCalledTimes(2);
  });

  it("user_message with images: emits error and does not send turn when upload to imageStore fails", async () => {
    const mockImageStore = {
      store: vi.fn().mockRejectedValue(new Error("ENOENT: image file not found")),
      convertForApi: vi.fn(),
    };
    bridge.setImageStore(mockImageStore as any);
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Please inspect this screenshot",
      images: [{ media_type: "image/png", data: "broken-base64" }],
    }));
    await new Promise((r) => setTimeout(r, 20));

    expect(cli.send).not.toHaveBeenCalled();
    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("Image failed to send: image couldn't be found on server"),
    }));
  });

  it("permission_response allow: sends control_response to CLI", async () => {
    // First create a pending permission
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-allow",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo hi" },
        tool_use_id: "tu-allow",
      },
    }));
    await new Promise(r => setTimeout(r, 0)); // flush async handleControlRequest
    cli.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-allow",
      behavior: "allow",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.subtype).toBe("success");
    expect(sent.response.request_id).toBe("req-allow");
    expect(sent.response.response.behavior).toBe("allow");
    expect(sent.response.response.updatedInput).toEqual({ command: "echo hi" });

    // Should remove from pending
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("req-allow")).toBe(false);
  });

  it("permission_response deny: sends deny response to CLI", () => {
    // Create a pending permission
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-deny",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /" },
        tool_use_id: "tu-deny",
      },
    }));
    cli.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-deny",
      behavior: "deny",
      message: "Too dangerous",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.subtype).toBe("success");
    expect(sent.response.request_id).toBe("req-deny");
    expect(sent.response.response.behavior).toBe("deny");
    expect(sent.response.response.message).toBe("Too dangerous");

    // Should remove from pending
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("req-deny")).toBe(false);
  });

  it("permission_response: deduplicates repeated client_msg_id", () => {
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-dedupe",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo hi" },
        tool_use_id: "tu-dedupe",
      },
    }));
    cli.send.mockClear();

    const payload = {
      type: "permission_response",
      request_id: "req-dedupe",
      behavior: "allow",
      client_msg_id: "perm-msg-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("req-dedupe")).toBe(false);
  });

  it("interrupt: sends control_request with interrupt subtype to CLI", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "interrupt",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("interrupt");
  });

  it("interrupt: emits turn_end with interrupt_source=user", () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "start work",
    }));
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "interrupt",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      total_cost_usd: 0,
      num_turns: 1,
    }));

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "user" }),
    );
    spy.mockRestore();
  });

  it("routeExternalInterrupt: emits turn_end with interrupt_source=leader", async () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "start work",
    }));
    await bridge.routeExternalInterrupt(bridge.getSession("s1")!, "leader");
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      total_cost_usd: 0,
      num_turns: 1,
    }));

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "leader" }),
    );
    spy.mockRestore();
  });

  it("interrupt: deduplicates repeated client_msg_id", () => {
    const payload = { type: "interrupt", client_msg_id: "ctrl-msg-1" };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("set_model: sends control_request with set_model subtype to CLI", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_model",
      model: "claude-opus-4-5-20250929",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("set_model");
    expect(sent.request.model).toBe("claude-opus-4-5-20250929");
  });

  it("set_permission_mode: sends control_request with set_permission_mode subtype to CLI", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_permission_mode",
      mode: "bypassPermissions",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("set_permission_mode");
    expect(sent.request.mode).toBe("bypassPermissions");
  });

  it("set_model: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "set_model",
      model: "claude-opus-4-5-20250929",
      client_msg_id: "set-model-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("set_permission_mode: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "set_permission_mode",
      mode: "plan",
      client_msg_id: "set-mode-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_toggle: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_toggle",
      serverName: "my-mcp",
      enabled: true,
      client_msg_id: "mcp-msg-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    // 1 send for mcp_toggle control_request + delayed status refresh timer not run in this assertion window.
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_get_status: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_get_status",
      client_msg_id: "mcp-status-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_reconnect: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_reconnect",
      serverName: "my-mcp",
      client_msg_id: "mcp-reconnect-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("mcp_set_servers: deduplicates repeated client_msg_id", () => {
    const payload = {
      type: "mcp_set_servers",
      servers: {
        "server-a": {
          type: "stdio",
          command: "node",
          args: ["server.js"],
        },
      },
      client_msg_id: "mcp-set-servers-1",
    };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    expect(cli.send).toHaveBeenCalledTimes(1);
  });
});

// ─── Persistence ─────────────────────────────────────────────────────────────

describe("Persistence", () => {
  it("restoreFromDisk: loads persisted Codex outbound turns from store", async () => {
    // Save a session directly to the store
    store.saveSync({
      id: "persisted-1",
      state: {
        session_id: "persisted-1",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/saved",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0.1,
        num_turns: 5,
        context_used_percent: 15,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/saved",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [
        { type: "user_message", content: "Hello", timestamp: 1000 },
      ],
      pendingMessages: [],
      pendingCodexTurns: [{
        adapterMsg: { type: "user_message", content: "Hello" },
        userMessageId: "restored-user-1",
        userContent: "Hello",
        historyIndex: -1,
        status: "queued",
        dispatchCount: 0,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        acknowledgedAt: null,
        turnTarget: null,
        lastError: null,
        turnId: "turn-restored-1",
        disconnectedAt: 1700000000000,
        resumeConfirmedAt: null,
      }],
      pendingPermissions: [],
      processedClientMessageIds: ["restored-client-1"],
    } as any);

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("persisted-1");
    expect(session).toBeDefined();
    expect(session!.state.model).toBe("claude-sonnet-4-5-20250929");
    expect(session!.state.cwd).toBe("/saved");
    expect(session!.state.total_cost_usd).toBe(0.1);
    expect(session!.messageHistory).toHaveLength(1);
    expect(session!.backendSocket).toBeNull();
    expect(session!.browserSockets.size).toBe(0);
    expect(getPendingCodexTurn(session!)).toMatchObject({
      adapterMsg: { type: "user_message", content: "Hello" },
      userMessageId: "restored-user-1",
      userContent: "Hello",
      status: "queued",
      dispatchCount: 0,
      turnId: "turn-restored-1",
      disconnectedAt: 1700000000000,
      resumeConfirmedAt: null,
      turnTarget: null,
      lastError: null,
    });
    expect(session!.processedClientMessageIdSet.has("restored-client-1")).toBe(true);
  });

  it("restoreFromDisk: does not overwrite live sessions", async () => {
    // Create a live session first
    const liveSession = bridge.getOrCreateSession("live-1");
    liveSession.state.model = "live-model";

    // Save a different version to disk
    store.saveSync({
      id: "live-1",
      state: {
        session_id: "live-1",
        model: "disk-model",
        cwd: "/disk",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: [],
    });

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(0);

    // Should still have the live model
    const session = bridge.getSession("live-1")!;
    expect(session.state.model).toBe("live-model");
  });

  it("restoreFromDisk: finalizes stale disconnected bash tools recovered from history", async () => {
    const startedAt = Date.now() - 180_000;
    store.saveSync({
      id: "persisted-codex-tool",
      state: {
        session_id: "persisted-codex-tool",
        backend_type: "codex",
        model: "gpt-5-codex",
        cwd: "/saved",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 1,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/saved",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [
        {
          type: "assistant",
          message: {
            id: "assistant-persisted-tool",
            type: "message",
            role: "assistant",
            model: "gpt-5-codex",
            content: [{ type: "tool_use", id: "cmd_restore", name: "Bash", input: { command: "git status --short" } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: startedAt,
          tool_start_times: { cmd_restore: startedAt },
        } as any,
      ],
      pendingMessages: [],
      pendingPermissions: [],
      toolResults: [],
    });

    await store.flushAll();
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("persisted-codex-tool")!;
    expect(session.toolStartTimes.has("cmd_restore")).toBe(false);
    const previewMsg = session.messageHistory.findLast((m) => m.type === "tool_result_preview") as any;
    expect(previewMsg).toBeDefined();
    expect(previewMsg.previews[0].tool_use_id).toBe("cmd_restore");
    expect(previewMsg.previews[0].is_error).toBe(true);
    expect(previewMsg.previews[0].content).toContain("backend was disconnected");
  });

  it("persistSession: called after state changes (via store.save)", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const saveSpy = vi.spyOn(store, "save");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // system.init should trigger persist
    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(saveSpy).toHaveBeenCalled();

    const lastCall = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][0];
    expect(lastCall.id).toBe("s1");
    expect(lastCall.state.model).toBe("claude-sonnet-4-5-20250929");

    saveSpy.mockClear();

    // assistant message should trigger persist
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Test" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "uuid-p1",
      session_id: "s1",
    }));
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // result message should trigger persist
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1000,
      duration_api_ms: 800,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "uuid-p2",
      session_id: "s1",
    }));
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // control_request (can_use_tool) should trigger persist
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-persist",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo test" },
        tool_use_id: "tu-persist",
      },
    }));
    await new Promise(r => setTimeout(r, 0)); // flush async handleControlRequest
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // user message from browser should trigger persist
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    bridge.handleBrowserMessage(browserWs, JSON.stringify({
      type: "user_message",
      content: "test persist",
    }));
    expect(saveSpy).toHaveBeenCalled();
  });

  it("persistSession: includes pending Codex turn recovery after user dispatch", async () => {
    const saveSpy = vi.spyOn(store, "save");
    const sid = "persist-codex-recovery";
    const adapter = makeCodexAdapterMock();
    adapter.sendBrowserMessage.mockReturnValue(true);
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "persist this retry context",
    }));

    // This guards the restart path: a user turn that disconnects immediately
    // after dispatch still needs its recovery state on disk.
    const persistedWithRecovery = saveSpy.mock.calls
      .map(([arg]) => arg)
      .find((call) => call.id === sid && Array.isArray(call.pendingCodexTurns) && call.pendingCodexTurns.length > 0);

    expect(persistedWithRecovery?.pendingCodexTurns?.[0]).toMatchObject({
      adapterMsg: { type: "user_message", content: "persist this retry context" },
      userMessageId: expect.any(String),
      userContent: "persist this retry context",
      historyIndex: 0,
      status: "dispatched",
      dispatchCount: 1,
      turnId: null,
      disconnectedAt: null,
      resumeConfirmedAt: null,
      turnTarget: null,
      lastError: null,
    });
  });

  it("restoreFromDisk: preserves unexpected raw Codex pendingMessages without auto-migrating them", async () => {
    const sid = "restore-codex-legacy-pending-message";
    store.saveSync({
      id: sid,
      state: {
        session_id: sid,
        backend_type: "codex",
        model: "gpt-5.3-codex",
        cwd: "/saved",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "main",
        is_worktree: false,
        is_containerized: false,
        repo_root: "/saved",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [
        JSON.stringify({ type: "user_message", content: "legacy raw codex turn", client_msg_id: "legacy-raw-1" }),
        JSON.stringify({ type: "set_model", model: "gpt-5.4" }),
      ],
      pendingCodexTurns: [],
      pendingPermissions: [],
    });

    await store.flushAll();
    await bridge.restoreFromDisk();

    const session = bridge.getSession(sid)!;
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.pendingMessages).toHaveLength(2);
    expect(JSON.parse(session.pendingMessages[0])).toMatchObject({
      type: "user_message",
      content: "legacy raw codex turn",
      client_msg_id: "legacy-raw-1",
    });
    expect(JSON.parse(session.pendingMessages[1])).toMatchObject({ type: "set_model", model: "gpt-5.4" });
  });
});

// ─── auth_status message routing ──────────────────────────────────────────────

describe("auth_status message routing", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
  });

  it("broadcasts auth_status with isAuthenticating: true", () => {
    const msg = JSON.stringify({
      type: "auth_status",
      isAuthenticating: true,
      output: ["Waiting for authentication..."],
      uuid: "uuid-auth-1",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const authMsg = calls.find((c: any) => c.type === "auth_status");
    expect(authMsg).toBeDefined();
    expect(authMsg.isAuthenticating).toBe(true);
    expect(authMsg.output).toEqual(["Waiting for authentication..."]);
    expect(authMsg.error).toBeUndefined();
  });

  it("broadcasts auth_status with isAuthenticating: false", () => {
    const msg = JSON.stringify({
      type: "auth_status",
      isAuthenticating: false,
      output: ["Authentication complete"],
      uuid: "uuid-auth-2",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const authMsg = calls.find((c: any) => c.type === "auth_status");
    expect(authMsg).toBeDefined();
    expect(authMsg.isAuthenticating).toBe(false);
    expect(authMsg.output).toEqual(["Authentication complete"]);
  });

  it("broadcasts auth_status with error field", () => {
    const msg = JSON.stringify({
      type: "auth_status",
      isAuthenticating: false,
      output: ["Failed to authenticate"],
      error: "Token expired",
      uuid: "uuid-auth-3",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const authMsg = calls.find((c: any) => c.type === "auth_status");
    expect(authMsg).toBeDefined();
    expect(authMsg.isAuthenticating).toBe(false);
    expect(authMsg.error).toBe("Token expired");
    expect(authMsg.output).toEqual(["Failed to authenticate"]);
  });
});

// ─── permission_response with updated_permissions ─────────────────────────────

describe("permission_response with updated_permissions", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();
    browser.send.mockClear();
  });

  it("allow with updated_permissions forwards updatedPermissions in control_response", () => {
    // Create pending permission
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-perm-update",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "echo hello" },
        tool_use_id: "tu-perm-update",
      },
    }));
    cli.send.mockClear();

    const updatedPermissions = [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo *" }], behavior: "allow", destination: "session" },
    ];

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-perm-update",
      behavior: "allow",
      updated_permissions: updatedPermissions,
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.response.behavior).toBe("allow");
    expect(sent.response.response.updatedPermissions).toEqual(updatedPermissions);
  });

  it("allow without updated_permissions does not include updatedPermissions key", () => {
    // Create pending permission
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-no-perm",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-no-perm",
      },
    }));
    cli.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-no-perm",
      behavior: "allow",
    }));

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.response.response.updatedPermissions).toBeUndefined();
  });

  it("allow with empty updated_permissions does not include updatedPermissions key", () => {
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-empty-perm",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-empty-perm",
      },
    }));
    cli.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-empty-perm",
      behavior: "allow",
      updated_permissions: [],
    }));

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.response.response.updatedPermissions).toBeUndefined();
  });
});

// ─── Multiple browser sockets ─────────────────────────────────────────────────

describe("Multiple browser sockets", () => {
  it("broadcasts to ALL connected browsers", () => {
    const cli = makeCliSocket("s1");
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");
    const browser3 = makeBrowserSocket("s1");

    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserOpen(browser3, "s1");
    browser1.send.mockClear();
    browser2.send.mockClear();
    browser3.send.mockClear();

    const msg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-multi",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1.5,
      uuid: "uuid-multi",
      session_id: "s1",
    });
    bridge.handleCLIMessage(cli, msg);

    // All three browsers should receive the broadcast
    for (const browser of [browser1, browser2, browser3]) {
      expect(browser.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(browser.send.mock.calls[0][0]);
      expect(sent.type).toBe("tool_progress");
      expect(sent.tool_use_id).toBe("tu-multi");
    }
  });

  it("removes a browser whose send() throws, but others continue to receive", () => {
    const cli = makeCliSocket("s1");
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");
    const browser3 = makeBrowserSocket("s1");

    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserOpen(browser3, "s1");
    browser1.send.mockClear();
    browser2.send.mockClear();
    browser3.send.mockClear();

    // Make browser2's send throw
    browser2.send.mockImplementation(() => {
      throw new Error("WebSocket closed");
    });

    const msg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-fail",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 2,
      uuid: "uuid-fail",
      session_id: "s1",
    });
    bridge.handleCLIMessage(cli, msg);

    // browser1 and browser3 should have received the message
    expect(browser1.send).toHaveBeenCalledTimes(1);
    expect(browser3.send).toHaveBeenCalledTimes(1);

    // browser2 should have been removed from the set
    const session = bridge.getSession("s1")!;
    expect(session.browserSockets.has(browser2)).toBe(false);
    expect(session.browserSockets.has(browser1)).toBe(true);
    expect(session.browserSockets.has(browser3)).toBe(true);
    expect(session.browserSockets.size).toBe(2);
  });
});

// ─── handleCLIMessage with Buffer ─────────────────────────────────────────────

describe("handleCLIMessage with Buffer", () => {
  it("parses Buffer input correctly", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const jsonStr = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-buf",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-buf",
      session_id: "s1",
    });

    // Pass as Buffer instead of string
    bridge.handleCLIMessage(cli, Buffer.from(jsonStr, "utf-8"));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsg = calls.find((c: any) => c.type === "tool_progress");
    expect(progressMsg).toBeDefined();
    expect(progressMsg.tool_use_id).toBe("tu-buf");
    expect(progressMsg.tool_name).toBe("Bash");
  });

  it("handles multi-line NDJSON as Buffer", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const line1 = JSON.stringify({ type: "keep_alive" });
    const line2 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-buf2",
      tool_name: "Read",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3,
      uuid: "uuid-buf2",
      session_id: "s1",
    });
    const ndjson = line1 + "\n" + line2;

    bridge.handleCLIMessage(cli, Buffer.from(ndjson, "utf-8"));

    // keep_alive is silently consumed, only tool_progress should be broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("tool_progress");
    expect(calls[0].tool_use_id).toBe("tu-buf2");
  });
});

// ─── handleBrowserMessage with Buffer ─────────────────────────────────────────

describe("handleBrowserMessage with Buffer", () => {
  it("parses Buffer input and routes user_message correctly", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    const msgStr = JSON.stringify({
      type: "user_message",
      content: "Hello from buffer",
    });

    bridge.handleBrowserMessage(browser, Buffer.from(msgStr, "utf-8"));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("user");
    expect(sent.message.content).toBe("Hello from buffer");
  });

  it("parses Buffer input and routes interrupt correctly", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    const msgStr = JSON.stringify({ type: "interrupt" });
    bridge.handleBrowserMessage(browser, Buffer.from(msgStr, "utf-8"));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("interrupt");
  });
});

// ─── handleBrowserMessage with malformed JSON ─────────────────────────────────

describe("handleBrowserMessage with malformed JSON", () => {
  it("does not throw on invalid JSON", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    expect(() => {
      bridge.handleBrowserMessage(browser, "this is not json {{{");
    }).not.toThrow();

    // CLI should not receive anything
    expect(cli.send).not.toHaveBeenCalled();
  });

  it("does not throw on empty string", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    expect(() => {
      bridge.handleBrowserMessage(browser, "");
    }).not.toThrow();

    expect(cli.send).not.toHaveBeenCalled();
  });

  it("does not throw on truncated JSON", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    cli.send.mockClear();

    expect(() => {
      bridge.handleBrowserMessage(browser, '{"type":"user_message","con');
    }).not.toThrow();

    expect(cli.send).not.toHaveBeenCalled();
  });
});

// ─── Empty NDJSON lines ───────────────────────────────────────────────────────

describe("Empty NDJSON lines", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
  });

  it("skips empty lines between valid NDJSON", () => {
    const validMsg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-empty-lines",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-empty-lines",
      session_id: "s1",
    });

    // Empty lines, whitespace-only lines interspersed
    const raw = "\n\n" + validMsg + "\n\n   \n\t\n";
    bridge.handleCLIMessage(cli, raw);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe("tool_progress");
    expect(calls[0].tool_use_id).toBe("tu-empty-lines");
  });

  it("handles entirely empty/whitespace input without crashing", () => {
    expect(() => bridge.handleCLIMessage(cli, "")).not.toThrow();
    expect(() => bridge.handleCLIMessage(cli, "\n\n\n")).not.toThrow();
    expect(() => bridge.handleCLIMessage(cli, "   \t  \n  ")).not.toThrow();
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("processes valid lines around whitespace-only lines", () => {
    const line1 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-ws-1",
      tool_name: "Read",
      parent_tool_use_id: null,
      elapsed_time_seconds: 1,
      uuid: "uuid-ws-1",
      session_id: "s1",
    });
    const line2 = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-ws-2",
      tool_name: "Edit",
      parent_tool_use_id: null,
      elapsed_time_seconds: 2,
      uuid: "uuid-ws-2",
      session_id: "s1",
    });

    const raw = line1 + "\n   \n\n" + line2 + "\n";
    bridge.handleCLIMessage(cli, raw);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const progressMsgs = calls.filter((c: any) => c.type === "tool_progress");
    expect(progressMsgs).toHaveLength(2);
    expect(progressMsgs[0].tool_use_id).toBe("tu-ws-1");
    expect(progressMsgs[1].tool_use_id).toBe("tu-ws-2");
  });
});

// ─── Session not found scenarios ──────────────────────────────────────────────

describe("Session not found scenarios", () => {
  it("handleCLIMessage does nothing for unknown session", () => {
    const cli = makeCliSocket("unknown-session");
    // Do NOT call handleCLIOpen — session does not exist in the bridge

    expect(() => {
      bridge.handleCLIMessage(cli, JSON.stringify({
        type: "tool_progress",
        tool_use_id: "tu-unknown",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 1,
        uuid: "uuid-unknown",
        session_id: "unknown-session",
      }));
    }).not.toThrow();

    // Session should not have been created
    expect(bridge.getSession("unknown-session")).toBeUndefined();
  });

  it("handleCLIClose does nothing for unknown session", () => {
    const cli = makeCliSocket("nonexistent");

    expect(() => {
      bridge.handleCLIClose(cli);
    }).not.toThrow();

    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });

  it("handleBrowserClose does nothing for unknown session", () => {
    const browser = makeBrowserSocket("nonexistent");

    expect(() => {
      bridge.handleBrowserClose(browser);
    }).not.toThrow();

    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });

  it("handleBrowserMessage does nothing for unknown session", () => {
    const browser = makeBrowserSocket("nonexistent");

    expect(() => {
      bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content: "hello",
      }));
    }).not.toThrow();

    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });
});

// ─── Restore from disk with pendingPermissions ───────────────────────────────

describe("Restore from disk with pendingPermissions", () => {
  it("restores sessions with pending permissions as a Map", async () => {
    const pendingPerms: [string, any][] = [
      ["req-restored-1", {
        request_id: "req-restored-1",
        tool_name: "Bash",
        input: { command: "rm -rf /tmp/test" },
        tool_use_id: "tu-restored-1",
        timestamp: 1700000000000,
      }],
      ["req-restored-2", {
        request_id: "req-restored-2",
        tool_name: "Edit",
        input: { file_path: "/test.ts" },
        description: "Edit file",
        tool_use_id: "tu-restored-2",
        agent_id: "agent-1",
        timestamp: 1700000001000,
      }],
    ];

    store.saveSync({
      id: "perm-session",
      state: {
        session_id: "perm-session",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/test",
        tools: ["Bash", "Edit"],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: pendingPerms,
    });

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("perm-session")!;
    expect(session.pendingPermissions).toBeInstanceOf(Map);
    expect(session.pendingPermissions.size).toBe(2);

    const perm1 = session.pendingPermissions.get("req-restored-1")!;
    expect(perm1.tool_name).toBe("Bash");
    expect(perm1.input).toEqual({ command: "rm -rf /tmp/test" });
    expect(perm1.tool_use_id).toBe("tu-restored-1");
    expect(perm1.timestamp).toBe(1700000000000);

    const perm2 = session.pendingPermissions.get("req-restored-2")!;
    expect(perm2.tool_name).toBe("Edit");
    expect(perm2.description).toBe("Edit file");
    expect(perm2.agent_id).toBe("agent-1");
  });

  it("restored pending permissions are sent to newly connected browsers", async () => {
    store.saveSync({
      id: "perm-replay",
      state: {
        session_id: "perm-replay",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/test",
        tools: ["Bash"],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: [
        ["req-replay", {
          request_id: "req-replay",
          tool_name: "Bash",
          input: { command: "echo test" },
          tool_use_id: "tu-replay",
          timestamp: 1700000000000,
        }],
      ],
    });

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back
    await bridge.restoreFromDisk();

    // Connect a CLI so we don't trigger relaunch
    const cli = makeCliSocket("perm-replay");
    bridge.handleCLIOpen(cli, "perm-replay");

    // Now connect a browser and send session_subscribe (permissions are
    // delivered via handleSessionSubscribe, not handleBrowserOpen)
    const browser = makeBrowserSocket("perm-replay");
    bridge.handleBrowserOpen(browser, "perm-replay");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permMsg = calls.find((c: any) => c.type === "permission_request");
    expect(permMsg).toBeDefined();
    expect(permMsg.request.request_id).toBe("req-replay");
    expect(permMsg.request.tool_name).toBe("Bash");
    expect(permMsg.request.input).toEqual({ command: "echo test" });
  });

  it("restores sessions with empty pendingPermissions array", async () => {
    store.saveSync({
      id: "empty-perms",
      state: {
        session_id: "empty-perms",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: [],
    });

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("empty-perms")!;
    expect(session.pendingPermissions).toBeInstanceOf(Map);
    expect(session.pendingPermissions.size).toBe(0);
  });

  it("restores sessions with undefined pendingPermissions", async () => {
    // Simulate a persisted session from an older version that lacks pendingPermissions
    store.saveSync({
      id: "no-perms-field",
      state: {
        session_id: "no-perms-field",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/test",
        tools: [],
        permissionMode: "default",
        claude_code_version: "1.0",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      // Cast to bypass TypeScript — simulating missing field from older persisted data
      pendingPermissions: undefined as any,
    });

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("no-perms-field")!;
    expect(session.pendingPermissions).toBeInstanceOf(Map);
    expect(session.pendingPermissions.size).toBe(0);
  });
});


// ─── broadcastNameUpdate ──────────────────────────────────────────────────────

describe("broadcastNameUpdate", () => {
  it("sends session_name_update to connected browsers", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");

    bridge.broadcastNameUpdate("s1", "Fix Auth Bug");

    const calls1 = browser1.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const calls2 = browser2.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls1).toContainEqual(expect.objectContaining({ type: "session_name_update", name: "Fix Auth Bug" }));
    expect(calls2).toContainEqual(expect.objectContaining({ type: "session_name_update", name: "Fix Auth Bug" }));
  });

  it("does nothing for unknown sessions", () => {
    // Should not throw
    bridge.broadcastNameUpdate("nonexistent", "Name");
  });
});

describe("session order updates", () => {
  it("broadcastSessionOrderUpdate sends the latest order to connected browsers", () => {
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s2");
    browser1.send.mockClear();
    browser2.send.mockClear();

    const snapshot = bridge.updateSessionOrder("/repo-a", ["s2", "s1"]);
    expect(snapshot).toEqual({ "/repo-a": ["s2", "s1"] });

    bridge.broadcastSessionOrderUpdate();

    const calls1 = browser1.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const calls2 = browser2.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls1).toContainEqual({
      type: "session_order_update",
      sessionOrder: { "/repo-a": ["s2", "s1"] },
    });
    expect(calls2).toContainEqual({
      type: "session_order_update",
      sessionOrder: { "/repo-a": ["s2", "s1"] },
    });
  });
});

describe("group order updates", () => {
  it("broadcastGroupOrderUpdate sends the latest order to connected browsers", () => {
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s2");
    browser1.send.mockClear();
    browser2.send.mockClear();

    const snapshot = bridge.updateGroupOrder(["/repo-c", "/repo-a", "/repo-b"]);
    expect(snapshot).toEqual(["/repo-c", "/repo-a", "/repo-b"]);

    bridge.broadcastGroupOrderUpdate();

    const calls1 = browser1.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const calls2 = browser2.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls1).toContainEqual({
      type: "group_order_update",
      groupOrder: ["/repo-c", "/repo-a", "/repo-b"],
    });
    expect(calls2).toContainEqual({
      type: "group_order_update",
      groupOrder: ["/repo-c", "/repo-a", "/repo-b"],
    });
  });
});

// ─── MCP Control Messages ────────────────────────────────────────────────────

describe("MCP control messages", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());
    cli.send.mockClear();
    browser.send.mockClear();
  });

  it("mcp_get_status: sends mcp_status control_request to CLI", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_get_status",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("mcp_status");
  });

  it("mcp_toggle: sends mcp_toggle control_request to CLI", () => {
    // Use vi.useFakeTimers to prevent the delayed mcp_get_status
    vi.useFakeTimers();
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_toggle",
      serverName: "my-server",
      enabled: false,
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("mcp_toggle");
    expect(sent.request.serverName).toBe("my-server");
    expect(sent.request.enabled).toBe(false);
    vi.useRealTimers();
  });

  it("mcp_reconnect: sends mcp_reconnect control_request to CLI", () => {
    vi.useFakeTimers();
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_reconnect",
      serverName: "failing-server",
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("mcp_reconnect");
    expect(sent.request.serverName).toBe("failing-server");
    vi.useRealTimers();
  });

  it("control_response for mcp_status: broadcasts mcp_status to browsers", () => {
    // Send mcp_get_status to create the pending request
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_get_status",
    }));
    browser.send.mockClear();

    // Simulate CLI responding with control_response
    const mockServers = [
      {
        name: "test-server",
        status: "connected",
        config: { type: "stdio", command: "node", args: ["server.js"] },
        scope: "project",
        tools: [{ name: "myTool" }],
      },
    ];

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "test-uuid",
        response: { mcpServers: mockServers },
      },
    }));

    expect(browser.send).toHaveBeenCalledTimes(1);
    const browserMsg = JSON.parse(browser.send.mock.calls[0][0] as string);
    expect(browserMsg.type).toBe("mcp_status");
    expect(browserMsg.servers).toHaveLength(1);
    expect(browserMsg.servers[0].name).toBe("test-server");
    expect(browserMsg.servers[0].status).toBe("connected");
    expect(browserMsg.servers[0].tools).toHaveLength(1);
  });

  it("control_response with error: does not broadcast to browsers", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_get_status",
    }));
    browser.send.mockClear();

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "test-uuid",
        error: "MCP not available",
      },
    }));

    // Should not broadcast anything
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("control_response for unknown request_id: ignored silently", () => {
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "unknown-id",
        response: { mcpServers: [] },
      },
    }));

    // Should not throw and not send anything
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("mcp_set_servers: sends mcp_set_servers control_request to CLI", () => {
    vi.useFakeTimers();
    const servers = {
      "my-notes": {
        type: "stdio" as const,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
      },
    };
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "mcp_set_servers",
      servers,
    }));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("mcp_set_servers");
    expect(sent.request.servers).toEqual(servers);
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

// ─── compact_boundary handling ──────────────────────────────────────────────

describe("compact_boundary handling", () => {
  it("appends compact_marker to messageHistory (preserving old messages) when compact_boundary is received", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Send init + an assistant message so history is non-empty
    bridge.handleCLIMessage(cli, makeInitMsg());
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "msg-1", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "hello" }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    // Verify history has the assistant message
    const sessionBefore = bridge.getOrCreateSession("s1");
    const historyLenBefore = sessionBefore.messageHistory.length;
    expect(historyLenBefore).toBeGreaterThan(0);

    // Send compact_boundary with metadata
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 50000 },
      uuid: "u3",
      session_id: "cli-123",
    }));

    // History should have old messages PLUS the new compact_marker appended
    const sessionAfter = bridge.getOrCreateSession("s1");
    expect(sessionAfter.messageHistory.length).toBe(historyLenBefore + 1);
    const lastEntry = sessionAfter.messageHistory[sessionAfter.messageHistory.length - 1];
    expect(lastEntry.type).toBe("compact_marker");
    const marker = lastEntry as any;
    expect(marker.trigger).toBe("manual");
    expect(marker.preTokens).toBe(50000);
    expect(marker.id).toMatch(/^compact-boundary-/);
  });

  it("updates context_used_percent from compact_boundary pre_tokens", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ model: "claude-opus-4-6" }));
    browser.send.mockClear();

    const session = bridge.getOrCreateSession("s1");
    session.state.context_used_percent = 68;

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 167048 },
      uuid: "u-ctx-compact",
      session_id: "cli-123",
    }));

    // 167048 / 200000 * 100 = 84
    expect(bridge.getOrCreateSession("s1").state.context_used_percent).toBe(84);
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const contextUpdate = calls.find((m: any) => m.type === "session_update" && m.session?.context_used_percent === 84);
    expect(contextUpdate).toBeDefined();
  });

  it("supports multiple compactions creating multiple compact_markers in history", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send an assistant message
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "msg-a", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "first response" }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "ua",
      session_id: "cli-123",
    }));

    // First compaction
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 30000 },
      uuid: "uc1",
      session_id: "cli-123",
    }));

    // Another assistant message after compaction
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "msg-b", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "second response" }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "ub",
      session_id: "cli-123",
    }));

    // Second compaction
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 60000 },
      uuid: "uc2",
      session_id: "cli-123",
    }));

    // History should contain: [assistant(first), compact_marker(1), assistant(second), compact_marker(2)]
    const session = bridge.getOrCreateSession("s1");
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers.length).toBe(2);
    expect((markers[0] as any).preTokens).toBe(30000);
    expect((markers[1] as any).preTokens).toBe(60000);
  });

  it("deduplicates replayed compact_boundary without uuid when marker is equivalent", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const payload = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 42000 },
      session_id: "cli-123",
    };

    bridge.handleCLIMessage(cli, JSON.stringify(payload));
    bridge.handleCLIMessage(cli, JSON.stringify(payload));

    const session = bridge.getOrCreateSession("s1");
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).trigger).toBe("manual");
    expect((markers[0] as any).preTokens).toBe(42000);
  });

  it("deduplicates equivalent replayed compact_boundary even when uuid changes", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 64000 },
      uuid: "compact-uuid-1",
      session_id: "cli-123",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 64000 },
      uuid: "compact-uuid-2",
      session_id: "cli-123",
    }));

    const session = bridge.getOrCreateSession("s1");
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).trigger).toBe("auto");
    expect((markers[0] as any).preTokens).toBe(64000);
  });

  it("broadcasts compact_boundary event with metadata to browsers", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Subscribe browser so it receives sequenced broadcasts
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    bridge.handleCLIMessage(cli, makeInitMsg());
    browser.send.mockClear();

    // Send compact_boundary
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "u4",
      session_id: "cli-123",
    }));

    // Browser should have received a compact_boundary message with metadata
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const compactMsg = calls.find((m: any) => m.type === "compact_boundary");
    expect(compactMsg).toBeTruthy();
    expect(compactMsg.id).toMatch(/^compact-boundary-\d+$/);
    expect(typeof compactMsg.timestamp).toBe("number");
    expect(compactMsg.trigger).toBe("auto");
    expect(compactMsg.preTokens).toBe(80000);
  });

  it("captures compaction summary from next CLI user message and broadcasts compact_summary", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Subscribe browser
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send compact_boundary (sets awaitingCompactSummary)
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto" },
      uuid: "u5",
      session_id: "cli-123",
    }));

    browser.send.mockClear();

    // Send a CLI "user" message with a text block (this is the compaction summary)
    const summaryText = "This session is being continued from a previous conversation. Key context: the user is building a web app.";
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: summaryText }] },
      parent_tool_use_id: null,
      uuid: "u6",
      session_id: "cli-123",
    }));

    // compact_marker in history should now have the summary
    const session = bridge.getOrCreateSession("s1");
    const marker = session.messageHistory.find((m) => m.type === "compact_marker") as any;
    expect(marker).toBeTruthy();
    expect(marker.summary).toBe(summaryText);

    // Browser should have received a compact_summary event
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const summaryMsg = calls.find((m: any) => m.type === "compact_summary");
    expect(summaryMsg).toBeTruthy();
    expect(summaryMsg.summary).toBe(summaryText);

    // awaitingCompactSummary should be cleared
    expect(session.awaitingCompactSummary).toBe(false);
  });

  it("captures compaction summary from a plain string content (CLI actual format)", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send compact_boundary
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 60000 },
      uuid: "u-str-1",
      session_id: "cli-123",
    }));

    browser.send.mockClear();

    // CLI sends the summary as a plain string (not an array of content blocks)
    const summaryText = "This session is being continued from a previous conversation. The user is building a web UI.";
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: summaryText },
      parent_tool_use_id: null,
      uuid: "u-str-2",
      session_id: "cli-123",
    }));

    // compact_marker in history should have the summary
    const session = bridge.getOrCreateSession("s1");
    const marker = session.messageHistory.find((m) => m.type === "compact_marker") as any;
    expect(marker).toBeTruthy();
    expect(marker.summary).toBe(summaryText);

    // Browser should have received compact_summary
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const summaryMsg = calls.find((m: any) => m.type === "compact_summary");
    expect(summaryMsg).toBeTruthy();
    expect(summaryMsg.summary).toBe(summaryText);

    // awaitingCompactSummary should be cleared
    expect(session.awaitingCompactSummary).toBe(false);
  });

  it("attaches summary to the LAST compact_marker when multiple compactions occurred (findLast)", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // First compaction
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 30000 },
      uuid: "uf1",
      session_id: "cli-123",
    }));

    // Provide summary for first compaction
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: "First compaction summary" },
      parent_tool_use_id: null,
      uuid: "uf2",
      session_id: "cli-123",
    }));

    // Some more messages between compactions
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "msg-mid", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "middle" }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "uf3",
      session_id: "cli-123",
    }));

    // Second compaction
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 60000 },
      uuid: "uf4",
      session_id: "cli-123",
    }));

    // Provide summary for second compaction — should attach to the LAST marker
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: "Second compaction summary" },
      parent_tool_use_id: null,
      uuid: "uf5",
      session_id: "cli-123",
    }));

    const session = bridge.getOrCreateSession("s1");
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers.length).toBe(2);
    // First marker should have its own summary
    expect((markers[0] as any).summary).toBe("First compaction summary");
    // Second marker should have the second summary (findLast ensures this)
    expect((markers[1] as any).summary).toBe("Second compaction summary");
  });

  it("processes normal tool_result user messages after summary is captured", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send compact_boundary
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual" },
      uuid: "u7",
      session_id: "cli-123",
    }));

    // Send summary (consumes awaitingCompactSummary)
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Summary text" }] },
      parent_tool_use_id: null,
      uuid: "u8",
      session_id: "cli-123",
    }));

    // Now send a normal tool_result user message — should be handled normally
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "result data" }] },
      parent_tool_use_id: null,
      uuid: "u9",
      session_id: "cli-123",
    }));

    // The tool_result_preview should be in history (not silently dropped)
    const session = bridge.getOrCreateSession("s1");
    const previewMsg = session.messageHistory.find((m) => m.type === "tool_result_preview");
    expect(previewMsg).toBeTruthy();
  });
});

// ─── Codex compaction marker synthesis ───────────────────────────────────────

describe("Codex compaction marker synthesis", () => {
  // Codex sessions don't emit compact_boundary like Claude Code. Instead, the
  // server synthesizes a compact_marker in messageHistory when it sees the
  // status_change to "compacting", so the chat UI shows the compaction divider.

  it("appends compact_marker to messageHistory when Codex status changes to compacting", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");

    // Simulate Codex status_change to compacting
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const session = bridge.getSession("s1")!;
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    const marker = markers[0] as any;
    expect(marker.id).toMatch(/^compact-boundary-/);
    expect(typeof marker.timestamp).toBe("number");
  });

  it("broadcasts compact_boundary to browsers when Codex compaction starts", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const compactMsg = calls.find((m: any) => m.type === "compact_boundary");
    expect(compactMsg).toBeTruthy();
    expect(compactMsg.id).toMatch(/^compact-boundary-\d+$/);
    expect(typeof compactMsg.timestamp).toBe("number");
  });

  it("does not duplicate compact_marker on re-notification of same compacting status", () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    // First compacting notification
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    // Re-notification (same status)
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const session = bridge.getSession("s1")!;
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
  });
});

// ─── compaction_finished herd event ──────────────────────────────────────────

describe("compaction_finished herd event", () => {
  it("emits compaction_finished when Claude Code exits compacting state", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Enter compacting
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
    }));

    // Exit compacting
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "status",
      status: "idle",
    }));

    const finishedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_finished");
    expect(finishedCalls).toHaveLength(1);
    spy.mockRestore();
  });

  it("emits compaction_finished when Codex exits compacting state", () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Enter compacting
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    // Exit compacting
    adapter.emitBrowserMessage({ type: "status_change", status: "idle" });

    const finishedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_finished");
    expect(finishedCalls).toHaveLength(1);
    spy.mockRestore();
  });

  it("includes context_used_percent in compaction_finished event data", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Set context usage on the session
    const session = bridge.getSession("s1")!;
    session.state.context_used_percent = 85;

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Enter then exit compacting
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system", subtype: "status", status: "compacting",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system", subtype: "status", status: "idle",
    }));

    const finishedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_finished");
    expect(finishedCalls).toHaveLength(1);
    expect(finishedCalls[0][2]).toEqual({ context_used_percent: 85 });
    spy.mockRestore();
  });

  it("does not emit compaction_finished during CLI resume replay", () => {
    vi.useFakeTimers();

    // Create session with existing history to trigger cliResuming
    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous" } as any);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    expect(session.cliResuming).toBe(true);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Replayed system.init
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Replayed compacting status (suppressed by cliResuming guard)
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system", subtype: "status", status: "compacting",
    }));
    // Replayed idle status
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system", subtype: "status", status: "idle",
    }));

    // Neither compaction_started nor compaction_finished should be emitted
    const compactionCalls = spy.mock.calls.filter(
      ([, event]) => event === "compaction_started" || event === "compaction_finished",
    );
    expect(compactionCalls).toHaveLength(0);

    spy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

// ─── Compaction does NOT kill generation lifecycle ───────────────────────────

describe("Compaction preserves generation state (regression)", () => {
  // Regression: Claude Code compaction called setGenerating(false, "compaction")
  // which killed the generation lifecycle mid-turn. After compaction, the CLI
  // continued working but isGenerating was false, so the final result was a
  // no-op and the session appeared permanently idle despite active work.

  it("Claude Code: isGenerating stays true during compaction", async () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Start generation via user message
    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "implement the feature",
    }));
    const session = bridge.getSession("s1")!;
    expect(session.isGenerating).toBe(true);

    // CLI enters compaction mid-turn
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
    }));

    // isGenerating must stay true — compaction is NOT a turn boundary
    expect(session.isGenerating).toBe(true);
    expect(session.state.is_compacting).toBe(true);

    // CLI finishes compaction, continues turn
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "status",
      status: "idle",
    }));
    expect(session.state.is_compacting).toBe(false);
    expect(session.isGenerating).toBe(true);

    // Turn ends normally — result properly transitions to idle
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      duration_ms: 5000,
      duration_api_ms: 5000,
      num_turns: 1,
      total_cost_usd: 0.05,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "result-1",
      session_id: "cli-123",
    }));
    expect(session.isGenerating).toBe(false);
  });

  it("Claude Code: compaction mid-tool-call preserves tool state and generation", async () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Start generation
    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "run the tests",
    }));

    // CLI sends assistant message with a tool_use
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-tool",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "tool_use", id: "tool-bash-1", name: "Bash", input: { command: "bun run test" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u-tool",
      session_id: "cli-123",
    }));

    const session = bridge.getSession("s1")!;
    expect(session.isGenerating).toBe(true);
    expect(session.toolStartTimes.has("tool-bash-1")).toBe(true);

    // Compaction starts mid-tool-call
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
    }));

    // Both generation AND tool state must be preserved
    expect(session.isGenerating).toBe(true);
    expect(session.toolStartTimes.has("tool-bash-1")).toBe(true);
    expect(session.state.is_compacting).toBe(true);

    // Compaction finishes
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "status",
      status: "idle",
    }));

    // Still generating, tool still tracked
    expect(session.isGenerating).toBe(true);
    expect(session.toolStartTimes.has("tool-bash-1")).toBe(true);
    expect(session.state.is_compacting).toBe(false);
  });

  it("Codex: isGenerating stays true during compaction status_change", async () => {
    const sid = "s-codex-compact";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-connected" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    // Start generation
    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "implement feature",
    }));
    adapter.emitTurnStarted("turn-codex-compact");
    const session = bridge.getSession(sid)!;
    expect(session.isGenerating).toBe(true);

    // Codex adapter emits compacting status
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.isGenerating).toBe(true);
    expect(session.state.is_compacting).toBe(true);

    // Codex adapter emits compaction finished
    adapter.emitBrowserMessage({ type: "status_change", status: null });
    expect(session.isGenerating).toBe(true);
    expect(session.state.is_compacting).toBe(false);
  });

  it("Codex: compaction mid-tool-call preserves tool tracking", async () => {
    const sid = "s-codex-compact-tool";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-codex-compact-tool" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    // Start generation
    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "run tests",
    }));
    adapter.emitTurnStarted("turn-codex-compact-tool");

    // Codex emits assistant with tool_use
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-agent-tool-1",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "tool_use", id: "cmd_test", name: "Bash", input: { command: "bun run test" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    const session = bridge.getSession(sid)!;
    expect(session.toolStartTimes.has("cmd_test")).toBe(true);

    // Compaction starts mid-tool-call
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    // Tool state and generation must survive compaction
    expect(session.isGenerating).toBe(true);
    expect(session.toolStartTimes.has("cmd_test")).toBe(true);
    expect(session.state.is_compacting).toBe(true);

    // Compaction finishes
    adapter.emitBrowserMessage({ type: "status_change", status: null });
    expect(session.isGenerating).toBe(true);
    expect(session.toolStartTimes.has("cmd_test")).toBe(true);
    expect(session.state.is_compacting).toBe(false);
  });
});

// ─── Codex stale turn retry after compaction + disconnect ────────────────────

describe("Codex retries user message when turn is stale after disconnect", () => {
  // Regression: When Codex disconnects during compaction and is relaunched,
  // the resumed thread reports idle but the last turn is inProgress. The
  // bridge must retry the user message so work continues, not silently
  // clear recovery and leave the session idle forever.

  it("retries user message when resumed turn is inProgress but thread is idle", async () => {
    const sid = "s-stale-retry";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-1" });
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-1" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    // Send user message to start the turn
    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "implement the feature and run tests",
    }));

    // Disconnect mid-turn (simulates crash during compaction)
    adapter1.emitDisconnect("turn-compact");

    // Reconnect — resume snapshot shows stale inProgress turn with thread idle
    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-stale",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-stale",
        turnCount: 5,
        threadStatus: "idle",
        lastTurn: {
          id: "turn-compact",
          status: "inProgress",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "implement the feature and run tests" }] },
            { type: "agentMessage", id: "agent-1", text: "I'll start by running the tests." },
            { type: "commandExecution", id: "cmd_test", status: "in_progress", command: ["bun", "run", "test"] },
            { type: "contextCompaction", id: "compact-1" },
          ],
        },
      },
    });

    // The user message must be retried via the adapter (not silently cleared)
    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const firstRetryCall = adapter2.sendBrowserMessage.mock.calls[0];
    expect(firstRetryCall).toBeDefined();
    const retried = ((firstRetryCall as unknown as [any])[0]) as any;
    expect(retried.content).toBe("implement the feature and run tests");
  });

  it("retries image user message when resumed turn is inProgress but thread is idle", async () => {
    const sid = "s-stale-image-retry";
    const adapter1 = makeCodexAdapterMock();
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getTransportPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.transport.jpeg"),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter(sid, adapter1 as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "implement the fix from this screenshot",
      images: [{ media_type: "image/png", data: "image-bytes" }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    adapter1.emitDisconnect("turn-compact-image");

    const adapter2 = makeCodexAdapterMock();
    adapter2.sendBrowserMessage.mockReturnValue(true);
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-stale-image",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-stale-image",
        turnCount: 6,
        threadStatus: "idle",
        lastTurn: {
          id: "turn-compact-image",
          status: "inProgress",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "implement the fix from this screenshot" }] },
            { type: "contextCompaction", id: "compact-1" },
          ],
        },
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_message",
        content: expect.stringContaining("implement the fix from this screenshot"),
        local_images: ["/tmp/companion-images/img-1.transport.jpeg"],
      }),
    );
    const firstImageRetryCall = adapter2.sendBrowserMessage.mock.calls[0];
    expect(firstImageRetryCall).toBeDefined();
    const retried = ((firstImageRetryCall as unknown as [any])[0]) as any;
    expect(retried.images).toBeUndefined();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const retrySkipError = calls.find((c: any) =>
      c.type === "error"
      && typeof c.message === "string"
      && c.message.includes("non-text tool activity"));
    expect(retrySkipError).toBeUndefined();
  });

  it("recovers agent messages before retrying stale turn", async () => {
    // When the last turn has agent messages not yet in history, they should
    // be recovered first. If recovery succeeds, no retry is needed.
    const sid = "s-recover-then-idle";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-recover" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "check status",
    }));
    adapter1.emitDisconnect("turn-recover");

    // Reconnect with agent messages that weren't streamed before disconnect
    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-recover",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-recover",
        turnCount: 3,
        threadStatus: "idle",
        lastTurn: {
          id: "turn-recover",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "check status" }] },
            { type: "agentMessage", id: "item-new-msg", text: "Status looks good. All tests passing." },
          ],
        },
      },
    });

    // Agent message should be recovered and broadcast to browser
    const session = bridge.getSession(sid)!;
    const recovered = session.messageHistory.find(
      (m: any) => m.type === "assistant" && m.message?.id === "codex-agent-item-new-msg",
    );
    expect(recovered).toBeDefined();

    // No retry needed since recovery succeeded
    expect(getPendingCodexTurn(session)).toBeNull();
  });
});

// ─── handleSessionSubscribe — single message_history delivery ───────────────

describe("handleSessionSubscribe — no double message_history", () => {
  it("does NOT send message_history in handleBrowserOpen (even with history present)", () => {
    // CLI must connect first so the session exists when CLI messages arrive
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Add a message to history
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "msg-1", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "hi" }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    // Verify history is non-empty before connecting browser
    const session = bridge.getOrCreateSession("s1");
    expect(session.messageHistory.length).toBeGreaterThan(0);

    // Now connect a browser
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Check that handleBrowserOpen sends session_init but NOT message_history
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const sessionInitMsgs = calls.filter((m: any) => m.type === "session_init");
    const historyMsgs = calls.filter((m: any) => m.type === "message_history");
    expect(sessionInitMsgs.length).toBe(1);
    expect(historyMsgs.length).toBe(0); // message_history NOT sent yet
  });

  it("sends history_sync only after session_subscribe with lastSeq=0", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "msg-1", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "hi" }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Now subscribe with last_seq=0
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    // Should now receive history_sync + state_snapshot
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const historyMsgs = calls.filter((m: any) => m.type === "history_sync");
    expect(historyMsgs.length).toBe(1);

    // state_snapshot should be sent last with authoritative transient state
    const snapshots = calls.filter((m: any) => m.type === "state_snapshot");
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toEqual(expect.objectContaining({
      type: "state_snapshot",
      backendConnected: true,
      permissionMode: expect.any(String),
    }));
  });

  it("includes nextEventSeq in session_init", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const sessionInit = calls.find((m: any) => m.type === "session_init");
    expect(sessionInit).toBeTruthy();
    expect(typeof sessionInit.nextEventSeq).toBe("number");
    expect(sessionInit.nextEventSeq).toBeGreaterThan(0);
  });
});

// ─── state_snapshot on subscribe ─────────────────────────────────────────────

describe("state_snapshot", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
  });

  it("sends state_snapshot after session_subscribe with lastSeq=0", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshots = calls.filter((m: any) => m.type === "state_snapshot");
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].backendConnected).toBe(true);
    expect(snapshots[0].sessionStatus).toBe("idle");
    expect(typeof snapshots[0].permissionMode).toBe("string");
    expect(typeof snapshots[0].askPermission).toBe("boolean");
  });

  it("state_snapshot is the last message sent during subscribe", () => {
    // Add history so multiple messages are sent
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "msg-1", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "hi" }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    // state_snapshot should be the very last message
    expect(calls[calls.length - 1].type).toBe("state_snapshot");
  });

  it("reports sessionStatus as 'running' when session is actively generating", () => {
    // Send a user message (sets isGenerating = true) followed by an assistant message (no result)
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Do something",
    }));
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: { id: "msg-1", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "working..." }], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      parent_tool_use_id: null,
      uuid: "u3",
      session_id: "cli-123",
    }));
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot.sessionStatus).toBe("running");
  });

  it("reports backendConnected as false when CLI is disconnected", () => {
    bridge.handleCLIClose(cli);
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot.backendConnected).toBe(false);
    expect(snapshot.sessionStatus).toBeNull();
  });
});

// ─── permission approval/denial includes request_id ──────────────────────────

describe("permission broadcasts include request_id", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
  });

  it("permission_approved broadcast includes request_id", () => {
    // Create pending permission for a notable tool (ExitPlanMode) so approval is broadcast
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-plan",
      request: {
        subtype: "can_use_tool",
        tool_name: "ExitPlanMode",
        input: {},
        tool_use_id: "tu-plan",
      },
    }));
    browser.send.mockClear();

    // Approve the permission
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-plan",
      behavior: "allow",
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const approved = calls.find((m: any) => m.type === "permission_approved");
    expect(approved).toBeDefined();
    expect(approved.request_id).toBe("req-plan");
    expect(approved.tool_name).toBe("ExitPlanMode");
  });

  it("permission_denied broadcast includes request_id", async () => {
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-deny-test",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /" },
        tool_use_id: "tu-deny-test",
      },
    }));
    await new Promise(r => setTimeout(r, 0)); // flush async handleControlRequest
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "permission_response",
      request_id: "req-deny-test",
      behavior: "deny",
      message: "Nope",
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const denied = calls.find((m: any) => m.type === "permission_denied");
    expect(denied).toBeDefined();
    expect(denied.request_id).toBe("req-deny-test");
    expect(denied.tool_name).toBe("Bash");
  });
});

// ─── AskUserQuestion / ExitPlanMode never auto-approved ───────────────────────

describe("AskUserQuestion is never auto-approved in bypassPermissions mode", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    // Start in bypassPermissions mode — all tools except interactive ones should auto-approve
    bridge.handleCLIMessage(cli, makeInitMsg({ permissionMode: "bypassPermissions" }));

    browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    cli.send.mockClear();
    browser.send.mockClear();
  });

  it("does not auto-approve AskUserQuestion — sends permission_request to browser instead", () => {
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-ask",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Which approach?", options: ["A", "B"] }] },
        tool_use_id: "tu-ask",
      },
    }));

    // CLI should NOT receive an auto-approval control_response
    const cliCalls = cli.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const autoResponse = cliCalls.find((m: any) => m.type === "control_response");
    expect(autoResponse).toBeUndefined();

    // Browser SHOULD receive a permission_request so the user can answer
    const browserCalls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const permReq = browserCalls.find((m: any) => m.type === "permission_request");
    expect(permReq).toBeDefined();
    expect(permReq.request.tool_name).toBe("AskUserQuestion");
  });

  it("does not auto-approve ExitPlanMode — sends permission_request to browser instead", () => {
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-plan",
      request: {
        subtype: "can_use_tool",
        tool_name: "ExitPlanMode",
        input: {},
        tool_use_id: "tu-plan",
      },
    }));

    const cliCalls = cli.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const autoResponse = cliCalls.find((m: any) => m.type === "control_response");
    expect(autoResponse).toBeUndefined();

    const browserCalls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const permReq = browserCalls.find((m: any) => m.type === "permission_request");
    expect(permReq).toBeDefined();
    expect(permReq.request.tool_name).toBe("ExitPlanMode");
  });

  it("still auto-approves regular tools like Edit in bypassPermissions mode", () => {
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "control_request",
      request_id: "req-edit",
      request: {
        subtype: "can_use_tool",
        tool_name: "Edit",
        input: { file_path: "/test/foo.ts", old_string: "a", new_string: "b" },
        tool_use_id: "tu-edit",
      },
    }));

    // CLI should receive an auto-approval
    const cliCalls = cli.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const autoResponse = cliCalls.find((m: any) => m.type === "control_response");
    expect(autoResponse).toBeDefined();
    expect(autoResponse.response.response.behavior).toBe("allow");
  });
});

// ─── status_change broadcast on user_message ─────────────────────────────────

describe("status_change: running on user_message", () => {
  let cli: ReturnType<typeof makeCliSocket>;
  let browser: ReturnType<typeof makeBrowserSocket>;

  beforeEach(() => {
    cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    browser.send.mockClear();
  });

  it("broadcasts user_message and status_change: running when user sends a message", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Hello",
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));

    // Server-authoritative: the user_message is broadcast back to the sender
    const userMsg = calls.find((m: any) => m.type === "user_message");
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe("Hello");
    expect(userMsg.id).toMatch(/^user-/);
    expect(userMsg.timestamp).toEqual(expect.any(Number));

    const statusChange = calls.find((m: any) => m.type === "status_change");
    expect(statusChange).toBeDefined();
    expect(statusChange.status).toBe("running");
  });

  it("does not rebroadcast status_change: running when already generating", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "First message",
    }));
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Second message while still running",
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const statusChanges = calls.filter((m: any) => m.type === "status_change" && m.status === "running");
    expect(statusChanges).toHaveLength(0);
  });

  it("reverts optimistic running to idle after 30s without backend output", () => {
    vi.useFakeTimers();
    try {
      bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content: "Hello",
      }));
      browser.send.mockClear();

      vi.advanceTimersByTime(30_000);

      const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const statusChange = calls.find((m: any) => m.type === "status_change");
      expect(statusChange).toBeDefined();
      expect(statusChange.status).toBe("idle");
      expect(bridge.getSession("s1")?.isGenerating).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels optimistic running timeout when backend output arrives", () => {
    vi.useFakeTimers();
    try {
      bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content: "Hello",
      }));

      // First backend output should cancel the timeout.
      bridge.handleCLIMessage(cli, JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-timeout-cancel",
          role: "assistant",
          content: [{ type: "text", text: "Working..." }],
          model: "claude-sonnet-4-5-20250929",
          stop_reason: null,
        },
      }));
      browser.send.mockClear();

      vi.advanceTimersByTime(30_000);

      const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const idleStatus = calls.find((m: any) => m.type === "status_change" && m.status === "idle");
      expect(idleStatus).toBeUndefined();
      expect(bridge.getSession("s1")?.isGenerating).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks injected herd/takode user messages as running immediately", () => {
    bridge.injectUserMessage("s1", "2 events from 1 session", {
      sessionId: "herd-events",
      sessionLabel: "Herd",
    });

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const statusChange = calls.find((m: any) => m.type === "status_change");
    expect(statusChange).toBeDefined();
    expect(statusChange.status).toBe("running");
  });

  it("broadcasts user_message to all connected browsers", () => {
    // Connect a second browser to the same session
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(browser2, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    browser.send.mockClear();
    browser2.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Hello from browser 1",
    }));

    // Both browsers should receive the user_message broadcast
    const browser1Calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const browser2Calls = browser2.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));

    const b1UserMsg = browser1Calls.find((m: any) => m.type === "user_message");
    const b2UserMsg = browser2Calls.find((m: any) => m.type === "user_message");

    expect(b1UserMsg).toBeDefined();
    expect(b2UserMsg).toBeDefined();
    expect(b1UserMsg.content).toBe("Hello from browser 1");
    expect(b2UserMsg.content).toBe("Hello from browser 1");
    // Same server-assigned ID
    expect(b1UserMsg.id).toBe(b2UserMsg.id);
  });

  it("deriveSessionStatus returns 'running' when user_message sets isGenerating", () => {
    // Send a user message — this sets isGenerating = true
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Hello",
    }));
    browser.send.mockClear();

    // Reconnect a new browser — state_snapshot should report "running"
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(browser2, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const calls = browser2.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot.sessionStatus).toBe("running");
  });

  it("deriveSessionStatus returns 'idle' after result even if history ends with assistant", () => {
    // Send a user message (isGenerating = true)
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Hello",
    }));

    // CLI sends an assistant message
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
        model: "claude-sonnet-4-5-20250929",
        stop_reason: "end_turn",
      },
    }));

    // CLI sends result (isGenerating = false)
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "result",
      total_cost_usd: 0.01,
      num_turns: 1,
    }));
    browser.send.mockClear();

    // Reconnect a new browser — should see "idle" not "running"
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(browser2, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const calls = browser2.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot.sessionStatus).toBe("idle");
  });

  it("deriveSessionStatus returns 'idle' after CLI relaunch (simulating server restart)", () => {
    vi.useFakeTimers();
    // Session was generating when CLI disconnected (interrupted generation)
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Do something",
    }));

    // CLI sends an assistant message mid-generation
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "Working on it..." }],
        model: "claude-sonnet-4-5-20250929",
        stop_reason: null,
      },
    }));

    // CLI disconnects (server restart scenario)
    bridge.handleCLIClose(cli);

    // Grace period expires — this is a real disconnect, not a token refresh
    vi.advanceTimersByTime(16_000);

    // CLI reconnects (like --resume after server restart)
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");
    bridge.handleCLIMessage(cli2, makeInitMsg());
    browser.send.mockClear();

    // Reconnect a new browser — should see "idle" not "running"
    // even though history ends with an assistant message
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(browser2, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const calls = browser2.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot).toBeDefined();
    // Key assertion: after a full relaunch (grace expired), isGenerating is cleared
    expect(snapshot.sessionStatus).toBe("idle");
    expect(snapshot.backendConnected).toBe(true);
    vi.useRealTimers();
  });

  it("state_snapshot includes attention for herded worker sessions when set", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "orch-1" })),
    } as any);

    const session = bridge.getSession("s1")!;
    session.attentionReason = "review";

    browser.send.mockClear();
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot.attentionReason).toBe("review");
  });
});

// ─── Tool call duration tracking ────────────────────────────────────────────

describe("Tool call duration tracking", () => {
  it("includes duration_seconds in tool_result_preview when start time was tracked", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    browser.send.mockClear();

    // Send assistant message with tool_use block
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1", type: "message", role: "assistant", model: "claude",
        content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    // Send tool_result
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file.txt" }] },
      parent_tool_use_id: null,
      uuid: "u3",
      session_id: "cli-123",
    }));

    // Find the tool_result_preview broadcast
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const preview = calls.find((m: any) => m.type === "tool_result_preview");
    expect(preview).toBeDefined();
    expect(preview.previews[0].tool_use_id).toBe("tu-1");
    // duration_seconds should be a number (>= 0) since start time was recorded
    expect(typeof preview.previews[0].duration_seconds).toBe("number");
    expect(preview.previews[0].duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it("tracks independent durations for parallel tool calls", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    browser.send.mockClear();

    // Send assistant with two parallel tool_use blocks
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1", type: "message", role: "assistant", model: "claude",
        content: [
          { type: "tool_use", id: "tu-a", name: "Grep", input: { pattern: "foo" } },
          { type: "tool_use", id: "tu-b", name: "Glob", input: { pattern: "*.ts" } },
        ],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    // Send tool_result for both
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu-a", content: "match1" },
        { type: "tool_result", tool_use_id: "tu-b", content: "match2" },
      ] },
      parent_tool_use_id: null,
      uuid: "u3",
      session_id: "cli-123",
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const preview = calls.find((m: any) => m.type === "tool_result_preview");
    expect(preview).toBeDefined();
    expect(preview.previews).toHaveLength(2);
    // Both should have durations
    expect(typeof preview.previews[0].duration_seconds).toBe("number");
    expect(typeof preview.previews[1].duration_seconds).toBe("number");
  });

  it("sets duration_seconds to undefined when no start time exists", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    browser.send.mockClear();

    // Send tool_result WITHOUT a preceding tool_use (simulates server restart)
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-orphan", content: "data" }] },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const preview = calls.find((m: any) => m.type === "tool_result_preview");
    expect(preview).toBeDefined();
    expect(preview.previews[0].duration_seconds).toBeUndefined();
  });

  it("cleans up toolStartTimes after tool_result is processed", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send tool_use
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1", type: "message", role: "assistant", model: "claude",
        content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "a.txt" } }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    const session = bridge.getOrCreateSession("s1");
    expect(session.toolStartTimes.has("tu-1")).toBe(true);

    // Send tool_result
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "contents" }] },
      parent_tool_use_id: null,
      uuid: "u3",
      session_id: "cli-123",
    }));

    // Start time should be cleaned up
    expect(session.toolStartTimes.has("tu-1")).toBe(false);
  });

  it("persists duration_seconds in messageHistory for replay", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send tool_use + tool_result
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1", type: "message", role: "assistant", model: "claude",
        content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "test" } }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] },
      parent_tool_use_id: null,
      uuid: "u3",
      session_id: "cli-123",
    }));

    // Check messageHistory contains the preview with duration
    const session = bridge.getOrCreateSession("s1");
    const previewMsg = session.messageHistory.find((m) => m.type === "tool_result_preview") as any;
    expect(previewMsg).toBeDefined();
    expect(typeof previewMsg.previews[0].duration_seconds).toBe("number");
  });

  it("includes tool_start_times in assistant broadcasts for tool_use blocks", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    browser.send.mockClear();

    // Send assistant message with tool_use blocks
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1", type: "message", role: "assistant", model: "claude",
        content: [
          { type: "tool_use", id: "tu-a", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "tu-b", name: "Read", input: { file_path: "x.ts" } },
        ],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    // Find the assistant broadcast
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const assistantMsg = calls.find((m: any) => m.type === "assistant");
    expect(assistantMsg).toBeDefined();
    // tool_start_times should be present with timestamps for both tool_use blocks
    expect(assistantMsg.tool_start_times).toBeDefined();
    expect(typeof assistantMsg.tool_start_times["tu-a"]).toBe("number");
    expect(typeof assistantMsg.tool_start_times["tu-b"]).toBe("number");
  });

  it("does not include tool_start_times when assistant message has no tool_use blocks", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    browser.send.mockClear();

    // Send assistant message with only text (no tool_use)
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1", type: "message", role: "assistant", model: "claude",
        content: [{ type: "text", text: "Hello" }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u2",
      session_id: "cli-123",
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const assistantMsg = calls.find((m: any) => m.type === "assistant");
    expect(assistantMsg).toBeDefined();
    // tool_start_times should NOT be present
    expect(assistantMsg.tool_start_times).toBeUndefined();
  });

  it("refreshes assistant timestamp when re-broadcasting accumulated content", () => {
    vi.useFakeTimers();
    try {
      const cli = makeCliSocket("s1");
      bridge.handleCLIOpen(cli, "s1");
      bridge.handleCLIMessage(cli, makeInitMsg());

      const browser = makeBrowserSocket("s1");
      bridge.handleBrowserOpen(browser, "s1");
      bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
      browser.send.mockClear();

      vi.setSystemTime(new Date(1700000000000));
      bridge.handleCLIMessage(cli, JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1", type: "message", role: "assistant", model: "claude",
          content: [{ type: "text", text: "Part 1" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }));

      vi.setSystemTime(new Date(1700000005000));
      bridge.handleCLIMessage(cli, JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1", type: "message", role: "assistant", model: "claude",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 12, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "cli-123",
      }));

      const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const assistantMsgs = calls.filter((m: any) => m.type === "assistant");
      expect(assistantMsgs).toHaveLength(2);
      expect(assistantMsgs[0].timestamp).toBe(1700000000000);
      expect(assistantMsgs[1].timestamp).toBe(1700000005000);

      const session = bridge.getOrCreateSession("s1");
      const hist = session.messageHistory.find((m) => m.type === "assistant") as { type: "assistant"; timestamp?: number } | undefined;
      expect(hist?.timestamp).toBe(1700000005000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Diff stats computation and dirty flag ──────────────────────────────────

describe("Diff stats computation", () => {
  it("computeDiffStats: uses merge-base anchor for worktree branch refs", async () => {
    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    (session as any).backendSocket = { send: vi.fn() };

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat-wt-1234\n";
      if (cmd.includes("rev-parse HEAD")) return "head-sha-1\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/feat-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base jiayi HEAD")) return "wt-anchor-sha\n";
      if (cmd.includes("diff --numstat wt-anchor-sha")) return "7\t2\tsrc/file.ts\n";
      return "";
    });

    bridge.setDiffBaseBranch("s1", "jiayi");

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(7);
      expect(session.state.total_lines_removed).toBe(2);
    });
  });

  it("computeDiffStats: compares directly to selected commit SHA in worktree mode", async () => {
    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.diff_base_branch = "abcdef1234567";
    session.diffStatsDirty = true;
    (session as any).backendSocket = { send: vi.fn() };

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("diff --numstat abcdef1234567")) return "9\t4\tsrc/file.ts\n";
      if (cmd.includes("merge-base --is-ancestor")) return "";
      if (cmd.includes("merge-base abcdef1234567 HEAD")) throw new Error("should not use merge-base for commit refs");
      return "";
    });

    bridge.recomputeDiffIfDirty(session);

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(9);
      expect(session.state.total_lines_removed).toBe(4);
    });
  });

  it("computeDiffStats: uses diff_base_start_sha for worktree sessions", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("diff --numstat base-start-sha")) return "4\t1\tsrc/app.ts\n2\t0\tsrc/util.ts\n";
      if (cmd.includes("merge-base")) throw new Error("should not call merge-base for anchored worktree diff");
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.diff_base_start_sha = "base-start-sha";
    session.diffStatsDirty = true;
    (session as any).backendSocket = { send: vi.fn() };

    bridge.recomputeDiffIfDirty(session);

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(6);
      expect(session.state.total_lines_removed).toBe(1);
    });
  });

  it("re-anchors worktree diff base to merge-base after base ref changes", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/rebased\n";
      if (cmd.includes("rev-parse HEAD")) return "new-head-sha\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/feat-rebased\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base jiayi HEAD")) return "rebased-anchor-sha\n";
      if (cmd.includes("diff --numstat rebased-anchor-sha")) return "3\t1\tsrc/rebased.ts\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.git_head_sha = "old-head-sha";
    session.state.diff_base_start_sha = "old-anchor-sha";
    session.diffStatsDirty = true;
    (session as any).backendSocket = { send: vi.fn() };

    bridge.setDiffBaseBranch("s1", "jiayi");

    await vi.waitFor(() => {
      expect(session.state.diff_base_start_sha).toBe("rebased-anchor-sha");
      expect(session.state.total_lines_added).toBe(3);
      expect(session.state.total_lines_removed).toBe(1);
    });
  });

  it("computeDiffStats: parses git diff --numstat output correctly", async () => {
    // Set up a session with diff_base_branch and tracked files
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "10\t3\tfile1.ts\n5\t2\tfile2.ts\n-\t-\timage.png\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;

    // Set cwd so computeDiffStats can run
    session.state.cwd = "/tmp/wt";
    // Ensure the session has a CLI socket so recomputeDiffIfDirty doesn't skip
    (session as any).backendSocket = { send: vi.fn() };

    // Use setDiffBaseBranch which triggers computeDiff
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/feat-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "10\t3\tfile1.ts\n5\t2\tfile2.ts\n-\t-\timage.png\n";
      return "";
    });

    bridge.setDiffBaseBranch("s1", "develop");

    // Async diff computation needs a tick to resolve
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(15);
      expect(session.state.total_lines_removed).toBe(5);
    });
  });

  it("computeDiffStats: handles empty diff gracefully", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";

    bridge.setDiffBaseBranch("s1", "main");

    expect(session.state.total_lines_added).toBe(0);
    expect(session.state.total_lines_removed).toBe(0);
  });

  it("recomputeDiffIfDirty: skips when flag is clean, recomputes when dirty", async () => {
    // Session with diff base set up so computeDiffStatsAsync can run
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "10\t3\tfile.ts\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "main");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    // Ensure the session has a CLI socket so refreshGitInfo/recomputeDiffIfDirty don't skip
    (session as any).backendSocket = { send: vi.fn() };
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");

    // Dirty by default — recompute should run
    expect(session.diffStatsDirty).toBe(true);
    bridge.recomputeDiffIfDirty(session);
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(10);
      expect(session.state.total_lines_removed).toBe(3);
    });
    // Flag cleared after successful computation
    expect(session.diffStatsDirty).toBe(false);

    // Change mock — but flag is clean, so recompute should be skipped
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "99\t88\tfile.ts\n";
      return "";
    });

    bridge.recomputeDiffIfDirty(session);
    // Give it a tick — values should NOT change since flag is clean
    await new Promise((r) => setTimeout(r, 50));
    expect(session.state.total_lines_added).toBe(10); // unchanged

    // Mark dirty again — recompute should pick up new values
    session.diffStatsDirty = true;
    bridge.recomputeDiffIfDirty(session);
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(99);
      expect(session.state.total_lines_removed).toBe(88);
    });
    expect(session.diffStatsDirty).toBe(false);
  });

  it("recomputes dirty diff stats when CLI reconnects after browser-open skip", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/reconnect\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "6\t2\tsrc/app.ts\n";
      return "";
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "main";
    session.state.total_lines_added = 0;
    session.state.total_lines_removed = 0;
    session.diffStatsDirty = true;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // No backend yet, so the browser-open recompute path is skipped.
    expect(session.state.total_lines_added).toBe(0);
    expect(session.diffStatsDirty).toBe(true);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(6);
      expect(session.state.total_lines_removed).toBe(2);
    });
    expect(session.diffStatsDirty).toBe(false);
  });

  it("recomputes diff stats on browser open for disconnected worktree sessions", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/jiayi-wt-1\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("rev-parse HEAD")) return "new-head-sha\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "new-head-sha\n";
      if (cmd.includes("diff --numstat")) return "\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.diff_base_start_sha = "old-anchor-sha";
    session.state.git_head_sha = "old-head-sha";
    session.diffStatsDirty = true;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await vi.waitFor(() => {
      expect(session.state.diff_base_start_sha).toBe("new-head-sha");
      expect(session.state.total_lines_added).toBe(0);
      expect(session.state.total_lines_removed).toBe(0);
    });
    expect(session.diffStatsDirty).toBe(false);
  });

  it("non-read-only tool marks diffStatsDirty; read-only tool does not", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      return "";
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    const session = bridge.getSession("s1")!;
    // Clear dirty flag from initialization
    session.diffStatsDirty = false;

    // Read-only tool (e.g. Read) should NOT mark dirty
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-read",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [{
          type: "tool_use",
          id: "tool-read",
          name: "Read",
          input: { file_path: "/repo/file.ts" },
        }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u-read",
      session_id: "s1",
    }));
    expect(session.diffStatsDirty).toBe(false);

    // Non-read-only tool (Edit) should mark dirty and track the file
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-edit",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [{
          type: "tool_use",
          id: "tool-edit",
          name: "Edit",
          input: { file_path: "/repo/file.ts", old_string: "a", new_string: "b" },
        }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u-edit",
      session_id: "s1",
    }));
    expect(session.diffStatsDirty).toBe(true);

    // Bash tool (not in READ_ONLY_TOOLS) should also mark dirty
    session.diffStatsDirty = false;
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-bash",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [{
          type: "tool_use",
          id: "tool-bash",
          name: "Bash",
          input: { command: "echo hello" },
        }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      uuid: "u-bash",
      session_id: "s1",
    }));
    expect(session.diffStatsDirty).toBe(true);
  });

  it("resolveGitInfo: uses diff_base_branch directly for ahead/behind (no @{upstream} fallback)", async () => {
    // Session with diff_base_branch pre-set — resolveGitInfo should use it directly
    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      // Verify the ref used is "jiayi" (from diff_base_branch), not "@{upstream}"
      if (cmd.includes("--left-right --count") && cmd.includes("jiayi...HEAD")) return "2\t3\n";
      if (cmd.includes("--left-right --count")) throw new Error("wrong ref used");
      return "";
    });

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/tmp/wt" }));

    // resolveGitInfo is async (fire-and-forget) — wait for it to complete
    await vi.waitFor(() => {
      expect(session.state.git_ahead).toBe(3);
      expect(session.state.git_behind).toBe(2);
      expect(session.state.diff_base_branch).toBe("jiayi");
    });
  });
});

describe("Codex adapter result handling", () => {
  it("ignores codex session_update line counters and keeps server-computed diff stats authoritative", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const session = bridge.getSession("s1")!;
    session.state.total_lines_added = 12;
    session.state.total_lines_removed = 4;

    adapter.emitBrowserMessage({
      type: "session_update",
      session: {
        total_lines_added: 34,
        total_lines_removed: 9,
        context_used_percent: 27,
      },
    });

    expect(session.state.total_lines_added).toBe(12);
    expect(session.state.total_lines_removed).toBe(4);
    expect(session.state.context_used_percent).toBe(27);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const update = calls.find((c: any) => c.type === "session_update");
    expect(update).toBeDefined();
    expect(update.session.total_lines_added).toBeUndefined();
    expect(update.session.total_lines_removed).toBeUndefined();
    expect(update.session.context_used_percent).toBe(27);
  });

  it("recomputes dirty diff stats on codex session_init", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    session.diffStatsDirty = true;
    session.state.total_lines_added = 0;
    session.state.total_lines_removed = 0;

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/codex\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/test\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "9\t4\tsrc/main.ts\n";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      return "";
    });

    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        cwd: "/test",
        model: "gpt-5-codex",
      },
    });

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(9);
      expect(session.state.total_lines_removed).toBe(4);
    });
    expect(session.diffStatsDirty).toBe(false);
  });

  it("recomputes and broadcasts diff stats on codex result", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feat/codex\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/test\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "12\t4\tsrc/app.ts\n";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      return "";
    });

    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        cwd: "/test",
        model: "gpt-5-codex",
      },
    });

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        duration_ms: 1000,
        duration_api_ms: 1000,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "codex-result-1",
        session_id: "s1",
      },
    });

    await vi.waitFor(() => {
      const state = bridge.getSession("s1")!.state;
      expect(state.total_lines_added).toBe(12);
      expect(state.total_lines_removed).toBe(4);
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const resultBroadcasts = calls.filter((c: any) => c.type === "result");
    expect(resultBroadcasts).toHaveLength(1);
    const diffUpdate = calls.find((c: any) =>
      c.type === "session_update"
      && c.session?.total_lines_added === 12
      && c.session?.total_lines_removed === 4,
    );
    expect(diffUpdate).toBeDefined();
  });

  it("converts codex assistant tool_result into tool_result_preview and suppresses raw tool_result bubble", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "asst-1",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "sed: can't read missing.ts: No such file or directory\nExit code: 2",
            is_error: true,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((c: any) => c.type === "assistant")).toBeUndefined();

    const previewMsg = calls.find((c: any) => c.type === "tool_result_preview");
    expect(previewMsg).toBeDefined();
    expect(previewMsg.previews[0].tool_use_id).toBe("tool-1");
    expect(previewMsg.previews[0].is_error).toBe(true);
    expect(previewMsg.previews[0].content).toContain("No such file or directory");

    const session = bridge.getSession("s1")!;
    expect(session.toolResults.get("tool-1")?.content).toContain("Exit code: 2");
  });

  it("tags codex leader assistant @to(user) messages as leader_user_addressed", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "asst-leader-1",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [{ type: "text", text: "I have queued tasks for workers. @to(user)" }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const assistantBroadcast = calls.find((c: any) => c.type === "assistant");
    expect(assistantBroadcast?.leader_user_addressed).toBe(true);

    const histAssistant = bridge.getSession("s1")!.messageHistory.find((m: any) => m.type === "assistant") as any;
    expect(histAssistant?.leader_user_addressed).toBe(true);
  });

  it("deduplicates replayed Codex assistant messages with identical timestamp and content", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const replayTimestamp = 1700000000123;
    const replayedText = "Investigating reconnect behavior.";

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-replay-original",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [{ type: "text", text: replayedText }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: replayTimestamp,
    });

    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-replay-duplicate",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [{ type: "text", text: replayedText }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: replayTimestamp,
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.filter((c: any) => c.type === "assistant")).toHaveLength(0);

    const assistantHistory = bridge.getSession("s1")!.messageHistory.filter((m: any) => m.type === "assistant");
    expect(assistantHistory).toHaveLength(1);
  });

  it("deduplicates Codex assistant messages with different IDs but same content within 15s window", () => {
    // When Codex reconnects and replays the same message with a different ID
    // but identical content within the 15-second window, it should be deduped.
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const repeatedText = "Checking reconnect status.";

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-repeat-1",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [{ type: "text", text: repeatedText }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1700000001000,
    });

    // Same content, 1ms later, different ID — should be deduped (within 15s window)
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-repeat-2",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [{ type: "text", text: repeatedText }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1700000001001,
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.filter((c: any) => c.type === "assistant")).toHaveLength(1);

    const assistantHistory = bridge.getSession("s1")!.messageHistory.filter((m: any) => m.type === "assistant");
    expect(assistantHistory).toHaveLength(1);
  });

  it("does not deduplicate legitimate repeated Codex text when timestamp exceeds 15s window", () => {
    // Messages with identical content but timestamps >15s apart are legitimate
    // repeated text, not reconnect replays.
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const repeatedText = "Checking reconnect status.";

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-legit-1",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [{ type: "text", text: repeatedText }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1700000001000,
    });

    // Same content but 20 seconds later — NOT a replay, should be kept
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-legit-2",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [{ type: "text", text: repeatedText }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: 1700000021000,
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.filter((c: any) => c.type === "assistant")).toHaveLength(2);

    const assistantHistory = bridge.getSession("s1")!.messageHistory.filter((m: any) => m.type === "assistant");
    expect(assistantHistory).toHaveLength(2);
  });

  it("reconciles Codex quest claim command into quest chip state and task history", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-tool-1",
            name: "Bash",
            input: { command: "quest claim q-74 --json" },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-end",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-tool-1",
            content: JSON.stringify({
              questId: "q-74",
              title: "Fix Codex quest lifecycle chips",
              status: "in_progress",
            }),
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvent = calls.find((c: any) => c.type === "session_quest_claimed");
    expect(questEvent).toBeDefined();
    expect(questEvent.quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });

    const taskHistoryMsg = calls.find((c: any) => c.type === "session_task_history");
    expect(taskHistoryMsg).toBeDefined();
    expect(taskHistoryMsg.tasks).toHaveLength(1);
    expect(taskHistoryMsg.tasks[0]).toEqual(
      expect.objectContaining({
        source: "quest",
        questId: "q-74",
        title: "Fix Codex quest lifecycle chips",
        action: "new",
      }),
    );
  });

  it("reconciles Codex quest complete command into needs_verification quest state", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.setSessionClaimedQuest("s1", {
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-complete-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-tool-2",
            name: "Bash",
            input: { command: "quest complete q-74 --items \"Verify\" --json" },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-complete-end",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-tool-2",
            content: JSON.stringify({
              questId: "q-74",
              title: "Fix Codex quest lifecycle chips",
              status: "needs_verification",
            }),
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvents = calls.filter((c: any) => c.type === "session_quest_claimed");
    expect(questEvents).toHaveLength(1);
    expect(questEvents[0].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "needs_verification",
    });
  });

  it("ignores quest lifecycle reconciliation when tool output only contains errors", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-start-error",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-tool-err-1",
            name: "Bash",
            input: { command: "quest claim q-74 --json" },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-claim-end-error",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-tool-err-1",
            content: "Error: sessionId is required for in_progress status",
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((c: any) => c.type === "session_quest_claimed")).toBeUndefined();
    expect(calls.find((c: any) => c.type === "session_task_history")).toBeUndefined();
  });

  it("parses quest IDs from jq id fields and prefers the last JSON object in compound output", () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.setSessionClaimedQuest("s1", {
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "in_progress",
    });
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-multi-start",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "quest-tool-multi-1",
            name: "Bash",
            input: {
              command: "quest claim q-74 --json | jq '{id,status}'; quest complete q-74 --items \"Verify\" --json | jq '{id,status}'",
            },
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "quest-multi-end",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_result",
            tool_use_id: "quest-tool-multi-1",
            content: `{
  "id": "q-74-v2",
  "status": "in_progress"
}
{
  "id": "q-74-v3",
  "status": "needs_verification"
}`,
            is_error: false,
          },
        ],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const questEvents = calls.filter((c: any) => c.type === "session_quest_claimed");
    expect(questEvents).toHaveLength(1);
    expect(questEvents[0].quest).toEqual({
      id: "q-74",
      title: "Fix Codex quest lifecycle chips",
      status: "needs_verification",
    });
    expect(calls.find((c: any) => c.type === "session_task_history")).toBeUndefined();
  });
});

describe("Codex turn-start failure re-queue", () => {
  // When the Codex transport closes during turn/start, the adapter fires
  // onTurnStartFailed. The bridge should re-queue the failed message so it
  // gets flushed to the next adapter after relaunch.

  it("registers onTurnStartFailed callback during adapter attachment", () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    expect(adapter.onTurnStartFailed).toHaveBeenCalledOnce();
  });

  it("re-queues the failed message to the Codex outbound-turn queue", () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    void bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "hello" }));

    const failedMsg = { type: "user_message", content: "hello" };
    adapter.emitTurnStartFailed(failedMsg);

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(0);
    expect(getPendingCodexTurn(session)).toMatchObject({
      adapterMsg: failedMsg,
      status: "dispatched",
      dispatchCount: 2,
    });
  });

  it("flushes re-queued message to a new adapter on reattach", () => {
    // First adapter: simulate turn-start failure
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter1 as any);
    emitCodexSessionReady(adapter1);
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    void bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "hello" }));
    adapter1.emitDisconnect();
    adapter1.emitTurnStartFailed({ type: "user_message", content: "hello" });

    // Second adapter: should receive the re-queued message
    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter2 as any);
    emitCodexSessionReady(adapter2, { cliSessionId: "thread-reattach" });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "hello" }),
    );
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(0);
    expect(getPendingCodexTurn(session)).toMatchObject({
      adapterMsg: { type: "user_message", content: "hello" },
      status: "dispatched",
    });
  });

  it("does not flush queued messages before Codex session_meta confirms reconnect", () => {
    // Guards the session-140 regression boundary: queued messages must wait
    // for session_meta so resume reconciliation runs before any replay.
    const session = bridge.getOrCreateSession("s1", "codex");
    session.pendingCodexTurns.push({
      adapterMsg: { type: "user_message", content: "hello again" },
      userMessageId: "queued-before-session-meta",
      userContent: "hello again",
      historyIndex: -1,
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
    } as any);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();

    emitCodexSessionReady(adapter, { cliSessionId: "thread-reattach" });

    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "hello again" }),
    );
    expect(session.pendingMessages).toHaveLength(0);
    expect(getPendingCodexTurn(session)).toMatchObject({
      adapterMsg: { type: "user_message", content: "hello again" },
      status: "dispatched",
    });
  });

  it("flushes stale adapter turn-start failures to the active adapter", () => {
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter1 as any);
    emitCodexSessionReady(adapter1);
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    void bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "replay me" }));

    // Attach a replacement adapter before the old adapter reports failure.
    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter2 as any);
    emitCodexSessionReady(adapter2, { cliSessionId: "thread-active" });

    adapter1.emitTurnStartFailed({ type: "user_message", content: "replay me" });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "replay me" }),
    );
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(0);
    expect(getPendingCodexTurn(session)).toMatchObject({
      adapterMsg: { type: "user_message", content: "replay me" },
      status: "dispatched",
    });
  });
});

describe("Codex disconnect auto-relaunch", () => {
  it("skips disconnect auto-relaunch/failure counting for intentional settings relaunches", async () => {
    vi.useFakeTimers();
    const sid = "s-intentional";
    const crashRelaunchCb = vi.fn();
    const settingsRelaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(crashRelaunchCb);
    bridge.onSessionRelaunchRequestedCallback(settingsRelaunchCb);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_permission_mode",
      mode: "plan",
    }));

    // Simulate the disconnect from the intentional relaunch teardown.
    adapter.emitDisconnect();

    const session = bridge.getSession(sid)!;
    expect(session.consecutiveAdapterFailures).toBe(0);
    expect(crashRelaunchCb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(settingsRelaunchCb).toHaveBeenCalledWith(sid);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected" }));
    vi.useRealTimers();
  });

  it("requests relaunch when Codex adapter disconnects with active browser", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();
    relaunchCb.mockClear();

    adapter.emitDisconnect();

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected" }));
  });

  it("does not request relaunch when no browser is connected", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    adapter.emitDisconnect();

    expect(relaunchCb).not.toHaveBeenCalled();
  });

  it("does not request relaunch for idle-manager disconnects", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ killedByIdleManager: true })),
    } as any);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    adapter.emitDisconnect();

    expect(relaunchCb).not.toHaveBeenCalled();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected", reason: "idle_limit" }));
  });

  it("stops auto-relaunch after repeated reconnect failures even across session_init", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();
    relaunchCb.mockClear();

    for (let i = 0; i < 4; i++) {
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);
      adapter.emitBrowserMessage({
        type: "session_init",
        session: { model: "gpt-5.3-codex" },
      });
      adapter.emitDisconnect();
    }

    expect(relaunchCb).toHaveBeenCalledTimes(3);
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("Session stopped after 3 consecutive launch failures"),
    }));
  });
});

describe("Codex user-message-driven relaunch for idle sessions", () => {
  it("requests relaunch when user message arrives for exited Codex session", async () => {
    // Scenario: Codex completed a turn, exited (code 0), adapter disconnected.
    // User sends a new message — should trigger relaunch so the CLI picks it up.
    const sid = "s-idle-codex";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ state: "exited", killedByIdleManager: false })),
    } as any);

    // Attach and then disconnect the adapter (simulating normal turn completion)
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    adapter.emitDisconnect();
    relaunchCb.mockClear();

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    relaunchCb.mockClear(); // clear any relaunch from handleBrowserOpen
    browser.send.mockClear();

    // Send a user message — should trigger relaunch
    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "continue working",
    }));

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    // Message should be queued in the authoritative Codex turn queue
    const session = bridge.getSession(sid)!;
    expect(session.pendingMessages.length).toBe(0);
    expect(session.pendingCodexTurns.length).toBeGreaterThan(0);
  });

  it("resets consecutiveAdapterFailures on user-message-driven relaunch", async () => {
    // After previous adapter failures, a user message should reset the counter
    // so the session doesn't stay stuck at the failure cap.
    const sid = "s-reset-failures";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ state: "exited", killedByIdleManager: false })),
    } as any);

    // Simulate 3 adapter failures to hit the cap
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    for (let i = 0; i < 3; i++) {
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);
      adapter.emitDisconnect();
    }
    const session = bridge.getSession(sid)!;
    expect(session.consecutiveAdapterFailures).toBe(3);
    relaunchCb.mockClear();

    // Send a user message — should reset failures and trigger relaunch
    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "try again",
    }));

    expect(session.consecutiveAdapterFailures).toBe(0);
    expect(relaunchCb).toHaveBeenCalledWith(sid);
  });

  it("does not request relaunch for exited sessions killed by idle manager", async () => {
    const sid = "s-idle-killed";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ state: "exited", killedByIdleManager: true })),
    } as any);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-connected" });
    adapter.emitDisconnect();
    relaunchCb.mockClear();

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    relaunchCb.mockClear();
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "hello",
    }));

    // Should NOT relaunch — session was intentionally killed by idle manager
    expect(relaunchCb).not.toHaveBeenCalled();
  });

  it("does not request relaunch when adapter is still connected", async () => {
    // If the adapter is connected, messages go directly — no relaunch needed
    const sid = "s-connected";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ state: "connected" })),
    } as any);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-connected" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    relaunchCb.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "this should go to the adapter directly",
    }));

    // Message should go to adapter, not trigger relaunch
    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    expect(relaunchCb).not.toHaveBeenCalled();
  });
});

describe("Codex broken-session recovery regression", () => {
  it("keeps the acknowledged image turn authoritative and blocks later messages after init failure", async () => {
    const sid = "s-image-init-failure";
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
    const adapter1 = makeCodexAdapterMock();
    const imageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-140", media_type: "image/jpeg" }),
      getTransportPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-140.transport.jpeg"),
    };
    bridge.setImageStore(imageStore as any);
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-image-140" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Please inspect this screenshot",
      images: [{ media_type: "image/jpeg", data: "inline-image-data" }],
    }));
    await flush();

    const session = bridge.getSession(sid)!;
    expect(getPendingCodexTurn(session)).toMatchObject({
      adapterMsg: expect.objectContaining({
        type: "user_message",
        local_images: ["/tmp/companion-images/img-140.transport.jpeg"],
        content: expect.stringContaining("/home/jiayiwei/.companion/images/s-image-init-failure/img-140.orig.jpeg"),
      }),
    });

    adapter1.emitTurnStarted("turn-image-140");
    adapter1.emitDisconnect("turn-image-140");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitInitError("Transport closed");

    expect(session.state.backend_state).toBe("broken");
    expect(session.state.backend_error).toBe("Transport closed");
    expect(session.isGenerating).toBe(false);
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "blocked_broken_session",
      turnId: "turn-image-140",
      lastError: "Transport closed",
      userContent: expect.stringContaining("/home/jiayiwei/.companion/images/s-image-init-failure/img-140.orig.jpeg"),
    });

    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Hello",
    }));
    await flush();

    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "blocked_broken_session",
      turnId: "turn-image-140",
      lastError: "Transport closed",
    });
    expect(session.pendingMessages).toHaveLength(0);
    expect(session.pendingCodexTurns[1]).toMatchObject({
      adapterMsg: { type: "user_message", content: "Hello" },
      status: "queued",
    });
    expect(session.isGenerating).toBe(false);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({
      type: "error",
      message: "Codex session is broken. Your message was queued and will run after relaunch.",
    }));
    expect(calls.find((msg: any) => msg.type === "status_change" && msg.status === "running")).toBeUndefined();
  });

  it("defers later queued user turns until the blocked recovery turn is cleared", async () => {
    // When a broken session already has an authoritative blocked turn, later
    // queued user messages must stay queued until that turn completes or is
    // explicitly resolved.
    const sid = "s-broken-queue-order";
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-replay" });
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-original" });

    await bridge.handleBrowserMessage(makeBrowserSocket(sid), JSON.stringify({
      type: "user_message",
      content: "original turn",
    }));
    await flush();

    adapter1.emitTurnStarted("turn-original");
    adapter1.emitDisconnect("turn-original");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitInitError("Transport closed");

    await bridge.handleBrowserMessage(makeBrowserSocket(sid), JSON.stringify({
      type: "user_message",
      content: "queued behind broken turn",
    }));
    await flush();

    const session = bridge.getSession(sid)!;
    const adapter3 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter3 as any);
    adapter3.emitSessionMeta({ cliSessionId: "thread-recovered", model: "gpt-5.3-codex", cwd: "/repo" });

    expect(adapter3.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "queued behind broken turn" }),
    );
    expect(session.pendingMessages).toHaveLength(0);
    expect(session.pendingCodexTurns[1]).toMatchObject({
      adapterMsg: { type: "user_message", content: "queued behind broken turn" },
      status: "queued",
    });

    adapter3.emitBrowserMessage({
      type: "result",
      data: {
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        result: "Recovered",
        session_id: sid,
        stop_reason: "end_turn",
      },
    } as any);

    expect(adapter3.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "queued behind broken turn" }),
    );
  });

  it("ignores stale turn-start and init-error callbacks after a replacement adapter attaches", () => {
    // Replacement adapters should own the session lifecycle. Late callbacks
    // from a stale adapter must not overwrite the active session state.
    const sid = "s-stale-adapter-callbacks";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-compaction" });
    adapter1.emitSessionMeta({ cliSessionId: "thread-old", model: "gpt-5.3-codex", cwd: "/repo" });

    const session = bridge.getSession(sid)!;
    session.pendingCodexTurns = [{
      adapterMsg: { type: "user_message", content: "new turn" },
      userMessageId: "user-1",
      userContent: "new turn",
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
    }] as any;

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({ cliSessionId: "thread-new", model: "gpt-5.3-codex", cwd: "/repo" });

    adapter1.emitTurnStarted("turn-stale");
    adapter1.emitInitError("stale failure");

    expect(getPendingCodexTurn(session)?.turnId).toBeNull();
    expect(session.state.backend_state).toBe("connected");
    expect(session.state.backend_error).toBeNull();
  });
});

describe("Codex resumed-turn recovery", () => {
  it("recovers assistant text from resumed turn instead of retrying", async () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-1" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "please recover this",
    }));

    adapter1.emitDisconnect("turn-123");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-1",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-1",
        turnCount: 10,
        lastTurn: {
          id: "turn-123",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "please recover this" }] },
            { type: "reasoning", summary: ["thinking"] },
            { type: "agentMessage", id: "item-a1", text: "Recovered answer from resumed turn" },
          ],
        },
      },
    });

    const session = bridge.getSession(sid)!;
    expect(getPendingCodexTurn(session)).toBeNull();
    expect(adapter2.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "please recover this" }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const recovered = calls.find((c: any) =>
      c.type === "assistant"
      && c.message?.id === "codex-agent-item-a1"
      && c.message?.content?.[0]?.text === "Recovered answer from resumed turn");
    expect(recovered).toBeDefined();
  });

  it("deduplicates resumed assistant text when codex replays the same item after reconnect", async () => {
    const sid = "s-replay-dedup";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-2" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "recover and replay",
    }));

    adapter1.emitDisconnect("turn-replay");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-replay",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-replay",
        turnCount: 11,
        lastTurn: {
          id: "turn-replay",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "recover and replay" }] },
            { type: "agentMessage", id: "item-replay", text: "Recovered once" },
          ],
        },
      },
    });

    browser.send.mockClear();
    adapter2.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-agent-item-replay",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "text", text: "Recovered once" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: Date.now() + 1000,
    });

    const session = bridge.getSession(sid)!;
    expect(session.messageHistory.filter((msg: any) =>
      msg.type === "assistant" && msg.message?.id === "codex-agent-item-replay")).toHaveLength(1);
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("deduplicates compaction-style resumed assistant snapshots with generic item ids", async () => {
    const sid = "s-compaction-replay-dedup";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-compaction" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "keep going after compaction",
    }));

    const session = bridge.getSession(sid)!;
    session.pendingCodexTurns.push({
      adapterMsg: { type: "user_message", content: "follow-up should stay queued" },
      userMessageId: "follow-up-turn",
      userContent: "follow-up should stay queued",
      historyIndex: 1,
      status: "queued",
      dispatchCount: 0,
      createdAt: 2,
      updatedAt: 2,
      acknowledgedAt: null,
      turnTarget: null,
      lastError: null,
      turnId: null,
      disconnectedAt: null,
      resumeConfirmedAt: null,
    } as any);

    adapter1.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-agent-msg_original_a",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "text", text: "First commentary before compaction" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
    adapter1.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "codex-agent-msg_original_b",
        type: "message",
        role: "assistant",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Second commentary before compaction" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: Date.now() + 1,
    });

    adapter1.emitTurnStarted("turn-compaction");
    adapter1.emitDisconnect("turn-compaction");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    browser.send.mockClear();

    adapter2.emitSessionMeta({
      cliSessionId: "thread-compaction",
      model: "gpt-5.4",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-compaction",
        turnCount: 14,
        lastTurn: {
          id: "turn-compaction",
          status: "inProgress",
          error: null,
          items: [
            { type: "userMessage", id: "item-25", content: [{ type: "text", text: "keep going after compaction" }] },
            { type: "agentMessage", id: "item-26", text: "First commentary before compaction" },
            { type: "agentMessage", id: "item-27", text: "Second commentary before compaction" },
          ],
        },
      },
    });

    expect(getPendingCodexTurn(session)).toMatchObject({
      userContent: "keep going after compaction",
      status: "backend_acknowledged",
      turnId: "turn-compaction",
    });
    expect(session.pendingCodexTurns[1]).toMatchObject({
      userContent: "follow-up should stay queued",
      status: "queued",
    });
    expect(adapter2.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "follow-up should stay queued" }),
    );
    expect(session.messageHistory.filter((msg: any) =>
      msg.type === "assistant"
      && msg.message?.content?.[0]?.type === "text"
      && msg.message.content[0].text === "First commentary before compaction")).toHaveLength(1);
    expect(session.messageHistory.filter((msg: any) =>
      msg.type === "assistant"
      && msg.message?.content?.[0]?.type === "text"
      && msg.message.content[0].text === "Second commentary before compaction")).toHaveLength(1);
    const assistantCalls = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .filter((msg: any) => msg.type === "assistant");
    expect(assistantCalls).toHaveLength(0);

    adapter2.emitBrowserMessage({
      type: "result",
      data: {
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        result: "Recovered after resume",
        session_id: sid,
        stop_reason: "end_turn",
      },
    } as any);

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "follow-up should stay queued" }),
    );
  });

  it("re-arms resumed in-progress queued follow-up turns after disconnect", async () => {
    const sid = "s-rearm-resumed-followup";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-rearm-resumed-followup" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    const eventSpy = vi.spyOn(bridge, "emitTakodeEvent");

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Draft the first pass",
    }));
    adapter1.emitTurnStarted("turn-rearm-resumed-followup-1");

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Then add the reconnect details",
    }));

    adapter1.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed the first pass",
        duration_ms: 100,
        duration_api_ms: 100,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "rearm-resumed-followup-result-1",
        session_id: sid,
      },
    });
    await Promise.resolve();

    const promotedSession = bridge.getSession(sid)!;
    expect(getPendingCodexTurn(promotedSession)).toMatchObject({
      userContent: "Then add the reconnect details",
      turnTarget: "queued",
    });
    expect(promotedSession.isGenerating).toBe(true);

    adapter1.emitDisconnect("turn-rearm-resumed-followup-2");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-rearm-resumed-followup",
      model: "gpt-5.4",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-rearm-resumed-followup",
        turnCount: 12,
        lastTurn: {
          id: "turn-rearm-resumed-followup-2",
          status: "inProgress",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "Then add the reconnect details" }] },
            { type: "agentMessage", id: "item-rearm-followup", text: "Recovering the reconnect details" },
          ],
        },
      },
    });

    const resumedSession = bridge.getSession(sid)!;
    expect(resumedSession.isGenerating).toBe(true);
    expect(getPendingCodexTurn(resumedSession)).toMatchObject({
      userContent: "Then add the reconnect details",
      status: "backend_acknowledged",
      turnId: "turn-rearm-resumed-followup-2",
      turnTarget: "current",
    });

    adapter2.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed the reconnect details",
        duration_ms: 150,
        duration_api_ms: 150,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "rearm-resumed-followup-result-2",
        session_id: sid,
      },
    });
    await Promise.resolve();

    const turnEndCalls = eventSpy.mock.calls.filter(
      ([eventSid, eventType]) => eventSid === sid && eventType === "turn_end",
    );
    expect(turnEndCalls).toHaveLength(3);
    expect(turnEndCalls[2]?.[2]).toEqual(expect.not.objectContaining({
      interrupted: true,
    }));

    eventSpy.mockRestore();
  });

  it("retries the user message when resumed turn has only user input", async () => {
    const sid = "s1";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "retry me",
    }));

    adapter1.emitDisconnect("turn-456");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-2",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-2",
        turnCount: 12,
        lastTurn: {
          id: "turn-456",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "retry me" }] },
          ],
        },
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "retry me" }),
    );
    const session = bridge.getSession(sid)!;
    expect(getPendingCodexTurn(session)).not.toBeNull();
  });

  it("retries when resumed turn contains only reasoning items", async () => {
    const sid = "s1";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-3" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "plan this safely",
    }));

    adapter1.emitDisconnect("turn-789");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-3",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-3",
        turnCount: 13,
        lastTurn: {
          id: "turn-789",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "plan this safely" }] },
            { type: "reasoning", summary: ["thinking"] },
          ],
        },
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "plan this safely" }),
    );
    const session = bridge.getSession(sid)!;
    expect(getPendingCodexTurn(session)).not.toBeNull();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const retrySkipError = calls.find((c: any) =>
      c.type === "error"
      && typeof c.message === "string"
      && c.message.includes("non-text tool activity"));
    expect(retrySkipError).toBeUndefined();
  });

  it("retries when resumed snapshot has no lastTurn for a pending in-flight turn", async () => {
    const sid = "s1";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-4" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "resume without last turn",
    }));

    adapter1.emitDisconnect("turn-missing");

    const adapter2 = makeCodexAdapterMock();
    adapter2.sendBrowserMessage.mockReturnValue(true);
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-4",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-4",
        turnCount: 13,
        lastTurn: null,
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "resume without last turn" }),
    );
  });

  it("retries stale idle-thread resumes even when disconnect happened before turn id was recorded", async () => {
    const sid = "s-missing-turn-id";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-orphaned" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "retry the orphaned dispatch",
    }));

    // Reproduce the session-140 race: Codex accepted turn/start, but the
    // transport closed before the adapter captured the returned turn id.
    adapter1.emitDisconnect(null);

    const adapter2 = makeCodexAdapterMock();
    adapter2.sendBrowserMessage.mockReturnValue(true);
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-orphaned",
      model: "gpt-5.4",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-orphaned",
        threadStatus: "idle",
        turnCount: 8,
        lastTurn: {
          id: "turn-orphaned",
          status: "inProgress",
          error: null,
          items: [],
        },
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "retry the orphaned dispatch" }),
    );
    expect((getPendingCodexTurn(bridge.getSession(sid)!) as any)?.turnId).toBeNull();
  });

  it("retries image turns when resume matching must use the annotated user text", async () => {
    const sid = "s-image-retry";
    const adapter1 = makeCodexAdapterMock();
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getTransportPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.transport.jpeg"),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-image" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "describe this screenshot",
      images: [{ media_type: "image/png", data: "image-bytes" }],
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const expectedPath = join(homedir(), ".companion", "images", sid, "img-1.orig.png");
    expect((getPendingCodexTurn(bridge.getSession(sid)!) as any)?.userContent).toBe(
      "describe this screenshot\n"
      + "[📎 Inline image file paths (same order as images above):\n"
      + `Attachment 1: ${expectedPath}]`,
    );

    // Reproduce the transport-drop window where turn/start disconnects before
    // Codex returns a turn ID, so resume matching has to fall back to text.
    adapter1.emitDisconnect(null);

    const adapter2 = makeCodexAdapterMock();
    adapter2.sendBrowserMessage.mockReturnValue(true);
    bridge.attachCodexAdapter(sid, adapter2 as any);

    adapter2.emitSessionMeta({
      cliSessionId: "thread-image",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-image",
        turnCount: 7,
        lastTurn: {
          id: "turn-image",
          status: "completed",
          error: null,
          items: [
            {
              type: "userMessage",
              content: [{
                type: "text",
                text:
                  "describe this screenshot\n"
                  + "[📎 Inline image file paths (same order as images above):\n"
                  + `Attachment 1: ${expectedPath}]`,
              }],
            },
          ],
        },
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_message",
        content: expect.stringContaining("describe this screenshot"),
        local_images: ["/tmp/companion-images/img-1.transport.jpeg"],
      }),
    );
  });

  it("retries when resumed snapshot lastTurn does not match pending disconnected turn", async () => {
    const sid = "s1";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-5" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "retry unmatched turn",
    }));

    adapter1.emitDisconnect("turn-expected");

    const adapter2 = makeCodexAdapterMock();
    adapter2.sendBrowserMessage.mockReturnValue(true);
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-5",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-5",
        turnCount: 14,
        lastTurn: {
          id: "turn-other",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "some prior request" }] },
            { type: "agentMessage", id: "item-z1", text: "previous output" },
          ],
        },
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "retry unmatched turn" }),
    );
  });

  it("synthesizes missing tool result previews from terminal resumed turns", async () => {
    const sid = "s-terminal-resume";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-terminal" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "run terminal command",
    }));
    adapter1.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-cmd-1",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "tool_use", id: "cmd_1", name: "Bash", input: { command: "echo hi" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
    expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_1")).toBe(true);

    adapter1.emitDisconnect("turn-cmd-1");
    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    browser.send.mockClear();

    adapter2.emitSessionMeta({
      cliSessionId: "thread-terminal",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-terminal",
        turnCount: 42,
        lastTurn: {
          id: "turn-cmd-1",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "run terminal command" }] },
            { type: "commandExecution", id: "cmd_1", status: "completed", aggregatedOutput: "hi", exitCode: 0 },
          ],
        },
      },
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const preview = calls.find((c: any) =>
      c.type === "tool_result_preview" && Array.isArray(c.previews) && c.previews.some((p: any) => p.tool_use_id === "cmd_1"));
    expect(preview).toBeDefined();
    expect(preview.previews[0].content).toContain("hi");

    const session = bridge.getSession(sid)!;
    expect(session.toolStartTimes.has("cmd_1")).toBe(false);
    expect(getPendingCodexTurn(session)).toBeNull();
  });

  it("watchdog synthesizes interruption when codex stays disconnected", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-watchdog-disconnected";
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);
      emitCodexSessionReady(adapter, { cliSessionId: "thread-watchdog-disconnected" });

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content: "run command",
      }));
      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-cmd-watch",
          type: "message",
          role: "assistant",
          model: "gpt-5.3-codex",
          content: [{ type: "tool_use", id: "cmd_watch", name: "Bash", input: { command: "sleep 999" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });
      browser.send.mockClear();

      adapter.emitDisconnect("turn-watch");
      vi.advanceTimersByTime(120_000);

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const preview = calls.find((c: any) =>
        c.type === "tool_result_preview" && Array.isArray(c.previews) && c.previews.some((p: any) => p.tool_use_id === "cmd_watch"));
      expect(preview).toBeDefined();
      expect(preview.previews[0].is_error).toBe(true);
      expect(preview.previews[0].content).toContain("interrupted");
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_watch")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watchdog does not synthesize while codex is connected", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-watchdog-connected";
      const adapter1 = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter1 as any);
      emitCodexSessionReady(adapter1, { cliSessionId: "thread-watchdog-connected" });

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content: "run long command",
      }));
      adapter1.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-cmd-live",
          type: "message",
          role: "assistant",
          model: "gpt-5.3-codex",
          content: [{ type: "tool_use", id: "cmd_live", name: "Bash", input: { command: "sleep 36000" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });
      browser.send.mockClear();
      adapter1.emitDisconnect("turn-live");

      const adapter2 = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter2 as any);
      browser.send.mockClear();

      vi.advanceTimersByTime(120_000);

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const preview = calls.find((c: any) =>
        c.type === "tool_result_preview" && Array.isArray(c.previews) && c.previews.some((p: any) => p.tool_use_id === "cmd_live"));
      expect(preview).toBeUndefined();
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_live")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watchdog finalizes resumed in-progress bash tools after reconnect confirmation", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-watchdog-resumed-turn";
      const adapter1 = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter1 as any);
      emitCodexSessionReady(adapter1, { cliSessionId: "thread-reconnect" });

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content: "run reconnecting command",
      }));
      adapter1.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-cmd-reconnect",
          type: "message",
          role: "assistant",
          model: "gpt-5.3-codex",
          content: [{ type: "tool_use", id: "cmd_reconnect", name: "Bash", input: { command: "sleep 36000" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });
      browser.send.mockClear();

      adapter1.emitDisconnect("turn-reconnect");

      const adapter2 = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter2 as any);
      adapter2.emitSessionMeta({
        cliSessionId: "thread-reconnect",
        model: "gpt-5.3-codex",
        cwd: "/repo",
        resumeSnapshot: {
          threadId: "thread-reconnect",
          turnCount: 15,
          lastTurn: {
            id: "turn-reconnect",
            status: "inProgress",
            error: null,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "run reconnecting command" }] },
              { type: "commandExecution", id: "cmd_reconnect", status: "in_progress", command: ["sleep", "36000"] },
            ],
          },
        },
      });

      const pending = getPendingCodexTurn(bridge.getSession(sid)!);
      expect(pending?.resumeConfirmedAt).not.toBeNull();
      expect(browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg)).find((c: any) =>
        c.type === "error"
        && typeof c.message === "string"
        && c.message.includes("non-text tool activity"))).toBeUndefined();

      browser.send.mockClear();
      vi.advanceTimersByTime(120_000);

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const preview = calls.find((c: any) =>
        c.type === "tool_result_preview" && Array.isArray(c.previews) && c.previews.some((p: any) => p.tool_use_id === "cmd_reconnect"));
      expect(preview).toBeDefined();
      expect(preview.previews[0].is_error).toBe(true);
      expect(preview.previews[0].content).toContain("interrupted");
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_reconnect")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not finalize older connected bash tools until a later tool actually completes", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-connected-tool-stays-open";
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content: "run two commands",
      }));

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-old-running",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_use", id: "cmd_old_running", name: "Bash", input: { command: "sleep 30" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      vi.advanceTimersByTime(1000);

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-new-running",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_use", id: "cmd_new_running", name: "Bash", input: { command: "pwd" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      const session = bridge.getSession(sid)!;
      expect(session.toolStartTimes.has("cmd_old_running")).toBe(true);
      expect(session.toolStartTimes.has("cmd_new_running")).toBe(true);

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const stalePreview = calls.find((c: any) =>
        c.type === "tool_result_preview" && Array.isArray(c.previews) && c.previews.some((p: any) => p.tool_use_id === "cmd_old_running"));
      expect(stalePreview).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes older connected bash tools once a later tool completes", async () => {
    vi.useFakeTimers();
    try {
      const sid = "s-connected-tool-superseded";
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);

      const browser = makeBrowserSocket(sid);
      bridge.handleBrowserOpen(browser, sid);
      browser.send.mockClear();

      await bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content: "run two commands",
      }));

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-old",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_use", id: "cmd_old", name: "Bash", input: { command: "git status --short" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      vi.advanceTimersByTime(1000);

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-new",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_use", id: "cmd_new", name: "Bash", input: { command: "pwd" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      browser.send.mockClear();
      vi.advanceTimersByTime(1000);

      adapter.emitBrowserMessage({
        type: "assistant",
        message: {
          id: "assistant-new-result",
          type: "message",
          role: "assistant",
          model: "gpt-5.4",
          content: [{ type: "tool_result", tool_use_id: "cmd_new", content: "/repo\n", is_error: false }],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const newPreview = calls.find((c: any) =>
        c.type === "tool_result_preview" && Array.isArray(c.previews) && c.previews.some((p: any) => p.tool_use_id === "cmd_new"));
      const stalePreview = calls.find((c: any) =>
        c.type === "tool_result_preview" && Array.isArray(c.previews) && c.previews.some((p: any) => p.tool_use_id === "cmd_old"));

      expect(newPreview).toBeDefined();
      expect(stalePreview).toBeDefined();
      expect(stalePreview.previews[0].is_error).toBe(false);
      expect(stalePreview.previews[0].content).toContain("later tool completed");
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_old")).toBe(false);
      expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_new")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("result finalizes silent bash tools so they do not stay running forever", async () => {
    const sid = "s-result-silent-terminal";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "run silent command",
    }));
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-cmd-silent",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "tool_use", id: "cmd_silent", name: "Bash", input: { command: "true" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    browser.send.mockClear();
    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        duration_ms: 1000,
        duration_api_ms: 1000,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "codex-result-silent",
        session_id: sid,
      },
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const preview = calls.find((c: any) =>
      c.type === "tool_result_preview" && Array.isArray(c.previews) && c.previews.some((p: any) => p.tool_use_id === "cmd_silent"));
    expect(preview).toBeDefined();
    expect(preview.previews[0].is_error).toBe(false);
    expect(preview.previews[0].content).toContain("no output was captured");
    expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_silent")).toBe(false);
  });

  it("retries stale recovery when resumed turn is inProgress but thread is idle", async () => {
    // When Codex CLI restarts, thread/resume may report the last turn as
    // "inProgress" while the thread itself is "idle". The turn was running
    // in the dead process and is now stale — the user message should be
    // retried so work continues (not silently cleared).
    const sid = "s-idle-thread-stale-turn";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "run a command",
    }));
    adapter1.emitDisconnect("turn-stale");

    // Reconnect with inProgress turn but idle thread
    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitSessionMeta({
      cliSessionId: "thread-idle",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-idle",
        turnCount: 5,
        threadStatus: "idle",
        lastTurn: {
          id: "turn-stale",
          status: "inProgress",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "run a command" }] },
            { type: "commandExecution", id: "cmd_stale", status: "in_progress", command: ["make", "build"] },
          ],
        },
      },
    });

    // User message must be retried via the adapter
    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const firstToolRetryCall = adapter2.sendBrowserMessage.mock.calls[0];
    expect(firstToolRetryCall).toBeDefined();
    const retried = (((firstToolRetryCall as unknown as [any])[0]) as any);
    expect(retried.content).toBe("run a command");

    // No "non-text tool activity" error sent
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((c: any) =>
      c.type === "error"
      && typeof c.message === "string"
      && c.message.includes("non-text tool activity"))).toBeUndefined();
  });
});

describe("Codex runtime settings updates", () => {
  it("set_model updates launcher/session state and requests relaunch", async () => {
    const sid = "s1";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const launcherInfo = { model: "gpt-5.4", permissionMode: "plan" };
    const launcherMock = {
      touchActivity: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.onSessionRelaunchRequestedCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_model",
      model: "gpt-5.3-codex",
    }));

    const session = bridge.getSession(sid)!;
    expect(session.state.model).toBe("gpt-5.3-codex");
    expect(launcherInfo.model).toBe("gpt-5.3-codex");
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    expect(relaunchCb).toHaveBeenCalledWith(sid);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const update = calls.find((c: any) => c.type === "session_update");
    expect(update).toEqual(expect.objectContaining({
      type: "session_update",
      session: expect.objectContaining({ model: "gpt-5.3-codex" }),
    }));
  });

  it("set_codex_reasoning_effort updates session state and requests relaunch", async () => {
    const sid = "s2";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const launcherInfo = { model: "gpt-5.4", codexReasoningEffort: undefined };
    const launcherMock = {
      touchActivity: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.onSessionRelaunchRequestedCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_codex_reasoning_effort",
      effort: "high",
    }));

    const session = bridge.getSession(sid)!;
    expect(session.state.codex_reasoning_effort).toBe("high");
    expect(launcherInfo.codexReasoningEffort).toBe("high");
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    expect(relaunchCb).toHaveBeenCalledWith(sid);
  });

  it("set_ask_permission keeps codex plan mode while updating askPermission", async () => {
    const sid = "s3";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const launcherInfo = { permissionMode: "plan", askPermission: true };
    const launcherMock = {
      touchActivity: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.onSessionRelaunchRequestedCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);
    const session = bridge.getSession(sid)!;
    session.state.permissionMode = "plan";
    session.state.uiMode = "plan";
    session.state.askPermission = true;
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_ask_permission",
      askPermission: false,
    }));

    expect(session.state.permissionMode).toBe("plan");
    expect(session.state.uiMode).toBe("plan");
    expect(session.state.askPermission).toBe(false);
    expect(launcherInfo.permissionMode).toBe("plan");
    expect(launcherInfo.askPermission).toBe(false);
    expect(relaunchCb).toHaveBeenCalledWith(sid);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const update = calls.find((m: any) => m.type === "session_update");
    expect(update).toEqual(expect.objectContaining({
      type: "session_update",
      session: expect.objectContaining({
        askPermission: false,
        permissionMode: "plan",
        uiMode: "plan",
      }),
    }));
  });
});

// Regression: switching Codex permission mode while a tool approval is pending
// used to leave the Codex thread stuck because the pending JSON-RPC approval
// was never responded to before the process was killed via relaunch.
describe("Codex permission mode switch with pending approvals", () => {
  it("auto-approves pending permissions when switching to bypassPermissions", async () => {
    const sid = "s-mode-switch";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const launcherInfo = { permissionMode: "suggest" };
    const launcherMock = {
      touchActivity: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
      getSessionNum: vi.fn(() => 1),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.onSessionRelaunchRequestedCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);

    // Simulate a pending permission request from Codex
    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-stuck",
        tool_name: "Bash",
        description: "rm -rf node_modules",
        input: { command: "rm -rf node_modules" },
      },
    });
    // Flush async permission pipeline — settings rule check reads from disk
    await new Promise(r => setTimeout(r, 50));
    const session = bridge.getSession(sid)!;
    expect(session.pendingPermissions.has("perm-stuck")).toBe(true);
    browser.send.mockClear();

    // Switch to bypassPermissions (auto-approve mode)
    // Use fake timers only for the relaunch delay
    vi.useFakeTimers();

    // Switch to bypassPermissions (auto-approve mode)
    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_permission_mode",
      mode: "bypassPermissions",
    }));

    // Pending permission should be cleared
    expect(session.pendingPermissions.size).toBe(0);

    // Adapter should have received a permission_response with behavior "allow"
    // so the JSON-RPC request is answered before the process is killed
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission_response",
        request_id: "perm-stuck",
        behavior: "allow",
      }),
    );

    // Browser should receive permission_approved + session_update with new mode
    const msgs = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const approved = msgs.find((m: any) => m.type === "permission_approved");
    expect(approved).toBeDefined();
    expect(approved.request_id).toBe("perm-stuck");
    const modeUpdate = msgs.find((m: any) =>
      m.type === "session_update" && m.session?.permissionMode,
    );
    expect(modeUpdate?.session?.permissionMode).toBe("bypassPermissions");

    // Relaunch should be requested (after setTimeout delay)
    expect(relaunchCb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(relaunchCb).toHaveBeenCalledWith(sid);

    vi.useRealTimers();
  });

  it("cancels pending permissions when switching to a non-bypass mode", async () => {
    const sid = "s-mode-cancel";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    // Start in suggest mode (permissions go to pending_human, not auto-approved)
    const launcherInfo = { permissionMode: "suggest" };
    const launcherMock = {
      touchActivity: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
      getSessionNum: vi.fn(() => 2),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.onSessionRelaunchRequestedCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);

    // Simulate a pending permission (use a command that won't match settings rules)
    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-cancel",
        tool_name: "Edit",
        description: "edit file",
        input: { file: "test.ts" },
      },
    });
    // Flush async permission pipeline — settings rule check reads from disk
    await new Promise(r => setTimeout(r, 50));
    const session = bridge.getSession(sid)!;
    expect(session.pendingPermissions.has("perm-cancel")).toBe(true);
    browser.send.mockClear();

    // Switch to suggest mode — pending permissions should be denied/cancelled
    // Use fake timers only for the relaunch delay
    vi.useFakeTimers();
    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_permission_mode",
      mode: "suggest",
    }));

    expect(session.pendingPermissions.size).toBe(0);

    // Adapter gets a deny response so the JSON-RPC request is resolved
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "permission_response",
        request_id: "perm-cancel",
        behavior: "deny",
      }),
    );

    // Browser should receive permission_cancelled
    const msgs = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const cancelled = msgs.find((m: any) => m.type === "permission_cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled.request_id).toBe("perm-cancel");

    vi.advanceTimersByTime(150);
    expect(relaunchCb).toHaveBeenCalledWith(sid);

    vi.useRealTimers();
  });

  it("skips auto-resolve when no permissions are pending", async () => {
    vi.useFakeTimers();
    const sid = "s-no-pending";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const launcherInfo = { permissionMode: "suggest" };
    const launcherMock = {
      touchActivity: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.onSessionRelaunchRequestedCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "set_permission_mode",
      mode: "bypassPermissions",
    }));

    // No adapter calls for permission resolution
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();

    // Relaunch still triggered
    vi.advanceTimersByTime(150);
    expect(relaunchCb).toHaveBeenCalledWith(sid);

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

describe("Codex /compact passthrough", () => {
  it("forwards /compact to adapter as a normal user message", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-compact" });
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "/compact",
    }));
    adapter.emitTurnStarted("turn-compact");

    // Adapter should receive the message.
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "/compact" }),
    );

    // User message is recorded and generation begins.
    const session = bridge.getSession("s1")!;
    const userMsgs = session.messageHistory.filter((m: any) => m.type === "user_message");
    expect(userMsgs).toHaveLength(1);
    expect(session.isGenerating).toBe(true);
  });

  it("forwards /compact with case/whitespace variations", async () => {
    const variations = [" /COMPACT ", "/Compact", "  /compact  "];
    for (const content of variations) {
      const sid = `s-${content.trim()}`;
      const browser = makeBrowserSocket(sid);
      const adapter = makeCodexAdapterMock();
      bridge.attachCodexAdapter(sid, adapter as any);
      emitCodexSessionReady(adapter, { cliSessionId: `thread-${content.trim()}` });
      bridge.handleBrowserOpen(browser, sid);

      await bridge.handleBrowserMessage(browser, JSON.stringify({
        type: "user_message",
        content,
      }));

      expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "user_message", content }),
      );
    }
  });
});

describe("Codex injected user_message metadata", () => {
  it("preserves herd agentSource on injected user messages for special UI rendering", async () => {
    const sid = "s-herd-events";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-herd-events" });
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    // Regression guard: herd-event injections come through injectUserMessage()
    // with agentSource={sessionId:"herd-events"}. The frontend relies on this
    // exact metadata to render the compact "Herd Events" card instead of a
    // normal right-aligned user bubble.
    bridge.injectUserMessage(sid, "2 events from 1 session", {
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    const userMsgs = session.messageHistory.filter((m: any) => m.type === "user_message");
    expect(userMsgs).toHaveLength(1);
    expect((userMsgs[0] as any).agentSource).toEqual({
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });

    const outbound = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const broadcastUser = outbound.find((m: any) => m.type === "user_message");
    expect(broadcastUser?.agentSource).toEqual({
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });
  });
});

describe("Codex user_message takode events", () => {
  it("emits takode user_message for direct human worker messages", async () => {
    const sid = "worker-codex-1";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Please prioritize fixing auth bug first",
    }));
    await Promise.resolve();

    expect(spy).toHaveBeenCalledWith(
      sid,
      "user_message",
      expect.objectContaining({
        content: "Please prioritize fixing auth bug first",
      }),
    );

    spy.mockRestore();
  });

  it("marks turn_end as interrupted when a new user_message arrives during a running codex turn", async () => {
    const sid = "worker-codex-2";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-worker-codex-2" });
    bridge.handleBrowserOpen(browser, sid);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Start an active turn.
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Run full test suite",
    }));
    adapter.emitTurnStarted("turn-running-1");

    // Mid-turn follow-up message causes Codex to interrupt the active turn first.
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Actually run only server tests",
    }));

    // Adapter reports completion of the interrupted turn.
    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "interrupted by new user message",
        duration_ms: 320,
        duration_api_ms: 320,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "interrupted",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "codex-result-interrupted-1",
        session_id: sid,
      },
    });

    await Promise.resolve();

    const turnEndCalls = spy.mock.calls.filter(
      ([eventSid, eventType]) => eventSid === sid && eventType === "turn_end",
    );
    expect(turnEndCalls.length).toBeGreaterThan(0);
    const lastTurnEnd = turnEndCalls[turnEndCalls.length - 1];
    expect(lastTurnEnd[2]).toEqual(expect.objectContaining({ interrupted: true, interrupt_source: "user" }));

    spy.mockRestore();
  });

  it("does not mark turn_end as interrupted when a queued follow-up arrives but the current codex result completes normally", async () => {
    const sid = "worker-codex-2b";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-worker-codex-2b" });
    bridge.handleBrowserOpen(browser, sid);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Run the full test suite",
    }));
    adapter.emitTurnStarted("turn-running-2");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "Then summarize only the failures",
    }));

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed original turn before follow-up started",
        duration_ms: 320,
        duration_api_ms: 320,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "codex-result-completed-1",
        session_id: sid,
      },
    });

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed follow-up turn",
        duration_ms: 180,
        duration_api_ms: 180,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "codex-result-completed-2",
        session_id: sid,
      },
    });

    await Promise.resolve();

    const turnEndCalls = spy.mock.calls.filter(
      ([eventSid, eventType]) => eventSid === sid && eventType === "turn_end",
    );
    expect(turnEndCalls).toHaveLength(2);
    expect(turnEndCalls[0]?.[2]).toEqual(expect.not.objectContaining({
      interrupted: true,
    }));
    expect(turnEndCalls[1]?.[2]).toEqual(expect.not.objectContaining({
      interrupted: true,
    }));

    spy.mockRestore();
  });

  it("emits both interrupted and resumed turn_end events after correction, with herd delivery for each", async () => {
    vi.useFakeTimers();
    const leaderId = "orch-correction";
    const workerId = "worker-correction";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "codex", cwd: "/test" }],
    ]);

    const launcherMock = {
      touchActivity: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 1 : 2)),
    };
    bridge.setLauncher(launcherMock as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const leaderCli = makeCliSocket(leaderId);
    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-correction" }));

    const workerBrowser = makeBrowserSocket(workerId);
    const workerAdapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(workerId, workerAdapter as any);
    emitCodexSessionReady(workerAdapter, { cliSessionId: "thread-worker-correction" });
    bridge.handleBrowserOpen(workerBrowser, workerId);

    const eventSpy = vi.spyOn(bridge, "emitTakodeEvent");
    const herdInjectSpy = vi.spyOn(bridge, "injectUserMessage");

    // Initial worker task turn.
    bridge.handleBrowserMessage(workerBrowser, JSON.stringify({
      type: "user_message",
      content: "Implement the first version",
    }));
    await Promise.resolve();
    workerAdapter.emitTurnStarted("turn-worker-correction-1");

    // Mid-turn correction from leader.
    bridge.handleBrowserMessage(workerBrowser, JSON.stringify({
      type: "user_message",
      content: "Correction: include edge-case handling",
      agentSource: { sessionId: leaderId, sessionLabel: "#1 leader" },
    }));
    await Promise.resolve();

    // First result ends interrupted turn.
    workerAdapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "interrupted by correction",
        duration_ms: 200,
        duration_api_ms: 200,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "interrupted",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-result-1",
        session_id: workerId,
      },
    });
    await Promise.resolve();

    // Deliver first herd event batch.
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    // Leader processes injected herd event message and returns idle.
    bridge.handleCLIMessage(leaderCli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ack",
      duration_ms: 100,
      duration_api_ms: 100,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      uuid: "leader-herd-ack-1",
      session_id: leaderId,
    }));
    await Promise.resolve();

    // Second result ends the resumed follow-up turn.
    workerAdapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed after correction",
        duration_ms: 450,
        duration_api_ms: 450,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-result-2",
        session_id: workerId,
      },
    });
    await Promise.resolve();
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    try {
      const workerTurnEndCalls = eventSpy.mock.calls.filter(
        ([sid, eventType]) => sid === workerId && eventType === "turn_end",
      );
      expect(workerTurnEndCalls).toHaveLength(2);
      expect(workerTurnEndCalls[0]?.[2]).toEqual(expect.objectContaining({
        interrupted: true,
        interrupt_source: "leader",
      }));
      expect(workerTurnEndCalls[1]?.[2]).toEqual(expect.not.objectContaining({
        interrupted: true,
      }));

      const herdDeliveries = herdInjectSpy.mock.calls.filter(
        ([sid, _content, source]) => sid === leaderId && source?.sessionId === "herd-events",
      );
      expect(herdDeliveries).toHaveLength(2);
    } finally {
      dispatcher.destroy();
      eventSpy.mockRestore();
      herdInjectSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps both turn_end events deliverable after correction when reconnect happens before follow-up start", async () => {
    vi.useFakeTimers();
    const leaderId = "orch-correction-reconnect";
    const workerId = "worker-correction-reconnect";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "codex", cwd: "/test" }],
    ]);

    const launcherMock = {
      touchActivity: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 1 : 2)),
    };
    bridge.setLauncher(launcherMock as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const leaderCli = makeCliSocket(leaderId);
    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-correction-reconnect" }));

    const workerBrowser = makeBrowserSocket(workerId);
    const workerAdapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(workerId, workerAdapter1 as any);
    emitCodexSessionReady(workerAdapter1, { cliSessionId: "thread-worker-correction-reconnect" });
    bridge.handleBrowserOpen(workerBrowser, workerId);

    const eventSpy = vi.spyOn(bridge, "emitTakodeEvent");
    const herdInjectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.handleBrowserMessage(workerBrowser, JSON.stringify({
      type: "user_message",
      content: "Implement the first version",
    }));
    await Promise.resolve();
    workerAdapter1.emitTurnStarted("turn-worker-correction-reconnect-1");

    bridge.handleBrowserMessage(workerBrowser, JSON.stringify({
      type: "user_message",
      content: "Correction: include edge-case handling",
      agentSource: { sessionId: leaderId, sessionLabel: "#1 leader" },
    }));
    await Promise.resolve();

    workerAdapter1.emitDisconnect("turn-worker-correction-reconnect-1");
    await Promise.resolve();

    vi.advanceTimersByTime(600);
    await Promise.resolve();

    bridge.handleCLIMessage(leaderCli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ack",
      duration_ms: 100,
      duration_api_ms: 100,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      uuid: "leader-herd-ack-reconnect-1",
      session_id: leaderId,
    }));
    await Promise.resolve();

    const workerAdapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(workerId, workerAdapter2 as any);
    workerAdapter2.emitSessionMeta({
      cliSessionId: "thread-worker-correction-reconnect",
      model: "gpt-5.4",
      cwd: "/test",
      resumeSnapshot: {
        threadId: "thread-worker-correction-reconnect",
        turnCount: 9,
        lastTurn: {
          id: "turn-worker-correction-reconnect-1",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "Implement the first version" }] },
            { type: "agentMessage", id: "item-reconnect-recovered", text: "Recovered interrupted work" },
          ],
        },
      },
    });

    const resumedSession = bridge.getSession(workerId)!;
    expect(getPendingCodexTurn(resumedSession)).toMatchObject({
      userContent: "Correction: include edge-case handling",
      status: "dispatched",
      turnTarget: null,
    });
    expect(resumedSession.queuedTurnStarts).toBe(0);
    expect(resumedSession.queuedTurnReasons).toEqual([]);
    expect(resumedSession.queuedTurnUserMessageIds).toEqual([]);
    expect(resumedSession.queuedTurnInterruptSources).toEqual([]);

    workerAdapter2.emitTurnStarted("turn-worker-correction-reconnect-2");
    workerAdapter2.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed after reconnect",
        duration_ms: 450,
        duration_api_ms: 450,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-reconnect-result-2",
        session_id: workerId,
      },
    });
    await Promise.resolve();
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    try {
      const workerTurnEndCalls = eventSpy.mock.calls.filter(
        ([sid, eventType]) => sid === workerId && eventType === "turn_end",
      );
      expect(workerTurnEndCalls).toHaveLength(2);
      expect(workerTurnEndCalls[0]?.[2]).toEqual(expect.objectContaining({
        interrupted: true,
        interrupt_source: "system",
      }));
      expect(workerTurnEndCalls[1]?.[2]).toEqual(expect.not.objectContaining({
        interrupted: true,
      }));

      const herdDeliveries = herdInjectSpy.mock.calls.filter(
        ([sid, _content, source]) => sid === leaderId && source?.sessionId === "herd-events",
      );
      expect(herdDeliveries).toHaveLength(2);
    } finally {
      dispatcher.destroy();
      eventSpy.mockRestore();
      herdInjectSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not mark leader correction turn_end as interrupted when the current codex turn completes before the queued follow-up begins", async () => {
    vi.useFakeTimers();
    const leaderId = "orch-correction-no-interrupt";
    const workerId = "worker-correction-no-interrupt";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "codex", cwd: "/test" }],
    ]);

    const launcherMock = {
      touchActivity: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 1 : 2)),
    };
    bridge.setLauncher(launcherMock as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const leaderCli = makeCliSocket(leaderId);
    bridge.handleCLIOpen(leaderCli, leaderId);
    bridge.handleCLIMessage(leaderCli, makeInitMsg({ session_id: "cli-orch-correction-no-interrupt" }));

    const workerBrowser = makeBrowserSocket(workerId);
    const workerAdapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(workerId, workerAdapter as any);
    emitCodexSessionReady(workerAdapter, { cliSessionId: "thread-worker-correction-no-interrupt" });
    bridge.handleBrowserOpen(workerBrowser, workerId);

    const eventSpy = vi.spyOn(bridge, "emitTakodeEvent");
    const herdInjectSpy = vi.spyOn(bridge, "injectUserMessage");

    bridge.handleBrowserMessage(workerBrowser, JSON.stringify({
      type: "user_message",
      content: "Implement the baseline version",
    }));
    await Promise.resolve();
    workerAdapter.emitTurnStarted("turn-worker-correction-no-interrupt-1");

    bridge.handleBrowserMessage(workerBrowser, JSON.stringify({
      type: "user_message",
      content: "Correction: also include validation",
      agentSource: { sessionId: leaderId, sessionLabel: "#1 leader" },
    }));
    await Promise.resolve();

    workerAdapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed original turn before correction follow-up started",
        duration_ms: 220,
        duration_api_ms: 220,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-no-interrupt-result-1",
        session_id: workerId,
      },
    });
    await Promise.resolve();

    vi.advanceTimersByTime(600);
    await Promise.resolve();

    bridge.handleCLIMessage(leaderCli, JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ack",
      duration_ms: 100,
      duration_api_ms: 100,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      uuid: "leader-herd-ack-no-interrupt-1",
      session_id: leaderId,
    }));
    await Promise.resolve();

    workerAdapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed correction follow-up turn",
        duration_ms: 410,
        duration_api_ms: 410,
        num_turns: 2,
        total_cost_usd: 0,
        stop_reason: "completed",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "worker-correction-no-interrupt-result-2",
        session_id: workerId,
      },
    });
    await Promise.resolve();
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    try {
      const workerTurnEndCalls = eventSpy.mock.calls.filter(
        ([sid, eventType]) => sid === workerId && eventType === "turn_end",
      );
      expect(workerTurnEndCalls).toHaveLength(2);
      expect(workerTurnEndCalls[0]?.[2]).toEqual(expect.not.objectContaining({
        interrupted: true,
      }));
      expect(workerTurnEndCalls[1]?.[2]).toEqual(expect.not.objectContaining({
        interrupted: true,
      }));

      const herdDeliveries = herdInjectSpy.mock.calls.filter(
        ([sid, _content, source]) => sid === leaderId && source?.sessionId === "herd-events",
      );
      expect(herdDeliveries).toHaveLength(2);
    } finally {
      dispatcher.destroy();
      eventSpy.mockRestore();
      herdInjectSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("Codex image transport", () => {
  // Prefer local image paths for Codex turn/start to avoid persisting large
  // data: URLs in thread history. Transport JPEG paths are preferred, with
  // fallback to original stored file paths.
  //
  // NOTE: handleBrowserMessage does NOT await routeBrowserMessage (fire-and-forget),
  // so tests need a microtask flush after the call for async image operations.

  /** Flush microtask queue so async routeBrowserMessage completes. */
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("sends local image paths to Codex when stored originals are available", async () => {
    const adapter = makeCodexAdapterMock();

    // Create a mock imageStore that can resolve normalized transport paths.
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getTransportPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.transport.jpeg"),
      compressForTransport: vi.fn().mockResolvedValue({
        base64: "compressed-base64-data",
        mediaType: "image/jpeg",
      }),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-local-paths" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "describe this image",
      images: [{ media_type: "image/png", data: "large-base64-data" }],
    }));
    await flush();

    // Adapter should receive local paths and skip inline payload compression.
    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const firstImageCall = adapter.sendBrowserMessage.mock.calls[0];
    expect(firstImageCall).toBeDefined();
    const sentMsg = ((firstImageCall as unknown as [any])[0]) as any;
    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    expect(sentMsg.content).toContain(`Attachment 1: ${expectedPath}`);
    expect(sentMsg.local_images).toEqual(["/tmp/companion-images/img-1.transport.jpeg"]);
    expect(sentMsg.images).toBeUndefined();
    expect(mockImageStore.compressForTransport).not.toHaveBeenCalled();
  });

  it("falls back to original stored paths when transport path lookup fails", async () => {
    const adapter = makeCodexAdapterMock();

    // Mock imageStore where transport path lookup fails.
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getTransportPath: vi.fn().mockResolvedValue(null),
      getOriginalPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.orig.png"),
      compressForTransport: vi.fn().mockResolvedValue({
        base64: "compressed-fallback-data",
        mediaType: "image/jpeg",
      }),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-fallback" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "what is this?",
      images: [{ media_type: "image/png", data: "small-data" }],
    }));
    await flush();

    // Adapter receives local_images and no inline image payload.
    const firstFallbackCall = adapter.sendBrowserMessage.mock.calls[0];
    expect(firstFallbackCall).toBeDefined();
    const sentMsg = ((firstFallbackCall as unknown as [any])[0]) as any;
    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    expect(sentMsg.content).toContain(`Attachment 1: ${expectedPath}`);
    expect(sentMsg.local_images).toEqual(["/tmp/companion-images/img-1.orig.png"]);
    expect(sentMsg.images).toBeUndefined();
    expect(mockImageStore.compressForTransport).not.toHaveBeenCalled();
  });

  it("sends all Codex image attachments as ordered local paths for multi-image messages", async () => {
    const adapter = makeCodexAdapterMock();

    const mockImageStore = {
      store: vi
        .fn()
        .mockResolvedValueOnce({ imageId: "img-1", media_type: "image/png" })
        .mockResolvedValueOnce({ imageId: "img-2", media_type: "image/png" }),
      getTransportPath: vi
        .fn()
        .mockResolvedValueOnce("/tmp/companion-images/img-1.transport.jpeg")
        .mockResolvedValueOnce("/tmp/companion-images/img-2.transport.jpeg"),
      compressForTransport: vi.fn().mockResolvedValue({
        base64: "compressed-fallback-data",
        mediaType: "image/jpeg",
      }),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-multi" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "compare these images",
      images: [
        { media_type: "image/png", data: "image-one-data" },
        { media_type: "image/png", data: "image-two-data" },
      ],
    }));
    await flush();

    const firstMultiImageCall = adapter.sendBrowserMessage.mock.calls[0];
    expect(firstMultiImageCall).toBeDefined();
    const sentMsg = ((firstMultiImageCall as unknown as [any])[0]) as any;
    const expectedPath1 = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    const expectedPath2 = join(homedir(), ".companion", "images", "s1", "img-2.orig.png");
    expect(sentMsg.content).toContain(`Attachment 1: ${expectedPath1}`);
    expect(sentMsg.content).toContain(`Attachment 2: ${expectedPath2}`);
    expect(sentMsg.local_images).toEqual([
      "/tmp/companion-images/img-1.transport.jpeg",
      "/tmp/companion-images/img-2.transport.jpeg",
    ]);
    expect(sentMsg.images).toBeUndefined();
    expect(mockImageStore.compressForTransport).not.toHaveBeenCalled();
  });

  it("emits an error and does not send Codex image turn when imageStore is not set", async () => {
    const adapter = makeCodexAdapterMock();
    // No imageStore set on bridge
    bridge.attachCodexAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "no store",
      images: [{ media_type: "image/png", data: "raw-data" }],
    }));
    await flush();

    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(browserCalls).toContainEqual(expect.objectContaining({
      type: "error",
      message: expect.stringContaining("Image failed to send"),
    }));
  });
});

describe("Claude SDK image transport", () => {
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("appends numbered attachment paths to Claude SDK user message text", async () => {
    const adapter = makeClaudeSdkAdapterMock();

    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      compressForTransport: vi.fn().mockResolvedValue({
        base64: "compressed-sdk-base64",
        mediaType: "image/jpeg",
      }),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "describe this image",
      images: [{ media_type: "image/png", data: "large-base64-data" }],
    }));
    await flush();

    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const sentMsg = adapter.sendBrowserMessage.mock.calls[0]![0] as any;
    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    expect(sentMsg.content).toContain(`Attachment 1: ${expectedPath}`);
    expect(sentMsg.images).toEqual([{ media_type: "image/jpeg", data: "compressed-sdk-base64" }]);
  });
});

// ─── Sensitive path and command guards ───────────────────────────────────────
// These are private static methods — access via `any` cast for testing.

describe("isSensitiveConfigPath", () => {
  const check = (p: string) => (WsBridge as any).isSensitiveConfigPath(p);

  it("blocks CLAUDE.md anywhere", () => {
    expect(check("/home/user/project/CLAUDE.md")).toBe(true);
    expect(check("/home/user/.claude/CLAUDE.md")).toBe(true);
    expect(check("/some/nested/dir/CLAUDE.md")).toBe(true);
  });

  it("blocks .mcp.json and .claude.json", () => {
    expect(check("/project/.mcp.json")).toBe(true);
    expect(check("/project/.claude.json")).toBe(true);
  });

  it("blocks .claude/ settings and credentials", () => {
    expect(check("/home/user/.claude/settings.json")).toBe(true);
    expect(check("/home/user/.claude/settings.local.json")).toBe(true);
    expect(check("/home/user/.claude/.credentials.json")).toBe(true);
  });

  it("blocks .claude/ subdirectories (commands, agents, skills, hooks)", () => {
    expect(check("/home/user/.claude/hooks/my-hook.sh")).toBe(true);
    expect(check("/home/user/.claude/commands/custom.md")).toBe(true);
    expect(check("/home/user/.claude/agents/reviewer.md")).toBe(true);
    expect(check("/home/user/.claude/skills/skill.md")).toBe(true);
  });

  it("blocks companion auto-approval configs", () => {
    const home = process.env.HOME || "/home/user";
    expect(check(`${home}/.companion/auto-approval/abc123.json`)).toBe(true);
  });

  it("blocks port-specific companion settings", () => {
    const home = process.env.HOME || "/home/user";
    expect(check(`${home}/.companion/settings.json`)).toBe(true);
    expect(check(`${home}/.companion/settings-3456.json`)).toBe(true);
    expect(check(`${home}/.companion/settings-8080.json`)).toBe(true);
  });

  it("allows normal project files", () => {
    expect(check("/home/user/project/src/main.ts")).toBe(false);
    expect(check("/home/user/project/README.md")).toBe(false);
    expect(check("/home/user/project/package.json")).toBe(false);
  });
});

describe("isSensitiveBashCommand", () => {
  const check = (cmd: string) => (WsBridge as any).isSensitiveBashCommand(cmd);

  it("blocks commands targeting CLAUDE.md", () => {
    expect(check("sed -i 's/foo/bar/' CLAUDE.md")).toBe(true);
    expect(check("cat > /project/CLAUDE.md <<EOF")).toBe(true);
    expect(check("echo 'new rules' >> CLAUDE.md")).toBe(true);
  });

  it("blocks commands targeting .claude/ config files", () => {
    expect(check("tee ~/.claude/hooks/smart-approve.sh")).toBe(true);
    expect(check("rm ~/.claude/settings.json")).toBe(true);
    expect(check("cp evil.json .claude/commands/")).toBe(true);
    expect(check("echo '{}' > .claude/agents/reviewer.md")).toBe(true);
  });

  it("blocks commands targeting companion config", () => {
    expect(check("cat > ~/.companion/settings-3456.json")).toBe(true);
    expect(check("rm ~/.companion/auto-approval/config.json")).toBe(true);
    expect(check("tee ~/.companion/envs/prod.json")).toBe(true);
  });

  it("blocks commands targeting MCP configs", () => {
    expect(check("echo '{}' > .mcp.json")).toBe(true);
    expect(check("cat > ~/.claude.json")).toBe(true);
  });

  it("allows normal bash commands", () => {
    expect(check("git status")).toBe(false);
    expect(check("npm test")).toBe(false);
    expect(check("ls -la /home/user/project")).toBe(false);
    expect(check("cat src/main.ts")).toBe(false);
  });

  it("returns false for empty command", () => {
    expect(check("")).toBe(false);
  });
});

// ─── Codex permission_request herd event ────────────────────────────────────

describe("Codex permission_request emits herd event", () => {
  // Regression: Codex permission requests were stored and broadcast to browsers
  // but never emitted as takode herd events, so orchestrators never learned
  // that a herded worker was blocked waiting for approval.
  it("emits takode permission_request event when Codex adapter sends permission_request", async () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-1",
        tool_name: "Bash",
        description: "rm -rf node_modules",
        input: { command: "rm -rf node_modules" },
      },
    });
    await new Promise(r => setTimeout(r, 50)); // flush async permission pipeline (settings rule check reads from disk)

    // Verify herd event was emitted with correct data
    expect(spy).toHaveBeenCalledWith("s1", "permission_request", expect.objectContaining({
      tool_name: "Bash",
      request_id: "perm-1",
      summary: "rm -rf node_modules",
    }));

    // Verify permission was also stored on the session
    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.has("perm-1")).toBe(true);

    spy.mockRestore();
  });

  it("uses tool_name as summary fallback when description is missing", async () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-2",
        tool_name: "Write",
        // Use a path that won't match any settings.json allow rules (e.g. Write(/tmp/**))
        input: { file_path: "/home/user/project/test.txt" },
      },
    });
    await new Promise(r => setTimeout(r, 50)); // flush async permission pipeline (settings rule check reads from disk)

    expect(spy).toHaveBeenCalledWith("s1", "permission_request", expect.objectContaining({
      tool_name: "Write",
      request_id: "perm-2",
      summary: "Write",
    }));

    spy.mockRestore();
  });
});

// ─── Codex adapter sets cliInitReceived for herd event delivery ────────────

describe("Codex adapter sets cliInitReceived on attach", () => {
  // Without cliInitReceived = true, isSessionIdle() returns false and herd
  // events are never delivered. This is the primary path for Codex sessions
  // after a server restart (cliInitReceived defaults to false, not persisted).
  it("sets cliInitReceived to true when Codex adapter is attached", () => {
    const sid = "s-codex-init";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const session = bridge.getSession(sid)!;
    expect(session.cliInitReceived).toBe(true);
  });

  it("isSessionIdle returns true for idle Codex session after attach", () => {
    const sid = "s-codex-idle";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    // Should be idle: codexAdapter set, cliInitReceived true, not generating
    expect(bridge.isSessionIdle(sid)).toBe(true);
  });

  it("isSessionIdle returns false while Codex session is generating", () => {
    const sid = "s-codex-gen";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-idle-check" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    // Trigger generating state via user message
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "test",
    }));
    adapter.emitTurnStarted("turn-idle-check");

    const session = bridge.getSession(sid)!;
    expect(session.isGenerating).toBe(true);
    expect(bridge.isSessionIdle(sid)).toBe(false);
  });
});

// ─── SDK disconnect auto-relaunch ───────────────────────────────────────────

describe("SDK disconnect auto-relaunch", () => {
  it("requests relaunch when SDK adapter disconnects with active browser", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    adapter.emitDisconnect();

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected" }));
  });

  it("does not request relaunch when no browser is connected", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);
    adapter.emitDisconnect();

    expect(relaunchCb).not.toHaveBeenCalled();
  });

  it("does not request relaunch for idle-manager disconnects", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ killedByIdleManager: true })),
    } as any);

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    adapter.emitDisconnect();

    expect(relaunchCb).not.toHaveBeenCalled();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected", reason: "idle_limit" }));
  });

  it("triggers relaunch for exited SDK session when browser connects", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    // Simulate post-restart: launcher reports SDK session as exited, no adapter attached
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "claude-sdk", state: "exited" })),
    } as any);

    // Create a session in the bridge without an adapter (simulates restoreFromDisk)
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    // Should trigger relaunch, NOT optimistically send backend_connected
    expect(relaunchCb).toHaveBeenCalledWith(sid);
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected" }));
  });

  it("sends backend_connected optimistically for non-exited SDK session without adapter", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    // Simulate active relaunch: launcher reports SDK session as connected
    bridge.setLauncher({
      touchActivity: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "claude-sdk", state: "connected" })),
    } as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    // Should NOT trigger relaunch — adapter is being attached during active relaunch
    expect(relaunchCb).not.toHaveBeenCalled();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_connected" }));
  });
});

describe("cliResuming debounce prevents false compaction events on --resume replay", () => {
  // During --resume, the CLI replays ALL historical system.init messages (one
  // per subagent/Task invocation). The old code cleared cliResuming on every
  // system.init, allowing later replayed system.status "compacting" messages
  // to slip through the guard and emit false compaction_started events.
  // The fix debounces the cliResuming clear — it stays true until 2s after
  // the LAST replayed system.init.

  it("does not emit compaction_started for replayed compacting status after a replayed system.init", () => {
    vi.useFakeTimers();

    // Create a session with existing message history (simulates restore from disk).
    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    // cliResuming should be true because messageHistory is non-empty.
    expect(session.cliResuming).toBe(true);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Simulate replayed system.init (from a subagent) — should NOT clear cliResuming.
    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(session.cliResuming).toBe(true); // still true — debounced

    // Simulate replayed system.status with compacting — should be suppressed.
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
    }));

    // No compaction_started event should have been emitted.
    const compactionCalls = spy.mock.calls.filter(([, event]) => event === "compaction_started");
    expect(compactionCalls).toHaveLength(0);

    // After the debounce window (2s), cliResuming should be cleared.
    vi.advanceTimersByTime(2100);
    expect(session.cliResuming).toBe(false);
    expect(session.state.is_compacting).toBe(false);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it("allows real compaction events after the debounce window expires", () => {
    vi.useFakeTimers();

    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Replayed system.init
    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(session.cliResuming).toBe(true);

    // Wait for debounce to expire.
    vi.advanceTimersByTime(2100);
    expect(session.cliResuming).toBe(false);

    // Now a REAL compaction status arrives — should emit event.
    bridge.handleCLIMessage(cli, JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
    }));

    const compactionCalls = spy.mock.calls.filter(([, event]) => event === "compaction_started");
    expect(compactionCalls).toHaveLength(1);

    spy.mockRestore();
    vi.useRealTimers();
  });

  it("resets debounce timer on each replayed system.init", () => {
    vi.useFakeTimers();

    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // First replayed system.init at t=0
    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(session.cliResuming).toBe(true);

    // Advance 1.5s (less than 2s debounce)
    vi.advanceTimersByTime(1500);
    expect(session.cliResuming).toBe(true); // still resuming

    // Second replayed system.init resets the timer
    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(session.cliResuming).toBe(true);

    // Advance another 1.5s — first timer would have fired, but it was reset
    vi.advanceTimersByTime(1500);
    expect(session.cliResuming).toBe(true); // still resuming (timer reset)

    // Advance past the second timer
    vi.advanceTimersByTime(600);
    expect(session.cliResuming).toBe(false); // now cleared

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

// ─── Stuck session watchdog ─────────────────────────────────────────────────

describe("stuck session watchdog", () => {
  it("does not flag a freshly-started generation with stale lastCliMessageAt", () => {
    vi.useFakeTimers();
    const sid = "s-stuck-false-positive";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Simulate a previous turn that ended 5 minutes ago
    session.lastCliMessageAt = Date.now() - 300_000;
    session.lastCliPingAt = Date.now() - 300_000;

    // Start a new generation (user sends a message)
    session.isGenerating = true;
    session.generationStartedAt = Date.now();
    session.stuckNotifiedAt = null;

    // Start the watchdog
    bridge.startStuckSessionWatchdog();

    // Advance past the 30s check interval
    vi.advanceTimersByTime(31_000);

    // Should NOT have sent session_stuck — generation just started
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(0);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("flags a session stuck after generating for longer than the threshold with no CLI activity", () => {
    vi.useFakeTimers();
    const sid = "s-stuck-real";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago, no CLI activity since
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    // Advance past the check interval
    vi.advanceTimersByTime(31_000);

    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(1);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sends session_unstuck when CLI activity resumes", () => {
    vi.useFakeTimers();
    const sid = "s-stuck-recover";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Session has been generating for 3 minutes with no activity
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    // First tick: should fire session_stuck
    vi.advanceTimersByTime(31_000);
    expect(session.stuckNotifiedAt).not.toBeNull();

    // Simulate CLI activity resuming
    session.lastCliMessageAt = Date.now();

    // Second tick: should fire session_unstuck
    browser.send.mockClear();
    vi.advanceTimersByTime(30_000);

    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const unstuckMessages = sentMessages.filter((m: any) => m.type === "session_unstuck");
    expect(unstuckMessages).toHaveLength(1);
    expect(session.stuckNotifiedAt).toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
