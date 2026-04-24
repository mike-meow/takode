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
describe("handleMessage: permission_approved", () => {
  it("removes the permission from pending when request_id is present", () => {
    vi.useFakeTimers();
    try {
      wsModule.connectSession("s1");
      fireMessage({ type: "session_init", session: makeSession("s1") });

      // Add a pending permission
      const request: PermissionRequest = {
        request_id: "req-approve-1",
        tool_name: "Edit",
        input: { file_path: "/test.ts" },
        tool_use_id: "tu-approve-1",
        timestamp: Date.now(),
      };
      useStore.getState().addPermission("s1", request);
      expect(useStore.getState().pendingPermissions.get("s1")!.has("req-approve-1")).toBe(true);

      // Fire permission_approved with request_id
      fireMessage({
        type: "permission_approved",
        id: "approval-req-approve-1",
        request_id: "req-approve-1",
        tool_name: "Edit",
        tool_use_id: "tu-approve-1",
        summary: "Approved Edit",
        timestamp: Date.now(),
      });

      // System message should be appended immediately
      const msgs = useStore.getState().messages.get("s1")!;
      expect(msgs.some((m) => m.variant === "approved")).toBe(true);

      // Permission removal is delayed 400ms for the stamping animation
      expect(useStore.getState().pendingPermissions.get("s1")!.has("req-approve-1")).toBe(true);
      vi.advanceTimersByTime(400);
      const perms = useStore.getState().pendingPermissions.get("s1");
      expect(perms!.has("req-approve-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still works without request_id (backward compat with old messages)", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Fire permission_approved WITHOUT request_id (old format)
    fireMessage({
      type: "permission_approved",
      id: "approval-old",
      tool_name: "Bash",
      tool_use_id: "tu-old",
      summary: "Approved Bash",
      timestamp: Date.now(),
    });

    // Should still append the system message without errors
    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs.some((m) => m.variant === "approved")).toBe(true);
  });
});
