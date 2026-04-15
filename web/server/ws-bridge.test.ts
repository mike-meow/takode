import { vi } from "vitest";

const mockExecSync = vi.hoisted(() => vi.fn());
const mockExec = vi.hoisted(() => vi.fn());
const mockShouldSettingsRuleApprove = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("node:child_process", () => ({ execSync: mockExecSync, exec: mockExec }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-uuid" }));
// Mock settings rule loading so real user ~/.claude/settings.json rules don't
// interfere with tests. Tests that need specific rules override this per-call.
vi.mock("./bridge/settings-rule-matcher.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./bridge/settings-rule-matcher.js")>();
  return {
    ...original,
    shouldSettingsRuleApprove: mockShouldSettingsRuleApprove,
  };
});

import { WsBridge, type SocketData } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { HerdEventDispatcher } from "./herd-event-dispatcher.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** Flush all pending microtasks and setTimeout(0) callbacks so async sendHistorySync and deferred traffic stats complete. */
async function flushAsync() {
  // Flush microtasks (queueMicrotask in traffic stats)
  await Promise.resolve();
  // Flush setTimeout(0) (yieldToEventLoop in sendHistorySync)
  await new Promise((r) => setTimeout(r, 0));
  // One more microtask pass for any traffic stats queued after the yield
  await Promise.resolve();
}

function makeCodexAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;
  let onTurnStartFailedCb: ((msg: any) => void) | undefined;
  let onTurnStartedCb: ((turnId: string) => void) | undefined;
  let onTurnSteeredCb: ((turnId: string, pendingInputIds: string[]) => void) | undefined;
  let onTurnSteerFailedCb: ((pendingInputIds: string[]) => void) | undefined;
  let currentTurnId: string | null = null;
  const rollbackTurns = vi.fn(async (_numTurns: number) => {});

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => {
      onBrowserMessageCb = cb;
    }),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => {
      onSessionMetaCb = cb;
    }),
    onDisconnect: vi.fn((cb: () => void) => {
      onDisconnectCb = cb;
    }),
    onInitError: vi.fn((cb: (error: string) => void) => {
      onInitErrorCb = cb;
    }),
    onTurnStartFailed: vi.fn((cb: (msg: any) => void) => {
      onTurnStartFailedCb = cb;
    }),
    onTurnStarted: vi.fn((cb: (turnId: string) => void) => {
      onTurnStartedCb = cb;
    }),
    onTurnSteered: vi.fn((cb: (turnId: string, pendingInputIds: string[]) => void) => {
      onTurnSteeredCb = cb;
    }),
    onTurnSteerFailed: vi.fn((cb: (pendingInputIds: string[]) => void) => {
      onTurnSteerFailedCb = cb;
    }),
    sendBrowserMessage: vi.fn((_msg?: any) => true),
    rollbackTurns,
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    getThreadId: vi.fn(() => "thread-ready"),
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
    emitTurnSteered: (turnId: string, pendingInputIds: string[]) => {
      onTurnSteeredCb?.(turnId, pendingInputIds);
    },
    emitTurnSteerFailed: (pendingInputIds: string[]) => {
      onTurnSteerFailedCb?.(pendingInputIds);
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

function getCodexStartPendingInputs(msg: any) {
  expect(msg?.type).toBe("codex_start_pending");
  expect(Array.isArray(msg?.inputs)).toBe(true);
  return msg.inputs as Array<{ content: string; local_images?: string[] }>;
}

function expectCodexStartPendingTurnLike(
  turn: any,
  expected: {
    firstContent?: string;
    firstContentContaining?: string;
    firstLocalImages?: string[];
    status?: string;
    dispatchCount?: number;
    userContent?: string;
    turnId?: string | null;
    turnTarget?: string | null;
  } = {},
) {
  expect(turn).toBeTruthy();
  expect(turn.adapterMsg?.type).toBe("codex_start_pending");
  const inputs = getCodexStartPendingInputs(turn.adapterMsg);
  expect(inputs.length).toBeGreaterThan(0);
  if (expected.firstContent !== undefined) {
    expect(inputs[0]?.content).toBe(expected.firstContent);
  }
  if (expected.firstContentContaining !== undefined) {
    expect(inputs[0]?.content).toContain(expected.firstContentContaining);
  }
  if (expected.firstLocalImages !== undefined) {
    expect(inputs[0]?.local_images).toEqual(expected.firstLocalImages);
  }
  if (expected.status !== undefined) {
    expect(turn.status).toBe(expected.status);
  }
  if (expected.dispatchCount !== undefined) {
    expect(turn.dispatchCount).toBe(expected.dispatchCount);
  }
  if (expected.userContent !== undefined) {
    expect(turn.userContent).toBe(expected.userContent);
  }
  if ("turnId" in expected) {
    expect(turn.turnId).toBe(expected.turnId);
  }
  if ("turnTarget" in expected) {
    expect(turn.turnTarget).toBe(expected.turnTarget);
  }
}

function makeClaudeSdkAdapterMock() {
  let onBrowserMessageCb: ((msg: any) => void) | undefined;
  let onSessionMetaCb: ((meta: any) => void) | undefined;
  let onDisconnectCb: (() => void) | undefined;
  let onInitErrorCb: ((error: string) => void) | undefined;
  let onCompactRequestedCb: (() => void) | undefined;

  return {
    onBrowserMessage: vi.fn((cb: (msg: any) => void) => {
      onBrowserMessageCb = cb;
    }),
    onSessionMeta: vi.fn((cb: (meta: any) => void) => {
      onSessionMetaCb = cb;
    }),
    onDisconnect: vi.fn((cb: () => void) => {
      onDisconnectCb = cb;
    }),
    onInitError: vi.fn((cb: (error: string) => void) => {
      onInitErrorCb = cb;
    }),
    onCompactRequested: vi.fn((cb: () => void) => {
      onCompactRequestedCb = cb;
    }),
    sendBrowserMessage: vi.fn(),
    drainPendingOutgoing: vi.fn((): any[] => []),
    isConnected: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    emitBrowserMessage: (msg: any) => onBrowserMessageCb?.(msg),
    emitSessionMeta: (meta: any) => onSessionMetaCb?.(meta),
    emitDisconnect: () => onDisconnectCb?.(),
    emitInitError: (error: string) => onInitErrorCb?.(error),
    emitCompactRequested: () => onCompactRequestedCb?.(),
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
  mockShouldSettingsRuleApprove.mockReset().mockResolvedValue(null);
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

// localDateKey is a private static — access via `any` cast for testing.
describe("WsBridge.localDateKey", () => {
  const localDateKey = (ts: number) => (WsBridge as any).localDateKey(ts);

  it("returns YYYY-MM-DD using local date components, not UTC", () => {
    // Test the core contract: output matches getFullYear/getMonth/getDate
    // on a Date constructed from the timestamp. Near UTC midnight, local vs
    // UTC dates diverge for non-UTC timezones.
    const ts = new Date(2026, 2, 31, 23, 45, 0).getTime(); // Mar 31, 11:45 PM local
    const d = new Date(ts);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(localDateKey(ts)).toBe(expected);
  });

  it("zero-pads month and day", () => {
    const ts = new Date(2026, 0, 5, 12, 0, 0).getTime(); // Jan 5 local
    expect(localDateKey(ts)).toBe("2026-01-05");
  });

  it("handles year boundary (Dec 31 → Jan 1)", () => {
    const dec31 = new Date(2025, 11, 31, 23, 59, 0).getTime(); // Dec 31 local
    const jan1 = new Date(2026, 0, 1, 0, 1, 0).getTime(); // Jan 1 local
    expect(localDateKey(dec31)).toBe("2025-12-31");
    expect(localDateKey(jan1)).toBe("2026-01-01");
    // Keys must differ so the date boundary triggers
    expect(localDateKey(dec31)).not.toBe(localDateKey(jan1));
  });
});

describe("traffic accounting", () => {
  it("tracks browser fanout using successful sends only", async () => {
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s1");

    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.resetTrafficStats();

    browser2.send.mockImplementation(() => {
      throw new Error("socket failed");
    });

    bridge.broadcastSessionUpdate("s1", { cwd: "/repo" });
    await flushAsync(); // traffic stats are now deferred via queueMicrotask

    const snapshot = bridge.getTrafficStatsSnapshot();
    const bucket = snapshot.buckets.find(
      (entry) => entry.channel === "browser" && entry.direction === "out" && entry.messageType === "session_update",
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
      (entry) => entry.channel === "browser" && entry.direction === "in" && entry.messageType === "session_subscribe",
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
      (entry) => entry.channel === "cli" && entry.direction === "in" && entry.messageType === "keep_alive",
    );
    const cliOut = snapshot.buckets.find(
      (entry) => entry.channel === "cli" && entry.direction === "out" && entry.messageType === "user",
    );

    expect(cliIn?.messages).toBe(1);
    expect(cliOut?.messages).toBe(1);
    expect(cliOut?.wireBytes).toBe(cliOut?.payloadBytes);
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Codex pending input delivery", () => {
  it("keeps Codex user input pending until turn/start acknowledges delivery", async () => {
    const sid = "s-codex-pending";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-pending", model: "gpt-5.4", cwd: "/repo" });
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "steer me later",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]).toMatchObject({
      content: "steer me later",
    });
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "steer me later"),
    ).toBe(false);

    const pendingBroadcast = browser.send.mock.calls
      .map(([arg]: [string]) => JSON.parse(arg))
      .find((msg: any) => msg.type === "codex_pending_inputs");
    expect(pendingBroadcast?.inputs).toHaveLength(1);

    adapter.emitTurnStarted("turn-pending");

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "steer me later"),
    ).toBe(true);
  });

  it("cancels still-local pending Codex input before delivery", async () => {
    const sid = "s-codex-cancel-pending";
    const browser = makeBrowserSocket(sid);
    bridge.getOrCreateSession(sid, "codex");
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "do not deliver this",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    const pendingId = session.pendingCodexInputs[0]?.id;
    expect(pendingId).toBeTruthy();
    expect(session.pendingCodexInputs[0]?.cancelable).toBe(true);
    expect(session.pendingCodexTurns).toHaveLength(1);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: pendingId,
      }),
    );
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "do not deliver this"),
    ).toBe(false);
  });

  it("restores pending Codex inputs across restart and delivers them on reconnect", async () => {
    const sid = "s-codex-persisted-pending";
    store.saveSync({
      id: sid,
      state: bridge.getOrCreateSession(sid, "codex").state,
      messageHistory: [],
      pendingMessages: [],
      pendingCodexInputs: [
        {
          id: "pending-persisted-1",
          content: "re-deliver me after restart",
          timestamp: 1,
          cancelable: true,
          draftImages: [],
          deliveryContent: "re-deliver me after restart",
        },
      ],
      pendingPermissions: [],
    });

    await store.flushAll(); // ensure fire-and-forget writeFile completes before reading back

    const restored = new WsBridge();
    restored.setStore(store);
    await restored.restoreFromDisk();

    const adapter = makeCodexAdapterMock();
    restored.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-restored-pending" });

    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        pendingInputIds: ["pending-persisted-1"],
      }),
    );
  });
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

  it("session_quest_claimed is not buffered for event replay (prevents stale chips on reconnect)", () => {
    // Quest lifecycle events are one-shot notifications that generate ephemeral
    // chat chips. Buffering them causes stale chips from previous quest operations
    // to reappear when a browser reconnects after server restart.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.setSessionClaimedQuest("s1", { id: "q-1", title: "Quest One", status: "in_progress" });

    const session = bridge.getSession("s1")!;
    const bufferedTypes = session.eventBuffer.map((e: any) => e.message.type);
    expect(bufferedTypes).not.toContain("session_quest_claimed");
  });

  it("session_name_update is not buffered for event replay (prevents stale names on reconnect)", () => {
    // Session name updates are one-shot notifications. Replaying stale name
    // updates on reconnect would overwrite the current name with old values.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.broadcastNameUpdate("s1", "New Session Name", "quest");

    const session = bridge.getSession("s1")!;
    const bufferedTypes = session.eventBuffer.map((e: any) => e.message.type);
    expect(bufferedTypes).not.toContain("session_name_update");
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

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello queued",
      }),
    );

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
    // CLI-bound content gets a [User HH:MM] timestamp prefix
    expect(parsed.message.content).toMatch(/^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] hello queued$/);
  });

  // ── WebSocket system prompt injection via initialize control_request ──

  /** Parse CLI socket send calls and find the initialize control_request, if any. */
  function findInitializeMsg(cli: ReturnType<typeof makeCliSocket>) {
    const sent = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg.trim()));
    return sent.find((m: any) => m.type === "control_request" && m.request?.subtype === "initialize") as
      | { type: string; request_id: string; request: { subtype: string; appendSystemPrompt?: string } }
      | undefined;
  }

  /** Set up a mock launcher returning a session with the given backendType and optional instructions. */
  function setLauncherSession(backendType: string, instructions?: string) {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({
        sessionId: "s1",
        state: "connected",
        backendType,
        ...(instructions !== undefined ? { injectedSystemPrompt: instructions } : {}),
      })),
    } as any);
  }

  it("handleCLIOpen: sends initialize control_request with appendSystemPrompt for WebSocket sessions", () => {
    // The --append-system-prompt CLI flag is not honored in --sdk-url mode.
    // Instead, we send a control_request {subtype: "initialize", appendSystemPrompt}
    // over the WebSocket before the first user message.
    const instructions =
      "## Session Timers\n\nUse `takode timer` to create timers.\n\n## Link Syntax\n\nTest instructions";
    setLauncherSession("claude", instructions);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    const initMsg = findInitializeMsg(cli);
    expect(initMsg).toBeDefined();
    expect(initMsg!.request.appendSystemPrompt).toBe(instructions);
    expect(initMsg!.request_id).toBeDefined();

    const session = bridge.getSession("s1")!;
    expect(session.cliInitializeSent).toBe(true);
  });

  it("handleCLIOpen: does NOT send initialize for SDK sessions", () => {
    // SDK sessions inject system prompts via V4.prototype.initialize patching,
    // not via WebSocket control_request.
    setLauncherSession("claude-sdk", "some instructions");

    const session = bridge.getOrCreateSession("s1", "claude-sdk");
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    expect(findInitializeMsg(cli)).toBeUndefined();
    expect(session.cliInitializeSent).toBe(false);
  });

  it("handleCLIOpen: does NOT send initialize for Codex sessions", () => {
    // Codex uses JSON-RPC initialize, not the NDJSON control_request.
    setLauncherSession("codex", "some instructions");

    const session = bridge.getOrCreateSession("s1", "codex");
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    expect(findInitializeMsg(cli)).toBeUndefined();
    expect(session.cliInitializeSent).toBe(false);
  });

  it("handleCLIOpen: does NOT send initialize when no injectedSystemPrompt", () => {
    // If the launcher has no instructions, skip the initialize request.
    setLauncherSession("claude");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    expect(findInitializeMsg(cli)).toBeUndefined();

    const session = bridge.getSession("s1")!;
    expect(session.cliInitializeSent).toBe(false);
  });

  it("handleCLIOpen: does NOT send initialize when injectedSystemPrompt is empty string", () => {
    // Empty string is falsy -- should not trigger an initialize request.
    setLauncherSession("claude", "");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    expect(findInitializeMsg(cli)).toBeUndefined();
    expect(bridge.getSession("s1")!.cliInitializeSent).toBe(false);
  });

  it("handleCLIOpen: seamless reconnect does NOT re-send initialize", () => {
    // When CLI disconnects for token refresh and reconnects within the grace
    // period, we should NOT re-send initialize (same process, already initialized).
    setLauncherSession("claude", "## Timers\nTest");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // First connect -- should send initialize
    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    const session = bridge.getSession("s1")!;
    expect(session.cliInitializeSent).toBe(true);

    // Simulate disconnect (triggers grace timer)
    bridge.handleCLIClose(cli1, 1006, "token refresh");

    // Reconnect within grace period (seamless)
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");

    // cliInitializeSent should still be true (not reset)
    expect(session.cliInitializeSent).toBe(true);
    expect(findInitializeMsg(cli2)).toBeUndefined();
  });

  it("handleCLIOpen: relaunch resets cliInitializeSent and re-sends initialize", () => {
    // When a CLI process is killed and relaunched, the new process needs
    // a fresh initialize control_request.
    const instructions = "## Timers\nTest";
    setLauncherSession("claude", instructions);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // First connect
    const cli1 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli1, "s1");
    const session = bridge.getSession("s1")!;
    expect(session.cliInitializeSent).toBe(true);

    // Simulate disconnect
    bridge.handleCLIClose(cli1, 1006, "relaunch");

    // Mark relaunch pending (as cli-launcher does via onBeforeRelaunch callback)
    bridge.markRelaunchPending("s1");

    // New CLI process connects
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");

    // cliInitializeSent should be true again (reset then re-sent)
    expect(session.cliInitializeSent).toBe(true);

    const initMsg2 = findInitializeMsg(cli2);
    expect(initMsg2).toBeDefined();
    expect(initMsg2!.request.appendSystemPrompt).toBe(instructions);
  });

  it("handleCLIOpen: initialize is sent BEFORE queued user messages", () => {
    // The NDJSON protocol requires initialize to be sent before the first user
    // message. Verify ordering when there are pending messages.
    setLauncherSession("claude", "## Timers\nTest");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Queue a user message before CLI connects
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "hello" }));

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Check ordering: initialize should come before the user message
    const sent = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg.trim()));
    const initIdx = sent.findIndex((m: any) => m.type === "control_request" && m.request?.subtype === "initialize");
    const userIdx = sent.findIndex((m: any) => m.type === "user");
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeLessThan(userIdx);
  });

  it("handleCLIMessage: system.init does not re-flush already-sent messages", () => {
    // Messages are flushed on CLI connect, so by the time system.init
    // arrives the queue should already be empty.
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello queued",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello",
      }),
    );
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

    bridge.handleCLIMessage(
      cli,
      makeInitMsg({
        model: "claude-opus-4-5-20250929",
        cwd: "/workspace",
        tools: ["Bash", "Read", "Edit"],
        permissionMode: "bypassPermissions",
        claude_code_version: "2.0",
        mcp_servers: [{ name: "test-mcp", status: "connected" }],
        agents: ["agent1"],
        slash_commands: ["/commit"],
        skills: ["pdf"],
      }),
    );

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
    bridge.markWorktree(
      "s1",
      "/home/user/companion",
      "/home/user/.companion/worktrees/companion/jiayi-wt-1234",
      "jiayi",
    );

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

  it("markWorktree: preserves an explicit default diff base selection", () => {
    // Restart path: an explicit "use default" selection persists as empty-string
    // plus the explicit flag, and worktree prepopulation must not overwrite it.
    const session = bridge.getOrCreateSession("s1");
    session.state.diff_base_branch = "";
    session.state.diff_base_branch_explicit = true;

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");

    const state = bridge.getSession("s1")!.state;
    expect(state.git_default_branch).toBe("jiayi");
    expect(state.diff_base_branch).toBe("");
    expect(state.diff_base_branch_explicit).toBe(true);
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
    expect(state.diff_base_branch_explicit).toBe(true);
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
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ diff_base_branch: "feature-branch" }),
      }),
    );

    // Non-existent session returns false
    expect(bridge.setDiffBaseBranch("nonexistent", "main")).toBe(false);
  });

  it("setDiffBaseBranch recomputes diff stats even without a CLI connection", async () => {
    // Regression: changing diff base from the UI left stale line stats when
    // no CLI was connected, because recomputeDiffIfDirty's guard skipped idle sessions.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "42\t17\tfile.ts\n";
      return "";
    });

    bridge.markWorktree("s1", "/home/user/companion", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    // Intentionally NO backendSocket -- simulates a session without active CLI
    // Seed stale stats that should be overwritten
    session.state.total_lines_added = 219;
    session.state.total_lines_removed = 126;

    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    browserWs.send.mockClear();

    bridge.setDiffBaseBranch("s1", "jiayi");

    // Wait for async diff computation to complete
    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(42);
    });
    expect(session.state.total_lines_removed).toBe(17);

    // Verify the updated stats were broadcast to the browser
    const calls = (browserWs.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({
          total_lines_added: 42,
          total_lines_removed: 17,
        }),
      }),
    );
  });

  it("setDiffBaseBranch: marks an explicit default selection and persists the empty branch", async () => {
    // The real UI setter path sends empty-string when the user explicitly chooses
    // the repo default branch. That selection must become authoritative state.
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "abc123\n";
      if (cmd.includes("diff --numstat")) return "0\t0\tfile.ts\n";
      return "";
    });

    bridge.markWorktree("s1", "/home/user/companion", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    (session as any).backendSocket = { send: vi.fn() };
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    const saveSpy = vi.spyOn(store, "save");
    browserWs.send.mockClear();

    const result = bridge.setDiffBaseBranch("s1", "");
    expect(result).toBe(true);

    await vi.waitFor(() => {
      expect(saveSpy).toHaveBeenCalled();
    });

    const state = bridge.getSession("s1")!.state;
    expect(state.diff_base_branch).toBe("");
    expect(state.diff_base_branch_explicit).toBe(true);

    const saved = saveSpy.mock.calls.at(-1)?.[0];
    expect(saved?.state.diff_base_branch).toBe("");
    expect(saved?.state.diff_base_branch_explicit).toBe(true);

    const messages = browserWs.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ diff_base_branch: "" }),
      }),
    );
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
    const gitCommands = mockExec.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((cmd) => cmd.includes("rev-parse"));
    expect(gitCommands).toContainEqual(
      expect.stringContaining(
        "git --no-optional-locks -c core.fsmonitor=false rev-parse --abbrev-ref --symbolic-full-name jiayi@{upstream}",
      ),
    );
    for (const cmd of gitCommands) {
      expect(cmd).toContain("-c core.fsmonitor=false");
    }
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

  it("handleCLIMessage: system.init preserves an explicit non-worktree diff base branch", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("jiayi@{upstream}")) return "origin/jiayi\n";
      if (cmd.includes("--left-right --count") && cmd.includes("main...HEAD")) return "0\t3\n";
      if (cmd.includes("for-each-ref")) return "jiayi\n";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main\n";
      if (cmd.includes("--left-right --count") && cmd.includes("origin/jiayi...HEAD")) return "0\t0\n";
      if (cmd.includes("diff --numstat")) return "";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "main";
    session.state.diff_base_branch_explicit = true;
    (session as any).backendSocket = { send: vi.fn() };

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    await vi.waitFor(() => {
      expect(session.state.git_default_branch).toBe("origin/jiayi");
      expect(session.state.diff_base_branch).toBe("main");
      expect(session.state.diff_base_branch_explicit).toBe(true);
      expect(session.state.git_ahead).toBe(3);
      expect(session.state.git_behind).toBe(0);
    });
  });

  it("handleCLIMessage: transient git failure does not erase an explicit diff base branch", async () => {
    // A transient refresh failure should not rewrite explicit branch selections.
    mockExecSync.mockImplementation(() => {
      throw new Error("git unavailable");
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "main";
    session.state.diff_base_branch_explicit = true;
    (session as any).backendSocket = { send: vi.fn() };

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    await vi.waitFor(() => {
      expect(session.state.git_branch).toBe("");
      expect(session.state.diff_base_branch).toBe("main");
      expect(session.state.diff_base_branch_explicit).toBe(true);
    });

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return ".git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("jiayi@{upstream}")) return "origin/jiayi\n";
      if (cmd.includes("--left-right --count") && cmd.includes("main...HEAD")) return "0\t3\n";
      if (cmd.includes("for-each-ref")) return "jiayi\n";
      if (cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) return "refs/remotes/origin/main\n";
      if (cmd.includes("--left-right --count") && cmd.includes("origin/jiayi...HEAD")) return "0\t0\n";
      if (cmd.includes("diff --numstat")) return "";
      throw new Error(`unknown git cmd: ${cmd}`);
    });

    bridge.handleCLIMessage(cli, makeInitMsg({ cwd: "/repo" }));

    await vi.waitFor(() => {
      expect(session.state.git_default_branch).toBe("origin/jiayi");
      expect(session.state.diff_base_branch).toBe("main");
      expect(session.state.diff_base_branch_explicit).toBe(true);
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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Do something",
      }),
    );
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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Do something",
      }),
    );
    const session = bridge.getSession("s1")!;
    expect(session.isGenerating).toBe(true);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // CLI disconnects and grace period expires (relaunch scenario)
    bridge.handleCLIClose(cli1);
    vi.advanceTimersByTime(16_000); // past 15s grace period

    // runFullDisconnect should have emitted turn_end
    const turnEndCalls = spy.mock.calls.filter(([, event]) => event === "turn_end");
    expect(turnEndCalls).toHaveLength(1);
    expect(turnEndCalls[0]?.[2]).toEqual(expect.objectContaining({ interrupted: true, interrupt_source: "system" }));
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

    bridge.handleBrowserMessage(
      seedBrowser,
      JSON.stringify({
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
      }),
    );

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
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest

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

  it("handleBrowserOpen: Codex dead backend enters recovering state before relaunch", () => {
    const sid = "s-codex-browser-open-dead";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "codex", state: "connected", killedByIdleManager: false })),
    } as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(bridge.getSession(sid)?.state.backend_state).toBe("recovering");
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected" }));
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ backend_state: "recovering", backend_error: null }),
      }),
    );
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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
        parent_tool_use_id: null,
        uuid: "u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "s1",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Ask for replay after seq=1 (backend_connected). Both stream events should replay.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const replay = calls.find((c: any) => c.type === "event_replay");
    expect(replay).toBeDefined();
    expect(replay.events).toHaveLength(2);
    expect(replay.events[0].seq).toBe(2);
    expect(replay.events[0].message.type).toBe("stream_event");
  });

  it("session_subscribe: falls back to full history sync when known_frozen_count is invalid", async () => {
    // When the browser claims a frozen count larger than the server's rendered
    // count, the initial sync is refused. The fallback retries with
    // knownFrozenCount=0, delivering a full history_sync so the browser is
    // never left without history.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Populate history so fallback payload has content.
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    // Generate several stream events, then trim the first one from in-memory buffer.
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "1" } },
        parent_tool_use_id: null,
        uuid: "se-u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "2" } },
        parent_tool_use_id: null,
        uuid: "se-u2",
        session_id: "s1",
      }),
    );
    const session = bridge.getSession("s1")!;
    session.eventBuffer.shift();
    session.eventBuffer.shift(); // force earliest seq high enough to create a gap for last_seq=1

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();
    (browser.data as any).subscribed = true;

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
        known_frozen_count: 99,
      }),
    );
    await flushAsync(); // sendHistorySync is async

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.some((c: any) => c.type === "message_history")).toBe(false);
    // Fallback full history_sync should be delivered
    const historySync = calls.find((c: any) => c.type === "history_sync");
    expect(historySync).toBeDefined();
    expect(historySync.frozen_base_count).toBe(0);
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    expect(replayMsg.events.some((e: any) => e.message.type === "stream_event")).toBe(true);
    expect(calls.some((c: any) => c.type === "state_snapshot")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("session_subscribe: falls back to full history sync when known_frozen_hash mismatches", async () => {
    // When the browser sends a stale frozen hash on reconnect, the server
    // should detect the mismatch and retry with a full history delivery
    // (frozen_base_count=0) instead of leaving the browser with no history.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user_message",
        content: "hello",
        timestamp: 1000,
        session_id: "s1",
        uuid: "u1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
        known_frozen_count: 2,
        known_frozen_hash: "deadbeef",
      }),
    );
    await flushAsync(); // sendHistorySync is async

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Should NOT get legacy message_history
    expect(calls.some((c: any) => c.type === "message_history")).toBe(false);
    // SHOULD get a fallback full history_sync with frozen_base_count=0
    const historySync = calls.find((c: any) => c.type === "history_sync");
    expect(historySync).toBeDefined();
    expect(historySync.frozen_base_count).toBe(0);
    // The mismatch/invalid-count warning should still be logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[history-sync]"));
    expect(calls.some((c: any) => c.type === "state_snapshot")).toBe(true);
    warnSpy.mockRestore();
  });

  it("session_subscribe: falls back to full history sync on gap path with stale frozen hash", async () => {
    // Exercises the gap-recovery code path (lastAckSeq > 0, hasGap=true) with
    // a frozen hash mismatch. The fallback should deliver full history_sync
    // just like the fresh connection path.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user_message",
        content: "hello",
        timestamp: 1000,
        session_id: "s1",
        uuid: "u1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "gap-hist-1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "gap test" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "gap-hist-u1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        session_id: "s1",
        uuid: "gap-res-1",
        stop_reason: "end_turn",
      }),
    );

    // Force a gap by clearing eventBuffer so the browser's last_seq=1 is
    // before the earliest buffered seq.
    const session = bridge.getSession("s1")!;
    session.eventBuffer.length = 0;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // last_seq=1 + empty eventBuffer → hasGap=true → gap recovery path.
    // known_frozen_hash is stale → sendHistorySyncAttempt returns false →
    // fallback delivers full history.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
        known_frozen_count: 2,
        known_frozen_hash: "stale-gap-hash",
      }),
    );
    await flushAsync();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historySync = calls.find((c: any) => c.type === "history_sync");
    expect(historySync).toBeDefined();
    expect(historySync.frozen_base_count).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[history-sync]"));
    expect(calls.some((c: any) => c.type === "state_snapshot")).toBe(true);
    warnSpy.mockRestore();
  });

  it("logs a warning when the browser reports a history_sync mismatch", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "history_sync_mismatch",
        frozen_count: 3,
        expected_frozen_hash: "expected-frozen",
        actual_frozen_hash: "actual-frozen",
        expected_full_hash: "expected-full",
        actual_full_hash: "actual-full",
      }),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[history-sync] Browser reported hash mismatch for session"),
    );
    expect(browser.send).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("session_subscribe no-gap: sends history_sync when history-backed events were missed", async () => {
    // Simulates a mobile browser that disconnected while the session was generating,
    // then reconnects. The event buffer covers the gap (no gap), but the browser
    // missed assistant messages that need to be delivered via message_history.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate a stream_event (transient, seq=2) then an assistant message (history-backed, seq=3)
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "streaming" } },
        parent_tool_use_id: null,
        uuid: "se-1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Browser reconnects claiming it last saw seq=1 (backend_connected event).
    // Event buffer covers seqs 2-3 (no gap), but seq=3 is history-backed.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );
    await flushAsync(); // sendHistorySync is async

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    // Should send history_sync because history-backed events were missed
    const historyMsg = calls.find((c: any) => c.type === "history_sync");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.hot_messages.some((m: any) => m.type === "assistant")).toBe(true);
    // Should also replay transient events (stream_event, status_change) that were missed.
    // status_change appears because the assistant message triggers cli_initiated_turn
    // detection (the CLI started outputting without a prior user message).
    const replayMsg = calls.find((c: any) => c.type === "event_replay");
    expect(replayMsg).toBeDefined();
    const transientTypes = new Set(["stream_event", "status_change"]);
    expect(replayMsg.events.every((e: any) => transientTypes.has(e.message.type))).toBe(true);
  });

  it("session_subscribe no-gap: skips message_history when only transient events were missed", () => {
    // When the browser only missed transient events (stream_event, tool_progress),
    // no message_history should be sent — just event_replay.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");

    // Generate only transient events
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "a" } },
        parent_tool_use_id: null,
        uuid: "se-t1",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "b" } },
        parent_tool_use_id: null,
        uuid: "se-t2",
        session_id: "s1",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    const session = bridge.getSession("s1")!;
    // Clear the event buffer to simulate pruning, but keep nextEventSeq advanced
    session.eventBuffer.length = 0;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Browser is behind (last_seq=1 but nextEventSeq > 2)
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 1,
      }),
    );

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const historyMsg = calls.find((c: any) => c.type === "history_sync");
    expect(historyMsg).toBeDefined();
    expect(historyMsg.hot_messages.some((m: any) => m.type === "assistant")).toBe(true);
  });

  it("session_ack: updates lastAckSeq for the session", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_ack",
        last_seq: 42,
      }),
    );

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
        usage: {
          input_tokens: 4000,
          output_tokens: 2000,
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 30000,
        },
      },
      parent_tool_use_id: null,
      uuid: "uuid-context-mid-turn",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    // (4000 + 5000 + 30000) / 200000 * 100 = 20
    // output_tokens (2000) excluded — they are generated, not context occupants
    expect(bridge.getSession("s1")!.state.context_used_percent).toBe(20);
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const contextUpdate = calls.find((c: any) => c.type === "session_update" && c.session?.context_used_percent === 20);
    expect(contextUpdate).toBeDefined();
  });

  it("assistant: does not recursively re-inject reminder on system-triggered turns", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    // Simulate a prior system reminder being injected (turn trigger source = system).
    bridge.injectUserMessage("s1", "[System] prior reminder", {
      sessionId: "system:leader-tag-enforcer",
      sessionLabel: "System",
    });

    const reminderCountBefore = cli.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(String(payload).trim()))
      .filter(
        (payload: any) => payload.type === "user" && String(payload.message?.content).includes("As a leader session"),
      ).length;

    // Assistant still forgets the suffix on this reminder-triggered turn.
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "",
        is_error: false,
        total_cost_usd: 0.01,
        num_turns: 1,
        session_id: "s1",
      }),
    );

    const reminderCountAfter = cli.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(String(payload).trim()))
      .filter(
        (payload: any) => payload.type === "user" && String(payload.message?.content).includes("As a leader session"),
      ).length;

    expect(reminderCountAfter).toBe(reminderCountBefore);
  });

  it("assistant: does not inject reminder after direct leader interrupt", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-missing-tag-interrupted",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Half-finished leader response without suffix." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: "s1",
      }),
    );

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "interrupt" }));

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "",
        is_error: false,
        stop_reason: "interrupted",
        total_cost_usd: 0.01,
        num_turns: 1,
        session_id: "s1",
      }),
    );

    const reminderSend = cli.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(String(payload).trim()))
      .find(
        (payload: any) => payload.type === "user" && String(payload.message?.content).includes("As a leader session"),
      );
    expect(reminderSend).toBeUndefined();

    const session = bridge.getSession("s1")!;
    const injectedUser = session.messageHistory.findLast((m: any) => m.type === "user_message") as any;
    expect(injectedUser?.content).toBe("start work");
  });

  it("assistant: does not inject reminder after SDK leader interrupt (stop_reason=end_turn)", () => {
    // Regression: SDK/Codex sessions route interrupt through the adapter path,
    // which bypasses handleInterrupt and never sets interruptedDuringTurn.
    // If the CLI result arrives with stop_reason="end_turn" (race with the
    // interrupt signal), turnWasInterrupted was false and the reminder fired.
    const adapter = makeClaudeSdkAdapterMock();
    adapter.sendBrowserMessage.mockReturnValue(true);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    // Send user message via browser so the session has a user turn
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "coordinate workers",
      }),
    );

    // Adapter emits assistant (missing @to tag — would trigger reminder normally)
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "msg-sdk-interrupt",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Let me start coordinating the team." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: "s1",
    });

    // User interrupts — this goes through the adapter path, not handleInterrupt
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "interrupt" }));

    // Result arrives with stop_reason="end_turn" (CLI was already finishing
    // when the interrupt signal arrived — the harder case where resultInterrupted=false)
    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        result: "",
        is_error: false,
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        num_turns: 1,
        session_id: "s1",
      },
    });

    // Verify: no leader tag enforcement reminder was injected
    const session = bridge.getSession("s1")!;
    const hasReminder = session.messageHistory.some(
      (m: any) => m.type === "user_message" && m.content?.includes("As a leader session"),
    );
    expect(hasReminder).toBe(false);
  });

  it("assistant: treats tool-only leader messages as internal without reminder", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-tool-only",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "tool_use", id: "tool-2", name: "Bash", input: { command: "git status" } }],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: "s1",
      }),
    );

    const session = bridge.getSession("s1")!;
    const histAssistant = session.messageHistory.find((m: any) => m.type === "assistant") as any;
    expect(histAssistant?.leader_user_addressed).not.toBe(true);

    const reminderSend = cli.send.mock.calls
      .map(([payload]: [string]) => JSON.parse(String(payload).trim()))
      .find(
        (payload: any) => payload.type === "user" && String(payload.message?.content).includes("As a leader session"),
      );
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
      if (cmd.includes("--left-right --count")) return "0\t2\n";
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
    const assistantRebroadcast = [...calls]
      .reverse()
      .find((c: any) => c.type === "assistant" && c.message?.id === "msg-turn-1");
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

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    expect(session.isGenerating).toBe(false);
    expect(session.generationStartedAt).toBeNull();
    expect(session.stuckNotifiedAt).toBeNull();
    expect(session.messageHistory.filter((m: any) => m.type === "result")).toHaveLength(1);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "idle" }));
  });

  it("result replay: retains only buffered Claude follow-ups when stale inline bookkeeping also exists", () => {
    // q-296 follow-up: the corrected nuance is not "drop all queued lifecycle
    // on Claude result". During reconnect/replay, a duplicate terminal result
    // can arrive after one follow-up was already delivered inline and another
    // later follow-up is still buffered in pendingMessages. Only the buffered
    // follow-up is legitimate and must survive replay cleanup.
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
        uuid: "uuid-replayed-result-with-buffered-followup",
        session_id: "s1",
      },
    } as any);
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 180_000;
    session.stuckNotifiedAt = Date.now() - 30_000;
    session.pendingMessages.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "[User 10:00 PM] buffered follow-up" },
        parent_tool_use_id: null,
        session_id: "s1",
      }),
    );
    session.queuedTurnStarts = 2;
    session.queuedTurnReasons = ["user_message", "user_message"];
    session.queuedTurnUserMessageIds = [[5], [7]];
    session.queuedTurnInterruptSources = [null, null];
    browser.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
        uuid: "uuid-replayed-result-with-buffered-followup",
        session_id: "s1",
      }),
    );

    expect(session.isGenerating).toBe(false);
    expect(session.generationStartedAt).toBeNull();
    expect(session.stuckNotifiedAt).toBeNull();
    expect(session.pendingMessages).toHaveLength(1);
    expect(session.queuedTurnStarts).toBe(1);
    expect(session.queuedTurnReasons).toEqual(["user_message"]);
    expect(session.queuedTurnUserMessageIds).toEqual([[7]]);
    expect(session.queuedTurnInterruptSources).toEqual([null]);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "idle" }));
  });

  it("result: drains inline Claude WebSocket follow-ups instead of promoting a phantom queued turn", () => {
    // q-296: for live Claude WebSocket sessions, a follow-up user message is
    // sent to the connected CLI immediately even while the current turn is
    // still running. The queued-turn lifecycle entry is only bookkeeping for
    // interruption attribution. If result handling promotes that entry as a
    // future turn, the session stays stuck in running until the watchdog fires.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "first turn",
      }),
    );
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "follow-up already delivered inline",
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.isGenerating).toBe(true);
    expect(session.queuedTurnStarts).toBe(1);
    expect(session.pendingMessages).toEqual([]);

    browser.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        duration_ms: 2500,
        duration_api_ms: 2000,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "uuid-inline-follow-up-result",
        session_id: "s1",
      }),
    );

    expect(session.isGenerating).toBe(false);
    expect(session.queuedTurnStarts).toBe(0);
    expect(session.queuedTurnReasons).toEqual([]);
    expect(session.queuedTurnUserMessageIds).toEqual([]);
    expect(session.queuedTurnInterruptSources).toEqual([]);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const runningStatuses = calls.filter((msg: any) => msg.type === "status_change" && msg.status === "running");
    const idleStatuses = calls.filter((msg: any) => msg.type === "status_change" && msg.status === "idle");
    expect(runningStatuses).toHaveLength(0);
    expect(idleStatuses).toHaveLength(1);
  });

  it("user replay: does not append duplicate tool_result_preview after a completed turn", async () => {
    const sid = "s-replay-preview";
    const cliReplay = makeCliSocket(sid);
    const browserReplay = makeBrowserSocket(sid);
    const session = bridge.getOrCreateSession(sid);

    session.messageHistory.push({
      type: "tool_result_preview",
      previews: [
        {
          tool_use_id: "tool-preview-1",
          content: "existing preview",
          is_error: false,
          total_size: 16,
          is_truncated: false,
        },
      ],
    } as any);
    session.messageHistory.push({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done!",
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "result-preview-1",
        session_id: sid,
      },
    } as any);
    session.toolResults.set("tool-preview-1", {
      content: "existing preview",
      is_error: false,
      timestamp: Date.now(),
    });
    session.toolStartTimes.set("tool-preview-1", Date.now() - 1000);

    bridge.handleBrowserOpen(browserReplay, sid);
    bridge.handleCLIOpen(cliReplay, sid);
    expect(session.cliResuming).toBe(true);
    browserReplay.send.mockClear();

    bridge.handleCLIMessage(
      cliReplay,
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-preview-1",
              content: "existing preview",
              is_error: false,
            },
          ],
        },
      }),
    );

    expect(session.messageHistory.filter((m: any) => m.type === "tool_result_preview")).toHaveLength(1);
    expect(session.toolStartTimes.has("tool-preview-1")).toBe(false);
    const replayCalls = browserReplay.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(replayCalls.some((msg: any) => msg.type === "tool_result_preview")).toBe(false);
  });

  it("persisted hot tail does not grow when replayed tool_result_preview is deduplicated", async () => {
    const sid = "s-replay-preview-persist";
    const cliReplay = makeCliSocket(sid);
    const session = bridge.getOrCreateSession(sid);

    session.messageHistory.push({
      type: "tool_result_preview",
      previews: [
        {
          tool_use_id: "tool-preview-2",
          content: "persisted preview",
          is_error: false,
          total_size: 17,
          is_truncated: false,
        },
      ],
    } as any);
    session.messageHistory.push({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Persisted",
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "result-preview-2",
        session_id: sid,
      },
    } as any);
    session.toolResults.set("tool-preview-2", {
      content: "persisted preview",
      is_error: false,
      timestamp: Date.now(),
    });

    bridge.handleCLIOpen(cliReplay, sid);
    expect(session.cliResuming).toBe(true);

    bridge.handleCLIMessage(
      cliReplay,
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-preview-2",
              content: "persisted preview",
              is_error: false,
            },
          ],
        },
      }),
    );

    bridge.persistSessionSync(sid);
    await store.flushAll();

    const persisted = JSON.parse(readFileSync(join(tempDir, `${sid}.json`), "utf-8"));
    expect(persisted._frozenCount).toBe(2);
    expect(persisted.messageHistory).toHaveLength(0);
  });

  // Leaders no longer auto-set review attention on turn completion.
  // They use `takode notify` explicitly instead of the old @to(user) tag system.
  it("result: suppresses review attention for all leader turns (leaders use takode notify instead)", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-internal",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Internal herd coordination completed." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
      }),
    );

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    expect(bridge.getSession("s1")!.attentionReason).toBeNull();
  });

  it("result: suppresses review attention for herded worker turns triggered by leader messages", async () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "orch-1" })),
    } as any);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please fix this quickly",
        agentSource: { sessionId: "orch-1", sessionLabel: "#1 leader" },
      }),
    );

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    expect(bridge.getSession("s1")!.attentionReason).toBeNull();
  });

  it("result: keeps user-triggered herded turns unread even with leader follow-up messages", async () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "orch-1" })),
    } as any);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Human request: investigate failing test",
      }),
    );

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Leader follow-up: include stack traces",
        agentSource: { sessionId: "orch-1", sessionLabel: "#1 leader" },
      }),
    );

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    expect(bridge.getSession("s1")!.attentionReason).toBe("review");
    expect(bridge.getSession("s1")!.isGenerating).toBe(true);

    bridge.markSessionRead("s1");

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

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
      touchUserMessage: vi.fn(),
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
    expect(leaderIdleEvents[0]).toEqual(
      expect.objectContaining({
        leader_session_id: leaderId,
        member_count: 2,
        leader_label: expect.stringContaining("#7"),
      }),
    );
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
      touchUserMessage: vi.fn(),
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
      touchUserMessage: vi.fn(),
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

    bridge.handleCLIMessage(
      workerCli,
      JSON.stringify({
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
      }),
    );

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

  it("result: stores and broadcasts Claude token details from modelUsage", () => {
    const session = bridge.getSession("s1")!;
    session.state.model = "claude-sonnet-4-5-20250929";

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      total_cost_usd: 0.02,
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {
        "claude-sonnet-4-5-20250929": {
          inputTokens: 254,
          outputTokens: 77_708,
          cacheReadInputTokens: 21_737_912,
          cacheCreationInputTokens: 263_780,
          contextWindow: 200_000,
          maxOutputTokens: 16_384,
          costUSD: 14.46,
        },
      },
      uuid: "uuid-5-token-details",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    expect(session.state.claude_token_details).toEqual({
      inputTokens: 254,
      outputTokens: 77_708,
      cachedInputTokens: 22_001_692,
      modelContextWindow: 200_000,
    });
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const tokenUpdate = calls.find((c: any) => c.type === "session_update" && c.session?.claude_token_details);
    expect(tokenUpdate?.session?.claude_token_details).toEqual({
      inputTokens: 254,
      outputTokens: 77_708,
      cachedInputTokens: 22_001_692,
      modelContextWindow: 200_000,
    });
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
      usage: {
        input_tokens: 400000,
        output_tokens: 10000,
        cache_creation_input_tokens: 15000,
        cache_read_input_tokens: 25000,
      },
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
    // input_tokens (400000) already includes cached tokens (OpenAI/Copilot semantics).
    // 400000 / 1000000 * 100 = 40
    // output_tokens (10000) excluded — they are generated, not context occupants
    expect(state.context_used_percent).toBe(40);
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

  it("result: skips cumulative usage that exceeds context window (WS sessions)", () => {
    // WS (NDJSON) sessions send cumulative usage on result messages that can
    // far exceed the context window. When assistant messages have zero usage
    // (typical for WS sessions), the code must not fall back to this cumulative
    // data or the context percentage will be wildly inflated.
    const session = bridge.getSession("s1")!;
    session.state.model = "claude-opus-4-6[1m]";
    session.state.context_used_percent = 34;

    // Add a top-level assistant message with zero usage (typical WS behavior)
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "msg-ws-cumulative",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "test" }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    } as any);

    const msg = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 70000,
      duration_api_ms: 66000,
      num_turns: 6,
      total_cost_usd: 9.64,
      stop_reason: "end_turn",
      // Cumulative usage across 6 turns — 1.9M input tokens far exceeds the 1M context window
      usage: {
        input_tokens: 1905323,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 189924,
        output_tokens: 800,
      },
      modelUsage: {
        "claude-opus-4-6[1m]": {
          inputTokens: 1905323,
          outputTokens: 800,
          cacheReadInputTokens: 189924,
          cacheCreationInputTokens: 0,
          contextWindow: 1000000,
          maxOutputTokens: 64000,
          costUSD: 9.64,
        },
      },
      uuid: "uuid-ws-cumulative",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    // context_used_percent should be preserved, not inflated to 100%+
    expect(bridge.getSession("s1")!.state.context_used_percent).toBe(34);
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

  it("stream_event: does not log zero-browser warnings when no browser is connected", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    bridge.handleBrowserClose(browser);

    const msg = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      uuid: "uuid-6b",
      session_id: "s1",
    });

    bridge.handleCLIMessage(cli, msg);

    const zeroBrowserWarning = logSpy.mock.calls.find(([line]) =>
      String(line).includes("Broadcasting stream_event to 0 browsers"),
    );
    expect(zeroBrowserWarning).toBeUndefined();
    logSpy.mockRestore();
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
        permission_suggestions: [
          { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
        ],
      },
    });

    bridge.handleCLIMessage(cli, msg);
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest

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
      touchUserMessage: vi.fn(),
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
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest

    const session = bridge.getSession("s1")!;
    expect(session.pendingPermissions.size).toBe(1);
    expect(session.attentionReason).toBeNull();
  });

  it("control_request (can_use_tool): Tier 1 mode auto-approves Write in acceptEdits and broadcasts permission_approved", async () => {
    const session = bridge.getSession("s1")!;
    session.state.permissionMode = "acceptEdits";
    browser.send.mockClear();

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-mode-auto",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "/tmp/test.txt", content: "hello" },
        description: "Write a file",
        tool_use_id: "tu-mode-auto",
      },
    });

    bridge.handleCLIMessage(cli, msg);
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest

    // Should NOT be added to pending (auto-approved)
    expect(session.pendingPermissions.has("req-mode-auto")).toBe(false);

    // CLI should receive control_response with allow
    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const controlResp = cliCalls.find(
      (c: any) => c.type === "control_response" && c.response?.request_id === "req-mode-auto",
    );
    expect(controlResp).toBeDefined();
    expect(controlResp.response.response.behavior).toBe("allow");

    // Browser should receive permission_approved (not just permission_request)
    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const approvedMsg = browserCalls.find(
      (c: any) => c.type === "permission_approved" && c.request_id === "req-mode-auto",
    );
    expect(approvedMsg).toBeDefined();
    expect(approvedMsg.tool_name).toBe("Write");
    expect(approvedMsg.tool_use_id).toBe("tu-mode-auto");

    // Should be in message history
    const historyEntry = session.messageHistory.find(
      (m: any) => m.type === "permission_approved" && m.request_id === "req-mode-auto",
    );
    expect(historyEntry).toBeDefined();
  });

  it("control_request (can_use_tool): Tier 2 settings rule auto-approves Bash mkdir for WS sessions", async () => {
    const session = bridge.getSession("s1")!;
    // Plan mode: Tier 1 won't fire for Bash, but Tier 2 should match settings rule
    session.state.permissionMode = "plan";

    // Mock settings rule matcher to approve mkdir commands
    mockShouldSettingsRuleApprove.mockResolvedValueOnce("Bash(mkdir *)");

    browser.send.mockClear();
    cli.send.mockClear();

    const msg = JSON.stringify({
      type: "control_request",
      request_id: "req-settings-rule",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "mkdir -p /tmp/test-dir" },
        description: "Create directory",
        tool_use_id: "tu-settings-rule",
      },
    });

    bridge.handleCLIMessage(cli, msg);
    // Tier 2 is async (settings rule check returns a promise), so flush promises
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Should NOT be added to pending (auto-approved via settings rule)
    expect(session.pendingPermissions.has("req-settings-rule")).toBe(false);

    // CLI should receive control_response with allow
    const cliCalls = cli.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const controlResp = cliCalls.find(
      (c: any) => c.type === "control_response" && c.response?.request_id === "req-settings-rule",
    );
    expect(controlResp).toBeDefined();
    expect(controlResp.response.response.behavior).toBe("allow");

    // Browser should receive permission_approved
    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const approvedMsg = browserCalls.find(
      (c: any) => c.type === "permission_approved" && c.request_id === "req-settings-rule",
    );
    expect(approvedMsg).toBeDefined();
    expect(approvedMsg.tool_name).toBe("Bash");
  });

  it("tool_progress: broadcasts", () => {
    const msg = JSON.stringify({
      type: "tool_progress",
      tool_use_id: "tu-10",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 3.5,
      output_delta: "hello\n",
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
    expect(progressMsg.output_delta).toBe("hello\n");
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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "tool_progress",
        tool_use_id: "tu-1",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 1,
        uuid: "uuid-1",
        session_id: "s1",
      }),
    );
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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "What is 2+2?",
      }),
    );

    // Should have sent NDJSON to CLI
    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("user");
    expect(sent.message.role).toBe("user");
    // CLI-bound content gets a [User HH:MM] timestamp prefix
    expect(sent.message.content).toMatch(/^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] What is 2\+2\?$/);

    // Should store in history (without the tag -- history preserves original content)
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

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "queued message",
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(1);
    const queued = JSON.parse(session.pendingMessages[0]);
    expect(queued.type).toBe("user");
    // CLI-bound content gets a [User HH:MM] timestamp prefix
    expect(queued.message.content).toMatch(/^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] queued message$/);
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

  it("user_message: herded worker gets [Leader HH:MM] for leader-forwarded messages", () => {
    // Make the session a herded worker
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "leader-session-1" })),
    } as any);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "do the task",
        agentSource: { sessionId: "leader-session-1", sessionLabel: "Leader" },
      }),
    );

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.message.content).toMatch(/^\[Leader (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] do the task$/);
  });

  it("user_message: herded worker gets [User HH:MM] for direct human messages", () => {
    // Make the session a herded worker
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "leader-session-1" })),
    } as any);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "direct nudge",
        // No agentSource -- message from the human
      }),
    );

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.message.content).toMatch(/^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] direct nudge$/);
  });

  it("user_message: first message includes date, same-day follow-up omits it, different-day includes it again", () => {
    // First message of a fresh session should include the date
    // (lastUserMessageDateTag starts as "").
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "msg1" }));
    expect(cli.send).toHaveBeenCalledTimes(1);
    const firstRaw = cli.send.mock.calls[0][0] as string;
    const first = JSON.parse(firstRaw.trim());
    // Date portion: "Mon, Mar 31" (weekday, month, day) must be present
    expect(first.message.content).toMatch(/^\[User \w{3}, \w{3} \d{1,2} \d{1,2}:\d{2}\s*[AP]M\] msg1$/);

    // Second message on the SAME day should omit the date (time only).
    cli.send.mockClear();
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "msg2" }));
    expect(cli.send).toHaveBeenCalledTimes(1);
    const secondRaw = cli.send.mock.calls[0][0] as string;
    const second = JSON.parse(secondRaw.trim());
    // Must NOT contain a date prefix -- should be just [User HH:MM AM/PM]
    expect(second.message.content).toMatch(/^\[User \d{1,2}:\d{2}\s*[AP]M\] msg2$/);
    // Negative check: no weekday/month in the tag
    expect(second.message.content).not.toMatch(/\w{3}, \w{3} \d{1,2}/);

    // Third message on a DIFFERENT day should include the date again.
    // Manually set lastUserMessageDateTag to a past date to simulate a day change.
    const session = bridge.getSession("s1")!;
    session.lastUserMessageDateTag = "1999-01-01";
    cli.send.mockClear();
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "msg3" }));
    expect(cli.send).toHaveBeenCalledTimes(1);
    const thirdRaw = cli.send.mock.calls[0][0] as string;
    const third = JSON.parse(thirdRaw.trim());
    // Date must be present again since the day changed
    expect(third.message.content).toMatch(/^\[User \w{3}, \w{3} \d{1,2} \d{1,2}:\d{2}\s*[AP]M\] msg3$/);
  });

  it("vscode_selection_update: broadcasts the latest global selection to browsers across sessions", () => {
    bridge.getOrCreateSession("s2");
    const otherBrowser = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(otherBrowser, "s2");
    otherBrowser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
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
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
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
      }),
    );
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
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
      }),
    );
    expect(browser.send).not.toHaveBeenCalled();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "vscode_selection_update",
        selection: null,
        updatedAt: 250,
        sourceId: "window-c",
        sourceType: "vscode-window",
        sourceLabel: "VS Code C",
        client_msg_id: "selection-4",
      }),
    );

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
    await expect(
      bridge.requestVsCodeOpenFile({
        absolutePath: "/repo/src/app.ts",
      }),
    ).rejects.toThrow("No running VS Code was detected on this machine.");
  });

  it("user_message with images: emits error and does not send when imageStore is not set", () => {
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "What's in this image?",
        images: [{ media_type: "image/png", data: "base64data==" }],
      }),
    );

    expect(cli.send).not.toHaveBeenCalled();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Image failed to send"),
      }),
    );
  });

  it("user_message with images: non-SDK Claude sends file path annotations instead of inline base64", async () => {
    const mockImageStore = {
      store: vi
        .fn()
        .mockResolvedValueOnce({ imageId: "img-1", media_type: "image/png" })
        .mockResolvedValueOnce({ imageId: "img-2", media_type: "image/jpeg" }),
    };
    bridge.setImageStore(mockImageStore as any);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please compare these",
        images: [
          { media_type: "image/png", data: "img1-base64" },
          { media_type: "image/jpeg", data: "img2-base64" },
        ],
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    // Images should be sent as file path annotations (plain text), not inline base64 blocks.
    // This avoids bloating the API request body with base64 data.
    expect(typeof sent.message.content).toBe("string");
    const expectedPath1 = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    const expectedPath2 = join(homedir(), ".companion", "images", "s1", "img-2.orig.jpeg");
    expect(sent.message.content).toContain("Please compare these");
    expect(sent.message.content).toContain(`Attachment 1: ${expectedPath1}`);
    expect(sent.message.content).toContain(`Attachment 2: ${expectedPath2}`);
    expect(sent.message.content).toContain("use the Read tool to view these files");

    expect(mockImageStore.store).toHaveBeenCalledTimes(2);
  });

  it("user_message with images: emits error and does not send turn when upload to imageStore fails", async () => {
    const mockImageStore = {
      store: vi.fn().mockRejectedValue(new Error("ENOENT: image file not found")),
    };
    bridge.setImageStore(mockImageStore as any);
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please inspect this screenshot",
        images: [{ media_type: "image/png", data: "broken-base64" }],
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(cli.send).not.toHaveBeenCalled();
    const session = bridge.getSession("s1")!;
    expect(session.messageHistory).toHaveLength(0);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Image failed to send: image couldn't be found on server"),
      }),
    );
  });

  it("permission_response allow: sends control_response to CLI", async () => {
    // First create a pending permission
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-allow",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo hi" },
          tool_use_id: "tu-allow",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-allow",
        behavior: "allow",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-deny",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
          tool_use_id: "tu-deny",
        },
      }),
    );
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-deny",
        behavior: "deny",
        message: "Too dangerous",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-dedupe",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo hi" },
          tool_use_id: "tu-dedupe",
        },
      }),
    );
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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "interrupt",
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("interrupt");
  });

  it("interrupt: emits turn_end with interrupt_source=user", () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "interrupt",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "user" }),
    );
    spy.mockRestore();
  });

  it("routeExternalInterrupt: emits turn_end with interrupt_source=leader", async () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );
    await bridge.routeExternalInterrupt(bridge.getSession("s1")!, "leader");
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "leader" }),
    );
    spy.mockRestore();
  });

  it("ExitPlanMode denial from browser emits turn_end with interrupt_source=user", () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );

    const session = bridge.getSession("s1")!;
    // Seed a pending ExitPlanMode request so the denial follows the same
    // interrupt path as a real in-flight plan exit.
    session.pendingPermissions.set("perm-exit-plan-user", {
      request_id: "perm-exit-plan-user",
      tool_name: "ExitPlanMode",
      input: { allowedPrompts: [] },
      description: "Exit plan mode",
      tool_use_id: "tool-exit-plan-user",
      timestamp: Date.now(),
    });

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "perm-exit-plan-user",
        behavior: "deny",
        message: "Keep planning",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "user" }),
    );
    spy.mockRestore();
  });

  it("ExitPlanMode denial from external leader emits turn_end with interrupt_source=leader", () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );

    const session = bridge.getSession("s1")!;
    session.pendingPermissions.set("perm-exit-plan-leader", {
      request_id: "perm-exit-plan-leader",
      tool_name: "ExitPlanMode",
      input: { allowedPrompts: [] },
      description: "Exit plan mode",
      tool_use_id: "tool-exit-plan-leader",
      timestamp: Date.now(),
    });

    bridge.routeExternalPermissionResponse(
      session,
      {
        type: "permission_response",
        request_id: "perm-exit-plan-leader",
        behavior: "deny",
        message: "Keep planning",
      },
      "leader-7",
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "leader" }),
    );
    spy.mockRestore();
  });

  it("ExitPlanMode denial from system actor emits turn_end with interrupt_source=system", () => {
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "start work",
      }),
    );

    const session = bridge.getSession("s1")!;
    session.pendingPermissions.set("perm-exit-plan-system", {
      request_id: "perm-exit-plan-system",
      tool_name: "ExitPlanMode",
      input: { allowedPrompts: [] },
      description: "Exit plan mode",
      tool_use_id: "tool-exit-plan-system",
      timestamp: Date.now(),
    });

    bridge.routeExternalPermissionResponse(
      session,
      {
        type: "permission_response",
        request_id: "perm-exit-plan-system",
        behavior: "deny",
        message: "Keep planning",
      },
      "system:auto",
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0,
        num_turns: 1,
      }),
    );

    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "system" }),
    );
    spy.mockRestore();
  });

  it("interrupt: deduplicates repeated client_msg_id", () => {
    const payload = { type: "interrupt", client_msg_id: "ctrl-msg-1" };
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));
    bridge.handleBrowserMessage(browser, JSON.stringify(payload));

    expect(cli.send).toHaveBeenCalledTimes(1);
  });

  it("interrupt: suppresses session_error takode event for interrupted is_error result", () => {
    // When a WS session is interrupted, the CLI may send a result with
    // is_error: true and diagnostic text. This should NOT fire session_error
    // because interrupts are normal control flow.
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "interrupt" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
        stop_reason: "interrupted",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    const sessionErrorCalls = spy.mock.calls.filter(([, eventType]) => eventType === "session_error");
    expect(sessionErrorCalls).toHaveLength(0);

    // turn_end should still fire with interrupted metadata
    const turnEndCalls = spy.mock.calls.filter(([, eventType]) => eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(expect.objectContaining({ interrupted: true }));
    spy.mockRestore();
  });

  it("interrupt: suppresses attention badge for interrupted is_error result", () => {
    // Interrupted error results should not set attention to "error"
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "interrupt" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "[ede_diagnostic] internal error",
        stop_reason: "interrupted",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    expect(bridge.getSession("s1")!.attentionReason).toBeNull();
  });

  it("interrupt: result browser message includes interrupted flag", () => {
    // The result message broadcast to browsers should carry interrupted: true
    // so the frontend can suppress error rendering.
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "interrupt" }));
    browser.send.mockClear();
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "diagnostic text",
        stop_reason: "interrupted",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    const sentMessages = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const resultMsg = sentMessages.find((m: { type: string }) => m.type === "result");
    expect(resultMsg).toBeDefined();
    expect(resultMsg.interrupted).toBe(true);
  });

  it("non-interrupted error result still emits session_error (regression)", () => {
    // Non-interrupted error results should still emit session_error and
    // set attention -- only interrupts are suppressed.
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    // No interrupt sent
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "real error: tool execution failed",
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    const sessionErrorCalls = spy.mock.calls.filter(([, eventType]) => eventType === "session_error");
    expect(sessionErrorCalls).toHaveLength(1);
    expect(sessionErrorCalls[0]?.[2]).toEqual(
      expect.objectContaining({ error: expect.stringContaining("real error") }),
    );
    expect(bridge.getSession("s1")!.attentionReason).toBe("error");
    spy.mockRestore();
  });

  it("interrupt: suppresses session_error for stop_reason=cancel (alternative interrupt indicator)", () => {
    // The CLI may use stop_reason "cancel" instead of "interrupted".
    // Both should suppress error side-effects (ws-bridge.ts:5896 checks both).
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "start work" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "cancelled",
        stop_reason: "cancel",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );

    const sessionErrorCalls = spy.mock.calls.filter(([, eventType]) => eventType === "session_error");
    expect(sessionErrorCalls).toHaveLength(0);
    expect(bridge.getSession("s1")!.attentionReason).toBeNull();
    spy.mockRestore();
  });

  it("set_model: sends control_request with set_model subtype to CLI", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_model",
        model: "claude-opus-4-5-20250929",
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_request");
    expect(sent.request_id).toBe("test-uuid");
    expect(sent.request.subtype).toBe("set_model");
    expect(sent.request.model).toBe("claude-opus-4-5-20250929");
  });

  it("set_permission_mode: sends control_request with set_permission_mode subtype to CLI", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_permission_mode",
        mode: "bypassPermissions",
      }),
    );

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
      messageHistory: [{ type: "user_message", content: "Hello", timestamp: 1000 }],
      pendingMessages: [],
      pendingCodexTurns: [
        {
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
        },
      ],
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

  it("restoreFromDisk: loads persisted pending Codex rollback state", async () => {
    store.saveSync({
      id: "persisted-rollback",
      state: {
        session_id: "persisted-rollback",
        backend_type: "codex",
        model: "gpt-5.4",
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
      pendingMessages: [],
      pendingCodexTurns: [],
      pendingCodexInputs: [],
      pendingCodexRollback: { numTurns: 2, truncateIdx: 0, clearCodexState: true },
      pendingCodexRollbackError: "stale error",
      pendingPermissions: [],
    } as any);

    await store.flushAll();
    const count = await bridge.restoreFromDisk();
    expect(count).toBe(1);

    const session = bridge.getSession("persisted-rollback");
    expect(session).toBeDefined();
    expect(session!.pendingCodexRollback).toEqual({ numTurns: 2, truncateIdx: 0, clearCodexState: true });
    expect(session!.pendingCodexRollbackError).toBe("stale error");
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

  it("restoreFromDisk: preserves an explicit default diff base selection across worktree refresh", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1234\n";
      if (cmd.includes("rev-parse HEAD")) return "head-worktree\n";
      if (cmd.includes("--git-dir")) return "/home/user/companion/.git/worktrees/jiayi-wt-1234\n";
      if (cmd.includes("--git-common-dir")) return "/home/user/companion/.git\n";
      if (cmd.includes("rev-parse --verify refs/heads/jiayi")) return "jiayi-head\n";
      if (cmd.includes("merge-base")) return "merge-base-sha\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("diff --numstat")) return "3\t1\tweb/src/app.ts\n";
      return "";
    });

    store.saveSync({
      id: "persisted-diff-base",
      state: {
        session_id: "persisted-diff-base",
        backend_type: "claude",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/wt",
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
        git_branch: "jiayi-wt-1234",
        git_default_branch: "jiayi",
        diff_base_branch: "",
        diff_base_branch_explicit: true,
        diff_base_start_sha: "",
        is_worktree: true,
        is_containerized: false,
        repo_root: "/home/user/companion",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      },
      messageHistory: [],
      pendingMessages: [],
      pendingPermissions: [],
    } as any);

    await store.flushAll();
    await bridge.restoreFromDisk();

    const restoredState = await bridge.refreshWorktreeGitStateForSnapshot("persisted-diff-base");
    expect(restoredState).toBeTruthy();
    expect(restoredState!.git_default_branch).toBe("jiayi");
    expect(restoredState!.diff_base_branch).toBe("");
    expect(restoredState!.diff_base_branch_explicit).toBe(true);
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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // result message should trigger persist
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // control_request (can_use_tool) should trigger persist
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-persist",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo test" },
          tool_use_id: "tu-persist",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest
    expect(saveSpy).toHaveBeenCalled();

    saveSpy.mockClear();

    // user message from browser should trigger persist
    const browserWs = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browserWs, "s1");
    bridge.handleBrowserMessage(
      browserWs,
      JSON.stringify({
        type: "user_message",
        content: "test persist",
      }),
    );
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "persist this retry context",
      }),
    );

    // This guards the restart path: a user turn that disconnects immediately
    // after dispatch still needs its recovery state on disk.
    const persistedWithRecovery = saveSpy.mock.calls
      .map(([arg]) => arg)
      .find((call) => call.id === sid && Array.isArray(call.pendingCodexTurns) && call.pendingCodexTurns.length > 0);

    expectCodexStartPendingTurnLike(persistedWithRecovery?.pendingCodexTurns?.[0], {
      firstContent: "persist this retry context",
      userContent: "persist this retry context",
      status: "dispatched",
      dispatchCount: 1,
      turnId: null,
      turnTarget: null,
    });
    expect(persistedWithRecovery?.pendingCodexTurns?.[0]?.lastError).toBeNull();
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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-perm-update",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "echo hello" },
          tool_use_id: "tu-perm-update",
        },
      }),
    );
    cli.send.mockClear();

    const updatedPermissions = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "echo *" }],
        behavior: "allow",
        destination: "session",
      },
    ];

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-perm-update",
        behavior: "allow",
        updated_permissions: updatedPermissions,
      }),
    );

    expect(cli.send).toHaveBeenCalledTimes(1);
    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.type).toBe("control_response");
    expect(sent.response.response.behavior).toBe("allow");
    expect(sent.response.response.updatedPermissions).toEqual(updatedPermissions);
  });

  it("allow without updated_permissions does not include updatedPermissions key", () => {
    // Create pending permission
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-no-perm",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          input: { file_path: "/test.ts" },
          tool_use_id: "tu-no-perm",
        },
      }),
    );
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-no-perm",
        behavior: "allow",
      }),
    );

    const sentRaw = cli.send.mock.calls[0][0] as string;
    const sent = JSON.parse(sentRaw.trim());
    expect(sent.response.response.updatedPermissions).toBeUndefined();
  });

  it("allow with empty updated_permissions does not include updatedPermissions key", () => {
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-empty-perm",
        request: {
          subtype: "can_use_tool",
          tool_name: "Read",
          input: { file_path: "/test.ts" },
          tool_use_id: "tu-empty-perm",
        },
      }),
    );
    cli.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-empty-perm",
        behavior: "allow",
        updated_permissions: [],
      }),
    );

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
    // CLI-bound content gets a [User HH:MM] timestamp prefix
    expect(sent.message.content).toMatch(
      /^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] Hello from buffer$/,
    );
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
      bridge.handleCLIMessage(
        cli,
        JSON.stringify({
          type: "tool_progress",
          tool_use_id: "tu-unknown",
          tool_name: "Bash",
          parent_tool_use_id: null,
          elapsed_time_seconds: 1,
          uuid: "uuid-unknown",
          session_id: "unknown-session",
        }),
      );
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
      bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "hello",
        }),
      );
    }).not.toThrow();

    expect(bridge.getSession("nonexistent")).toBeUndefined();
  });
});

