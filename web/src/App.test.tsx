// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockConnectSession = vi.fn();
const mockDisconnectSession = vi.fn();

interface MockStoreState {
  colorTheme: string;
  darkMode: boolean;
  zoomLevel: number;
  currentSessionId: string | null;
  searchPreviewSessionId: string | null;
  terminalCwd: string | null;
  connectionStatus: Map<string, "connecting" | "connected" | "disconnected">;
  cliConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | "broken" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | "reverting" | null>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  askPermission: Map<string, boolean>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  shortcutSettings: {
    enabled: boolean;
    preset: "standard" | "vscode-light" | "vim-light";
    overrides: Record<string, string | null>;
  };
  sdkSessions: Array<{
    sessionId: string;
    createdAt: number;
    archived?: boolean;
    cronJobId?: string | null;
    state?: "starting" | "connected" | "running" | "exited" | null;
    cwd?: string;
    model?: string;
    gitBranch?: string;
    gitAhead?: number;
    gitBehind?: number;
    totalLinesAdded?: number;
    totalLinesRemoved?: number;
    pendingTimerCount?: number;
    backendType?: "claude" | "codex" | "claude-sdk";
    repoRoot?: string;
    cliConnected?: boolean;
    isWorktree?: boolean;
    worktreeExists?: boolean;
    worktreeDirty?: boolean;
    lastActivityAt?: number;
    lastUserMessageAt?: number;
    isOrchestrator?: boolean;
    herdedBy?: string;
    sessionNum?: number | null;
    reviewerOf?: number;
    claimedQuestStatus?: string;
  }>;
  treeGroups: Array<{ id: string; name: string }>;
  treeAssignments: Map<string, string>;
  treeNodeOrder: Map<string, string[]>;
  collapsedTreeGroups: Set<string>;
  expandedHerdNodes: Set<string>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionSortMode: "created" | "activity";
  messages: Map<string, Array<{ id: string; historyIndex?: number }>>;
  sidebarOpen: boolean;
  taskPanelOpen: boolean;
  activeTab: "chat" | "diff";
  newSessionModalState: null;
  serverRestarting: boolean;
  serverReachable: boolean;
  setServerReachable: ReturnType<typeof vi.fn>;
  setCurrentSession: ReturnType<typeof vi.fn>;
  markSessionViewed: ReturnType<typeof vi.fn>;
  requestScrollToMessage: ReturnType<typeof vi.fn>;
  setExpandAllInTurn: ReturnType<typeof vi.fn>;
  setPendingScrollToMessageIndex: ReturnType<typeof vi.fn>;
  closeNewSessionModal: ReturnType<typeof vi.fn>;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setActiveTab: ReturnType<typeof vi.fn>;
  openSessionSearch: ReturnType<typeof vi.fn>;
  closeSessionSearch: ReturnType<typeof vi.fn>;
  openNewSessionModal: ReturnType<typeof vi.fn>;
  openTerminal: ReturnType<typeof vi.fn>;
  sessions: Map<string, { backend_type?: string; cwd?: string }>;
}

let mockState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  mockState = {
    colorTheme: "dark",
    darkMode: true,
    zoomLevel: 1,
    currentSessionId: "s1",
    searchPreviewSessionId: null,
    terminalCwd: null,
    connectionStatus: new Map([["s1", "connected"]]),
    cliConnected: new Map([["s1", true]]),
    cliDisconnectReason: new Map(),
    sessionStatus: new Map([["s1", "idle"]]),
    pendingPermissions: new Map(),
    askPermission: new Map(),
    diffFileStats: new Map(),
    shortcutSettings: { enabled: false, preset: "standard", overrides: {} },
    sdkSessions: [{ sessionId: "s1", createdAt: 1, archived: false, cwd: "/repo/s1", backendType: "claude" }],
    treeGroups: [{ id: "default", name: "Default" }],
    treeAssignments: new Map(),
    treeNodeOrder: new Map(),
    collapsedTreeGroups: new Set(),
    expandedHerdNodes: new Set(),
    sessionAttention: new Map(),
    sessionSortMode: "created",
    messages: new Map([
      [
        "s1",
        [
          { id: "m0", historyIndex: 0 },
          { id: "m1", historyIndex: 1 },
          { id: "m2", historyIndex: 2 },
        ],
      ],
    ]),
    sidebarOpen: false,
    taskPanelOpen: false,
    activeTab: "chat",
    newSessionModalState: null,
    serverRestarting: false,
    serverReachable: true,
    setServerReachable: vi.fn(),
    setCurrentSession: vi.fn(),
    markSessionViewed: vi.fn(),
    requestScrollToMessage: vi.fn(),
    setExpandAllInTurn: vi.fn(),
    setPendingScrollToMessageIndex: vi.fn(),
    closeNewSessionModal: vi.fn(),
    setSidebarOpen: vi.fn(),
    setActiveTab: vi.fn(),
    openSessionSearch: vi.fn(),
    closeSessionSearch: vi.fn(),
    openNewSessionModal: vi.fn(),
    openTerminal: vi.fn(),
    sessions: new Map([["s1", { backend_type: "claude" }]]),
    ...overrides,
  };
}

