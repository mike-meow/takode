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
describe("handleMessage: history_window_sync", () => {
  it("replaces local messages with the requested history window and preserves raw history indexes", () => {
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
          type: "tool_result_preview",
          previews: [
            {
              tool_use_id: "tool-window",
              content: "hidden preview",
              is_error: false,
              total_size: 14,
              is_truncated: false,
            },
          ],
        },
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
        start_index: 50,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      },
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.map((m) => m.id)).toEqual(["u-window", "a-window"]);
    expect(msgs.map((m) => m.historyIndex)).toEqual([50, 52]);
    expect(useStore.getState().historyWindows.get("s1")).toEqual({
      from_turn: 100,
      turn_count: 150,
      total_turns: 320,
      start_index: 50,
      section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
    });
  });

  it("reuses cached history window messages only after a server-validated cache hit", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const window = {
      from_turn: 100,
      turn_count: 1,
      total_turns: 320,
      start_index: 50,
      section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      window_hash: "history-window-hash",
    };

    fireMessage({
      type: "history_window_sync",
      messages: [{ type: "user_message", id: "u-cached", content: "cached window user", timestamp: 1000 }],
      window,
    });

    useStore
      .getState()
      .setMessages("s1", [{ id: "stale", role: "assistant", content: "stale", timestamp: 1 }], { frozenCount: 0 });

    fireMessage({
      type: "history_window_sync",
      cache_hit: true,
      messages: [],
      window,
    });

    expect(
      useStore
        .getState()
        .messages.get("s1")
        ?.map((msg) => msg.id),
    ).toEqual(["u-cached"]);
  });

  it("refetches a cache-hit history window without replacing visible state when the local cache entry is missing", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const existingWindow = {
      from_turn: 250,
      turn_count: 50,
      total_turns: 320,
      start_index: 125,
      section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
    };
    useStore
      .getState()
      .setMessages("s1", [{ id: "still-visible", role: "assistant", content: "keep me", timestamp: 1 }], {
        frozenCount: 0,
      });
    useStore.getState().setHistoryWindow("s1", existingWindow);
    lastWs.send.mockClear();

    fireMessage({
      type: "history_window_sync",
      cache_hit: true,
      messages: [],
      window: {
        from_turn: 100,
        turn_count: 150,
        total_turns: 320,
        start_index: 50,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
        window_hash: "missing-local-history-window",
      },
    });

    expect(
      useStore
        .getState()
        .messages.get("s1")
        ?.map((msg) => msg.id),
    ).toEqual(["still-visible"]);
    expect(useStore.getState().historyWindows.get("s1")).toEqual(existingWindow);
    expect(lastWs.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lastWs.send.mock.calls[0][0])).toEqual({
      type: "history_window_request",
      from_turn: 100,
      turn_count: 150,
      section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
    });
  });

  it("stores additive feed_window_sync without replacing authoritative history state", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setMessages("s1", [{ id: "visible", role: "assistant", content: "visible", timestamp: 1 }], {
      frozenCount: 0,
    });

    fireMessage({
      type: "feed_window_sync",
      sync: {
        version: FEED_WINDOW_SYNC_VERSION,
        source: "history_window",
        legacySyncType: "history_window_sync",
        threadKey: "main",
        windowHash: "hash-1",
        window: {
          from_turn: 20,
          turn_count: 10,
          total_turns: 40,
          start_index: 200,
          section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
          visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
          window_hash: "hash-1",
        },
        items: [
          {
            key: "200:u-window",
            kind: "message",
            messageId: "u-window",
            messageType: "user_message",
            historyIndex: 200,
            timestamp: 1000,
          },
        ],
        bounds: { from: 20, count: 10, total: 40 },
      },
    });

    expect(
      useStore
        .getState()
        .messages.get("s1")
        ?.map((message) => message.id),
    ).toEqual(["visible"]);
    expect(
      useStore
        .getState()
        .feedWindowSyncs.get("s1")
        ?.items.map((item) => item.messageId),
    ).toEqual(["u-window"]);
  });

  it("keeps a pending raw-index scroll when the current history window does not contain the target", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setPendingScrollToMessageIndex("s1", 49);

    fireMessage({
      type: "history_window_sync",
      messages: [{ type: "user_message", id: "u-window-50", content: "window user", timestamp: 1000 }],
      window: {
        from_turn: 100,
        turn_count: 1,
        total_turns: 320,
        start_index: 50,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      },
    });

    expect(useStore.getState().scrollToMessageId.get("s1")).toBeUndefined();
    expect(useStore.getState().pendingScrollToMessageIndex.get("s1")).toBe(49);
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

  it("sanitizes reply context in the session preview from loaded history", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "history_window_sync",
      messages: [
        {
          type: "user_message",
          id: "u-reply",
          content: "continue the work",
          replyContext: { previewText: "Original answer", messageId: "codex-agent-random-id" },
          timestamp: 1000,
        },
      ],
      window: {
        from_turn: 450,
        turn_count: 50,
        total_turns: 500,
        section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
        visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
      },
    });

    expect(useStore.getState().sessionPreviews.get("s1")).toBe("[reply] continue the work");
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