// ─── Restore from disk with pendingPermissions ───────────────────────────────

describe("Restore from disk with pendingPermissions", () => {
  it("restores sessions with pending permissions as a Map", async () => {
    const pendingPerms: [string, any][] = [
      [
        "req-restored-1",
        {
          request_id: "req-restored-1",
          tool_name: "Bash",
          input: { command: "rm -rf /tmp/test" },
          tool_use_id: "tu-restored-1",
          timestamp: 1700000000000,
        },
      ],
      [
        "req-restored-2",
        {
          request_id: "req-restored-2",
          tool_name: "Edit",
          input: { file_path: "/test.ts" },
          description: "Edit file",
          tool_use_id: "tu-restored-2",
          agent_id: "agent-1",
          timestamp: 1700000001000,
        },
      ],
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
        [
          "req-replay",
          {
            request_id: "req-replay",
            tool_name: "Bash",
            input: { command: "echo test" },
            tool_use_id: "tu-replay",
            timestamp: 1700000000000,
          },
        ],
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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_get_status",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_toggle",
        serverName: "my-server",
        enabled: false,
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_reconnect",
        serverName: "failing-server",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_get_status",
      }),
    );
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

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "test-uuid",
          response: { mcpServers: mockServers },
        },
      }),
    );

    expect(browser.send).toHaveBeenCalledTimes(1);
    const browserMsg = JSON.parse(browser.send.mock.calls[0][0] as string);
    expect(browserMsg.type).toBe("mcp_status");
    expect(browserMsg.servers).toHaveLength(1);
    expect(browserMsg.servers[0].name).toBe("test-server");
    expect(browserMsg.servers[0].status).toBe("connected");
    expect(browserMsg.servers[0].tools).toHaveLength(1);
  });

  it("control_response with error: does not broadcast to browsers", () => {
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_get_status",
      }),
    );
    browser.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "test-uuid",
          error: "MCP not available",
        },
      }),
    );

    // Should not broadcast anything
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("control_response for unknown request_id: ignored silently", () => {
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "unknown-id",
          response: { mcpServers: [] },
        },
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "mcp_set_servers",
        servers,
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hello" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );

    // Verify history has the assistant message
    const sessionBefore = bridge.getOrCreateSession("s1");
    const historyLenBefore = sessionBefore.messageHistory.length;
    expect(historyLenBefore).toBeGreaterThan(0);

    // Send compact_boundary with metadata
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 50000 },
        uuid: "u3",
        session_id: "cli-123",
      }),
    );

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

  // Validates that compact_boundary does NOT update context_used_percent.
  // pre_tokens is a diagnostic snapshot of context BEFORE compaction -- using
  // it as the displayed percentage would show a stale high value that may
  // never be overwritten (the post-compaction result message may not produce
  // a valid percentage for SDK/WebSocket sessions).
  it("does not update context_used_percent from compact_boundary pre_tokens", () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg({ model: "claude-opus-4-6" }));
    browser.send.mockClear();

    const session = bridge.getOrCreateSession("s1");
    session.state.context_used_percent = 68;

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 167048 },
        uuid: "u-ctx-compact",
        session_id: "cli-123",
      }),
    );

    // context_used_percent should remain at 68 (unchanged by compact_boundary)
    expect(bridge.getOrCreateSession("s1").state.context_used_percent).toBe(68);
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    // No session_update with context_used_percent should be broadcast
    const contextUpdate = calls.find(
      (m: any) => m.type === "session_update" && m.session?.context_used_percent != null,
    );
    expect(contextUpdate).toBeUndefined();
  });

  it("supports multiple compactions creating multiple compact_markers in history", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send an assistant message
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-a",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "first response" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "ua",
        session_id: "cli-123",
      }),
    );

    // First compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 30000 },
        uuid: "uc1",
        session_id: "cli-123",
      }),
    );

    // Another assistant message after compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-b",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "second response" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "ub",
        session_id: "cli-123",
      }),
    );

    // Second compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 60000 },
        uuid: "uc2",
        session_id: "cli-123",
      }),
    );

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

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 64000 },
        uuid: "compact-uuid-1",
        session_id: "cli-123",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 64000 },
        uuid: "compact-uuid-2",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );

    bridge.handleCLIMessage(cli, makeInitMsg());
    browser.send.mockClear();

    // Send compact_boundary
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 80000 },
        uuid: "u4",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );

    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send compact_boundary (sets awaitingCompactSummary)
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto" },
        uuid: "u5",
        session_id: "cli-123",
      }),
    );

    browser.send.mockClear();

    // Send a CLI "user" message with a text block (this is the compaction summary)
    const summaryText =
      "This session is being continued from a previous conversation. Key context: the user is building a web app.";
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: summaryText }] },
        parent_tool_use_id: null,
        uuid: "u6",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );

    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send compact_boundary
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 60000 },
        uuid: "u-str-1",
        session_id: "cli-123",
      }),
    );

    browser.send.mockClear();

    // CLI sends the summary as a plain string (not an array of content blocks)
    const summaryText = "This session is being continued from a previous conversation. The user is building a web UI.";
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: summaryText },
        parent_tool_use_id: null,
        uuid: "u-str-2",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 30000 },
        uuid: "uf1",
        session_id: "cli-123",
      }),
    );

    // Provide summary for first compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "First compaction summary" },
        parent_tool_use_id: null,
        uuid: "uf2",
        session_id: "cli-123",
      }),
    );

    // Some more messages between compactions
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-mid",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "middle" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "uf3",
        session_id: "cli-123",
      }),
    );

    // Second compaction
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 60000 },
        uuid: "uf4",
        session_id: "cli-123",
      }),
    );

    // Provide summary for second compaction — should attach to the LAST marker
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Second compaction summary" },
        parent_tool_use_id: null,
        uuid: "uf5",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual" },
        uuid: "u7",
        session_id: "cli-123",
      }),
    );

    // Send summary (consumes awaitingCompactSummary)
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Summary text" }] },
        parent_tool_use_id: null,
        uuid: "u8",
        session_id: "cli-123",
      }),
    );

    // Now send a normal tool_result user message — should be handled normally
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "result data" }] },
        parent_tool_use_id: null,
        uuid: "u9",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "compacting",
      }),
    );

    // Exit compacting
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "idle",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "compacting",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "idle",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "compacting",
      }),
    );
    // Replayed idle status
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "idle",
      }),
    );

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
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "implement the feature",
      }),
    );
    const session = bridge.getSession("s1")!;
    expect(session.isGenerating).toBe(true);

    // CLI enters compaction mid-turn
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "compacting",
      }),
    );

    // isGenerating must stay true — compaction is NOT a turn boundary
    expect(session.isGenerating).toBe(true);
    expect(session.state.is_compacting).toBe(true);

    // CLI finishes compaction, continues turn
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "idle",
      }),
    );
    expect(session.state.is_compacting).toBe(false);
    expect(session.isGenerating).toBe(true);

    // Turn ends normally — result properly transitions to idle
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );
    expect(session.isGenerating).toBe(false);
  });

  it("Claude Code: compaction mid-tool-call preserves tool state and generation", async () => {
    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Start generation
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run the tests",
      }),
    );

    // CLI sends assistant message with a tool_use
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
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
      }),
    );

    const session = bridge.getSession("s1")!;
    expect(session.isGenerating).toBe(true);
    expect(session.toolStartTimes.has("tool-bash-1")).toBe(true);

    // Compaction starts mid-tool-call
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "compacting",
      }),
    );

    // Both generation AND tool state must be preserved
    expect(session.isGenerating).toBe(true);
    expect(session.toolStartTimes.has("tool-bash-1")).toBe(true);
    expect(session.state.is_compacting).toBe(true);

    // Compaction finishes
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "idle",
      }),
    );

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
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "implement feature",
      }),
    );
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
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run tests",
      }),
    );
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

// ─── SDK compaction handling ────────────────────────────────────────────────

describe("Claude SDK compaction handling", () => {
  // The SDK status_change handler synthesizes a compact_marker immediately
  // (the Agent SDK may not emit compact_boundary through stream()). If
  // compact_boundary does arrive, the handler enriches the existing marker
  // with metadata (trigger, preTokens, cliUuid) instead of creating a
  // duplicate. This mirrors the Codex pattern for resilient UI rendering.

  /** Helper: create an SDK adapter mock, attach it, and emit session_init. */
  function initSdkSession(sessionId: string) {
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sessionId, adapter as any);
    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        session_id: `cli-${sessionId}`,
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/test",
        tools: [],
        permissionMode: "default",
      },
    });
    return adapter;
  }

  it("updates is_compacting state when SDK status_change reports compacting", () => {
    // is_compacting drives deriveSessionStatus() which populates state_snapshot
    // on browser reconnect. Without this, reconnecting browsers see "idle"
    // instead of "compacting" during active compaction.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    expect(session.state.is_compacting).toBe(false);

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.state.is_compacting).toBe(true);

    adapter.emitBrowserMessage({ type: "status_change", status: null });
    expect(session.state.is_compacting).toBe(false);
  });

  it("sets compactedDuringTurn when SDK enters compacting state", () => {
    // compactedDuringTurn is consumed by the herd event system to annotate
    // turn_end events with "(compacted)" so the orchestrator knows the worker
    // was busy compacting rather than doing useful work.
    const adapter = initSdkSession("s1");

    const session = bridge.getSession("s1")!;
    expect(session.compactedDuringTurn).toBe(false);

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.compactedDuringTurn).toBe(true);
  });

  it("emits compaction_started and compaction_finished takode events for SDK sessions", () => {
    // Takode orchestrators use these events to track herded worker compaction
    // state. Without them, the leader has no visibility into SDK workers
    // spending time on compaction vs. actual work.
    const adapter = initSdkSession("s1");

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    const startedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_started");
    const finishedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_finished");
    expect(startedCalls).toHaveLength(1);
    expect(finishedCalls).toHaveLength(1);
  });

  it("synthesizes compact_marker from status_change even without compact_boundary", () => {
    // The Agent SDK may not yield compact_boundary through stream() — the
    // status_change handler creates a compact_marker so the chat UI always
    // shows the "Conversation compacted" divider.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const session = bridge.getSession("s1")!;
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).id).toMatch(/^compact-boundary-/);

    // Browser receives compact_boundary broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const compactMsg = calls.find((m: any) => m.type === "compact_boundary");
    expect(compactMsg).toBeTruthy();
    expect(typeof compactMsg.timestamp).toBe("number");

    // awaitingCompactSummary is set so summary capture works
    expect(session.awaitingCompactSummary).toBe(true);
  });

  it("compact_boundary enriches existing synthesized marker with metadata", () => {
    // When compact_boundary arrives after status_change, it should enrich
    // the already-synthesized marker with trigger/preTokens/cliUuid rather
    // than creating a duplicate marker.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // status_change creates the initial marker
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    // compact_boundary enriches it
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "sdk-compact-uuid-1",
      session_id: "cli-s1",
    });

    const session = bridge.getSession("s1")!;
    // Still only one marker (no duplicate)
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    const marker = markers[0] as any;
    expect(marker.trigger).toBe("auto");
    expect(marker.preTokens).toBe(80000);
    expect(marker.cliUuid).toBe("sdk-compact-uuid-1");
    expect(marker.id).toMatch(/^compact-boundary-/);
  });

  it("handles compact_boundary that arrives without prior status_change", () => {
    // Edge case: the SDK might deliver compact_boundary independently of
    // status_change, or the messages could arrive out of order. The compact
    // marker must still be created correctly, and the browser broadcast must
    // include the trigger and preTokens metadata fields.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // compact_boundary WITHOUT any prior status_change(compacting)
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 60000 },
      uuid: "sdk-standalone-boundary",
      session_id: "cli-s1",
    });

    const session = bridge.getSession("s1")!;
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).trigger).toBe("manual");

    // Browser broadcast includes trigger and preTokens metadata
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const boundaryMsg = calls.find((m: any) => m.type === "compact_boundary");
    expect(boundaryMsg).toBeTruthy();
    expect(boundaryMsg.trigger).toBe("manual");
    expect(boundaryMsg.preTokens).toBe(60000);
  });

  it("deduplicates replayed compact_boundary by uuid on SDK resume", () => {
    // On --resume, the SDK replays historical compact_boundary messages.
    // The bridge must deduplicate by uuid so replay doesn't create duplicate
    // markers in messageHistory (same logic as the WebSocket path).
    const adapter = initSdkSession("s1");

    // First: status_change creates synthesized marker, compact_boundary enriches it
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "sdk-dedup-uuid",
      session_id: "cli-s1",
    });

    // Replay (same uuid) — should be deduplicated
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "sdk-dedup-uuid",
      session_id: "cli-s1",
    });

    const session = bridge.getSession("s1")!;
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
  });

  it("captures compaction summary from user message after status_change synthesis", () => {
    // After compacting, the CLI sends a "user" message containing the
    // compaction summary text. The bridge stores this on the compact_marker
    // and broadcasts compact_summary so the browser can update the marker
    // content from "Conversation compacted" to the full summary. This must
    // work even without compact_boundary (status_change-only path).
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // status_change synthesizes the marker and sets awaitingCompactSummary
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const session = bridge.getSession("s1")!;
    expect(session.awaitingCompactSummary).toBe(true);

    adapter.emitBrowserMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "Here is a summary of the conversation so far..." }],
      },
      parent_tool_use_id: null,
      uuid: "sdk-summary-msg-1",
      session_id: "cli-s1",
    });

    expect(session.awaitingCompactSummary).toBe(false);

    const marker = session.messageHistory.findLast((m) => m.type === "compact_marker") as any;
    expect(marker?.summary).toBe("Here is a summary of the conversation so far...");

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const summaryMsg = calls.find((m: any) => m.type === "compact_summary");
    expect(summaryMsg).toBeTruthy();
    expect(summaryMsg.summary).toBe("Here is a summary of the conversation so far...");
  });

  it("does not duplicate state or markers on re-notification of same compacting status", () => {
    // The SDK or adapter may re-notify the same compacting status. The bridge
    // must be idempotent: is_compacting stays true, compactedDuringTurn stays
    // true, no duplicate takode events are emitted, and only one compact_marker
    // is created.
    const adapter = initSdkSession("s1");
    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const session = bridge.getSession("s1")!;
    expect(session.state.is_compacting).toBe(true);
    expect(session.compactedDuringTurn).toBe(true);

    // Only one compaction_started event (transition guard prevents duplicate)
    const startedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_started");
    expect(startedCalls).toHaveLength(1);

    // Only one compact_marker (second status_change was not a transition)
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
  });

  it("broadcasts both status_change and compact_boundary to browser on SDK compaction", () => {
    // The browser uses status_change to update the session status indicator
    // (showing "compacting" spinner) AND receives compact_boundary to render
    // the chat divider. Both must be broadcast from the status_change handler.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "compacting" }));
    expect(calls.find((m: any) => m.type === "compact_boundary")).toBeTruthy();
  });

  it("preserves isGenerating during SDK compaction mid-turn", async () => {
    // Compaction is NOT a turn boundary -- the CLI continues its turn after
    // compacting. isGenerating must stay true throughout so the session
    // doesn't appear idle while still working.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    await bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "implement feature" }));

    const session = bridge.getSession("s1")!;
    // isGenerating is set by the user message dispatch
    // (SDK adapter mock returns true for sendBrowserMessage by default)

    // SDK enters compaction mid-turn
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.state.is_compacting).toBe(true);
    // isGenerating must NOT be cleared by compaction
    expect(session.isGenerating).toBe(true);

    // SDK exits compaction, continues turn
    adapter.emitBrowserMessage({ type: "status_change", status: null });
    expect(session.state.is_compacting).toBe(false);
    expect(session.isGenerating).toBe(true);
  });

  it("handles full auto-compaction lifecycle: status_change → compact_boundary → summary → idle", () => {
    // Simulates the exact message sequence the CLI emits during automatic
    // compaction (hitting context limits). Verifies every side-effect fires:
    // state transitions, marker creation, enrichment, summary capture,
    // and all browser broadcasts arrive in the expected order.
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const spy = vi.spyOn(bridge, "emitTakodeEvent");
    const session = bridge.getSession("s1")!;

    // Phase 1: CLI signals compaction start
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    expect(session.state.is_compacting).toBe(true);
    // compactedDuringTurn stays true until turn ends (reset in setGenerating),
    // not at compaction end -- tested in "preserves isGenerating" test above.
    expect(session.compactedDuringTurn).toBe(true);
    expect(session.awaitingCompactSummary).toBe(true);
    const markers1 = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers1).toHaveLength(1);
    // Marker synthesized without metadata (no compact_boundary yet)
    expect((markers1[0] as any).trigger).toBeUndefined();

    // Phase 2: CLI sends compact_boundary with auto-compaction metadata
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 95000 },
      uuid: "auto-compact-uuid-1",
      session_id: "cli-s1",
    });

    // Marker enriched (still just one)
    const markers2 = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers2).toHaveLength(1);
    const enriched = markers2[0] as any;
    expect(enriched.trigger).toBe("auto");
    expect(enriched.preTokens).toBe(95000);
    expect(enriched.cliUuid).toBe("auto-compact-uuid-1");

    // Phase 3: CLI sends the compaction summary as a user message
    const summaryText =
      "This session continues from a previous conversation. " +
      "The user is building a real-time dashboard with WebSocket support.";
    adapter.emitBrowserMessage({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: summaryText }] },
      parent_tool_use_id: null,
      uuid: "auto-compact-summary-1",
      session_id: "cli-s1",
    });

    expect(session.awaitingCompactSummary).toBe(false);
    const finalMarker = session.messageHistory.findLast((m) => m.type === "compact_marker") as any;
    expect(finalMarker?.summary).toBe(summaryText);

    // Phase 4: CLI signals compaction complete
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    expect(session.state.is_compacting).toBe(false);

    // Verify takode events
    const startedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_started");
    const finishedCalls = spy.mock.calls.filter(([, event]) => event === "compaction_finished");
    expect(startedCalls).toHaveLength(1);
    expect(finishedCalls).toHaveLength(1);

    // Verify browser received all expected messages in order
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const types = calls.map((m: any) => m.type);
    // compact_boundary comes before status_change(compacting) because the bridge
    // synthesizes the marker first, then falls through to broadcastToBrowsers
    expect(types).toContain("compact_boundary");
    expect(types).toContain("status_change");
    expect(types).toContain("compact_summary");
    // Verify final status_change(null) was broadcast
    const finalStatusMsg = calls.filter((m: any) => m.type === "status_change" && m.status === null);
    expect(finalStatusMsg.length).toBeGreaterThanOrEqual(1);
  });

  // Validates that compact_boundary enrichment does NOT update
  // context_used_percent. pre_tokens is a pre-compaction diagnostic
  // snapshot that would show a stale high value.
  it("does not update context_used_percent from compact_boundary enrichment", () => {
    const adapter = initSdkSession("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;
    session.state.model = "claude-sonnet-4-5-20250929";
    session.state.context_used_percent = 42;
    browser.send.mockClear();

    // status_change creates the synthesized marker
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    // compact_boundary enriches it with pre_tokens
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 180000 },
      uuid: "ctx-pct-uuid",
      session_id: "cli-s1",
    });

    // context_used_percent should remain unchanged (not set from pre_tokens)
    expect(session.state.context_used_percent).toBe(42);

    // No session_update with context_used_percent should be broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const contextUpdate = calls.find(
      (m: any) => m.type === "session_update" && m.session?.context_used_percent != null,
    );
    expect(contextUpdate).toBeUndefined();
  });

  it("does not synthesize compact_marker during cliResuming replay (q-227)", () => {
    // During --resume replay, replayed status_change(compacting) must NOT
    // create a compact_marker in history. Without this guard, a revert +
    // /compact sequence produces duplicate markers: one from the replayed
    // compaction and one from the real compaction after resume ends.
    const adapter = initSdkSession("s1");
    const session = bridge.getSession("s1")!;
    // Simulate resume state (session has history + CLI is replaying)
    session.cliResuming = true;

    const spy = vi.spyOn(bridge, "emitTakodeEvent");

    // Replayed status_change(compacting) — should NOT create marker
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });

    // is_compacting is still tracked (needed for cleanup when cliResuming clears)
    expect(session.state.is_compacting).toBe(true);
    // But no marker should have been synthesized
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(0);
    // awaitingCompactSummary should NOT be set during replay
    expect(session.awaitingCompactSummary).toBeFalsy();
    // compactedDuringTurn should NOT be set during replay
    expect(session.compactedDuringTurn).toBe(false);
    // No takode event emitted
    expect(spy.mock.calls.filter(([, e]) => e === "compaction_started")).toHaveLength(0);

    spy.mockRestore();
  });

  it("skips replayed compact_boundary during cliResuming (q-227)", () => {
    // Replayed compact_boundary during --resume must be completely ignored,
    // not just deduped. After a revert, old markers are removed from history,
    // so UUID-based dedup fails and would create a ghost marker.
    const adapter = initSdkSession("s1");
    const session = bridge.getSession("s1")!;
    session.cliResuming = true;

    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "replayed-boundary-uuid",
      session_id: "cli-s1",
    });

    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(0);
    expect(session.awaitingCompactSummary).toBeFalsy();
  });

  it("skips compact summary capture from replayed user messages during cliResuming (q-227)", () => {
    // If awaitingCompactSummary is stale from before a revert, replayed
    // user messages during --resume must not be consumed as summaries.
    const adapter = initSdkSession("s1");
    const session = bridge.getSession("s1")!;
    session.cliResuming = true;
    // Simulate stale flag from a pre-revert compaction
    session.awaitingCompactSummary = true;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "This is a replayed summary" }] },
      parent_tool_use_id: null,
      uuid: "replayed-user-msg",
      session_id: "cli-s1",
    });

    // awaitingCompactSummary should NOT have been consumed (still true)
    expect(session.awaitingCompactSummary).toBe(true);
    // No compact_summary broadcast
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((m: any) => m.type === "compact_summary")).toBeUndefined();
  });

  it("replayed compaction during resume is ignored, real compaction after resume produces exactly one marker (q-227)", () => {
    // Regression test for the resume replay path. Simulates:
    // 1. cliResuming=true: replayed compaction events arrive (all ignored)
    // 2. cliResuming clears: resume replay is done
    // 3. Real /compact produces compaction events
    // Verifies exactly one marker from the real compaction, none from replay.
    // Note: the revert handler's state clearing is tested separately in routes.test.ts.
    vi.useFakeTimers();

    const adapter = initSdkSession("s1");
    const session = bridge.getSession("s1")!;
    session.cliResuming = true;

    // Phase 1: Replayed compaction events during resume (all ignored)
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 80000 },
      uuid: "old-compact-uuid",
      session_id: "cli-s1",
    });
    adapter.emitBrowserMessage({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Old compaction summary" }] },
      parent_tool_use_id: null,
      uuid: "old-summary-msg",
      session_id: "cli-s1",
    });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    expect(session.messageHistory.filter((m) => m.type === "compact_marker")).toHaveLength(0);

    // Phase 2: Resume ends
    session.cliResuming = false;

    // Phase 3: Real compaction from the new /compact
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 60000 },
      uuid: "new-compact-uuid",
      session_id: "cli-s1",
    });
    adapter.emitBrowserMessage({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "New compaction summary" }] },
      parent_tool_use_id: null,
      uuid: "new-summary-msg",
      session_id: "cli-s1",
    });

    // Exactly one marker with the real summary
    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    const marker = markers[0] as any;
    expect(marker.summary).toBe("New compaction summary");
    expect(marker.cliUuid).toBe("new-compact-uuid");
    expect(marker.trigger).toBe("manual");

    vi.useRealTimers();
  });
});

// ─── Leader compaction recovery ─────────────────────────────────────────────