vi.mock("./store.js", () => {
  const useStore: any = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStore.getState = () => mockState;
  return {
    useStore,
    getSessionSearchState: () => ({
      query: "",
      isOpen: false,
      mode: "strict",
      category: "all",
      matches: [],
      currentMatchIndex: -1,
    }),
  };
});

const mockCheckHealth = vi.fn().mockResolvedValue(true);
const mockMarkSessionRead = vi.fn().mockResolvedValue({ ok: true });
const mockListSessions = vi.fn().mockResolvedValue([]);
const mockSearchEverything = vi.fn().mockResolvedValue({ query: "", tookMs: 0, totalMatches: 0, results: [] });
const mockRefreshSessionGitStatus = vi.fn().mockResolvedValue({ ok: true });

vi.mock("./api.js", () => ({
  api: {
    markSessionRead: (...args: unknown[]) => mockMarkSessionRead(...args),
    listSessions: (...args: unknown[]) => mockListSessions(...args),
    searchEverything: (...args: unknown[]) => mockSearchEverything(...args),
    refreshSessionGitStatus: (...args: unknown[]) => mockRefreshSessionGitStatus(...args),
  },
  checkHealth: (...args: unknown[]) => mockCheckHealth(...args),
}));

vi.mock("./ws.js", () => ({
  connectSession: (...args: unknown[]) => mockConnectSession(...args),
  disconnectSession: (...args: unknown[]) => mockDisconnectSession(...args),
  sendVsCodeSelectionUpdate: vi.fn(),
}));

vi.mock("./components/Sidebar.js", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock("./components/TaskPanel.js", () => ({
  TaskPanel: () => <div data-testid="task-panel" />,
}));

vi.mock("./components/TopBar.js", () => ({
  TopBar: () => <div data-testid="top-bar" />,
}));

vi.mock("./components/ChatView.js", () => ({
  ChatView: ({ sessionId, preview }: { sessionId: string; preview?: boolean }) => (
    <div data-testid="chat-view" data-session-id={sessionId} data-preview={preview ? "true" : "false"} />
  ),
}));

vi.mock("./components/EmptyState.js", () => ({
  EmptyState: () => <div data-testid="empty-state" />,
}));

vi.mock("./components/DiffPanel.js", () => ({
  DiffPanel: () => <div data-testid="diff-panel" />,
}));

vi.mock("./components/Playground.js", () => ({
  Playground: () => <div data-testid="playground" />,
}));

vi.mock("./components/SettingsPage.js", () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));

vi.mock("./components/LogsPage.js", () => ({
  LogsPage: () => <div data-testid="logs-page" />,
}));

vi.mock("./components/EnvManager.js", () => ({
  EnvManager: () => <div data-testid="env-manager" />,
}));

vi.mock("./components/ActiveTimersPage.js", () => ({
  ActiveTimersPage: () => <div data-testid="active-timers-page" />,
}));

vi.mock("./components/StreamsPage.js", () => ({
  StreamsPage: () => <div data-testid="streams-page" />,
}));

vi.mock("./components/TerminalPage.js", () => ({
  TerminalPage: () => <div data-testid="terminal-page" />,
}));

vi.mock("./components/SessionCreationView.js", () => ({
  SessionCreationView: () => <div data-testid="session-creation-view" />,
}));

