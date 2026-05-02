// @vitest-environment jsdom

import type { SessionState, PermissionRequest, ContentBlock, BrowserIncomingMessage } from "./types.js";
import { computeHistoryMessagesSyncHash } from "../shared/history-sync-hash.js";
import { HISTORY_WINDOW_SECTION_TURN_COUNT, HISTORY_WINDOW_VISIBLE_SECTION_COUNT } from "../shared/history-window.js";
import { FEED_WINDOW_SYNC_VERSION } from "../shared/feed-window-sync.js";

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
    // messages and a server-provided frozen hash
    localStorage.setItem("companion:last-seq:s1", "12");
    useStore.getState().setMessages(
      "s1",
      [
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
      ],
      { frozenCount: 1, frozenHash: "abcd1234" },
    );
    wsModule.connectSession("s1");

    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 12,
        known_frozen_count: 1,
        known_frozen_hash: "abcd1234",
      }),
    );
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
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
        known_frozen_count: 0,
        history_window_section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        history_window_visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
        feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
      }),
    );
  });

  it("sends last_seq: 0 when localStorage has no entry", () => {
    // Brand new session — no localStorage, no store messages
    wsModule.connectSession("s1");

    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
        known_frozen_count: 0,
        history_window_section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        history_window_visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
        feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
      }),
    );
  });

  it("falls back to full-history subscribe when a pending message scroll needs absolute indexes", () => {
    useStore.getState().setPendingScrollToMessageIndex("s1", 42);
    wsModule.connectSession("s1");

    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
        known_frozen_count: 0,
      }),
    );
  });

  it("treats windowed history as non-reusable and resubscribes fresh", () => {
    localStorage.setItem("companion:last-seq:s1", "50");
    useStore.getState().setMessages("s1", [{ id: "partial-msg", role: "user", content: "partial", timestamp: 1000 }], {
      frozenCount: 1,
      frozenHash: "stale-window-hash",
    });
    useStore.getState().setHistoryWindow("s1", {
      from_turn: 100,
      turn_count: 150,
      total_turns: 500,
      section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
    });

    wsModule.connectSession("s1");
    lastWs.onopen?.(new Event("open"));

    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "session_subscribe",
        last_seq: 0,
        known_frozen_count: 0,
        history_window_section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        history_window_visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
        feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
      }),
    );
  });

  it("marks history as loading when connecting to a session without local messages", () => {
    wsModule.connectSession("s1");

    expect(useStore.getState().historyLoading.get("s1")).toBe(true);
  });

  it("clears history loading when subscribe completes with only an empty state snapshot", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    expect(useStore.getState().historyLoading.get("s1")).toBe(true);

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      backendState: "connected",
      backendError: null,
      uiMode: null,
      askPermission: true,
      lastReadAt: undefined,
      attentionReason: undefined,
      generationStartedAt: null,
    });

    expect(useStore.getState().historyLoading.has("s1")).toBe(false);
  });
});