describe("Leader compaction recovery", () => {
  // After compaction finishes, leader sessions receive a [System] user message
  // instructing them to reload orchestration skills and refresh herd state.
  // This prevents post-compaction mistakes (wrong dispatch format, using
  // subagents instead of takode spawn, skipping board updates, etc.).

  it("injects recovery message for leader sessions after SDK compaction finishes", () => {
    // Leader sessions lose skill context after compaction. The recovery
    // message reminds them to reload /takode-orchestration and /quest.
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);
    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        session_id: "cli-s1",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/test",
        tools: [],
        permissionMode: "default",
      },
    });

    // Mark session as orchestrator
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    const spy = vi.spyOn(bridge, "injectUserMessage");

    // Compaction cycle: start → finish
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    // Recovery message should have been injected with system source tag
    const recoveryCalls = spy.mock.calls.filter(
      ([, , source]) => source?.sessionId === "system" && source?.sessionLabel === "System",
    );
    expect(recoveryCalls).toHaveLength(1);
    expect(recoveryCalls[0][1]).toContain("/takode-orchestration");
    expect(recoveryCalls[0][1]).toContain("takode board show");
    expect(recoveryCalls[0][1]).toContain("stage-explicit");
    expect(recoveryCalls[0][1]).toContain("plan only");
    expect(recoveryCalls[0][1]).toContain("implement and stop");
    expect(recoveryCalls[0][1]).toContain("groom/rework and report back");
    expect(recoveryCalls[0][1]).toContain("port only when explicitly told");
  });

  it("does not inject recovery for Claude WebSocket leaders when compact_boundary never arrived", () => {
    // q-317: status-only compacting transitions can be noisy or stale. The
    // leader recovery prompt should only appear after a real Claude
    // compact_boundary, not just after compacting -> idle.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    const spy = vi.spyOn(bridge, "injectUserMessage");

    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: "compacting" }));
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: null }));

    const recoveryCalls = spy.mock.calls.filter(
      ([, , source]) => source?.sessionId === "system" && source?.sessionLabel === "System",
    );
    expect(recoveryCalls).toHaveLength(0);
  });

  it("deduplicates replayed websocket recovery but still injects again for a later real compaction", () => {
    // Regression for q-317: replayed compacting/null pairs in Claude WebSocket
    // sessions can arrive after a completed compaction and must not re-inject
    // the leader recovery prompt unless a new compact_boundary was recorded.
    // A later real compaction must still inject a fresh recovery message.
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    // First real compaction with a real boundary + summary.
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: "compacting" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 80000 },
        uuid: "u-compact-1",
        session_id: "cli-123",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Compaction summary" }] },
        parent_tool_use_id: null,
        uuid: "u-summary-1",
        session_id: "cli-123",
      }),
    );
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: null }));

    // Replayed status pair after the same compaction — must NOT inject again.
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: "compacting" }));
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: null }));

    const sessionAfterReplay = bridge.getSession("s1")!;
    const replayRecoveries = sessionAfterReplay.messageHistory.filter(
      (entry: any) =>
        entry.type === "user_message" &&
        typeof entry.content === "string" &&
        entry.content.includes("Context was compacted. Before continuing, reload your orchestration state:") &&
        entry.agentSource?.sessionId === "system" &&
        entry.agentSource?.sessionLabel === "System",
    );
    expect(replayRecoveries).toHaveLength(1);

    // Second real compaction with a NEW boundary must inject a NEW recovery.
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: "compacting" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 60000 },
        uuid: "u-compact-2",
        session_id: "cli-123",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Second compaction summary" }] },
        parent_tool_use_id: null,
        uuid: "u-summary-2",
        session_id: "cli-123",
      }),
    );
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: null }));

    const finalSession = bridge.getSession("s1")!;
    const recoveries = finalSession.messageHistory.filter(
      (entry: any) =>
        entry.type === "user_message" &&
        typeof entry.content === "string" &&
        entry.content.includes("Context was compacted. Before continuing, reload your orchestration state:") &&
        entry.agentSource?.sessionId === "system" &&
        entry.agentSource?.sessionLabel === "System",
    );
    expect(recoveries).toHaveLength(2);
  });

  it("does not inject recovery message for non-leader sessions", () => {
    // Regular (standalone) sessions don't have orchestration skills to reload.
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);
    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        session_id: "cli-s1",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/test",
        tools: [],
        permissionMode: "default",
      },
    });

    // Not an orchestrator
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: false })),
    } as any);

    const spy = vi.spyOn(bridge, "injectUserMessage");

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    const recoveryCalls = spy.mock.calls.filter(
      ([, , source]) => source?.sessionId === "system" && source?.sessionLabel === "System",
    );
    expect(recoveryCalls).toHaveLength(0);
  });

  it("does not inject recovery for herded worker sessions", () => {
    // Workers are not leaders -- they don't need orchestration recovery.
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);
    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        session_id: "cli-s1",
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/test",
        tools: [],
        permissionMode: "default",
      },
    });

    // Herded worker (not orchestrator)
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: false, herdedBy: "leader-uuid" })),
    } as any);

    const spy = vi.spyOn(bridge, "injectUserMessage");

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    const recoveryCalls = spy.mock.calls.filter(
      ([, , source]) => source?.sessionId === "system" && source?.sessionLabel === "System",
    );
    expect(recoveryCalls).toHaveLength(0);
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
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "implement the feature and run tests",
      }),
    );

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
    const retried = (firstRetryCall as unknown as [any])[0] as any;
    expect(getCodexStartPendingInputs(retried)[0]?.content).toBe("implement the feature and run tests");
  });

  it("retries image user message when resumed turn is inProgress but thread is idle", async () => {
    const sid = "s-stale-image-retry";
    const adapter1 = makeCodexAdapterMock();
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getOriginalPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.orig.png"),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter(sid, adapter1 as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "implement the fix from this screenshot",
        images: [{ media_type: "image/png", data: "image-bytes" }],
      }),
    );
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

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const retriedImageCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const retriedImageMsg = retriedImageCalls[0]?.[0] as any;
    expect(retriedImageMsg).toBeDefined();
    expect(getCodexStartPendingInputs(retriedImageMsg)[0]?.content).toContain("implement the fix from this screenshot");
    expect(getCodexStartPendingInputs(retriedImageMsg)[0]?.local_images).toEqual(["/tmp/companion-images/img-1.orig.png"]);
    const firstImageRetryCall = adapter2.sendBrowserMessage.mock.calls[0];
    expect(firstImageRetryCall).toBeDefined();
    const retried = (firstImageRetryCall as unknown as [any])[0] as any;
    expect(retried.images).toBeUndefined();

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const retrySkipError = calls.find(
      (c: any) => c.type === "error" && typeof c.message === "string" && c.message.includes("non-text tool activity"),
    );
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "check status",
      }),
    );
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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );

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

  it("sends history_sync only after session_subscribe with lastSeq=0", async () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    // Now subscribe with last_seq=0
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );
    await flushAsync(); // sendHistorySync is async

    // Should now receive history_sync + state_snapshot
    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const historyMsgs = calls.filter((m: any) => m.type === "history_sync");
    expect(historyMsgs.length).toBe(1);

    // state_snapshot should be sent last with authoritative transient state
    const snapshots = calls.filter((m: any) => m.type === "state_snapshot");
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]).toEqual(
      expect.objectContaining({
        type: "state_snapshot",
        backendConnected: true,
        permissionMode: expect.any(String),
      }),
    );
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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshots = calls.filter((m: any) => m.type === "state_snapshot");
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].backendConnected).toBe(true);
    expect(snapshots[0].sessionStatus).toBe("idle");
    expect(typeof snapshots[0].permissionMode).toBe("string");
    expect(typeof snapshots[0].askPermission).toBe("boolean");
  });

  it("state_snapshot is the last message sent during subscribe", async () => {
    // Add history so multiple messages are sent
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "hi" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );
    await flushAsync(); // sendHistorySync is async

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    // state_snapshot should be the last message in the subscribe sequence.
    // Note: async git refresh (refreshGitInfoThenRecomputeDiff) may send a
    // session_update after state_snapshot once the yield resolves, so we check
    // that state_snapshot comes after history_sync rather than being the
    // absolute last message.
    const historySyncIdx = calls.findIndex((m: any) => m.type === "history_sync");
    const snapshotIdx = calls.findIndex((m: any) => m.type === "state_snapshot");
    expect(historySyncIdx).toBeGreaterThanOrEqual(0);
    expect(snapshotIdx).toBeGreaterThan(historySyncIdx);
  });

  it("reports sessionStatus as 'running' when session is actively generating", async () => {
    // Send a user message (sets isGenerating = true) followed by an assistant message (no result)
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Do something",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "working..." }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "cli-123",
      }),
    );
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );
    await flushAsync(); // sendHistorySync is async

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot.sessionStatus).toBe("running");
  });

  it("reports backendConnected as false when CLI is disconnected", async () => {
    bridge.handleCLIClose(cli);
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
      }),
    );
    await flushAsync(); // sendHistorySync is async

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-plan",
        request: {
          subtype: "can_use_tool",
          tool_name: "ExitPlanMode",
          input: {},
          tool_use_id: "tu-plan",
        },
      }),
    );
    browser.send.mockClear();

    // Approve the permission
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-plan",
        behavior: "allow",
      }),
    );

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const approved = calls.find((m: any) => m.type === "permission_approved");
    expect(approved).toBeDefined();
    expect(approved.request_id).toBe("req-plan");
    expect(approved.tool_name).toBe("ExitPlanMode");
  });

  it("permission_denied broadcast includes request_id", async () => {
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-deny-test",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
          tool_use_id: "tu-deny-test",
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0)); // flush async handleControlRequest
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "req-deny-test",
        behavior: "deny",
        message: "Nope",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-ask",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: { questions: [{ question: "Which approach?", options: ["A", "B"] }] },
          tool_use_id: "tu-ask",
        },
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-plan",
        request: {
          subtype: "can_use_tool",
          tool_name: "ExitPlanMode",
          input: {},
          tool_use_id: "tu-plan",
        },
      }),
    );

    const cliCalls = cli.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const autoResponse = cliCalls.find((m: any) => m.type === "control_response");
    expect(autoResponse).toBeUndefined();

    const browserCalls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const permReq = browserCalls.find((m: any) => m.type === "permission_request");
    expect(permReq).toBeDefined();
    expect(permReq.request.tool_name).toBe("ExitPlanMode");
  });

  it("still auto-approves regular tools like Edit in bypassPermissions mode", () => {
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "control_request",
        request_id: "req-edit",
        request: {
          subtype: "can_use_tool",
          tool_name: "Edit",
          input: { file_path: "/test/foo.ts", old_string: "a", new_string: "b" },
          tool_use_id: "tu-edit",
        },
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Hello",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "First message",
      }),
    );
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Second message while still running",
      }),
    );

    const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const statusChanges = calls.filter((m: any) => m.type === "status_change" && m.status === "running");
    expect(statusChanges).toHaveLength(0);
  });

  it("reverts optimistic running to idle after 30s without backend output", () => {
    vi.useFakeTimers();
    try {
      bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "Hello",
        }),
      );
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
      bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "Hello",
        }),
      );

      // First backend output should cancel the timeout.
      bridge.handleCLIMessage(
        cli,
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-timeout-cancel",
            role: "assistant",
            content: [{ type: "text", text: "Working..." }],
            model: "claude-sonnet-4-5-20250929",
            stop_reason: null,
          },
        }),
      );
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

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Hello from browser 1",
      }),
    );

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

  it("deriveSessionStatus returns 'running' when user_message sets isGenerating", async () => {
    // Send a user message — this sets isGenerating = true
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Hello",
      }),
    );
    browser.send.mockClear();

    // Reconnect a new browser — state_snapshot should report "running"
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(browser2, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    await flushAsync(); // sendHistorySync is async

    const calls = browser2.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot.sessionStatus).toBe("running");
  });

  it("deriveSessionStatus returns 'idle' after result even if history ends with assistant", async () => {
    // Send a user message (isGenerating = true)
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Hello",
      }),
    );

    // CLI sends an assistant message
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "Hi there" }],
          model: "claude-sonnet-4-5-20250929",
          stop_reason: "end_turn",
        },
      }),
    );

    // CLI sends result (isGenerating = false)
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "result",
        total_cost_usd: 0.01,
        num_turns: 1,
      }),
    );
    browser.send.mockClear();

    // Reconnect a new browser — should see "idle" not "running"
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(browser2, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    await flushAsync(); // sendHistorySync is async

    const calls = browser2.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot).toBeDefined();
    expect(snapshot.sessionStatus).toBe("idle");
  });

  it("deriveSessionStatus returns 'idle' after CLI relaunch (simulating server restart)", async () => {
    vi.useFakeTimers();
    // Session was generating when CLI disconnected (interrupted generation)
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Do something",
      }),
    );

    // CLI sends an assistant message mid-generation
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [{ type: "text", text: "Working on it..." }],
          model: "claude-sonnet-4-5-20250929",
          stop_reason: null,
        },
      }),
    );

    // CLI disconnects (server restart scenario)
    bridge.handleCLIClose(cli);

    // Grace period expires — this is a real disconnect, not a token refresh
    vi.advanceTimersByTime(16_000);

    // CLI reconnects (like --resume after server restart)
    const cli2 = makeCliSocket("s1");
    bridge.handleCLIOpen(cli2, "s1");
    bridge.handleCLIMessage(cli2, makeInitMsg());
    browser.send.mockClear();

    // Switch back to real timers before subscribe so async flushes work
    vi.useRealTimers();

    // Reconnect a new browser — should see "idle" not "running"
    // even though history ends with an assistant message
    const browser2 = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser2, "s1");
    bridge.handleBrowserMessage(browser2, JSON.stringify({ type: "session_subscribe", last_seq: 0 }));
    await flushAsync(); // sendHistorySync is async

    const calls = browser2.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const snapshot = calls.find((m: any) => m.type === "state_snapshot");
    expect(snapshot).toBeDefined();
    // Key assertion: after a full relaunch (grace expired), isGenerating is cleared
    expect(snapshot.sessionStatus).toBe("idle");
    expect(snapshot.backendConnected).toBe(true);
  });

  it("state_snapshot includes attention for herded worker sessions when set", () => {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );

    // Send tool_result
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file.txt" }] },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
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
      }),
    );

    // Send tool_result for both
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu-a", content: "match1" },
            { type: "tool_result", tool_use_id: "tu-b", content: "match2" },
          ],
        },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-orphan", content: "data" }] },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "a.txt" } }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );

    const session = bridge.getOrCreateSession("s1");
    expect(session.toolStartTimes.has("tu-1")).toBe(true);

    // Send tool_result
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "contents" }] },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "cli-123",
      }),
    );

    // Start time should be cleaned up
    expect(session.toolStartTimes.has("tu-1")).toBe(false);
  });

  it("persists duration_seconds in messageHistory for replay", () => {
    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Send tool_use + tool_result
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "test" } }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }] },
        parent_tool_use_id: null,
        uuid: "u3",
        session_id: "cli-123",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
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
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [{ type: "text", text: "Hello" }],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u2",
        session_id: "cli-123",
      }),
    );

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
      bridge.handleCLIMessage(
        cli,
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude",
            content: [{ type: "text", text: "Part 1" }],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          uuid: "u2",
          session_id: "cli-123",
        }),
      );

      vi.setSystemTime(new Date(1700000005000));
      bridge.handleCLIMessage(
        cli,
        JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude",
            content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 12, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          uuid: "u3",
          session_id: "cli-123",
        }),
      );

      const calls = browser.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const assistantMsgs = calls.filter((m: any) => m.type === "assistant");
      expect(assistantMsgs).toHaveLength(2);
      expect(assistantMsgs[0].timestamp).toBe(1700000000000);
      expect(assistantMsgs[1].timestamp).toBe(1700000005000);

      const session = bridge.getOrCreateSession("s1");
      const hist = session.messageHistory.find((m) => m.type === "assistant") as
        | { type: "assistant"; timestamp?: number }
        | undefined;
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

  it("computeDiffStats: uses merge-base for non-worktree sessions to exclude remote changes", async () => {
    // Validates the core fix: non-worktree sessions should diff against merge-base,
    // not the raw branch ref. Without merge-base anchoring, `git diff main` includes
    // changes the session is BEHIND on (remote commits), inflating the stats.
    const mergeBaseCalls: string[] = [];
    const diffCalls: string[] = [];
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("diff --numstat")) {
        diffCalls.push(cmd);
        // Only return stats when diffing against the merge-base SHA (not raw branch ref)
        if (cmd.includes("abc999def")) return "5\t2\tchanged.ts\n";
        // If the raw branch ref slips through, return inflated stats (the bug)
        return "100\t50\tremote-changes.ts\n5\t2\tchanged.ts\n";
      }
      if (cmd.includes("merge-base")) {
        mergeBaseCalls.push(cmd);
        return "abc999def\n";
      }
      return "";
    });

    const session = bridge.getOrCreateSession("s1");
    session.state.cwd = "/repo";
    session.state.diff_base_branch = "origin/main";
    session.state.is_worktree = false;
    session.diffStatsDirty = true;
    (session as any).backendSocket = { send: vi.fn() };

    bridge.recomputeDiffIfDirty(session);

    await vi.waitFor(() => {
      expect(session.state.total_lines_added).toBe(5);
      expect(session.state.total_lines_removed).toBe(2);
    });

    // Verify merge-base was called with the branch ref
    expect(mergeBaseCalls).toHaveLength(1);
    expect(mergeBaseCalls[0]).toContain("origin/main");
    // Verify diff was called with the merge-base SHA, not the raw branch ref
    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0]).toContain("abc999def");
    expect(diffCalls[0]).not.toContain("origin/main");
  });

  it("recomputeDiffIfDirty: skips when flag is clean, recomputes when dirty", async () => {
    // Session with diff base set up so computeDiffStatsAsync can run
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "main-wt-1\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/main-wt-1\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
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
      if (cmd.includes("--left-right --count")) return "0\t3\n";
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

  it("refreshWorktreeGitStateForSnapshot forces a clean diff recompute after external reset", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1\n";
      if (cmd.includes("--git-dir")) return "/repo/.git/worktrees/jiayi-wt-1\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("rev-parse HEAD")) return "same-head-sha\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "same-head-sha\n";
      if (cmd.includes("diff --numstat")) return "\n";
      return "";
    });

    bridge.markWorktree("s1", "/repo", "/tmp/wt", "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = "/tmp/wt";
    session.state.git_head_sha = "same-head-sha";
    session.state.diff_base_start_sha = "same-head-sha";
    session.state.total_lines_added = 777;
    session.state.total_lines_removed = 55;
    session.diffStatsDirty = false;

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    (browser.send as any).mockClear();

    await bridge.refreshWorktreeGitStateForSnapshot("s1", { broadcastUpdate: true });

    expect(session.state.total_lines_added).toBe(0);
    expect(session.state.total_lines_removed).toBe(0);
    expect(session.diffStatsDirty).toBe(false);
    expect(
      (browser.send as any).mock.calls.some(([raw]: [string]) => {
        const msg = JSON.parse(raw);
        return (
          msg.type === "session_update" &&
          msg.session?.total_lines_added === 0 &&
          msg.session?.total_lines_removed === 0
        );
      }),
    ).toBe(true);
  });

  it("refreshWorktreeGitStateForSnapshot skips git work when the worktree fingerprint is unchanged", async () => {
    const worktreeCwd = join(tempDir, "wt");
    const worktreeGitDir = join(tempDir, "repo.git", "worktrees", "wt-1");
    mkdirSync(worktreeCwd, { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeCwd, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/jiayi-wt-1\n");
    writeFileSync(join(worktreeGitDir, "index"), "index");

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi-wt-1\n";
      if (cmd.includes("--git-dir")) return `${worktreeGitDir}\n`;
      if (cmd.includes("--git-common-dir")) return `${join(tempDir, "repo.git")}\n`;
      if (cmd.includes("rev-parse HEAD")) return "same-head-sha\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "same-head-sha\n";
      if (cmd.includes("diff --numstat")) return "10\t3\tfile.ts\n";
      return "";
    });

    bridge.markWorktree("s1", join(tempDir, "repo"), worktreeCwd, "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = worktreeCwd;

    await bridge.refreshWorktreeGitStateForSnapshot("s1");
    expect(session.state.total_lines_added).toBe(10);
    expect(session.state.total_lines_removed).toBe(3);

    mockExecSync.mockClear();
    await bridge.refreshWorktreeGitStateForSnapshot("s1");

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(session.state.total_lines_added).toBe(10);
    expect(session.state.total_lines_removed).toBe(3);
  });

  it("refreshWorktreeGitStateForSnapshot coalesces concurrent refreshes for the same session", async () => {
    const worktreeCwd = join(tempDir, "wt");
    const worktreeGitDir = join(tempDir, "repo.git", "worktrees", "wt-1");
    mkdirSync(worktreeCwd, { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeCwd, ".git"), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(worktreeGitDir, "HEAD"), "ref: refs/heads/jiayi-wt-1\n");
    writeFileSync(join(worktreeGitDir, "index"), "index");

    const diffCallbacks: Array<(err: Error | null, result: { stdout: string; stderr: string }) => void> = [];
    const commands: string[] = [];
    mockExec.mockImplementation((cmd: string, opts: any, cb?: Function) => {
      commands.push(cmd);
      const callback = typeof opts === "function" ? opts : cb;
      if (cmd.includes("diff --numstat")) {
        if (callback) diffCallbacks.push(callback);
        return;
      }
      let stdout = "";
      if (cmd.includes("--abbrev-ref HEAD")) stdout = "jiayi-wt-1\n";
      else if (cmd.includes("--git-dir")) stdout = `${worktreeGitDir}\n`;
      else if (cmd.includes("--git-common-dir")) stdout = `${join(tempDir, "repo.git")}\n`;
      else if (cmd.includes("rev-parse HEAD")) stdout = "same-head-sha\n";
      else if (cmd.includes("--left-right --count")) stdout = "0\t0\n";
      else if (cmd.includes("merge-base")) stdout = "same-head-sha\n";
      callback?.(null, { stdout, stderr: "" });
    });

    bridge.markWorktree("s1", join(tempDir, "repo"), worktreeCwd, "jiayi");
    const session = bridge.getSession("s1")!;
    session.state.cwd = worktreeCwd;

    const first = bridge.refreshWorktreeGitStateForSnapshot("s1");
    const second = bridge.refreshWorktreeGitStateForSnapshot("s1");

    await vi.waitFor(() => expect(diffCallbacks).toHaveLength(1));
    diffCallbacks[0]!(null, { stdout: "10\t3\tfile.ts\n", stderr: "" });
    await Promise.all([first, second]);

    expect(commands.filter((cmd) => cmd.includes("diff --numstat"))).toHaveLength(1);
    expect(session.state.total_lines_added).toBe(10);
    expect(session.state.total_lines_removed).toBe(3);
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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-read",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [
            {
              type: "tool_use",
              id: "tool-read",
              name: "Read",
              input: { file_path: "/repo/file.ts" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u-read",
        session_id: "s1",
      }),
    );
    expect(session.diffStatsDirty).toBe(false);

    // Non-read-only tool (Edit) should mark dirty and track the file
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-edit",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [
            {
              type: "tool_use",
              id: "tool-edit",
              name: "Edit",
              input: { file_path: "/repo/file.ts", old_string: "a", new_string: "b" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u-edit",
        session_id: "s1",
      }),
    );
    expect(session.diffStatsDirty).toBe(true);

    // Bash tool (not in READ_ONLY_TOOLS) should also mark dirty
    session.diffStatsDirty = false;
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-bash",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [
            {
              type: "tool_use",
              id: "tool-bash",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        uuid: "u-bash",
        session_id: "s1",
      }),
    );
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

  it("prefills Codex skill/app mention metadata from the per-project cache", () => {
    // Validates one initialized Codex session seeds `$` mention suggestions for
    // later sessions in the same project before those sessions refresh from Codex.
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        cwd: "/repo",
        model: "gpt-5-codex",
      },
    });
    adapter.emitBrowserMessage({
      type: "session_update",
      session: {
        skills: ["review"],
        skill_metadata: [
          {
            name: "review",
            path: "/Users/test/.codex/skills/review/SKILL.md",
            description: "Review code changes",
          },
        ],
        apps: [
          {
            id: "connector_google_drive",
            name: "Google Drive",
            description: "Search and edit Drive files",
          },
        ],
      },
    });

    bridge.setInitialCwd("s2", "/repo");

    const state = bridge.getSession("s2")!.state;
    expect(state.skills).toEqual(["review"]);
    expect(state.skill_metadata).toEqual([
      {
        name: "review",
        path: "/Users/test/.codex/skills/review/SKILL.md",
        description: "Review code changes",
      },
    ]);
    expect(state.apps).toEqual([
      {
        id: "connector_google_drive",
        name: "Google Drive",
        description: "Search and edit Drive files",
      },
    ]);
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
      if (cmd.includes("--left-right --count")) return "0\t2\n";
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
      if (cmd.includes("--left-right --count")) return "0\t3\n";
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
    const diffUpdate = calls.find(
      (c: any) =>
        c.type === "session_update" && c.session?.total_lines_added === 12 && c.session?.total_lines_removed === 4,
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
            input: { command: 'quest complete q-74 --items "Verify" --json' },
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
              command:
                "quest claim q-74 --json | jq '{id,status}'; quest complete q-74 --items \"Verify\" --json | jq '{id,status}'",
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
    expectCodexStartPendingTurnLike(getPendingCodexTurn(session), {
      firstContent: "hello",
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

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const reattachedCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const reattachedMsg = reattachedCalls[0]?.[0] as any;
    expect(reattachedMsg).toBeDefined();
    expect(getCodexStartPendingInputs(reattachedMsg)[0]?.content).toBe("hello");
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(0);
    expectCodexStartPendingTurnLike(getPendingCodexTurn(session), {
      firstContent: "hello",
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

  it("executes pending Codex rollback on session reattach before resume hydration", async () => {
    const session = bridge.getOrCreateSession("s1", "codex");
    session.messageHistory = [];
    const { promise, requiresRelaunch } = bridge.beginCodexRollback("s1", {
      numTurns: 2,
      truncateIdx: 0,
      clearCodexState: true,
    });
    expect(requiresRelaunch).toBe(true);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);

    emitCodexSessionReady(adapter, {
      cliSessionId: "thread-rollback-reattach",
      resumeSnapshot: {
        threadId: "thread-rollback-reattach",
        turnCount: 3,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            error: null,
            items: [{ type: "userMessage", text: "stale replay text" }],
          },
        ],
        lastTurn: {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [{ type: "userMessage", text: "stale replay text" }],
        },
        threadStatus: "idle",
      },
    });
    await promise;

    expect(adapter.rollbackTurns).toHaveBeenCalledWith(2);
    expect(session.pendingCodexRollback).toBeNull();
    expect(session.messageHistory).toEqual([]);
  });

  it("records pending Codex rollback failure on session reattach without hydrating stale resume history", async () => {
    const session = bridge.getOrCreateSession("s1", "codex");
    const { promise, requiresRelaunch } = bridge.beginCodexRollback("s1", {
      numTurns: 2,
      truncateIdx: 0,
      clearCodexState: true,
    });
    expect(requiresRelaunch).toBe(true);

    const adapter = makeCodexAdapterMock();
    adapter.rollbackTurns.mockRejectedValueOnce(new Error("rollback refused"));
    bridge.attachCodexAdapter("s1", adapter as any);

    emitCodexSessionReady(adapter, {
      cliSessionId: "thread-rollback-failure",
      resumeSnapshot: {
        threadId: "thread-rollback-failure",
        turnCount: 3,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            error: null,
            items: [{ type: "userMessage", text: "stale replay text" }],
          },
        ],
        lastTurn: {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [{ type: "userMessage", text: "stale replay text" }],
        },
        threadStatus: "idle",
      },
    });

    await expect(promise).rejects.toThrow("rollback refused");
    expect(session.pendingCodexRollback).toBeNull();
    expect(session.pendingCodexRollbackError).toBe("rollback refused");
    expect(session.messageHistory).toEqual([]);
  });

  it("preserves pending Codex rollback across init error so a later reconnect can retry", async () => {
    const session = bridge.getOrCreateSession("s1", "codex");
    const { promise, requiresRelaunch } = bridge.beginCodexRollback("s1", {
      numTurns: 2,
      truncateIdx: 0,
      clearCodexState: true,
    });
    expect(requiresRelaunch).toBe(true);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter("s1", adapter as any);
    adapter.emitInitError("codex init failed");

    await expect(promise).rejects.toThrow("codex init failed");
    expect(session.pendingCodexRollback).toEqual({ numTurns: 2, truncateIdx: 0, clearCodexState: true });
    expect(session.pendingCodexRollbackError).toBe("codex init failed");
    expect(session.messageHistory).toEqual([]);
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

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const replayedCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const replayedMsg = replayedCalls[0]?.[0] as any;
    expect(replayedMsg).toBeDefined();
    expect(getCodexStartPendingInputs(replayedMsg)[0]?.content).toBe("replay me");
    const session = bridge.getSession("s1")!;
    expect(session.pendingMessages).toHaveLength(0);
    expectCodexStartPendingTurnLike(getPendingCodexTurn(session), {
      firstContent: "replay me",
      status: "dispatched",
    });
  });
});

describe("Codex MCP startup failures", () => {
  it("keeps an established session connected when optional connector auth fails", () => {
    const sid = "s-established-mcp-auth-noise";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "codex", state: "connected", killedByIdleManager: false })),
    } as any);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-established-mcp-auth-noise" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    relaunchCb.mockClear();
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "mcp_status",
      servers: [
        {
          name: "notion",
          status: "failed",
          error: 'Auth(TokenRefreshFailed("Server returned error response: invalid_grant"))',
          config: { type: "unknown" },
          scope: "session",
          tools: [],
        },
      ],
    });
    adapter.emitBrowserMessage({
      type: "session_update",
      session: { mcp_servers: [{ name: "notion", status: "failed" }] },
    });

    expect(relaunchCb).not.toHaveBeenCalled();
    const session = bridge.getSession(sid)!;
    expect(session.codexAdapter).toBe(adapter);
    expect(session.state.backend_state).toBe("connected");

    const sentTypes = browser.send.mock.calls.map(([raw]: [unknown]) => JSON.parse(String(raw)).type);
    expect(sentTypes).toContain("mcp_status");
    expect(sentTypes).toContain("session_update");
    expect(sentTypes).not.toContain("backend_disconnected");
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_permission_mode",
        mode: "plan",
      }),
    );

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
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ backend_state: "recovering", backend_error: null }),
      }),
    );
  });

  it("requests relaunch when Codex adapter disconnects without a browser attached", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    adapter.emitDisconnect();

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(bridge.getSession(sid)?.state.backend_state).toBe("recovering");
  });

  it("does not request relaunch for idle-manager disconnects", () => {
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
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
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Session stopped after 3 consecutive launch failures"),
      }),
    );
  });
});

// Regression: q-16 — markCodexRelaunchIntentional prevents the adapter
// disconnect handler from requesting a redundant auto-relaunch when
// cli-launcher kills the old process during relaunch().
describe("markCodexRelaunchIntentional (q-16 double-spawn fix)", () => {
  it("suppresses auto-relaunch when disconnect is marked intentional before it fires", () => {
    const sid = "s-mark-intentional";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();
    relaunchCb.mockClear();

    // Mark the upcoming disconnect as intentional (simulating what
    // cli-launcher.relaunch() does via onBeforeRelaunch callback)
    bridge.markCodexRelaunchIntentional(sid, "relaunch");

    // Simulate the disconnect from killing the old process
    adapter.emitDisconnect();

    // The disconnect handler should recognize it as intentional and NOT
    // request another relaunch
    expect(relaunchCb).not.toHaveBeenCalled();

    // Failure counter should not have been incremented
    const session = bridge.getSession(sid)!;
    expect(session.consecutiveAdapterFailures).toBe(0);
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
      touchUserMessage: vi.fn(),
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
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "continue working",
      }),
    );

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
      touchUserMessage: vi.fn(),
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
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "try again",
      }),
    );

    expect(session.consecutiveAdapterFailures).toBe(0);
    expect(relaunchCb).toHaveBeenCalledWith(sid);
  });

  it("wakes idle-killed Codex sessions by clearing flag and relaunching on user_message", async () => {
    // When a user sends a message to an idle-killed Codex session, the intent
    // is to wake it. The killedByIdleManager flag should be cleared and
    // relaunch triggered (matching the injectUserMessage fix for q-15).
    const sid = "s-idle-killed";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    const launcherInfo = { state: "exited", killedByIdleManager: true };
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello",
      }),
    );

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(launcherInfo.killedByIdleManager).toBe(false);
  });

  it("does not request relaunch when adapter is still connected", async () => {
    // If the adapter is connected, messages go directly — no relaunch needed
    const sid = "s-connected";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ state: "connected" })),
    } as any);

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-connected" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    relaunchCb.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "this should go to the adapter directly",
      }),
    );

    // Message should go to adapter, not trigger relaunch
    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    expect(relaunchCb).not.toHaveBeenCalled();
  });

  it("requests relaunch for adapter-missing Codex user messages even when launcher state is connected", async () => {
    const sid = "s-codex-missing-adapter";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "codex", state: "connected", killedByIdleManager: false })),
    } as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    const session = bridge.getSession(sid)!;
    session.backendType = "codex";
    browser.send.mockClear();
    relaunchCb.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "wake missing adapter",
      }),
    );

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(session.state.backend_state).toBe("recovering");
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("wake missing adapter");
  });
});

describe("injectUserMessage triggers relaunch for exited sessions (q-15)", () => {
  // injectUserMessage is called by the takode send REST endpoint. Before q-15,
  // the endpoint rejected exited sessions outright. Now it lets the message
  // queue and relies on injectUserMessage to trigger a relaunch — matching the
  // browser chat UI behavior.

  it("requests relaunch when injecting a message into an exited Claude session", () => {
    const sid = "s-inject-claude";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ state: "exited", killedByIdleManager: false })),
    } as any);

    // Create a Claude session with no backend socket (exited)
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    relaunchCb.mockClear();

    const delivery = bridge.injectUserMessage(sid, "hello from takode send");

    // Message should be queued (not sent) and relaunch requested
    expect(delivery).toBe("queued");
    expect(relaunchCb).toHaveBeenCalledWith(sid);
  });

  it("routes pre-attach injected Codex messages through the authoritative Codex turn queue", () => {
    const sid = "s-inject-codex-starting";
    const relaunchCb = vi.fn();
    const launcherInfo = { backendType: "codex", state: "starting", killedByIdleManager: false };
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    } as any);

    // A browser/opened placeholder can exist before the Codex adapter attaches.
    // It must be corrected from launcher metadata before injected dispatch
    // routing, otherwise q44 startup turns fall into raw pendingMessages.
    const session = bridge.getOrCreateSession(sid);
    expect(session.backendType).toBe("claude");

    const delivery = bridge.injectUserMessage(sid, "startup dispatch from takode send", {
      sessionId: "leader-session",
      sessionLabel: "Leader",
    });

    expect(delivery).toBe("queued");
    expect(relaunchCb).not.toHaveBeenCalled();
    expect(session.backendType).toBe("codex");
    expect(session.pendingMessages).toHaveLength(0);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "queued",
      userContent: "startup dispatch from takode send",
    });

    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-startup-dispatch" });

    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: [expect.objectContaining({ content: "startup dispatch from takode send" })],
      }),
    );
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "dispatched",
      dispatchCount: 1,
    });
  });

  it("wakes an idle-killed session by clearing flag and requesting relaunch", () => {
    // When a leader sends a message to an idle-killed worker, the intent is
    // clear: wake the session. The killedByIdleManager flag should be cleared
    // and relaunch triggered — matching how wakeIdleKilledSession() works.
    const sid = "s-inject-idle-killed";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    const launcherInfo = { state: "exited", killedByIdleManager: true };
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    } as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    relaunchCb.mockClear();

    const delivery = bridge.injectUserMessage(sid, "wake up, worker");

    expect(delivery).toBe("queued");
    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(launcherInfo.killedByIdleManager).toBe(false);
  });

  it("returns 'sent' and does not relaunch when backend is connected", () => {
    const sid = "s-inject-connected";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ state: "connected" })),
    } as any);

    const cliWs = makeCliSocket(sid);
    bridge.handleCLIOpen(cliWs, sid);

    const delivery = bridge.injectUserMessage(sid, "hello live session");

    expect(delivery).toBe("sent");
    expect(relaunchCb).not.toHaveBeenCalled();
  });

  it("requests relaunch when injectUserMessage targets an adapter-missing Codex session whose launcher still says connected", () => {
    const sid = "s-inject-codex-missing-adapter";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "codex", state: "connected", killedByIdleManager: false })),
    } as any);

    const session = bridge.getOrCreateSession(sid);
    session.backendType = "codex";
    session.state.backend_type = "codex";

    const delivery = bridge.injectUserMessage(sid, "inject wake missing adapter");

    expect(delivery).toBe("queued");
    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(session.state.backend_state).toBe("recovering");
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("inject wake missing adapter");
  });

  it("wakes idle-killed SDK session when browser sends user_message (adapter path)", async () => {
    // SDK sessions use the adapter code path in routeBrowserMessage.
    // When the adapter is missing (post-restart, idle-killed), a browser
    // user_message should clear killedByIdleManager and trigger relaunch.
    const sid = "s-sdk-idle-wake";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    const launcherInfo = { backendType: "claude-sdk", state: "exited", killedByIdleManager: true };
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    } as any);

    // Create an SDK session with no adapter (simulates post-restart idle-killed state)
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    const session = bridge.getSession(sid)!;
    session.backendType = "claude-sdk";
    relaunchCb.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "wake up from idle",
      }),
    );

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    expect(launcherInfo.killedByIdleManager).toBe(false);
  });
});

describe("Codex recovering state reset", () => {
  it("drops recovering back to disconnected when auto-relaunch fails before any adapter reattaches", () => {
    const sid = "s-codex-recovery-failed";
    const session = bridge.getOrCreateSession(sid, "codex");
    session.state.backend_state = "recovering";

    (bridge as any).markCodexAutoRecoveryFailed(sid);

    expect(session.state.backend_state).toBe("disconnected");
    expect(session.state.backend_error).toBeNull();
  });

  it("keeps recovering unchanged if a Codex adapter is already attached", () => {
    const sid = "s-codex-recovery-live";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    const session = bridge.getSession(sid)!;
    session.state.backend_state = "recovering";

    (bridge as any).markCodexAutoRecoveryFailed(sid);

    expect(session.state.backend_state).toBe("recovering");
  });
});

