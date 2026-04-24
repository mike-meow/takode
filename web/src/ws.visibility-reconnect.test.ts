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
describe("visibility reconnect", () => {
  it("reconnects only the current session when tab becomes visible", () => {
    useStore.getState().setSdkSessions([
      { sessionId: "s1", cwd: "/tmp/s1", createdAt: Date.now(), archived: false, state: "exited" },
      { sessionId: "s2", cwd: "/tmp/s2", createdAt: Date.now(), archived: false, state: "exited" },
    ]);
    useStore.getState().setCurrentSession("s2");

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    document.dispatchEvent(new Event("visibilitychange"));

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toBe("ws://localhost:3456/ws/browser/s2");
  });

  it("reconnects the current session when resume finds a closed socket still tracked", () => {
    useStore
      .getState()
      .setSdkSessions([{ sessionId: "s1", cwd: "/tmp/s1", createdAt: Date.now(), archived: false, state: "exited" }]);
    useStore.getState().setCurrentSession("s1");
    wsModule.connectSession("s1");
    lastWs.readyState = MockWebSocket.CLOSED;

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    document.dispatchEvent(new Event("visibilitychange"));

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1]?.url).toBe("ws://localhost:3456/ws/browser/s1");
  });

  it("force-refreshes the current session after a long hidden interval", () => {
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    useStore
      .getState()
      .setSdkSessions([
        { sessionId: "s1", cwd: "/tmp/s1", createdAt: Date.now(), archived: false, state: "connected" },
      ]);
    useStore.getState().setCurrentSession("s1");
    wsModule.connectSession("s1");
    const firstSocket = lastWs;

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(60_001);

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(firstSocket.close).toHaveBeenCalled();
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    expect(MockWebSocket.instances.at(-1)).not.toBe(firstSocket);
    expect(MockWebSocket.instances.at(-1)?.url).toBe("ws://localhost:3456/ws/browser/s1");
  });

  it("keeps the replacement socket tracked when the old intentional close arrives late", () => {
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    useStore
      .getState()
      .setSdkSessions([
        { sessionId: "s1", cwd: "/tmp/s1", createdAt: Date.now(), archived: false, state: "connected" },
      ]);
    useStore.getState().setCurrentSession("s1");
    wsModule.connectSession("s1");
    const firstSocket = lastWs;
    firstSocket.onopen?.(new Event("open"));

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(60_001);

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    const replacementSocket = lastWs;
    replacementSocket.onopen?.(new Event("open"));
    replacementSocket.send.mockClear();

    firstSocket.onclose?.();

    expect(wsModule.sendToSession("s1", { type: "interrupt" })).toBe(true);
    expect(replacementSocket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(replacementSocket.send.mock.calls[0][0]).type).toBe("interrupt");

    replacementSocket.send.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(replacementSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "ping" }));
  });
});
