// @vitest-environment jsdom

import type { SessionState, PermissionRequest, ContentBlock } from "./types.js";
import { computeChatMessagesSyncHash } from "../shared/history-sync-hash.js";

// Mock the names utility before any imports
vi.mock("./utils/names.js", () => ({
  generateUniqueSessionName: vi.fn(() => "Test Session"),
}));

const getDiffStatsMock = vi.fn().mockResolvedValue({ stats: {} });
const listSessionsMock = vi.fn().mockResolvedValue([]);
const playNotificationSoundMock = vi.hoisted(() => vi.fn());

// Mock the API module so PostHog doesn't break in jsdom
vi.mock("./api.js", () => ({
  api: {
    getDiffStats: getDiffStatsMock,
    listSessions: listSessionsMock,
  },
}));

vi.mock("./utils/notification-sound.js", () => ({
  playNotificationSound: playNotificationSoundMock,
}));

let wsModule: typeof import("./ws.js");
let useStore: typeof import("./store.js").useStore;

// ---------------------------------------------------------------------------
// MockWebSocket
// ---------------------------------------------------------------------------
let lastWs: InstanceType<typeof MockWebSocket>;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  OPEN = 1;
  CLOSED = 3;
  CONNECTING = 0;
  CLOSING = 2;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastWs = this;
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("location", { protocol: "http:", host: "localhost:3456" });

// ---------------------------------------------------------------------------
// Fresh module state for each test
// ---------------------------------------------------------------------------
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  getDiffStatsMock.mockReset();
  getDiffStatsMock.mockResolvedValue({ stats: {} });
  listSessionsMock.mockReset();
  listSessionsMock.mockResolvedValue([]);
  playNotificationSoundMock.mockReset();
  MockWebSocket.instances = [];

  const storeModule = await import("./store.js");
  useStore = storeModule.useStore;
  useStore.getState().reset();
  localStorage.clear();

  wsModule = await import("./ws.js");
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSession(id: string): SessionState {
  return {
    session_id: id,
    model: "claude-opus-4-20250514",
    cwd: "/home/user",
    tools: ["Bash", "Read"],
    permissionMode: "default",
    claude_code_version: "2.1.0",
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
    repo_root: "/home/user",
    git_ahead: 0,
    git_behind: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  };
}

function fireMessage(data: Record<string, unknown>) {
  lastWs.onmessage!({ data: JSON.stringify(data) });
}

// ===========================================================================
// Connection
// ===========================================================================
describe("connectSession", () => {
  it("creates a WebSocket with the correct URL", () => {
    wsModule.connectSession("s1");

    expect(lastWs.url).toBe("ws://localhost:3456/ws/browser/s1");
    expect(useStore.getState().connectionStatus.get("s1")).toBe("connecting");
  });

  it("does not create a duplicate socket for the same session", () => {
    wsModule.connectSession("s1");
    const first = lastWs;
    wsModule.connectSession("s1");

    // lastWs should still be the first one (no new constructor call)
    expect(lastWs).toBe(first);
  });

  it("sends session_subscribe with last_seq, known_frozen_count, and known_frozen_hash on open when store has messages", () => {
    // Simulate a WebSocket reconnect (not a page refresh): store already has
    // messages, so we use the cached last_seq from localStorage
    localStorage.setItem("companion:last-seq:s1", "12");
    useStore.getState().setMessages("s1", [
      {
        id: "msg-existing",
        role: "user",
        content: "existing message",
        timestamp: 1000,
      },
      {
        id: "msg-hot",
        role: "assistant",
        content: "hot reply",
        timestamp: 2000,
      },
    ], { frozenCount: 1 });
    wsModule.connectSession("s1");

    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledWith(JSON.stringify({
      type: "session_subscribe",
      last_seq: 12,
      known_frozen_count: 1,
      known_frozen_hash: computeChatMessagesSyncHash([
        {
          id: "msg-existing",
          role: "user",
          content: "existing message",
          timestamp: 1000,
        },
      ]),
    }));
  });

  // Regression test: after a full page refresh, the Zustand store is empty but
  // localStorage still holds a stale high last_seq. If we send that stale value,
  // the server thinks we're caught up and skips sending message_history, leaving
  // the UI empty. Fix: send last_seq: 0 when the store has no messages.
  it("sends last_seq: 0 on open when store has no messages (page refresh scenario)", () => {
    localStorage.setItem("companion:last-seq:s1", "50");
    // Store is empty (simulates page refresh — Zustand resets but localStorage persists)
    wsModule.connectSession("s1");

    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_subscribe", last_seq: 0, known_frozen_count: 0 }),
    );
  });

  it("sends last_seq: 0 when localStorage has no entry", () => {
    // Brand new session — no localStorage, no store messages
    wsModule.connectSession("s1");

    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_subscribe", last_seq: 0, known_frozen_count: 0 }),
    );
  });
});

describe("visibility reconnect", () => {
  it("reconnects only the current session when tab becomes visible", () => {
    useStore.getState().setSdkSessions([
      { sessionId: "s1", cwd: "/tmp/s1", createdAt: Date.now(), archived: false, state: "exited" },
      { sessionId: "s2", cwd: "/tmp/s2", createdAt: Date.now(), archived: false, state: "exited" },
    ]);
    useStore.getState().setCurrentSession("s2");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    document.dispatchEvent(new Event("visibilitychange"));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toBe("ws://localhost:3456/ws/browser/s2");
  });
});

// ===========================================================================
// sendToSession
// ===========================================================================
describe("sendToSession", () => {
  it("JSON-stringifies and sends the message", () => {
    wsModule.connectSession("s1");
    const msg = { type: "user_message" as const, content: "hello" };

    wsModule.sendToSession("s1", msg);

    const payload = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(payload.type).toBe("user_message");
    expect(payload.content).toBe("hello");
    expect(typeof payload.client_msg_id).toBe("string");
  });

  it("does nothing when session has no socket", () => {
    // Should not throw
    wsModule.sendToSession("nonexistent", { type: "interrupt" });
  });

  it("preserves provided client_msg_id", () => {
    wsModule.connectSession("s1");
    wsModule.sendToSession("s1", {
      type: "user_message",
      content: "hello",
      client_msg_id: "fixed-id-1",
    });

    const payload = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(payload.client_msg_id).toBe("fixed-id-1");
  });

  it("adds client_msg_id for interrupt control message", () => {
    wsModule.connectSession("s1");
    wsModule.sendToSession("s1", { type: "interrupt" });

    const payload = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(payload.type).toBe("interrupt");
    expect(typeof payload.client_msg_id).toBe("string");
  });
});

