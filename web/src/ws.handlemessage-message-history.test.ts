// @vitest-environment jsdom

import type { SessionState, PermissionRequest, ContentBlock, BrowserIncomingMessage } from "./types.js";
import { computeHistoryMessagesSyncHash } from "../shared/history-sync-hash.js";
import { HISTORY_WINDOW_SECTION_TURN_COUNT, HISTORY_WINDOW_VISIBLE_SECTION_COUNT } from "../shared/history-window.js";

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
    expect(useStore.getState().historyLoading.has("s1")).toBe(false);
  });

  it("resolves pending deep-link indexes against raw messageHistory indexes when entries are skipped", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setPendingScrollToMessageIndex("s1", 2);

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", id: "u-raw-0", content: "Run the tool", timestamp: 1000 },
        {
          type: "tool_result_preview",
          previews: [
            {
              tool_use_id: "tool-1",
              content: "Hidden preview",
              is_error: false,
              total_size: 14,
              is_truncated: false,
            },
          ],
        },
        {
          type: "assistant",
          timestamp: 2000,
          parent_tool_use_id: null,
          message: {
            id: "a-raw-2",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "Visible answer" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.map((msg) => ({ id: msg.id, historyIndex: msg.historyIndex }))).toEqual([
      { id: "u-raw-0", historyIndex: 0 },
      { id: "a-raw-2", historyIndex: 2 },
    ]);
    expect(useStore.getState().scrollToMessageId.get("s1")).toBe("a-raw-2");
    expect(useStore.getState().expandAllInTurn.get("s1")).toBe("a-raw-2");
  });

  it("clears stale todo state on history replay once a result is encountered", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore
      .getState()
      .setTasks("s1", [{ id: "stale-1", subject: "Old task", description: "", status: "in_progress" }]);
    useStore.getState().setSessionTaskPreview("s1", "Old task");

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "assistant",
          message: {
            id: "msg-hist-todo-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [
              {
                type: "tool_use",
                id: "hist-todo-1",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "Inspect worktree", status: "in_progress", activeForm: "Inspecting worktree" },
                    { content: "Run tests", status: "pending" },
                  ],
                },
              },
            ],
            stop_reason: "tool_use",
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
            uuid: "u-hist-clear",
            session_id: "s1",
          },
        },
      ],
    });

    expect(useStore.getState().sessionTasks.get("s1")).toEqual([]);
    expect(useStore.getState().sessionTaskPreview.has("s1")).toBe(false);
  });

  it("ignores deprecated leader_user_addressed metadata from history", () => {
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
    expect(msgs[0]).not.toHaveProperty("leaderUserAddressed");
    expect(msgs[0].content).toBe("done @to(user)");
  });

  it("keeps history sync hashes stable when deprecated leader_user_addressed metadata appears", () => {
    const baseHistory: BrowserIncomingMessage[] = [
      {
        type: "assistant",
        message: {
          id: "msg-hash-1",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-20250514",
          content: [{ type: "text", text: "done @to(user)" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: 1000,
      },
    ];

    const deprecatedHistory = [
      {
        ...(baseHistory[0] as Extract<BrowserIncomingMessage, { type: "assistant" }>),
        leader_user_addressed: true,
      },
    ] as unknown as BrowserIncomingMessage[];

    expect(computeHistoryMessagesSyncHash(baseHistory)).toEqual(computeHistoryMessagesSyncHash(deprecatedHistory));
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
      messages: [{ type: "user_message", id: "user-1", content: "old message", timestamp: 1000 }],
    });
    expect(useStore.getState().messages.get("s1")).toHaveLength(1);
    expect(useStore.getState().messages.get("s1")![0].content).toBe("old message");

    // Second history load with different messages — should REPLACE, not merge
    fireMessage({
      type: "message_history",
      messages: [{ type: "user_message", id: "user-2", content: "new message", timestamp: 2000 }],
    });
    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("new message");
    // Old message should NOT be present
    expect(msgs.find((m) => m.content === "old message")).toBeUndefined();
  });

  it("trims replay-style duplicated assistant text tails inside authoritative history replay", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "assistant",
          message: {
            id: "msg-dup-history",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [
              { type: "text", text: "Noted VIP Ben results." },
              { type: "tool_use", id: "task-1", name: "Task", input: { description: "Check Ben" } },
              { type: "text", text: "Noted VIP Ben results." },
              { type: "text", text: "Noted VIP Ben results." },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Noted VIP Ben results.");
    expect(msgs[0].contentBlocks).toEqual([
      { type: "text", text: "Noted VIP Ben results." },
      { type: "tool_use", id: "task-1", name: "Task", input: { description: "Check Ben" } },
    ]);
  });

  it("preserves legitimate repeated assistant text blocks when no replay-style tool overlap is present", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "assistant",
          message: {
            id: "msg-legit-repeat",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [
              { type: "text", text: "echo" },
              { type: "text", text: "echo" },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("echo\necho");
    expect(msgs[0].contentBlocks).toEqual([
      { type: "text", text: "echo" },
      { type: "text", text: "echo" },
    ]);
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
