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
describe("handleMessage: history_sync", () => {
  it("appends frozen delta and replaces the hot tail", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setMessages(
      "s1",
      [
        { id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 },
        { id: "hot-1", role: "assistant", content: "stale hot", timestamp: 2000 },
      ],
      { frozenCount: 1 },
    );

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
      hot_messages: [{ type: "user_message", id: "hot-2", content: "new hot user", timestamp: 4000 }],
      frozen_count: 2,
      expected_frozen_hash: "server-frozen-hash",
      expected_full_hash: "server-full-hash",
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.map((m) => m.id)).toEqual(["frozen-1", "frozen-2", "hot-2"]);
    expect(msgs[2]?.content).toBe("new hot user");
    expect(useStore.getState().messageFrozenCounts.get("s1")).toBe(2);
    // Server-authoritative hash is stored for use on next reconnect
    expect(useStore.getState().messageFrozenHashes.get("s1")).toBe("server-frozen-hash");
  });

  it("clears the prior hot tail when history_sync hot_messages is empty", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setMessages(
      "s1",
      [
        { id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 },
        { id: "hot-1", role: "assistant", content: "stale hot", timestamp: 2000 },
      ],
      { frozenCount: 1 },
    );

    fireMessage({
      type: "history_sync",
      frozen_base_count: 1,
      frozen_delta: [],
      hot_messages: [],
      frozen_count: 1,
      expected_frozen_hash: "frozen-only-hash",
      expected_full_hash: "frozen-only-hash",
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.map((m) => m.id)).toEqual(["frozen-1"]);
    expect(useStore.getState().messageFrozenCounts.get("s1")).toBe(1);
  });

  it("stores server-provided frozen hash for use on next reconnect", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setMessages("s1", [{ id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 }], {
      frozenCount: 1,
    });

    fireMessage({
      type: "history_sync",
      frozen_base_count: 1,
      frozen_delta: [],
      hot_messages: [],
      frozen_count: 1,
      expected_frozen_hash: "server1234",
      expected_full_hash: "serverfull",
    });

    expect(useStore.getState().messageFrozenHashes.get("s1")).toBe("server1234");
  });

  it("clears stale pending Codex inputs when history_sync hot messages include the committed user message", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: { ...makeSession("s1"), backend_type: "codex" } });

    useStore
      .getState()
      .setMessages("s1", [{ id: "frozen-1", role: "assistant", content: "older message", timestamp: 500 }], {
        frozenCount: 1,
      });
    useStore.getState().setPendingCodexInputs("s1", [
      {
        id: "pending-hot-1",
        content: "queued hot tail",
        timestamp: 1000,
        cancelable: true,
      } as any,
    ]);

    fireMessage({
      type: "history_sync",
      frozen_base_count: 1,
      frozen_delta: [],
      hot_messages: [{ type: "user_message", id: "pending-hot-1", content: "queued hot tail", timestamp: 1000 }],
      frozen_count: 1,
      expected_frozen_hash: "frozen-hash",
      expected_full_hash: "full-hash",
    });

    expect(useStore.getState().pendingCodexInputs.has("s1")).toBe(false);
  });

  it("clears stale live subagent state when message_history replaces the session feed", () => {
    // q-327: authoritative history replay must clear client-derived live
    // subagent state, otherwise stale running chips can survive reconnect.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setStreaming("s1", "child output", "task-live-1");
    useStore.getState().setStreamingThinking("s1", "child reasoning", "task-live-1");
    useStore.getState().setToolProgress("s1", "task-live-1", {
      toolName: "Task",
      elapsedSeconds: 120,
      outputDelta: "still running",
    });
    useStore.getState().setToolResult("s1", "task-live-1", {
      tool_use_id: "task-live-1",
      content: "stale result",
      is_error: false,
      total_size: 11,
      is_truncated: false,
    });
    useStore.getState().setBackgroundAgentNotif("s1", "task-live-1", {
      status: "running",
      summary: "stale background agent",
    });
    useStore.getState().setToolStartTimestamps("s1", {
      "task-live-1": 1234,
    });

    fireMessage({
      type: "message_history",
      messages: [
        { type: "user_message", id: "u1", content: "Fresh request", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "msg-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "Fresh reply" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 3000,
        },
      ],
    });

    const state = useStore.getState();
    expect(state.streamingByParentToolUseId.has("s1")).toBe(false);
    expect(state.streamingThinkingByParentToolUseId.has("s1")).toBe(false);
    expect(state.toolProgress.has("s1")).toBe(false);
    expect(state.toolResults.has("s1")).toBe(false);
    expect(state.backgroundAgentNotifs.has("s1")).toBe(false);
    expect(state.toolStartTimestamps.has("s1")).toBe(false);
  });

  it("clears stale live subagent state when history_sync replaces the hot tail", () => {
    // q-327: history_sync is also an authoritative replacement path and must
    // drop stale live progress before rebuilding from server data, while the
    // frozen prefix keeps its already-authoritative historical tool state.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setMessages("s1", [{ id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 }], {
      frozenCount: 1,
    });
    useStore.getState().setToolProgress("s1", "task-live-2", {
      toolName: "Task",
      elapsedSeconds: 55,
      outputDelta: "stale progress",
    });
    useStore.getState().setToolStartTimestamps("s1", {
      "task-live-2": 4321,
    });

    fireMessage({
      type: "history_sync",
      frozen_base_count: 1,
      frozen_delta: [],
      hot_messages: [
        {
          type: "assistant",
          message: {
            id: "msg-fresh",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "Fresh synced reply" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
        },
      ],
      frozen_count: 1,
      expected_frozen_hash: "frozen-hash",
      expected_full_hash: "full-hash",
    });

    const state = useStore.getState();
    expect(state.toolProgress.has("s1")).toBe(false);
  });

  it("rebuilds fresh live tool state from message_history after clearing stale entries", () => {
    // q-327: authoritative message_history should not just clear stale live
    // tool state — it must also repopulate fresh tool results, notifications,
    // and tool-start timestamps from the replay payload.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setToolProgress("s1", "task-stale", {
      toolName: "Task",
      elapsedSeconds: 99,
      outputDelta: "stale progress",
    });
    useStore.getState().setToolResult("s1", "task-stale", {
      tool_use_id: "task-stale",
      content: "stale result",
      is_error: false,
      total_size: 11,
      is_truncated: false,
    });
    useStore.getState().setBackgroundAgentNotif("s1", "task-stale", {
      status: "running",
      summary: "stale notif",
    });
    useStore.getState().setToolStartTimestamps("s1", {
      "task-stale": 1111,
    });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "assistant",
          message: {
            id: "msg-task",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [
              {
                type: "tool_use",
                id: "task-fresh",
                name: "Task",
                input: { description: "Fresh child", subagent_type: "explorer" },
              },
            ],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
          tool_start_times: { "task-fresh": 2222 },
        },
        {
          type: "tool_result_preview",
          previews: [
            {
              tool_use_id: "task-fresh",
              content: "fresh result",
              is_error: false,
              total_size: 12,
              is_truncated: false,
            },
          ],
        },
        {
          type: "task_notification",
          task_id: "bg-1",
          tool_use_id: "task-fresh",
          status: "completed",
          summary: "fresh notification",
        },
      ],
    });

    const state = useStore.getState();
    expect(state.toolProgress.has("s1")).toBe(false);
    expect(state.toolResults.get("s1")?.has("task-stale")).toBe(false);
    expect(state.backgroundAgentNotifs.get("s1")?.has("task-stale")).toBe(false);
    expect(state.toolStartTimestamps.get("s1")?.has("task-stale")).toBe(false);
    expect(state.toolResults.get("s1")?.get("task-fresh")?.content).toBe("fresh result");
    expect(state.backgroundAgentNotifs.get("s1")?.get("task-fresh")?.summary).toBe("fresh notification");
    expect(state.toolStartTimestamps.get("s1")?.get("task-fresh")).toBe(2222);
  });

  it("rebuilds fresh live tool state from history_sync after clearing stale entries", () => {
    // q-327: history_sync follows the same authoritative replacement rule as
    // message_history for fresh incoming entries, but it also preserves the
    // reused frozen prefix's historical tool/subagent state.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setMessages("s1", [{ id: "frozen-1", role: "user", content: "old frozen", timestamp: 1000 }], {
      frozenCount: 1,
    });
    useStore.getState().setToolResult("s1", "task-stale", {
      tool_use_id: "task-stale",
      content: "stale result",
      is_error: false,
      total_size: 11,
      is_truncated: false,
    });
    useStore.getState().setBackgroundAgentNotif("s1", "task-stale", {
      status: "running",
      summary: "stale notif",
    });
    useStore.getState().setToolStartTimestamps("s1", {
      "task-stale": 3333,
    });
    useStore.getState().setToolProgress("s1", "task-stale", {
      toolName: "Task",
      elapsedSeconds: 21,
      outputDelta: "stale progress",
    });

    fireMessage({
      type: "history_sync",
      frozen_base_count: 1,
      frozen_delta: [],
      hot_messages: [
        {
          type: "assistant",
          message: {
            id: "msg-fresh-sync",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [
              {
                type: "tool_use",
                id: "task-fresh-sync",
                name: "Task",
                input: { description: "Fresh synced child", subagent_type: "explorer" },
              },
            ],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
          tool_start_times: { "task-fresh-sync": 4444 },
        },
        {
          type: "tool_result_preview",
          previews: [
            {
              tool_use_id: "task-fresh-sync",
              content: "fresh synced result",
              is_error: false,
              total_size: 19,
              is_truncated: false,
            },
          ],
        },
        {
          type: "task_notification",
          task_id: "bg-2",
          tool_use_id: "task-fresh-sync",
          status: "completed",
          summary: "fresh synced notification",
        },
      ],
      frozen_count: 1,
      expected_frozen_hash: "frozen-hash",
      expected_full_hash: "full-hash",
    });

    const state = useStore.getState();
    expect(state.toolProgress.has("s1")).toBe(false);
    expect(state.toolResults.get("s1")?.get("task-fresh-sync")?.content).toBe("fresh synced result");
    expect(state.backgroundAgentNotifs.get("s1")?.get("task-fresh-sync")?.summary).toBe("fresh synced notification");
    expect(state.toolStartTimestamps.get("s1")?.get("task-fresh-sync")).toBe(4444);
  });

  it("preserves frozen-prefix tool state across history_sync reuse while replacing the hot tail", () => {
    // q-327: history_sync reuses the browser's frozen prefix, so completed
    // tool/subagent state from that prefix must survive while stale hot-tail
    // live state is cleared and replaced by fresh server data.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setMessages(
      "s1",
      [
        {
          id: "frozen-task-parent",
          role: "assistant",
          content: "",
          timestamp: 1000,
          contentBlocks: [
            {
              type: "tool_use",
              id: "task-frozen",
              name: "Task",
              input: { description: "Frozen child", subagent_type: "explorer" },
            },
          ],
        },
        { id: "hot-1", role: "assistant", content: "stale hot", timestamp: 2000 },
      ],
      { frozenCount: 1 },
    );
    useStore.getState().setToolResult("s1", "task-frozen", {
      tool_use_id: "task-frozen",
      content: "frozen result",
      is_error: false,
      total_size: 13,
      is_truncated: false,
    });
    useStore.getState().setBackgroundAgentNotif("s1", "task-frozen", {
      status: "completed",
      summary: "frozen notification",
    });
    useStore.getState().setToolStartTimestamps("s1", {
      "task-frozen": 1111,
      "task-stale-hot": 2222,
    });
    useStore.getState().setToolProgress("s1", "task-stale-hot", {
      toolName: "Task",
      elapsedSeconds: 55,
      outputDelta: "stale progress",
    });

    fireMessage({
      type: "history_sync",
      frozen_base_count: 1,
      frozen_delta: [],
      hot_messages: [
        {
          type: "assistant",
          message: {
            id: "msg-fresh-sync-2",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [
              {
                type: "tool_use",
                id: "task-fresh-sync-2",
                name: "Task",
                input: { description: "Fresh synced child", subagent_type: "explorer" },
              },
            ],
            stop_reason: null,
            usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 3000,
          tool_start_times: { "task-fresh-sync-2": 4444 },
        },
        {
          type: "tool_result_preview",
          previews: [
            {
              tool_use_id: "task-fresh-sync-2",
              content: "fresh synced result 2",
              is_error: false,
              total_size: 21,
              is_truncated: false,
            },
          ],
        },
        {
          type: "task_notification",
          task_id: "bg-3",
          tool_use_id: "task-fresh-sync-2",
          status: "completed",
          summary: "fresh synced notification 2",
        },
      ],
      frozen_count: 1,
      expected_frozen_hash: "frozen-hash",
      expected_full_hash: "full-hash",
    });

    const state = useStore.getState();
    expect(state.toolResults.get("s1")?.get("task-frozen")?.content).toBe("frozen result");
    expect(state.backgroundAgentNotifs.get("s1")?.get("task-frozen")?.summary).toBe("frozen notification");
    expect(state.toolStartTimestamps.get("s1")?.get("task-frozen")).toBe(1111);
    expect(state.toolResults.get("s1")?.has("task-stale-hot")).toBe(false);
    expect(state.backgroundAgentNotifs.get("s1")?.has("task-stale-hot")).toBe(false);
    expect(state.toolStartTimestamps.get("s1")?.has("task-stale-hot")).toBe(false);
    expect(state.toolProgress.has("s1")).toBe(false);
    expect(state.toolResults.get("s1")?.get("task-fresh-sync-2")?.content).toBe("fresh synced result 2");
    expect(state.backgroundAgentNotifs.get("s1")?.get("task-fresh-sync-2")?.summary).toBe(
      "fresh synced notification 2",
    );
    expect(state.toolStartTimestamps.get("s1")?.get("task-fresh-sync-2")).toBe(4444);
  });
});