// ===========================================================================
// disconnectSession
// ===========================================================================
describe("disconnectSession", () => {
  it("closes the WebSocket and cleans up", () => {
    wsModule.connectSession("s1");
    const ws = lastWs;

    wsModule.disconnectSession("s1");

    expect(ws.close).toHaveBeenCalled();
    // Sending after disconnect should be a no-op
    wsModule.sendToSession("s1", { type: "interrupt" });
    expect(ws.send).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// handleMessage: session_init
// ===========================================================================
describe("handleMessage: session_init", () => {
  it("adds session to store, generates name, but does not set CLI connected", () => {
    // session_init is just a state snapshot — CLI connection status comes from
    // explicit backend_connected/backend_disconnected messages, not from session_init.
    wsModule.connectSession("s1");
    const session = makeSession("s1");

    fireMessage({ type: "session_init", session });

    const state = useStore.getState();
    expect(state.sessions.has("s1")).toBe(true);
    expect(state.sessions.get("s1")!.model).toBe("claude-opus-4-20250514");
    expect(state.cliConnected.get("s1")).toBeUndefined();
    expect(state.sessionStatus.get("s1")).toBe("idle");
    expect(state.sessionNames.get("s1")).toBe("Test Session");
  });

  it("does not overwrite an existing session name", () => {
    useStore.getState().setSessionName("s1", "Custom Name");

    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Custom Name");
  });
});

describe("handleMessage: session_created", () => {
  it("refreshes sdk sessions without opening sockets for every listed session", async () => {
    listSessionsMock.mockResolvedValueOnce([
      { sessionId: "s-new-1", cwd: "/tmp/a", createdAt: Date.now(), archived: false },
      { sessionId: "s-new-2", cwd: "/tmp/b", createdAt: Date.now(), archived: false },
    ]);

    wsModule.connectSession("s-origin");
    fireMessage({ type: "session_created", session_id: "s-new-1" });
    await Promise.resolve();

    expect(listSessionsMock).toHaveBeenCalledTimes(1);
    expect(useStore.getState().sdkSessions.map((s) => s.sessionId)).toEqual(["s-new-1", "s-new-2"]);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toBe("ws://localhost:3456/ws/browser/s-origin");
  });
});

// ===========================================================================
// handleMessage: session_update
// ===========================================================================
describe("handleMessage: session_update", () => {
  it("updates the session in the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "session_update", session: { model: "claude-sonnet-4-20250514" } });

    expect(useStore.getState().sessions.get("s1")!.model).toBe("claude-sonnet-4-20250514");
  });
});

// ===========================================================================
// handleMessage: vscode_selection_state
// ===========================================================================
describe("handleMessage: vscode_selection_state", () => {
  it("stores the authoritative selection state from the server", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "vscode_selection_state",
      state: {
        selection: {
          absolutePath: "/home/user/web/src/App.tsx",
          startLine: 12,
          endLine: 14,
          lineCount: 3,
        },
        updatedAt: 1234,
        sourceId: "vscode:window-1",
        sourceType: "vscode-window",
        sourceLabel: "VS Code",
      },
    });

    expect(useStore.getState().vscodeSelectionContext).toEqual({
      selection: {
        absolutePath: "/home/user/web/src/App.tsx",
        startLine: 12,
        endLine: 14,
        lineCount: 3,
      },
      updatedAt: 1234,
      sourceId: "vscode:window-1",
      sourceType: "vscode-window",
      sourceLabel: "VS Code",
    });
  });

  it("clears the authoritative selection state when the server sends null", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setVsCodeSelectionContext({
      selection: {
        absolutePath: "/home/user/web/src/App.tsx",
        startLine: 12,
        endLine: 14,
        lineCount: 3,
      },
      updatedAt: 1234,
      sourceId: "vscode:window-1",
      sourceType: "vscode-window",
    });

    fireMessage({
      type: "vscode_selection_state",
      state: null,
    });

    expect(useStore.getState().vscodeSelectionContext).toBeNull();
  });
});

describe("handleMessage: event_replay", () => {
  it("replays sequenced stream events and stores latest seq", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "event_replay",
      events: [
        {
          seq: 1,
          message: {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
            parent_tool_use_id: null,
          },
        },
      ],
    });

    expect(useStore.getState().streaming.get("s1")).toBe("Hello");
    expect(localStorage.getItem("companion:last-seq:s1")).toBe("1");
    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_ack", last_seq: 1 }),
    );
  });

  it("acks only once using the latest replayed seq", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    lastWs.send.mockClear();

    fireMessage({
      type: "event_replay",
      events: [
        {
          seq: 1,
          message: {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "A" } },
            parent_tool_use_id: null,
          },
        },
        {
          seq: 2,
          message: {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "B" } },
            parent_tool_use_id: null,
          },
        },
      ],
    });

    expect(useStore.getState().streaming.get("s1")).toBe("AB");
    expect(lastWs.send).toHaveBeenCalledTimes(1);
    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "session_ack", last_seq: 2 }),
    );
  });
});

// ===========================================================================
// handleMessage: assistant
// ===========================================================================
describe("handleMessage: assistant", () => {
  it("appends a chat message and clears streaming", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Set some streaming text first
    useStore.getState().setStreaming("s1", "partial text...");

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Hello world" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const state = useStore.getState();
    const msgs = state.messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toBe("Hello world");
    expect(msgs[0].id).toBe("msg-1");
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.sessionStatus.get("s1")).toBe("running");
  });

  it("preserves leader_user_addressed metadata from assistant messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      leader_user_addressed: true,
      message: {
        id: "msg-leader-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Here's the status @to(user)" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs[0].leaderUserAddressed).toBe(true);
  });

  it("clears only parented streaming for matching subagent assistant messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setStreaming("s1", "top level");
    useStore.getState().setStreaming("s1", "child partial", "agent-1");

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-subagent-1",
        type: "message",
        role: "assistant",
        model: "gpt-5",
        content: [{ type: "text", text: "Child final" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: "agent-1",
    });

    const state = useStore.getState();
    expect(state.streaming.get("s1")).toBe("top level");
    expect(state.streamingByParentToolUseId.has("s1")).toBe(false);
  });

  it("updates timestamp when an existing assistant message is re-broadcast with newer data", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      timestamp: 1000,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "part 1" }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "assistant",
      timestamp: 2500,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(2500);
  });

  it("updates turn duration when an existing assistant message is re-broadcast with duration", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      timestamp: 1000,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "done soon" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "assistant",
      timestamp: 1000,
      turn_duration_ms: 4200,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "done soon" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].turnDurationMs).toBe(4200);
  });

  it("does not set session status to running for rebroadcasted assistant with turn_duration_ms", () => {
    // When the server rebroadcasts the latest assistant message with turn_duration_ms
    // after a turn completes, the browser must NOT flip status to "running" — the turn
    // is already done and the result message will set "idle" shortly after.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Simulate initial assistant (sets status to running)
    fireMessage({
      type: "assistant",
      timestamp: 1000,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });
    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");

    // Simulate result setting idle
    fireMessage({ type: "status_change", status: "idle" });
    expect(useStore.getState().sessionStatus.get("s1")).toBe("idle");

    // Simulate rebroadcast with turn_duration_ms (arrives after result in some orderings)
    fireMessage({
      type: "assistant",
      timestamp: 1000,
      turn_duration_ms: 5000,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    // Status should remain idle — the rebroadcast must NOT flip it to "running"
    expect(useStore.getState().sessionStatus.get("s1")).toBe("idle");
  });

  it("tracks changed files using session cwd for resolving relative tool paths", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Edit",
            input: { file_path: "web/server/index.ts" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed?.has("/home/user/web/server/index.ts")).toBe(true);
  });

  it("ignores changed files outside the repo root", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-2",
            name: "Write",
            input: { file_path: "/Users/test/.claude/plans/example.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed).toBeUndefined();
  });

  it("tracks changed files with absolute paths when inside repo root", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-3",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-3",
            name: "Write",
            input: { file_path: "/home/user/README.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed?.has("/home/user/README.md")).toBe(true);
  });

  it("tracks changed files in worktree sessions where repo_root is the main repo", () => {
    // In a worktree, repo_root points to the main repo (e.g. /home/user/companion)
    // but the session cwd is the worktree directory (e.g. /home/user/.worktrees/wt-1).
    // Files edited in the worktree should still be tracked.
    const worktreeSession = {
      ...makeSession("s1"),
      cwd: "/home/user/.worktrees/wt-1",
      repo_root: "/home/user/companion",
      is_worktree: true,
    };
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: worktreeSession });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-wt-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-wt-1",
            name: "Edit",
            input: { file_path: "web/src/index.ts" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed?.has("/home/user/.worktrees/wt-1/web/src/index.ts")).toBe(true);
  });

  it("tracks changed files when cwd is a subdirectory of repo_root", () => {
    // When cwd is a subdirectory of repo_root, repo_root should be used as the scope
    // so files at the repo root level (e.g. CLAUDE.md) are tracked.
    const subSession = {
      ...makeSession("s1"),
      cwd: "/home/user/monorepo/packages/app",
      repo_root: "/home/user/monorepo",
    };
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: subSession });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-sub-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-sub-1",
            name: "Write",
            input: { file_path: "/home/user/monorepo/CLAUDE.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed?.has("/home/user/monorepo/CLAUDE.md")).toBe(true);
  });
});

