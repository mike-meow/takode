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

function fireMessage(data: unknown) {
  lastWs.onmessage!({ data: JSON.stringify(data) });
}

function flushSeqState() {
  vi.advanceTimersByTime(60);
}

function threadAttachmentUpdate(
  overrides: Partial<Extract<BrowserIncomingMessage, { type: "thread_attachment_update" }>> = {},
): Extract<BrowserIncomingMessage, { type: "thread_attachment_update" }> {
  return {
    type: "thread_attachment_update",
    version: 1,
    updateId: "attach-update-1",
    timestamp: 3000,
    attachedAt: 3000,
    attachedBy: "leader-1",
    historyLength: 43,
    affectedThreadKeys: ["main", "q-1087"],
    maxDistanceFromTail: 300,
    maxChangedMessages: 100,
    updates: [
      {
        target: { threadKey: "q-1087", questId: "q-1087" },
        markers: [
          {
            type: "thread_attachment_marker",
            id: "marker-1",
            timestamp: 3000,
            markerKey: "q-1087:u2",
            threadKey: "q-1087",
            questId: "q-1087",
            attachedAt: 3000,
            attachedBy: "leader-1",
            messageIds: ["u2"],
            messageIndices: [1],
            ranges: ["1"],
            count: 1,
            firstMessageId: "u2",
            firstMessageIndex: 1,
          },
        ],
        markerHistoryIndices: [42],
        changedMessages: [
          {
            historyIndex: 1,
            messageId: "u2",
            threadRefs: [{ threadKey: "q-1087", questId: "q-1087", source: "backfill" }],
          },
        ],
        ranges: ["1"],
        count: 1,
      },
    ],
    ...overrides,
  };
}

