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
describe("handleMessage: state_snapshot", () => {
  it("updates session status, CLI connection, and askPermission from snapshot", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: "running",
      permissionMode: "acceptEdits",
      backendConnected: true,
      uiMode: null,
      askPermission: false,
    });

    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);
    expect(useStore.getState().cliEverConnected.get("s1")).toBe(true);
    expect(useStore.getState().askPermission.get("s1")).toBe(false);
  });

  it("stores backendState and backendError from the authoritative snapshot", () => {
    // The browser should trust the server snapshot for broken/recovering
    // backend health rather than inferring it from transient local state.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "state_snapshot",
      sessionStatus: null,
      permissionMode: "default",
      backendConnected: false,
      backendState: "broken",
      backendError: "Codex initialization failed: Transport closed",
      uiMode: null,
      askPermission: true,
    });

    const session = useStore.getState().sessions.get("s1");
    expect(session?.backend_state).toBe("broken");
    expect(session?.backend_error).toBe("Codex initialization failed: Transport closed");
  });

  it("sets backendConnected to false and sessionStatus to null when CLI is disconnected", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // First set connected
    fireMessage({
      type: "state_snapshot",
      sessionStatus: "idle",
      permissionMode: "default",
      backendConnected: true,
      uiMode: null,
      askPermission: true,
    });
    expect(useStore.getState().cliConnected.get("s1")).toBe(true);

    // Then snapshot with CLI disconnected
    fireMessage({
      type: "state_snapshot",
      sessionStatus: null,
      permissionMode: "default",
      backendConnected: false,
      uiMode: null,
      askPermission: true,
    });
    expect(useStore.getState().cliConnected.get("s1")).toBe(false);
    expect(useStore.getState().sessionStatus.get("s1")).toBeNull();
  });
});