// ===========================================================================
// handleMessage: stream_event (content_block_delta)
// ===========================================================================
describe("handleMessage: stream_event content_block_delta", () => {
  it("accumulates streaming text from text_delta events", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streaming.get("s1")).toBe("Hello world");
  });

  it("routes parented streaming text into the matching subagent buffer", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Nested " } },
      parent_tool_use_id: "agent-1",
    });
    fireMessage({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "output" } },
      parent_tool_use_id: "agent-1",
    });

    const state = useStore.getState();
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.streamingByParentToolUseId.get("s1")?.get("agent-1")).toBe("Nested output");
  });
});

// ===========================================================================
// handleMessage: stream_event (message_start)
// ===========================================================================
describe("handleMessage: stream_event message_start", () => {
  it("sets streaming start time", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    vi.setSystemTime(new Date(1700000000000));
    fireMessage({
      type: "stream_event",
      event: { type: "message_start" },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(1700000000000);
  });
});

// ===========================================================================
// handleMessage: result
// ===========================================================================
describe("handleMessage: result", () => {
  it("updates cost/turns, clears streaming, sets idle", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().appendMessage("s1", {
      id: "user-1",
      role: "user",
      content: "hello",
      timestamp: 1000,
    });
    useStore.getState().appendMessage("s1", {
      id: "assistant-1",
      role: "assistant",
      content: "world",
      timestamp: 2000,
    });
    useStore.getState().setStreaming("s1", "partial");
    useStore.getState().setStreamingStats("s1", { startedAt: Date.now() });

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 3,
        total_cost_usd: 0.05,
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "u1",
        session_id: "s1",
      },
    });

    const state = useStore.getState();
    expect(state.sessions.get("s1")!.total_cost_usd).toBe(0.05);
    expect(state.sessions.get("s1")!.num_turns).toBe(3);
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.streamingStartedAt.has("s1")).toBe(false);
    expect(state.sessionStatus.get("s1")).toBe("idle");
    expect(state.messageFrozenCounts.get("s1")).toBe(2);
  });

  it("suppresses completion notifications for leader sessions without @to(user) assistant messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setSdkSessions([
      { sessionId: "s1", state: "connected", cwd: "/home/user", createdAt: Date.now(), isOrchestrator: true },
    ]);
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Internal herd update" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "u-leader-internal",
        session_id: "s1",
      },
    });

    expect(playNotificationSoundMock).not.toHaveBeenCalled();
    hasFocusSpy.mockRestore();
  });

  it("plays completion notifications for leader sessions when latest assistant is @to(user) addressed", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setSdkSessions([
      { sessionId: "s1", state: "connected", cwd: "/home/user", createdAt: Date.now(), isOrchestrator: true },
    ]);
    fireMessage({
      type: "assistant",
      leader_user_addressed: true,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Please review the PR @to(user)" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "u-leader-user",
        session_id: "s1",
      },
    });

    expect(playNotificationSoundMock).toHaveBeenCalledTimes(1);
    hasFocusSpy.mockRestore();
  });

  it("suppresses completion notifications for herded worker sessions", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setSdkSessions([
      { sessionId: "s1", state: "connected", cwd: "/home/user", createdAt: Date.now(), herdedBy: "orch-1" },
    ]);
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Worker finished task" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "u-herded",
        session_id: "s1",
      },
    });

    expect(playNotificationSoundMock).not.toHaveBeenCalled();
    hasFocusSpy.mockRestore();
  });

  it("sends leader-group idle notifications when unfocused", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setNotificationDesktop(true);
    const hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false);

    const notificationCalls: Array<{ title: string; options: NotificationOptions }> = [];
    const OriginalNotification = (globalThis as any).Notification;
    class MockNotification {
      static permission = "granted";
      constructor(title: string, options: NotificationOptions) {
        notificationCalls.push({ title, options });
      }
    }
    (globalThis as any).Notification = MockNotification;

    fireMessage({
      type: "leader_group_idle",
      leader_session_id: "s1",
      leader_label: "#7 Orchestrator",
      member_count: 3,
      idle_for_ms: 10_500,
      timestamp: Date.now(),
    });

    expect(playNotificationSoundMock).toHaveBeenCalledTimes(1);
    expect(notificationCalls).toEqual([
      {
        title: "Leader group idle",
        options: {
          body: "#7 Orchestrator is idle and waiting for attention",
          tag: "leader-group-idle:s1",
        },
      },
    ]);

    (globalThis as any).Notification = OriginalNotification;
    hasFocusSpy.mockRestore();
  });

  it("does not recompute context_used_percent from result.modelUsage on the client", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    fireMessage({ type: "session_update", session: { context_used_percent: 37 } });

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 3,
        total_cost_usd: 0.05,
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 254,
            outputTokens: 77708,
            cacheReadInputTokens: 21737912,
            cacheCreationInputTokens: 263780,
            contextWindow: 200000,
            maxOutputTokens: 32000,
            costUSD: 14.46,
          },
        },
        uuid: "u1-model-usage",
        session_id: "s1",
      },
    });

    expect(useStore.getState().sessions.get("s1")!.context_used_percent).toBe(37);
  });

  it("appends a system error message when result has errors", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Something went wrong", "Another error"],
        duration_ms: 100,
        duration_api_ms: 50,
        num_turns: 1,
        total_cost_usd: 0.01,
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "u2",
        session_id: "s1",
      },
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Error: Something went wrong, Another error");
  });
});

// ===========================================================================
// handleMessage: permission_request
// ===========================================================================
describe("handleMessage: permission_request", () => {
  it("adds permission to the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const request: PermissionRequest = {
      request_id: "req-1",
      tool_name: "Bash",
      input: { command: "rm -rf /" },
      tool_use_id: "tu-1",
      timestamp: Date.now(),
    };

    fireMessage({ type: "permission_request", request });

    const perms = useStore.getState().pendingPermissions.get("s1");
    expect(perms).toBeDefined();
    expect(perms!.get("req-1")).toBeDefined();
    expect(perms!.get("req-1")!.tool_name).toBe("Bash");
  });
});

// ===========================================================================
// handleMessage: permission_cancelled
// ===========================================================================
describe("handleMessage: permission_cancelled", () => {
  it("removes the permission from the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Add a permission first
    const request: PermissionRequest = {
      request_id: "req-1",
      tool_name: "Bash",
      input: {},
      tool_use_id: "tu-1",
      timestamp: Date.now(),
    };
    useStore.getState().addPermission("s1", request);

    fireMessage({ type: "permission_cancelled", request_id: "req-1" });

    const perms = useStore.getState().pendingPermissions.get("s1");
    expect(perms!.has("req-1")).toBe(false);
  });
});

