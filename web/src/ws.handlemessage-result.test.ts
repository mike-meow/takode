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

  it("clears synthetic Codex /status streaming state when the terminal result arrives", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: { ...makeSession("s1"), backend_type: "codex" } });

    vi.setSystemTime(new Date(1700000000000));
    fireMessage({
      type: "assistant",
      timestamp: 1000,
      message: {
        id: "status-msg-1",
        type: "message",
        role: "assistant",
        model: "gpt-5.5",
        content: [{ type: "text", text: "Codex status\n\n- Session: idle" }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streamingStartedAt.get("s1")).toBe(1700000000000);
    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");

    fireMessage({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 4,
        total_cost_usd: 0.25,
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        uuid: "synthetic-status-result",
        session_id: "s1",
      },
    });

    const state = useStore.getState();
    expect(state.streamingStartedAt.has("s1")).toBe(false);
    expect(state.sessionStatus.get("s1")).toBe("idle");
    expect(state.sessions.get("s1")?.num_turns).toBe(4);
    expect(state.sessions.get("s1")?.total_cost_usd).toBe(0.25);
  });

  it("clears transient todo state when a turn completes", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setTasks("s1", [
      {
        id: "1",
        subject: "Inspect worktree",
        description: "",
        status: "in_progress",
        activeForm: "Inspecting worktree",
      },
      { id: "2", subject: "Run tests", description: "", status: "pending" },
    ]);
    useStore.getState().setSessionTaskPreview("s1", "Inspecting worktree");

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
        uuid: "u1-clear-tasks",
        session_id: "s1",
      },
    });

    expect(useStore.getState().sessionTasks.get("s1")).toEqual([]);
    expect(useStore.getState().sessionTaskPreview.has("s1")).toBe(false);
  });

  it("suppresses completion notifications for leader sessions without notification-anchored assistant messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore
      .getState()
      .setSdkSessions([
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

  it("plays completion notifications for leader sessions when latest assistant has a notification", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore
      .getState()
      .setSdkSessions([
        { sessionId: "s1", state: "connected", cwd: "/home/user", createdAt: Date.now(), isOrchestrator: true },
      ]);
    fireMessage({
      type: "assistant",
      notification: { category: "review", timestamp: Date.now(), summary: "Please review the PR" },
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Please review the PR" }],
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
    useStore
      .getState()
      .setSdkSessions([
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
