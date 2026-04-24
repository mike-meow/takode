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