// ===========================================================================
// handleMessage: status_change (compacting)
// ===========================================================================
describe("handleMessage: status_change", () => {
  it("sets session status to compacting", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "status_change", status: "compacting" });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("compacting");
  });

  it("sets session status to arbitrary value", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({ type: "status_change", status: "running" });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");
  });
});

// ===========================================================================
// handleMessage: backend_disconnected / backend_connected
// ===========================================================================
describe("handleMessage: backend_disconnected/connected", () => {
  it("toggles backendConnected in the store with disconnect debounce", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // session_init does not set backendConnected — only explicit messages do
    expect(useStore.getState().cliConnected.get("s1")).toBeUndefined();

    fireMessage({ type: "backend_connected" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);

    fireMessage({ type: "backend_disconnected" });
    // Disconnect is debounced to avoid visual flicker during fast relaunches.
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
    vi.advanceTimersByTime(300);
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
    expect(useStore.getState().sessionStatus.get("s1")).toBeNull();

    fireMessage({ type: "backend_connected" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
  });

  it("preserves a broken disconnect reason for explicit relaunch UI", () => {
    // Broken Codex sessions should surface a durable reason instead of
    // looking like a generic transient disconnect.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    fireMessage({ type: "backend_connected" });

    fireMessage({ type: "backend_disconnected", reason: "broken" });
    vi.advanceTimersByTime(300);

    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
    expect(useStore.getState().cliDisconnectReason.get("s1")).toBe("broken");
  });

  it("coalesces fast disconnect/reconnect without showing disconnected state", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    fireMessage({ type: "backend_connected" });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);

    fireMessage({ type: "backend_disconnected" });
    fireMessage({ type: "backend_connected" });
    vi.advanceTimersByTime(300);

    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
    expect(useStore.getState().sessionStatus.get("s1")).toBe("idle");
  });
});

// ===========================================================================
// handleMessage: message_history
// ===========================================================================
describe("handleMessage: message_history", () => {
  it("reconstructs chat messages from history", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "What is 2+2?", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "msg-hist-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "4" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
        },
        {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0.01,
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "u1",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("What is 2+2?");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("4");
    expect(useStore.getState().messageFrozenCounts.get("s1")).toBe(2);
  });

  it("restores leader_user_addressed metadata from history", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "assistant",
          leader_user_addressed: true,
          message: {
            id: "msg-hist-leader-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "done @to(user)" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].leaderUserAddressed).toBe(true);
  });

  it("includes error results from history as system messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "result",
          data: {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["Timed out"],
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "u1",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Error: Timed out");
    expect(useStore.getState().messageFrozenCounts.get("s1")).toBe(1);
  });

  it("assigns stable IDs to error results based on history index", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "hi", timestamp: 1000 },
        {
          type: "result",
          data: {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["Timed out"],
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0,
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "u1",
            session_id: "s1",
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    const errorMsg = msgs.find((m) => m.role === "system")!;
    expect(errorMsg.id).toBe("hist-error-1");
  });

  it("deduplicates messages on reconnection (replayed history)", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const history = {
      type: "message_history",
      messages: [
        { type: "user_message", id: "user-1", content: "hello", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
        },
      ],
    };

    // Initial connect
    fireMessage(history);
    expect(useStore.getState().messages.get("s1")).toHaveLength(2);

    // Simulate reconnect: same history replayed
    fireMessage(history);
    expect(useStore.getState().messages.get("s1")).toHaveLength(2);
  });

  it("replaces (not merges) existing messages when message_history arrives", () => {
    // This tests the fix for cross-session message contamination where the old
    // merge logic would keep stale messages from a previous session in the store.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // First history load
    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", id: "user-1", content: "old message", timestamp: 1000 },
      ],
    });
    expect(useStore.getState().messages.get("s1")).toHaveLength(1);
    expect(useStore.getState().messages.get("s1")![0].content).toBe("old message");

    // Second history load with different messages — should REPLACE, not merge
    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", id: "user-2", content: "new message", timestamp: 2000 },
      ],
    });
    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("new message");
    // Old message should NOT be present
    expect(msgs.find((m) => m.content === "old message")).toBeUndefined();
  });

  it("preserves original timestamps from history instead of using Date.now()", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "hello", timestamp: 42000 },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 43000,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs[0].timestamp).toBe(42000);
    expect(msgs[1].timestamp).toBe(43000);
  });

  it("extracts turn_duration_ms from assistant messages in history", () => {
    // When the browser reconnects, the server replays message_history which may
    // include assistant messages with turn_duration_ms persisted from the previous
    // turn. The browser must extract this so the chat feed can show turn durations.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "hello", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "hi back" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
          turn_duration_ms: 3500,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].turnDurationMs).toBe(3500);
  });
});

describe("handleMessage: history_sync", () => {
  it("appends frozen delta and replaces the hot tail", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setMessages("s1", [
      { id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 },
      { id: "hot-1", role: "assistant", content: "stale hot", timestamp: 2000 },
    ], { frozenCount: 1 });

    fireMessage({
      type: "history_sync",
      frozen_base_count: 1,
      frozen_delta: [
        {
          type: "assistant",
          message: {
            id: "frozen-2",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "new frozen reply" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 3000,
        },
        {
          type: "result",
          data: {
            type: "result",
            subtype: "success",
            is_error: false,
            duration_ms: 100,
            duration_api_ms: 50,
            num_turns: 1,
            total_cost_usd: 0.01,
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: "r1",
            session_id: "s1",
          },
        },
      ],
      hot_messages: [
        { type: "user_message", id: "hot-2", content: "new hot user", timestamp: 4000 },
      ],
      frozen_count: 2,
      expected_frozen_hash: computeChatMessagesSyncHash([
        { id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 },
        { id: "frozen-2", role: "assistant", content: "new frozen reply", timestamp: 3000 },
      ]),
      expected_full_hash: computeChatMessagesSyncHash([
        { id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 },
        { id: "frozen-2", role: "assistant", content: "new frozen reply", timestamp: 3000 },
        { id: "hot-2", role: "user", content: "new hot user", timestamp: 4000 },
      ]),
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.map((m) => m.id)).toEqual(["frozen-1", "frozen-2", "hot-2"]);
    expect(msgs[2]?.content).toBe("new hot user");
    expect(useStore.getState().messageFrozenCounts.get("s1")).toBe(2);
  });

  it("clears the prior hot tail when history_sync hot_messages is empty", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setMessages("s1", [
      { id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 },
      { id: "hot-1", role: "assistant", content: "stale hot", timestamp: 2000 },
    ], { frozenCount: 1 });

    fireMessage({
      type: "history_sync",
      frozen_base_count: 1,
      frozen_delta: [],
      hot_messages: [],
      frozen_count: 1,
      expected_frozen_hash: computeChatMessagesSyncHash([
        { id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 },
      ]),
      expected_full_hash: computeChatMessagesSyncHash([
        { id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 },
      ]),
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.map((m) => m.id)).toEqual(["frozen-1"]);
    expect(useStore.getState().messageFrozenCounts.get("s1")).toBe(1);
  });

  it("logs and requests a full resync when runtime hash verification fails", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setMessages("s1", [
      { id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 },
    ], { frozenCount: 1 });
    lastWs.send.mockClear();

    fireMessage({
      type: "history_sync",
      frozen_base_count: 1,
      frozen_delta: [],
      hot_messages: [],
      frozen_count: 1,
      expected_frozen_hash: "deadbeef",
      expected_full_hash: "deadbeef",
    });

    expect(errorSpy).toHaveBeenCalled();
    const outgoing = lastWs.send.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(outgoing).toHaveLength(2);
    expect(outgoing[0]).toMatchObject({
      type: "history_sync_mismatch",
      frozen_count: 1,
      expected_frozen_hash: "deadbeef",
      expected_full_hash: "deadbeef",
    });
    expect(outgoing[0].actual_frozen_hash).toEqual(expect.any(String));
    expect(outgoing[0].actual_full_hash).toEqual(expect.any(String));
    expect(outgoing[1]).toEqual({
      type: "session_subscribe",
      last_seq: 0,
      known_frozen_count: 0,
    });
    errorSpy.mockRestore();
  });
});