describe("Codex broken-session recovery regression", () => {
  it("keeps the acknowledged image turn authoritative and blocks later messages after init failure", async () => {
    const sid = "s-image-init-failure";
    const expectedAttachmentPath = join(homedir(), ".companion", "images", sid, "img-140.orig.jpeg");
    const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
    const adapter1 = makeCodexAdapterMock();
    const imageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-140", media_type: "image/jpeg" }),
      getOriginalPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-140.orig.jpeg"),
    };
    bridge.setImageStore(imageStore as any);
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-image-140" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please inspect this screenshot",
        images: [{ media_type: "image/jpeg", data: "inline-image-data" }],
      }),
    );
    await flush();

    const session = bridge.getSession(sid)!;
    expectCodexStartPendingTurnLike(getPendingCodexTurn(session), {
      firstContentContaining: expectedAttachmentPath,
      firstLocalImages: ["/tmp/companion-images/img-140.orig.jpeg"],
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
      userContent: expect.stringContaining(expectedAttachmentPath),
    });

    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Hello",
      }),
    );
    await flush();

    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "blocked_broken_session",
      turnId: "turn-image-140",
      lastError: "Transport closed",
    });
    expect(session.pendingMessages).toHaveLength(0);
    expect(session.pendingCodexTurns[1]).toBeUndefined();
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("Hello");
    expect(session.isGenerating).toBe(false);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "Codex session is broken. Your message was queued and will run after relaunch.",
      }),
    );
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

    await bridge.handleBrowserMessage(
      makeBrowserSocket(sid),
      JSON.stringify({
        type: "user_message",
        content: "original turn",
      }),
    );
    await flush();

    adapter1.emitTurnStarted("turn-original");
    adapter1.emitDisconnect("turn-original");

    const adapter2 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter2 as any);
    adapter2.emitInitError("Transport closed");

    await bridge.handleBrowserMessage(
      makeBrowserSocket(sid),
      JSON.stringify({
        type: "user_message",
        content: "queued behind broken turn",
      }),
    );
    await flush();

    const session = bridge.getSession(sid)!;
    const adapter3 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter3 as any);
    adapter3.emitSessionMeta({ cliSessionId: "thread-recovered", model: "gpt-5.3-codex", cwd: "/repo" });

    expect(adapter3.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: expect.arrayContaining([expect.objectContaining({ content: "queued behind broken turn" })]),
      }),
    );
    expect(session.pendingMessages).toHaveLength(0);
    expect(session.pendingCodexTurns[1]).toBeUndefined();
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("queued behind broken turn");

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

    const resumedQueuedMsg = (adapter3.sendBrowserMessage.mock.calls as any[])[1]?.[0];
    expect(resumedQueuedMsg).toBeDefined();
    expect(getCodexStartPendingInputs(resumedQueuedMsg)[0]?.content).toBe("queued behind broken turn");
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
    session.pendingCodexTurns = [
      {
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
      },
    ] as any;

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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "please recover this",
      }),
    );

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
    const recovered = calls.find(
      (c: any) =>
        c.type === "assistant" &&
        c.message?.id === "codex-agent-item-a1" &&
        c.message?.content?.[0]?.text === "Recovered answer from resumed turn",
    );
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "recover and replay",
      }),
    );

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
    expect(
      session.messageHistory.filter(
        (msg: any) => msg.type === "assistant" && msg.message?.id === "codex-agent-item-replay",
      ),
    ).toHaveLength(1);
    expect(browser.send).not.toHaveBeenCalled();
  });

  it("hydrates prior transcript when resuming an external codex thread", async () => {
    const sid = "s-external-resume-history";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    adapter.emitSessionMeta({
      cliSessionId: "thread-history",
      model: "gpt-5.3-codex",
      cwd: "/repo",
      resumeSnapshot: {
        threadId: "thread-history",
        turnCount: 2,
        turns: [
          {
            id: "turn-1",
            status: "completed",
            error: null,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "first question" }] },
              { type: "agentMessage", id: "item-a1", text: "first answer" },
            ],
          },
          {
            id: "turn-2",
            status: "completed",
            error: null,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "second question" }] },
              { type: "agentMessage", id: "item-a2", text: "second answer" },
            ],
          },
        ],
        lastTurn: {
          id: "turn-2",
          status: "completed",
          error: null,
          items: [
            { type: "userMessage", content: [{ type: "text", text: "second question" }] },
            { type: "agentMessage", id: "item-a2", text: "second answer" },
          ],
        },
      },
    });

    const session = bridge.getSession(sid)!;
    expect(session.messageHistory.map((msg: any) => msg.type)).toEqual([
      "user_message",
      "assistant",
      "user_message",
      "assistant",
    ]);

    const browserMessages = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      browserMessages.find((msg: any) => msg.type === "user_message" && msg.content === "first question"),
    ).toBeDefined();
    expect(
      browserMessages.find(
        (msg: any) => msg.type === "assistant" && msg.message?.content?.[0]?.text === "second answer",
      ),
    ).toBeDefined();
  });

  it("deduplicates compaction-style resumed assistant snapshots with generic item ids", async () => {
    const sid = "s-compaction-replay-dedup";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-compaction" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "keep going after compaction",
      }),
    );

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
    expect(
      session.messageHistory.filter(
        (msg: any) =>
          msg.type === "assistant" &&
          msg.message?.content?.[0]?.type === "text" &&
          msg.message.content[0].text === "First commentary before compaction",
      ),
    ).toHaveLength(1);
    expect(
      session.messageHistory.filter(
        (msg: any) =>
          msg.type === "assistant" &&
          msg.message?.content?.[0]?.type === "text" &&
          msg.message.content[0].text === "Second commentary before compaction",
      ),
    ).toHaveLength(1);
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Draft the first pass",
      }),
    );
    adapter1.emitTurnStarted("turn-rearm-resumed-followup-1");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Then add the reconnect details",
      }),
    );
    await Promise.resolve();
    const steeredPendingId = bridge.getSession(sid)?.pendingCodexInputs[0]?.id;
    expect(steeredPendingId).toBeDefined();
    if (!steeredPendingId) throw new Error("missing steered pending input");
    adapter1.emitTurnSteered("turn-rearm-resumed-followup-2", [steeredPendingId]);

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
      status: "backend_acknowledged",
      turnId: "turn-rearm-resumed-followup-2",
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
    expect(turnEndCalls[2]?.[2]).toEqual(
      expect.not.objectContaining({
        interrupted: true,
      }),
    );

    eventSpy.mockRestore();
  });

  it("retries the user message when resumed turn has only user input", async () => {
    const sid = "s1";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "retry me",
      }),
    );

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
          items: [{ type: "userMessage", content: [{ type: "text", text: "retry me" }] }],
        },
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const retryCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const retryMsg = retryCalls[0]?.[0] as any;
    expect(retryMsg).toBeDefined();
    expect(getCodexStartPendingInputs(retryMsg)[0]?.content).toBe("retry me");
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "plan this safely",
      }),
    );

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

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const reasoningRetryCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const reasoningRetryMsg = reasoningRetryCalls[0]?.[0] as any;
    expect(reasoningRetryMsg).toBeDefined();
    expect(getCodexStartPendingInputs(reasoningRetryMsg)[0]?.content).toBe("plan this safely");
    const session = bridge.getSession(sid)!;
    expect(getPendingCodexTurn(session)).not.toBeNull();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const retrySkipError = calls.find(
      (c: any) => c.type === "error" && typeof c.message === "string" && c.message.includes("non-text tool activity"),
    );
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "resume without last turn",
      }),
    );

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

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const missingTurnRetryCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const missingTurnRetryMsg = missingTurnRetryCalls[0]?.[0] as any;
    expect(missingTurnRetryMsg).toBeDefined();
    expect(getCodexStartPendingInputs(missingTurnRetryMsg)[0]?.content).toBe("resume without last turn");
  });

  it("retries stale idle-thread resumes even when disconnect happened before turn id was recorded", async () => {
    const sid = "s-missing-turn-id";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-orphaned" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "retry the orphaned dispatch",
      }),
    );

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

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const orphanedRetryCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const orphanedRetryMsg = orphanedRetryCalls[0]?.[0] as any;
    expect(orphanedRetryMsg).toBeDefined();
    expect(getCodexStartPendingInputs(orphanedRetryMsg)[0]?.content).toBe("retry the orphaned dispatch");
    expect((getPendingCodexTurn(bridge.getSession(sid)!) as any)?.turnId).toBeNull();
  });

  it("retries image turns when resume matching must use the annotated user text", async () => {
    const sid = "s-image-retry";
    const adapter1 = makeCodexAdapterMock();
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getOriginalPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.orig.png"),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-image" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "describe this screenshot",
        images: [{ media_type: "image/png", data: "image-bytes" }],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const expectedPath = "/tmp/companion-images/img-1.orig.png";
    expect((getPendingCodexTurn(bridge.getSession(sid)!) as any)?.userContent).toBe(
      "describe this screenshot\n" +
        "[📎 Image attachments -- use the Read tool to view these files:\n" +
        `Attachment 1: ${expectedPath}]`,
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
              content: [
                {
                  type: "text",
                  text:
                    "describe this screenshot\n" +
                    "[📎 Image attachments -- use the Read tool to view these files:\n" +
                    `Attachment 1: ${expectedPath}]`,
                },
              ],
            },
          ],
        },
      },
    });

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const retriedImageCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const retriedImageMsg = retriedImageCalls[0]?.[0] as any;
    expect(retriedImageMsg).toBeDefined();
    expect(getCodexStartPendingInputs(retriedImageMsg)[0]?.content).toContain("describe this screenshot");
    expect(getCodexStartPendingInputs(retriedImageMsg)[0]?.local_images).toEqual(["/tmp/companion-images/img-1.orig.png"]);
  });

  it("retries when resumed snapshot lastTurn does not match pending disconnected turn", async () => {
    const sid = "s1";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-5" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "retry unmatched turn",
      }),
    );

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

    expect(adapter2.sendBrowserMessage).toHaveBeenCalled();
    const unmatchedRetryCalls = adapter2.sendBrowserMessage.mock.calls as any[];
    const unmatchedRetryMsg = unmatchedRetryCalls[0]?.[0] as any;
    expect(unmatchedRetryMsg).toBeDefined();
    expect(getCodexStartPendingInputs(unmatchedRetryMsg)[0]?.content).toBe("retry unmatched turn");
  });

  it("synthesizes missing tool result previews from terminal resumed turns", async () => {
    const sid = "s-terminal-resume";
    const adapter1 = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter1 as any);
    emitCodexSessionReady(adapter1, { cliSessionId: "thread-terminal" });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run terminal command",
      }),
    );
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
    const preview = calls.find(
      (c: any) =>
        c.type === "tool_result_preview" &&
        Array.isArray(c.previews) &&
        c.previews.some((p: any) => p.tool_use_id === "cmd_1"),
    );
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

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run command",
        }),
      );
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
      const preview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_watch"),
      );
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

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run long command",
        }),
      );
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
      const preview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_live"),
      );
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

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run reconnecting command",
        }),
      );
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
      expect(
        browser.send.mock.calls
          .map(([arg]: [string]) => JSON.parse(arg))
          .find(
            (c: any) =>
              c.type === "error" && typeof c.message === "string" && c.message.includes("non-text tool activity"),
          ),
      ).toBeUndefined();

      browser.send.mockClear();
      vi.advanceTimersByTime(120_000);

      const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
      const preview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_reconnect"),
      );
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

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run two commands",
        }),
      );

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
      const stalePreview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_old_running"),
      );
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

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content: "run two commands",
        }),
      );

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
      const newPreview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_new"),
      );
      const stalePreview = calls.find(
        (c: any) =>
          c.type === "tool_result_preview" &&
          Array.isArray(c.previews) &&
          c.previews.some((p: any) => p.tool_use_id === "cmd_old"),
      );

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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run silent command",
      }),
    );
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
    const preview = calls.find(
      (c: any) =>
        c.type === "tool_result_preview" &&
        Array.isArray(c.previews) &&
        c.previews.some((p: any) => p.tool_use_id === "cmd_silent"),
    );
    expect(preview).toBeDefined();
    expect(preview.previews[0].is_error).toBe(false);
    expect(preview.previews[0].content).toContain("no output was captured");
    expect(bridge.getSession(sid)?.toolStartTimes.has("cmd_silent")).toBe(false);
  });

  it("prefers retained terminal transcript when superseded codex bash tool lacks a final result", async () => {
    const sid = "s-superseded-terminal-transcript";
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run two commands",
      }),
    );

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-old-terminal",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [
          {
            type: "tool_use",
            id: "cmd_old",
            name: "Bash",
            input: { command: "git --no-optional-locks status --short" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now() - 1000,
      tool_start_times: { cmd_old: Date.now() - 1000 },
    });

    adapter.emitBrowserMessage({
      type: "tool_progress",
      tool_use_id: "cmd_old",
      tool_name: "Bash",
      elapsed_time_seconds: 1,
      output_delta: " M web/src/components/MessageFeed.tsx\n",
    } as any);

    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-new-terminal",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "tool_use", id: "cmd_new", name: "Bash", input: { command: "echo done" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
      tool_start_times: { cmd_new: Date.now() },
    });
    bridge.getSession(sid)!.toolStartTimes.set("cmd_old", Date.now() - 1_000);
    bridge.getSession(sid)!.toolStartTimes.set("cmd_new", Date.now());

    browser.send.mockClear();
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "assistant-new-result",
        type: "message",
        role: "assistant",
        model: "gpt-5.3-codex",
        content: [{ type: "tool_result", tool_use_id: "cmd_new", content: "done", is_error: false }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const stalePreview = calls.find(
      (c: any) =>
        c.type === "tool_result_preview" &&
        Array.isArray(c.previews) &&
        c.previews.some((p: any) => p.tool_use_id === "cmd_old"),
    );

    expect(stalePreview).toBeDefined();
    expect(stalePreview.previews[0].content).toContain("M web/src/components/MessageFeed.tsx");
    expect(stalePreview.previews[0].content).not.toContain("later tool completed");
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "run a command",
      }),
    );
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
    const retried = (firstToolRetryCall as unknown as [any])[0] as any;
    expect(getCodexStartPendingInputs(retried)[0]?.content).toBe("run a command");

    // No "non-text tool activity" error sent
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(
      calls.find(
        (c: any) => c.type === "error" && typeof c.message === "string" && c.message.includes("non-text tool activity"),
      ),
    ).toBeUndefined();
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
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.onSessionRelaunchRequestedCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_model",
        model: "gpt-5.3-codex",
      }),
    );

    const session = bridge.getSession(sid)!;
    expect(session.state.model).toBe("gpt-5.3-codex");
    expect(launcherInfo.model).toBe("gpt-5.3-codex");
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    expect(relaunchCb).toHaveBeenCalledWith(sid);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const update = calls.find((c: any) => c.type === "session_update");
    expect(update).toEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({ model: "gpt-5.3-codex" }),
      }),
    );
  });

  it("set_codex_reasoning_effort updates session state and requests relaunch", async () => {
    const sid = "s2";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    const relaunchCb = vi.fn();
    const launcherInfo = { model: "gpt-5.4", codexReasoningEffort: undefined };
    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.onSessionRelaunchRequestedCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_codex_reasoning_effort",
        effort: "high",
      }),
    );

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
      touchUserMessage: vi.fn(),
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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_ask_permission",
        askPermission: false,
      }),
    );

    expect(session.state.permissionMode).toBe("plan");
    expect(session.state.uiMode).toBe("plan");
    expect(session.state.askPermission).toBe(false);
    expect(launcherInfo.permissionMode).toBe("plan");
    expect(launcherInfo.askPermission).toBe(false);
    expect(relaunchCb).toHaveBeenCalledWith(sid);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const update = calls.find((m: any) => m.type === "session_update");
    expect(update).toEqual(
      expect.objectContaining({
        type: "session_update",
        session: expect.objectContaining({
          askPermission: false,
          permissionMode: "plan",
          uiMode: "plan",
        }),
      }),
    );
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
      touchUserMessage: vi.fn(),
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
    await new Promise((r) => setTimeout(r, 50));
    const session = bridge.getSession(sid)!;
    expect(session.pendingPermissions.has("perm-stuck")).toBe(true);
    browser.send.mockClear();

    // Switch to bypassPermissions (auto-approve mode)
    // Use fake timers only for the relaunch delay
    vi.useFakeTimers();

    // Switch to bypassPermissions (auto-approve mode)
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_permission_mode",
        mode: "bypassPermissions",
      }),
    );

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
    const modeUpdate = msgs.find((m: any) => m.type === "session_update" && m.session?.permissionMode);
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
      touchUserMessage: vi.fn(),
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
    await new Promise((r) => setTimeout(r, 50));
    const session = bridge.getSession(sid)!;
    expect(session.pendingPermissions.has("perm-cancel")).toBe(true);
    browser.send.mockClear();

    // Switch to suggest mode — pending permissions should be denied/cancelled
    // Use fake timers only for the relaunch delay
    vi.useFakeTimers();
    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_permission_mode",
        mode: "suggest",
      }),
    );

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
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => launcherInfo),
    };
    bridge.setLauncher(launcherMock as any);
    bridge.onSessionRelaunchRequestedCallback(relaunchCb);
    bridge.attachCodexAdapter(sid, adapter as any);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "set_permission_mode",
        mode: "bypassPermissions",
      }),
    );

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

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "/compact",
      }),
    );
    adapter.emitTurnStarted("turn-compact");

    // Adapter should receive the message.
    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const compactCalls = adapter.sendBrowserMessage.mock.calls as any[];
    const compactMsg = compactCalls[0]?.[0] as any;
    expect(compactMsg).toBeDefined();
    expect(getCodexStartPendingInputs(compactMsg)[0]?.content).toBe("/compact");

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

      await bridge.handleBrowserMessage(
        browser,
        JSON.stringify({
          type: "user_message",
          content,
        }),
      );

      expect(adapter.sendBrowserMessage).toHaveBeenCalled();
      const compactVariationCalls = adapter.sendBrowserMessage.mock.calls as any[];
      const compactVariationMsg = compactVariationCalls[0]?.[0] as any;
      expect(compactVariationMsg).toBeDefined();
      expect(getCodexStartPendingInputs(compactVariationMsg)[0]?.content).toBe(content);
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
    expect(session.messageHistory.filter((m: any) => m.type === "user_message")).toHaveLength(0);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.agentSource).toEqual({
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });

    const outbound = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const broadcastPending = outbound.find((m: any) => m.type === "codex_pending_inputs");
    expect(broadcastPending?.inputs?.[0]?.agentSource).toEqual({
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });
  });

  it("dedupes herd-event retries even when the formatted age text changes", async () => {
    // Regression guard for q-275: real herd retries re-render relative-age text
    // (for example 1s ago -> 3s ago). The retry path must still match the
    // existing pending herd input instead of stacking a duplicate.
    vi.useFakeTimers();
    const leaderId = "orch-herd-retry-codex";
    const workerId = "worker-herd-retry-codex";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "codex", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "codex", cwd: "/test" }],
    ]);

    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 1 : 2)),
    };
    bridge.setLauncher(launcherMock as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const browser = makeBrowserSocket(leaderId);
    const adapter = makeCodexAdapterMock();
    let pendingBatchAttempts = 0;
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      if (msg.type === "codex_start_pending") {
        pendingBatchAttempts += 1;
        return pendingBatchAttempts > 1;
      }
      return true;
    });
    bridge.attachCodexAdapter(leaderId, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-herd-events-queued" });
    bridge.handleBrowserOpen(browser, leaderId);

    bridge.emitTakodeEvent(workerId, "turn_end", { duration_ms: 1000 });
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    const session = bridge.getSession(leaderId)!;
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "queued",
    });

    vi.advanceTimersByTime(2100);
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexTurns).toHaveLength(1);
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "dispatched",
    });
    expect(adapter.sendBrowserMessage).toHaveBeenCalledTimes(2);

    dispatcher.destroy();
    vi.useRealTimers();
  });

  it("dispatches a later real leader message instead of leaving it stranded behind a queued herd event", async () => {
    // q-275 user-visible regression: once the queued herd-event retry succeeds,
    // a later ordinary leader message should steer into the live Codex turn
    // instead of remaining stranded behind the previously queued herd chip.
    vi.useFakeTimers();
    const leaderId = "orch-herd-follow-up-codex";
    const workerId = "worker-herd-follow-up-codex";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "codex", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "codex", cwd: "/test" }],
    ]);
    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => launcherSessions.get(id)),
      getHerdedSessions: vi.fn((id: string) => (id === leaderId ? [{ sessionId: workerId }] : [])),
      getSessionNum: vi.fn((id: string) => (id === leaderId ? 1 : 2)),
    };
    bridge.setLauncher(launcherMock as any);

    const dispatcher = new HerdEventDispatcher(bridge as any, launcherMock as any);
    bridge.setHerdEventDispatcher(dispatcher);
    dispatcher.setupForOrchestrator(leaderId);

    const browser = makeBrowserSocket(leaderId);
    const adapter = makeCodexAdapterMock();
    let pendingBatchAttempts = 0;
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      if (msg.type === "codex_start_pending") {
        pendingBatchAttempts += 1;
        return pendingBatchAttempts > 1;
      }
      return true;
    });
    bridge.attachCodexAdapter(leaderId, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-herd-events-follow-up" });
    bridge.handleBrowserOpen(browser, leaderId);

    bridge.emitTakodeEvent(workerId, "turn_end", { duration_ms: 1000 });
    vi.advanceTimersByTime(600);
    await Promise.resolve();

    const session = bridge.getSession(leaderId)!;
    expect(getPendingCodexTurn(session)).toMatchObject({ status: "queued" });
    vi.advanceTimersByTime(2100);
    await Promise.resolve();
    expect(getPendingCodexTurn(session)).toMatchObject({ status: "dispatched" });

    adapter.emitTurnStarted("turn-herd-events-follow-up");
    await Promise.resolve();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "actual leader message",
      }),
    );
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(1);
    const pendingId = session.pendingCodexInputs[0]?.id;
    const steerCall = (adapter.sendBrowserMessage.mock.calls as any[])
      .map((call) => call[0])
      .find((msg: any) => msg.type === "codex_steer_pending");
    expect(steerCall?.type).toBe("codex_steer_pending");
    expect(steerCall?.inputs?.[0]?.content).toBe("actual leader message");

    adapter.emitTurnSteered("turn-herd-events-follow-up", [pendingId]);
    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "actual leader message"),
    ).toBe(true);

    dispatcher.destroy();
    vi.useRealTimers();
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

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please prioritize fixing auth bug first",
      }),
    );
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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Run full test suite",
      }),
    );
    adapter.emitTurnStarted("turn-running-1");

    // Mid-turn follow-up message causes Codex to interrupt the active turn first.
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Actually run only server tests",
      }),
    );

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

    const turnEndCalls = spy.mock.calls.filter(([eventSid, eventType]) => eventSid === sid && eventType === "turn_end");
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

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Run the full test suite",
      }),
    );
    adapter.emitTurnStarted("turn-running-2");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Then summarize only the failures",
      }),
    );

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

    const turnEndCalls = spy.mock.calls.filter(([eventSid, eventType]) => eventSid === sid && eventType === "turn_end");
    expect(turnEndCalls).toHaveLength(2);
    expect(turnEndCalls[0]?.[2]).toEqual(
      expect.not.objectContaining({
        interrupted: true,
      }),
    );
    expect(turnEndCalls[1]?.[2]).toEqual(
      expect.not.objectContaining({
        interrupted: true,
      }),
    );

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
      touchUserMessage: vi.fn(),
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
    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Implement the first version",
      }),
    );
    await Promise.resolve();
    workerAdapter.emitTurnStarted("turn-worker-correction-1");

    // Mid-turn correction from leader.
    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Correction: include edge-case handling",
        agentSource: { sessionId: leaderId, sessionLabel: "#1 leader" },
      }),
    );
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
    bridge.handleCLIMessage(
      leaderCli,
      JSON.stringify({
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
      }),
    );
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
      expect(workerTurnEndCalls[0]?.[2]).toEqual(
        expect.objectContaining({
          interrupted: true,
          interrupt_source: "leader",
        }),
      );
      expect(workerTurnEndCalls[1]?.[2]).toEqual(
        expect.not.objectContaining({
          interrupted: true,
        }),
      );

      const herdDeliveries = herdInjectSpy.mock.calls.filter(
        ([sid, _content, source]) => sid === leaderId && source?.sessionId === "herd-events",
      );
      // Both turn_end events are still delivered to the leader so reconnect
      // recovery remains visible even though the interrupted turn is system-attributed.
      expect(herdDeliveries).toHaveLength(2);
    } finally {
      dispatcher.destroy();
      eventSpy.mockRestore();
      herdInjectSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("delivers only leader-initiated turn_end to herd after correction with reconnect before follow-up start", async () => {
    vi.useFakeTimers();
    const leaderId = "orch-correction-reconnect";
    const workerId = "worker-correction-reconnect";
    const launcherSessions = new Map<string, any>([
      [leaderId, { sessionId: leaderId, isOrchestrator: true, backendType: "claude", cwd: "/test" }],
      [workerId, { sessionId: workerId, herdedBy: leaderId, backendType: "codex", cwd: "/test" }],
    ]);

    const launcherMock = {
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
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

    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Implement the first version",
      }),
    );
    await Promise.resolve();
    workerAdapter1.emitTurnStarted("turn-worker-correction-reconnect-1");

    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Correction: include edge-case handling",
        agentSource: { sessionId: leaderId, sessionLabel: "#1 leader" },
      }),
    );
    await Promise.resolve();

    workerAdapter1.emitDisconnect("turn-worker-correction-reconnect-1");
    await Promise.resolve();

    vi.advanceTimersByTime(600);
    await Promise.resolve();

    bridge.handleCLIMessage(
      leaderCli,
      JSON.stringify({
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
      }),
    );
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
      expect(workerTurnEndCalls[0]?.[2]).toEqual(
        expect.objectContaining({
          interrupted: true,
          interrupt_source: "system",
        }),
      );
      expect(workerTurnEndCalls[1]?.[2]).toEqual(
        expect.not.objectContaining({
          interrupted: true,
        }),
      );

      const herdDeliveries = herdInjectSpy.mock.calls.filter(
        ([sid, _content, source]) => sid === leaderId && source?.sessionId === "herd-events",
      );
      // Both turn_end events are delivered to the leader so the interrupted
      // correction turn and the resumed completion stay visible in herd.
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
      touchUserMessage: vi.fn(),
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

    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Implement the baseline version",
      }),
    );
    await Promise.resolve();
    workerAdapter.emitTurnStarted("turn-worker-correction-no-interrupt-1");

    bridge.handleBrowserMessage(
      workerBrowser,
      JSON.stringify({
        type: "user_message",
        content: "Correction: also include validation",
        agentSource: { sessionId: leaderId, sessionLabel: "#1 leader" },
      }),
    );
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

    bridge.handleCLIMessage(
      leaderCli,
      JSON.stringify({
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
      }),
    );
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
      expect(workerTurnEndCalls[0]?.[2]).toEqual(
        expect.not.objectContaining({
          interrupted: true,
        }),
      );
      expect(workerTurnEndCalls[1]?.[2]).toEqual(
        expect.not.objectContaining({
          interrupted: true,
        }),
      );

      const herdDeliveries = herdInjectSpy.mock.calls.filter(
        ([sid, _content, source]) => sid === leaderId && source?.sessionId === "herd-events",
      );
      // Both turn_end events are delivered to the leader: user-initiated
      // ones are annotated with "(user-initiated)" so the leader has full
      // visibility into all worker state changes.
      expect(herdDeliveries).toHaveLength(2);
    } finally {
      dispatcher.destroy();
      eventSpy.mockRestore();
      herdInjectSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("Codex explicit stop semantics", () => {
  it("clears queued follow-up turns on explicit user interrupt while preserving pending inputs", async () => {
    const sid = "codex-stop-clears-queue";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stop-clears-queue" });
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "initial active turn",
      }),
    );
    adapter.emitTurnStarted("turn-initial");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "queued follow-up after stop",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("queued follow-up after stop");
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_steer_pending",
        expectedTurnId: "turn-initial",
      }),
    );

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "interrupt",
        interruptSource: "user",
      }),
    );
    await Promise.resolve();

    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("queued follow-up after stop");
  });
});

describe("Codex active-turn steering", () => {
  it("steers a follow-up immediately instead of queueing a future turn", async () => {
    const sid = "codex-steer-active-turn";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-steer-active" });
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "initial turn",
      }),
    );
    await Promise.resolve();
    adapter.emitTurnStarted("turn-initial");

    const session = bridge.getSession(sid)!;
    const beforeCount = session.pendingCodexTurns.length;

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "follow-up steer",
      }),
    );
    await Promise.resolve();

    expect(session.pendingCodexInputs.map((input: any) => input.content)).toContain("follow-up steer");
    expect(session.pendingCodexTurns.length).toBe(beforeCount);
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_steer_pending",
        expectedTurnId: "turn-initial",
      }),
    );
  });

  it("clears a steered follow-up when Codex reports the same turn completed", async () => {
    // Codex can accept a steer into the currently running turn and return that
    // same turn id. In that case the follow-up was already consumed by the
    // completed backend turn and must not be promoted into a phantom queued turn.
    const sid = "codex-steer-same-turn-complete";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-steer-same-turn" });
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "initial turn",
      }),
    );
    await Promise.resolve();
    adapter.emitTurnStarted("turn-initial");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "follow-up handled in same turn",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    const pendingId = session.pendingCodexInputs.find(
      (input: any) => input.content === "follow-up handled in same turn",
    )?.id;
    expect(pendingId).toBeTruthy();
    if (!pendingId) throw new Error("missing pending Codex input id");
    adapter.emitTurnSteered("turn-initial", [pendingId]);
    expect(session.pendingCodexTurns).toHaveLength(2);

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed same turn",
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
        uuid: "codex-result-same-turn-steer",
        session_id: sid,
        codex_turn_id: "turn-initial",
      },
    });
    await Promise.resolve();

    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.queuedTurnStarts).toBe(0);
    expect(session.queuedTurnReasons).toEqual([]);
    expect(session.queuedTurnUserMessageIds).toEqual([]);
    expect(session.isGenerating).toBe(false);
  });

  it("preserves a steered future turn when only the current turn completed", async () => {
    // If turn/steer returns a different turn id, the follow-up belongs to a
    // future backend turn. Completing the current turn should still promote
    // that queued follow-up instead of dropping it.
    const sid = "codex-steer-future-turn-complete";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-steer-future-turn" });
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "initial turn",
      }),
    );
    await Promise.resolve();
    adapter.emitTurnStarted("turn-initial");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "follow-up in future turn",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    const pendingId = session.pendingCodexInputs.find((input: any) => input.content === "follow-up in future turn")?.id;
    expect(pendingId).toBeTruthy();
    if (!pendingId) throw new Error("missing pending Codex input id");
    adapter.emitTurnSteered("turn-follow-up", [pendingId]);

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed current turn",
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
        uuid: "codex-result-future-turn-current",
        session_id: sid,
        codex_turn_id: "turn-initial",
      },
    });
    await Promise.resolve();

    expect(session.pendingCodexTurns).toHaveLength(1);
    expect(getPendingCodexTurn(session)).toMatchObject({
      userContent: "follow-up in future turn",
      status: "backend_acknowledged",
      turnId: "turn-follow-up",
      turnTarget: "queued",
    });
    expect(session.isGenerating).toBe(true);
  });

  it("ignores a stale Codex result id instead of completing the current head turn", async () => {
    // A duplicate or delayed turn/completed for an already-cleared Codex turn
    // must not fall back to completing whatever turn is currently at the queue
    // head. That would recreate the q-25 stuck/lost-turn class in reverse.
    const sid = "codex-stale-result-id";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-stale-result-id" });
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "current turn",
      }),
    );
    await Promise.resolve();
    adapter.emitTurnStarted("turn-current");

    const session = bridge.getSession(sid)!;
    expect(getPendingCodexTurn(session)).toMatchObject({
      userContent: "current turn",
      turnId: "turn-current",
    });

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "duplicate stale completion",
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
        uuid: "codex-result-stale-id",
        session_id: sid,
        codex_turn_id: "turn-already-cleared",
      },
    });
    await Promise.resolve();

    expect(session.pendingCodexTurns).toHaveLength(1);
    expect(getPendingCodexTurn(session)).toMatchObject({
      userContent: "current turn",
      status: "backend_acknowledged",
      turnId: "turn-current",
    });
    expect(session.isGenerating).toBe(true);
    const staleResultPersisted = session.messageHistory.some(
      (msg: any) => msg.type === "result" && msg.data?.uuid === "codex-result-stale-id",
    );
    expect(staleResultPersisted).toBe(false);
  });

  it("restores pending Codex input to cancelable state when steer delivery fails", async () => {
    const sid = "codex-steer-failure";
    const browser = makeBrowserSocket(sid);
    const adapter = makeCodexAdapterMock();
    bridge.attachCodexAdapter(sid, adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-steer-failure" });
    bridge.handleBrowserOpen(browser, sid);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "initial turn",
      }),
    );
    await Promise.resolve();
    adapter.emitTurnStarted("turn-initial");

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "follow-up steer failure",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession(sid)!;
    expect(
      session.pendingCodexInputs.find((input: any) => input.content === "follow-up steer failure")?.cancelable,
    ).toBe(false);

    const pendingId = session.pendingCodexInputs.find((input: any) => input.content === "follow-up steer failure")?.id;
    expect(pendingId).toBeTruthy();
    if (!pendingId) throw new Error("missing pending Codex input id");
    const ensuredPendingId: string = pendingId;
    adapter.emitTurnSteerFailed([ensuredPendingId]);

    expect(session.pendingCodexInputs.find((input: any) => input.id === ensuredPendingId)?.cancelable).toBe(true);
  });
});

