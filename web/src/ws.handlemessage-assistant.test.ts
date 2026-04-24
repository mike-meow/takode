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
describe("handleMessage: assistant", () => {
  it("appends a chat message and clears streaming", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Set some streaming text first
    useStore.getState().setStreaming("s1", "partial text...");

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Hello world" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const state = useStore.getState();
    const msgs = state.messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toBe("Hello world");
    expect(msgs[0].id).toBe("msg-1");
    expect(state.streaming.has("s1")).toBe(false);
    expect(state.sessionStatus.get("s1")).toBe("running");
  });

  it("ignores deprecated leader_user_addressed metadata from assistant messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      leader_user_addressed: true,
      message: {
        id: "msg-leader-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "Here's the status @to(user)" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs[0]).not.toHaveProperty("leaderUserAddressed");
    expect(msgs[0].content).toBe("Here's the status @to(user)");
  });

  it("clears only parented streaming for matching subagent assistant messages", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().setStreaming("s1", "top level");
    useStore.getState().setStreaming("s1", "child partial", "agent-1");

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-subagent-1",
        type: "message",
        role: "assistant",
        model: "gpt-5",
        content: [{ type: "text", text: "Child final" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: "agent-1",
    });

    const state = useStore.getState();
    expect(state.streaming.get("s1")).toBe("top level");
    expect(state.streamingByParentToolUseId.has("s1")).toBe(false);
  });

  it("updates timestamp when an existing assistant message is re-broadcast with newer data", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      timestamp: 1000,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "part 1" }],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "assistant",
      timestamp: 2500,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "pwd" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].timestamp).toBe(2500);
  });

  it("merges richer tool_use input for an existing assistant message instead of keeping the stale placeholder", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      timestamp: 1000,
      message: {
        id: "msg-view-image-1",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [{ type: "tool_use", id: "view-image-1", name: "view_image", input: { path: "" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "assistant",
      timestamp: 1500,
      message: {
        id: "msg-view-image-1",
        type: "message",
        role: "assistant",
        model: "gpt-5-codex",
        content: [
          {
            type: "tool_use",
            id: "view-image-1",
            name: "view_image",
            input: { path: "/tmp/final-screenshot.png" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    const toolUse = msgs[0].contentBlocks?.find((block) => block.type === "tool_use");
    expect(toolUse).toMatchObject({
      type: "tool_use",
      id: "view-image-1",
      input: { path: "/tmp/final-screenshot.png" },
    });
  });

  it("updates turn duration when an existing assistant message is re-broadcast with duration", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      timestamp: 1000,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "done soon" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    fireMessage({
      type: "assistant",
      timestamp: 1000,
      turn_duration_ms: 4200,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "done soon" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].turnDurationMs).toBe(4200);
  });

  it("does not set session status to running for rebroadcasted assistant with turn_duration_ms", () => {
    // When the server rebroadcasts the latest assistant message with turn_duration_ms
    // after a turn completes, the browser must NOT flip status to "running" — the turn
    // is already done and the result message will set "idle" shortly after.
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    // Simulate initial assistant (sets status to running)
    fireMessage({
      type: "assistant",
      timestamp: 1000,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });
    expect(useStore.getState().sessionStatus.get("s1")).toBe("running");

    // Simulate result setting idle
    fireMessage({ type: "status_change", status: "idle" });
    expect(useStore.getState().sessionStatus.get("s1")).toBe("idle");

    // Simulate rebroadcast with turn_duration_ms (arrives after result in some orderings)
    fireMessage({
      type: "assistant",
      timestamp: 1000,
      turn_duration_ms: 5000,
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    // Status should remain idle — the rebroadcast must NOT flip it to "running"
    expect(useStore.getState().sessionStatus.get("s1")).toBe("idle");
  });

  it("tracks changed files using session cwd for resolving relative tool paths", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Edit",
            input: { file_path: "web/server/index.ts" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed?.has("/home/user/web/server/index.ts")).toBe(true);
  });

  it("ignores changed files outside the repo root", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-2",
            name: "Write",
            input: { file_path: "/Users/test/.claude/plans/example.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed).toBeUndefined();
  });

  it("tracks changed files with absolute paths when inside repo root", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-tool-3",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-3",
            name: "Write",
            input: { file_path: "/home/user/README.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed?.has("/home/user/README.md")).toBe(true);
  });

  it("tracks changed files in worktree sessions where repo_root is the main repo", () => {
    // In a worktree, repo_root points to the main repo (e.g. /home/user/companion)
    // but the session cwd is the worktree directory (e.g. /home/user/.worktrees/wt-1).
    // Files edited in the worktree should still be tracked.
    const worktreeSession = {
      ...makeSession("s1"),
      cwd: "/home/user/.worktrees/wt-1",
      repo_root: "/home/user/companion",
      is_worktree: true,
    };
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: worktreeSession });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-wt-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-wt-1",
            name: "Edit",
            input: { file_path: "web/src/index.ts" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed?.has("/home/user/.worktrees/wt-1/web/src/index.ts")).toBe(true);
  });

  it("tracks changed files when cwd is a subdirectory of repo_root", () => {
    // When cwd is a subdirectory of repo_root, repo_root should be used as the scope
    // so files at the repo root level (e.g. CLAUDE.md) are tracked.
    const subSession = {
      ...makeSession("s1"),
      cwd: "/home/user/monorepo/packages/app",
      repo_root: "/home/user/monorepo",
    };
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: subSession });

    fireMessage({
      type: "assistant",
      message: {
        id: "msg-sub-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "tool-sub-1",
            name: "Write",
            input: { file_path: "/home/user/monorepo/CLAUDE.md" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    const changed = useStore.getState().changedFiles.get("s1");
    expect(changed?.has("/home/user/monorepo/CLAUDE.md")).toBe(true);
  });
});