// ===========================================================================
// handleMessage: auth_status error
// ===========================================================================
describe("handleMessage: auth_status", () => {
  it("appends a system message when there is an auth error", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "auth_status",
      isAuthenticating: false,
      output: [],
      error: "Invalid API key",
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("Auth error: Invalid API key");
  });

  it("does not append a message when there is no error", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "auth_status",
      isAuthenticating: true,
      output: ["Authenticating..."],
    });

    const msgs = useStore.getState().messages.get("s1") || [];
    expect(msgs).toHaveLength(0);
  });
});

// ===========================================================================
// Task extraction: TodoWrite
// ===========================================================================
describe("task extraction: TodoWrite", () => {
  it("replaces all tasks via TodoWrite tool_use block", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tasks-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "Fix bug", status: "in_progress", activeForm: "Fixing bug" },
                { content: "Write tests", status: "pending", activeForm: "Writing tests" },
              ],
            },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].subject).toBe("Fix bug");
    expect(tasks[0].status).toBe("in_progress");
    expect(tasks[0].activeForm).toBe("Fixing bug");
    expect(tasks[1].subject).toBe("Write tests");
    expect(tasks[1].status).toBe("pending");
  });
});

// ===========================================================================
// Task extraction: TaskCreate
// ===========================================================================
describe("task extraction: TaskCreate", () => {
  it("incrementally adds a task", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tc-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-tc-1",
            name: "TaskCreate",
            input: { subject: "Deploy service", description: "Deploy to prod", activeForm: "Deploying service" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const tasks = useStore.getState().sessionTasks.get("s1")!;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("Deploy service");
    expect(tasks[0].description).toBe("Deploy to prod");
    expect(tasks[0].status).toBe("pending");
  });
});

// ===========================================================================
// Task extraction: TaskUpdate
// ===========================================================================
describe("task extraction: TaskUpdate", () => {
  it("updates an existing task", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Create a task first via TaskCreate
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tc-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-tc-2",
            name: "TaskCreate",
            input: { subject: "Build feature" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const tasksBefore = useStore.getState().sessionTasks.get("s1")!;
    expect(tasksBefore[0].status).toBe("pending");

    // Update the task
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tu-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tu-tu-1",
            name: "TaskUpdate",
            input: { taskId: "1", status: "completed" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const tasksAfter = useStore.getState().sessionTasks.get("s1")!;
    expect(tasksAfter[0].status).toBe("completed");
  });
});

// ===========================================================================
// handleMessage: session_order_update
// ===========================================================================
describe("handleMessage: session_order_update", () => {
  it("replaces session order from server snapshot", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "session_order_update",
      sessionOrder: {
        "/repo-a": ["s2", "s1"],
        "/repo-b": ["s3"],
      },
    });

    expect(useStore.getState().sessionOrder).toEqual(new Map([
      ["/repo-a", ["s2", "s1"]],
      ["/repo-b", ["s3"]],
    ]));
  });

  it("overwrites stale local order when a new snapshot arrives", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setSessionOrderMap(new Map([
      ["/repo-a", ["stale-1", "stale-2"]],
    ]));

    fireMessage({
      type: "session_order_update",
      sessionOrder: {
        "/repo-a": ["s1", "s2"],
      },
    });

    expect(useStore.getState().sessionOrder).toEqual(new Map([
      ["/repo-a", ["s1", "s2"]],
    ]));
  });
});

// ===========================================================================
// handleMessage: session_name_update
// ===========================================================================
describe("handleMessage: session_name_update", () => {
  // Server is authoritative for all name updates — the browser always accepts them.
  // The server handles the logic of when to update names (auto-naming, manual renames, etc.)

  it("updates session name from server", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setSessionName("s1", "Swift Falcon");

    fireMessage({ type: "session_name_update", name: "Fix Authentication Bug" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Fix Authentication Bug");
  });

  it("marks session as recently renamed for animation when name changes", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setSessionName("s1", "Calm River");

    fireMessage({ type: "session_name_update", name: "Deploy Dashboard" });

    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("always accepts server-authoritative name updates", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Even custom names get overwritten by server updates — the server
    // controls when names should change (it tracks manual rename state)
    useStore.getState().setSessionName("s1", "My Custom Project");

    fireMessage({ type: "session_name_update", name: "Auto Generated Title" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Auto Generated Title");
  });

  it("does not mark as recently renamed when name is the same", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setSessionName("s1", "Same Name");
    useStore.getState().clearRecentlyRenamed("s1");

    // Server sends the same name — no animation
    fireMessage({ type: "session_name_update", name: "Same Name" });

    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });

  it("updates name when session has no name at all", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Clear the name entirely
    const sessionNames = new Map(useStore.getState().sessionNames);
    sessionNames.delete("s1");
    useStore.setState({ sessionNames });

    fireMessage({ type: "session_name_update", name: "Brand New Title" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Brand New Title");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("updates any name regardless of pattern — server is source of truth", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Random Adj+Noun name
    useStore.getState().setSessionName("s1", "Bright Falcon");
    fireMessage({ type: "session_name_update", name: "Auto Title" });
    expect(useStore.getState().sessionNames.get("s1")).toBe("Auto Title");

    // Multi-word custom name also gets updated
    useStore.getState().setSessionName("s1", "My Cool Project");
    useStore.getState().clearRecentlyRenamed("s1");
    fireMessage({ type: "session_name_update", name: "Another Auto Title" });
    expect(useStore.getState().sessionNames.get("s1")).toBe("Another Auto Title");
  });
});

// ===========================================================================
// MCP Status
// ===========================================================================

describe("MCP status messages", () => {
  it("mcp_status: stores servers in store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const servers = [
      {
        name: "test-mcp",
        status: "connected",
        config: { type: "stdio", command: "node", args: ["server.js"] },
        scope: "project",
        tools: [{ name: "myTool" }],
      },
      {
        name: "disabled-mcp",
        status: "disabled",
        config: { type: "sse", url: "http://localhost:3000" },
        scope: "user",
      },
    ];

    fireMessage({ type: "mcp_status", servers });

    const stored = useStore.getState().mcpServers.get("s1");
    expect(stored).toHaveLength(2);
    expect(stored![0].name).toBe("test-mcp");
    expect(stored![0].status).toBe("connected");
    expect(stored![0].tools).toHaveLength(1);
    expect(stored![1].name).toBe("disabled-mcp");
    expect(stored![1].status).toBe("disabled");
  });

  it("sendMcpGetStatus: sends mcp_get_status message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    wsModule.sendMcpGetStatus("s1");

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_get_status");
    expect(typeof sent.client_msg_id).toBe("string");
  });

  it("sendMcpToggle: sends mcp_toggle message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    wsModule.sendMcpToggle("s1", "my-server", false);

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_toggle");
    expect(sent.serverName).toBe("my-server");
    expect(sent.enabled).toBe(false);
    expect(typeof sent.client_msg_id).toBe("string");
  });

  it("sendMcpReconnect: sends mcp_reconnect message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    wsModule.sendMcpReconnect("s1", "failing-server");

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_reconnect");
    expect(sent.serverName).toBe("failing-server");
    expect(typeof sent.client_msg_id).toBe("string");
  });

  it("sendMcpSetServers: sends mcp_set_servers message", () => {
    wsModule.connectSession("s1");
    lastWs.send.mockClear();

    const servers = {
      "notes-server": {
        type: "stdio" as const,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-memory"],
      },
    };
    wsModule.sendMcpSetServers("s1", servers);

    expect(lastWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastWs.send.mock.calls[0][0]);
    expect(sent.type).toBe("mcp_set_servers");
    expect(sent.servers).toEqual(servers);
    expect(typeof sent.client_msg_id).toBe("string");
  });
});