describe("Codex image transport", () => {
  // Codex image sends should rely on the same attachment-path text context as
  // Claude sessions, rather than native localImage transport.
  //
  // NOTE: handleBrowserMessage does NOT await routeBrowserMessage (fire-and-forget),
  // so tests need a microtask flush after the call for async image operations.

  /** Flush microtask queue so async routeBrowserMessage completes. */
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("sends path-only text context to Codex when stored originals are available", async () => {
    const adapter = makeCodexAdapterMock();

    // Create a mock imageStore that can resolve original paths.
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getOriginalPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.orig.png"),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-local-paths" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "describe this image",
        images: [{ media_type: "image/png", data: "large-base64-data" }],
      }),
    );
    await flush();

    // Adapter should receive text-only attachment paths AND native local_images
    // for Codex's localImage transport (q-322 restored this after q-298 broke it).
    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const firstImageCall = adapter.sendBrowserMessage.mock.calls[0];
    expect(firstImageCall).toBeDefined();
    const sentMsg = (firstImageCall as unknown as [any])[0] as any;
    const expectedPath = "/tmp/companion-images/img-1.orig.png";
    expect(sentMsg.type).toBe("codex_start_pending");
    expect(sentMsg.inputs[0]?.content).toContain(`Attachment 1: ${expectedPath}`);
    expect(sentMsg.inputs[0]?.local_images).toEqual([expectedPath]);
    expect(sentMsg.images).toBeUndefined();

    // The pending Codex input should stay path-only for transport, but must
    // still retain draftImages so cancel/edit can restore the attachments.
    const session = bridge.getSession("s1");
    expect(session?.pendingCodexInputs[0]).toMatchObject({
      deliveryContent: expect.stringContaining(`Attachment 1: ${expectedPath}`),
      imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
    });
    expect(session?.pendingCodexInputs[0]?.draftImages).toEqual([
      {
        name: "attachment-1.png",
        base64: "large-base64-data",
        mediaType: "image/png",
      },
    ]);
    expect(session?.pendingCodexInputs[0]?.localImagePaths).toEqual([expectedPath]);
  });

  it("restores image attachments when a pending Codex image input is cancelled", async () => {
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getOriginalPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.orig.png"),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.getOrCreateSession("s1", "codex");

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "restore this image",
        images: [{ media_type: "image/png", data: "restore-image-data" }],
      }),
    );
    await flush();

    const session = bridge.getSession("s1")!;
    const pendingId = session.pendingCodexInputs[0]?.id;
    expect(pendingId).toBeTruthy();
    expect(session.pendingCodexInputs[0]?.cancelable).toBe(true);
    expect(session.pendingCodexInputs[0]?.draftImages).toEqual([
      {
        name: "attachment-1.png",
        base64: "restore-image-data",
        mediaType: "image/png",
      },
    ]);
    expect(session.pendingCodexTurns).toHaveLength(1);

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: pendingId,
      }),
    );
    await flush();

    expect(session.pendingCodexInputs).toHaveLength(0);
    expect(session.pendingCodexTurns).toHaveLength(0);
    expect(session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "restore this image")).toBe(false);
  });

  it("advances delivery to the next pending input when the current head is cancelled", async () => {
    // The q-326 fix has two halves: canceling a newer pending item must not
    // dispatch an older item, but canceling the current head should still let
    // the next pending input advance through the queue.
    const adapter = makeCodexAdapterMock();
    let startPendingAttempts = 0;
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      if (msg.type === "codex_start_pending") {
        startPendingAttempts += 1;
        return startPendingAttempts > 1;
      }
      return true;
    });
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-q326-cancel-head-advance" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "first pending item",
      }),
    );
    await Promise.resolve();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "second pending item",
      }),
    );
    await Promise.resolve();

    const session = bridge.getSession("s1")!;
    expect(session.pendingCodexInputs).toHaveLength(2);
    const firstPendingId = session.pendingCodexInputs[0]?.id;
    expect(firstPendingId).toBeTruthy();
    if (!firstPendingId) throw new Error("missing first pending id");

    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: firstPendingId,
      }),
    );
    await Promise.resolve();

    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.content).toBe("second pending item");
    expect(startPendingAttempts).toBe(2);
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: [expect.objectContaining({ content: "second pending item" })],
      }),
    );
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "dispatched",
      userContent: "second pending item",
    });
  });

  it("does not dispatch an older pending image when cancelling a newer herd-event pending input", async () => {
    // q-326 incident guard: a later pending herd event should be cancelable
    // without that cancel action silently delivering an older stuck image turn.
    const adapter = makeCodexAdapterMock();
    let startPendingAttempts = 0;
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      if (msg.type === "codex_start_pending") {
        startPendingAttempts += 1;
        return false;
      }
      return true;
    });
    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getOriginalPath: vi.fn().mockResolvedValue("/tmp/companion-images/img-1.orig.png"),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-q326-cancel-mixup" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Please inspect this screenshot",
        images: [{ media_type: "image/png", data: "raw-image-data" }],
      }),
    );
    await flush();

    const herdContent = "1 event from 1 session\n\n#472 | turn_end | ✓ 6m 41s";
    bridge.injectUserMessage("s1", herdContent, {
      sessionId: "herd-events",
      sessionLabel: "Herd Events",
    });
    await flush();

    const session = bridge.getSession("s1")!;
    expect(session.pendingCodexInputs).toHaveLength(2);
    const imagePendingId = session.pendingCodexInputs[0]?.id;
    const herdPendingId = session.pendingCodexInputs[1]?.id;
    expect(imagePendingId).toBeTruthy();
    expect(herdPendingId).toBeTruthy();
    if (!imagePendingId || !herdPendingId) throw new Error("missing pending ids");

    adapter.sendBrowserMessage.mockClear();

    await bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "cancel_pending_codex_input",
        id: herdPendingId,
      }),
    );
    await flush();

    expect(startPendingAttempts).toBe(1);
    expect(session.pendingCodexInputs).toHaveLength(1);
    expect(session.pendingCodexInputs[0]?.id).toBe(imagePendingId);
    expect(session.pendingCodexInputs[0]?.content).toBe("Please inspect this screenshot");
    expect(session.pendingCodexTurns).toHaveLength(1);
    expect(getPendingCodexTurn(session)).toMatchObject({
      status: "queued",
      userContent: expect.stringContaining("Please inspect this screenshot"),
    });
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: "codex_start_pending",
        inputs: [expect.objectContaining({ content: expect.stringContaining("Please inspect this screenshot") })],
      }),
    );
    expect(
      session.messageHistory.some((msg: any) => msg.type === "user_message" && msg.content === "Please inspect this screenshot"),
    ).toBe(false);
  });

  it("sends error when original path lookup fails for Codex images", async () => {
    const adapter = makeCodexAdapterMock();

    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
      getOriginalPath: vi.fn().mockResolvedValue(null),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-fallback" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "what is this?",
        images: [{ media_type: "image/png", data: "small-data" }],
      }),
    );
    await flush();

    // When original path lookup fails, an error should be sent to the browser
    // and no turn should be dispatched to the adapter.
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    expect(browser.send).toHaveBeenCalledWith(expect.stringContaining("Image failed to send"));
  });

  it("sends all Codex image attachments as ordered path annotations without native image transport", async () => {
    const adapter = makeCodexAdapterMock();

    const mockImageStore = {
      store: vi
        .fn()
        .mockResolvedValueOnce({ imageId: "img-1", media_type: "image/png" })
        .mockResolvedValueOnce({ imageId: "img-2", media_type: "image/png" }),
      getOriginalPath: vi
        .fn()
        .mockResolvedValueOnce("/tmp/companion-images/img-1.orig.png")
        .mockResolvedValueOnce("/tmp/companion-images/img-2.orig.png"),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachCodexAdapter("s1", adapter as any);
    emitCodexSessionReady(adapter, { cliSessionId: "thread-image-multi" });

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "compare these images",
        images: [
          { media_type: "image/png", data: "image-one-data" },
          { media_type: "image/png", data: "image-two-data" },
        ],
      }),
    );
    await flush();

    const firstMultiImageCall = adapter.sendBrowserMessage.mock.calls[0];
    expect(firstMultiImageCall).toBeDefined();
    const sentMsg = (firstMultiImageCall as unknown as [any])[0] as any;
    const expectedPath1 = "/tmp/companion-images/img-1.orig.png";
    const expectedPath2 = "/tmp/companion-images/img-2.orig.png";
    expect(sentMsg.type).toBe("codex_start_pending");
    expect(sentMsg.inputs[0]?.content).toContain(`Attachment 1: ${expectedPath1}`);
    expect(sentMsg.inputs[0]?.content).toContain(`Attachment 2: ${expectedPath2}`);
    expect(sentMsg.inputs[0]?.local_images).toEqual([expectedPath1, expectedPath2]);
    expect(sentMsg.images).toBeUndefined();
  });

  it("emits an error and does not send Codex image turn when imageStore is not set", async () => {
    const adapter = makeCodexAdapterMock();
    // No imageStore set on bridge
    bridge.attachCodexAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "no store",
        images: [{ media_type: "image/png", data: "raw-data" }],
      }),
    );
    await flush();

    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    const browserCalls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(browserCalls).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Image failed to send"),
      }),
    );
  });
});

describe("Claude SDK image transport", () => {
  const flush = () => new Promise((r) => setTimeout(r, 20));

  it("strips images and appends SDK Read-tool annotation to Claude SDK user message text", async () => {
    const adapter = makeClaudeSdkAdapterMock();

    const mockImageStore = {
      store: vi.fn().mockResolvedValue({ imageId: "img-1", media_type: "image/png" }),
    };
    bridge.setImageStore(mockImageStore as any);
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "describe this image",
        images: [{ media_type: "image/png", data: "large-base64-data" }],
      }),
    );
    await flush();

    expect(adapter.sendBrowserMessage).toHaveBeenCalled();
    const sentMsg = adapter.sendBrowserMessage.mock.calls[0]![0] as any;
    const expectedPath = join(homedir(), ".companion", "images", "s1", "img-1.orig.png");
    // SDK sessions use the Read-tool annotation instead of embedding images
    expect(sentMsg.content).toContain(`Attachment 1: ${expectedPath}`);
    expect(sentMsg.content).toContain("use the Read tool to view these files");
    // Images should be stripped — the CLI doesn't support image content blocks via stdin
    expect(sentMsg.images).toBeUndefined();
  });
});

describe("Claude SDK adapter queue handoff", () => {
  it("avoids double-buffering pre-init SDK messages and hands them off on reattach", async () => {
    // Regression: a message could be queued in both the SDK adapter's internal
    // pendingOutgoing buffer and the bridge's session.pendingMessages buffer.
    // Reattaching a replacement adapter could then flush the same message twice.
    const sid = "sdk-queue-reattach";
    const pendingOutgoing: any[] = [];
    const adapter1 = makeClaudeSdkAdapterMock();
    adapter1.isConnected.mockReturnValue(false);
    adapter1.sendBrowserMessage.mockImplementation((msg: any) => {
      pendingOutgoing.push(msg);
      return false;
    });
    adapter1.drainPendingOutgoing.mockImplementation(() => pendingOutgoing.splice(0));
    bridge.attachClaudeSdkAdapter(sid, adapter1 as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "hello from sdk queue",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const session = bridge.getSession(sid)!;
    expect(pendingOutgoing).toHaveLength(1);
    expect(session.pendingMessages).toHaveLength(0);

    const delivered: any[] = [];
    const adapter2 = makeClaudeSdkAdapterMock();
    adapter2.sendBrowserMessage.mockImplementation((msg: any) => {
      delivered.push(msg);
      return true;
    });
    bridge.attachClaudeSdkAdapter(sid, adapter2 as any);

    expect(adapter1.drainPendingOutgoing).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      type: "user_message",
    });
    expect(delivered[0].content).toMatch(
      /^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] hello from sdk queue$/,
    );
    expect(session.pendingMessages).toHaveLength(0);
  });

  it("tags user_message with [User HH:MM] when sent through SDK adapter path", () => {
    // Verifies the adapter path (not just handleUserMessage) applies timestamp tags
    const bridge = new WsBridge();
    const sid = "sdk-ts-1";
    bridge.getOrCreateSession(sid);
    const session = bridge.getSession(sid)!;
    session.backendType = "claude-sdk";

    const delivered: any[] = [];
    const adapter = makeClaudeSdkAdapterMock();
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      delivered.push(msg);
      return true;
    });
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleBrowserMessage(browser, JSON.stringify({ type: "user_message", content: "hello sdk" }));

    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toMatch(/^\[User (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] hello sdk$/);
  });

  it("tags user_message with [Leader HH:MM] in herded SDK session", () => {
    // Verifies herded workers get [Leader] tag through the adapter path
    const bridge = new WsBridge();
    const sid = "sdk-ts-herded";
    bridge.getOrCreateSession(sid);
    const session = bridge.getSession(sid)!;
    session.backendType = "claude-sdk";

    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ herdedBy: "leader-1" })),
    } as any);

    const delivered: any[] = [];
    const adapter = makeClaudeSdkAdapterMock();
    adapter.sendBrowserMessage.mockImplementation((msg: any) => {
      delivered.push(msg);
      return true;
    });
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "do the task",
        agentSource: { sessionId: "leader-1", sessionLabel: "Leader" },
      }),
    );

    expect(delivered).toHaveLength(1);
    expect(delivered[0].content).toMatch(/^\[Leader (?:\w{3}, \w{3} \d{1,2} )?\d{1,2}:\d{2}\s*[AP]M\] do the task$/);
  });
});
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
    await new Promise((r) => setTimeout(r, 50)); // flush async permission pipeline (settings rule check reads from disk)

    // Verify herd event was emitted with correct data
    expect(spy).toHaveBeenCalledWith(
      "s1",
      "permission_request",
      expect.objectContaining({
        tool_name: "Bash",
        request_id: "perm-1",
        summary: "rm -rf node_modules",
      }),
    );

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
    await new Promise((r) => setTimeout(r, 50)); // flush async permission pipeline (settings rule check reads from disk)

    expect(spy).toHaveBeenCalledWith(
      "s1",
      "permission_request",
      expect.objectContaining({
        tool_name: "Write",
        request_id: "perm-2",
        summary: "Write",
      }),
    );

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
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "test",
      }),
    );
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
      touchUserMessage: vi.fn(),
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
      touchUserMessage: vi.fn(),
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

  it("sends backend_connected optimistically for SDK session in 'starting' state", () => {
    // When an SDK relaunch is in progress (state="starting"), the adapter
    // attaches synchronously during spawnClaudeSdk — send backend_connected
    // optimistically so the browser doesn't flash a disconnect banner.
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "claude-sdk", state: "starting" })),
    } as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    expect(relaunchCb).not.toHaveBeenCalled();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_connected" }));
  });

  it("sends backend_disconnected and triggers relaunch for SDK session in 'connected' state without adapter", () => {
    // When the SDK adapter has disconnected at runtime, the launcher state
    // stays "connected" but the adapter is null — the backend is genuinely
    // dead. The browser must be told it's disconnected and relaunch triggered.
    const sid = "s1";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ backendType: "claude-sdk", state: "connected" })),
    } as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    expect(relaunchCb).toHaveBeenCalledWith(sid);
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "backend_disconnected" }));
  });

  it("stops auto-relaunch after max failures without reverting backend type", () => {
    // Regression: after removing the SDK crash-loop fallback, exceeding
    // MAX_ADAPTER_RELAUNCH_FAILURES (3) consecutive adapter disconnects should
    // stop auto-relaunching and broadcast an error, but the session's
    // backendType must stay "claude-sdk" (not silently revert to "claude").
    const sid = "s-sdk-no-revert";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();
    relaunchCb.mockClear();

    // Simulate 4 consecutive adapter attach+disconnect cycles (1 more than the cap of 3).
    // Each cycle: attach a fresh SDK adapter, then immediately disconnect it.
    for (let i = 0; i < 4; i++) {
      const adapter = makeClaudeSdkAdapterMock();
      bridge.attachClaudeSdkAdapter(sid, adapter as any);
      adapter.emitDisconnect();
    }

    // Only the first 3 disconnects should have triggered auto-relaunch;
    // the 4th exceeds MAX_ADAPTER_RELAUNCH_FAILURES and is suppressed.
    expect(relaunchCb).toHaveBeenCalledTimes(3);

    // The error message should be broadcast to browsers.
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Session stopped after 3 consecutive launch failures"),
      }),
    );

    // Critical: backendType must remain "claude-sdk" — no silent fallback to "claude".
    const session = bridge.getSession(sid)!;
    expect(session.backendType).toBe("claude-sdk");
    expect(session.state.backend_type).toBe("claude-sdk");
  });

  it("queues /compact and requests relaunch when browser sends /compact user_message", () => {
    // /compact interception moved from the SDK adapter to routeBrowserMessage
    // (before timestamp tagging). Sending a user_message with content "/compact"
    // should queue it as a pending message, broadcast "compacting" status, and
    // trigger a relaunch — without the message reaching the adapter.
    const sid = "s-compact";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ cliSessionId: "cli-sess-123" })),
    } as any);

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    // Send /compact as a browser user message
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "/compact",
      }),
    );

    // Should have triggered relaunch
    expect(relaunchCb).toHaveBeenCalledWith(sid);

    // Should have broadcast "compacting" status to browsers
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "compacting" }));

    // Should have recorded the /compact in message history
    const session = bridge.getSession(sid)!;
    const userMsg = session.messageHistory.find((m) => m.type === "user_message" && (m as any).content === "/compact");
    expect(userMsg).toBeTruthy();

    // Should have queued /compact in browser format for the SDK adapter flush
    expect(session.pendingMessages.length).toBe(1);
    const queued = JSON.parse(session.pendingMessages[0]);
    expect(queued).toEqual({ type: "user_message", content: "/compact" });
  });

  it("queues /compact in NDJSON format for WebSocket sessions", () => {
    // WebSocket (plain Claude) sessions flush pendingMessages through
    // sendToCLI() which expects NDJSON format (type: "user").
    const sid = "s-compact-ws";
    const relaunchCb = vi.fn();
    bridge.onCLIRelaunchNeededCallback(relaunchCb);
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ cliSessionId: "cli-sess-456" })),
    } as any);

    // Create session with default backendType (claude = WebSocket)
    const session = bridge.getOrCreateSession(sid);
    expect(session.backendType).toBe("claude");

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "/compact",
      }),
    );

    expect(relaunchCb).toHaveBeenCalledWith(sid);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "compacting" }));

    // WebSocket sessions queue NDJSON format for sendToCLI flush
    expect(session.pendingMessages.length).toBe(1);
    const queued = JSON.parse(session.pendingMessages[0]);
    expect(queued).toEqual({
      type: "user",
      message: { role: "user", content: "/compact" },
      parent_tool_use_id: null,
      session_id: "cli-sess-456",
    });
  });
});

describe("CLI slash command interception", () => {
  // CLI-native slash commands (e.g. /context, /cost, /status) must be forwarded
  // to the CLI without timestamp tagging. The timestamp prefix (e.g.
  // "[User 7:41 PM] /context") breaks the CLI's internal slash command parser.

  let bridge: WsBridge;

  beforeEach(() => {
    bridge = new WsBridge();
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ cliSessionId: "cli-sess-slash" })),
    } as any);
  });

  it("forwards /context to SDK adapter without timestamp tagging", () => {
    const sid = "s-slash-sdk";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    // Populate slash_commands so the bridge recognizes /context
    const session = bridge.getSession(sid)!;
    session.state.slash_commands = ["context", "cost", "status"];

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();
    adapter.sendBrowserMessage.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "/context",
      }),
    );

    // Should have forwarded to the SDK adapter with clean content (no timestamp tag)
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "/context" }),
    );

    // Should have recorded the command in message history
    const userMsg = session.messageHistory.find((m) => m.type === "user_message" && (m as any).content === "/context");
    expect(userMsg).toBeTruthy();

    // Should have broadcast "running" status
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls).toContainEqual(expect.objectContaining({ type: "status_change", status: "running" }));
  });

  it("forwards /cost to WebSocket session via sendToCLI", () => {
    const sid = "s-slash-ws";
    const session = bridge.getOrCreateSession(sid);
    session.state.slash_commands = ["context", "cost", "status"];

    // Connect a mock CLI socket so sendToCLI works
    const cliSocket = makeCliSocket(sid);
    bridge.handleCLIOpen(cliSocket, sid);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();
    cliSocket.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "/cost",
      }),
    );

    // Should have sent NDJSON to the CLI socket without timestamp tags
    expect(cliSocket.send).toHaveBeenCalled();
    const sentNdjson = JSON.parse(cliSocket.send.mock.calls[0][0]);
    expect(sentNdjson.type).toBe("user");
    expect(sentNdjson.message.content).toBe("/cost");

    // Should have recorded the command in message history
    const userMsg = session.messageHistory.find((m) => m.type === "user_message" && (m as any).content === "/cost");
    expect(userMsg).toBeTruthy();
  });

  it("does NOT intercept unrecognized slash commands", () => {
    const sid = "s-slash-unknown";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const session = bridge.getSession(sid)!;
    session.state.slash_commands = ["context", "cost"];

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    adapter.sendBrowserMessage.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "/nonexistent-command",
      }),
    );

    // The adapter should still receive the message (through normal path with timestamp)
    // but it should NOT have been intercepted by the slash command handler.
    // If it went through the normal path, the content will have a timestamp tag.
    const adapterCalls = adapter.sendBrowserMessage.mock.calls;
    if (adapterCalls.length > 0) {
      const content = (adapterCalls[0][0] as any).content;
      // Normal path adds timestamp tag prefix like "[User HH:MM PM]"
      expect(content).not.toBe("/nonexistent-command");
    }
  });

  it("does NOT intercept slash commands when slash_commands is empty", () => {
    const sid = "s-slash-empty";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    // Leave slash_commands empty (as before first user message)
    const session = bridge.getSession(sid)!;
    expect(session.state.slash_commands).toEqual([]);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    adapter.sendBrowserMessage.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "/context",
      }),
    );

    // Should NOT have been intercepted -- goes through normal path
    const adapterCalls = adapter.sendBrowserMessage.mock.calls;
    if (adapterCalls.length > 0) {
      const content = (adapterCalls[0][0] as any).content;
      expect(content).not.toBe("/context");
    }
  });

  it("trims whitespace when matching slash commands", () => {
    const sid = "s-slash-trim";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const session = bridge.getSession(sid)!;
    session.state.slash_commands = ["context"];

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    adapter.sendBrowserMessage.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "  /context  ",
      }),
    );

    // Should have been intercepted and forwarded with trimmed content
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "/context" }),
    );
  });

  it("queues to pendingMessages when SDK adapter rejects the message", () => {
    const sid = "s-slash-queue";
    const adapter = makeClaudeSdkAdapterMock();
    adapter.sendBrowserMessage.mockReturnValue(false);
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const session = bridge.getSession(sid)!;
    session.state.slash_commands = ["context"];

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "/context",
      }),
    );

    // Should have queued the message for later flush
    expect(session.pendingMessages.length).toBe(1);
    const queued = JSON.parse(session.pendingMessages[0]);
    expect(queued).toEqual({ type: "user_message", content: "/context" });
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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "compacting",
      }),
    );

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
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "status",
        status: "compacting",
      }),
    );

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

  it("ignores replayed compact_boundary on Claude WebSocket sessions during cliResuming", () => {
    vi.useFakeTimers();

    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIOpen(cli, "s1");
    expect(session.cliResuming).toBe(true);

    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(session.cliResuming).toBe(true);
    browser.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 80000 },
        uuid: "replayed-boundary-uuid",
        session_id: "s1",
      }),
    );

    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(0);
    expect(session.awaitingCompactSummary).toBeFalsy();
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((m: any) => m.type === "compact_boundary")).toBeUndefined();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not capture replayed compact summaries on Claude WebSocket sessions during cliResuming", () => {
    vi.useFakeTimers();

    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);
    session.cliResuming = true;
    session.awaitingCompactSummary = true;

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIOpen(cli, "s1");
    browser.send.mockClear();

    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "replayed summary text" },
        parent_tool_use_id: null,
        uuid: "replayed-summary",
        session_id: "s1",
      }),
    );

    expect(session.awaitingCompactSummary).toBe(true);
    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.find((m: any) => m.type === "compact_summary")).toBeUndefined();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("replayed Claude WebSocket compaction during resume is ignored, then the first real compaction after debounce produces one live sequence", () => {
    // q-317: the WebSocket path now mirrors the SDK replay guard. Replayed
    // compaction noise during cliResuming must be ignored, then once the
    // debounce clears, the first real compact_boundary + summary should produce
    // exactly one live marker and exactly one leader recovery injection.
    vi.useFakeTimers();

    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);

    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIOpen(cli, "s1");
    expect(session.cliResuming).toBe(true);

    const injectSpy = vi.spyOn(bridge, "injectUserMessage");

    // Phase 1: replay noise during resume must be ignored.
    bridge.handleCLIMessage(cli, makeInitMsg());
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: "compacting" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 80000 },
        uuid: "old-compact-uuid",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Old compaction summary" },
        parent_tool_use_id: null,
        uuid: "old-summary-msg",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: null }));

    expect(session.messageHistory.filter((m) => m.type === "compact_marker")).toHaveLength(0);
    expect(
      injectSpy.mock.calls.filter(([, , source]) => source?.sessionId === "system" && source?.sessionLabel === "System"),
    ).toHaveLength(0);

    // Phase 2: resume debounce clears stale compaction state.
    vi.advanceTimersByTime(2100);
    expect(session.cliResuming).toBe(false);
    expect(session.awaitingCompactSummary).toBe(false);
    expect(session.state.is_compacting).toBe(false);

    browser.send.mockClear();

    // Phase 3: first real compaction after replay should surface exactly once.
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: "compacting" }));
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 60000 },
        uuid: "new-compact-uuid",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "New compaction summary" },
        parent_tool_use_id: null,
        uuid: "new-summary-msg",
        session_id: "s1",
      }),
    );
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: null }));

    const markers = session.messageHistory.filter((m) => m.type === "compact_marker");
    expect(markers).toHaveLength(1);
    expect((markers[0] as any).summary).toBe("New compaction summary");
    expect((markers[0] as any).cliUuid).toBe("new-compact-uuid");

    const recoveryCalls = injectSpy.mock.calls.filter(
      ([, , source]) => source?.sessionId === "system" && source?.sessionLabel === "System",
    );
    expect(recoveryCalls).toHaveLength(1);

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    expect(calls.filter((m: any) => m.type === "compact_boundary")).toHaveLength(1);
    expect(calls.filter((m: any) => m.type === "compact_summary")).toHaveLength(1);

    injectSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

describe("prepareSessionForRevert", () => {
  it("prunes toolResults that are no longer reachable after revert truncation", () => {
    // Revert should drop lazy-fetch tool results for previews that were
    // truncated out of history so retained payload metrics don't stay inflated.
    const bridge = new WsBridge();
    const cli = makeCliSocket("revert-prunes-tool-results");
    bridge.handleCLIOpen(cli, "revert-prunes-tool-results");

    const session = bridge.getSession("revert-prunes-tool-results");
    expect(session).toBeDefined();
    if (!session) return;

    session.messageHistory = [
      {
        type: "tool_result_preview",
        previews: [
          {
            tool_use_id: "tool-keep",
            content: "keep",
            is_error: false,
            total_size: 4,
            is_truncated: false,
          },
        ],
      } as any,
      {
        type: "tool_result_preview",
        previews: [
          {
            tool_use_id: "tool-drop",
            content: "drop",
            is_error: false,
            total_size: 4,
            is_truncated: false,
          },
        ],
      } as any,
    ];
    session.toolResults.set("tool-keep", { content: "keep", is_error: false, timestamp: 1 });
    session.toolResults.set("tool-drop", { content: "drop", is_error: false, timestamp: 2 });

    bridge.prepareSessionForRevert("revert-prunes-tool-results", 1);

    expect(session.toolResults.has("tool-keep")).toBe(true);
    expect(session.toolResults.has("tool-drop")).toBe(false);
  });

  it("prunes stale toolResults even when reachable preview count matches map size", () => {
    // Equal cardinality is not equal membership: rollback/resume can leave a
    // stale tool ID in the map while history references a different preview ID.
    const bridge = new WsBridge();
    const cli = makeCliSocket("revert-prunes-equal-cardinality");
    bridge.handleCLIOpen(cli, "revert-prunes-equal-cardinality");

    const session = bridge.getSession("revert-prunes-equal-cardinality");
    expect(session).toBeDefined();
    if (!session) return;

    session.messageHistory = [
      {
        type: "tool_result_preview",
        previews: [
          {
            tool_use_id: "tool-keep",
            content: "keep",
            is_error: false,
            total_size: 4,
            is_truncated: false,
          },
        ],
      } as any,
      {
        type: "tool_result_preview",
        previews: [
          {
            tool_use_id: "tool-replacement",
            content: "replacement",
            is_error: false,
            total_size: 11,
            is_truncated: false,
          },
        ],
      } as any,
    ];
    session.toolResults.set("tool-keep", { content: "keep", is_error: false, timestamp: 1 });
    session.toolResults.set("tool-stale", { content: "stale", is_error: false, timestamp: 2 });

    bridge.prepareSessionForRevert("revert-prunes-equal-cardinality", 2);

    expect(session.toolResults.has("tool-keep")).toBe(true);
    expect(session.toolResults.has("tool-stale")).toBe(false);
    expect(session.toolResults.has("tool-replacement")).toBe(false);
  });
});

// ─── cliResuming guards status_change broadcast (q-213) ───────────────────

