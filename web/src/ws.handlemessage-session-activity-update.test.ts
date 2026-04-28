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
describe("handleMessage: session_activity_update", () => {
  it("updates inactive session sidebar state from another session socket", () => {
    wsModule.connectSession("leader");
    fireMessage({ type: "session_init", session: makeSession("leader") });
    useStore.getState().setCurrentSession("leader");
    useStore.getState().setSdkSessions([
      { sessionId: "leader", state: "connected", cwd: "/home/user", createdAt: 1, archived: false },
      { sessionId: "worker", state: "connected", cwd: "/home/user", createdAt: 2, archived: false },
    ]);

    fireMessage({
      type: "session_activity_update",
      session_id: "worker",
      session: {
        pendingPermissionCount: 1,
        pendingPermissionSummary: "pending plan",
        attentionReason: "action",
        status: "running",
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
        notificationStatusVersion: 2,
        notificationStatusUpdatedAt: 2000,
      },
    });

    const worker = useStore.getState().sdkSessions.find((session) => session.sessionId === "worker")!;
    expect(worker.pendingPermissionCount).toBe(1);
    expect(worker.pendingPermissionSummary).toBe("pending plan");
    expect(worker.notificationUrgency).toBe("needs-input");
    expect(worker.activeNotificationCount).toBe(1);
    expect(worker.notificationStatusVersion).toBe(2);
    expect(useStore.getState().sessionAttention.get("worker")).toBe("action");
    expect(useStore.getState().sessionStatus.get("worker")).toBe("running");

    fireMessage({
      type: "session_activity_update",
      session_id: "worker",
      session: {
        pendingPermissionCount: 0,
        pendingPermissionSummary: null,
        attentionReason: null,
        status: "idle",
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 3,
        notificationStatusUpdatedAt: 3000,
      },
    });

    const updatedWorker = useStore.getState().sdkSessions.find((session) => session.sessionId === "worker")!;
    expect(updatedWorker.pendingPermissionCount).toBe(0);
    expect(updatedWorker.pendingPermissionSummary).toBeNull();
    expect(updatedWorker.notificationUrgency).toBeNull();
    expect(updatedWorker.activeNotificationCount).toBe(0);
    expect(updatedWorker.notificationStatusVersion).toBe(3);
    expect(useStore.getState().sessionAttention.get("worker")).toBeNull();
    expect(useStore.getState().sessionStatus.get("worker")).toBe("idle");
  });

  it("rejects older notification status updates for inactive sidebar rows", () => {
    // Notification status broadcasts and REST snapshots can cross in flight.
    // The sidebar must keep the newer clear instead of restoring an older amber marker.
    wsModule.connectSession("leader");
    fireMessage({ type: "session_init", session: makeSession("leader") });
    useStore.getState().setCurrentSession("leader");
    useStore.getState().setSdkSessions([
      {
        sessionId: "worker",
        state: "connected",
        cwd: "/home/user",
        createdAt: 2,
        archived: false,
        notificationUrgency: null,
        activeNotificationCount: 0,
        notificationStatusVersion: 5,
        notificationStatusUpdatedAt: 5000,
      },
    ]);

    fireMessage({
      type: "session_activity_update",
      session_id: "worker",
      session: {
        notificationUrgency: "needs-input",
        activeNotificationCount: 1,
        notificationStatusVersion: 4,
        notificationStatusUpdatedAt: 4000,
      },
    });

    const worker = useStore.getState().sdkSessions.find((session) => session.sessionId === "worker")!;
    expect(worker.notificationUrgency).toBeNull();
    expect(worker.activeNotificationCount).toBe(0);
    expect(worker.notificationStatusVersion).toBe(5);
  });
});