// ===========================================================================
// handleMessage: tool_progress
// ===========================================================================
describe("handleMessage: tool_progress", () => {
  it("stores tool progress in the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-123",
      tool_name: "Bash",
      elapsed_time_seconds: 5,
    });

    const progress = useStore.getState().toolProgress.get("s1");
    expect(progress).toBeDefined();
    expect(progress!.get("tu-123")).toEqual({
      toolName: "Bash",
      elapsedSeconds: 5,
    });
  });

  it("updates elapsed time on subsequent messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-123",
      tool_name: "Bash",
      elapsed_time_seconds: 2,
    });
    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-123",
      tool_name: "Bash",
      elapsed_time_seconds: 7,
    });

    const entry = useStore.getState().toolProgress.get("s1")!.get("tu-123");
    expect(entry!.elapsedSeconds).toBe(7);
  });

  it("accumulates streamed output deltas for Codex Bash commands", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-live",
      tool_name: "Bash",
      elapsed_time_seconds: 1,
      output_delta: "Merged 128/512 files\n",
    });
    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-live",
      tool_name: "Bash",
      elapsed_time_seconds: 2,
      output_delta: "Merged 256/512 files\n",
    });

    const entry = useStore.getState().toolProgress.get("s1")!.get("tu-live");
    expect(entry).toEqual({
      toolName: "Bash",
      elapsedSeconds: 2,
      output: "Merged 128/512 files\nMerged 256/512 files\n",
    });
  });

  it("keeps only the latest output tail when streamed output exceeds cap", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const firstChunk = "a".repeat(7_000);
    const secondChunk = "b".repeat(7_000);
    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-long",
      tool_name: "Bash",
      elapsed_time_seconds: 1,
      output_delta: firstChunk,
    });
    fireMessage({
      type: "tool_progress",
      tool_use_id: "tu-long",
      tool_name: "Bash",
      elapsed_time_seconds: 2,
      output_delta: secondChunk,
    });

    const entry = useStore.getState().toolProgress.get("s1")!.get("tu-long")!;
    expect(entry.output?.length).toBe(12_000);
    expect(entry.output?.endsWith(secondChunk)).toBe(true);
    expect(entry.outputTruncated).toBe(true);
  });
});

// ===========================================================================
// handleMessage: tool_result_preview
// ===========================================================================
describe("handleMessage: tool_result_preview", () => {
  it("stores preview and clears in-progress tool output for completed tools", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setToolProgress("s1", "tu-live", {
      toolName: "Bash",
      elapsedSeconds: 9,
      outputDelta: "still running\n",
    });

    fireMessage({
      type: "tool_result_preview",
      previews: [
        {
          tool_use_id: "tu-live",
          content: "done",
          is_error: false,
          total_size: 4,
          is_truncated: false,
        },
      ],
    });

    const preview = useStore.getState().toolResults.get("s1")?.get("tu-live");
    expect(preview?.content).toBe("done");
    const progress = useStore.getState().toolProgress.get("s1");
    expect(progress?.has("tu-live")).toBe(false);
  });
});

// ===========================================================================
// handleMessage: task_notification
// ===========================================================================
describe("handleMessage: task_notification", () => {
  it("stores background agent notification in the store", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "task_notification",
      task_id: "task-1",
      tool_use_id: "tu-bg-1",
      status: "completed",
      output_file: "/tmp/output.txt",
      summary: "Found 3 files matching the pattern",
    });

    const notif = useStore.getState().backgroundAgentNotifs.get("s1")?.get("tu-bg-1");
    expect(notif).toBeDefined();
    expect(notif!.status).toBe("completed");
    expect(notif!.outputFile).toBe("/tmp/output.txt");
    expect(notif!.summary).toBe("Found 3 files matching the pattern");
  });

  it("ignores task_notification without tool_use_id", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "task_notification",
      task_id: "task-1",
      tool_use_id: "",
      status: "completed",
    });

    const sessionNotifs = useStore.getState().backgroundAgentNotifs.get("s1");
    // Empty string tool_use_id is falsy, so no notification should be stored
    expect(sessionNotifs?.has("")).toBeFalsy();
  });
});

// ===========================================================================
// message_history: task_notification replay
// ===========================================================================
describe("handleMessage: message_history replays task_notification", () => {
  it("restores background agent notifications from history", () => {
    // Verifies that task_notification messages persisted in messageHistory
    // are replayed on reconnect, so background agent completion survives
    // page refreshes.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", content: "search for auth", timestamp: 1000 },
        {
          type: "task_notification",
          task_id: "task-1",
          tool_use_id: "tu-bg-hist",
          status: "completed",
          output_file: "/tmp/agent-out.txt",
          summary: "Agent completed successfully",
        },
      ],
    });

    const notif = useStore.getState().backgroundAgentNotifs.get("s1")?.get("tu-bg-hist");
    expect(notif).toBeDefined();
    expect(notif!.status).toBe("completed");
    expect(notif!.summary).toBe("Agent completed successfully");
    expect(notif!.outputFile).toBe("/tmp/agent-out.txt");
  });
});

// ===========================================================================
// handleMessage: tool_use_summary
// ===========================================================================
describe("handleMessage: tool_use_summary", () => {
  it("appends a system message with the summary text", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "tool_use_summary",
      summary: "Ran 3 tools: Bash, Read, Grep",
      tool_use_ids: ["tu-1", "tu-2", "tu-3"],
    });

    const msgs = useStore.getState().messages.get("s1");
    expect(msgs).toBeDefined();
    const systemMsg = msgs!.find((m) => m.role === "system" && m.content === "Ran 3 tools: Bash, Read, Grep");
    expect(systemMsg).toBeDefined();
  });
});

// ===========================================================================
// assistant message: per-tool progress clearing (not blanket clear)
// ===========================================================================
describe("handleMessage: assistant clears only completed tool progress", () => {
  it("clears progress for tool_result blocks but keeps others", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Set up progress for two concurrent tools
    useStore.getState().setToolProgress("s1", "tu-a", { toolName: "Grep", elapsedSeconds: 3 });
    useStore.getState().setToolProgress("s1", "tu-b", { toolName: "Glob", elapsedSeconds: 2 });

    // Simulate assistant message with tool_result for only tu-a
    fireMessage({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          { type: "tool_result", tool_use_id: "tu-a", content: "3 matches" },
        ] as ContentBlock[],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const progress = useStore.getState().toolProgress.get("s1");
    // tu-a should be cleared (its result arrived)
    expect(progress?.has("tu-a")).toBeFalsy();
    // tu-b should still be present (still running)
    expect(progress?.get("tu-b")).toEqual({ toolName: "Glob", elapsedSeconds: 2 });
  });
});