describe("cliResuming suppresses status_change broadcast during --resume replay", () => {
  // During --resume, the CLI replays historical system.status messages (with
  // status "compacting" | null per CLISystemStatusMessage). Without the
  // cliResuming guard, these get broadcast to browsers as live status_change
  // events, polluting the eventBuffer and overriding state_snapshot.

  it("does not broadcast status_change for replayed system.status during cliResuming", () => {
    vi.useFakeTimers();

    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIOpen(cli, "s1");
    expect(session.cliResuming).toBe(true);

    // Replayed system.init (triggers cliResuming debounce)
    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(session.cliResuming).toBe(true);

    browser.send.mockClear();

    // Replayed system.status with null (idle/completed turn) — should NOT be broadcast.
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: null }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const statusChanges = calls.filter((m: any) => m.type === "status_change");
    expect(statusChanges).toHaveLength(0);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("broadcasts status_change after cliResuming clears", () => {
    vi.useFakeTimers();

    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);

    const cli = makeCliSocket("s1");
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    bridge.handleCLIOpen(cli, "s1");

    bridge.handleCLIMessage(cli, makeInitMsg());
    expect(session.cliResuming).toBe(true);

    // Wait for debounce to clear cliResuming.
    vi.advanceTimersByTime(2100);
    expect(session.cliResuming).toBe(false);

    browser.send.mockClear();

    // Real system.status with compacting — should be broadcast.
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: "compacting" }));

    const calls = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const statusChanges = calls.filter((m: any) => m.type === "status_change");
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0].status).toBe("compacting");

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not buffer stale status_change in eventBuffer during cliResuming", () => {
    vi.useFakeTimers();

    const session = bridge.getOrCreateSession("s1");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);

    const cli = makeCliSocket("s1");
    bridge.handleCLIOpen(cli, "s1");
    expect(session.cliResuming).toBe(true);

    bridge.handleCLIMessage(cli, makeInitMsg());

    const bufferLenBefore = session.eventBuffer.length;

    // Replayed system.status with null — should NOT enter eventBuffer.
    bridge.handleCLIMessage(cli, JSON.stringify({ type: "system", subtype: "status", status: null }));

    // eventBuffer should not have grown (no status_change was buffered).
    const statusBuffered = session.eventBuffer
      .slice(bufferLenBefore)
      .filter((evt: any) => evt.message?.type === "status_change");
    expect(statusBuffered).toHaveLength(0);

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

  it("detects stuck session even when keep_alive pings are recent", () => {
    // Regression test for q-237: keep_alive pings indicate the CLI process
    // is alive (network liveness) but should NOT be treated as real activity.
    // A session with stale lastCliMessageAt but recent lastCliPingAt is stuck.
    vi.useFakeTimers();
    const sid = "s-stuck-keepalive";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago, no real CLI output since
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    // But keep_alive pings are recent (CLI process is alive)
    session.lastCliPingAt = Date.now() - 10_000;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should be flagged as stuck despite recent keep_alive pings
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(1);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("detects stuck session when toolStartTimes entries are stale (older than 5 min)", () => {
    // Regression test for q-237 follow-up: stale toolStartTimes entries from
    // missed tool_results were permanently suppressing stuck detection. Tools
    // older than AUTO_RECOVER_MS (5 min) should be treated as stale and not
    // prevent stuck detection from firing.
    vi.useFakeTimers();
    const sid = "s-stuck-stale-tools";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 6 minutes ago, no CLI activity since
    const sixMinAgo = Date.now() - 360_000;
    session.isGenerating = true;
    session.generationStartedAt = sixMinAgo;
    session.lastCliMessageAt = sixMinAgo;
    session.lastCliPingAt = sixMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    // Stale tool entry from 6 minutes ago (missed tool_result)
    session.toolStartTimes.set("tool-stale-123", sixMinAgo);

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should auto-recover despite toolStartTimes being non-empty
    expect(session.isGenerating).toBe(false);
    // Stale tools should be cleared during auto-recovery
    expect(session.toolStartTimes.size).toBe(0);

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

  it("does not flag a session as stuck when async sub-agents have recent tool_progress", () => {
    // When the main agent spawns async sub-agents, it goes quiet while waiting
    // for them to complete. Sub-agent tool_progress updates (Agent/Task tool)
    // should prevent false "stuck" warnings even though lastCliMessageAt is stale.
    vi.useFakeTimers();
    const sid = "s-stuck-subagent";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago, no direct CLI message since
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.stuckNotifiedAt = null;

    // But a tool sent tool_progress 30 seconds ago
    session.lastToolProgressAt = Date.now() - 30_000;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should NOT be flagged as stuck — sub-agent is actively running
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(0);
    expect(session.stuckNotifiedAt).toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not flag a session as stuck when tools are actively running (block=true Bash)", () => {
    // When a CLI is executing a blocking command (e.g. `sleep 600` with block=true),
    // there are no tool_progress events or CLI messages. The session has an active
    // tool in toolStartTimes, which proves the CLI is alive and waiting for the tool.
    vi.useFakeTimers();
    const sid = "s-stuck-blocking-tool";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 5 minutes ago, no CLI activity since
    const fiveMinAgo = Date.now() - 300_000;
    session.isGenerating = true;
    session.generationStartedAt = fiveMinAgo;
    session.lastCliMessageAt = fiveMinAgo;
    session.lastCliPingAt = fiveMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    // But a tool is actively running (started recently, not stale)
    session.toolStartTimes.set("tool-bash-123", Date.now() - 60_000);

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should NOT be flagged as stuck — a tool is actively running
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    expect(stuckMessages).toHaveLength(0);
    expect(session.stuckNotifiedAt).toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("clears stuck flag when a tool starts running on a previously-stuck session", () => {
    // If a session was flagged as stuck and then a tool starts (toolStartTimes
    // becomes non-empty), the next watchdog tick should send session_unstuck.
    vi.useFakeTimers();
    const sid = "s-stuck-then-tool";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Use 3 minutes (below the 5-min auto-recovery threshold) so the session
    // gets flagged as stuck without being auto-recovered on the first tick.
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    // First tick: no tools running, should fire session_stuck
    vi.advanceTimersByTime(31_000);
    expect(session.stuckNotifiedAt).not.toBeNull();

    // Now a tool starts running
    session.toolStartTimes.set("tool-bash-456", Date.now());
    browser.send.mockClear();

    // Second tick: should fire session_unstuck because tool is active
    vi.advanceTimersByTime(30_000);
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const unstuckMessages = sentMessages.filter((m: any) => m.type === "session_unstuck");
    expect(unstuckMessages).toHaveLength(1);
    expect(session.stuckNotifiedAt).toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("auto-recovers a stuck session after 5 minutes by clearing isGenerating", () => {
    // When a session has been stuck for 5+ minutes with the CLI still connected
    // (e.g., missed result message), the watchdog should force-clear isGenerating
    // to recover the session. This is the last-resort safety net, especially for
    // herded workers which skip the optimistic 30s running timer.
    vi.useFakeTimers();
    const sid = "s-stuck-auto-recover";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 6 minutes ago, no CLI activity since
    const sixMinAgo = Date.now() - 360_000;
    session.isGenerating = true;
    session.generationStartedAt = sixMinAgo;
    session.lastCliMessageAt = sixMinAgo;
    session.lastCliPingAt = sixMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();
    browser.send.mockClear();

    vi.advanceTimersByTime(31_000);

    // Should have auto-recovered: isGenerating cleared
    expect(session.isGenerating).toBe(false);
    expect(session.generationStartedAt).toBeNull();

    // Should have received both session_stuck (first detection) and status_change idle + session_unstuck (recovery)
    const sentMessages = browser.send.mock.calls.map((c: any) => JSON.parse(c[0]));
    const stuckMessages = sentMessages.filter((m: any) => m.type === "session_stuck");
    const idleMessages = sentMessages.filter((m: any) => m.type === "status_change" && m.status === "idle");
    const unstuckMessages = sentMessages.filter((m: any) => m.type === "session_unstuck");
    expect(stuckMessages).toHaveLength(1);
    expect(idleMessages.length).toBeGreaterThanOrEqual(1);
    expect(unstuckMessages).toHaveLength(1);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not auto-recover a stuck session before 5 minutes", () => {
    // Sessions stuck for less than 5 minutes should only get the notification,
    // not auto-recovery. The CLI may genuinely be processing a long turn.
    vi.useFakeTimers();
    const sid = "s-stuck-no-recover";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago (below 5-min threshold)
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should have flagged as stuck but NOT auto-recovered
    expect(session.stuckNotifiedAt).not.toBeNull();
    expect(session.isGenerating).toBe(true); // still generating
    expect(session.generationStartedAt).not.toBeNull();

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("auto-recovers a stuck session even when CLI is disconnected after 5 minutes (q-307)", () => {
    // Before q-307, auto-recovery required CLI to be connected. Now, if the
    // session has been stuck for 5+ minutes AND the CLI is disconnected (relaunch
    // may have failed), the watchdog clears isGenerating as a safety net.
    vi.useFakeTimers();
    const sid = "s-stuck-cli-disconnected";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Generation started 6 minutes ago, no CLI activity since
    const sixMinAgo = Date.now() - 360_000;
    session.isGenerating = true;
    session.generationStartedAt = sixMinAgo;
    session.lastCliMessageAt = sixMinAgo;
    session.lastCliPingAt = sixMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    // Simulate CLI disconnect (backendSocket cleared)
    session.backendSocket = null;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should auto-recover even with CLI disconnected (q-307)
    expect(session.isGenerating).toBe(false);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("auto-recovers orchestrator sessions faster than regular sessions (q-307)", () => {
    // Orchestrator (leader) sessions gate herd event delivery via isSessionIdle(),
    // so a stuck leader blocks all workers. The watchdog recovers orchestrators at
    // 2 min (STUCK_GENERATION_THRESHOLD_MS) instead of the regular 5 min.
    vi.useFakeTimers();
    const sid = "s-stuck-orchestrator";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    // Set up launcher with isOrchestrator=true
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ isOrchestrator: true })),
    } as any);

    const session = bridge.getSession(sid)!;

    // Generation started 3 minutes ago — past the 2-min orchestrator threshold
    // but below the 5-min regular threshold
    const threeMinAgo = Date.now() - 180_000;
    session.isGenerating = true;
    session.generationStartedAt = threeMinAgo;
    session.lastCliMessageAt = threeMinAgo;
    session.lastCliPingAt = threeMinAgo;
    session.lastToolProgressAt = 0;
    session.stuckNotifiedAt = null;

    bridge.startStuckSessionWatchdog();

    vi.advanceTimersByTime(31_000);

    // Should auto-recover because orchestrators use the faster 2-min threshold
    expect(session.isGenerating).toBe(false);

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

// ─── Seamless reconnect with stuck generation (q-307) ─────────────────────

describe("Seamless reconnect with stuck generation (q-307)", () => {
  it("clears isGenerating on seamless reconnect when generation is older than stuck threshold", () => {
    // When the CLI does a 5-minute token refresh (seamless reconnect) and the
    // generation has been running for 2+ minutes, it's provably stuck -- the CLI
    // had a full refresh cycle to produce output and didn't.
    vi.useFakeTimers();
    const sid = "s-seamless-stuck";
    const cli1 = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli1, sid);
    bridge.handleCLIMessage(cli1, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Start generation 3 minutes ago (above the 2-min stuck threshold)
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 180_000;

    // Simulate CLI disconnect (token refresh)
    bridge.handleCLIClose(cli1, 1000);

    // CLI reconnects within the grace period (seamless)
    const cli2 = makeCliSocket(sid);
    bridge.handleCLIOpen(cli2, sid);
    expect(session.seamlessReconnect).toBe(true);

    // system.init arrives — should force-clear isGenerating because generation is old
    bridge.handleCLIMessage(cli2, makeInitMsg());
    expect(session.isGenerating).toBe(false);
    expect(session.seamlessReconnect).toBe(false); // consumed

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("preserves isGenerating on seamless reconnect when generation is fresh", () => {
    // Short-lived generations (under 2 min) should still be preserved across
    // seamless reconnects — the CLI is genuinely still processing.
    vi.useFakeTimers();
    const sid = "s-seamless-fresh";
    const cli1 = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli1, sid);
    bridge.handleCLIMessage(cli1, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Start generation 30 seconds ago (well below the 2-min threshold)
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 30_000;

    // Simulate seamless reconnect
    bridge.handleCLIClose(cli1, 1000);
    const cli2 = makeCliSocket(sid);
    bridge.handleCLIOpen(cli2, sid);
    expect(session.seamlessReconnect).toBe(true);

    // system.init arrives — should preserve isGenerating (generation is fresh)
    bridge.handleCLIMessage(cli2, makeInitMsg());
    expect(session.isGenerating).toBe(true);

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

describe("Claude SDK task_notification forwarding", () => {
  it("persists task_notification from SDK adapter to messageHistory and broadcasts to browser", () => {
    // Validates that sub-agent completion notifications from Claude SDK sessions
    // are persisted (surviving reconnects) and forwarded to browsers, enabling
    // the floating agent chip UI to show sub-agent completion state.
    const sid = "sdk-task-notif";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    browser.send.mockClear();

    adapter.emitBrowserMessage({
      type: "task_notification",
      task_id: "task-123",
      tool_use_id: "tooluse-abc",
      status: "completed",
      summary: "Found 3 auth patterns",
    });

    // Should be broadcast to browser
    const sent = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const notif = sent.find((m: any) => m.type === "task_notification");
    expect(notif).toBeDefined();
    expect(notif.tool_use_id).toBe("tooluse-abc");
    expect(notif.status).toBe("completed");
    expect(notif.summary).toBe("Found 3 auth patterns");

    // Should be persisted in messageHistory
    const session = bridge.getSession(sid)!;
    const histNotif = session.messageHistory.find((m: any) => m.type === "task_notification");
    expect(histNotif).toBeDefined();
    expect((histNotif as any).tool_use_id).toBe("tooluse-abc");
  });
});

// ─── SDK generation lifecycle on result ──────────────────────────────────────

describe("Claude SDK generation lifecycle on result", () => {
  it("clears isGenerating via handleResultMessage and broadcasts idle status", () => {
    // Validates that SDK result messages clear isGenerating through the unified
    // handleResultMessage path (not a duplicate early setGenerating call) and
    // broadcast status:idle even though the SDK CLI doesn't send system.status.
    const sid = "sdk-gen-result";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    // Set up generation state (simulating a turn in progress)
    const session = bridge.getSession(sid)!;
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 5000;
    session.cliInitReceived = true;

    browser.send.mockClear();

    // SDK adapter emits a result message (raw CLI format, no .data wrapper)
    adapter.emitBrowserMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done with sub-agents",
      duration_ms: 5000,
      duration_api_ms: 4800,
      num_turns: 1,
      total_cost_usd: 0.05,
      stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "sdk-result-1",
      session_id: sid,
    });

    // isGenerating should be cleared
    expect(session.isGenerating).toBe(false);

    // Browser should receive status:idle
    const sent = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const statusMsgs = sent.filter((m: any) => m.type === "status_change");
    expect(statusMsgs.some((m: any) => m.status === "idle")).toBe(true);

    // Browser should also receive the result message (wrapped with .data)
    const resultMsgs = sent.filter((m: any) => m.type === "result");
    expect(resultMsgs).toHaveLength(1);
    expect(resultMsgs[0].data.uuid).toBe("sdk-result-1");
  });

  it("drains queued turns for SDK sessions since CLI processes messages inline", async () => {
    // SDK sessions send user messages immediately to the CLI regardless of
    // queue state. The CLI processes them inline as part of the current turn.
    // When the result arrives, any "queued" turns are phantom — the CLI
    // already handled them. The queue must be drained before
    // reconcileTerminalResultState to prevent promoteNextQueuedTurn from
    // starting a phantom turn that never gets a result (leaving isGenerating
    // stuck at true forever).
    const sid = "sdk-gen-queued";
    const cli = makeCliSocket(sid);
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg());

    const session = bridge.getSession(sid)!;

    // Switch to SDK backend for this session
    session.backendType = "claude-sdk";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    // Simulate: first turn is running
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 10000;
    session.userMessageIdsThisTurn = [0];

    // Queue a second turn (user sent another message while generating)
    session.queuedTurnStarts = 1;
    session.queuedTurnReasons = ["user_message"];
    session.queuedTurnUserMessageIds = [[1]];
    session.queuedTurnInterruptSources = [null];

    // Result arrives for the first turn
    adapter.emitBrowserMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "First turn done",
      duration_ms: 10000,
      duration_api_ms: 9000,
      num_turns: 1,
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: "sdk-result-queued",
      session_id: sid,
    });

    // Queue should be fully drained
    expect(session.queuedTurnStarts).toBe(0);
    // isGenerating should be FALSE — no phantom promoted turn
    expect(session.isGenerating).toBe(false);
  });

  it("computes context_used_percent from result.usage when assistant usage is all zeros", () => {
    // SDK sessions have all-zero usage on assistant messages but real per-turn
    // usage on result messages. The context % computation must fall through
    // from the zero assistant usage to the result's usage.
    const sid = "sdk-ctx-pct";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    session.isGenerating = true;
    session.generationStartedAt = Date.now() - 5000;
    session.cliInitReceived = true;
    session.state.model = "claude-opus-4-6[1m]";

    // Add a top-level assistant message with zero usage (mimics SDK behavior)
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "test" }],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    } as any);

    browser.send.mockClear();

    // Result with per-turn usage showing 300k/1M context (30%)
    adapter.emitBrowserMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done",
      duration_ms: 5000,
      duration_api_ms: 4800,
      num_turns: 1,
      total_cost_usd: 0.05,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 200000,
        output_tokens: 500,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100000,
      },
      modelUsage: {
        "claude-opus-4-6[1m]": {
          inputTokens: 200000,
          outputTokens: 500,
          cacheReadInputTokens: 100000,
          cacheCreationInputTokens: 0,
          contextWindow: 1000000,
        },
      },
      uuid: "sdk-ctx-result",
      session_id: sid,
    });

    // context_used_percent should be ~20% (200k / 1M)
    // input_tokens already includes cached tokens (OpenAI/Copilot semantics),
    // so cache_read_input_tokens is a subset, not additive.
    expect(session.state.context_used_percent).toBe(20);

    // Verify the session_update broadcast includes the context %
    const sent = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const update = sent.find((m: any) => m.type === "session_update" && m.session?.context_used_percent != null);
    expect(update).toBeDefined();
    expect(update.session.context_used_percent).toBe(20);
  });
});

// ─── SDK session_init permissionMode preservation (q-316) ─────────────────────

describe("SDK session_init preserves server permissionMode (q-316)", () => {
  it("preserves bypassPermissions when CLI session_init reports a different mode", () => {
    // Bug: the SDK adapter's canUseTool callback causes the CLI to report
    // permissionMode: "default" in session_init, overwriting the server's
    // "bypassPermissions" set at session creation. This caused Bash commands
    // to fall through to human approval instead of being auto-approved.
    const sid = "sdk-bypass-preserved";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const session = bridge.getSession(sid)!;
    // Simulate server-side mode set at session creation
    session.state.permissionMode = "bypassPermissions";

    // SDK adapter emits session_init with CLI's own mode (may differ)
    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        session_id: `cli-${sid}`,
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/different-cwd",
        tools: [],
        permissionMode: "default", // CLI reports "default" because canUseTool is provided
      },
    });

    // Server's permissionMode should be preserved, not overwritten
    expect(session.state.permissionMode).toBe("bypassPermissions");
  });

  it("auto-approves Bash after session_init when server mode is bypassPermissions", () => {
    // End-to-end: session created with bypassPermissions → CLI session_init
    // overwrites mode → Bash request should still be auto-approved.
    const sid = "sdk-bypass-e2e";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const session = bridge.getSession(sid)!;
    session.state.permissionMode = "bypassPermissions";

    // CLI sends session_init with different mode
    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        session_id: `cli-${sid}`,
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/test",
        tools: [],
        permissionMode: "default",
      },
    });

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);
    session.cliInitReceived = true;
    browser.send.mockClear();

    // SDK adapter emits a permission_request for Bash cp
    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-cp",
        tool_name: "Bash",
        input: { command: "cp file1.txt file2.txt" },
        tool_use_id: "tool-cp",
        timestamp: Date.now(),
      },
    } as any);

    // Should be auto-approved (not forwarded to browser as permission_request)
    const sent = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permReqs = sent.filter((m: any) => m.type === "permission_request");
    expect(permReqs).toHaveLength(0);

    const approvals = sent.filter((m: any) => m.type === "permission_approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].tool_name).toBe("Bash");
  });

  it("does not preserve permissionMode when server has no mode set (fresh session)", () => {
    // If the server has no permissionMode set (undefined), the CLI's reported
    // mode from session_init should be accepted as-is.
    const sid = "sdk-no-mode";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const session = bridge.getSession(sid)!;
    // No permissionMode set on server (simulate fresh session before init)
    (session.state as any).permissionMode = undefined;

    adapter.emitBrowserMessage({
      type: "session_init",
      session: {
        session_id: `cli-${sid}`,
        model: "claude-sonnet-4-5-20250929",
        cwd: "/tmp/test",
        tools: [],
        permissionMode: "plan",
      },
    });

    // CLI's mode should be accepted
    expect(session.state.permissionMode).toBe("plan");
  });
});

// ─── SDK interactive tool permission routing ─────────────────────────────────

describe("Claude SDK interactive tool permissions", () => {
  it("broadcasts ExitPlanMode permission_request to browser instead of auto-approving", () => {
    // Validates that interactive tools (ExitPlanMode, AskUserQuestion) from SDK
    // sessions are routed to the browser for user interaction, not auto-approved
    // by the permission pipeline. This requires the canUseTool callback to be
    // provided even in bypassPermissions mode.
    const sid = "sdk-plan-perm";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    session.cliInitReceived = true;
    session.state.permissionMode = "bypassPermissions";
    browser.send.mockClear();

    // SDK adapter emits a permission_request for ExitPlanMode
    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-exit-plan",
        tool_name: "ExitPlanMode",
        input: { allowedPrompts: [] },
        tool_use_id: "tool-exit-plan",
        timestamp: Date.now(),
      },
    } as any);

    // The permission should be broadcast to the browser (not auto-approved)
    const sent = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permReqs = sent.filter((m: any) => m.type === "permission_request");
    expect(permReqs).toHaveLength(1);
    expect(permReqs[0].request.tool_name).toBe("ExitPlanMode");
    expect(permReqs[0].request.request_id).toBe("perm-exit-plan");

    // It should be in pendingPermissions
    expect(session.pendingPermissions.has("perm-exit-plan")).toBe(true);
  });

  it("broadcasts AskUserQuestion permission_request to browser instead of auto-approving", () => {
    // Same as above but for AskUserQuestion — both are in NEVER_AUTO_APPROVE.
    const sid = "sdk-ask-perm";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    session.cliInitReceived = true;
    session.state.permissionMode = "bypassPermissions";
    browser.send.mockClear();

    // SDK adapter emits a permission_request for AskUserQuestion
    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-ask-user",
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Which approach?" }] },
        tool_use_id: "tool-ask-user",
        timestamp: Date.now(),
      },
    } as any);

    const sent = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permReqs = sent.filter((m: any) => m.type === "permission_request");
    expect(permReqs).toHaveLength(1);
    expect(permReqs[0].request.tool_name).toBe("AskUserQuestion");

    expect(session.pendingPermissions.has("perm-ask-user")).toBe(true);
  });

  it("auto-approves Bash in bypassPermissions mode via SDK permission pipeline", () => {
    // Verifies that non-interactive tools are still auto-approved in
    // bypassPermissions mode through the SDK permission pipeline.
    const sid = "sdk-bash-bypass";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    session.cliInitReceived = true;
    session.state.permissionMode = "bypassPermissions";
    browser.send.mockClear();

    // SDK adapter emits a permission_request for Bash
    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-bash",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "tool-bash",
        timestamp: Date.now(),
      },
    } as any);

    // Bash should be auto-approved (NOT broadcast as permission_request to browser)
    const sent = browser.send.mock.calls.map(([arg]: [string]) => JSON.parse(arg));
    const permReqs = sent.filter((m: any) => m.type === "permission_request");
    expect(permReqs).toHaveLength(0);

    // Should be auto-approved (recorded as permission_approved)
    const approvals = sent.filter((m: any) => m.type === "permission_approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].tool_name).toBe("Bash");

    // Not in pendingPermissions (already resolved)
    expect(session.pendingPermissions.has("perm-bash")).toBe(false);
  });

  it("routes SDK permission_response to adapter for ExitPlanMode approval", () => {
    // End-to-end: ExitPlanMode request → browser shows UI → user approves →
    // response routed back to SDK adapter.
    const sid = "sdk-plan-approve";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    session.cliInitReceived = true;
    session.state.permissionMode = "plan";
    browser.send.mockClear();

    // Step 1: SDK emits ExitPlanMode permission request
    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-exit-plan-2",
        tool_name: "ExitPlanMode",
        input: { allowedPrompts: [] },
        tool_use_id: "tool-exit-plan-2",
        timestamp: Date.now(),
      },
    } as any);

    expect(session.pendingPermissions.has("perm-exit-plan-2")).toBe(true);

    // Step 2: Browser sends approval
    adapter.sendBrowserMessage.mockClear();
    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "permission_response",
        request_id: "perm-exit-plan-2",
        behavior: "allow",
        updated_input: { allowedPrompts: [] },
      }),
    );

    // Step 3: Verify response was forwarded to SDK adapter
    // Note: the response may be sent twice (once by the SDK-specific handler
    // in routeBrowserMessage, once by the generic adapter dispatch fallthrough).
    // The adapter's dispatchOutgoing handles dedup — the second call is a no-op.
    const adapterCalls = adapter.sendBrowserMessage.mock.calls;
    const permResponses = adapterCalls
      .map((args: any[]) => args[0])
      .filter((m: any) => m.type === "permission_response");
    expect(permResponses.length).toBeGreaterThanOrEqual(1);
    expect(permResponses[0].request_id).toBe("perm-exit-plan-2");
    expect(permResponses[0].behavior).toBe("allow");

    // Pending should be cleared
    expect(session.pendingPermissions.has("perm-exit-plan-2")).toBe(false);
  });

  it("routes SDK ExitPlanMode denial with leader attribution into turn_end", () => {
    const sid = "sdk-plan-deny-leader";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    const session = bridge.getSession(sid)!;
    session.cliInitReceived = true;
    session.state.permissionMode = "plan";
    browser.send.mockClear();

    bridge.handleBrowserMessage(
      browser,
      JSON.stringify({
        type: "user_message",
        content: "Draft the implementation plan",
      }),
    );

    adapter.emitBrowserMessage({
      type: "permission_request",
      request: {
        request_id: "perm-exit-plan-sdk-deny",
        tool_name: "ExitPlanMode",
        input: { allowedPrompts: [] },
        tool_use_id: "tool-exit-plan-sdk-deny",
        timestamp: Date.now(),
      },
    } as any);

    const spy = vi.spyOn(bridge, "emitTakodeEvent");
    adapter.sendBrowserMessage.mockClear();

    // External permission responses carry the actor session ID. The SDK
    // denial path must preserve that actor when it synthesizes the interrupt.
    bridge.routeExternalPermissionResponse(
      session,
      {
        type: "permission_response",
        request_id: "perm-exit-plan-sdk-deny",
        behavior: "deny",
        message: "Keep refining",
      },
      "leader-7",
    );

    const interruptCalls = adapter.sendBrowserMessage.mock.calls
      .map((args: any[]) => args[0])
      .filter((message: any) => message.type === "interrupt");
    expect(interruptCalls).toContainEqual(expect.objectContaining({ interruptSource: "leader" }));

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        result: "",
        is_error: false,
        stop_reason: "end_turn",
        total_cost_usd: 0.01,
        num_turns: 1,
        session_id: sid,
      },
    });

    const turnEndCalls = spy.mock.calls.filter(([eventSid, eventType]) => eventSid === sid && eventType === "turn_end");
    expect(turnEndCalls.length).toBeGreaterThan(0);
    expect(turnEndCalls[turnEndCalls.length - 1]?.[2]).toEqual(
      expect.objectContaining({ interrupted: true, interrupt_source: "leader" }),
    );

    spy.mockRestore();
  });
});

describe("Cross-session branch invalidation", () => {
  // Tests for the branch-to-sessions reverse index and cross-session
  // diff stats invalidation when a branch tip moves.

  function setupGitMocks(overrides: Record<string, string> = {}) {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return overrides.branch || "feature-x\n";
      if (cmd.includes("rev-parse HEAD")) return overrides.headSha || "sha-111\n";
      if (cmd.includes("--git-dir")) return overrides.gitDir || "/repo/.git/worktrees/wt\n";
      if (cmd.includes("--git-common-dir")) return overrides.commonDir || "/repo/.git\n";
      if (cmd.includes("--show-toplevel")) return overrides.toplevel || "/repo\n";
      if (cmd.includes("--left-right --count")) return overrides.leftRight || "0\t0\n";
      if (cmd.includes("merge-base")) return overrides.mergeBase || "sha-000\n";
      if (cmd.includes("diff --numstat")) return overrides.diffNumstat || "";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return overrides.branchList || "  main\n";
      if (cmd.includes("@{upstream}")) throw new Error("no upstream");
      return "";
    });
  }

  it("updateBranchIndex tracks session branch references correctly", () => {
    // Create two sessions referencing the same diff_base_branch
    setupGitMocks();
    bridge.markWorktree("s1", "/repo", "/tmp/wt1", "jiayi");
    bridge.markWorktree("s2", "/repo", "/tmp/wt2", "jiayi");

    const s1 = bridge.getSession("s1")!;
    const s2 = bridge.getSession("s2")!;
    s1.state.git_branch = "wt-1";
    s1.state.diff_base_branch = "jiayi";
    s2.state.git_branch = "wt-2";
    s2.state.diff_base_branch = "jiayi";

    // Trigger index update via setDiffBaseBranch (which calls updateBranchIndex)
    bridge.setDiffBaseBranch("s1", "jiayi");
    bridge.setDiffBaseBranch("s2", "jiayi");

    // Access the internal index via the bridge's internal state
    // The index should have "jiayi" pointing to both sessions
    // We verify this indirectly by checking that closing one session
    // doesn't break the other's index entry
    bridge.closeSession("s1");
    // s2 should still be tracked — verify by setting a new base
    expect(bridge.setDiffBaseBranch("s2", "origin/main")).toBe(true);
  });

  it("HEAD SHA change triggers cross-session invalidation", async () => {
    // Session A: working on branch "jiayi" (worktree base for session B)
    // Session B: worktree with diff_base_branch = "jiayi"
    // When session A's HEAD moves, session B should get its diff stats refreshed.

    let headSha = "sha-old";
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("rev-parse HEAD")) return `${headSha}\n`;
      if (cmd.includes("--git-dir")) return "/repo/.git\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "2\t1\n";
      if (cmd.includes("merge-base")) return "sha-old\n";
      if (cmd.includes("diff --numstat")) return "5\t3\tfile.ts\n";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      if (cmd.includes("@{upstream}")) throw new Error("no upstream");
      return "";
    });

    // Set up session A (on branch "jiayi") with CLI socket
    bridge.markWorktree("sA", "/repo", "/tmp/wtA", "main");
    const sA = bridge.getSession("sA")!;
    (sA as any).backendSocket = { send: vi.fn() };
    sA.state.git_branch = "jiayi";
    sA.state.git_head_sha = "sha-old";

    // Set up session B (worktree, base = "jiayi") with CLI socket
    bridge.markWorktree("sB", "/repo", "/tmp/wtB", "jiayi");
    const sB = bridge.getSession("sB")!;
    (sB as any).backendSocket = { send: vi.fn() };
    sB.state.git_branch = "jiayi-wt-123";
    sB.state.diff_base_branch = "jiayi";
    sB.state.git_head_sha = "sha-wt-b";

    // Index both sessions by calling setDiffBaseBranch
    bridge.setDiffBaseBranch("sA", "main");
    bridge.setDiffBaseBranch("sB", "jiayi");

    // Wait for initial async work to settle
    await vi.waitFor(() => {
      expect(sA.state.diff_base_branch).toBe("main");
      expect(sB.state.diff_base_branch).toBe("jiayi");
    });

    const browserB = makeBrowserSocket("sB");
    bridge.handleBrowserOpen(browserB, "sB");
    browserB.send.mockClear();

    // Now simulate session A's HEAD moving (e.g., a new commit on "jiayi")
    headSha = "sha-new";
    sA.state.git_head_sha = "sha-old"; // Still old before refresh

    // Trigger refreshGitInfoPublic on session A — this will detect HEAD change
    // and cross-invalidate session B
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    // Wait for cross-session invalidation to propagate to session B
    await vi.waitFor(() => {
      // Session B should have been refreshed (diffStatsDirty was set and recompute triggered)
      const calls = (browserB.send as ReturnType<typeof vi.fn>).mock.calls;
      const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      // Should have received a session_update with refreshed git info
      const gitUpdates = messages.filter(
        (m: any) =>
          m.type === "session_update" && m.session && ("git_branch" in m.session || "total_lines_added" in m.session),
      );
      expect(gitUpdates.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("archived sessions are excluded from cross-session invalidation", async () => {
    // Set up a launcher mock where session B is archived
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn((id: string) => {
        if (id === "sB") return { archived: true };
        return { archived: false };
      }),
    } as any);

    setupGitMocks({ headSha: "sha-old" });

    bridge.markWorktree("sA", "/repo", "/tmp/wtA", "main");
    const sA = bridge.getSession("sA")!;
    (sA as any).backendSocket = { send: vi.fn() };
    sA.state.git_branch = "jiayi";
    sA.state.git_head_sha = "sha-old";

    bridge.markWorktree("sB", "/repo", "/tmp/wtB", "jiayi");
    const sB = bridge.getSession("sB")!;
    (sB as any).backendSocket = { send: vi.fn() };
    sB.state.git_branch = "jiayi-wt-123";
    sB.state.diff_base_branch = "jiayi";
    sB.state.git_head_sha = "sha-wt-b";

    // Index sessions — session B should be excluded since it's archived
    bridge.setDiffBaseBranch("sA", "main");
    bridge.setDiffBaseBranch("sB", "jiayi");

    const browserB = makeBrowserSocket("sB");
    bridge.handleBrowserOpen(browserB, "sB");

    // Wait for all async work from setDiffBaseBranch to settle, then clear
    await new Promise((r) => setTimeout(r, 200));
    browserB.send.mockClear();

    // Simulate HEAD change on session A
    setupGitMocks({ headSha: "sha-new" });
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    // Give a moment for any async propagation
    await new Promise((r) => setTimeout(r, 200));

    // Session B (archived) should NOT have received any cross-session updates
    const calls = (browserB.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    // Should have no git info updates from cross-session invalidation
    const crossSessionUpdates = messages.filter(
      (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
    );
    expect(crossSessionUpdates.length).toBe(0);
  });

  it("per-session throttle prevents rapid cascading", async () => {
    setupGitMocks();

    bridge.markWorktree("sA", "/repo", "/tmp/wtA", "main");
    const sA = bridge.getSession("sA")!;
    (sA as any).backendSocket = { send: vi.fn() };
    sA.state.git_branch = "jiayi";
    sA.state.git_head_sha = "sha-1";

    bridge.markWorktree("sB", "/repo", "/tmp/wtB", "jiayi");
    const sB = bridge.getSession("sB")!;
    (sB as any).backendSocket = { send: vi.fn() };
    sB.state.git_branch = "jiayi-wt-123";
    sB.state.diff_base_branch = "jiayi";

    // Index sessions
    bridge.setDiffBaseBranch("sA", "main");
    bridge.setDiffBaseBranch("sB", "jiayi");

    const browserB = makeBrowserSocket("sB");
    bridge.handleBrowserOpen(browserB, "sB");

    // First refresh: HEAD changes sha-1 → sha-2
    let sha = "sha-2";
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse HEAD")) return `${sha}\n`;
      if (cmd.includes("--abbrev-ref HEAD")) return "jiayi\n";
      if (cmd.includes("--git-dir")) return "/repo/.git\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "sha-1\n";
      if (cmd.includes("diff --numstat")) return "";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      if (cmd.includes("@{upstream}")) throw new Error("no upstream");
      return "";
    });

    sA.state.git_head_sha = "sha-1";
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    // Wait for first cross-invalidation to propagate
    await vi.waitFor(() => {
      expect(sA.state.git_head_sha).toBe("sha-2");
    });

    // Wait for all async propagation from first invalidation to settle
    await new Promise((r) => setTimeout(r, 200));
    browserB.send.mockClear();

    // Immediately trigger another HEAD change (sha-2 → sha-3)
    // This should be throttled for session B (within 30s window)
    sha = "sha-3";
    sA.state.git_head_sha = "sha-2"; // reset to trigger change detection
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    // Give async ops time to settle
    await new Promise((r) => setTimeout(r, 200));

    // Session B should NOT have received updates from the second invalidation
    // (throttled within the 30s window)
    const calls = (browserB.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const gitInfoUpdates = messages.filter(
      (m: any) => m.type === "session_update" && m.session && "git_branch" in m.session,
    );
    expect(gitInfoUpdates.length).toBe(0);
  });

  it("closeSession removes session from branch index", () => {
    setupGitMocks();
    bridge.markWorktree("s1", "/repo", "/tmp/wt1", "jiayi");
    const s1 = bridge.getSession("s1")!;
    s1.state.git_branch = "wt-1";
    s1.state.diff_base_branch = "jiayi";
    bridge.setDiffBaseBranch("s1", "jiayi");

    // Session should exist
    expect(bridge.getSession("s1")).toBeDefined();

    // Close session
    bridge.closeSession("s1");

    // Session should be gone
    expect(bridge.getSession("s1")).toBeUndefined();

    // Creating a new session with the same branch reference should work fine
    // (no stale index entries pointing to deleted session)
    bridge.markWorktree("s2", "/repo", "/tmp/wt2", "jiayi");
    expect(bridge.setDiffBaseBranch("s2", "jiayi")).toBe(true);
  });

  it("onSessionArchived removes session from branch index", () => {
    setupGitMocks();
    bridge.markWorktree("s1", "/repo", "/tmp/wt1", "jiayi");
    const s1 = bridge.getSession("s1")!;
    s1.state.git_branch = "wt-1";
    s1.state.diff_base_branch = "jiayi";
    bridge.setDiffBaseBranch("s1", "jiayi");

    // Archive the session
    bridge.onSessionArchived("s1");

    // Session still exists in the bridge (archived just removes from branch index)
    expect(bridge.getSession("s1")).toBeDefined();

    // Unarchiving should re-add to the index
    bridge.onSessionUnarchived("s1");
    expect(bridge.setDiffBaseBranch("s1", "origin/main")).toBe(true);
  });

  it("does not invalidate sessions depending on unrelated branches", async () => {
    // Session A on "feature-x", session B with diff_base_branch = "feature-z" (unrelated)
    // Changing A's HEAD should NOT trigger a refresh on B.

    let headSha = "sha-old";
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("--abbrev-ref HEAD")) return "feature-x\n";
      if (cmd.includes("rev-parse HEAD")) return `${headSha}\n`;
      if (cmd.includes("--git-dir")) return "/repo/.git\n";
      if (cmd.includes("--git-common-dir")) return "/repo/.git\n";
      if (cmd.includes("--show-toplevel")) return "/repo\n";
      if (cmd.includes("--left-right --count")) return "0\t0\n";
      if (cmd.includes("merge-base")) return "sha-000\n";
      if (cmd.includes("diff --numstat")) return "";
      if (cmd.includes("for-each-ref")) return "";
      if (cmd.includes("symbolic-ref")) return "";
      if (cmd.includes("branch --list")) return "  main\n";
      if (cmd.includes("@{upstream}")) throw new Error("no upstream");
      return "";
    });

    bridge.markWorktree("sA", "/repo", "/tmp/wtA", "main");
    const sA = bridge.getSession("sA")!;
    (sA as any).backendSocket = { send: vi.fn() };
    sA.state.git_branch = "feature-x";
    sA.state.git_head_sha = "sha-old";

    bridge.markWorktree("sB", "/repo", "/tmp/wtB", "feature-z");
    const sB = bridge.getSession("sB")!;
    (sB as any).backendSocket = { send: vi.fn() };
    sB.state.git_branch = "feature-y";
    sB.state.diff_base_branch = "feature-z"; // unrelated to sA's git_branch

    // Index both sessions via refreshGitInfoPublic (awaited, so async settles here)
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });
    await bridge.refreshGitInfoPublic("sB", { broadcastUpdate: true, force: true });

    const browserB = makeBrowserSocket("sB");
    bridge.handleBrowserOpen(browserB, "sB");
    browserB.send.mockClear();

    // Trigger HEAD change on session A (branch "feature-x")
    headSha = "sha-new";
    sA.state.git_head_sha = "sha-old";
    await bridge.refreshGitInfoPublic("sA", { broadcastUpdate: true, force: true });

    await new Promise((r) => setTimeout(r, 200));

    // Session B should NOT have received any cross-session updates
    // because its diff_base_branch "feature-z" doesn't match sA's git_branch "feature-x"
    const calls = (browserB.send as ReturnType<typeof vi.fn>).mock.calls;
    const messages = calls.map((c: unknown[]) => JSON.parse(c[0] as string));
    const crossSessionUpdates = messages.filter(
      (m: any) => m.type === "session_update" && m.session?.git_ahead !== undefined,
    );
    expect(crossSessionUpdates.length).toBe(0);
  });
});

