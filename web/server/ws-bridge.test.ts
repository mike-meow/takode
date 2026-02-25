import { vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync: mockExecSync, exec: mockExec }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));

import { WsBridge, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  let onTurnStartFailedCb: ((msg: any) => void) | undefined;

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => { onBrowserMessageCb = cb; }),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => { onSessionMetaCb = cb; }),
    onDisconnect: vi.fn((cb: () => void) => { onDisconnectCb = cb; }),
    onTurnStartFailed: vi.fn((cb: (msg: any) => void) => { onTurnStartFailedCb = cb; }),
    sendBrowserMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    emitBrowserMessage: (msg: any) => onBrowserMessageCb?.(msg),
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: () => onDisconnectCb?.(),
    emitTurnStartFailed: (msg: any) => onTurnStartFailedCb?.(msg),
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
    expect(session.cliSocket).toBeNull();
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

  it("isCliConnected: returns false without CLI socket", () => {
    bridge.getOrCreateSession("s1");
    expect(bridge.isCliConnected("s1")).toBe(false);
    expect(bridge.isCliConnected("nonexistent")).toBe(false);
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
  it("handleCLIOpen: sets cliSocket and broadcasts cli_connected", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    // Clear session_init send calls
    browser.send.mockClear();

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.cliSocket).toBe(cli);
    expect(bridge.isCliConnected("s1")).toBe(true);

    // Should have broadcast cli_connected
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "cli_connected" }));
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
    (session as any).cliSocket = { send: vi.fn() };
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
    (session as any).cliSocket = { send: vi.fn() };

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

  it("handleCLIClose: nulls cliSocket and broadcasts cli_disconnected", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    const session = bridge.getSession("s1")!;
    expect(session.cliSocket).toBeNull();
    expect(bridge.isCliConnected("s1")).toBe(false);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "cli_disconnected" }));
  });

  it("handleCLIClose: cancels pending permissions", async () => {
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
    await new Promise(r => setTimeout(r, 0)); // flush async handleControlRequest
    browser.send.mockClear();

    bridge.handleCLIClose(cli);

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const cancelMsg = calls.find((c: any) => c.type === "permission_cancelled");
    expect(cancelMsg).toBeDefined();
    expect(cancelMsg.request_id).toBe("req-1");
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
    (session as any).cliSocket = { send: vi.fn() };

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

    // message_history is sent after session_subscribe
    browser.send.mockClear();
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));

    const subscribeCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyAfterSubscribe = subscribeCalls.find((c: any) => c.type === "message_history");
    expect(historyAfterSubscribe).toBeDefined();
    expect(historyAfterSubscribe.messages).toHaveLength(1);
    expect(historyAfterSubscribe.messages[0].type).toBe("assistant");
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

    // Also sends cli_disconnected
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const disconnectedMsg = calls.find((c: any) => c.type === "cli_disconnected");
    expect(disconnectedMsg).toBeDefined();
  });

  it("handleBrowserOpen: does NOT relaunch when Codex adapter is attached but still initializing", () => {
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const session = bridge.getOrCreateSession("s1", "codex");
    session.codexAdapter = { isConnected: () => false } as any;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    expect(relaunchCb).not.toHaveBeenCalled();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const disconnectedMsg = calls.find((c: any) => c.type === "cli_disconnected");
    expect(disconnectedMsg).toBeUndefined();
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

    // Ask for replay after seq=1 (cli_connected). Both stream events should replay.
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

  it("session_subscribe: falls back to message_history when last_seq is older than buffer window", () => {
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
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages.some((m: any) => m.type === "assistant")).toBe(true);
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events.some((e: any) => e.message.type === "stream_event")).toBe(true);
  });

  it("session_subscribe no-gap: sends message_history when history-backed events were missed", () => {
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

    // Browser reconnects claiming it last saw seq=1 (cli_connected event).
    // Event buffer covers seqs 2-3 (no gap), but seq=3 is history-backed.
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 1,
    }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Should send message_history because history-backed events were missed
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages.some((m: any) => m.type === "assistant")).toBe(true);
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
    // Should replay the missed transient events
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events).toHaveLength(2);
  });

  it("session_subscribe: sends message_history when event buffer is empty but browser is behind", () => {
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
    const historyMsg = calls.find((c: any) => c.type === "message_history");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.messages.some((m: any) => m.type === "assistant")).toBe(true);
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

  it("result: computes context_used_percent from modelUsage", () => {
    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {
        "claude-sonnet-4-5-20250929": {
          inputTokens: 8000,
          outputTokens: 2000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
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
    // (8000 + 2000) / 200000 * 100 = 5
    expect(state.context_used_percent).toBe(5);
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

  it("user_message with images: builds content blocks", () => {
    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "What's in this image?",
      images: [
        { media_type: "image/png", data: "base64data==" },
      ],
    }));

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("user");
    expect(Array.isArray(sent.message.content)).toBe(true);
    expect(sent.message.content).toHaveLength(2);
    // First block should be the image
    expect(sent.message.content[0].type).toBe("image");
    expect(sent.message.content[0].source.type).toBe("base64");
    expect(sent.message.content[0].source.media_type).toBe("image/png");
    expect(sent.message.content[0].source.data).toBe("base64data==");
    // Second block should be the text
    expect(sent.message.content[1].type).toBe("text");
    expect(sent.message.content[1].text).toBe("What's in this image?");
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
  it("restoreFromDisk: loads sessions from store", async () => {
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
      pendingPermissions: [],
      processedClientMessageIds: ["restored-client-1"],
    });

    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("persisted-1");
    expect(session).toBeDefined();
    expect(session!.state.model).toBe("claude-sonnet-4-5-20250929");
    expect(session!.state.cwd).toBe("/saved");
    expect(session!.state.total_cost_usd).toBe(0.1);
    expect(session!.messageHistory).toHaveLength(1);
    expect(session!.cliSocket).toBeNull();
    expect(session!.browserSockets.size).toBe(0);
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

    const count = await bridge.restoreFromDisk();
    expect(count).toBe(0);

    // Should still have the live model
    const session = bridge.getSession("live-1")!;
    expect(session.state.model).toBe("live-model");
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

  it("sends message_history only after session_subscribe with lastSeq=0", () => {
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

    // Should now receive message_history + state_snapshot
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const historyMsgs = calls.filter((m: any) => m.type === "message_history");
    expect(historyMsgs.length).toBe(1);

    // state_snapshot should be sent last with authoritative transient state
    const snapshots = calls.filter((m: any) => m.type === "state_snapshot");
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toEqual(expect.objectContaining({
      type: "state_snapshot",
      cliConnected: true,
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
    expect(snapshots[0].cliConnected).toBe(true);
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

  it("reports cliConnected as false when CLI is disconnected", () => {
    bridge.handleCLIClose(cli);
    browser.send.mockClear();

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "session_subscribe",
      last_seq: 0,
    }));

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot.cliConnected).toBe(false);
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

  it("deriveSessionStatus returns 'idle' after CLI reconnect (simulating server restart)", () => {
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

    // CLI disconnects (server restart scenario) — isGenerating is reset to false
    bridge.handleCLIClose(cli);

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
    // Key assertion: despite history ending with "assistant", isGenerating is false
    // because CLI disconnect resets it
    expect(snapshot.sessionStatus).toBe("idle");
    expect(snapshot.cliConnected).toBe(true);
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
    (session as any).cliSocket = { send: vi.fn() };

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
    (session as any).cliSocket = { send: vi.fn() };

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
    (session as any).cliSocket = { send: vi.fn() };

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
    (session as any).cliSocket = { send: vi.fn() };

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
    (session as any).cliSocket = { send: vi.fn() };

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
    (session as any).cliSocket = { send: vi.fn() };
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

  it("re-queues the failed message to session.pendingMessages", () => {
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    const failedMsg = { type: "user_message", content: "hello" };
    adapter.emitTurnStartFailed(failedMsg);

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(1);
    expect(JSON.parse(session.pendingMessages[0])).toEqual(failedMsg);
  });

  it("flushes re-queued message to a new adapter on reattach", () => {
    // First adapter: simulate turn-start failure
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter1 as any);
    const failedMsg = { type: "user_message", content: "hello" };
    adapter1.emitTurnStartFailed(failedMsg);

    // Simulate disconnect
    adapter1.emitDisconnect();

    // Second adapter: should receive the re-queued message
    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter2 as any);

    expect(adapter2.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "hello" }),
    );
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(0);
  });
});

describe("Codex runtime settings updates", () => {
  it("set_model updates launcher/session state and requests relaunch", async () => {
    const sid = "s1";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const launcherInfo = { model: "gpt-5.2-codex", permissionMode: "plan" };
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
    const launcherInfo = { model: "gpt-5.2-codex", codexReasoningEffort: undefined };
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
});

describe("Codex /compact passthrough", () => {
  it("forwards /compact to adapter as a normal user message", async () => {
    const browser = makeBrowserSocket("s1");
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "/compact",
    }));

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

describe("Codex image transport", () => {
  // Prefer local image paths for Codex turn/start to avoid persisting large
  // data: URLs in thread history. If local paths are unavailable, fall back to
  // compressed inline base64 payloads.
  //
  // NOTE: handleBrowserMessage does NOT await routeBrowserMessage (fire-and-forget),
  // so tests need a microtask flush after the call for async image operations.

  /** Flush microtask queue so async routeBrowserMessage completes. */
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("sends local image paths to Codex when stored originals are available", async () => {
    const adapter = makeCodexAdapterMock();

    // Create a mock imageStore that can resolve local original paths.
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getOriginalPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.orig.png"),
      compressForTransport: vi.fn().mockResolvedValue({
        base64: "compressed-base64-data",
        mediaType: "image/jpeg",
      }),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);

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
    const sentMsg = adapter.sendBrowserMessage.mock.calls[0][0];
    expect(sentMsg.local_images).toEqual(["/tmp/companion-images/img-1.orig.png"]);
    expect(sentMsg.images).toBeUndefined();
    expect(mockImageStore.compressForTransport).not.toHaveBeenCalled();
  });

  it("falls back to compressed inline images when local path lookup fails", async () => {
    const adapter = makeCodexAdapterMock();

    // Mock imageStore where original path lookup fails.
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getOriginalPath: vi.fn().mockResolvedValue(null),
      compressForTransport: vi.fn().mockResolvedValue({
        base64: "compressed-fallback-data",
        mediaType: "image/jpeg",
      }),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "what is this?",
      images: [{ media_type: "image/png", data: "small-data" }],
    }));
    await flush();

    // Adapter receives compressed inline data and no local_images.
    const sentMsg = adapter.sendBrowserMessage.mock.calls[0][0];
    expect(mockImageStore.compressForTransport).toHaveBeenCalledWith("small-data", "image/png");
    expect(sentMsg.images[0].data).toBe("compressed-fallback-data");
    expect(sentMsg.images[0].media_type).toBe("image/jpeg");
    expect(sentMsg.local_images).toBeUndefined();
  });

  it("skips compression when imageStore is not set", async () => {
    const adapter = makeCodexAdapterMock();
    // No imageStore set on bridge
    bridge.attachCodexAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(browser, JSON.stringify({
      type: "user_message",
      content: "no store",
      images: [{ media_type: "image/png", data: "raw-data" }],
    }));
    await flush();

    // Adapter receives original message (no compression without imageStore)
    const sentMsg = adapter.sendBrowserMessage.mock.calls[0][0];
    expect(sentMsg.images[0].data).toBe("raw-data");
  });
});