// ===========================================================================
// handleMessage: compact_boundary (preserves messages + inserts marker)
// ===========================================================================
describe("handleMessage: compact_boundary", () => {
  it("appends a system compact marker using server-provided id and timestamp", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Add some existing messages
    useStore.getState().appendMessage("s1", {
      id: "msg-1",
      role: "user",
      content: "hello",
      timestamp: 1000,
    });
    useStore.getState().appendMessage("s1", {
      id: "msg-2",
      role: "assistant",
      content: "hi there",
      timestamp: 2000,
    });

    // Fire compact_boundary — should preserve existing messages and add a marker
    fireMessage({
      type: "compact_boundary",
      id: "compact-boundary-3333",
      timestamp: 3333,
      trigger: "auto",
      preTokens: 80000,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    // Existing messages should still be there
    expect(msgs.length).toBe(3);
    expect(msgs[0].id).toBe("msg-1");
    expect(msgs[1].id).toBe("msg-2");
    // Third message should be the compact marker
    const marker = msgs[2];
    expect(marker.role).toBe("system");
    expect(marker.content).toBe("Conversation compacted");
    expect(marker.variant).toBe("info");
    expect(marker.id).toBe("compact-boundary-3333");
    expect(marker.timestamp).toBe(3333);
  });

  it("does not duplicate compact marker when replay event matches existing history marker id", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", id: "u1", content: "Before compact", timestamp: 1000 },
        {
          type: "compact_marker",
          id: "compact-boundary-5000",
          timestamp: 5000,
          summary: "Conversation compacted",
        },
      ],
    });

    fireMessage({
      type: "compact_boundary",
      id: "compact-boundary-5000",
      timestamp: 5000,
      trigger: "auto",
      preTokens: 60000,
    });

    const msgs = useStore.getState().messages.get("s1") ?? [];
    const markers = msgs.filter((m) => m.id === "compact-boundary-5000");
    expect(markers).toHaveLength(1);
  });
});

// ===========================================================================
// handleMessage: compact_summary (updates compact marker content)
// ===========================================================================
describe("handleMessage: compact_summary", () => {
  it("updates the most recent compact marker with summary text", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Insert a compact marker
    useStore.getState().appendMessage("s1", {
      id: "compact-boundary-12345",
      role: "system",
      content: "Conversation compacted",
      timestamp: 12345,
      variant: "info",
    });

    const summary = "This session is being continued. Key context: building a web app.";
    fireMessage({ type: "compact_summary", summary });

    const msgs = useStore.getState().messages.get("s1")!;
    const marker = msgs.find((m) => m.id === "compact-boundary-12345");
    expect(marker).toBeTruthy();
    expect(marker!.content).toBe(summary);
  });
});

// ===========================================================================
// handleMessage: message_history with compact_marker
// ===========================================================================
describe("handleMessage: message_history with compact_marker", () => {
  it("renders compact_marker as a system message with summary", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const summary = "Previous conversation summary text.";
    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "compact_marker",
          timestamp: 5000,
          id: "compact-boundary-5000",
          summary,
          trigger: "auto",
          preTokens: 60000,
        },
        { type: "user_message", content: "new message after compact", timestamp: 6000 },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.length).toBe(2);

    // First message should be the compact marker rendered as system
    const marker = msgs[0];
    expect(marker.role).toBe("system");
    expect(marker.content).toBe(summary);
    expect(marker.variant).toBe("info");
    expect(marker.id).toBe("compact-boundary-5000");

    // Second should be the user message
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toBe("new message after compact");
  });

  it("preserves old messages before compact_marker in history (flat history)", () => {
    // After compaction, server sends full history: old messages + compact_marker + new messages.
    // Browser should render all of them, with the compact marker acting as a visual divider.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", id: "old-1", content: "old question", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "old-2",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "old answer" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
        },
        {
          type: "compact_marker",
          timestamp: 3000,
          id: "compact-boundary-3000",
          summary: "Summary of old conversation",
          trigger: "manual",
          preTokens: 50000,
        },
        { type: "user_message", id: "new-1", content: "new question", timestamp: 4000 },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    // All 4 items should be present: old user, old assistant, compact marker, new user
    expect(msgs.length).toBe(4);
    expect(msgs[0].content).toBe("old question");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("system");
    expect(msgs[2].content).toBe("Summary of old conversation");
    expect(msgs[3].content).toBe("new question");
  });

  it("renders compact_marker without summary as default text", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "compact_marker",
          timestamp: 7000,
          id: "compact-boundary-7000",
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("Conversation compacted");
  });
});

// ===========================================================================
// handleMessage: state_snapshot
// ===========================================================================
describe("handleMessage: state_snapshot", () => {
  it("updates session status, CLI connection, and askPermission from snapshot", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "running",
      permissionMode: "acceptEdits",
      backendConnected: true,
      uiMode: null,
      askPermission: false,
    });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
    expect(useStore.getState().cliEverConnected.get("s1")).toBe(true);
    expect(useStore.getState().askPermission.get("s1")).toBe(false);
  });

  it("stores backendState and backendError from the authoritative snapshot", () => {
    // The browser should trust the server snapshot for broken/recovering
    // backend health rather than inferring it from transient local state.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: null,
      permissionMode: "default",
      backendConnected: false,
      backendState: "broken",
      backendError: "Codex initialization failed: Transport closed",
      uiMode: null,
      askPermission: true,
    });

    const session = useStore.getState().sessions.get("s1");
    expect(session?.backend_state).toBe("broken");
    expect(session?.backend_error).toBe("Codex initialization failed: Transport closed");
  });

  it("sets backendConnected to false and sessionStatus to null when CLI is disconnected", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // First set connected
    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      uiMode: null,
      askPermission: true,
    });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);

    // Then snapshot with CLI disconnected
    fireMessage({
      type: "state_snapshot",
      sessionStatus: null,
      permissionMode: "default",
      backendConnected: false,
      uiMode: null,
      askPermission: true,
    });
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
    expect(useStore.getState().sessionStatus.get("s1")).toBeNull();
  });
});

