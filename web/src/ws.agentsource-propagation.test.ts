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
describe("agentSource propagation", () => {
  /** Live user_message events with agentSource should populate the ChatMessage.agentSource field. */
  it("propagates agentSource from live user_message to ChatMessage", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "user_message",
      content: "Run tests",
      timestamp: 1000,
      id: "user-1000-0",
      agentSource: { sessionId: "abc123", sessionLabel: "#3 orchestrator" },
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Run tests");
    expect(msgs[0].agentSource).toEqual({
      sessionId: "abc123",
      sessionLabel: "#3 orchestrator",
    });
  });

  it("does not set agentSource when absent from live user_message", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "user_message",
      content: "Normal message",
      timestamp: 1000,
      id: "user-1000-0",
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].agentSource).toBeUndefined();
  });

  it("replaces a pending local upload with the authoritative user message while preserving local image previews", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().addPendingUserUpload("s1", {
      id: "pending-upload-1",
      content: "Inspect this screenshot",
      timestamp: 1000,
      stage: "delivering",
      images: [
        {
          id: "draft-image-1",
          name: "attachment-1.png",
          base64: "restore-image-data",
          mediaType: "image/png",
          status: "ready",
          prepared: {
            imageRef: { imageId: "img-1", media_type: "image/png" },
            path: "/tmp/img.png",
          },
        },
      ],
      prepared: {
        deliveryContent:
          "Inspect this screenshot\n[📎 Image attachments -- read these files with the Read tool before responding:\nAttachment 1: /tmp/img.png]",
        imageRefs: [{ imageId: "img-1", media_type: "image/png" }],
      },
    });

    fireMessage({
      type: "user_message",
      content: "Inspect this screenshot",
      timestamp: 1001,
      id: "user-1001-0",
      client_msg_id: "pending-upload-1",
      images: [{ imageId: "img-1", media_type: "image/png" }],
    });

    expect(useStore.getState().pendingUserUploads.get("s1")).toBeUndefined();
    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].images).toEqual([{ imageId: "img-1", media_type: "image/png" }]);
    expect(msgs[0].localImages).toEqual([
      { name: "attachment-1.png", base64: "restore-image-data", mediaType: "image/png" },
    ]);
    expect(msgs[0].clientMsgId).toBe("pending-upload-1");
  });

  it("preserves local image previews when history_sync replaces the hot tail for a pending upload", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    useStore.getState().addPendingUserUpload("s1", {
      id: "pending-upload-2",
      content: "Inspect this screenshot",
      timestamp: 1000,
      stage: "delivering",
      images: [
        {
          id: "draft-image-2",
          name: "attachment-1.png",
          base64: "restore-image-data",
          mediaType: "image/png",
          status: "ready",
          prepared: {
            imageRef: { imageId: "img-2", media_type: "image/png" },
            path: "/tmp/img.png",
          },
        },
      ],
      prepared: {
        deliveryContent:
          "Inspect this screenshot\n[📎 Image attachments -- read these files with the Read tool before responding:\nAttachment 1: /tmp/img.png]",
        imageRefs: [{ imageId: "img-2", media_type: "image/png" }],
      },
    });

    fireMessage({
      type: "history_sync",
      frozen_base_count: 0,
      frozen_delta: [],
      hot_messages: [
        {
          type: "user_message",
          content: "Inspect this screenshot",
          timestamp: 1001,
          id: "user-1001-1",
          client_msg_id: "pending-upload-2",
          images: [{ imageId: "img-2", media_type: "image/png" }],
        },
      ],
      frozen_count: 0,
      expected_frozen_hash: "hash-frozen",
      expected_full_hash: "hash-full",
    });

    expect(useStore.getState().pendingUserUploads.get("s1")).toBeUndefined();
    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].images).toEqual([{ imageId: "img-2", media_type: "image/png" }]);
    expect(msgs[0].localImages).toEqual([
      { name: "attachment-1.png", base64: "restore-image-data", mediaType: "image/png" },
    ]);
    expect(msgs[0].clientMsgId).toBe("pending-upload-2");
  });

  it("does not treat user message metadata as the authoritative VS Code selection state", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });
    useStore.getState().setVsCodeSelectionContext({
      selection: {
        absolutePath: "/home/user/existing.ts",
        startLine: 1,
        endLine: 1,
        lineCount: 1,
      },
      updatedAt: 100,
      sourceId: "vscode:window-existing",
      sourceType: "vscode-window",
    });

    fireMessage({
      type: "user_message",
      content: "check this file",
      timestamp: 1234,
      vscodeSelection: {
        absolutePath: "/home/user/web/src/App.tsx",
        relativePath: "web/src/App.tsx",
        displayPath: "App.tsx",
        startLine: 42,
        endLine: 44,
        lineCount: 3,
      },
    });

    const state = useStore.getState();
    expect(state.vscodeSelectionContext).toEqual({
      selection: {
        absolutePath: "/home/user/existing.ts",
        startLine: 1,
        endLine: 1,
        lineCount: 1,
      },
      updatedAt: 100,
      sourceId: "vscode:window-existing",
      sourceType: "vscode-window",
    });
    expect(state.messages.get("s1")?.[0].metadata?.vscodeSelection).toEqual({
      absolutePath: "/home/user/web/src/App.tsx",
      relativePath: "web/src/App.tsx",
      displayPath: "App.tsx",
      startLine: 42,
      endLine: 44,
      lineCount: 3,
    });
  });

  /** message_history replay should also preserve agentSource on user messages. */
  it("propagates agentSource from message_history replay", () => {
    wsModule.connectSession("s1");
    fireMessage({ type: "session_init", session: makeSession("s1") });

    fireMessage({
      type: "message_history",
      messages: [
        {
          type: "user_message",
          content: "Check PRs",
          timestamp: 2000,
          id: "user-2000-0",
          agentSource: { sessionId: "cron:pr-check", sessionLabel: "cron: PR Check" },
        },
        {
          type: "assistant",
          message: {
            id: "msg-hist-1",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-20250514",
            content: [{ type: "text", text: "Done" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          },
          parent_tool_use_id: null,
        },
      ],
    });

    const msgs = useStore.getState().messages.get("s1")!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].agentSource).toEqual({
      sessionId: "cron:pr-check",
      sessionLabel: "cron: PR Check",
    });
    // Assistant message should not have agentSource
    expect(msgs[1].agentSource).toBeUndefined();
  });
});
