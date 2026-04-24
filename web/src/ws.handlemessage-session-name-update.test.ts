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
describe("handleMessage: session_name_update", () => {
  // Server is authoritative for all name updates — the browser always accepts them.
  // The server handles the logic of when to update names (auto-naming, manual renames, etc.)

  it("updates session name from server", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setSessionName("s1", "Swift Falcon");

    fireMessage({ type: "session_name_update", name: "Fix Authentication Bug" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Fix Authentication Bug");
  });

  it("marks session as recently renamed for animation when name changes", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setSessionName("s1", "Calm River");

    fireMessage({ type: "session_name_update", name: "Deploy Dashboard" });

    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("always accepts server-authoritative name updates", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Even custom names get overwritten by server updates — the server
    // controls when names should change (it tracks manual rename state)
    useStore.getState().setSessionName("s1", "My Custom Project");

    fireMessage({ type: "session_name_update", name: "Auto Generated Title" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Auto Generated Title");
  });

  it("does not mark as recently renamed when name is the same", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setSessionName("s1", "Same Name");
    useStore.getState().clearRecentlyRenamed("s1");

    // Server sends the same name — no animation
    fireMessage({ type: "session_name_update", name: "Same Name" });

    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(false);
  });

  it("updates name when session has no name at all", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Clear the name entirely
    const sessionNames = new Map(useStore.getState().sessionNames);
    sessionNames.delete("s1");
    useStore.setState({ sessionNames });

    fireMessage({ type: "session_name_update", name: "Brand New Title" });

    expect(useStore.getState().sessionNames.get("s1")).toBe("Brand New Title");
    expect(useStore.getState().recentlyRenamed.has("s1")).toBe(true);
  });

  it("updates any name regardless of pattern — server is source of truth", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Random Adj+Noun name
    useStore.getState().setSessionName("s1", "Bright Falcon");
    fireMessage({ type: "session_name_update", name: "Auto Title" });
    expect(useStore.getState().sessionNames.get("s1")).toBe("Auto Title");

    // Multi-word custom name also gets updated
    useStore.getState().setSessionName("s1", "My Cool Project");
    useStore.getState().clearRecentlyRenamed("s1");
    fireMessage({ type: "session_name_update", name: "Another Auto Title" });
    expect(useStore.getState().sessionNames.get("s1")).toBe("Another Auto Title");
  });

  it("keeps the quest-owned marker on same-title updates during needs_verification", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "session_quest_claimed",
      quest: { id: "q-348", title: "Fix Authentication Bug", status: "needs_verification" },
    });

    fireMessage({ type: "session_name_update", name: "Fix Authentication Bug" });

    const state = useStore.getState();
    expect(state.sessionNames.get("s1")).toBe("Fix Authentication Bug");
    expect(state.questNamedSessions.has("s1")).toBe(true);
  });
});