// ─── getHerdDiagnostics field name consistency ──────────────────────────────
// Regression: getHerdDiagnostics() returned `backendConnected` but the frontend
// reads `cliConnected`. Since the type is Record<string, unknown>, TypeScript
// didn't catch the mismatch, causing the Herd Diagnostics panel to always show
// "cli disconnected" even when the CLI was active.

describe("getHerdDiagnostics field name consistency", () => {
  it("returns cliConnected (not backendConnected) when SDK adapter is attached", () => {
    const sid = "herd-diag-field";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    const diag = bridge.getHerdDiagnostics(sid);
    expect(diag).not.toBeNull();
    // Must use "cliConnected" — this is what the frontend reads.
    expect(diag!.cliConnected).toBe(true);
    // Must NOT use "backendConnected" — that's the old buggy field name.
    expect("backendConnected" in diag!).toBe(false);
  });

  it("returns cliConnected=false when no backend is attached", () => {
    const sid = "herd-diag-disconnected";
    const browser = makeBrowserSocket(sid);
    bridge.handleBrowserOpen(browser, sid);

    const diag = bridge.getHerdDiagnostics(sid);
    expect(diag).not.toBeNull();
    expect(diag!.cliConnected).toBe(false);
    expect("backendConnected" in diag!).toBe(false);
  });
});

describe("CLI-initiated turn tracking", () => {
  // When the CLI spontaneously starts a turn (e.g. CronCreate wakeup,
  // background task notification), the server must detect it and track
  // the generation lifecycle so turn_end events are emitted. Without
  // this, herded workers that wake up from cron jobs are invisible to
  // the leader -- no turn_end means no herd event delivery.

  it("sets isGenerating when SDK session emits assistant without prior user message", () => {
    // Simulates a CLI-initiated turn (e.g. cron wakeup): the CLI sends
    // an assistant message without any user_message from the browser.
    const sid = "cli-initiated-sdk";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    // Emit system.init so cliInitReceived=true
    adapter.emitBrowserMessage({
      type: "system",
      subtype: "init",
      session_id: "cli-sdk-init",
      model: "opus-4",
      cwd: "/test",
      tools: [],
      permissionMode: "bypassPermissions",
      mcp_servers: [],
    });

    const session = bridge.getSession(sid)!;
    expect(session.isGenerating).toBe(false);

    // CLI spontaneously emits an assistant message (cron wakeup)
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "cron-assistant-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Cron check: investigating..." }],
        model: "opus-4",
      },
      parent_tool_use_id: null,
    });

    // Server should detect this as a CLI-initiated turn
    expect(session.isGenerating).toBe(true);
  });

  it("emits turn_end when CLI-initiated SDK turn completes with result", () => {
    const sid = "cli-initiated-turn-end";
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter(sid, adapter as any);

    adapter.emitBrowserMessage({
      type: "system",
      subtype: "init",
      session_id: "cli-init-te",
      model: "opus-4",
      cwd: "/test",
      tools: [],
      permissionMode: "bypassPermissions",
      mcp_servers: [],
    });

    const eventSpy = vi.spyOn(bridge, "emitTakodeEvent");

    // CLI-initiated turn: assistant then result
    adapter.emitBrowserMessage({
      type: "assistant",
      message: {
        id: "cron-assist-2",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Cron: all checks passed." }],
        model: "opus-4",
      },
      parent_tool_use_id: null,
    });

    adapter.emitBrowserMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Cron check complete",
        duration_ms: 3000,
        duration_api_ms: 3000,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: "cli-init-result-1",
        session_id: sid,
      },
    });

    // turn_end should have been emitted
    const turnEndCalls = eventSpy.mock.calls.filter(
      ([sessionId, eventType]) => sessionId === sid && eventType === "turn_end",
    );
    expect(turnEndCalls).toHaveLength(1);
    // turn_source should be "unknown" since there's no user message in the turn
    expect(turnEndCalls[0]?.[2]).toEqual(
      expect.objectContaining({
        turn_source: "unknown",
      }),
    );

    eventSpy.mockRestore();
  });

  it("does not false-detect CLI-initiated turn for subagent assistant messages", () => {
    // Subagent messages have parent_tool_use_id set. They should NOT
    // trigger a new cli_initiated_turn because they're part of an
    // already-tracked turn.
    const sid = "cli-init-subagent";
    const cli = makeCliSocket(sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg({ session_id: "cli-subagent-1" }));

    const session = bridge.getSession(sid)!;
    expect(session.isGenerating).toBe(false);

    // Subagent assistant message (has parent_tool_use_id)
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "subagent-msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Subagent working..." }],
          model: "opus-4",
        },
        parent_tool_use_id: "tool-123",
      }),
    );

    // Should NOT have triggered a new turn
    expect(session.isGenerating).toBe(false);
  });

  it("does not false-detect CLI-initiated turn during resume replay", () => {
    // During --resume, the CLI replays historical assistant messages.
    // These should NOT trigger cli_initiated_turn detection.
    const sid = "cli-init-resume";
    const cli = makeCliSocket(sid);
    bridge.handleCLIOpen(cli, sid);
    bridge.handleCLIMessage(cli, makeInitMsg({ session_id: "cli-resume-1" }));

    const session = bridge.getSession(sid)!;
    // Simulate: session already has a historical assistant message
    session.messageHistory.push({
      type: "assistant",
      message: {
        id: "historical-msg-1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Previously said" }],
        model: "opus-4",
      },
      parent_tool_use_id: null,
      timestamp: Date.now() - 60000,
    } as any);

    // Replay of the same message (same ID)
    bridge.handleCLIMessage(
      cli,
      JSON.stringify({
        type: "assistant",
        message: {
          id: "historical-msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Previously said" }],
          model: "opus-4",
        },
        parent_tool_use_id: null,
      }),
    );

    // Should NOT have triggered a turn (it's a replay)
    expect(session.isGenerating).toBe(false);
  });
});

// ─── Work Board ────────────────────────────────────────────────────────────

describe("work board", () => {
  it("getBoard returns empty array for unknown session", () => {
    expect(bridge.getBoard("nonexistent")).toEqual([]);
  });

  it("upsertBoardRow adds a row and broadcasts", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const board = bridge.upsertBoardRow("s1", {
      questId: "q-42",
      title: "Fix sidebar",
      status: "implementing",
    });

    expect(board).not.toBeNull();
    expect(board).toHaveLength(1);
    expect(board![0].questId).toBe("q-42");
    expect(board![0].title).toBe("Fix sidebar");
    expect(board![0].status).toBe("implementing");
    expect(board![0].updatedAt).toBeGreaterThan(0);

    // Verify broadcast to browser
    const sent = browser.send.mock.calls.find((call: any[]) => {
      try {
        return JSON.parse(call[0]).type === "board_updated";
      } catch {
        return false;
      }
    });
    expect(sent).toBeTruthy();
    const msg = JSON.parse(sent![0] as string);
    expect(msg.board).toHaveLength(1);
    expect(msg.board[0].questId).toBe("q-42");
  });

  it("upsertBoardRow merges with existing row", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", {
      questId: "q-42",
      title: "Fix sidebar",
      worker: "worker-1",
      workerNum: 5,
      status: "implementing",
    });

    // Update only the status -- other fields should be preserved
    const board = bridge.upsertBoardRow("s1", {
      questId: "q-42",
      status: "waiting for review",
    });

    expect(board).toHaveLength(1);
    expect(board![0].questId).toBe("q-42");
    expect(board![0].title).toBe("Fix sidebar"); // preserved
    expect(board![0].worker).toBe("worker-1"); // preserved
    expect(board![0].workerNum).toBe(5); // preserved
    expect(board![0].status).toBe("waiting for review"); // updated
  });

  it("upsertBoardRow preserves createdAt on update (stable sort key)", () => {
    // createdAt is set once on first insert and must survive subsequent upserts
    // so that board sort order remains stable across updates.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "First" });
    const originalCreatedAt = bridge.getBoard("s1")[0].createdAt;
    expect(originalCreatedAt).toBeGreaterThan(0);

    // Update the row after a brief delay to ensure Date.now() would differ
    const board = bridge.upsertBoardRow("s1", { questId: "q-1", status: "PLANNING" });
    expect(board![0].createdAt).toBe(originalCreatedAt); // preserved
    expect(board![0].updatedAt).toBeGreaterThanOrEqual(originalCreatedAt); // updated
  });

  it("removeBoardRows removes specified rows", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Quest 2" });
    bridge.upsertBoardRow("s1", { questId: "q-3", title: "Quest 3" });

    const board = bridge.removeBoardRows("s1", ["q-1", "q-3"]);

    expect(board).toHaveLength(1);
    expect(board![0].questId).toBe("q-2");
  });

  it("removeBoardRowFromAll removes quest from all sessions", () => {
    const browser1 = makeBrowserSocket("s1");
    const browser2 = makeBrowserSocket("s2");
    bridge.handleBrowserOpen(browser1, "s1");
    bridge.handleBrowserOpen(browser2, "s2");

    bridge.upsertBoardRow("s1", { questId: "q-42", title: "Shared quest" });
    bridge.upsertBoardRow("s2", { questId: "q-42", title: "Shared quest" });
    bridge.upsertBoardRow("s2", { questId: "q-99", title: "Other quest" });

    bridge.removeBoardRowFromAll("q-42");

    expect(bridge.getBoard("s1")).toHaveLength(0);
    const s2Board = bridge.getBoard("s2");
    expect(s2Board).toHaveLength(1);
    expect(s2Board[0].questId).toBe("q-99");
  });

  it("board survives persistence round-trip", async () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", {
      questId: "q-42",
      title: "Fix sidebar",
      worker: "w1",
      workerNum: 5,
      status: "implementing",
    });

    // Wait for debounced write
    await new Promise((r) => setTimeout(r, 200));

    // Restore from disk
    const restored = new WsBridge();
    restored.setStore(store);
    await restored.restoreFromDisk();

    const board = restored.getBoard("s1");
    expect(board).toHaveLength(1);
    expect(board[0].questId).toBe("q-42");
    expect(board[0].title).toBe("Fix sidebar");
    expect(board[0].worker).toBe("w1");
    expect(board[0].workerNum).toBe(5);
    expect(board[0].status).toBe("implementing");
  });

  it("upsertBoardRow returns null for unknown session", () => {
    expect(bridge.upsertBoardRow("nonexistent", { questId: "q-1" })).toBeNull();
  });

  it("removeBoardRows returns null for unknown session", () => {
    expect(bridge.removeBoardRows("nonexistent", ["q-1"])).toBeNull();
  });

  it("getBoard returns rows sorted by createdAt (stable insertion order)", () => {
    // Mock Date.now() to return distinct values so sort is deterministic,
    // independent of runtime speed or timer resolution.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    let clock = 1000;
    const originalNow = Date.now;
    Date.now = () => clock++;

    try {
      bridge.upsertBoardRow("s1", { questId: "q-1", title: "First" });
      bridge.upsertBoardRow("s1", { questId: "q-2", title: "Second" });
      bridge.upsertBoardRow("s1", { questId: "q-3", title: "Third" });

      const board = bridge.getBoard("s1");
      expect(board.map((r) => r.questId)).toEqual(["q-1", "q-2", "q-3"]);
    } finally {
      Date.now = originalNow;
    }
  });

  // ─── waitFor field ────────────────────────────────────────────────────────

  it("upsertBoardRow sets waitFor array on row", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2", "q-3"] });
    const board = bridge.getBoard("s1");
    expect(board[0].waitFor).toEqual(["q-2", "q-3"]);
  });

  it("upsertBoardRow clears waitFor when given empty array", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Set initial waitFor
    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2"] });
    expect(bridge.getBoard("s1")[0].waitFor).toEqual(["q-2"]);

    // Clear with empty array
    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: [] });
    expect(bridge.getBoard("s1")[0].waitFor).toBeUndefined();
  });

  it("upsertBoardRow preserves existing waitFor when field is omitted", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", waitFor: ["q-2"] });
    // Update title without touching waitFor
    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Updated" });
    const row = bridge.getBoard("s1")[0];
    expect(row.title).toBe("Updated");
    expect(row.waitFor).toEqual(["q-2"]);
  });

  // ─── field clearing ──────────────────────────────────────────────────────

  it("upsertBoardRow clears worker when given empty string", () => {
    // Empty string signals "clear this field" -- should remove existing worker
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", worker: "worker-1", workerNum: 5 });
    expect(bridge.getBoard("s1")[0].worker).toBe("worker-1");

    bridge.upsertBoardRow("s1", { questId: "q-1", worker: "" });
    const row = bridge.getBoard("s1")[0];
    expect(row.worker).toBeUndefined();
    expect(row.workerNum).toBeUndefined();
  });

  it("upsertBoardRow preserves worker when field is omitted", () => {
    // Undefined means "not provided" -- should keep existing value
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", worker: "worker-1", workerNum: 5 });
    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Updated" });
    const row = bridge.getBoard("s1")[0];
    expect(row.worker).toBe("worker-1");
    expect(row.workerNum).toBe(5);
  });

  it("upsertBoardRow clears status when given empty string", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "implementing" });
    expect(bridge.getBoard("s1")[0].status).toBe("implementing");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "" });
    expect(bridge.getBoard("s1")[0].status).toBeUndefined();
  });

  it("upsertBoardRow clears title when given empty string", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Fix sidebar" });
    expect(bridge.getBoard("s1")[0].title).toBe("Fix sidebar");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "" });
    expect(bridge.getBoard("s1")[0].title).toBeUndefined();
  });

  // ─── advanceBoardRow ──────────────────────────────────────────────────────

  it("advanceBoardRow advances from QUEUED to PLANNING", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "QUEUED" });
    const result = bridge.advanceBoardRow("s1", "q-1");
    expect(result).not.toBeNull();
    expect(result!.removed).toBe(false);
    expect(result!.previousState).toBe("QUEUED");
    expect(result!.newState).toBe("PLANNING");
    expect(result!.board[0].status).toBe("PLANNING");
  });

  it("advanceBoardRow walks through all Quest Journey stages", () => {
    // Validates the full state machine progression
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "QUEUED" });

    const expectedTransitions = [
      ["QUEUED", "PLANNING"],
      ["PLANNING", "IMPLEMENTING"],
      ["IMPLEMENTING", "SKEPTIC_REVIEWING"],
      ["SKEPTIC_REVIEWING", "GROOM_REVIEWING"],
      ["GROOM_REVIEWING", "PORTING"],
    ];

    for (const [from, to] of expectedTransitions) {
      const result = bridge.advanceBoardRow("s1", "q-1");
      expect(result!.previousState).toBe(from);
      expect(result!.newState).toBe(to);
      expect(result!.removed).toBe(false);
    }

    // Final advance removes from board
    const final = bridge.advanceBoardRow("s1", "q-1");
    expect(final!.removed).toBe(true);
    expect(final!.previousState).toBe("PORTING");
    expect(final!.board).toHaveLength(0);
  });

  it("advanceBoardRow removes row at final stage PORTING", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "PORTING" });
    const result = bridge.advanceBoardRow("s1", "q-1");
    expect(result!.removed).toBe(true);
    expect(result!.newState).toBeUndefined();
    expect(result!.board).toHaveLength(0);
  });

  it("advanceBoardRow sets QUEUED when status is unrecognized", () => {
    // Handles rows with freeform status text from before Quest Journey
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", status: "some-legacy-status" });
    const result = bridge.advanceBoardRow("s1", "q-1");
    expect(result!.newState).toBe("QUEUED");
    expect(result!.previousState).toBe("some-legacy-status");
  });

  it("advanceBoardRow returns null for unknown session", () => {
    expect(bridge.advanceBoardRow("nonexistent", "q-1")).toBeNull();
  });

  it("advanceBoardRow returns null for unknown questId", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    expect(bridge.advanceBoardRow("s1", "q-999")).toBeNull();
  });

  // ─── completed board (history) ───────────────────────────────────────────

  it("removeBoardRows moves items to completedBoard instead of deleting", () => {
    // removeBoardRows should archive items to completedBoard with a completedAt
    // timestamp, not delete them permanently.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Quest 2" });

    bridge.removeBoardRows("s1", ["q-1"]);

    // Active board should only have q-2
    expect(bridge.getBoard("s1")).toHaveLength(1);
    expect(bridge.getBoard("s1")[0].questId).toBe("q-2");

    // Completed board should have q-1 with completedAt timestamp
    const completed = bridge.getCompletedBoard("s1");
    expect(completed).toHaveLength(1);
    expect(completed[0].questId).toBe("q-1");
    expect(completed[0].title).toBe("Quest 1");
    expect(completed[0].completedAt).toBeGreaterThan(0);
  });

  it("advanceBoardRow at final stage moves item to completedBoard", () => {
    // Advancing past PORTING (final stage) should move the row to completed
    // history, not delete it.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Done quest", status: "PORTING" });
    const result = bridge.advanceBoardRow("s1", "q-1");

    expect(result!.removed).toBe(true);
    expect(result!.board).toHaveLength(0);

    const completed = bridge.getCompletedBoard("s1");
    expect(completed).toHaveLength(1);
    expect(completed[0].questId).toBe("q-1");
    expect(completed[0].completedAt).toBeGreaterThan(0);
  });

  it("removeBoardRowFromAll true-deletes from both active and completed boards", () => {
    // Quest deletion/cancellation should purge from everywhere -- no history kept.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Add two quests, move one to completed
    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.upsertBoardRow("s1", { questId: "q-2", title: "Quest 2" });
    bridge.removeBoardRows("s1", ["q-1"]); // q-1 -> completedBoard

    expect(bridge.getCompletedBoard("s1")).toHaveLength(1);
    expect(bridge.getBoard("s1")).toHaveLength(1);

    // removeBoardRowFromAll should delete from completed
    bridge.removeBoardRowFromAll("q-1");
    expect(bridge.getCompletedBoard("s1")).toHaveLength(0);

    // removeBoardRowFromAll should delete from active
    bridge.removeBoardRowFromAll("q-2");
    expect(bridge.getBoard("s1")).toHaveLength(0);
  });

  it("getCompletedBoard returns empty for unknown session", () => {
    expect(bridge.getCompletedBoard("nonexistent")).toEqual([]);
  });

  it("getCompletedBoard returns items sorted newest-first by completedAt", () => {
    // Multiple completed items should be ordered by completedAt descending
    // so the most recently completed item appears first.
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    let clock = 1000;
    const originalNow = Date.now;
    Date.now = () => clock++;

    try {
      bridge.upsertBoardRow("s1", { questId: "q-1", title: "First" });
      bridge.upsertBoardRow("s1", { questId: "q-2", title: "Second" });
      bridge.upsertBoardRow("s1", { questId: "q-3", title: "Third" });

      // Remove in order: q-1, q-2, q-3 (each gets a later completedAt)
      bridge.removeBoardRows("s1", ["q-1"]);
      bridge.removeBoardRows("s1", ["q-2"]);
      bridge.removeBoardRows("s1", ["q-3"]);

      const completed = bridge.getCompletedBoard("s1");
      expect(completed).toHaveLength(3);
      // Newest first: q-3, q-2, q-1
      expect(completed.map((r) => r.questId)).toEqual(["q-3", "q-2", "q-1"]);
    } finally {
      Date.now = originalNow;
    }
  });

  it("board_updated broadcast includes completedBoard", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-1", title: "Quest 1" });
    bridge.removeBoardRows("s1", ["q-1"]);

    // Find the most recent board_updated broadcast
    const boardUpdates = browser.send.mock.calls
      .map((call: any[]) => {
        try {
          return JSON.parse(call[0]);
        } catch {
          return null;
        }
      })
      .filter((msg: any) => msg?.type === "board_updated");
    const lastUpdate = boardUpdates[boardUpdates.length - 1];
    expect(lastUpdate.completedBoard).toHaveLength(1);
    expect(lastUpdate.completedBoard[0].questId).toBe("q-1");
  });

  it("completedBoard survives persistence round-trip", async () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    bridge.upsertBoardRow("s1", { questId: "q-42", title: "Fix sidebar", status: "PORTING" });
    bridge.advanceBoardRow("s1", "q-42"); // moves to completed

    // Wait for debounced write
    await new Promise((r) => setTimeout(r, 200));

    // Restore from disk
    const restored = new WsBridge();
    restored.setStore(store);
    await restored.restoreFromDisk();

    const completed = restored.getCompletedBoard("s1");
    expect(completed).toHaveLength(1);
    expect(completed[0].questId).toBe("q-42");
    expect(completed[0].title).toBe("Fix sidebar");
    expect(completed[0].completedAt).toBeGreaterThan(0);
  });
});

// ─── SDK resume stall (q-220) ──────────────────────────────────────────────

describe("SDK resume stall: cliResuming guards (q-220)", () => {
  // When an SDK session is resumed after server restart, the CLI replays
  // historical messages including stale status_change:"running" events.
  // Without cliResuming guards, these get broadcast to browsers, overriding
  // the correct "idle" state from state_snapshot and leaving the session
  // stuck showing "running" indefinitely.

  /** Set up a mock launcher with cliSessionId (simulates post-restart resume). */
  function setResumedSdkLauncher(sessionId: string) {
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({
        sessionId,
        state: "connected",
        backendType: "claude-sdk",
        cliSessionId: "cli-session-for-resume",
      })),
      setCLISessionId: vi.fn(),
    } as any);
  }

  /** Helper: create a session with existing history (simulates resumed session). */
  function createResumedSdkSession(sessionId: string) {
    const session = bridge.getOrCreateSession(sessionId, "claude-sdk");
    session.messageHistory.push({ role: "assistant", content: "previous turn" } as any);
    setResumedSdkLauncher(sessionId);
    return session;
  }

  it("sets cliResuming=true when attaching SDK adapter to resumed session", () => {
    // A resumed SDK session has existing messageHistory and the launcher has
    // a cliSessionId. The adapter attach must set cliResuming to defer
    // message processing during replay.
    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(true);
  });

  it("does NOT set cliResuming for a fresh SDK session (no history, no cliSessionId)", () => {
    // Brand-new sessions have no replay — cliResuming should stay false.
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(false);
  });

  it("does NOT set cliResuming when adapter is replaced mid-conversation (no cliSessionId)", () => {
    // Adapter replacement during normal operation (e.g., adapter crash + relaunch)
    // should NOT trigger cliResuming, even if messageHistory has entries.
    // Without the cliSessionId check, this would false-positive.
    const session = bridge.getOrCreateSession("s1", "claude-sdk");
    session.messageHistory.push({ role: "assistant", content: "msg" } as any);
    // No launcher set — simulates adapter replacement without server restart
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    expect(session.cliResuming).toBe(false);
  });

  it("suppresses status_change broadcasts during SDK resume replay", () => {
    // Stale status_change:"running" from completed historical turns must not
    // reach browsers — they would override the correct "idle" snapshot.
    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");
    browser.send.mockClear();

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(true);

    // Simulate replayed status_change from a completed turn
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });

    // The browser should NOT receive a status_change broadcast
    const statusChanges = browser.send.mock.calls.filter((call: any[]) => {
      try {
        const msg = JSON.parse(call[0]);
        return msg.type === "status_change";
      } catch {
        return false;
      }
    });
    expect(statusChanges).toHaveLength(0);
  });

  it("still updates is_compacting state during SDK resume replay", () => {
    // Compaction state tracking must still work during replay for correctness
    // — only the browser broadcast is suppressed.
    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(true);

    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.state.is_compacting).toBe(true);
  });

  it("clears cliResuming after 2s debounce and flushes deferred messages", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;
    expect(session.cliResuming).toBe(true);

    // Queue a pending message (e.g., user message sent during reconnect)
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "hello" }));

    // Simulate replayed messages arriving from the SDK stream
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    // cliResuming should still be true before the debounce fires
    expect(session.cliResuming).toBe(true);
    expect(session.pendingMessages).toHaveLength(1);

    // Advance past the 2s debounce
    vi.advanceTimersByTime(2100);

    expect(session.cliResuming).toBe(false);
    // Deferred pending message should have been flushed via adapter.sendBrowserMessage
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "hello" }),
    );
    expect(session.pendingMessages).toHaveLength(0);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("debounce resets on each incoming SDK message", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;

    // First replayed message
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    vi.advanceTimersByTime(1500);
    // Still resuming — debounce not yet elapsed
    expect(session.cliResuming).toBe(true);

    // Second replayed message resets the debounce
    adapter.emitBrowserMessage({ type: "status_change", status: null });
    vi.advanceTimersByTime(1500);
    // Still resuming — only 1.5s since last message
    expect(session.cliResuming).toBe(true);

    // Full 2s after the last message
    vi.advanceTimersByTime(600);
    expect(session.cliResuming).toBe(false);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("defers pendingMessages flush when SDK adapter attaches during resume", () => {
    // When cliResuming is true, pendingMessages should NOT be flushed
    // immediately on adapter attach — they must wait for replay to finish.
    createResumedSdkSession("s1");
    const session = bridge.getSession("s1")!;
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "queued" }));

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    // Message should NOT have been flushed yet
    expect(adapter.sendBrowserMessage).not.toHaveBeenCalled();
    expect(session.pendingMessages).toHaveLength(1);
  });

  it("flushes pendingMessages immediately for fresh SDK sessions (no resume)", () => {
    // Non-resumed sessions should flush immediately, preserving existing behavior.
    const session = bridge.getOrCreateSession("s1", "claude-sdk");
    session.pendingMessages.push(JSON.stringify({ type: "user_message", content: "queued" }));

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    // Message should be flushed immediately
    expect(adapter.sendBrowserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user_message", content: "queued" }),
    );
    expect(session.pendingMessages).toHaveLength(0);
  });

  it("broadcasts status_change after cliResuming clears", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    const session = bridge.getSession("s1")!;

    // Replayed messages during resume — suppressed
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    adapter.emitBrowserMessage({ type: "status_change", status: null });

    // Clear cliResuming via debounce
    vi.advanceTimersByTime(2100);
    expect(session.cliResuming).toBe(false);
    browser.send.mockClear();

    // Now a live status_change should be broadcast normally
    adapter.emitBrowserMessage({ type: "status_change", status: "running" });
    const statusChanges = browser.send.mock.calls.filter((call: any[]) => {
      try {
        const msg = JSON.parse(call[0]);
        return msg.type === "status_change";
      } catch {
        return false;
      }
    });
    expect(statusChanges.length).toBeGreaterThan(0);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("resets is_compacting to false when debounce fires after replay", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    const session = bridge.getSession("s1")!;

    // Replay a compacting status — the flag gets set during replay
    adapter.emitBrowserMessage({ type: "status_change", status: "compacting" });
    expect(session.state.is_compacting).toBe(true);

    // After the debounce fires, stale compaction state must be reset.
    // A replayed "compacting" from a completed historical turn shouldn't
    // leave the session permanently showing a compaction indicator.
    vi.advanceTimersByTime(2100);
    expect(session.cliResuming).toBe(false);
    expect(session.state.is_compacting).toBe(false);

    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("defers herd event flush during resume and fires after debounce", () => {
    vi.useFakeTimers();

    createResumedSdkSession("s1");
    const session = bridge.getSession("s1")!;

    // Set up a mock herd event dispatcher
    const mockDispatcher = { onOrchestratorTurnEnd: vi.fn() } as any;
    bridge.setHerdEventDispatcher(mockDispatcher);

    // Override the launcher to also report isOrchestrator
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({
        sessionId: "s1",
        state: "connected",
        backendType: "claude-sdk",
        cliSessionId: "cli-session-for-resume",
        isOrchestrator: true,
      })),
      setCLISessionId: vi.fn(),
    } as any);

    const adapter = makeClaudeSdkAdapterMock();
    bridge.attachClaudeSdkAdapter("s1", adapter as any);

    // Herd events should NOT have been flushed on attach (deferred)
    expect(mockDispatcher.onOrchestratorTurnEnd).not.toHaveBeenCalled();

    // Trigger the debounce via a replayed message
    adapter.emitBrowserMessage({ type: "status_change", status: null });
    vi.advanceTimersByTime(2100);

    // After debounce clears cliResuming, herd events should be flushed
    expect(session.cliResuming).toBe(false);
    expect(mockDispatcher.onOrchestratorTurnEnd).toHaveBeenCalledWith("s1");

    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

// ─── notifyUser: herded session routing (q-264) ─────────────────────────────

describe("notifyUser herded session routing", () => {
  // When a herded worker calls takode notify, notifications should be routed
  // through the leader instead of directly to the user. Review notifications
  // are silenced (leader tracks via board/herd events), and needs-input
  // notifications are emitted as herd events for the leader to handle.

  it("suppresses attention and Pushover for herded review notifications", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Set up launcher to report this session as herded
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ sessionId: "s1", state: "connected", herdedBy: "leader-1" })),
    } as any);

    // Subscribe to takode events to verify no herd events are emitted for review
    const capturedEvents: any[] = [];
    bridge.subscribeTakodeEvents(new Set(["s1"]), (evt) => capturedEvents.push(evt));

    // Add an assistant message so notifyUser can anchor to it
    const session = (bridge as any).sessions.get("s1");
    session.messageHistory.push({
      type: "assistant",
      message: { id: "asst-1", content: [{ type: "text", text: "Done" }] },
      timestamp: Date.now(),
    });

    const result = bridge.notifyUser("s1", "review", "Quest completed");
    expect(result.ok).toBe(true);

    // Notification should be persisted to inbox
    expect(session.notifications).toHaveLength(1);
    expect(session.notifications[0].category).toBe("review");

    // But attention should NOT be set (no user-facing badge)
    expect(session.attentionReason).toBeNull();

    // Verify notification_update was NOT broadcast (herded sessions don't drive browser UI)
    const notifUpdates = browser.send.mock.calls
      .map((c: any[]) => { try { return JSON.parse(c[0]); } catch { return null; } })
      .filter((m: any) => m?.type === "notification_update");
    expect(notifUpdates).toHaveLength(0);

    // Verify NO session_update with attentionReason was broadcast
    const attentionUpdates = browser.send.mock.calls
      .map((c: any[]) => { try { return JSON.parse(c[0]); } catch { return null; } })
      .filter((m: any) => m?.type === "session_update" && m.session?.attentionReason !== undefined);
    expect(attentionUpdates).toHaveLength(0);

    // Verify NO herd event was emitted (review is silenced entirely, unlike needs-input)
    const herdEvents = capturedEvents.filter((e) => e.event === "notification_needs_input");
    expect(herdEvents).toHaveLength(0);
  });

  it("emits notification_needs_input herd event for herded needs-input notifications", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Set up launcher to report this session as herded
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ sessionId: "s1", state: "connected", herdedBy: "leader-1" })),
    } as any);

    // Subscribe to takode events to capture the emitted event
    const capturedEvents: any[] = [];
    bridge.subscribeTakodeEvents(new Set(["s1"]), (evt) => capturedEvents.push(evt));

    // Add an assistant message
    const session = (bridge as any).sessions.get("s1");
    session.messageHistory.push({
      type: "assistant",
      message: { id: "asst-1", content: [{ type: "text", text: "Need help" }] },
      timestamp: Date.now(),
    });

    const result = bridge.notifyUser("s1", "needs-input", "Need decision on auth");
    expect(result.ok).toBe(true);

    // Should emit notification_needs_input event
    const needsInputEvents = capturedEvents.filter((e) => e.event === "notification_needs_input");
    expect(needsInputEvents).toHaveLength(1);
    expect(needsInputEvents[0].data.summary).toBe("Need decision on auth");

    // Attention should NOT be set for herded session
    expect(session.attentionReason).toBeNull();
  });

  it("notifies user directly for non-herded sessions (no herdedBy)", () => {
    const browser = makeBrowserSocket("s1");
    bridge.handleBrowserOpen(browser, "s1");

    // Non-herded session (no herdedBy)
    bridge.setLauncher({
      touchActivity: vi.fn(),
      touchUserMessage: vi.fn(),
      getSession: vi.fn(() => ({ sessionId: "s1", state: "connected" })),
    } as any);

    const session = (bridge as any).sessions.get("s1");
    session.messageHistory.push({
      type: "assistant",
      message: { id: "asst-1", content: [{ type: "text", text: "Done" }] },
      timestamp: Date.now(),
    });

    bridge.notifyUser("s1", "review", "Task done");

    // Attention SHOULD be set for non-herded sessions
    expect(session.attentionReason).toBe("review");
  });
});