// ===========================================================================
// Connection
// ===========================================================================
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
    expect(localStorage.getItem("companion:last-seq:s1")).toBeNull();
    expect(lastWs.send).not.toHaveBeenCalledWith(JSON.stringify({ type: "session_ack", last_seq: 1 }));
    flushSeqState();
    expect(localStorage.getItem("companion:last-seq:s1")).toBe("1");
    expect(lastWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "session_ack", last_seq: 1 }));
  });

  it("batches replay ack and storage writes using the latest replayed seq", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    lastWs.send.mockClear();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

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
    expect(localStorage.getItem("companion:last-seq:s1")).toBeNull();
    expect(lastWs.send).not.toHaveBeenCalled();
    flushSeqState();
    expect(lastWs.send).toHaveBeenCalledTimes(1);
    expect(lastWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "session_ack", last_seq: 2 }));
    expect(localStorage.getItem("companion:last-seq:s1")).toBe("2");
    expect(setItemSpy.mock.calls.filter(([key]) => key === "companion:last-seq:s1")).toHaveLength(1);
  });

  it("acks but skips stale transient replay after a cold authoritative history window", () => {
    wsModule.connectSession("s1");
    lastWs.onopen?.(new Event("open"));
    lastWs.send.mockClear();

    fireMessage({
      type: "history_window_sync",
      messages: [],
      window: {
        from_turn: 0,
        turn_count: 0,
        total_turns: 0,
        start_index: 0,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      },
    });
    fireMessage({
      type: "event_replay",
      events: [
        {
          seq: 1,
          message: {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "stale" } },
            parent_tool_use_id: null,
          },
        },
        {
          seq: 2,
          message: {
            type: "pr_status_update",
            available: true,
            pr: null,
          },
        },
      ],
    });
    fireMessage({ type: "state_snapshot", sessionStatus: "idle", backendConnected: true });

    expect(useStore.getState().streaming.get("s1")).toBeUndefined();
    expect(useStore.getState().prStatus.get("s1")).toBeUndefined();
    flushSeqState();
    expect(localStorage.getItem("companion:last-seq:s1")).toBe("2");
    expect(lastWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "session_ack", last_seq: 2 }));
  });

  it("replays buffered cold transient events when the authoritative snapshot is still running", () => {
    wsModule.connectSession("s1");
    lastWs.onopen?.(new Event("open"));
    lastWs.send.mockClear();

    fireMessage({
      type: "history_window_sync",
      messages: [],
      window: {
        from_turn: 0,
        turn_count: 0,
        total_turns: 0,
        start_index: 0,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      },
    });
    fireMessage({
      type: "event_replay",
      events: [
        {
          seq: 1,
          message: {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "live" } },
            parent_tool_use_id: null,
          },
        },
      ],
    });

    expect(useStore.getState().streaming.get("s1")).toBeUndefined();

    fireMessage({ type: "state_snapshot", sessionStatus: "running", backendConnected: true });

    expect(useStore.getState().streaming.get("s1")).toBe("live");
    flushSeqState();
    expect(localStorage.getItem("companion:last-seq:s1")).toBe("1");
    expect(lastWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "session_ack", last_seq: 1 }));
  });

  it("treats cold buffered thread attachment replay after an authoritative window as refetch-only", async () => {
    wsModule.connectSession("s1");
    lastWs.onopen?.(new Event("open"));
    lastWs.send.mockClear();

    fireMessage({
      type: "history_window_sync",
      messages: [{ type: "user_message", id: "u2", content: "move me", timestamp: 1001 }],
      window: {
        from_turn: 0,
        turn_count: 1,
        total_turns: 1,
        start_index: 1,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      },
    });
    lastWs.send.mockClear();
    fireMessage({
      type: "event_replay",
      events: [{ seq: 1, message: threadAttachmentUpdate() }],
    });

    expect(
      useStore
        .getState()
        .messages.get("s1")
        ?.find((message) => message.id === "u2")?.metadata?.threadRefs,
    ).toBe(undefined);

    fireMessage({ type: "state_snapshot", sessionStatus: "running", backendConnected: true });

    const messages = useStore.getState().messages.get("s1") ?? [];
    expect(messages.find((message) => message.id === "u2")?.metadata?.threadRefs).toBeUndefined();
    expect(messages.some((message) => message.id === "marker-1")).toBe(false);
    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "history_window_request",
        from_turn: -1,
        turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT * HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
        feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
      }),
    );
    expect(lastWs.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "thread_window_request",
        thread_key: "q-1087",
        from_item: -1,
        item_count: HISTORY_WINDOW_SECTION_TURN_COUNT * HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
        section_item_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_item_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
        feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
      }),
    );

    const { getFrontendPerfEntries } = await import("./utils/frontend-perf-recorder.js");
    expect(getFrontendPerfEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "thread_attachment_update_apply",
          sessionId: "s1",
          applicationMode: "refetch_only",
          advisoryReason: "cold_buffered_replay_after_authoritative_sync",
          skippedLocalPatch: true,
          replayed: true,
          coldBufferedReplay: true,
          requestedHistoryWindowCount: 1,
          requestedThreadWindowCount: 1,
        }),
      ]),
    );
  });

  it("batches live event acks so tiny stream deltas do not send per event", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    lastWs.send.mockClear();

    fireMessage({
      type: "stream_event",
      seq: 1,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "A" } },
      parent_tool_use_id: null,
    });
    fireMessage({
      type: "stream_event",
      seq: 2,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "B" } },
      parent_tool_use_id: null,
    });

    expect(useStore.getState().streaming.get("s1")).toBe("AB");
    expect(lastWs.send).not.toHaveBeenCalled();
    expect(localStorage.getItem("companion:last-seq:s1")).toBeNull();
    flushSeqState();
    expect(lastWs.send).toHaveBeenCalledTimes(1);
    expect(lastWs.send).toHaveBeenCalledWith(JSON.stringify({ type: "session_ack", last_seq: 2 }));
    expect(localStorage.getItem("companion:last-seq:s1")).toBe("2");
  });
});
