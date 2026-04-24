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
describe("handleMessage: history_window_sync", () => {
  it("replaces local messages with the requested history window and records window metadata", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore
      .getState()
      .setMessages("s1", [{ id: "stale", role: "assistant", content: "stale", timestamp: 1 }], { frozenCount: 0 });

    fireMessage({
      type: "history_window_sync",
      messages: [
        { type: "user_message", id: "u-window", content: "window user", timestamp: 1000 },
        {
          type: "assistant",
          message: {
            id: "a-window",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "window reply" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
          timestamp: 2000,
        },
      ],
      window: {
        from_turn: 100,
        turn_count: 150,
        total_turns: 320,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      },
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.map((m) => m.id)).toEqual(["u-window", "a-window"]);
    expect(useStore.getState().historyWindows.get("s1")).toEqual({
      from_turn: 100,
      turn_count: 150,
      total_turns: 320,
      section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
    });
  });

  it("does not overwrite the session preview when loading an older history window", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setSessionPreview("s1", "latest preview");

    fireMessage({
      type: "history_window_sync",
      messages: [{ type: "user_message", id: "u-older", content: "older historical text", timestamp: 1000 }],
      window: {
        from_turn: 10,
        turn_count: 50,
        total_turns: 500,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      },
    });

    expect(useStore.getState().sessionPreviews.get("s1")).toBe("latest preview");
  });

  it("updates the session preview when the loaded window includes the latest turn", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setSessionPreview("s1", "stale preview");

    fireMessage({
      type: "history_window_sync",
      messages: [{ type: "user_message", id: "u-latest", content: "newest visible text", timestamp: 1000 }],
      window: {
        from_turn: 450,
        turn_count: 50,
        total_turns: 500,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      },
    });

    expect(useStore.getState().sessionPreviews.get("s1")).toBe("newest visible text");
  });

  it("clears window metadata when a full history_sync later arrives", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setHistoryWindow("s1", {
      from_turn: 10,
      turn_count: 150,
      total_turns: 200,
      section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
    });

    fireMessage({
      type: "history_sync",
      frozen_base_count: 0,
      frozen_delta: [{ type: "user_message", id: "u-full", content: "full history", timestamp: 1000 }],
      hot_messages: [],
      frozen_count: 1,
      expected_frozen_hash: "full-frozen",
      expected_full_hash: "full-hash",
    });

    expect(useStore.getState().historyWindows.has("s1")).toBe(false);
  });
});
