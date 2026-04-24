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