// ===========================================================================
// handleMessage: permission_approved removes pending permission
// ===========================================================================
describe("handleMessage: permission_approved", () => {
  it("removes the permission from pending when request_id is present", () => {
    vi.useFakeTimers();
    try {
      wsModule.connectSession("s1");
      fireMessage({ type: "session_init", session: makeSession("s1") });

      // Add a pending permission
      const request: PermissionRequest = {
        request_id: "req-approve-1",
        tool_name: "Edit",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-approve-1",
        timestamp: Date.now(),
      };
      useStore.getState().addPermission("s1", request);
      expect(useStore.getState().pendingPermissions.get("s1")!.has("req-approve-1")).toBe(true);

      // Fire permission_approved with request_id
      fireMessage({
        type: "permission_approved",
        id: "approval-req-approve-1",
        request_id: "req-approve-1",
        tool_name: "Edit",
        tool_use_id: "tu-approve-1",
        summary: "Approved Edit",
        timestamp: Date.now(),
      });

      // System message should be appended immediately
      const msgs = useStore.getState().messages.get("s1")!;
      expect(msgs.some((m) => m.variant === "approved")).toBe(true);

      // Permission removal is delayed 400ms for the stamping animation
      expect(useStore.getState().pendingPermissions.get("s1")!.has("req-approve-1")).toBe(true);
      vi.advanceTimersByTime(400);
      const perms = useStore.getState().pendingPermissions.get("s1");
      expect(perms!.has("req-approve-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still works without request_id (backward compat with old messages)", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Fire permission_approved WITHOUT request_id (old format)
    fireMessage({
      type: "permission_approved",
      id: "approval-old",
      tool_name: "Bash",
      tool_use_id: "tu-old",
      summary: "Approved Bash",
      timestamp: Date.now(),
    });

    // Should still append the system message without errors
    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.some((m) => m.variant === "approved")).toBe(true);
  });
});

// ===========================================================================
// handleMessage: permission_denied removes pending permission
// ===========================================================================
describe("handleMessage: permission_denied", () => {
  it("removes the permission from pending when request_id is present", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Add a pending permission
    const request: PermissionRequest = {
      request_id: "req-deny-1",
      tool_name: "Bash",
      input: { command: "rm -rf /" },
      tool_use_id: "tu-deny-1",
      timestamp: Date.now(),
    };
    useStore.getState().addPermission("s1", request);
    expect(useStore.getState().pendingPermissions.get("s1")!.has("req-deny-1")).toBe(true);

    // Fire permission_denied with request_id
    fireMessage({
      type: "permission_denied",
      id: "denial-req-deny-1",
      request_id: "req-deny-1",
      tool_name: "Bash",
      tool_use_id: "tu-deny-1",
      summary: "Denied Bash",
      timestamp: Date.now(),
    });

    // Permission should be removed from pending
    const perms = useStore.getState().pendingPermissions.get("s1");
    expect(perms!.has("req-deny-1")).toBe(false);

    // System message should be appended with denied variant
    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.some((m) => m.variant === "denied")).toBe(true);
  });
});

// ===========================================================================
// sendToSession: returns boolean indicating success
// ===========================================================================
describe("sendToSession return value", () => {
  it("returns true when WebSocket is open", () => {
    wsModule.connectSession("s1");
    const result = wsModule.sendToSession("s1", { type: "interrupt" });
    expect(result).toBe(true);
  });

  it("returns false when WebSocket is closed", () => {
    wsModule.connectSession("s1");
    lastWs.readyState = MockWebSocket.CLOSED;
    const result = wsModule.sendToSession("s1", { type: "interrupt" });
    expect(result).toBe(false);
  });

  it("returns false when session has no socket", () => {
    const result = wsModule.sendToSession("nonexistent", { type: "interrupt" });
    expect(result).toBe(false);
  });
});

// ===========================================================================
// agentSource propagation
// ===========================================================================
describe("agentSource propagation", () => {
  /** Live user_message events with agentSource should populate the ChatMessage.agentSource field. */
  it("propagates agentSource from live user_message to ChatMessage", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "user_message",
      content: "Run tests",
      timestamp: 1000,
      id: "user-1000-0",
      agentSource: { sessionId: "abc123", sessionLabel: "#3 orchestrator" },
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Run tests");
    expect(msgs[0].agentSource).toEqual({
      sessionId: "abc123",
      sessionLabel: "#3 orchestrator",
    });
  });

  it("does not set agentSource when absent from live user_message", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "user_message",
      content: "Normal message",
      timestamp: 1000,
      id: "user-1000-0",
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].agentSource).toBeUndefined();
  });

  it("does not treat user message metadata as the authoritative VS Code selection state", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setVsCodeSelectionContext({
      selection: {
        absolutePath: "/home/user/existing.ts",
        startLine: 1,
        endLine: 1,
        lineCount: 1,
      },
      updatedAt: 100,
      sourceId: "vscode:window-existing",
      sourceType: "vscode-window",
    });

    fireMessage({
      type: "user_message",
      content: "check this file",
      timestamp: 1234,
      vscodeSelection: {
        absolutePath: "/home/user/web/src/App.tsx",
        relativePath: "web/src/App.tsx",
        displayPath: "App.tsx",
        startLine: 42,
        endLine: 44,
        lineCount: 3,
      },
    });

    const state = useStore.getState();
    expect(state.vscodeSelectionContext).toEqual({
      selection: {
        absolutePath: "/home/user/existing.ts",
        startLine: 1,
        endLine: 1,
        lineCount: 1,
      },
      updatedAt: 100,
      sourceId: "vscode:window-existing",
      sourceType: "vscode-window",
    });
    expect(state.messages.get("s1")?.[0].metadata?.vscodeSelection).toEqual({
      absolutePath: "/home/user/web/src/App.tsx",
      relativePath: "web/src/App.tsx",
      displayPath: "App.tsx",
      startLine: 42,
      endLine: 44,
      lineCount: 3,
    });
  });

  /** message_history replay should also preserve agentSource on user messages. */
  it("propagates agentSource from message_history replay", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "user_message",
          content: "Check PRs",
          timestamp: 2000,
          id: "user-2000-0",
          agentSource: { sessionId: "cron:pr-check", sessionLabel: "cron: PR Check" },
        },
        {
          type: "assistant",
          message: {
            id: "msg-hist-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "Done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].agentSource).toEqual({
      sessionId: "cron:pr-check",
      sessionLabel: "cron: PR Check",
    });
    // Assistant message should not have agentSource
    expect(msgs[1].agentSource).toBeUndefined();
  });
});

// ===========================================================================
// mid-stream follow-up: sticky turn expansion override
// ===========================================================================
describe("mid-stream follow-up turn expansion", () => {
  /** When a user_message arrives while the session is running, the in-flight
   *  turn should get a sticky "expanded" override so it doesn't collapse
   *  when sessionStatus flickers to "idle" after the interrupted result. */
  it("tracks transient auto-expansion for the in-flight turn when user_message arrives during running", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Simulate an active session with a user message + agent streaming
    fireMessage({
      type: "user_message",
      id: "u1",
      content: "First request",
      timestamp: 1000,
    });
    // Set session to running (agent is streaming)
    useStore.getState().setSessionStatus("s1", "running");

    // Send a follow-up message while streaming
    fireMessage({
      type: "user_message",
      id: "u2",
      content: "Follow-up during stream",
      timestamp: 2000,
    });

    // The auto-expanded turn set should track the in-flight turn (u1).
    const autoExpandedTurns = useStore.getState().autoExpandedTurnIds.get("s1");
    expect(autoExpandedTurns).toBeTruthy();
    expect(autoExpandedTurns!.has("u1")).toBe(true);
    // Manual overrides should remain untouched.
    expect(useStore.getState().turnActivityOverrides.get("s1")?.get("u1")).toBeUndefined();
  });

  it("does not set override when session is idle", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "user_message",
      id: "u1",
      content: "First request",
      timestamp: 1000,
    });
    useStore.getState().setSessionStatus("s1", "idle");

    fireMessage({
      type: "user_message",
      id: "u2",
      content: "Follow-up after idle",
      timestamp: 2000,
    });

    const autoExpandedTurns = useStore.getState().autoExpandedTurnIds.get("s1");
    expect(autoExpandedTurns?.has("u1")).toBeUndefined();
  });

  it("clears transient auto-expansion when message_history replaces the session feed", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "user_message",
      id: "u1",
      content: "First request",
      timestamp: 1000,
    });
    useStore.getState().setSessionStatus("s1", "running");
    fireMessage({
      type: "user_message",
      id: "u2",
      content: "Follow-up during stream",
      timestamp: 2000,
    });

    expect(useStore.getState().autoExpandedTurnIds.get("s1")?.has("u1")).toBe(true);

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", id: "u1", content: "First request", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "Recovered reply" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 3000,
        },
      ],
    });

    expect(useStore.getState().autoExpandedTurnIds.has("s1")).toBe(false);
  });
});