vi.mock("./components/NewSessionModal.js", () => ({
  NewSessionModal: () => null,
}));

vi.mock("./components/QuestmasterPage.js", () => ({
  QuestmasterPage: () => <div data-testid="questmaster-page" />,
}));

vi.mock("./components/QuestDetailPanel.js", () => ({
  QuestDetailPanel: () => null,
}));

vi.mock("./utils/vscode-context.js", () => ({
  announceVsCodeReady: vi.fn(),
  maybeReadVsCodeSelectionContext: vi.fn(() => undefined),
}));

vi.mock("./utils/vscode-bridge.js", () => ({
  ensureVsCodeEditorPreference: vi.fn().mockResolvedValue(undefined),
}));

import App from "./App.js";
import { resetSessionGitStatusAutoRefreshForTest } from "./utils/session-git-status-auto-refresh.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionGitStatusAutoRefreshForTest();
  mockListSessions.mockResolvedValue([]);
  mockRefreshSessionGitStatus.mockResolvedValue({ ok: true });
  resetStore();
  window.location.hash = "#/session/s1";
});

describe("App hidden panels", () => {
  it("does not mount the sidebar while it is closed", () => {
    resetStore({ sidebarOpen: false, taskPanelOpen: false });

    render(<App />);

    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.queryByTestId("task-panel")).toBeNull();
  });

  it("mounts the sidebar and task panel only when opened", () => {
    resetStore({ sidebarOpen: true, taskPanelOpen: true });

    render(<App />);

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("task-panel")).toBeInTheDocument();
  });

  it("opens Search Everything from the global_search shortcut without mounting Sidebar search", async () => {
    resetStore({
      sidebarOpen: false,
      shortcutSettings: { enabled: true, preset: "standard", overrides: { global_search: "Ctrl+Shift+F" } },
    });

    render(<App />);
    fireEvent.keyDown(document, { key: "F", ctrlKey: true, shiftKey: true });

    expect(screen.getByRole("dialog", { name: "Search Everything" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Search everything query")).toHaveFocus());
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("mounts ActiveTimersPage on the scheduled route", () => {
    window.location.hash = "#/scheduled";

    render(<App />);

    expect(screen.getByTestId("active-timers-page")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-view")).toBeNull();
  });

  it("mounts StreamsPage on the streams route", () => {
    window.location.hash = "#/streams";

    render(<App />);

    expect(screen.getByTestId("streams-page")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-view")).toBeNull();
  });

  it("suppresses the server unreachable banner while the active chat session is connected", () => {
    resetStore({
      serverReachable: false,
      activeTab: "chat",
      currentSessionId: "s1",
      connectionStatus: new Map([["s1", "connected"]]),
    });

    render(<App />);

    expect(screen.queryByText("Server unreachable")).toBeNull();
  });

  it("keeps the server unreachable banner on non-chat views even if the session transport is connected", () => {
    resetStore({
      serverReachable: false,
      activeTab: "diff",
      currentSessionId: "s1",
      connectionStatus: new Map([["s1", "connected"]]),
    });

    render(<App />);

    expect(screen.getByText("Server unreachable")).toBeInTheDocument();
  });

  it("renders the right-pane chat in preview mode when searchPreviewSessionId is set", () => {
    resetStore({
      currentSessionId: "s1",
      searchPreviewSessionId: "s2",
      connectionStatus: new Map([
        ["s1", "connected"],
        ["s2", "disconnected"],
      ]),
      sessions: new Map([
        ["s1", { backend_type: "claude" }],
        ["s2", { backend_type: "claude" }],
      ]),
    });
    window.location.hash = "#/session/s1";

    render(<App />);

    const chatView = screen.getByTestId("chat-view");
    expect(chatView).toHaveAttribute("data-session-id", "s2");
    expect(chatView).toHaveAttribute("data-preview", "true");
    expect(mockConnectSession).toHaveBeenCalledWith("s2");
  });

  it("resolves readable message deep links through raw history index before selecting and scrolling", async () => {
    resetStore({
      currentSessionId: null,
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          archived: false,
          cwd: "/repo/s1",
          backendType: "claude",
          sessionNum: 123,
        },
      ],
      messages: new Map([
        [
          "s1",
          [
            { id: "m0", historyIndex: 0 },
            // Raw history index 1 can be a non-rendered entry such as tool_result_preview.
            { id: "m2", historyIndex: 2 },
          ],
        ],
      ]),
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    window.location.hash = "#/session/123/msg/2";

    render(<App />);

    await waitFor(() => {
      expect(mockState.setCurrentSession).toHaveBeenCalledWith("s1");
      expect(mockConnectSession).toHaveBeenCalledWith("s1");
      expect(mockState.requestScrollToMessage).toHaveBeenCalledWith("s1", "m2");
      expect(mockState.setExpandAllInTurn).toHaveBeenCalledWith("s1", "m2");
    });
    expect(screen.getByTestId("chat-view")).toHaveAttribute("data-session-id", "s1");
    expect(mockConnectSession).not.toHaveBeenCalledWith("123");
  });

  it("starts a cheap git status refresh when switching to a worktree session", async () => {
    resetStore({
      currentSessionId: "s1",
      sdkSessions: [
        { sessionId: "s1", createdAt: 1, archived: false, cwd: "/repo/s1", backendType: "claude", isWorktree: true },
        { sessionId: "s2", createdAt: 2, archived: false, cwd: "/repo/s2", backendType: "claude", isWorktree: true },
      ],
      sessions: new Map([
        ["s1", { backend_type: "claude", is_worktree: true } as any],
        ["s2", { backend_type: "claude", is_worktree: true } as any],
      ]),
    });
    window.location.hash = "#/session/s2";

    render(<App />);

    await waitFor(() => {
      expect(mockConnectSession).toHaveBeenCalledWith("s2");
      expect(mockRefreshSessionGitStatus).toHaveBeenCalledWith("s2", { force: false });
    });
  });

  it("does not show a fake session for an unresolved numeric message deep link", () => {
    resetStore({ currentSessionId: null, sdkSessions: [], sessions: new Map(), messages: new Map() });
    window.location.hash = "#/session/123/msg/2";

    render(<App />);

    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-view")).toBeNull();
    expect(screen.queryByTestId("session-creation-view")).toBeNull();
    expect(mockState.setCurrentSession).not.toHaveBeenCalledWith("123");
    expect(mockConnectSession).not.toHaveBeenCalledWith("123");
  });

  it("cleans up preview mode when searchPreviewSessionId is cleared", () => {
    resetStore({
      currentSessionId: "s1",
      searchPreviewSessionId: "s2",
      connectionStatus: new Map([
        ["s1", "connected"],
        ["s2", "disconnected"],
      ]),
      sessions: new Map([
        ["s1", { backend_type: "claude" }],
        ["s2", { backend_type: "claude" }],
      ]),
    });
    window.location.hash = "#/session/s1";

    const view = render(<App />);
    expect(screen.getByTestId("chat-view")).toHaveAttribute("data-session-id", "s2");

    resetStore({
      currentSessionId: "s1",
      searchPreviewSessionId: null,
      connectionStatus: new Map([["s1", "connected"]]),
      sessions: new Map([["s1", { backend_type: "claude" }]]),
    });
    view.rerender(<App />);

    const chatView = screen.getByTestId("chat-view");
    expect(chatView).toHaveAttribute("data-session-id", "s1");
    expect(chatView).toHaveAttribute("data-preview", "false");
    expect(mockDisconnectSession).toHaveBeenCalledWith("s2");
  });

  it("triggers global search even when focus is inside an input", () => {
    resetStore({
      shortcutSettings: { enabled: true, preset: "standard", overrides: { global_search: "Ctrl+Shift+F" } },
      sidebarOpen: false,
    });
    render(<App />);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "F", ctrlKey: true, shiftKey: true });

    expect(screen.getByRole("dialog", { name: "Search Everything" })).toBeInTheDocument();
    expect(mockState.setSidebarOpen).not.toHaveBeenCalled();
    input.remove();
  });

  it("triggers session switching even when focus is inside an input", () => {
    resetStore({
      shortcutSettings: { enabled: true, preset: "standard", overrides: {} },
      currentSessionId: "s1",
      connectionStatus: new Map([
        ["s1", "connected"],
        ["s2", "connected"],
      ]),
      cliConnected: new Map([
        ["s1", true],
        ["s2", true],
      ]),
      sessionStatus: new Map([
        ["s1", "idle"],
        ["s2", "idle"],
      ]),
      sessions: new Map([
        ["s1", { backend_type: "claude" }],
        ["s2", { backend_type: "claude" }],
      ]),
      sdkSessions: [
        { sessionId: "s1", createdAt: 2, archived: false, cwd: "/repo/s1", backendType: "claude" },
        { sessionId: "s2", createdAt: 1, archived: false, cwd: "/repo/s2", backendType: "claude" },
      ],
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map([["default", ["s1", "s2"]]]),
    });
    window.location.hash = "#/session/s1";
    render(<App />);

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "}",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(window.location.hash).toBe("#/session/s2");
    input.remove();
  });

  it("triggers terminal open even when focus is inside the session input", () => {
    resetStore({
      shortcutSettings: { enabled: true, preset: "standard", overrides: {} },
      currentSessionId: "s1",
      sessions: new Map([["s1", { backend_type: "claude", cwd: "/repo/s1" }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, archived: false, cwd: "/repo/s1", backendType: "claude" }],
    });
    window.location.hash = "#/session/s1";
    render(<App />);

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "T",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(mockState.openTerminal).toHaveBeenCalledWith("/repo/s1", "s1");
    expect(window.location.hash).toBe("#/terminal");
    input.remove();
  });

  it("triggers terminal return even when focus is inside the terminal input", () => {
    resetStore({
      shortcutSettings: { enabled: true, preset: "standard", overrides: {} },
      currentSessionId: "s1",
      terminalCwd: "/repo/s1",
      sessions: new Map([["s1", { backend_type: "claude", cwd: "/repo/s1" }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, archived: false, cwd: "/repo/s1", backendType: "claude" }],
    });
    window.location.hash = "#/terminal";
    render(<App />);

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "T",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(window.location.hash).toBe("#/session/s1");
    expect(mockState.setActiveTab).toHaveBeenCalledWith("chat");
    input.remove();
  });

  it("keeps non-global shortcuts blocked while focus is inside an input", () => {
    resetStore({
      shortcutSettings: { enabled: true, preset: "standard", overrides: {} },
      currentSessionId: "s1",
    });
    window.location.hash = "#/session/s1";
    render(<App />);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(mockState.openSessionSearch).not.toHaveBeenCalled();
    input.remove();
  });

  it("skips sessions hidden by collapsed herd rows when switching sessions", () => {
    resetStore({
      shortcutSettings: { enabled: true, preset: "standard", overrides: {} },
      currentSessionId: "leader",
      connectionStatus: new Map([
        ["leader", "connected"],
        ["worker-hidden", "connected"],
        ["standalone", "connected"],
      ]),
      cliConnected: new Map([
        ["leader", true],
        ["worker-hidden", true],
        ["standalone", true],
      ]),
      sessionStatus: new Map([
        ["leader", "idle"],
        ["worker-hidden", "idle"],
        ["standalone", "idle"],
      ]),
      sessions: new Map([
        ["leader", { backend_type: "claude" }],
        ["worker-hidden", { backend_type: "claude" }],
        ["standalone", { backend_type: "claude" }],
      ]),
      sdkSessions: [
        {
          sessionId: "leader",
          createdAt: 3,
          archived: false,
          cwd: "/repo/leader",
          backendType: "claude",
          isOrchestrator: true,
          sessionNum: 10,
        },
        {
          sessionId: "worker-hidden",
          createdAt: 2,
          archived: false,
          cwd: "/repo/worker-hidden",
          backendType: "claude",
          herdedBy: "leader",
          sessionNum: 11,
        },
        {
          sessionId: "standalone",
          createdAt: 1,
          archived: false,
          cwd: "/repo/standalone",
          backendType: "claude",
          sessionNum: 12,
        },
      ],
      treeGroups: [{ id: "default", name: "Default" }],
      treeAssignments: new Map(),
      treeNodeOrder: new Map([["default", ["leader", "standalone"]]]),
      expandedHerdNodes: new Set(),
    });
    window.location.hash = "#/session/leader";
    render(<App />);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "}",
        code: "BracketRight",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(window.location.hash).toBe("#/session/standalone");
    expect(window.location.hash).not.toBe("#/session/worker-hidden");
  });
});