describe("handleMessage: thread_window_sync", () => {
  it("stores selected-feed window messages without replacing raw history state", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore
      .getState()
      .setMessages("s1", [{ id: "raw-existing", role: "user", content: "raw", timestamp: 1 }], { frozenCount: 1 });
    useStore.getState().setHistoryWindow("s1", {
      from_turn: 10,
      turn_count: 5,
      total_turns: 100,
      start_index: 50,
      section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
    });

    fireMessage({
      type: "thread_window_sync",
      thread_key: "q-1040",
      entries: [
        {
          history_index: 120,
          message: {
            type: "user_message",
            id: "u-thread",
            content: "selected feed message",
            timestamp: 2000,
            threadKey: "q-1040",
            questId: "q-1040",
            threadRefs: [{ threadKey: "q-1040", questId: "q-1040", source: "explicit" }],
          },
        },
        {
          history_index: 121,
          synthetic: true,
          message: {
            type: "cross_thread_activity_marker",
            id: "cross-thread-activity:project-notes:u-project",
            timestamp: 2100,
            threadKey: "project-notes",
            count: 2,
            firstMessageId: "u-project",
            lastMessageId: "a-project",
            firstHistoryIndex: 12,
            lastHistoryIndex: 13,
            startedAt: 2050,
            updatedAt: 2100,
          },
        },
      ],
      window: {
        thread_key: "q-1040",
        from_item: 20,
        item_count: 2,
        total_items: 40,
        source_history_length: 150,
        section_item_count: 10,
        visible_item_count: 2,
      },
    });

    expect(
      useStore
        .getState()
        .messages.get("s1")
        ?.map((message) => message.id),
    ).toEqual(["raw-existing"]);
    expect(useStore.getState().historyWindows.get("s1")).toEqual({
      from_turn: 10,
      turn_count: 5,
      total_turns: 100,
      start_index: 50,
      section_turn_count: HISTORY_WINDOW_SECTION_TURN_COUNT,
      visible_section_count: HISTORY_WINDOW_VISIBLE_SECTION_COUNT,
    });
    expect(useStore.getState().threadWindows.get("s1")?.get("q-1040")).toEqual({
      thread_key: "q-1040",
      from_item: 20,
      item_count: 2,
      total_items: 40,
      source_history_length: 150,
      section_item_count: 10,
      visible_item_count: 2,
    });
    expect(
      useStore
        .getState()
        .threadWindowMessages.get("s1")
        ?.get("q-1040")
        ?.map((message) => message.id),
    ).toEqual(["u-thread", "cross-thread-activity:project-notes:u-project"]);
    expect(
      useStore
        .getState()
        .threadWindowMessages.get("s1")
        ?.get("q-1040")
        ?.map((message) => message.historyIndex),
    ).toEqual([120, 121]);
  });

  it("reuses cached thread window entries only after a server-validated cache hit", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const window = {
      thread_key: "q-1040",
      from_item: 20,
      item_count: 1,
      total_items: 40,
      source_history_length: 150,
      section_item_count: 10,
      visible_item_count: 2,
      window_hash: "thread-window-hash",
    };

    fireMessage({
      type: "thread_window_sync",
      thread_key: "q-1040",
      entries: [
        {
          history_index: 120,
          message: {
            type: "user_message",
            id: "u-thread-cached",
            content: "selected feed message",
            timestamp: 2000,
            threadKey: "q-1040",
            questId: "q-1040",
            threadRefs: [{ threadKey: "q-1040", questId: "q-1040", source: "explicit" }],
          },
        },
      ],
      window,
    });

    fireMessage({
      type: "thread_window_sync",
      cache_hit: true,
      thread_key: "q-1040",
      entries: [],
      window,
    });

    expect(
      useStore
        .getState()
        .threadWindowMessages.get("s1")
        ?.get("q-1040")
        ?.map((message) => message.id),
    ).toEqual(["u-thread-cached"]);
  });

  it("refetches a cache-hit selected-thread window without replacing visible state when the local cache is invalid", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    const existingThreadWindow = {
      thread_key: "q-1040",
      from_item: 30,
      item_count: 10,
      total_items: 40,
      source_history_length: 150,
      section_item_count: 10,
      visible_item_count: 2,
    };
    useStore
      .getState()
      .setThreadWindow("s1", "q-1040", existingThreadWindow, [
        { id: "still-visible-thread", role: "user", content: "keep thread", timestamp: 1 },
      ]);
    localStorage.setItem("cc-thread-window-cache:v1:s1:q-1040", "{not valid json");
    lastWs.send.mockClear();

    fireMessage({
      type: "thread_window_sync",
      cache_hit: true,
      thread_key: "q-1040",
      entries: [],
      window: {
        thread_key: "q-1040",
        from_item: 20,
        item_count: 10,
        total_items: 40,
        source_history_length: 150,
        section_item_count: 10,
        visible_item_count: 2,
        window_hash: "invalid-local-thread-window",
      },
    });

    expect(
      useStore
        .getState()
        .threadWindowMessages.get("s1")
        ?.get("q-1040")
        ?.map((message) => message.id),
    ).toEqual(["still-visible-thread"]);
    expect(useStore.getState().threadWindows.get("s1")?.get("q-1040")).toEqual(existingThreadWindow);
    expect(lastWs.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lastWs.send.mock.calls[0][0])).toEqual({
      type: "thread_window_request",
      thread_key: "q-1040",
      from_item: 20,
      item_count: 10,
      section_item_count: 10,
      visible_item_count: 2,
      feed_window_sync_version: FEED_WINDOW_SYNC_VERSION,
    });
  });

  it("stores additive selected-thread feed_window_sync without replacing selected-thread messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setThreadWindow(
      "s1",
      "q-1040",
      {
        thread_key: "q-1040",
        from_item: 20,
        item_count: 1,
        total_items: 40,
        source_history_length: 150,
        section_item_count: 10,
        visible_item_count: 2,
      },
      [{ id: "visible-thread", role: "assistant", content: "visible", timestamp: 1 }],
    );

    fireMessage({
      type: "feed_window_sync",
      sync: {
        version: FEED_WINDOW_SYNC_VERSION,
        source: "thread_window",
        legacySyncType: "thread_window_sync",
        threadKey: "q-1040",
        windowHash: "hash-thread",
        window: {
          thread_key: "q-1040",
          from_item: 20,
          item_count: 1,
          total_items: 40,
          source_history_length: 150,
          section_item_count: 10,
          visible_item_count: 2,
          window_hash: "hash-thread",
        },
        items: [
          {
            key: "120:u-thread",
            kind: "message",
            messageId: "u-thread",
            messageType: "user_message",
            historyIndex: 120,
            timestamp: 1000,
          },
        ],
        bounds: { from: 20, count: 1, total: 40, sourceHistoryLength: 150 },
      },
    });

    expect(
      useStore
        .getState()
        .threadWindowMessages.get("s1")
        ?.get("q-1040")
        ?.map((message) => message.id),
    ).toEqual(["visible-thread"]);
    expect(
      useStore
        .getState()
        .threadFeedWindowSyncs.get("s1")
        ?.get("q-1040")
        ?.items.map((item) => item.messageId),
    ).toEqual(["u-thread"]);
  });
});
