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

  it("clears stale retryable Codex init errors after recovery connects", () => {
    // Mirrors the q-949/#1132 race: a retryable init failure may have reached
    // the browser before bridge recovery proved the session was still alive.
    // Once recovery connects, that stale terminal-looking bubble should go away.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: { ...makeSession("s1"), backend_type: "codex" } });
    fireMessage({
      type: "error",
      message:
        "Codex initialization failed: Transport closed. Stderr: [mai-codex-wrapper] " +
        "wrapper_pid=63170 ppid=61864 companion_session=s1 cwd=/repo",
    });
    expect(
      useStore
        .getState()
        .messages.get("s1")
        ?.map((msg) => msg.content),
    ).toContain(
      "Codex initialization failed: Transport closed. Stderr: [mai-codex-wrapper] " +
        "wrapper_pid=63170 ppid=61864 companion_session=s1 cwd=/repo",
    );

    fireMessage({ type: "session_update", session: { backend_state: "recovering", backend_error: null } });
    fireMessage({ type: "backend_disconnected" });
    fireMessage({ type: "session_update", session: { backend_state: "connected", backend_error: null } });
    fireMessage({ type: "backend_connected" });
    vi.advanceTimersByTime(300);

    const contents =
      useStore
        .getState()
        .messages.get("s1")
        ?.map((msg) => msg.content) ?? [];
    expect(contents.some((content) => content.includes("Codex initialization failed: Transport closed"))).toBe(false);
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
  });

  it.each([
    "Error: error loading default config after config error: No such file or directory (os error 2)",
    'MCP server "codex_apps" startup failed during initialize',
    "rmcp::transport::worker quit with fatal: Transport channel closed",
    "TokenRefreshFailed while starting MCP server",
    "OAuth refresh failed: invalid_grant",
  ])("preserves actionable Codex init errors after backend connects: %s", (stderr) => {
    // Config/auth/MCP failures can also arrive wrapped in Transport closed.
    // Those remain visible because they are actionable terminal errors, not
    // transient post-restart startup closes.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: { ...makeSession("s1"), backend_type: "codex" } });
    fireMessage({
      type: "error",
      message: `Codex initialization failed: Transport closed. Stderr: ${stderr}`,
    });

    fireMessage({ type: "session_update", session: { backend_state: "connected", backend_error: null } });
    fireMessage({ type: "backend_connected" });

    const contents =
      useStore
        .getState()
        .messages.get("s1")
        ?.map((msg) => msg.content) ?? [];
    expect(contents.some((content) => content.includes(stderr))).toBe(true);
  });
});
